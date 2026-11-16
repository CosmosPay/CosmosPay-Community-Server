import {
  PAYMENT_RECEIPT_MAX_PER_MERCHANT,
  PAYMENT_RECEIPT_MAX_PER_RECIPIENT,
} from '@/payment-intents/payment-intents.constants';
import { PaymentReceiptsService } from '@/payment-intents/payment-receipts.service';
import { WebhookEventPayload } from '@/webhooks/webhook-events';

const INTENT = {
  id: 'pi_1',
  consumerId: 'c1',
  chain: 'base',
  network: 'public',
  amount: '25' as string | null,
  asset: 'USDC',
  msg: 'Order #24' as string | null,
  txHash: '0xb7f1c3a2d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d',
  updatedAt: new Date('2026-11-17T12:00:00.000Z'),
  paidFrom: null as unknown,
};

type Session = {
  email: string;
  lang: string;
  sentAt: Date | null;
  createdAt: Date;
};
const at = (minute: number) =>
  new Date(`2026-11-17T11:${String(minute).padStart(2, '0')}:00.000Z`);
/* One checkout session gave an email (the common case). */
const ONE_SESSION: Session[] = [
  {
    email: 'link-payer@example.com',
    lang: 'es',
    sentAt: null,
    createdAt: at(1),
  },
];

function build(
  options: {
    claimed?: number;
    intent?: Partial<typeof INTENT>;
    deposit?: unknown;
    sessions?: Session[];
    configured?: boolean;
    sendFails?: boolean;
    /** Receipts already booked in the window: to this recipient, by this merchant. */
    sentToRecipient?: number;
    sentByMerchant?: number;
  } = {},
) {
  const sql: string[] = [];
  const prisma: any = {
    $transaction: jest.fn((work: (tx: unknown) => Promise<unknown>) =>
      work(prisma),
    ),
    $executeRaw: jest.fn((strings: TemplateStringsArray) => {
      const text = strings.join('?');
      sql.push(text);
      return Promise.resolve(
        text.includes('"receiptClaimedAt" = ?') && text.includes('IS NULL OR')
          ? (options.claimed ?? 1)
          : 1,
      );
    }),
    paymentIntent: {
      findUnique: jest.fn().mockResolvedValue({ ...INTENT, ...options.intent }),
      count: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          'receiptTo' in where
            ? (options.sentToRecipient ?? 0)
            : (options.sentByMerchant ?? 0),
        ),
      ),
    },
    paymentDeposit: {
      findUnique: jest.fn().mockResolvedValue(options.deposit ?? null),
    },
    paymentPayerSession: {
      findMany: jest.fn().mockResolvedValue(options.sessions ?? ONE_SESSION),
    },
  };
  const mailer = {
    configured: options.configured ?? true,
    send: options.sendFails
      ? jest.fn().mockRejectedValue(new Error('down'))
      : jest.fn().mockResolvedValue(undefined),
  };
  const customers = { linkPayerEmail: jest.fn().mockResolvedValue(undefined) };
  const config = {
    get: () => ({ checkoutUrl: 'https://payments.cosmospay.lat' }),
  };
  const service = new PaymentReceiptsService(
    prisma,
    mailer as never,
    customers as never,
    config as never,
  );
  return { service, prisma, mailer, customers, sql };
}

