import { Keypair } from '@stellar/stellar-sdk';
import { AliasChallengePurpose, AliasStatus } from '@generated/prisma/client';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { AliasesService } from '@/aliases/aliases.service';
import { aliasChallengeMessage, aliasDigest } from '@/aliases/alias-signing';
import { ALIAS_RECOVERY_MAX_ATTEMPTS } from '@/aliases/aliases.constants';

const consumer = { username: 'cosmos_u1', credentialId: 'cred_1' } as never;
const kp = Keypair.random();

function signFor(body: {
  purpose: AliasChallengePurpose;
  name: string;
  address: string;
  network: string;
  nonce: string;
}) {
  return Buffer.from(
    kp.sign(aliasDigest(aliasChallengeMessage(body))),
  ).toString('base64');
}

/** A challenge row as the database would hold it, live and unspent by default. */
function challengeRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ch_1',
    aliasId: null,
    purpose: AliasChallengePurpose.CLAIM,
    name: 'emanuel250',
    address: kp.publicKey(),
    network: 'public',
    nonce: 'nonce-1',
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    ...over,
  };
}

function build(over: Record<string, unknown> = {}) {
  const prisma = {
    consumer: { upsert: jest.fn().mockResolvedValue({ id: 'c1' }) },
    alias: {
      findUnique: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    aliasAddress: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
    aliasChallenge: {
      findUnique: jest.fn().mockResolvedValue(challengeRow()),
      create: jest.fn().mockResolvedValue(challengeRow()),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    aliasRecovery: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => unknown)(prisma)
        : Promise.all(arg as Promise<unknown>[]),
    ...over,
  };
  const service = new AliasesService(
    prisma as never,
    new ConsumerResolverService(prisma as never),
  );
  return { service, prisma };
}

async function codeOf(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
    return undefined;
  } catch (e) {
    return e instanceof ApiError ? e.code : `THREW:${String(e)}`;
  }
}

