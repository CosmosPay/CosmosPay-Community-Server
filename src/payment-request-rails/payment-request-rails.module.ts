import { Module } from '@nestjs/common';
import { PaymentRequestRails } from '@/payment-request-rails/payment-request-rails';

/**
 * The extension point between the plugin that owns payment requests and the
 * plugins that serve other ways to pay them. Imported by each of them (one
 * instance, as every static module), never by the core itself.
 */
@Module({
  providers: [PaymentRequestRails],
  exports: [PaymentRequestRails],
})
export class PaymentRequestRailsModule {}
