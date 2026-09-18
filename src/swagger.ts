import { INestApplication } from '@nestjs/common';
// `OperationObject` and friends come from the package root, not
// `@nestjs/swagger/dist/...`. Swagger 12 publishes an `exports` map that exposes
// only "." and "./plugin", so the deep path stopped resolving; the types are
// re-exported from the root anyway.
import {
  DocumentBuilder,
  OpenAPIObject,
  SwaggerModule,
  type OperationObject,
  type ResponseObject,
  type ResponsesObject,
  type SecurityRequirementObject,
} from '@nestjs/swagger';
import { ALLOW_PUBLIC_KEY_EXTENSION_KEY } from '@/common/decorators/allow-public-key.decorator';
import {
  UPSTREAM_EXTENSION_KEY,
  type UpstreamProvider,
} from '@/common/decorators/api-upstream.decorator';
import { PUBLIC_EXTENSION_KEY } from '@/common/decorators/public.decorator';
import {
  RATE_LIMIT_EXTENSION_KEY,
  type RateLimitPolicy,
} from '@/common/decorators/rate-limit.decorator';
import { ApiErrorCode, reasonPhrase } from '@/common/errors/api-error';
import { ApiErrorBodyEntity } from '@/common/errors/api-error.entity';
import {
  apiErrorResponse,
  RATE_LIMITED_RESPONSE_HEADERS,
  RATE_LIMIT_RESPONSE_HEADERS,
} from '@/common/errors/api-error.responses';
import type { AppConfig } from '@/config/configuration';

/**
 * Single source of truth for the OpenAPI document. Used both by the running
 * server (Swagger UI at /docs) and by the `openapi:generate` script that writes
 * the spec to disk so other services — and Postman — can consume it.
 *
 * Settings arrive as typed configuration instead of being read here, because
 * the environment is read only in `configuration.ts`. The two callers get them
 * differently: `main.ts` from `ConfigService`, and the generator by calling the
 * factory itself — it boots in preview mode, which never instantiates
 * `ConfigService`.
 */
export function buildSwaggerConfig(openapi: AppConfig['openapi']) {
  const builder = new DocumentBuilder()
    .setTitle('Cosmos Pay — Payments API')
    .setDescription(
      'Payments microservice (Stellar payment intents, swaps, liquidity ' +
        'pools, fiat on/offramp). Paths already include the version ' +
        '(`/v1/...`).\n\n' +
        '**Two ways to call it, and the spec documents both.** Through the ' +
        'APISIX gateway — the deployment integrators use — you send your API ' +
        'key as `Authorization: Bearer <key>`; the gateway validates it, ' +
        'strips it, and injects `X-Gateway-Secret` and `X-Consumer-Username` ' +
        'for this service. Against this service directly (local development, ' +
        'no gateway in front) you send those two headers yourself. Pick the ' +
        'matching server and security scheme below.\n\n' +
        '**Every failure returns the same envelope** (`ApiErrorBodyEntity`), ' +
        'and `code` is the part to branch on — `message` is prose and may be ' +
        'reworded. Each operation documents only the statuses it can really ' +
        'return: `429` appears where a budget is declared (the budget itself ' +
        'is published as `x-cosmos-rate-limit`), `502`/`503`/`504` where the ' +
        'route calls a provider (`x-cosmos-upstream`), and neither `401` nor ' +
        '`403` on the probes that need no credentials (`x-cosmos-public`).',
    )
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        description:
          'Your Cosmos Pay API key, for calls that go through the APISIX ' +
          'gateway. The gateway converts it to the `apikey` header, ' +
          'authenticates the consumer, and removes it before proxying — this ' +
          'service never sees it.',
      },
      'api-key',
    )
    // The headers APISIX injects. Documented as schemes because that is what a
    // caller hitting this service directly — local development, or another
    // service on the private network — has to send by hand.
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'X-Gateway-Secret',
        description:
          'Must equal `APISIX_GATEWAY_SECRET`. Set by the gateway in a real ' +
          'deployment; sent by hand only when calling this service directly.',
      },
      'gateway-secret',
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'X-Consumer-Username',
        description:
          'The authenticated consumer. Every tenant query filters by it, so ' +
          'two values are two separate sets of data. APISIX overwrites ' +
          'whatever a client sends.',
      },
      'consumer',
    );

  // Optionally point the spec at the public gateway host (root URL — paths
  // already carry /v1). Set OPENAPI_SERVER_URL when generating for prod.
  if (openapi.serverUrl) {
    builder.addServer(openapi.serverUrl, 'APISIX gateway (bearer API key)');
  }
  // Always offered, and always last when a gateway is configured, so an import
  // defaults to the server the reader is most likely to be on. A `{port}`
  // variable rather than the configured port: PORT is a local choice, and
  // baking it in would make the committed spec differ per developer and fail
  // `openapi:check`.
  builder.addServer(
    'http://localhost:{port}',
    'This service directly — send the two APISIX headers yourself',
    { port: { default: '3000' } },
  );

  // Security requirements are OR-ed by OpenAPI, which is exactly right here:
  // either you came through the gateway with a bearer key, or you are talking
  // to this service directly with both headers. Both headers in ONE entry is
  // the AND. They used to be two entries — "either secret or consumer" — so a
  // Postman import configured one header and got 401 on every call.
  const throughGateway: SecurityRequirementObject = { 'api-key': [] };
  const direct: SecurityRequirementObject = {
    'gateway-secret': [],
    consumer: [],
  };
  // First entry wins in the tools that pick one: match the default server.
  for (const requirement of openapi.serverUrl
    ? [throughGateway, direct]
    : [direct, throughGateway]) {
    builder.addSecurityRequirements(requirement);
  }

  for (const [name, description] of Object.entries(TAG_DESCRIPTIONS)) {
    builder.addTag(name, description);
  }

  return builder.build();
}

