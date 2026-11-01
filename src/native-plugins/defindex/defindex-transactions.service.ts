import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { VaultTransactionResponse } from '@defindex/sdk';
import { Prisma } from '@generated/prisma/client';
import type { DefindexTransaction } from '@generated/prisma/client';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { isUniqueViolation } from '@/common/prisma-errors';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { resolveNetwork } from '@/common/stellar-network';
import { AppConfig, StellarNetwork } from '@/config/configuration';
import { DefindexClient } from '@/native-plugins/defindex/defindex.client';
import {
  DEFINDEX_BUILD_TTL_MS,
  DEFINDEX_SUBMIT_LEASE_MARGIN_MS,
} from '@/native-plugins/defindex/defindex.constants';
import {
  type ExpectedDefindexCall,
  signedEnvelope,
  submittableUntil,
  transactionHash,
  verifyBuiltEnvelope,
} from '@/native-plugins/defindex/defindex-envelope';
import { PrismaService } from '@/prisma/prisma.service';
import { StellarService } from '@/stellar/stellar.service';

/** DeFindex's name for the operation a row records. */
const KIND_COLUMN = {
  deposit: 'DEPOSIT',
  withdraw: 'WITHDRAW',
} as const satisfies Record<
  ExpectedDefindexCall['kind'],
  DefindexTransaction['kind']
>;

/**
 * The DeFindex transactions this service built, and the one door they leave by.
 *
 * `POST /v1/defindex/submit` used to hand ANY signed XDR to DeFindex, which
 * broadcast it: the service was an open relay for arbitrary transactions,
 * under its own DeFindex API key and with the shared public key able to reach
 * it. Now a build records the envelope it handed out (`record`), and a submit
 * relays a signed transaction only when it is one of those (`submit`):
 *
 *   1. **The envelope first.** It must parse under the passphrase of the
 *      submitting key's network, not be a fee bump and carry a signature.
 *   2. **Then the row, by the envelope's hash**, filtered by the calling
 *      consumer and the key's network. Signing does not change a transaction's
 *      hash and any other change does, so a hit is exactly "a signed copy of a
 *      transaction built here for this consumer on this network". A miss is
 *      `404 not_found` whether the transaction was tampered with, built by
 *      DeFindex for someone else, or never built at all: "exists but not yours"
 *      is an ownership oracle.
 *   3. **Once.** A row DeFindex already answered for returns that stored answer
 *      and DeFindex is not called again. A row past `expiresAt` is
 *      `400 invalid_state_transition`.
 *   4. **One submit at a time.** A conditional write (BUILT → SUBMITTING) claims
 *      the row; a concurrent submit of the same transaction gets
 *      `409 operation_in_flight`. A claim older than the DeFindex timeout plus
 *      {@link DEFINDEX_SUBMIT_LEASE_MARGIN_MS} is abandoned and may be taken over.
 *   5. **DeFindex's answer is stored before it is returned** (SUBMITTING →
 *      SUBMITTED). When DeFindex does not answer (a 502 or 503), the claim is
 *      released and the same transaction may be submitted again: it can still
 *      land only once, its sequence number sees to that.
 */
@Injectable()
export class DefindexTransactionsService {
  private readonly logger = new Logger(DefindexTransactionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly consumers: ConsumerResolverService,
    private readonly client: DefindexClient,
    private readonly stellar: StellarService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Records the envelope DeFindex built for `expected`, after checking it is
   * that call (`verifyBuiltEnvelope`). Building the same transaction twice
   * keeps the first row: its bytes, and so its deadline, are the same.
   */
  async record(
    consumer: GatewayConsumer,
    network: StellarNetwork,
    expected: ExpectedDefindexCall,
    built: VaultTransactionResponse,
  ): Promise<void> {
    const envelope = builtXdr(built);
    if (!envelope) {
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        `DeFindex returned no transaction to sign for the ${expected.kind}`,
      );
    }
    const tx = verifyBuiltEnvelope(
      envelope,
      this.stellar.passphrase(network),
      expected,
    );
    const txHash = transactionHash(tx);
    const builtAt = new Date();
    const local = await this.consumers.resolve(consumer);

    try {
      await this.prisma.defindexTransaction.upsert({
        where: { consumerId_txHash: { consumerId: local.id, txHash } },
        create: {
          consumerId: local.id,
          network,
          kind: KIND_COLUMN[expected.kind],
          vault: expected.vault,
          caller: expected.caller,
          xdr: envelope,
          txHash,
          expiresAt: submittableUntil(tx, builtAt, DEFINDEX_BUILD_TTL_MS),
        },
        update: {},
      });
    } catch (error) {
      // Two identical builds raced to insert the same row: it exists, which is
      // all this needed.
      if (!isUniqueViolation(error)) throw error;
    }
  }

