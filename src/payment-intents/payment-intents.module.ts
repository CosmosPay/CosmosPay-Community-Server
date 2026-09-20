import { Module } from '@nestjs/common';
import { CustomersModule } from '@/customers/customers.module';
import { PaymentIntentsController } from '@/payment-intents/payment-intents.controller';
import { PaymentIntentsService } from '@/payment-intents/payment-intents.service';
import { Sep7LinkBuilder } from '@/payment-intents/sep7-link-builder.service';
import { StellarVerifierService } from '@/payment-intents/stellar-verifier.service';
import { StellarObserverService } from '@/payment-intents/stellar-observer.service';

@Module({
  // A settled payment adds its payer as a customer, and that table is the
  // customers module's to write. The dependency runs one way only.
  imports: [CustomersModule],
  controllers: [PaymentIntentsController],
  providers: [
    PaymentIntentsService,
    Sep7LinkBuilder,
    StellarVerifierService,
    StellarObserverService,
  ],
  exports: [PaymentIntentsService],
})
export class PaymentIntentsModule {}
