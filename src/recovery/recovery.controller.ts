import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Res,
  UseFilters,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { Public } from '@/common/decorators/public.decorator';
import { SEP_TOKEN_SCHEME } from '@/swagger';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import {
  RecoveryEmailStartDto,
  RecoveryEmailVerifyDto,
  RecoveryIdTokenDto,
  Sep10ChallengeQueryDto,
  Sep10TokenDto,
  Sep30AddressParamDto,
  Sep30IdentitiesDto,
  Sep30ListQueryDto,
  Sep30SignDto,
  Sep30SignParamDto,
} from '@/recovery/dto/recovery.dto';
import type { Identity } from '@/recovery/recovery-core';
import {
  RECOVERY_CODE_RATE_LIMIT,
  RECOVERY_EMAIL_RATE_LIMIT,
  RECOVERY_IDENTITY_RATE_LIMIT,
  SEP10_CHALLENGE_RATE_LIMIT,
  SEP10_TOKEN_RATE_LIMIT,
  SEP30_READ_RATE_LIMIT,
  SEP30_SIGN_RATE_LIMIT,
  SEP30_WRITE_RATE_LIMIT,
} from '@/recovery/recovery.constants';
import { RecoveryService } from '@/recovery/recovery.service';
import { SepExceptionFilter } from '@/recovery/sep-exception.filter';

/*
 * Every route in this file is `@Public()`, and that is the standard, not a
 * shortcut: SEP-10 and SEP-30 are called by wallets that hold no API key of
 * ours — somebody else's included. Proving control of the account IS SEP-10's
 * authentication, and the SEP-10 or identity token is SEP-30's. Budgets are per
 * client address (`recovery.constants.ts`), and APISIX serves these prefixes on
 * a keyless route.
 *
 * A deployment that is not a recovery server (no `RECOVERY_ROLE`) answers 404 on
 * all of them — see `RecoveryService.rules`.
 */

/** `GET /.well-known/stellar.toml` — SEP-1, at the host root, unversioned. */
@ApiTags('recovery')
@Controller({ path: '.well-known', version: VERSION_NEUTRAL })
export class StellarTomlController {
  constructor(private readonly recovery: RecoveryService) {}

  @Get('stellar.toml')
  @Public()
  @ApiOperation({
    summary: 'SEP-1 discovery for this recovery server',
    description:
      'WEB_AUTH_ENDPOINT and SIGNING_KEY (SEP-10), HOME_DOMAIN, and a ' +
      '[[RECOVERY_SERVERS]] entry with the SEP-30 ENDPOINT, the ROLE and the ' +
      'identity methods. 404 on a deployment that is not a recovery server.',
  })
  @ApiResponse({
    status: 200,
    content: { 'text/plain': { schema: { type: 'string' } } },
  })
  toml(@Res() res: Response): void {
    let body: string;
    try {
      body = this.recovery.stellarToml();
    } catch {
      // Absent is a fact a client can act on; a file of empty fields looks
      // answerable and is not.
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    res
      .status(200)
      .type('text/plain; charset=utf-8')
      .setHeader('Cache-Control', 'public, max-age=300');
    res.send(body);
  }
}

/** `GET|POST /v1/sep10/auth` — SEP-10 Stellar Web Authentication. */
@ApiTags('recovery')
@UseFilters(SepExceptionFilter)
@Controller({ path: 'sep10', version: '1' })
export class Sep10Controller {
  constructor(private readonly recovery: RecoveryService) {}

  @Get('auth')
  @Public()
  @RateLimit(SEP10_CHALLENGE_RATE_LIMIT)
  @ApiOperation({
    summary: 'A challenge for an account',
    description: 'Sequence 0: unsubmittable by construction.',
  })
  challenge(@Query() query: Sep10ChallengeQueryDto) {
    return this.recovery.challenge(query.account);
  }

  @Post('auth')
  @HttpCode(200)
  @Public()
  @RateLimit(SEP10_TOKEN_RATE_LIMIT)
  @ApiOperation({
    summary: 'Exchange a signed challenge for a token',
    description:
      "Weighed against the account's CURRENT signers and medium threshold, so a " +
      'recovered account authenticates with the key that replaced its master.',
  })
  token(@Body() body: Sep10TokenDto) {
    return this.recovery.token(body.transaction);
  }
}

/** SEP-30 plus this server's two ways to prove an inbox. */
@ApiTags('recovery')
@UseFilters(SepExceptionFilter)
@Controller({ path: 'sep30', version: '1' })
export class Sep30Controller {
  constructor(private readonly recovery: RecoveryService) {}

  /* ------------------------------- identities ------------------------------ */