  /**
   * Relays a signed transaction this service built for the caller, once, and
   * answers DeFindex's result (the stored one on a replay). See the class
   * docblock for the order of the checks.
   */
  async submit(consumer: GatewayConsumer, signedXdr: string): Promise<unknown> {
    const network = resolveNetwork(this.config, consumer);
    const tx = signedEnvelope(signedXdr, this.stellar.passphrase(network));
    const txHash = transactionHash(tx);
    const consumerId = await this.consumers.resolveId(consumer);

    const row = await this.prisma.defindexTransaction.findFirst({
      where: { consumerId, network, txHash },
    });
    if (!row) {
      this.logger.warn(
        `Refused DeFindex submit by ${consumer.username}: tx ${txHash} was not built here for this key on ${network}`,
      );
      throw notBuiltHere();
    }
    if (row.status === 'SUBMITTED') return row.result;

    const now = new Date();
    if (now > row.expiresAt) throw expired();

    const claimedAt = now;
    const claim = await this.prisma.defindexTransaction.updateMany({
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

    let result: unknown;
    try {
      result = await this.client.send(network, tx.toXDR());
    } catch (error) {
      // DeFindex gave no answer to store: release the claim so the caller can
      // submit the same transaction again.
      await this.prisma.defindexTransaction.updateMany({
        where: { id: row.id, status: 'SUBMITTING', claimedAt },
        data: { status: 'BUILT', claimedAt: null },
      });
      throw error;
    }

    const stored = await this.prisma.defindexTransaction.updateMany({
      where: { id: row.id, status: 'SUBMITTING', claimedAt },
      data: {
        status: 'SUBMITTED',
        submittedAt: new Date(),
        result: asJson(result),
      },
    });
    if (stored.count === 0) {
      // Our claim was taken over as abandoned and that submit already stored
      // an answer: every caller gets the same one.
      const settled = await this.prisma.defindexTransaction.findUnique({
        where: { id: row.id },
      });
      if (settled?.status === 'SUBMITTED') return settled.result;
    }
    this.logger.log(
      `DeFindex ${row.kind.toLowerCase()} ${row.id} submitted (tx=${txHash})`,
    );
    return result;
  }

  /** Why the claim did not take: answered meanwhile, in flight, or expired. */
  private async answerLostClaim(id: string): Promise<unknown> {
    const current = await this.prisma.defindexTransaction.findUnique({
      where: { id },
    });
    if (current?.status === 'SUBMITTED') return current.result;
    if (current?.status === 'SUBMITTING') {
      throw ApiError.conflict(
        ApiErrorCode.OperationInFlight,
        'This DeFindex transaction is already being submitted. Wait for that ' +
          'submit to finish, then submit it again to read its result.',
      );
    }
    throw expired();
  }

  /** How long a claim stands before another submit may take it over. */
  private leaseMs(): number {
    return this.client.timeoutMs + DEFINDEX_SUBMIT_LEASE_MARGIN_MS;
  }
}

/** The envelope in a build answer: `xdr`, or the older `transactionXdr`. */
function builtXdr(built: VaultTransactionResponse): string | null {
  const answer = built as VaultTransactionResponse & {
    transactionXdr?: unknown;
  };
  if (typeof answer.xdr === 'string' && answer.xdr) return answer.xdr;
  return typeof answer.transactionXdr === 'string' && answer.transactionXdr
    ? answer.transactionXdr
    : null;
}

/** DeFindex's answer as a JSON column value (null when it sent no body). */
function asJson(
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null || value === undefined ? Prisma.JsonNull : value;
}

function notBuiltHere(): ApiError {
  return ApiError.notFound(
    'This transaction was not built by POST /v1/defindex/vaults/{vault}/deposit ' +
      'or /withdraw for this API key on this network. Build it here, sign it ' +
      'unchanged, and submit it before it expires.',
  );
}

function expired(): ApiError {
  return ApiError.badRequest(
    ApiErrorCode.InvalidStateTransition,
    'This DeFindex transaction expired before it was submitted and can no ' +
      'longer be relayed. Build a new one.',
  );
}
