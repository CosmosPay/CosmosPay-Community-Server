import type { RenderedEmail } from '@/mailer/wallet-emails';

/** The languages a payment receipt is written in. */
export type ReceiptEmailLang = 'en' | 'es' | 'pt' | 'fr' | 'de' | 'hi' | 'zh';

/**
 * What a receipt says: what was paid, where, when, and how to look it up. Only
 * facts this service generates: the receipt goes to an address nobody
 * verified, so nothing a merchant or payer wrote (a link's message, a name)
 * ever reaches it.
 */
export interface PaymentReceiptFields {
  lang: ReceiptEmailLang;
  /** Decimal, or null when the payment had no fixed amount we can state. */
  amount: string | null;
  /** The asset's ticker (USDC, XLM, ETH, ...). */
  asset: string;
  /** The network's display name (Base, Stellar, Bitcoin, ...). */
  network: string;
  /** The payment's id: what the merchant finds it by. */
  paymentId: string;
  /** The settling transaction on the payment's network, when there is one. */
  txHash: string | null;
  /** That transaction on the network's explorer (built here), or null. */
  explorerUrl: string | null;
  /** The payment's own page on the hosted checkout (built here), or null. */
  paymentUrl: string | null;
  paidAt: Date;
  /** Where the payer sent from, for a payment from another network. */
  paidFrom: { amount: string; asset: string; network: string } | null;
}

interface ReceiptCopy {
  subject: string;
  eyebrow: string;
  heading: string;
  lead: string;
  amount: string;
  network: string;
  paidFrom: string;
  date: string;
  paymentId: string;
  transaction: string;
  view: string;
  explorer: string;
  footnote: string;
}

/**
 * The receipt's words, per language. No provider is named and nothing here
 * promises more than happened: the payment was received by the merchant on
 * the network shown. The footnote says the address was typed by the payer,
 * because it was never verified.
 */
const COPY: Record<ReceiptEmailLang, ReceiptCopy> = {
  en: {
    subject: 'Your payment receipt',
    eyebrow: 'Payment received',
    heading: 'Thank you, your payment went through',
    lead: 'This is your receipt. Keep it for your records.',
    amount: 'Amount',
    network: 'Network',
    paidFrom: 'Paid from',
    date: 'Date',
    paymentId: 'Payment ID',
    transaction: 'Transaction',
    view: 'View this payment',
    explorer: 'View the transaction',
    footnote:
      'You received this email because this address was entered at checkout. If you did not make this payment, you can ignore it.',
  },
  es: {
    subject: 'Tu comprobante de pago',
    eyebrow: 'Pago recibido',
    heading: 'Gracias, tu pago se completó',
    lead: 'Este es tu comprobante. Guárdalo para tus registros.',
    amount: 'Monto',
    network: 'Red',
    paidFrom: 'Pagado desde',
    date: 'Fecha',
    paymentId: 'ID del pago',
    transaction: 'Transacción',
    view: 'Ver este pago',
    explorer: 'Ver la transacción',
    footnote:
      'Recibiste este correo porque esta dirección se ingresó en el checkout. Si no hiciste este pago, puedes ignorarlo.',
  },
  pt: {
    subject: 'Seu comprovante de pagamento',
    eyebrow: 'Pagamento recebido',
    heading: 'Obrigado, seu pagamento foi concluído',
    lead: 'Este é o seu comprovante. Guarde-o para seus registros.',
    amount: 'Valor',
    network: 'Rede',
    paidFrom: 'Pago a partir de',
    date: 'Data',
    paymentId: 'ID do pagamento',
    transaction: 'Transação',
    view: 'Ver este pagamento',
    explorer: 'Ver a transação',
    footnote:
      'Você recebeu este e-mail porque este endereço foi informado no checkout. Se você não fez este pagamento, pode ignorá-lo.',
  },
  fr: {
    subject: 'Votre reçu de paiement',
    eyebrow: 'Paiement reçu',
    heading: 'Merci, votre paiement a abouti',
    lead: 'Voici votre reçu. Conservez-le pour vos dossiers.',
    amount: 'Montant',
    network: 'Réseau',
    paidFrom: 'Payé depuis',
    date: 'Date',
    paymentId: 'ID du paiement',
    transaction: 'Transaction',
    view: 'Voir ce paiement',
    explorer: 'Voir la transaction',
    footnote:
      "Vous recevez cet e-mail parce que cette adresse a été saisie lors du paiement. Si vous n'avez pas effectué ce paiement, vous pouvez l'ignorer.",
  },
  de: {
    subject: 'Ihre Zahlungsbestätigung',
    eyebrow: 'Zahlung erhalten',
    heading: 'Danke, Ihre Zahlung ist eingegangen',
    lead: 'Dies ist Ihr Beleg. Bewahren Sie ihn für Ihre Unterlagen auf.',
    amount: 'Betrag',
    network: 'Netzwerk',
    paidFrom: 'Bezahlt von',
    date: 'Datum',
    paymentId: 'Zahlungs-ID',
    transaction: 'Transaktion',
    view: 'Diese Zahlung ansehen',
    explorer: 'Transaktion ansehen',
    footnote:
      'Sie erhalten diese E-Mail, weil diese Adresse an der Kasse eingegeben wurde. Wenn Sie diese Zahlung nicht getätigt haben, können Sie sie ignorieren.',
  },
  hi: {
    subject: 'आपके भुगतान की रसीद',
    eyebrow: 'भुगतान प्राप्त हुआ',
    heading: 'धन्यवाद, आपका भुगतान पूरा हो गया',
    lead: 'यह आपकी रसीद है। इसे अपने रिकॉर्ड के लिए रखें।',
    amount: 'राशि',
    network: 'नेटवर्क',
    paidFrom: 'यहाँ से भुगतान',
    date: 'तारीख',
    paymentId: 'भुगतान ID',
    transaction: 'ट्रांज़ैक्शन',
    view: 'यह भुगतान देखें',
    explorer: 'ट्रांज़ैक्शन देखें',
    footnote:
      'आपको यह ईमेल इसलिए मिला क्योंकि चेकआउट में यह पता दर्ज किया गया था। अगर यह भुगतान आपने नहीं किया, तो आप इसे अनदेखा कर सकते हैं।',
  },
  zh: {
    subject: '您的付款收据',
    eyebrow: '已收到付款',
    heading: '谢谢，您的付款已完成',
    lead: '这是您的收据，请妥善保存。',
    amount: '金额',
    network: '网络',
    paidFrom: '付款来源',
    date: '日期',
    paymentId: '付款 ID',
    transaction: '交易',
    view: '查看此付款',
    explorer: '查看交易',
    footnote:
      '您收到此邮件，是因为结账时填写了此邮箱地址。如果这笔付款不是您本人所付，可以忽略此邮件。',
  },
};

