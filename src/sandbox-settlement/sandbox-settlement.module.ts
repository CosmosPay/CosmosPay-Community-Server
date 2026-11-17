import { Module } from '@nestjs/common';
import { SandboxDepositRoute } from '@/sandbox-settlement/sandbox-deposit-route.service';
import { SandboxEvmClient } from '@/sandbox-settlement/sandbox-evm.client';
import { SandboxEvmLedger } from '@/sandbox-settlement/sandbox-evm.ledger';
import { SandboxLedgers } from '@/sandbox-settlement/sandbox-ledgers.service';
import { SandboxSettler } from '@/sandbox-settlement/sandbox-settler.service';
import { SandboxXrplClient } from '@/sandbox-settlement/sandbox-xrpl.client';
import { SandboxXrplLedger } from '@/sandbox-settlement/sandbox-xrpl.ledger';

/**
 * Sandbox settlement: payment links on the networks paid through deposit
 * addresses, on their test networks, settled by this service itself (the
 * cross-chain route has no test network). The payment links module asks it for
 * prices and deposit addresses (`SandboxDepositRoute`) and has its observer
 * settle sandbox deposits through it (`SandboxSettler`). Each kind of test
 * network is one `SandboxLedger` over its own client (`SandboxLedgers`).
 */
@Module({
  providers: [
    SandboxEvmClient,
    SandboxEvmLedger,
    SandboxXrplClient,
    SandboxXrplLedger,
    SandboxLedgers,
    SandboxDepositRoute,
    SandboxSettler,
  ],
  exports: [SandboxEvmClient, SandboxDepositRoute, SandboxSettler],
})
export class SandboxSettlementModule {}
