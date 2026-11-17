import type { PaymentDeposit, SandboxPayout } from '@generated/prisma/client';
import type { PaymentNetwork } from '@/payment-intents/payment-networks';

/**
 * What the sandbox needs from one kind of test network (EVM, XRP Ledger,
 * NEAR, ...): where a payer deposits, what arrived, and the treasury's
 * transfers. `SandboxSettler` keeps every decision (statuses, the deadline,
 * the `sandbox_payout` row written before any broadcast); a ledger only reads
 * its network and signs. One implementation per `SandboxLedgerKind`, so a new
 * kind of network is one class and one entry in `SandboxLedgers`.
 */

/** One treasury transfer of a network's test stablecoin. */
export interface SandboxTransfer {
  network: PaymentNetwork;
  /**
   * The stablecoin as the network names it: an ERC-20 contract, an XRP Ledger
   * issuer, a NEAR contract account, a Sui coin type, an Aptos metadata object.
   */
  token: string;
  recipient: string;
  /** Base units of the stablecoin. */
  amount: bigint;
}

/** A transfer the treasury signed: what `sandbox_payout` keeps before broadcast. */
export interface SignedSandboxTransfer {
  /** The id the network's explorer shows. */
  hash: string;
  /** The signed bytes, the only thing ever broadcast again for this transfer. */
  raw: string;
  /** The account nonce or sequence the transaction consumes. */
  nonce: string;
}

/** Where a recorded transfer stands. */
export type SandboxTxOutcome = 'pending' | 'succeeded' | 'failed';

/** Where one new deposit is paid. */
export interface SandboxDepositTarget {
  address: string;
  /** What the payer must attach (an XRP Ledger destination tag); null when nothing. */
  memo: string | null;
  /**
   * How the deposit is found again, kept as its correlation id after
   * `sandbox:`: the HD path of its key, or its tag. Never a secret.
   */
  locator: string;
}

export interface SandboxLedger {
  /** A fresh deposit target for one payment. Pure: nothing is sent or stored. */
  newDeposit(network: PaymentNetwork): SandboxDepositTarget;

  /** The treasury's address on `network` (derived, never configured apart). */
  treasuryAddress(network: PaymentNetwork): string;

  /** Base units of the test stablecoin that arrived for `deposit` on its origin network. */
  received(deposit: PaymentDeposit): Promise<bigint>;

  /**
   * Readies a deposit that is still waiting for its money (NEAR registers the
   * deposit account with the token, without which a transfer to it fails).
   * Best effort: logs and returns on any failure, retried at the next look.
   */
  prepareDeposit?(deposit: PaymentDeposit): Promise<void>;

  /**
   * Why `transfer` cannot be signed right now, in an operator's words (the
   * treasury lacks the token or the gas coin, the recipient cannot hold the
   * token yet); null when it can. A blocked transfer is retried at the next
   * look, so an unfunded treasury only makes deposits wait.
   */
  blocker(transfer: SandboxTransfer): Promise<string | null>;

  /** Signs `transfer` from the treasury. Nothing is broadcast. */
  sign(transfer: SandboxTransfer): Promise<SignedSandboxTransfer>;

  /** Broadcasts signed bytes; a node that already holds them is not an error. */
  broadcast(network: PaymentNetwork, raw: string): Promise<void>;

  /**
   * Where a recorded transfer stands. While it is not final its signed bytes
   * are broadcast again (never re-signed); `failed` is final: reverted, or
   * provably never executable any more (expired).
   */
  follow(row: SandboxPayout): Promise<SandboxTxOutcome>;

  /** The explorer page of a transaction. */
  explorerTx(network: PaymentNetwork, hash: string): string;

  /**
   * The treasury's one-time setup on `network` (an XRP Ledger trustline, a
   * NEAR token registration), for `npm run sandbox:prepare`. Each line says
   * what was done or found; never a secret.
   */
  prepareTreasury?(network: PaymentNetwork): Promise<string[]>;

  /** The treasury's balances on `network`, one line for `npm run sandbox:status`. */
  treasuryReport(network: PaymentNetwork): Promise<string>;
}
