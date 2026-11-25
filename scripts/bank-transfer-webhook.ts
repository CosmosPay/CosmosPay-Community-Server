/**
 * Registers, lists and pings the bank transfer partner's webhook endpoint for
 * one environment (native plugin `koywe`). Reads the environment's credentials
 * from the same `.env` the service reads (`KOYWE_*` for `public`,
 * `KOYWE_SANDBOX_*` for `testnet`) and prints no secret.
 *
 *   npm run bank-transfer:webhook -- register --network testnet [--url <url>]
 *   npm run bank-transfer:webhook -- list --network testnet
 *   npm run bank-transfer:webhook -- ping --network testnet --id <webhookId>
 *
 * `register` signs the endpoint with the environment's webhook secret
 * (`KOYWE_WEBHOOK_SECRET` / `KOYWE_SANDBOX_WEBHOOK_SECRET`), the one the service
 * verifies deliveries with; the default URL is the gateway's public route.
 */
import { config as loadDotenv } from 'dotenv';
import configuration, {
  envFilePath,
  type KoyweEnvironmentConfig,
  type StellarNetwork,
} from '@/config/configuration';

const DEFAULT_URL =
  'https://api.cosmospay.lat/cosmos-api/v1/onramp/transfer/webhooks';
const ENDPOINT_NAME = 'Cosmos Pay bank transfers';
const TIMEOUT_MS = 15_000;

type Command = 'register' | 'list' | 'ping';

function usage(message?: string): never {
  if (message) console.error(message);
  console.error(
    'Usage: npm run bank-transfer:webhook -- <register|list|ping> --network <testnet|public> [--url <url>] [--id <webhookId>]',
  );
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  if (!['register', 'list', 'ping'].includes(command ?? '')) usage();
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    const value = rest[i + 1];
    if (!name?.startsWith('--') || value === undefined) usage();
    flags[name.slice(2)] = value;
  }
  if (flags.network !== 'testnet' && flags.network !== 'public') {
    usage('--network must be testnet or public');
  }
  const network: StellarNetwork =
    flags.network === 'public' ? 'public' : 'testnet';
  return {
    command: command as Command,
    network,
    url: flags.url ?? DEFAULT_URL,
    id: flags.id,
  };
}

/** One JSON call; a failure says the status and the partner's message, never a credential. */
async function call<T>(
  environment: KoyweEnvironmentConfig,
  method: 'GET' | 'POST',
  path: string,
  token: string | null,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${environment.apiUrl}${path}`, {
    method,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed.message === 'string') message = parsed.message;
    } catch {
      // Not JSON: the start of the body is the message.
    }
    throw new Error(`${method} ${path} answered ${res.status}: ${message}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

interface Endpoint {
  id?: string;
  url?: string;
  environment?: string;
  isActive?: boolean;
  isDeleted?: boolean;
}

function show(endpoint: Endpoint): string {
  return `${endpoint.id ?? '?'}  ${endpoint.url ?? '?'}  environment=${endpoint.environment ?? '?'}  active=${String(endpoint.isActive ?? '?')}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadDotenv({ path: envFilePath(), quiet: true });
  const environment = configuration().koywe.environments[args.network];
  const prefix = args.network === 'public' ? 'KOYWE_' : 'KOYWE_SANDBOX_';
  for (const [field, name] of [
    ['apiKey', 'API_KEY'],
    ['secret', 'SECRET'],
    ['organizationId', 'ORGANIZATION_ID'],
  ] as const) {
    if (!environment[field]) usage(`${prefix}${name} is not set`);
  }

  const { token } = await call<{ token: string }>(
    environment,
    'POST',
    '/api/v1/auth/sign-in',
    null,
    { apiKey: environment.apiKey, secret: environment.secret },
  );
  const org = `/api/v1/organizations/${encodeURIComponent(environment.organizationId)}`;

  if (args.command === 'register') {
    if (environment.webhookSecret.length < 32) {
      usage(
        `${prefix}WEBHOOK_SECRET must be set, 32 characters or more (openssl rand -hex 32)`,
      );
    }
    const created = await call<Endpoint>(
      environment,
      'POST',
      `${org}/webhooks`,
      token,
      {
        url: args.url,
        name: ENDPOINT_NAME,
        secret: environment.webhookSecret,
      },
    );
    console.log(`Registered (${args.network}): ${show(created)}`);
    console.log(
      `Signed with ${prefix}WEBHOOK_SECRET. Check it with: npm run bank-transfer:webhook -- ping --network ${args.network} --id ${created.id ?? '<id>'}`,
    );
    return;
  }

  if (args.command === 'list') {
    const endpoints = await call<Endpoint[]>(
      environment,
      'GET',
      `${org}/webhooks`,
      token,
    );
    const live = (Array.isArray(endpoints) ? endpoints : []).filter(
      (endpoint) => !endpoint.isDeleted,
    );
    if (live.length === 0)
      console.log(`No webhook endpoint (${args.network}).`);
    for (const endpoint of live) console.log(show(endpoint));
    return;
  }

  if (!args.id) usage('ping needs --id <webhookId> (see list)');
  const event = await call<{ id?: string; type?: string }>(
    environment,
    'POST',
    `${org}/webhooks/${encodeURIComponent(args.id)}/ping`,
    token,
    {},
  );
  console.log(
    `Ping sent (${args.network}): event ${event.id ?? '?'} (${event.type ?? 'webhook.ping'}). ` +
      'The service logs nothing for a ping it verified; a 401 in its log means the secrets differ.',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
