import { Injectable } from '@nestjs/common';
import type { PaymentIntent } from '@generated/prisma/client';
import { toChecksumAddress } from '@/chains/chain-address';
import { NATIVE_DECIMALS } from '@/chains/chains.constants';
import { parseUnits } from '@/chains/units';
import type { StellarNetwork } from '@/config/configuration';
import { addressTopic, topicAddress } from '@/evm/eip681';
import {
  ERC20_TRANSFER_SELECTOR,
  ERC20_TRANSFER_TOPIC,
  EVM_LOG_SCAN_MAX_CALLS,
  type EvmChain,
} from '@/evm/evm.constants';
import {
  EvmRpcClient,
  type EvmReceipt,
  type EvmTransaction,
} from '@/evm/evm-rpc.client';
import { TX_CREATED_AT_SKEW_MS } from '@/payment-intents/payment-intents.constants';
import type {
  PaymentVerifier,
  VerificationResult,
} from '@/payment-intents/payment-verifier';

/**
 * Confirms that an EVM transaction pays an intent (Monad).
 *
 * With a relayer configured, every Monad intent has its own deposit address
 * (`chainReference`) and that address is the identification — the rules
 * below then apply to it instead of the merchant, the amount becomes "at
 * least", and discovery is the deposit forwarder's (by balance, native MON
 * included). What follows is the direct mode, paying the merchant.
 *
 * An EIP-681 payment carries no memo: a plain value transfer and an ERC-20
 * `transfer` have no field a wallet fills with an intent id. So the payment is
 * identified by what it moves — to the intent's destination, in its asset, for
 * exactly its amount — at or after the intent's creation. That is weaker than a
 * Stellar memo or a Solana reference, which is why an EVM intent must fix an
 * amount (the DTO refuses an open one) and why the README tells integrators to
 * give concurrent intents to one destination distinct amounts.
 *
 *   - Native MON: the transaction's `to` and `value`. The observer cannot find
 *     one on its own — a value transfer emits no log, and scanning every block
 *     is not a cost this service takes on — so a native intent settles through
 *     `POST /:id/validate` (or `PATCH` with the hash).
 *   - ERC-20: a `Transfer(from, to, value)` log of the token contract. The
 *     observer finds these with `eth_getLogs`, resuming from the intent's
 *     cursor each tick.
 */
@Injectable()
export class EvmVerifierService implements PaymentVerifier {
  private readonly chain: EvmChain = 'monad';

  constructor(private readonly rpc: EvmRpcClient) {}

  async verifyByHash(
    intent: PaymentIntent,
    hash: string,
  ): Promise<VerificationResult> {
    const network = intent.network as StellarNetwork;
    const [tx, receipt] = await Promise.all([
      this.rpc.getTransaction(this.chain, network, hash),
      this.rpc.getReceipt(this.chain, network, hash),
    ]);
    if (!tx || !receipt) {
      return { valid: false, reason: 'Transaction not found on-chain' };
    }

    const expected = this.expected(intent);
    if (expected === null && !isDeposit(intent)) {
      return { valid: false, reason: 'The intent has no payable amount' };
    }
    const accepts = amountRule(intent, expected);

    const paysIntent = intent.assetIssuer
      ? this.erc20Pays(intent, tx, receipt, accepts)
      : this.nativePays(intent, tx, accepts);
    if (!paysIntent) {
      return {
        valid: false,
        reason:
          'No transfer in this transaction matches the destination/amount',
      };
    }

    const timestamp = await this.rpc.blockTimestamp(
      this.chain,
      network,
      receipt.blockNumber,
    );
    if (
      timestamp === null ||
      timestamp * 1000 < intent.createdAt.getTime() - TX_CREATED_AT_SKEW_MS
    ) {
      return {
        valid: false,
        reason: 'Transaction predates this payment intent',
      };
    }

    if (receipt.status !== '0x1') {
      return {
        valid: false,
        failedOnChain: true,
        reason: 'Transaction failed on-chain',
      };
    }
    return {
      valid: true,
      txHash: hash.toLowerCase(),
      payer: toChecksumAddress(tx.from),
    };
  }

