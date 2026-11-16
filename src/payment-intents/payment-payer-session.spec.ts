import {
  newPayerToken,
  payerTokenHash,
  receiptRecipient,
} from '@/payment-intents/payment-payer-session';

const at = (minute: number) =>
  new Date(`2026-11-17T11:${String(minute).padStart(2, '0')}:00.000Z`);

const PAYER = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
const OTHER = 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO';
const TX = 'b7f1c3a2d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d';
const SETTLED = { chain: 'stellar', txHash: TX, source: PAYER };

const session = (
  email: string,
  proof: {
    walletAddress?: string | null;
    walletTxHash?: string | null;
    provenAt?: Date | null;
  } = {},
) => ({
  email,
  lang: 'en',
  walletAddress: proof.walletAddress ?? null,
  walletTxHash: proof.walletTxHash ?? null,
  provenAt: proof.provenAt ?? null,
});

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
  it("picks the session whose registered transaction is the settlement's, as proven", () => {
    const result = receiptRecipient(
      [
        session('stranger@example.com', {
          walletAddress: OTHER,
          provenAt: at(1),
        }),
        session('payer@example.com', {
          walletTxHash: TX.toUpperCase(),
          provenAt: at(5),
        }),
      ],
      SETTLED,
    );
    expect(result).toEqual({
      session: expect.objectContaining({ email: 'payer@example.com' }),
      proven: true,
    });
  });

  it('takes the earliest proof when two sessions claim one transaction', () => {
    expect(
      receiptRecipient(
        [
          session('copycat@example.com', { walletTxHash: TX, provenAt: at(9) }),
          session('payer@example.com', { walletTxHash: TX, provenAt: at(4) }),
        ],
        SETTLED,
      )?.session.email,
    ).toBe('payer@example.com');
  });

  it("falls back to the session whose wallet account is the settlement's source", () => {
    expect(
      receiptRecipient(
        [
          session('payer@example.com', {
            walletAddress: PAYER,
            provenAt: at(2),
          }),
          session('other@example.com'),
        ],
        SETTLED,
      ),
    ).toEqual({
      session: expect.objectContaining({ email: 'payer@example.com' }),
      proven: true,
    });
  });

  it('without a match, the only session gets it unproven; with several, nobody', () => {
    expect(receiptRecipient([session('payer@example.com')], SETTLED)).toEqual({
      session: expect.objectContaining({ email: 'payer@example.com' }),
      proven: false,
    });
    expect(
      receiptRecipient(
        [
          session('payer@example.com'),
          session('payer@example.com', { walletAddress: OTHER }),
        ],
        SETTLED,
      ),
    ).toBeNull();
    expect(receiptRecipient([], SETTLED)).toBeNull();
  });
});
