import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { Public } from '@/common/decorators/public.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { AuthorizeOauthDto } from '@/pollar/oauth/dto/authorize-oauth.dto';
import { ExchangeCodeDto } from '@/pollar/oauth/dto/exchange-code.dto';
import { LogoutSessionDto } from '@/pollar/oauth/dto/logout-session.dto';
import { RefreshSessionDto } from '@/pollar/oauth/dto/refresh-session.dto';
import { PollarAuthorizationEntity } from '@/pollar/oauth/entities/pollar-authorization.entity';
import { PollarSessionStatusEntity } from '@/pollar/oauth/entities/pollar-session-status.entity';
import {
  PollarLogoutEntity,
  PollarSessionEntity,
  PollarTokenPairEntity,
} from '@/pollar/oauth/entities/pollar-session.entity';
import {
  PollarCallbackOutcome,
  PollarOauthService,
} from '@/pollar/oauth/pollar-oauth.service';
import { renderCallbackPage } from '@/pollar/oauth/pollar-callback-page';
import {
  POLLAR_AUTHORIZE_RATE_LIMIT,
  POLLAR_CALLBACK_RATE_LIMIT,
  POLLAR_TOKEN_RATE_LIMIT,
} from '@/pollar/pollar.constants';

/**
 * The Pollar OAuth bridge — `/v1/pollar/oauth`.
 *
 * The whole surface a wallet needs, in the order it uses them:
 *
 *   1. `POST /authorize` — hand back a URL to open. The bridge assembles it.
 *   2. the user consents; the provider returns the browser to `GET /callback/{state}`.
 *   3. the wallet absorbs the `code` — from its own redirect URI, or from
 *      `GET /sessions/{state}` when it has no addressable URI.
 *   4. `POST /token` — the code becomes a live Pollar session.
 *   5. `POST /refresh` / `POST /logout` — the rest of the session's life.
 *
 * After step 4 the wallet talks to Pollar directly: this service does not proxy
 * balances, transaction building or signing, and holds no key that could.
 */
@ApiTags('pollar')
@Controller({ path: 'pollar/oauth', version: '1' })
export class PollarOauthController {
  constructor(private readonly oauth: PollarOauthService) {}

  @Post('authorize')
  @RequirePermissions('pollar:write')
  // The cap on wallet generation: a handshake yields at most one wallet, so
  // bounding handshakes per address bounds what an address can spend.
  @RateLimit(POLLAR_AUTHORIZE_RATE_LIMIT)
  @ApiOperation({
    summary: 'Open a Pollar login and get the URL to send the user to',
    description:
      'Mints a Pollar client session and returns a ready-to-open authorization ' +
      'URL. Open it in a browser; the bridge receives the user back and produces ' +
      'a single-use code for this handshake.',
  })
  @ApiCreatedResponse({ type: PollarAuthorizationEntity })
  authorize(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: AuthorizeOauthDto,
  ): Promise<PollarAuthorizationEntity> {
    return this.oauth.authorize(consumer, dto);
  }

  /**
   * Where Pollar returns the browser. `@Public()` because it is a navigation:
   * no API key, no gateway consumer, nothing to authenticate with. The unguessable
   * `state` is the credential, and the transition it drives is single-shot.
   *
   * The state rides in the path so it survives whatever the provider chain does
   * to the query string; the `?state=` form below is the fallback.
   *
   * Documented rather than hidden: unlike an inbound provider webhook, this URL
   * is something the operator configures (`POLLAR_BRIDGE_CALLBACK_URL`) and
   * registers with Pollar, so leaving it out of the contract hides the one part
   * of the flow they have to get exactly right.
   */
  @Get('callback/:state')
  @Public()
  // The only route here an anonymous client can reach.
  @RateLimit(POLLAR_CALLBACK_RATE_LIMIT)
  @ApiOperation({
    summary: 'Where Pollar returns the browser after consent',
    description:
      "Not called by your code — the user's browser lands here. Public by " +
      'necessity: a navigation carries no API key and no gateway consumer, so ' +
      'the unguessable `state` is the credential and the transition it drives ' +
      'is single-shot. Point POLLAR_BRIDGE_CALLBACK_URL at this route (without ' +
      'the state; the bridge appends it) and register its host with Pollar.',
  })
  @ApiParam({
    name: 'state',
    description:
      'The handshake handle returned by POST /v1/pollar/oauth/authorize.',
  })
  @ApiResponse({
    status: 302,
    description:
      "Redirect-mode handshake: the browser is sent to the wallet's registered " +
      'redirect URI with `?code=…&state=…` appended.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Poll-mode handshake: a plain "you can close this window" page. It never ' +
      'contains the code — the wallet collects that from GET /oauth/sessions/{state}.',
    content: { 'text/html': { schema: { type: 'string' } } },
  })
  callback(@Param('state') state: string, @Res() res: Response): Promise<void> {
    return this.finishCallback(state, res);
  }

