import { Injectable } from '@nestjs/common';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
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
}
