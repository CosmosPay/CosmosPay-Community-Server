import { Module } from '@nestjs/common';
import { PaymentIntentsModule } from '@/payment-intents/payment-intents.module';
import { PrivateRfqsController } from '@/private-rfqs/private-rfqs.controller';
import { PrivateRfqsService } from '@/private-rfqs/private-rfqs.service';
import { SubRosaRoundReader } from '@/private-rfqs/sub-rosa-round-reader.service';

@Module({
  imports: [PaymentIntentsModule],
  controllers: [PrivateRfqsController],
  providers: [PrivateRfqsService, SubRosaRoundReader],
})
export class PrivateRfqsModule {}
