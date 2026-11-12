/**
 * Sandbox only: simulates a payer's bank transfer into a merchant's ARS
 * account at the bank transfer partner (native plugin `koywe`), which fires a
 * real `bank_income.received` to the registered webhook, so the whole flow
 * (match, conversion, completion) runs end to end. Reads `KOYWE_SANDBOX_*`
 * from the same `.env` the service reads; prints no secret and only the last
 * three digits of the document.
 *
 *   npm run bank-transfer:simulate -- --amount 6000 --document 20123456786 [--merchant <merchantId>] [--reference <text>]
 *
 * `--merchant` is the seller's merchant (their bank transfer account), or
 * `KOYWE_SANDBOX_MERCHANT_ID` (the pooled one) when it is left out. The
 * document is the one the payer gave to `POST /v1/payment-links/fiat/{id}/transfers`.
 */
import { config as loadDotenv } from 'dotenv';
import configuration, { envFilePath } from '@/config/configuration';

const TIMEOUT_MS = 15_000;

function usage(message?: string): never {
  if (message) console.error(message);
  console.error(
    'Usage: npm run bank-transfer:simulate -- --amount <ARS> --document <CUIT/CUIL or DNI> [--merchant <merchantId>] [--reference <text>]',
  );
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (!name?.startsWith('--') || value === undefined) usage();
    flags[name.slice(2)] = value;
  }
  const amount = Number(flags.amount);
  if (!/^\d+(\.\d{1,2})?$/.test(flags.amount ?? '') || !(amount > 0)) {
    usage('--amount must be an amount of ARS, e.g. 6000 or 6000.01');
  }
  const document = (flags.document ?? '').replace(/[-.\s]/g, '');
  if (!/^(\d{7,8}|\d{11})$/.test(document)) {
    usage(
      '--document must be a CUIT/CUIL (11 digits) or a DNI (7 or 8 digits)',
    );
  }
  return {
    amount,
    document,
    merchant: flags.merchant,
    reference: flags.reference ?? `cosmospay-simulation-${Date.now()}`,
  };
}

async function call<T>(
  url: string,
  token: string | null,
  body: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    // The partner may echo the document it was sent: masked before printing.
    const masked = text.slice(0, 300).replace(/\d{7,}/g, '[redacted]');
    throw new Error(
      `POST ${new URL(url).pathname} answered ${res.status}: ${masked}`,
    );
  }
  return (text ? JSON.parse(text) : null) as T;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadDotenv({ path: envFilePath(), quiet: true });
  const sandbox = configuration().koywe.environments.testnet;
  for (const [field, name] of [
    ['apiKey', 'KOYWE_SANDBOX_API_KEY'],
    ['secret', 'KOYWE_SANDBOX_SECRET'],
    ['organizationId', 'KOYWE_SANDBOX_ORGANIZATION_ID'],
  ] as const) {
    if (!sandbox[field]) usage(`${name} is not set`);
  }
  const merchant = args.merchant ?? sandbox.merchantId;
  if (!merchant) {
    usage('--merchant is required when KOYWE_SANDBOX_MERCHANT_ID is not set');
  }

  const { token } = await call<{ token: string }>(
    `${sandbox.apiUrl}/api/v1/auth/sign-in`,
    null,
    { apiKey: sandbox.apiKey, secret: sandbox.secret },
  );
  const simulated = await call<{
    referenceId?: string;
    virtualAccountProvisioned?: boolean;
  }>(
    `${sandbox.apiUrl}/api/v1/organizations/${encodeURIComponent(sandbox.organizationId)}/merchants/${encodeURIComponent(merchant)}/sandbox/bank-income/simulate`,
    token,
    {
      currency: 'ARS',
      amount: args.amount,
      documentType: args.document.length === 11 ? 'CUIT' : 'DNI',
      documentNumber: args.document,
      customerReference: args.reference,
    },
  );
  console.log(
    `Simulated a deposit of ${args.amount} ARS from document …${args.document.slice(-3)} into merchant ${merchant}: reference ${simulated.referenceId ?? '?'}` +
      (simulated.virtualAccountProvisioned
        ? ' (the sandbox opened a virtual account for it)'
        : ''),
  );
  console.log(
    'The partner now delivers bank_income.received to the registered webhook; the charge reads processing, then paid.',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
