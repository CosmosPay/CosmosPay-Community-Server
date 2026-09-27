import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiExcludeEndpoint,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { ApiErrorCode } from '@/common/errors/api-error';
import { AllowPublicKey } from '@/common/decorators/allow-public-key.decorator';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { ConsoleOnlyGuard } from '@/common/guards/console-only.guard';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import {
  ALIAS_CHALLENGE_RATE_LIMIT,
  ALIAS_RECOVERY_COMPLETE_RATE_LIMIT,
} from '@/aliases/aliases.constants';
import { AliasesService } from '@/aliases/aliases.service';
import {
  AddAliasAddressDto,
  ClaimAliasDto,
  CompleteAliasRecoveryDto,
  CreateAliasChallengeDto,
  QueryAliasesDto,
  StartAliasRecoveryDto,
} from '@/aliases/dto/alias.dto';
import {
  AliasAddressEntity,
  AliasAvailabilityEntity,
  AliasByAddressEntity,
  AliasChallengeEntity,
  AliasDeletedEntity,
  AliasListEntity,
  AliasRecoveryStartedEntity,
  AliasResolutionEntity,
  OwnedAliasEntity,
} from '@/aliases/entities/alias.entity';

/**
 * Claimable payment handles — `emanuel250` instead of `GA5ZSE…`.
 *
 * Two audiences, and the split decides every decorator here:
 *
 *  * **Payers** resolve a handle and read an address list. Those routes carry
 *    `@AllowPublicKey()` because a payer is by definition the anonymous caller the
 *    shared key exists for, and their responses are a pure function of the request
 *    — nothing about who asked, and never the owner's mailbox.
 *  * **Owners** claim, add addresses and recover. Those need a real account key:
 *    an alias is bound to the consumer that holds it, and the shared key
 *    authenticates every anonymous wallet as ONE consumer, so claiming with it
 *    would make a single "owner" of every alias on the platform.
 *
 * One route belongs to neither: STARTING a recovery is the platform console's,
 * because its response is the token that proves the owner's mailbox and the
 * console is what emails it.
 */
@ApiTags('aliases')
@Controller({ path: 'aliases', version: '1' })
export class AliasesController {
  constructor(private readonly aliases: AliasesService) {}

  /* ------------------------------- payer side ------------------------------ */

  @Get('resolve/:name')
  @AllowPublicKey()
  @RequirePermissions('payments:read')
  @ApiOperation({ summary: 'Resolve an alias to its addresses' })
  @ApiQuery({
    name: 'network',
    required: false,
    description: 'Limit to one network (public | testnet | a custom id).',
  })
  @ApiOkResponse({ type: AliasResolutionEntity })
  resolve(@Param('name') name: string, @Query('network') network?: string) {
    return this.aliases.resolve(name, network);
  }

  @Get('availability/:name')
  @AllowPublicKey()
  @RequirePermissions('payments:read')
  @ApiOperation({ summary: 'Is this handle claimable, and if not why not' })
  @ApiOkResponse({ type: AliasAvailabilityEntity })
  availability(@Param('name') name: string) {
    return this.aliases.availability(name);
  }

  @Get('by-address/:address')
  @AllowPublicKey()
  @RequirePermissions('payments:read')
  @ApiOperation({ summary: 'Which aliases point at this address' })
  @ApiOkResponse({ type: AliasByAddressEntity })
  @ApiQuery({ name: 'network', required: false })
  byAddress(
    @Param('address') address: string,
    @Query('network') network?: string,
  ) {
    return this.aliases.findByAddress(address, network);
  }

  /* ------------------------------- owner side ------------------------------ */

