import { Injectable } from '@nestjs/common';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import { PrismaService } from '../prisma/prisma.service';
import type { Consumer } from '../../generated/prisma/client';

/**
 * Resolves the local `Consumer` row that mirrors the APISIX consumer on a
 * request, creating it on first sight. This is the same upsert several domain
 * services do inline (e.g. CustomersService); centralizing it keeps the BlindPay
 * feature services from each re-implementing it.
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
