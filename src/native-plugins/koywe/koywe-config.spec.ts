import type { AppConfig, KoyweEnvironmentConfig } from '@/config/configuration';
import {
  assertKoyweConfigConsistent,
  isKoyweEnvironmentComplete,
  koyweDelivers,
  pooledMerchantId,
  railNetworks,
} from '@/native-plugins/koywe/koywe-config';

const COMPLETE: KoyweEnvironmentConfig = {
  apiUrl: 'https://api-sandbox.koywe.example',
  apiKey: 'key',
  secret: 'secret',
  organizationId: 'org_1',
  merchantId: '',
  webhookSecret: 'w'.repeat(40),
};
const EMPTY: KoyweEnvironmentConfig = {
  apiUrl: 'https://api.koywe.example',
  apiKey: '',
  secret: '',
  organizationId: '',
  merchantId: '',
  webhookSecret: '',
};

function config(over: Partial<AppConfig['koywe']> = {}): AppConfig['koywe'] {
  return {
    environments: { public: EMPTY, testnet: COMPLETE },
    pooledEnabled: false,
    documentPepper: 'p'.repeat(40),
    accountHolder: '',
    alias: '',
    cvu: '',
    minArs: 1000,
    maxArs: 5_000_000,
    sandboxNetwork: 'POLYGON',
    sandboxToken: 'USDT',
    ...over,
  };
}

describe('koywe configuration', () => {
  it('needs the key, the secret, the organization and the webhook secret; not the merchant', () => {
    expect(isKoyweEnvironmentComplete(COMPLETE)).toBe(true);
    for (const missing of [
      'apiKey',
      'secret',
      'organizationId',
      'webhookSecret',
    ] as const) {
      expect(isKoyweEnvironmentComplete({ ...COMPLETE, [missing]: '' })).toBe(
        false,
      );
    }
  });

  it('serves a network with a complete environment, and none without the document pepper', () => {
    expect(railNetworks(config())).toEqual(['testnet']);
    expect(
      railNetworks(
        config({ environments: { public: COMPLETE, testnet: COMPLETE } }),
      ),
    ).toEqual(['public', 'testnet']);
    expect(railNetworks(config({ documentPepper: '' }))).toEqual([]);
  });

  it('pools only when switched on, with the merchant set, on a served network', () => {
    const withMerchant = { ...COMPLETE, merchantId: 'mrc_cosmos' };
    expect(pooledMerchantId(config(), 'testnet')).toBeNull();
    expect(
      pooledMerchantId(
        config({
          pooledEnabled: true,
          environments: { public: EMPTY, testnet: withMerchant },
        }),
        'testnet',
      ),
    ).toBe('mrc_cosmos');
    expect(
      pooledMerchantId(config({ pooledEnabled: true }), 'testnet'),
    ).toBeNull();
    expect(
      pooledMerchantId(
        config({
          pooledEnabled: true,
          documentPepper: '',
          environments: { public: EMPTY, testnet: withMerchant },
        }),
        'testnet',
      ),
    ).toBeNull();
  });

  it('knows the pairs the provider converts to', () => {
    expect(koyweDelivers('BSC', 'USDT')).toBe(true);
    expect(koyweDelivers('BSC', 'USDC')).toBe(false);
    expect(koyweDelivers('POLYGON', 'USDC')).toBe(true);
    expect(koyweDelivers('SOLANA', 'USDC')).toBe(false);
  });

  describe('at boot', () => {
    it('refuses to run without the plugin that owns payment requests', () => {
      expect(() => assertKoyweConfigConsistent(config(), ['koywe'])).toThrow(
        /without eldorado/,
      );
    });

    it('refuses one webhook secret for both networks', () => {
      expect(() =>
        assertKoyweConfigConsistent(
          config({ environments: { public: COMPLETE, testnet: COMPLETE } }),
          ['eldorado', 'koywe'],
        ),
      ).toThrow(
        /KOYWE_WEBHOOK_SECRET and KOYWE_SANDBOX_WEBHOOK_SECRET are the same/,
      );
    });

    it('refuses a sandbox pair the provider does not convert to, and bounds the wrong way round', () => {
      expect(() =>
        assertKoyweConfigConsistent(
          config({ sandboxNetwork: 'BSC', sandboxToken: 'USDC' }),
          ['eldorado', 'koywe'],
        ),
      ).toThrow(/KOYWE_SANDBOX_NETWORK=BSC/);
      expect(() =>
        assertKoyweConfigConsistent(config({ minArs: 10, maxArs: 5 }), [
          'eldorado',
          'koywe',
        ]),
      ).toThrow(/KOYWE_MIN_ARS/);
    });

    it('notes, without failing, what leaves the rail off', () => {
      expect(
        assertKoyweConfigConsistent(config(), ['eldorado', 'koywe']),
      ).toEqual([]);
      const notes = assertKoyweConfigConsistent(
        config({
          documentPepper: '',
          pooledEnabled: true,
          environments: {
            public: { ...EMPTY, apiKey: 'only-a-key' },
            testnet: COMPLETE,
          },
        }),
        ['eldorado', 'koywe'],
      );
      expect(notes).toEqual([
        expect.stringContaining(
          'KOYWE_API_KEY, SECRET, ORGANIZATION_ID and WEBHOOK_SECRET',
        ),
        expect.stringContaining('KOYWE_DOCUMENT_PEPPER is not set'),
      ]);
      expect(
        assertKoyweConfigConsistent(config({ pooledEnabled: true }), [
          'eldorado',
          'koywe',
        ]),
      ).toEqual([
        expect.stringContaining('KOYWE_SANDBOX_MERCHANT_ID is not set'),
      ]);
    });
  });
});
