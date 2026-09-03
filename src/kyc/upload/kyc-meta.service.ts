import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { BlindpayClient, UploadableFile } from '@/blindpay/blindpay.client';
import { BlindpayObject } from '@/blindpay/blindpay-sync.service';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { UPLOAD_BUCKETS } from '@/blindpay/blindpay.constants';
import { ApiError } from '@/common/errors/api-error';
import { PrismaService } from '@/prisma/prisma.service';
import { InitiateTosDto } from '@/kyc/upload/dto/initiate-tos.dto';
import type { AppConfig } from '@/config/configuration';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { assertRedirectAllowed } from '@/kyc/redirect-url-whitelist';

/**
 * Compliance helpers that aren't tied to a single receiver: document upload and
 * rail discovery. These proxy BlindPay directly (upload + the `/available/*`
 * catalog) and persist nothing.
 */
@Injectable()
export class KycMetaService {
  constructor(
    private readonly blindpay: BlindpayClient,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly consumers: ConsumerResolverService,
  ) {}

  /**
   * Uploads a KYC document and returns its `file_url`, which the caller then
   * passes into the receiver's `*_file` fields.
   */
  uploadDocument(
    file: UploadableFile | undefined,
    bucket: string | undefined,
  ): Promise<{ file_url: string }> {
    if (!file) {
      throw new BadRequestException(
        'A file is required (multipart field "file")',
      );
    }
    const target = bucket ?? 'onboarding';
    if (!(UPLOAD_BUCKETS as readonly string[]).includes(target)) {
      throw new BadRequestException(
        `bucket must be one of: ${UPLOAD_BUCKETS.join(', ')}`,
      );
    }
    return this.blindpay.uploadFile(file, target);
  }

  /**
   * Starts the terms-of-service acceptance flow and returns the hosted URL the
   * end user must visit. BlindPay redirects to `redirect_url` with a `tos_id`
   * query param afterwards — required to create a receiver. This route lives at
   * `/e/instances/{id}/tos`, outside the normal instance path.
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
    return this.blindpay.post<{ url: string }>(
      `/e/instances/${this.blindpay.instanceId}/tos`,
      {
        idempotency_key: dto.idempotency_key ?? randomUUID(),
        receiver_id: dto.receiver_id ?? null,
        redirect_url: dto.redirect_url,
      },
    );
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
    return this.blindpay.get<BlindpayObject>('/available/rails');
  }

  /** Returns the field schema a given rail requires. */
  bankDetails(rail: string): Promise<BlindpayObject> {
    return this.blindpay.get<BlindpayObject>('/available/bank-details', {
      query: { rail },
    });
  }
}
