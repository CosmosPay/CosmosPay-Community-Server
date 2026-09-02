import { StellarService } from './stellar.service';
import { Networks } from '@stellar/stellar-sdk';

describe('StellarService', () => {
  const config = {
    get: () => ({
      horizon: {
        public: 'https://horizon.stellar.org',
        testnet: 'https://horizon-testnet.stellar.org',
      },
    }),
  } as never;

  it('bounds every Horizon read with a real timeout', () => {
    const service = new StellarService(config);

    // The regression this guards: `Config.setTimeout()` reads as a global
    // timeout but no Horizon code path calls `Config.getTimeout()`, so every
    // read stayed unbounded and a stalled socket wedged the reconcilers'
    // `running` latch permanently.
    expect(service.server('public').httpClient.defaults.timeout).toBe(15_000);
    expect(service.server('testnet').httpClient.defaults.timeout).toBe(15_000);
  });

  it('caches one server per network', () => {
    const service = new StellarService(config);

    expect(service.server('public')).toBe(service.server('public'));
    expect(service.server('public')).not.toBe(service.server('testnet'));
  });

  it('pairs each network with its own passphrase', () => {
    const service = new StellarService(config);

    expect(service.passphrase('public')).toBe(Networks.PUBLIC);
    expect(service.passphrase('testnet')).toBe(Networks.TESTNET);
  });
});
