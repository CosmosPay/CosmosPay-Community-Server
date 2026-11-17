import type { PaymentNetwork } from '@/payment-intents/payment-networks';

/**
 * Sandbox settlement: payment links on the networks paid through deposit
 * addresses, on their TEST networks, for `dev` keys. The cross-chain route has
 * no test network, so this service settles them itself: a deposit address per
 * payment derived from a sandbox seed, an observer that reads the payer's
 * deposit on the origin test network, and a treasury that pays the merchant on
 * the link's test network. Same `payment_deposit` rows, statuses and webhooks
 * as on mainnet.
 *
 * Only stablecoins move, one for one: there is no test-network price for
 * anything else, and a sandbox must not invent one.
 */

/** Who issues a sandbox stablecoin: Circle's own test USDC, or our cUSD. */
export type SandboxStablecoinIssuer = 'circle' | 'cusd';

/** The test stablecoin of a network the sandbox settles on. */
export interface SandboxStablecoin {
  symbol: string;
  decimals: number;
  issuer: SandboxStablecoinIssuer;
  /**
   * How the network names Circle's test USDC: an ERC-20 contract, an XRP
   * Ledger issuer, a NEAR contract account, a Sui coin type, an Aptos metadata
   * object. From Circle's published list and checked on-chain (symbol USDC,
   * 6 decimals). Null for cUSD: deployed by `npm run sandbox:deploy-cusd`,
   * configured in `SANDBOX_CUSD_ADDRESSES`.
   */
  contract: string | null;
}

/** What every network the sandbox settles on declares. */
export interface SandboxNetworkCommon {
  /** The test network's own name (`Sepolia`, `XRP Ledger Testnet`). */
  testnetName: string;
  /** A public node, overridable per network (`SANDBOX_RPC_URLS`). */
  defaultRpcUrl: string;
  /** Transaction explorer, `<base><hash>`. */
  explorerTx: string;
  stablecoin: SandboxStablecoin;
}

/** An EVM test network the sandbox settles on. */
export interface SandboxEvmNetwork extends SandboxNetworkCommon {
  kind: 'evm';
  /**
   * EIP-155 id. Checked against chainlist (chainid.network/chains.json) AND the
   * network's `eth_chainId` on 2026-11-16; the client checks it again before
   * trusting a node, so a node on another chain (mainnet above all) is refused.
   */
  chainId: number;
}

/** A network the sandbox does not settle on, and why. */
export interface SandboxUnavailableNetwork {
  kind: 'unavailable';
  reason: string;
}

/**
 * Every kind of test network the sandbox settles on, each with its own
 * `SandboxLedger` (`SandboxLedgers` holds one per kind).
 */
export type SandboxSettledNetwork = SandboxEvmNetwork;

/** Which ledger implementation a settled network uses. */
export type SandboxLedgerKind = SandboxSettledNetwork['kind'];

export type SandboxNetwork = SandboxSettledNetwork | SandboxUnavailableNetwork;

const circleUsdc = (contract: string) => ({
  symbol: 'USDC',
  decimals: 6,
  issuer: 'circle' as const,
  contract,
});

/** Our own test stablecoin, where no official test USDC exists. */
export const SANDBOX_CUSD_SYMBOL = 'cUSD';
export const SANDBOX_CUSD_DECIMALS = 6;
const cusd = {
  symbol: SANDBOX_CUSD_SYMBOL,
  decimals: SANDBOX_CUSD_DECIMALS,
  issuer: 'cusd' as const,
  contract: null,
};

const evm = (
  testnetName: string,
  chainId: number,
  defaultRpcUrl: string,
  explorerTx: string,
  stablecoin: SandboxStablecoin,
): SandboxEvmNetwork => ({
  kind: 'evm',
  testnetName,
  chainId,
  defaultRpcUrl,
  explorerTx,
  stablecoin,
});

const notYet = (detail: string): SandboxUnavailableNetwork => ({
  kind: 'unavailable',
  reason: `The sandbox does not settle on this network yet: ${detail}`,
});

/**
 * Every payment network, by what the sandbox does on its test network. A
 * `Record` over `PaymentNetwork`, so a network added to the list does not
 * compile until it says.
 *
 * Stellar, Solana and Monad links are paid natively in the sandbox, as on
 * mainnet; Monad's test network is also an ORIGIN here (a payer pays a Base
 * Sepolia link from Monad testnet USDC). The other EVM networks are one shared
 * path: an HD deposit address, an ERC-20 balance read, an ERC-20 payout.
 */
