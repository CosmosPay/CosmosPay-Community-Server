import { Module } from '@nestjs/common';
import { OidcModule } from '@/common/oidc/oidc.module';
import { GatewayKeysModule } from '@/gateway-keys/gateway-keys.module';
import { MailerModule } from '@/mailer/mailer.module';
import {
  WalletAuthController,
  WalletBackupController,
} from '@/wallet-auth/wallet-auth.controller';
import { BackupCipher } from '@/wallet-auth/backup-cipher';
import { WalletAuthService } from '@/wallet-auth/wallet-auth.service';
import { WalletAuthSweeperService } from '@/wallet-auth/wallet-auth-sweeper.service';

@Module({
  imports: [OidcModule, MailerModule, GatewayKeysModule],
  controllers: [WalletAuthController, WalletBackupController],
  providers: [WalletAuthService, WalletAuthSweeperService, BackupCipher],
  // Exported so a later flow — provisioning, recovery — can resolve a wallet
  // identity without going back out through HTTP.
  exports: [WalletAuthService],
})
export class WalletAuthModule {}
