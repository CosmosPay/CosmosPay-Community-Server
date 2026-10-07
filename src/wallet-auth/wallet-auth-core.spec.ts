import { createHash } from 'node:crypto';
import { WalletAuthMethod, WalletAuthProvider } from '@generated/prisma/client';
import {
  authorizationUrl,
  backupMessage,
  callbackUrl,
  finishMessage,
  fallbackName,
  githubIdentity,
  googleIdentity,
  isBackupBox,
  issueSessionToken,
  methodOfProvider,
  pkceMatches,
  providerFromWire,
  recoverySetupMessage,
  readSessionToken,
  mfaSettingsUrl,
  signedAtFresh,
  sixDigitCode,
  verifyWalletSignature,
} from '@/wallet-auth/wallet-auth-core';
import {
  BACKUP_MAX_ITERATIONS,
  BACKUP_MIN_ITERATIONS,
  BACKUP_ARGON2_MAX_MEMORY_KIB,
  BACKUP_ARGON2_MIN_MEMORY_KIB,
  BACKUP_ARGON2_MIN_PASSES,
  OIDC_MAX_AGE_S,
  SESSION_TTL_MS,
  SIGNED_AT_SKEW_MS,
} from '@/wallet-auth/wallet-auth.constants';

const SECRET = 'a-server-secret-long-enough-to-be-real';

/** A structurally valid box, at the floor unless a test says otherwise. */
function box(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 2,
    salt: Buffer.alloc(16, 1).toString('base64'),
    iv: Buffer.alloc(12, 2).toString('base64'),
    data: Buffer.alloc(64, 3).toString('base64'),
    iter: BACKUP_MIN_ITERATIONS,
    ...overrides,
  });
}

const passwordSlot = (overrides: Record<string, unknown> = {}) => ({
  kind: 'password',
  salt: Buffer.alloc(16, 4).toString('base64'),
  iter: BACKUP_MIN_ITERATIONS,
  iv: Buffer.alloc(12, 5).toString('base64'),
  data: Buffer.alloc(48, 6).toString('base64'),
  ...overrides,
});

const passkeySlot = (overrides: Record<string, unknown> = {}) => ({
  kind: 'passkey',
  id: Buffer.alloc(32, 7).toString('base64url'),
  iv: Buffer.alloc(12, 8).toString('base64'),
  data: Buffer.alloc(48, 9).toString('base64'),
  ...overrides,
});

/** A v4 recovery door: the data key under the key the two recovery servers split. */
const recoverySlot = (overrides: Record<string, unknown> = {}) => ({
  kind: 'recovery',
  iv: Buffer.alloc(12, 10).toString('base64'),
  data: Buffer.alloc(48, 11).toString('base64'),
  ...overrides,
});

/** A v4 password door: Argon2id at the wallet's cost. */
const argonSlot = (overrides: Record<string, unknown> = {}) => ({
  kind: 'password',
  kdf: 'argon2id',
  salt: Buffer.alloc(16, 4).toString('base64'),
  m: 65_536,
  t: 2,
  p: 1,
  iv: Buffer.alloc(12, 5).toString('base64'),
  data: Buffer.alloc(48, 6).toString('base64'),
  ...overrides,
});

/** A v3 box: the seed under a data key, the data key under each slot. */
function boxV3(
  slots: unknown[] = [passwordSlot(), passkeySlot()],
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    v: 3,
    iv: Buffer.alloc(12, 2).toString('base64'),
    data: Buffer.alloc(64, 3).toString('base64'),
    slots,
    ...overrides,
  });
}

