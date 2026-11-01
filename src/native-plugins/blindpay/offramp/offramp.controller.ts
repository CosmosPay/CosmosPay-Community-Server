import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiUpstream } from '@/common/decorators/api-upstream.decorator';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { ApiErrorCode } from '@/common/errors/api-error';
import { WidePaginationQueryDto } from '@/common/dto/pagination.query.dto';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { BLINDPAY_CONSUMER_QUOTA_RATE_LIMIT } from '@/native-plugins/blindpay/blindpay.constants';
import {
  OFFRAMP_DOCUMENT_RATE_LIMIT,
  OFFRAMP_PAYOUT_RATE_LIMIT,
  OFFRAMP_QUOTE_RATE_LIMIT,
} from '@/native-plugins/blindpay/offramp/offramp.constants';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { OfframpService } from '@/native-plugins/blindpay/offramp/offramp.service';
import { AuthorizedPayoutEntity } from '@/native-plugins/blindpay/offramp/entities/authorized-payout.entity';
import { CreatePayoutQuoteDto } from '@/native-plugins/blindpay/offramp/dto/create-payout-quote.dto';
import { AuthorizePayoutDto } from '@/native-plugins/blindpay/offramp/dto/authorize-payout.dto';
import { CreatePayoutDto } from '@/native-plugins/blindpay/offramp/dto/create-payout.dto';
import { PayoutDocumentDto } from '@/native-plugins/blindpay/offramp/dto/payout-document.dto';
import { PayoutQuoteEntity } from '@/native-plugins/blindpay/offramp/entities/payout-quote.entity';
import {
  PayoutEntity,
  PayoutListEntity,
} from '@/native-plugins/blindpay/offramp/entities/payout.entity';

// /v1/offramp — stablecoin -> fiat.
@ApiTags('offramp')
@Controller({ path: 'offramp', version: '1' })
export class OfframpController {
  constructor(private readonly offramp: OfframpService) {}

  @Post('quotes')
  @ApiUpstream('BlindPay')
  @RequirePermissions('offramp:write')
  // A provider call on the instance every tenant shares, plus a stored row.
  @RateLimit(OFFRAMP_QUOTE_RATE_LIMIT, BLINDPAY_CONSUMER_QUOTA_RATE_LIMIT)
  @ApiOperation({
    summary: 'Create a payout quote (EVM quote carries the approve contract)',
    description:
      'Prices a payout through BlindPay of `token` on `network` to one of your ' +
      'bank accounts (`bank_account_id`, a Cosmos Pay id) and records the ' +
      'quote as yours, on the BlindPay instance your key selects (a `dev` key ' +
      'uses the development instance and moves no real money). An EVM quote ' +
      'carries the `contract` whose `approve` the customer signs before the ' +
      'payout, and `receiver_local_amount` is filled from `receiver_amount` ' +
      'when BlindPay sends 0. Amounts are integers in minor units. A bank ' +
      "account you do not own is a 404, and one whose receiver's fiat access " +
      'is disabled is `403 account_disabled`.',
  })
  @ApiCreatedResponse({ type: PayoutQuoteEntity })
  createQuote(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreatePayoutQuoteDto,
  ) {
    return this.offramp.createQuote(consumer, dto);
  }

