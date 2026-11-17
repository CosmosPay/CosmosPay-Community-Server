import { Injectable, Logger } from '@nestjs/common';
import type { PaymentDeposit, SandboxPayout } from '@generated/prisma/client';
import { formatUnits, parseUnits } from '@/chains/units';
import { isUniqueViolation } from '@/common/prisma-errors';
import type { NearIntentsStatus } from '@/near-intents/near-intents.constants';
import type {
  NearIntentsStatusResponse,
  NearIntentsTransaction,
} from '@/near-intents/near-intents.types';
import type { PaymentNetwork } from '@/payment-intents/payment-networks';
import { PrismaService } from '@/prisma/prisma.service';
import type { SandboxTransfer } from '@/sandbox-settlement/sandbox-ledger';
import { SandboxLedgers } from '@/sandbox-settlement/sandbox-ledgers.service';

/** One of the two transactions the treasury may send for a deposit. */
type PayoutKind = 'payout' | 'refund';

/**
 * Settles sandbox deposits: reads the payer's deposit on the origin test
 * network and has the sandbox treasury pay the merchant on the link's test
 * network (or refund the payer), answering in the cross-chain route's own
 * status vocabulary so `PaymentDepositsService.applyProviderStatus` moves the
 * row, settles the intent and notifies exactly as on mainnet. What is read and
 * signed on each network is its `SandboxLedger`'s; every decision is here.
 *
 * The decision per deposit, at each look:
 *
 *   - a payout already sent: succeeded is SUCCESS, failed (reverted, or
 *     expired unexecuted) is FAILED, not final yet is PROCESSING (its signed
 *     bytes are broadcast again, never re-signed);
 *   - a refund already sent: succeeded is REFUNDED, otherwise PROCESSING;
 *   - nothing arrived: PENDING_DEPOSIT (the deadline expires it);
 *   - less than `minAmountIn`: INCOMPLETE_DEPOSIT, refunded once the deadline
 *     passes;
 *   - enough, before the deadline: the payout is sent (PROCESSING);
 *   - enough, after it: refunded, as the route does with a late deposit.
 *
 * The treasury pays from its own balance, one for one; the payer's deposit
 * stays at its address (test funds, recoverable from the seed). Each
 * transaction is written with its signed bytes BEFORE it is broadcast, one per
 * kind per deposit (`sandbox_payout`), so a crash or a second replica never
 * pays twice. Ticks run under the observer's advisory lock.
 */
@Injectable()
export class SandboxSettler {
  private readonly logger = new Logger(SandboxSettler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgers: SandboxLedgers,
  ) {}

  /** Where the deposit stands, in the route's status vocabulary; never null. */
  async observe(deposit: PaymentDeposit): Promise<NearIntentsStatusResponse> {
    const sent = await this.prisma.sandboxPayout.findMany({
      where: { depositId: deposit.id },
    });
    const payout = sent.find((p) => p.kind === 'payout');
    const refund = sent.find((p) => p.kind === 'refund');

    if (payout) return this.follow(deposit, payout, 'SUCCESS');
    if (refund) return this.follow(deposit, refund, 'REFUNDED');

    const origin = deposit.originChain as PaymentNetwork;
    const ledger = this.ledgers.for(origin);
    const received = await ledger.received(deposit);
    const late = Date.now() > deposit.expiresAt.getTime();
    if (received === 0n) {
      if (!late) await ledger.prepareDeposit?.(deposit);
      return this.status(deposit, 'PENDING_DEPOSIT');
    }

    const minimum = parseUnits(deposit.minAmountIn, deposit.originDecimals);
    if (received < minimum && !late) {
      return this.status(deposit, 'INCOMPLETE_DEPOSIT');
    }
    if (late) {
      // Too little before the deadline, or anything after it: the payer gets
      // back what arrived, from the treasury, on the origin network.
      const sentRefund = await this.send(deposit, 'refund', {
        network: origin,
        token: deposit.originContract ?? '',
        recipient: deposit.refundTo,
        amount: received,
      });
      if (!sentRefund) return this.status(deposit, 'INCOMPLETE_DEPOSIT');
      return sentRefund.fresh
        ? this.status(deposit, 'PROCESSING')
        : this.follow(deposit, sentRefund.row, 'REFUNDED');
    }
    const sentPayout = await this.send(deposit, 'payout', {
      network: deposit.destinationChain as PaymentNetwork,
      token: deposit.destinationContract ?? '',
      recipient: deposit.recipient,
      amount: parseUnits(deposit.amountOut, deposit.destinationDecimals),
    });
    if (!sentPayout) return this.status(deposit, 'KNOWN_DEPOSIT_TX');
    return sentPayout.fresh
      ? this.status(deposit, 'PROCESSING')
      : this.follow(deposit, sentPayout.row, 'SUCCESS');
  }

