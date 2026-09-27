import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  type Transaction,
} from '@stellar/stellar-sdk';
import {
  actorFromToken,
  buildStellarToml,
  issueIdentityToken,
  issueSep10Token,
  listWhere,
  mayAct,
  signerFor,
  signRefusal,
  type RecoveryRules,
} from '@/recovery/recovery-core';
import {
  buildChallenge,
  readChallenge,
  verifyChallenge,
} from '@/recovery/sep10-core';

const PASSPHRASE = Networks.TESTNET;
const NOW = Math.floor(Date.now() / 1000);

function rules(role: 'a' | 'b' = 'a'): RecoveryRules {
  return {
    role,
    sep10: {
      signingSecret: Keypair.random().secret(),
      homeDomain: 'cosmospay.lat',
      webAuthDomain: `recovery-${role}.cosmospay.lat`,
      networkPassphrase: PASSPHRASE,
    },
    signerMaster: Keypair.random().secret(),
    jwtSecret: 'a-recovery-jwt-secret-long-enough-000000',
    webAuthEndpoint: `https://recovery-${role}.cosmospay.lat/cosmos-api/v1/sep10/auth`,
  };
}

/* ---------------------------------- the signer ---------------------------------- */

describe('signerFor', () => {
  const master = Keypair.random().secret();

  it('derives the same signer for the same account, and a different one for another', () => {
    const a = Keypair.random().publicKey();
    const b = Keypair.random().publicKey();
    expect(signerFor(master, a).publicKey()).toBe(
      signerFor(master, a).publicKey(),
    );
    expect(signerFor(master, a).publicKey()).not.toBe(
      signerFor(master, b).publicKey(),
    );
  });

  it('never derives the master itself', () => {
    const a = Keypair.random().publicKey();
    expect(signerFor(master, a).secret()).not.toBe(master);
  });
});

/* ---------------------------------- the tokens ---------------------------------- */

describe('actorFromToken', () => {
  const r = rules('a');
  const account = Keypair.random().publicKey();

  it('reads a SEP-10 token as the account', () => {
    expect(actorFromToken(r, issueSep10Token(r, account))).toEqual({
      kind: 'address',
      address: account,
    });
  });

  it('reads an identity token as the inbox, never as the account', () => {
    expect(actorFromToken(r, issueIdentityToken(r, 'Ada@Example.com'))).toEqual(
      {
        kind: 'identity',
        type: 'email',
        value: 'ada@example.com',
      },
    );
  });

  /* The two servers share code and must share nothing else. */
  it("refuses the sibling server's tokens even with the same secret", () => {
    const b = { ...rules('b'), jwtSecret: r.jwtSecret };
    expect(actorFromToken(r, issueSep10Token(b, account))).toBeNull();
    expect(
      actorFromToken(r, issueIdentityToken(b, 'ada@example.com')),
    ).toBeNull();
  });
});

describe('mayAct / listWhere', () => {
  const address = Keypair.random().publicKey();
  const methods = [{ type: 'email', value: 'ada@example.com' }];

  it('lets the key holder and the registered inbox act, and nobody else', () => {
    expect(mayAct({ kind: 'address', address }, address, methods)).toBe(true);
    expect(
      mayAct(
        { kind: 'identity', type: 'email', value: 'ada@example.com' },
        address,
        methods,
      ),
    ).toBe(true);
    expect(
      mayAct(
        { kind: 'identity', type: 'email', value: 'eve@example.com' },
        address,
        methods,
      ),
    ).toBe(false);
    expect(
      mayAct(
        { kind: 'address', address: Keypair.random().publicKey() },
        address,
        methods,
      ),
    ).toBe(false);
  });

  /* A cursor merged over the scope could overwrite it; ANDed, it can only narrow. */
  it('combines the cursor with the scope rather than merging it', () => {
    const where = listWhere(
      'a',
      { kind: 'identity', type: 'email', value: 'ada@example.com' },
      address,
    );
    expect(where).toEqual({
      AND: [
        {
          role: 'a',
          methods: { some: { type: 'email', value: 'ada@example.com' } },
        },
        { address: { gt: address } },
      ],
    });
  });
});

/* ---------------------------------- the policy ---------------------------------- */

