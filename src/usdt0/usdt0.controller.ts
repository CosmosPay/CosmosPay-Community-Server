import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { AllowPublicKey } from '@/common/decorators/allow-public-key.decorator';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { ApiRecordTokenHeader } from '@/common/decorators/api-record-token.decorator';
import { ApiUpstream } from '@/common/decorators/api-upstream.decorator';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { RECORD_TOKEN_HEADER } from '@/common/public-record-token.constants';
import { headerValue } from '@/common/request-header';
import { CreateUsdt0TransferDto } from '@/usdt0/dto/create-usdt0-transfer.dto';
import { QueryUsdt0TransfersDto } from '@/usdt0/dto/query-usdt0-transfers.dto';
import { QuoteUsdt0Dto } from '@/usdt0/dto/quote-usdt0.dto';
import { SubmitUsdt0TransferDto } from '@/usdt0/dto/submit-usdt0-transfer.dto';
import {
  Usdt0QuoteEntity,
  Usdt0RoutesEntity,
  Usdt0SubmitResultEntity,
  Usdt0TransferCreatedEntity,
  Usdt0TransferEntity,
  Usdt0TransferListEntity,
} from '@/usdt0/entities/usdt0.entity';
import { Usdt0Service } from '@/usdt0/usdt0.service';
import {
  USDT0_CREATE_RATE_LIMIT,
  USDT0_QUOTE_RATE_LIMIT,
  USDT0_SUBMIT_RATE_LIMIT,
} from '@/usdt0/usdt0.constants';

const EXAMPLE_SOURCE =
  'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';

/**
 * The messages these routes really send, for the published examples: the
 * shared table's examples come from other routes (a swap's trustline, a
 * pool's balance), and an example that cannot occur here is worse than none.
 */
const USDT0_MESSAGES: Partial<Record<ApiErrorCode, string>> = {
  [ApiErrorCode.NetworkUnsupported]:
    'USDT0 is on Stellar mainnet only: it does not exist on Stellar testnet. Use a prod API key.',
  [ApiErrorCode.InvalidAmount]:
    'amount must be at least 0.000001 USDT0: the OFT carries 6 decimals, and the 7th stays in the account as dust',
  [ApiErrorCode.TrustlineMissing]:
    `Account ${EXAMPLE_SOURCE} has no trustline for ` +
    'USDT0:GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q, so it ' +
    'holds no USDT0 to send. Add the trustline and receive USDT0 first, then ' +
    'try again.',
  [ApiErrorCode.InsufficientBalance]:
    `Account ${EXAMPLE_SOURCE} cannot pay this transfer's fees in XLM: it ` +
    'needs 7.1996499 XLM (its minimum balance of 1.5 XLM, the 4.2474009 XLM ' +
    'LayerZero fee limit, the 1.452249 XLM network fee) but holds 5 XLM. Add ' +
    'at least 2.1996499 XLM to it, then try again. What LayerZero does not ' +
    'charge of its fee limit comes back in the same transaction.',
  [ApiErrorCode.IdempotencyConflict]:
    'This Idempotency-Key was already used for a different USDT0 transfer ' +
    'request. Use a new key for a new request.',
  [ApiErrorCode.InvalidStateTransition]:
    'Cannot submit a FAILED USDT0 transfer. Build a new one.',
  [ApiErrorCode.ProviderUnavailable]:
    'The Stellar mainnet Soroban RPC is unavailable. Retry shortly.',
  [ApiErrorCode.Misconfigured]:
    'The Soroban RPC configured for Stellar mainnet (STELLAR_RPC_URL_MAINNET) serves another network.',
};

/** Per-code example overrides for one route, with its own path and messages. */
function usdt0Examples(
  path: string,
  codes: readonly ApiErrorCode[],
  messages: Partial<Record<ApiErrorCode, string>> = {},
) {
  return Object.fromEntries(
    codes.map((code) => [
      code,
      {
        path,
        ...(code === ApiErrorCode.NetworkUnsupported
          ? {
              summary:
                'USDT0 is on Stellar mainnet only; a dev key cannot use this route',
            }
          : {}),
        ...((messages[code] ?? USDT0_MESSAGES[code])
          ? { message: messages[code] ?? USDT0_MESSAGES[code] }
          : {}),
      },
    ]),
  );
}

