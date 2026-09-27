import { ApiProperty, getSchemaPath } from '@nestjs/swagger';
import { ApiErrorCode } from '@/common/errors/api-error';

/**
 * The envelope every failure returns, published so integrators can find it.
 *
 * `AllExceptionsFilter` has always emitted this shape, and the README told
 * readers "the full code list is `ApiErrorCode` in
 * src/common/errors/api-error.ts" — i.e. read our source. The spec carried no
 * 4xx/5xx schema at all, so the `code` field, which exists precisely so an
 * integrator can branch on it, was undiscoverable from the contract.
 *
 * This class is only the SHAPE. What a given status actually returns —
 * `statusCode`, `error`, the codes it can carry and a real `message` for each —
 * is in `api-error.responses.ts`, and `swagger.ts` attaches those per route.
 * The property examples below therefore have to be one self-consistent envelope
 * (a validation failure, the most common one) rather than a mix: a tool that
 * builds a sample body out of them, as Postman does when a response has no
 * example of its own, composes exactly what is written here. They used to
 * compose a 409 `idempotency_conflict` — which is what every 401, 404 and 500
 * in the published spec then appeared to return.
 */
export class ApiErrorBodyEntity {
  @ApiProperty({
    description: 'Always the HTTP status of the response itself.',
    example: 400,
  })
  statusCode!: number;

  @ApiProperty({
    description:
      'Stable machine-readable code. Branch on this, never on the message — ' +
      'messages are human-facing and may be reworded; codes are never renamed ' +
      'once published. Each response documents the subset it can return.',
    enum: ApiErrorCode,
    example: ApiErrorCode.ValidationFailed,
  })
  code!: ApiErrorCode;

  @ApiProperty({
    description: 'The HTTP reason phrase for `statusCode`.',
    example: 'Bad Request',
  })
  error!: string;

  @ApiProperty({
    description:
      'Human-readable detail. An array when class-validator rejected the body.',
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    example: ['amount must be a positive decimal string'],
  })
  message!: string | string[];

  @ApiProperty({
    description: 'The path of the request that failed.',
    example: '/v1/swaps',
  })
  path!: string;

  @ApiProperty({
    description: 'When the envelope was produced, ISO 8601.',
    example: '2026-09-01T12:00:00.000Z',
  })
  timestamp!: string;
}

/**
 * The envelope as a `$ref`.
 *
 * Use this — through the helpers in `api-error.responses.ts`, not by hand —
 * instead of `type: ApiErrorBodyEntity` when a route documents one of its
 * errors itself. `swagger.ts` registers the entity once through `extraModels`;
 * naming it as a `type` registers it again while that controller is scanned,
 * which moves it within `components.schemas` and churns the published contract
 * for no change in it.
 */
export const API_ERROR_BODY_SCHEMA = {
  $ref: getSchemaPath(ApiErrorBodyEntity),
};
