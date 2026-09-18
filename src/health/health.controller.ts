import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { Public } from '@/common/decorators/public.decorator';
import { ApiErrorCode } from '@/common/errors/api-error';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * Liveness/readiness endpoints. Marked @Public() because the orchestrator
 * (k8s/docker) probes them directly, not through APISIX.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
  ) {}

  @Get('liveness')
  @Public()
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiOkResponse({
    description: 'The process is up. It says nothing about the database.',
    schema: {
      type: 'object',
      properties: { status: { type: 'string', example: 'ok' } },
    },
  })
  liveness() {
    return { status: 'ok' };
  }

  @Get('readiness')
  @Public()
  // Terminus documents its own 200 and 503. The 200 is accurate; the 503 is
  // not, and cannot be — `AllExceptionsFilter` catches the
  // ServiceUnavailableException Terminus throws and rewrites the body into the
  // standard error envelope, deliberately dropping the indicator report (it
  // carried Prisma's connection message, database host and user included, on a
  // route served without credentials). The published 503 described that
  // dropped report. Documenting both here, with `swaggerDocumentation: false`,
  // is the only way the contract can match what a probe actually receives.
  @HealthCheck({ swaggerDocumentation: false, noCache: true })
  @ApiOperation({ summary: 'Readiness probe (checks the database)' })
  @ApiOkResponse({
    description: 'Every indicator is up; the service can take traffic.',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ok' },
        info: { type: 'object', example: { database: { status: 'up' } } },
        error: { type: 'object', example: {} },
        details: { type: 'object', example: { database: { status: 'up' } } },
      },
    },
  })
  @ApiErrorResponse({
    status: 503,
    codes: [ApiErrorCode.ProviderUnavailable],
    // Byte for byte what the filter produces here: Terminus' report has no
    // `message` of its own, so the envelope falls back to the exception's name.
    examples: {
      [ApiErrorCode.ProviderUnavailable]: {
        summary: 'an indicator is down',
        message: 'Service Unavailable Exception',
        path: '/v1/health/readiness',
      },
    },
    description:
      'An indicator is down — today that means Postgres did not answer the ' +
      'ping. Which one, and why, is logged; the body says only that the ' +
      'service is not ready, because this route is served without ' +
      'credentials and the indicator report names internal hosts.',
  })
  readiness() {
    return this.health.check([
      () => this.prismaHealth.pingCheck('database', this.prisma),
    ]);
  }
}
