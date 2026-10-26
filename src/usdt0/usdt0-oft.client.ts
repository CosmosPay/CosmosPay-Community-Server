import { Injectable, Logger } from '@nestjs/common';
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  nativeToScVal,
  rpc,
  TimeoutInfinite,
  type Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { SorobanRpcClient } from '@/stellar/soroban-rpc.client';
import {
  type MessagingFee,
  messagingFeeScVal,
  type OftQuote,
  parseMessagingFee,
  parseOftQuote,
  sendParamScVal,
  type SendParamInput,
} from '@/usdt0/usdt0-oft';
import { USDT0_OFT, USDT0_QUOTE_SOURCE } from '@/usdt0/usdt0.constants';

/** A merchant fee the wrapper pays before the OFT's `send`, in USDT0 stroops. */
export interface Usdt0MerchantFeeLeg {
  /** The verified wrapper contract (C...). */
  wrapper: string;
  wallet: string;
  amount: bigint;
}

/** The longest contract error relayed to a caller; the event log after it is cut. */
const MAX_CONTRACT_ERROR_LENGTH = 200;

/** The account a transaction is built from: its address and next sequence. */
export type SourceAccount = ConstructorParameters<typeof TransactionBuilder>[0];

/**
 * USDT0's OFT contract on Stellar mainnet, through the Soroban RPC: the two
 * quotes, and the `send` transaction a holder signs. Encoding is `usdt0-oft.ts`'s;
 * this class only simulates and assembles.
 *
 * What the contract ANSWERS is the caller's business: a simulation the contract
 * refuses (`Error(Contract, #…)`: no peer for that network, a paused OFT, a
 * trustline Tether froze) is `400 provider_error` carrying the contract's error,
 * because it describes the request. What the RPC cannot answer is the RPC
 * client's `503`.
 */
@Injectable()
export class Usdt0OftClient {
  private readonly logger = new Logger(Usdt0OftClient.name);

  constructor(private readonly rpc: SorobanRpcClient) {}

  /**
   * Both quotes for sending `amountLd` from `from`: `quote_oft` with no floor
   * (what the OFT takes and what arrives), then `quote_send` with the floor set
   * to what arrives, which is the `SendParam` the transaction will carry.
   */
  async quote(
    from: string,
    param: Omit<SendParamInput, 'minAmountLd'>,
  ): Promise<{ oft: OftQuote; fee: MessagingFee }> {
    const oftRetval = await this.simulateRead(from, 'quote_oft', [
      new Address(from).toScVal(),
      sendParamScVal({ ...param, minAmountLd: 0n }),
    ]);
    const oft = this.decode('quote_oft', () => parseOftQuote(oftRetval));
    const feeRetval = await this.simulateRead(from, 'quote_send', [
      new Address(from).toScVal(),
      sendParamScVal({ ...param, minAmountLd: oft.amountReceivedLd }),
      // Pay in XLM: there is no ZRO to pay with here.
      xdr.ScVal.scvBool(false),
    ]);
    const fee = this.decode('quote_send', () => parseMessagingFee(feeRetval));
    return { oft, fee };
  }

