import type { PaymentIntent, Prisma } from '@generated/prisma/client';
import type { Chain } from '@/chains/chains.constants';
import { payee } from '@/payment-intents/evm-verifier.service';
import { SETTLEMENT_RIVALS_MAX } from '@/payment-intents/payment-intents.constants';

/**
 * Which older intents may outrank `intent` for a payment: those of OTHER
 * consumers that the same payment could also pay. The oldest intent a payment
 * pays is the one it settles.
 *
 * The settlement claim (`payment_settlement`) already lets one transaction
 * settle one intent, but on its own the first claim wins — and a copycat's
 * observer tick can come before the original's. A tenant copying another's
 * destination, amount and memo then took the payment and left the original to
 * expire unpaid. A copy can only be made of an intent that already exists, so
 * the original is older, and age is the tiebreak a copycat cannot win.
 *
 * These filters only NARROW the candidates; whether a candidate is really paid
 * is the chain verifier's answer (`verifyByHash`), the same predicate that
 * settles it. Each filter keeps the fields a copy must share to be paid by the
 * same transfer:
 *
 * - Stellar: the memo and the destination. A transaction carries one memo, and
 *   the copy is paid by the operation that pays the original. A rival paid by a
 *   different operation of the same transaction (a batch to two destinations)
 *   is not looked for; the claim's primary key still lets only one of them
 *   settle, first come.
 * - Solana: the reference key, which is random per intent, so no other intent
 *   carries it and no copy can be paid by the same transfer.
 * - Monad: the address the payment lands at — an intent paid there directly
 *   (`destination`) or through its deposit address (`chainReference`). The
 *   second is what makes a copy whose destination is someone's deposit address
 *   lose to that intent, even after the relayer's forward — a different hash —
 *   has settled it.
 */
export const SETTLEMENT_RIVAL_FILTERS: Record<
  Chain,
  (intent: PaymentIntent) => Prisma.PaymentIntentWhereInput
> = {
  stellar: (intent) => ({
    memo: intent.memo,
    destination: intent.destination,
  }),
  solana: (intent) =>
    intent.chainReference
      ? { chainReference: intent.chainReference }
      : { id: { in: [] } },
  monad: (intent) => {
    const at = payee(intent);
    return { OR: [{ destination: at }, { chainReference: at }] };
  },
};

/**
 * The query for `intent`'s rivals, oldest first: same chain and network, a
 * different consumer, created before it (the id breaks a tie in `createdAt`),
 * and PENDING, SUBMITTED or SUCCEEDED: open for the payment, or already
 * credited with it (the relayer may have settled it on its forward, under
 * another hash).
 *
 * EXPIRED is left out on purpose, although a verified payment still settles an
 * EXPIRED intent. Counted, it let a copy made BEFORE the original, with a
 * guessed, predictable memo, outrank the original forever. Left out, a copy
 * outranks it only for the copy's own lifetime. The price: a payment that
 * lands after the original has expired can go to a newer copy that has not.
 * The original no longer outranks it, and the claim then goes to whichever
 * settles first. CANCELLED and FAILED give a payment up.
 *
 * One more than {@link SETTLEMENT_RIVALS_MAX} is read, so the caller can tell
 * a full list from an overflowing one.
 */
export function settlementRivalsQuery(
  chain: Chain,
  intent: PaymentIntent,
): Prisma.PaymentIntentFindManyArgs {
  return {
    where: {
      AND: [
        SETTLEMENT_RIVAL_FILTERS[chain](intent),
        {
          chain,
          network: intent.network,
          consumerId: { not: intent.consumerId },
          status: { in: ['PENDING', 'SUBMITTED', 'SUCCEEDED'] },
          OR: [
            { createdAt: { lt: intent.createdAt } },
            { createdAt: intent.createdAt, id: { lt: intent.id } },
          ],
        },
      ],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: SETTLEMENT_RIVALS_MAX + 1,
  };
}
