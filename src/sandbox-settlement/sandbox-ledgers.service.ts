import { Injectable } from '@nestjs/common';
import type { PaymentNetwork } from '@/payment-intents/payment-networks';
import { SandboxEvmLedger } from '@/sandbox-settlement/sandbox-evm.ledger';
import type { SandboxLedger } from '@/sandbox-settlement/sandbox-ledger';
import {
  SANDBOX_NETWORKS,
  type SandboxLedgerKind,
} from '@/sandbox-settlement/sandbox-settlement.constants';

/**
 * The ledger of each kind of test network the sandbox settles on: a
 * `Record<SandboxLedgerKind, …>`, so a new kind does not compile until it has
 * one.
 */
@Injectable()
export class SandboxLedgers {
  private readonly byKind: Record<SandboxLedgerKind, SandboxLedger>;

  constructor(evm: SandboxEvmLedger) {
    this.byKind = { evm };
  }

  /** The ledger of `network`; throws for a network the sandbox does not settle on. */
  for(network: PaymentNetwork): SandboxLedger {
    const entry = SANDBOX_NETWORKS[network];
    if (entry.kind === 'unavailable') {
      throw new Error(`The sandbox does not settle on ${network}`);
    }
    return this.byKind[entry.kind];
  }
}
