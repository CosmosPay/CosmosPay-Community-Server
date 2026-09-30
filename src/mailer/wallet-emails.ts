import { FALLBACK_CODE_MINUTES } from '@/mailer/mailer.constants';

/**
 * The two emails this service sends: the wallet's sign-in code and a recovery
 * server's code. Pure functions, so a spec can render them without a container.
 *
 * Both used to be rendered and sent by the developer platform, which this
 * service posted each code to. That put the platform in the path of every
 * sign-in and every recovery, and it is the piece that goes down; the copy moved
 * here unchanged.
 *
 * The code never goes in the subject in either: a subject is what a locked
 * phone shows on its notification.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] as string,
  );
}

/** Minutes left until `expiresAt`, for the copy only; never below one. */
export function minutesUntil(expiresAt: Date, now = Date.now()): number {
  const at = expiresAt.getTime();
  return Number.isFinite(at)
    ? Math.max(1, Math.round((at - now) / 60_000))
    : FALLBACK_CODE_MINUTES;
}

const CARD_OPEN =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
  '<title>Cosmos Pay</title></head>' +
  `<body style="margin:0;background:#f6f6fb;font-family:'Poppins',Arial,sans-serif;color:#1a1830;">` +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 0;"><tr><td align="center">' +
  '<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #ececf3;">' +
  '<tr><td style="padding:30px 34px 28px;">';

const CARD_CLOSE = '</td></tr></table></td></tr></table></body></html>';

function codeBox(code: string): string {
  return (
    '<div style="font-size:34px;font-weight:700;letter-spacing:.32em;text-align:center;background:#f3f1ff;' +
    `color:#13112a;padding:18px 0;border-radius:12px;border:1px solid #e4def9;">${escapeHtml(code)}</div>`
  );
}

function eyebrow(label: string): string {
  return `<div style="font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#6b47ff;font-weight:600;">${label}</div>`;
}

function heading(text: string): string {
  return `<h1 style="font-size:22px;margin:14px 0 6px;color:#13112a;">${text}</h1>`;
}

function lead(html: string): string {
  return `<p style="font-size:15px;line-height:1.6;color:#4a4862;margin:0 0 22px;">${html}</p>`;
}

function footnote(html: string): string {
  return `<p style="font-size:13px;line-height:1.6;color:#8a89a0;margin:22px 0 0;">${html}</p>`;
}

/** The wallet sign-in code (`POST /v1/wallet/auth/email/start`). */
export function renderLoginCodeEmail(v: {
  name: string;
  code: string;
  minutes: number;
}): RenderedEmail {
  const name = escapeHtml(v.name);
  const html =
    CARD_OPEN +
    eyebrow('Cosmos&nbsp;Pay') +
    heading('Your wallet sign-in code') +
    lead(
      `Hi ${name}, use the code below to sign in to the <b>CosmosPay&nbsp;Wallet</b>. ` +
        "If you didn't try to sign in, you can safely ignore this email — nobody gets in without the code.",
    ) +
    codeBox(v.code) +
    footnote(
      `This code expires in ${v.minutes}&nbsp;minutes and can be used once. Never share it — ` +
        'anyone with this code could sign in to your wallet account.',
    ) +
    CARD_CLOSE;
  const text = [
    `Hi ${v.name},`,
    '',
    'Use this code to sign in to the CosmosPay Wallet:',
    '',
    `    ${v.code}`,
    '',
    `This code expires in ${v.minutes} minutes and can be used once. If you didn't try to sign in,`,
    'ignore this email — nobody gets in without the code.',
    '',
    '— CosmosPay',
  ].join('\n');
  return { subject: 'Your CosmosPay wallet sign-in code', html, text };
}

/**
 * A recovery server's code (SEP-30, roles `a` and `b`).
 *
 * The copy names WHICH server sent it and says up front that the other one
 * sends its own: the person receives two of these with different codes, and a
 * second one must read as expected rather than as a glitch — or as a phisher's
 * "use this one instead". It also tells someone who did not ask to share
 * nothing: a recovery code is half of what re-keys a wallet.
 */
export function renderRecoveryCodeEmail(v: {
  role: 'a' | 'b';
  code: string;
  minutes: number;
}): RenderedEmail {
  const server = v.role === 'a' ? 'A' : 'B';
  const html =
    CARD_OPEN +
    eyebrow(`Cosmos&nbsp;Pay &middot; Recovery server&nbsp;${server}`) +
    heading('Your wallet recovery code') +
    lead(
      'Someone asked to <b>recover a Cosmos wallet</b> registered to this email address. ' +
        `This code is from <b>recovery server&nbsp;${server}</b>. Recovery uses two independent ` +
        'servers and each one sends its own code, so you will receive a second email with a ' +
        'different code — the wallet needs both.',
    ) +
    codeBox(v.code) +
    footnote(
      `This code expires in ${v.minutes}&nbsp;minutes and can be used once. <b>If you did not ask ` +
        'to recover a wallet, ignore this email and do not share the code</b> with anyone — ' +
        'including anyone claiming to be CosmosPay.',
    ) +
    CARD_CLOSE;
  const text = [
    'Hi,',
    '',
    'Someone asked to recover a Cosmos wallet registered to this email address.',
    `This code is from recovery server ${server}:`,
    '',
    `    ${v.code}`,
    '',
    'Recovery uses two independent servers and each one sends its own code, so you will',
    'receive a second email with a different code. The wallet needs both.',
    '',
    `This code expires in ${v.minutes} minutes and can be used once.`,
    'If you did not ask to recover a wallet, ignore this email and do not share the code',
    'with anyone — including anyone claiming to be CosmosPay.',
    '',
    '— CosmosPay',
  ].join('\n');
  return {
    subject: `Your CosmosPay wallet recovery code (server ${server})`,
    html,
    text,
  };
}
