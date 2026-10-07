import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@/config/configuration';
import { WALLET_CONSUMER_PREFIX } from '@/gateway-keys/gateway-keys.constants';

/** One credential as the Admin API returns it — only the fields read here. */
export interface GatewayCredential {
  id: string;
  key: string | null;
  labels: Record<string, string>;
}

/** One wallet consumer as the Admin API lists it — only the fields read here. */
export interface WalletConsumer {
  username: string;
  forwarder: string | null;
  labels: Record<string, string>;
}

/**
 * The APISIX Admin API, narrowed to what wallet provisioning needs.
 *
 * The admin key can rewrite every route and every consumer on the gateway, and
 * APISIX has no narrower grant to hand out. So the narrowing happens here: this
 * client exposes only consumer and credential writes, and refuses any consumer
 * outside `WALLET_CONSUMER_PREFIX` before a request is built. A bug elsewhere in
 * this service can mint a wallet key; it cannot touch a route, the public key or
 * a developer's own consumer through this class.
 */
@Injectable()
export class ApisixAdminClient {
  private readonly logger = new Logger(ApisixAdminClient.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  private get settings() {
    return this.config.get('apisixAdmin', { infer: true });
  }

  get configured(): boolean {
    return Boolean(this.settings.url && this.settings.key);
  }

  /** The consumer's current forwarder body, or null when it has none / does not exist. */
  async getConsumerForwarder(username: string): Promise<string | null> {
    const body = (await this.request('GET', this.consumerPath(username), {
      allowNotFound: true,
    })) as {
      value?: {
        plugins?: { 'serverless-pre-function'?: { functions?: string[] } };
      };
    } | null;
    return (
      body?.value?.plugins?.['serverless-pre-function']?.functions?.[0] ?? null
    );
  }

  /**
   * Every wallet consumer on the gateway. The Admin API lists them all; any
   * outside `WALLET_CONSUMER_PREFIX` is dropped here, so a caller never sees a
   * developer's consumer.
   */
  async listWalletConsumers(): Promise<WalletConsumer[]> {
    const body = (await this.request('GET', '/consumers')) as {
      list?: Array<{
        value?: {
          username?: string;
          labels?: Record<string, string>;
          plugins?: { 'serverless-pre-function'?: { functions?: string[] } };
        };
      }>;
    } | null;
    return (body?.list ?? []).flatMap((item) => {
      const v = item?.value;
      if (!v?.username?.startsWith(WALLET_CONSUMER_PREFIX)) return [];
      return [
        {
          username: v.username,
          forwarder:
            v.plugins?.['serverless-pre-function']?.functions?.[0] ?? null,
          labels: v.labels ?? {},
        },
      ];
    });
  }

  /** Create or replace the consumer with exactly this plugin set and these labels. */
  async putConsumer(
    username: string,
    plugins: Record<string, unknown>,
    labels: Record<string, string>,
  ): Promise<void> {
    this.consumerPath(username);
    await this.request('PUT', '/consumers', {
      body: { username, plugins, labels },
    });
  }

  async listCredentials(username: string): Promise<GatewayCredential[]> {
    const body = (await this.request(
      'GET',
      `${this.consumerPath(username)}/credentials`,
      { allowNotFound: true },
    )) as {
      list?: Array<{
        value?: {
          id?: string;
          labels?: Record<string, string>;
          plugins?: { 'key-auth'?: { key?: string } };
        };
      }>;
    } | null;
    return (body?.list ?? []).flatMap((item) => {
      const v = item?.value;
      if (!v?.id) return [];
      return [
        {
          id: v.id,
          key: v.plugins?.['key-auth']?.key ?? null,
          labels: v.labels ?? {},
        },
      ];
    });
  }

  async putCredential(
    username: string,
    credentialId: string,
    input: {
      key: string;
      labels: Record<string, string>;
      name: string;
      desc: string;
    },
  ): Promise<void> {
    await this.request(
      'PUT',
      `${this.consumerPath(username)}/credentials/${encodeURIComponent(credentialId)}`,
      {
        body: {
          plugins: { 'key-auth': { key: input.key } },
          labels: input.labels,
          name: input.name,
          desc: input.desc,
        },
      },
    );
  }

  /** `/consumers/<username>`, or a throw for a name outside the wallet namespace. */
  private consumerPath(username: string): string {
    if (
      !username.startsWith(WALLET_CONSUMER_PREFIX) ||
      !/^[A-Za-z0-9_-]+$/.test(username)
    ) {
      throw new Error(`Refusing to write consumer "${username}".`);
    }
    return `/consumers/${username}`;
  }

  private async request(
    method: 'GET' | 'PUT',
    path: string,
    opts: { body?: unknown; allowNotFound?: boolean } = {},
  ): Promise<unknown> {
    const { url, key, timeoutMs } = this.settings;
    if (!url || !key)
      throw new Error('The APISIX Admin API is not configured.');

    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        'x-api-key': key,
        ...(opts.body ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404 && opts.allowNotFound) return null;
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.error(
        `apisix admin: ${method} ${path} answered ${res.status}: ${detail.slice(0, 300)}`,
      );
      throw new Error(`APISIX admin ${method} ${path} failed (${res.status}).`);
    }
    return res.json().catch(() => null);
  }
}
