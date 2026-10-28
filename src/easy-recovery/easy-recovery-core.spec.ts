import { createHash } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519.js';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ClaimEasyRecoveryDto,
  CreateEasyRecoverySessionDto,
  OfferEasyRecoveryDto,
} from '@/easy-recovery/dto/easy-recovery.dto';
import {
  easyRecoveryCodeHash,
  easyRecoveryCodeMatches,
  isLiveSession,
  isReceiverKey,
  isSessionId,
  newSessionId,
} from '@/easy-recovery/easy-recovery-core';
import {
  EASY_RECOVERY_CIPHERTEXT_MAX_CHARS,
  EASY_RECOVERY_MAX_ATTEMPTS,
} from '@/easy-recovery/easy-recovery.constants';

/** A real X25519 public key, from a fixed secret so the spec is deterministic. */
const RECEIVER_KEY = Buffer.from(
  x25519.getPublicKey(new Uint8Array(32).fill(7)),
).toString('base64url');

/**
 * The low-order points (and their non-canonical spellings) a key exchange with
 * which yields a shared secret anyone can compute.
 */
const LOW_ORDER_POINTS = [
  '00'.repeat(32),
  '01' + '00'.repeat(31),
  'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
  '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157',
  'ec' + 'ff'.repeat(30) + '7f', // p - 1
  'ed' + 'ff'.repeat(30) + '7f', // p
  'ee' + 'ff'.repeat(30) + '7f', // p + 1
  // The order-8 point with the top bit set, which X25519 masks off.
  'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b880',
].map((hex) => Buffer.from(hex, 'hex').toString('base64url'));

