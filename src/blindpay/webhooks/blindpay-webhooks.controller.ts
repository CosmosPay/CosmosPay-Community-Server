import {
  BadRequestException,
  Controller,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { Request } from 'express';
import { AppConfig } from '../../config/configuration';
import { Public } from '../../common/decorators/public.decorator';
import { verifySvixSignature } from '../blindpay-signature';
import { BlindpaySyncService, BlindpayObject } from '../blindpay-sync.service';

/**
 * Receives BlindPay (Svix) webhook deliveries.
 *
 * This route is `@Public()` because BlindPay calls it directly — it does not
 * carry an APISIX consumer or the gateway secret. Authenticity is established by
 * verifying the Svix signature over the raw request body instead. Configure the
 * BlindPay dashboard to point its webhook at `<gateway>/v1/blindpay/webhooks`
 * and set BLINDPAY_WEBHOOK_SECRET to that endpoint's signing secret.
 */
@Controller({ path: 'blindpay', version: '1' })
export class BlindpayWebhooksController {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly sync: BlindpaySyncService,
  ) {}

  @Post('webhooks')
  @Public()
  @ApiExcludeEndpoint()
  async handle(
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ received: boolean }> {
    const { webhookSecret } = this.config.get('blindpay', { infer: true });
    if (!webhookSecret) {
      throw new BadRequestException('BlindPay webhooks are not configured');
    }

    const rawBody = req.rawBody?.toString('utf8') ?? '';
    const ok = verifySvixSignature(webhookSecret, rawBody, {
      id: header(req, 'svix-id'),
      timestamp: header(req, 'svix-timestamp'),
      signature: header(req, 'svix-signature'),
    });
    if (!ok) {
      throw new BadRequestException('Invalid BlindPay webhook signature');
    }

    const event = parseEvent(rawBody);
    if (event) {
      await this.sync.handleWebhook(event.type, event.data);
    }
    return { received: true };
  }
}

function header(req: Request, name: string): string {
  const raw = req.headers[name];
  return Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
}

/** Pulls `{ type, data }` out of a verified Svix payload. */
function parseEvent(
  rawBody: string,
): { type: string; data: BlindpayObject } | null {
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const type = typeof parsed.type === 'string' ? parsed.type : null;
    if (!type) return null;
    const data = (
      parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed
    ) as BlindpayObject;
    return { type, data };
  } catch {
    return null;
  }
}