  /**
   * The unsigned `send(from, send_param, fee, refund_address)` transaction,
   * simulated and assembled: its footprint, its resource fee and the
   * authorization entries the simulation recorded.
   *
   * `from` is the transaction's own source, so its `require_auth` (for the
   * burn, and for the XLM the endpoint takes) is covered by the envelope
   * signature: every entry must carry source-account credentials, and one that
   * asks for a separate signature is refused here rather than handed to a
   * wallet that could not satisfy it. The refund address is `from` too: the
   * part of `native_fee` the endpoint does not charge goes straight back.
   */
  async buildSend(
    account: SourceAccount,
    param: SendParamInput,
    fee: MessagingFee,
    opts: { baseFee: string; timeoutSeconds: number },
    merchantFee: Usdt0MerchantFeeLeg | null = null,
  ): Promise<Transaction> {
    const from = account.accountId();
    const send = [
      sendParamScVal(param),
      messagingFeeScVal(fee),
      new Address(from).toScVal(),
    ];
    // With a merchant fee the operation is the wrapper's `send`, which pays
    // the fee and calls the OFT's with the same arguments.
    const call = merchantFee
      ? new Contract(merchantFee.wrapper).call(
          'send',
          new Address(from).toScVal(),
          new Address(merchantFee.wallet).toScVal(),
          nativeToScVal(merchantFee.amount, { type: 'i128' }),
          ...send,
        )
      : new Contract(USDT0_OFT).call(
          'send',
          new Address(from).toScVal(),
          ...send,
        );
    const tx = new TransactionBuilder(account, {
      fee: opts.baseFee,
      networkPassphrase: this.rpc.passphrase,
    })
      .addOperation(call)
      .setTimeout(opts.timeoutSeconds)
      .build();

    const sim = await this.rpc.simulate(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw this.refused('the transfer', sim.error);
    }
    if (rpc.Api.isSimulationRestore(sim)) {
      this.logger.warn('send simulation asks for a ledger entry restore');
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        'Part of the USDT0 contract state is archived on the ledger and must ' +
          'be restored before a transfer can be built. Retry later.',
      );
    }
    const foreign = (sim.result?.auth ?? []).filter(
      (entry) => entry.credentials.type !== 'sorobanCredentialsSourceAccount',
    );
    if (foreign.length > 0) {
      this.logger.error(
        `send simulation asks for ${foreign.length} authorization(s) beyond the source account`,
      );
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        'The USDT0 contract asks for a signature this transaction cannot carry.',
      );
    }
    return rpc.assembleTransaction(tx, sim).build();
  }

  /** The OFT and the token a merchant fee wrapper was built with. */
  async wrapperBinding(
    wrapper: string,
  ): Promise<{ oft: string | null; token: string | null }> {
    const read = async (method: 'oft' | 'token') => {
      const retval = await this.simulateRead(
        USDT0_QUOTE_SOURCE,
        method,
        [],
        wrapper,
      );
      try {
        return Address.fromScVal(retval).toString();
      } catch {
        return null;
      }
    };
    const [oft, token] = await Promise.all([read('oft'), read('token')]);
    return { oft, token };
  }

  /**
   * Simulates a read-only call and returns its value. Any account, existing or
   * not, can be the source: a simulation checks no sequence number and no
   * signature.
   */
  private async simulateRead(
    from: string,
    method: string,
    args: xdr.ScVal[],
    contract: string = USDT0_OFT,
  ): Promise<xdr.ScVal> {
    const tx = new TransactionBuilder(new Account(from, '0'), {
      fee: BASE_FEE,
      networkPassphrase: this.rpc.passphrase,
    })
      .addOperation(new Contract(contract).call(method, ...args))
      .setTimeout(TimeoutInfinite)
      .build();
    const sim = await this.rpc.simulate(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw this.refused(`the quote (${method})`, sim.error);
    }
    if (!sim.result) {
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        `The Soroban RPC returned no result for ${method}.`,
      );
    }
    return sim.result.retval;
  }

  /** Runs a decode, turning a shape the contract never returns into a 502. */
  private decode<T>(method: string, run: () => T): T {
    try {
      return run();
    } catch (err) {
      this.logger.error(`Could not decode ${method}: ${String(err)}`);
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        `The USDT0 contract answered ${method} in an unexpected shape.`,
      );
    }
  }

  /** A simulation the contract refused, with the contract's own error. */
  private refused(what: string, error: string): ApiError {
    const line = error.split('\n')[0]?.trim() || 'no reason given';
    const reason =
      line.length > MAX_CONTRACT_ERROR_LENGTH
        ? `${line.slice(0, MAX_CONTRACT_ERROR_LENGTH)}...`
        : line;
    this.logger.warn(`USDT0 OFT refused ${what}: ${reason}`);
    return ApiError.badRequest(
      ApiErrorCode.ProviderError,
      `The USDT0 contract refused ${what}: ${reason}`,
    );
  }
}
