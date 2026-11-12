import { Logger } from '@nestjs/common';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { ApiErrorCode } from '@/common/errors/api-error';
import type { EldoradoClient } from '@/native-plugins/eldorado/eldorado.client';
import { P2pOrderEventsService } from '@/native-plugins/eldorado/p2p-order-events.service';
import { P2pWebhookKeys } from '@/native-plugins/eldorado/p2p-webhook-keys.service';
import { webhookBodyHash } from '@/native-plugins/eldorado/p2p-webhook-signature';

const RECIPIENT = '0x52908400098527886E0F7030069857D2E4169EE7';
const USDT0 = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
const TX = `0x${'cd'.repeat(32)}`;

type Row = Record<string, unknown>;

/** A table in memory: equality and `null` filters, each statement whole. */
function table(rows: Row[]) {
  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([field, want]) => row[field] === want);
  return {
    rows,
    findFirst: jest.fn(({ where }: { where: Row }) => {
      const row = rows.find((r) => matches(r, where));
      return Promise.resolve(row ? { ...row } : null);
    }),
    findUnique: jest.fn(({ where }: { where: Row }) => {
      const row = rows.find((r) => matches(r, where));
      return Promise.resolve(row ? { ...row } : null);
    }),
    updateMany: jest.fn(({ where, data }: { where: Row; data: Row }) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return Promise.resolve({ count: hit.length });
    }),
  };
}

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  return { privateKey, jwk: publicKey.export({ format: 'jwk' }) };
}

const mainnet = keyPair();
const sandbox = keyPair();
const stranger = keyPair();

/** A delivery as the marketplace sends it: the raw body, its hash, its signature. */
function delivery(body: unknown, signer: ReturnType<typeof keyPair> = mainnet) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const hash = webhookBodyHash(rawBody);
  return {
    rawBody,
    hash,
    signature: createSign('RSA-SHA256')
      .update(hash)
      .sign(signer.privateKey, 'base64'),
  };
}

/** One order of a session, in the documented shape, at `status`. */
function order(reference: string, status: string, extra: Row = {}) {
  return {
    event: 'ORDER_STATUS_CHANGED',
    order: {
      apiOrderId: `ord-${reference}`,
      orderStatus: status,
      type: 'BUY',
      externalReferenceId: reference,
      cryptoDetails: {
        recipientAddress: RECIPIENT.toLowerCase(),
        tokenAddress: USDT0.toLowerCase(),
        chainId: 42161,
      },
      // Lower case, as the marketplace may spell it: still the session's ARS.
      quote: {
        in: { amount: '16000', currency: 'ars' },
        out: { amount: '10' },
      },
      ...(status === 'COMPLETED'
        ? { transferInfo: { amountOut: '9.95', txHashDestination: TX } }
        : {}),
      ...extra,
    },
  };
}

function session(id: string, extra: Row = {}): Row {
  return {
    id,
    reference: `cp-${id}`,
    network: 'public',
    side: 'buy',
    address: RECIPIENT,
    chainId: 42161,
    tokenAddress: USDT0,
    currency: 'ARS',
    amount: '16000',
    paymentRequestId: 'creq1',
    providerOrderId: null,
    providerStatus: null,
    deliveredAmount: null,
    txHash: null,
    completedAt: null,
    ...extra,
  };
}

function setup(sessions: Row[], requestExtra: Row = {}) {
  const client = {
    webhookKeys: jest.fn((network: string) =>
      Promise.resolve({
        keys: [network === 'public' ? mainnet.jwk : sandbox.jwk],
      }),
    ),
  };
  const prisma = {
    p2pRampSession: table(sessions),
    p2pPaymentRequest: table([
      {
        id: 'creq1',
        status: 'open',
        expiresAt: new Date(Date.now() + 60_000),
        paidAt: null,
        paidAmount: null,
        paidTxHash: null,
        paidSessionId: null,
        ...requestExtra,
      },
    ]),
  };
  const service = new P2pOrderEventsService(
    prisma as never,
    new P2pWebhookKeys(client as unknown as EldoradoClient),
  );
  return {
    service,
    prisma,
    sessions: prisma.p2pRampSession.rows,
    request: prisma.p2pPaymentRequest.rows[0],
  };
}

