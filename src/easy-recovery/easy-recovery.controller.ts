import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { AllowPublicKey } from '@/common/decorators/allow-public-key.decorator';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { ApiErrorCode } from '@/common/errors/api-error';
import {
  ClaimEasyRecoveryDto,
  CreateEasyRecoverySessionDto,
  OfferEasyRecoveryDto,
} from '@/easy-recovery/dto/easy-recovery.dto';
import {
  EASY_RECOVERY_CLAIM_RATE_LIMIT,
  EASY_RECOVERY_CREATE_RATE_LIMIT,
  EASY_RECOVERY_OFFER_RATE_LIMIT,
  EASY_RECOVERY_POLL_RATE_LIMIT,
} from '@/easy-recovery/easy-recovery.constants';
import { EasyRecoveryService } from '@/easy-recovery/easy-recovery.service';
import {
  EasyRecoveryClaimedEntity,
  EasyRecoveryOfferedEntity,
  EasyRecoverySessionCreatedEntity,
  EasyRecoverySessionStatusEntity,
} from '@/easy-recovery/entities/easy-recovery.entity';

const SESSION_ID_PARAM = {
  name: 'id',
  description:
    'The session id from `POST /v1/wallet/easy-recovery/sessions`, as the QR ' +
    'carries it: 22 base64url characters.',
  example: 'q2Z7rT0aV1bX9cD4eF6gHw',
};

/** The 404 example, at the path of the route that publishes it. */
const notFoundAt = (action: 'offer' | 'claim') => ({
  [ApiErrorCode.EasyRecoveryNotFound]: {
    path: `/v1/wallet/easy-recovery/sessions/${SESSION_ID_PARAM.example}/${action}`,
  },
});

/**
 * Easy recovery: moving a wallet from an old device to a new one.
 *
 * Every route takes the SHARED public key, like the wallet's sign-in: the new
 * device has no account yet, and the old one need not be signed in to move its
 * own wallet. That is safe because no route reads back anything a caller could
 * not already prove: the session id is 128 random bits minted here, its status
 * is all a read returns, and the one secret this service holds — the wallet
 * sealed to the new device's key — goes out once, to the code shown on the old
 * device, with five tries. A session id is therefore the handle to a session and
 * not a record token: it is never listed, and holding someone else's buys five
 * guesses at a code, while what a right guess releases opens only with the new
 * device's private key.
 */
@ApiTags('wallet-easy-recovery')
@Controller({ path: 'wallet/easy-recovery', version: '1' })
export class EasyRecoveryController {
  constructor(private readonly easyRecovery: EasyRecoveryService) {}

  @Post('sessions')
  @AllowPublicKey()
  @RequirePermissions('payments:write')
  // Every call writes a row that lives five minutes.
  @RateLimit(EASY_RECOVERY_CREATE_RATE_LIMIT)
  @ApiOperation({
    summary: 'Open a session on the new device',
    description:
      'Send a fresh X25519 public key; keep its private half on the device. ' +
      'Show a QR with the returned `id` and that key: nothing else, no ' +
      'secret and no server URL. The session lives five minutes.',
  })
  @ApiCreatedResponse({ type: EasyRecoverySessionCreatedEntity })
  createSession(@Body() dto: CreateEasyRecoverySessionDto) {
    return this.easyRecovery.createSession(dto);
  }

  @Get('sessions/:id')
  @AllowPublicKey()
  @RequirePermissions('payments:read')
  // Sized for both devices polling every couple of seconds for five minutes.
  @RateLimit(EASY_RECOVERY_POLL_RATE_LIMIT)
  @ApiOperation({
    summary: 'Poll a session',
    description:
      'Both devices poll it: the new one waits for `offered` to ask for the ' +
      'code, the old one for `claimed` to stop showing it. Answers the status ' +
      'and the expiry only, never the key, the sealed wallet or the code. An ' +
      'unknown, expired or burned session is a 404.',
  })
  @ApiParam(SESSION_ID_PARAM)
  @ApiOkResponse({ type: EasyRecoverySessionStatusEntity })
  @ApiErrorResponse({
    status: 404,
    codes: [ApiErrorCode.EasyRecoveryNotFound],
  })
  status(@Param('id') id: string) {
    return this.easyRecovery.status(id);
  }

  @Post('sessions/:id/offer')
  @HttpCode(200)
  @AllowPublicKey()
  @RequirePermissions('payments:write')
  @RateLimit(EASY_RECOVERY_OFFER_RATE_LIMIT)
  @ApiOperation({
    summary: 'Offer the sealed wallet from the old device',
    description:
      'After the person confirmed and unlocked on the old device: seal the ' +
      'wallet to the `receiverKey` read from the QR (ECIES, on the device), ' +
      'generate a random five-digit code, send both here and show the code. ' +
      'Accepted once per session, while it is `open`: the first offer wins ' +
      'and any later one is a 409. Only a hash of the code is stored.',
  })
  @ApiParam(SESSION_ID_PARAM)
  @ApiOkResponse({ type: EasyRecoveryOfferedEntity })
  @ApiErrorResponse({
    status: 404,
    codes: [ApiErrorCode.EasyRecoveryNotFound],
    examples: notFoundAt('offer'),
  })
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.EasyRecoveryAlreadyOffered],
  })
  offer(@Param('id') id: string, @Body() dto: OfferEasyRecoveryDto) {
    return this.easyRecovery.offer(id, dto);
  }

  @Post('sessions/:id/claim')
  @HttpCode(200)
  @AllowPublicKey()
  @RequirePermissions('payments:write')
  // The attempt counter on the row bounds guessing one session; this keeps a
  // machine from walking many.
  @RateLimit(EASY_RECOVERY_CLAIM_RATE_LIMIT)
  @ApiOperation({
    summary: 'Claim the sealed wallet with the code on the old device',
    description:
      'The right code answers the sealed wallet, once: the session reads ' +
      '`claimed` from then on and no longer holds it. A wrong code is a 422 ' +
      'with `details.attemptsLeft`; the fifth wrong code deletes the session ' +
      'and answers 410. Before the old device offered, the answer is 409: ' +
      'poll for `offered` first. A malformed code is a 400 and costs no attempt.',
  })
  @ApiParam(SESSION_ID_PARAM)
  @ApiOkResponse({ type: EasyRecoveryClaimedEntity })
  @ApiErrorResponse({
    status: 404,
    codes: [ApiErrorCode.EasyRecoveryNotFound],
    examples: notFoundAt('claim'),
  })
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.EasyRecoveryNotOffered],
  })
  @ApiErrorResponse({
    status: 410,
    codes: [ApiErrorCode.EasyRecoveryBurned],
  })
  @ApiErrorResponse({
    status: 422,
    codes: [ApiErrorCode.EasyRecoveryCodeInvalid],
  })
  claim(@Param('id') id: string, @Body() dto: ClaimEasyRecoveryDto) {
    return this.easyRecovery.claim(id, dto);
  }
}
