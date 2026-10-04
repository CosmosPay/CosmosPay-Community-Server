import type { PaymentIntent, Prisma } from '@generated/prisma/client';
import type { Chain } from '@/chains/chains.constants';
import { SETTLEMENT_RIVALS_MAX } from '@/payment-intents/payment-intents.constants';
import { STELLAR_DECIMALS } from '@/stellar/stellar.constants';
import { fromStroops, toStroops } from '@/swaps/swap-math';

/** A filter no row satisfies: the chain has no rivals for this intent. */
const NO_RIVALS: Prisma.PaymentIntentWhereInput = { id: { in: [] } };

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
 * settles it. But they must narrow to rows that describe the SAME payment:
 * every row they admit can cost a verifier call, and a filter wider than the
 * payment let anyone fill it with junk intents at a merchant's address. Each
 * keeps what the verifier itself requires a rival to share with this intent:
 *
 * - Stellar: memo, destination, asset (code and issuer), and amount — the same
 *   number of stroops, which is what the verifier compares, or no amount at
 *   all, since an open-amount intent is paid by any amount. When THIS intent is
 *   open, the amount it was paid is not known here, so rivals of any amount are
 *   asked about; the memo, destination and asset still bound them. A rival paid
 *   by a different operation of the same transaction (a batch to two
 *   destinations) is not looked for; the claim still lets only one settle,
 *   first come.
 * - Solana: the reference key, which is random per intent, so no other intent
 *   carries it and no copy can be paid by the same transfer.
 * - Monad, an intent paying the merchant directly (no relayer): only an intent
 *   whose DEPOSIT address is this intent's destination, in the same token. That
 *   closes a copy aimed at someone's deposit address, which the payer's own
 *   transfer pays while the relayer's forward settles the original under a
 *   different hash. Two direct intents are NOT ranked against each other: the
 *   payment carries nothing that is the intent's own — no memo, no reference;
 *   destination, token and amount are public — so whoever pre-creates an
 *   intent for a merchant's address and price would hold age precedence over
 *   every intent the merchant makes after it, for as long as they keep
 *   re-creating it. Between two direct intents the claim decides, first come.
 *   The README sends integrators to the relayer's deposit addresses, where
 *   every intent is identified by an address nobody else can hold.
 * - Monad, an intent with a deposit address: none. The address exists only on
 *   this intent, and a copy aimed at it is necessarily younger.
 */
export const SETTLEMENT_RIVAL_FILTERS: Record<
  Chain,
  (intent: PaymentIntent) => Prisma.PaymentIntentWhereInput
> = {
  stellar: (intent) => ({
    memo: intent.memo,
    destination: intent.destination,
    asset: intent.asset,
    assetIssuer: intent.assetIssuer,
    ...stellarAmount(intent.amount),
  }),
  solana: (intent) =>
    intent.chainReference
      ? { chainReference: intent.chainReference }
      : NO_RIVALS,
  monad: (intent) =>
    intent.chainReference
      ? NO_RIVALS
      : {
          chainReference: intent.destination,
          assetIssuer: intent.assetIssuer,
        },
};

/**
 * Rivals by amount on Stellar: open ones, or ones for the same number of
 * stroops. Stored amounts keep the spelling they were sent in, so the same
 * amount is matched in every spelling a request can give it — `25.5` through
 * `25.5000000`. One with leading zeros (`025.5`) is not, and that rival is
 * then not asked about: the claim decides between the two, first come — never
 * a refusal of this intent.
 */
function stellarAmount(amount: string | null): Prisma.PaymentIntentWhereInput {
  if (amount === null) return {};
  return {
    OR: [{ amount: null }, { amount: { in: amountSpellings(amount) } }],
  };
}

function amountSpellings(amount: string): string[] {
  let canonical: string;
  try {
    canonical = fromStroops(toStroops(amount));
  } catch {
    return [amount];
  }
  const [whole, frac = ''] = canonical.split('.');
  const spellings = new Set([amount, canonical]);
  for (let places = frac.length + 1; places <= STELLAR_DECIMALS; places += 1) {
    spellings.add(`${whole}.${frac.padEnd(places, '0')}`);
  }
  return [...spellings];
}

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
 * Only the oldest {@link SETTLEMENT_RIVALS_MAX} are read — see the constant
 * for why the rest are left to the claim.
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
    take: SETTLEMENT_RIVALS_MAX,
  };
}
