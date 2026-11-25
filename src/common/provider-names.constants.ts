/**
 * The provider names nothing a client receives may carry, and what stands in
 * for each (`src/common/provider-names.ts` says why and where it is applied).
 *
 * Display casing only (`BlindPay`, not `blindpay`): an identifier quoted in a
 * description (`blindpayId`, `transfers_bitso`) is the published contract and
 * is left alone. English words that are also provider names (Abroad, Defuse,
 * Circle) are not here: they would rewrite ordinary sentences.
 */

/** One provider: how it is written in prose, and what replaces it in a sentence. */
export interface ProviderTerm {
  /** The name as prose writes it; a space matches any run of whitespace. */
  readonly name: string;
  /** Stands for the provider on its own ("the cross-chain route refused …"). */
  readonly noun: string;
  /** Stands for it after a determiner, before a noun ("a cross-chain deposit address"). */
  readonly adjective: string;
}

/**
 * Longer names before the shorter ones they contain ("LayerZero Scan" before
 * "LayerZero", "Kuru Flow" before "Kuru"), so the longer one is replaced whole.
 * The nouns are the same words the developer platform's copy uses for each.
 */
export const PROVIDER_TERMS: readonly ProviderTerm[] = [
  {
    name: 'NEAR Intents',
    noun: 'the cross-chain route',
    adjective: 'cross-chain',
  },
  { name: '1Click', noun: 'the cross-chain route', adjective: 'cross-chain' },
  { name: 'BlindPay', noun: 'the fiat partner', adjective: 'fiat partner' },
  {
    name: 'El Dorado',
    noun: 'the P2P marketplace',
    adjective: 'P2P marketplace',
  },
  { name: 'Kuru Flow', noun: 'the Monad swap route', adjective: 'Monad swap' },
  { name: 'Kuru', noun: 'the Monad swap route', adjective: 'Monad swap' },
  { name: 'Jupiter', noun: 'the Solana swap route', adjective: 'Solana swap' },
  {
    name: 'LayerZero Scan',
    noun: 'the bridge explorer',
    adjective: 'bridge explorer',
  },
  { name: 'LayerZero', noun: 'the bridge', adjective: 'bridge' },
  { name: 'OFT', noun: 'the bridge contract', adjective: 'bridge contract' },
  { name: 'DeFindex', noun: 'the vault protocol', adjective: 'vault' },
  {
    name: 'Trustless Work',
    noun: 'the protected-payments service',
    adjective: 'protected-payment',
  },
  {
    name: 'Bitso',
    noun: 'the local payout partner',
    adjective: 'local partner',
  },
  {
    name: 'Soroswap',
    noun: 'the Stellar swap route',
    adjective: 'Stellar swap',
  },
  { name: 'Allbridge', noun: 'the bridge', adjective: 'bridge' },
  { name: 'Stargate', noun: 'the bridge', adjective: 'bridge' },
  { name: 'CCTP', noun: 'the USDC bridge', adjective: 'USDC bridge' },
  { name: 'OpenZeppelin', noun: 'the contract library', adjective: 'audited' },
  { name: 'Sub Rosa', noun: 'the RFQ plugin', adjective: 'RFQ' },
  { name: 'Anclap', noun: 'the anchor', adjective: 'anchor' },
  {
    name: 'Koywe',
    noun: 'the bank transfer partner',
    adjective: 'bank transfer',
  },
];

/**
 * Nouns that, right after a provider's name, make the name an adjective:
 * "inbound BlindPay webhooks" reads "inbound fiat partner webhooks", not
 * "inbound the fiat partner webhooks".
 */
export const PROVIDER_ATTRIBUTIVE_NOUNS: readonly string[] = [
  'webhooks?',
  'instances?',
  'API',
  'call',
  'codes?',
  'ids?',
  'quote',
  'deposits?',
  'addresse?s?',
  'accounts?',
  'status(?:es)?',
  'endpoints?',
  'fees?',
  'contracts?',
  'transactions?',
  'failures?',
  'request',
  'errors?',
  'keys?',
  'receivers?',
  'payouts?',
  'payins?',
  'orders?',
  'sandbox',
  'environments?',
  'tokens?',
  'list',
  'fields?',
  'rails?',
  'documents?',
  'sessions?',
  'widget',
  'credentials?',
  'limits?',
  'minimums?',
  'maximums?',
  'routers?',
  'messages?',
  'simulation',
  'swap',
  'vaults?',
  'terms',
  'page',
  'hosted',
  'responses?',
  'body',
  'answer',
];

/** Phrases a word-for-word swap reads badly in, rewritten before the table. */
export const PROVIDER_PHRASES: readonly (readonly [RegExp, string])[] = [
  [/\b(?:USDT0['’]s )?LayerZero(?:['’]s)? OFT contract\b/g, 'bridge contract'],
  [/\b(Solana) (?:via|through) Jupiter\b/g, '$1'],
  [/\b(Monad) (?:via|through) Kuru Flow\b/g, '$1'],
  [
    /\bNEAR Intents['’] current reference price\b/g,
    'the current market reference price',
  ],
  [/\bNEAR Intents['’] current price\b/g, 'the current market price'],
  [/\bNEAR Intents['’] prices\b/g, 'the market reference prices'],
  [/\bBlindPay partner\b/g, 'partner'],
  [/\bOFT contract\b/g, 'bridge contract'],
  [/\bDeFindex yield vaults\b/g, 'yield vaults'],
  [/\bDeFindex vault(s?)\b/g, 'yield vault$1'],
  [/\bJupiter['’]s route\b/g, 'the Solana swap route'],
  [/\bUSDT0['’]s LayerZero OFT\b/g, 'the USDT0 bridge contract'],
  [/\bLayerZero(?:['’]s)? OFT(?: adapter)?\b/g, 'bridge contract'],
  [/\bUSDT0['’]s OFT\b/g, 'the USDT0 bridge contract'],
  [/\bUSDT0 OFT['’]s\b/g, 'USDT0 bridge contract’s'],
  [/\bOFT adapter\b/g, 'bridge adapter'],
];

/**
 * An env var whose name carries a provider's (`NEAR_INTENTS_API_KEY`,
 * `KURU_MERCHANT_FEE_ROUTER`): an operator reads it in the logs, a client never.
 */
export const PROVIDER_ENV_VAR =
  /\b[A-Z0-9_]*(?:BLINDPAY|NEAR_INTENTS|ONECLICK|KURU|JUPITER|TRUSTLESS_WORK|DEFINDEX|ELDORADO|LAYERZERO|BITSO|SOROSWAP|ALLBRIDGE)[A-Z0-9_]*\b/g;

/** A provider's domain in a text it answered with (`docs.blindpay.com/…`), dropped before relaying it. */
export const PROVIDER_DOMAIN =
  /\b[\w.-]*(?:blindpay|defindex|trustlesswork|kuru|jup|layerzero|eldorado|chaindefuser|nearintents|near-intents|defuse)[\w.-]*\.(?:com|io|ag|xyz|finance|org|net|dev|app)\b\S*/gi;

/** What an env var named after a provider becomes in a message. */
export const PROVIDER_ENV_VAR_STANDIN = 'this deployment’s configuration';
