import { Module } from '@nestjs/common';
import { EvmRelayer } from '@/evm/evm-relayer.service';
import { EvmRpcClient } from '@/evm/evm-rpc.client';

/**
 * EVM access (Monad, Arc) for the modules that settle, sign in or resolve on
 * them. No table, no route: the RPC client that knows the node URLs, and the
 * relayer, the one key per EVM chain this service signs with, for gas only.
 */
@Module({
  providers: [EvmRpcClient, EvmRelayer],
  exports: [EvmRpcClient, EvmRelayer],
})
export class EvmModule {}