describe('wallet-auth-core', () => {
  /* The cross-repo contract. These literals are built independently here and by
     the wallet (src/lib/signIn.ts, pinned in its tests/unit/signIn.test.ts); both
     must agree byte for byte or no sign-in can finish. Pinned as whole strings on purpose —
     asserting "it contains the email" would pass through a reordering that
     breaks every device in the field. */
  describe('the signed challenges are a contract, not an implementation detail', () => {
    it('pins the sign-in challenge', () => {
      expect(
        finishMessage('  Person@Example.COM ', 'GABC', '2026-01-02T03:04:05Z'),
      ).toBe(
        'Cosmos Pay Wallet sign-in\n' +
          'email: person@example.com\n' +
          'account: GABC\n' +
          'at: 2026-01-02T03:04:05Z',
      );
    });

    // The wallet builds this string itself (in its recovery module) and pins
    // the same literal in its own test: a rename on either side builds cleanly and
    // produces a signature the other one rejects.
    it('pins the recovery-setup challenge', () => {
      expect(
        recoverySetupMessage(
          'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
          ['GAAA', 'GBBB'],
          '2026-09-19T12:00:00.000Z',
        ),
      ).toBe(
        'Cosmos Pay Wallet recovery setup\n' +
          'account: GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ\n' +
          'signers: GAAA,GBBB\n' +
          'at: 2026-09-19T12:00:00.000Z',
      );
    });

    it('pins the backup challenge, over the box hash rather than the box', () => {
      const b = box();
      const digest = createHash('sha256').update(b).digest('hex');
      expect(backupMessage('GABC', b, '2026-01-02T03:04:05Z')).toBe(
        'Cosmos Pay Wallet backup\n' +
          'account: GABC\n' +
          `box: ${digest}\n` +
          'at: 2026-01-02T03:04:05Z',
      );
    });

    it('gives the two challenges different first lines', () => {
      const a = finishMessage('a@b.com', 'GABC', '2026-01-02T03:04:05Z').split(
        '\n',
      )[0];
      const b = backupMessage('GABC', box(), '2026-01-02T03:04:05Z').split(
        '\n',
      )[0];
      expect(a).not.toBe(b);
    });
  });

  /* FIXED VECTORS, not a keypair generated here.
     Produced once with @stellar/stellar-sdk from the seed Buffer.alloc(32, 7)
     and pasted in. Generating a fresh keypair per run would prove that this
     file's verifier agrees with this file's signer at this version and nothing
     more; a stored vector keeps proving it agrees with bytes the wallet's own
     SDK really produced, across every upgrade of either side. */
  describe('verifyWalletSignature', () => {
    const ADDRESS = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';
    const OTHER_ADDRESS =
      'GD6ROJBYLKQMOW3E7N4M2YBPUHMZD7PL65VRHRMO24BOVSBV5H3BQRSL';
    const SIGNED_AT = '2026-01-02T03:04:05Z';
    const FINISH_SIGNATURE =
      'msWcPRf8GVEgAnlPd44NIhax6lhkH4Yi3GkGQdNLIh87brdw3uA0Ar8CRj/TYO9sJ6pWsNhxhQ3+1Qd+kCKNDA==';
    const BACKUP_SIGNATURE =
      'nvwZGuTCgDCT8Aj7iShTY4Ppfj3YupP3pB0Bg7wP8+x5jyc4Wv5yxteN/mhxdbZMnGNE9FtpWTt5sA5NbdMvDA==';

    const message = finishMessage('ada@example.com', ADDRESS, SIGNED_AT);

    it('accepts a signature the SDK produced for this exact challenge', () => {
      expect(verifyWalletSignature(ADDRESS, message, FINISH_SIGNATURE)).toBe(
        true,
      );
    });

    it('accepts the backup challenge signature, over the box hash', () => {
      expect(
        verifyWalletSignature(
          ADDRESS,
          backupMessage(ADDRESS, box(), SIGNED_AT),
          BACKUP_SIGNATURE,
        ),
      ).toBe(true);
    });

    it('refuses a sign-in signature replayed as a backup one', () => {
      expect(
        verifyWalletSignature(
          ADDRESS,
          backupMessage(ADDRESS, box(), SIGNED_AT),
          FINISH_SIGNATURE,
        ),
      ).toBe(false);
    });

    it('refuses the same signature presented for another address', () => {
      expect(
        verifyWalletSignature(OTHER_ADDRESS, message, FINISH_SIGNATURE),
      ).toBe(false);
    });

    it('refuses a signature over different bytes', () => {
      const other = finishMessage('mallory@example.com', ADDRESS, SIGNED_AT);
      expect(verifyWalletSignature(ADDRESS, other, FINISH_SIGNATURE)).toBe(
        false,
      );
    });

    it.each([
      ['a malformed address', 'not-an-address', 'AAAA'],
      ['junk base64', ADDRESS, 'not base64 at all!!'],
      ['an empty signature', ADDRESS, ''],
    ])('returns false for %s instead of throwing', (_label, address, sig) => {
      expect(verifyWalletSignature(address, 'anything', sig)).toBe(false);
    });
  });

  describe('pkceMatches', () => {
    const verifier = 'a-verifier-the-device-kept-to-itself';
    const challenge = createHash('sha256')
      .update(verifier, 'ascii')
      .digest('base64url');

    it('accepts the verifier its challenge was built from', () => {
      expect(pkceMatches(verifier, challenge)).toBe(true);
    });

    it('refuses another verifier', () => {
      expect(pkceMatches('something-else', challenge)).toBe(false);
    });

    it('refuses a challenge of the wrong length rather than comparing a prefix', () => {
      expect(pkceMatches(verifier, challenge.slice(0, 10))).toBe(false);
    });
  });

  describe('googleIdentity', () => {
    const base = {
      sub: '123',
      email: 'A@B.com',
      email_verified: true,
      name: 'Ada',
    };

    it('lowercases the email it trusts', () => {
      const r = googleIdentity(base);
      expect(r).toEqual({
        ok: true,
        identity: {
          email: 'a@b.com',
          name: 'Ada',
          avatar: null,
          subject: '123',
        },
      });
    });

    it('refuses an unverified email, which is how an account is impersonated', () => {
      expect(googleIdentity({ ...base, email_verified: false })).toEqual({
        ok: false,
        error: 'email_unverified',
      });
    });

    it('refuses a truthy-but-not-true verified flag', () => {
      expect(googleIdentity({ ...base, email_verified: 'yes' })).toEqual({
        ok: false,
        error: 'email_unverified',
      });
    });

    it('refuses a profile with no subject', () => {
      expect(googleIdentity({ ...base, sub: undefined })).toEqual({
        ok: false,
        error: 'profile_invalid',
      });
    });

    it('drops a non-https avatar rather than storing it', () => {
      const r = googleIdentity({
        ...base,
        picture: 'http://example.com/a.png',
      });
      expect(r.ok && r.identity.avatar).toBeNull();
    });
  });

  describe('githubIdentity', () => {
    const user = { id: 42, login: 'ada', name: 'Ada' };

    it('never uses the profile email, which carries no verification', () => {
      const r = githubIdentity({ ...user, email: 'public@example.com' }, [
        { email: 'real@example.com', primary: true, verified: true },
      ]);
      expect(r.ok && r.identity.email).toBe('real@example.com');
    });

    it('prefers the verified primary address', () => {
      const r = githubIdentity(user, [
        { email: 'second@example.com', primary: false, verified: true },
        { email: 'primary@example.com', primary: true, verified: true },
      ]);
      expect(r.ok && r.identity.email).toBe('primary@example.com');
    });

    it('falls back to the first verified address when the primary is not', () => {
      const r = githubIdentity(user, [
        { email: 'primary@example.com', primary: true, verified: false },
        { email: 'second@example.com', primary: false, verified: true },
      ]);
      expect(r.ok && r.identity.email).toBe('second@example.com');
    });

    it('refuses when nothing is verified', () => {
      expect(
        githubIdentity(user, [
          { email: 'a@b.com', primary: true, verified: false },
        ]),
      ).toEqual({ ok: false, error: 'email_unverified' });
    });

    it('refuses an empty email list', () => {
      expect(githubIdentity(user, [])).toEqual({
        ok: false,
        error: 'email_unverified',
      });
    });

    it('accepts a string id as well as a numeric one', () => {
      const r = githubIdentity({ ...user, id: '42' }, [
        { email: 'a@b.com', primary: true, verified: true },
      ]);
      expect(r.ok && r.identity.subject).toBe('42');
    });
  });

  describe('the session token', () => {
    const identity = {
      email: 'a@b.com',
      name: 'Ada',
      avatar: null,
      method: WalletAuthMethod.GOOGLE,
    };

    it('round-trips the identity it was issued for', () => {
      expect(
        readSessionToken(issueSessionToken(identity, SECRET), SECRET),
      ).toEqual(identity);
    });

    it('is refused after its window closes', () => {
      const token = issueSessionToken(identity, SECRET, 1_000);
      expect(
        readSessionToken(token, SECRET, 1_000 + SESSION_TTL_MS + 1),
      ).toBeNull();
    });

    it('is refused under another server secret, so it cannot be minted elsewhere', () => {
      const token = issueSessionToken(identity, SECRET);
      expect(
        readSessionToken(token, 'a-different-server-secret-entirely'),
      ).toBeNull();
    });

    it.each([['junk'], ['']])(
      'returns null for %p rather than throwing',
      (input) => {
        expect(readSessionToken(input, SECRET)).toBeNull();
      },
    );
  });

  describe('signedAtFresh', () => {
    const now = Date.parse('2026-01-02T03:04:05Z');

    it('accepts a timestamp at this instant', () => {
      expect(signedAtFresh('2026-01-02T03:04:05Z', now)).toBe(true);
    });

    it('accepts milliseconds', () => {
      expect(signedAtFresh('2026-01-02T03:04:05.123Z', now)).toBe(true);
    });

    it('accepts a clock running fast, which phones do', () => {
      expect(
        signedAtFresh('2026-01-02T03:04:05Z', now - SIGNED_AT_SKEW_MS + 1_000),
      ).toBe(true);
    });

    it('refuses one further out than the skew', () => {
      expect(
        signedAtFresh('2026-01-02T03:04:05Z', now + SIGNED_AT_SKEW_MS + 1_000),
      ).toBe(false);
    });

    it.each([
      ['an offset instead of Z', '2026-01-02T03:04:05+00:00'],
      ['no timezone', '2026-01-02T03:04:05'],
      ['a date alone', '2026-01-02'],
      ['prose', 'now'],
      ['empty', ''],
    ])('refuses %s', (_label, value) => {
      expect(signedAtFresh(value, now)).toBe(false);
    });
  });

  describe('isBackupBox', () => {
    it('accepts a box the wallet could have written', () => {
      expect(isBackupBox(box())).toBe(true);
    });

    /* v4: what the wallet seals now. Its password door is Argon2id, held to OWASP's floor. */
    it('accepts a v4 box with an Argon2id password door and a passkey door', () => {
      expect(isBackupBox(boxV3([argonSlot(), passkeySlot()], { v: 4 }))).toBe(
        true,
      );
      expect(isBackupBox(boxV3([passkeySlot()], { v: 4 }))).toBe(true);
    });

    it('holds a v4 password door to the Argon2id floor and ceiling', () => {
      const v4 = (slot: unknown) => isBackupBox(boxV3([slot], { v: 4 }));
      expect(v4(argonSlot({ m: BACKUP_ARGON2_MIN_MEMORY_KIB }))).toBe(true);
      expect(v4(argonSlot({ m: BACKUP_ARGON2_MIN_MEMORY_KIB - 1 }))).toBe(
        false,
      );
      expect(v4(argonSlot({ t: BACKUP_ARGON2_MIN_PASSES - 1 }))).toBe(false);
      expect(v4(argonSlot({ m: BACKUP_ARGON2_MAX_MEMORY_KIB + 1 }))).toBe(
        false,
      );
      expect(v4(argonSlot({ p: 0 }))).toBe(false);
      expect(
        v4(argonSlot({ salt: Buffer.alloc(8, 1).toString('base64') })),
      ).toBe(false);
    });

    /* The email-recovery door: beside a password or a passkey, never alone, never twice. */
    it('accepts one recovery door beside a password or passkey door in a v4 box', () => {
      expect(isBackupBox(boxV3([argonSlot(), recoverySlot()], { v: 4 }))).toBe(
        true,
      );
      expect(
        isBackupBox(
          boxV3([argonSlot(), passkeySlot(), recoverySlot()], { v: 4 }),
        ),
      ).toBe(true);
    });

    it('refuses a recovery door alone, twice, in a v3 box, or with extra fields', () => {
      expect(isBackupBox(boxV3([recoverySlot()], { v: 4 }))).toBe(false);
      expect(
        isBackupBox(
          boxV3([argonSlot(), recoverySlot(), recoverySlot()], { v: 4 }),
        ),
      ).toBe(false);
      expect(isBackupBox(boxV3([passwordSlot(), recoverySlot()]))).toBe(false);
      expect(
        isBackupBox(
          boxV3([argonSlot(), recoverySlot({ email: 'a@b.com' })], { v: 4 }),
        ),
      ).toBe(false);
    });

    /* Each version has one kind of password door, so neither can carry the other's. */
    it('refuses a PBKDF2 door in a v4 box, and an Argon2id door in a v3 one', () => {
      expect(isBackupBox(boxV3([passwordSlot()], { v: 4 }))).toBe(false);
      expect(isBackupBox(boxV3([argonSlot()]))).toBe(false);
    });

    it('refuses a cost below the floor, which is the whole point of checking', () => {
      expect(isBackupBox(box({ iter: BACKUP_MIN_ITERATIONS - 1 }))).toBe(false);
    });

    it('accepts the floor exactly', () => {
      expect(isBackupBox(box({ iter: BACKUP_MIN_ITERATIONS }))).toBe(true);
    });

    it('refuses a cost above the ceiling', () => {
      expect(isBackupBox(box({ iter: BACKUP_MAX_ITERATIONS + 1 }))).toBe(false);
    });

    it('refuses a non-integer cost', () => {
      expect(isBackupBox(box({ iter: 700000.5 }))).toBe(false);
    });

    it('refuses an older box version rather than migrating it', () => {
      expect(isBackupBox(box({ v: 1 }))).toBe(false);
    });

    it('refuses a short salt', () => {
      expect(
        isBackupBox(box({ salt: Buffer.alloc(8, 1).toString('base64') })),
      ).toBe(false);
    });

    it('refuses an IV that is not 12 bytes', () => {
      expect(
        isBackupBox(box({ iv: Buffer.alloc(16, 2).toString('base64') })),
      ).toBe(false);
    });

    it.each([
      ['not JSON', 'hello'],
      ['an array', '[]'],
      ['null', 'null'],
      ['empty', ''],
      ['a missing field', JSON.stringify({ v: 2, salt: 'AAAA', iv: 'AAAA' })],
    ])('refuses %s', (_label, value) => {
      expect(isBackupBox(value)).toBe(false);
    });

    it('refuses a box larger than anything the wallet writes', () => {
      expect(isBackupBox(box({ data: 'A'.repeat(9000) }))).toBe(false);
    });

    describe('v3 — a data key behind several doors', () => {
      it('accepts a password and a passkey door', () => {
        expect(isBackupBox(boxV3())).toBe(true);
      });

      it('accepts a passkey door alone, which is a passwordless wallet', () => {
        expect(isBackupBox(boxV3([passkeySlot()]))).toBe(true);
      });

      /* The whole point of the floor, and a v3 box must not be a way around it. */
      it('holds a password door to the same cost floor as a v2 box', () => {
        expect(
          isBackupBox(
            boxV3([passwordSlot({ iter: BACKUP_MIN_ITERATIONS - 1 })]),
          ),
        ).toBe(false);
        expect(
          isBackupBox(
            boxV3([
              passkeySlot(),
              passwordSlot({ iter: BACKUP_MIN_ITERATIONS - 1 }),
            ]),
          ),
        ).toBe(false);
      });

      it.each([
        ['no doors', []],
        ['too many doors', Array.from({ length: 9 }, () => passkeySlot())],
        ['an unknown kind', [passkeySlot({ kind: 'pin' })]],
        [
          'a wrapped key that is not 32 bytes plus a tag',
          [passkeySlot({ data: Buffer.alloc(32, 1).toString('base64') })],
        ],
        [
          'a slot IV that is not 12 bytes',
          [passkeySlot({ iv: Buffer.alloc(16, 1).toString('base64') })],
        ],
        ['a passkey with no credential id', [passkeySlot({ id: '' })]],
        [
          'a credential id that is not base64url',
          [passkeySlot({ id: 'has spaces' })],
        ],
        [
          'a password door with a short salt',
          [passwordSlot({ salt: Buffer.alloc(8, 1).toString('base64') })],
        ],
        ['a slot that is not an object', ['passkey']],
      ])('refuses %s', (_label, slots) => {
        expect(isBackupBox(boxV3(slots))).toBe(false);
      });

      it('refuses slots that are not a list', () => {
        expect(isBackupBox(boxV3(undefined, { slots: passkeySlot() }))).toBe(
          false,
        );
      });

      it('refuses a v3 box whose own IV is not 12 bytes', () => {
        expect(
          isBackupBox(
            boxV3(undefined, { iv: Buffer.alloc(16, 1).toString('base64') }),
          ),
        ).toBe(false);
      });
    });
  });

  describe('provider plumbing', () => {
    it('maps the wire spelling both ways', () => {
      expect(providerFromWire('google')).toBe(WalletAuthProvider.GOOGLE);
      expect(providerFromWire('GitHub')).toBe(WalletAuthProvider.GITHUB);
      expect(methodOfProvider(WalletAuthProvider.GITHUB)).toBe(
        WalletAuthMethod.GITHUB,
      );
    });

    it.each([['myspace'], [''], ['__proto__']])(
      'refuses %p as a provider',
      (value) => {
        expect(providerFromWire(value)).toBeNull();
      },
    );

    it('builds the callback on this service, under /v1', () => {
      expect(
        callbackUrl('https://api.example.com/', WalletAuthProvider.GOOGLE),
      ).toBe('https://api.example.com/v1/wallet/auth/oauth/callback/google');
    });

    it('forces the Google account picker, so a signed-in browser cannot decide', () => {
      const url = new URL(
        authorizationUrl(WalletAuthProvider.GOOGLE, {
          clientId: 'cid',
          redirectUri: 'https://api.example.com/cb',
          state: 'st',
        }),
      );
      expect(url.searchParams.get('prompt')).toBe('select_account');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('state')).toBe('st');
    });

    /* Not prompt=login: Authentik makes a browser with no session log in twice
       under it, and the second login through a social source dead-ends. */
    it('asks Authentik for a recent login with max_age, not prompt=login', () => {
      const url = new URL(
        authorizationUrl(WalletAuthProvider.AUTHENTIK, {
          clientId: 'cid',
          redirectUri: 'https://api.example.com/cb',
          state: 'st',
          oidc: {
            authorizationEndpoint: 'https://auth.example.com/authorize/',
            codeChallenge: 'ch',
            nonce: 'n',
          },
        }),
      );
      expect(url.searchParams.get('max_age')).toBe(String(OIDC_MAX_AGE_S));
      expect(url.searchParams.has('prompt')).toBe(false);
    });

    it('asks GitHub for the scope that exposes email verification', () => {
      const url = new URL(
        authorizationUrl(WalletAuthProvider.GITHUB, {
          clientId: 'cid',
          redirectUri: 'https://api.example.com/cb',
          state: 'st',
        }),
      );
      expect(url.searchParams.get('scope')).toContain('user:email');
    });
  });

  describe('small helpers', () => {
    it('always produces six digits', () => {
      for (let i = 0; i < 200; i += 1)
        expect(sixDigitCode()).toMatch(/^\d{6}$/);
    });

    it('names a person after their mailbox when the provider gave nothing', () => {
      expect(fallbackName('ada@example.com', null)).toBe('ada');
      expect(fallbackName('ada@example.com', '  ')).toBe('ada');
      expect(fallbackName('ada@example.com', 'Ada')).toBe('Ada');
    });
  });
});

describe('mfaSettingsUrl', () => {
  const PATH = '/if/user/#/settings;{"page":"page-credentials"}';

  it('serves the page from the issuer origin, not under its application path', () => {
    expect(
      mfaSettingsUrl('https://auth.example.com/application/o/wallet/', PATH),
    ).toBe(`https://auth.example.com${PATH}`);
  });

  it('keeps a non-default port', () => {
    expect(
      mfaSettingsUrl('https://localhost:9444/application/o/wallet/', PATH),
    ).toBe(`https://localhost:9444${PATH}`);
  });

  it('offers nothing for an issuer that is not a URL', () => {
    expect(mfaSettingsUrl('', PATH)).toBeNull();
    expect(mfaSettingsUrl('not a url', PATH)).toBeNull();
  });
});
