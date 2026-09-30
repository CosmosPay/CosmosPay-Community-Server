import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import {
  ApiExtraModels,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { AllowPublicKey } from '@/common/decorators/allow-public-key.decorator';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { Public } from '@/common/decorators/public.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import {
  WALLET_AUTH_AUTHORIZE_RATE_LIMIT,
  WALLET_AUTH_CLAIM_RATE_LIMIT,
  WALLET_AUTH_EMAIL_RATE_LIMIT,
  WALLET_AUTH_FINISH_RATE_LIMIT,
  WALLET_AUTH_POLL_RATE_LIMIT,
  WALLET_RECOVERY_SETUP_GLOBAL_RATE_LIMIT,
  WALLET_RECOVERY_SETUP_RATE_LIMIT,
  WALLET_SESSION_HEADER,
} from '@/wallet-auth/wallet-auth.constants';
import { WalletAuthService } from '@/wallet-auth/wallet-auth.service';
import { callbackPage } from '@/wallet-auth/wallet-auth-page';
import {
  ClaimWalletOauthDto,
  FinishWalletSignInDto,
  ReplaceWalletBackupDto,
  SponsorRecoverySetupDto,
  StartWalletEmailDto,
  StartWalletOauthDto,
  VerifyWalletEmailDto,
} from '@/wallet-auth/dto/wallet-auth.dto';
import {
  WalletAuthProvidersEntity,
  WalletAuthReadyEntity,
  WalletAuthStatusEntity,
  WalletAuthVerifyEmailEntity,
  WalletBackupUpdatedEntity,
  WalletCodeInvalidEntity,
  WalletEmailStartedEntity,
  WalletOauthStartedEntity,
  WalletRecoverySetupEntity,
  WalletSignInFinishedEntity,
} from '@/wallet-auth/entities/wallet-auth.entity';

/**
 * A response discriminated on `status`, published as every branch rather than
 * as one shape with optional fields — which branch came back IS the information.
 */
const oneOf = (...models: Parameters<typeof getSchemaPath>[0][]) => ({
  schema: { oneOf: models.map((m) => ({ $ref: getSchemaPath(m) })) },
});

/**
 * The wallet's own sign-in.
 *
 * Two kinds of caller reach this controller, and the split decides every
 * decorator here:
 *
 *  * **The wallet**, which holds the SHARED public key like any anonymous
 *    wallet. Those routes carry `@AllowPublicKey()`, and that is not a
 *    weakening: signing in is what a wallet does BEFORE it has an account, so a
 *    route requiring an account key would be a door that only opens from the
 *    inside. Every response here is a pure function of what the caller already
 *    proved — a handshake it opened, a code sent to a mailbox, a signature by a
 *    key it holds — and never a per-consumer row.
 *  * **A browser**, exactly once, at the OAuth callback. That route is
 *    `@Public()` by necessity: a navigation carries no API key and no gateway
 *    consumer. The unguessable `state` is all it carries, and all a `state` buys
 *    is a state transition — the identity behind it is collected by the device
 *    that holds the PKCE verifier, which the browser never had.
 *
 * Nothing here is reachable with an ordinary account key in a way that matters:
 * the credential on every route is the handshake, the code or the signature, not
 * the API key.
 */
@ApiTags('wallet-auth')
@ApiExtraModels(
  WalletAuthReadyEntity,
  WalletAuthVerifyEmailEntity,
  WalletCodeInvalidEntity,
  WalletSignInFinishedEntity,
)
@Controller({ path: 'wallet/auth', version: '1' })
export class WalletAuthController {
  constructor(private readonly walletAuth: WalletAuthService) {}

  @Get('providers')
  @AllowPublicKey()
  @RequirePermissions('payments:read')
  @ApiOperation({
    summary: 'Which sign-in doors this deployment has',
    description:
      'Render buttons from this rather than from a compiled-in list. A ' +
      'deployment with no Google credentials should not show a Google button ' +
      'that dies at the consent screen.',
  })
  @ApiOkResponse({ type: WalletAuthProvidersEntity })
  providers(): WalletAuthProvidersEntity {
    return this.walletAuth.providers();
  }

  /* --------------------------------- OAuth -------------------------------- */

