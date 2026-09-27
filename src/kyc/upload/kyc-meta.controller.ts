import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { ApiUpstream } from '@/common/decorators/api-upstream.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { UploadableFile } from '@/blindpay/blindpay.client';
import { KycMetaService } from '@/kyc/upload/kyc-meta.service';
import { InitiateTosDto } from '@/kyc/upload/dto/initiate-tos.dto';
import {
  KycTermsOfServiceEntity,
  KycUploadEntity,
} from '@/kyc/upload/entities/kyc-meta.entity';
import {
  ALLOWED_UPLOAD_TYPES,
  KYC_TOS_RATE_LIMIT,
  KYC_UPLOAD_RATE_LIMIT,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FIELD_BYTES,
  MAX_UPLOAD_FIELDS,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_PARTS,
} from '@/kyc/kyc.constants';
import { BLINDPAY_CONSUMER_QUOTA_RATE_LIMIT } from '@/blindpay/blindpay.constants';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';

/**
 * Multer defaults to memory storage with **no** size limit, so an unbounded file
 * was buffered into the heap and then copied twice more — into a `Uint8Array`
 * and a `Blob` — before reaching the provider. Three copies of an
 * attacker-chosen size, on a `kyc:write` key. The content type was never
 * inspected either, so arbitrary bytes were relayed to the provider's storage
 * under a document filename.
 *
 * Capping the file alone left the same hole one text field at a time: multer's
 * field count and part count are unlimited by default and each field value is
 * held in memory up to 1 MB. Every multipart count is bounded now — the
 * `MAX_UPLOAD_*` constants say why each number.
 *
 * The filter below can only see the *declared* type; the bytes have not arrived
 * when it runs. They are checked against that declaration in
 * `KycMetaService.uploadDocument`.
 */
const KYC_UPLOAD_OPTIONS: MulterOptions = {
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: MAX_UPLOAD_FILES,
    fields: MAX_UPLOAD_FIELDS,
    fieldSize: MAX_UPLOAD_FIELD_BYTES,
    parts: MAX_UPLOAD_PARTS,
  },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_UPLOAD_TYPES.has(file.mimetype)) {
      cb(
        ApiError.badRequest(
          ApiErrorCode.ValidationFailed,
          `Unsupported file type "${file.mimetype}". Allowed: ${[
            ...ALLOWED_UPLOAD_TYPES,
          ].join(', ')}.`,
        ),
        false,
      );
      return;
    }
    cb(null, true);
  },
};

// /v1/kyc — compliance helpers not scoped to a single receiver.
@ApiTags('kyc')
// Every route here relays to BlindPay: the upload, the ToS link, and both
// catalog reads.
@ApiUpstream('BlindPay')
@Controller({ path: 'kyc', version: '1' })
export class KycMetaController {
  constructor(private readonly meta: KycMetaService) {}

  @Post('upload')
  @RequirePermissions('kyc:write')
  // The provider keeps what it is handed, and a later error deletes nothing.
  @RateLimit(KYC_UPLOAD_RATE_LIMIT, BLINDPAY_CONSUMER_QUOTA_RATE_LIMIT)
  @UseInterceptors(FileInterceptor('file', KYC_UPLOAD_OPTIONS))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a KYC document; returns its file_url' })
  // Declaring the failures below drops Nest's implicit 201, so the success
  // body has to be declared too or the route publishes no success at all.
  @ApiCreatedResponse({ type: KycUploadEntity })
  // Declared here rather than left to the generic 400 `swagger.ts` attaches: that text
  // ("not valid in the current state") says nothing an integrator can act on, and each
  // of these refusals is a limit they can stay inside. The limits are interpolated from
  // the constants the interceptor enforces, so the contract cannot quote a stale number.
  // `@ApiErrorResponse` keeps the envelope's schema and its examples, which a bare
  // `@ApiResponse({ description })` would replace with nothing at all.
  @ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.ValidationFailed],
    description:
      'The multipart form was refused (`validation_failed`), before the provider saw anything: ' +
      `more than ${MAX_UPLOAD_FIELDS} text fields; a text field longer than ${MAX_UPLOAD_FIELD_BYTES} bytes; ` +
      `more than ${MAX_UPLOAD_FILES} file; a declared content type other than ${[
        ...ALLOWED_UPLOAD_TYPES,
      ].join(', ')}; ` +
      'file bytes that do not match the declared content type; a missing `file` part; or an unknown `bucket`.',
  })
  @ApiErrorResponse({
    status: 413,
    codes: [ApiErrorCode.PayloadTooLarge],
    description:
      `The file is larger than ${MAX_UPLOAD_BYTES} bytes (\`payload_too_large\`). Multer stops ` +
      'reading at the limit, so nothing reaches the provider.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        bucket: {
          type: 'string',
          enum: ['avatar', 'onboarding', 'limit_increase'],
        },
      },
      required: ['file'],
    },
  })
  upload(
    @CurrentConsumer() consumer: GatewayConsumer,
    @UploadedFile() file: UploadableFile | undefined,
    @Body('bucket') bucket?: string,
  ) {
    return this.meta.uploadDocument(consumer, file, bucket);
  }

  @Post('terms-of-service')
  @RequirePermissions('kyc:write')
  // Creates a record at the provider; the response cannot take it back.
  @RateLimit(KYC_TOS_RATE_LIMIT, BLINDPAY_CONSUMER_QUOTA_RATE_LIMIT)
  @ApiOperation({
    summary: 'Start ToS acceptance; returns the hosted URL (first KYC step)',
  })
  @ApiCreatedResponse({ type: KycTermsOfServiceEntity })
  initiateTos(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: InitiateTosDto,
  ) {
    return this.meta.initiateTos(consumer, dto);
  }

  @Get('rails')
  @RequirePermissions('kyc:read')
  @ApiOperation({ summary: 'List available bank rails' })
  rails(@CurrentConsumer() consumer: GatewayConsumer) {
    return this.meta.listRails(consumer);
  }

  @Get('bank-details')
  @RequirePermissions('kyc:read')
  @ApiOperation({ summary: 'Get the field schema required by a rail' })
  bankDetails(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query('rail') rail?: string,
  ) {
    if (!rail) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'Query param "rail" is required',
      );
    }
    return this.meta.bankDetails(consumer, rail);
  }
}
