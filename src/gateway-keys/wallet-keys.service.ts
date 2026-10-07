import { randomBytes, randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@/config/configuration';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import {
  ApisixAdminClient,
  type GatewayCredential,
} from '@/gateway-keys/apisix-admin.client';
import {
  consumerForwardingPlugin,
  type ForwardEntry,
  luaSafe,
  parseForwardMap,
} from '@/gateway-keys/consumer-forwarder';
import {
  GATEWAY_KEY_RE,
  WALLET_CONSUMER_PREFIX,
  WALLET_CREDENTIAL_PREFIX,
  WALLET_KEY_PLAN,
  WALLET_KEY_SCOPES,
} from '@/gateway-keys/gateway-keys.constants';

type KeyEnv = 'dev' | 'prod';

const KEY_ENVS: readonly KeyEnv[] = ['dev', 'prod'];

/** How each environment's key is spelled and labelled. */
const KEY_SHAPE: Record<KeyEnv, { prefix: string; label: string }> = {
  dev: { prefix: 'dv', label: 'testnet' },
  prod: { prefix: 'prod', label: 'mainnet' },
};

export interface WalletKeys {
  organizationId: string;
  dev: string | null;
  prod: string | null;
}

/** The email as the forwarder may carry it, or "" — which fails a binding check closed. */
function forwardableEmail(email: string): string {
  const e = email.trim().toLowerCase();
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+$/.test(e) ? luaSafe(e) : '';
}

/**
 * Mints the gateway keys behind a finished wallet sign-in, directly in APISIX.
 *
 * This used to be a POST to the developer platform, which made the platform a
 * hard dependency of every sign-in — and the platform is the piece that goes
 * down. The keys it minted and the keys minted here are indistinguishable
 * upstream: the same scopes, labels and consumer forwarder.
 *
 * Idempotent per account. A second sign-in — another device, a reinstall —
 * gets back the keys the account already has instead of minting a new pair
 * each time, which is what the platform did and what left accounts with a
 * credential per sign-in that nobody could revoke by name.
 */
