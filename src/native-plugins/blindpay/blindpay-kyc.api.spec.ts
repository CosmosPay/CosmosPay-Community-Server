import { BlindpayKycApi } from '@/blindpay/blindpay-kyc.api';
import { BlindpayClient } from '@/blindpay/blindpay.client';

/**
 * The client is mocked with the real `instancePath` rule, so every assertion here
 * is the exact method, path, body and options BlindPay receives — the contract the
 * feature services relied on when they built these paths themselves. `instance`
 * hands back the same mock for either environment; which one was asked for is
 * asserted where it matters.
 */
function makeApi() {
  const client = {
    instanceId: 'in_test',
    instancePath: jest.fn((p: string) => `/instances/in_test${p}`),
    get: jest.fn().mockResolvedValue({ ok: true }),
    post: jest.fn().mockResolvedValue({ ok: true }),
    put: jest.fn().mockResolvedValue({ ok: true }),
    delete: jest.fn().mockResolvedValue(undefined),
    uploadFile: jest.fn().mockResolvedValue({ file_url: 'https://files/x' }),
    instance: jest.fn(),
    environmentFor: jest.fn().mockReturnValue('dev'),
  };
  client.instance.mockReturnValue(client);
  const api = new BlindpayKycApi(client as unknown as BlindpayClient);
  return { api, client };
}

describe('BlindpayKycApi', () => {
  it('sends each call to the instance its environment names', async () => {
    const { api, client } = makeApi();

    await api.getReceiver('dev', 're_1');
    await api.deleteReceiver('prod', 're_2');

    expect(client.instance).toHaveBeenNthCalledWith(1, 'dev');
    expect(client.instance).toHaveBeenNthCalledWith(2, 'prod');
  });

  it("resolves a caller's environment through the client", () => {
    const { api, client } = makeApi();
    const consumer = { username: 'cosmos_u1', environment: 'dev' } as any;

    expect(api.environmentFor(consumer)).toBe('dev');
    expect(client.environmentFor).toHaveBeenCalledWith(consumer);
  });

  it('requests ToS outside the instance path, body passed through', async () => {
    const { api, client } = makeApi();
    client.post.mockResolvedValue({ url: 'https://tos.example/accept' });
    const body = {
      idempotency_key: 'idem_1',
      receiver_id: null,
      redirect_url: 'https://app.example.com/cb',
    };

    await expect(api.requestTos('prod', body)).resolves.toEqual({
      url: 'https://tos.example/accept',
    });
    expect(client.post).toHaveBeenCalledWith('/e/instances/in_test/tos', body);
    expect(client.instancePath).not.toHaveBeenCalled();
  });

  it('creates a receiver under /customers', async () => {
    const { api, client } = makeApi();

    await api.createReceiver('prod', { email: 'a@b.com', tos_id: 'tos_1' });

    expect(client.post).toHaveBeenCalledWith('/instances/in_test/customers', {
      email: 'a@b.com',
      tos_id: 'tos_1',
    });
  });

  it('reads, updates and deletes a receiver by its BlindPay id', async () => {
    const { api, client } = makeApi();

    await api.getReceiver('prod', 're_1');
    await api.updateReceiver('prod', 're_1', { email: 'new@b.com' });
    await api.deleteReceiver('prod', 're_1');

    expect(client.get).toHaveBeenCalledWith(
      '/instances/in_test/customers/re_1',
    );
    expect(client.put).toHaveBeenCalledWith(
      '/instances/in_test/customers/re_1',
      { email: 'new@b.com' },
    );
    expect(client.delete).toHaveBeenCalledWith(
      '/instances/in_test/customers/re_1',
    );
  });

  it('nests blockchain wallets under the receiver', async () => {
    const { api, client } = makeApi();

    await api.createBlockchainWallet('prod', 're_1', { network: 'stellar' });
    await api.getWalletSignMessage('prod', 're_1');
    await api.deleteBlockchainWallet('prod', 're_1', 'bw_1');

    expect(client.post).toHaveBeenCalledWith(
      '/instances/in_test/customers/re_1/blockchain-wallets',
      { network: 'stellar' },
    );
    expect(client.get).toHaveBeenCalledWith(
      '/instances/in_test/customers/re_1/blockchain-wallets/sign-message',
    );
    expect(client.delete).toHaveBeenCalledWith(
      '/instances/in_test/customers/re_1/blockchain-wallets/bw_1',
    );
  });

  it('nests bank accounts under the receiver', async () => {
    const { api, client } = makeApi();

    await api.createBankAccount('prod', 're_1', { type: 'ach' });
    await api.deleteBankAccount('prod', 're_1', 'ba_1');

    expect(client.post).toHaveBeenCalledWith(
      '/instances/in_test/customers/re_1/bank-accounts',
      { type: 'ach' },
    );
    expect(client.delete).toHaveBeenCalledWith(
      '/instances/in_test/customers/re_1/bank-accounts/ba_1',
    );
  });

  it('delegates document upload to the multipart client call', async () => {
    const { api, client } = makeApi();
    const file = {
      buffer: Buffer.from('%PDF-1.7'),
      originalname: 'doc.pdf',
      mimetype: 'application/pdf',
    };

    await expect(api.uploadFile('prod', file, 'onboarding')).resolves.toEqual({
      file_url: 'https://files/x',
    });
    expect(client.uploadFile).toHaveBeenCalledWith(file, 'onboarding');
  });

  it('reads the rail catalog outside the instance path', async () => {
    const { api, client } = makeApi();

    await api.listRails('prod');
    await api.getBankDetails('prod', 'ach');

    expect(client.get).toHaveBeenNthCalledWith(1, '/available/rails');
    expect(client.get).toHaveBeenNthCalledWith(2, '/available/bank-details', {
      query: { rail: 'ach' },
    });
    expect(client.instancePath).not.toHaveBeenCalled();
  });

  it('returns the provider response unchanged', async () => {
    const { api, client } = makeApi();
    const provider = { id: 're_1', kyc_status: 'approved' };
    client.get.mockResolvedValue(provider);

    await expect(api.getReceiver('prod', 're_1')).resolves.toBe(provider);
  });
});
