import { Injectable, Logger } from '@nestjs/common';
import type { PollarUserWallet } from '@generated/prisma/client';
import { PollarWalletStatus } from '@generated/prisma/client';
import { counterpartNetwork } from '@/common/stellar-network';
import { StellarNetwork } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import { PollarApiError, PollarClient } from '@/pollar/pollar.client';
import {
  POLLAR_USER_EXISTS_CODES,
  POLLAR_WALLET_PROVISION_BACKOFF_MS,
  POLLAR_WALLET_PROVISION_MAX_ATTEMPTS,
  POLLAR_WALLET_PROVISION_MAX_BACKOFF_MS,
  POLLAR_WALLET_PROVISION_TIMEOUT_MS,
} from '@/pollar/pollar.constants';
import type { PollarWallet } from '@/pollar/pollar.types';
import { asPollarWallet, asId, walletAddress } from '@/pollar/pollar.util';
import { PollarNetworkWalletEntity } from '@/pollar/oauth/entities/pollar-session.entity';

/** The profile Pollar assembled from the OAuth provider, as far as we relay it. */
export interface PollarProvisionProfile {
  first_name?: string;
  last_name?: string;
  avatar?: string;
}

/** Everything a redemption knows about the user it just logged in. */
export interface PollarProvisionInput {
  consumerId: string;
  /** The OAuth email. Empty when the provider vouched for none. */
  externalId: string | null;
  /** The network the login actually ran on. */
  primaryNetwork: StellarNetwork;
  /** The wallet that login returned, if it returned one. */
  wallet: PollarWallet | undefined;
  pollarUserId: string | null;
  profile: PollarProvisionProfile;
}

/**
 * Gets a user a Pollar wallet on **both** Stellar networks, without ever letting
 * the second one fail the first.
 *
 * Pollar runs mainnet and testnet as two separate applications with two separate
 * key pairs, so a hosted login only ever produces a wallet on the network its
 * API key resolved to. That is fine until the user moves between environments:
 * the address they hold on testnet is not the address that receives on mainnet,
 * and the missing wallet gets created lazily, at whatever moment they first need
 * it — which is the moment least able to absorb a provider failure.
 *
 * So a redemption provisions the counterpart network too, through the Server
 * API's `POST /users/with-wallet`, and the attempt is recorded per network in
 * `pollar_user_wallet`.
 *
 * **Nothing here throws into the login.** The counterpart wallet costs the
 * operator XLM, is created against an API that may be down, and may have no key
 * configured at all — none of which is a reason to fail a login that already
 * worked. A failed attempt leaves the row `PENDING` with a backoff, and
 * {@link PollarWalletProvisionSweeperService} finishes it off the request path.
 *
 * The join key across the two networks is the OAuth **email**, because that is
 * what a later hosted login on the other network resolves the same person by.
 * Registering under anything else would provision a wallet nobody ever logs
 * into. A provider that vouches for no email therefore gets no counterpart
 * wallet at all, rather than an orphan one.
 */
@Injectable()
export class PollarWalletProvisioningService {
  private readonly logger = new Logger(PollarWalletProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pollar: PollarClient,
  ) {}

  /**
   * Records the wallet the login already produced and attempts the other
   * network. Returns one entry per network for the redemption response.
   *
   * Never rejects: every failure below resolves to a `pending` entry.
   */
  async provisionBothNetworks(
    input: PollarProvisionInput,
  ): Promise<PollarNetworkWalletEntity[]> {
    const primary = this.fromLogin(input);
    const other = counterpartNetwork(input.primaryNetwork);

    // No email means no handle that addresses this person on the other network.
    // Provisioning anyway would create a wallet keyed to something no future
    // login resolves to — an orphan that costs XLM and is never reachable.
    if (!input.externalId) {
      this.logger.warn(
        `Pollar login on ${input.primaryNetwork} carried no email; skipping ${other} provisioning`,
      );
      return [primary];
    }

    await this.rememberPrimary(input);
    const counterpart = await this.ensure(
      input.consumerId,
      input.externalId,
      other,
      input.profile,
    );
    return [primary, counterpart];
  }

  // ── the counterpart attempt ───────────────────────────────────────────────

