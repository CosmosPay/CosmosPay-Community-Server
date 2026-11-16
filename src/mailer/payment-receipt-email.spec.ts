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
  explorerUrl: 'https://basescan.org/tx/0xabc',
  paymentUrl: 'https://payments.cosmospay.lat/cmh4x2k9a0001l70g8v5q3z2w',
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

  it('links only the payment page and the explorer, and only https ones', () => {
    const email = renderPaymentReceiptEmail({ ...FIELDS, lang: 'en' });
    const hrefs = [...email.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([
      'https://payments.cosmospay.lat/cmh4x2k9a0001l70g8v5q3z2w',
      'https://basescan.org/tx/0xabc',
    ]);
    const unsafe = renderPaymentReceiptEmail({
      ...FIELDS,
      lang: 'en',
      paymentUrl: 'javascript:alert(1)',
      explorerUrl: 'http://basescan.org/tx/0xabc',
    });
    expect(unsafe.html).not.toContain('href=');
    expect(unsafe.text).not.toContain('javascript:');
  });

  it('leaves out what it does not know', () => {
    const email = renderPaymentReceiptEmail({
      ...FIELDS,
      lang: 'en',
      amount: null,
      txHash: null,
      explorerUrl: null,
      paymentUrl: null,
      paidFrom: null,
    });
    expect(email.text).not.toContain('Amount');
    expect(email.text).not.toContain('Transaction');
    expect(email.text).not.toContain('Paid from');
  });
});
