import { ApiProperty } from '@nestjs/swagger';
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
