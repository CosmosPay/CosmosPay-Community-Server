import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AllowPublicKey } from '@/common/decorators/allow-public-key.decorator';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { CreateTransferAccountDto } from '@/native-plugins/koywe/dto/bank-transfer.dto';
import { TransferAccountEntity } from '@/native-plugins/koywe/entities/bank-transfer.entity';
import { TRANSFER_ACCOUNT_RATE_LIMIT } from '@/native-plugins/koywe/koywe.constants';
import { TransferAccountsService } from '@/native-plugins/koywe/transfer-accounts.service';

const PATH = '/v1/onramp/transfer/account';

/** The 403s these routes return: the gateway's and the shared public key's. */
const Forbidden = () =>
  ApiErrorResponse({
    status: 403,
    codes: [
      ApiErrorCode.InsufficientScope,
      ApiErrorCode.GatewayRequired,
      ApiErrorCode.AccountRequired,
    ],
    examples: {
      [ApiErrorCode.AccountRequired]: {
        message:
          'Accepting bank transfers needs a Cosmos Pay account: sign in to use your own API key.',
        path: PATH,
      },
    },
  });

/**
 * `/v1/onramp/transfer/account`: the seller's bank transfer account, the
 * account (in their own name) that payers of their payment requests transfer
 * pesos to. One per consumer and network. The shared public key reaches these
 * routes only to be told `403 account_required`: every anonymous wallet is
 * that one consumer, and an account is one person's or company's.
 */
@ApiTags('bank-transfers')
@Controller({ path: 'onramp/transfer/account', version: '1' })
export class TransferAccountsController {
  constructor(private readonly accounts: TransferAccountsService) {}

  @Get()
  @RequirePermissions('onramp:read')
  @AllowPublicKey()
  @ApiOperation({
    summary: 'Read your bank transfer account',
    description:
      'The account payers of your charges transfer pesos to, on the key’s network: `none` until you open one, then `pending` with the hosted `verificationUrl` to complete, `in_review`, `approved` with its `alias` and `cvu`, or `rejected` with the `reason`. ' +
      'While it is not approved, your charges are not offered by bank transfer. The shared public key is refused with `403 account_required`.',
  })
  @ApiOkResponse({ type: TransferAccountEntity })
  @Forbidden()
  view(@CurrentConsumer() consumer: GatewayConsumer) {
    return this.accounts.view(consumer);
  }

  @Post()
  @RequirePermissions('onramp:write')
  @AllowPublicKey()
  @RateLimit(TRANSFER_ACCOUNT_RATE_LIMIT)
  @ApiOperation({
    summary: 'Open your bank transfer account',
    description:
      'Opens an account in your name (a person with their CUIL or CUIT and date of birth, or a company with its CUIT) on the key’s network and starts its verification, which you complete on the hosted form at `verificationUrl`. ' +
      'Once approved, your charges in ARS can be paid by bank transfer into it and converted to your token. Only the name, the type and the last three digits of the tax id are kept. ' +
      '`409 account_exists` while one exists and is not rejected (a rejected one is submitted again), `400 invalid_tax_id`, `503 transfer_unavailable` when accounts cannot be opened right now. The shared public key is refused with `403 account_required`.',
  })
  @ApiCreatedResponse({ type: TransferAccountEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.ValidationFailed, ApiErrorCode.InvalidTaxId],
  })
  @Forbidden()
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.AccountExists],
  })
  @ApiErrorResponse({
    status: 503,
    codes: [ApiErrorCode.TransferUnavailable],
    examples: {
      [ApiErrorCode.TransferUnavailable]: {
        message:
          'Bank transfer accounts cannot be opened right now: retry shortly.',
        path: PATH,
      },
    },
  })
  open(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateTransferAccountDto,
  ) {
    return this.accounts.open(consumer, dto);
  }
}
