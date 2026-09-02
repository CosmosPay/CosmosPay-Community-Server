import { Module } from '@nestjs/common';
import { PaymentIntentsController } from '@/payment-intents/payment-intents.controller';
import { PaymentIntentsService } from '@/payment-intents/payment-intents.service';
import { StellarVerifierService } from '@/payment-intents/stellar-verifier.service';
import { StellarObserverService } from '@/payment-intents/stellar-observer.service';

@Module({
  controllers: [PaymentIntentsController],
  providers: [
    PaymentIntentsService,
    StellarVerifierService,
    StellarObserverService,
  ],
})
export class PaymentIntentsModule {}
