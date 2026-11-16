import type { PaymentDeposit } from '@generated/prisma/client';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { PaymentDepositsService } from '@/payment-intents/payment-deposits.service';
import {
  PAYMENT_DEPOSIT_LOCK_CLASS,
  PAYMENT_DEPOSIT_MAX_OPEN_PER_CLIENT,
  PAYMENT_DEPOSIT_MAX_OPEN_PER_LINK,
} from '@/payment-intents/payment-intents.constants';

const MERCHANT = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const PAYER = 'TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy';
const CLIENT_A = '203.0.113.7';
const CLIENT_B = '2001:db8:1:2::5';
const ORIGIN = {
  chain: 'tron',
  chainName: 'Tron',
  symbol: 'USDT',
  assetId: 'nep141:tron-usdt.omft.near',
  decimals: 6,
  contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  priceUsd: 1,
};
const DESTINATION = {
  chain: 'base',
  chainName: 'Base',
  symbol: 'USDC',
  assetId: 'nep141:base-usdc.omft.near',
  decimals: 6,
  contract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  priceUsd: 1,
};
const REQUEST = {
  originChain: 'tron' as const,
  originAsset: 'USDT',
  refundTo: PAYER,
};
/** A distinct, valid Tron refund address per index (34 base58 characters). */
const refundTo = (i: number) =>
  `TLsV52sRDL79HXGGm9yzwKibb6Beruh${'ABCDEFGHJ'[i % 9]}${'abcdefghi'[Math.floor(i / 9) % 9]}y`;

const INTENT = {
  id: 'pi_1',
  kind: 'PAY',
  chain: 'base',
  network: 'public',
  status: 'PENDING',
  destination: MERCHANT,
  chainReference: null,
  amount: '25',
  asset: 'USDC',
  assetIssuer: DESTINATION.contract,
  merchantFee: null,
  crossChainFeeBps: 50,
  expiresAt: new Date(Date.now() + 3_600_000),
};

function stored(overrides: Partial<PaymentDeposit> = {}): PaymentDeposit {
  return {
    id: 'dep_1',
    intentId: 'pi_1',
    network: 'public',
    status: 'AWAITING_DEPOSIT',
    providerStatus: 'PENDING_DEPOSIT',
    originChain: 'tron',
    originAsset: 'USDT',
    originAssetId: ORIGIN.assetId,
    originContract: ORIGIN.contract,
    originDecimals: 6,
    destinationChain: 'base',
    destinationAsset: 'USDC',
    destinationAssetId: DESTINATION.assetId,
    destinationContract: DESTINATION.contract,
    destinationDecimals: 6,
    amountIn: '25.284231',
    minAmountIn: '25.031458',
    amountOut: '25',
    feeBps: 50,
    feeAmount: '0.126421',
    slippageBps: 100,
    recipient: MERCHANT,
    refundTo: PAYER,
    clientKey: 'k',
    depositAddress: 'TXk4mWpuXSbT4F7wC6S5K3aA2CKUZPqT3a',
    depositMemo: null,
    depositUri: null,
    amountOutPaid: null,
    refundedAmount: null,
    originTxHashes: null,
    destinationTxHashes: null,
    timeEstimateSeconds: 82,
    correlationId: 'corr',
    quoteSignature: 'sig',
    quote: {},
    expiresAt: new Date(Date.now() + 30 * 60_000),
    lastCheckedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Whether a row matches the `where` the service sends: the operators it uses
 * (`in`, `gt`, `gte`, `lte`) over plain columns.
 */
function matches(row: Record<string, any>, where: Record<string, any>) {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond && !cond.in.includes(value)) return false;
      if ('gt' in cond && !(value > cond.gt)) return false;
      if ('gte' in cond && !(value >= cond.gte)) return false;
      if ('lte' in cond && !(value <= cond.lte)) return false;
      return true;
    }
    return value === cond;
  });
}

