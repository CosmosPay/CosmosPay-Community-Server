import { secp256k1 } from '@noble/curves/secp256k1.js';
import { eip191Digest } from '@/chains/message-signature';
import { addressOfSecretKey } from '@/evm/evm-transaction';
import { P2pAccountsService } from '@/p2p/p2p-accounts.service';
import { registrationMessage } from '@/p2p/p2p-account-challenge';

const KEY = new Uint8Array(32).fill(3);
const ADDRESS = addressOfSecretKey(KEY);
const OTHER_KEY = new Uint8Array(32).fill(4);

/** `personal_sign`, as a wallet answers it: r || s || v, 0x-hex. */
function personalSign(message: string, key: Uint8Array): string {
  const sig = secp256k1.sign(eip191Digest(Buffer.from(message, 'utf8')), key, {
    prehash: false,
    format: 'recovered',
  });
  const v = 27 + sig[0];
  return `0x${Buffer.from(sig.subarray(1)).toString('hex')}${v.toString(16)}`;
}

const CONSUMER = { username: 'cosmos_u1', environment: 'dev' } as never;

function setup() {
  const challenges: Record<string, unknown>[] = [];
  const accounts: Record<string, unknown>[] = [];
  const prisma = {
    p2pAccountChallenge: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        challenges.push({
          id: `ch${challenges.length}`,
          usedAt: null,
          createdAt: new Date(),
          ...data,
        });
        return Promise.resolve({});
      }),
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          challenges.filter(
            (c) =>
              c.consumerId === where.consumerId &&
              c.tier === where.tier &&
              c.address === where.address &&
              c.usedAt === null &&
              (c.expiresAt as Date) > new Date(),
          ),
        ),
      ),
      // Atomic per statement, like the real compare-and-swap.
      updateMany: jest.fn(
        ({ where, data }: { where: { id: string }; data: object }) => {
          const row = challenges.find(
            (c) => c.id === where.id && c.usedAt === null,
          );
          if (!row) return Promise.resolve({ count: 0 });
          Object.assign(row, data);
          return Promise.resolve({ count: 1 });
        },
      ),
    },
    p2pAccount: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        if (
          accounts.some(
            (a) => a.tier === data.tier && a.address === data.address,
          )
        ) {
          return Promise.reject(
            Object.assign(new Error('unique'), { code: 'P2002' }),
          );
        }
        const row = {
          id: `acc${accounts.length}`,
          label: null,
          displayName: null,
          merchantStatus: 'ACTIVE',
          completedOrders: 0,
          cancelledOrders: 0,
          disputesLost: 0,
          medianReleaseSeconds: null,
          lastActiveAt: null,
          operators: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        accounts.push(row);
        return Promise.resolve(row);
      }),
    },
  };
  const service = new P2pAccountsService(
    prisma as never,
    { resolveId: jest.fn().mockResolvedValue('consumer_1') } as never,
    { tierFor: () => 'testnet', matcherAddress: () => null } as never,
    {} as never,
  );
  return { service, prisma, challenges };
}

