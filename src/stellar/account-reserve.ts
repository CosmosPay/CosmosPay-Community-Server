import { BASE_RESERVE_STROOPS } from '@/stellar/stellar.constants';
import { toStroops } from '@/swaps/swap-math';

/**
 * The fields Horizon reports on an account that decide how much XLM it must
 * keep. All optional: an account that never sponsored anything, or a test
 * double, reads as zero.
 */
export interface ReserveFields {
  subentry_count?: number;
  num_sponsoring?: number;
  num_sponsored?: number;
}

/** A balance line, as far as the reserve arithmetic reads it. */
export interface NativeBalanceLine {
  asset_type?: string;
  balance?: string;
  selling_liabilities?: string;
}

/**
 * The XLM an account must keep, in stroops, once it has `extraSubentries` more
 * subentries than Horizon reports:
 * `(2 + subentries + sponsoring - sponsored) × base reserve`.
 *
 * Sponsorship moves reserve between accounts (CAP-33): an entry another account
 * sponsors costs this one nothing (`num_sponsored`), and every entry this one
 * sponsors for someone else costs it a base reserve (`num_sponsoring`). A
 * trustline the account adds for itself is one more subentry it pays for, which
 * is what `extraSubentries` prices.
 */
export function minimumBalanceStroops(
  account: ReserveFields,
  extraSubentries = 0n,
): bigint {
  const entries =
    2n +
    BigInt(account.subentry_count ?? 0) +
    BigInt(account.num_sponsoring ?? 0) -
    BigInt(account.num_sponsored ?? 0) +
    extraSubentries;
  return entries * BASE_RESERVE_STROOPS;
}

/** The account's XLM balance, in stroops (zero when Horizon lists none). */
export function nativeBalanceStroops(balances: NativeBalanceLine[]): bigint {
  return toStroops(nativeLine(balances)?.balance ?? '0');
}

/**
 * XLM promised to the account's open sell offers, in stroops. The protocol keeps
 * it out of reach exactly as it keeps the reserve: an operation may spend only
 * what is left of the balance after both.
 */
export function nativeSellingLiabilitiesStroops(
  balances: NativeBalanceLine[],
): bigint {
  return toStroops(nativeLine(balances)?.selling_liabilities ?? '0');
}

function nativeLine(
  balances: NativeBalanceLine[],
): NativeBalanceLine | undefined {
  return balances.find((b) => b.asset_type === 'native');
}
