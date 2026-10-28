import { Module } from '@nestjs/common';
import { EasyRecoveryController } from '@/easy-recovery/easy-recovery.controller';
import { EasyRecoveryService } from '@/easy-recovery/easy-recovery.service';
import { EasyRecoverySweeperService } from '@/easy-recovery/easy-recovery-sweeper.service';

/**
 * `/v1/wallet/easy-recovery`: moving a wallet between two devices through a
 * five-minute mailbox this service cannot open. Served by the main deployment,
 * beside the wallet's sign-in and backups.
 */
@Module({
  controllers: [EasyRecoveryController],
  providers: [EasyRecoveryService, EasyRecoverySweeperService],
})
export class EasyRecoveryModule {}
