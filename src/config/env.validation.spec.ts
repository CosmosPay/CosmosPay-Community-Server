import 'reflect-metadata';
import { validateEnv } from '@/config/env.validation';

/** Valid Stellar testnet address (from .env.example). */
const VALID_FEE_WALLET =
  'GARMB7W3FCR3GKIM3FLWVJASC2PUZ4VHUJZTNJVWWKNTCJNKO6TBCT76';

function validEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    DATABASE_URL:
      'postgresql://postgres:postgres@localhost:5432/cosmos_payments',
    APISIX_GATEWAY_SECRET: 'test-gateway-secret-at-least-32-chars-long',
    NODE_ENV: 'test',
    STELLAR_SWAP_FEE_WALLET: VALID_FEE_WALLET,
    ...overrides,
  };
}

function expectEnvError(env: Record<string, string>, variable: string): void {
  expect(() => validateEnv(env)).toThrow(new RegExp(variable, 'i'));
}

describe('validateEnv', () => {
  it('accepts a minimal valid environment', () => {
    const result = validateEnv(validEnv());
    expect(typeof result.DATABASE_URL).toBe('string');
    expect(result.APISIX_GATEWAY_SECRET).toBe(
      'test-gateway-secret-at-least-32-chars-long',
    );
  });

  it('rejects a gateway secret short enough to guess', () => {
    // This value is the whole boundary between "arrived through APISIX" and
    // "anyone who can reach the pod", and it used to boot at one character
    // while admin credentials already demanded 16.
    expectEnvError(
      validEnv({ APISIX_GATEWAY_SECRET: 'short' }),
      'APISIX_GATEWAY_SECRET',
    );
  });

  it('requires APISIX_GATEWAY_SECRET', () => {
    expectEnvError(
      validEnv({ APISIX_GATEWAY_SECRET: '' }),
      'APISIX_GATEWAY_SECRET',
    );
  });

  it('rejects the placeholder .env.example used to ship', () => {
    // 46 characters, so the length floor alone let it boot — behind a secret
    // printed in a public repository.
    expect(() =>
      validateEnv(
        validEnv({
          APISIX_GATEWAY_SECRET:
            'replace-with-a-long-random-secret-min-32-chars',
        }),
      ),
    ).toThrow(/APISIX_GATEWAY_SECRET is still a placeholder/);
  });

  it('rejects other obvious placeholder gateway secrets', () => {
    for (const placeholder of [
      'change-me-to-a-random-value-of-32-chars',
      'YOUR_SECRET_GOES_HERE_AT_LEAST_32_CHARS',
    ]) {
      expect(() =>
        validateEnv(validEnv({ APISIX_GATEWAY_SECRET: placeholder })),
      ).toThrow(/placeholder/);
    }
  });

  it('accepts a generated gateway secret', () => {
    const generated =
      '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
    expect(
      validateEnv(validEnv({ APISIX_GATEWAY_SECRET: generated }))
        .APISIX_GATEWAY_SECRET,
    ).toBe(generated);
  });

  describe('NODE_ENV', () => {
    it('rejects NODE_ENV=prod', () => {
      expectEnvError(validEnv({ NODE_ENV: 'prod' }), 'NODE_ENV');
    });

    it('accepts development, test, and production', () => {
      for (const nodeEnv of ['development', 'test', 'production'] as const) {
        expect(validateEnv(validEnv({ NODE_ENV: nodeEnv })).NODE_ENV).toBe(
          nodeEnv,
        );
      }
    });
  });

  describe('deprecated STELLAR_HORIZON_URL', () => {
    it('rejects the legacy single Horizon URL variable', () => {
      expect(() =>
        validateEnv(
          validEnv({ STELLAR_HORIZON_URL: 'https://horizon.example.com' }),
        ),
      ).toThrow(/STELLAR_HORIZON_URL.*STELLAR_HORIZON_URL_PUBLIC/i);
    });
  });

  describe('observer tuning', () => {
    it('rejects OBSERVER_INTERVAL_MS=abc', () => {
      expectEnvError(
        validEnv({ OBSERVER_INTERVAL_MS: 'abc' }),
        'OBSERVER_INTERVAL_MS',
      );
    });

    it('rejects OBSERVER_INTERVAL_MS below minimum', () => {
      expectEnvError(
        validEnv({ OBSERVER_INTERVAL_MS: '5' }),
        'OBSERVER_INTERVAL_MS',
      );
    });

    it('accepts OBSERVER_INTERVAL_MS=15000', () => {
      expect(
        validateEnv(validEnv({ OBSERVER_INTERVAL_MS: '15000' }))
          .OBSERVER_INTERVAL_MS,
      ).toBe(15000);
    });

    it('rejects OBSERVER_BATCH_SIZE=abc', () => {
      expectEnvError(
        validEnv({ OBSERVER_BATCH_SIZE: 'abc' }),
        'OBSERVER_BATCH_SIZE',
      );
    });

    it('rejects OBSERVER_BATCH_SIZE=0', () => {
      expectEnvError(
        validEnv({ OBSERVER_BATCH_SIZE: '0' }),
        'OBSERVER_BATCH_SIZE',
      );
    });

    it('rejects invalid OBSERVER_ENABLED values', () => {
      expectEnvError(
        validEnv({ OBSERVER_ENABLED: 'fasle' }),
        'OBSERVER_ENABLED',
      );
    });

    it('accepts OBSERVER_ENABLED=true and false', () => {
      expect(
        validateEnv(validEnv({ OBSERVER_ENABLED: 'true' })).OBSERVER_ENABLED,
      ).toBe('true');
      expect(
        validateEnv(validEnv({ OBSERVER_ENABLED: 'false' })).OBSERVER_ENABLED,
      ).toBe('false');
    });
  });

  describe('request log retention', () => {
    it('rejects REQUEST_LOG_RETENTION_DAYS=abc', () => {
      expectEnvError(
        validEnv({ REQUEST_LOG_RETENTION_DAYS: 'abc' }),
        'REQUEST_LOG_RETENTION_DAYS',
      );
    });

    it('accepts REQUEST_LOG_RETENTION_DAYS=0 (prune disabled)', () => {
      expect(
        validateEnv(validEnv({ REQUEST_LOG_RETENTION_DAYS: '0' }))
          .REQUEST_LOG_RETENTION_DAYS,
      ).toBe(0);
    });

    it('rejects REQUEST_LOG_PRUNE_INTERVAL_MS=abc', () => {
      expectEnvError(
        validEnv({ REQUEST_LOG_PRUNE_INTERVAL_MS: 'abc' }),
        'REQUEST_LOG_PRUNE_INTERVAL_MS',
      );
    });

    it('rejects REQUEST_LOG_PRUNE_BATCH_SIZE=0', () => {
      expectEnvError(
        validEnv({ REQUEST_LOG_PRUNE_BATCH_SIZE: '0' }),
        'REQUEST_LOG_PRUNE_BATCH_SIZE',
      );
    });

    it('rejects REQUEST_LOG_PRUNE_MAX_PER_CYCLE=abc', () => {
      expectEnvError(
        validEnv({ REQUEST_LOG_PRUNE_MAX_PER_CYCLE: 'abc' }),
        'REQUEST_LOG_PRUNE_MAX_PER_CYCLE',
      );
    });
  });

  describe('payment intent TTL', () => {
    it('rejects PAYMENT_INTENT_TTL_SECONDS=abc', () => {
      expectEnvError(
        validEnv({ PAYMENT_INTENT_TTL_SECONDS: 'abc' }),
        'PAYMENT_INTENT_TTL_SECONDS',
      );
    });

    it('rejects PAYMENT_INTENT_TTL_SECONDS=0', () => {
      expectEnvError(
        validEnv({ PAYMENT_INTENT_TTL_SECONDS: '0' }),
        'PAYMENT_INTENT_TTL_SECONDS',
      );
    });
  });

  describe('webhook tuning', () => {
    it('rejects WEBHOOK_TIMEOUT_MS=abc', () => {
      expectEnvError(
        validEnv({ WEBHOOK_TIMEOUT_MS: 'abc' }),
        'WEBHOOK_TIMEOUT_MS',
      );
    });

    it('rejects WEBHOOK_MAX_ATTEMPTS=abc', () => {
      expectEnvError(
        validEnv({ WEBHOOK_MAX_ATTEMPTS: 'abc' }),
        'WEBHOOK_MAX_ATTEMPTS',
      );
    });

    it('rejects WEBHOOK_BACKOFF_MS=abc', () => {
      expectEnvError(
        validEnv({ WEBHOOK_BACKOFF_MS: 'abc' }),
        'WEBHOOK_BACKOFF_MS',
      );
    });
  });

  describe('Horizon and OpenAPI URLs', () => {
    it('rejects invalid STELLAR_HORIZON_URL_PUBLIC', () => {
      expectEnvError(
        validEnv({ STELLAR_HORIZON_URL_PUBLIC: 'not-a-url' }),
        'STELLAR_HORIZON_URL_PUBLIC',
      );
    });

    it('accepts valid Horizon override URLs', () => {
      expect(
        validateEnv(
          validEnv({
            STELLAR_HORIZON_URL_PUBLIC: 'https://horizon.stellar.org',
            STELLAR_HORIZON_URL_TESTNET: 'https://horizon-testnet.stellar.org',
          }),
        ).STELLAR_HORIZON_URL_PUBLIC,
      ).toBe('https://horizon.stellar.org');
    });

    it('rejects invalid OPENAPI_SERVER_URL', () => {
      expectEnvError(
        validEnv({ OPENAPI_SERVER_URL: 'not-a-url' }),
        'OPENAPI_SERVER_URL',
      );
    });
  });

  describe('APISIX header overrides', () => {
    it('accepts optional APISIX header overrides', () => {
      expect(
        validateEnv(
          validEnv({
            APISIX_ENVIRONMENT_HEADER: 'x-custom-env',
            APISIX_ROLE_HEADER: 'x-custom-role',
            APISIX_PERMISSIONS_HEADER: 'x-custom-permissions',
          }),
        ).APISIX_ENVIRONMENT_HEADER,
      ).toBe('x-custom-env');
    });
  });

  describe('SWAGGER_ENABLED', () => {
    it('accepts true and false', () => {
      expect(
        validateEnv(validEnv({ SWAGGER_ENABLED: 'true' })).SWAGGER_ENABLED,
      ).toBe('true');
      expect(
        validateEnv(validEnv({ SWAGGER_ENABLED: 'false' })).SWAGGER_ENABLED,
      ).toBe('false');
    });

    it('rejects invalid SWAGGER_ENABLED values', () => {
      expectEnvError(validEnv({ SWAGGER_ENABLED: 'yes' }), 'SWAGGER_ENABLED');
    });
  });

  describe('cross-field rules', () => {
    it('requires STELLAR_SWAP_FEE_WALLET when STELLAR_SWAP_FEE_BPS > 0', () => {
      expect(() =>
        validateEnv(
          validEnv({
            STELLAR_SWAP_FEE_BPS: '50',
            STELLAR_SWAP_FEE_WALLET: '',
          }),
        ),
      ).toThrow(/STELLAR_SWAP_FEE_WALLET/i);
    });

    it('requires STELLAR_SWAP_FEE_WALLET when fee bps defaults to 50', () => {
      expect(() =>
        validateEnv(
          validEnv({
            STELLAR_SWAP_FEE_WALLET: '',
          }),
        ),
      ).toThrow(/STELLAR_SWAP_FEE_WALLET/i);
    });

    it('allows zero fee without a wallet', () => {
      expect(
        validateEnv(
          validEnv({
            STELLAR_SWAP_FEE_BPS: '0',
            STELLAR_SWAP_FEE_WALLET: '',
          }),
        ).STELLAR_SWAP_FEE_BPS,
      ).toBe(0);
    });

    it('rejects an invalid fee wallet when fee > 0', () => {
      expect(() =>
        validateEnv(
          validEnv({
            STELLAR_SWAP_FEE_BPS: '50',
            STELLAR_SWAP_FEE_WALLET: 'GXXX-invalida',
          }),
        ),
      ).toThrow(/STELLAR_SWAP_FEE_WALLET/i);
    });

    it('rejects slippage above max slippage', () => {
      expect(() =>
        validateEnv(
          validEnv({
            STELLAR_SWAP_SLIPPAGE_BPS: '600',
            STELLAR_SWAP_MAX_SLIPPAGE_BPS: '500',
          }),
        ),
      ).toThrow(/STELLAR_SWAP_SLIPPAGE_BPS/i);
    });
  });

  describe('SWAP_COMMISSION_DEV_WAIVER', () => {
    it('is accepted outside production', () => {
      expect(() =>
        validateEnv(validEnv({ SWAP_COMMISSION_DEV_WAIVER: 'true' })),
      ).not.toThrow();
    });

    it('is refused when NODE_ENV=production: it would give swaps away', () => {
      expectEnvError(
        validEnv({
          NODE_ENV: 'production',
          SWAP_COMMISSION_DEV_WAIVER: 'true',
        }),
        'SWAP_COMMISSION_DEV_WAIVER',
      );
    });
  });

  describe('bank transfers (native plugin koywe)', () => {
    const EMPTY = Object.fromEntries(
      [
        'KOYWE_API_URL',
        'KOYWE_WEBHOOK_SECRET',
        'KOYWE_SANDBOX_API_URL',
        'KOYWE_SANDBOX_WEBHOOK_SECRET',
        'KOYWE_SANDBOX_NETWORK',
        'KOYWE_SANDBOX_TOKEN',
        'KOYWE_POOLED_ENABLED',
        'KOYWE_DOCUMENT_PEPPER',
        'KOYWE_ALIAS',
        'KOYWE_CVU',
      ].map((name) => [name, '']),
    );

    it('reads an empty value as an unset one, as .env.example leaves them', () => {
      expect(() => validateEnv(validEnv(EMPTY))).not.toThrow();
    });

    it('accepts a whole set', () => {
      expect(() =>
        validateEnv(
          validEnv({
            KOYWE_API_URL: 'https://api.koywe.com',
            KOYWE_API_KEY: 'key',
            KOYWE_SECRET: 'secret',
            KOYWE_ORGANIZATION_ID: 'org_1',
            KOYWE_WEBHOOK_SECRET: 'w'.repeat(64),
            KOYWE_SANDBOX_NETWORK: 'POLYGON',
            KOYWE_SANDBOX_TOKEN: 'USDT',
            KOYWE_POOLED_ENABLED: 'false',
            KOYWE_DOCUMENT_PEPPER: 'p'.repeat(64),
            KOYWE_ALIAS: 'cosmospay.qr',
            KOYWE_CVU: '0000003100000000000000',
            KOYWE_MIN_ARS: '1000',
            KOYWE_MAX_ARS: '5000000',
          }),
        ),
      ).not.toThrow();
    });

    it('refuses a short webhook secret or pepper, and values that cannot be', () => {
      for (const [name, value] of [
        ['KOYWE_WEBHOOK_SECRET', 'short'],
        ['KOYWE_SANDBOX_WEBHOOK_SECRET', 'short'],
        ['KOYWE_DOCUMENT_PEPPER', 'short'],
        ['KOYWE_SANDBOX_NETWORK', 'SOLANA'],
        ['KOYWE_SANDBOX_TOKEN', 'ETH'],
        ['KOYWE_CVU', '123'],
        ['KOYWE_ALIAS', 'a b'],
        ['KOYWE_POOLED_ENABLED', 'maybe'],
        ['KOYWE_MIN_ARS', '0'],
        ['KOYWE_MAX_ARS', '1000.123'],
      ]) {
        expectEnvError(validEnv({ [name]: value }), name);
      }
    });
  });
});
