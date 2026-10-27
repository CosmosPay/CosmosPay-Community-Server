import { Injectable, Logger } from '@nestjs/common';
import { USD_PRICES_WAIT_MS } from '@/analytics/analytics.constants';
import { usdPricer, type UsdPricer } from '@/analytics/usd-prices';
import { NearIntentsClient } from '@/near-intents/near-intents.client';
import type { NearIntentsToken } from '@/near-intents/near-intents.types';

/**
 * Prices for the dashboard's USD figures, from NEAR Intents' cached token list. A figure is never
 * worth failing a summary over: when the list cannot be read in {@link USD_PRICES_WAIT_MS}, this
 * answers null and the caller reports its USD fields as null.
 */
@Injectable()
export class UsdPricesService {
  private readonly logger = new Logger(UsdPricesService.name);

  constructor(private readonly nearIntents: NearIntentsClient) {}

  /** The pricer for one network tier (`public` / `testnet`), or null without a price list. */
  async pricer(network: string): Promise<UsdPricer | null> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), USD_PRICES_WAIT_MS);
      timer.unref();
    });
    try {
      const tokens: NearIntentsToken[] | null = await Promise.race([
        this.nearIntents.tokens(),
        late,
      ]);
      if (!tokens) {
        this.logger.warn(
          `NEAR Intents' token list took over ${USD_PRICES_WAIT_MS} ms; USD figures omitted`,
        );
        return null;
      }
      return usdPricer(tokens, network);
    } catch (err) {
      this.logger.warn(
        `NEAR Intents' token list is unavailable; USD figures omitted: ${(err as Error).message}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
