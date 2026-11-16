import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaymentDeposit, SandboxPayout } from '@generated/prisma/client';
import { formatUnits, parseUnits } from '@/chains/units';
import { isUniqueViolation } from '@/common/prisma-errors';
import type { AppConfig } from '@/config/configuration';
import { addressOfSecretKey, signEip1559 } from '@/evm/evm-transaction';
import { hexToBytes } from '@/evm/rlp';
import type { NearIntentsStatus } from '@/near-intents/near-intents.constants';
import type {
  NearIntentsStatusResponse,
  NearIntentsTransaction,
} from '@/near-intents/near-intents.types';
import type { PaymentNetwork } from '@/payment-intents/payment-networks';
import { PrismaService } from '@/prisma/prisma.service';
import {
  erc20TransferCalldata,
  SandboxEvmClient,
} from '@/sandbox-settlement/sandbox-evm.client';
import { SANDBOX_TRANSFER_GAS_FALLBACK } from '@/sandbox-settlement/sandbox-settlement.constants';

/** One of the two transactions the treasury may send for a deposit. */
type PayoutKind = 'payout' | 'refund';

/**
 * Settles sandbox deposits: reads the payer's deposit on the origin test
 * network and has the sandbox treasury pay the merchant on the link's test
 * network (or refund the payer), answering in the cross-chain route's own
 * status vocabulary so `PaymentDepositsService.applyProviderStatus` moves the
 * row, settles the intent and notifies exactly as on mainnet.
 *
 * The decision per deposit, at each look:
 *
 *   - a payout already sent: mined and succeeded is SUCCESS, mined and
 *     reverted is FAILED, not mined yet is PROCESSING (its signed bytes are
 *     broadcast again, same nonce and hash);
 *   - a refund already sent: mined is REFUNDED, otherwise PROCESSING;
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
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly chains: SandboxEvmClient,
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
    const received = await this.chains.erc20BalanceOf(
      origin,
      deposit.originContract ?? '',
      deposit.depositAddress,
    );
    if (received === 0n) return this.status(deposit, 'PENDING_DEPOSIT');

    const minimum = parseUnits(deposit.minAmountIn, deposit.originDecimals);
    const late = Date.now() > deposit.expiresAt.getTime();
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

  /** The treasury's address (the same on every EVM test network). */
  treasuryAddress(): string {
    return addressOfSecretKey(this.treasuryKey());
  }

  /** Where a sent transaction stands: mined, reverted or still in flight. */
  private async follow(
    deposit: PaymentDeposit,
    row: SandboxPayout,
    whenMined: Extract<NearIntentsStatus, 'SUCCESS' | 'REFUNDED'>,
  ): Promise<NearIntentsStatusResponse> {
    const network = row.network as PaymentNetwork;
    const receipt = await this.chains.receipt(network, row.txHash);
    if (!receipt) {
      await this.chains.sendRawTransaction(network, row.raw);
      return this.status(deposit, 'PROCESSING');
    }
    if (!receipt.succeeded) {
      if (row.status !== 'FAILED') {
        await this.prisma.sandboxPayout.update({
          where: { id: row.id },
          data: { status: 'FAILED' },
        });
        this.logger.error(
          `Sandbox ${row.kind} ${row.txHash} for deposit ${deposit.id} reverted on ${network}`,
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
      explorerUrl: `${this.chains.network(network).explorerTx}${row.txHash}`,
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
   * treasury cannot pay right now (not enough of the token): logged, and
   * looked at again on the next tick. A unique violation means another tick
   * recorded the same kind first: its row comes back (`fresh: false`) to be
   * followed instead.
   */
  private async send(
    deposit: PaymentDeposit,
    kind: PayoutKind,
    transfer: {
      network: PaymentNetwork;
      token: string;
      recipient: string;
      amount: bigint;
    },
  ): Promise<{ row: SandboxPayout; fresh: boolean } | null> {
    const { network, token, recipient, amount } = transfer;
    const key = this.treasuryKey();
    const treasury = addressOfSecretKey(key);
    const balance = await this.chains.erc20BalanceOf(network, token, treasury);
    if (balance < amount) {
      this.logger.error(
        `Sandbox treasury ${treasury} holds ${balance} of ${token} on ${network}, ` +
          `below the ${amount} deposit ${deposit.id} needs: fund it`,
      );
      return null;
    }
    const data = erc20TransferCalldata(recipient, amount);
    const [nonce, fees, estimate] = await Promise.all([
      this.chains.pendingNonce(network, treasury),
      this.chains.feeData(network),
      this.chains.estimateGas(network, { from: treasury, to: token, data }),
    ]);
    const signed = signEip1559(
      {
        chainId: this.chains.network(network).chainId,
        nonce,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        gasLimit: estimate
          ? (estimate * 13n) / 10n
          : SANDBOX_TRANSFER_GAS_FALLBACK,
        to: token,
        value: 0n,
        data,
      },
      key,
    );
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
          nonce: nonce.toString(),
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
    await this.chains.sendRawTransaction(network, signed.raw);
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

  private treasuryKey(): Uint8Array {
    const hex = this.config.get('sandbox', { infer: true }).treasuryPrivateKey;
    if (!hex) throw new Error('SANDBOX_TREASURY_PRIVATE_KEY is not set');
    return hexToBytes(hex);
  }
}