describe('P2pOrderEventsService', () => {
  describe('verifying a delivery', () => {
    it('applies a delivery the marketplace signed', async () => {
      const { service, sessions } = setup([session('s1')]);

      await expect(
        service.receive(delivery(order('cp-s1', 'ACCEPTED'))),
      ).resolves.toEqual({ received: true });
      expect(sessions[0]).toMatchObject({
        providerStatus: 'ACCEPTED',
        providerOrderId: 'ord-cp-s1',
      });
    });

    it('refuses a tampered body, a wrong hash and a signature no published key made, applying nothing', async () => {
      const { service, prisma } = setup([session('s1')]);
      const good = delivery(order('cp-s1', 'COMPLETED'));
      const tampered = {
        ...good,
        rawBody: Buffer.from(
          good.rawBody
            .toString()
            .replace(RECIPIENT.toLowerCase(), `0x${'1'.repeat(40)}`),
        ),
      };
      const otherBodysHash = {
        ...good,
        hash: webhookBodyHash(Buffer.from('{}')),
      };
      const forged = delivery(order('cp-s1', 'COMPLETED'), stranger);

      for (const bad of [
        tampered,
        otherBodysHash,
        { ...good, hash: undefined },
        { ...good, signature: undefined },
        { ...good, rawBody: undefined },
        forged,
      ]) {
        await expect(service.receive(bad)).rejects.toMatchObject({
          code: ApiErrorCode.WebhookSignatureInvalid,
          status: 401,
        });
      }
      expect(prisma.p2pRampSession.findFirst).not.toHaveBeenCalled();
      expect(prisma.p2pRampSession.updateMany).not.toHaveBeenCalled();
    });

    it('lets a network’s key reach only that network’s sessions', async () => {
      const { service, sessions } = setup([session('s1')]);

      // Signed by the sandbox for a mainnet session: no session of the sandbox has it.
      await service.receive(delivery(order('cp-s1', 'COMPLETED'), sandbox));

      expect(sessions[0].providerStatus).toBeNull();
    });

    it('acknowledges a signed body it cannot read, or that names no session', async () => {
      const { service, prisma } = setup([session('s1')]);

      await expect(service.receive(delivery({ ping: true }))).resolves.toEqual({
        received: true,
      });
      await expect(
        service.receive(delivery(order('cp-unknown', 'COMPLETED'))),
      ).resolves.toEqual({ received: true });
      expect(prisma.p2pRampSession.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('what an order changes', () => {
    it('follows the order, completes once and never goes back', async () => {
      const { service, sessions, request } = setup([session('s1')]);

      await service.receive(delivery(order('cp-s1', 'ACCEPTED')));
      await service.receive(delivery(order('cp-s1', 'FIAT_PAID')));
      expect(sessions[0].providerStatus).toBe('FIAT_PAID');
      expect(request.status).toBe('open');

      await service.receive(delivery(order('cp-s1', 'COMPLETED')));
      expect(sessions[0]).toMatchObject({
        providerStatus: 'COMPLETED',
        deliveredAmount: '9.95',
        txHash: TX,
        completedAt: expect.any(Date),
      });
      expect(request).toMatchObject({
        status: 'paid',
        paidAt: expect.any(Date),
        paidAmount: '9.95',
        paidTxHash: TX,
        paidSessionId: 's1',
      });

      // A late event arrives after the completion.
      await service.receive(delivery(order('cp-s1', 'FIAT_RECEIVED')));
      expect(sessions[0].providerStatus).toBe('COMPLETED');
    });

    it('is idempotent: the same completion twice changes nothing the second time', async () => {
      const { service, sessions, request } = setup([session('s1')]);
      const completed = delivery(order('cp-s1', 'COMPLETED'));

      await service.receive(completed);
      const completedAt = sessions[0].completedAt;
      const paidAt = request.paidAt;
      await service.receive(completed);

      expect(sessions[0].completedAt).toBe(completedAt);
      expect(request.paidAt).toBe(paidAt);
    });

    it('records a completion that does not pay the request, but leaves the request open', async () => {
      const { service, sessions, request } = setup([
        session('s1'),
        session('s2'),
        session('s3'),
        session('s4'),
        session('s5'),
      ]);

      await service.receive(
        delivery(
          order('cp-s1', 'COMPLETED', {
            cryptoDetails: {
              recipientAddress: `0x${'1'.repeat(40)}`,
              tokenAddress: USDT0,
              chainId: 42161,
            },
          }),
        ),
      );
      await service.receive(
        delivery(
          order('cp-s2', 'COMPLETED', {
            quote: { in: { amount: '100', currency: 'ARS' } },
          }),
        ),
      );
      await service.receive(
        delivery(order('cp-s3', 'COMPLETED', { type: 'SELL' })),
      );
      // The payer switched the widget to a cheaper currency, same number.
      await service.receive(
        delivery(
          order('cp-s4', 'COMPLETED', {
            quote: { in: { amount: '16000', currency: 'COP' } },
          }),
        ),
      );
      await service.receive(
        delivery(
          order('cp-s5', 'COMPLETED', { quote: { in: { amount: '16000' } } }),
        ),
      );

      expect(sessions.map((s) => s.providerStatus)).toEqual([
        'COMPLETED',
        'COMPLETED',
        'COMPLETED',
        'COMPLETED',
        'COMPLETED',
      ]);
      expect(request).toMatchObject({ status: 'open', paidAt: null });
    });

    it('marks a request paid even after it expired or was cancelled: the money arrived', async () => {
      for (const extra of [
        { expiresAt: new Date(Date.now() - 60_000) },
        { status: 'cancelled', cancelledAt: new Date() },
      ]) {
        const { service, request } = setup([session('s1')], extra);

        await service.receive(delivery(order('cp-s1', 'COMPLETED')));

        expect(request).toMatchObject({ status: 'paid', paidSessionId: 's1' });
      }
    });

    it('lets the first completion win when two purchases pay one request', async () => {
      const { service, request } = setup([session('s1'), session('s2')]);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

      await service.receive(delivery(order('cp-s2', 'COMPLETED')));
      await service.receive(delivery(order('cp-s1', 'COMPLETED')));

      expect(request).toMatchObject({ paidSessionId: 's2', paidMethod: 'p2p' });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'was already paid (p2p): session s1 also completed',
        ),
      );
      warn.mockRestore();
    });

    it('pays a request a bank transfer is processing: the first completion wins, and the transfer is the one logged later', async () => {
      const { service, request } = setup([session('s1')], {
        status: 'processing',
      });

      await service.receive(delivery(order('cp-s1', 'COMPLETED')));

      expect(request).toMatchObject({
        status: 'paid',
        paidMethod: 'p2p',
        paidSessionId: 's1',
        paidAmount: '9.95',
      });
    });

    it('does not log a redelivery of the completion that paid the request', async () => {
      const { service } = setup([session('s1')]);
      const completed = delivery(order('cp-s1', 'COMPLETED'));
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

      await service.receive(completed);
      await service.receive(completed);

      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('does not pay a request another rail already paid', async () => {
      const paidAt = new Date('2026-11-12T12:00:00.000Z');
      const { service, request } = setup([session('s1')], {
        status: 'paid',
        paidAt,
        paidMethod: 'transfer',
        paidAmount: '9.90',
      });
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

      await service.receive(delivery(order('cp-s1', 'COMPLETED')));

      expect(request).toMatchObject({
        paidAt,
        paidMethod: 'transfer',
        paidAmount: '9.90',
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('was already paid (transfer)'),
      );
      warn.mockRestore();
    });

    it('records a session with no payment request without touching any request', async () => {
      const { service, prisma, sessions } = setup([
        session('s1', { paymentRequestId: null }),
      ]);

      await service.receive(delivery(order('cp-s1', 'COMPLETED')));

      expect(sessions[0].providerStatus).toBe('COMPLETED');
      expect(prisma.p2pPaymentRequest.updateMany).not.toHaveBeenCalled();
    });
  });
});