// URI versioning => /v1/usdt0
//
// USDT0 from Stellar to an EVM network through LayerZero's OFT: the holder
// signs one Soroban transaction. Every route but the list reaches the shared
// public key, so a wallet without an account can send its own USDT0.
@ApiTags('usdt0')
@Controller({ path: 'usdt0', version: '1' })
export class Usdt0Controller {
  constructor(private readonly usdt0: Usdt0Service) {}

  @Get('routes')
  // A catalogue, the same for every caller of a network.
  @AllowPublicKey()
  @RequirePermissions('swaps:read')
  @ApiOperation({
    summary:
      'The networks USDT0 can be sent to from Stellar, with what arrives there (mainnet only)',
    description:
      'USDT0 is Tether’s omnichain USDT. From Stellar it travels through ' +
      'LayerZero’s OFT: Ethereum receives native USDT (Tether’s OFT adapter ' +
      'unlocks it), every other network receives USDT0. All routes take an EVM ' +
      'recipient. USDT0 exists on Stellar mainnet only: a dev (testnet) key ' +
      'gets `available: false` and no routes.',
  })
  @ApiOkResponse({ type: Usdt0RoutesEntity })
  routes(@CurrentConsumer() consumer: GatewayConsumer) {
    return this.usdt0.routes(consumer);
  }