/**
 * One line per tag, so the sidebar in Swagger UI and the folder list in a
 * Postman import say what a group is for. `@ApiTags` alone publishes a bare
 * name and nothing else.
 */
const TAG_DESCRIPTIONS: Record<string, string> = {
  'payment-intents': 'Request a Stellar payment, then watch it settle.',
  swaps: 'Path payments between assets: quote, build, submit.',
  'liquidity-pools': 'Non-custodial AMM deposits and withdrawals.',
  aliases: 'Claimable payment handles, resolved to Stellar addresses.',
  customers: 'End users a payment intent can be attributed to.',
  products: 'Catalog items a payment intent can reference.',
  assets: 'The asset registry this service prices and validates against.',
  kyc: 'Receivers, their documents, wallets and bank accounts (BlindPay).',
  onramp: 'Fiat in: quotes, payins and virtual accounts (BlindPay).',
  offramp: 'Fiat out: quotes and payouts (BlindPay).',
  pollar: 'Social login that hands back a Stellar wallet.',
  webhooks: 'Endpoints this service notifies, and their delivery history.',
  activity: 'What a wallet or dashboard reports back about a session.',
  analytics: 'Aggregates over this consumer’s own traffic.',
  health: 'Liveness and readiness probes for the orchestrator.',
};

/**
 * The failure responses every route shares, published once under
 * `components.responses` and referenced by the operations that can return them.
 *
 * Shared rather than inlined per operation because these are genuinely the same
 * response: the same envelope, from the same guard, on 100-odd routes. Inlining
 * would add roughly a megabyte of identical examples to the spec.
 */
