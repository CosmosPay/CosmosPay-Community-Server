import type { SandboxNetworkCommon } from '@/sandbox-settlement/sandbox-settlement.constants';

/**
 * The sandbox on the XRP Ledger TESTNET. Payers deposit to the treasury
 * account itself, each payment with its own destination tag: a per-payment
 * account would need its reserve and a trustline for the test USDC before the
 * payer could pay it, while one account with a trustline takes every deposit.
 */

/** The XRP Ledger test network the sandbox settles on. */
export interface SandboxXrplNetwork extends SandboxNetworkCommon {
  kind: 'xrpl';
  /**
   * The network id `server_info` answers (0 mainnet, 1 testnet, 2 devnet),
   * checked before a node is trusted: a node on mainnet is refused.
   */
  networkId: number;
  /** The test USDC's currency code, as the ledger stores it (40 hex). */
  currency: string;
}

/**
 * Circle's test USDC on the XRP Ledger testnet: currency `USDC` (non-standard
 * code, hex) issued by rHuGNhqTG32mfmAvWA8hUyWRLV3tCSwKQt, as published in
 * Circle's USDC address list. Checked on-chain on 2026-11-17: Domain
 * `https://circle.com`, no TransferRate (no transfer fee, so a payment needs no
 * SendMax), RequireAuth off (a trustline needs no approval), master key
 * disabled.
 */
export const XRPL_TEST_USDC_ISSUER = 'rHuGNhqTG32mfmAvWA8hUyWRLV3tCSwKQt';
export const XRPL_TEST_USDC_CURRENCY =
  '5553444300000000000000000000000000000000';

export const XRPL_TESTNET: SandboxXrplNetwork = {
  kind: 'xrpl',
  testnetName: 'XRP Ledger Testnet',
  networkId: 1,
  defaultRpcUrl: 'https://s.altnet.rippletest.net:51234/',
  explorerTx: 'https://testnet.xrpl.org/transactions/',
  currency: XRPL_TEST_USDC_CURRENCY,
  stablecoin: {
    symbol: 'USDC',
    // An issued currency has no decimals of its own (15 significant digits);
    // the sandbox counts it in millionths, as USDC everywhere else.
    decimals: 6,
    issuer: 'circle',
    contract: XRPL_TEST_USDC_ISSUER,
  },
};

/** Where an XRP Ledger deposit is found again: `xrpl:tag:<destination tag>`. */
export const XRPL_DEPOSIT_LOCATOR_PREFIX = 'xrpl:tag:';

/**
 * Ledgers a treasury transaction stays valid for (`LastLedgerSequence` =
 * the open ledger + this). About an hour at 3 to 4 s a ledger: long enough to
 * ride out a node outage while the same bytes are broadcast again, and once it
 * is passed unvalidated the transaction can never execute, so its payout is
 * final as failed and never signed twice.
 */
export const XRPL_TX_VALIDITY_LEDGERS = 1_000;

/**
 * Highest fee, in drops, the treasury pays per transaction. The base fee is
 * 10 drops; the open ledger escalates it under load, and past this cap the
 * transaction waits for a quieter ledger rather than spend more.
 */
export const XRPL_MAX_FEE_DROPS = 5_000n;

/** The trustline limit the treasury sets for the test USDC (`sandbox:prepare`). */
export const XRPL_TREASURY_TRUST_LIMIT = '1000000000';

/**
 * Pages of the treasury's history `received` reads per deposit (each up to
 * `XRPL_ACCOUNT_TX_PAGE` transactions, newest first, stopping at the first one
 * closed before the deposit opened). Bounds the work per look on a busy
 * treasury; a deposit buried deeper is found again at a quieter look.
 */
export const XRPL_ACCOUNT_TX_MAX_PAGES = 10;
export const XRPL_ACCOUNT_TX_PAGE = 200;

/**
 * How far before a deposit opened its payment may have closed and still be
 * counted: clock skew between this service and the ledger. A tag is drawn at
 * random per deposit, so an older payment with the same tag is a 2^-32 event.
 */
export const XRPL_DEPOSIT_CLOCK_MARGIN_MS = 5 * 60_000;

/**
 * XRP Ledger binary field ids `(type code, field code)` the sandbox writes,
 * from rippled's definitions (`ripple-binary-codec` definitions.json). The
 * serializer sorts by them, which is the canonical order a signature covers.
 */
export const XRPL_FIELDS = {
  TransactionType: [1, 2],
  Flags: [2, 2],
  Sequence: [2, 4],
  DestinationTag: [2, 14],
  LastLedgerSequence: [2, 27],
  Amount: [6, 1],
  LimitAmount: [6, 3],
  Fee: [6, 8],
  SigningPubKey: [7, 3],
  TxnSignature: [7, 4],
  Account: [8, 1],
  Destination: [8, 3],
} as const;

/** Transaction type codes. */
export const XRPL_TX_TYPES = { Payment: 0, TrustSet: 20 } as const;

/**
 * Flags of a treasury Payment: none, and above all never `tfPartialPayment`,
 * so a payout delivers its whole amount or fails.
 */
export const XRPL_PAYMENT_FLAGS = 0;

/**
 * Flags of the treasury's TrustSet: `tfSetNoRipple`, the setting for an
 * account that holds a currency rather than issues it (no balance ever
 * ripples through the treasury's line).
 */
export const XRPL_TRUST_SET_FLAGS = 0x00020000;

/**
 * How long `sandbox:prepare` waits for its TrustSet to validate (a ledger
 * closes every 3 to 4 s), polling every `XRPL_TRUST_SET_POLL_MS`; past it the
 * script says to run again.
 */
export const XRPL_TRUST_SET_WAIT_MS = 20_000;
export const XRPL_TRUST_SET_POLL_MS = 2_000;
