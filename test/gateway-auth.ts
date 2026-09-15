import request from 'supertest';

/**
 * Satisfies ApisixGuard + PermissionsGuard in e2e harness requests.
 *
 * The account email is what the Pollar bridge binds a login to; it is the
 * `mail` the Pollar e2e fixtures log in with.
 */
export function withGatewayAuth(req: request.Test): request.Test {
  return req
    .set('x-gateway-secret', 'topsecret-topsecret-topsecret-topsecret')
    .set('x-consumer-username', 'cosmos_u1')
    .set('x-consumer-role', 'admin')
    .set('x-consumer-email', 'ada@example.com');
}