const SHARED_ERROR_RESPONSES = {
  ValidationFailed: apiErrorResponse(400, [ApiErrorCode.ValidationFailed], {
    description:
      'The body, query or path failed validation. `message` is an array of ' +
      'the individual failures.\n\nRoutes that reject a *valid* request for a ' +
      'reason of their own — an amount, a memo, a state — document the code ' +
      'for it on their own 400.',
  }),
  Unauthorized: apiErrorResponse(401, [ApiErrorCode.NoAuthenticatedConsumer]),
  Forbidden: apiErrorResponse(
    403,
    [ApiErrorCode.InsufficientScope, ApiErrorCode.GatewayRequired],
    {
      description:
        '`insufficient_scope` — the API key does not hold the scope this ' +
        'route requires. The shared public API key also gets this on every ' +
        'route that is not marked `x-cosmos-public-key`, with a message ' +
        'saying so; more scopes will not help, the key is the wrong one.\n\n' +
        '`gateway_required` — the request did not arrive through APISIX.',
    },
  ),
  NotFound: apiErrorResponse(404, [ApiErrorCode.NotFound], {
    description:
      'No such resource — or it exists and belongs to another consumer. The ' +
      'two are deliberately the same answer: "exists but not yours" is an ' +
      'ownership oracle.',
  }),
  RateLimited: apiErrorResponse(429, [ApiErrorCode.RateLimited], {
    description:
      'The budget in `x-cosmos-rate-limit` is spent for this caller. Honour ' +
      '`Retry-After`.\n\nThe `ratelimit-*` triple rides along on successful ' +
      'responses too, so a client can pace itself instead of being refused. ' +
      'If the counter store itself is unreachable the guard fails closed and ' +
      'answers `503 provider_unavailable`.',
    headers: RATE_LIMITED_RESPONSE_HEADERS,
  }),
  InternalError: apiErrorResponse(500, [ApiErrorCode.Internal], {
    description:
      'Unexpected server error. The detail is logged server-side and never ' +
      'returned — there is nothing in the body to branch on beyond the code.',
  }),
  UpstreamError: apiErrorResponse(
    502,
    [ApiErrorCode.ProviderError, ApiErrorCode.ProviderUnavailable],
    {
      description:
        'The provider named in `x-cosmos-upstream` refused the request ' +
        '(`provider_error`) or could not be reached at all ' +
        '(`provider_unavailable`). Nothing was charged; retry is safe with ' +
        'the same `Idempotency-Key`.',
    },
  ),
  UpstreamUnavailable: apiErrorResponse(
    503,
    [ApiErrorCode.ProviderUnavailable, ApiErrorCode.Misconfigured],
    {
      description:
        '`provider_unavailable` — the provider in `x-cosmos-upstream` is ' +
        'down or unreachable; the message names it. Retry.\n\n' +
        '`misconfigured` — this deployment is missing configuration the ' +
        'route needs (a provider instance, a fee wallet, the plan header the ' +
        'gateway must forward). Retrying will not help; it is an operator ' +
        'problem.',
    },
  ),
  UpstreamTimeout: apiErrorResponse(504, [ApiErrorCode.ProviderUnavailable], {
    description:
      'The provider in `x-cosmos-upstream` did not answer in time. Whether ' +
      'it acted on the request is unknown — retry with the same ' +
      '`Idempotency-Key`, never with a fresh one.',
  }),
} satisfies Record<string, ResponseObject>;

type SharedErrorResponse = keyof typeof SHARED_ERROR_RESPONSES;

/**
 * Which statuses each provider can fail with. Horizon is reached through the
 * Stellar SDK, which this service wraps in a plain `503` — it has no timeout
 * of its own to report and no body to pass through — while the two HTTP
 * clients distinguish "refused" (502), "down" (503) and "timed out" (504).
 */
const UPSTREAM_FAILURES: Record<
  UpstreamProvider,
  readonly SharedErrorResponse[]
> = {
  BlindPay: ['UpstreamError', 'UpstreamUnavailable', 'UpstreamTimeout'],
  Pollar: ['UpstreamError', 'UpstreamUnavailable', 'UpstreamTimeout'],
  Horizon: ['UpstreamUnavailable'],
};

const RESPONSE_STATUS: Record<SharedErrorResponse, number> = {
  ValidationFailed: 400,
  Unauthorized: 401,
  Forbidden: 403,
  NotFound: 404,
  RateLimited: 429,
  InternalError: 500,
  UpstreamError: 502,
  UpstreamUnavailable: 503,
  UpstreamTimeout: 504,
};