/**
 * The service over in-memory tables. `$transaction` runs one callback at a
 * time, as the link's advisory lock makes Postgres do for one intent, and the
 * live quote waits `quoteMs`, so concurrent creates all start before any of
 * them could insert.
 */
function build(
  intent: unknown = INTENT,
  deposits: PaymentDeposit[] = [],
  quoteMs = 0,
) {
  const tables = {
    deposits: [...deposits],
    reservations: [] as {
      id: string;
      intentId: string;
      clientKey: string;
      expiresAt: Date;
    }[],
  };
  let seq = 0;
  let lockChain: Promise<unknown> = Promise.resolve();
  const locks: unknown[][] = [];
  const paymentDeposit = {
    findFirst: jest.fn(({ where }: any) =>
      Promise.resolve(
        [...tables.deposits].reverse().find((d) => matches(d, where)) ?? null,
      ),
    ),
    findMany: jest.fn(({ where }: any) =>
      Promise.resolve(tables.deposits.filter((d) => matches(d, where))),
    ),
    count: jest.fn(({ where }: any) =>
      Promise.resolve(tables.deposits.filter((d) => matches(d, where)).length),
    ),
    create: jest.fn(({ data }: any) => {
      const row = stored({ ...data, id: `dep_${++seq}` });
      tables.deposits.push(row);
      return Promise.resolve(row);
    }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findUniqueOrThrow: jest.fn(({ where }: any) =>
      Promise.resolve(tables.deposits.find((d) => d.id === where.id)),
    ),
  };
  const paymentDepositReservation = {
    count: jest.fn(({ where }: any) =>
      Promise.resolve(
        tables.reservations.filter((r) => matches(r, where)).length,
      ),
    ),
    create: jest.fn(({ data }: any) => {
      const row = { ...data, id: `slot_${++seq}` };
      tables.reservations.push(row);
      return Promise.resolve({ id: row.id });
    }),
    deleteMany: jest.fn(({ where }: any) => {
      const before = tables.reservations.length;
      tables.reservations = tables.reservations.filter(
        (r) => !matches(r, where),
      );
      return Promise.resolve({ count: before - tables.reservations.length });
    }),
  };
  const prisma: any = {
    paymentIntent: { findUnique: jest.fn().mockResolvedValue(intent) },
    paymentDeposit,
    paymentDepositReservation,
    $transaction: jest.fn((work: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        paymentDeposit,
        paymentDepositReservation,
        $executeRaw: jest.fn(
          (strings: TemplateStringsArray, ...values: unknown[]) => {
            locks.push([strings.join('?'), ...values]);
            return Promise.resolve(1);
          },
        ),
      };
      const run = lockChain.then(() => work(tx));
      lockChain = run.catch(() => undefined);
      return run;
    }),
  };
  const pricing = {
    originAsset: jest.fn().mockResolvedValue(ORIGIN),
    payableAssets: jest.fn().mockResolvedValue([ORIGIN, DESTINATION]),
    price: jest.fn().mockImplementation(async (_intent, request, live) => {
      if (quoteMs) await new Promise((r) => setTimeout(r, quoteMs));
      return {
        origin: ORIGIN,
        destination: DESTINATION,
        amountIn: '25.284231',
        minAmountIn: '25.031458',
        amountOut: '25',
        feeBps: 50,
        feeAmount: '0.126421',
        slippageBps: 100,
        recipient: MERCHANT,
        refundTo: request.refundTo,
        request: { deadline: '2026-11-16T15:30:00.000Z' },
        response: {
          correlationId: 'corr',
          signature: 'sig',
          quote: {
            amountInUsd: '25.27',
            amountOutUsd: '24.99',
            timeEstimate: 82,
            ...(live
              ? {
                  depositAddress: `TDeposit${++seq}`,
                  deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
                }
              : {}),
          },
        },
      };
    }),
  };
  const paymentIntents = {
    assertOwned: jest.fn().mockResolvedValue('base'),
    settleFromDeposit: jest.fn().mockResolvedValue({}),
  };
  const accounts = { load: jest.fn(), assertCanReceive: jest.fn() };
  const values: Record<string, unknown> = {
    apisix: { gatewaySecret: 'a-gateway-secret-for-the-spec-only' },
    nearIntents: { timeoutMs: 20_000 },
  };
  const config = { get: (key: string) => values[key] } as never;
  const service = new PaymentDepositsService(
    config,
    prisma,
    pricing as never,
    paymentIntents as never,
    accounts as never,
  );
  return { service, prisma, tables, locks, pricing, paymentIntents, accounts };
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('PaymentDepositsService', () => {
  describe('which links take a payment from another network', () => {
    it('is the 404 of a missing intent for an unknown id', async () => {
      const { service } = build(null);
      expect((await refusal(service.assets('nope'))).code).toBe(
        ApiErrorCode.NotFound,
      );
    });

    it('refuses a link that cannot be paid from another network, naming why', async () => {
      const { service, pricing } = build({ ...INTENT, amount: null });
      const err = await refusal(service.quote('pi_1', REQUEST));
      expect(err.code).toBe(ApiErrorCode.ValidationFailed);
      expect(err.message).toMatch(/no fixed amount/);
      expect(pricing.price).not.toHaveBeenCalled();
    });

    it('lists the assets for a payable link, open or not', async () => {
      const { service } = build({ ...INTENT, status: 'SUCCEEDED' });
      await expect(service.assets('pi_1')).resolves.toEqual({
        data: [ORIGIN, DESTINATION],
      });
    });

    it('quotes and opens deposits only while the link is open', async () => {
      for (const intent of [
        { ...INTENT, status: 'SUCCEEDED' },
        { ...INTENT, expiresAt: new Date(Date.now() - 1000) },
      ]) {
        const { service } = build(intent);
        expect((await refusal(service.quote('pi_1', REQUEST))).code).toBe(
          ApiErrorCode.InvalidStateTransition,
        );
        expect(
          (await refusal(service.create('pi_1', REQUEST, CLIENT_A))).code,
        ).toBe(ApiErrorCode.InvalidStateTransition);
      }
    });
  });

  it('answers a dry quote as the payer reads it', async () => {
    const { service, pricing } = build();
    const quote = await service.quote('pi_1', REQUEST);
    expect(pricing.price.mock.calls[0][2]).toBe(false);
    expect(quote).toEqual({
      origin: {
        chain: 'tron',
        asset: 'USDT',
        assetId: ORIGIN.assetId,
        contract: ORIGIN.contract,
        amount: '25.284231',
        minimum: '25.031458',
        amountUsd: '25.27',
      },
      destination: {
        chain: 'base',
        asset: 'USDC',
        contract: DESTINATION.contract,
        amount: '25',
        amountUsd: '24.99',
      },
      fee: { bps: 50, amount: '0.126421', asset: 'USDT' },
      timeEstimateSeconds: 82,
    });
  });

  describe('create', () => {
    it('stores a live quote as a deposit of this link, keyed to its client, and releases the slot', async () => {
      const { service, prisma, tables, locks } = build();
      const deposit = await service.create('pi_1', REQUEST, CLIENT_A);

      const data = prisma.paymentDeposit.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        intentId: 'pi_1',
        network: 'public',
        status: 'AWAITING_DEPOSIT',
        originChain: 'tron',
        destinationChain: 'base',
        amountOut: '25',
        recipient: MERCHANT,
        refundTo: PAYER,
      });
      // The client is stored as a MAC, never as its address.
      expect(data.clientKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(data.clientKey).not.toContain('203');
      expect(deposit).toMatchObject({ paymentLinkId: 'pi_1' });
      expect(deposit.qr).toMatch(/^data:image\/png;base64,/);
      expect(JSON.stringify(deposit)).not.toContain('clientKey');
      // The slot was taken under the link's lock and is released.
      expect(locks[0]).toEqual([
        expect.stringContaining('pg_advisory_xact_lock(?::int, hashtext(?))'),
        PAYMENT_DEPOSIT_LOCK_CLASS,
        'pi_1',
      ]);
      expect(tables.reservations).toEqual([]);
    });

    it('answers the open deposit again for the same asset and refund address, from any client', async () => {
      const { service, prisma, pricing } = build(INTENT, [stored()]);
      const deposit = await service.create('pi_1', REQUEST, CLIENT_B);
      expect(deposit.id).toBe('dep_1');
      expect(pricing.price).not.toHaveBeenCalled();
      expect(prisma.paymentDeposit.create).not.toHaveBeenCalled();
    });

    it(`keeps a client to ${PAYMENT_DEPOSIT_MAX_OPEN_PER_CLIENT} open deposits on a link, even when its requests race`, async () => {
      const { service, tables, pricing } = build(INTENT, [], 20);
      const attempts = 6;

      const results = await Promise.allSettled(
        Array.from({ length: attempts }, (_, i) =>
          service.create(
            'pi_1',
            { ...REQUEST, refundTo: refundTo(i) },
            CLIENT_A,
          ),
        ),
      );

      const opened = results.filter((r) => r.status === 'fulfilled');
      const refused = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(opened).toHaveLength(PAYMENT_DEPOSIT_MAX_OPEN_PER_CLIENT);
      expect(tables.deposits).toHaveLength(PAYMENT_DEPOSIT_MAX_OPEN_PER_CLIENT);
      for (const r of refused) {
        expect(r.reason).toBeInstanceOf(ApiError);
        expect((r.reason as ApiError).code).toBe(
          ApiErrorCode.OperationInFlight,
        );
      }
      // The refused ones never reached the cross-chain route.
      expect(pricing.price).toHaveBeenCalledTimes(
        PAYMENT_DEPOSIT_MAX_OPEN_PER_CLIENT,
      );
      expect(tables.reservations).toEqual([]);
    });

    it('lets another client open a deposit while one client has used all of its own', async () => {
      const { service, tables } = build(INTENT, [], 5);
      await Promise.allSettled(
        Array.from({ length: 4 }, (_, i) =>
          service.create(
            'pi_1',
            { ...REQUEST, refundTo: refundTo(i) },
            CLIENT_A,
          ),
        ),
      );
      expect(
        (
          await refusal(
            service.create(
              'pi_1',
              { ...REQUEST, refundTo: refundTo(7) },
              CLIENT_A,
            ),
          )
        ).code,
      ).toBe(ApiErrorCode.OperationInFlight);

      const theirs = await service.create(
        'pi_1',
        { ...REQUEST, refundTo: refundTo(8) },
        CLIENT_B,
      );
      expect(theirs.refundTo).toBe(refundTo(8));
      expect(tables.deposits).toHaveLength(
        PAYMENT_DEPOSIT_MAX_OPEN_PER_CLIENT + 1,
      );
    });

    it(`opens at most ${PAYMENT_DEPOSIT_MAX_OPEN_PER_LINK} on one link from any number of clients, racing or not`, async () => {
      const { service, tables, pricing } = build(INTENT, [], 10);
      const clients = PAYMENT_DEPOSIT_MAX_OPEN_PER_LINK + 6;

      const results = await Promise.allSettled(
        Array.from({ length: clients }, (_, i) =>
          service.create(
            'pi_1',
            { ...REQUEST, refundTo: refundTo(i) },
            `198.51.100.${i + 1}`,
          ),
        ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(
        PAYMENT_DEPOSIT_MAX_OPEN_PER_LINK,
      );
      expect(tables.deposits).toHaveLength(PAYMENT_DEPOSIT_MAX_OPEN_PER_LINK);
      expect(pricing.price).toHaveBeenCalledTimes(
        PAYMENT_DEPOSIT_MAX_OPEN_PER_LINK,
      );
      const refused = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(refused).toHaveLength(6);
      for (const r of refused) {
        expect((r.reason as ApiError).code).toBe(
          ApiErrorCode.OperationInFlight,
        );
        expect((r.reason as ApiError).message).toMatch(/This payment link has/);
      }
    });

    it('counts IPv6 callers in one /48 as one client, and another /48 as another', async () => {
      const { service, tables } = build();
      await service.create(
        'pi_1',
        { ...REQUEST, refundTo: refundTo(1) },
        '2001:db8:1:2::5',
      );
      // Another /64 of the same /48: rotating /64s buys nothing.
      await service.create(
        'pi_1',
        { ...REQUEST, refundTo: refundTo(2) },
        '2001:db8:1:ffff::9',
      );
      const err = await refusal(
        service.create(
          'pi_1',
          { ...REQUEST, refundTo: refundTo(3) },
          '2001:0db8:0001:0abc:1:2:3:4',
        ),
      );
      expect(err.code).toBe(ApiErrorCode.OperationInFlight);
      expect(err.message).toMatch(/You already have/);

      await service.create(
        'pi_1',
        { ...REQUEST, refundTo: refundTo(4) },
        '2001:db8:2::1',
      );
      expect(tables.deposits).toHaveLength(3);
      expect(new Set(tables.deposits.map((d) => d.clientKey)).size).toBe(2);
    });

    it('frees a client slot again once a deposit expires', async () => {
      const { service, tables } = build();
      const clientKey =
        (await service.create('pi_1', REQUEST, CLIENT_A)) &&
        tables.deposits[0].clientKey;
      tables.deposits.push(
        stored({
          id: 'old',
          clientKey,
          expiresAt: new Date(Date.now() - 1000),
        }),
      );
      await service.create(
        'pi_1',
        { ...REQUEST, refundTo: refundTo(1) },
        CLIENT_A,
      );
      expect(tables.deposits.filter((d) => d.id !== 'old')).toHaveLength(2);
    });

    it('releases the slot when the quote fails, so the client can try again', async () => {
      const { service, pricing, tables } = build();
      pricing.price.mockRejectedValueOnce(
        ApiError.badRequest(ApiErrorCode.ProviderError, 'refused'),
      );
      pricing.price.mockRejectedValueOnce(
        ApiError.badRequest(ApiErrorCode.ProviderError, 'refused'),
      );
      for (let i = 0; i < 2; i++) {
        expect(
          (await refusal(service.create('pi_1', REQUEST, CLIENT_A))).code,
        ).toBe(ApiErrorCode.ProviderError);
      }
      expect(tables.reservations).toEqual([]);
      await expect(
        service.create('pi_1', REQUEST, CLIENT_A),
      ).resolves.toBeDefined();
    });

    it('sweeps a slot whose process died before counting', async () => {
      const { service, tables } = build();
      tables.reservations.push({
        id: 'stale_1',
        intentId: 'pi_1',
        clientKey: 'whatever',
        expiresAt: new Date(Date.now() - 1),
      });
      await service.create('pi_1', REQUEST, CLIENT_A);
      expect(tables.reservations).toEqual([]);
    });

    it('checks a Stellar merchant trusts the asset before handing out an address', async () => {
      const { service, pricing, accounts, tables } = build();
      pricing.price.mockImplementationOnce(() =>
        Promise.resolve({
          origin: ORIGIN,
          destination: {
            ...DESTINATION,
            chain: 'stellar',
            contract:
              'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
          },
          recipient: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
          request: { deadline: new Date().toISOString() },
          response: { quote: { depositAddress: 'TX' } },
        }),
      );
      accounts.load.mockResolvedValue({ balances: [] });
      accounts.assertCanReceive.mockImplementation(() => {
        throw ApiError.badRequest(
          ApiErrorCode.TrustlineMissing,
          'no trustline',
        );
      });
      const err = await refusal(service.create('pi_1', REQUEST, CLIENT_A));
      expect(err.code).toBe(ApiErrorCode.TrustlineMissing);
      expect(tables.deposits).toEqual([]);
      expect(tables.reservations).toEqual([]);
    });
  });

  it('reads a deposit only through its own link', async () => {
    const { service, prisma } = build(INTENT, [stored()]);
    expect((await refusal(service.findPublic('pi_other', 'dep_1'))).code).toBe(
      ApiErrorCode.NotFound,
    );
    expect(prisma.paymentDeposit.findFirst).toHaveBeenCalledWith({
      where: { id: 'dep_1', intentId: 'pi_other' },
    });
  });

  it("lists an owner's deposits only after checking the intent is theirs", async () => {
    const { service, prisma, paymentIntents } = build();
    paymentIntents.assertOwned.mockRejectedValueOnce(
      ApiError.notFound('Payment intent pi_1 not found'),
    );
    await expect(service.listForOwner({} as never, 'pi_1')).rejects.toThrow(
      ApiError,
    );
    expect(prisma.paymentDeposit.findMany).not.toHaveBeenCalled();
  });

  describe('applyProviderStatus', () => {
    it('follows the route and settles the link when the merchant is paid', async () => {
      const paid = stored({
        status: 'SUCCEEDED',
        amountOutPaid: '25',
        destinationTxHashes: [
          { hash: '0xPAYOUT', explorerUrl: 'https://basescan.org/tx/0xpayout' },
        ],
      });
      const { service, prisma, paymentIntents } = build(INTENT, [paid]);

      await service.applyProviderStatus(stored({ status: 'PROCESSING' }), {
        correlationId: 'corr',
        status: 'SUCCESS',
        updatedAt: '',
        swapDetails: {
          amountOut: '25000000',
          amountOutFormatted: '25',
          originChainTxHashes: [],
          destinationChainTxHashes: [
            {
              hash: '0xPAYOUT',
              explorerUrl: 'https://basescan.org/tx/0xpayout',
            },
          ],
        },
      });

      expect(prisma.paymentDeposit.updateMany).toHaveBeenCalledWith({
        where: { id: 'dep_1', status: 'PROCESSING' },
        data: expect.objectContaining({
          status: 'SUCCEEDED',
          amountOutPaid: '25',
          providerStatus: 'SUCCESS',
        }),
      });
      expect(paymentIntents.settleFromDeposit).toHaveBeenCalledWith(
        'pi_1',
        '0xPAYOUT',
        expect.objectContaining({ depositId: 'dep_1', chain: 'tron' }),
      );
    });

    it('does not settle on a payout below the link amount', async () => {
      const short = stored({
        status: 'SUCCEEDED',
        amountOutPaid: '24',
        destinationTxHashes: [{ hash: '0x1', explorerUrl: 'https://x' }],
      });
      const { service, paymentIntents } = build(INTENT, [short]);
      await service.applyProviderStatus(stored({ status: 'PROCESSING' }), {
        correlationId: 'corr',
        status: 'SUCCESS',
        updatedAt: '',
      });
      expect(paymentIntents.settleFromDeposit).not.toHaveBeenCalled();
    });

    it('expires a deposit nobody paid once its deadline passes', async () => {
      const lapsed = stored({ expiresAt: new Date(Date.now() - 1000) });
      const { service, prisma } = build(INTENT, [
        { ...lapsed, status: 'EXPIRED' },
      ]);
      await service.applyProviderStatus(lapsed, null);
      expect(
        prisma.paymentDeposit.updateMany.mock.calls[0][0].data,
      ).toMatchObject({ status: 'EXPIRED' });
    });
  });
});
