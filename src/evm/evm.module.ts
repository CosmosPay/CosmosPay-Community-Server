import { Module } from '@nestjs/common';
import { EvmRpcClient } from '@/evm/evm-rpc.client';

/**
 * EVM access (Monad) for the modules that settle, sign in or resolve on it.
 * No table, no route: only the RPC client that knows the node URLs.
 */
@Module({
  providers: [EvmRpcClient],
  exports: [EvmRpcClient],
})
export class EvmModule {}
