import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { ApiUpstream } from '@/common/decorators/api-upstream.decorator';
import { Public } from '@/common/decorators/public.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { ApiErrorCode } from '@/common/errors/api-error';
import {
  DisputeProtectedPaymentLinkDto,
  FundProtectedPaymentLinkDto,
  SubmitProtectedPaymentLinkDto,
} from '@/native-plugins/trustless-work/dto/protected-payment.dto';
import {
  ProtectedPaymentLinkBuildEntity,
  ProtectedPaymentLinkDisputeEntity,
  ProtectedPaymentLinkEntity,
  ProtectedPaymentLinkSubmitEntity,
} from '@/native-plugins/trustless-work/entities/protected-payment.entity';
import { ProtectedPaymentLinksService } from '@/native-plugins/trustless-work/protected-payment-links.service';
import {
  PROTECTED_PAYMENT_LINK_BUILD_RATE_LIMIT,
  PROTECTED_PAYMENT_LINK_READ_RATE_LIMIT,
  PROTECTED_PAYMENT_LINK_SUBMIT_RATE_LIMIT,
} from '@/native-plugins/trustless-work/trustless-work.constants';

const ID = '3f1c2b7e-8d4a-4c1e-9b2f-6a5d4c3b2a10';
const BASE = `/v1/protected-payment-links/${ID}`;

const IdParam = () =>
  ApiParam({
    name: 'id',
    description:
      'The protected payment id (a uuid), as in the link ' +
      '`https://payments.cosmospay.lat/protected/<id>`.',
    example: ID,
  });

/** The 404 of a link: there is no consumer here, only the id. */
const LinkNotFound = (path: string) =>
  ApiErrorResponse({
    status: 404,
    codes: [ApiErrorCode.NotFound],
    description: 'No protected payment has this id.',
    examples: {
      [ApiErrorCode.NotFound]: {
        message: `Protected payment ${ID} not found`,
        path,
      },
    },
  });

/** The 400 every buyer build can answer. */
const BuildRefused = (path: string, action: string) =>
  ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.InvalidStateTransition, ApiErrorCode.ProviderError],
    description:
      '`invalid_state_transition`: the payment is not in a state this action ' +
      'can be built from, or the release model gives it to the merchant. ' +
      '`provider_error`: Trustless Work refused the request.',
    examples: {
      [ApiErrorCode.InvalidStateTransition]: {
        message: `Cannot ${action} a protected payment that is RELEASED.`,
        path,
      },
      [ApiErrorCode.ProviderError]: {
        message: 'Trustless Work refused the request: amount must be a number',
        path,
      },
    },
  });

/**
 * `/v1/protected-payment-links/{id}`: the buyer's side of a protected payment,
 * what the hosted checkout calls from the buyer's browser.
 *
 * Every route is `@Public()`: the page has no API key and no gateway secret, so
 * there is no consumer here (`ApisixGuard` drops any the client names) and
 * nothing may be read per consumer. The id is the capability (see
 * `ProtectedPaymentLinksService`), budgets are per client address, and the
 * answers are `ProtectedPaymentLinkEntity`, never the merchant's view.
 */
@ApiTags('Protected payment links')
@Controller({ path: 'protected-payment-links', version: '1' })
export class ProtectedPaymentLinksController {
  constructor(private readonly links: ProtectedPaymentLinksService) {}