/** The locale a date is written in, per receipt language. */
const DATE_LOCALES: Record<ReceiptEmailLang, string> = {
  en: 'en-US',
  es: 'es-AR',
  pt: 'pt-BR',
  fr: 'fr-FR',
  de: 'de-DE',
  hi: 'hi-IN',
  zh: 'zh-CN',
};

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] as string,
  );
}

/** An https URL with no credentials, or null: the only links a receipt carries. */
function safeLink(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

/**
 * A payment receipt, in the payer's checkout language: a table of what was
 * paid and the ids to look it up by, then two links this service built (the
 * payment's page on the hosted checkout, the transaction on its explorer).
 * Every value is escaped.
 */
export function renderPaymentReceiptEmail(
  v: PaymentReceiptFields,
): RenderedEmail {
  const t = COPY[v.lang] ?? COPY.en;
  const when = v.paidAt.toLocaleString(DATE_LOCALES[v.lang] ?? 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
  const rows: [string, string][] = [
    ...(v.amount !== null
      ? [[t.amount, `${v.amount} ${v.asset}`] as [string, string]]
      : []),
    [t.network, v.network],
    ...(v.paidFrom
      ? [
          [
            t.paidFrom,
            `${v.paidFrom.amount} ${v.paidFrom.asset} (${v.paidFrom.network})`,
          ] as [string, string],
        ]
      : []),
    [t.date, `${when} UTC`],
    [t.paymentId, v.paymentId],
    ...(v.txHash ? [[t.transaction, v.txHash] as [string, string]] : []),
  ];

  const links = [
    [t.view, safeLink(v.paymentUrl)],
    [t.explorer, safeLink(v.explorerUrl)],
  ].filter((l): l is [string, string] => l[1] !== null);

  const tableRows = rows
    .map(
      ([label, value]) =>
        '<tr>' +
        `<td style="padding:8px 0;color:#8a89a0;font-size:13px;vertical-align:top;width:38%;">${escapeHtml(label)}</td>` +
        `<td style="padding:8px 0;color:#13112a;font-size:14px;word-break:break-all;">${escapeHtml(value)}</td>` +
        '</tr>',
    )
    .join('');

  const html =
    `<!doctype html><html lang="${v.lang}"><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    `<title>${escapeHtml(t.subject)}</title></head>` +
    `<body style="margin:0;background:#f6f6fb;font-family:'Poppins',Arial,sans-serif;color:#1a1830;">` +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 0;"><tr><td align="center">' +
    '<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #ececf3;">' +
    '<tr><td style="padding:30px 34px 28px;">' +
    `<div style="font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#6b47ff;font-weight:600;">${escapeHtml(t.eyebrow)}</div>` +
    `<h1 style="font-size:22px;margin:14px 0 6px;color:#13112a;">${escapeHtml(t.heading)}</h1>` +
    `<p style="font-size:15px;line-height:1.6;color:#4a4862;margin:0 0 18px;">${escapeHtml(t.lead)}</p>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${tableRows}</table>` +
    links
      .map(
        ([label, url]) =>
          `<p style="font-size:14px;margin:14px 0 0;"><a href="${escapeHtml(url)}" style="color:#13112a;text-decoration:underline;">${escapeHtml(label)}</a></p>`,
      )
      .join('') +
    `<p style="font-size:13px;line-height:1.6;color:#8a89a0;margin:22px 0 0;">${escapeHtml(t.footnote)}</p>` +
    '</td></tr></table></td></tr></table></body></html>';

  const text = [
    t.heading,
    '',
    t.lead,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    ...(links.length
      ? ['', ...links.map(([label, url]) => `${label}: ${url}`)]
      : []),
    '',
    t.footnote,
  ].join('\n');

  return { subject: t.subject, html, text };
}
