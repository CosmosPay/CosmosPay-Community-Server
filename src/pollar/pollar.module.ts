import { Module } from '@nestjs/common';
import { PollarClient } from '@/pollar/pollar.client';
import { PollarOauthController } from '@/pollar/oauth/pollar-oauth.controller';
import { PollarOauthService } from '@/pollar/oauth/pollar-oauth.service';
import { PollarOauthSweeperService } from '@/pollar/oauth/pollar-oauth-sweeper.service';
import { PollarWalletsController } from '@/pollar/wallets/pollar-wallets.controller';
import { PollarWalletsService } from '@/pollar/wallets/pollar-wallets.service';

/**
 * Pollar: hosted social login in, a Stellar wallet out.
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
    // Retires handshakes nobody finished (one replica per tick, via the lock).
    PollarOauthSweeperService,
  ],
  exports: [PollarClient],
})
export class PollarModule {}
