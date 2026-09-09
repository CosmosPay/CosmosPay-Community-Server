/**
 * The asset registry: which (code, issuer) pairs this platform vouches for, per
 * network, and who issues them.
 *
 * Why a curated table and not a Horizon query: on Stellar an asset is a (code,
 * issuer) PAIR and the code alone is not an identifier. Anyone may issue a token
 * called `USDC`, and at the time of writing mainnet carries 20+ issuers doing
 * exactly that, plus 8 more for `USDT0`. A client that resolves an asset by code
 * picks whichever issuer its indexer happened to return first, which is how a user
 * ends up holding a worthless look-alike. So the identity comes from here, and
 * Horizon is only ever asked about balances and prices.
 *
 * `verified` is a claim about the ISSUER'S IDENTITY, not about the asset being a
 * good investment: it means we checked that the issuing account is the one the
 * named organization publishes (its `home_domain`, its stellar.toml, or a direct
 * integration in this platform's case). An entry with `verified: false` is listed
 * for discoverability and the wallet paints it as unvetted — the two must never be
 * rendered the same way, because the whole point of the list is telling them apart.
 *
 * Everything here was read off Horizon and stellar.expert rather than transcribed
 * from documentation. `npm run assets:verify` re-checks every row against the live
 * network; run it before editing an issuer, and after.
 */

/** The networks the registry covers. Mirrors `StellarNetwork` in config. */
export type RegistryNetwork = 'public' | 'testnet';

/**
 * Issuer behaviour a holder is entitled to know about BEFORE creating a
 * trustline, because neither is reversible from the holder's side.
 *
 * These are read off the issuing account's flags, not asserted by us. They are not
 * a mark against an asset — Circle's USDC sets `authRevocable` and Tether's USDT0
 * sets both, and they are the two largest stablecoins on the network — but a wallet
 * that never surfaces them is hiding the fact that a regulated issuer can freeze or
 * claw back a balance.
 */
export interface IssuerFlags {
  /** The issuer may freeze this trustline (SEP-8 / regulated assets). */
  authRevocable: boolean;
  /** The issuer may claw the balance back out of the holder's account. */
  clawback: boolean;
}

export interface RegistryAsset {
  /** Stellar asset code, 1-12 alphanumeric. `XLM` for the native asset. */
  code: string;
  /** Issuing account, or null for native lumens. */
  issuer: string | null;
  /** Display name, e.g. `USD Coin`. */
  name: string;
  /**
   * WHO issues it, in the user's words — `Circle`, `Tether`, `Aquarius`.
   *
   * This is the field that makes the list worth having. `USDC` tells a user
   * nothing about which of the twenty USDCs they are about to trust; `USDC ·
   * Circle` does, and on testnet — where no issuer publishes a home domain and
   * every candidate is an anonymous `G...` account — it is the only thing that does.
   */
  issuerName: string;
  /**
   * The issuer's published `home_domain`, verbatim, or empty when it publishes
   * none — which includes Tether's USDT0 and every testnet issuer.
   *
   * The invariant is that a non-empty value EQUALS the on-chain home_domain, and
   * `npm run assets:verify` enforces it. Nothing attributed by a third party goes
   * here: an explorer's guess rendered next to a token reads to the user as the
   * issuer's own claim, which is precisely the confusion the registry exists to
   * remove. Put that in a comment on the entry instead.
   */
  issuerDomain: string;
  /** Whether we checked the issuing account against the named organization. */
  verified: boolean;
  /** Stellar Asset Contract id, when the asset has been wrapped for Soroban. */
  contract: string | null;
  flags: IssuerFlags;
}

const NATIVE: RegistryAsset = {
  code: 'XLM',
  issuer: null,
  name: 'Stellar Lumens',
  issuerName: 'Stellar network',
  issuerDomain: 'stellar.org',
  verified: true,
  contract: null,
  flags: { authRevocable: false, clawback: false },
};

/**
 * Mainnet. Trustline counts at the time of verification are in the comments so a
 * later reader can tell a canonical issuer from a squatter that has since grown —
 * the squatters on these codes sit in the hundreds, the real ones in the tens of
 * thousands and up.
 */
