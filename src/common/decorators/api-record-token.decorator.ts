import { ApiHeader, ApiProperty } from '@nestjs/swagger';

const TOKEN_EXAMPLE = 'q3Zx0r8vH6c1yJ2bN5mT4kW9sD7fL0aE1gP3uR6iO2w';

/**
 * How a route treats a missing `X-Record-Token` from the shared public key:
 * `required` refuses it (404); `legacy` still accepts it for now, on the two
 * routes the wallet called before tokens existed (`LEGACY_RECORD_TOKEN_ROUTES`),
 * until `PUBLIC_RECORD_TOKEN_REQUIRED_ON_LEGACY` is on.
 */
export type RecordTokenRequirement = 'required' | 'legacy';

const HEADER_DESCRIPTIONS: Record<RecordTokenRequirement, string> = {
  required:
    'Required with the shared public key: the `publicToken` the create ' +
    'response returned for this record. Without it, or with the token of ' +
    'another record, the answer is 404, as for a record that does not ' +
    'exist. Ignored for every other API key.',
  legacy:
    'With the shared public key, send the `publicToken` the create response ' +
    'returned for this record. A wrong token is 404, as for a record that ' +
    'does not exist. A missing one is still accepted for now (and logged as ' +
    'deprecated) so wallets that do not send it yet keep working; it becomes ' +
    'required here when the deployment sets ' +
    '`PUBLIC_RECORD_TOKEN_REQUIRED_ON_LEGACY=true`. Ignored for every other ' +
    'API key.',
};

/**
 * The `X-Record-Token` header on the routes that read or act on ONE record the
 * shared public key may have created (`GET /v1/swaps/{id}`, its submit, ...).
 * Optional in the contract because a real key never sends it; whether the
 * public key must is `requirement` (`PublicRecordTokens`).
 */
export const ApiRecordTokenHeader = (
  requirement: RecordTokenRequirement = 'required',
) =>
  ApiHeader({
    name: 'X-Record-Token',
    required: false,
    description: HEADER_DESCRIPTIONS[requirement],
    example: TOKEN_EXAMPLE,
  });

/**
 * `publicToken` on a create response: present only for the shared public key.
 * A property decorator, so each `*CreatedEntity` documents it the same way.
 */
export const ApiPublicTokenProperty = () =>
  ApiProperty({
    required: false,
    example: TOKEN_EXAMPLE,
    description:
      'Only when the caller is the shared public key: this record’s read ' +
      'token. Send it as `X-Record-Token` on the routes of this one record. ' +
      'Reading it by id (and submitting a USDT0 transfer) answers 404 without ' +
      'it; swap submit and cross-chain deposit still accept a request without ' +
      'it for now, and will require it once the deployment turns ' +
      '`PUBLIC_RECORD_TOKEN_REQUIRED_ON_LEGACY` on. The same create replayed ' +
      'with its Idempotency-Key answers the same token. Keep it like the ' +
      'record id: whoever holds both can read the record.',
  });