  /**
   * Brings one (user, network) row to `READY`, or leaves it `PENDING`.
   *
   * The row is written *before* the Pollar call, not after: if this process dies
   * mid-request the intent still exists and the sweeper picks it up. Writing it
   * afterwards would lose exactly the failures this feature is about.
   */
  private async ensure(
    consumerId: string,
    externalId: string,
    network: StellarNetwork,
    profile: PollarProvisionProfile,
  ): Promise<PollarNetworkWalletEntity> {
    let row: PollarUserWallet;
    try {
      row = await this.prisma.pollarUserWallet.upsert({
        where: {
          consumerId_externalId_network: { consumerId, externalId, network },
        },
        create: { consumerId, externalId, network },
        update: {},
      });
    } catch (err) {
      // The row is the only durable record of the intent, so without it there
      // is nothing to retry — but the login still succeeded, and that is what
      // the caller is waiting on.
      this.logger.error(
        `Could not record Pollar ${network} provisioning for this login`,
        err as Error,
      );
      return { network, status: 'pending', address: null };
    }

    if (row.status === PollarWalletStatus.READY) {
      return this.toEntity(row);
    }

    try {
      return this.toEntity(await this.attempt(row, profile));
    } catch (err) {
      // `attempt` records its own failures; anything escaping it is the
      // bookkeeping itself failing. The row survives with its previous
      // deadline, so the sweeper still owns it.
      this.logger.error(
        `Pollar ${network} provisioning attempt could not be recorded`,
        err as Error,
      );
      return this.toEntity(row);
    }
  }

  /**
   * One registration attempt against `row.network`, and the row that results.
   *
   * Returns the updated row rather than throwing: every caller — the redemption
   * and the sweeper — wants the outcome recorded, not raised.
   */
  async attempt(
    row: PollarUserWallet,
    profile: PollarProvisionProfile = {},
  ): Promise<PollarUserWallet> {
    try {
      const content = await this.pollar.server<Record<string, unknown>>(
        'POST',
        row.network as StellarNetwork,
        '/users/with-wallet',
        {
          body: {
            externalId: row.externalId,
            // The external id IS the email here, so Pollar gets it under both
            // names — it keys on the former and shows the latter.
            email: row.externalId,
            ...(profile.first_name ? { firstName: profile.first_name } : {}),
            ...(profile.last_name ? { lastName: profile.last_name } : {}),
            ...(profile.avatar ? { avatar: profile.avatar } : {}),
          },
          timeoutMs: POLLAR_WALLET_PROVISION_TIMEOUT_MS,
        },
      );
      const wallet = asPollarWallet(content.wallet);
      return await this.settle(row, {
        address: wallet ? walletAddress(wallet) : null,
        walletType: wallet?.type ?? null,
        pollarUserId: asId(content.id) ?? asId(content.userId),
      });
    } catch (err) {
      // Pollar already having this user is the outcome we wanted, reached by
      // somebody else — a previous sweep, the other network's login, an
      // operator's own call to POST /v1/pollar/users/with-wallet.
      if (
        err instanceof PollarApiError &&
        POLLAR_USER_EXISTS_CODES.has(err.code)
      ) {
        return this.settle(row, {
          address: row.address,
          walletType: row.walletType,
          pollarUserId: row.pollarUserId,
        });
      }
      return this.defer(row, err);
    }
  }

  /** The attempt landed: terminal `READY`, nothing left to retry. */
  private settle(
    row: PollarUserWallet,
    wallet: Pick<PollarUserWallet, 'address' | 'walletType' | 'pollarUserId'>,
  ): Promise<PollarUserWallet> {
    return this.prisma.pollarUserWallet.update({
      where: { id: row.id },
      data: {
        status: PollarWalletStatus.READY,
        attempts: row.attempts + 1,
        errorCode: null,
        nextAttemptAt: null,
        ...wallet,
      },
    });
  }

