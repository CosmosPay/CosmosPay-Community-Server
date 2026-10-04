import type { Logger } from '@nestjs/common';
import { StellarNetwork } from '@/config/configuration';
import { horizonStatus, isHorizonNotFound } from '@/stellar/horizon-errors';
import type { StellarService } from '@/stellar/stellar.service';

/**
 * What the chain says about a transaction.
 *
 * `absent` and `unknown` must stay distinct. They used to be one value
 * (`unsettled`), which meant "Horizon returned 404" and "we could not reach
 * Horizon" were indistinguishable — and the observer's expiry branch acted on
 * both. A transaction that had settled on-chain and paid the platform its
 * commission was marked EXPIRED during a Horizon outage, and since the observer
 * only selected in-flight rows it was never looked at again.
 */
export type TransactionSettlement =
  'succeeded' | 'failed' | 'absent' | 'unknown';

/**
 * Looks a transaction up by its deterministic hash on Horizon.
 *
 * Signing does not change the hash, so a customer who signs and broadcasts the
 * transaction themselves — straight from their wallet through the SEP-7 link,
 * bypassing our submit endpoint — still settles under the hash we stored. Both
 * writers of a swap or liquidity row ask through here: the settlement observer
 * on every tick, and the relay when Horizon rejects a submission, because a
 * rejection of *this* broadcast says nothing about whether the same transaction
 * already landed from somewhere else.
 *
 * A 404 means it is not on-chain (`absent`) — or not yet ingested. Any other
 * error is transient (`unknown`) and must never be read as "it never settled":
 * a 429, a 504 or a socket timeout tells us nothing about the transaction.
 */
export async function transactionSettlement(
  stellar: StellarService,
  network: string,
  txHash: string,
  logger: Logger,
): Promise<TransactionSettlement> {
  try {
    const tx = await stellar
      .server(network as StellarNetwork)
      .transactions()
      .transaction(txHash)
      .call();
    return tx.successful ? 'succeeded' : 'failed';
  } catch (err) {
    if (isHorizonNotFound(err)) return 'absent';
    logger.warn(
      `Horizon lookup failed for tx ${txHash} (status ${horizonStatus(err) ?? 'none'}); ` +
        'leaving the operation as it is for the next cycle',
    );
    return 'unknown';
  }
}
