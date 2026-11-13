import { ApiErrorCode } from '@/common/errors/api-error';
import { UpstreamStatusError } from '@/common/upstream-http';
import {
  accountDetails,
  directConfigured,
  directLanguage,
  directRefusal,
  generatedUsername,
  isAccountId,
  isEmailAddress,
  isLoginCode,
  isPhoneCode,
  normalizeArPhone,
  p2pDirectAvailable,
  parseDirectAccount,
  quoteIdOf,
  readDirectAccounts,
  readDirectOrder,
  readKyc,
  readLoginChallenge,
  readLoginSession,
  remainingLimitUsd,
  type DirectAccountInput,
  type DirectStep,
} from '@/native-plugins/eldorado/p2p-direct';

const REQUEST = 'cmh4x2k9a0001l70g8v5q3z2w';
const FALLBACK = { amount: '15000', currency: 'ARS' };
const SECRET = Buffer.alloc(32, 1).toString('base64');

describe('the direct flow’s rules', () => {
  describe('availability', () => {
    it('needs the client id, the API referral id and the session secret', () => {
      const on = {
        clientId: 'c',
        apiReferralId: 'r-api',
        directSessionSecret: SECRET,
      };
      expect(directConfigured(on)).toBe(true);
      expect(directConfigured({ ...on, clientId: '' })).toBe(false);
      expect(directConfigured({ ...on, apiReferralId: '' })).toBe(false);
      expect(directConfigured({ ...on, directSessionSecret: '' })).toBe(false);
    });

    it('is offered for ARS with the P2P rail available, on a deployment that serves it', () => {
      expect(
        p2pDirectAvailable(true, { currency: 'ARS', methods: ['p2p'] }),
      ).toBe(true);
      expect(
        p2pDirectAvailable(true, {
          currency: 'ARS',
          methods: ['transfer', 'p2p'],
        }),
      ).toBe(true);
      expect(
        p2pDirectAvailable(false, { currency: 'ARS', methods: ['p2p'] }),
      ).toBe(false);
      expect(
        p2pDirectAvailable(true, { currency: 'ARS', methods: ['transfer'] }),
      ).toBe(false);
      expect(
        p2pDirectAvailable(true, { currency: 'COP', methods: ['p2p'] }),
      ).toBe(false);
    });
  });

  describe('sign-in', () => {
    it('writes the email in the language the page prefers, Spanish by default', () => {
      expect(directLanguage(undefined)).toBe('es');
      expect(directLanguage('')).toBe('es');
      expect(directLanguage('en-US,en;q=0.9')).toBe('en');
      expect(directLanguage('pt-BR')).toBe('pt');
      expect(directLanguage('fr-FR,fr;q=0.9,en;q=0.5')).toBe('en');
      expect(directLanguage('de,en;q=0.1,pt;q=0.8')).toBe('pt');
      expect(directLanguage('es-AR,es;q=0.9')).toBe('es');
      expect(directLanguage('en;q=0,fr')).toBe('es');
      expect(directLanguage('zh-CN')).toBe('es');
    });

    it('reads the challenge and whether the account is new', () => {
      expect(
        readLoginChallenge({
          ok: true,
          otpIdentifier: 'otp-1',
          action: 'REGISTER',
        }),
      ).toEqual({ challenge: 'otp-1', newAccount: true });
      expect(
        readLoginChallenge({ otpIdentifier: 'otp-1', action: 'LOGIN' }),
      ).toEqual({ challenge: 'otp-1', newAccount: false });
      for (const raw of [
        null,
        {},
        { otpIdentifier: '' },
        { otpIdentifier: 'has space' },
        { otpIdentifier: 7 },
      ]) {
        expect(readLoginChallenge(raw)).toBeNull();
      }
    });

    it('checks an email address', () => {
      expect(isEmailAddress('payer@example.com')).toBe(true);
      expect(isEmailAddress('payer.example.com')).toBe(false);
      expect(isEmailAddress('payer@')).toBe(false);
      expect(isEmailAddress(`${'a'.repeat(250)}@example.com`)).toBe(false);
    });

    it('checks the codes’ shapes', () => {
      expect(isLoginCode('A1B2C3D4')).toBe(true);
      expect(isLoginCode('A1B2C3D')).toBe(false);
      expect(isLoginCode('A1B2-C3D4')).toBe(false);
      expect(isPhoneCode('1234')).toBe(true);
      expect(isPhoneCode('123')).toBe(false);
      expect(isPhoneCode('12a4')).toBe(false);
    });

    it('reads the token and its expiry', () => {
      expect(
        readLoginSession({
          token: 'jwt',
          expiresAt: '2026-11-13T14:00:00.000Z',
          user: { email: 'payer@example.com' },
        }),
      ).toEqual({
        token: 'jwt',
        expiresAt: Date.parse('2026-11-13T14:00:00.000Z'),
      });
      expect(readLoginSession({ token: 'jwt' })).toEqual({
        token: 'jwt',
        expiresAt: null,
      });
      expect(readLoginSession({ token: '' })).toBeNull();
      expect(readLoginSession(null)).toBeNull();
    });

    it('generates a username of 3 to 20 letters and digits', () => {
      for (let i = 0; i < 20; i++) {
        expect(generatedUsername()).toMatch(/^cp[a-z0-9]{10}$/);
      }
    });
  });

  describe('verification steps', () => {
    const at = (kyc: Record<string, unknown>) => readKyc(kyc);

    it.each([
      // [level, status, next, nextStatus, error, action, step, error out]
      ['L0', 'passed', 'L1', 'needed', undefined, 'form', 'details', null],
      [
        'L0',
        'needed',
        undefined,
        undefined,
        undefined,
        undefined,
        'details',
        null,
      ],
      ['L0', 'passed', 'L1', 'started', undefined, 'form', 'phone', null],
      ['L0', 'passed', 'L1', 'pending', undefined, undefined, 'phone', null],
      [
        'L0',
        'passed',
        'L1',
        'started',
        'PHONE_NUMBER_EXIST',
        'form',
        'details',
        'phone_taken',
      ],
      [
        'L0',
        'passed',
        'L1',
        'needed',
        'PHONE_NUMBER_INVALID',
        'form',
        'details',
        'phone_invalid',
      ],
      ['L0', 'passed', 'L1', 'rejected', undefined, 'form', 'details', null],
      ['L1', 'passed', 'L2', 'needed', undefined, 'url', 'document', null],
      ['L1', 'passed', 'L2', 'started', undefined, 'url', 'document', null],
      ['L1', 'passed', 'L2', 'pending', undefined, undefined, 'review', null],
      [
        'L1',
        'passed',
        'L2',
        'rejected',
        undefined,
        undefined,
        'rejected',
        null,
      ],
      ['L2', 'passed', 'L3', undefined, undefined, undefined, 'ready', null],
      ['L3', 'passed', 'L4', 'needed', undefined, 'url', 'ready', null],
    ] as const)(
      'reads %s %s, next %s %s, error %s as %s',
      (level, status, next, nextStatus, error, action, step, errorOut) => {
        const { kyc, unmapped } = at({
          userId: 'u',
          kycLevel: level,
          kycStatus: status,
          kycNextLevel: next,
          kycNextLevelStatus: nextStatus,
          kycNextLevelError: error,
          action:
            action === 'url'
              ? { type: 'url', value: 'https://verify.example/s/1' }
              : action === 'form'
                ? { type: 'form', value: { phoneNumber: 'phone' } }
                : undefined,
        });
        expect(kyc.step).toBe(step);
        expect(kyc.error).toBe(errorOut);
        expect(kyc.documentUrl).toBe(
          step === 'document' ? 'https://verify.example/s/1' : null,
        );
        expect(unmapped).toBeNull();
      },
    );

    it('answers the likeliest step for a combination it does not expect, and says so by enum values only', () => {
      const pendingL2 = at({ kycLevel: 'L2', kycStatus: 'pending' });
      expect(pendingL2.kyc.step).toBe('review');
      expect(pendingL2.unmapped).toBe(
        'level=L2 status=pending next=none nextStatus=none error=none',
      );
      expect(at({ kycLevel: 'L2', kycStatus: 'rejected' }).kyc.step).toBe(
        'rejected',
      );
      expect(
        at({
          kycLevel: 'L1',
          kycStatus: 'passed',
          kycNextLevelStatus: 'passed',
        }).kyc.step,
      ).toBe('review');
      const odd = at({
        kycLevel: 'L9',
        kycStatus: 'weird status with spaces',
        kycNextLevelError: 'payer@example.com',
      });
      expect(odd.kyc.step).toBe('details');
      expect(odd.unmapped).toBe(
        'level=L9 status=(other) next=none nextStatus=none error=(other)',
      );
      expect(odd.unmapped).not.toContain('@');
    });

    it('reads no verification record as the first step', () => {
      expect(readKyc(null)).toMatchObject({
        kyc: { step: 'details', error: null, documentUrl: null },
      });
    });

    it('never hands the page a link it should not open', () => {
      for (const value of [
        'javascript:alert(1)',
        'data:text/html,hi',
        'not a url',
        42,
      ]) {
        const { kyc, unmapped } = at({
          kycLevel: 'L1',
          kycStatus: 'passed',
          kycNextLevel: 'L2',
          kycNextLevelStatus: 'needed',
          action: { type: 'url', value },
        });
        expect(kyc).toMatchObject({ step: 'document', documentUrl: null });
        expect(unmapped).not.toBeNull();
      }
    });

    it('works out what is left of the monthly allowance, never below zero', () => {
      expect(
        remainingLimitUsd({
          month_allowance_usd: '10000',
          month_consumed_usd: '150.5',
        }),
      ).toBe('9849.50');
      expect(remainingLimitUsd({ month_allowance_usd: '10000' })).toBe(
        '10000.00',
      );
      expect(
        remainingLimitUsd({
          month_allowance_usd: 100,
          month_consumed_usd: '250',
        }),
      ).toBe('0.00');
      expect(remainingLimitUsd({ month_consumed_usd: '1' })).toBeNull();
      expect(remainingLimitUsd(null)).toBeNull();
    });
  });

  describe('the phone', () => {
    it.each([
      ['+54 9 387 412-3456', '+5493874123456'],
      ['+543874123456', '+543874123456'],
      ['5493874123456', '+5493874123456'],
      ['3874123456', '+543874123456'],
      ['(0387) 412-3456', '+543874123456'],
      ['11 2345.6789', '+541123456789'],
    ])('reads %s as %s', (input, phone) => {
      expect(normalizeArPhone(input)).toBe(phone);
    });

    it.each([
      '+1 202 555 0143',
      '+56912345678',
      '412-3456',
      '38741234567890',
      'phone',
      '',
      '+54 387 412 345',
    ])('refuses %s', (input) => {
      expect(normalizeArPhone(input)).toBeNull();
    });
  });

  describe('bank accounts', () => {
    const ACCOUNT: DirectAccountInput = {
      holder: 'Juan Pérez',
      cbu: '0000003100000000000000',
      documentType: 'CUIL',
      document: '20123456786',
      bank: 'mercado_pago',
      accountType: 'savings',
    };

    it('reads a typed account, dropping the separators a person types', () => {
      expect(
        parseDirectAccount({
          holder: '  Juan   Pérez ',
          cbu: '0000-0031 0000.0000-0000-00',
          documentType: 'CUIL',
          document: '20-12345678-6',
          bank: 'mercado_pago',
          accountType: 'savings',
          extra: 'ignored',
        }),
      ).toEqual({ account: ACCOUNT });
    });

    it.each([
      [{ holder: 'Jo' }, ApiErrorCode.InvalidAccount, /holder/],
      [{ holder: 'Juan 2' }, ApiErrorCode.InvalidAccount, /holder/],
      [{ holder: undefined }, ApiErrorCode.InvalidAccount, /holder/],
      [{ cbu: '000000310000000000000' }, ApiErrorCode.InvalidCbu, /22 digits/],
      // Right length, wrong check digits (each block).
      [{ cbu: '0000003200000000000000' }, ApiErrorCode.InvalidCbu, /check/],
      [{ cbu: '0000003100000000001234' }, ApiErrorCode.InvalidCbu, /check/],
      [{ cbu: 42 }, ApiErrorCode.InvalidCbu, /cbu/],
      [{ documentType: 'DNI' }, ApiErrorCode.InvalidDocument, /documentType/],
      [
        { document: '20123456785' },
        ApiErrorCode.InvalidDocument,
        /check digit/,
      ],
      [{ document: '12345678' }, ApiErrorCode.InvalidDocument, /11 digits/],
      [{ bank: 'banco_falso' }, ApiErrorCode.InvalidBank, /bank/],
      [{ accountType: 'current' }, ApiErrorCode.InvalidAccount, /accountType/],
    ] as const)('refuses %j with its own code', (change, code, message) => {
      const parsed = parseDirectAccount({ ...ACCOUNT, ...change });
      expect(parsed).toEqual({
        refusal: { code, message: expect.stringMatching(message) as unknown },
      });
    });

    it('refuses an account that is not an object', () => {
      for (const raw of [null, 'account', ['x']]) {
        expect(parseDirectAccount(raw)).toMatchObject({
          refusal: { code: ApiErrorCode.InvalidAccount },
        });
      }
    });

    it('takes a saved account id only in the marketplace’s shape', () => {
      expect(isAccountId('3b1f8a2c-6d4e-4f7a-9c0b-1e2d3f4a5b6c')).toBe(true);
      expect(isAccountId('../x')).toBe(false);
      expect(isAccountId('')).toBe(false);
    });

    it('sends a typed account as the CVU/CBU form', () => {
      expect(accountDetails(ACCOUNT)).toEqual({
        type: 'CVU/CBU',
        fullName: 'Juan Pérez',
        'CVU/CBU': '0000003100000000000000',
        typeOfDocument: 'CUIL',
        documentNumber: '20123456786',
        bankId: 'mercado_pago',
        accountType: 'savings',
      });
    });

    it('lists the payer’s own saved accounts with a hint, never a full number', () => {
      const accounts = readDirectAccounts([
        {
          id: 'pd-1',
          paymentMethodId: 'bank_tx_ar',
          ownershipType: 'SELF',
          details: {
            type: 'CVU/CBU',
            fullName: 'Juan Pérez',
            'CVU/CBU': '0000003100000000001234',
            documentNumber: '20123456786',
            bankId: 'galicia',
          },
        },
        {
          id: 'pd-2',
          paymentMethodId: 'bank_tx_ar',
          ownershipType: 'SELF',
          details: {
            type: 'alias',
            fullName: 'Juan Pérez',
            alias: 'juan.perez.mp',
            'CVU/CBU': '0000003100000000005678',
            bankId: 'mercado_pago',
          },
        },
        // Someone else's account: never offered.
        {
          id: 'pd-3',
          paymentMethodId: 'bank_tx_ar',
          ownershipType: 'THIRD_PARTY',
          details: { fullName: 'Other', 'CVU/CBU': '0'.repeat(22) },
        },
        // Another payment method, no id, no holder: left out.
        { id: 'pd-4', paymentMethodId: 'app_nequi_co', details: {} },
        { paymentMethodId: 'bank_tx_ar', details: { fullName: 'X' } },
        { id: 'pd-6', details: { 'CVU/CBU': '0'.repeat(22) } },
      ]);
      expect(accounts).toEqual([
        { id: 'pd-1', holder: 'Juan Pérez', bank: 'galicia', hint: '1234' },
        {
          id: 'pd-2',
          holder: 'Juan Pérez',
          bank: 'mercado_pago',
          hint: 'juan.perez.mp',
        },
      ]);
      const text = JSON.stringify(accounts);
      expect(text).not.toContain('0000003100000000001234');
      expect(text).not.toContain('20123456786');
      expect(readDirectAccounts(null)).toEqual([]);
    });
  });

  describe('orders', () => {
    const raw = (status: string, extra: Record<string, unknown> = {}) => ({
      order: {
        userId: 'payer-user',
        apiOrderId: 'ord-1',
        orderStatus: status,
        type: 'BUY',
        createdDate: '2026-11-13T12:30:00.000Z',
        dueDate: '2026-11-13T13:00:00.000Z',
        externalReferenceId: REQUEST,
        quote: {
          in: {
            amount: '15000',
            currency: 'ARS',
            paymentMethodId: 'bank_tx_ar',
          },
          out: { amount: '9.95', currency: 'USDT', chain: '42161' },
        },
        fiatDetails: {
          paymentMethodId: 'bank_tx_ar',
          payerDetails: {
            fullName: 'Juan Pérez',
            'CVU/CBU': '0000003100000000001234',
          },
          payeeDetails: {
            type: 'alias',
            fullName: 'María Gómez',
            alias: 'maria.gomez.mp',
            'CVU/CBU': '0000003100000000009999',
            bankId: 'mercado_pago',
            documentNumber: '27123456780',
          },
        },
        ...extra,
      },
    });

    it.each([
      ['REQUESTED', 'matching'],
      ['ACCEPTED', 'pay'],
      ['FIAT_PAID', 'confirming'],
      ['FIAT_RECEIVED', 'confirming'],
      ['COMPLETED', 'completed'],
      ['CANCELLED', 'cancelled'],
      ['DISPUTED', 'disputed'],
    ])('reads %s as %s', (status, view) => {
      const order = readDirectOrder(raw(status), FALLBACK)!;
      expect(order.view.status).toBe(view);
      expect(order.rawStatus).toBe(status);
      expect(order.unmapped).toBeNull();
      const live = view === 'pay' || view === 'confirming';
      expect(order.view.payTo === null).toBe(!live);
      expect(order.view.dueAt === null).toBe(!live);
    });

    it('answers where to transfer while the payer pays, and nothing about the payer', () => {
      const order = readDirectOrder(raw('ACCEPTED'), FALLBACK)!;
      expect(order.view).toEqual({
        id: 'ord-1',
        status: 'pay',
        amount: '15000',
        currency: 'ARS',
        payTo: {
          holder: 'María Gómez',
          cbu: '0000003100000000009999',
          alias: 'maria.gomez.mp',
          bank: 'mercado_pago',
        },
        dueAt: '2026-11-13T13:00:00.000Z',
        createdAt: '2026-11-13T12:30:00.000Z',
      });
      expect(order.reference).toBe(REQUEST);
      expect(order.amountOut).toBe('9.95');
      const text = JSON.stringify(order.view);
      expect(text).not.toContain('Juan');
      expect(text).not.toContain('27123456780');
      expect(text).not.toContain('payer-user');
    });

    it('gives no payTo when the seller named no account the payer can use', () => {
      const order = readDirectOrder(
        raw('ACCEPTED', {
          fiatDetails: { payeeDetails: { fullName: 'María Gómez' } },
        }),
        FALLBACK,
      )!;
      expect(order.view.payTo).toBeNull();
    });

    it('reads an unknown status as matching and says so; an order with no id or status as nothing', () => {
      const order = readDirectOrder(raw('WAITING_FOR_FUNDS'), FALLBACK)!;
      expect(order.view.status).toBe('matching');
      expect(order.unmapped).toBe('status=WAITING_FOR_FUNDS');
      expect(
        readDirectOrder({ order: { orderStatus: 'ACCEPTED' } }, FALLBACK),
      ).toBeNull();
      expect(
        readDirectOrder({ order: { apiOrderId: 'x' } }, FALLBACK),
      ).toBeNull();
      expect(readDirectOrder(null, FALLBACK)).toBeNull();
    });

    it('falls back to the request’s amount when the order does not say it', () => {
      const order = readDirectOrder(
        { order: { apiOrderId: 'ord-1', orderStatus: 'REQUESTED' } },
        FALLBACK,
      )!;
      expect(order.view).toMatchObject({ amount: '15000', currency: 'ARS' });
      expect(order.reference).toBeNull();
    });

    it('takes a quote id only from a quote that can be ordered', () => {
      expect(quoteIdOf({ quoteId: 'q-1' })).toBe('q-1');
      expect(quoteIdOf({ quoteId: 'q-1', readonly: true })).toBeNull();
      expect(quoteIdOf({})).toBeNull();
    });
  });

  describe('marketplace refusals', () => {
    const refusal = (
      step: DirectStep,
      status: number,
      code: string | null = null,
      text = '',
    ) =>
      directRefusal(
        step,
        new UpstreamStatusError('P2P marketplace', status, code, [], text),
      );
    const codeOf = (error: ReturnType<typeof directRefusal>) => ({
      status: error.getStatus(),
      code: error.code,
    });

    it.each([
      ['verify', 403, 'INVALID_OTP', 400, ApiErrorCode.InvalidCode],
      ['verify', 400, 'INVALID_PARAMETERS', 400, ApiErrorCode.InvalidCode],
      ['verify', 403, 'UNABLE_TO_SIGNUP', 400, ApiErrorCode.Rejected],
      ['verify', 429, 'ACCOUNT_LOCKED', 429, ApiErrorCode.RateLimited],
      ['login', 401, 'UNAUTHORIZED', 503, ApiErrorCode.P2pUnavailable],
      ['login', 400, 'INVALID_PARAMETERS', 400, ApiErrorCode.Rejected],
      ['kyc', 401, 'SESSION_EXPIRED', 401, ApiErrorCode.SessionExpired],
      ['kycPhone', 400, null, 400, ApiErrorCode.InvalidCode],
      [
        'kycDetails',
        400,
        'PHONE_NUMBER_COUNTRY_NOT_SUPPORTED',
        400,
        ApiErrorCode.InvalidPhone,
      ],
      [
        'kycDetails',
        400,
        'RESIDENCE_COUNTRY_NOT_SUPPORTED',
        400,
        ApiErrorCode.Rejected,
      ],
      ['accounts', 500, null, 503, ApiErrorCode.P2pUnavailable],
      ['quote', 422, 'QUOTE_NOT_AVAILABLE', 503, ApiErrorCode.NoSellers],
      ['quote', 500, null, 503, ApiErrorCode.NoSellers],
      ['quote', 401, null, 401, ApiErrorCode.SessionExpired],
      ['order', 429, 'TOO_MANY_ACTIVE_ORDERS', 409, ApiErrorCode.TooManyOrders],
      ['order', 410, 'EXPIRED_QUOTE', 503, ApiErrorCode.NoSellers],
      ['order', 404, 'QUOTE_NOT_FOUND', 503, ApiErrorCode.NoSellers],
      ['order', 403, 'PROFILE_NOT_READY', 409, ApiErrorCode.KycRequired],
      ['order', 400, 'INVALID_PARAMETERS', 400, ApiErrorCode.Rejected],
      ['order', 500, 'INTERNAL_SERVER_ERROR', 503, ApiErrorCode.P2pUnavailable],
      ['orderRead', 404, 'NOT_FOUND', 404, ApiErrorCode.NotFound],
      ['paid', 403, 'INVALID_ORDER_STATUS', 409, ApiErrorCode.OrderNotPayable],
      ['cancel', 403, null, 409, ApiErrorCode.OrderNotCancellable],
      ['cancel', 418, null, 400, ApiErrorCode.Rejected],
    ] as const)(
      '%s: %i %s is %i %s',
      (step, status, code, wantStatus, wantCode) => {
        expect(codeOf(refusal(step, status, code))).toEqual({
          status: wantStatus,
          code: wantCode,
        });
      },
    );

    it('reads a refusal about the phone at the details step as invalid_phone', () => {
      expect(
        codeOf(
          refusal(
            'kycDetails',
            400,
            'INVALID_PARAMETERS',
            'Phone number must be in international format',
          ),
        ).code,
      ).toBe(ApiErrorCode.InvalidPhone);
    });

    it('never relays the marketplace’s text', () => {
      const error = refusal(
        'order',
        400,
        'INVALID_PARAMETERS',
        'payer@example.com 20123456786 El Dorado',
      );
      const body = JSON.stringify(error.getResponse());
      expect(body).not.toContain('payer@example.com');
      expect(body).not.toContain('20123456786');
      expect(body).not.toMatch(/dorado/i);
    });
  });
});
