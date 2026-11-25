import { readMerchantFeeRecord } from '@/common/merchant-fee/merchant-fee';
import { Injectable } from '@nestjs/common';
import type { PaymentIntent } from '@generated/prisma/client';
import { toChecksumAddress } from '@/chains/chain-address';
import { NATIVE_ASSET_CODES, NATIVE_DECIMALS } from '@/chains/chains.constants';
import { parseUnits } from '@/chains/units';
import type { StellarNetwork } from '@/config/configuration';
import { addressTopic, topicAddress } from '@/evm/eip681';
import {
  ERC20_TRANSFER_TOPIC,
  EVM_LOG_SCAN_MAX_CALLS,
  EVM_NATIVE_TOKEN_INTERFACES,
  type EvmChain,
  type EvmNativeTokenInterface,
  isEvmChain,
} from '@/evm/evm.constants';
import {
  EvmRpcClient,
  type EvmReceipt,
  type EvmTransaction,
} from '@/evm/evm-rpc.client';
import { TX_CREATED_AT_SKEW_MS } from '@/payment-intents/payment-intents.constants';
import { PAY_TO } from '@/payment-intents/pay-to';
import type {
  PaymentVerifier,
  VerificationResult,
} from '@/payment-intents/payment-verifier';

/**
 * Confirms that an EVM transaction pays an intent (Monad, Arc), on the
 * intent's own chain.
 *
 * With a relayer configured, every intent has its own deposit address
 * (`chainReference`) and that address is the identification — the rules
 * below then apply to it instead of the merchant, the amount becomes "at
 * least", and discovery is the deposit forwarder's (by balance, native MON
 * included). What follows is the direct mode, paying the merchant.
 *
 * An EIP-681 payment carries no memo: a plain value transfer and an ERC-20
 * `transfer` have no field a wallet fills with an intent id. So the payment is
 * identified by what it moves — to the intent's destination, in its asset, for
 * exactly its amount — at or after the intent's creation. That is weaker than a
 * Stellar memo or a Solana reference, which is why an EVM intent must fix an
 * amount (the DTO refuses an open one) and why the README tells integrators to
 * give concurrent intents to one destination distinct amounts.
 *
 *   - Native MON: the transaction's `to` and `value`. The observer cannot find
 *     one on its own — a value transfer emits no log, and scanning every block
 *     is not a cost this service takes on — so a native intent settles through
 *     `POST /:id/validate` (or `PATCH` with the hash).
 *   - ERC-20: a `Transfer(from, to, value)` log of the token contract. The
 *     observer finds these with `eth_getLogs`, resuming from the intent's
 *     cursor each tick.
 *   - Arc's USDC, the chain's gas coin seen as an ERC-20
 *     (`EVM_NATIVE_TOKEN_INTERFACES`): the payer's wallet may send it as the
 *     ERC-20 or as a plain value transfer, and both move one balance. Every
 *     such movement is logged once by Arc's system emitter (EIP-7708), in 18
 *     decimals, and an ERC-20 transfer is ALSO logged by the token, in 6. So
 *     only the emitter's log is read, its value cut to 6 decimals (dust under
 *     a micro-USDC dropped, as `balanceOf` drops it) and compared with the
 *     intent's amount: either way of paying settles, and no payment counts
 *     twice. A value transfer is then found by the observer too.
 *
 * A reverted transaction is a plain mismatch here, never `failedOnChain`: it
 * carries nothing that binds it to one intent (no memo, no reference; payee,
 * token and amount are public), so anyone could revert a `transfer(payTo,
 * amount)` from an empty account for the price of gas, have the hash reach
 * `validate`, and turn the intent FAILED, which is terminal. Only Stellar
 * (memo) and Solana (reference) can tie a failed transaction to an intent.
 */
@Injectable()
export class EvmVerifierService implements PaymentVerifier {
  constructor(private readonly rpc: EvmRpcClient) {}

