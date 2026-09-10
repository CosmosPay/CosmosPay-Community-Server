import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { AllowPublicKey } from '@/common/decorators/allow-public-key.decorator';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
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
  @ApiOperation({
    summary: 'Get a nonce to sign',
    description:
      'Returns the EXACT message to digest and sign. Single-use and short-lived; ' +
      'the purpose is inside the signed bytes, so a signature collected to add an ' +
      'address cannot be replayed to complete a recovery.',
  })
  @ApiCreatedResponse({ type: AliasChallengeEntity })
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
  @RequirePermissions('payments:write')
  @ApiOperation({
    summary: 'Start email recovery',
    description:
      'The response is IDENTICAL whether or not the alias and mailbox matched. A ' +
      'handle is public and the mailbox behind it is not, so a differing answer ' +
      'would confirm who owns it to anyone who asked. This service sends no mail: ' +
      'it returns the token for the caller to deliver, exactly as the KYC ' +
      'terms-of-service flow does.',
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
  @ApiOperation({
    summary: 'Finish recovery: take ownership with a new address',
    description:
      'Needs the emailed token AND a signature from the new key. Every previous ' +
      'address is dropped — recovery exists because the old keys are gone, and ' +
      'leaving them resolvable would keep whoever holds them receiving payments.',
  })
  @ApiOkResponse({ type: OwnedAliasEntity })
  completeRecovery(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('name') name: string,
    @Body() dto: CompleteAliasRecoveryDto,
  ) {
    return this.aliases.completeRecovery(consumer, name, dto);
  }
}
