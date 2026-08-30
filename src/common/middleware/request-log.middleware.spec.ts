import {
  BadRequestException,
  CanActivate,
  Controller,
  ForbiddenException,
  Get,
  INestApplication,
  MiddlewareConsumer,
  Module,
  NestModule,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../../prisma/prisma.service';
import { RequestLogMiddleware } from './request-log.middleware';

/**
 * A guard that always rejects, standing in for ApisixGuard / PermissionsGuard.
 * The point of the test is that a request rejected by a guard — which never
 * reaches an interceptor — is still logged by the middleware, with the real
 * status the exception filter writes (403).
 */
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    throw new ForbiddenException();
  }
}

@Controller()
class ProbeController {
  @Get('ok')
  ok(): { ok: true } {
    return { ok: true };
  }

  @Post('created')
  created(): { created: true } {
    return { created: true };
  }

  @Get('bad')
  bad(): never {
    throw new BadRequestException();
  }

  @Get('missing')
  missing(): never {
    throw new NotFoundException();
  }

  @Get('boom')
  boom(): never {
    throw new Error('kaboom');
  }

  @Get('guarded')
  @UseGuards(DenyGuard)
  guarded(): { ok: true } {
    return { ok: true };
  }
}

@Controller('v1/health')
class HealthController {
  @Get('liveness')
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }
}

describe('RequestLogMiddleware', () => {
  let app: INestApplication;
  const create = jest.fn().mockResolvedValue({});
  const prismaMock = { requestLog: { create } };

  @Module({
    controllers: [ProbeController, HealthController],
    providers: [
      { provide: PrismaService, useValue: prismaMock },
      RequestLogMiddleware,
    ],
  })
  class ProbeModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
      consumer.apply(RequestLogMiddleware).forRoutes('*');
    }
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ProbeModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => create.mockClear());

  const http = () => app.getHttpServer();

  // `res.on('finish')` fires after supertest already has the response, so give
  // the event loop one turn for the persist() call to land before asserting.
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  const lastStatus = (): number =>
    create.mock.calls.at(-1)?.[0].data.statusCode as number;

  it('logs a successful GET with status 200', async () => {
    await request(http()).get('/ok').expect(200);
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
    expect(lastStatus()).toBe(200);
  });

  it('logs a successful POST with the real 201', async () => {
    await request(http()).post('/created').expect(201);
    await flush();
    expect(lastStatus()).toBe(201);
  });

  it('logs a validation/bad-request path as 400, not 200', async () => {
    await request(http()).get('/bad').expect(400);
    await flush();
    expect(lastStatus()).toBe(400);
  });

  it('logs a not-found path as 404', async () => {
    await request(http()).get('/missing').expect(404);
    await flush();
    expect(lastStatus()).toBe(404);
  });

  it('logs an unexpected error as 500', async () => {
    await request(http()).get('/boom').expect(500);
    await flush();
    expect(lastStatus()).toBe(500);
  });

  it('logs a guard rejection as 403 (never reaches an interceptor)', async () => {
    await request(http()).get('/guarded').expect(403);
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
    expect(lastStatus()).toBe(403);
  });

  it('writes exactly one row per request', async () => {
    await request(http()).get('/ok').expect(200);
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not log health probes', async () => {
    await request(http()).get('/v1/health/liveness').expect(200);
    await flush();
    expect(create).not.toHaveBeenCalled();
  });

  it('does not log requests marked x-cosmos-internal', async () => {
    await request(http()).get('/ok').set('x-cosmos-internal', '1').expect(200);
    await flush();
    expect(create).not.toHaveBeenCalled();
  });
});
