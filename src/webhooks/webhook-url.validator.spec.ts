import {
  assertPublicWebhookUrl,
  WebhookUrlValidationError,
} from '@/webhooks/webhook-url.validator';

describe('assertPublicWebhookUrl', () => {
  const publicLookup = jest.fn(async () => ['93.184.216.34']); // example.com

  beforeEach(() => {
    publicLookup.mockReset();
    publicLookup.mockResolvedValue(['93.184.216.34']);
  });

  /** The refusal `promise` produced, so message and detail can both be read. */
  async function refusal(
    promise: Promise<unknown>,
  ): Promise<WebhookUrlValidationError> {
    try {
      await promise;
    } catch (err) {
      return err as WebhookUrlValidationError;
    }
    throw new Error('expected the destination to be refused');
  }

  /**
   * Asserts a host-dependent refusal: the caller is told only that the host is
   * not allowed, and the reason is on `detail`, for the log.
   */
  async function refusedFor(
    promise: Promise<unknown>,
    reason: RegExp,
  ): Promise<void> {
    const err = await refusal(promise);
    expect(err).toBeInstanceOf(WebhookUrlValidationError);
    expect(err.message).toMatch(/host is not an allowed destination/i);
    expect(err.detail).toMatch(reason);
  }

  it('allows https URLs that resolve to a public address', async () => {
    await expect(
      assertPublicWebhookUrl(
        'https://integrator.example.com/hooks',
        publicLookup,
      ),
    ).resolves.toEqual({
      hostname: 'integrator.example.com',
      port: 443,
      address: '93.184.216.34',
      family: 4,
    });
    expect(publicLookup).toHaveBeenCalledWith('integrator.example.com');
  });

  it('returns the checked address so delivery can pin the connection', async () => {
    // The caller must connect to *this* address. Handing the hostname back to
    // a second resolution is the rebinding hole the check exists to close.
    const lookup = jest.fn(async () => ['93.184.216.34', '2606:2800:220::1']);
    await expect(
      assertPublicWebhookUrl('https://dual.example.com:8443/hooks', lookup),
    ).resolves.toEqual({
      hostname: 'dual.example.com',
      port: 8443,
      address: '93.184.216.34',
      family: 4,
    });
  });

  it('pins a literal IPv6 destination to itself', async () => {
    await expect(
      assertPublicWebhookUrl('https://[2606:2800:220::1]/hooks', publicLookup),
    ).resolves.toEqual({
      hostname: '2606:2800:220::1',
      port: 443,
      address: '2606:2800:220::1',
      family: 6,
    });
    expect(publicLookup).not.toHaveBeenCalled();
  });

  it('rejects non-https schemes', async () => {
    await expect(
      assertPublicWebhookUrl(
        'http://integrator.example.com/hooks',
        publicLookup,
      ),
    ).rejects.toThrow(WebhookUrlValidationError);
    await expect(
      assertPublicWebhookUrl(
        'http://integrator.example.com/hooks',
        publicLookup,
      ),
    ).rejects.toThrow(/https scheme/i);
    expect(publicLookup).not.toHaveBeenCalled();
  });

  it('rejects loopback destinations (literal IP)', async () => {
    await refusedFor(
      assertPublicWebhookUrl('https://127.0.0.1/hooks', publicLookup),
      /loopback/i,
    );
    await refusedFor(
      assertPublicWebhookUrl('https://[::1]/hooks', publicLookup),
      /loopback/i,
    );
    expect(publicLookup).not.toHaveBeenCalled();
  });

  it('rejects private-range destinations', async () => {
    for (const url of [
      'https://10.0.0.5/hooks',
      'https://172.16.1.1/hooks',
      'https://192.168.1.10/hooks',
    ]) {
      await refusedFor(
        assertPublicWebhookUrl(url, publicLookup),
        /private address/i,
      );
    }
    expect(publicLookup).not.toHaveBeenCalled();
  });

  it('rejects link-local destinations', async () => {
    await refusedFor(
      assertPublicWebhookUrl('https://169.254.1.1/hooks', publicLookup),
      /link-local|cloud-metadata/i,
    );
    expect(publicLookup).not.toHaveBeenCalled();
  });

  it('rejects cloud metadata host and address', async () => {
    await refusedFor(
      assertPublicWebhookUrl(
        'https://169.254.169.254/latest/meta-data',
        publicLookup,
      ),
      /link-local|cloud-metadata/i,
    );
    await refusedFor(
      assertPublicWebhookUrl(
        'https://metadata.google.internal/computeMetadata/v1/',
        publicLookup,
      ),
      /cloud metadata/i,
    );
    expect(publicLookup).not.toHaveBeenCalled();
  });

  it('rejects IETF protocol assignments 192.0.0.0/24', async () => {
    await refusedFor(
      assertPublicWebhookUrl('https://192.0.0.1/hooks', publicLookup),
      /reserved/i,
    );
    // The neighbouring documentation range 192.0.2.0/24 is not in the /24.
    await expect(
      assertPublicWebhookUrl('https://192.1.0.1/hooks', publicLookup),
    ).resolves.toMatchObject({ address: '192.1.0.1' });
  });

  it('rejects the benchmarking range 198.18.0.0/15', async () => {
    await refusedFor(
      assertPublicWebhookUrl('https://198.18.0.1/hooks', publicLookup),
      /benchmarking/i,
    );
    await refusedFor(
      assertPublicWebhookUrl('https://198.19.255.254/hooks', publicLookup),
      /benchmarking/i,
    );
    await expect(
      assertPublicWebhookUrl('https://198.20.0.1/hooks', publicLookup),
    ).resolves.toMatchObject({ address: '198.20.0.1' });
  });

  it('rejects 6to4 (2002::/16), which embeds an IPv4 destination', async () => {
    // 2002:a9fe:a9fe:: is 169.254.169.254 wearing an IPv6 hat.
    await refusedFor(
      assertPublicWebhookUrl('https://[2002:a9fe:a9fe::1]/hooks', publicLookup),
      /6to4/i,
    );
    await refusedFor(
      assertPublicWebhookUrl('https://evil.example.com/hooks', async () => [
        '2002:0a00:0001::1',
      ]),
      /6to4/i,
    );
  });

  it('rejects NAT64 (64:ff9b::/32), which translates to IPv4', async () => {
    await refusedFor(
      assertPublicWebhookUrl(
        'https://[64:ff9b::a9fe:a9fe]/hooks',
        publicLookup,
      ),
      /NAT64/i,
    );
    // Local-use NAT64 prefix 64:ff9b:1::/48 too.
    await refusedFor(
      assertPublicWebhookUrl('https://[64:ff9b:1::1]/hooks', publicLookup),
      /NAT64/i,
    );
  });

  it('rejects when DNS resolves to a blocked address (hostname path)', async () => {
    const lookup = jest.fn(async () => ['10.1.2.3']);
    await refusedFor(
      assertPublicWebhookUrl('https://evil.example.com/hooks', lookup),
      /private address/i,
    );
  });

  it('rejects when any of multiple DNS answers is blocked', async () => {
    const lookup = jest.fn(async () => ['93.184.216.34', '127.0.0.1']);
    await refusedFor(
      assertPublicWebhookUrl('https://dual.example.com/hooks', lookup),
      /loopback/i,
    );
  });

  it('rejects credentials in the URL', async () => {
    await expect(
      assertPublicWebhookUrl(
        'https://user:pass@integrator.example.com/hooks',
        publicLookup,
      ),
    ).rejects.toThrow(/credentials/i);
  });

  it('answers every host-dependent refusal with one indistinguishable message', async () => {
    // The point of the collapse: a caller POSTing endpoints must not be able to
    // tell "this name does not resolve here" from "it resolves to 10.0.4.7"
    // from "it resolves to the metadata service". Each answer is a fact about
    // the network this process runs in, and asking is free.
    const refused = await Promise.all(
      [
        assertPublicWebhookUrl('https://redis.internal/hooks', async () => {
          throw new Error('ENOTFOUND');
        }),
        assertPublicWebhookUrl('https://db.internal/hooks', async () => [
          '10.0.4.7',
        ]),
        assertPublicWebhookUrl('https://meta.internal/hooks', async () => [
          '169.254.169.254',
        ]),
        assertPublicWebhookUrl('https://empty.internal/hooks', async () => []),
        assertPublicWebhookUrl(
          'https://metadata.google.internal/hooks',
          publicLookup,
        ),
      ].map((promise) => refusal(promise)),
    );

    expect(new Set(refused.map((err) => err.message)).size).toBe(1);
    for (const err of refused) {
      expect(err.message).not.toMatch(
        /resolved? to|could not be resolved|no addresses|10[.]0[.]4[.]7|169[.]254/i,
      );
      // The reason survives for the operator's log.
      expect(err.detail).toBeTruthy();
    }
    expect(new Set(refused.map((err) => err.detail)).size).toBe(refused.length);
  });
});
