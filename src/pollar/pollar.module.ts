import { Module } from '@nestjs/common';
import { PollarClient } from '@/pollar/pollar.client';
import { PollarOauthController } from '@/pollar/oauth/pollar-oauth.controller';
import { PollarOauthService } from '@/pollar/oauth/pollar-oauth.service';
import { PollarOauthSweeperService } from '@/pollar/oauth/pollar-oauth-sweeper.service';
import { PollarWalletsController } from '@/pollar/wallets/pollar-wallets.controller';
import { PollarWalletsService } from '@/pollar/wallets/pollar-wallets.service';
import { PollarWalletProvisioningService } from '@/pollar/wallets/pollar-wallet-provisioning.service';
import { PollarWalletProvisionSweeperService } from '@/pollar/wallets/pollar-wallet-provision-sweeper.service';

/**
 * Pollar: hosted social login in, a Stellar wallet out — on both networks.
 *
 * Two surfaces, split by which Pollar key they need. The **OAuth bridge** owns
 * the login handshake so a wallet never touches a Pollar key, a client session
 * id or a registered redirect URI — it opens an authorization and redeems a
 * code. The **wallet routes** are the operator calls that need the secret key:
 * fund a reserve, add a trustline, register a user, verify a token.
 *
 * What is deliberately absent is a proxy for the wallet's own surface. Once a
 * session is redeemed the wallet talks to Pollar directly, so this service never
 * stands between a user and their funds, and holds no key that would let it.
 */
@Module({
  controllers: [PollarOauthController, PollarWalletsController],
  providers: [
    PollarClient,
    PollarOauthService,
    PollarWalletsService,
    // Gets each user a wallet on BOTH networks, without letting the second one
    // fail the login that produced the first.
    PollarWalletProvisioningService,
    // Retires handshakes nobody finished (one replica per tick, via the lock).
    PollarOauthSweeperService,
    // Finishes the wallets a login left pending — same cadence, same lock shape.
    PollarWalletProvisionSweeperService,
  ],
  exports: [PollarClient],
})
export class PollarModule {}
