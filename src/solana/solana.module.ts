import { Module } from '@nestjs/common';
import { SolanaRpcClient } from '@/solana/solana-rpc.client';

/**
 * Solana access for the modules that settle, sign in or resolve on it. It
 * owns no table and no route: only the RPC client, which is the one place that
 * knows the node URLs.
 */
@Module({
  providers: [SolanaRpcClient],
  exports: [SolanaRpcClient],
})
export class SolanaModule {}
