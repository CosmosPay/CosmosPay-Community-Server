import { BlindpayOnrampApi } from '@/blindpay/blindpay-onramp.api';
import { VIRTUAL_ACCOUNT_PUBLIC_SELECT } from '@/blindpay/blindpay-sync.service';
import { ApiErrorCode } from '@/common/errors/api-error';
import { ReceiversService } from '@/kyc/receivers/receivers.service';
import { VirtualAccountsService } from '@/onramp/virtual-accounts/virtual-accounts.service';

const CONSUMER = { username: 'cosmos_u1' } as any;

/** Straight out of the provider payload — must never reach a response. */
const ACCOUNT_NUMBER = '000123456789';

/** BlindPay's create response, whole: the account's bank details and its holder. */
const PROVIDER_VIRTUAL_ACCOUNT = {
  id: 'va_000000000001',
  token: 'USDC',
  blockchain_wallet_id: 'bw_000000000001',
  kyc_status: 'approved',
  us: { ach: { routing_number: '021000021', account_number: ACCOUNT_NUMBER } },
  account_holder: { name: 'Ada Lovelace', address: '1 Analytical Way' },
};

/** What Prisma answers for a `select`: those columns only, or the whole row. */
function project(
  row: Record<string, unknown>,
  select?: Record<string, boolean>,
): Record<string, unknown> {
  if (!select) return row;
  return Object.fromEntries(
    Object.keys(select)
      .filter((key) => select[key])
      .map((key) => [key, row[key]]),
  );
}

function makeService(
  opts: { receiverDisabled?: boolean; walletOwnerDisabled?: boolean } = {},
) {
  const prisma: any = {
    blindpayBlockchainWallet: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'bw_local',
        blindpayId: 'bw_000000000001',
        receiverId: 'rcv_wallet_owner',
      }),
    },
    blindpayReceiver: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ disabled: Boolean(opts.walletOwnerDisabled) }),
    },
    blindpayVirtualAccount: {
      // Stored whole, as PostgreSQL would hold it, and read back through
      // whatever `select` the service asked for.
      upsert: jest.fn(({ create, select }: any) =>
        Promise.resolve(
          project(
            {
              id: 'va_local',
              createdAt: new Date(),
              updatedAt: new Date(),
              ...create,
            },
            select,
          ),
        ),
      ),
    },
  };
  const blindpay = {
    post: jest.fn().mockResolvedValue(PROVIDER_VIRTUAL_ACCOUNT),
    instancePath: jest.fn((p: string) => `/instances/in_test${p}`),
    environmentFor: jest.fn(() => 'prod'),
    instance: jest.fn(),
  };
  blindpay.instance.mockReturnValue(blindpay);
  const consumers = { resolve: jest.fn().mockResolvedValue({ id: 'c1' }) };
  const receivers = {
    findReceiverOrThrow: jest.fn().mockResolvedValue({
      id: 'rcv_local',
      blindpayId: 're_000000000001',
      disabled: Boolean(opts.receiverDisabled),
    }),
    // The real rule, so the spec tests the kill switch rather than a stub of it.
    assertEnabled: ReceiversService.prototype.assertEnabled,
  };
  const service = new VirtualAccountsService(
    prisma,
    new BlindpayOnrampApi(blindpay as any),
    consumers as any,
    receivers as any,
  );
  return { service, prisma, blindpay };
}

describe('VirtualAccountsService kill switch', () => {
  it('refuses a disabled receiver before anything reaches BlindPay', async () => {
    const { service, blindpay } = makeService({ receiverDisabled: true });

    await expect(
      service.create(CONSUMER, 'rcv_local', {
        blockchain_wallet_id: 'bw_local',
      } as any),
    ).rejects.toMatchObject({ code: ApiErrorCode.AccountDisabled });
    expect(blindpay.post).not.toHaveBeenCalled();
  });

  it('refuses a destination wallet whose own receiver is disabled', async () => {
    const { service, blindpay } = makeService({ walletOwnerDisabled: true });

    await expect(
      service.create(CONSUMER, 'rcv_local', {
        blockchain_wallet_id: 'bw_local',
      } as any),
    ).rejects.toMatchObject({ code: ApiErrorCode.AccountDisabled });
    expect(blindpay.post).not.toHaveBeenCalled();
  });
});

describe('VirtualAccountsService.create', () => {
  it('returns the public projection, not the provider payload it mirrored', async () => {
    const { service, prisma } = makeService();

    const created = await service.create(CONSUMER, 'rcv_local', {
      blockchain_wallet_id: 'bw_local',
    } as any);

    expect(Object.keys(created).sort()).toEqual(
      Object.keys(VIRTUAL_ACCOUNT_PUBLIC_SELECT).sort(),
    );
    expect(created).not.toHaveProperty('raw');
    expect(JSON.stringify(created)).not.toContain(ACCOUNT_NUMBER);
    // The blob is still mirrored; it is only the response that must not carry it.
    expect(
      prisma.blindpayVirtualAccount.upsert.mock.calls[0][0].create.raw,
    ).toEqual(PROVIDER_VIRTUAL_ACCOUNT);
  });

  it('maps the provider fields onto the public ones', async () => {
    const { service } = makeService();

    await expect(
      service.create(CONSUMER, 'rcv_local', {
        blockchain_wallet_id: 'bw_local',
      } as any),
    ).resolves.toMatchObject({
      blindpayId: 'va_000000000001',
      blockchainWalletId: 'bw_000000000001',
      token: 'USDC',
      status: 'approved',
    });
  });
});