export const SANDBOX_NETWORKS: Record<PaymentNetwork, SandboxNetwork> = {
  stellar: notYet(
    'Stellar links are paid natively on its test network; paying them from another test network is a follow-up.',
  ),
  solana: notYet(
    'Solana links are paid natively on devnet; paying them from another test network is a follow-up.',
  ),
  monad: evm(
    'Monad Testnet',
    10143,
    'https://testnet-rpc.monad.xyz',
    'https://testnet.monadexplorer.com/tx/',
    circleUsdc('0x534b2f3A21130d7a60830c2Df862319e593943A3'),
  ),
  eth: evm(
    'Sepolia',
    11155111,
    'https://ethereum-sepolia-rpc.publicnode.com',
    'https://sepolia.etherscan.io/tx/',
    circleUsdc('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'),
  ),
  base: evm(
    'Base Sepolia',
    84532,
    'https://sepolia.base.org',
    'https://sepolia.basescan.org/tx/',
    circleUsdc('0x036CbD53842c5426634e7929541eC2318f3dCF7e'),
  ),
  arb: evm(
    'Arbitrum Sepolia',
    421614,
    'https://sepolia-rollup.arbitrum.io/rpc',
    'https://sepolia.arbiscan.io/tx/',
    circleUsdc('0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d'),
  ),
  op: evm(
    'OP Sepolia',
    11155420,
    'https://sepolia.optimism.io',
    'https://sepolia-optimism.etherscan.io/tx/',
    circleUsdc('0x5fd84259d66Cd46123540766Be93DFE6D43130D7'),
  ),
  bsc: evm(
    'BNB Smart Chain Testnet',
    97,
    'https://bsc-testnet-rpc.publicnode.com',
    'https://testnet.bscscan.com/tx/',
    cusd,
  ),
  pol: evm(
    'Polygon Amoy',
    80002,
    'https://polygon-amoy-bor-rpc.publicnode.com',
    'https://amoy.polygonscan.com/tx/',
    circleUsdc('0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582'),
  ),
  avax: evm(
    'Avalanche Fuji',
    43113,
    'https://api.avax-test.network/ext/bc/C/rpc',
    'https://testnet.snowtrace.io/tx/',
    circleUsdc('0x5425890298aed601595a70AB815c96711a31Bc65'),
  ),
  gnosis: evm(
    'Gnosis Chiado',
    10200,
    'https://rpc.chiadochain.net',
    'https://gnosis-chiado.blockscout.com/tx/',
    cusd,
  ),
  bera: evm(
    'Berachain Bepolia',
    80069,
    'https://bepolia.rpc.berachain.com',
    'https://testnet.berascan.com/tx/',
    cusd,
  ),
  // The public RPC answered 526 on 2026-11-16 (chain id taken from chainlist);
  // point SANDBOX_RPC_URLS at a working Scroll Sepolia node.
  scroll: evm(
    'Scroll Sepolia',
    534351,
    'https://sepolia-rpc.scroll.io',
    'https://sepolia.scrollscan.com/tx/',
    cusd,
  ),
  xlayer: evm(
    'X Layer Testnet',
    1952,
    'https://testrpc.xlayer.tech',
    'https://www.oklink.com/xlayer-test/tx/',
    circleUsdc('0xDec90b78111Ba2fc6FC6d84d8B9ec159A2d4b9B3'),
  ),
  abs: notYet(
    'Abstract runs EraVM, so a test stablecoin needs an EraVM build, and no official test USDC is listed there.',
  ),
  plasma: evm(
    'Plasma Testnet',
    9746,
    'https://testnet-rpc.plasma.to',
    'https://testnet.plasmascan.to/tx/',
    circleUsdc('0xE67Fb267022cBA8064Dd388CC2FED724F3120D9D'),
  ),
  hood: evm(
    'Robinhood Chain Testnet',
    46630,
    'https://rpc.testnet.chain.robinhood.com/rpc',
    'https://explorer.testnet.chain.robinhood.com/tx/',
    cusd,
  ),
  hypercore: notYet(
    'HyperCore is not an EVM chain a deposit address can be paid on.',
  ),
  btc: notYet('it needs a UTXO deposit and payout path (follow-up).'),
  ltc: notYet('it needs a UTXO deposit and payout path (follow-up).'),
  doge: notYet('it needs a UTXO deposit and payout path (follow-up).'),
  bch: notYet('it needs a UTXO deposit and payout path (follow-up).'),
  dash: notYet('it needs a UTXO deposit and payout path (follow-up).'),
  zec: notYet('it needs a UTXO deposit and payout path (follow-up).'),
  xrp: notYet(
    'an XRP Ledger path is a follow-up (an official test USDC exists there).',
  ),
  tron: notYet('a Tron path is a follow-up (needs its own test stablecoin).'),
  ton: notYet('a TON path is a follow-up (needs its own test stablecoin).'),
  near: notYet(
    'a NEAR path is a follow-up (an official test USDC exists there).',
  ),
  sui: notYet(
    'a Sui path is a follow-up (an official test USDC exists there).',
  ),
  aptos: notYet(
    'an Aptos path is a follow-up (an official test USDC exists there).',
  ),
  movement: notYet('a Movement path is a follow-up.'),
  starknet: notYet(
    'a Starknet path is a follow-up (an official test USDC exists there).',
  ),
  cardano: notYet('a Cardano path is a follow-up.'),
  aleo: notYet('an Aleo path is a follow-up.'),
  fogo: notYet('a Fogo path is a follow-up.'),
};

