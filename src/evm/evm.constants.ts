import type { StellarNetwork } from '@/config/configuration';
import { MONAD_CHAIN_IDS } from '@/chains/chains.constants';

/** The EVM chains this service speaks. Monad today; one entry per chain. */
export const EVM_CHAINS = ['monad'] as const;
export type EvmChain = (typeof EVM_CHAINS)[number];

/** Each EVM chain's EIP-155 ids, per network tier. */
export const EVM_CHAIN_IDS: Record<EvmChain, Record<StellarNetwork, number>> = {
  monad: MONAD_CHAIN_IDS,
};

/** Display name, for the errors a caller sees ("Monad RPC is unreachable"). */
export const EVM_PROVIDER_NAMES: Record<EvmChain, string> = {
  monad: 'Monad',
};

/** `keccak256("Transfer(address,address,uint256)")` — the ERC-20 transfer log. */
export const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** `transfer(address,uint256)` — how an ERC-20 payment's calldata begins. */
export const ERC20_TRANSFER_SELECTOR = '0xa9059cbb';

/** `decimals()` selector. */
export const ERC20_DECIMALS_SELECTOR = '0x313ce567';

/** The URI scheme of an EIP-681 payment request. */
export const EIP681_SCHEME = 'ethereum:';

/**
 * `eth_getLogs` calls one observer tick may spend on one intent. With the
 * public RPC's 100-block cap and Monad's ~0.4 s blocks that is ~200 s of chain
 * per tick: enough to keep up at the default 15 s interval and to catch up a
 * backlog over a few ticks without letting one intent own the sweep.
 */
export const EVM_LOG_SCAN_MAX_CALLS = 5;

/**
 * The deterministic deployment proxy (Arachnid): `CREATE2`s whatever init code
 * follows a 32-byte salt in its calldata. Deployed at this same address on
 * nearly every EVM chain, Monad mainnet and testnet included (checked with
 * `eth_getCode`), which is why deposit addresses need no factory of our own.
 */
export const DETERMINISTIC_DEPLOYER =
  '0x4e59b44847b379578588920ca78fbf26c0b4956c';

/** `balanceOf(address)` selector. */
export const ERC20_BALANCE_OF_SELECTOR = '0x70a08231';

/**
 * Gas a forwarder deployment is budgeted at when its fee is quoted: the
 * deployment itself plus the constructor's two transfers (fee, then the rest),
 * rounded up. Monad charges the gas LIMIT, not the gas used, so the relayer
 * sends with a limit close to its estimate — this constant only prices the
 * fee, and `DEPOSIT_FEE_MARGIN_BPS` covers the gas price moving meanwhile.
 * Measured on Monad testnet with `eth_estimateGas` through the proxy: 367k
 * with nothing to forward, 418k forwarding native MON (state override giving
 * the address a balance). The token path adds a `balanceOf` and two token
 * transfers.
 */
export const FORWARDER_GAS_NATIVE = 450_000n;
export const FORWARDER_GAS_TOKEN = 520_000n;

/** Headroom on the quoted fee for the gas price rising before the forward (bps). */
export const DEPOSIT_FEE_MARGIN_BPS = 12_500n;

/** The quoted fee is rounded up to this many wei (0.000001 MON), for a readable amount. */
export const DEPOSIT_FEE_ROUNDING_WEI = 10n ** 12n;

/**
 * Headroom on `eth_estimateGas` when the relayer sends (bps). Small, because
 * Monad bills the whole limit.
 */
export const RELAYER_GAS_LIMIT_MARGIN_BPS = 11_500n;

/** Deposit rows the forwarder looks at in one tick. */
export const DEPOSIT_FORWARD_BATCH = 50;

/**
 * How long a deposit address is watched after its intent is created. Money that
 * arrives later still belongs to the merchant and still reaches them — native
 * coin forwards itself once deployed, and `flush` / `flushToken` are open to
 * anyone — but the service stops spending RPC calls on it.
 */
export const DEPOSIT_WATCH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A forward with no receipt after this long is presumed dropped and sent again.
 * Re-sending is safe: a second deployment of the same address reverts, and the
 * retry path checks for code first.
 */
export const DEPOSIT_FORWARD_RESEND_MS = 5 * 60 * 1000;
