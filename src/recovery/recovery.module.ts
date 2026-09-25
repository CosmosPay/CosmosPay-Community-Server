import { Module } from '@nestjs/common';
import { OidcModule } from '@/common/oidc/oidc.module';
import {
  Sep10Controller,
  Sep30Controller,
  StellarTomlController,
} from '@/recovery/recovery.controller';
import { RecoveryService } from '@/recovery/recovery.service';
import { RecoverySweeperService } from '@/recovery/recovery-sweeper.service';

/**
 * SEP-10 + SEP-30 — this deployment as one of the two recovery servers.
 *
 * Loaded on every deployment and inert on the ones without `RECOVERY_ROLE`: the
 * routes answer 404 and the sweeper stays idle. Run it twice — role `a` and role
 * `b`, each with its own keys, secret, host and database — and as many replicas
 * of each as the load needs; nothing here is per-process state.
 */
@Module({
  imports: [OidcModule],
  controllers: [StellarTomlController, Sep10Controller, Sep30Controller],
  providers: [RecoveryService, RecoverySweeperService],
})
export class RecoveryModule {}
