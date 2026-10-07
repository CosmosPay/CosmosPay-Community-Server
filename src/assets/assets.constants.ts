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
    // 10,205 trustlines, home_domain token-metadata.paxos.com, listed in its
    // stellar.toml (Paxos Trust Company). PayPal's stablecoin, issued by Paxos.
    // Issuer can freeze and clawback.
    code: 'PYUSD',
    issuer: 'GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5',
    name: 'PayPal USD',
    issuerName: 'Paxos',
    issuerDomain: 'token-metadata.paxos.com',
    verified: true,
    contract: 'CCCRWH6Q3FNP3I2I57BDLM5AFAT7O6OF6GKQOC6SSJNDAVRZ57SPHGU2',
    flags: { authRevocable: true, clawback: true },
  },
  {
    // 3,152 trustlines, home_domain ondo.finance, listed in its stellar.toml
    // (Ondo Finance). Tokenized US Treasuries note. Issuer can freeze and
    // clawback.
    code: 'USDY',
    issuer: 'GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6',
    name: 'Ondo US Dollar Yield',
    issuerName: 'Ondo Finance',
    issuerDomain: 'ondo.finance',
    verified: true,
    contract: 'CB3YA656OYIHU57657I5KGSBRHE5I3OZU4VFC22PYAOANFZHEWNYGAGP',
    flags: { authRevocable: true, clawback: true },
  },
  {
    // 639 trustlines, home_domain app.glodollar.org, listed in its stellar.toml
    // (Glo Development Foundation, Inc). Issuer can freeze and clawback.
    code: 'USDGLO',
    issuer: 'GBBS25EGYQPGEZCGCFBKG4OAGFXU6DSOQBGTHELLJT3HZXZJ34HWS6XV',
    name: 'Glo Dollar',
    issuerName: 'Glo Foundation',
    issuerDomain: 'app.glodollar.org',
    verified: true,
    contract: 'CB226ZOEYXTBPD3QEGABTJYSKZVBP2PASEISLG3SBMTN5CE4QZUVZ3CE',
    flags: { authRevocable: true, clawback: true },
  },
  {
    // 2,314 trustlines, home_domain stablecoin.z.com, listed in its stellar.toml
    // (GMO-Z.com Trust Company, Inc.). Japanese yen stablecoin. Issuer can freeze
    // and clawback.
    code: 'GYEN',
    issuer: 'GDF6VOEGRWLOZ64PQQGKD2IYWA22RLT37GJKS2EJXZHT2VLAGWLC5TOB',
    name: 'GYEN',
    issuerName: 'GMO Trust',
    issuerDomain: 'stablecoin.z.com',
    verified: true,
    contract: 'CA67EQNWGPGXHVT6E4HQ65WEV54KFDB6HJDHVCJM33VKZ7XKR5MN3KPJ',
    flags: { authRevocable: true, clawback: true },
  },
  {
    // 1,507 trustlines, home_domain audd.digital, listed in its stellar.toml
    // (AUDC PTY LTD). Australian dollar stablecoin.
    code: 'AUDD',
    issuer: 'GDC7X2MXTYSAKUUGAIQ7J7RPEIM7GXSAIWFYWWH4GLNFECQVJJLB2EEU',
    name: 'AUDD',
    issuerName: 'AUDD',
    issuerDomain: 'audd.digital',
    verified: true,
    contract: 'CACXKRVCW7I6CWX6RS6ANFDKVCOUI2PB6LTDUROL3J3FMJCRZ4ZLQRF6',
    flags: { authRevocable: false, clawback: false },
  },
  {
    // 139 trustlines, home_domain vnx.io, listed in its stellar.toml (VNX Global
    // Ltd.). Issuer can freeze and clawback.
    code: 'VCHF',
    issuer: 'GDXLSLCOPPHTWOQXLLKSVN4VN3G67WD2ENU7UMVAROEYVJLSPSEWXIZN',
    name: 'VNX Swiss Franc',
    issuerName: 'VNX',
    issuerDomain: 'vnx.io',
    verified: true,
    contract: null,
    flags: { authRevocable: true, clawback: true },
  },
  {
    // 181,450 trustlines, home_domain zeam.money, listed in its stellar.toml
    // (ZEAM LIMITED). South African rand stablecoin. Issuer can freeze and
    // clawback.
    code: 'ZARZ',
    issuer: 'GAROH4EV3WVVTRQKEY43GZK3XSRBEYETRVZ7SVG5LHWOAANSMCTJBB3U',
    name: 'ZARZ',
    issuerName: 'ZEAM',
    issuerDomain: 'zeam.money',
    verified: true,
    contract: null,
    flags: { authRevocable: true, clawback: true },
  },
  {
    // 181,083 trustlines, home_domain zeam.money, listed in its stellar.toml
    // (ZEAM LIMITED). Issuer can freeze and clawback.
    code: 'USDZ',
    issuer: 'GAKTLPC4ZV37SSCITQ5IS5AQ4WPF4CF4VZJQPPAROSGXMYOATF5U6XPR',
    name: 'USDZ',
    issuerName: 'ZEAM',
    issuerDomain: 'zeam.money',
    verified: true,
    contract: null,
    flags: { authRevocable: true, clawback: true },
  },
  {
    // 6,341 trustlines, home_domain ngnc.online, listed in its stellar.toml
    // (LINK.IO LTD.). Nigerian naira stablecoin.
    code: 'NGNC',
    issuer: 'GASBV6W7GGED66MXEVC7YZHTWWYMSVYEY35USF2HJZBLABLYIFQGXZY6',
    name: 'NGN Coin',
    issuerName: 'LINK',
    issuerDomain: 'ngnc.online',
    verified: true,
    contract: 'CBYFV4W2LTMXYZ3XWFX5BK2BY255DU2DSXNAE4FJ5A5VYUWGIBJDOIGG',
    flags: { authRevocable: false, clawback: false },
  },
  {
    // 38,525 trustlines, home_domain api.anclap.com, listed in its stellar.toml
    // (Grupo Anchor S.A.). Anclap anchor, LatAm on/off-ramp.
    code: 'ARS',
    issuer: 'GCYE7C77EB5AWAA25R5XMWNI2EDOKTTFTTPZKM2SR5DI4B4WFD52DARS',
    name: 'Argentine Peso',
    issuerName: 'Anclap',
    issuerDomain: 'api.anclap.com',
    verified: true,
    contract: null,
    flags: { authRevocable: false, clawback: false },
  },
  {
    // 41,413 trustlines, home_domain api.anclap.com, listed in its stellar.toml
    // (Grupo Anchor S.A.).
    code: 'PEN',
    issuer: 'GA4TDPNUCZPTOHB3TKUYMDCRVATXKEADH7ZEYEBWJKQKE2UBFCYNBPEN',
    name: 'Peruvian Sol',
    issuerName: 'Anclap',
    issuerDomain: 'api.anclap.com',
    verified: true,
    contract: 'CCFS6UDFSR5OJIN45RQPUCZ5JTTU5TQOTIS6XKYKNWKC4TVR752BOWOF',
    flags: { authRevocable: false, clawback: false },
  },
  {
    // 5,781 trustlines, home_domain clpx.finance, listed in its stellar.toml
    // (CLPX S.A.).
    code: 'CLPX',
    issuer: 'GDYSPBVZHPQTYMGSYNOHRZQNLB3ZWFVQ2F7EP7YBOLRGD42XIC3QUX5G',
    name: 'Chilean Peso',
    issuerName: 'CLPX',
    issuerDomain: 'clpx.finance',
    verified: true,
    contract: null,
    flags: { authRevocable: false, clawback: false },
  },
  {
    // 1,175 trustlines, home_domain etherfuse.com, listed in its stellar.toml
    // (Etherfuse). Tokenized Mexican treasury bills. Issuer can freeze and
    // clawback.
    code: 'CETES',
    issuer: 'GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC',
    name: 'Etherfuse CETES',
    issuerName: 'Etherfuse',
    issuerDomain: 'etherfuse.com',
    verified: true,
    contract: 'CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV',
    flags: { authRevocable: true, clawback: true },
  },
  {
    // 937 trustlines, home_domain etherfuse.com, listed in its stellar.toml
    // (Etherfuse). Issuer can freeze and clawback.
    code: 'USTRY',
    issuer: 'GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC',
    name: 'Etherfuse US Treasury',
    issuerName: 'Etherfuse',
    issuerDomain: 'etherfuse.com',
    verified: true,
    contract: 'CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR',
    flags: { authRevocable: true, clawback: true },
  },
  {
    // 193 trustlines, home_domain etherfuse.com, listed in its stellar.toml
    // (Etherfuse). Tokenized Brazilian treasury bonds. Issuer can freeze and
    // clawback.
    code: 'TESOURO',
    issuer: 'GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC',
    name: 'Etherfuse Tesouro',
    issuerName: 'Etherfuse',
    issuerDomain: 'etherfuse.com',
    verified: true,
    contract: 'CD6M4R2322BYCY2LNWM74PEBQAQ63SA3DUJLI3L4225U4ZVCLMSCBCIS',
    flags: { authRevocable: true, clawback: true },
  },
  {
    // 46 trustlines, home_domain etherfuse.com, listed in its stellar.toml
    // (Etherfuse). Issuer can freeze and clawback.
    code: 'KTB',
    issuer: 'GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC',
    name: 'Etherfuse KTB',
    issuerName: 'Etherfuse',
    issuerDomain: 'etherfuse.com',
    verified: true,
    contract: 'CBAECV6UVDS6ZKPMC63MUYY4V7Q3KTHR7NLUFGVVGK7K3AQT475QTETP',
    flags: { authRevocable: true, clawback: true },
  },
  {
    // 34,859 trustlines, home_domain ultracapital.xyz, listed in its stellar.toml
    // (Ultra Capital LLC). Yield-bearing wrapped USDC.
    code: 'yUSDC',
    issuer: 'GDGTVWSM4MGS4T7Z6W4RPWOCHE2I6RDFCIFZGS3DOA63LWQTRNZNTTFF',
    name: 'Ultra Stellar USDC',
    issuerName: 'Ultra Capital',
    issuerDomain: 'ultracapital.xyz',
    verified: true,
    contract: 'CDOFW7HNKLUZRLFZST4EW7V3AV4JI5IHMT6BPXXSY2IEFZ4NE5TWU2P4',
    flags: { authRevocable: false, clawback: false },
  },
  {
    // 4,642 trustlines, home_domain ultracapital.xyz, listed in its stellar.toml
    // (Ultra Capital LLC).
    code: 'yBTC',
    issuer: 'GBUVRNH4RW4VLHP4C5MOF46RRIRZLAVHYGX45MVSTKA2F6TMR7E7L6NW',
    name: 'Ultra Stellar BTC',
    issuerName: 'Ultra Capital',
    issuerDomain: 'ultracapital.xyz',
    verified: true,
    contract: 'CB2XMFB6BDIHFOSFB5IXHDOYV3SI3IXMNIZLPDZHC7ENDCXSBEBZAO2Y',
    flags: { authRevocable: false, clawback: false },
  },
  {
    // 4,256 trustlines, home_domain ultracapital.xyz, listed in its stellar.toml
    // (Ultra Capital LLC).
    code: 'yETH',
    issuer: 'GDYQNEF2UWTK4L6HITMT53MZ6F5QWO3Q4UVE6SCGC4OMEQIZQQDERQFD',
    name: 'Ultra Stellar ETH',
    issuerName: 'Ultra Capital',
    issuerDomain: 'ultracapital.xyz',
    verified: true,
    contract: 'CDYEOOVL6WV4JRY45CXQKOBJFFAPOM5KNQCCDNM333L6RM2L4RO3LKYG',
    flags: { authRevocable: false, clawback: false },
  },
  {
    // 19,749 trustlines, home_domain ultracapital.xyz, listed in its stellar.toml
    // (Ultra Capital LLC). Ultra Capital wrapped BTC (not Stellarport's defunct
    // BTC).
    code: 'BTC',
    issuer: 'GDPJALI4AZKUU2W426U5WKMAT6CN3AJRPIIRYR2YM54TL2GDWO5O2MZM',
    name: 'Bitcoin',
    issuerName: 'Ultra Capital',
    issuerDomain: 'ultracapital.xyz',
    verified: true,
    contract: 'CAO7DDJNGMOYQPRYDY5JVZ5YEK4UQBSMGLAEWRCUOTRMDSBMGWSAATDZ',
    flags: { authRevocable: false, clawback: false },
  },
  {
    // 16,191 trustlines, home_domain ultracapital.xyz, listed in its stellar.toml
    // (Ultra Capital LLC).
    code: 'ETH',
    issuer: 'GBFXOHVAS43OIWNIO7XLRJAHT3BICFEIKOJLZVXNT572MISM4CMGSOCC',
    name: 'Ethereum',
    issuerName: 'Ultra Capital',
    issuerDomain: 'ultracapital.xyz',
    verified: true,
    contract: 'CBH4M45TQBLDPXOK6L7VYKMEJWFITBOL64BN3WDAIIDT4LNUTWTTOCKF',
    flags: { authRevocable: false, clawback: false },
  },
  {
    // 57,343 trustlines, home_domain fchain.io, listed in its stellar.toml (Muyu
    // Network). Fchain-bridged XRP.
    code: 'XRP',
    issuer: 'GBXRPL45NPHCVMFFAYZVUVFFVKSIZ362ZXFP7I2ETNQ3QKZMFLPRDTD5',
    name: 'XRP',
    issuerName: 'Fchain',
    issuerDomain: 'fchain.io',
    verified: true,
    contract: 'CAAV3AE3VKD2P4TY7LWTQMMJHIJ4WOCZ5ANCIJPC3NRSERKVXNHBU2W7',
    flags: { authRevocable: false, clawback: false },
  },
  {
    // 93,285 trustlines, home_domain stronghold.co, listed in its stellar.toml
    // (Stronghold).
    code: 'SHX',
    issuer: 'GDSTRSHXHGJ7ZIVRBXEYE5Q74XUVCUSEKEBR7UCHEUUEK72N7I7KJ6JH',
    name: 'Stronghold SHx',
    issuerName: 'Stronghold',
    issuerDomain: 'stronghold.co',
    verified: true,
    contract: 'CCKCKCPHYVXQD4NECBFJTFSCU2AMSJGCNG4O6K4JVRE2BLPR7WNDBQIQ',
    flags: { authRevocable: false, clawback: false },
  },
  {
    // 38,315 trustlines, home_domain mobius.network, listed in its stellar.toml
    // (Mochi, Inc.).
    code: 'MOBI',
    issuer: 'GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH',
    name: 'Mobius',
    issuerName: 'Mobius',
    issuerDomain: 'mobius.network',
    verified: true,
    contract: null,
    flags: { authRevocable: false, clawback: false },
  },
  {
    // 38,271 trustlines, home_domain afreum.com, listed in its stellar.toml
    // (Afreum DAO).
    code: 'AFR',
    issuer: 'GBX6YI45VU7WNAAKA3RBFDR3I3UKNFHTJPQ5F6KOOKSGYIAM4TRQN54W',
    name: 'Afreum',
    issuerName: 'Afreum',
    issuerDomain: 'afreum.com',
    verified: true,
    contract: 'CCG27OZ5AV4WUXS6XTECWAXEY5UOMEFI2CWFA3LHZGBTLYZWTJF3MJYQ',
    flags: { authRevocable: false, clawback: false },
  },
  {
    // 20,123 trustlines, home_domain threefold.io, listed in its stellar.toml
    // (Threefold foundation).
    code: 'TFT',
    issuer: 'GBOVQKJYHXRR3DX6NOX2RRYFRCUMSADGDESTDNBDS6CDVLGVESRTAC47',
    name: 'ThreeFold Token',
    issuerName: 'ThreeFold',
    issuerDomain: 'threefold.io',
    verified: true,
    contract: 'CCXY3CNHSU2DPUOZFKNNH67IVRMBRCATX4SABDSLBY5LAJI66LRLHTJQ',
    flags: { authRevocable: false, clawback: false },
  },
  {
    // 19,549 trustlines, home_domain lumenswap.io, listed in its stellar.toml
    // (Lumenswap LLC).
    code: 'LSP',
    issuer: 'GAB7STHVD5BDH3EEYXPI3OM7PCS4V443PYB5FNT6CFGJVPDLMKDM24WK',
    name: 'Lumenswap',
    issuerName: 'Lumenswap',
    issuerDomain: 'lumenswap.io',
    verified: true,
    contract: 'CBXE6V454EUYWVQCI4TCSOG4CSNPQ2BLYOTKAKXYFHO3KNVX4CXYCY2T',
    flags: { authRevocable: false, clawback: false },
  },
  {
    // 11,286 trustlines, home_domain kalepail.com, listed in its stellar.toml
    // (The KALEpail Project). Proof-of-teamwork Soroban farming token.
    code: 'KALE',
    issuer: 'GBDVX4VELCDSQ54KQJYTNHXAHFLBCA77ZY2USQBM4CSHTTV7DME7KALE',
    name: 'KALE',
    issuerName: 'KALEpail',
    issuerDomain: 'kalepail.com',
    verified: true,
    contract: 'CB23WRDQWGSP6YPMY4UV5C4OW5CBTXKYN3XEATG7KJEZCXMJBYEHOUOV',
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
  {
    // 42,378 trustlines. Listed but NOT verified: the issuer publishes no
    // home_domain, so nothing on-chain ties it to Velo.
    code: 'VELO',
    issuer: 'GDM4RQUQQUVSKQA7S6EM7XBZP3FCGH4Q7CL6TABQ7B2BEJ5ERARM2M5M',
    name: 'Velo',
    issuerName: 'Velo',
    issuerDomain: '',
    verified: false,
    contract: 'CAESLMGW5LYTIEJI7FJHK6SFSWRELLNVX5Q4WR4UZEALMTRWQDBKDPAG',
    flags: { authRevocable: false, clawback: false },
  },
];

/**
 * Testnet. This is where the registry earns its keep: apart from Circle, testnet
 * issuers publish no home domain, so every candidate looks identical in an
 * explorer — 13 accounts issue `USDT0` here and not one of them is Tether. Only assets this platform
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
    // 3,460 trustlines, home_domain circle.com. Circle's official testnet EURC,
    // the counterpart of the mainnet entry and minted by their faucet.
    code: 'EURC',
    issuer: 'GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO',
    name: 'Euro Coin',
    issuerName: 'Circle',
    issuerDomain: 'circle.com',
    verified: true,
    contract: 'CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ',
    flags: { authRevocable: false, clawback: false },
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
export const ASSET_REGISTRY_VERSION = 2;

/**
 * How long a client may reuse a registry response.
 *
 * Long, because the contents change a handful of times a year while every wallet
 * on the network polls this: an issuer is added, not repriced. The wallet also
 * holds a bundled fallback, so a stale cache degrades to "the newest asset is
 * missing for an hour", never to a broken screen.
 */
export const ASSET_REGISTRY_MAX_AGE_S = 3600;
