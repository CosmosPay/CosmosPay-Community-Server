import { ConfigService } from '@nestjs/config';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import type { DefindexClient } from '@/native-plugins/defindex/defindex.client';
import { DefindexService } from '@/native-plugins/defindex/defindex.service';
import type { DefindexTransactionsService } from '@/native-plugins/defindex/defindex-transactions.service';

const CALLER = Keypair.random().publicKey();
const VAULT = StrKey.encodeContract(Buffer.alloc(32, 7));
const BUILT = {
  xdr: 'AAAA',
  simulationResponse: {},
  functionName: 'deposit',
  params: [],
};

const prodKey: GatewayConsumer = {
  username: 'cosmos_u1',
  credentialId: null,
  environment: 'prod',
  role: 'user',
  permissions: ['liquidity:write'],
  organizationId: null,
  plan: null,
  planSwapFeeBps: null,
};

function setup() {
  const client = {
    deposit: jest.fn().mockResolvedValue(BUILT),
    withdrawShares: jest.fn().mockResolvedValue(BUILT),
  };
  const transactions = { record: jest.fn().mockResolvedValue(undefined) };
  const config = {
    get: jest.fn(() => ({ network: 'testnet' })),
  } as unknown as ConfigService;
  const service = new DefindexService(
    config as never,
    client as unknown as DefindexClient,
    transactions as unknown as DefindexTransactionsService,
  );
  return { service, client, transactions };
}

describe('DefindexService', () => {
  it('builds a deposit on the key network and records exactly what was asked', async () => {
    const { service, client, transactions } = setup();

    await expect(
      service.deposit(prodKey, VAULT, {
        amounts: ['10000000', '9007199254740991'],
        caller: CALLER,
      }),
    ).resolves.toBe(BUILT);

    expect(client.deposit).toHaveBeenCalledWith('public', VAULT, {
      caller: CALLER,
      amounts: [10_000_000, Number.MAX_SAFE_INTEGER],
      invest: true,
      slippageBps: 100,
    });
    expect(transactions.record).toHaveBeenCalledWith(
      prodKey,
      'public',
      {
        kind: 'deposit',
        vault: VAULT,
        caller: CALLER,
        amounts: [10_000_000n, 9_007_199_254_740_991n],
        invest: true,
      },
      BUILT,
    );
  });

  it('builds a withdrawal and records its shares', async () => {
    const { service, client, transactions } = setup();

    await service.withdraw(prodKey, VAULT, {
      shares: '5000',
      caller: CALLER,
      slippageBps: 50,
    });

    expect(client.withdrawShares).toHaveBeenCalledWith('public', VAULT, {
      caller: CALLER,
      shares: 5000,
      slippageBps: 50,
    });
    expect(transactions.record).toHaveBeenCalledWith(
      prodKey,
      'public',
      { kind: 'withdraw', vault: VAULT, caller: CALLER, shares: 5000n },
      BUILT,
    );
  });

  it('refuses an oversized amount as a 400 before DeFindex is called', async () => {
    const { service, client, transactions } = setup();

    const refused = await service
      .deposit(prodKey, VAULT, {
        amounts: ['9007199254740992'],
        caller: CALLER,
      })
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).getStatus()).toBe(400);
    expect((refused as ApiError).code).toBe(ApiErrorCode.InvalidAmount);
    expect(client.deposit).not.toHaveBeenCalled();
    expect(transactions.record).not.toHaveBeenCalled();
  });

  it('refuses oversized shares as a 400 before DeFindex is called', async () => {
    const { service, client } = setup();

    const refused = await service
      .withdraw(prodKey, VAULT, {
        shares: '18446744073709551616',
        caller: CALLER,
      })
      .catch((error: unknown) => error);

    expect((refused as ApiError).getStatus()).toBe(400);
    expect(client.withdrawShares).not.toHaveBeenCalled();
  });

  it('hands nothing out when the build cannot be recorded', async () => {
    const { service, transactions } = setup();
    transactions.record.mockRejectedValueOnce(
      ApiError.badGateway(
        ApiErrorCode.ProviderError,
        'not the requested deposit',
      ),
    );

    await expect(
      service.deposit(prodKey, VAULT, { amounts: ['1'], caller: CALLER }),
    ).rejects.toMatchObject({ code: ApiErrorCode.ProviderError });
  });
});
