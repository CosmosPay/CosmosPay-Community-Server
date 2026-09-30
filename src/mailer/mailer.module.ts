import { Module } from '@nestjs/common';
import { MailerService } from '@/mailer/mailer.service';
import {
  SMTP_TRANSPORT_FACTORY,
  createSmtpTransport,
} from '@/mailer/smtp-transport';

/** This service's own sender — see `MailerService` for why it has one. */
@Module({
  providers: [
    MailerService,
    { provide: SMTP_TRANSPORT_FACTORY, useValue: createSmtpTransport },
  ],
  exports: [MailerService],
})
export class MailerModule {}
