import { Injectable } from '@nestjs/common';
import {
  CONSUMER_ID_CACHE_MAX_ENTRIES,
  CONSUMER_ID_CACHE_TTL_MS,
} from '@/common/consumer-resolver.constants';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { ReadThroughCache } from '@/common/read-through-cache';
import { PrismaService } from '@/prisma/prisma.service';
import type { Consumer } from '@generated/prisma/client';

/**
 * Resolves the local `Consumer` row that mirrors the APISIX consumer on a
 * request, creating it on first sight.
 *
 * Every tenant-scoped service needs this, so it belongs in `CommonModule`
 * (which is `@Global`). It previously sat under `src/blindpay/` — a
 * provider-specific module — which is why the Stellar half of the app could not
 * reasonably import it and each re-rolled the same upsert inline. That drift
 * was real: seven copies, and the old docblock admitted to it.
 */
@Injectable()
export class ConsumerResolverService {
  /** Local ids by gateway consumer AND credential, so a new credential is upserted at once. */
  private readonly ids = new ReadThroughCache<string>(
    CONSUMER_ID_CACHE_TTL_MS,
    CONSUMER_ID_CACHE_MAX_ENTRIES,
  );

  constructor(private readonly prisma: PrismaService) {}

  resolve(consumer: GatewayConsumer): Promise<Consumer> {
    return this.prisma.consumer.upsert({
      where: { apisixUsername: consumer.username },
      create: {
        apisixUsername: consumer.username,
        credentialId: consumer.credentialId,
      },
      update: { credentialId: consumer.credentialId },
    });
  }

  /**
   * The local id alone, for read paths that need nothing else of the row (the dashboard's
   * analytics): resolved once per gateway consumer and credential and reused for
   * {@link CONSUMER_ID_CACHE_TTL_MS}, instead of an upsert on every request. A write path that
   * reads the row keeps using {@link resolve}.
   */
  resolveId(consumer: GatewayConsumer): Promise<string> {
    return this.ids.get(
      JSON.stringify([consumer.username, consumer.credentialId ?? null]),
      () => this.resolve(consumer).then((row) => row.id),
    );
  }
}
