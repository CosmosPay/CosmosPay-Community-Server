import type { SandboxNetworkCommon } from '@/sandbox-settlement/sandbox-settlement.constants';

/**
 * The sandbox on NEAR's test network: a per-payment implicit account (the hex
 * of an ed25519 key derived from the sandbox seed) as the deposit address, and
 * the treasury's own implicit account paying out Circle's test USDC, a NEP-141
 * fungible token whose holders must be registered with the token contract
 * (NEP-145 storage) before they can receive it.
 */
export interface SandboxNearNetwork extends SandboxNetworkCommon {
  kind: 'near';
  /**
   * The network's `chain_id` as its RPC `status` answers it. Checked before a
   * node is trusted, so a node of another network (mainnet above all) is
   * refused.
   */
  chainId: string;
}

/**
 * NEAR testnet. `status` answered chain_id `testnet` on 2026-11-17; the test
 * USDC contract (Circle's published testnet address) answered `ft_metadata`
 * symbol USDC, 6 decimals, the same day.
 */
export const SANDBOX_NEAR_TESTNET: SandboxNearNetwork = {
  kind: 'near',
  testnetName: 'NEAR Testnet',
  chainId: 'testnet',
  defaultRpcUrl: 'https://rpc.testnet.near.org',
  explorerTx: 'https://testnet.nearblocks.io/txns/',
  stablecoin: {
    symbol: 'USDC',
    decimals: 6,
    issuer: 'circle',
    contract:
      '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
  },
};

/** NEAR's SLIP-44 coin type: deposit keys live at m/44'/397'/7007'/a'/b'. */
export const SANDBOX_NEAR_COIN_TYPE = 397;

/**
 * yoctoNEAR attached to a `storage_deposit` on the test USDC contract: its
 * `storage_balance_bounds` answered min = max = 0.00125 NEAR on 2026-11-17.
 * With `registration_only: true` an account that is already registered gets
 * it back in full, so attaching it to every payout costs nothing twice.
 */
export const SANDBOX_NEAR_STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n;

/** One yoctoNEAR: NEP-141 `ft_transfer` requires exactly this attached. */
export const SANDBOX_NEAR_ONE_YOCTO = 1n;

/**
 * Gas for `storage_deposit` (a few Tgas in practice) and `ft_transfer` (about
 * 3-5 Tgas). Prepaid gas that is not burnt is refunded, so the margin only
 * caps the cost.
 */
export const SANDBOX_NEAR_STORAGE_GAS = 10_000_000_000_000n;
export const SANDBOX_NEAR_TRANSFER_GAS = 15_000_000_000_000n;

/**
 * Spendable NEAR the treasury keeps for gas on top of a storage deposit: the
 * prepaid 25 Tgas above cost at most 0.0025 NEAR at the minimum gas price, and
 * the rest leaves room for price rises between ticks.
 */
export const SANDBOX_NEAR_GAS_RESERVE = 10_000_000_000_000_000_000_000n;

/**
 * yoctoNEAR locked per byte of account storage (NEAR's storage staking cost,
 * 1 NEAR per 100 kB): what an account cannot spend out of its balance.
 */
export const SANDBOX_NEAR_STORAGE_BYTE_COST = 10_000_000_000_000_000_000n;

/**
 * Executed and finalized: the only `final_execution_status` a payout is read
 * as settled or failed at. Anything earlier can still change.
 */
export const SANDBOX_NEAR_FINAL_STATUS = 'FINAL';
