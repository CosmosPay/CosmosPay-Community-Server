import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@/config/configuration';
import { RESEND_ENDPOINT } from '@/mailer/mailer.constants';
import {
  SMTP_TRANSPORT_FACTORY,
  type SmtpTransport,
  type SmtpTransportFactory,
} from '@/mailer/smtp-transport';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Sends this service's own mail: through Resend's HTTPS API when
 * `MAIL_RESEND_API_KEY` is set, otherwise through SMTP (`MAIL_SMTP_*`).
 *
 * It exists so that nothing a wallet does depends on the developer platform
 * being up: sign-in codes and recovery codes used to be posted there to be
 * delivered, which made the platform — the piece with the worst uptime — a
 * hard dependency of every sign-in. The platform keeps its own mailer for its
 * own mail (invitations, KYC terms); this one is not shared with it.
 *
 * Resend wins when both are set because it is HTTPS on 443, which works on the
 * hosts that block outbound SMTP ports.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private smtp: SmtpTransport | null = null;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(SMTP_TRANSPORT_FACTORY)
    private readonly smtpFactory: SmtpTransportFactory,
  ) {}

  private get settings() {
    return this.config.get('mail', { infer: true });
  }

  /** Whether a sender is configured. A door that needs mail reports itself off without one. */
  get configured(): boolean {
    const { resendApiKey, smtp, from } = this.settings;
    return Boolean(from && (resendApiKey || smtp.host));
  }

  /**
   * Send one message, or throw.
   *
   * The provider's own error is logged and never rethrown to the caller: it can
   * carry account detail, and every caller's only decision is retry-or-refuse.
   */
  async send(msg: MailMessage): Promise<void> {
    if (!this.configured) {
      throw new Error('No mail sender is configured.');
    }
    try {
      if (this.settings.resendApiKey) await this.viaResend(msg);
      else await this.viaSmtp(msg);
    } catch (error) {
      this.logger.error(`mail: send failed: ${String(error)}`);
      throw new Error('The email could not be sent.', { cause: error });
    }
  }

  private async viaResend(msg: MailMessage): Promise<void> {
    const { resendApiKey, from, timeoutMs } = this.settings;
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${resendApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Resend answered ${res.status}: ${detail.slice(0, 300)}`);
    }
  }

  private async viaSmtp(msg: MailMessage): Promise<void> {
    const { smtp, from, timeoutMs } = this.settings;
    // One transport per process: it pools the connection between sends.
    this.smtp ??= this.smtpFactory({ ...smtp, timeoutMs });
    await this.smtp.sendMail({ from, ...msg });
  }
}
