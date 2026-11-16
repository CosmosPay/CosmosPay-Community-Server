import { PaymentReceiptsService } from '@/payment-intents/payment-receipts.service';
import { WebhookEventPayload } from '@/webhooks/webhook-events';

const INTENT = {
  id: 'pi_1',
  consumerId: 'c1',
  chain: 'base',
  amount: '25' as string | null,
  asset: 'USDC',
  msg: 'Order #24',
  txHash: '0xpayout',
  updatedAt: new Date('2026-11-17T12:00:00.000Z'),
  paidFrom: null as unknown,
  payerEmail: 'link-payer@example.com' as string | null,
  payerLang: 'es' as string | null,
};

function build(
  options: {
    claimed?: number;
    intent?: Partial<typeof INTENT>;
    deposit?: unknown;
    configured?: boolean;
    sendFails?: boolean;
  } = {},
) {
  const sql: string[] = [];
  const prisma: any = {
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
    },
    paymentDeposit: {
      findUnique: jest.fn().mockResolvedValue(options.deposit ?? null),
    },
  };
  const mailer = {
    configured: options.configured ?? true,
    send: options.sendFails
      ? jest.fn().mockRejectedValue(new Error('down'))
      : jest.fn().mockResolvedValue(undefined),
  };
  const customers = { linkPayerEmail: jest.fn().mockResolvedValue(undefined) };
  const service = new PaymentReceiptsService(
    prisma,
    mailer as never,
    customers as never,
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
    expect(message.text).toContain('Order #24');
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
        payerEmail: 'deposit-payer@example.com',
        payerLang: 'en',
        amountOutPaid: '25',
        amountOut: '25',
      },
    });
    await service.send('pi_1');
    const message = mailer.send.mock.calls[0][0];
    expect(message.to).toBe('deposit-payer@example.com');
    expect(message.subject).toBe('Your payment receipt');
    expect(message.text).toContain('25.28 USDT (Tron)');
  });

  it('sends nothing when another replica holds the claim or it went out already', async () => {
    const { service, mailer, prisma } = build({ claimed: 0 });
    await expect(service.send('pi_1')).resolves.toBe(false);
    expect(prisma.paymentIntent.findUnique).not.toHaveBeenCalled();
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('sends nothing for a payment with no email (paid outside the checkout)', async () => {
    const { service, mailer } = build({ intent: { payerEmail: null } });
    await expect(service.send('pi_1')).resolves.toBe(false);
    expect(mailer.send).not.toHaveBeenCalled();
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
