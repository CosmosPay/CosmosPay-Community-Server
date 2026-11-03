import { Keypair } from '@stellar/stellar-sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import {
  assertDisputeChallengeSigned,
  disputeChallenge,
  disputeChallengeMessage,
} from '@/native-plugins/trustless-work/protected-payment-dispute-challenge';

const buyer = Keypair.random();
const ID = '3f1c2b7e-8d4a-4c1e-9b2f-6a5d4c3b2a10';
const NOW = new Date('2026-11-02T18:00:00.000Z');

/** What the wallet does: ed25519 over the message's UTF-8 bytes, base64. */
const sign = (key: Keypair, message: string) =>
  Buffer.from(key.sign(Buffer.from(message, 'utf8'))).toString('base64');

function refusal(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('the dispute challenge', () => {
  it('names the flow, the payment, the account, the network and the expiry, in order', () => {
    expect(
      disputeChallengeMessage({
        protectedPaymentId: ID,
        buyer: 'GABC',
        network: 'testnet',
        expiresAt: '2026-11-02T18:10:00.000Z',
      }),
    ).toBe(
      'Cosmos Pay protected payment dispute\n' +
        `payment: ${ID}\n` +
        'account: GABC\n' +
        'network: testnet\n' +
        'expires: 2026-11-02T18:10:00.000Z',
    );
  });

  it('offers a challenge that expires ten minutes ahead', () => {
    const challenge = disputeChallenge(
      { protectedPaymentId: ID, buyer: buyer.publicKey(), network: 'testnet' },
      NOW,
    );
    expect(challenge.expiresAt).toBe('2026-11-02T18:10:00.000Z');
    expect(challenge.message).toContain(`account: ${buyer.publicKey()}`);
  });

  describe('assertDisputeChallengeSigned', () => {
    const fields = () => {
      const { message, expiresAt } = disputeChallenge(
        {
          protectedPaymentId: ID,
          buyer: buyer.publicKey(),
          network: 'testnet',
        },
        NOW,
      );
      return {
        protectedPaymentId: ID,
        buyer: buyer.publicKey(),
        network: 'testnet' as const,
        expiresAt,
        signature: sign(buyer, message),
      };
    };

    it("accepts the buyer's signature over the challenge", () => {
      expect(() => assertDisputeChallengeSigned(fields(), NOW)).not.toThrow();
    });

    it('refuses a signature by another key', () => {
      const other = Keypair.random();
      const f = fields();
      const message = disputeChallengeMessage(f);
      const error = refusal(() =>
        assertDisputeChallengeSigned(
          { ...f, signature: sign(other, message) },
          NOW,
        ),
      );
      expect(error.getStatus()).toBe(400);
      expect(error.code).toBe(ApiErrorCode.ProtectedPaymentSignatureInvalid);
    });

    it('refuses a signature made for another payment or network', () => {
      const f = fields();
      expect(
        refusal(() =>
          assertDisputeChallengeSigned(
            { ...f, protectedPaymentId: 'b'.repeat(36) },
            NOW,
          ),
        ).code,
      ).toBe(ApiErrorCode.ProtectedPaymentSignatureInvalid);
      expect(
        refusal(() =>
          assertDisputeChallengeSigned({ ...f, network: 'public' }, NOW),
        ).code,
      ).toBe(ApiErrorCode.ProtectedPaymentSignatureInvalid);
    });

    it('refuses an expired message and one that expires too far ahead', () => {
      const f = fields();
      expect(
        refusal(() =>
          assertDisputeChallengeSigned(
            f,
            new Date(NOW.getTime() + 11 * 60_000),
          ),
        ).message,
      ).toMatch(/expired/);
      const far = new Date(NOW.getTime() + 60 * 60_000).toISOString();
      const message = disputeChallengeMessage({ ...f, expiresAt: far });
      expect(
        refusal(() =>
          assertDisputeChallengeSigned(
            { ...f, expiresAt: far, signature: sign(buyer, message) },
            NOW,
          ),
        ).message,
      ).toMatch(/too far ahead/);
    });

    it('refuses an expiry that is not the exact ISO string, and junk signatures', () => {
      const f = fields();
      expect(
        refusal(() =>
          assertDisputeChallengeSigned(
            { ...f, expiresAt: '2026-11-02T18:10:00Z' },
            NOW,
          ),
        ).code,
      ).toBe(ApiErrorCode.ProtectedPaymentSignatureInvalid);
      expect(
        refusal(() =>
          assertDisputeChallengeSigned({ ...f, signature: 'not-base64!' }, NOW),
        ).code,
      ).toBe(ApiErrorCode.ProtectedPaymentSignatureInvalid);
    });
  });
});
