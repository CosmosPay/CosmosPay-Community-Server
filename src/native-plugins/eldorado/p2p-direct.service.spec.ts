import { Logger } from '@nestjs/common';
import { ApiErrorCode } from '@/common/errors/api-error';
import { UpstreamStatusError } from '@/common/upstream-http';
import {
  openPayerSession,
  sealPayerSession,
} from '@/native-plugins/eldorado/p2p-direct-session';
import { P2pDirectService } from '@/native-plugins/eldorado/p2p-direct.service';
import { P2pPaymentRequestLedger } from '@/native-plugins/eldorado/p2p-payment-request-ledger.service';
import { PaymentRequestRails } from '@/payment-request-rails/payment-request-rails';

const SECRET = Buffer.alloc(32, 3).toString('base64');
const REQUEST = 'cmh4x2k9a0001l70g8v5q3z2w';
const OTHER_REQUEST = 'cmh4x2k9a0001l70g8v5q3zzz';
const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
const USDT0 = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
const CHECKOUT = 'https://payments.cosmospay.lat';
const EMAIL = 'payer@example.com';
const JWT = 'eyJhbGciOiJSUzI1NiJ9.the-payers-token.sig';
const ACCOUNT = {
  holder: 'Juan Pérez',
  cbu: '0000003100000000001232',
  documentType: 'CUIL' as const,
  document: '20123456786',
  bank: 'mercado_pago' as const,
  accountType: 'savings' as const,
};
/** Everything about the payer that must never reach a row or a log. */
const PAYER_DATA = [EMAIL, JWT, 'Juan', ACCOUNT.cbu, ACCOUNT.document];

type Row = Record<string, unknown>;

function table(prefix: string, rows: Row[] = []) {
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([field, want]) => {
      if (want && typeof want === 'object' && 'in' in want) {
        return (want as { in: unknown[] }).in.includes(row[field]);
      }
      return (row[field] ?? null) === want;
    });
  return {
    rows,
    findUnique: jest.fn(({ where }: { where: Row }) => {
      const row = rows.find((r) => r.id === where.id);
      return Promise.resolve(row ? { ...row } : null);
    }),
    findFirst: jest.fn(({ where }: { where: Row }) => {
      const row = rows.find((r) => matches(r, where));
      return Promise.resolve(row ? { ...row } : null);
    }),
    create: jest.fn(({ data }: { data: Row }) => {
      const row = {
        id: `${prefix}${rows.length + 1}`,
        completedAt: null,
        ...data,
      };
      rows.push(row);
      return Promise.resolve({ ...row });
    }),
    updateMany: jest.fn(({ where, data }: { where: Row; data: Row }) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return Promise.resolve({ count: hit.length });
    }),
  };
}

/** An order as the marketplace answers it, at `status`. */
function marketOrder(
  status: string,
  extra: Row = {},
  reference: string = REQUEST,
) {
  return {
    order: {
      userId: 'payer-user-id',
      apiOrderId: 'ord-1',
      orderStatus: status,
      type: 'BUY',
      createdDate: '2026-11-13T12:30:00.000Z',
      dueDate: '2026-11-13T13:00:00.000Z',
      externalReferenceId: reference,
      quote: {
        in: { amount: '15000', currency: 'ARS' },
        out: { amount: '9.95' },
      },
      fiatDetails: {
        payerDetails: { fullName: 'Juan Pérez', 'CVU/CBU': ACCOUNT.cbu },
        payeeDetails: {
          fullName: 'María Gómez',
          'CVU/CBU': '0000003100000000009999',
          bankId: 'galicia',
        },
      },
      ...extra,
    },
  };
}

