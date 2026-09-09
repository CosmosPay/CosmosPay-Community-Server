/**
 * Re-checks every row of the asset registry against the live network.
 *
 * The registry is a security control — it is the only thing standing between a
 * user and one of the twenty accounts issuing a token called `USDC` — and its
 * contents are hand-written constants that nothing else validates. A typo in an
 * issuer, or a flag transcribed from documentation rather than read off the
 * chain, produces a registry that compiles, passes every test, serves a 200, and
 * points users at the wrong asset.
 *
 * So this asserts the facts the entries actually claim:
 *
 *   - the (code, issuer) pair EXISTS on the network it is filed under, which is
 *     what catches a mainnet issuer pasted into the testnet list;
 *   - `contract` matches Horizon's `contract_id` for the pair, or is null;
 *   - `flags` match the issuing account's real `auth_revocable` /
 *     `auth_clawback_enabled`, since those are a disclosure to the holder and a
 *     stale `false` understates what the issuer can do;
 *   - a verified entry with a domain matches the issuing account's
 *     `home_domain`. Verified entries WITHOUT a domain are reported, not failed —
 *     Tether's USDT0 publishes none and BlindPay's testnet asset is ours.
 *
 * It is deliberately not a unit test: it needs the public internet, and a test
 * that fails when Horizon is slow is a test people learn to skip. Run it when
 * touching the registry, and on a schedule if you like.
 *
 *   npm run assets:verify
 */
import {
  ASSET_REGISTRY,
  type RegistryAsset,
  type RegistryNetwork,
} from '@/assets/assets.constants';

const HORIZON: Record<RegistryNetwork, string> = {
  public: 'https://horizon.stellar.org',
  testnet: 'https://horizon-testnet.stellar.org',
};

interface HorizonAssetRecord {
  contract_id?: string;
  accounts?: { authorized?: number };
}

interface HorizonAccount {
  home_domain?: string;
  flags?: { auth_revocable?: boolean; auth_clawback_enabled?: boolean };
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

const problems: string[] = [];
const notes: string[] = [];

function check(
  network: RegistryNetwork,
  asset: RegistryAsset,
  condition: boolean,
  message: string,
): void {
  if (!condition) {
    problems.push(
      `[${network}] ${asset.code} ${asset.issuer ?? 'native'}: ${message}`,
    );
  }
}

async function verify(
  network: RegistryNetwork,
  asset: RegistryAsset,
): Promise<void> {
  // Native lumens have no issuing account and no trustline to look up.
  if (asset.issuer === null) return;

  const base = HORIZON[network];
  const listed = await getJson<{
    _embedded?: { records?: HorizonAssetRecord[] };
  }>(
    `${base}/assets?asset_code=${encodeURIComponent(asset.code)}&asset_issuer=${asset.issuer}`,
  );
  const record = listed?._embedded?.records?.[0];
  if (!record) {
    problems.push(
      `[${network}] ${asset.code} ${asset.issuer}: does not exist on this network`,
    );
    return;
  }

  const account = await getJson<HorizonAccount>(
    `${base}/accounts/${asset.issuer}`,
  );
  if (!account) {
    problems.push(
      `[${network}] ${asset.code} ${asset.issuer}: issuing account not found`,
    );
    return;
  }

  const contract = record.contract_id ?? null;
  check(
    network,
    asset,
    asset.contract === contract,
    `contract is ${asset.contract ?? 'null'}, Horizon says ${contract ?? 'null'}`,
  );

  const revocable = !!account.flags?.auth_revocable;
  const clawback = !!account.flags?.auth_clawback_enabled;
  check(
    network,
    asset,
    asset.flags.authRevocable === revocable,
    `flags.authRevocable is ${asset.flags.authRevocable}, chain says ${revocable}`,
  );
  check(
    network,
    asset,
    asset.flags.clawback === clawback,
    `flags.clawback is ${asset.flags.clawback}, chain says ${clawback}`,
  );

  const home = account.home_domain ?? '';
  if (asset.verified && asset.issuerDomain) {
    check(
      network,
      asset,
      home === asset.issuerDomain,
      `issuerDomain is ${asset.issuerDomain}, home_domain is ${home || '(none)'}`,
    );
  } else if (asset.verified) {
    notes.push(
      `[${network}] ${asset.code} (${asset.issuerName}): verified with no domain — ` +
        `identity rests on ${asset.contract ? 'its SAC id' : 'a direct integration'}, ` +
        `not on DNS. ${record.accounts?.authorized ?? 0} trustlines.`,
    );
  }
}

async function main(): Promise<void> {
  for (const network of Object.keys(ASSET_REGISTRY) as RegistryNetwork[]) {
    for (const asset of ASSET_REGISTRY[network]) {
      await verify(network, asset);
    }
  }

  for (const note of notes) console.log(`note  ${note}`);
  if (problems.length === 0) {
    console.log(`\nok — every registry entry matches the live network.`);
    return;
  }
  for (const problem of problems) console.error(`FAIL  ${problem}`);
  console.error(
    `\n${problems.length} registry entr(ies) disagree with the chain.`,
  );
  process.exitCode = 1;
}

void main();
