import { Module } from '@nestjs/common';
import { CustomersModule } from '@/customers/customers.module';
import { EvmModule } from '@/evm/evm.module';
import { ChainPayLinkBuilder } from '@/payment-intents/chain-pay-link-builder.service';
import { EvmVerifierService } from '@/payment-intents/evm-verifier.service';
import { PaymentIntentObserverService } from '@/payment-intents/payment-intent-observer.service';
import { PaymentIntentsController } from '@/payment-intents/payment-intents.controller';
import { PaymentIntentsService } from '@/payment-intents/payment-intents.service';
import { PaymentVerifiers } from '@/payment-intents/payment-verifiers';
import { Sep7LinkBuilder } from '@/payment-intents/sep7-link-builder.service';
import { SolanaVerifierService } from '@/payment-intents/solana-verifier.service';
import { StellarVerifierService } from '@/payment-intents/stellar-verifier.service';
import { SolanaModule } from '@/solana/solana.module';

@Module({
  // A settled payment adds its payer as a customer, and that table is the
  // customers module's to write. The dependency runs one way only. Solana and
  // Monad are reached through their RPC clients, never a URL of our own.
  imports: [CustomersModule, SolanaModule, EvmModule],
  controllers: [PaymentIntentsController],
  providers: [
    PaymentIntentsService,
    Sep7LinkBuilder,
    ChainPayLinkBuilder,
    StellarVerifierService,
    SolanaVerifierService,
    EvmVerifierService,
    PaymentVerifiers,
    PaymentIntentObserverService,
  ],
  // Plugins read intents through this service's tenant-scoped reads.
  exports: [PaymentIntentsService],
})
export class PaymentIntentsModule {}
