import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '@/common/decorators/public.decorator';
import { headerValue } from '@/common/request-header';
import { BankTransferWebhooks } from '@/native-plugins/koywe/bank-transfer-webhooks.service';
import { KOYWE_SIGNATURE_HEADER } from '@/native-plugins/koywe/koywe.constants';

/**
 * Receives the bank transfer provider's webhooks: deposits to the sellers'
 * (or the pooled) ARS accounts, the conversion orders and the sellers' KYB.
 *
 * `@Public()` because the provider calls it directly, with no APISIX consumer
 * and no gateway secret: authenticity is the HMAC of the raw body under a
 * secret registered with the endpoint (`BankTransferWebhooks.receive`). Kept
 * out of the published contract, like the other providers' webhooks:
 * integrators never call it. Registered per environment with
 * `npm run bank-transfer:webhook -- register` as
 * `<gateway>/v1/onramp/transfer/webhooks`.
 */
@ApiExcludeController()
@Controller({ path: 'onramp/transfer/webhooks', version: '1' })
export class BankTransferWebhooksController {
  constructor(private readonly webhooks: BankTransferWebhooks) {}

  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  receive(@Req() req: RawBodyRequest<Request>): Promise<{ received: true }> {
    return this.webhooks.receive({
      rawBody: req.rawBody,
      signature: headerValue(req, KOYWE_SIGNATURE_HEADER),
    });
  }
}
