import { Module } from '@nestjs/common';
import { EldoradoClient } from '@/native-plugins/eldorado/eldorado.client';
import { P2pDirectController } from '@/native-plugins/eldorado/p2p-direct.controller';
import { P2pDirectService } from '@/native-plugins/eldorado/p2p-direct.service';
import { P2pOfframpController } from '@/native-plugins/eldorado/p2p-offramp.controller';
import { P2pOnrampController } from '@/native-plugins/eldorado/p2p-onramp.controller';
import { P2pOrderEventsService } from '@/native-plugins/eldorado/p2p-order-events.service';
import { P2pPaymentLinksController } from '@/native-plugins/eldorado/p2p-payment-links.controller';
import { P2pPaymentRequestLedger } from '@/native-plugins/eldorado/p2p-payment-request-ledger.service';
import { P2pPaymentRequestsController } from '@/native-plugins/eldorado/p2p-payment-requests.controller';
import { P2pPaymentRequestsService } from '@/native-plugins/eldorado/p2p-payment-requests.service';
import { P2pRampService } from '@/native-plugins/eldorado/p2p-ramp.service';
import { P2pWebhookKeys } from '@/native-plugins/eldorado/p2p-webhook-keys.service';
import { P2pWebhooksController } from '@/native-plugins/eldorado/p2p-webhooks.controller';
import { PaymentRequestRailsModule } from '@/payment-request-rails/payment-request-rails.module';

/**
 * The `eldorado` native plugin: stablecoins traded for local money with P2P
 * counterparts on El Dorado's marketplace, bought (`/v1/onramp/p2p`) and sold
 * (`/v1/offramp/p2p`), and charges in local money shown as a QR
 * (`/v1/onramp/p2p/payment-requests`, paid through the keyless
 * `/v1/payment-links/fiat/{id}`, in the marketplace's window or, for ARS,
 * inside the payer's page through its API: `.../direct/*`). A third-party marketplace rather than the
 * chain itself, so it is served only when `PLUGINS_ENABLED` lists `eldorado`.
 * Owns the `p2p_ramp_session` table (the purchases and sales it opened for
 * each consumer, with what the marketplace's webhook reports about them) and
 * `p2p_payment_request`, which other plugins' rails (a bank transfer) reach
 * only through the core's `PaymentRequestRails`, where this plugin registers
 * its ledger. Without any of them, a request is paid through the marketplace
 * alone, as it always was.
 */
@Module({
  imports: [PaymentRequestRailsModule],
  controllers: [
    P2pOnrampController,
    P2pOfframpController,
    P2pPaymentRequestsController,
    P2pPaymentLinksController,
    P2pDirectController,
    P2pWebhooksController,
  ],
  providers: [
    EldoradoClient,
    P2pRampService,
    P2pPaymentRequestsService,
    P2pPaymentRequestLedger,
    P2pWebhookKeys,
    P2pOrderEventsService,
    P2pDirectService,
  ],
})
export class EldoradoModule {}