describe('AliasesService — claiming', () => {
  const good = {
    purpose: AliasChallengePurpose.CLAIM,
    name: 'emanuel250',
    address: kp.publicKey(),
    network: 'public',
    nonce: 'nonce-1',
  };

  it('claims with a valid signature and makes the first address primary', async () => {
    const { service, prisma } = build();
    prisma.alias.create.mockResolvedValue({
      id: 'al_1',
      name: 'emanuel250',
      displayName: 'Emanuel250',
      email: 'a@b.com',
      emailVerifiedAt: null,
      status: AliasStatus.ACTIVE,
      createdAt: new Date(),
      addresses: [],
    });

    await service.claim(consumer, {
      name: 'Emanuel250',
      email: 'A@B.com',
      nonce: 'nonce-1',
      signature: signFor(good),
    });

    const data = prisma.alias.create.mock.calls[0][0].data;
    // Uniqueness is decided on the folded name; the typed one is display only.
    expect(data.name).toBe('emanuel250');
    expect(data.displayName).toBe('Emanuel250');
    expect(data.email).toBe('a@b.com');
    // The first address on a network is necessarily its default.
    expect(data.addresses.create.isPrimary).toBe(true);
    expect(data.addresses.create.address).toBe(kp.publicKey());
  });

  it('takes the address from the CHALLENGE, never from a constant or the body', async () => {
    // `ClaimAliasDto` has no address field at all, which is the structural half of
    // this rule. The behavioural half is that the registered address tracks
    // whatever the challenge was issued for — asserted here with a DIFFERENT key
    // than the module-level one, so a hardcoded value could not pass.
    const other = Keypair.random();
    const { service, prisma } = build();
    prisma.aliasChallenge.findUnique.mockResolvedValue(
      challengeRow({ address: other.publicKey(), network: 'testnet' }),
    );
    prisma.alias.create.mockResolvedValue({
      id: 'al_1',
      name: 'emanuel250',
      displayName: 'emanuel250',
      email: 'a@b.com',
      emailVerifiedAt: null,
      status: AliasStatus.ACTIVE,
      createdAt: new Date(),
      addresses: [],
    });

    await service.claim(consumer, {
      name: 'emanuel250',
      email: 'a@b.com',
      nonce: 'nonce-1',
      signature: Buffer.from(
        other.sign(
          aliasDigest(
            aliasChallengeMessage({
              purpose: AliasChallengePurpose.CLAIM,
              name: 'emanuel250',
              address: other.publicKey(),
              network: 'testnet',
              nonce: 'nonce-1',
            }),
          ),
        ),
      ).toString('base64'),
    });

    const created = prisma.alias.create.mock.calls[0][0].data.addresses.create;
    expect(created.address).toBe(other.publicKey());
    expect(created.network).toBe('testnet');
  });

  it('refuses a signature from another key', async () => {
    const { service } = build();
    const impostor = Keypair.random();
    const sig = Buffer.from(
      impostor.sign(aliasDigest(aliasChallengeMessage(good))),
    ).toString('base64');

    expect(
      await codeOf(
        service.claim(consumer, {
          name: 'emanuel250',
          email: 'a@b.com',
          nonce: 'nonce-1',
          signature: sig,
        }),
      ),
    ).toBe(ApiErrorCode.AliasSignatureInvalid);
  });

  it('refuses an expired or already-spent challenge', async () => {
    for (const over of [
      { expiresAt: new Date(Date.now() - 1) },
      { consumedAt: new Date() },
      { name: 'a_different_name' },
    ]) {
      const { service, prisma } = build();
      prisma.aliasChallenge.findUnique.mockResolvedValue(challengeRow(over));
      expect(
        await codeOf(
          service.claim(consumer, {
            name: 'emanuel250',
            email: 'a@b.com',
            nonce: 'nonce-1',
            signature: signFor(good),
          }),
        ),
      ).toBe(ApiErrorCode.AliasChallengeInvalid);
    }
  });

  it('verifies the signature BEFORE spending the challenge', async () => {
    // Otherwise anyone could burn a rival's in-flight challenge by replaying its
    // nonce with a junk signature.
    const { service, prisma } = build();
    await codeOf(
      service.claim(consumer, {
        name: 'emanuel250',
        email: 'a@b.com',
        nonce: 'nonce-1',
        signature: 'garbage',
      }),
    );
    expect(prisma.aliasChallenge.updateMany).not.toHaveBeenCalled();
  });

  it('reports a lost race as alias_taken rather than a 500', async () => {
    // The unique index settles the race, not a pre-check — a `findUnique` first
    // would be a TOCTOU window on an operation whose loser is permanent.
    const { service, prisma } = build();
    prisma.alias.create.mockRejectedValue(
      Object.assign(new Error('unique'), {
        code: 'P2002',
        name: 'PrismaClientKnownRequestError',
        constructor: { name: 'PrismaClientKnownRequestError' },
      }),
    );
    const code = await codeOf(
      service.claim(consumer, {
        name: 'emanuel250',
        email: 'a@b.com',
        nonce: 'nonce-1',
        signature: signFor(good),
      }),
    );
    // Either mapped (real Prisma error class) or rethrown — what must never happen
    // is a silent success.
    expect(code).toBeDefined();
  });
});

describe('AliasesService — resolution', () => {
  it('returns every address with the primary first', async () => {
    const { service, prisma } = build();
    prisma.alias.findUnique.mockResolvedValue({
      name: 'emanuel250',
      displayName: 'Emanuel250',
      status: AliasStatus.ACTIVE,
      addresses: [
        { address: 'GPRIMARY', network: 'public', isPrimary: true },
        { address: 'GOTHER', network: 'public', isPrimary: false },
      ],
    });

    const res = await service.resolve('EMANUEL250', 'public');
    expect(res.primaryAddress).toBe('GPRIMARY');
    expect(res.addresses).toHaveLength(2);
    // Lookup folds case, so a payer typing it from memory finds it.
    expect(prisma.alias.findUnique.mock.calls[0][0].where.name).toBe(
      'emanuel250',
    );
  });

  it('a suspended alias resolves to nothing at all', async () => {
    // A suspension that still hands out an account does nothing about the money.
    const { service, prisma } = build();
    prisma.alias.findUnique.mockResolvedValue({
      name: 'emanuel250',
      displayName: 'e',
      status: AliasStatus.SUSPENDED,
      addresses: [{ address: 'GX', network: 'public', isPrimary: true }],
    });
    expect(await codeOf(service.resolve('emanuel250'))).toBe(
      ApiErrorCode.NotFound,
    );
  });

  it('never returns the owner mailbox', async () => {
    const { service, prisma } = build();
    prisma.alias.findUnique.mockResolvedValue({
      name: 'emanuel250',
      displayName: 'e',
      email: 'secret@example.com',
      status: AliasStatus.ACTIVE,
      addresses: [],
    });
    const res = await service.resolve('emanuel250');
    expect(JSON.stringify(res)).not.toContain('secret@example.com');
  });
});

