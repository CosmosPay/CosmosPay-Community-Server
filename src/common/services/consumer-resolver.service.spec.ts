import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';

const consumer = {
  username: 'cosmos_u1',
  credentialId: 'cred_1',
  environment: 'dev',
} as GatewayConsumer;

function build() {
  const upsert = jest.fn(({ where }: { where: { apisixUsername: string } }) =>
    Promise.resolve({ id: `local_${where.apisixUsername}` }),
  );
  return {
    service: new ConsumerResolverService({ consumer: { upsert } } as never),
    upsert,
  };
}

describe('ConsumerResolverService', () => {
  afterEach(() => jest.useRealTimers());

  it('resolve upserts the mirror row on every call', async () => {
    const { service, upsert } = build();
    await service.resolve(consumer);
    await service.resolve(consumer);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[0][0]).toMatchObject({
      where: { apisixUsername: 'cosmos_u1' },
      update: { credentialId: 'cred_1' },
    });
  });

  it('resolveId upserts once per consumer and credential, then reuses the id', async () => {
    const { service, upsert } = build();

    const ids = await Promise.all([
      service.resolveId(consumer),
      service.resolveId(consumer),
    ]);
    await service.resolveId(consumer);

    expect(ids).toEqual(['local_cosmos_u1', 'local_cosmos_u1']);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('resolveId never answers one consumer with another’s id, and upserts a new credential at once', async () => {
    const { service, upsert } = build();

    await service.resolveId(consumer);
    await expect(
      service.resolveId({ ...consumer, username: 'cosmos_u2' }),
    ).resolves.toBe('local_cosmos_u2');
    await service.resolveId({ ...consumer, credentialId: 'cred_2' });

    expect(upsert).toHaveBeenCalledTimes(3);
    expect(upsert.mock.calls[2][0]).toMatchObject({
      update: { credentialId: 'cred_2' },
    });
  });

  it('resolveId upserts again after a minute', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-26T12:00:00Z') });
    const { service, upsert } = build();

    await service.resolveId(consumer);
    jest.setSystemTime(new Date('2026-10-26T12:00:59Z'));
    await service.resolveId(consumer);
    expect(upsert).toHaveBeenCalledTimes(1);

    jest.setSystemTime(new Date('2026-10-26T12:01:00Z'));
    await service.resolveId(consumer);
    expect(upsert).toHaveBeenCalledTimes(2);
  });
});
