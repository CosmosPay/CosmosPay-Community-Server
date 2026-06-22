import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

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

/** Builds the OpenAPI document from the app's metadata. */
export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  return SwaggerModule.createDocument(app, buildSwaggerConfig());
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
    swaggerOptions: { persistAuthorization: true },
  });
  return document;
}
