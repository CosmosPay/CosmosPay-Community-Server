import { Global, Module } from '@nestjs/common';
import { StellarAccountLoader } from '@/stellar/account-loader.service';
import { SignedTransactionRelay } from '@/stellar/signed-transaction-relay.service';
import { SorobanRpcClient } from '@/stellar/soroban-rpc.client';
import { StellarService } from '@/stellar/stellar.service';

@Global()
@Module({
  providers: [
    StellarService,
    StellarAccountLoader,
    SignedTransactionRelay,
    SorobanRpcClient,
  ],
  exports: [
    StellarService,
    StellarAccountLoader,
    SignedTransactionRelay,
    SorobanRpcClient,
  ],
})
export class StellarModule {}
