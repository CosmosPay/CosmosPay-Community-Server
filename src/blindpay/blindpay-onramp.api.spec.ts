import { BlindpayOnrampApi } from '@/blindpay/blindpay-onramp.api';
import { BlindpayClient } from '@/blindpay/blindpay.client';

/** The real `instancePath` rule, so each assertion is the request BlindPay gets. */
function makeApi() {
  const client = {
    instanceId: 'in_test',
    instancePath: jest.fn((p: string) => `/instances/in_test${p}`),
    get: jest.fn().mockResolvedValue({ ok: true }),
    post: jest.fn().mockResolvedValue({ ok: true }),
    instance: jest.fn(),
  };
  client.instance.mockReturnValue(client);
  const api = new BlindpayOnrampApi(client as unknown as BlindpayClient);
  return { api, client };
}

describe('BlindpayOnrampApi', () => {
  it('prices a payin quote on the named instance', async () => {
    const { api, client } = makeApi();
    const body = { blockchain_wallet_id: 'bw_1', request_amount: 1000 };

    await api.createPayinQuote('dev', body);

    expect(client.instance).toHaveBeenCalledWith('dev');
    expect(client.post).toHaveBeenCalledWith(
      '/instances/in_test/payin-quotes',
      body,
    );
  });

  it('executes every payin through the single /payins/evm route', async () => {
    const { api, client } = makeApi();

    await api.createPayin('prod', { payin_quote_id: 'pq_1' });

    expect(client.post).toHaveBeenCalledWith('/instances/in_test/payins/evm', {
      payin_quote_id: 'pq_1',
    });
  });

  it('reads a payin by its BlindPay id', async () => {
    const { api, client } = makeApi();
    const provider = { id: 'pi_1', status: 'completed' };
    client.get.mockResolvedValue(provider);

    await expect(api.getPayin('prod', 'pi_1')).resolves.toBe(provider);
    expect(client.get).toHaveBeenCalledWith('/instances/in_test/payins/pi_1');
  });

  it('builds a trustline transaction', async () => {
    const { api, client } = makeApi();

    await api.createAssetTrustline('prod', { address: 'GABC' });

    expect(client.post).toHaveBeenCalledWith(
      '/instances/in_test/create-asset-trustline',
      { address: 'GABC' },
    );
  });

  it('nests virtual accounts under the receiver', async () => {
    const { api, client } = makeApi();

    await api.createVirtualAccount('prod', 're_1', {
      blockchain_wallet_id: 'bw_1',
    });

    expect(client.post).toHaveBeenCalledWith(
      '/instances/in_test/customers/re_1/virtual-accounts',
      { blockchain_wallet_id: 'bw_1' },
    );
  });
});
