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
 * Registered as the default response for every route in `swagger.ts`, so it is
 * documented once rather than per handler.
 */
export class ApiErrorBodyEntity {
  @ApiProperty({ example: 409 })
  statusCode!: number;

  @ApiProperty({
    description:
      'Stable machine-readable code. Branch on this, never on the message — ' +
      'messages are human-facing and may be reworded; codes are never renamed ' +
      'once published.',
    enum: ApiErrorCode,
    example: ApiErrorCode.IdempotencyConflict,
  })
  code!: ApiErrorCode;

  @ApiProperty({
    description: 'The HTTP reason phrase for `statusCode`.',
    example: 'Conflict',
  })
  error!: string;

  @ApiProperty({
    description:
      'Human-readable detail. An array when class-validator rejected the body.',
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    example: 'A swap already exists for this Idempotency-Key',
  })
  message!: string | string[];

  @ApiProperty({ example: '/v1/swaps' })
  path!: string;

  @ApiProperty({ example: '2026-06-21T12:34:56.000Z' })
  timestamp!: string;
}

/**
 * The envelope as an `@ApiResponse` `content`, by `$ref`.
 *
 * Use this instead of `type: ApiErrorBodyEntity` when a route documents one of
 * its errors itself. `swagger.ts` registers the entity once through
 * `extraModels`; naming it as a `type` registers it again while that controller
 * is scanned, which moves it within `components.schemas` and churns the
 * published contract for no change in it.
 */
export const API_ERROR_BODY_CONTENT = {
  'application/json': { schema: { $ref: getSchemaPath(ApiErrorBodyEntity) } },
};
