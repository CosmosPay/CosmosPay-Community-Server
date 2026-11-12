import {
  Body,
  Controller,
  Header,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { Public } from '@/common/decorators/public.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { ApiErrorCode } from '@/common/errors/api-error';
import { BankTransfersService } from '@/native-plugins/koywe/bank-transfers.service';
import {
  BankTransferParamsDto,
  CreateBankTransferDto,
} from '@/native-plugins/koywe/dto/bank-transfer.dto';
import { BankTransferEntity } from '@/native-plugins/koywe/entities/bank-transfer.entity';
import { BANK_TRANSFER_RATE_LIMIT } from '@/native-plugins/koywe/koywe.constants';

const ID = 'cmh4x2k9a0001l70g8v5q3z2w';
const PATH = `/v1/payment-links/fiat/${ID}/transfers`;

/**
 * `/v1/payment-links/fiat/{id}/transfers`: the payer of a payment request
 * asks how to pay it by bank transfer. `@Public()` like the rest of the
 * payer's page (the keyless gateway route of `/v1/payment-links/*` serves it):
 * no consumer, the request id is the capability, budgeted per client address.
 */
@ApiTags('payment-links')
@Controller({ path: 'payment-links/fiat', version: '1' })
export class BankTransferLinksController {
  constructor(private readonly transfers: BankTransfersService) {}

  @Post(':id/transfers')
  @Public()
  @RateLimit(BANK_TRANSFER_RATE_LIMIT)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Get bank transfer instructions for a charge (no API key)',
    description:
      'For a request whose `methods` include `transfer`: the payer gives their CUIT/CUIL or DNI and is answered the exact amount, the alias and CVU to transfer it to and until when (an hour, never past the charge). ' +
      'The transfer must come from an account in the payer’s own name; it is detected on its own and the charge reads `processing`, then `paid`. ' +
      'The same document answers the same transfer (`200`), a new one `201`; only an HMAC of the document and its last three digits are kept. ' +
      '`400 invalid_document`, `400 method_unavailable` when the charge cannot be paid this way, `409 request_closed` unless it is open, `503 transfer_unavailable` when the account cannot be given right now.',
  })
  @ApiParam({
    name: 'id',
    description:
      'The payment request id, as in its page `https://payments.cosmospay.lat/fiat/<id>`.',
    example: ID,
  })
  @ApiCreatedResponse({
    type: BankTransferEntity,
    description: 'A new transfer was opened for this document.',
  })
  @ApiOkResponse({
    type: BankTransferEntity,
    description: 'The transfer this document already has for the charge.',
  })
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.ValidationFailed,
      ApiErrorCode.InvalidDocument,
      ApiErrorCode.MethodUnavailable,
    ],
    examples: {
      [ApiErrorCode.MethodUnavailable]: {
        message: `Payment request ${ID} cannot be paid by bank transfer`,
        path: PATH,
      },
    },
  })
  @ApiErrorResponse({
    status: 404,
    codes: [ApiErrorCode.NotFound],
    description: 'No payment request has this id.',
    examples: {
      [ApiErrorCode.NotFound]: {
        message: 'Payment request not found',
        path: PATH,
      },
    },
  })
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.RequestClosed],
    description:
      'The request is processing a payment, was paid or cancelled, or it expired.',
    examples: {
      [ApiErrorCode.RequestClosed]: {
        message: `Payment request ${ID} is paid: it can no longer be paid`,
        path: PATH,
      },
    },
  })
  @ApiErrorResponse({
    status: 503,
    codes: [ApiErrorCode.TransferUnavailable],
  })
  async open(
    @Param() params: BankTransferParamsDto,
    @Body() dto: CreateBankTransferDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BankTransferEntity> {
    const { transfer, created } = await this.transfers.open(
      params.id,
      dto.document,
    );
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return transfer;
  }
}
