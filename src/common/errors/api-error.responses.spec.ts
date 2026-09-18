import { STATUS_CODES } from 'node:http';
import { ApiErrorCode } from '@/common/errors/api-error';
import {
  API_ERROR_CASES,
  API_ERROR_EXAMPLE_TIMESTAMP,
  apiErrorContent,
  apiErrorDescription,
  apiErrorExample,
  apiErrorExamples,
  apiErrorResponse,
} from '@/common/errors/api-error.responses';

describe('API error documentation', () => {
  const codes = Object.values(ApiErrorCode);

  it('documents every published code', () => {
    // The Record type already forces this at compile time; the runtime check is
    // what catches a code added with a `// @ts-expect-error` or a merge that
    // dropped an entry.
    expect(Object.keys(API_ERROR_CASES).sort()).toEqual([...codes].sort());
  });

  it.each(codes)('%s has a usable example', (code) => {
    const example = API_ERROR_CASES[code];
    expect(example.statuses.length).toBeGreaterThan(0);
    for (const status of example.statuses) {
      expect(STATUS_CODES[status]).toBeDefined();
    }
    expect(example.summary).not.toHaveLength(0);
    expect(example.message).not.toHaveLength(0);
    // The envelope's `path` is a request path, and a reader copies it.
    expect(example.path).toMatch(/^\/v1\//);
  });

  describe('apiErrorExample', () => {
    it('stamps the status it is given into the envelope', () => {
      expect(apiErrorExample(ApiErrorCode.ProviderUnavailable, 504)).toEqual({
        statusCode: 504,
        code: 'provider_unavailable',
        error: 'Gateway Timeout',
        message: expect.any(String),
        path: expect.any(String),
        timestamp: API_ERROR_EXAMPLE_TIMESTAMP,
      });
    });

    it('defaults to the code’s usual status', () => {
      const example = apiErrorExample(ApiErrorCode.ProviderUnavailable);
      expect(example.statusCode).toBe(503);
      expect(example.error).toBe('Service Unavailable');
    });

    it.each(codes)(
      '%s agrees with its own status and reason phrase',
      (code) => {
        for (const status of API_ERROR_CASES[code].statuses) {
          const example = apiErrorExample(code, status);
          expect(example.statusCode).toBe(status);
          expect(example.code).toBe(code);
          expect(example.error).toBe(STATUS_CODES[status]);
        }
      },
    );

    it('is fixed in time, so the spec regenerates byte for byte', () => {
      expect(apiErrorExample(ApiErrorCode.NotFound).timestamp).toBe(
        apiErrorExample(ApiErrorCode.Internal).timestamp,
      );
    });
  });

  describe('apiErrorExamples', () => {
    it('keys the picker by code', () => {
      const examples = apiErrorExamples(403, [
        ApiErrorCode.InsufficientScope,
        ApiErrorCode.GatewayRequired,
      ]);
      expect(Object.keys(examples)).toEqual([
        'insufficient_scope',
        'gateway_required',
      ]);
      expect(examples.gateway_required.summary).toContain('gateway_required');
    });

    it('lets a route override the message and path it really sends', () => {
      const examples = apiErrorExamples(
        503,
        [ApiErrorCode.ProviderUnavailable],
        {
          [ApiErrorCode.ProviderUnavailable]: {
            summary: 'an indicator is down',
            message: 'Service Unavailable Exception',
            path: '/v1/health/readiness',
          },
        },
      );
      expect(examples.provider_unavailable).toEqual({
        summary: 'provider_unavailable — an indicator is down',
        value: {
          statusCode: 503,
          code: 'provider_unavailable',
          error: 'Service Unavailable',
          message: 'Service Unavailable Exception',
          path: '/v1/health/readiness',
          timestamp: API_ERROR_EXAMPLE_TIMESTAMP,
        },
      });
    });

    it('keeps an override from contradicting the status it sits under', () => {
      // `summary` is the picker's label, not part of the body, and the fields
      // that identify the failure are not overridable at all.
      const examples = apiErrorExamples(404, [ApiErrorCode.NotFound], {
        [ApiErrorCode.NotFound]: { summary: 'gone' },
      });
      expect(examples.not_found.value).not.toHaveProperty('summary');
      expect(examples.not_found.value.statusCode).toBe(404);
    });
  });

  describe('apiErrorResponse', () => {
    it('carries the envelope schema and one example per code', () => {
      const response = apiErrorResponse(409, [
        ApiErrorCode.IdempotencyConflict,
        ApiErrorCode.OperationInFlight,
      ]);
      const body = response.content?.['application/json'];
      expect(body?.schema).toEqual({
        $ref: '#/components/schemas/ApiErrorBodyEntity',
      });
      expect(Object.keys(body?.examples ?? {})).toEqual([
        'idempotency_conflict',
        'operation_in_flight',
      ]);
      expect(response.description).toContain('`idempotency_conflict`');
    });

    it('takes a route’s own prose over the generated list', () => {
      const response = apiErrorResponse(404, [ApiErrorCode.NotFound], {
        description: 'The pool is not on this network.',
      });
      expect(response.description).toBe('The pool is not on this network.');
    });

    it('attaches headers only when asked', () => {
      expect(apiErrorResponse(500, [ApiErrorCode.Internal])).not.toHaveProperty(
        'headers',
      );
    });
  });

  it('builds a description a reader can act on', () => {
    expect(apiErrorDescription([ApiErrorCode.RateLimited])).toBe(
      `\`rate_limited\` — ${API_ERROR_CASES[ApiErrorCode.RateLimited].summary}`,
    );
  });

  it('serves the envelope as JSON only', () => {
    expect(
      Object.keys(apiErrorContent(400, [ApiErrorCode.ValidationFailed])),
    ).toEqual(['application/json']);
  });
});
