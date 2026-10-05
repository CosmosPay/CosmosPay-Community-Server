import { ApisixContextMiddleware } from '@/common/middleware/apisix-context.middleware';
import { signConsoleMarker } from '@/admin/console-marker';

const APISIX = {
  consumerHeader: 'x-consumer-username',
  credentialHeader: 'x-credential-identifier',
  environmentHeader: 'x-consumer-env',
  roleHeader: 'x-consumer-role',
  permissionsHeader: 'x-consumer-permissions',
  organizationHeader: 'x-consumer-org',
  planHeader: 'x-consumer-plan',
  swapFeeBpsHeader: 'x-plan-swap-fee-bps',
  emailHeader: 'x-consumer-email',
  gatewaySecret: 'topsecret-topsecret-topsecret-topsecret',
};

/** Runs the middleware over a request carrying `headers` and returns the consumer. */
function consumerFor(headers: Record<string, string>) {
  const config: any = { get: jest.fn(() => APISIX) };
  const middleware = new ApisixContextMiddleware(config);
  const req: any = { headers };
  const next = jest.fn();
  middleware.use(req, {} as any, next);
  expect(next).toHaveBeenCalled();
  return req.gatewayConsumer;
}

describe('ApisixContextMiddleware', () => {
  it('attaches no consumer when the gateway forwarded none', () => {
    expect(consumerFor({ 'x-consumer-email': 'ada@example.com' })).toBe(
      undefined,
    );
  });

  it('reads the account email the gateway forwards, lowercased', () => {
    // Anything that compares it with another email must not read a casing
    // difference as a different person.
    const consumer = consumerFor({
      'x-consumer-username': 'cosmos_u1',
      'x-consumer-email': '  Ada@Example.COM ',
    });
    expect(consumer.email).toBe('ada@example.com');
  });

  it('treats a malformed email as not forwarded', () => {
    // Null fails any identity check closed; a garbled value must not be
    // compared as though it named someone.
    for (const raw of ['ada', '@example.com', 'ada@', 'a b@example.com']) {
      expect(
        consumerFor({
          'x-consumer-username': 'cosmos_u1',
          'x-consumer-email': raw,
        }).email,
      ).toBeNull();
    }
    expect(
      consumerFor({ 'x-consumer-username': 'cosmos_u1' }).email,
    ).toBeNull();
  });

  it('marks a console call as internal, and nothing else', () => {
    expect(
      consumerFor({
        'x-consumer-username': 'cosmos_u1',
        'x-cosmos-internal': signConsoleMarker(
          APISIX.gatewaySecret,
          Date.now(),
        ),
      }).internal,
    ).toBe(true);
    // The bare marker exempted its sender from per-consumer rate limits once;
    // a route that forgot to strip the header handed that to any API key.
    expect(
      consumerFor({
        'x-consumer-username': 'cosmos_u1',
        'x-cosmos-internal': '1',
      }).internal,
    ).toBe(false);
    expect(
      consumerFor({
        'x-consumer-username': 'cosmos_u1',
        'x-cosmos-internal': '0',
      }).internal,
    ).toBe(false);
    expect(consumerFor({ 'x-consumer-username': 'cosmos_u1' }).internal).toBe(
      false,
    );
  });
});
