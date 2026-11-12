import { createSign, generateKeyPairSync } from 'node:crypto';
import { ApiErrorCode } from '@/common/errors/api-error';
import type { EldoradoClient } from '@/native-plugins/eldorado/eldorado.client';
import { P2pWebhookKeys } from '@/native-plugins/eldorado/p2p-webhook-keys.service';
import { webhookBodyHash } from '@/native-plugins/eldorado/p2p-webhook-signature';

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  return { privateKey, jwk: publicKey.export({ format: 'jwk' }) };
}

function signed(privateKey: ReturnType<typeof keyPair>['privateKey']) {
  const hash = webhookBodyHash(Buffer.from('{"order":{}}'));
  return {
    hash,
    signature: createSign('RSA-SHA256').update(hash).sign(privateKey, 'base64'),
  };
}

/** Stops the clock for `Date` alone, so the once-a-minute rule can be walked through. */
function freezeDate(at: number) {
  jest.useFakeTimers({
    now: at,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
}

describe('P2pWebhookKeys', () => {
  const mainnet = keyPair();
  const sandbox = keyPair();
  const rotated = keyPair();
  const stranger = keyPair();

  /** A JWKS stub per network: no test reaches the marketplace. */
  function setup(sets: Record<string, unknown[] | Error>) {
    const client = {
      webhookKeys: jest.fn((network: string) => {
        const set = sets[network];
        return set instanceof Error
          ? Promise.reject(set)
          : Promise.resolve({ keys: set });
      }),
    };
    return {
      keys: new P2pWebhookKeys(client as unknown as EldoradoClient),
      client,
    };
  }

  afterEach(() => jest.useRealTimers());

  it('says which network’s key signed a delivery, reading each set once', async () => {
    const { keys, client } = setup({
      public: [mainnet.jwk],
      testnet: [sandbox.jwk],
    });
    const fromMainnet = signed(mainnet.privateKey);
    const fromSandbox = signed(sandbox.privateKey);

    await expect(
      keys.signer(fromMainnet.hash, fromMainnet.signature),
    ).resolves.toBe('public');
    await expect(
      keys.signer(fromSandbox.hash, fromSandbox.signature),
    ).resolves.toBe('testnet');
    await expect(
      keys.signer(fromMainnet.hash, fromMainnet.signature),
    ).resolves.toBe('public');

    expect(client.webhookKeys.mock.calls).toEqual([['public'], ['testnet']]);
  });

  it('refuses a signature no published key made, reading the keys again at most once a minute', async () => {
    const start = Date.parse('2026-11-12T12:00:00.000Z');
    freezeDate(start);
    const { keys, client } = setup({
      public: [mainnet.jwk],
      testnet: [sandbox.jwk],
    });
    const forged = signed(stranger.privateKey);

    await expect(keys.signer(forged.hash, forged.signature)).resolves.toBe(
      null,
    );
    await expect(keys.signer(forged.hash, forged.signature)).resolves.toBe(
      null,
    );
    expect(client.webhookKeys).toHaveBeenCalledTimes(2);

    jest.setSystemTime(start + 61_000);
    await expect(keys.signer(forged.hash, forged.signature)).resolves.toBe(
      null,
    );
    expect(client.webhookKeys).toHaveBeenCalledTimes(4);
  });

  it('picks up a rotated key once a minute has passed', async () => {
    const start = Date.parse('2026-11-12T12:00:00.000Z');
    freezeDate(start);
    const sets: Record<string, unknown[]> = {
      public: [mainnet.jwk],
      testnet: [sandbox.jwk],
    };
    const { keys } = setup(sets);
    const old = signed(mainnet.privateKey);
    await expect(keys.signer(old.hash, old.signature)).resolves.toBe('public');

    sets.public = [rotated.jwk, mainnet.jwk];
    const fresh = signed(rotated.privateKey);
    // Read a moment ago: not read again yet.
    await expect(keys.signer(fresh.hash, fresh.signature)).resolves.toBe(null);

    jest.setSystemTime(start + 61_000);
    await expect(keys.signer(fresh.hash, fresh.signature)).resolves.toBe(
      'public',
    );
  });

  it('answers 503 when a set could not be read and no key on hand verifies', async () => {
    const { keys } = setup({
      public: new Error('socket hang up'),
      testnet: [sandbox.jwk],
    });
    const fromMainnet = signed(mainnet.privateKey);
    const fromSandbox = signed(sandbox.privateKey);

    await expect(
      keys.signer(fromMainnet.hash, fromMainnet.signature),
    ).rejects.toMatchObject({ code: ApiErrorCode.ProviderUnavailable });
    // The set that did load still verifies its own deliveries.
    await expect(
      keys.signer(fromSandbox.hash, fromSandbox.signature),
    ).resolves.toBe('testnet');
  });

  it('treats a set with no usable RSA key as unread', async () => {
    const { keys } = setup({
      public: [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }],
      testnet: [sandbox.jwk],
    });
    const fromMainnet = signed(mainnet.privateKey);

    await expect(
      keys.signer(fromMainnet.hash, fromMainnet.signature),
    ).rejects.toMatchObject({ code: ApiErrorCode.ProviderUnavailable });
  });
});