const PUBLIC_ASSETS: RegistryAsset[] = [
  NATIVE,
  {
    // 2,390,585 trustlines, home_domain circle.com. The most-held issued asset on
    // the network; every other `USDC` on mainnet is an impostor.
    code: 'USDC',
    issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    name: 'USD Coin',
    issuerName: 'Circle',
    issuerDomain: 'circle.com',
    verified: true,
    contract: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
    flags: { authRevocable: true, clawback: false },
  },
  {
    // Tether's omnichain USDT0. 12,212 trustlines and 12 pools, against 8 issuers
    // squatting the code, none of which clears 300.
    //
    // `issuerDomain` is EMPTY on purpose. The issuing account publishes no
    // `home_domain`; stellar.expert attributes it to usdt0.to, but that is an
    // explorer's judgement and not something the ledger says, and a wallet that
    // rendered it would be showing the user a domain nobody can verify from the
    // chain — the exact move an impostor makes. Identity here rests on the SAC id
    // and the trustline count instead. Both issuer flags are set: Tether can
    // freeze a trustline and claw a balance back.
    code: 'USDT0',
    issuer: 'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q',
    name: 'USDT0',
    issuerName: 'Tether',
    issuerDomain: '',
    verified: true,
    contract: 'CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF',
    flags: { authRevocable: true, clawback: true },
  },
  {
    // 34,568 trustlines, home_domain circle.com. Circle's euro stablecoin.
    code: 'EURC',
    issuer: 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2',
    name: 'Euro Coin',
    issuerName: 'Circle',
    issuerDomain: 'circle.com',
    verified: true,
    contract: 'CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV',
    flags: { authRevocable: true, clawback: false },
  },
  {
    // A SECOND legitimate EURC, from MyKobo (12,806 trustlines, home_domain
    // mykobo.co) — not a clone of the entry above but a different euro token that
    // happens to share the code. It is exactly why `issuerName` is rendered next
    // to every row: with the code alone these two are indistinguishable, and a
    // user swapping into "EURC" would have no way to say which they meant.
    code: 'EURC',
    issuer: 'GAQRF3UGHBT6JYQZ7YSUYCIYWAF4T2SAA5237Q5LIQYJOHHFAWDXZ7NM',
    name: 'Euro Coin',
    issuerName: 'MyKobo',
    issuerDomain: 'mykobo.co',
    verified: true,
    contract: 'CBVDRT5474OBUEXF5MJB3UGQ5CG7CKGCAH5M4RV5NBCDJUBZ5OXHJLOU',
    flags: { authRevocable: false, clawback: false },
  },
  {
    // 191,956 trustlines, 1,308 pools, home_domain aqua.network.
    code: 'AQUA',
    issuer: 'GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA',
    name: 'Aquarius',
    issuerName: 'Aquarius',
    issuerDomain: 'aqua.network',
    verified: true,
    contract: 'CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK',
    flags: { authRevocable: false, clawback: false },
  },
  {
    // 53,878 trustlines, home_domain ultracapital.xyz. Yield-bearing wrapped XLM.
    code: 'yXLM',
    issuer: 'GARDNV3Q7YGT4AKSDF25LT32YSCCW4EV22Y2TV3I2PU2MMXJTEDL5T55',
    name: 'Ultra Stellar XLM',
    issuerName: 'Ultra Capital',
    issuerDomain: 'ultracapital.xyz',
    verified: true,
    contract: 'CBZVSNVB55ANF24QVJL2K5QCLOAB6XITGTGXYEAF6NPTXYKEJUYQOHFC',
    flags: { authRevocable: false, clawback: false },
  },
  {
    // 328,632 trustlines, home_domain pubnet-sep.latamex.com. Argentine peso.
    code: 'ARST',
    issuer: 'GCSAZVWXZKWS4XS223M5F54H2B6XPIIXZZGP7KEAIU6YSL5HDRGCI3DG',
    name: 'Argentine Peso',
    issuerName: 'Latamex',
    issuerDomain: 'pubnet-sep.latamex.com',
    verified: true,
    contract: 'CCRPYMVKZLWGZHEDZ23FOE22E3T3HOCNP5Y2EFZFVRUVIXU5NJ7UNGV2',
    flags: { authRevocable: false, clawback: false },
  },
  {
    // 6,983 trustlines, home_domain ntokens.com. Brazilian real. Listed but NOT
    // verified: stellar.expert rates the domain 0 and the issuer holds both freeze
    // and clawback, so the wallet shows it behind the unvetted warning.
    code: 'BRL',
    issuer: 'GDVKY2GU2DRXWTBEYJJWSFXIGBZV6AZNBVVSUHEPZI54LIS6BA7DVVSP',
    name: 'Brazilian Real',
    issuerName: 'NTokens',
    issuerDomain: 'ntokens.com',
    verified: false,
    contract: 'CBF4E5GSTVSITE5Q2ENOTEUQJPBZAU3SBDVLQMSQ7GLBRTSYGUAT722K',
    flags: { authRevocable: true, clawback: true },
  },
];

/**
 * Testnet. This is where the registry earns its keep: NO testnet issuer publishes
 * a home domain, so every candidate looks identical in an explorer — 13 accounts
 * issue `USDT0` here and not one of them is Tether. Only assets this platform
 * actually integrates against are marked verified; the rest of testnet is
 * deliberately absent rather than guessed at.
 */
const TESTNET_ASSETS: RegistryAsset[] = [
  NATIVE,
  {
    // 64,325 trustlines, home_domain centre.io. Circle's official testnet USDC,
    // and the one their faucet mints.
    code: 'USDC',
    issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    name: 'USD Coin',
    issuerName: 'Circle',
    issuerDomain: 'centre.io',
    verified: true,
    contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    flags: { authRevocable: true, clawback: false },
  },
  {
    // BlindPay's test stablecoin, used by this platform's own fiat on/off-ramp.
    // No home domain — verified because the integration is ours, which is a
    // stronger claim than a DNS record, not a weaker one.
    code: 'USDB',
    issuer: 'GCQSSIMOW5OCGULZATDXKU5MOJBOMFX6G65X6CXZDQ7AIB3SKFUZ67NX',
    name: 'USD BlindPay',
    issuerName: 'BlindPay',
    issuerDomain: '',
    verified: true,
    contract: null,
    flags: { authRevocable: true, clawback: false },
  },
];

export const ASSET_REGISTRY: Record<RegistryNetwork, RegistryAsset[]> = {
  public: PUBLIC_ASSETS,
  testnet: TESTNET_ASSETS,
};

/**
 * Bumped whenever a row above changes.
 *
 * The wallet ships a bundled copy of this registry and prefers whichever of the
 * two is newer, so without a version it has no way to tell an old server (behind
 * a stale CDN edge, say) from a fresh one, and would happily replace a newer
 * bundled list with an older fetched one. A monotonic integer, not a date: it has
 * to be comparable, and two edits on one day are ordinary.
 */
export const ASSET_REGISTRY_VERSION = 1;

/**
 * How long a client may reuse a registry response.
 *
 * Long, because the contents change a handful of times a year while every wallet
 * on the network polls this: an issuer is added, not repriced. The wallet also
 * holds a bundled fallback, so a stale cache degrades to "the newest asset is
 * missing for an hour", never to a broken screen.
 */
export const ASSET_REGISTRY_MAX_AGE_S = 3600;
