import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type Keypair,
  type Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { Prisma } from '@generated/prisma/client';
import type {
  ProtectedPayment,
  ProtectedPaymentAction,
  ProtectedPaymentTransaction,
} from '@generated/prisma/client';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { isUniqueViolation } from '@/common/prisma-errors';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import {
  type TrustlessWorkSendResult,
  TrustlessWorkClient,
} from '@/native-plugins/trustless-work/trustless-work.client';
import {
  TRUSTLESS_WORK_BUILD_TTL_MS,
  TRUSTLESS_WORK_CLOCK_SKEW_MS,
  TRUSTLESS_WORK_SUBMIT_LEASE_MARGIN_MS,
} from '@/native-plugins/trustless-work/trustless-work.constants';
import {
  builtEnvelopeRefused,
  checkTrustlessWorkEnvelope,
  type DeployFacts,
  type ExpectedTrustlessWorkCall,
} from '@/native-plugins/trustless-work/trustless-work-envelope';
import { PrismaService } from '@/prisma/prisma.service';
import {
  signedEnvelope,
  submittableUntil,
  transactionHash,
} from '@/stellar/soroban-envelope';
import { StellarService } from '@/stellar/stellar.service';

/** Which rows a signed envelope may be matched against. */
export interface SubmitScope {
  protectedPaymentId: string;
  network: StellarNetwork;
  /** The submitting merchant's consumer; absent on the keyless buyer routes. */
  consumerId?: string;
  /** Only rows this account signs (the caller's own address). */
  signer: string;
  /** Only rows of these actions. */
  actions?: readonly ProtectedPaymentAction[];
}

/** What a relay ended in: Trustless Work's answer, stored, and whether it landed. */
export interface RelayOutcome {
  row: ProtectedPaymentTransaction;
  result: TrustlessWorkSendResult;
  /** Trustless Work answered `SUCCESS`. */
  succeeded: boolean;
}

/**
 * The transactions this service built for protected payments, and the one door
 * they leave by: `DefindexTransactionsService`'s design, for Trustless Work.
 *
 *   1. **A build is checked, then recorded** (`record`): the envelope must be
 *      exactly the requested call (`checkTrustlessWorkEnvelope`); a refusal is
 *      logged and answered `502 provider_error`, and nothing is stored.
 *   2. **A submit relays only a recorded row**, found by the signed envelope's
 *      hash within the caller's scope (the protected payment, its network, the
 *      merchant's consumer on the keyed routes, and the caller's own address as
 *      the signer). A miss is `404`: tampered, built for someone else, or never
 *      built here look the same.
 *   3. **Once.** A row Trustless Work already answered returns that stored
 *      answer without calling it again; an expired one is
 *      `400 invalid_state_transition`.
 *   4. **One submit at a time.** BUILT to SUBMITTING is a conditional write; a
 *      concurrent submit is `409 operation_in_flight`, and a claim older than
 *      the Trustless Work timeout plus {@link TRUSTLESS_WORK_SUBMIT_LEASE_MARGIN_MS}
 *      may be taken over.
 *   5. **The answer is stored before it is returned.** When Trustless Work gives
 *      none (an error), the claim is released and the same transaction may be
 *      submitted again: it lands once at most, its sequence number sees to that.
 *
 * The transactions this server signs itself (deploys, the platform's disputes,
 * the automatic resolver's resolutions) go through the same rows and the same
 * claim (`relayServerSigned`).
 */