  @Post('payouts/authorize')
  @ApiUpstream('BlindPay')
  @RequirePermissions('offramp:write')
  // One budget with the payout it prepares — see OFFRAMP_PAYOUT_RATE_LIMIT.
  @RateLimit(OFFRAMP_PAYOUT_RATE_LIMIT, BLINDPAY_CONSUMER_QUOTA_RATE_LIMIT)
  @ApiOperation({
    summary: 'Build the unsigned Stellar/Solana payout tx to sign',
    description:
      'Step one of a `stellar` or `solana` payout (EVM payouts skip it): ' +
      'BlindPay builds the transaction `sender_wallet_address` signs for ' +
      '`quote_id`, returned as `unsigned_transaction` (Stellar XDR or Solana ' +
      "transaction) beside BlindPay's own fields. Pass the signed result as " +
      '`signed_transaction` to `POST /v1/offramp/payouts`; nothing is stored. ' +
      'A quote that is not yours, is a payin quote or was minted on the other ' +
      'instance is `404 quote_not_found`; a lapsed one is `400 quote_expired`.',
  })
  @ApiCreatedResponse({ type: AuthorizedPayoutEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.ValidationFailed, ApiErrorCode.QuoteExpired],
  })
  authorize(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: AuthorizePayoutDto,
  ) {
    return this.offramp.authorize(consumer, dto);
  }

  @Post('payouts')
  @ApiUpstream('BlindPay')
  @RequirePermissions('offramp:write')
  // Money leaving: an error afterwards does not bring it back.
  @RateLimit(OFFRAMP_PAYOUT_RATE_LIMIT, BLINDPAY_CONSUMER_QUOTA_RATE_LIMIT)
  @ApiOperation({
    summary: 'Create a payout from a quote',
    description:
      'Executes a payout quote at BlindPay: for `evm` the customer has already ' +
      "sent the quote's `approve`, for `stellar` and `solana` " +
      '`signed_transaction` (from the authorize step) is required. Idempotent ' +
      'per quote: a retry of the same quote reuses its row and its BlindPay ' +
      '`Idempotency-Key`, so a quote is never paid out twice. A quote that is ' +
      'not yours, is a payin quote or was minted on the other instance is ' +
      '`404 quote_not_found`; a lapsed one is `400 quote_expired`. Status ' +
      'changes arrive later as `PAYOUT_UPDATED` and `PAYOUT_COMPLETED` ' +
      'webhook events.',
  })
  @ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.ValidationFailed, ApiErrorCode.QuoteExpired],
  })
  @ApiCreatedResponse({ type: PayoutEntity })
  createPayout(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreatePayoutDto,
  ) {
    return this.offramp.createPayout(consumer, dto);
  }

  @Get('payouts')
  @RequirePermissions('offramp:read')
  @ApiOperation({
    summary: "List the consumer's payouts",
    description:
      "Reads this service's mirror only (no BlindPay call), newest first, " +
      "limited to your key's BlindPay instance; payouts still waiting for " +
      "BlindPay's id are left out. Paginated with `take` (default 100, max " +
      '100) and `skip`; answers `{ data, total, take, skip }`, where `total` ' +
      'counts every matching payout.',
  })
  @ApiOkResponse({ type: PayoutListEntity })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: WidePaginationQueryDto,
  ) {
    return this.offramp.findAll(consumer, query);
  }

  @Get('payouts/:id')
  // Refreshes the mirror from BlindPay before answering.
  @ApiUpstream('BlindPay')
  @RequirePermissions('offramp:read')
  @ApiOperation({
    summary:
      'Get a payout (serves the local mirror; refreshes from BlindPay when stale)',
    description:
      'Answers from the mirror while it was updated in the last 60 seconds; ' +
      'an older row is refreshed from BlindPay first, and when BlindPay cannot ' +
      'answer the stored row is returned instead of an error. Only payouts of ' +
      "your key's BlindPay instance that BlindPay already acknowledged; " +
      'anything else is 404.',
  })
  @ApiOkResponse({ type: PayoutEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.offramp.findOne(consumer, id);
  }

  @Post('payouts/:id/documents')
  @ApiUpstream('BlindPay')
  @RequirePermissions('offramp:write')
  // The provider keeps what it is handed.
  @RateLimit(OFFRAMP_DOCUMENT_RATE_LIMIT, BLINDPAY_CONSUMER_QUOTA_RATE_LIMIT)
  @ApiOperation({
    summary: 'Attach a compliance document to a payout',
    description:
      'Forwards a document backing the payout (an invoice, for example) to ' +
      "BlindPay and returns BlindPay's answer as is. Upload the file first " +
      'with `POST /v1/kyc/upload` and pass its `file_url` as ' +
      "`transaction_document_file`. Only a payout of yours on your key's " +
      'BlindPay instance that BlindPay already acknowledged; anything else is ' +
      '404.',
  })
  addDocument(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: PayoutDocumentDto,
  ) {
    return this.offramp.addDocument(consumer, id, dto);
  }
}