  @Post('challenges')
  @RequirePermissions('payments:write')
  // Every call stores a challenge row, which outlives its TTL by a day.
  @RateLimit(ALIAS_CHALLENGE_RATE_LIMIT)
  @ApiOperation({
    summary: 'Get a nonce to sign',
    description:
      'Returns the EXACT message to digest and sign. Single-use and short-lived; ' +
      'the purpose is inside the signed bytes, so a signature collected to add an ' +
      'address cannot be replayed to complete a recovery.',
  })
  @ApiCreatedResponse({ type: AliasChallengeEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.ValidationFailed, ApiErrorCode.AliasNameInvalid],
  })
  challenge(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateAliasChallengeDto,
  ) {
    return this.aliases.createChallenge(consumer, dto);
  }

  @Post()
  @RequirePermissions('payments:write')
  @ApiOperation({ summary: 'Claim an alias with a signature' })
  @ApiCreatedResponse({ type: OwnedAliasEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.ValidationFailed,
      ApiErrorCode.AliasNameInvalid,
      ApiErrorCode.AliasChallengeInvalid,
      ApiErrorCode.AliasSignatureInvalid,
      ApiErrorCode.AliasAddressConflict,
    ],
  })
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.AliasTaken],
    description:
      '`alias_taken` — someone claimed the handle first. There is no queue ' +
      'and no reservation: pick another name.',
  })
  claim(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: ClaimAliasDto,
  ) {
    return this.aliases.claim(consumer, dto);
  }

  @Get()
  @RequirePermissions('payments:read')
  @ApiOperation({ summary: "List the caller's aliases" })
  @ApiOkResponse({ type: AliasListEntity })
  list(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryAliasesDto,
  ) {
    return this.aliases.listOwned(consumer, query);
  }

  @Post(':name/addresses')
  @RequirePermissions('payments:write')
  @ApiOperation({
    summary: 'Point the alias at another address',
    description:
      'Needs two proofs: the caller owns the alias, and the NEW address signs for ' +
      'itself. One alias may hold many addresses across many networks.',
  })
  @ApiCreatedResponse({ type: AliasAddressEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.ValidationFailed,
      ApiErrorCode.AliasChallengeInvalid,
      ApiErrorCode.AliasSignatureInvalid,
      ApiErrorCode.AliasAddressConflict,
    ],
  })
  addAddress(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('name') name: string,
    @Body() dto: AddAliasAddressDto,
  ) {
    return this.aliases.addAddress(consumer, name, dto);
  }

  @Delete(':name/addresses/:addressId')
  @RequirePermissions('payments:write')
  @ApiOperation({ summary: 'Remove one address from the alias' })
  @ApiOkResponse({ type: AliasDeletedEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.AliasAddressConflict],
    description:
      '`alias_address_conflict` — an alias must keep at least one address. ' +
      'Release the alias instead.',
  })
  removeAddress(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('name') name: string,
    @Param('addressId') addressId: string,
  ) {
    return this.aliases.removeAddress(consumer, name, addressId);
  }

  @Delete(':name')
  @RequirePermissions('payments:write')
  @ApiOperation({ summary: 'Release the alias back to the namespace' })
  @ApiOkResponse({ type: AliasDeletedEntity })
  release(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('name') name: string,
  ) {
    return this.aliases.release(consumer, name);
  }

  /* -------------------------------- recovery ------------------------------- */

  @Post(':name/recovery')
  // Console only, and out of the published contract. This service sends no mail,
  // so the response carries the token for the console to deliver — and the token
  // IS the proof of mailbox control. Behind a scope it proved nothing: any key
  // holder who knew a handle and its owner's email got the token back and could
  // complete the recovery with a key of their own, taking every payment sent to
  // that name. No scope is declared because a console call is not an API-key call
  // (the same as `/v1/admin`); the guard refuses before the alias is looked up.
  @UseGuards(ConsoleOnlyGuard)
  @ApiExcludeEndpoint()
  @ApiOperation({
    summary: 'Start email recovery (platform console only)',
    description:
      'The response is IDENTICAL whether or not the alias and mailbox matched. A ' +
      'handle is public and the mailbox behind it is not, so a differing answer ' +
      'would confirm who owns it to anyone who asked.',
  })
  @ApiCreatedResponse({ type: AliasRecoveryStartedEntity })
  startRecovery(
    @Param('name') name: string,
    @Body() dto: StartAliasRecoveryDto,
  ) {
    return this.aliases.startRecovery(name, dto);
  }

  @Post(':name/recovery/complete')
  @RequirePermissions('payments:write')
  // Handles are public, so any key can aim this at any alias. Junk tokens write
  // nothing, which leaves this limit as the bound on how fast one address tries.
  @RateLimit(ALIAS_RECOVERY_COMPLETE_RATE_LIMIT)
  @ApiOperation({
    summary: 'Finish recovery: take ownership with a new address',
    description:
      'Needs the emailed token AND a signature from the new key. Every previous ' +
      'address is dropped — recovery exists because the old keys are gone, and ' +
      'leaving them resolvable would keep whoever holds them receiving payments.',
  })
  @ApiOkResponse({ type: OwnedAliasEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.ValidationFailed,
      ApiErrorCode.AliasRecoveryInvalid,
      ApiErrorCode.AliasSignatureInvalid,
      ApiErrorCode.AliasAddressConflict,
    ],
  })
  completeRecovery(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('name') name: string,
    @Body() dto: CompleteAliasRecoveryDto,
  ) {
    return this.aliases.completeRecovery(consumer, name, dto);
  }
}
