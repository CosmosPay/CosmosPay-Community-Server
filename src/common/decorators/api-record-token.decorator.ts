import { ApiHeader, ApiProperty } from '@nestjs/swagger';

/**
 * The `X-Record-Token` header on the routes that read or act on ONE record the
 * shared public key may have created (`GET /v1/swaps/{id}`, its submit, ...).
 * Optional in the contract because a real key never sends it; required, in
 * practice, with the shared public key (`PublicRecordTokens`).
 */
export const ApiRecordTokenHeader = () =>
  ApiHeader({
    name: 'X-Record-Token',
    required: false,
    description:
      'Required with the shared public key: the `publicToken` the create ' +
      'response returned for this record. Without it, or with the token of ' +
      'another record, the answer is 404, as for a record that does not ' +
      'exist. Ignored for every other API key.',
    example: 'q3Zx0r8vH6c1yJ2bN5mT4kW9sD7fL0aE1gP3uR6iO2w',
  });

/**
 * `publicToken` on a create response: present only for the shared public key.
 * A property decorator, so each `*CreatedEntity` documents it the same way.
 */
export const ApiPublicTokenProperty = () =>
  ApiProperty({
    required: false,
    example: 'q3Zx0r8vH6c1yJ2bN5mT4kW9sD7fL0aE1gP3uR6iO2w',
    description:
      'Only when the caller is the shared public key: this record’s read ' +
      'token. Send it as `X-Record-Token` to read the record by id or act on ' +
      'it (submit, report a deposit); without it those routes answer 404. ' +
      'The same create replayed with its Idempotency-Key answers the same ' +
      'token. Keep it like the record id: whoever holds both can read the ' +
      'record.',
  });
