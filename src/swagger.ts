import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import type { OperationObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { ApiErrorBodyEntity } from './common/errors/api-error.entity';

/**
 * Single source of truth for the OpenAPI document. Used both by the running
 * server (Swagger UI at /docs) and by the `openapi:generate` script that writes
 * the spec to disk so other services can consume it.
 */
export function buildSwaggerConfig() {
  const builder = new DocumentBuilder()
    .setTitle('Cosmos Pay — Payments API')
    .setDescription(
      'Payments microservice (Stellar payment intents). All endpoints require ' +
        'traffic to arrive through the APISIX gateway: a valid `X-Gateway-Secret` ' +
        'header plus an authenticated consumer (`X-Consumer-Username`). Paths ' +
        'already include the version (`/v1/...`).',
    )
    .setVersion('1.0')
    // Document the headers APISIX injects so consumers of the spec understand
    // how the gate works (these are normally set by the gateway, not the client).
    .addApiKey(
      { type: 'apiKey', in: 'header', name: 'X-Gateway-Secret' },
      'gateway-secret',
    )
    .addApiKey(
      { type: 'apiKey', in: 'header', name: 'X-Consumer-Username' },
      'consumer',
    )
    .addSecurityRequirements('gateway-secret')
    .addSecurityRequirements('consumer');

  // Optionally point the spec at the public gateway host (root URL — paths
  // already carry /v1). Set OPENAPI_SERVER_URL when generating for prod.
  const serverUrl = process.env.OPENAPI_SERVER_URL;
  if (serverUrl) {
    builder.addServer(serverUrl, 'Gateway base URL');
  }

  return builder.build();
}

/**
 * Every status the exception filter can produce, with the reason phrase the
 * envelope carries. Attached to every operation below rather than repeated as a
 * decorator on ~70 handlers.
 */
const ERROR_RESPONSES: Record<string, string> = {
  '400': 'Validation failed, or the request is not valid in the current state.',
  '401': 'No authenticated consumer, or admin credentials are required.',
  '403':
    'The API key lacks the required scope, or the request did not arrive through the gateway.',
  '404': 'The resource does not exist, or does not belong to this consumer.',
  '409':
    'Conflicts with existing state — an idempotency clash, an operation already in flight, or an invalid state transition.',
  '502': 'An upstream provider returned an error.',
  '503':
    'An upstream provider is unavailable, or the service is misconfigured.',
  '500':
    'Unexpected server error. The detail is logged server-side and never returned.',
};

/**
 * Builds the OpenAPI document from the app's metadata.
 *
 * Error responses are attached here, after generation. Nest only documents what
 * decorators declare, and the envelope was declared nowhere — so the published
 * spec described the success path of ~70 routes and said nothing at all about
 * failure, despite `code` being the stable contract integrators are told to
 * branch on. Attaching centrally also keeps it honest: a new route cannot
 * forget to document its errors.
 */
export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const document = SwaggerModule.createDocument(app, buildSwaggerConfig(), {
    extraModels: [ApiErrorBodyEntity],
  });

  const schemaRef = { $ref: '#/components/schemas/ApiErrorBodyEntity' };
  for (const pathItem of Object.values(document.paths)) {
    for (const operation of Object.values(
      pathItem as Record<string, OperationObject | undefined>,
    )) {
      if (!operation?.responses) continue;
      const responses = operation.responses as Record<string, unknown>;
      for (const [status, description] of Object.entries(ERROR_RESPONSES)) {
        // Never overwrite a route that documents its own error more precisely.
        if (responses[status]) continue;
        responses[status] = {
          description,
          content: { 'application/json': { schema: schemaRef } },
        };
      }
    }
  }

  return document;
}

/**
 * Mounts Swagger UI at /docs and exposes the raw spec at:
 *   - GET /docs/json  (OpenAPI JSON)
 *   - GET /docs/yaml  (OpenAPI YAML)
 * so another server can fetch the live spec directly.
 */
export function setupSwagger(app: INestApplication): OpenAPIObject {
  const document = createOpenApiDocument(app);
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs/json',
    yamlDocumentUrl: 'docs/yaml',
    swaggerOptions: {
      // Off in production. The documented schemes are X-Gateway-Secret and
      // X-Consumer-Username, and /docs is mounted outside every guard — so
      // persisting would write the real gateway secret into browser
      // localStorage on an unauthenticated page.
      persistAuthorization: process.env.NODE_ENV !== 'production',
    },
  });
  return document;
}
