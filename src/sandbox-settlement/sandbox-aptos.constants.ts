import type { SandboxNetworkCommon } from '@/sandbox-settlement/sandbox-settlement.constants';

/**
 * The sandbox on the Aptos test network: a deposit address per payment, Circle's
 * test USDC (a fungible asset, read and moved through its primary stores), and
 * entry-function transfers from the treasury.
 */

/** The Aptos test network the sandbox settles on. */
export interface SandboxAptosNetwork extends SandboxNetworkCommon {
  kind: 'aptos';
  /**
   * The chain id the REST API answers on `GET /v1` (2 is the test network, 1
   * mainnet). Every transaction signs it too, so a node on another network is
   * refused before any read and no signed transfer is valid anywhere else.
   */
  chainId: number;
}

/** SLIP-44 coin type of Aptos: deposit keys live at `m/44'/637'/7007'/a'/b'`. */
export const SANDBOX_APTOS_COIN_TYPE = 637;

/**
 * Aptos Testnet. Chain id 2 read from `GET /v1` on 2026-11-17. The USDC
 * metadata object is Circle's test USDC from its published list
 * (developers.circle.com, "USDC contract addresses", Aptos Testnet), and it
 * answered `0x1::fungible_asset::symbol` "USDC" and `decimals` 6 on-chain the
 * same day. `explorerTx` is the page's prefix: the ledger appends the hash and
 * `?network=testnet`, which the explorer needs to look on the test network.
 */
export const SANDBOX_APTOS_TESTNET: SandboxAptosNetwork = {
  kind: 'aptos',
  testnetName: 'Aptos Testnet',
  chainId: 2,
  defaultRpcUrl: 'https://api.testnet.aptoslabs.com/v1',
  explorerTx: 'https://explorer.aptoslabs.com/txn/',
  stablecoin: {
    symbol: 'USDC',
    decimals: 6,
    issuer: 'circle',
    contract:
      '0x69091fbab5f7d635ee7ac5098cf0c1efbe31d68fec0f2cd565e8d168daf52832',
  },
};

/** The query the explorer needs after the hash to look on the test network. */
export const SANDBOX_APTOS_EXPLORER_QUERY = '?network=testnet';

/**
 * Gas units a treasury transfer may burn at most. A fungible-asset transfer
 * between existing primary stores costs a few hundred units; one that creates
 * the recipient's store pays its storage too (a few hundred more at the test
 * network's price). 20,000 is the cap, not the charge: unused gas is not paid,
 * and the blocker asks the treasury to hold this times the gas price in APT.
 */
export const SANDBOX_APTOS_MAX_GAS_AMOUNT = 20_000n;

/**
 * Seconds a signed treasury transfer stays valid. Its bytes are submitted
 * again at every look while it is not committed, so an hour rides out a node
 * or mempool outage; past it, a transfer that never committed provably never
 * will, and the payout is final as failed (never signed a second time).
 */
export const SANDBOX_APTOS_EXPIRATION_SECONDS = 3600;

/** The module and function every treasury transfer calls. */
export const APTOS_FA_TRANSFER = {
  address: '0x1',
  module: 'primary_fungible_store',
  function: 'transfer',
} as const;

/** The struct the transfer is generic over: `0x1::fungible_asset::Metadata`. */
export const APTOS_FA_METADATA_TYPE = {
  address: '0x1',
  module: 'fungible_asset',
  name: 'Metadata',
} as const;

/** APT's own fungible-asset metadata object (the gas coin, paired with `AptosCoin`). */
export const APTOS_APT_METADATA = '0xa';

/** Octas in one APT, for the operator's report. */
export const APTOS_OCTAS_PER_APT = 100_000_000n;
