import type { StellarNetwork } from '@/config/configuration';
import { ARC_CHAIN_IDS, MONAD_CHAIN_IDS } from '@/chains/chains.constants';

/**
 * The EVM chains this service speaks, each a `Chain` with its own RPC, relayer
 * and deposit addresses. One entry per chain: every table below is a `Record`
 * over it, so a new EVM chain does not compile until each says its value.
 */
export const EVM_CHAINS = ['monad', 'arc'] as const;
export type EvmChain = (typeof EVM_CHAINS)[number];

export function isEvmChain(value: unknown): value is EvmChain {
  return (
    typeof value === 'string' &&
    (EVM_CHAINS as readonly string[]).includes(value)
  );
}

/** Each EVM chain's EIP-155 ids, per network tier. */
export const EVM_CHAIN_IDS: Record<EvmChain, Record<StellarNetwork, number>> = {
  monad: MONAD_CHAIN_IDS,
  arc: ARC_CHAIN_IDS,
};

/** Display name, for the errors a caller sees ("Monad RPC is unreachable"). */
export const EVM_PROVIDER_NAMES: Record<EvmChain, string> = {
  monad: 'Monad',
  arc: 'Arc',
};

/**
 * Arc's USDC, as an ERC-20 (6 decimals). It is the chain's native coin seen
 * through the ERC-20 interface: one balance, which the native view counts in
 * 18 decimals and this contract truncates to 6 (`balanceOf` drops dust under
 * a micro-USDC, so a zero there does not prove a zero native balance). Same
 * address on mainnet and testnet (docs.arc.io, "Contract addresses";
 * `decimals()` and `symbol()` read on both on 2026-11-18).
 */
export const ARC_USDC = '0x3600000000000000000000000000000000000000';

/**
 * Arc's system address that logs every native USDC movement as a standard
 * ERC-20 `Transfer` (EIP-7708), amounts in 18 decimals. A plain value transfer
 * logs only here; an ERC-20 `transfer` on {@link ARC_USDC} logs BOTH here (18
 * decimals) and at the token (6), so counting both would count it twice. Seen
 * on a testnet receipt on 2026-11-18: one transfer, 9409212000000000000 here
 * and 9409212 at the token. Gas is deducted without a log. Stored lowercase,
 * as nodes report a log's `address`.
 */
export const ARC_TRANSFER_EMITTER =
  '0xfffffffffffffffffffffffffffffffffffffffe';

/** A native coin that also answers as an ERC-20, and where its moves are logged. */
export interface EvmNativeTokenInterface {
  /** The ERC-20 contract over the native balance. */
  token: string;
  /** Its `decimals()`; the native coin keeps `NATIVE_DECIMALS`. */
  decimals: number;
  /**
   * The address that logs every movement of the coin as a `Transfer`, in the
   * native decimals, whichever interface moved it. Reading it alone counts
   * each movement once.
   */
  transferEmitter: string;
}

/**
 * Per EVM chain, its native coin's ERC-20 interface, or null where there is
 * none (Monad's MON is only a coin). On Arc a payment link charges USDC
 * through this interface, whether the payer's wallet sends it as the ERC-20
 * or as a value transfer: the verifier reads the emitter's log and compares it
 * in 6 decimals, and the deposit forwarder reads `balanceOf`.
 */
export const EVM_NATIVE_TOKEN_INTERFACES: Record<
  EvmChain,
  EvmNativeTokenInterface | null
> = {
  monad: null,
  arc: { token: ARC_USDC, decimals: 6, transferEmitter: ARC_TRANSFER_EMITTER },
};

/** A token a request may name by its code alone, without `assetIssuer`. */
export interface EvmTokenPreset {
  /** EIP-55. */
  address: string;
  decimals: number;
}

/**
 * Tokens a payment link may name by code alone, per chain and tier. Any other
 * ERC-20 is still accepted by its contract (`assetIssuer`), its `decimals()`
 * read on-chain. Arc's: USDC and EURC (docs.arc.io, "Contract addresses";
 * `decimals()` 6 and `symbol()` read on mainnet and testnet on 2026-11-18).
 */
export const EVM_TOKEN_PRESETS: Record<
  EvmChain,
  Record<StellarNetwork, Readonly<Record<string, EvmTokenPreset>>>
> = {
  monad: { public: {}, testnet: {} },
  arc: {
    public: {
      USDC: { address: ARC_USDC, decimals: 6 },
      EURC: {
        address: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1',
        decimals: 6,
      },
    },
    testnet: {
      USDC: { address: ARC_USDC, decimals: 6 },
      EURC: {
        address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
        decimals: 6,
      },
    },
  },
};

/**
 * The lowest `maxFeePerGas` a chain's mempool keeps, in wei. Arc drops a
 * transaction under 20 gwei silently, with no error and no receipt
 * (docs.arc.io, "EVM compatibility"; its base fee sat at that floor on both
 * tiers on 2026-11-18), so the relayer never bids under it.
 */
export const EVM_MIN_MAX_FEE_PER_GAS: Record<EvmChain, bigint> = {
  monad: 0n,
  arc: 20_000_000_000n,
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
 * backlog over a few ticks without letting one intent own the sweep. On Arc
 * (~0.5 s blocks, 5,000 blocks a call by default) it is hours of chain.
 */
export const EVM_LOG_SCAN_MAX_CALLS = 5;

/**
 * The deterministic deployment proxy (Arachnid): `CREATE2`s whatever init code
 * follows a 32-byte salt in its calldata. Deployed at this same address on
 * nearly every EVM chain, Monad mainnet and testnet included (checked with
 * `eth_getCode`), which is why deposit addresses need no factory of our own.
 * Arc too, on both tiers: `eth_getCode` answers the proxy's runtime, and a
 * creation `eth_call` through it answered the address `depositAddress`
 * computes (2026-11-18).
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
 * transfers. On Arc, mainnet and testnet alike (2026-11-18, same method):
 * 451k forwarding USDC through its ERC-20 interface (dust under a micro-USDC
 * included, sent on as native coin), 501k with a merchant fee, 411k native.
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

/** `allowance(address,address)` — how much a spender may pull from an owner. */
export const ERC20_ALLOWANCE_SELECTOR = '0xdd62ed3e';

/** `approve(address,uint256)` — the call a wallet sends before an ERC-20 swap. */
export const ERC20_APPROVE_SELECTOR = '0x095ea7b3';

/**
 * `swap(address,uint256,address,uint256,address,uint256,address,bytes)` on
 * `contracts/MerchantFeeSwapRouter.sol`: a Monad swap that also pays a
 * merchant fee.
 */
export const MERCHANT_FEE_ROUTER_SWAP_SELECTOR = '0x6f3c6281';

/** `aggregator()` on the merchant fee swap router: the contract it calls. */
export const MERCHANT_FEE_ROUTER_AGGREGATOR_SELECTOR = '0x245a7bfc';