/**
 * BIP-44 style prefix of every deposit address path: m / 44' / 60' / 7007' /
 * a' / b'. Coin type 60 (EVM keys), account 7007 for sandbox deposits, and two
 * hardened indexes drawn at random per deposit (62 bits), so no counter is
 * shared between replicas and two deposits meeting on one address is a 2^-62
 * event (the `(depositAddress, depositMemo)` index refuses it anyway).
 */
export const SANDBOX_DEPOSIT_PATH_PREFIX = [44, 60, 7007] as const;

/**
 * The account index every sandbox deposit path uses after its coin type
 * (`m/44'/<coin>'/7007'/a'/b'`). Ed25519 networks (NEAR, Sui, Aptos) derive
 * their deposit keys with SLIP-0010 under their own SLIP-44 coin type, so a
 * key is recoverable from the seed with any SLIP-0010 tool.
 */
export const SANDBOX_DEPOSIT_ACCOUNT_INDEX = 7007;

/**
 * HKDF salt for the treasury's keys on networks whose curve is not the EVM
 * one: each is HKDF-SHA256(SANDBOX_TREASURY_PRIVATE_KEY, salt, info
 * `treasury:<network>`), so one configured secret yields one independent key
 * per network and no new variable is needed. Changing either string moves
 * every non-EVM treasury to a new address.
 */
export const SANDBOX_TREASURY_KDF_SALT = 'cosmos-pay sandbox treasury v1';

/**
 * Gas limit for an ERC-20 transfer when the node cannot estimate one. A
 * standard transfer costs about 35-65k; this leaves room for tokens that
 * write more (and is only the cap: unused gas is not paid).
 */
export const SANDBOX_TRANSFER_GAS_FALLBACK = 120_000n;

/** Seconds a sandbox deposit address accepts a deposit, as on mainnet. */
export const SANDBOX_DEPOSIT_DEADLINE_SECONDS = 30 * 60;

/** Estimated seconds from a confirmed deposit to the merchant's payout. */
export const SANDBOX_TIME_ESTIMATE_SECONDS = 30;

/**
 * Prefix of a sandbox deposit's correlation id (the rest is its HD path), so
 * a sandbox row is never mistaken for one the cross-chain route made.
 */
export const SANDBOX_CORRELATION_PREFIX = 'sandbox:';

/**
 * Why a link with a merchant fee is refused in the sandbox. On mainnet the fee
 * is the route's own app fee, credited to an account inside the route (often a
 * NEAR account id the sandbox cannot pay on a test network), so the sandbox
 * does not pretend to settle it: a follow-up pays it from the treasury where
 * the account is an EVM address.
 */
export const SANDBOX_MERCHANT_FEE_REFUSAL =
  'A payment link with a merchant fee is not settled in the sandbox yet: create it without merchantFee on a dev key, or use a prod key.';
