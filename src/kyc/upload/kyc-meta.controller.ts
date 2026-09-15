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
import { API_ERROR_BODY_CONTENT } from '@/common/errors/api-error.entity';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { UploadableFile } from '@/blindpay/blindpay.client';
import { KycMetaService } from '@/kyc/upload/kyc-meta.service';
import { InitiateTosDto } from '@/kyc/upload/dto/initiate-tos.dto';
import {
  ALLOWED_UPLOAD_TYPES,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FIELD_BYTES,
  MAX_UPLOAD_FIELDS,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_PARTS,
} from '@/kyc/kyc.constants';

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
@Controller({ path: 'kyc', version: '1' })
export class KycMetaController {
  constructor(private readonly meta: KycMetaService) {}

  @Post('upload')
  @RequirePermissions('kyc:write')
  @UseInterceptors(FileInterceptor('file', KYC_UPLOAD_OPTIONS))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a KYC document; returns its file_url' })
  // Declared here rather than left to the generic 400 `swagger.ts` attaches: that text
  // ("not valid in the current state") says nothing an integrator can act on, and each
  // of these refusals is a limit they can stay inside. The limits are interpolated from
  // the constants the interceptor enforces, so the contract cannot quote a stale number.
  // `content` keeps the error envelope's schema, which a route-level declaration would
  // otherwise replace with a bare description.
  @ApiResponse({
    status: 400,
    content: API_ERROR_BODY_CONTENT,
    description:
      'The multipart form was refused (`validation_failed`), before the provider saw anything: ' +
      `more than ${MAX_UPLOAD_FIELDS} text fields; a text field longer than ${MAX_UPLOAD_FIELD_BYTES} bytes; ` +
      `more than ${MAX_UPLOAD_FILES} file; a declared content type other than ${[
        ...ALLOWED_UPLOAD_TYPES,
      ].join(', ')}; ` +
      'file bytes that do not match the declared content type; a missing `file` part; or an unknown `bucket`.',
  })
  @ApiResponse({
    status: 413,
    content: API_ERROR_BODY_CONTENT,
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
  @ApiOperation({
    summary: 'Start ToS acceptance; returns the hosted URL (first KYC step)',
  })
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
