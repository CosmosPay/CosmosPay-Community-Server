import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';

describe('AllExceptionsFilter', () => {
  function build() {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ url: '/v1/swaps' }),
      }),
    } as unknown as ArgumentsHost;
    return { filter: new AllExceptionsFilter(), host, status, json };
  }

  const body = (json: jest.Mock) =>
    json.mock.calls[0][0] as Record<string, unknown>;

  afterEach(() => jest.restoreAllMocks());

  it('carries the machine-readable code from an ApiError', () => {
    const { filter, host, status, json } = build();

    filter.catch(
      ApiError.conflict(
        ApiErrorCode.IdempotencyConflict,
        'A swap already exists for this Idempotency-Key',
      ),
      host,
    );

    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(body(json)).toMatchObject({
      statusCode: 409,
      code: 'idempotency_conflict',
      // The reason phrase must track the status. When ApiError omitted it, the
      // filter's initial value stood and every migrated throw site reported
      // "Internal Server Error" next to a correct 409.
      error: 'Conflict',
      message: 'A swap already exists for this Idempotency-Key',
      path: '/v1/swaps',
    });
  });

  it('gives every ApiError status its own reason phrase', () => {
    const cases: [() => Error, string][] = [
      [() => ApiError.notFound('gone'), 'Not Found'],
      [
        () => ApiError.badRequest(ApiErrorCode.InvalidMemo, 'bad memo'),
        'Bad Request',
      ],
      [
        () => ApiError.forbidden(ApiErrorCode.InsufficientScope, 'nope'),
        'Forbidden',
      ],
      [
        () => ApiError.unavailable(ApiErrorCode.Misconfigured, 'no header'),
        'Service Unavailable',
      ],
      [
        () => ApiError.badGateway(ApiErrorCode.ProviderError, 'upstream'),
        'Bad Gateway',
      ],
    ];

    for (const [make, phrase] of cases) {
      const { filter, host, json } = build();
      filter.catch(make(), host);
      expect(body(json).error).toBe(phrase);
    }
  });

  it('distinguishes two 400s that used to be indistinguishable', () => {
    const slippage = build();
    slippage.filter.catch(
      ApiError.badRequest(ApiErrorCode.SlippageExceeded, 'slippage too high'),
      slippage.host,
    );

    const balance = build();
    balance.filter.catch(
      ApiError.badRequest(ApiErrorCode.InsufficientBalance, 'not enough XLM'),
      balance.host,
    );

    expect(body(slippage.json).statusCode).toBe(400);
    expect(body(balance.json).statusCode).toBe(400);
    // Same status, different code — the whole point of the field.
    expect(body(slippage.json).code).toBe('slippage_exceeded');
    expect(body(balance.json).code).toBe('insufficient_balance');
  });

  it('falls back to a status-derived code for a plain Nest exception', () => {
    const notFound = build();
    notFound.filter.catch(
      new NotFoundException('Swap not found'),
      notFound.host,
    );
    expect(body(notFound.json).code).toBe('not_found');

    const forbidden = build();
    forbidden.filter.catch(new ForbiddenException('nope'), forbidden.host);
    expect(body(forbidden.json).code).toBe('insufficient_scope');

    const bad = build();
    bad.filter.catch(new BadRequestException('bad'), bad.host);
    expect(body(bad.json).code).toBe('validation_failed');
  });

  it('sanitizes an unexpected error to a generic 500 and logs it server-side', () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const { filter, host, status, json } = build();

    filter.catch(new Error('connect ECONNREFUSED 10.0.0.5:5432'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body(json)).toMatchObject({
      statusCode: 500,
      code: 'internal_error',
      message: 'Internal server error',
    });
    // The internal detail is logged, never returned.
    expect(JSON.stringify(body(json))).not.toContain('ECONNREFUSED');
    expect(error).toHaveBeenCalled();
  });

  it('preserves class-validator message arrays', () => {
    const { filter, host, json } = build();

    filter.catch(
      new BadRequestException([
        'source must be a valid Stellar account address (G...)',
        'amount must be a positive decimal',
      ]),
      host,
    );

    expect(body(json).message).toEqual([
      'source must be a valid Stellar account address (G...)',
      'amount must be a positive decimal',
    ]);
  });

  it('always emits a code, so integrators can rely on the field existing', () => {
    for (const exception of [
      new BadRequestException('x'),
      new NotFoundException('x'),
      new Error('x'),
      ApiError.unavailable(ApiErrorCode.Misconfigured, 'x'),
    ]) {
      const { filter, host, json } = build();
      jest.spyOn(Logger.prototype, 'error').mockImplementation();
      filter.catch(exception, host);
      expect(typeof body(json).code).toBe('string');
      expect(body(json).code).not.toBe('');
    }
  });
});
