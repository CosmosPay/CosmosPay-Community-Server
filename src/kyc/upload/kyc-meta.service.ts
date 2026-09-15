import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { UploadableFile } from '@/blindpay/blindpay.client';
import { BlindpayKycApi } from '@/blindpay/blindpay-kyc.api';
import { BlindpayObject } from '@/blindpay/blindpay-sync.service';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { UPLOAD_BUCKETS } from '@/blindpay/blindpay.constants';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { UPLOAD_SIGNATURES } from '@/kyc/kyc.constants';
import { PrismaService } from '@/prisma/prisma.service';
import { InitiateTosDto } from '@/kyc/upload/dto/initiate-tos.dto';
import type { AppConfig } from '@/config/configuration';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { assertRedirectAllowed } from '@/kyc/redirect-url-whitelist';

/**
 * Compliance helpers that aren't tied to a single receiver: document upload and
 * rail discovery. These proxy BlindPay directly (upload + the rail catalog) and
 * persist nothing.
 */
@Injectable()
export class KycMetaService {
  constructor(
    private readonly blindpay: BlindpayKycApi,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly consumers: ConsumerResolverService,
  ) {}

  /**
   * Uploads a KYC document and returns its `file_url`, which the caller then
   * passes into the receiver's `*_file` fields.
   *
   * The bytes must be what the declared type says. The multipart filter already
   * refused undeclared types, but a declaration is only the client's word, and
   * this is the first point at which the content is in hand to check it.
   */
  uploadDocument(
    file: UploadableFile | undefined,
    bucket: string | undefined,
  ): Promise<{ file_url: string }> {
    if (!file) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'A file is required (multipart field "file")',
      );
    }
    const target = bucket ?? 'onboarding';
    if (!(UPLOAD_BUCKETS as readonly string[]).includes(target)) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        `bucket must be one of: ${UPLOAD_BUCKETS.join(', ')}`,
      );
    }
    if (!hasSignatureOf(file.buffer, file.mimetype)) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        `File content is not a valid "${file.mimetype}".`,
      );
    }
    return this.blindpay.uploadFile(file, target);
  }

  /**
   * Starts the terms-of-service acceptance flow and returns the hosted URL the
   * end user must visit. BlindPay redirects to `redirect_url` with a `tos_id`
   * query param afterwards — required to create a receiver.
   */
  async initiateTos(
    consumer: GatewayConsumer,
    dto: InitiateTosDto,
  ): Promise<{ url: string }> {
    assertRedirectAllowed(
      consumer.username,
      dto.redirect_url,
      this.config.get('kyc', { infer: true }).redirectUrlWhitelist,
    );
    // Every tenant shares one BlindPay platform instance, so holding a receiver
    // id proves nothing about who owns it — the same reason `assertQuoteOwned`
    // exists on the onramp/offramp quote paths. Without this check a tenant
    // could name another tenant's receiver, get back a hosted acceptance URL
    // bound to that person, and have the resulting `tos_id` delivered to its
    // own redirect host: manufactured terms-acceptance evidence for someone
    // else's customer, against a regulated provider.
    if (dto.receiver_id) {
      await this.assertReceiverOwned(consumer, dto.receiver_id);
    }
    return this.blindpay.requestTos({
      idempotency_key: dto.idempotency_key ?? randomUUID(),
      receiver_id: dto.receiver_id ?? null,
      redirect_url: dto.redirect_url,
    });
  }

  /** 404s unless the provider receiver id is mirrored against this consumer. */
  private async assertReceiverOwned(
    consumer: GatewayConsumer,
    blindpayId: string,
  ): Promise<void> {
    const local = await this.consumers.resolve(consumer);
    const owned = await this.prisma.blindpayReceiver.findFirst({
      where: { blindpayId, consumerId: local.id },
      select: { id: true },
    });
    if (!owned) {
      // 404, not 403: a tenant must not be able to probe which receiver ids
      // exist on the shared instance.
      throw ApiError.notFound(`Receiver ${blindpayId} not found`);
    }
  }

  /** Lists the bank rails available for the platform instance. */
  listRails(): Promise<BlindpayObject> {
    return this.blindpay.listRails();
  }

  /** Returns the field schema a given rail requires. */
  bankDetails(rail: string): Promise<BlindpayObject> {
    return this.blindpay.getBankDetails(rail);
  }
}

/**
 * True when `buffer` starts the way a file of `mimetype` must. A type with no
 * entry in {@link UPLOAD_SIGNATURES} never matches — own keys only, so a
 * "type" named after an `Object.prototype` member is not mistaken for one.
 */
function hasSignatureOf(buffer: Buffer, mimetype: string): boolean {
  if (!Object.hasOwn(UPLOAD_SIGNATURES, mimetype)) return false;
  return UPLOAD_SIGNATURES[mimetype].some((signature) =>
    signature.every(({ offset, bytes }) =>
      bytes.every((byte, i) => buffer[offset + i] === byte),
    ),
  );
}