  /**
   * The same callback with the state in the query instead of the path — a
   * fallback for a provider chain that rewrites the path but preserves the
   * query. Same single-shot transition; only the way in differs.
   */
  @Get('callback')
  @Public()
  @RateLimit(POLLAR_CALLBACK_RATE_LIMIT)
  @ApiOperation({
    summary: 'Callback fallback, with the state in the query',
    description:
      'Identical to `GET /callback/{state}`, for a redirect chain that keeps ' +
      'the query but not the path segment. Prefer the path form.',
  })
  @ApiQuery({ name: 'state', description: 'The handshake handle.' })
  @ApiResponse({ status: 302, description: "Redirect to the wallet's URI." })
  @ApiResponse({
    status: 200,
    description: 'The poll-mode landing page.',
    content: { 'text/html': { schema: { type: 'string' } } },
  })
  callbackByQuery(
    @Query('state') state: string,
    @Res() res: Response,
  ): Promise<void> {
    return this.finishCallback(state, res);
  }

  @Get('sessions/:state')
  @RequirePermissions('pollar:read')
  @ApiOperation({
    summary: 'Poll a login, and collect its code',
    description:
      'For a wallet with no addressable redirect URI. Returns the handshake ' +
      'status, and — once the user has come back — the single-use code. Each ' +
      'call issues a fresh code and retires the previous one, so redeem the code ' +
      'from your most recent poll.',
  })
  @ApiOkResponse({ type: PollarSessionStatusEntity })
  status(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('state') state: string,
  ): Promise<PollarSessionStatusEntity> {
    return this.oauth.status(consumer, state);
  }

  @Post('token')
  @RequirePermissions('pollar:write')
  // Loose on purpose — the 409 path below tells the caller to retry this exact
  // request, and redeeming creates nothing the handshake did not already allow.
  @RateLimit(POLLAR_TOKEN_RATE_LIMIT)
  @ApiOperation({
    summary: 'Redeem a bridge code for a Pollar session',
    description:
      "Trades the single-use code for Pollar's end-user tokens and the wallet " +
      'it resolved. May take a moment on a first login: Pollar creates the ' +
      'Stellar account, funds its reserve and adds the trustlines first. A 409 ' +
      'means it is still working — retry the same code.',
  })
  @ApiCreatedResponse({ type: PollarSessionEntity })
  exchange(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: ExchangeCodeDto,
  ): Promise<PollarSessionEntity> {
    return this.oauth.exchange(consumer, dto);
  }

  @Post('refresh')
  @RequirePermissions('pollar:write')
  @ApiOperation({
    summary: 'Rotate a Pollar token pair',
    description:
      'Refresh tokens are single-use — Pollar rotates on every call and treats ' +
      'a replay as a compromise. Not available for a DPoP-bound session: only ' +
      "the holder of the wallet's private key can refresh one.",
  })
  @ApiCreatedResponse({ type: PollarTokenPairEntity })
  refresh(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: RefreshSessionDto,
  ): Promise<PollarTokenPairEntity> {
    return this.oauth.refresh(consumer, dto);
  }

  @Post('logout')
  @RequirePermissions('pollar:write')
  @ApiOperation({ summary: 'Revoke a Pollar session (this device, or all)' })
  @ApiCreatedResponse({ type: PollarLogoutEntity })
  logout(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: LogoutSessionDto,
  ): Promise<PollarLogoutEntity> {
    return this.oauth.logout(consumer, dto);
  }

  /**
   * Puts a callback outcome on the wire: a 302 to the wallet's redirect URI, or
   * a self-contained page showing the code when the handshake has nowhere to
   * send the browser.
   */
  private async finishCallback(state: string, res: Response): Promise<void> {
    const outcome: PollarCallbackOutcome =
      await this.oauth.handleCallback(state);

    if (outcome.redirectTo) {
      res.redirect(302, outcome.redirectTo);
      return;
    }

    res
      .status(200)
      .type('html')
      // The page carries a live code, so it must not be cached anywhere — not
      // by a proxy, and not in the browser's back-forward cache.
      .set('cache-control', 'no-store, no-cache, must-revalidate, private')
      .set('referrer-policy', 'no-referrer')
      .send(renderCallbackPage(outcome));
  }
}
