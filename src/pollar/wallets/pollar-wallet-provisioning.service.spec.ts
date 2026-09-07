import { PollarApiError } from '@/pollar/pollar.client';
import { POLLAR_WALLET_PROVISION_MAX_ATTEMPTS } from '@/pollar/pollar.constants';
import { PollarWalletProvisioningService } from '@/pollar/wallets/pollar-wallet-provisioning.service';

const ADDRESS = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const OTHER_ADDRESS =
  'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

/**
 * An in-memory stand-in for `pollar_user_wallet`, keyed the way the real unique
 * index is. The compound key is the idempotency of the whole feature — a repeat
 * login must upsert rather than fan out — so a fake that ignored it would make
 * the property untestable.
 */
function makeTable() {
  const rows: any[] = [];
  const keyOf = (k: any) => `${k.consumerId}|${k.externalId}|${k.network}`;

  return {
    rows,
    upsert: jest.fn(({ where, create, update }: any) => {
      const key = keyOf(where.consumerId_externalId_network);
      const existing = rows.find((row) => keyOf(row) === key);
      if (existing) {
        Object.assign(existing, update);
        return Promise.resolve(existing);
      }
      const row = {
        id: `w${rows.length + 1}`,
        status: 'PENDING',
        address: null,
        walletType: null,
        pollarUserId: null,
        attempts: 0,
        errorCode: null,
        nextAttemptAt: null,
        ...where.consumerId_externalId_network,
        ...create,
      };
      rows.push(row);
      return Promise.resolve(row);
    }),
    update: jest.fn(({ where, data }: any) => {
      const row = rows.find((r) => r.id === where.id);
      Object.assign(row, data);
      return Promise.resolve(row);
    }),
  };
}

function build() {
  const table = makeTable();
  const prisma: any = { pollarUserWallet: table };
  const pollar: any = { server: jest.fn() };
  const service = new PollarWalletProvisioningService(prisma, pollar);
  return { service, table, pollar };
}

const INPUT = {
  consumerId: 'c1',
  externalId: 'ada@example.com',
  primaryNetwork: 'testnet' as const,
  wallet: { type: 'internal' as const, address: ADDRESS },
  pollarUserId: 'usr_1',
  profile: { first_name: 'Ada', last_name: 'Lovelace' },
};

const row = (table: ReturnType<typeof makeTable>, network: string) =>
  table.rows.find((r) => r.network === network);

