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
  // The account that paid, as the settlement recorded it.
  source: '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed' as string | null,
  // When its transaction closed on-chain: proofs must come before.
  paidOnChainAt: new Date('2026-11-17T11:30:00.000Z') as Date | null,
};

type Session = {
  email: string;
  lang: string;
  walletAddress: string | null;
  walletTxHash: string | null;
  provenAt: Date | null;
};
const at = (minute: number) =>
  new Date(`2026-11-17T11:${String(minute).padStart(2, '0')}:00.000Z`);
const session = (
  email: string,
  lang = 'en',
  proof: Partial<
    Pick<Session, 'walletAddress' | 'walletTxHash' | 'provenAt'>
  > = {},
): Session => ({
  email,
  lang,
  walletAddress: proof.walletAddress ?? null,
  walletTxHash: proof.walletTxHash ?? null,
  provenAt: proof.provenAt ?? null,
});
/* One checkout session gave an email and its wallet's transaction is the settlement's. */
const ONE_SESSION: Session[] = [
  session('link-payer@example.com', 'es', {
    walletTxHash: INTENT.txHash,
    provenAt: at(1),
  }),
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

  it("goes to the deposit's own session, and links it, when a deposit settled the link", async () => {
    const { service, mailer, customers } = build({
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
      // Other sessions of the link never take a deposit's receipt, proof or not.
      sessions: [
        session('someone@example.com', 'es', {
          walletTxHash: INTENT.txHash,
          provenAt: at(2),
        }),
      ],
    });
    await service.send('pi_1');
    const message = mailer.send.mock.calls[0][0];
    expect(message.to).toBe('deposit-payer@example.com');
    // The deposit's own session is the proof: its payer is linked.
    expect(customers.linkPayerEmail).toHaveBeenCalledWith(
      'c1',
      'deposit-payer@example.com',
    );
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

  it('a matching transaction wins over any `sent` report, and links the payer', async () => {
    const { service, mailer, customers } = build({
      sessions: [
        // Reported `sent` later, with no proof: informational only.
        session('loud@example.com', 'en', { provenAt: null }),
        session('payer@example.com', 'pt', {
          walletTxHash: INTENT.txHash.toUpperCase().replace('0X', '0x'),
          provenAt: at(2),
        }),
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

  it("goes to the session whose wallet account is the settlement's source", async () => {
    const { service, mailer } = build({
      sessions: [
        session('other@example.com'),
        session('payer@example.com', 'en', {
          walletAddress: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
          provenAt: at(3),
        }),
      ],
    });
    await expect(service.send('pi_1')).resolves.toBe(true);
    expect(mailer.send.mock.calls[0][0].to).toBe('payer@example.com');
  });

  it('with two or more sessions and no proof matching, sends nothing and links no customer', async () => {
    const { service, mailer, customers, sql } = build({
      sessions: [
        // This one reported `sent`, but `sent` proves nothing.
        session('loud@example.com', 'en', {
          walletTxHash:
            '0x1111111111111111111111111111111111111111111111111111111111111111',
          provenAt: at(1),
        }),
        session('payer@example.com'),
      ],
    });
    await expect(service.send('pi_1')).resolves.toBe(false);
    expect(mailer.send).not.toHaveBeenCalled();
    expect(customers.linkPayerEmail).not.toHaveBeenCalled();
    // Decided once: the sweeper does not ask again.
    expect(sql.some((q) => q.includes('"receiptSkippedAt" = ?'))).toBe(true);
  });

  it('a proof registered after the transaction closed on-chain does not count', async () => {
    const { service, mailer, customers } = build({
      sessions: [
        session('copycat@example.com', 'en', {
          walletTxHash: INTENT.txHash,
          provenAt: at(31),
        }),
        session('payer@example.com'),
      ],
    });
    await expect(service.send('pi_1')).resolves.toBe(false);
    expect(mailer.send).not.toHaveBeenCalled();
    expect(customers.linkPayerEmail).not.toHaveBeenCalled();
  });

  it('two sessions matching one proof are unproven: the single-session rule decides', async () => {
    const both = build({
      sessions: [
        session('a@example.com', 'en', {
          walletTxHash: INTENT.txHash,
          provenAt: at(2),
        }),
        session('b@example.com', 'en', {
          walletTxHash: INTENT.txHash,
          provenAt: at(3),
        }),
      ],
    });
    await expect(both.service.send('pi_1')).resolves.toBe(false);
    expect(both.mailer.send).not.toHaveBeenCalled();
    expect(both.customers.linkPayerEmail).not.toHaveBeenCalled();
  });

  it('a single unproven session gets the receipt but no customer link', async () => {
    const { service, mailer, customers } = build({
      sessions: [session('payer@example.com', 'fr')],
    });
    await expect(service.send('pi_1')).resolves.toBe(true);
    const message = mailer.send.mock.calls[0][0];
    expect(message.to).toBe('payer@example.com');
    expect(message.subject).toBe('Votre reçu de paiement');
    expect(customers.linkPayerEmail).not.toHaveBeenCalled();
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