  async verifyByHash(
    intent: PaymentIntent,
    hash: string,
  ): Promise<VerificationResult> {
    const chain = evmChainOf(intent);
    const network = intent.network as StellarNetwork;
    const [tx, receipt] = await Promise.all([
      this.rpc.getTransaction(chain, network, hash),
      this.rpc.getReceipt(chain, network, hash),
    ]);
    if (!tx || !receipt) {
      return { valid: false, reason: 'Transaction not found on-chain' };
    }
    // Before any match: a reverted transaction moved nothing, so it never
    // settles, and it never fails the intent either (see the class comment).
    if (receipt.status !== '0x1') {
      return { valid: false, reason: 'Transaction failed on-chain' };
    }

    const expected = this.expected(chain, intent);
    if (expected === null && !isDeposit(intent)) {
      return { valid: false, reason: 'The intent has no payable amount' };
    }
    const accepts = amountRule(intent, expected);

    const paysIntent = intent.assetIssuer
      ? this.erc20Pays(chain, intent, receipt, accepts)
      : this.nativePays(chain, intent, tx, accepts);
    if (!paysIntent) {
      return {
        valid: false,
        reason:
          'No transfer in this transaction matches the destination/amount',
      };
    }

    const timestamp = await this.rpc.blockTimestamp(
      chain,
      network,
      receipt.blockNumber,
    );
    if (
      timestamp === null ||
      timestamp * 1000 < intent.createdAt.getTime() - TX_CREATED_AT_SKEW_MS
    ) {
      return {
        valid: false,
        reason: 'Transaction predates this payment intent',
      };
    }

    return {
      valid: true,
      txHash: hash.toLowerCase(),
      payer: toChecksumAddress(tx.from),
      paidAt: new Date(timestamp * 1000),
    };
  }

  /**
   * Scans the token's `Transfer` logs to the destination from the block after
   * the intent's cursor, a provider-sized range at a time, at most
   * {@link EVM_LOG_SCAN_MAX_CALLS} ranges per call. Where it stopped comes back
   * as `nextCursor` whether or not it found anything, so the next tick resumes
   * there. For Arc's USDC the logs read are the system emitter's, which cover
   * a value transfer as well as an ERC-20 one, each once.
   */
  async findMatchingPayment(
    intent: PaymentIntent,
  ): Promise<VerificationResult> {
    const chain = evmChainOf(intent);
    // A deposit address is watched by its balance, by the deposit forwarder,
    // which settles the intent once the money is on its way to the merchant.
    if (isDeposit(intent)) {
      return {
        valid: false,
        reason: 'Awaiting a deposit at the intent address',
      };
    }
    if (!intent.assetIssuer) {
      return {
        valid: false,
        reason:
          `A native ${NATIVE_ASSET_CODES[chain]} payment emits no log to find it by: confirm it with ` +
          'POST /v1/payment-intents/{id}/validate and the transaction hash',
      };
    }
    const expected = this.expected(chain, intent);
    if (expected === null) {
      return { valid: false, reason: 'The intent has no payable amount' };
    }
    const gasCoin = gasCoinOf(chain, intent.assetIssuer);

    const network = intent.network as StellarNetwork;
    const head = await this.rpc.blockNumber(chain, network);
    let cursor = intent.chainCursor ? BigInt(intent.chainCursor) : head;
    const range = BigInt(this.rpc.logBlockRange(chain));

    for (
      let calls = 0;
      calls < EVM_LOG_SCAN_MAX_CALLS && cursor < head;
      calls += 1
    ) {
      const fromBlock = cursor + 1n;
      const toBlock =
        fromBlock + range - 1n < head ? fromBlock + range - 1n : head;
      const logs = await this.rpc.getLogs(chain, network, {
        address: gasCoin?.transferEmitter ?? intent.assetIssuer,
        topics: [ERC20_TRANSFER_TOPIC, null, addressTopic(intent.destination)],
        fromBlock,
        toBlock,
      });
      const match = logs.find(
        (log) =>
          !log.removed && loggedAmount(chain, gasCoin, log.data) === expected,
      );
      if (match) {
        // The block's time, one read on a match: without it no session's proof
        // counts for the receipt.
        const timestamp = await this.rpc
          .blockTimestamp(chain, network, match.blockNumber)
          .catch(() => null);
        return {
          valid: true,
          txHash: match.transactionHash.toLowerCase(),
          payer: toChecksumAddress(topicAddress(match.topics[1] ?? '')),
          nextCursor: toBlock.toString(),
          ...(timestamp !== null ? { paidAt: new Date(timestamp * 1000) } : {}),
        };
      }
      cursor = toBlock;
    }
    return {
      valid: false,
      reason: 'No matching payment found yet',
      nextCursor: cursor.toString(),
    };
  }

  /**
   * What the payer sends, in the asset's base units, or null when the intent
   * fixed none: its amount, plus a merchant fee the payer pays on top (only a
   * deposit-address intent has one; its forwarder pays the fee out).
   */
  private expected(chain: EvmChain, intent: PaymentIntent): bigint | null {
    if (intent.amount == null) return null;
    const decimals = intent.assetIssuer
      ? intent.assetDecimals
      : NATIVE_DECIMALS[chain];
    if (decimals == null) return null;
    try {
      const amount = parseUnits(intent.amount, decimals);
      const fee = readMerchantFeeRecord(intent.merchantFee);
      return fee?.paidBy === 'payer'
        ? amount + parseUnits(fee.amount, decimals)
        : amount;
    } catch {
      return null;
    }
  }