  /**
   * Scans the token's `Transfer` logs to the destination from the block after
   * the intent's cursor, a provider-sized range at a time, at most
   * {@link EVM_LOG_SCAN_MAX_CALLS} ranges per call. Where it stopped comes back
   * as `nextCursor` whether or not it found anything, so the next tick resumes
   * there.
   */
  async findMatchingPayment(
    intent: PaymentIntent,
  ): Promise<VerificationResult> {
    // A deposit address is watched by its balance, by the deposit forwarder,
    // which settles the intent once the money is on its way to the merchant.
    if (isDeposit(intent)) {
      return {
        valid: false,
        reason: 'Awaiting a deposit at the intent address',
      };
    }
    if (!intent.assetIssuer) {
      return {
        valid: false,
        reason:
          'A native MON payment emits no log to find it by: confirm it with ' +
          'POST /v1/payment-intents/{id}/validate and the transaction hash',
      };
    }
    const expected = this.expected(intent);
    if (expected === null) {
      return { valid: false, reason: 'The intent has no payable amount' };
    }

    const network = intent.network as StellarNetwork;
    const head = await this.rpc.blockNumber(this.chain, network);
    let cursor = intent.chainCursor ? BigInt(intent.chainCursor) : head;
    const range = BigInt(this.rpc.logBlockRange(this.chain));

    for (
      let calls = 0;
      calls < EVM_LOG_SCAN_MAX_CALLS && cursor < head;
      calls += 1
    ) {
      const fromBlock = cursor + 1n;
      const toBlock =
        fromBlock + range - 1n < head ? fromBlock + range - 1n : head;
      const logs = await this.rpc.getLogs(this.chain, network, {
        address: intent.assetIssuer,
        topics: [ERC20_TRANSFER_TOPIC, null, addressTopic(intent.destination)],
        fromBlock,
        toBlock,
      });
      const match = logs.find(
        (log) => !log.removed && safeBigInt(log.data) === expected,
      );
      if (match) {
        return {
          valid: true,
          txHash: match.transactionHash.toLowerCase(),
          payer: toChecksumAddress(topicAddress(match.topics[1] ?? '')),
          nextCursor: toBlock.toString(),
        };
      }
      cursor = toBlock;
    }
    return {
      valid: false,
      reason: 'No matching payment found yet',
      nextCursor: cursor.toString(),
    };
  }

  /** The intent's amount in the asset's base units, or null when it has none. */
  private expected(intent: PaymentIntent): bigint | null {
    if (intent.amount == null) return null;
    const decimals = intent.assetIssuer
      ? intent.assetDecimals
      : NATIVE_DECIMALS.monad;
    if (decimals == null) return null;
    try {
      return parseUnits(intent.amount, decimals);
    } catch {
      return null;
    }
  }

  private nativePays(
    intent: PaymentIntent,
    tx: EvmTransaction,
    accepts: (value: bigint | null) => boolean,
  ): boolean {
    return (
      tx.to?.toLowerCase() === payee(intent).toLowerCase() &&
      accepts(safeBigInt(tx.value))
    );
  }

  /**
   * A `Transfer` log of the token to the destination for the amount — or, for
   * a reverted transaction, which emits no logs, the `transfer(to, amount)`
   * call to the token itself, so the payer's own failed attempt is recognised.
   */
  private erc20Pays(
    intent: PaymentIntent,
    tx: EvmTransaction,
    receipt: EvmReceipt,
    accepts: (value: bigint | null) => boolean,
  ): boolean {
    const token = intent.assetIssuer!.toLowerCase();
    const destination = addressTopic(payee(intent));
    const logged = receipt.logs.some(
      (log) =>
        log.address.toLowerCase() === token &&
        log.topics[0] === ERC20_TRANSFER_TOPIC &&
        log.topics[2]?.toLowerCase() === destination &&
        accepts(safeBigInt(log.data)),
    );
    if (logged) return true;
    if (receipt.status === '0x1' || tx.to?.toLowerCase() !== token) {
      return false;
    }
    const input = tx.input.toLowerCase();
    return (
      input.startsWith(ERC20_TRANSFER_SELECTOR) &&
      `0x${input.slice(10, 74)}` === destination &&
      accepts(safeBigInt(`0x${input.slice(74, 138)}`))
    );
  }
}

/** Whether the intent has its own deposit address (the relayer is on). */
function isDeposit(intent: PaymentIntent): boolean {
  return intent.chainReference !== null && intent.chainReference !== undefined;
}

/**
 * Where the payer pays: the intent's deposit address, else the merchant.
 * Exported for the settlement precedence check (`settlement-rivals.ts`), which
 * must look for older intents paid at the same address this rule pays.
 */
export function payee(intent: PaymentIntent): string {
  return intent.chainReference ?? intent.destination;
}

/**
 * Which amounts settle the intent. Paying the merchant directly, only the
 * exact amount: it is half of how the payment is recognised. Paying a deposit
 * address, the address alone identifies the intent, so the amount or more
 * does — any positive amount for an open intent.
 */
function amountRule(
  intent: PaymentIntent,
  expected: bigint | null,
): (value: bigint | null) => boolean {
  if (!isDeposit(intent)) return (value) => value === expected;
  if (expected === null) return (value) => value !== null && value > 0n;
  return (value) => value !== null && value >= expected;
}

/** A hex quantity as a bigint, or null when it is not one. */
function safeBigInt(hex: string): bigint | null {
  try {
    return /^0x[0-9a-fA-F]+$/.test(hex) ? BigInt(hex) : null;
  } catch {
    return null;
  }
}
