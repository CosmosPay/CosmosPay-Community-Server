import { ConfigService } from '@nestjs/config';
import { ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { PublicRecordTokens } from '@/common/public-record-token';
import type { EldoradoClient } from '@/native-plugins/eldorado/eldorado.client';
import { P2pPaymentRequestsService } from '@/native-plugins/eldorado/p2p-payment-requests.service';
import { P2pRampService } from '@/native-plugins/eldorado/p2p-ramp.service';
import {
  PaymentRequestRails,
  type PaymentRequestRail,
} from '@/payment-request-rails/payment-request-rails';

const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
const USDT0 = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
const CHECKOUT = 'https://payments.cosmospay.lat';

const key = (
  username: string,
  environment: 'prod' | 'dev' = 'prod',
): GatewayConsumer => ({
  username,
  credentialId: null,
  environment,
  role: 'user',
  permissions: ['onramp:read', 'onramp:write'],
  organizationId: null,
  plan: null,
  planSwapFeeBps: null,
});
const seller = key('cosmos_seller');
const publicKey: GatewayConsumer = {
  ...key('cosmos_public'),
  role: 'public',
};

const INPUT = {
  currency: 'ARS',
  amount: '16000',
  chainId: 42161,
  token: USDT0.toLowerCase(),
  address: ADDRESS.toLowerCase(),
  description: 'Table 4',
};

type Row = Record<string, unknown>;

/** Stops the clock at `iso` for `Date` alone: promises, timers and the QR encoder run as usual. */
function freezeDate(iso: string) {
  jest.useFakeTimers({
    now: new Date(iso),
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
}

/**
 * A table in memory with the few filters these services write: equality,
 * `null`, and `{ gt }` on a date. Each statement runs whole, as Postgres would.
 */
function table(prefix: string, defaults: Row = {}) {
  const rows: Row[] = [];
  const matches = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([field, want]) => {
      if (want && typeof want === 'object' && 'gt' in want) {
        return (row[field] as Date) > (want as { gt: Date }).gt;
      }
      return row[field] === want;
    });
  const newestFirst = (a: Row, b: Row) =>
    (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime();
  return {
    rows,
    create: jest.fn(({ data }: { data: Row }) => {
      const row = {
        id: `${prefix}${rows.length + 1}`,
        createdAt: new Date(Date.now() + rows.length),
        ...defaults,
        ...data,
      };
      rows.push(row);
      return Promise.resolve({ ...row });
    }),
    findMany: jest.fn(
      ({ where, take, skip }: { where: Row; take: number; skip: number }) =>
        Promise.resolve(
          rows
            .filter((r) => matches(r, where))
            .sort(newestFirst)
            .slice(skip, skip + take)
            .map((r) => ({ ...r })),
        ),
    ),
    count: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(rows.filter((r) => matches(r, where)).length),
    ),
    findFirst: jest.fn(({ where }: { where: Row }) => {
      const row = rows.find((r) => matches(r, where));
      return Promise.resolve(row ? { ...row } : null);
    }),
    findUnique: jest.fn(({ where }: { where: Row; select?: Row }) => {
      const row = rows.find((r) => r.id === where.id);
      return Promise.resolve(row ? { ...row } : null);
    }),
    updateMany: jest.fn(({ where, data }: { where: Row; data: Row }) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return Promise.resolve({ count: hit.length });
    }),
  };
}

function marketClient() {
  return {
    currencies: jest.fn().mockResolvedValue({
      currencies: [
        { id: 'ARS', type: 'FIAT', description: { en: 'Argentine Pesos' } },
      ],
    }),
    paymentMethods: jest.fn().mockResolvedValue({
      paymentMethods: [
        { id: 'bank_tx_ar', name: 'CVU/CBU o Alias (ARS)', currency: 'ARS' },
      ],
    }),
    prices: jest.fn().mockResolvedValue({
      BUY: { ARS: { price: '1600', limits: { in: { min: '8000' } } } },
    }),
    chains: jest.fn().mockResolvedValue({ chains: ['42161'] }),
    tokens: jest.fn().mockResolvedValue({
      tokens: [{ address: USDT0, symbol: 'USDT0', decimals: 6, priceUSD: '1' }],
    }),
    integratorIds: jest.fn((shared: boolean) => ({
      clientId: 'client-1',
      referralId: shared ? 'r-public' : 'r-1',
    })),
  };
}

/** A bank transfer rail that takes ARS at or above 1000, delivering the listed token. */
function transferRail() {
  const accepts = jest.fn(
    (
      terms: { currency: string; amount: string },
      listed: { symbol: string; decimals: number } | null,
    ): Promise<{ symbol: string; decimals: number } | null> =>
      Promise.resolve(
        terms.currency === 'ARS' && Number(terms.amount) >= 1000
          ? (listed ?? { symbol: 'USDT', decimals: 6 })
          : null,
      ),
  );
  const rail: PaymentRequestRail = { method: 'transfer', accepts };
  return { rail, accepts };
}

/** The settings that switch the direct flow on. */
const DIRECT_ON = {
  clientId: 'client-1',
  apiReferralId: 'r-api',
  directSessionSecret: Buffer.alloc(32, 7).toString('base64'),
};

function setup(options: { rail?: boolean; direct?: boolean } = {}) {
  const client = marketClient();
  const rails = new PaymentRequestRails();
  const transfer = transferRail();
  if (options.rail) rails.registerRail(transfer.rail);
  const prisma = {
    p2pPaymentRequest: table('creq', {
      status: 'open',
      paidAt: null,
      paidAmount: null,
      paidTxHash: null,
      paidSessionId: null,
      cancelledAt: null,
      sharedPublicKey: false,
    }),
    p2pRampSession: table('csess', { providerStatus: null }),
  };
  const consumers = {
    resolve: jest.fn((c: GatewayConsumer) =>
      Promise.resolve({ id: `c_${c.username}` }),
    ),
    resolveId: jest.fn((c: GatewayConsumer) =>
      Promise.resolve(`c_${c.username}`),
    ),
  };
  const config = {
    get: jest.fn((name: string) =>
      name === 'apisix'
        ? {
            publicConsumer: 'cosmos_public',
            gatewaySecret: 'topsecret-topsecret-topsecret-topsecret',
          }
        : name === 'paymentIntents'
          ? { checkoutUrl: CHECKOUT }
          : name === 'eldorado' && options.direct
            ? DIRECT_ON
            : { network: 'testnet' },
    ),
  } as unknown as ConfigService;
  const recordTokens = new PublicRecordTokens(config as never);
  const ramp = new P2pRampService(
    config as never,
    prisma as never,
    consumers as never,
    client as unknown as EldoradoClient,
    recordTokens,
  );
  const service = new P2pPaymentRequestsService(
    config as never,
    prisma as never,
    consumers as never,
    ramp,
    recordTokens,
    rails,
  );
  return {
    service,
    client,
    prisma,
    consumers,
    recordTokens,
    accepts: transfer.accepts,
  };
}

describe('P2pPaymentRequestsService', () => {
  afterEach(() => jest.useRealTimers());

  describe('creating', () => {
    it('checks the terms against the live market and stores the charge', async () => {
      freezeDate('2026-11-12T12:00:00.000Z');
      const { service, prisma } = setup();

      const created = await service.create(seller, INPUT);

      expect(prisma.p2pPaymentRequest.rows[0]).toMatchObject({
        consumerId: 'c_cosmos_seller',
        network: 'public',
        sharedPublicKey: false,
        currency: 'ARS',
        amount: '16000',
        chainId: 42161,
        token: 'USDT0',
        // EIP-55, however the caller spelled them.
        tokenAddress: USDT0,
        tokenDecimals: 6,
        address: ADDRESS,
        description: 'Table 4',
        status: 'open',
        methods: ['p2p'],
      });
      expect(created).toMatchObject({
        id: 'creq1',
        network: 'public',
        status: 'open',
        token: 'USDT0',
        tokenAddress: USDT0,
        tokenDecimals: 6,
        address: ADDRESS,
        // 16000 / 1600 / 1
        estimatedAmountOut: '10.00',
        url: `${CHECKOUT}/fiat/creq1`,
        // A day by default.
        expiresAt: '2026-11-13T12:00:00.000Z',
        paidAt: null,
        paidAmount: null,
        paidTxHash: null,
        paidMethod: null,
        methods: ['p2p'],
      });
      expect(created.qr).toMatch(/^data:image\/png;base64,/);
      expect(created).not.toHaveProperty('publicToken');
    });

    it('takes the lifetime it is given', async () => {
      freezeDate('2026-11-12T12:00:00.000Z');
      const { service } = setup();

      const created = await service.create(seller, {
        ...INPUT,
        expiresInMinutes: 5,
      });

      expect(created.expiresAt).toBe('2026-11-12T12:05:00.000Z');
    });

    it('refuses terms the market does not take, before storing anything', async () => {
      const { service, prisma } = setup();

      for (const [change, message] of [
        [{ amount: '7999.99' }, 'amount is below the minimum of 8000 ARS'],
        [
          { amount: '16000.001' },
          'amount is local money: at most two decimals',
        ],
        [{ currency: 'BRL' }, 'currency BRL cannot be bought (offered: ARS)'],
        [{ chainId: 1 }, 'chainId 1 is not offered (offered: 42161)'],
      ] as const) {
        await expect(
          service.create(seller, { ...INPUT, ...change }),
        ).rejects.toMatchObject({
          code: ApiErrorCode.ValidationFailed,
          message,
        });
      }
      expect(prisma.p2pPaymentRequest.create).not.toHaveBeenCalled();
    });
  });

  describe('other rails', () => {
    it('stores and answers the bank transfer first when its rail takes the terms', async () => {
      const { service, prisma, accepts } = setup({ rail: true });

      const created = await service.create(seller, INPUT);

      expect(created.methods).toEqual(['transfer', 'p2p']);
      expect(prisma.p2pPaymentRequest.rows[0].methods).toEqual([
        'transfer',
        'p2p',
      ]);
      // The rail is told who owns the request and what the market lists.
      expect(accepts).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: 'c_cosmos_seller',
          network: 'public',
          currency: 'ARS',
          amount: '16000',
        }),
        { symbol: 'USDT0', decimals: 6 },
      );
    });

    it('creates a request only the bank transfer can pay, keeping the market token and estimate', async () => {
      const { service, prisma } = setup({ rail: true });

      // Under the market's 8000 minimum, over the rail's 1000.
      const created = await service.create(seller, {
        ...INPUT,
        amount: '5000',
      });

      expect(created).toMatchObject({
        methods: ['transfer'],
        token: 'USDT0',
        tokenAddress: USDT0,
        tokenDecimals: 6,
        // 5000 / 1600 / 1
        estimatedAmountOut: '3.12',
      });
      expect(prisma.p2pPaymentRequest.rows[0].currency).toBe('ARS');
    });

    it('keeps the market refusal when no rail takes the terms', async () => {
      const { service, prisma } = setup({ rail: true });

      await expect(
        service.create(seller, { ...INPUT, amount: '999' }),
      ).rejects.toMatchObject({
        code: ApiErrorCode.ValidationFailed,
        message: 'amount is below the minimum of 8000 ARS',
      });
      expect(prisma.p2pPaymentRequest.create).not.toHaveBeenCalled();
    });

    it('asks the rail again on every read: switched off, the transfer is gone', async () => {
      const { service, accepts } = setup({ rail: true });
      const created = await service.create(seller, INPUT);

      accepts.mockResolvedValue(null);

      await expect(service.findOne(seller, created.id)).resolves.toMatchObject({
        methods: ['p2p'],
      });
      await expect(service.findPublic(created.id)).resolves.toMatchObject({
        methods: ['p2p'],
      });
    });

    it('reads a processing request as such, refuses to cancel it, and says how a paid one was paid', async () => {
      const { service, prisma } = setup();
      const created = await service.create(seller, INPUT);
      const row = prisma.p2pPaymentRequest.rows[0];

      Object.assign(row, {
        status: 'processing',
        expiresAt: new Date(Date.now() - 1),
      });
      await expect(service.findOne(seller, created.id)).resolves.toMatchObject({
        status: 'processing',
      });
      await expect(service.cancel(seller, created.id)).rejects.toMatchObject({
        code: ApiErrorCode.RequestClosed,
        message: `Payment request ${created.id} is processing: only an open one can be cancelled`,
      });
      await expect(
        service.openPayerSession(created.id, 'bank_tx_ar'),
      ).rejects.toMatchObject({ code: ApiErrorCode.RequestClosed });

      Object.assign(row, {
        status: 'paid',
        paidAt: new Date(),
        paidAmount: '9.5',
        paidMethod: 'transfer',
      });
      await expect(service.findOne(seller, created.id)).resolves.toMatchObject({
        status: 'paid',
        paidAmount: '9.5',
        paidMethod: 'transfer',
      });
    });

    it('keeps the stored p2p when the market cannot be read, and the payer never sees the owner', async () => {
      const { service, prisma, client } = setup({ rail: true });
      const created = await service.create(seller, INPUT);
      client.currencies.mockRejectedValue(new Error('the market is down'));
      prisma.p2pPaymentRequest.findUnique.mockClear();

      const view = await service.findPublic(created.id);

      expect(view.methods).toEqual(['transfer', 'p2p']);
      expect(JSON.stringify(view)).not.toContain('c_cosmos_seller');
      // The owner is read apart from the payer's projection, for the rails only.
      const selects = prisma.p2pPaymentRequest.findUnique.mock.calls.map(
        ([args]) => (args as { select: Row }).select,
      );
      expect(selects[0]).not.toHaveProperty('consumerId');
      expect(selects[1]).toEqual({ consumerId: true });
    });

    it('drops p2p for the payer when the live market no longer takes the amount', async () => {
      const { service, prisma } = setup({ rail: true });
      const created = await service.create(seller, INPUT);
      // Now under the market's 8000 minimum, still over the rail's 1000.
      prisma.p2pPaymentRequest.rows[0].amount = '7000';

      await expect(service.findPublic(created.id)).resolves.toMatchObject({
        methods: ['transfer'],
      });
    });
  });

  describe('ownership', () => {
    it('reads and cancels only the consumer’s own requests on the key’s network', async () => {
      const { service } = setup();
      const created = await service.create(seller, INPUT);

      await expect(service.findOne(seller, created.id)).resolves.toMatchObject({
        id: created.id,
      });
      for (const caller of [
        key('cosmos_mallory'),
        // The same account's sandbox key reaches only test-network rows.
        key('cosmos_seller', 'dev'),
      ]) {
        await expect(service.findOne(caller, created.id)).rejects.toMatchObject(
          {
            code: ApiErrorCode.NotFound,
            message: 'Payment request not found',
          },
        );
        await expect(service.cancel(caller, created.id)).rejects.toMatchObject({
          code: ApiErrorCode.NotFound,
        });
      }
      await expect(service.findOne(seller, created.id)).resolves.toMatchObject({
        status: 'open',
      });
    });

    it('lists the consumer’s requests on the key’s network, newest first', async () => {
      const { service } = setup();
      await service.create(seller, INPUT);
      await service.create(seller, { ...INPUT, amount: '20000' });
      await service.create(key('cosmos_mallory'), INPUT);

      const listed = await service.findAll(seller, { take: 100, skip: 0 });

      expect(listed.total).toBe(2);
      expect(listed.data.map((r) => r.amount)).toEqual(['20000', '16000']);
    });

    it('gives the shared public key a record token, and reads back only with it', async () => {
      const { service, prisma, recordTokens } = setup();
      const created = await service.create(publicKey, INPUT);
      const otherToken = recordTokens.issueFor(
        publicKey,
        'p2p-payment-request',
        'creq2',
      );

      expect(created.publicToken).toEqual(expect.any(String));
      expect(prisma.p2pPaymentRequest.rows[0].sharedPublicKey).toBe(true);
      prisma.p2pPaymentRequest.findFirst.mockClear();
      for (const token of [undefined, 'not-a-token', otherToken]) {
        await expect(
          service.findOne(publicKey, created.id, token),
        ).rejects.toMatchObject({ code: ApiErrorCode.NotFound });
        await expect(
          service.cancel(publicKey, created.id, token),
        ).rejects.toMatchObject({ code: ApiErrorCode.NotFound });
      }
      // Refused before the table is read.
      expect(prisma.p2pPaymentRequest.findFirst).not.toHaveBeenCalled();
      expect(prisma.p2pPaymentRequest.updateMany).not.toHaveBeenCalled();

      const read = await service.findOne(
        publicKey,
        created.id,
        created.publicToken,
      );
      expect(read.id).toBe(created.id);
      expect(read).not.toHaveProperty('publicToken');
    });
  });

  describe('cancelling', () => {
    it('cancels an open request once, then answers 409 request_closed', async () => {
      const { service } = setup();
      const created = await service.create(seller, INPUT);

      await expect(service.cancel(seller, created.id)).resolves.toMatchObject({
        status: 'cancelled',
      });
      await expect(service.cancel(seller, created.id)).rejects.toMatchObject({
        code: ApiErrorCode.RequestClosed,
        message: `Payment request ${created.id} is cancelled: only an open one can be cancelled`,
      });
    });

    it('refuses to cancel an expired or paid request', async () => {
      const { service, prisma } = setup();
      const expired = await service.create(seller, INPUT);
      const paid = await service.create(seller, INPUT);
      prisma.p2pPaymentRequest.rows[0].expiresAt = new Date(Date.now() - 1);
      Object.assign(prisma.p2pPaymentRequest.rows[1], {
        status: 'paid',
        paidAt: new Date(),
      });

      await expect(service.cancel(seller, expired.id)).rejects.toMatchObject({
        code: ApiErrorCode.RequestClosed,
        message: `Payment request ${expired.id} is expired: only an open one can be cancelled`,
      });
      await expect(service.cancel(seller, paid.id)).rejects.toMatchObject({
        code: ApiErrorCode.RequestClosed,
      });
      expect(prisma.p2pPaymentRequest.rows[0].status).toBe('open');
    });
  });

  describe('the payer’s read', () => {
    it('answers only the public fields, with the live estimate and methods', async () => {
      const { service, prisma } = setup();
      const created = await service.create(seller, INPUT);

      const view = await service.findPublic(created.id);

      expect(Object.keys(view).sort()).toEqual(
        [
          'id',
          'network',
          'status',
          'currency',
          'amount',
          'description',
          'chainId',
          'token',
          'tokenAddress',
          'estimatedAmountOut',
          'paymentMethods',
          'methods',
          'p2pDirect',
          'expiresAt',
          'createdAt',
          'paidAt',
        ].sort(),
      );
      expect(view).toMatchObject({
        status: 'open',
        amount: '16000',
        estimatedAmountOut: '10.00',
        paymentMethods: [{ id: 'bank_tx_ar', name: 'CVU/CBU o Alias (ARS)' }],
      });
      const text = JSON.stringify(view);
      expect(text).not.toContain(ADDRESS);
      expect(text).not.toContain('c_cosmos_seller');
      const select = prisma.p2pPaymentRequest.findUnique.mock.calls[0][0]
        .select as Row;
      expect(select).not.toHaveProperty('address');
      expect(select).not.toHaveProperty('consumerId');
    });

    it('offers the direct flow for an ARS request the market takes, only on a deployment that serves it', async () => {
      const on = setup({ direct: true });
      const created = await on.service.create(seller, INPUT);
      expect(created).toMatchObject({ methods: ['p2p'], p2pDirect: true });
      await expect(on.service.findPublic(created.id)).resolves.toMatchObject({
        methods: ['p2p'],
        p2pDirect: true,
      });

      const off = setup();
      const plain = await off.service.create(seller, INPUT);
      expect(plain.p2pDirect).toBe(false);
      await expect(off.service.findPublic(plain.id)).resolves.toMatchObject({
        methods: ['p2p'],
        p2pDirect: false,
      });
    });

    it('is a 404 for an unknown id, and for one no request could have, before the table is read', async () => {
      const { service, prisma } = setup();

      await expect(service.findPublic('cmissing')).rejects.toMatchObject({
        code: ApiErrorCode.NotFound,
      });
      prisma.p2pPaymentRequest.findUnique.mockClear();
      await expect(
        service.findPublic('../../etc/passwd'),
      ).rejects.toMatchObject({ code: ApiErrorCode.NotFound });
      expect(prisma.p2pPaymentRequest.findUnique).not.toHaveBeenCalled();
    });

    it('still answers when the market cannot be read', async () => {
      const { service, prisma, client } = setup();
      prisma.p2pPaymentRequest.rows.push({
        id: 'creq9',
        network: 'testnet',
        status: 'open',
        currency: 'ARS',
        amount: '16000',
        description: null,
        chainId: 421614,
        token: 'USDT',
        tokenAddress: USDT0,
        tokenDecimals: 6,
        methods: ['p2p'],
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        paidAt: null,
      });
      client.currencies.mockRejectedValue(new Error('the market is down'));

      await expect(service.findPublic('creq9')).resolves.toMatchObject({
        status: 'open',
        estimatedAmountOut: null,
        paymentMethods: [],
        methods: ['p2p'],
      });
    });
  });

  describe('the payer starting to pay', () => {
    it('opens a purchase owned by the seller, with its referral id, linked to the request', async () => {
      const { service, prisma, client, consumers } = setup();
      const created = await service.create(publicKey, INPUT);
      consumers.resolve.mockClear();

      const opened = await service.openPayerSession(created.id, 'bank_tx_ar');

      expect(Object.keys(opened).sort()).toEqual(['reference', 'widgetUrl']);
      const session = prisma.p2pRampSession.rows[0];
      expect(session).toMatchObject({
        consumerId: 'c_cosmos_public',
        network: 'public',
        side: 'buy',
        currency: 'ARS',
        paymentMethod: 'bank_tx_ar',
        amount: '16000',
        tokenAddress: USDT0,
        chainId: 42161,
        address: ADDRESS,
        paymentRequestId: created.id,
        reference: opened.reference,
      });
      // The request was made with the shared key: its referral id rides along.
      expect(client.integratorIds).toHaveBeenLastCalledWith(true);
      const url = new URL(opened.widgetUrl);
      expect(url.searchParams.get('referralId')).toBe('r-public');
      expect(url.searchParams.get('address')).toBe(ADDRESS);
      expect(url.searchParams.get('amount')).toBe('16000');
      expect(url.searchParams.get('externalReferenceId')).toBe(
        opened.reference,
      );
      // Nobody calling: the owner comes from the row.
      expect(consumers.resolve).not.toHaveBeenCalled();
    });

    it('carries an account’s own referral id for its requests', async () => {
      const { service, client } = setup();
      const created = await service.create(seller, INPUT);

      const opened = await service.openPayerSession(created.id, 'bank_tx_ar');

      expect(client.integratorIds).toHaveBeenLastCalledWith(false);
      expect(new URL(opened.widgetUrl).searchParams.get('referralId')).toBe(
        'r-1',
      );
    });

    it('answers 409 request_closed once the request is cancelled, paid or expired', async () => {
      const { service, prisma } = setup();
      const created = await service.create(seller, INPUT);
      const row = prisma.p2pPaymentRequest.rows[0];

      for (const [change, status] of [
        [{ status: 'cancelled' }, 'cancelled'],
        [{ status: 'paid', paidAt: new Date() }, 'paid'],
        [{ status: 'open', expiresAt: new Date(Date.now() - 1) }, 'expired'],
      ] as const) {
        Object.assign(row, change);
        await expect(
          service.openPayerSession(created.id, 'bank_tx_ar'),
        ).rejects.toMatchObject({
          code: ApiErrorCode.RequestClosed,
          message: `Payment request ${created.id} is ${status}: it can no longer be paid`,
        });
      }
      expect(prisma.p2pRampSession.create).not.toHaveBeenCalled();
    });

    it('refuses a payment method the market does not offer, and an unknown request', async () => {
      const { service, prisma } = setup();
      const created = await service.create(seller, INPUT);

      await expect(
        service.openPayerSession(created.id, 'pix'),
      ).rejects.toMatchObject({
        code: ApiErrorCode.ValidationFailed,
        message: 'paymentMethod pix does not pay in ARS (offered: bank_tx_ar)',
      });
      await expect(
        service.openPayerSession('cmissing', 'bank_tx_ar'),
      ).rejects.toMatchObject({ code: ApiErrorCode.NotFound });
      expect(prisma.p2pRampSession.create).not.toHaveBeenCalled();
    });
  });
});
