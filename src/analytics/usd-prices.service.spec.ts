import { USD_PRICES_WAIT_MS } from '@/analytics/analytics.constants';
import { UsdPricesService } from '@/analytics/usd-prices.service';
import type { NearIntentsClient } from '@/near-intents/near-intents.client';
import type { NearIntentsToken } from '@/near-intents/near-intents.types';

const XLM: NearIntentsToken = {
  assetId: 'nep245:xlm',
  blockchain: 'stellar',
  symbol: 'XLM',
  decimals: 7,
  price: 0.25,
};

/** The summary's prices never fail it: a NEAR Intents outage or a slow list is no USD figure. */
describe('UsdPricesService', () => {
  afterEach(() => jest.useRealTimers());

  const service = (tokens: () => Promise<NearIntentsToken[]>) =>
    new UsdPricesService({ tokens } as unknown as NearIntentsClient);

  it('prices the network tier it is asked for from the token list', async () => {
    const pricer = await service(() => Promise.resolve([XLM])).pricer(
      'testnet',
    );
    expect(pricer?.({ chain: 'stellar', asset: 'XLM', issuer: null })).toBe(
      0.25,
    );
  });

  it('answers null when NEAR Intents cannot be reached', async () => {
    const pricer = await service(() =>
      Promise.reject(new Error('NEAR Intents is unavailable')),
    ).pricer('public');
    expect(pricer).toBeNull();
  });

  it('answers null when the list takes longer than the summary waits', async () => {
    jest.useFakeTimers();
    const pending = service(
      () => new Promise<NearIntentsToken[]>(() => {}),
    ).pricer('public');
    jest.advanceTimersByTime(USD_PRICES_WAIT_MS);
    await expect(pending).resolves.toBeNull();
  });
});
