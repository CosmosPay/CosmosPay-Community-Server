import { Injectable } from '@nestjs/common';
import { NATIVE_DECIMALS } from '@/chains/chains.constants';
import { parseUnits } from '@/chains/units';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { StellarNetwork } from '@/config/configuration';
import { paymentLegs } from '@/payment-intents/payment-legs';
import { associatedTokenAddress } from '@/solana/associated-token-account';
import { SolanaRpcClient } from '@/solana/solana-rpc.client';
import {
  buildLegacyTransaction,
  createAssociatedTokenAccountIdempotent,
  memoInstruction,
  type SolanaInstruction,
  systemTransfer,
  tokenTransferChecked,
  withReference,
} from '@/solana/solana-transaction-builder';
import { SPL_TOKEN_PROGRAM_IDS } from '@/solana/solana.constants';

/** The columns of an intent its Solana Pay transaction is built from. */
export interface SolanaPayLink {
  network: string;
  destination: string;
  chainReference: string | null;
  asset: string;
  assetIssuer: string | null;
  assetDecimals: number | null;
  amount: string | null;
  memo: string;
  merchantFee: unknown;
}

/**
 * The transaction a Solana Pay transaction request answers, for a Solana link
 * with a merchant fee: a transfer request names one recipient, so the wallet
 * asks for this instead.
 *
 *   memo · [create the receivers' token accounts, if missing] ·
 *   the merchant's transfer (carrying the link's reference) · the fee's transfer
 *
 * The same legs the verifier checks (`paymentLegs`), and the reference key the
 * observer finds the payment by, so a payment made from it settles the link
 * like any other. The payer signs and pays the network fee; this builds only.
 */
@Injectable()
export class SolanaPayTransactionBuilder {
  constructor(private readonly rpc: SolanaRpcClient) {}

  async build(link: SolanaPayLink, payer: string): Promise<string> {
    const network = link.network as StellarNetwork;
    const native = link.asset === 'native';
    const decimals = native
      ? NATIVE_DECIMALS.solana
      : (link.assetDecimals ?? NATIVE_DECIMALS.solana);
    const legs = paymentLegs(link, decimals);
    if (!link.chainReference || legs.destinationAmount === null || !legs.fee) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'This payment link is not a Solana Pay transaction request: open its uri',
      );
    }
    const toMerchant = parseUnits(legs.destinationAmount, decimals);
    const toFee = parseUnits(legs.fee.amount, decimals);
    const reference = link.chainReference;

    const instructions: SolanaInstruction[] = [memoInstruction(link.memo)];
    if (native) {
      instructions.push(
        withReference(
          systemTransfer(payer, link.destination, toMerchant),
          reference,
        ),
        systemTransfer(payer, legs.fee.wallet, toFee),
      );
    } else {
      const mint = link.assetIssuer!;
      const tokenProgram = await this.rpc.getAccountOwner(network, mint);
      if (!tokenProgram || !SPL_TOKEN_PROGRAM_IDS.includes(tokenProgram)) {
        throw ApiError.badGateway(
          ApiErrorCode.ProviderError,
          `The link's token mint ${mint} is no longer an SPL mint on this network`,
        );
      }
      const source = associatedTokenAddress(payer, mint, tokenProgram);
      const merchantAccount = associatedTokenAddress(
        link.destination,
        mint,
        tokenProgram,
      );
      const feeAccount = associatedTokenAddress(
        legs.fee.wallet,
        mint,
        tokenProgram,
      );
      const transfer = (destination: string, amount: bigint) =>
        tokenTransferChecked({
          tokenProgram,
          source,
          mint,
          destination,
          owner: payer,
          amount,
          decimals,
        });
      instructions.push(
        createAssociatedTokenAccountIdempotent({
          payer,
          account: merchantAccount,
          owner: link.destination,
          mint,
          tokenProgram,
        }),
        createAssociatedTokenAccountIdempotent({
          payer,
          account: feeAccount,
          owner: legs.fee.wallet,
          mint,
          tokenProgram,
        }),
        withReference(transfer(merchantAccount, toMerchant), reference),
        transfer(feeAccount, toFee),
      );
    }

    const blockhash = await this.rpc.getLatestBlockhash(network);
    return Buffer.from(
      buildLegacyTransaction(payer, blockhash, instructions),
    ).toString('base64');
  }
}