  @Post('identity')
  @HttpCode(200)
  @Public()
  @RateLimit(RECOVERY_IDENTITY_RATE_LIMIT)
  @ApiOperation({
    summary: "Exchange an OIDC ID token for this server's identity token",
    description:
      'SEP-30 "external" authentication. The ID token is verified against the ' +
      "provider's published keys, must stand for a login in the last 15 " +
      'minutes, must carry a VERIFIED email, and is accepted once per server.',
  })
  exchange(@Body() body: RecoveryIdTokenDto) {
    return this.recovery.exchangeIdToken(body.id_token);
  }

  @Post('identity/email/start')
  @HttpCode(200)
  @Public()
  @RateLimit(RECOVERY_EMAIL_RATE_LIMIT)
  @ApiOperation({
    summary: 'Email a code that proves an inbox to this server',
    description:
      'The same answer whether or not the address recovers anything here; a ' +
      'code is only sent to one that does.',
  })
  startEmail(@Body() body: RecoveryEmailStartDto) {
    return this.recovery.startEmail(body.email);
  }

  @Post('identity/email/verify')
  @HttpCode(200)
  @Public()
  @RateLimit(RECOVERY_CODE_RATE_LIMIT)
  @ApiOperation({
    summary: 'Answer an emailed code',
    description: 'Five wrong answers burn it.',
  })
  verifyEmail(@Body() body: RecoveryEmailVerifyDto) {
    return this.recovery.verifyEmail(body.claim_token, body.code);
  }

  /* --------------------------------- SEP-30 -------------------------------- */

  @Get('accounts')
  @ApiBearerAuth(SEP_TOKEN_SCHEME)
  @Public()
  @RateLimit(SEP30_READ_RATE_LIMIT)
  @ApiOperation({
    summary: 'Accounts this caller may recover (paged by `after`)',
  })
  list(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: Sep30ListQueryDto,
  ) {
    return this.recovery.list(authorization, query.after);
  }

  @Post('accounts/:address')
  @ApiBearerAuth(SEP_TOKEN_SCHEME)
  // 200, as the reference implementation answers; a client reads the body, and
  // one that insisted on 201 would be insisting on a status the spec never names.
  @HttpCode(200)
  @Public()
  @RateLimit(SEP30_WRITE_RATE_LIMIT)
  @ApiOperation({
    summary: 'Register an account (SEP-10 token of that account)',
  })
  register(
    @Headers('authorization') authorization: string | undefined,
    @Param() params: Sep30AddressParamDto,
    @Body() body: Sep30IdentitiesDto,
  ) {
    return this.recovery.register(
      authorization,
      params.address,
      body.identities as Identity[],
    );
  }

  @Put('accounts/:address')
  @ApiBearerAuth(SEP_TOKEN_SCHEME)
  @Public()
  @RateLimit(SEP30_WRITE_RATE_LIMIT)
  @ApiOperation({
    summary:
      'Replace who may recover an account (SEP-10 token of that account)',
  })
  update(
    @Headers('authorization') authorization: string | undefined,
    @Param() params: Sep30AddressParamDto,
    @Body() body: Sep30IdentitiesDto,
  ) {
    return this.recovery.update(
      authorization,
      params.address,
      body.identities as Identity[],
    );
  }

  @Get('accounts/:address')
  @ApiBearerAuth(SEP_TOKEN_SCHEME)
  @Public()
  @RateLimit(SEP30_READ_RATE_LIMIT)
  @ApiOperation({ summary: 'Describe an account' })
  get(
    @Headers('authorization') authorization: string | undefined,
    @Param() params: Sep30AddressParamDto,
  ) {
    return this.recovery.get(authorization, params.address);
  }

  @Delete('accounts/:address')
  @ApiBearerAuth(SEP_TOKEN_SCHEME)
  @Public()
  @RateLimit(SEP30_WRITE_RATE_LIMIT)
  @ApiOperation({ summary: 'Forget an account (SEP-10 token of that account)' })
  remove(
    @Headers('authorization') authorization: string | undefined,
    @Param() params: Sep30AddressParamDto,
  ) {
    return this.recovery.remove(authorization, params.address);
  }

  @Post('accounts/:address/sign/:signer')
  @ApiBearerAuth(SEP_TOKEN_SCHEME)
  @HttpCode(200)
  @Public()
  @RateLimit(SEP30_SIGN_RATE_LIMIT)
  @ApiOperation({
    summary: 'Co-sign a recovery transaction',
    description:
      'Returns the SIGNATURE, not an envelope. Only an account-control change on ' +
      'the registered account, sourced by it, with no memo, valid for at most 15 ' +
      'minutes.',
  })
  sign(
    @Headers('authorization') authorization: string | undefined,
    @Param() params: Sep30SignParamDto,
    @Body() body: Sep30SignDto,
  ) {
    return this.recovery.sign(
      authorization,
      params.address,
      params.signer,
      body.transaction,
    );
  }
}
