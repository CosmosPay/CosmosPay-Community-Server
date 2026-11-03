import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { requestUpstreamJson, UpstreamNotFound } from '@/common/upstream-http';
import type {
  AppConfig,
  StellarNetwork,
  TrustlessWorkNetworkConfig,
} from '@/config/configuration';
import { trustlessWorkEnvName } from '@/native-plugins/trustless-work/trustless-work-config';

const PROVIDER = 'Trustless Work';

/** The six roles of a V1 single-release contract, as the API names them. */
export interface TrustlessWorkRoles {
  approver: string;
  serviceProvider: string;
  platformAddress: string;
  releaseSigner: string;
  disputeResolver: string;
  receiver: string;
}

/** `POST /deployer/single-release`. Amounts in token units, the fee in percent. */
export interface TrustlessWorkDeployBody {
  signer: string;
  engagementId: string;
  title: string;
  description: string;
  roles: TrustlessWorkRoles;
  amount: number;
  platformFee: number;
  milestones: { description: string }[];
  trustline: { address: string; symbol: string };
}

/** What `POST /helper/send-transaction` answers (a deploy adds `contractId`, `escrow`). */
export interface TrustlessWorkSendResult {
  status: string;
  message?: string;
  contractId?: string;
  [key: string]: unknown;
}

/**
 * One contract as `GET /helper/get-escrow-by-contract-ids` answers it, read
 * only for what the sync needs. Every field is optional: the indexer's shape
 * is Trustless Work's, and a missing field reads as "not yet".
 */
export interface TrustlessWorkContractRead {
  contractId?: string;
  balance?: number | string;
  milestones?: { status?: string; evidence?: string; approved?: boolean }[];
  flags?: { disputed?: boolean; released?: boolean; resolved?: boolean };
  [key: string]: unknown;
}

/** Every V1 write endpoint's answer: an unsigned envelope to sign. */
interface BuildAnswer {
  status?: unknown;
  unsignedTransaction?: unknown;
  message?: unknown;
}

/**
 * The Trustless Work V1 REST API, as this plugin uses it: the one place that
 * holds the per-network API keys, builds Trustless Work's URLs and turns its
 * failures into this service's errors (through `requestUpstreamJson`).
 *
 *  - A network whose `TRUSTLESS_WORK_API_KEY_*` is empty answers
 *    `503 misconfigured` before any call.
 *  - Trustless Work's 400 (it refused the request: a validation of its own) is
 *    `400 provider_error`; a refused key is `503 misconfigured` naming the
 *    variable; its rate limit `503 provider_unavailable`; a 5xx (how V1 reports
 *    a contract error at simulation, `{ status: "FAILED", message }`)
 *    `502 provider_error`; a timeout `504`.
 *  - A 2xx answer that says `FAILED`, or a build with no envelope in it, is
 *    `502 provider_error` with Trustless Work's message.
 *  - A 404 is `502 provider_error` too, except on the contract read, where it
 *    means none of the contracts is indexed yet.
 */
