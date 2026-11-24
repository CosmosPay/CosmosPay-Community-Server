import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { JobSchedule, ScheduledJob } from '@/common/services/scheduled-job';
import type { AppConfig } from '@/config/configuration';
import {
  P2P_DIRECT_PROCESSING_SWEEP_BATCH,
  P2P_DIRECT_PROCESSING_SWEEP_INTERVAL_MS,
} from '@/native-plugins/eldorado/eldorado.constants';
import { P2pPaymentRequestLedger } from '@/native-plugins/eldorado/p2p-payment-request-ledger.service';

/**
 * Opens again the payment requests a direct order left `processing` past its
 * deadline: its payer said they transferred, and by the order's due time plus
 * `P2P_DIRECT_PROCESSING_GRACE_MS` the marketplace had neither completed nor
 * cancelled it (no webhook, no read of the order saw either). Without it, a
 * payer who marks paid without paying froze the request for good. The
 * marketplace cannot be asked here: an order is read only with its payer's
 * token, which is never stored, so the deadline set when the order was marked
 * paid decides.
 *
 * Database only, one conditional write per request (`reopenOverdue`). On with
 * the settlement observer (`OBSERVER_ENABLED`), like the other plugins' jobs,
 * whether or not the direct flow is still configured: requests it left
 * `processing` must not stay so because it was turned off. One replica runs a
 * cycle (advisory lock).
 */
@Injectable()
export class P2pDirectProcessingSweepService extends ScheduledJob {
  protected readonly logger = new Logger(P2pDirectProcessingSweepService.name);
  protected readonly lockKey = AdvisoryLockKey.P2pDirectProcessingSweep;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly ledger: P2pPaymentRequestLedger,
    locks: AdvisoryLockService,
  ) {
    super(locks);
  }

  protected schedule(): JobSchedule {
    return {
      enabled: this.config.get('observer', { infer: true }).enabled,
      intervalMs: P2P_DIRECT_PROCESSING_SWEEP_INTERVAL_MS,
      description: 'P2P direct processing sweep',
    };
  }

  protected async run(): Promise<void> {
    await this.ledger.reopenOverdue(
      new Date(),
      P2P_DIRECT_PROCESSING_SWEEP_BATCH,
    );
  }
}