describe('P2pAccountsService registration', () => {
  it('registers a wallet that signed its challenge, and uses the challenge up', async () => {
    const { service } = setup();
    const { message } = await service.challenge(CONSUMER, { address: ADDRESS });
    expect(message).toContain(`Register wallet: ${ADDRESS}`);
    expect(message).toContain('For: cosmos_u1');
    expect(message).toContain('Tier: testnet');
    const signature = personalSign(message, KEY);

    const account = await service.register(CONSUMER, {
      address: ADDRESS.toLowerCase(),
      signature,
      displayName: 'Pampa Cambio',
    });
    expect(account).toMatchObject({
      address: ADDRESS,
      tier: 'testnet',
      displayName: 'Pampa Cambio',
      merchantStatus: 'ACTIVE',
    });
    expect(account).not.toHaveProperty('consumerId');

    // The same signature again: its challenge is used.
    await expect(
      service.register(CONSUMER, { address: ADDRESS, signature }),
    ).rejects.toMatchObject({ code: 'p2p_challenge_invalid' });
  });

  it('refuses a signature by another key', async () => {
    const { service } = setup();
    const { message } = await service.challenge(CONSUMER, { address: ADDRESS });
    await expect(
      service.register(CONSUMER, {
        address: ADDRESS,
        signature: personalSign(message, OTHER_KEY),
      }),
    ).rejects.toMatchObject({ code: 'p2p_signature_invalid' });
  });

  it('refuses a signature over a message naming another consumer', async () => {
    const { service, challenges } = setup();
    await service.challenge(CONSUMER, { address: ADDRESS });
    const c = challenges[0];
    const forged = registrationMessage({
      address: ADDRESS,
      consumer: 'cosmos_other',
      tier: 'testnet',
      nonce: c.nonce as string,
      expiresAt: c.expiresAt as Date,
    });
    await expect(
      service.register(CONSUMER, {
        address: ADDRESS,
        signature: personalSign(forged, KEY),
      }),
    ).rejects.toMatchObject({ code: 'p2p_signature_invalid' });
  });

  it('refuses without an open challenge, and an expired one', async () => {
    const { service, challenges } = setup();
    await expect(
      service.register(CONSUMER, {
        address: ADDRESS,
        signature: `0x${'11'.repeat(65)}`,
      }),
    ).rejects.toMatchObject({ code: 'p2p_challenge_invalid' });
    const { message } = await service.challenge(CONSUMER, { address: ADDRESS });
    challenges[0].expiresAt = new Date(Date.now() - 1);
    await expect(
      service.register(CONSUMER, {
        address: ADDRESS,
        signature: personalSign(message, KEY),
      }),
    ).rejects.toMatchObject({ code: 'p2p_challenge_invalid' });
  });

  it('answers 409 for a wallet already registered on the tier', async () => {
    const { service } = setup();
    for (let i = 0; i < 2; i += 1) {
      const { message } = await service.challenge(CONSUMER, {
        address: ADDRESS,
      });
      const attempt = service.register(CONSUMER, {
        address: ADDRESS,
        signature: personalSign(message, KEY),
      });
      if (i === 0) await attempt;
      else
        await expect(attempt).rejects.toMatchObject({
          code: 'p2p_account_taken',
        });
    }
  });
});

describe('P2pAccountsService live state', () => {
  it('sums what the account has locked per network and token, from the order rows', async () => {
    const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
    const row = {
      id: 'acc0',
      tier: 'testnet',
      address: ADDRESS,
      label: null,
      displayName: 'Pampa',
      merchantStatus: 'ACTIVE',
      completedOrders: 0,
      cancelledOrders: 0,
      disputesLost: 0,
      medianReleaseSeconds: null,
      lastActiveAt: null,
      verifiedAt: new Date(),
      operators: { base: { '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65': 2 } },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const findMany = jest.fn().mockResolvedValue([
      {
        network: 'base',
        token: USDC,
        sellerAddress: ADDRESS,
        tokenAmount: '100',
        bond: '0',
      },
      {
        network: 'base',
        token: USDC,
        sellerAddress: ADDRESS,
        tokenAmount: '50',
        bond: '5',
      },
      {
        network: 'base',
        token: USDC,
        sellerAddress: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        tokenAmount: '200',
        bond: '20',
      },
    ]);
    const prisma = {
      p2pAccount: { findFirst: jest.fn().mockResolvedValue(row) },
      p2pOrder: { findMany },
    };
    const reader = {
      liveDeployments: jest.fn().mockResolvedValue([
        {
          network: 'base',
          tokens: [{ symbol: 'USDC', address: USDC, decimals: 6 }],
        },
      ]),
      balanceOf: jest.fn().mockResolvedValue(1_000n),
      matcherTerms: jest
        .fn()
        .mockResolvedValue({ maxPerOrder: 500n, autoSettle: false }),
    };
    const service = new P2pAccountsService(
      prisma as never,
      { resolveId: jest.fn().mockResolvedValue('consumer_1') } as never,
      {
        tierFor: () => 'testnet',
        matcherAddress: () => '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
      } as never,
      reader as never,
    );
    const account = await service.get(CONSUMER, 'acc0');
    expect(account.networks).toEqual([
      {
        network: 'base',
        balances: [
          {
            symbol: 'USDC',
            token: USDC,
            decimals: 6,
            amount: '1000',
            locked: '170',
          },
        ],
        matcher: { maxPerOrder: '500', autoSettle: false },
        operators: { '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65': 2 },
      },
    ]);
    // Only this tier's open orders, as seller, or accepted bonds as buyer.
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      tier: 'testnet',
      OR: [
        { sellerAddress: ADDRESS },
        { buyerAddress: ADDRESS, bond: { not: '0' } },
      ],
    });
  });
});