describe('provisionBothNetworks', () => {
  it('provisions the counterpart network and reports both', async () => {
    const { service, table, pollar } = build();
    pollar.server.mockResolvedValue({
      id: 'usr_2',
      wallet: { type: 'internal', address: OTHER_ADDRESS },
    });

    const wallets = await service.provisionBothNetworks(INPUT);

    expect(wallets).toEqual([
      { network: 'testnet', status: 'ready', address: ADDRESS },
      { network: 'public', status: 'ready', address: OTHER_ADDRESS },
    ]);
    // A testnet login must register on mainnet, not on itself.
    expect(pollar.server).toHaveBeenCalledTimes(1);
    expect(pollar.server.mock.calls[0].slice(0, 3)).toEqual([
      'POST',
      'public',
      '/users/with-wallet',
    ]);
    expect(row(table, 'public')).toMatchObject({
      status: 'READY',
      address: OTHER_ADDRESS,
      pollarUserId: 'usr_2',
    });
  });

  it('registers under the OAuth email, which is what links the two networks', async () => {
    const { service, pollar } = build();
    pollar.server.mockResolvedValue({});

    await service.provisionBothNetworks(INPUT);

    // Anything else here provisions a wallet no future hosted login on that
    // network resolves to.
    expect(pollar.server.mock.calls[0][3].body).toMatchObject({
      externalId: 'ada@example.com',
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
  });

  it('leaves the counterpart pending instead of failing the login', async () => {
    const { service, table, pollar } = build();
    pollar.server.mockRejectedValue(
      new PollarApiError(503, 'MISCONFIGURED', 'no key for this network'),
    );

    const wallets = await service.provisionBothNetworks(INPUT);

    // The whole contract: the login already succeeded, so this resolves.
    expect(wallets[0]).toMatchObject({ network: 'testnet', status: 'ready' });
    expect(wallets[1]).toEqual({
      network: 'public',
      status: 'pending',
      address: null,
    });
    expect(row(table, 'public')).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      errorCode: 'MISCONFIGURED',
    });
    // Scheduled, so the sweeper picks it up rather than hammering Pollar.
    expect(row(table, 'public').nextAttemptAt).toBeInstanceOf(Date);
  });

  it('never rejects, whatever the provider does', async () => {
    const { service, pollar } = build();
    pollar.server.mockRejectedValue(new Error('socket hang up'));

    await expect(service.provisionBothNetworks(INPUT)).resolves.toHaveLength(2);
  });

  it('survives the bookkeeping itself failing', async () => {
    const { service, table, pollar } = build();
    pollar.server.mockResolvedValue({});
    table.upsert.mockRejectedValue(new Error('db down'));

    const wallets = await service.provisionBothNetworks(INPUT);

    // The primary entry still comes off the login payload, which is the only
    // part the caller actually needs.
    expect(wallets[0]).toMatchObject({ network: 'testnet', status: 'ready' });
    expect(wallets[1]).toMatchObject({ network: 'public', status: 'pending' });
  });

  it('skips the counterpart when the provider vouched for no email', async () => {
    const { service, pollar } = build();

    const wallets = await service.provisionBothNetworks({
      ...INPUT,
      externalId: null,
    });

    // Without the join key a second wallet is an orphan that costs XLM and no
    // login ever reaches.
    expect(wallets).toEqual([
      { network: 'testnet', status: 'ready', address: ADDRESS },
    ]);
    expect(pollar.server).not.toHaveBeenCalled();
  });

  it('reports a deferred-funding primary wallet as pending, not ready', async () => {
    const { service, table, pollar } = build();
    pollar.server.mockResolvedValue({});

    const wallets = await service.provisionBothNetworks({
      ...INPUT,
      wallet: { type: 'internal' as const, address: null },
    });

    expect(wallets[0]).toEqual({
      network: 'testnet',
      status: 'pending',
      address: null,
    });
    expect(row(table, 'testnet').status).toBe('PENDING');
  });

  it('does not let a later address-less login erase a known wallet', async () => {
    const { service, table, pollar } = build();
    pollar.server.mockResolvedValue({});

    await service.provisionBothNetworks(INPUT);
    // Pollar answered without a wallet this time. The wallet did not stop
    // existing; this response just did not carry it.
    await service.provisionBothNetworks({
      ...INPUT,
      wallet: { type: 'internal' as const, address: null },
    });

    expect(row(table, 'testnet')).toMatchObject({
      status: 'READY',
      address: ADDRESS,
    });
  });

  it('does not re-register a network that is already ready', async () => {
    const { service, pollar } = build();
    pollar.server.mockResolvedValue({
      wallet: { type: 'internal', address: OTHER_ADDRESS },
    });

    await service.provisionBothNetworks(INPUT);
    await service.provisionBothNetworks(INPUT);

    // The second login upserts through the same unique key and finds READY.
    expect(pollar.server).toHaveBeenCalledTimes(1);
  });

  it('treats "already exists" as the outcome it wanted', async () => {
    const { service, table, pollar } = build();
    pollar.server.mockRejectedValue(
      new PollarApiError(409, 'USER_ALREADY_EXISTS', 'taken'),
    );

    const wallets = await service.provisionBothNetworks(INPUT);

    expect(wallets[1]).toMatchObject({ network: 'public', status: 'ready' });
    expect(row(table, 'public')).toMatchObject({
      status: 'READY',
      errorCode: null,
    });
  });
});

describe('attempt', () => {
  it('gives up for good once the budget is spent', async () => {
    const { service, table, pollar } = build();
    pollar.server.mockRejectedValue(
      new PollarApiError(500, 'PROVIDER_DOWN', 'nope'),
    );
    const pending = {
      id: 'w1',
      consumerId: 'c1',
      externalId: 'ada@example.com',
      network: 'public',
      status: 'PENDING',
      attempts: POLLAR_WALLET_PROVISION_MAX_ATTEMPTS - 1,
      address: null,
      walletType: null,
      pollarUserId: null,
      errorCode: null,
      nextAttemptAt: null,
    };
    table.rows.push(pending);

    const exhausted = await service.attempt(pending as any);

    // Ten refusals is a configuration problem, and asking again every minute
    // forever only spends requests to log the same line.
    expect(exhausted).toMatchObject({
      status: 'FAILED',
      attempts: POLLAR_WALLET_PROVISION_MAX_ATTEMPTS,
      nextAttemptAt: null,
    });
  });

  it('bounds the call so a slow provider cannot stall a login', async () => {
    const { service, pollar } = build();
    pollar.server.mockResolvedValue({});

    await service.provisionBothNetworks(INPUT);

    expect(pollar.server.mock.calls[0][3].timeoutMs).toBeGreaterThan(0);
  });
});
