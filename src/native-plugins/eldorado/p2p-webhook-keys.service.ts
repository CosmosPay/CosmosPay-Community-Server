import type { KeyObject } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { StellarNetwork } from '@/config/configuration';
import { EldoradoClient } from '@/native-plugins/eldorado/eldorado.client';
import {
  P2P_MARKETPLACE,
  P2P_WEBHOOK_KEYS_REFETCH_MS,
  P2P_WEBHOOK_NETWORKS,
} from '@/native-plugins/eldorado/eldorado.constants';
import {
  readWebhookJwks,
  webhookSignedByAny,
} from '@/native-plugins/eldorado/p2p-webhook-signature';

/**
 * The keys each network's marketplace signs its webhooks with, and which one
 * signed a delivery.
 *
 * One deployment serves both networks (a `prod` key trades on mainnet, a `dev`
 * key in the sandbox), and each marketplace signs with its own JWKS. The key
 * that verifies a delivery is what says which network sent it, and so which
 * sessions it may touch: nothing in the body is trusted for that.
 *
 * Each set is read on first use and kept. When a delivery verifies against no
 * key on hand (the marketplace rotated them) each set is read again, at most
 * once a minute per network ({@link P2P_WEBHOOK_KEYS_REFETCH_MS}), whatever the
 * outcome of the last read, so forged deliveries cannot make this service hammer
 * the marketplace.
 */
@Injectable()
export class P2pWebhookKeys {
  private readonly logger = new Logger(P2pWebhookKeys.name);
  private readonly sets = new Map<StellarNetwork, KeyObject[]>();
  private readonly readAt = new Map<StellarNetwork, number>();
  private readonly inFlight = new Map<
    StellarNetwork,
    Promise<KeyObject[] | null>
  >();

  constructor(private readonly client: EldoradoClient) {}

  /**
   * The network whose marketplace signed `hashHex` with `signature`, or null
   * when no key of either verifies it. When none does and a network's keys
   * could not be read at all, the delivery cannot be judged: a 503, so the
   * marketplace sends it again instead of it being refused as forged.
   */
  async signer(
    hashHex: string,
    signature: string,
  ): Promise<StellarNetwork | null> {
    for (const network of P2P_WEBHOOK_NETWORKS) {
      const keys = this.sets.get(network) ?? (await this.refresh(network));
      if (keys && webhookSignedByAny(hashHex, signature, keys)) return network;
    }
    for (const network of P2P_WEBHOOK_NETWORKS) {
      const keys = await this.refresh(network);
      if (keys && webhookSignedByAny(hashHex, signature, keys)) return network;
    }
    const unread = P2P_WEBHOOK_NETWORKS.filter((n) => !this.sets.has(n));
    if (unread.length > 0) {
      this.logger.warn(
        `A ${P2P_MARKETPLACE} webhook verified against no key on hand, and the keys of ${unread.join(', ')} could not be read`,
      );
      throw ApiError.unavailable(
        ApiErrorCode.ProviderUnavailable,
        'The webhook signing keys could not be read right now; send it again later.',
      );
    }
    return null;
  }

  /**
   * One network's keys read again, unless they were read (or tried) within
   * the last minute: then null, and the set on hand stays. A failed read or a
   * set with no usable key is logged and keeps the set on hand.
   */
  private refresh(network: StellarNetwork): Promise<KeyObject[] | null> {
    const running = this.inFlight.get(network);
    if (running) return running;
    const last = this.readAt.get(network);
    if (last !== undefined && Date.now() - last < P2P_WEBHOOK_KEYS_REFETCH_MS) {
      return Promise.resolve(null);
    }
    this.readAt.set(network, Date.now());
    const read = this.client
      .webhookKeys(network)
      .then((answer) => {
        const keys = readWebhookJwks(answer);
        if (keys.length === 0) {
          this.logger.warn(
            `The ${P2P_MARKETPLACE} webhook JWKS of ${network} holds no RSA signing key`,
          );
          return null;
        }
        this.sets.set(network, keys);
        return keys;
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `The ${P2P_MARKETPLACE} webhook JWKS of ${network} could not be read: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return null;
      })
      .finally(() => this.inFlight.delete(network));
    this.inFlight.set(network, read);
    return read;
  }
}