  /**
   * The attempt did not land: burn one of the budget and schedule the next.
   *
   * Out of budget is `FAILED` rather than an endless `PENDING` — ten refusals of
   * the same registration is a configuration problem (no key for that network, a
   * rejected email), and asking again every minute forever only spends requests
   * to log the same line.
   */
  private async defer(
    row: PollarUserWallet,
    err: unknown,
  ): Promise<PollarUserWallet> {
    const attempts = row.attempts + 1;
    const exhausted = attempts >= POLLAR_WALLET_PROVISION_MAX_ATTEMPTS;
    const errorCode =
      err instanceof PollarApiError ? err.code : 'PROVISIONING_UNAVAILABLE';

    this.logger.warn(
      `Pollar ${row.network} wallet still pending after attempt ${attempts}` +
        `${exhausted ? ' (budget exhausted)' : ''}: ${errorCode}`,
    );

    try {
      return await this.prisma.pollarUserWallet.update({
        where: { id: row.id },
        data: {
          status: exhausted
            ? PollarWalletStatus.FAILED
            : PollarWalletStatus.PENDING,
          attempts,
          errorCode,
          nextAttemptAt: exhausted
            ? null
            : new Date(Date.now() + backoff(attempts)),
        },
      });
    } catch (write) {
      // Losing the bookkeeping must not turn a pending wallet into a failed
      // login. The row keeps its previous deadline and is retried on that.
      this.logger.error(
        `Could not record the failed Pollar ${row.network} attempt`,
        write as Error,
      );
      return row;
    }
  }

  // ── the primary network ───────────────────────────────────────────────────

  /**
   * Mirrors the wallet the login just returned into the same table, so both
   * networks are readable from one place and a later login on the *other*
   * network finds this one already `READY` instead of re-registering it.
   */
  private async rememberPrimary(input: PollarProvisionInput): Promise<void> {
    const address = walletAddress(input.wallet);
    const wallet = {
      address,
      walletType: input.wallet?.type ?? null,
      pollarUserId: input.pollarUserId,
    };

    try {
      await this.prisma.pollarUserWallet.upsert({
        where: {
          consumerId_externalId_network: {
            consumerId: input.consumerId,
            externalId: input.externalId!,
            network: input.primaryNetwork,
          },
        },
        create: {
          consumerId: input.consumerId,
          externalId: input.externalId!,
          network: input.primaryNetwork,
          // Pollar can hand back a session before the wallet has an address
          // (the Deferred funding mode). That is not READY: there is nothing to
          // receive into yet, and the sweeper should keep asking.
          status: address
            ? PollarWalletStatus.READY
            : PollarWalletStatus.PENDING,
          ...wallet,
        },
        // Only ever an improvement. A login that came back without an address
        // must not erase one an earlier login established — the wallet did not
        // stop existing, this response just did not carry it — so an empty
        // update leaves the row exactly as it was.
        update: address
          ? {
              status: PollarWalletStatus.READY,
              errorCode: null,
              nextAttemptAt: null,
              ...wallet,
            }
          : {},
      });
    } catch (err) {
      // Cosmetic for this request — the wallet exists either way and the
      // response carries it straight from the login payload.
      this.logger.error(
        `Could not mirror the ${input.primaryNetwork} Pollar wallet`,
        err as Error,
      );
    }
  }

  // ── projections ───────────────────────────────────────────────────────────

  /** The primary network's entry, straight from what the login returned. */
  private fromLogin(input: PollarProvisionInput): PollarNetworkWalletEntity {
    const address = walletAddress(input.wallet);
    return {
      network: input.primaryNetwork,
      status: address ? 'ready' : 'pending',
      address,
    };
  }

  private toEntity(row: PollarUserWallet): PollarNetworkWalletEntity {
    return {
      network: row.network,
      status: STATUS_LABEL[row.status],
      address: row.address,
    };
  }
}

/** Wire spelling of the provisioning status. Lowercase, like every other enum here. */
const STATUS_LABEL: Record<PollarWalletStatus, 'ready' | 'pending' | 'failed'> =
  {
    [PollarWalletStatus.READY]: 'ready',
    [PollarWalletStatus.PENDING]: 'pending',
    [PollarWalletStatus.FAILED]: 'failed',
  };

/**
 * Exponential, capped. The common failure is an operator who has not configured
 * the other network's keys yet, which is fixed on a human timescale — so the
 * first retry is a minute out and a long-failing row still gets an hourly try.
 */
function backoff(attempts: number): number {
  return Math.min(
    POLLAR_WALLET_PROVISION_BACKOFF_MS * 2 ** (attempts - 1),
    POLLAR_WALLET_PROVISION_MAX_BACKOFF_MS,
  );
}