function setup(
  options: {
    request?: Row;
    view?: { status?: string; p2pDirect?: boolean };
    configured?: boolean;
  } = {},
) {
  const prisma = {
    p2pPaymentRequest: table('creq', [
      {
        id: REQUEST,
        consumerId: 'c_seller',
        network: 'public',
        status: 'open',
        currency: 'ARS',
        amount: '15000',
        chainId: 42161,
        token: 'USDT0',
        tokenAddress: USDT0,
        address: ADDRESS,
        expiresAt: new Date(Date.now() + 3_600_000),
        paidAt: null,
        processingSessionId: null,
        ...options.request,
      },
    ]),
    p2pRampSession: table('csess'),
  };
  const client = {
    sendLoginCode: jest
      .fn()
      .mockResolvedValue({ ok: true, otpIdentifier: 'otp-1', action: 'LOGIN' }),
    verifyLoginCode: jest.fn().mockResolvedValue({
      ok: true,
      token: JWT,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      user: { email: EMAIL, username: 'juan' },
    }),
    kyc: jest.fn().mockResolvedValue({
      kyc: { userId: 'u', kycLevel: 'L2', kycStatus: 'passed' },
    }),
    submitKycDetails: jest.fn().mockResolvedValue({ ok: true }),
    verifyKycPhone: jest.fn().mockResolvedValue({ ok: true }),
    userInfo: jest.fn().mockResolvedValue({
      profile: { fullName: 'Juan Pérez', email: EMAIL },
      allowance: { month_allowance_usd: '10000', month_consumed_usd: '100' },
    }),
    paymentDetails: jest.fn().mockResolvedValue({
      paymentDetails: [
        {
          id: 'pd-1',
          paymentMethodId: 'bank_tx_ar',
          ownershipType: 'SELF',
          details: {
            type: 'CVU/CBU',
            fullName: 'Juan Pérez',
            'CVU/CBU': ACCOUNT.cbu,
            bankId: 'mercado_pago',
          },
        },
      ],
    }),
    directBuyQuote: jest.fn().mockResolvedValue({ quoteId: 'q-1' }),
    createBuyOrder: jest.fn().mockResolvedValue(marketOrder('REQUESTED')),
    order: jest.fn().mockResolvedValue(marketOrder('ACCEPTED')),
    markOrderPaid: jest.fn().mockResolvedValue(marketOrder('FIAT_PAID')),
    cancelOrder: jest.fn().mockResolvedValue({ ok: true }),
  };
  const requests = {
    findPublic: jest.fn((id: string) =>
      id === REQUEST
        ? Promise.resolve({
            status: 'open',
            p2pDirect: true,
            ...options.view,
          })
        : Promise.reject(
            Object.assign(new Error('Payment request not found'), {
              code: ApiErrorCode.NotFound,
            }),
          ),
    ),
  };
  const configured = options.configured ?? true;
  const config = {
    get: jest.fn((name: string) =>
      name === 'paymentIntents'
        ? { checkoutUrl: CHECKOUT }
        : {
            clientId: configured ? 'client-1' : '',
            apiReferralId: configured ? 'r-api' : '',
            directSessionSecret: configured ? SECRET : '',
          },
    ),
  };
  const ledger = new P2pPaymentRequestLedger(
    prisma as never,
    new PaymentRequestRails(),
  );
  const service = new P2pDirectService(
    config as never,
    prisma as never,
    client as never,
    requests as never,
    ledger,
  );
  const session = sealPayerSession(
    { t: JWT, n: 'public', r: REQUEST, e: Date.now() + 60_000 },
    SECRET,
  );
  return {
    service,
    client,
    prisma,
    requests,
    session,
    request: prisma.p2pPaymentRequest.rows[0],
    sessions: prisma.p2pRampSession.rows,
  };
}

const refused = (status: number, code: string | null, text = '') =>
  new UpstreamStatusError('P2P marketplace', status, code, ['errorCode'], text);

