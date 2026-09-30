import { Module } from '@nestjs/common';
import { ApisixAdminClient } from '@/gateway-keys/apisix-admin.client';
import { WalletKeysService } from '@/gateway-keys/wallet-keys.service';

/**
 * Mints the gateway keys of wallet accounts in APISIX — see `WalletKeysService`.
 * The admin client stays private to this module: nothing else here needs it.
 */
@Module({
  providers: [ApisixAdminClient, WalletKeysService],
  exports: [WalletKeysService],
})
export class GatewayKeysModule {}