  @Post('quote')
  // Two simulations of the OFT at the Soroban RPC.
  @ApiUpstream('Soroban RPC')
  // A pure function of the request; persists nothing.
  @AllowPublicKey()
  @RequirePermissions('swaps:read')
  @RateLimit(USDT0_QUOTE_RATE_LIMIT)
  // Nothing is created: 200, not Nest's default 201 for a POST.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Quote a USDT0 transfer from Stellar; persists nothing',
    description:
      'Simulates the OFT’s `quote_oft` and `quote_send` on Stellar mainnet. ' +
      'The OFT carries 6 decimals and the asset has 7, so the 7th is `dust` ' +
      'that stays in the account. `nativeFee` is LayerZero’s fee, paid in XLM ' +
      'on top of the USDT0; `nativeFeeLimit` is what a transfer built now ' +
      'would offer (20% more, the excess refunded in the same transaction). ' +
      'Mainnet only.',
  })
  @ApiOkResponse({ type: Usdt0QuoteEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.InvalidAmount,
      ApiErrorCode.NetworkUnsupported,
      ApiErrorCode.ProviderError,
    ],
    description:
      '`network_unsupported`: a dev (testnet) key; USDT0 is on Stellar ' +
      'mainnet only. `invalid_amount`: less than 0.000001 USDT0 (all dust), ' +
      'or outside the OFT’s limits. `provider_error`: the OFT refused the ' +
      'quote; `message` carries its contract error.',
    examples: usdt0Examples(
      '/v1/usdt0/quote',
      [
        ApiErrorCode.InvalidAmount,
        ApiErrorCode.NetworkUnsupported,
        ApiErrorCode.ProviderError,
      ],
      {
        [ApiErrorCode.ProviderError]:
          'The USDT0 contract refused the quote (quote_send): HostError: Error(Contract, #2001)',
      },
    ),
  })
  @ApiErrorResponse({
    status: 502,
    codes: [ApiErrorCode.ProviderError],
    description:
      '`provider_error`: the Soroban RPC answered the simulation with no ' +
      'result, or in a shape the OFT never returns.',
    examples: usdt0Examples('/v1/usdt0/quote', [ApiErrorCode.ProviderError], {
      [ApiErrorCode.ProviderError]:
        'The USDT0 contract answered quote_oft in an unexpected shape.',
    }),
  })
  @ApiErrorResponse({
    status: 503,
    codes: [ApiErrorCode.ProviderUnavailable, ApiErrorCode.Misconfigured],
    description:
      '`provider_unavailable`: the Soroban RPC did not answer; retry. ' +
      '`misconfigured`: STELLAR_RPC_URL_MAINNET serves another network, or ' +
      'USDT0_FEE_WRAPPER is set with a plan commission and no ' +
      'STELLAR_SWAP_FEE_WALLET.',
    examples: usdt0Examples('/v1/usdt0/quote', [
      ApiErrorCode.ProviderUnavailable,
      ApiErrorCode.Misconfigured,
    ]),
  })
  quote(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: QuoteUsdt0Dto,
  ) {
    return this.usdt0.quote(consumer, dto);
  }

  @Post('transfers')
  // Horizon for the source's balances; the RPC for the quotes and the build.
  @ApiUpstream('Horizon', 'Soroban RPC')
  // Builds an unsigned transaction from the request; the wallet signs it.
  @AllowPublicKey()
  @RequirePermissions('swaps:write')
  @RateLimit(USDT0_CREATE_RATE_LIMIT)
  @ApiOperation({
    summary:
      'Create a USDT0 transfer from Stellar → the unsigned Soroban transaction to sign (XDR + SEP-7 link)',
    description:
      'Builds `send` on USDT0’s LayerZero OFT: it burns the USDT0 on Stellar ' +
      'and LayerZero delivers it to `recipient`, as native USDT on Ethereum ' +
      'and as USDT0 elsewhere. The source signs one transaction (Freighter, ' +
      'or the SEP-7 `uri`) and pays two fees in XLM: LayerZero’s ' +
      '(`nativeFeeLimit` is offered, the unused part refunded in the same ' +
      'transaction) and the network’s (`networkFee`). A 7th decimal of ' +
      '`amount` is `dust` and stays in the account. No Cosmos Pay commission ' +
      'is charged. Mainnet only. Submit the signed XDR to ' +
      '`POST /v1/usdt0/transfers/{id}/submit`, then follow ' +
      '`GET /v1/usdt0/transfers/{id}`.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional idempotency key. A retry with the same key and the same request ' +
      'returns the stored transfer unchanged; the same key with a different ' +
      'request is 409 idempotency_conflict. Takes precedence over ' +
      'body.idempotencyKey.',
    example: 'usdt0-retry-2026-10-25-001',
  })
  @ApiCreatedResponse({
    type: Usdt0TransferCreatedEntity,
    description:
      'The transfer. With the shared public key it carries `publicToken`: ' +
      'send it as `X-Record-Token` to read the transfer or submit it.',
  })
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.ValidationFailed,
      ApiErrorCode.InvalidAmount,
      ApiErrorCode.TrustlineMissing,
      ApiErrorCode.InsufficientBalance,
      ApiErrorCode.NetworkUnsupported,
      ApiErrorCode.ProviderError,
      ApiErrorCode.MerchantFeeUnsupported,
    ],
    description:
      '`merchant_fee_unsupported`: a `merchantFee` and no merchant fee ' +
      'wrapper configured (USDT0_FEE_WRAPPER). ' +
      '`network_unsupported`: a dev (testnet) key; USDT0 is on Stellar ' +
      'mainnet only. `validation_failed`: the source account does not exist, ' +
      'or the recipient has a bad EIP-55 checksum. `trustline_missing`: the ' +
      'source does not trust USDT0. `insufficient_balance`: it holds less ' +
      'USDT0 than the transfer takes, or too little XLM for LayerZero’s fee ' +
      'limit, the network fee and its reserve (the message says how much XLM ' +
      'to add). `invalid_amount`: all dust, or outside the OFT’s limits. ' +
      '`provider_error`: the OFT refused the transfer; `message` carries its ' +
      'contract error. With a merchant fee, `trustline_missing` also answers ' +
      'a fee wallet that does not trust USDT0, and `insufficient_balance` ' +
      'counts the fee the holder pays on top.',
    examples: usdt0Examples(
      '/v1/usdt0/transfers',
      [
        ApiErrorCode.ValidationFailed,
        ApiErrorCode.InvalidAmount,
        ApiErrorCode.TrustlineMissing,
        ApiErrorCode.InsufficientBalance,
        ApiErrorCode.NetworkUnsupported,
        ApiErrorCode.ProviderError,
        ApiErrorCode.MerchantFeeUnsupported,
      ],
      {
        [ApiErrorCode.ValidationFailed]:
          'recipient has an invalid EIP-55 checksum: check the address, or send it in lowercase',
        [ApiErrorCode.ProviderError]:
          'The USDT0 contract refused the transfer: HostError: Error(Contract, #2001)',
        [ApiErrorCode.MerchantFeeUnsupported]:
          'A merchant fee is not available on USDT0 transfers on this deployment: a Soroban transaction carries one operation, so the fee needs the fee wrapper (USDT0_FEE_WRAPPER), which is not configured.',
      },
    ),
  })
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.IdempotencyConflict],
    description:
      'This Idempotency-Key was already used for a different USDT0 transfer ' +
      'request, or an identical transfer was built from the same account in ' +
      'the same second.',
    examples: usdt0Examples('/v1/usdt0/transfers', [
      ApiErrorCode.IdempotencyConflict,
    ]),
  })
  @ApiErrorResponse({
    status: 502,
    codes: [ApiErrorCode.ProviderError],
    description:
      '`provider_error`: the OFT cannot be called right now (part of its ' +
      'state is archived on the ledger, or it asks for a signature the ' +
      'transaction cannot carry), or the RPC answered in an unexpected shape.',
    examples: usdt0Examples(
      '/v1/usdt0/transfers',
      [ApiErrorCode.ProviderError],
      {
        [ApiErrorCode.ProviderError]:
          'Part of the USDT0 contract state is archived on the ledger and must be restored before a transfer can be built. Retry later.',
      },
    ),
  })
  @ApiErrorResponse({
    status: 503,
    codes: [ApiErrorCode.ProviderUnavailable, ApiErrorCode.Misconfigured],
    description:
      '`provider_unavailable`: Horizon or the Soroban RPC did not answer; ' +
      'retry. `misconfigured`: STELLAR_RPC_URL_MAINNET serves another ' +
      'network, or USDT0_FEE_WRAPPER is not the reviewed wrapper ' +
      "bound to USDT0's OFT and token, or the plan commission has no " +
      'STELLAR_SWAP_FEE_WALLET, or one that does not trust USDT0.',
    examples: usdt0Examples('/v1/usdt0/transfers', [
      ApiErrorCode.ProviderUnavailable,
      ApiErrorCode.Misconfigured,
    ]),
  })
  create(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateUsdt0TransferDto,
    // Read via @Req (not @Headers) so Swagger does not emit a second
    // `idempotency-key` parameter beside @ApiHeader.
    @Req() req: Request,
  ) {
    return this.usdt0.create(
      consumer,
      dto,
      headerValue(req, 'idempotency-key'),
    );
  }

  @Get('transfers')
  @RequirePermissions('swaps:read')
  @ApiOperation({
    summary:
      "List the consumer's USDT0 transfers (not on the shared public key)",
    description:
      'Answers from this service’s own table, as last refreshed; read one ' +
      'transfer to refresh it. Refused to the shared public key, which is ' +
      'every anonymous caller at once.',
  })
  @ApiOkResponse({ type: Usdt0TransferListEntity })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryUsdt0TransfersDto,
  ) {
    return this.usdt0.findAll(consumer, query);
  }

  @Get('transfers/:id')
  // Refreshes a PENDING or SUBMITTED transfer from the ledger and LayerZero
  // Scan, throttled per transfer. A failure there is not the caller's: the
  // read answers from the row, so no upstream status is documented. The
  // shared public key also needs the transfer's record token.
  @AllowPublicKey()
  @RequirePermissions('swaps:read')
  @ApiRecordTokenHeader()
  @ApiOperation({
    summary:
      'Get a USDT0 transfer by id, refreshed from the Stellar ledger and LayerZero Scan',
    description:
      'While PENDING or SUBMITTED, a read asks the Stellar ledger (a wallet ' +
      'may have broadcast the transaction itself) and LayerZero Scan, at most ' +
      'once every 15 seconds per transfer, and moves it to SUBMITTED, ' +
      'DELIVERED (with `destinationTxHash`), FAILED or EXPIRED. Delivery takes ' +
      'about 27 minutes on every route: LayerZero’s verifiers wait for Stellar ' +
      'confirmations. The shared public key may call it, but only with the ' +
      'transfer’s `publicToken` in `X-Record-Token`: without it, or with ' +
      'another transfer’s, the answer is 404. Every other key reads its own ' +
      'transfers as before.',
  })
  @ApiOkResponse({ type: Usdt0TransferEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    return this.usdt0.findOne(
      consumer,
      id,
      headerValue(req, RECORD_TOKEN_HEADER),
    );
  }

  @Post('transfers/:id/submit')
  // Submits through the Soroban RPC and waits for the ledger.
  @ApiUpstream('Soroban RPC')
  // Nothing about the transfer is answered until the body is its transaction,
  // signed; reaching another anonymous caller's transfer takes its id and the
  // transaction only its creator was handed, and the shared public key also
  // needs the transfer's record token.
  @AllowPublicKey()
  @RequirePermissions('swaps:write')
  @ApiRecordTokenHeader()
  @RateLimit(USDT0_SUBMIT_RATE_LIMIT)
  // Advances an existing transfer; nothing new comes into existence.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Relay the signed USDT0 transaction to Stellar mainnet',
    description:
      'The signed XDR must hash to the transfer’s transaction and carry a ' +
      'signature. Accepted and applied: SUBMITTED, with LayerZero’s `guid`. ' +
      'Applied and failed: FAILED. Refused by the network: the transfer stays ' +
      'PENDING (`submitted: false`, `reason`) and can be submitted again until ' +
      'it expires. Waits up to 30 seconds for the ledger.',
  })
  @ApiOkResponse({ type: Usdt0SubmitResultEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.ValidationFailed,
      ApiErrorCode.InvalidStateTransition,
      ApiErrorCode.NetworkUnsupported,
    ],
    description:
      '`validation_failed`: `signedXdr` is not a transaction, is not the one ' +
      'built for this transfer, or carries no signature. ' +
      '`invalid_state_transition`: the transfer is FAILED or EXPIRED, or its ' +
      'transaction expired; build a new one. `network_unsupported`: a dev ' +
      '(testnet) key.',
    examples: usdt0Examples(
      '/v1/usdt0/transfers/cm2u0t0transfer0000000001/submit',
      [
        ApiErrorCode.ValidationFailed,
        ApiErrorCode.InvalidStateTransition,
        ApiErrorCode.NetworkUnsupported,
      ],
      {
        [ApiErrorCode.ValidationFailed]:
          'The signed transaction does not match this transfer',
      },
    ),
  })
  @ApiErrorResponse({
    status: 503,
    codes: [ApiErrorCode.ProviderUnavailable, ApiErrorCode.Misconfigured],
    description:
      '`provider_unavailable`: the Soroban RPC did not answer, or the network ' +
      'asked to try again later; the transfer stays PENDING, submit again. ' +
      '`misconfigured`: STELLAR_RPC_URL_MAINNET serves another network.',
    examples: usdt0Examples(
      '/v1/usdt0/transfers/cm2u0t0transfer0000000001/submit',
      [ApiErrorCode.ProviderUnavailable, ApiErrorCode.Misconfigured],
    ),
  })
  submit(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: SubmitUsdt0TransferDto,
    @Req() req: Request,
  ) {
    return this.usdt0.submit(
      consumer,
      id,
      dto.signedXdr,
      headerValue(req, RECORD_TOKEN_HEADER),
    );
  }
}
