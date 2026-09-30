import { createTransport } from 'nodemailer';

/** What the mailer needs from an SMTP transport: one send. */
export interface SmtpTransport {
  sendMail(msg: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<unknown>;
}

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  timeoutMs: number;
}

/** Injection token for the factory below, so a spec can hand in a fake transport. */
export const SMTP_TRANSPORT_FACTORY = Symbol('SMTP_TRANSPORT_FACTORY');

export type SmtpTransportFactory = (opts: SmtpOptions) => SmtpTransport;

/**
 * Builds the nodemailer transport. Every timeout is set: without them a blocked
 * or wrong port leaves the sign-in request hanging until the proxy in front
 * gives up, instead of failing in seconds.
 */
export const createSmtpTransport: SmtpTransportFactory = (opts) =>
  createTransport({
    host: opts.host,
    port: opts.port,
    // 465 → implicit TLS (secure=true); 587 → STARTTLS (secure=false).
    secure: opts.secure,
    auth: opts.user ? { user: opts.user, pass: opts.pass } : undefined,
    connectionTimeout: opts.timeoutMs,
    greetingTimeout: opts.timeoutMs,
    socketTimeout: opts.timeoutMs,
  });