  @Get(':id')
  @Public()
  @RateLimit(PROTECTED_PAYMENT_LINK_READ_RATE_LIMIT)
  // The status changes while the page is open.
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Read a protected payment as its buyer sees it (no API key)',
    description:
      'For the hosted checkout: the amount, the merchant, the release model, the ' +
      'deadlines, the status and `buyerActions`, what the buyer may do now. **The ' +
      'id is the capability**: nothing about the merchant’s account or `reference` ' +
      'is returned. Answered with `Cache-Control: no-store` and budgeted per client address.',
  })
  @IdParam()
  @ApiOkResponse({ type: ProtectedPaymentLinkEntity })
  @LinkNotFound(BASE)
  findOne(@Param('id') id: string) {
    return this.links.findPublic(id);
  }

  @Post(':id/fund')
  @Public()
  @RateLimit(PROTECTED_PAYMENT_LINK_BUILD_RATE_LIMIT)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiUpstream('Horizon', 'Trustless Work')
  @ApiOperation({
    summary:
      'Build the buyer’s deposit into the protected payment (no API key)',
    description:
      'The first call deploys the payment’s contract (Cosmos Pay pays for it) and ' +
      'binds `buyer`, once Horizon shows it holds the amount in USDC; a different ' +
      'buyer afterwards, or one the merchant did not name, is 409. Answers the ' +
      'checked deposit for `buyer` to sign and send to the link’s submit, before ' +
      'the funding window closes.',
  })
  @IdParam()
  @ApiOkResponse({ type: ProtectedPaymentLinkBuildEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.ValidationFailed,
      ApiErrorCode.InvalidStateTransition,
      ApiErrorCode.TrustlineMissing,
      ApiErrorCode.InsufficientBalance,
      ApiErrorCode.ProviderError,
    ],
    description:
      '`validation_failed`: `buyer` is the merchant, a platform account or an ' +
      'account that does not exist. `invalid_state_transition`: the payment is no ' +
      'longer open for funding. `trustline_missing`: the buyer does not trust USDC, ' +
      'or the merchant cannot receive it. `insufficient_balance`: the buyer holds ' +
      'less than the amount. `provider_error`: Trustless Work refused the request.',
    examples: {
      [ApiErrorCode.InvalidStateTransition]: {
        message: `Cannot fund a protected payment that is FUNDED.`,
        path: `${BASE}/fund`,
      },
      [ApiErrorCode.InsufficientBalance]: {
        message:
          'Account GARMB7W3FCR3GKIM3FLWVJASC2PUZ4VHUJZTNJVWWKNTCJNKO6TBCT76 holds ' +
          '20 USDC; this protected payment takes 125.5.',
        path: `${BASE}/fund`,
      },
    },
  })
  @LinkNotFound(`${BASE}/fund`)
  @ApiErrorResponse({
    status: 409,
    codes: [
      ApiErrorCode.ProtectedPaymentBuyerMismatch,
      ApiErrorCode.OperationInFlight,
    ],
    description:
      '`protected_payment_buyer_mismatch`: another buyer is bound. ' +
      '`operation_in_flight`: the contract is being deployed by another request; retry.',
    examples: {
      [ApiErrorCode.OperationInFlight]: {
        message:
          'This protected payment is being deployed by another request. Retry in ' +
          'a few seconds.',
        path: `${BASE}/fund`,
      },
    },
  })
  fund(@Param('id') id: string, @Body() dto: FundProtectedPaymentLinkDto) {
    return this.links.fund(id, dto.buyer);
  }

  @Post(':id/approve')
  @Public()
  @RateLimit(PROTECTED_PAYMENT_LINK_BUILD_RATE_LIMIT)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiUpstream('Trustless Work')
  @ApiOperation({
    summary: 'Build the buyer’s confirmation of delivery (no API key)',
    description:
      'Where the buyer approves (`BUYER_RELEASES`, `BUYER_APPROVES_MERCHANT_RELEASES`), ' +
      'for a FUNDED or SHIPPED payment. Answers the checked envelope for the bound ' +
      'buyer to sign and send to the link’s submit.',
  })
  @IdParam()
  @ApiOkResponse({ type: ProtectedPaymentLinkBuildEntity })
  @BuildRefused(`${BASE}/approve`, 'approve')
  @LinkNotFound(`${BASE}/approve`)
  approve(@Param('id') id: string) {
    return this.links.approve(id);
  }

  @Post(':id/release')
  @Public()
  @RateLimit(PROTECTED_PAYMENT_LINK_BUILD_RATE_LIMIT)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiUpstream('Trustless Work')
  @ApiOperation({
    summary: 'Build the buyer’s release of the funds (no API key)',
    description:
      'Only under `BUYER_RELEASES`, for an APPROVED payment: the contract pays the ' +
      'merchant the amount less 1.95%. Answers the checked envelope for the bound ' +
      'buyer to sign and send to the link’s submit.',
  })
  @IdParam()
  @ApiOkResponse({ type: ProtectedPaymentLinkBuildEntity })
  @BuildRefused(`${BASE}/release`, 'release')
  @LinkNotFound(`${BASE}/release`)
  release(@Param('id') id: string) {
    return this.links.release(id);
  }

  @Post(':id/dispute')
  @Public()
  @RateLimit(PROTECTED_PAYMENT_LINK_BUILD_RATE_LIMIT)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiUpstream('Trustless Work')
  @ApiOperation({
    summary: 'Open the buyer’s dispute (no API key)',
    description:
      'Where the buyer holds a role in the contract, answers `built`, the dispute ' +
      'for the buyer to sign and submit. Under `MERCHANT_RELEASES` the buyer holds ' +
      'none, so Cosmos Pay’s platform key opens it (`submitted`) once `signature` ' +
      'proves the buyer signed the link’s `disputeChallenge` before `expiresAt`.',
  })
  @IdParam()
  @ApiOkResponse({ type: ProtectedPaymentLinkDisputeEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.InvalidStateTransition,
      ApiErrorCode.ProtectedPaymentSignatureInvalid,
      ApiErrorCode.ProviderError,
    ],
    description:
      '`invalid_state_transition`: the payment is not funded, or already settled. ' +
      '`protected_payment_signature_invalid`: the signed message is missing, does ' +
      'not verify against the buyer, or expired. `provider_error`: Trustless Work ' +
      'refused the request.',
    examples: {
      [ApiErrorCode.InvalidStateTransition]: {
        message: 'Cannot dispute a protected payment that is RELEASED.',
        path: `${BASE}/dispute`,
      },
    },
  })
  @LinkNotFound(`${BASE}/dispute`)
  dispute(
    @Param('id') id: string,
    @Body() dto: DisputeProtectedPaymentLinkDto,
  ) {
    return this.links.dispute(id, dto);
  }

  @Post(':id/submit')
  @Public()
  @RateLimit(PROTECTED_PAYMENT_LINK_SUBMIT_RATE_LIMIT)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiUpstream('Trustless Work')
  @ApiOperation({
    summary: 'Submit a buyer-signed protected payment transaction (no API key)',
    description:
      'Relays `xdr` through Trustless Work only when it is a signed copy of a ' +
      'transaction this link built for the bound buyer, before it expires. ' +
      'Relayed once: the answer is stored and a replay returns it; on `SUCCESS` ' +
      'the payment moves.',
  })
  @IdParam()
  @ApiOkResponse({ type: ProtectedPaymentLinkSubmitEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.ValidationFailed, ApiErrorCode.InvalidStateTransition],
    description:
      '`validation_failed`: `xdr` is not an envelope, is a fee bump or carries no ' +
      'signature. `invalid_state_transition`: it expired before it was submitted.',
    examples: {
      [ApiErrorCode.ValidationFailed]: {
        message:
          'xdr carries no signatures; sign the transaction before submitting it',
        path: `${BASE}/submit`,
      },
      [ApiErrorCode.InvalidStateTransition]: {
        message:
          'This protected payment transaction expired before it was submitted ' +
          'and can no longer be relayed. Build a new one.',
        path: `${BASE}/submit`,
      },
    },
  })
  @LinkNotFound(`${BASE}/submit`)
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.OperationInFlight],
    examples: {
      [ApiErrorCode.OperationInFlight]: {
        message:
          'This protected payment transaction is already being submitted. Wait ' +
          'for that submit to finish, then submit it again to read its result.',
        path: `${BASE}/submit`,
      },
    },
  })
  submit(@Param('id') id: string, @Body() dto: SubmitProtectedPaymentLinkDto) {
    return this.links.submit(id, dto.xdr);
  }
}
