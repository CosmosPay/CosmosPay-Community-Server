import { Injectable, Logger } from '@nestjs/common';
import { requestUpstreamJson, UpstreamNotFound } from '@/common/upstream-http';
import {
  LAYERZERO_SCAN_API_URL,
  LAYERZERO_SCAN_TIMEOUT_MS,
} from '@/usdt0/usdt0.constants';
import type { LayerZeroScanResponse } from '@/usdt0/usdt0-scan';

/**
 * The one way this service reaches LayerZero Scan's public API
 * (`https://scan.layerzero-api.com/v1`, no key): the messages a transfer's
 * transaction sent. Feature code never builds a Scan URL.
 *
 * Two lookups, because Scan indexes a message sent from Stellar by its guid
 * first and fills in the source transaction later (a lookup by the Stellar
 * hash answers 404 for minutes after the transaction landed). The guid comes
 * from `send`'s return value, so it is asked first whenever it is known.
 */
@Injectable()
export class LayerZeroScanClient {
  private readonly logger = new Logger(LayerZeroScanClient.name);

  /** The message with this guid (0x + 64 hex), or null when Scan has none yet. */
  byGuid(guid: string): Promise<LayerZeroScanResponse | null> {
    return this.get(`/messages/guid/${encodeURIComponent(guid)}`);
  }

  /**
   * The messages a source transaction sent, by its hash (a Stellar hash is
   * 64 lowercase hex with no `0x`, as Scan stores it), or null when Scan has
   * none yet.
   */
  byTransaction(txHash: string): Promise<LayerZeroScanResponse | null> {
    return this.get(`/messages/tx/${encodeURIComponent(txHash)}`);
  }

  private async get(path: string): Promise<LayerZeroScanResponse | null> {
    try {
      return await requestUpstreamJson<LayerZeroScanResponse>(
        {
          provider: 'LayerZero Scan',
          // Scan takes no key; a 401 or 403 would name this instead.
          keyEnv: 'no key (LayerZero Scan is public)',
          method: 'GET',
          url: `${LAYERZERO_SCAN_API_URL}${path}`,
          timeoutMs: LAYERZERO_SCAN_TIMEOUT_MS,
        },
        this.logger,
      );
    } catch (err) {
      if (err instanceof UpstreamNotFound) return null;
      throw err;
    }
  }
}
