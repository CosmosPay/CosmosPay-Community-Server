import { PAYMENT_PAYER_PROOF_MARGIN_MS } from '@/payment-intents/payment-intents.constants';
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
/* Closed on-chain at 11:30: a proof must come before. */
const SETTLED = { chain: 'stellar', txHash: TX, source: PAYER, paidAt: at(30) };

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

  it('two sessions matching one proof prove nothing: no customer link, and the ambiguous rule', () => {
    const sessions = [
      session('copycat@example.com', { walletTxHash: TX, provenAt: at(9) }),
      session('payer@example.com', { walletTxHash: TX, provenAt: at(4) }),
    ];
    expect(receiptRecipient(sessions, SETTLED)).toBeNull();
    // The same on one account, with a single session left it would still be unproven.
    expect(
      receiptRecipient(
        [
          session('a@example.com', { walletAddress: PAYER, provenAt: at(2) }),
          session('b@example.com', { walletAddress: PAYER, provenAt: at(3) }),
        ],
        SETTLED,
      ),
    ).toBeNull();
  });

  it('ignores a proof registered at or after the transaction closed on-chain', () => {
    // The hash and the source are public once it closed: copied, they prove nothing.
    for (const late of [at(30), at(31)]) {
      expect(
        receiptRecipient(
          [
            session('copycat@example.com', {
              walletTxHash: TX,
              provenAt: late,
            }),
            session('payer@example.com'),
          ],
          SETTLED,
        ),
      ).toBeNull();
    }
    // Nor does an account registered in time: an address proves nothing.
    expect(
      receiptRecipient(
        [
          session('copycat@example.com', {
            walletTxHash: TX,
            provenAt: at(31),
          }),
          session('payer@example.com', {
            walletAddress: PAYER,
            provenAt: at(29),
          }),
        ],
        SETTLED,
      ),
    ).toBeNull();
  });

  it("never takes the settlement's source account as proof: addresses are public", () => {
    // A stranger registers a payer's known address before that payer pays.
    expect(
      receiptRecipient(
        [
          session('stranger@example.com', {
            walletAddress: PAYER,
            provenAt: at(2),
          }),
          session('payer@example.com'),
        ],
        SETTLED,
      ),
    ).toBeNull();
    // Alone, a session that registered the account still gets no customer link.
    expect(
      receiptRecipient(
        [
          session('payer@example.com', {
            walletAddress: PAYER,
            provenAt: at(2),
          }),
        ],
        SETTLED,
      ),
    ).toEqual({
      session: expect.objectContaining({ email: 'payer@example.com' }),
      proven: false,
    });
  });

  it('counts a proof only when registered a full margin before the on-chain time', () => {
    const near = new Date(at(30).getTime() - PAYMENT_PAYER_PROOF_MARGIN_MS + 1);
    const early = new Date(
      at(30).getTime() - PAYMENT_PAYER_PROOF_MARGIN_MS - 1,
    );
    const with2 = (provenAt: Date) => [
      session('payer@example.com', { walletTxHash: TX, provenAt }),
      session('other@example.com'),
    ];
    expect(receiptRecipient(with2(near), SETTLED)).toBeNull();
    expect(receiptRecipient(with2(early), SETTLED)?.proven).toBe(true);
  });

  it('fails closed without an on-chain time: no proof counts', () => {
    const unknown = { ...SETTLED, paidAt: null };
    expect(
      receiptRecipient(
        [
          session('payer@example.com', { walletTxHash: TX, provenAt: at(1) }),
          session('other@example.com'),
        ],
        unknown,
      ),
    ).toBeNull();
    expect(
      receiptRecipient(
        [session('payer@example.com', { walletTxHash: TX, provenAt: at(1) })],
        unknown,
      ),
    ).toEqual({
      session: expect.objectContaining({ email: 'payer@example.com' }),
      proven: false,
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
