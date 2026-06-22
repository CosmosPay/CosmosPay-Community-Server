import { Module } from '@nestjs/common';
import { PaymentIntentsController } from './payment-intents.controller';
import { PaymentIntentsService } from './payment-intents.service';
import { StellarVerifierService } from './stellar-verifier.service';
import { StellarObserverService } from './stellar-observer.service';

@Module({
  controllers: [PaymentIntentsController],
  providers: [
    PaymentIntentsService,
    StellarVerifierService,
    StellarObserverService,
  ],
})
export class PaymentIntentsModule {}
