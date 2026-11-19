import { Injectable, Logger } from '@nestjs/common';
import { signEip1559 } from '@/evm/evm-transaction';
import { PrismaService } from '@/prisma/prisma.service';
import { P2pChainClient } from '@/p2p/p2p-chain.client';
import {
  P2pNetworksService,
  type P2pDeployment,
} from '@/p2p/p2p-networks.service';
import {
  P2P_MATCHER_GAS_MARGIN_BPS,
  P2P_MATCHER_NONCE_LOCK_CLASS,
} from '@/p2p/p2p.constants';

/** What the matcher sends: an order's opening, or an act for a buyer it opened an order for. */
export type P2pMatcherKind = 'open' | 'markPaid' | 'cancel' | 'dispute';

export interface P2pMatcherSend {
  kind: P2pMatcherKind;
  orderId: string;
  data: string;
}

/**
 * The only place the matcher key signs. Every transaction is:
 *
 *   1. simulated (`eth_estimateGas`): a call the contract would revert is a
 *      `P2pCallReverted` before anything is signed, so a refused request costs
 *      no gas and burns no nonce;
 *   2. signed and WRITTEN to `p2p_matcher_tx` under the network's nonce lock,
 *      with the next nonce (the higher of the node's pending count and the last
 *      one recorded), so two replicas never sign the same nonce;
 *   3. broadcast, after the row is committed.
 *
 * Only that row's bytes are ever sent again (`P2pMatcherFollowerService`): a
 * nonce is signed once, never re-signed with other fees or another call. The
 * matcher holds gas money and the authority sellers granted it; it never holds
 * a seller's or a buyer's tokens.
 */
@Injectable()
export class P2pMatcherService {
  private readonly logger = new Logger(P2pMatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly networks: P2pNetworksService,
    private readonly chain: P2pChainClient,
  ) {}

  /** Signs, records and broadcasts; answers the transaction hash. */
  async send(d: P2pDeployment, input: P2pMatcherSend): Promise<string> {
    const key = this.networks.matcherKey();
    const from = this.networks.matcherAddress() as string;
    const [estimate, fees] = await Promise.all([
      this.chain.estimateGas(d, { from, to: d.contract, data: input.data }),
      this.chain.feeData(d),
    ]);
    const gasLimit = (estimate * P2P_MATCHER_GAS_MARGIN_BPS) / 10_000n;

    const row = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${P2P_MATCHER_NONCE_LOCK_CLASS}::int, hashtext(${`${d.tier}:${d.network}`}))`;
        const last = await tx.p2pMatcherTx.findFirst({
          where: { tier: d.tier, network: d.network, fromAddress: from },
          orderBy: { nonce: 'desc' },
          select: { nonce: true },
        });
        const pending = await this.chain.pendingNonce(d, from);
        const recorded = last ? last.nonce + 1n : 0n;
        const nonce = pending > recorded ? pending : recorded;
        const signed = signEip1559(
          {
            chainId: d.chainId,
            nonce,
            maxFeePerGas: fees.maxFeePerGas,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
            gasLimit,
            to: d.contract,
            value: 0n,
            data: input.data,
          },
          key,
        );
        return tx.p2pMatcherTx.create({
          data: {
            tier: d.tier,
            network: d.network,
            fromAddress: from,
            nonce,
            kind: input.kind,
            orderId: input.orderId,
            toAddress: d.contract,
            hash: signed.hash,
            raw: signed.raw,
          },
          select: { id: true, hash: true, raw: true },
        });
      },
      { timeout: this.networks.timeoutMs() * 3, maxWait: 5_000 },
    );

    try {
      await this.chain.sendRawTransaction(d, row.raw);
      await this.prisma.p2pMatcherTx.updateMany({
        where: { id: row.id, status: 'signed' },
        data: { status: 'sent', sentAt: new Date() },
      });
    } catch (err) {
      // Recorded and signed: the follower sends these same bytes again. The
      // request is not failed for it, its order simply stays where it is.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `P2P matcher ${input.kind} for order ${input.orderId} on ${d.network}/${d.tier} (${row.hash}) not broadcast yet: ${message}`,
      );
      await this.prisma.p2pMatcherTx.updateMany({
        where: { id: row.id },
        data: { lastError: message.slice(0, 500) },
      });
    }
    return row.hash;
  }
}
