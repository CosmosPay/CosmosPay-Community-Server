import type { OpenAPIObject } from '@nestjs/swagger';
import { ALLOW_PUBLIC_KEY_EXTENSION_KEY } from '@/common/decorators/allow-public-key.decorator';
import { UPSTREAM_EXTENSION_KEY } from '@/common/decorators/api-upstream.decorator';
import { PUBLIC_EXTENSION_KEY } from '@/common/decorators/public.decorator';
import { RATE_LIMIT_EXTENSION_KEY } from '@/common/decorators/rate-limit.decorator';
import {
  attachErrorResponses,
  buildSwaggerConfig,
  findOpenApiIssues,
} from '@/swagger';

/**
 * A document shaped like the one `SwaggerModule.createDocument` produces, with
 * only the parts the attachment reads. Built by hand rather than booted: what
 * is under test is the rule that turns "what a route declares" into "what the
 * contract says it can fail with", and that rule is a pure function.
 */
function documentWith(
  operations: Record<string, Record<string, unknown>>,
): OpenAPIObject {
  const paths: OpenAPIObject['paths'] = {};
  for (const [key, operation] of Object.entries(operations)) {
    const [method, path] = key.split(' ');
    paths[path] = {
      ...paths[path],
      [method.toLowerCase()]: {
        summary: `test ${key}`,
        responses: { '200': { description: '' } },
        ...operation,
      },
    };
  }
  return {
    openapi: '3.0.0',
    info: { title: 'test', version: '1' },
    paths,
  };
}

const statusesOf = (
  document: OpenAPIObject,
  path: string,
  method = 'get',
): string[] =>
  Object.keys(
    (
      document.paths[path] as Record<
        string,
        { responses: Record<string, unknown> }
      >
    )[method].responses,
  );

describe('attachErrorResponses', () => {
  it('publishes each shared failure once, and references it', () => {
    const document = attachErrorResponses(
      documentWith({ 'GET /v1/products': {} }),
    );

    expect(Object.keys(document.components?.responses ?? {})).toEqual(
      expect.arrayContaining(['Unauthorized', 'Forbidden', 'InternalError']),
    );
    expect(
      (document.paths['/v1/products'] as Record<string, { responses: object }>)
        .get.responses,
    ).toMatchObject({
      '401': { $ref: '#/components/responses/Unauthorized' },
      '500': { $ref: '#/components/responses/InternalError' },
    });
  });

  it('never invents a conflict', () => {
    // The whole read surface used to document `409 idempotency_conflict`.
    const document = attachErrorResponses(
      documentWith({ 'GET /v1/products/{id}': {} }),
    );
    expect(statusesOf(document, '/v1/products/{id}')).not.toContain('409');
  });

  it('documents 404 only where a path names a resource', () => {
    const document = attachErrorResponses(
      documentWith({ 'GET /v1/products': {}, 'GET /v1/products/{id}': {} }),
    );
    expect(statusesOf(document, '/v1/products')).not.toContain('404');
    expect(statusesOf(document, '/v1/products/{id}')).toContain('404');
  });

  it('documents 400 only where there is something to validate', () => {
    const document = attachErrorResponses(
      documentWith({
        'GET /v1/balances': { parameters: [] },
        'GET /v1/logs': {
          parameters: [{ name: 'take', in: 'query', schema: {} }],
        },
        'GET /v1/swaps': {
          // A documented header is not input the pipe can reject.
          parameters: [{ name: 'Idempotency-Key', in: 'header', schema: {} }],
        },
        'POST /v1/customers': { requestBody: { content: {} } },
      }),
    );
    expect(statusesOf(document, '/v1/balances')).not.toContain('400');
    expect(statusesOf(document, '/v1/swaps')).not.toContain('400');
    expect(statusesOf(document, '/v1/logs')).toContain('400');
    expect(statusesOf(document, '/v1/customers', 'post')).toContain('400');
  });

  describe('a @Public() route', () => {
    const document = attachErrorResponses(
      documentWith({
        'GET /v1/health/liveness': { [PUBLIC_EXTENSION_KEY]: true },
      }),
    );

    it('cannot be refused for a credential it never asks for', () => {
      expect(statusesOf(document, '/v1/health/liveness')).toEqual([
        '200',
        '500',
      ]);
    });

    it('says so, so an imported collection stops sending one', () => {
      expect(
        (document.paths['/v1/health/liveness'] as Record<string, unknown>).get,
      ).toMatchObject({ security: [] });
    });
  });

  describe('a @RateLimit route', () => {
    const document = attachErrorResponses(
      documentWith({
        'POST /v1/swaps': {
          [RATE_LIMIT_EXTENSION_KEY]: [
            { name: 'swap-create', limit: 30, windowMs: 60_000 },
          ],
          responses: { '201': { description: '' } },
        },
        'GET /v1/products': {},
      }),
    );
    const operation = (
      document.paths['/v1/swaps'] as Record<
        string,
        { responses: Record<string, { headers?: object }> }
      >
    ).post;

    it('documents the refusal', () => {
      expect(statusesOf(document, '/v1/swaps', 'post')).toContain('429');
      expect(statusesOf(document, '/v1/products')).not.toContain('429');
    });

    it('documents the budget on the way out, not only on the way back', () => {
      expect(Object.keys(operation.responses['201'].headers ?? {})).toEqual([
        'ratelimit-limit',
        'ratelimit-remaining',
        'ratelimit-reset',
      ]);
    });
  });

  describe('an @ApiUpstream route', () => {
    const document = attachErrorResponses(
      documentWith({
        'POST /v1/offramp/quotes': { [UPSTREAM_EXTENSION_KEY]: ['BlindPay'] },
        'POST /v1/swaps/quote': { [UPSTREAM_EXTENSION_KEY]: ['Horizon'] },
        'GET /v1/products': {},
      }),
    );

    it('distinguishes an HTTP provider from the Stellar SDK', () => {
      // BlindPay and Pollar are `fetch` calls that can be refused (502) or time
      // out (504); Horizon is wrapped by the SDK and only ever a 503 here.
      expect(statusesOf(document, '/v1/offramp/quotes', 'post')).toEqual(
        expect.arrayContaining(['502', '503', '504']),
      );
      expect(statusesOf(document, '/v1/swaps/quote', 'post')).toContain('503');
      expect(statusesOf(document, '/v1/swaps/quote', 'post')).not.toContain(
        '502',
      );
    });

    it('leaves a route that calls nobody alone', () => {
      expect(statusesOf(document, '/v1/products')).not.toContain('503');
    });
  });

  it('never overwrites a failure the route documents itself', () => {
    const own = {
      description: 'The memo is already taken.',
      content: { 'application/json': { schema: {} } },
    };
    const document = attachErrorResponses(
      documentWith({
        'POST /v1/payment-intents/pay': {
          responses: { '201': { description: '' }, '409': own },
        },
      }),
    );
    expect(
      (
        document.paths['/v1/payment-intents/pay'] as Record<
          string,
          { responses: Record<string, unknown> }
        >
      ).post.responses['409'],
    ).toBe(own);
  });

  it('gives Nest’s blank success descriptions the reason phrase', () => {
    const document = attachErrorResponses(
      documentWith({
        'POST /v1/customers': { responses: { '201': { description: '' } } },
      }),
    );
    expect(
      (
        document.paths['/v1/customers'] as Record<
          string,
          { responses: Record<string, { description: string }> }
        >
      ).post.responses['201'].description,
    ).toBe('Created');
  });
});

