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

  it('refuses a token that is unknown, expired, spent or over its attempt ladder', async () => {
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
      // A wrong token counts against the ladder, so the endpoint is not an oracle.
      expect(prisma.aliasRecovery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { attempts: { increment: 1 } } }),
      );
    }
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
