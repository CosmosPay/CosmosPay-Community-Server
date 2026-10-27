import { LayerZeroScanClient } from '@/usdt0/layerzero-scan.client';

describe('LayerZeroScanClient', () => {
  const fetchMock = jest.fn();
  const realFetch = global.fetch;

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });
  afterAll(() => {
    global.fetch = realFetch;
  });

  const answer = (status: number, body: unknown) =>
    fetchMock.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(JSON.stringify(body)),
    });

  it('looks a message up by guid at the public API', async () => {
    answer(200, { data: [{ guid: '0xab' }] });
    const client = new LayerZeroScanClient();
    await expect(client.byGuid('0xab')).resolves.toEqual({
      data: [{ guid: '0xab' }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://scan.layerzero-api.com/v1/messages/guid/0xab',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('looks messages up by the Stellar transaction hash, as Scan stores it', async () => {
    answer(200, { data: [] });
    await new LayerZeroScanClient().byTransaction('cd'.repeat(32));
    expect(fetchMock).toHaveBeenCalledWith(
      `https://scan.layerzero-api.com/v1/messages/tx/${'cd'.repeat(32)}`,
      expect.anything(),
    );
  });

  it('answers null when Scan has not indexed the message yet (404)', async () => {
    answer(404, { message: 'Message not found', code: 4040 });
    await expect(new LayerZeroScanClient().byGuid('0xab')).resolves.toBeNull();
  });

  it('throws on any other failure, for the caller to absorb', async () => {
    answer(500, { message: 'boom' });
    await expect(
      new LayerZeroScanClient().byGuid('0xab'),
    ).rejects.toMatchObject({
      code: 'provider_error',
    });
  });
});
