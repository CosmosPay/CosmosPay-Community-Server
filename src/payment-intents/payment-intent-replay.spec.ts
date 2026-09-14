import {
  isSameIntentRequest,
  type PaymentIntentTerms,
} from '@/payment-intents/payment-intent-replay';

/**
 * A create that reuses a memo gets the stored intent back only when it asks for
 * the same payment. Under the shared public key the memo is a key every
 * anonymous caller can reach, so "same memo" alone handed one user another
 * user's payment link.
 */
describe('isSameIntentRequest', () => {
  const tx: PaymentIntentTerms = {
    kind: 'TX',
    network: 'testnet',
    source: 'GSOURCE',
    destination: 'GDEST',
    amount: '25.5',
    asset: 'USDC',
    assetIssuer: 'GISSUER',
    msg: 'Order #24',
    callback: 'url:https://merchant.example.com/cb',
  };
  const pay = { ...tx, kind: 'PAY', source: null } as PaymentIntentTerms;

  it('accepts an identical request', () => {
    expect(isSameIntentRequest(tx, { ...tx })).toBe(true);
    expect(isSameIntentRequest(pay, { ...pay })).toBe(true);
  });

  it('compares amounts in stroops, not as text', () => {
    expect(isSameIntentRequest(tx, { ...tx, amount: '25.5000000' })).toBe(true);
  });

  it.each([
    ['kind', 'PAY'],
    ['network', 'public'],
    ['source', 'GOTHERSOURCE'],
    ['destination', 'GATTACKER'],
    ['amount', '25.5000001'],
    ['asset', 'USDT'],
    ['assetIssuer', 'GOTHERISSUER'],
    ['msg', 'Order #25'],
    ['callback', 'url:https://attacker.example.com/cb'],
  ])('rejects a request whose %s differs', (field, value) => {
    const requested = { ...tx, [field]: value };
    expect(isSameIntentRequest(tx, requested)).toBe(false);
  });

  it('treats an omitted amount and a fixed one as different payments', () => {
    const open = { ...pay, amount: null };
    expect(isSameIntentRequest(open, { ...open })).toBe(true);
    expect(isSameIntentRequest(open, { ...open, amount: '1' })).toBe(false);
    expect(isSameIntentRequest({ ...open, amount: '1' }, open)).toBe(false);
  });

  it('treats an omitted msg or callback as different from a supplied one', () => {
    expect(isSameIntentRequest({ ...tx, msg: null }, tx)).toBe(false);
    expect(isSameIntentRequest(tx, { ...tx, callback: null })).toBe(false);
  });

  it('ignores the payer recorded on a PAY intent after it settled', () => {
    // `transition` fills `source` with the on-chain payer when a PAY intent
    // settles; a retry of the original link must not conflict with that.
    expect(isSameIntentRequest({ ...pay, source: 'GPAYER' }, pay)).toBe(true);
  });

  it('falls back to exact text for an amount too large to be a Stellar amount', () => {
    const huge = '99999999999999999999';
    expect(
      isSameIntentRequest({ ...tx, amount: huge }, { ...tx, amount: huge }),
    ).toBe(true);
    expect(
      isSameIntentRequest(
        { ...tx, amount: huge },
        { ...tx, amount: `${huge}.0` },
      ),
    ).toBe(false);
  });
});