describe('findOpenApiIssues', () => {
  it('passes a document built the documented way', () => {
    const document = attachErrorResponses(
      documentWith({
        'GET /v1/products/{id}': {},
        'POST /v1/swaps': {
          [RATE_LIMIT_EXTENSION_KEY]: [
            { name: 'swap-create', limit: 30, windowMs: 60_000 },
          ],
          [ALLOW_PUBLIC_KEY_EXTENSION_KEY]: true,
          responses: { '201': { description: '' } },
        },
      }),
    );
    expect(findOpenApiIssues(document)).toEqual([]);
  });

  it('catches an operation with no summary', () => {
    const document = documentWith({ 'GET /v1/products': { summary: '' } });
    expect(findOpenApiIssues(document)).toContainEqual(
      expect.stringContaining('no summary'),
    );
  });

  it('catches a 429 on a route with no budget to spend', () => {
    const document = documentWith({
      'GET /v1/products': {
        responses: {
          '200': { description: 'ok' },
          '429': {
            description: 'slow down',
            content: {
              'application/json': {
                examples: { rate_limited: { value: { statusCode: 429 } } },
              },
            },
          },
        },
      },
    });
    expect(findOpenApiIssues(document)).toContainEqual(
      expect.stringContaining('declares no @RateLimit'),
    );
  });

  it('catches a budget that is enforced but not published', () => {
    const document = documentWith({
      'POST /v1/swaps': {
        [RATE_LIMIT_EXTENSION_KEY]: [
          { name: 'swap-create', limit: 30, windowMs: 60_000 },
        ],
        responses: { '201': { description: 'ok' } },
      },
    });
    expect(findOpenApiIssues(document)).toContainEqual(
      expect.stringContaining('does not document 429'),
    );
  });

  it('catches a failure documented with no body', () => {
    const document = documentWith({
      'GET /v1/products': {
        responses: {
          '200': { description: 'ok' },
          '403': { description: 'nope' },
        },
      },
    });
    expect(findOpenApiIssues(document)).toContainEqual(
      expect.stringContaining('no application/json body'),
    );
  });

  it('catches an example that belongs to another status', () => {
    const document = documentWith({
      'GET /v1/products': {
        responses: {
          '200': { description: 'ok' },
          '404': {
            description: 'gone',
            content: {
              'application/json': {
                examples: {
                  idempotency_conflict: { value: { statusCode: 409 } },
                },
              },
            },
          },
        },
      },
    });
    expect(findOpenApiIssues(document)).toContainEqual(
      expect.stringContaining('carries statusCode 409'),
    );
  });
});

describe('buildSwaggerConfig', () => {
  it('requires both APISIX headers together, not either one', () => {
    // Two separate requirements are an OR, so an imported collection set one
    // header and was refused by the gateway check it had not satisfied.
    expect(buildSwaggerConfig({ serverUrl: '' }).security).toEqual([
      { 'gateway-secret': [], consumer: [] },
      { 'api-key': [] },
    ]);
  });

  it('offers the gateway first once one is configured', () => {
    const config = buildSwaggerConfig({ serverUrl: 'https://gw.example.com' });
    expect(config.security?.[0]).toEqual({ 'api-key': [] });
    expect(config.servers?.[0]).toMatchObject({
      url: 'https://gw.example.com',
    });
  });

  it('always names a server, so an import has a base URL', () => {
    const config = buildSwaggerConfig({ serverUrl: '' });
    expect(config.servers).toEqual([
      expect.objectContaining({
        url: 'http://localhost:{port}',
        variables: { port: { default: '3000' } },
      }),
    ]);
  });

  it('describes every tag it publishes', () => {
    for (const tag of buildSwaggerConfig({ serverUrl: '' }).tags ?? []) {
      expect(tag.description).toEqual(expect.any(String));
      expect(tag.description).not.toHaveLength(0);
    }
  });
});
