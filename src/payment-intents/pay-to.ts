import type { PaymentIntent } from '@generated/prisma/client';
import type { Chain } from '@/chains/chains.constants';

/** The columns that decide where an intent's payer sends the money. */
export type PayToFields = Pick<PaymentIntent, 'destination' | 'chainReference'>;

/**
 * Where the payer of an intent sends the money, per chain: always the address
 * its `uri` pays, because the link builder that wrote the URI stored the same
 * value (`Sep7LinkBuilder`, `ChainPayLinkBuilder`).
 *
 *   - Stellar: `destination`. A SEP-7 `pay` link carries it as `destination=`,
 *     and the envelope a `tx` link carries pays it.
 *   - Solana: `destination`, the Solana Pay recipient. `chainReference` is the
 *     intent's `reference` KEY, which the wallet attaches to the transfer as a
 *     read-only account. It is a fresh random key nobody holds, so money sent
 *     to it is gone.
 *   - Monad: the intent's CREATE2 deposit address when the deployment has a
 *     relayer — stored as `chainReference`, and the address the EIP-681 link
 *     pays; the forwarder later pays the merchant less `networkFee`. Without a
 *     relayer `chainReference` is null and the link pays `destination`.
 *
 * A table rather than one `chainReference ?? destination` for every chain: that
 * line is right on Monad and sends a Solana payer to a key nobody controls. The
 * EVM verifier reads the Monad entry, so the address a payment is checked
 * against and the address a payer is shown are one rule.
 */
export const PAY_TO: Record<Chain, (intent: PayToFields) => string> = {
  stellar: (intent) => intent.destination,
  solana: (intent) => intent.destination,
  monad: (intent) => intent.chainReference ?? intent.destination,
};