/** An operation plus the vendor extensions this codebase's decorators publish. */
interface CosmosOperation extends OperationObject {
  [PUBLIC_EXTENSION_KEY]?: boolean;
  [ALLOW_PUBLIC_KEY_EXTENSION_KEY]?: boolean;
  [RATE_LIMIT_EXTENSION_KEY]?: RateLimitPolicy[];
  [UPSTREAM_EXTENSION_KEY]?: UpstreamProvider[];
}

const HTTP_METHODS = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
] as const;

/** Every (path, method, operation) in the document, in document order. */
function* operationsOf(
  document: OpenAPIObject,
): Generator<{ path: string; method: string; operation: CosmosOperation }> {
  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = (
        pathItem as Record<string, CosmosOperation | undefined>
      )[method];
      if (operation) yield { path, method, operation };
    }
  }
}

/**
 * The failures a route can actually produce, derived from what guards and
 * decorators say about it rather than from a list applied to everything.
 *
 * Every operation used to be published with the same nine statuses, which meant
 * the spec claimed `GET /v1/products` could answer `409 idempotency_conflict`
 * and `/v1/health/liveness` could answer `401`. A status a route cannot return
 * is not harmless padding: it is a branch an integrator writes and can never
 * exercise, and it hides the ones that matter.
 *
 * 409 is never added here. A conflict is always specific to what the route
 * writes, so it is the route's own `@ApiErrorResponse` to declare — which is
 * also why one is no longer attached to the 80-odd read-only routes.
 */
function sharedFailuresFor(
  path: string,
  operation: CosmosOperation,
): SharedErrorResponse[] {
  const failures: SharedErrorResponse[] = [];

  // Anything with input can fail the validation pipe. A GET with no parameters
  // has nothing to reject.
  const hasInput =
    Boolean(operation.requestBody) ||
    (operation.parameters ?? []).some(
      (parameter) => 'in' in parameter && parameter.in !== 'header',
    );
  if (hasInput) failures.push('ValidationFailed');

  // A @Public() route is served without key-auth: ApisixGuard lets it through
  // and drops whatever consumer header arrived, so neither status can occur.
  if (!operation[PUBLIC_EXTENSION_KEY]) {
    failures.push('Unauthorized', 'Forbidden');
  }

  // A path parameter is a resource this consumer may not own, or may not exist.
  if (path.includes('{')) failures.push('NotFound');

  if (operation[RATE_LIMIT_EXTENSION_KEY]?.length) failures.push('RateLimited');

  for (const provider of operation[UPSTREAM_EXTENSION_KEY] ?? []) {
    for (const failure of UPSTREAM_FAILURES[provider]) {
      if (!failures.includes(failure)) failures.push(failure);
    }
  }

  // Nothing is exempt from an unhandled error.
  failures.push('InternalError');

  return failures;
}

/**
 * Attaches the shared failures, the rate-limit headers and the honest security
 * requirement to every operation, and gives the success responses Nest left
 * blank a description.
 *
 * Central rather than ~107 sets of decorators: a route added tomorrow is
 * documented the moment it declares what it is (`@Public`, `@RateLimit`,
 * `@ApiUpstream`), and no route can quietly ship with its failures undocumented.
 * Exported so a spec can drive it with a hand-built document, without a Nest
 * container.
 */
export function attachErrorResponses(document: OpenAPIObject): OpenAPIObject {
  document.components ??= {};
  document.components.responses = {
    ...document.components.responses,
    ...SHARED_ERROR_RESPONSES,
  };

  for (const { path, operation } of operationsOf(document)) {
    const responses: ResponsesObject = (operation.responses ??= {});

    // A public route is served without credentials at all. Saying so is what
    // makes an imported collection work: the tool otherwise sends the
    // document-level auth and the reader wonders which header was wrong.
    if (operation[PUBLIC_EXTENSION_KEY]) operation.security = [];

    const rateLimited = Boolean(operation[RATE_LIMIT_EXTENSION_KEY]?.length);

    for (const [status, response] of Object.entries(responses)) {
      if (!response || '$ref' in response) continue;
      // Nest emits `description: ''` for every `@ApiOkResponse({ type })`,
      // which Swagger UI renders as an empty line next to the status.
      response.description ||= reasonPhrase(Number(status));
      // The guard sets the triple on the way out, not only when it refuses.
      if (rateLimited && Number(status) < 400) {
        response.headers = {
          ...RATE_LIMIT_RESPONSE_HEADERS,
          ...response.headers,
        };
      }
    }

    for (const failure of sharedFailuresFor(path, operation)) {
      const status = String(RESPONSE_STATUS[failure]);
      // Never overwrite a route that documents its own failure more precisely.
      if (responses[status]) continue;
      responses[status] = { $ref: `#/components/responses/${failure}` };
    }
  }

  return document;
}