@Injectable()
export class TrustlessWorkClient {
  private readonly logger = new Logger(TrustlessWorkClient.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  /** How long one Trustless Work call may take: a submit's claim outlives it. */
  get timeoutMs(): number {
    return this.config.get('trustlessWork', { infer: true }).timeoutMs;
  }

  deploy(network: StellarNetwork, body: TrustlessWorkDeployBody) {
    return this.build(network, '/deployer/single-release', body);
  }

  fund(
    network: StellarNetwork,
    body: { contractId: string; signer: string; amount: number },
  ) {
    return this.build(network, '/escrow/single-release/fund-escrow', body);
  }

  changeMilestoneStatus(
    network: StellarNetwork,
    body: {
      contractId: string;
      milestoneIndex: string;
      newStatus: string;
      newEvidence: string;
      serviceProvider: string;
    },
  ) {
    return this.build(
      network,
      '/escrow/single-release/change-milestone-status',
      body,
    );
  }

  approveMilestone(
    network: StellarNetwork,
    body: { contractId: string; milestoneIndex: string; approver: string },
  ) {
    return this.build(
      network,
      '/escrow/single-release/approve-milestone',
      body,
    );
  }

  releaseFunds(
    network: StellarNetwork,
    body: { contractId: string; releaseSigner: string },
  ) {
    return this.build(network, '/escrow/single-release/release-funds', body);
  }

  disputeEscrow(
    network: StellarNetwork,
    body: { contractId: string; signer: string },
  ) {
    return this.build(network, '/escrow/single-release/dispute-escrow', body);
  }

  resolveDispute(
    network: StellarNetwork,
    body: {
      contractId: string;
      disputeResolver: string;
      distributions: { address: string; amount: number }[];
    },
  ) {
    return this.build(network, '/escrow/single-release/resolve-dispute', body);
  }

  /** Relays a signed transaction and waits for Trustless Work's answer. */
  async send(
    network: StellarNetwork,
    signedXdr: string,
  ): Promise<TrustlessWorkSendResult> {
    const answer = await this.request<unknown>(network, {
      method: 'POST',
      path: '/helper/send-transaction',
      body: { signedXdr },
    });
    if (!answer || typeof answer !== 'object') {
      throw providerError('Trustless Work answered the submit with no result.');
    }
    const result = answer as TrustlessWorkSendResult;
    if (typeof result.status !== 'string') {
      throw providerError('Trustless Work answered the submit with no status.');
    }
    return result;
  }

  /**
   * The contracts with these ids, read through Trustless Work's indexer and
   * checked against the chain (`validateOnChain=true`). At most
   * `TRUSTLESS_WORK_READ_BATCH` per call; the caller batches.
   */
  async contracts(
    network: StellarNetwork,
    contractIds: readonly string[],
  ): Promise<TrustlessWorkContractRead[]> {
    if (contractIds.length === 0) return [];
    const params = new URLSearchParams();
    for (const id of contractIds) params.append('contractIds[]', id);
    params.append('validateOnChain', 'true');
    try {
      const answer = await this.request<unknown>(network, {
        method: 'GET',
        path: `/helper/get-escrow-by-contract-ids?${params.toString()}`,
      });
      return Array.isArray(answer)
        ? (answer.filter(
            (item) => item && typeof item === 'object',
          ) as TrustlessWorkContractRead[])
        : [];
    } catch (error) {
      if (error instanceof UpstreamNotFound) return [];
      throw error;
    }
  }

  /** A V1 write: Trustless Work simulates the call and answers the envelope. */
  private async build(
    network: StellarNetwork,
    path: string,
    body: unknown,
  ): Promise<string> {
    let answer: BuildAnswer | null;
    try {
      answer = await this.request<BuildAnswer | null>(network, {
        method: 'POST',
        path,
        body,
      });
    } catch (error) {
      if (error instanceof UpstreamNotFound) {
        throw providerError(`Trustless Work does not serve ${path}.`);
      }
      throw error;
    }
    if (answer?.status !== 'SUCCESS') {
      throw providerError(
        `Trustless Work could not build the transaction${reason(answer)}`,
      );
    }
    if (
      typeof answer.unsignedTransaction !== 'string' ||
      answer.unsignedTransaction === ''
    ) {
      throw providerError('Trustless Work returned no transaction to sign.');
    }
    return answer.unsignedTransaction;
  }

  private request<T>(
    network: StellarNetwork,
    call: { method: 'GET' | 'POST'; path: string; body?: unknown },
  ): Promise<T> {
    const cfg = this.settings(network);
    return requestUpstreamJson<T>(
      {
        provider: PROVIDER,
        keyEnv: trustlessWorkEnvName(network, 'API_KEY'),
        method: call.method,
        url: `${cfg.baseUrl}${call.path}`,
        headers: { 'x-api-key': cfg.apiKey },
        ...(call.body === undefined ? {} : { body: call.body }),
        timeoutMs: this.timeoutMs,
      },
      this.logger,
    );
  }

  private settings(network: StellarNetwork): TrustlessWorkNetworkConfig {
    const cfg = this.config.get('trustlessWork', { infer: true }).networks[
      network
    ];
    if (!cfg.apiKey) {
      throw ApiError.unavailable(
        ApiErrorCode.Misconfigured,
        `Trustless Work is not configured on ${network}: set ` +
          `${trustlessWorkEnvName(network, 'API_KEY')}.`,
      );
    }
    return cfg;
  }
}

function providerError(message: string): ApiError {
  return ApiError.badGateway(ApiErrorCode.ProviderError, message);
}

/** `: <Trustless Work's message>.`, or `.` when it gave none. */
function reason(answer: BuildAnswer | null): string {
  const message =
    answer && typeof answer.message === 'string' ? answer.message.trim() : '';
  return message ? `: ${message.slice(0, 300)}` : '.';
}
