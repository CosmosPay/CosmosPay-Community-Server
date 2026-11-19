import {
  completionRate,
  hasLiquidity,
  offerRefusal,
  rankOffers,
  withinLimits,
  type P2pMatchRequest,
  type P2pOfferCandidate,
} from '@/p2p/p2p-matching';

const NOW = new Date('2026-11-19T12:00:00Z');

function offer(overrides: Partial<P2pOfferCandidate> = {}): P2pOfferCandidate {
  return {
    offerId: 'o1',
    accountId: 'a1',
    priceUnits: 1_000_000_000n,
    priceUpdatedAt: new Date(NOW.getTime() - 60_000),
    priceTtlSeconds: 600,
    minFiatUnits: 1_000n,
    maxFiatUnits: 1_000_000_00n,
    rails: ['ar_bank_transfer'],
    merchantStatus: 'ACTIVE',
    openOrders: 0,
    hasPaymentMethod: true,
    completed: 10,
    cancelled: 0,
    disputesLost: 0,
    medianReleaseSeconds: 120,
    ...overrides,
  };
}

const BUY: P2pMatchRequest = {
  side: 'BUY',
  rail: 'ar_bank_transfer',
  now: NOW,
  maxOpenOrders: 5,
};

describe('P2P matching', () => {
  it('takes an active, fresh offer on the rail with room', () => {
    expect(offerRefusal(offer(), BUY)).toBeNull();
  });

  it('leaves out paused or suspended merchants, stale prices, other rails and busy merchants', () => {
    expect(offerRefusal(offer({ merchantStatus: 'PAUSED' }), BUY)).toBe(
      'merchant_inactive',
    );
    expect(offerRefusal(offer({ merchantStatus: 'SUSPENDED' }), BUY)).toBe(
      'merchant_inactive',
    );
    expect(
      offerRefusal(
        offer({ priceUpdatedAt: new Date(NOW.getTime() - 601_000) }),
        BUY,
      ),
    ).toBe('price_stale');
    expect(offerRefusal(offer({ rails: ['br_pix'] }), BUY)).toBe('rail');
    expect(offerRefusal(offer({ openOrders: 5 }), BUY)).toBe('busy');
  });

  it('needs a payment method for a purchase, not for a sale', () => {
    expect(offerRefusal(offer({ hasPaymentMethod: false }), BUY)).toBe(
      'payment_method',
    );
    expect(
      offerRefusal(offer({ hasPaymentMethod: false }), {
        ...BUY,
        side: 'SELL',
      }),
    ).toBeNull();
  });

  it('checks the amount against the bounds, both inclusive', () => {
    expect(withinLimits(offer(), 1_000n)).toBe(true);
    expect(withinLimits(offer(), 999n)).toBe(false);
    expect(withinLimits(offer(), 1_000_000_00n)).toBe(true);
    expect(withinLimits(offer(), 1_000_000_01n)).toBe(false);
  });

  it('ranks by the best price for the person first', () => {
    const cheap = offer({ offerId: 'cheap', priceUnits: 990_000_000n });
    const dear = offer({ offerId: 'dear', priceUnits: 1_010_000_000n });
    expect(rankOffers([dear, cheap], 'BUY').map((o) => o.offerId)).toEqual([
      'cheap',
      'dear',
    ]);
    expect(rankOffers([cheap, dear], 'SELL').map((o) => o.offerId)).toEqual([
      'dear',
      'cheap',
    ]);
  });

  it('then by reputation, open orders and id', () => {
    const proven = offer({ offerId: 'p', completed: 50, cancelled: 1 });
    const fresh = offer({ offerId: 'f', completed: 0, cancelled: 0 });
    const flaky = offer({ offerId: 'x', completed: 2, cancelled: 8 });
    expect(
      rankOffers([flaky, fresh, proven], 'BUY').map((o) => o.offerId),
    ).toEqual(['p', 'f', 'x']);
    const fast = offer({ offerId: 'fast', medianReleaseSeconds: 30 });
    const slow = offer({ offerId: 'slow', medianReleaseSeconds: 900 });
    const unknown = offer({ offerId: 'unk', medianReleaseSeconds: null });
    expect(
      rankOffers([unknown, slow, fast], 'BUY').map((o) => o.offerId),
    ).toEqual(['fast', 'slow', 'unk']);
    const lost = offer({ offerId: 'lost', disputesLost: 2 });
    const busy = offer({ offerId: 'busy', openOrders: 3 });
    const b = offer({ offerId: 'b' });
    const a = offer({ offerId: 'a' });
    expect(rankOffers([lost, busy, b, a], 'BUY').map((o) => o.offerId)).toEqual(
      ['a', 'b', 'busy', 'lost'],
    );
  });

  it('rates a merchant with no history at one half', () => {
    expect(completionRate(offer({ completed: 0, cancelled: 0 }))).toBe(0.5);
    expect(completionRate(offer({ completed: 3, cancelled: 1 }))).toBe(0.75);
  });

  it('needs the amount and the matcher cap for a purchase, the bond for a sale', () => {
    expect(
      hasLiquidity('BUY', { freeBalance: 100n, maxPerOrder: 100n }, 100n, 0n),
    ).toBe(true);
    expect(
      hasLiquidity('BUY', { freeBalance: 99n, maxPerOrder: 100n }, 100n, 0n),
    ).toBe(false);
    expect(
      hasLiquidity('BUY', { freeBalance: 100n, maxPerOrder: 99n }, 100n, 0n),
    ).toBe(false);
    expect(
      hasLiquidity('SELL', { freeBalance: 10n, maxPerOrder: 0n }, 100n, 10n),
    ).toBe(true);
    expect(
      hasLiquidity('SELL', { freeBalance: 9n, maxPerOrder: 0n }, 100n, 10n),
    ).toBe(false);
  });
});
