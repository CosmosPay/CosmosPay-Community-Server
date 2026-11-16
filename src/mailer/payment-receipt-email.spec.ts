import { providerNamesIn } from '@/common/provider-names';
import {
  type ReceiptEmailLang,
  renderPaymentReceiptEmail,
} from '@/mailer/payment-receipt-email';

const FIELDS = {
  amount: '25',
  asset: 'USDC',
  network: 'Base',
  paymentId: 'cmh4x2k9a0001l70g8v5q3z2w',
  txHash: '0xabc',
  description: 'Order <b>#24</b>',
  paidAt: new Date('2026-11-17T12:00:00.000Z'),
  paidFrom: { amount: '25.28', asset: 'USDT', network: 'Tron' },
};

const LANGS: ReceiptEmailLang[] = ['en', 'es', 'pt', 'fr', 'de', 'hi', 'zh'];

describe('renderPaymentReceiptEmail', () => {
  it.each(LANGS)('writes a full receipt in %s, naming no provider', (lang) => {
    const email = renderPaymentReceiptEmail({ ...FIELDS, lang });
    expect(email.subject.length).toBeGreaterThan(0);
    for (const part of [email.html, email.text]) {
      expect(part).toContain('25 USDC');
      expect(part).toContain('Base');
      expect(part).toContain('cmh4x2k9a0001l70g8v5q3z2w');
      expect(part).toContain('25.28 USDT (Tron)');
      expect(providerNamesIn(part)).toEqual([]);
      expect(part).not.toMatch(/escrow/i);
      expect(part).not.toContain('—');
    }
    expect(email.html).toContain(`lang="${lang}"`);
  });

  it('escapes what a merchant or payer wrote, and links nothing', () => {
    const email = renderPaymentReceiptEmail({ ...FIELDS, lang: 'en' });
    expect(email.html).not.toContain('<b>#24</b>');
    expect(email.html).toContain('Order &lt;b&gt;#24&lt;/b&gt;');
    expect(email.html).not.toContain('href=');
  });

  it('leaves out what it does not know', () => {
    const email = renderPaymentReceiptEmail({
      ...FIELDS,
      lang: 'en',
      amount: null,
      txHash: null,
      description: null,
      paidFrom: null,
    });
    expect(email.text).not.toContain('Amount');
    expect(email.text).not.toContain('Transaction');
    expect(email.text).not.toContain('Paid from');
  });
});