@Injectable()
export class ProtectedPaymentTransactionsService {
  private readonly logger = new Logger(
    ProtectedPaymentTransactionsService.name,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: TrustlessWorkClient,
    private readonly stellar: StellarService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Checks the envelope Trustless Work built for `expected` and records it for
   * `payment`. Building the same transaction twice keeps the first row.
   */
  async record(
    payment: Pick<ProtectedPayment, 'id' | 'consumerId' | 'network'>,
    expected: ExpectedTrustlessWorkCall,
    envelope: string,
    context?: Prisma.InputJsonValue,
  ): Promise<{
    row: ProtectedPaymentTransaction;
    tx: Transaction;
    deploy?: DeployFacts;
  }> {
    const network = payment.network as StellarNetwork;
    const builtAt = new Date();
    const check = checkTrustlessWorkEnvelope(
      envelope,
      this.stellar.passphrase(network),
      expected,
      {
        maxFeeStroops: BigInt(
          this.config.get('trustlessWork', { infer: true }).maxFeeStroops,
        ),
        maxValidityMs: TRUSTLESS_WORK_BUILD_TTL_MS,
        clockSkewMs: TRUSTLESS_WORK_CLOCK_SKEW_MS,
        now: builtAt,
      },
    );
    if (!check.ok) {
      this.logger.error(
        `Refused a Trustless Work ${expected.action.toLowerCase()} build for ` +
          `protected payment ${payment.id} on ${network}: ${check.reason}`,
      );
      throw builtEnvelopeRefused(expected.action, check.reason);
    }
    const { tx, deploy } = check;
    const txHash = transactionHash(tx);
    const fullContext =
      deploy !== undefined
        ? {
            ...((context as Record<string, unknown> | undefined) ?? {}),
            ...deploy,
          }
        : context;

    let row: ProtectedPaymentTransaction;
    try {
      row = await this.prisma.protectedPaymentTransaction.upsert({
        where: {
          consumerId_txHash: { consumerId: payment.consumerId, txHash },
        },
        create: {
          protectedPaymentId: payment.id,
          consumerId: payment.consumerId,
          network,
          action: expected.action,
          signer: expected.signer,
          xdr: envelope,
          txHash,
          ...(fullContext === undefined ? {} : { context: fullContext }),
          expiresAt: submittableUntil(tx, builtAt, TRUSTLESS_WORK_BUILD_TTL_MS),
        },
        update: {},
      });
    } catch (error) {
      // Two identical builds raced to insert the same row: it exists.
      if (!isUniqueViolation(error)) throw error;
      row = (await this.prisma.protectedPaymentTransaction.findUnique({
        where: {
          consumerId_txHash: { consumerId: payment.consumerId, txHash },
        },
      }))!;
    }
    return { row, tx, ...(deploy ? { deploy } : {}) };
  }

  /**
   * Relays a signed transaction this service built within `scope`, once, and
   * answers Trustless Work's result (the stored one on a replay).
   */
  async submitSigned(
    scope: SubmitScope,
    signedXdr: string,
  ): Promise<RelayOutcome> {
    const tx = signedEnvelope(
      signedXdr,
      this.stellar.passphrase(scope.network),
    );
    const txHash = transactionHash(tx);
    const row = await this.prisma.protectedPaymentTransaction.findFirst({
      where: {
        protectedPaymentId: scope.protectedPaymentId,
        network: scope.network,
        txHash,
        signer: scope.signer,
        ...(scope.consumerId ? { consumerId: scope.consumerId } : {}),
        ...(scope.actions ? { action: { in: [...scope.actions] } } : {}),
      },
    });
    if (!row) {
      this.logger.warn(
        `Refused a protected payment submit for ${scope.protectedPaymentId}: ` +
          `tx ${txHash} was not built here for it on ${scope.network}`,
      );
      throw notBuiltHere();
    }
    return this.relay(row, tx);
  }

  /** Signs a recorded row with one of this server's keys, and relays it. */
  async relayServerSigned(
    row: ProtectedPaymentTransaction,
    key: Keypair,
  ): Promise<RelayOutcome> {
    if (key.publicKey() !== row.signer) {
      throw new Error(
        `Refusing to sign ${row.id} with ${key.publicKey()}: it is ${row.signer}'s`,
      );
    }
    const tx = TransactionBuilder.fromXDR(
      row.xdr,
      this.stellar.passphrase(row.network as StellarNetwork),
    ) as Transaction;
    tx.sign(key);
    return this.relay(row, tx);
  }

  /** The newest row of `action` for a protected payment. */
  latest(
    protectedPaymentId: string,
    action: ProtectedPaymentAction,
  ): Promise<ProtectedPaymentTransaction | null> {
    return this.prisma.protectedPaymentTransaction.findFirst({
      where: { protectedPaymentId, action },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Whether a transaction of `action` handed out for this payment could still
   * land: built or being submitted, and not past its time bounds. A cancel and
   * an expiry wait for an outstanding fund to lapse, so no deposit lands in a
   * payment that already ended.
   */
  async outstanding(
    protectedPaymentId: string,
    action: ProtectedPaymentAction,
    now: Date,
  ): Promise<boolean> {
    const count = await this.prisma.protectedPaymentTransaction.count({
      where: {
        protectedPaymentId,
        action,
        status: { in: ['BUILT', 'SUBMITTING'] },
        expiresAt: { gte: now },
      },
    });
    return count > 0;
  }

  /** The claim, the relay and the stored answer: see the class docblock. */
  private async relay(
    row: ProtectedPaymentTransaction,
    tx: Transaction,
  ): Promise<RelayOutcome> {
    if (row.status === 'SUBMITTED') return outcome(row, row.result);

    const now = new Date();
    if (now > row.expiresAt) throw expired();

    const claimedAt = now;
    const claim = await this.prisma.protectedPaymentTransaction.updateMany({
      where: {
        id: row.id,
        expiresAt: { gte: now },
        OR: [
          { status: 'BUILT' },
          {
            status: 'SUBMITTING',
            claimedAt: { lt: new Date(now.getTime() - this.leaseMs()) },
          },
        ],
      },
      data: { status: 'SUBMITTING', claimedAt },
    });
    if (claim.count === 0) return this.answerLostClaim(row.id);

    let result: TrustlessWorkSendResult;
    try {
      result = await this.client.send(
        row.network as StellarNetwork,
        tx.toXDR(),
      );
    } catch (error) {
      await this.prisma.protectedPaymentTransaction.updateMany({
        where: { id: row.id, status: 'SUBMITTING', claimedAt },
        data: { status: 'BUILT', claimedAt: null },
      });
      throw error;
    }

    const stored = await this.prisma.protectedPaymentTransaction.updateMany({
      where: { id: row.id, status: 'SUBMITTING', claimedAt },
      data: {
        status: 'SUBMITTED',
        submittedAt: new Date(),
        result: result as Prisma.InputJsonValue,
      },
    });
    if (stored.count === 0) {
      // Taken over as abandoned, and that submit stored its answer: every
      // caller gets the same one.
      const settled = await this.prisma.protectedPaymentTransaction.findUnique({
        where: { id: row.id },
      });
      if (settled?.status === 'SUBMITTED') {
        return outcome(settled, settled.result);
      }
    }
    this.logger.log(
      `Protected payment ${row.protectedPaymentId}: ${row.action.toLowerCase()} ` +
        `relayed (tx=${row.txHash}, ${result.status})`,
    );
    return outcome(
      { ...row, status: 'SUBMITTED', result: result as Prisma.JsonValue },
      result,
    );
  }

  private async answerLostClaim(id: string): Promise<RelayOutcome> {
    const current = await this.prisma.protectedPaymentTransaction.findUnique({
      where: { id },
    });
    if (current?.status === 'SUBMITTED')
      return outcome(current, current.result);
    if (current?.status === 'SUBMITTING') {
      throw ApiError.conflict(
        ApiErrorCode.OperationInFlight,
        'This protected payment transaction is already being submitted. Wait ' +
          'for that submit to finish, then submit it again to read its result.',
      );
    }
    throw expired();
  }

  private leaseMs(): number {
    return this.client.timeoutMs + TRUSTLESS_WORK_SUBMIT_LEASE_MARGIN_MS;
  }
}

function outcome(
  row: ProtectedPaymentTransaction,
  stored: unknown,
): RelayOutcome {
  const result = (
    stored && typeof stored === 'object' ? stored : { status: 'FAILED' }
  ) as TrustlessWorkSendResult;
  return { row, result, succeeded: result.status === 'SUCCESS' };
}

function notBuiltHere(): ApiError {
  return ApiError.notFound(
    'This transaction was not built for this protected payment by this ' +
      'service, for this signer, on this network. Build it here, sign it ' +
      'unchanged, and submit it before it expires.',
  );
}

function expired(): ApiError {
  return ApiError.badRequest(
    ApiErrorCode.InvalidStateTransition,
    'This protected payment transaction expired before it was submitted and ' +
      'can no longer be relayed. Build a new one.',
  );
}
