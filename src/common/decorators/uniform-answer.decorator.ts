import { ApiExtension } from '@nestjs/swagger';

/**
 * Vendor extension the published spec carries, and `swagger.ts` reads back: the
 * route answers the same whether or not the resource its path names exists.
 */
export const UNIFORM_ANSWER_EXTENSION_KEY = 'x-cosmos-uniform-answer';

/**
 * Marks a route that answers identically whether or not the resource in its
 * path exists — so it has no 404 to document, although the path has a
 * `{param}`.
 *
 * It is a security property, not a formatting one: alias recovery answers
 * `{ accepted: true }` for any name, because a differing answer would confirm
 * which mailbox owns a public handle. Publishing it tells an integrator not to
 * read anything into the answer, and keeps the contract from promising a 404
 * the route must never send.
 */
export const UniformAnswer = () =>
  ApiExtension(UNIFORM_ANSWER_EXTENSION_KEY, true);
