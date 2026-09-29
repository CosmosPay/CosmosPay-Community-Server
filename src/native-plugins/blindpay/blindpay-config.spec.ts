import type { AppConfig } from '@/config/configuration';
import { assertBlindpayInstancesConsistent } from '@/native-plugins/blindpay/blindpay-config';

/** The shape Svix mints: `whsec_` + base64 of 24 key bytes. */
const SVIX_SECRET = `whsec_${Buffer.from('env-validation-svix-key!').toString('base64')}`;

const EMPTY = { apiKey: '', instanceId: '', webhookSecret: '' };

function blindpay(
  prod: Partial<typeof EMPTY> = {},
  dev: Partial<typeof EMPTY> = {},
): AppConfig['blindpay'] {
  return {
    baseUrl: 'https://api.blindpay.com/v1',
    timeoutMs: 15_000,
    instances: {
      prod: { ...EMPTY, ...prod },
      dev: { ...EMPTY, ...dev },
    },
  };
}

describe('assertBlindpayInstancesConsistent', () => {
  it('accepts no BlindPay configuration at all', () => {
    expect(() => assertBlindpayInstancesConsistent(blindpay())).not.toThrow();
  });

  it('requires the webhook secret when the API key is set', () => {
    expect(() =>
      assertBlindpayInstancesConsistent(
        blindpay({ apiKey: 'bp_test_key', instanceId: 'in_test' }),
      ),
    ).toThrow(/BLINDPAY_WEBHOOK_SECRET/);
  });

  it('requires the instance id when the API key is set', () => {
    expect(() =>
      assertBlindpayInstancesConsistent(
        blindpay({ apiKey: 'bp_test_key', webhookSecret: SVIX_SECRET }),
      ),
    ).toThrow(/BLINDPAY_INSTANCE_ID/);
  });

  it('accepts a real-length Svix webhook secret', () => {
    expect(() =>
      assertBlindpayInstancesConsistent(
        blindpay({
          apiKey: 'bp_test_key',
          instanceId: 'in_test',
          webhookSecret: SVIX_SECRET,
        }),
      ),
    ).not.toThrow();
  });

  it('rejects a webhook secret whose key is too short', () => {
    // `test` decodes to 3 bytes of HMAC key.
    expect(() =>
      assertBlindpayInstancesConsistent(
        blindpay({ webhookSecret: 'whsec_test' }),
      ),
    ).toThrow(/BLINDPAY_WEBHOOK_SECRET is not a usable Svix signing secret/);
  });

  it('rejects a webhook secret outside the base64 alphabet, even with no API key', () => {
    // Node decodes this to an EMPTY key without complaint; checked even with
    // no API key set, because the webhook route reads the secret on its own.
    expect(() =>
      assertBlindpayInstancesConsistent(
        blindpay({ webhookSecret: `whsec_${'!'.repeat(40)}` }),
      ),
    ).toThrow(/BLINDPAY_WEBHOOK_SECRET is not a usable Svix signing secret/);
  });

  it('holds the development instance to the same rules, naming its own variables', () => {
    expect(() =>
      assertBlindpayInstancesConsistent(
        blindpay({}, { apiKey: 'bp_dev_key', webhookSecret: SVIX_SECRET }),
      ),
    ).toThrow(/BLINDPAY_INSTANCE_ID_DEV is required/);
    expect(() =>
      assertBlindpayInstancesConsistent(
        blindpay({}, { webhookSecret: 'whsec_test' }),
      ),
    ).toThrow(
      /BLINDPAY_WEBHOOK_SECRET_DEV is not a usable Svix signing secret/,
    );
  });

  it('accepts a complete development instance alongside production', () => {
    const whole = {
      apiKey: 'bp_key',
      instanceId: 'in_1',
      webhookSecret: SVIX_SECRET,
    };
    expect(() =>
      assertBlindpayInstancesConsistent(blindpay(whole, whole)),
    ).not.toThrow();
  });
});
