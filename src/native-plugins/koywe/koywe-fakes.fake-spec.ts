import type { AppConfig, KoyweEnvironmentConfig } from '@/config/configuration';
import {
  PaymentRequestRails,
  type PaymentRequestLedger,
  type PaymentRequestRecord,
  type PaymentRequestSettlement,
} from '@/payment-request-rails/payment-request-rails';

/**
 * Fakes the `koywe` plugin's service specs share: its configuration, and the
 * payment requests another plugin owns, behind the core's ledger. Named
 * `*.fake-spec.ts`: kept out of the build and not a suite of its own.
 */

export const PEPPER = 'a-pepper-of-at-least-thirty-two-characters!';
export const SELLER_ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
export const POLYGON_USDT = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F';
export const SANDBOX_USDT = '0x25f5D414F85b7f4668ADe4E557ef234023208771';

const environment = (
  over: Partial<KoyweEnvironmentConfig> = {},
): KoyweEnvironmentConfig => ({
  apiUrl: 'https://api-sandbox.koywe.example',
  apiKey: 'key',
  secret: 'secret',
  organizationId: 'org_sandbox',
  merchantId: '',
  webhookSecret: 'sandbox-webhook-secret-sandbox-webhook-secret',
  ...over,
});

export function koyweSettings(
  over: Partial<AppConfig['koywe']> = {},
): AppConfig['koywe'] {
  return {
    environments: {
      public: environment({
        apiUrl: 'https://api.koywe.example',
        organizationId: 'org_production',
        webhookSecret: 'production-webhook-secret-production-secret',
      }),
      testnet: environment(),
    },
    pooledEnabled: false,
    documentPepper: PEPPER,
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

/** A ConfigService over the koywe section (and the observer switch the sweep reads). */
export function koyweConfig(over: Partial<AppConfig['koywe']> = {}) {
  const koywe = koyweSettings(over);
  return {
    koywe,
    get: jest.fn((key: string) => {
      if (key === 'koywe') return koywe;
      if (key === 'observer') return { enabled: false };
      if (key === 'apisix') {
        return {
          publicConsumer: 'cosmos_public',
          gatewaySecret: 'topsecret-topsecret-topsecret-topsecret',
        };
      }
      return { network: 'testnet' };
    }),
  };
}

/** A payment request as the ledger answers it. */
export function request(
  over: Partial<PaymentRequestRecord> = {},
): PaymentRequestRecord {
  return {
    id: 'creq1',
    ownerId: 'c_seller',
    network: 'public',
    status: 'open',
    currency: 'ARS',
    amount: '15000',
    chainId: 137,
    token: 'USDT',
    tokenAddress: POLYGON_USDT,
    tokenDecimals: 6,
    address: SELLER_ADDRESS,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    paidAt: null,
    ...over,
  };
}

/** The payment requests, behind a ledger that keeps the first completion, registered in the core's rails. */
export function fakeLedger(requests: PaymentRequestRecord[]) {
  const settlements: { id: string; settlement: PaymentRequestSettlement }[] =
    [];
  const ledger = {
    find: jest.fn((id: string) =>
      Promise.resolve(requests.find((r) => r.id === id) ?? null),
    ),
    markProcessing: jest.fn((id: string) => {
      const row = requests.find((r) => r.id === id);
      if (
        !row ||
        row.paidAt ||
        !['open', 'expired', 'cancelled'].includes(row.status)
      ) {
        return Promise.resolve(false);
      }
      row.status = 'processing';
      return Promise.resolve(true);
    }),
    markPaid: jest.fn((id: string, settlement: PaymentRequestSettlement) => {
      const row = requests.find((r) => r.id === id);
      if (!row || row.paidAt) return Promise.resolve(false);
      row.status = 'paid';
      row.paidAt = settlement.at;
      settlements.push({ id, settlement });
      return Promise.resolve(true);
    }),
  } satisfies PaymentRequestLedger;
  const rails = new PaymentRequestRails();
  rails.registerLedger(ledger);
  return { ledger, rails, settlements, requests };
}