@Injectable()
export class WalletKeysService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WalletKeysService.name);

  constructor(
    private readonly admin: ApisixAdminClient,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /** Whether this deployment can mint keys at all. */
  get configured(): boolean {
    return this.admin.configured;
  }

  /** The swap commission (bps) a wallet account's keys are baked with. */
  private get swapFeeBps(): number {
    return this.config.get('apisixAdmin', { infer: true }).walletSwapFeeBps;
  }

  /**
   * Off the boot path: a gateway that is down must not keep the service from
   * starting, and the next boot tries again.
   */
  onApplicationBootstrap(): void {
    if (!this.admin.configured) return;
    void this.rebakeSwapFees().catch((error: unknown) => {
      this.logger.warn(`wallet keys: fee re-bake skipped: ${String(error)}`);
    });
  }

  /**
   * Re-bakes every wallet consumer whose forwarder carries a swap commission
   * other than `WALLET_KEY_SWAP_FEE_BPS`.
   *
   * The commission is baked into the forwarder at sign-in, so a rate change
   * would otherwise reach an account only on its next sign-in — and until then
   * it keeps paying the old one. Only `f` changes: every other field is kept as
   * it was baked, in the same order, so the body is the one `provision` would
   * write and its next sign-in skips the consumer write. A body this service
   * did not write is left alone.
   */
  async rebakeSwapFees(): Promise<{ rebaked: number; current: number }> {
    const fee = this.swapFeeBps;
    let rebaked = 0;
    let current = 0;
    for (const consumer of await this.admin.listWalletConsumers()) {
      const map = consumer.forwarder
        ? parseForwardMap(consumer.forwarder)
        : null;
      if (!map) continue;
      const entries = Object.values(map);
      if (entries.every((entry) => entry.f === fee)) {
        current++;
        continue;
      }
      for (const entry of entries) entry.f = fee;
      try {
        await this.admin.putConsumer(
          consumer.username,
          { 'serverless-pre-function': consumerForwardingPlugin(map) },
          consumer.labels,
        );
        rebaked++;
      } catch (error) {
        this.logger.warn(
          `wallet keys: re-baking ${consumer.username} failed: ${String(error)}`,
        );
      }
    }
    this.logger.log(
      `wallet keys: swap fee ${fee} bps — ${rebaked} consumer(s) re-baked, ${current} already current`,
    );
    return { rebaked, current };
  }

  /** The consumer an account's keys live under. */
  static consumerFor(accountId: string): string {
    return `${WALLET_CONSUMER_PREFIX}${accountId}`;
  }

  async provision(input: {
    accountId: string;
    email: string;
  }): Promise<WalletKeys> {
    if (!this.admin.configured) {
      throw ApiError.unavailable(
        ApiErrorCode.Misconfigured,
        'This deployment cannot mint API keys: APISIX_ADMIN_URL / APISIX_ADMIN_KEY are not set.',
      );
    }

    const username = WalletKeysService.consumerFor(input.accountId);
    const organizationId = input.accountId;
    try {
      const existing = await this.admin.listCredentials(username);

      const keys: Record<KeyEnv, string | null> = { dev: null, prod: null };
      const minted: Array<{ env: KeyEnv; id: string; key: string }> = [];
      for (const env of KEY_ENVS) {
        const reusable = existing.find(
          (c) => c.labels.env === env && c.key && GATEWAY_KEY_RE.test(c.key),
        );
        if (reusable?.key) {
          keys[env] = reusable.key;
          continue;
        }
        const key = `${KEY_SHAPE[env].prefix}_${randomBytes(32).toString('hex')}`;
        minted.push({
          env,
          id: `${WALLET_CREDENTIAL_PREFIX}${randomUUID()}`,
          key,
        });
        keys[env] = key;
      }

      // The consumer first, carrying the forwarder for every credential it will
      // hold: a credential that authenticates before its entry exists reaches
      // this service with no scopes at all, which fails closed but reads to the
      // person as a broken key.
      const forwarder = consumerForwardingPlugin(
        this.forwardMap(
          [
            ...existing,
            ...minted.map((m) => ({
              id: m.id,
              key: m.key,
              labels: { env: m.env },
            })),
          ],
          organizationId,
          input.email,
        ),
      );
      const current = await this.admin.getConsumerForwarder(username);
      if (current !== forwarder.functions[0]) {
        await this.admin.putConsumer(
          username,
          { 'serverless-pre-function': forwarder },
          { source: 'community-server', wallet_account: input.accountId },
        );
      }

      for (const m of minted) {
        await this.admin.putCredential(username, m.id, {
          key: m.key,
          labels: {
            permissions: JSON.stringify(WALLET_KEY_SCOPES),
            role: 'user',
            env: m.env,
            org: organizationId,
          },
          name: `CosmosWallet (${KEY_SHAPE[m.env].label})`,
          desc: 'Auto-provisioned for the CosmosPay Wallet by the community server',
        });
      }

      if (minted.length) {
        this.logger.log(
          `wallet keys: minted ${minted.map((m) => m.env).join('+')} for ${username}`,
        );
      }
      return { organizationId, dev: keys.dev, prod: keys.prod };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      this.logger.error(
        `wallet keys: provisioning ${username} failed: ${String(error)}`,
      );
      throw ApiError.unavailable(
        ApiErrorCode.Misconfigured,
        'The sign-in could not be completed. Try again shortly.',
      );
    }
  }

  /**
   * One forwarder entry per credential, sorted by id so an unchanged key set
   * bakes an identical function body — which is what lets `provision` skip the
   * consumer write, and with it a churn of APISIX's per-credential cache.
   */
  private forwardMap(
    credentials: GatewayCredential[],
    organizationId: string,
    email: string,
  ): Record<string, ForwardEntry> {
    const fee = this.swapFeeBps;
    const em = forwardableEmail(email);
    const map: Record<string, ForwardEntry> = {};
    for (const c of [...credentials].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      map[c.id] = {
        p: JSON.stringify(WALLET_KEY_SCOPES),
        r: 'user',
        e: c.labels.env === 'prod' ? 'prod' : 'dev',
        o: luaSafe(organizationId),
        pl: WALLET_KEY_PLAN,
        f: fee,
        em,
      };
    }
    return map;
  }
}
