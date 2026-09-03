import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@generated/prisma/client';
import type { AppConfig } from '@/config/configuration';
import {
  POOL_CONNECTION_TIMEOUT_MS,
  POOL_IDLE_TIMEOUT_MS,
  POOL_MAX,
  STATEMENT_TIMEOUT_MS,
} from '@/prisma/prisma.constants';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService<AppConfig, true>) {
    // `PrismaPg` forwards this object to `new pg.Pool`, whose defaults are a
    // poor fit for a service fronting a payments API: `max: 10` and, more
    // dangerously, `connectionTimeoutMillis: 0` — a caller waits forever for a
    // connection rather than failing fast. Under a slow-query stall that turns
    // pool exhaustion into unbounded queueing, and because the readiness probe
    // shares the pool the pod is pulled from the load balancer and its traffic
    // shifted onto the remaining replicas: a cascading failure.
    //
    // `statement_timeout` is the backstop on the database side, so a runaway
    // query cannot hold a connection past it.
    const adapter = new PrismaPg({
      connectionString: config.get('databaseUrl', { infer: true }),
      max: POOL_MAX,
      connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
    });
    super({ adapter });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Connected to the payments database');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Disconnected from the payments database');
  }
}