/**
 * Contract problems that should stop a release, not reach a client generator.
 *
 * `openapi:generate` fails on a non-empty result, so CI's `openapi:check` is
 * also the gate on these. Every rule here is a mistake this spec has actually
 * shipped: an operation with no summary, a failure documented with no body, an
 * example whose `statusCode` disagreed with the status it sat under, and a 429
 * on a route with no budget to spend.
 */
export function findOpenApiIssues(document: OpenAPIObject): string[] {
  const issues: string[] = [];

  for (const { path, method, operation } of operationsOf(document)) {
    const where = `${method.toUpperCase()} ${path}`;

    if (!operation.summary) {
      issues.push(`${where}: no summary — add @ApiOperation({ summary }).`);
    }

    const rateLimited = Boolean(operation[RATE_LIMIT_EXTENSION_KEY]?.length);
    const responses: ResponsesObject = operation.responses ?? {};

    if (responses['429'] && !rateLimited) {
      issues.push(
        `${where}: documents 429 but declares no @RateLimit — nothing can spend a budget it does not have.`,
      );
    }
    if (rateLimited && !responses['429']) {
      issues.push(`${where}: declares @RateLimit but does not document 429.`);
    }

    for (const [status, response] of Object.entries(responses)) {
      const code = Number(status);
      if (!response || '$ref' in response) continue;
      if (!response.description) {
        issues.push(`${where} ${status}: no description.`);
      }
      if (code < 400) continue;

      const body = response.content?.['application/json'];
      if (!body) {
        issues.push(
          `${where} ${status}: no application/json body — every failure returns the error envelope.`,
        );
        continue;
      }
      for (const [name, example] of Object.entries(body.examples ?? {})) {
        if ('$ref' in example) continue;
        const value = example.value as { statusCode?: number } | undefined;
        if (value?.statusCode !== code) {
          issues.push(
            `${where} ${status}: example "${name}" carries statusCode ${String(value?.statusCode)}.`,
          );
        }
      }
      if (!body.examples && !body.example) {
        issues.push(
          `${where} ${status}: no example — use @ApiErrorResponse so the body shown is one this route can return.`,
        );
      }
    }
  }

  return issues;
}

/**
 * Builds the OpenAPI document from the app's metadata, then attaches everything
 * the decorators know but Nest does not publish on its own.
 */
export function createOpenApiDocument(
  app: INestApplication,
  openapi: AppConfig['openapi'],
): OpenAPIObject {
  const document = SwaggerModule.createDocument(
    app,
    buildSwaggerConfig(openapi),
    { extraModels: [ApiErrorBodyEntity] },
  );

  return attachErrorResponses(document);
}

/**
 * Mounts Swagger UI at /docs and exposes the raw spec at:
 *   - GET /docs/json  (OpenAPI JSON)
 *   - GET /docs/yaml  (OpenAPI YAML)
 * so another server — or Postman's "import from URL" — can fetch the live spec
 * directly.
 */
export function setupSwagger(
  app: INestApplication,
  settings: Pick<AppConfig, 'nodeEnv' | 'openapi'>,
): OpenAPIObject {
  const document = createOpenApiDocument(app, settings.openapi);
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs/json',
    yamlDocumentUrl: 'docs/yaml',
    swaggerOptions: {
      // Off in production. The documented schemes include the gateway secret,
      // and /docs is mounted outside every guard — so persisting would write it
      // into browser localStorage on an unauthenticated page.
      persistAuthorization: settings.nodeEnv !== 'production',
    },
  });
  return document;
}
