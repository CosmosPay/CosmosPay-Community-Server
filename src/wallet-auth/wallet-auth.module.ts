import { Module } from '@nestjs/common';
import { OidcModule } from '@/common/oidc/oidc.module';
import {
  WalletAuthController,
  WalletBackupController,
} from '@/wallet-auth/wallet-auth.controller';
import { WalletAuthService } from '@/wallet-auth/wallet-auth.service';
import { WalletAuthSweeperService } from '@/wallet-auth/wallet-auth-sweeper.service';

@Module({
  imports: [OidcModule],
  controllers: [WalletAuthController, WalletBackupController],
  providers: [WalletAuthService, WalletAuthSweeperService],
  // Exported so a later flow — provisioning, recovery — can resolve a wallet
  // identity without going back out through HTTP.
  exports: [WalletAuthService],
})
export class WalletAuthModule {}