describe('PaymentReceiptsService', () => {
  it('sends the receipt in the checkout language and links the customer by email', async () => {
    const { service, mailer, customers, sql } = build();
    await expect(service.send('pi_1')).resolves.toBe(true);

    const message = mailer.send.mock.calls[0][0];
    expect(message.to).toBe('link-payer@example.com');
    expect(message.subject).toBe('Tu comprobante de pago');
    expect(message.text).toContain('25 USDC');
    expect(message.text).toContain('Base');
    // Only what this service generated: its own page and the explorer's.
    expect(message.html).toContain(
      'href="https://payments.cosmospay.lat/pi_1"',
    );
    expect(message.html).toContain(
      `href="https://basescan.org/tx/${INTENT.txHash}"`,
    );
    expect(customers.linkPayerEmail).toHaveBeenCalledWith(
      'c1',
      'link-payer@example.com',
    );
    expect(sql.some((q) => q.includes('"receiptSentAt" = ?'))).toBe(true);
  });

  it("goes to the deposit's own email when a deposit settled the link", async () => {
    const { service, mailer } = build({
      intent: {
        amount: null,
        paidFrom: {
          depositId: 'dep_1',
          chain: 'tron',
          asset: 'USDT',
          contract: null,
          amount: '25.28',
        },
      },
      deposit: {
        payerSession: { email: 'deposit-payer@example.com', lang: 'en' },
        amountOutPaid: '25',
        amountOut: '25',
      },
      // Other sessions of the link never take a deposit's receipt.
      sessions: [
        {
          email: 'someone@example.com',
          lang: 'es',
          sentAt: at(9),
          createdAt: at(2),
        },
      ],
    });
    await service.send('pi_1');
    const message = mailer.send.mock.calls[0][0];
    expect(message.to).toBe('deposit-payer@example.com');
    expect(message.subject).toBe('Your payment receipt');
    expect(message.text).toContain('25.28 USDT (Tron)');
  });

  it("never carries the link's message: a URL a merchant wrote there never reaches the email", async () => {
    const { service, mailer } = build({
      intent: {
        msg: 'Your account is locked: verify at https://evil.example/login or www.evil.example',
      },
    });
    await service.send('pi_1');
    const message = mailer.send.mock.calls[0][0];
    for (const part of [message.subject, message.html, message.text]) {
      expect(part).not.toContain('evil.example');
      expect(part).not.toContain('locked');
    }
    const hrefs = [...message.html.matchAll(/href="([^"]*)"/g)].map(
      (m: RegExpMatchArray) => new URL(m[1]).host,
    );
    expect(hrefs).toEqual(['payments.cosmospay.lat', 'basescan.org']);
  });

  it('holds a receipt once its recipient had its day of receipts, and books one under the limit', async () => {
    const held = build({ sentToRecipient: PAYMENT_RECEIPT_MAX_PER_RECIPIENT });
    await expect(held.service.send('pi_1')).resolves.toBe(false);
    expect(held.mailer.send).not.toHaveBeenCalled();
    // Held, not dropped: the claim stays (the sweeper asks again after its
    // lease) and nothing is marked sent.
    expect(held.sql.some((q) => q.includes('"receiptClaimedAt" = NULL'))).toBe(
      false,
    );
    expect(held.sql.some((q) => q.includes('"receiptSentAt" = ?'))).toBe(false);
    // The count is per address across every merchant, under that address's lock.
    expect(held.prisma.paymentIntent.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ receiptTo: 'link-payer@example.com' }),
    });
    expect(held.sql.some((q) => q.includes('pg_advisory_xact_lock'))).toBe(
      true,
    );

    const under = build({
      sentToRecipient: PAYMENT_RECEIPT_MAX_PER_RECIPIENT - 1,
    });
    await expect(under.service.send('pi_1')).resolves.toBe(true);
    expect(
      under.sql.some(
        (q) => q.includes('"receiptTo" = ?') && !q.includes('updatedAt'),
      ),
    ).toBe(true);
  });

  it('holds a receipt once its merchant sent its day of receipts', async () => {
    const { service, mailer } = build({
      sentByMerchant: PAYMENT_RECEIPT_MAX_PER_MERCHANT,
    });
    await expect(service.send('pi_1')).resolves.toBe(false);
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('sends nothing when another replica holds the claim or it went out already', async () => {
    const { service, mailer, prisma } = build({ claimed: 0 });
    await expect(service.send('pi_1')).resolves.toBe(false);
    expect(prisma.paymentIntent.findUnique).not.toHaveBeenCalled();
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('sends nothing for a payment with no email (paid outside the checkout), once', async () => {
    const { service, mailer, sql } = build({ sessions: [] });
    await expect(service.send('pi_1')).resolves.toBe(false);
    expect(mailer.send).not.toHaveBeenCalled();
    expect(sql.some((q) => q.includes('"receiptSkippedAt" = ?'))).toBe(true);
  });

  it('goes to the checkout session that reported `sent` last, whoever else gave an email', async () => {
    const { service, mailer, customers } = build({
      sessions: [
        {
          email: 'early@example.com',
          lang: 'en',
          sentAt: at(3),
          createdAt: at(1),
        },
        {
          email: 'payer@example.com',
          lang: 'pt',
          sentAt: at(8),
          createdAt: at(2),
        },
        {
          email: 'stranger@example.com',
          lang: 'en',
          sentAt: null,
          createdAt: at(9),
        },
      ],
    });
    await expect(service.send('pi_1')).resolves.toBe(true);
    const message = mailer.send.mock.calls[0][0];
    expect(message.to).toBe('payer@example.com');
    expect(message.subject).toBe('Seu comprovante de pagamento');
    expect(customers.linkPayerEmail).toHaveBeenCalledWith(
      'c1',
      'payer@example.com',
    );
  });

  it('sends nothing and links no customer when the payer cannot be told apart', async () => {
    const { service, mailer, customers, sql } = build({
      sessions: [
        {
          email: 'payer@example.com',
          lang: 'en',
          sentAt: null,
          createdAt: at(1),
        },
        {
          email: 'stranger@example.com',
          lang: 'en',
          sentAt: null,
          createdAt: at(2),
        },
      ],
    });
    await expect(service.send('pi_1')).resolves.toBe(false);
    expect(mailer.send).not.toHaveBeenCalled();
    expect(customers.linkPayerEmail).not.toHaveBeenCalled();
    // Decided once: the sweeper does not ask again.
    expect(sql.some((q) => q.includes('"receiptSkippedAt" = ?'))).toBe(true);
  });

  it('sends to the one email when every session gave the same (a payer who reopened the page)', async () => {
    const { service, mailer } = build({
      sessions: [
        {
          email: 'payer@example.com',
          lang: 'en',
          sentAt: null,
          createdAt: at(1),
        },
        {
          email: 'Payer@Example.com',
          lang: 'fr',
          sentAt: null,
          createdAt: at(5),
        },
      ],
    });
    await expect(service.send('pi_1')).resolves.toBe(true);
    const message = mailer.send.mock.calls[0][0];
    expect(message.to).toBe('payer@example.com');
    expect(message.subject).toBe('Votre reçu de paiement');
  });

  it('gives the claim back when there is no mail sender or it fails, for the sweeper to retry', async () => {
    for (const options of [{ configured: false }, { sendFails: true }]) {
      const { service, sql } = build(options);
      await service.send('pi_1').catch(() => undefined);
      expect(sql.some((q) => q.includes('"receiptClaimedAt" = NULL'))).toBe(
        true,
      );
      expect(sql.some((q) => q.includes('"receiptSentAt" = ?'))).toBe(false);
    }
  });

  it('answers the settlement event only', async () => {
    const { service, mailer } = build();
    await service.onEvent(
      new WebhookEventPayload('u', 'PAYMENT_INTENT_UPDATED', { id: 'pi_1' }),
    );
    expect(mailer.send).not.toHaveBeenCalled();
    await service.onEvent(
      new WebhookEventPayload('u', 'PAYMENT_INTENT_SUCCEEDED', { id: 'pi_1' }),
    );
    expect(mailer.send).toHaveBeenCalledTimes(1);
  });
});