  @Post('oauth/authorize')
  @AllowPublicKey()
  @RequirePermissions('payments:write')
  // Every call writes a handshake row that outlives its TTL by the sweep grace.
  @RateLimit(WALLET_AUTH_AUTHORIZE_RATE_LIMIT)
  @ApiOperation({
    summary: 'Open a provider sign-in',
    description:
      'Returns the URL to open in a browser. Keep the PKCE verifier on the ' +
      'device: the `state` travels through the browser and buys only polling, ' +
      'while the verifier is what redeems the handshake.',
  })
  @ApiOkResponse({ type: WalletOauthStartedEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.WalletProviderUnavailable,
      ApiErrorCode.WalletReturnUrlNotAllowed,
    ],
  })
  @ApiErrorResponse({
    status: 503,
    codes: [ApiErrorCode.WalletProviderUnavailable],
  })
  startOauth(@Body() dto: StartWalletOauthDto) {
    return this.walletAuth.startOauth(dto);
  }

  /**
   * Where Authentik, Google or GitHub returns the browser.
   *
   * Documented rather than hidden: this URL is something the operator registers
   * with each provider, so leaving it out of the contract hides the one part of
   * the setup that has to be exactly right. It is never called by a client's
   * code.
   */
  @Get('oauth/callback/:provider')
  @Public()
  @ApiOperation({
    summary: 'Where the provider returns the browser after consent',
    description:
      'Not called by your code — the person’s browser lands here. Public by ' +
      'necessity: a navigation carries no API key and no gateway consumer. It ' +
      'renders a page — or, when the handshake was opened with a `returnTo`, ' +
      'redirects to it with the `state` — and nothing else; the identity is ' +
      'collected by the device that holds the PKCE verifier. Register ' +
      '`{WALLET_AUTH_PUBLIC_BASE_URL}/v1/wallet/auth/oauth/callback/{provider}` ' +
      'with each provider.',
  })
  @ApiParam({ name: 'provider', enum: ['authentik', 'google', 'github'] })
  @ApiQuery({ name: 'code', required: false })
  @ApiQuery({ name: 'state', required: false })
  @ApiQuery({ name: 'error', required: false })
  @ApiResponse({
    status: 200,
    description:
      'A "you can go back to your wallet" page. It never contains the identity ' +
      'or a token.',
    content: { 'text/html': { schema: { type: 'string' } } },
  })
  @ApiResponse({
    status: 302,
    description:
      'The handshake was opened with a `returnTo`: the browser is sent there ' +
      'with `?state=…`, plus `&error=<reason>` when the sign-in did not ' +
      'succeed. The same reason tokens the poll reports; never the identity.',
    headers: {
      Location: {
        description: 'The wallet return URL with `state` (and `error`).',
        schema: { type: 'string' },
      },
    },
  })
  async callback(
    @Param('provider') provider: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const outcome = await this.walletAuth.handleCallback(provider, {
      code,
      state,
      error,
    });
    // A native wallet's auth session closes only when the browser reaches the
    // wallet's own URL, so a handshake opened with one is sent back there.
    if (outcome.redirectTo) {
      res.redirect(302, outcome.redirectTo);
      return;
    }
    // Otherwise always 200 with a page. A status code is for the client that
    // made the request, and the client here is a person looking at a browser.
    res.status(200).type('text/html').send(callbackPage(outcome));
  }

  @Get('oauth/session/:state')
  @AllowPublicKey()
  @RequirePermissions('payments:read')
  // Sized for a wallet polling every couple of seconds while someone reads a
  // consent screen — that is the correct use of this route, not abuse of it.
  @RateLimit(WALLET_AUTH_POLL_RATE_LIMIT)
  @ApiOperation({
    summary: 'Poll a sign-in',
    description:
      'Answers on the `state` alone, and never returns the identity at any ' +
      'status. Poll until it leaves `pending`, then redeem with the verifier.',
  })
  @ApiOkResponse({ type: WalletAuthStatusEntity })
  pollStatus(@Param('state') state: string) {
    return this.walletAuth.pollStatus(state);
  }

  @Post('oauth/claim')
  @AllowPublicKey()
  @RequirePermissions('payments:write')
  @RateLimit(WALLET_AUTH_CLAIM_RATE_LIMIT)
  @ApiOperation({
    summary: 'Redeem a handshake with the PKCE verifier',
    description:
      'A NEW email ends here, with a session token. An email that ALREADY has ' +
      'an account gets `verify_email` instead and a code in its inbox: a ' +
      'provider proves who consented, not who opened the sign-in, and an ' +
      'existing account is where the backup worth stealing is. An Authentik ' +
      'email the provider has not confirmed also gets `verify_email`, account ' +
      'or not, under the same per-address cooldown as `email/start`.',
  })
  @ApiOkResponse(oneOf(WalletAuthReadyEntity, WalletAuthVerifyEmailEntity))
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.WalletVerifierInvalid,
      ApiErrorCode.WalletLoginCodeCooldown,
    ],
  })
  claimOauth(@Body() dto: ClaimWalletOauthDto) {
    return this.walletAuth.claimOauth(dto);
  }

  /* --------------------------------- email -------------------------------- */

  @Post('email/start')
  @AllowPublicKey()
  @RequirePermissions('payments:write')
  // The tight one: the only route here that makes this service send mail to an
  // address the caller chose. A per-row cooldown backs it up, because the
  // budget's subject is a client address and the mailbox is somebody else's.
  @RateLimit(WALLET_AUTH_EMAIL_RATE_LIMIT)
  @ApiOperation({ summary: 'Send a sign-in code to a mailbox' })
  @ApiOkResponse({ type: WalletEmailStartedEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.WalletLoginCodeCooldown],
  })
  startEmail(@Body() dto: StartWalletEmailDto) {
    return this.walletAuth.startEmail(dto);
  }

  @Post('email/verify')
  @AllowPublicKey()
  @RequirePermissions('payments:write')
  @RateLimit(WALLET_AUTH_CLAIM_RATE_LIMIT)
  @ApiOperation({
    summary: 'Answer a sign-in code',
    description:
      'Wrong codes are counted on the row, not by the client. Five burns it, ' +
      'and a burned code is replaced by asking for another.',
  })
  @ApiOkResponse(oneOf(WalletAuthReadyEntity, WalletCodeInvalidEntity))
  verifyEmail(@Body() dto: VerifyWalletEmailDto) {
    return this.walletAuth.verifyEmail(dto);
  }

  /* --------------------------------- finish ------------------------------- */

  @Post('finish')
  @AllowPublicKey()
  @RequirePermissions('payments:write')
  // Verifies an ed25519 signature before it writes, which is real CPU on a route
  // the shared key can reach.
  @RateLimit(WALLET_AUTH_FINISH_RATE_LIMIT)
  @ApiOperation({
    summary: 'Attach the proven identity to the account this device signs for',
    description:
      'Send the session token as `X-Wallet-Session: {sessionToken}` — the ' +
      'gateway strips `Authorization`. The signature covers ' +
      'exactly:\n\n' +
      '```\n' +
      'Cosmos Pay Wallet sign-in\n' +
      'email: {lowercased email}\n' +
      'account: {address}\n' +
      'at: {signedAt}\n' +
      '```\n\n' +
      'signed over those raw UTF-8 bytes with the account key, base64. The ' +
      'first line is one no Stellar transaction envelope can begin with, which ' +
      'is what makes signing it safe.\n\n' +
      'On Solana and Monad (`chain`), a `chain: {chain}` line follows the ' +
      'first one. Solana signs the bytes with ed25519 (`signMessage`; base64 ' +
      'or base58); Monad with EIP-191 `personal_sign` (0x-hex).',
  })
  @ApiHeader({
    name: 'X-Wallet-Session',
    description:
      '{sessionToken}, from the sign-in that just finished. ' +
      '`Authorization: Bearer {sessionToken}` is read too, but only on a ' +
      'direct call: APISIX strips it.',
    required: true,
  })
  @ApiOkResponse({ type: WalletSignInFinishedEntity })
  @ApiErrorResponse({
    status: 401,
    codes: [ApiErrorCode.WalletSessionInvalid],
  })
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.WalletSignatureInvalid,
      ApiErrorCode.WalletBackupInvalid,
      ApiErrorCode.WalletBackupLimit,
    ],
  })
  finish(
    @Headers(WALLET_SESSION_HEADER) session: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: FinishWalletSignInDto,
  ) {
    return this.walletAuth.finish(sessionToken(session, authorization), dto);
  }
}

