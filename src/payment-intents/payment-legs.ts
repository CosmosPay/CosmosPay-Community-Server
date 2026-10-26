import { formatUnits, parseUnits } from '@/chains/units';
import { readMerchantFeeRecord } from '@/common/merchant-fee/merchant-fee';

/**
 * What an intent's payment carries on-chain: the merchant's own leg, to
 * `destination`, and with a merchant fee the fee's leg, to the fee wallet, in
 * the same transaction and the intent's asset. Without a merchant fee the
 * merchant's leg is the whole `amount` and there is no fee leg.
 */
export interface PaymentLegs {
  /** What `destination` receives; null for an open-amount intent. */
  destinationAmount: string | null;
  fee: { wallet: string; amount: string } | null;
}

/**
 * The legs of `intent`, in its asset's `decimals`. A fee paid by the recipient
 * comes out of `amount`; one paid by the payer is sent beside it. The one rule
 * the builder, the hosted checkout's transaction and the verifier share, so
 * what a payer is asked to sign is what settles the intent.
 *
 * Throws when a stored amount does not parse; the verifier treats that as "no
 * match" rather than let one corrupt row stop the observer's sweep.
 */
export function paymentLegs(
  intent: { amount: string | null; merchantFee: unknown },
  decimals: number,
): PaymentLegs {
  const record = readMerchantFeeRecord(intent.merchantFee);
  if (!record || intent.amount === null) {
    return { destinationAmount: intent.amount, fee: null };
  }
  const amount = parseUnits(intent.amount, decimals);
  const fee = parseUnits(record.amount, decimals);
  const destination = record.paidBy === 'recipient' ? amount - fee : amount;
  return {
    destinationAmount: formatUnits(destination, decimals),
    fee: { wallet: record.wallet, amount: record.amount },
  };
}
