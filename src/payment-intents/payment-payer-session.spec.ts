import {
  newPayerToken,
  payerTokenHash,
  receiptRecipient,
} from '@/payment-intents/payment-payer-session';

const at = (minute: number) =>
  new Date(`2026-11-17T11:${String(minute).padStart(2, '0')}:00.000Z`);

describe('checkout session tokens', () => {
  it('are 256 random bits, base64url, never the same twice', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newPayerToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('are stored as their SHA-256 only', () => {
    const token = newPayerToken();
    const hash = payerTokenHash(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(payerTokenHash(token)).toBe(hash);
  });
});

describe('receiptRecipient', () => {
  const session = (email: string, sentAt: Date | null, createdAt: Date) => ({
    email,
    lang: 'en',
    sentAt,
    createdAt,
  });

  it('picks the session that reported `sent` most recently', () => {
    expect(
      receiptRecipient([
        session('a@example.com', at(5), at(1)),
        session('b@example.com', at(9), at(2)),
        session('c@example.com', null, at(10)),
      ])?.email,
    ).toBe('b@example.com');
  });

  it('with no `sent`, takes the one email every session gave', () => {
    expect(
      receiptRecipient([
        session('a@example.com', null, at(1)),
        session('A@Example.com', null, at(3)),
      ])?.createdAt,
    ).toEqual(at(3));
  });

  it('answers nobody when the payer cannot be told apart, or nobody gave one', () => {
    expect(
      receiptRecipient([
        session('a@example.com', null, at(1)),
        session('b@example.com', null, at(2)),
      ]),
    ).toBeNull();
    expect(receiptRecipient([])).toBeNull();
  });
});
