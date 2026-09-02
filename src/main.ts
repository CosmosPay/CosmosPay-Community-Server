import { networkInterfaces } from 'node:os';
import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from '@/app.module';
import { AppConfig } from '@/config/configuration';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { setupSwagger } from '@/swagger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: false,
    // Capture the raw request body so the BlindPay webhook controller can verify
    // the Svix signature against the exact bytes BlindPay signed.
    rawBody: true,
  });
  const logger = new Logger('Bootstrap');
  const config = app.get(ConfigService<AppConfig, true>);

  // Last-resort backstop. Several paths hand a promise to nobody — the
  // `@OnEvent` webhook listener fired by a synchronous `emit`, and the
  // `void this.tick()` timers — so a rejection that escapes their own handling
  // would otherwise hit Node's default `--unhandled-rejections=throw` and kill
  // a process that is mid-payment. Log it and keep serving; the background jobs
  // retry on their next tick. This is a safety net, not a licence to omit local
  // handling: every one of those sites has its own try/catch.
  process.on('unhandledRejection', (reason) => {
    logger.error(
      'Unhandled promise rejection — the process was kept alive',
      reason instanceof Error ? reason.stack : String(reason),
    );
  });

  // Security headers. The service sits behind APISIX, but defense in depth.
  app.use(helmet());

  // We trust the gateway's X-Forwarded-* headers for client IP / proto.
  app.set('trust proxy', 1);

  // No `api` prefix — this service *is* the API, so routes live under /v1.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  // OpenAPI docs + raw spec (/docs, /docs/json, /docs/yaml).
  // Mounted as Express middleware — not behind ApisixGuard / PermissionsGuard.
  if (config.get('swaggerEnabled', { infer: true })) {
    setupSwagger(app);
  }

  app.enableShutdownHooks();

  const port = config.get('port', { infer: true });
  // Bind to 0.0.0.0 so the service is reachable from the LAN and from the
  // APISIX gateway (e.g. running in Docker), not only from localhost.
  await app.listen(port, '0.0.0.0');

  logger.log('Cosmos Pay payments service running:');
  logger.log(`  Local      http://localhost:${port}/v1`);
  const lanIps = getLanIps();
  if (lanIps.length > 0) {
    logger.log(`  Network    http://${lanIps[0]}:${port}/v1`);
    for (const ip of lanIps.slice(1)) {
      logger.log(`             http://${ip}:${port}/v1`);
    }
  }
  const swaggerEnabled = config.get('swaggerEnabled', { infer: true });
  if (swaggerEnabled) {
    logger.log(`  Swagger    http://localhost:${port}/docs`);
    logger.log(
      `  OpenAPI    http://localhost:${port}/docs/json (json) · /docs/yaml (yaml)`,
    );
  } else {
    logger.log(
      '  Swagger UI is disabled (set SWAGGER_ENABLED=true to publish /docs)',
    );
  }
}

/** Non-internal IPv4 addresses of this host, for the LAN "Network" URLs. */
function getLanIps(): string[] {
  const ips: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      // Node <18 reports family as 'IPv4'; newer versions may report 4.
      const isIPv4 = addr.family === 'IPv4' || (addr.family as unknown) === 4;
      if (isIPv4 && !addr.internal) {
        ips.push(addr.address);
      }
    }
  }
  return ips;
}

void bootstrap();