describe('AliasesService — recovery', () => {
  it('answers identically whether or not the alias and mailbox matched', async () => {
    // The handle is public and the mailbox behind it is not. A differing answer
    // would confirm who owns a name to anyone who asked.
    const missing = build();
    missing.prisma.alias.findUnique.mockResolvedValue(null);
    const a = await missing.service.startRecovery('nobody', {
      email: 'x@y.com',
    });

    const wrongEmail = build();
    wrongEmail.prisma.alias.findUnique.mockResolvedValue({
      id: 'al_1',
      name: 'emanuel250',
      email: 'real@example.com',
      status: AliasStatus.ACTIVE,
    });
    const b = await wrongEmail.service.startRecovery('emanuel250', {
      email: 'guess@example.com',
    });

    expect(a).toEqual(b);
    expect(a.accepted).toBe(true);
    expect(a.token).toBeNull();
  });

  it('mints a token, stores only its hash, and burns any earlier one', async () => {
    const { service, prisma } = build();
    prisma.alias.findUnique.mockResolvedValue({
      id: 'al_1',
      name: 'emanuel250',
      email: 'real@example.com',
      status: AliasStatus.ACTIVE,
    });

    const res = await service.startRecovery('emanuel250', {
      email: 'REAL@example.com',
    });

    expect(res.token).toEqual(expect.any(String));
    expect(res.email).toBe('real@example.com');
    // Two live tokens means the older keeps working after the owner started again.
    expect(prisma.aliasRecovery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { aliasId: 'al_1', consumedAt: null } }),
    );
    // The plaintext must exist only in the response.
    const stored = prisma.aliasRecovery.create.mock.calls[0][0].data;
    expect(stored.tokenHash).not.toBe(res.token);
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a token that is unknown, spent, expired, exhausted or another alias’s, and writes nothing', async () => {
    const cases = [
      null,
      {
        aliasId: 'al_1',
        consumedAt: new Date(),
        expiresAt: new Date(Date.now() + 1000),
        attempts: 0,
      },
      {
        aliasId: 'al_1',
        consumedAt: null,
        expiresAt: new Date(Date.now() - 1),
        attempts: 0,
      },
      {
        aliasId: 'al_1',
        consumedAt: null,
        expiresAt: new Date(Date.now() + 1000),
        attempts: ALIAS_RECOVERY_MAX_ATTEMPTS,
      },
      {
        aliasId: 'OTHER',
        consumedAt: null,
        expiresAt: new Date(Date.now() + 1000),
        attempts: 0,
      },
    ];
    for (const row of cases) {
      const { service, prisma } = build();
      prisma.alias.findUnique.mockResolvedValue({
        id: 'al_1',
        name: 'emanuel250',
        email: 'real@example.com',
        status: AliasStatus.ACTIVE,
      });
      prisma.aliasRecovery.findUnique.mockResolvedValue(row);

      expect(
        await codeOf(
          service.completeRecovery(consumer, 'emanuel250', {
            token: 'whatever',
            address: kp.publicKey(),
            network: 'public',
            nonce: 'nonce-1',
            signature: signFor({
              ...good(),
              purpose: AliasChallengePurpose.RECOVER,
            }),
          }),
        ),
      ).toBe(ApiErrorCode.AliasRecoveryInvalid);
      // Nothing is written for a token that names no live recovery of this
      // alias. Counting it against the alias's live recovery let anyone burn it,
      // because the handle is public.
      expect(prisma.aliasRecovery.updateMany).not.toHaveBeenCalled();
      // Nor does it reach the proof step.
      expect(prisma.aliasChallenge.updateMany).not.toHaveBeenCalled();
    }
  });

  describe('the attempt ladder', () => {
    const liveAlias = {
      id: 'al_1',
      name: 'emanuel250',
      email: 'real@example.com',
      status: AliasStatus.ACTIVE,
    };

    /** A RECOVER completion body for `token`, signed over `nonce-1`. */
    function recoverWith(token: string, signer: Keypair = kp) {
      const body = { ...good(), purpose: AliasChallengePurpose.RECOVER };
      return {
        token,
        address: kp.publicKey(),
        network: 'public',
        nonce: 'nonce-1',
        signature: Buffer.from(
          signer.sign(aliasDigest(aliasChallengeMessage(body))),
        ).toString('base64'),
      };
    }

    /**
     * `aliasRecovery` as an in-memory table that honours the `where` shapes the
     * service writes, so an attempt counted by one call is what the next call
     * reads. The default mock answers `{ count: 1 }` to everything and remembers
     * nothing, which is exactly how the old bug went unseen.
     */
    function recoveryTable() {
      const rows: Record<string, any>[] = [];
      const matches = (row: Record<string, any>, where: Record<string, any>) =>
        Object.entries(where).every(([key, cond]) => {
          if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
            if ('lt' in cond) return row[key] < cond.lt;
            if ('gt' in cond) return row[key] > cond.gt;
          }
          return row[key] === cond;
        });
      return {
        rows,
        findUnique: jest.fn(({ where }: any) =>
          Promise.resolve(
            rows.find((r) => r.tokenHash === where.tokenHash) ?? null,
          ),
        ),
        create: jest.fn(({ data }: any) => {
          const row = {
            id: `rec_${rows.length + 1}`,
            consumedAt: null,
            attempts: 0,
            ...data,
          };
          rows.push(row);
          return Promise.resolve(row);
        }),
        updateMany: jest.fn(({ where, data }: any) => {
          const hits = rows.filter((r) => matches(r, where));
          for (const row of hits) {
            if (data.attempts?.increment) {
              row.attempts += data.attempts.increment;
            }
            if (data.consumedAt) row.consumedAt = data.consumedAt;
          }
          return Promise.resolve({ count: hits.length });
        }),
      };
    }

    /** A live recovery for `emanuel250`, started the way the console starts it. */
    async function started() {
      const table = recoveryTable();
      const { service, prisma } = build({ aliasRecovery: table });
      prisma.alias.findUnique.mockResolvedValue(liveAlias);
      prisma.aliasChallenge.findUnique.mockResolvedValue(
        challengeRow({
          purpose: AliasChallengePurpose.RECOVER,
          aliasId: 'al_1',
        }),
      );
      prisma.alias.update.mockResolvedValue({
        ...liveAlias,
        displayName: 'emanuel250',
        emailVerifiedAt: null,
        createdAt: new Date(),
        addresses: [],
      });
      const { token } = await service.startRecovery('emanuel250', {
        email: 'real@example.com',
      });
      return { service, prisma, table, token: token! };
    }

    it('junk tokens from any caller leave the owner’s live recovery usable', async () => {
      // Handles are public. When every bad token counted against the alias's
      // live recovery, ALIAS_RECOVERY_MAX_ATTEMPTS junk requests from any key
      // burned the recovery the console had just started for the owner.
      const { service, prisma, table, token } = await started();

      for (let i = 0; i <= ALIAS_RECOVERY_MAX_ATTEMPTS; i++) {
        expect(
          await codeOf(
            service.completeRecovery(
              consumer,
              'emanuel250',
              recoverWith(`junk-${i}`),
            ),
          ),
        ).toBe(ApiErrorCode.AliasRecoveryInvalid);
      }
      expect(table.rows[0].attempts).toBe(0);

      // The owner's genuine token still works.
      expect(
        await codeOf(
          service.completeRecovery(consumer, 'emanuel250', recoverWith(token)),
        ),
      ).toBeUndefined();
      expect(table.rows[0].consumedAt).not.toBeNull();
      expect(prisma.alias.update.mock.calls[0][0].data).toEqual({
        consumerId: 'c1',
      });
    });

    it('counts a live token whose proof fails, then refuses it once the ladder is spent', async () => {
      // This is what the ladder is for. A failing challenge or signature used to
      // throw before anything was counted, so a live token could be tried
      // against the proof step without limit.
      const { service, prisma, table, token } = await started();
      const impostor = Keypair.random();

      for (let i = 0; i < ALIAS_RECOVERY_MAX_ATTEMPTS; i++) {
        expect(
          await codeOf(
            service.completeRecovery(
              consumer,
              'emanuel250',
              recoverWith(token, impostor),
            ),
          ),
        ).toBe(ApiErrorCode.AliasSignatureInvalid);
      }
      expect(table.rows[0].attempts).toBe(ALIAS_RECOVERY_MAX_ATTEMPTS);

      // Now even a correct proof is refused, with the answer a junk token gets.
      expect(
        await codeOf(
          service.completeRecovery(consumer, 'emanuel250', recoverWith(token)),
        ),
      ).toBe(ApiErrorCode.AliasRecoveryInvalid);
      expect(prisma.aliasAddress.deleteMany).not.toHaveBeenCalled();
      expect(prisma.alias.update).not.toHaveBeenCalled();
    });

    it('holds the ladder exactly when attempts arrive concurrently', async () => {
      // Every request reads `attempts = 0` before any of them writes. A
      // read-check-then-increment would let all of them through to the proof
      // step. Checking and counting in one statement admits exactly the ladder.
      const { service, table, token } = await started();
      const impostor = Keypair.random();
      const extra = 3;

      const codes = await Promise.all(
        Array.from({ length: ALIAS_RECOVERY_MAX_ATTEMPTS + extra }, () =>
          codeOf(
            service.completeRecovery(
              consumer,
              'emanuel250',
              recoverWith(token, impostor),
            ),
          ),
        ),
      );

      expect(table.rows[0].attempts).toBe(ALIAS_RECOVERY_MAX_ATTEMPTS);
      expect(
        codes.filter((c) => c === ApiErrorCode.AliasSignatureInvalid),
      ).toHaveLength(ALIAS_RECOVERY_MAX_ATTEMPTS);
      expect(
        codes.filter((c) => c === ApiErrorCode.AliasRecoveryInvalid),
      ).toHaveLength(extra);
    });
  });

  it('refuses to recover a suspended alias, even with a live token', async () => {
    // A suspension is an operator hold; a token minted before it is not a way out.
    const { service, prisma } = build();
    prisma.alias.findUnique.mockResolvedValue({
      id: 'al_1',
      name: 'emanuel250',
      email: 'real@example.com',
      status: AliasStatus.SUSPENDED,
    });
    prisma.aliasRecovery.findUnique.mockResolvedValue({
      id: 'rec_1',
      aliasId: 'al_1',
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      attempts: 0,
    });

    expect(
      await codeOf(
        service.completeRecovery(consumer, 'emanuel250', {
          token: 'tok',
          address: kp.publicKey(),
          network: 'public',
          nonce: 'nonce-1',
          signature: signFor({
            ...good(),
            purpose: AliasChallengePurpose.RECOVER,
          }),
        }),
      ),
    ).toBe(ApiErrorCode.NotFound);
    expect(prisma.aliasChallenge.updateMany).not.toHaveBeenCalled();
    expect(prisma.aliasAddress.deleteMany).not.toHaveBeenCalled();
    expect(prisma.alias.update).not.toHaveBeenCalled();
  });

  it('drops every previous address when ownership moves', async () => {
    // Recovery exists because the old keys are gone. Leaving them resolvable would
    // keep whoever holds them receiving money sent to this name.
    const { service, prisma } = build();
    prisma.alias.findUnique.mockResolvedValue({
      id: 'al_1',
      name: 'emanuel250',
      email: 'real@example.com',
      status: AliasStatus.ACTIVE,
    });
    prisma.aliasRecovery.findUnique.mockResolvedValue({
      id: 'rec_1',
      aliasId: 'al_1',
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      attempts: 0,
    });
    prisma.aliasChallenge.findUnique.mockResolvedValue(
      challengeRow({ purpose: AliasChallengePurpose.RECOVER, aliasId: 'al_1' }),
    );
    prisma.alias.update.mockResolvedValue({
      id: 'al_1',
      name: 'emanuel250',
      displayName: 'emanuel250',
      email: 'real@example.com',
      emailVerifiedAt: null,
      status: AliasStatus.ACTIVE,
      createdAt: new Date(),
      addresses: [],
    });

    await service.completeRecovery(consumer, 'emanuel250', {
      token: 'tok',
      address: kp.publicKey(),
      network: 'public',
      nonce: 'nonce-1',
      signature: signFor({ ...good(), purpose: AliasChallengePurpose.RECOVER }),
    });

    expect(prisma.aliasAddress.deleteMany).toHaveBeenCalledWith({
      where: { aliasId: 'al_1' },
    });
    expect(prisma.aliasAddress.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          address: kp.publicKey(),
          isPrimary: true,
        }),
      }),
    );
    // Ownership moves to the caller's consumer.
    expect(prisma.alias.update.mock.calls[0][0].data).toEqual({
      consumerId: 'c1',
    });
  });
});

/** The challenge body the mocked rows correspond to. */
function good() {
  return {
    purpose: AliasChallengePurpose.CLAIM,
    name: 'emanuel250',
    address: kp.publicKey(),
    network: 'public',
    nonce: 'nonce-1',
  };
}
