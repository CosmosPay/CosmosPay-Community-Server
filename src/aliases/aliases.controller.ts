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
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { ApiErrorCode } from '@/common/errors/api-error';
import { AllowPublicKey } from '@/common/decorators/allow-public-key.decorator';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { UniformAnswer } from '@/common/decorators/uniform-answer.decorator';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import {
  ALIAS_CHALLENGE_RATE_LIMIT,
  ALIAS_RECOVERY_COMPLETE_RATE_LIMIT,
  ALIAS_RECOVERY_START_RATE_LIMIT,
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
import { CHAINS, type Chain } from '@/chains/chains.constants';
import { ParseOptionalChainPipe } from '@/chains/parse-chain.pipe';

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
  @ApiOperation({
    summary: 'Resolve an alias to its addresses',
    description:
      'Answers the addresses of the alias on one chain (Stellar unless `chain` ' +
      'names another), optionally narrowed to one `network`, primary first, ' +
      'with `primaryAddress` as the default to pay (null when it has none ' +
      'there). The name is matched trimmed and lowercased. An unknown or ' +
      'suspended alias is a 404, and nothing about its owner is returned.',
  })
  @ApiQuery({
    name: 'network',
    required: false,
    description: 'Limit to one network (public | testnet | a custom id).',
  })
  @ApiQuery({
    name: 'chain',
    required: false,
    enum: CHAINS,
    description:
      'The chain to resolve on. Omit for Stellar: a wallet that does not ask ' +
      'for a chain is never handed another chain’s address.',
  })
  @ApiOkResponse({ type: AliasResolutionEntity })
  resolve(
    @Param('name') name: string,
    @Query('network') network?: string,
    @Query('chain', ParseOptionalChainPipe) chain?: Chain,
  ) {
    return this.aliases.resolve(name, network, chain);
  }

  @Get('availability/:name')
  @AllowPublicKey()
  @RequirePermissions('payments:read')
  @ApiOperation({
    summary: 'Is this handle claimable, and if not why not',
    description:
      'Checks the trimmed, lowercased handle and answers `available`, with a ' +
      '`reason` when it is not: `too_short` or `too_long` (3 to 32 ' +
      'characters), `bad_characters` (a-z, 0-9 and underscores, starting and ' +
      'ending with a letter or digit), `reserved`, `address_like` (it would ' +
      'read as a Stellar address) or `taken`. It reserves nothing: a claim ' +
      'can still lose the name with `409 alias_taken`.',
  })
  @ApiOkResponse({ type: AliasAvailabilityEntity })
  availability(@Param('name') name: string) {
    return this.aliases.availability(name);
  }

  @Get('by-address/:address')
  @AllowPublicKey()
  @RequirePermissions('payments:read')
  @ApiOperation({
    summary: 'Which aliases point at this address',
    description:
      'The active aliases holding this address, oldest first, each with its ' +
      '`chain`, `network` and whether the address is its primary there, as ' +
      '`{ data }` (not paged). Without `chain` the chain is read off the ' +
      "address's own shape, and a Monad address matches whatever its letter " +
      'case. An address no chain accepts answers an empty `data`, not an error.',
  })
  @ApiOkResponse({ type: AliasByAddressEntity })
  @ApiQuery({
    name: 'network',
    required: false,
    description:
      'Limit to addresses registered on this network (public | testnet | a ' +
      'custom id). Omit for every network.',
  })
  @ApiQuery({
    name: 'chain',
    required: false,
    enum: CHAINS,
    description: 'Omit to read the chain off the address’s own shape.',
  })
  byAddress(
    @Param('address') address: string,
    @Query('network') network?: string,
    @Query('chain', ParseOptionalChainPipe) chain?: Chain,
  ) {
    return this.aliases.findByAddress(address, network, chain);
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
  @ApiOperation({
    summary: 'Claim an alias with a signature',
    description:
      'Takes the `nonce` of a `CLAIM` challenge from ' +
      '`POST /v1/aliases/challenges` and the signature over its message: the ' +
      "address, chain and network registered are the challenge's, never the " +
      "body's, and that address becomes the alias's primary. A challenge is " +
      'single-use and lives 5 minutes (`alias_challenge_invalid`); a signature ' +
      'that does not verify is `alias_signature_invalid`. `email` is the ' +
      'mailbox recovery goes to, a consumer holds at most 25 aliases ' +
      '(`400 alias_address_conflict`) and the first claim of a name wins ' +
      '(`409 alias_taken`).',
  })
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
      '`alias_taken`: someone claimed the handle first. There is no queue ' +
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
  @ApiOperation({
    summary: "List the caller's aliases",
    description:
      'The aliases this consumer holds, newest first, each with its recovery ' +
      '`email`, `status` and every address on every chain and network ' +
      '(primary first). Paged with `take` (default and maximum 50) and ' +
      '`skip`; answers `{ data, total, take, skip }`.',
  })
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
  @ApiOperation({
    summary: 'Remove one address from the alias',
    description:
      'Deletes one address of an alias this consumer holds. When it was the ' +
      'primary on its chain and network, the oldest remaining address there ' +
      'becomes primary. The last address of the alias cannot be removed: ' +
      'release the alias instead.',
  })
  @ApiOkResponse({ type: AliasDeletedEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.AliasAddressConflict],
    description:
      '`alias_address_conflict`: an alias must keep at least one address. ' +
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
  @ApiOperation({
    summary: 'Release the alias back to the namespace',
    description:
      'Deletes an alias this consumer holds, with all its addresses, so anyone ' +
      'can claim the name again. An alias held by another consumer is a 404.',
  })
  @ApiOkResponse({ type: AliasDeletedEntity })
  release(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('name') name: string,
  ) {
    return this.aliases.release(consumer, name);
  }

  /* -------------------------------- recovery ------------------------------- */

  @Post(':name/recovery')
  // Open to the shared public key: whoever lost their keys has no account to call
  // it with. That is safe because the token — the proof of mailbox control — is
  // emailed to the mailbox on record and never returned: a caller can make the
  // owner receive a mail, nothing more. It used to be returned to the developer
  // platform's console to deliver, which put the platform in this path.
  @AllowPublicKey()
  @RequirePermissions('payments:write')
  // Every accepted call may send an email.
  @RateLimit(ALIAS_RECOVERY_START_RATE_LIMIT)
  @UniformAnswer()
  @ApiOperation({
    summary: 'Start email recovery: the token is emailed to the owner',
    description:
      'Always `{ accepted: true }`, whether or not the alias exists and the mailbox ' +
      'matched: a handle is public and the mailbox behind it is not. When both ' +
      'match, the token is emailed to the mailbox on record (at most once a minute ' +
      'per alias); it never appears in the response.',
  })
  @ApiCreatedResponse({ type: AliasRecoveryStartedEntity })
  @ApiErrorResponse({ status: 503, codes: [ApiErrorCode.Misconfigured] })
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
      'address is dropped: recovery exists because the old keys are gone, and ' +
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