  /** Where a sent transaction stands: succeeded, failed or still in flight. */
  private async follow(
    deposit: PaymentDeposit,
    row: SandboxPayout,
    whenMined: Extract<NearIntentsStatus, 'SUCCESS' | 'REFUNDED'>,
  ): Promise<NearIntentsStatusResponse> {
    const network = row.network as PaymentNetwork;
    const ledger = this.ledgers.for(network);
    const outcome = await ledger.follow(row);
    if (outcome === 'pending') return this.status(deposit, 'PROCESSING');
    if (outcome === 'failed') {
      if (row.status !== 'FAILED') {
        await this.prisma.sandboxPayout.update({
          where: { id: row.id },
          data: { status: 'FAILED' },
        });
        this.logger.error(
          `Sandbox ${row.kind} ${row.txHash} for deposit ${deposit.id} failed on ${network}`,
        );
      }
      return this.status(deposit, 'FAILED');
    }
    if (row.status !== 'CONFIRMED') {
      await this.prisma.sandboxPayout.update({
        where: { id: row.id },
        data: { status: 'CONFIRMED' },
      });
    }
    const tx: NearIntentsTransaction = {
      hash: row.txHash,
      explorerUrl: ledger.explorerTx(network, row.txHash),
    };
    const decimals =
      row.kind === 'payout'
        ? deposit.destinationDecimals
        : deposit.originDecimals;
    const amount = BigInt(row.amount);
    return {
      ...this.status(deposit, whenMined),
      swapDetails:
        whenMined === 'SUCCESS'
          ? {
              amountOut: amount.toString(),
              amountOutFormatted: formatUnits(amount, decimals),
              originChainTxHashes: [],
              destinationChainTxHashes: [tx],
            }
          : {
              refundedAmount: amount.toString(),
              refundedAmountFormatted: formatUnits(amount, decimals),
              originChainTxHashes: [tx],
              destinationChainTxHashes: [],
            },
    };
  }

  /**
   * Signs a treasury transfer, records it, then broadcasts it. Null when the
   * transfer cannot be sent right now (the ledger's `blocker`: the treasury is
   * short, the recipient cannot hold the token yet): logged, and looked at
   * again on the next tick. A unique violation means another tick recorded the
   * same kind first: its row comes back (`fresh: false`) to be followed instead.
   */
  private async send(
    deposit: PaymentDeposit,
    kind: PayoutKind,
    transfer: SandboxTransfer,
  ): Promise<{ row: SandboxPayout; fresh: boolean } | null> {
    const { network, token, recipient, amount } = transfer;
    const ledger = this.ledgers.for(network);
    const blocked = await ledger.blocker(transfer);
    if (blocked) {
      this.logger.error(
        `Sandbox ${kind} for deposit ${deposit.id} on ${network} waits: ${blocked}`,
      );
      return null;
    }
    const signed = await ledger.sign(transfer);
    let row: SandboxPayout;
    try {
      row = await this.prisma.sandboxPayout.create({
        data: {
          depositId: deposit.id,
          kind,
          network,
          token,
          recipient,
          amount: amount.toString(),
          nonce: signed.nonce,
          txHash: signed.hash,
          raw: signed.raw,
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = await this.prisma.sandboxPayout.findUnique({
        where: { depositId_kind: { depositId: deposit.id, kind } },
      });
      return raced ? { row: raced, fresh: false } : null;
    }
    await ledger.broadcast(network, signed.raw);
    this.logger.log(
      `Sandbox ${kind} for deposit ${deposit.id}: ${amount} of ${token} to ` +
        `${recipient} on ${network} (tx=${signed.hash})`,
    );
    return { row, fresh: true };
  }

  private status(
    deposit: PaymentDeposit,
    status: NearIntentsStatus,
  ): NearIntentsStatusResponse {
    return {
      correlationId: deposit.correlationId,
      status,
      updatedAt: new Date().toISOString(),
    };
  }
}