/**
 * `PUT /v1/wallet/backup` — its own controller because it is its own resource,
 * and because it takes no sign-in at all: the signature by the box's own address
 * is the credential.
 */
@ApiTags('wallet-auth')
@Controller({ path: 'wallet', version: '1' })
export class WalletBackupController {
  constructor(private readonly walletAuth: WalletAuthService) {}

  @Put('backup')
  @AllowPublicKey()
  @RequirePermissions('payments:write')
  @RateLimit(WALLET_AUTH_FINISH_RATE_LIMIT)
  @ApiOperation({
    summary: 'Replace the sealed box stored for an account',
    description:
      'What `changePassword` on the device sends. No session: the signature is ' +
      'the credential, and it covers the SHA-256 of the box — so one signature ' +
      'stores exactly one box and cannot be replayed to store another. The ' +
      'bytes are:\n\n' +
      '```\n' +
      'Cosmos Pay Wallet backup\n' +
      'account: {address}\n' +
      'box: {sha256 hex of box}\n' +
      'at: {signedAt}\n' +
      '```\n\n' +
      'On Solana and Monad a `chain: {chain}` line follows the first one, and ' +
      'the bytes are signed as for sign-in.',
  })
  @ApiOkResponse({ type: WalletBackupUpdatedEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.WalletSignatureInvalid,
      ApiErrorCode.WalletBackupInvalid,
    ],
  })
  @ApiErrorResponse({
    status: 404,
    codes: [ApiErrorCode.WalletAccountMismatch],
  })
  replaceBackup(@Body() dto: ReplaceWalletBackupDto) {
    return this.walletAuth.replaceBackupBox(dto);
  }

  /**
   * `POST /v1/wallet/recovery/setup` — the operator pays the reserve of an
   * account's two SEP-30 signers and hands back the transaction that adds them.
   *
   * Here, on the main deployment, and never on a recovery server: the sponsor
   * key is the operator's money, and the recovery servers are the two hosts that
   * must not also be able to spend it.
   */
  @Post('recovery/setup')
  @HttpCode(200)
  @AllowPublicKey()
  @RequirePermissions('payments:write')
  @RateLimit(
    WALLET_RECOVERY_SETUP_RATE_LIMIT,
    WALLET_RECOVERY_SETUP_GLOBAL_RATE_LIMIT,
  )
  @ApiOperation({
    summary: "Sponsor the reserve of an account's two recovery signers",
    description:
      'Send the session token as `X-Wallet-Session: {sessionToken}` — the ' +
      'gateway strips `Authorization`. The signature covers ' +
      'exactly:\n\n' +
      '```\n' +
      'Cosmos Pay Wallet recovery setup\n' +
      'account: {stellarAddress}\n' +
      'signers: {signerA},{signerB}\n' +
      'at: {signedAt}\n' +
      '```\n\n' +
      'The envelope comes back signed by the sponsor only. Once per account: ' +
      'refused when the account already has a signer besides its master key.',
  })
  @ApiHeader({
    name: 'X-Wallet-Session',
    description:
      '{sessionToken}. `Authorization: Bearer {sessionToken}` is read too, ' +
      'but only on a direct call: APISIX strips it.',
    required: true,
  })
  @ApiOkResponse({ type: WalletRecoverySetupEntity })
  @ApiErrorResponse({ status: 401, codes: [ApiErrorCode.WalletSessionInvalid] })
  @ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.WalletSignatureInvalid],
  })
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.WalletRecoverySetupRefused],
  })
  sponsorRecoverySetup(
    @Headers(WALLET_SESSION_HEADER) session: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: SponsorRecoverySetupDto,
  ) {
    return this.walletAuth.sponsorRecoverySetup(
      sessionToken(session, authorization),
      dto,
    );
  }
}

/**
 * The session token, or a refusal.
 *
 * `X-Wallet-Session` first: through APISIX it is the only place the token can
 * ride, because the gateway strips `Authorization` (see WALLET_SESSION_HEADER).
 * A `Bearer` in `Authorization` is the fallback for a direct call.
 *
 * Refusing an absent token here rather than letting an empty string reach
 * `readSessionToken` keeps the two failures apart: "you sent no token" and "the
 * token you sent is not good" are different sentences, and the second one sends
 * whoever is debugging to look at their sealing secret.
 */
function sessionToken(
  session: string | undefined,
  authorization: string | undefined,
): string {
  const direct = session?.trim();
  if (direct) return direct;
  const match = /^Bearer\s+(.+)$/i.exec(authorization?.trim() ?? '');
  if (!match) {
    throw ApiError.unauthorized(
      ApiErrorCode.WalletSessionInvalid,
      'Send the session token as `X-Wallet-Session: {token}`.',
    );
  }
  return match[1].trim();
}
