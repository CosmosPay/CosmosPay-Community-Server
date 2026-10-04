import { Injectable } from '@nestjs/common';
import { type Chain, isChain } from '@/chains/chains.constants';
import { EvmVerifierService } from '@/payment-intents/evm-verifier.service';
import type { PaymentVerifier } from '@/payment-intents/payment-verifier';
import { SolanaVerifierService } from '@/payment-intents/solana-verifier.service';
import { StellarVerifierService } from '@/payment-intents/stellar-verifier.service';

/**
 * Every chain's payment verifier, by chain. The service and the observer ask
 * this for an intent's verifier instead of branching on `intent.chain`, so a
 * chain is one entry here — a `Record` over the chain union, which does not
 * compile until the entry exists.
 */
@Injectable()
export class PaymentVerifiers {
  private readonly byChain: Record<Chain, PaymentVerifier>;

  constructor(
    stellar: StellarVerifierService,
    solana: SolanaVerifierService,
    evm: EvmVerifierService,
  ) {
    this.byChain = { stellar, solana, monad: evm };
  }

  /**
   * The verifier for a stored intent's chain. A row with a chain this build
   * does not know is a data error, and verifying it by another chain's rules
   * would be worse than refusing.
   */
  for(chain: string): PaymentVerifier {
    if (!isChain(chain)) {
      throw new Error(`Payment intent on unknown chain "${chain}"`);
    }
    return this.byChain[chain];
  }
}