  /** A successful value transfer to the payee for the amount (checked by the caller: status `0x1`). */
  private nativePays(
    chain: EvmChain,
    intent: PaymentIntent,
    tx: EvmTransaction,
    accepts: (value: bigint | null) => boolean,
  ): boolean {
    return (
      tx.to?.toLowerCase() === PAY_TO[chain](intent).toLowerCase() &&
      accepts(safeBigInt(tx.value))
    );
  }

  /**
   * A `Transfer` log of the token to the destination for the amount, in a
   * successful receipt (a reverted one emits no logs, and the caller refuses
   * it first). For a chain's gas coin seen as an ERC-20 (Arc's USDC) the log is
   * the system emitter's instead, never the token's (see the class comment).
   */
  private erc20Pays(
    chain: EvmChain,
    intent: PaymentIntent,
    receipt: EvmReceipt,
    accepts: (value: bigint | null) => boolean,
  ): boolean {
    const token = intent.assetIssuer!.toLowerCase();
    const payTo = PAY_TO[chain](intent).toLowerCase();
    const destination = addressTopic(payTo);
    const gasCoin = gasCoinOf(chain, token);
    const emitter = gasCoin?.transferEmitter.toLowerCase() ?? token;
    return receipt.logs.some(
      (log) =>
        log.address.toLowerCase() === emitter &&
        log.topics[0] === ERC20_TRANSFER_TOPIC &&
        log.topics[2]?.toLowerCase() === destination &&
        accepts(loggedAmount(chain, gasCoin, log.data)),
    );
  }
}

/**
 * The intent's chain, as an EVM chain. The verifier is registered only for
 * EVM chains (`PaymentVerifiers`), so anything else is a wiring error, and
 * reading it from another chain's node would be worse than refusing.
 */
function evmChainOf(intent: Pick<PaymentIntent, 'chain' | 'id'>): EvmChain {
  if (!isEvmChain(intent.chain)) {
    throw new Error(
      `Payment intent ${intent.id} on "${intent.chain}" reached the EVM verifier`,
    );
  }
  return intent.chain;
}

/**
 * The chain's gas coin interface when `token` is it (Arc's USDC), else null:
 * the one token whose payments are read from the system emitter.
 */
export function gasCoinOf(
  chain: EvmChain,
  token: string,
): EvmNativeTokenInterface | null {
  const gasCoin = EVM_NATIVE_TOKEN_INTERFACES[chain];
  return gasCoin && gasCoin.token.toLowerCase() === token.toLowerCase()
    ? gasCoin
    : null;
}

/**
 * A logged (or sent) amount in the intent's units: as it is for a token, and
 * for the gas coin cut from the native decimals to the interface's, truncating
 * as the interface's `balanceOf` does (Arc: 18 to 6). Null when the hex is not
 * a quantity.
 */
export function loggedAmount(
  chain: EvmChain,
  gasCoin: EvmNativeTokenInterface | null,
  hex: string,
): bigint | null {
  const value = safeBigInt(hex);
  if (value === null || gasCoin === null) return value;
  return value / 10n ** BigInt(NATIVE_DECIMALS[chain] - gasCoin.decimals);
}

/** Whether the intent has its own deposit address (the relayer is on). */
function isDeposit(intent: PaymentIntent): boolean {
  return intent.chainReference !== null && intent.chainReference !== undefined;
}

/**
 * Which amounts settle the intent. Paying the merchant directly, only the
 * exact amount: it is half of how the payment is recognised. Paying a deposit
 * address, the address alone identifies the intent, so the amount or more
 * does — any positive amount for an open intent.
 */
function amountRule(
  intent: PaymentIntent,
  expected: bigint | null,
): (value: bigint | null) => boolean {
  if (!isDeposit(intent)) return (value) => value === expected;
  if (expected === null) return (value) => value !== null && value > 0n;
  return (value) => value !== null && value >= expected;
}

/** A hex quantity as a bigint, or null when it is not one. */
function safeBigInt(hex: string): bigint | null {
  try {
    return /^0x[0-9a-fA-F]+$/.test(hex) ? BigInt(hex) : null;
  } catch {
    return null;
  }
}