describe('P2pDirectService', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((message: unknown, ..._rest: unknown[]) => {
          logged.push(String(message));
        });
    }
  });

  afterEach(() => {
    // Nothing about the payer is ever logged, whatever the test did.
    for (const line of logged) {
      for (const secret of PAYER_DATA) expect(line).not.toContain(secret);
    }
    jest.restoreAllMocks();
  });

  describe('signing in', () => {
    it('emails a code in the page’s language and answers the challenge', async () => {
      const { service, client } = setup();

      await expect(
        service.login(REQUEST, EMAIL, 'pt-BR,pt;q=0.9'),
      ).resolves.toEqual({ challenge: 'otp-1', newAccount: false });
      expect(client.sendLoginCode).toHaveBeenCalledWith('public', EMAIL, 'pt');
    });

    it('refuses an email that is not one before asking the marketplace', async () => {
      const { service, client } = setup();

      await expect(
        service.login(REQUEST, 'payer.example.com', undefined),
      ).rejects.toMatchObject({ code: ApiErrorCode.InvalidEmail });
      expect(client.sendLoginCode).not.toHaveBeenCalled();
    });

    it('refuses a request that is not open, or that this page cannot pay', async () => {
      await expect(
        setup({ view: { status: 'paid' } }).service.login(
          REQUEST,
          EMAIL,
          undefined,
        ),
      ).rejects.toMatchObject({ code: ApiErrorCode.RequestClosed });
      const off = setup({ view: { p2pDirect: false } });
      await expect(
        off.service.login(REQUEST, EMAIL, undefined),
      ).rejects.toMatchObject({ code: ApiErrorCode.MethodUnavailable });
      expect(off.client.sendLoginCode).not.toHaveBeenCalled();
      await expect(
        off.service.login(OTHER_REQUEST, EMAIL, undefined),
      ).rejects.toMatchObject({ code: ApiErrorCode.NotFound });
    });

    it('trades the code for a session bound to this request, never past two hours', async () => {
      const { service, client } = setup();
      client.verifyLoginCode.mockResolvedValueOnce({
        token: JWT,
        expiresAt: new Date(Date.now() + 30 * 24 * 3_600_000).toISOString(),
      });

      const answer = await service.verify(REQUEST, 'otp-1', 'A1B2C3D4');

      expect(answer.session).not.toContain('the-payers-token');
      const expires = Date.parse(answer.expiresAt);
      expect(expires).toBeLessThanOrEqual(Date.now() + 2 * 3_600_000);
      expect(expires).toBeGreaterThan(Date.now() + 2 * 3_600_000 - 5_000);
      expect(
        openPayerSession(
          answer.session,
          SECRET,
          { requestId: REQUEST, network: 'public' },
          Date.now(),
        ),
      ).toMatchObject({ t: JWT, r: REQUEST, n: 'public' });
      expect(client.verifyLoginCode).toHaveBeenCalledWith('public', {
        otp: 'A1B2C3D4',
        otpIdentifier: 'otp-1',
      });
    });

    it('refuses a malformed code without asking, and a wrong one as invalid_code', async () => {
      const { service, client } = setup();
      await expect(
        service.verify(REQUEST, 'otp-1', '12'),
      ).rejects.toMatchObject({ code: ApiErrorCode.InvalidCode });
      expect(client.verifyLoginCode).not.toHaveBeenCalled();

      client.verifyLoginCode.mockRejectedValueOnce(refused(403, 'INVALID_OTP'));
      await expect(
        service.verify(REQUEST, 'otp-1', 'A1B2C3D4'),
      ).rejects.toMatchObject({ code: ApiErrorCode.InvalidCode });
    });

    it('gives a new account a generated username, once, when the marketplace demands one', async () => {
      const { service, client } = setup();
      client.verifyLoginCode.mockRejectedValueOnce(
        refused(400, 'INVALID_PARAMETERS', 'username is required'),
      );

      await service.verify(REQUEST, 'otp-1', 'A1B2C3D4');

      expect(client.verifyLoginCode).toHaveBeenCalledTimes(2);
      expect(client.verifyLoginCode.mock.calls[1][1]).toMatchObject({
        otp: 'A1B2C3D4',
        username: expect.stringMatching(/^cp[a-z0-9]{10}$/) as unknown,
      });
    });
  });

  describe('the session', () => {
    it('is required, and only for its own request and network', async () => {
      const { service, client } = setup();
      const other = sealPayerSession(
        { t: JWT, n: 'public', r: OTHER_REQUEST, e: Date.now() + 60_000 },
        SECRET,
      );
      const testnet = sealPayerSession(
        { t: JWT, n: 'testnet', r: REQUEST, e: Date.now() + 60_000 },
        SECRET,
      );
      const expired = sealPayerSession(
        { t: JWT, n: 'public', r: REQUEST, e: Date.now() - 1 },
        SECRET,
      );

      for (const session of [undefined, 'garbage', other, testnet, expired]) {
        await expect(service.kyc(REQUEST, session)).rejects.toMatchObject({
          code: ApiErrorCode.SessionExpired,
        });
      }
      expect(client.kyc).not.toHaveBeenCalled();
    });

    it('turns the marketplace refusing the token into session_expired', async () => {
      const { service, client, session } = setup();
      client.kyc.mockRejectedValueOnce(refused(401, 'SESSION_EXPIRED'));

      await expect(service.kyc(REQUEST, session)).rejects.toMatchObject({
        code: ApiErrorCode.SessionExpired,
      });
    });
  });

  describe('verification', () => {
    it('answers ready with what is left this month', async () => {
      const { service, client, session } = setup();

      await expect(service.kyc(REQUEST, session)).resolves.toEqual({
        step: 'ready',
        documentUrl: null,
        error: null,
        limitUsd: '9900.00',
      });
      expect(client.kyc).toHaveBeenCalledWith('public', JWT);
    });

    it('reads a payer with no verification record as the first step, and an unreadable allowance as no limit', async () => {
      const { service, client, session } = setup();
      client.kyc.mockRejectedValueOnce(refused(404, 'NOT_FOUND'));
      await expect(service.kyc(REQUEST, session)).resolves.toMatchObject({
        step: 'details',
      });

      client.userInfo.mockRejectedValueOnce(refused(500, null));
      await expect(service.kyc(REQUEST, session)).resolves.toMatchObject({
        step: 'ready',
        limitUsd: null,
      });
    });

    it('sends Argentina, the city and the phone as +54, then answers the new step', async () => {
      const { service, client, session } = setup();
      client.kyc.mockResolvedValueOnce({
        kyc: {
          kycLevel: 'L0',
          kycStatus: 'passed',
          kycNextLevel: 'L1',
          kycNextLevelStatus: 'started',
        },
      });

      await expect(
        service.submitKycDetails(REQUEST, session, 'Salta', '387 412-3456'),
      ).resolves.toMatchObject({ step: 'phone' });
      expect(client.submitKycDetails).toHaveBeenCalledWith('public', JWT, {
        countryOfResidence: 'AR',
        cityOfResidence: 'Salta',
        phoneNumber: '+543874123456',
      });
    });

    it('refuses a phone that is not Argentine, and a phone code of the wrong shape, without asking', async () => {
      const { service, client, session } = setup();

      await expect(
        service.submitKycDetails(REQUEST, session, 'Salta', '+1 202 555 0143'),
      ).rejects.toMatchObject({ code: ApiErrorCode.InvalidPhone });
      await expect(
        service.verifyKycPhone(REQUEST, session, '12'),
      ).rejects.toMatchObject({ code: ApiErrorCode.InvalidCode });
      expect(client.submitKycDetails).not.toHaveBeenCalled();
      expect(client.verifyKycPhone).not.toHaveBeenCalled();
    });
  });

  describe('paying', () => {
    it('lists the saved accounts with a hint only', async () => {
      const { service, session } = setup();

      await expect(service.accounts(REQUEST, session)).resolves.toEqual({
        accounts: [
          {
            id: 'pd-1',
            holder: 'Juan Pérez',
            bank: 'mercado_pago',
            hint: '1232',
          },
        ],
      });
    });

    it('quotes the request’s exact amount and opens the order to the request’s own destination', async () => {
      const { service, client, session, sessions } = setup();

      const order = await service.createOrder(REQUEST, session, {
        account: ACCOUNT,
      });

      expect(client.directBuyQuote).toHaveBeenCalledWith('public', JWT, {
        token: USDT0,
        chainId: '42161',
        fiatCurrencyId: 'ARS',
        paymentMethodId: 'bank_tx_ar',
        amount: '15000',
        fixedAmountSide: 'IN',
        addressTo: ADDRESS,
      });
      expect(client.createBuyOrder).toHaveBeenCalledWith('public', JWT, {
        quoteId: 'q-1',
        fiatDetails: {
          details: {
            type: 'CVU/CBU',
            fullName: 'Juan Pérez',
            'CVU/CBU': ACCOUNT.cbu,
            typeOfDocument: 'CUIL',
            documentNumber: ACCOUNT.document,
            bankId: 'mercado_pago',
            accountType: 'savings',
          },
        },
        cryptoDetails: {
          recipientAddress: ADDRESS,
          tokenAddress: USDT0,
          chainId: '42161',
        },
        externalReferenceId: REQUEST,
      });
      expect(order).toMatchObject({
        id: 'ord-1',
        status: 'matching',
        amount: '15000',
        currency: 'ARS',
        payTo: null,
      });
      // The seller's session record: the order id, never the payer.
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        consumerId: 'c_seller',
        network: 'public',
        side: 'buy',
        paymentMethod: 'bank_tx_ar',
        paymentRequestId: REQUEST,
        providerOrderId: 'ord-1',
        providerStatus: 'REQUESTED',
        address: ADDRESS,
        estimatedAmountOut: '9.95',
        widgetUrl: `${CHECKOUT}/fiat/${REQUEST}`,
      });
      const stored = JSON.stringify(sessions[0]);
      for (const secret of PAYER_DATA) expect(stored).not.toContain(secret);
    });

    it('pays from a saved account by its id', async () => {
      const { service, client, session } = setup();

      await service.createOrder(REQUEST, session, { accountId: 'pd-1' });

      expect(client.createBuyOrder.mock.calls[0][2]).toMatchObject({
        fiatDetails: { detailsId: 'pd-1' },
      });
    });

    it('refuses before quoting: neither or both accounts, a bad CUIT/CUIL, a payer not verified', async () => {
      const { service, client, session } = setup();

      await expect(
        service.createOrder(REQUEST, session, {}),
      ).rejects.toMatchObject({ code: ApiErrorCode.InvalidAccount });
      await expect(
        service.createOrder(REQUEST, session, {
          accountId: 'pd-1',
          account: ACCOUNT,
        }),
      ).rejects.toMatchObject({ code: ApiErrorCode.InvalidAccount });
      await expect(
        service.createOrder(REQUEST, session, {
          account: { ...ACCOUNT, document: '20123456785' },
        }),
      ).rejects.toMatchObject({ code: ApiErrorCode.InvalidDocument });
      await expect(
        service.createOrder(REQUEST, session, {
          account: { ...ACCOUNT, cbu: '0000003100000000001234' },
        }),
      ).rejects.toMatchObject({ code: ApiErrorCode.InvalidCbu });
      await expect(
        service.createOrder(REQUEST, session, {
          account: { ...ACCOUNT, bank: 'banco_falso' },
        }),
      ).rejects.toMatchObject({ code: ApiErrorCode.InvalidBank });
      await expect(
        service.createOrder(REQUEST, session, { accountId: '../x' }),
      ).rejects.toMatchObject({ code: ApiErrorCode.InvalidAccount });
      client.kyc.mockResolvedValueOnce({
        kyc: {
          kycLevel: 'L1',
          kycStatus: 'passed',
          kycNextLevel: 'L2',
          kycNextLevelStatus: 'pending',
        },
      });
      await expect(
        service.createOrder(REQUEST, session, { accountId: 'pd-1' }),
      ).rejects.toMatchObject({ code: ApiErrorCode.KycRequired });
      expect(client.directBuyQuote).not.toHaveBeenCalled();
    });

    it('maps the marketplace’s limits: no seller to quote, two orders in progress', async () => {
      const { service, client, session, sessions } = setup();
      client.directBuyQuote.mockRejectedValueOnce(
        refused(422, 'QUOTE_NOT_AVAILABLE'),
      );
      await expect(
        service.createOrder(REQUEST, session, { accountId: 'pd-1' }),
      ).rejects.toMatchObject({ code: ApiErrorCode.NoSellers });

      client.createBuyOrder.mockRejectedValueOnce(
        refused(429, 'TOO_MANY_ACTIVE_ORDERS'),
      );
      await expect(
        service.createOrder(REQUEST, session, { accountId: 'pd-1' }),
      ).rejects.toMatchObject({ code: ApiErrorCode.TooManyOrders });
      expect(sessions).toHaveLength(0);
    });

    it('cancels an order it could not record, so none is left that no webhook can settle', async () => {
      const { service, client, prisma, session } = setup();
      prisma.p2pRampSession.create.mockRejectedValueOnce(
        new Error('database down'),
      );

      await expect(
        service.createOrder(REQUEST, session, { accountId: 'pd-1' }),
      ).rejects.toThrow('database down');
      expect(client.cancelOrder).toHaveBeenCalledWith('public', JWT, 'ord-1');
    });
  });

  describe('an order under way', () => {
    it('is read only when it names this request', async () => {
      const { service, client, session } = setup();

      await expect(
        service.order(REQUEST, 'ord-1', session),
      ).resolves.toMatchObject({
        id: 'ord-1',
        status: 'pay',
        payTo: {
          holder: 'María Gómez',
          cbu: '0000003100000000009999',
          alias: null,
          bank: 'galicia',
        },
        dueAt: '2026-11-13T13:00:00.000Z',
      });

      client.order.mockResolvedValueOnce(
        marketOrder('ACCEPTED', {}, OTHER_REQUEST),
      );
      await expect(
        service.order(REQUEST, 'ord-1', session),
      ).rejects.toMatchObject({ code: ApiErrorCode.NotFound });
      client.order.mockResolvedValueOnce(
        marketOrder('ACCEPTED', { externalReferenceId: undefined }),
      );
      await expect(
        service.order(REQUEST, 'ord-1', session),
      ).rejects.toMatchObject({ code: ApiErrorCode.NotFound });
      client.order.mockRejectedValueOnce(refused(404, 'NOT_FOUND'));
      await expect(
        service.order(REQUEST, 'ord-2', session),
      ).rejects.toMatchObject({ code: ApiErrorCode.NotFound });
    });

    it('stays readable once the request is paid, expired or cancelled', async () => {
      const { service, session } = setup({
        request: { status: 'paid', paidAt: new Date() },
        view: { status: 'paid', p2pDirect: false },
      });

      await expect(
        service.order(REQUEST, 'ord-1', session),
      ).resolves.toMatchObject({ id: 'ord-1' });
    });

    it('is 503 p2p_unavailable once the deployment no longer serves the flow', async () => {
      const { service, session } = setup({ configured: false });

      await expect(
        service.order(REQUEST, 'ord-1', session),
      ).rejects.toMatchObject({ code: ApiErrorCode.P2pUnavailable });
    });

    it('marked paid, moves to confirming and the request to processing because of it', async () => {
      const { service, client, session, request, sessions } = setup();
      await service.createOrder(REQUEST, session, { accountId: 'pd-1' });

      await expect(
        service.markPaid(REQUEST, 'ord-1', session),
      ).resolves.toMatchObject({ status: 'confirming' });

      expect(client.markOrderPaid).toHaveBeenCalledWith('public', JWT, 'ord-1');
      expect(sessions).toHaveLength(1);
      expect(sessions[0].providerStatus).toBe('FIAT_PAID');
      expect(request).toMatchObject({
        status: 'processing',
        processingSessionId: sessions[0].id,
      });
    });

    it('records the order when it marks paid one it had no record of', async () => {
      const { service, session, request, sessions } = setup();

      await service.markPaid(REQUEST, 'ord-1', session);

      expect(sessions[0]).toMatchObject({
        providerOrderId: 'ord-1',
        paymentRequestId: REQUEST,
      });
      expect(request.processingSessionId).toBe(sessions[0].id);
    });

    it('cannot be marked paid unless it waits for the transfer', async () => {
      const { service, client, session, request } = setup();
      client.order.mockResolvedValueOnce(marketOrder('REQUESTED'));

      await expect(
        service.markPaid(REQUEST, 'ord-1', session),
      ).rejects.toMatchObject({
        code: ApiErrorCode.OrderNotPayable,
        message:
          'This order is matching: only an order waiting for your transfer can be marked paid.',
      });
      expect(client.markOrderPaid).not.toHaveBeenCalled();
      expect(request.status).toBe('open');
    });

    it('is cancelled only before it is paid', async () => {
      const { service, client, session } = setup();
      client.order
        .mockResolvedValueOnce(marketOrder('ACCEPTED'))
        .mockResolvedValueOnce(marketOrder('CANCELLED'));

      await expect(
        service.cancel(REQUEST, 'ord-1', session),
      ).resolves.toMatchObject({ status: 'cancelled', payTo: null });
      expect(client.cancelOrder).toHaveBeenCalledWith('public', JWT, 'ord-1');

      client.order.mockResolvedValueOnce(marketOrder('FIAT_PAID'));
      client.cancelOrder.mockClear();
      await expect(
        service.cancel(REQUEST, 'ord-1', session),
      ).rejects.toMatchObject({ code: ApiErrorCode.OrderNotCancellable });
      expect(client.cancelOrder).not.toHaveBeenCalled();
    });
  });
});
