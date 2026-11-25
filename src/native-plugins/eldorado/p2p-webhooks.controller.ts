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
import {
  P2P_WEBHOOK_HASH_HEADER,
  P2P_WEBHOOK_SIGNATURE_HEADER,
} from '@/native-plugins/eldorado/eldorado.constants';
import { P2pOrderEventsService } from '@/native-plugins/eldorado/p2p-order-events.service';

/**
 * Receives the P2P marketplace's order webhooks (`ORDER_STATUS_CHANGED`) for
 * the orders this service's sessions opened.
 *
 * `@Public()` because the marketplace calls it directly, with no APISIX
 * consumer and no gateway secret: authenticity is its signature over the raw
 * request body (`P2pOrderEventsService.receive`), checked against the keys the
 * marketplace publishes. Kept out of the published contract, like the fiat
 * partner's webhook: integrators never call it. The marketplace registers it per
 * Client ID, by email: give it `<gateway>/v1/onramp/p2p/webhooks`.
 */
@ApiExcludeController()
@Controller({ path: 'onramp/p2p/webhooks', version: '1' })
export class P2pWebhooksController {
  constructor(private readonly events: P2pOrderEventsService) {}

  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  receive(@Req() req: RawBodyRequest<Request>): Promise<{ received: true }> {
    return this.events.receive({
      rawBody: req.rawBody,
      hash: headerValue(req, P2P_WEBHOOK_HASH_HEADER),
      signature: headerValue(req, P2P_WEBHOOK_SIGNATURE_HEADER),
    });
  }
}
