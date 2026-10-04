import { PluginViolationError } from '@/plugins/plugin-errors';
import { PluginHttpClient } from '@/plugins/plugin-http.client';
import { PluginError } from '@/plugins/sdk';

describe('PluginHttpClient', () => {
  function build(addresses: string[] = ['93.184.216.34']) {
    const client = new PluginHttpClient();
    client.replaceDnsLookup(() => Promise.resolve(addresses));
    const send = jest.spyOn(client, 'send').mockResolvedValue({
      status: 200,
      headers: {},
      body: '{}',
      json: () => ({}),
    });
    return { http: client.forPlugin('acme', ['api.acme.example']), send };
  }

  it('sends to an allowlisted public host, pinned to the checked address', async () => {
    const { http, send } = build();

    await http.request({
      method: 'POST',
      url: 'https://api.acme.example/v1/sync?x=1',
      body: { a: 1 },
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        body: '{"a":1}',
        headers: { 'content-type': 'application/json' },
        destination: expect.objectContaining({
          hostname: 'api.acme.example',
          address: '93.184.216.34',
        }),
      }),
    );
  });

  it.each([
    ['a host outside the egress list', 'https://evil.example/x'],
    ['plain http', 'http://api.acme.example/x'],
    ['another port', 'https://api.acme.example:8443/x'],
  ])('refuses %s', async (_label, url) => {
    const { http, send } = build();
    await expect(http.request({ method: 'GET', url })).rejects.toBeInstanceOf(
      PluginViolationError,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it.each([['127.0.0.1'], ['10.0.0.8'], ['169.254.169.254']])(
    'refuses an allowlisted host that resolves to %s',
    async (address) => {
      const { http, send } = build([address]);
      await expect(
        http.request({ method: 'GET', url: 'https://api.acme.example/' }),
      ).rejects.toBeInstanceOf(PluginViolationError);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('refuses headers the transport owns, and header injection', async () => {
    const { http } = build();
    const url = 'https://api.acme.example/';
    await expect(
      http.request({ method: 'GET', url, headers: { Host: 'evil.example' } }),
    ).rejects.toBeInstanceOf(PluginError);
    await expect(
      http.request({ method: 'GET', url, headers: { 'x-a': 'b\r\nx-b: c' } }),
    ).rejects.toBeInstanceOf(PluginError);
  });
});