describe('signRefusal', () => {
  const owner = Keypair.random();
  const address = owner.publicKey();
  const newKey = Keypair.random().publicKey();

  function tx(
    build: (b: TransactionBuilder) => TransactionBuilder,
    opts: { memo?: Memo; timeout?: number; source?: string } = {},
  ) {
    const b = new TransactionBuilder(
      new Account(opts.source ?? address, '10'),
      {
        fee: '200',
        networkPassphrase: PASSPHRASE,
        memo: opts.memo ?? Memo.none(),
      },
    );
    return build(b)
      .setTimeout(opts.timeout ?? 300)
      .build();
  }

  const replacement = (b: TransactionBuilder) =>
    b
      .addOperation(
        Operation.setOptions({
          source: address,
          signer: { ed25519PublicKey: newKey, weight: 10 },
        }),
      )
      .addOperation(Operation.setOptions({ source: address, masterWeight: 0 }));

  it("signs the wallet's own key replacement", () => {
    expect(signRefusal(tx(replacement), address, NOW)).toBeNull();
  });

  it('signs the sponsored variant, sponsor for THIS account', () => {
    const sponsor = Keypair.random().publicKey();
    const t = tx((b) =>
      b
        .addOperation(
          Operation.beginSponsoringFutureReserves({
            source: sponsor,
            sponsoredId: address,
          }),
        )
        .addOperation(
          Operation.setOptions({
            source: address,
            signer: { ed25519PublicKey: newKey, weight: 10 },
          }),
        )
        .addOperation(
          Operation.endSponsoringFutureReserves({ source: address }),
        ),
    );
    expect(signRefusal(t, address, NOW)).toBeNull();
  });

  it.each([
    ['a merge', () => Operation.accountMerge({ destination: newKey })],
    [
      'a payment',
      () =>
        Operation.payment({
          destination: newKey,
          asset: Asset.native(),
          amount: '1',
        }),
    ],
    ['a data entry', () => Operation.manageData({ name: 'x', value: 'y' })],
  ])('refuses %s', (_, op) => {
    expect(
      signRefusal(
        tx((b) => b.addOperation(op())),
        address,
        NOW,
      ),
    ).toBe('operation_not_allowed');
  });

  it('refuses a transaction sourced by another account', () => {
    expect(
      signRefusal(
        tx(replacement, { source: Keypair.random().publicKey() }),
        address,
        NOW,
      ),
    ).toBe('foreign_source');
  });

  it('refuses an operation sourced by another account', () => {
    const t = tx((b) =>
      b.addOperation(
        Operation.setOptions({
          source: newKey,
          signer: { ed25519PublicKey: newKey, weight: 10 },
        }),
      ),
    );
    expect(signRefusal(t, address, NOW)).toBe('foreign_operation_source');
  });

  it('refuses sponsorship of some other account', () => {
    const t = tx((b) =>
      b.addOperation(
        Operation.beginSponsoringFutureReserves({
          source: address,
          sponsoredId: Keypair.random().publicKey(),
        }),
      ),
    );
    expect(signRefusal(t, address, NOW)).toBe('foreign_operation_source');
  });

  it.each([
    ['flags', { setFlags: 1 }],
    ['a home domain', { homeDomain: 'evil.example.com' }],
    ['a cleared home domain', { homeDomain: '' }],
    [
      'an inflation destination',
      { inflationDest: Keypair.random().publicKey() },
    ],
  ])('refuses a setOptions that touches %s', (_, extra) => {
    const t = tx((b) =>
      b.addOperation(
        Operation.setOptions({ source: address, ...(extra as object) }),
      ),
    );
    expect(signRefusal(t, address, NOW)).toBe('option_not_allowed');
  });

  it('refuses a hash signer', () => {
    const t = tx((b) =>
      b.addOperation(
        Operation.setOptions({
          source: address,
          signer: { sha256Hash: Buffer.alloc(32, 1), weight: 10 },
        }),
      ),
    );
    expect(signRefusal(t, address, NOW)).toBe('unsupported_signer');
  });

  it('refuses a memo', () => {
    expect(
      signRefusal(tx(replacement, { memo: Memo.text('hi') }), address, NOW),
    ).toBe('memo_not_allowed');
  });

  /* A co-signature with a long window is a standing takeover instrument. */
  it('refuses a window longer than fifteen minutes', () => {
    expect(
      signRefusal(tx(replacement, { timeout: 24 * 3600 }), address, NOW),
    ).toBe('window_too_long');
  });

  it('refuses no expiry at all', () => {
    const t = new TransactionBuilder(new Account(address, '10'), {
      fee: '200',
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(Operation.setOptions({ source: address, masterWeight: 0 }))
      .setTimeout(0)
      .build();
    expect(signRefusal(t, address, NOW)).toBe('no_expiry');
  });

  it('refuses a fee bump', () => {
    const inner = tx(replacement);
    inner.sign(owner);
    const bump = TransactionBuilder.buildFeeBumpTransaction(
      Keypair.random(),
      '1000',
      inner,
      PASSPHRASE,
    );
    expect(signRefusal(bump, address, NOW)).toBe('fee_bump');
  });
});

/* ---------------------------------- SEP-10 ---------------------------------- */

describe('sep10', () => {
  const r = rules('a');
  const owner = Keypair.random();
  const server = Keypair.fromSecret(r.sep10.signingSecret);

  const signed = (xdr: string, ...keys: Keypair[]) => {
    const t = TransactionBuilder.fromXDR(xdr, PASSPHRASE) as Transaction;
    for (const k of keys) t.sign(k);
    return t.toXDR();
  };

  it('builds an unsubmittable challenge naming this server and the wallet domain', () => {
    const t = TransactionBuilder.fromXDR(
      buildChallenge(r.sep10, owner.publicKey()),
      PASSPHRASE,
    ) as Transaction;
    expect(t.sequence).toBe('0');
    expect(t.source).toBe(server.publicKey());
    expect(t.operations[0]).toMatchObject({
      type: 'manageData',
      name: 'cosmospay.lat auth',
      source: owner.publicKey(),
    });
  });

  it("authenticates an account that doesn't exist yet by its master key", () => {
    const xdr = signed(buildChallenge(r.sep10, owner.publicKey()), owner);
    expect(verifyChallenge(r.sep10, xdr, null)).toEqual({
      ok: true,
      account: owner.publicKey(),
    });
  });

  /* The recovered account: master at 0, a new device key at the threshold. */
  it('authenticates a recovered account with the key that replaced its master', () => {
    const device = Keypair.random();
    const xdr = signed(buildChallenge(r.sep10, owner.publicKey()), device);
    const signers = {
      signers: [
        { key: owner.publicKey(), weight: 0 },
        { key: device.publicKey(), weight: 10 },
      ],
      medThreshold: 10,
      highThreshold: 10,
    };
    expect(verifyChallenge(r.sep10, xdr, signers)).toEqual({
      ok: true,
      account: owner.publicKey(),
    });
  });

  it('refuses one recovery server authenticating as the account', () => {
    const half = Keypair.random();
    const xdr = signed(buildChallenge(r.sep10, owner.publicKey()), half);
    const signers = {
      signers: [
        { key: owner.publicKey(), weight: 10 },
        { key: half.publicKey(), weight: 5 },
      ],
      medThreshold: 10,
      highThreshold: 10,
    };
    expect(verifyChallenge(r.sep10, xdr, signers)).toEqual({
      ok: false,
      error: 'below_threshold',
    });
  });

  it("refuses the sibling server's challenge", () => {
    const b = rules('b');
    const xdr = signed(buildChallenge(b.sep10, owner.publicKey()), owner);
    expect(readChallenge(r.sep10, xdr)).toEqual({
      ok: false,
      error: 'wrong_server',
    });
  });

  it('refuses a challenge replayed at another web-auth domain', () => {
    const elsewhere = { ...r.sep10, webAuthDomain: 'recovery-b.cosmospay.lat' };
    const xdr = signed(buildChallenge(elsewhere, owner.publicKey()), owner);
    expect(readChallenge(r.sep10, xdr)).toEqual({
      ok: false,
      error: 'wrong_web_auth_domain',
    });
  });

  it('refuses an expired challenge', () => {
    const xdr = buildChallenge(r.sep10, owner.publicKey(), NOW - 3600);
    expect(readChallenge(r.sep10, xdr, NOW)).toEqual({
      ok: false,
      error: 'expired',
    });
  });

  it('refuses a signature missing from the client', () => {
    const xdr = buildChallenge(r.sep10, owner.publicKey());
    expect(verifyChallenge(r.sep10, xdr, null)).toEqual({
      ok: false,
      error: 'client_signature',
    });
  });
});

/* ---------------------------------- the TOML ---------------------------------- */

describe('buildStellarToml', () => {
  it('publishes the signing key DERIVED from the secret, and the SEP-30 base', () => {
    const r = rules('a');
    const toml = buildStellarToml({
      rules: r,
      horizonUrl: 'https://horizon-testnet.stellar.org',
      sep30Endpoint: 'https://recovery-a.cosmospay.lat/cosmos-api/v1/sep30',
      oidcIssuer: 'https://auth.cosmospay.lat/application/o/wallet/',
      emailCodes: false,
    });
    expect(toml).toContain(
      `SIGNING_KEY = "${Keypair.fromSecret(r.sep10.signingSecret).publicKey()}"`,
    );
    expect(toml).toContain(`WEB_AUTH_ENDPOINT = "${r.webAuthEndpoint}"`);
    expect(toml).toContain('HOME_DOMAIN = "cosmospay.lat"');
    expect(toml).toContain(
      'ENDPOINT = "https://recovery-a.cosmospay.lat/cosmos-api/v1/sep30"',
    );
    expect(toml).toContain('ROLE = "a"');
    expect(toml).toContain('EMAIL_CODES = false');
    // Top-level fields before the table, which is all a strict reader looks at.
    expect(toml.indexOf('SIGNING_KEY')).toBeLessThan(
      toml.indexOf('[[RECOVERY_SERVERS]]'),
    );
  });
});
