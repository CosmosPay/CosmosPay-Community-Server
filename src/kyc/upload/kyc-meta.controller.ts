import {
  BadRequestException,
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
import { ApiError, ApiErrorCode } from '../../common/errors/api-error';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentConsumer } from '../../common/decorators/current-consumer.decorator';
import { GatewayConsumer } from '../../common/interfaces/gateway-consumer.interface';
import { UploadableFile } from '../../blindpay/blindpay.client';
import { KycMetaService } from './kyc-meta.service';
import { InitiateTosDto } from './dto/initiate-tos.dto';

/** 10 MB — comfortably above a passport scan, far below a heap exhaustion. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Identity documents are images or PDFs; nothing else has a reason to be here. */
const ALLOWED_UPLOAD_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
]);

/**
 * Multer defaults to memory storage with **no** size limit, so an unbounded file
 * was buffered into the heap and then copied twice more — into a `Uint8Array`
 * and a `Blob` — before reaching the provider. Three copies of an
 * attacker-chosen size, on a `kyc:write` key. The content type was never
 * inspected either, so arbitrary bytes were relayed to the provider's storage
 * under a document filename.
 */
const KYC_UPLOAD_OPTIONS: MulterOptions = {
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
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
    @UploadedFile() file: UploadableFile | undefined,
    @Body('bucket') bucket?: string,
  ) {
    return this.meta.uploadDocument(file, bucket);
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
  rails() {
    return this.meta.listRails();
  }

  @Get('bank-details')
  @RequirePermissions('kyc:read')
  @ApiOperation({ summary: 'Get the field schema required by a rail' })
  bankDetails(@Query('rail') rail?: string) {
    if (!rail) {
      throw new BadRequestException('Query param "rail" is required');
    }
    return this.meta.bankDetails(rail);
  }
}
