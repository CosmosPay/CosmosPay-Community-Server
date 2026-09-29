import { Controller, Post, RawBodyRequest, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { Request } from 'express';
import { AppConfig } from '@/config/configuration';
import { Public } from '@/common/decorators/public.decorator';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { headerValue } from '@/common/request-header';
import { verifySvixSignature } from '@/blindpay/blindpay-signature';
import { BLINDPAY_ENVIRONMENTS } from '@/blindpay/blindpay.constants';
import {
  BlindpaySyncService,
  BlindpayObject,
} from '@/blindpay/blindpay-sync.service';

/**
 * Receives BlindPay (Svix) webhook deliveries from both platform instances.
 *
 * This route is `@Public()` because BlindPay calls it directly — it does not
 * carry an APISIX consumer or the gateway secret. Authenticity is established by
 * verifying the Svix signature over the raw request body instead. Point each
 * instance's BlindPay dashboard webhook at `<gateway>/v1/blindpay/webhooks` and
 * set BLINDPAY_WEBHOOK_SECRET (production) and BLINDPAY_WEBHOOK_SECRET_DEV
 * (development) to that endpoint's signing secret.
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
    const { instances } = this.config.get('blindpay', { infer: true });
    const configured = BLINDPAY_ENVIRONMENTS.filter(
      (env) => instances[env].webhookSecret,
    );
    if (configured.length === 0) {
      // 503 `misconfigured`, not 400: nothing is wrong with the delivery. A 400
      // told whoever read the Svix log that BlindPay had sent something
      // malformed, when the fault is this deployment's configuration. Svix
      // retries any non-2xx, so a delivery refused here still arrives once the
      // secret is set, within Svix's retry window.
      throw ApiError.unavailable(
        ApiErrorCode.Misconfigured,
        'BlindPay webhooks are not configured',
      );
    }

    const rawBody = req.rawBody?.toString('utf8') ?? '';
    // The delivery id is both signed content and the de-duplication key: Svix
    // repeats it on every retry of the same event, so the sync service uses it
    // to tell a retry from a new state change.
    const svixId = headerValue(req, 'svix-id') ?? '';
    const headers = {
      id: svixId,
      timestamp: headerValue(req, 'svix-timestamp') ?? '',
      signature: headerValue(req, 'svix-signature') ?? '',
    };
    // Each instance signs with its own endpoint secret, so the secret a delivery
    // verifies against is what says which instance sent it — and so which mirror
    // rows it may touch. Nothing in the payload is trusted for that.
    const environment = configured.find((env) =>
      verifySvixSignature(instances[env].webhookSecret, rawBody, headers),
    );
    if (!environment) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'Invalid BlindPay webhook signature',
      );
    }

    const event = parseEvent(rawBody);
    if (event) {
      await this.sync.handleWebhook(
        environment,
        event.type,
        event.data,
        svixId,
      );
    }
    return { received: true };
  }
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
