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
import { ApiUpstream } from '@/common/decorators/api-upstream.decorator';
import { Public } from '@/common/decorators/public.decorator';
import { SEP_TOKEN_SCHEME } from '@/swagger';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import {
  RecoveryEmailStartDto,
  RecoveryEmailVerifyDto,
  RecoveryIdTokenDto,
  RecoveryShareDto,
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
  RECOVERY_SHARE_READ_RATE_LIMIT,
  RECOVERY_SHARE_WRITE_RATE_LIMIT,
  SEP10_CHALLENGE_RATE_LIMIT,
  SEP10_TOKEN_RATE_LIMIT,
  SEP30_READ_RATE_LIMIT,
  SEP30_SIGN_RATE_LIMIT,
  SEP30_WRITE_RATE_LIMIT,
} from '@/recovery/recovery.constants';
import { RecoveryService } from '@/recovery/recovery.service';
import { RecoveryNetwork, tomlNetwork } from '@/recovery/recovery-network';
import type { StellarNetwork } from '@/config/configuration';
import { RecoverySharesService } from '@/recovery/recovery-shares.service';
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
  toml(@Res() res: Response, @Query('network') rawNetwork?: string): void {
    let body: string;
    try {
      // `?network=public|testnet` picks the ledger; none is the default one.
      const network = tomlNetwork(rawNetwork);
      if (network === undefined) throw new Error('unknown network');
      body = this.recovery.stellarToml(network);
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
  challenge(
    @Query() query: Sep10ChallengeQueryDto,
    @RecoveryNetwork() network: StellarNetwork | null,
  ) {
    return this.recovery.challenge(query.account, network);
  }

  @Post('auth')
  @HttpCode(200)
  @Public()
  @RateLimit(SEP10_TOKEN_RATE_LIMIT)
  // The challenge is weighed against the signer set Horizon reports; a lookup
  // that fails answers 503 (`{ error }`, via SepExceptionFilter).
  @ApiUpstream('Horizon')
  @ApiOperation({
    summary: 'Exchange a signed challenge for a token',
    description:
      "Weighed against the account's CURRENT signers and medium threshold, so a " +
      'recovered account authenticates with the key that replaced its master.',
  })
  token(
    @Body() body: Sep10TokenDto,
    @RecoveryNetwork() network: StellarNetwork | null,
  ) {
    return this.recovery.token(body.transaction, network);
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
  exchange(
    @Body() body: RecoveryIdTokenDto,
    @RecoveryNetwork() network: StellarNetwork | null,
  ) {
    return this.recovery.exchangeIdToken(body.id_token, network);
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
  startEmail(
    @Body() body: RecoveryEmailStartDto,
    @RecoveryNetwork() network: StellarNetwork | null,
  ) {
    return this.recovery.startEmail(body.email, network);
  }

  @Post('identity/email/verify')
  @HttpCode(200)
  @Public()
  @RateLimit(RECOVERY_CODE_RATE_LIMIT)
  @ApiOperation({
    summary: 'Answer an emailed code',
    description: 'Five wrong answers burn it.',
  })
  verifyEmail(
    @Body() body: RecoveryEmailVerifyDto,
    @RecoveryNetwork() network: StellarNetwork | null,
  ) {
    return this.recovery.verifyEmail(body.claim_token, body.code, network);
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
    @RecoveryNetwork() network: StellarNetwork | null,
  ) {
    return this.recovery.list(authorization, query.after, network);
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
    @RecoveryNetwork() network: StellarNetwork | null,
  ) {
    return this.recovery.register(
      authorization,
      params.address,
      body.identities as Identity[],
      network,
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
    @RecoveryNetwork() network: StellarNetwork | null,
  ) {
    return this.recovery.update(
      authorization,
      params.address,
      body.identities as Identity[],
      network,
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
    @RecoveryNetwork() network: StellarNetwork | null,
  ) {
    return this.recovery.get(authorization, params.address, network);
  }

  @Delete('accounts/:address')
  @ApiBearerAuth(SEP_TOKEN_SCHEME)
  @Public()
  @RateLimit(SEP30_WRITE_RATE_LIMIT)
  @ApiOperation({ summary: 'Forget an account (SEP-10 token of that account)' })
  remove(
    @Headers('authorization') authorization: string | undefined,
    @Param() params: Sep30AddressParamDto,
    @RecoveryNetwork() network: StellarNetwork | null,
  ) {
    return this.recovery.remove(authorization, params.address, network);
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
    @RecoveryNetwork() network: StellarNetwork | null,
  ) {
    return this.recovery.sign(
      authorization,
      params.address,
      params.signer,
      body.transaction,
      network,
    );
  }
}

/**
 * `/v1/sep30/shares/:address` — this server's half of a wallet backup's
 * recovery key. A Cosmos extension beside SEP-30, under its prefix so it rides
 * the same keyless route and the same two proofs; see `RecoverySharesService`.
 */
@ApiTags('recovery')
@UseFilters(SepExceptionFilter)
@Controller({ path: 'sep30/shares', version: '1' })
export class RecoverySharesController {
  constructor(private readonly shares: RecoverySharesService) {}

  @Get()
  @ApiBearerAuth(SEP_TOKEN_SCHEME)
  @Public()
  @RateLimit(RECOVERY_SHARE_READ_RATE_LIMIT)
  @ApiOperation({
    summary:
      'Every half this server holds for the proven inbox (paged by `after`)',
    description:
      "This server's identity token for an email. One proof brings back the " +
      'halves of every wallet backed up under it.',
  })
  list(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: Sep30ListQueryDto,
    @RecoveryNetwork() network: StellarNetwork | null,
  ) {
    return this.shares.list(authorization, query.after, network);
  }

  @Put(':address')
  @ApiBearerAuth(SEP_TOKEN_SCHEME)
  @Public()
  @RateLimit(RECOVERY_SHARE_WRITE_RATE_LIMIT)
  @ApiOperation({
    summary:
      "File this server's half of a backup's recovery key (SEP-10 token of that account)",
    description:
      'Replaces any half filed before: a re-sealed backup has a new key. The ' +
      'email is who may take the half back.',
  })
  put(
    @Headers('authorization') authorization: string | undefined,
    @Param() params: Sep30AddressParamDto,
    @Body() body: RecoveryShareDto,
    @RecoveryNetwork() network: StellarNetwork | null,
  ) {
    return this.shares.put(
      authorization,
      params.address,
      body.share,
      body.email,
      network,
    );
  }

  @Get(':address')
  @ApiBearerAuth(SEP_TOKEN_SCHEME)
  @Public()
  @RateLimit(RECOVERY_SHARE_READ_RATE_LIMIT)
  @ApiOperation({
    summary:
      "Take this server's half back (the account's key, or its proven inbox)",
    description:
      "The account's SEP-10 token, or this server's identity token for the " +
      'email the half was filed under. Absent and not-yours are the same 404.',
  })
  get(
    @Headers('authorization') authorization: string | undefined,
    @Param() params: Sep30AddressParamDto,
    @RecoveryNetwork() network: StellarNetwork | null,
  ) {
    return this.shares.get(authorization, params.address, network);
  }

  @Delete(':address')
  @ApiBearerAuth(SEP_TOKEN_SCHEME)
  @Public()
  @RateLimit(RECOVERY_SHARE_WRITE_RATE_LIMIT)
  @ApiOperation({
    summary: "Forget this server's half (SEP-10 token of that account)",
  })
  remove(
    @Headers('authorization') authorization: string | undefined,
    @Param() params: Sep30AddressParamDto,
    @RecoveryNetwork() network: StellarNetwork | null,
  ) {
    return this.shares.remove(authorization, params.address, network);
  }
}
