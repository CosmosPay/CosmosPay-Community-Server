import { ConfigService } from '@nestjs/config';
import { Networks, rpc, type Transaction } from '@stellar/stellar-sdk';
import { SorobanRpcClient } from '@/stellar/soroban-rpc.client';

describe('SorobanRpcClient', () => {
  const config = {
    get: () => ({ mainnetRpcUrl: 'https://rpc.example' }),
  } as unknown as ConfigService<any, true>;

  let getNetwork: jest.SpyInstance;
  let getTransaction: jest.SpyInstance;

  beforeEach(() => {
    getNetwork = jest
      .spyOn(rpc.Server.prototype, 'getNetwork')
      .mockResolvedValue({ passphrase: Networks.PUBLIC } as never);
    getTransaction = jest
      .spyOn(rpc.Server.prototype, 'getTransaction')
      .mockResolvedValue({ status: 'NOT_FOUND' } as never);
  });
  afterEach(() => jest.restoreAllMocks());

  it('checks the node serves mainnet once, then answers', async () => {
    const client = new SorobanRpcClient(config);
    await client.getTransaction('ab');
    await client.getTransaction('cd');
    expect(getNetwork).toHaveBeenCalledTimes(1);
    expect(getTransaction).toHaveBeenCalledTimes(2);
    expect(client.passphrase).toBe(Networks.PUBLIC);
  });

  it('refuses a node on another network (503 misconfigured), and asks again next time', async () => {
    getNetwork.mockResolvedValueOnce({ passphrase: Networks.TESTNET });
    const client = new SorobanRpcClient(config);
    await expect(client.getTransaction('ab')).rejects.toMatchObject({
      code: 'misconfigured',
      status: 503,
    });
    expect(getTransaction).not.toHaveBeenCalled();
    await expect(client.getTransaction('ab')).resolves.toBeDefined();
    expect(getNetwork).toHaveBeenCalledTimes(2);
  });

  it('turns a transport failure into 503 provider_unavailable', async () => {
    jest
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockRejectedValue(new Error('socket hang up'));
    const client = new SorobanRpcClient(config);
    await expect(client.simulate({} as Transaction)).rejects.toMatchObject({
      code: 'provider_unavailable',
      status: 503,
    });
  });

  it('returns what the node answers, a refusal included', async () => {
    jest
      .spyOn(rpc.Server.prototype, 'sendTransaction')
      .mockResolvedValue({ status: 'ERROR', hash: 'ab' } as never);
    const client = new SorobanRpcClient(config);
    await expect(client.send({} as Transaction)).resolves.toMatchObject({
      status: 'ERROR',
    });
  });
});
