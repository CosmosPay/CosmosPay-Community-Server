import { Injectable } from '@nestjs/common';
import type { PaymentIntent } from '@generated/prisma/client';
import { NATIVE_DECIMALS } from '@/chains/chains.constants';
import { parseUnits } from '@/chains/units';
import type { StellarNetwork } from '@/config/configuration';
import { TX_CREATED_AT_SKEW_MS } from '@/payment-intents/payment-intents.constants';
import type {
  PaymentVerifier,
  VerificationResult,
} from '@/payment-intents/payment-verifier';
import {
  SolanaRpcClient,
  type SolanaTransaction,
} from '@/solana/solana-rpc.client';
import { SOLANA_REFERENCE_SIGNATURE_LIMIT } from '@/solana/solana.constants';

/**
 * Confirms that a Solana transaction pays an intent, by the rules of the
 * Solana Pay spec's `validateTransfer`:
 *
 *   - it carries the intent's `reference` key among its accounts — the
 *     identification a Stellar memo gives, and why a transfer made for some
 *     other purpose never settles an intent;
 *   - it landed no earlier than the intent was created (clock skew aside);
 *   - the destination's balance of the intent's asset rose by exactly the
 *     amount — lamports for SOL, the token account's balance for an SPL mint,
 *     read from the transaction's own pre/post balances so no second call and
 *     no decimals guess is involved;
 *   - and it succeeded. A failed transaction is reported `failedOnChain` once
 *     it has been shown to carry this intent's reference — see `check`.
 *
 * The payer is the fee payer — the first signer.
 */
@Injectable()
export class SolanaVerifierService implements PaymentVerifier {
  constructor(private readonly rpc: SolanaRpcClient) {}

  async verifyByHash(
    intent: PaymentIntent,
    signature: string,
  ): Promise<VerificationResult> {
    const tx = await this.rpc.getTransaction(
      intent.network as StellarNetwork,
      signature,
    );
    if (!tx) {
      return { valid: false, reason: 'Transaction not found on-chain' };
    }
    return this.check(intent, signature, tx);
  }

  /**
   * The transactions that touched the intent's reference key, newest first.
   * The key exists only in this intent's link, so every one of them is the
   * payer's attempt at this payment; the first that settles it wins.
   */
  async findMatchingPayment(
    intent: PaymentIntent,
  ): Promise<VerificationResult> {
    if (!intent.chainReference) {
      return { valid: false, reason: 'Intent has no Solana Pay reference' };
    }
    const network = intent.network as StellarNetwork;
    const signatures = await this.rpc.getSignaturesForAddress(
      network,
      intent.chainReference,
      SOLANA_REFERENCE_SIGNATURE_LIMIT,
    );
    // Oldest first: when a payer retried, the first successful attempt is
    // the payment, and a later one is a double payment to refund.
    for (const entry of [...signatures].reverse()) {
      if (entry.err) continue;
      const tx = await this.rpc.getTransaction(network, entry.signature);
      if (!tx) continue;
      const result = this.check(intent, entry.signature, tx);
      if (result.valid) return result;
    }
    return { valid: false, reason: 'No matching payment found yet' };
  }

  private check(
    intent: PaymentIntent,
    signature: string,
    tx: SolanaTransaction,
  ): VerificationResult {
    const keys = tx.transaction.message.accountKeys;
    if (
      !intent.chainReference ||
      !keys.some((k) => k.pubkey === intent.chainReference)
    ) {
      return {
        valid: false,
        reason: "Transaction does not carry this intent's reference key",
      };
    }

    if (
      tx.blockTime === null ||
      tx.blockTime * 1000 < intent.createdAt.getTime() - TX_CREATED_AT_SKEW_MS
    ) {
      return {
        valid: false,
        reason: 'Transaction predates this payment intent',
      };
    }

    // Before the amount, unlike on Stellar: a failed Solana transaction moves
    // no balance, so its transfer cannot be read back from pre/post balances.
    // The reference key is what makes this safe — it exists only in this
    // intent's link, so a failed transaction carrying it is the payer's own
    // attempt at this payment, not some unrelated failure.
    if (!tx.meta || tx.meta.err) {
      return {
        valid: false,
        failedOnChain: true,
        reason: 'Transaction failed on-chain',
      };
    }

    const received = this.received(intent, tx);
    if (received === null || received <= 0n) {
      return {
        valid: false,
        reason: 'No transfer in this transaction pays the destination',
      };
    }
    if (intent.amount != null && received !== this.expected(intent)) {
      return {
        valid: false,
        reason: 'The transfer does not match the intent amount',
      };
    }

    const payer = keys.find((k) => k.signer)?.pubkey;
    return { valid: true, txHash: signature, payer };
  }

  /** The intent's amount in base units, or null when it fixed none. */
  private expected(intent: PaymentIntent): bigint | null {
    if (intent.amount == null) return null;
    const decimals =
      intent.asset === 'native'
        ? NATIVE_DECIMALS.solana
        : (intent.assetDecimals ?? NATIVE_DECIMALS.solana);
    try {
      return parseUnits(intent.amount, decimals);
    } catch {
      return null;
    }
  }

  /**
   * How much of the intent's asset the destination gained in `tx`, in base
   * units — or null when the transaction's balances do not show it at all.
   */
  private received(
    intent: PaymentIntent,
    tx: SolanaTransaction,
  ): bigint | null {
    const meta = tx.meta;
    if (!meta) return null;
    const keys = tx.transaction.message.accountKeys;

    if (intent.asset === 'native') {
      const index = keys.findIndex((k) => k.pubkey === intent.destination);
      if (index < 0) return null;
      return BigInt(meta.postBalances[index]) - BigInt(meta.preBalances[index]);
    }

    // The destination's token account(s) for the mint: owned by it, of that
    // mint. An associated token account created in the same transaction has
    // no pre-balance, which counts as zero.
    const owned = (balances: typeof meta.postTokenBalances) =>
      (balances ?? []).filter(
        (b) => b.owner === intent.destination && b.mint === intent.assetIssuer,
      );
    const post = owned(meta.postTokenBalances);
    if (post.length === 0) return null;
    const pre = owned(meta.preTokenBalances);
    let delta = 0n;
    for (const balance of post) {
      const before = pre.find((b) => b.accountIndex === balance.accountIndex);
      delta +=
        BigInt(balance.uiTokenAmount.amount) -
        BigInt(before?.uiTokenAmount.amount ?? '0');
    }
    return delta;
  }
}
