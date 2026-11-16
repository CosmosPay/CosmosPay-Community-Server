import { Logger } from '@nestjs/common';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { PAYMENT_ROUTE_PROBE_ORIGINS } from '@/payment-intents/payment-intents.constants';
import { PaymentRouteProbe } from '@/payment-intents/payment-route-probe.service';

const LINK = {
  kind: 'PAY' as const,
  chain: 'base',
  network: 'public',
  destination: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  amount: '25',
  asset: 'USDC',
  assetIssuer: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  assetDecimals: 6,
  merchantFee: null,
  crossChainFeeBps: 50,
};

function build() {
  const pricing = {
    price: jest.fn(
      (_intent: unknown, request: { originChain: string }, _live: boolean) =>
        request.originChain === 'tron'
          ? Promise.reject(
              ApiError.badRequest(
                ApiErrorCode.ProviderError,
                'The cross-chain route refused the request: Temporary swap limits: minimum swap amount is $100',
              ),
            )
          : Promise.resolve({ amountIn: '25.28' }),
    ),
  };
  return { probe: new PaymentRouteProbe(pricing as never), pricing };
}

describe('PaymentRouteProbe', () => {
  it('asks every main origin with a dry quote and says which cannot pay, and why', async () => {
    const { probe, pricing } = build();
    const routes = await probe.check(LINK);

    expect(pricing.price).toHaveBeenCalledTimes(
      PAYMENT_ROUTE_PROBE_ORIGINS.length,
    );
    for (const call of pricing.price.mock.calls) {
      expect(call[2]).toBe(false);
    }
    expect(routes.find((r) => r.chain === 'tron')).toEqual({
      chain: 'tron',
      asset: 'USDT',
      available: false,
      reason:
        'The cross-chain route refused the request: Temporary swap limits: minimum swap amount is $100',
      amount: null,
    });
    expect(routes.find((r) => r.chain === 'base')).toEqual({
      chain: 'base',
      asset: 'USDC',
      available: true,
      reason: null,
      amount: '25.28',
    });
  });

  it('reuses an answer for the same asset and amount', async () => {
    const { probe, pricing } = build();
    await probe.check(LINK);
    await probe.check({ ...LINK });
    expect(pricing.price).toHaveBeenCalledTimes(
      PAYMENT_ROUTE_PROBE_ORIGINS.length,
    );
    await probe.check({ ...LINK, amount: '500' });
    expect(pricing.price).toHaveBeenCalledTimes(
      2 * PAYMENT_ROUTE_PROBE_ORIGINS.length,
    );
  });

  it('asks nothing for a link without an amount, or one that cannot be paid this way', async () => {
    const { probe, pricing } = build();
    await expect(probe.check({ ...LINK, amount: null })).resolves.toEqual([]);
    await expect(probe.check({ ...LINK, network: 'testnet' })).resolves.toEqual(
      [],
    );
    expect(pricing.price).not.toHaveBeenCalled();
  });

  it('leaves out an origin it could not ask, never showing that error, and asks again next time', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { probe, pricing } = build();
    pricing.price.mockImplementation(
      (_intent: unknown, request: { originChain: string }) =>
        request.originChain === 'eth'
          ? Promise.reject(new Error('socket hang up near 10.0.0.1'))
          : Promise.reject(
              ApiError.unavailable(
                ApiErrorCode.ProviderUnavailable,
                'The cross-chain route is unavailable',
              ),
            ),
    );
    const routes = await probe.check({ ...LINK, amount: '7' });
    expect(routes).toEqual([]);
    expect(JSON.stringify(routes)).not.toContain('10.0.0.1');
    await probe.check({ ...LINK, amount: '7' });
    expect(pricing.price).toHaveBeenCalledTimes(
      2 * PAYMENT_ROUTE_PROBE_ORIGINS.length,
    );
    warn.mockRestore();
  });
});
