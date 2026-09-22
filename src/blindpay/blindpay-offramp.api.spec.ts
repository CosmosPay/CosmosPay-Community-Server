import { BlindpayOfframpApi } from '@/blindpay/blindpay-offramp.api';
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
  const api = new BlindpayOfframpApi(client as unknown as BlindpayClient);
  return { api, client };
}

describe('BlindpayOfframpApi', () => {
  it('prices a payout quote on the named instance', async () => {
    const { api, client } = makeApi();
    const body = { bank_account_id: 'ba_1', request_amount: 1000 };

    await api.createPayoutQuote('dev', body);

    expect(client.instance).toHaveBeenCalledWith('dev');
    expect(client.post).toHaveBeenCalledWith('/instances/in_test/quotes', body);
  });

  it('authorizes on the chain-specific sub-route', async () => {
    const { api, client } = makeApi();
    const body = { quote_id: 'qe_1', sender_wallet_address: 'GABC' };

    await api.authorizePayout('prod', 'stellar', body);

    expect(client.post).toHaveBeenCalledWith(
      '/instances/in_test/payouts/stellar/authorize',
      body,
    );
  });

  it('executes on the chain-specific route, body passed through', async () => {
    const { api, client } = makeApi();
    const body = {
      quote_id: 'qe_1',
      sender_wallet_address: 'GABC',
      signed_transaction: 'AAAA',
    };

    await api.createPayout('prod', 'solana', body, '48b581d5-a18d-41a7-a3ff-ccfa8f8499fd');

    expect(client.post).toHaveBeenCalledWith(
      '/instances/in_test/payouts/solana',
      body,
      { headers: { 'Idempotency-Key': '48b581d5-a18d-41a7-a3ff-ccfa8f8499fd' } },
    );
  });

  it('reads a payout by its BlindPay id', async () => {
    const { api, client } = makeApi();
    const provider = { id: 'pa_1', status: 'completed' };
    client.get.mockResolvedValue(provider);

    await expect(api.getPayout('prod', 'pa_1')).resolves.toBe(provider);
    expect(client.get).toHaveBeenCalledWith('/instances/in_test/payouts/pa_1');
  });

  it('attaches a compliance document to a payout', async () => {
    const { api, client } = makeApi();

    await api.addPayoutDocument('prod', 'pa_1', { type: 'invoice' });

    expect(client.post).toHaveBeenCalledWith(
      '/instances/in_test/payouts/pa_1/documents',
      { type: 'invoice' },
    );
  });
});