describe('easy recovery rules', () => {
  describe('isReceiverKey', () => {
    it('accepts a real X25519 public key, 43 base64url characters', () => {
      expect(RECEIVER_KEY).toHaveLength(43);
      expect(isReceiverKey(RECEIVER_KEY)).toBe(true);
    });

    it.each([
      ['padded', `${RECEIVER_KEY}=`],
      ['standard base64', RECEIVER_KEY.replace(/-/g, '+').replace(/_/g, '/')],
      ['one character short', RECEIVER_KEY.slice(0, 42)],
      ['one character long', `${RECEIVER_KEY}A`],
      ['33 bytes', Buffer.alloc(33, 9).toString('base64url')],
      ['31 bytes', Buffer.alloc(31, 9).toString('base64url')],
      ['not a string', 42],
      ['empty', ''],
    ])('refuses a key that is %s', (_label, value) => {
      expect(isReceiverKey(value)).toBe(false);
    });

    it('refuses a non-canonical spelling, so one key has one spelling', () => {
      // The last character carries two spare bits; setting one decodes to the
      // same 32 bytes but is not how base64url writes them.
      const last = RECEIVER_KEY.at(-1)!;
      const alphabet =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      const sibling = alphabet[alphabet.indexOf(last) ^ 1];
      const spelled = RECEIVER_KEY.slice(0, 42) + sibling;
      expect(Buffer.from(spelled, 'base64url')).toEqual(
        Buffer.from(RECEIVER_KEY, 'base64url'),
      );
      expect(isReceiverKey(spelled)).toBe(false);
    });

    it.each(LOW_ORDER_POINTS)(
      'refuses the low-order point %s, whose shared secret is no secret',
      (point) => {
        expect(point).toHaveLength(43);
        expect(isReceiverKey(point)).toBe(false);
      },
    );
  });

  describe('session ids', () => {
    it('mints 16 random bytes as 22 base64url characters', () => {
      const ids = new Set(Array.from({ length: 64 }, () => newSessionId()));
      expect(ids.size).toBe(64);
      for (const id of ids) {
        expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
        expect(Buffer.from(id, 'base64url')).toHaveLength(16);
        expect(isSessionId(id)).toBe(true);
      }
    });

    it.each([
      '',
      'short',
      'q2Z7rT0aV1bX9cD4eF6gH',
      'q2Z7rT0aV1bX9cD4eF6gHw=',
      'q2Z7rT0aV1bX9cD4eF6g/w',
      '../../admin/summaryxxx',
    ])('refuses %p without a database read', (id) => {
      expect(isSessionId(id)).toBe(false);
    });
  });

  describe('the code', () => {
    const ID = 'q2Z7rT0aV1bX9cD4eF6gHw';

    it('is stored as SHA-256 hex of {id}:{code}, never as itself', () => {
      const hash = easyRecoveryCodeHash(ID, '48213');
      expect(hash).toBe(
        createHash('sha256').update(`${ID}:48213`).digest('hex'),
      );
      expect(hash).not.toContain('48213');
    });

    it('is salted by the session, so one table read is not one lookup table', () => {
      expect(easyRecoveryCodeHash(ID, '48213')).not.toBe(
        easyRecoveryCodeHash('AAAAAAAAAAAAAAAAAAAAAA', '48213'),
      );
    });

    it('matches only the right code for the right session', () => {
      const stored = easyRecoveryCodeHash(ID, '48213');
      expect(easyRecoveryCodeMatches(ID, '48213', stored)).toBe(true);
      expect(easyRecoveryCodeMatches(ID, '48214', stored)).toBe(false);
      expect(
        easyRecoveryCodeMatches('AAAAAAAAAAAAAAAAAAAAAA', '48213', stored),
      ).toBe(false);
    });

    it('never matches a missing or malformed hash', () => {
      expect(easyRecoveryCodeMatches(ID, '48213', null)).toBe(false);
      expect(easyRecoveryCodeMatches(ID, '48213', '')).toBe(false);
      expect(easyRecoveryCodeMatches(ID, '48213', 'abcd')).toBe(false);
    });
  });

  describe('isLiveSession', () => {
    const now = new Date('2026-10-28T20:00:00.000Z');
    const later = new Date(now.getTime() + 1000);
    const earlier = new Date(now.getTime() - 1000);

    it('is live before expiry and below the attempt limit', () => {
      expect(isLiveSession({ expiresAt: later, attempts: 0 }, now)).toBe(true);
      expect(
        isLiveSession(
          { expiresAt: later, attempts: EASY_RECOVERY_MAX_ATTEMPTS - 1 },
          now,
        ),
      ).toBe(true);
    });

    it('is gone when missing, expired, at expiry, or at the attempt limit', () => {
      expect(isLiveSession(null, now)).toBe(false);
      expect(isLiveSession({ expiresAt: earlier, attempts: 0 }, now)).toBe(
        false,
      );
      expect(isLiveSession({ expiresAt: now, attempts: 0 }, now)).toBe(false);
      expect(
        isLiveSession(
          { expiresAt: later, attempts: EASY_RECOVERY_MAX_ATTEMPTS },
          now,
        ),
      ).toBe(false);
    });
  });

  describe('request bodies', () => {
    const errorsOf = async <T extends object>(
      type: new () => T,
      body: Record<string, unknown>,
    ) =>
      (await validate(plainToInstance(type, body))).flatMap((e) =>
        Object.values(e.constraints ?? {}),
      );

    it('takes a real receiver key and refuses a low-order one', async () => {
      expect(
        await errorsOf(CreateEasyRecoverySessionDto, {
          receiverKey: RECEIVER_KEY,
        }),
      ).toEqual([]);
      expect(
        await errorsOf(CreateEasyRecoverySessionDto, {
          receiverKey: LOW_ORDER_POINTS[0],
        }),
      ).toEqual([expect.stringContaining('X25519 public key')]);
    });

    it('takes an offer of base64url ciphertext and a five-digit code', async () => {
      expect(
        await errorsOf(OfferEasyRecoveryDto, {
          ciphertext: 'c2VhbGVk',
          code: '01234',
        }),
      ).toEqual([]);
    });

    it.each([
      ['an empty ciphertext', { ciphertext: '', code: '01234' }],
      [
        'a ciphertext that is not base64url',
        { ciphertext: 'a+b/', code: '01234' },
      ],
      [
        'a ciphertext over the cap',
        {
          ciphertext: 'A'.repeat(EASY_RECOVERY_CIPHERTEXT_MAX_CHARS + 1),
          code: '01234',
        },
      ],
      ['a four-digit code', { ciphertext: 'c2VhbGVk', code: '1234' }],
      ['a six-digit code', { ciphertext: 'c2VhbGVk', code: '123456' }],
      ['a code with a letter', { ciphertext: 'c2VhbGVk', code: '12a45' }],
      ['a code of non-ASCII digits', { ciphertext: 'c2VhbGVk', code: '١٢٣٤٥' }],
      ['a numeric code', { ciphertext: 'c2VhbGVk', code: 12345 }],
    ])('refuses an offer with %s', async (_label, body) => {
      expect(
        (await errorsOf(OfferEasyRecoveryDto, body)).length,
      ).toBeGreaterThan(0);
    });

    it('refuses a malformed claim code before it can cost an attempt', async () => {
      expect(await errorsOf(ClaimEasyRecoveryDto, { code: '48213' })).toEqual(
        [],
      );
      expect(
        (await errorsOf(ClaimEasyRecoveryDto, { code: '4821' })).length,
      ).toBeGreaterThan(0);
    });
  });
});
