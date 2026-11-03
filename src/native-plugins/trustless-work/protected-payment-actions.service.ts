import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Asset, type Keypair } from '@stellar/stellar-sdk';
import type {
  Prisma,
  ProtectedPayment,
  ProtectedPaymentAction,
  ProtectedPaymentTransaction,
} from '@generated/prisma/client';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import { StellarAccountLoader } from '@/stellar/account-loader.service';
import { resolveAsset } from '@/stellar/asset';
import { StellarService } from '@/stellar/stellar.service';
import { fromStroops, toStroops } from '@/swaps/swap-math';
import { assertDisputeChallengeSigned } from '@/native-plugins/trustless-work/protected-payment-dispute-challenge';
import { ProtectedPaymentLifecycle } from '@/native-plugins/trustless-work/protected-payment-lifecycle.service';
import {
  apiAmount,
  apiPlatformFee,
  balanceStroops,
  checkedSplit,
  type Split,
} from '@/native-plugins/trustless-work/protected-payment-math';
import {
  approvesUnder,
  contractRoles,
  holdsRole,
  type Party,
  releasesUnder,
} from '@/native-plugins/trustless-work/protected-payment-roles';
import {
  type RelayOutcome,
  type SubmitScope,
  ProtectedPaymentTransactionsService,
} from '@/native-plugins/trustless-work/protected-payment-transactions.service';
import {
  ACTION_STEP,
  canBuild,
} from '@/native-plugins/trustless-work/protected-payment-transitions';
import { TrustlessWorkClient } from '@/native-plugins/trustless-work/trustless-work.client';
import {
  PROTECTED_PAYMENT_ASSET_CODE,
  PROTECTED_PAYMENT_DEPLOY_CALLS,
  PROTECTED_PAYMENT_MILESTONE_DESCRIPTION,
  PROTECTED_PAYMENT_MILESTONE_INDEX,
  PROTECTED_PAYMENT_SHIPPED_STATUS,
  TRUSTLESS_WORK_SUBMIT_LEASE_MARGIN_MS,
} from '@/native-plugins/trustless-work/trustless-work.constants';
import type { ExpectedContract } from '@/native-plugins/trustless-work/trustless-work-envelope';
import { TrustlessWorkKeys } from '@/native-plugins/trustless-work/trustless-work-keys';

/** An envelope handed out to sign: recorded for the submit. */
export interface BuiltTransaction {
  action: ProtectedPaymentAction;
  xdr: string;
  txHash: string;
  expiresAt: Date;
  payment: ProtectedPayment;
}

/** What a relay answered, and the payment after it. */
export interface SubmittedTransaction {
  action: ProtectedPaymentAction;
  txHash: string;
  status: string;
  message: string | null;
  payment: ProtectedPayment;
}

/** A dispute is either handed out to sign, or opened by the platform. */
export type DisputeOutcome =
  | { built: BuiltTransaction; submitted?: undefined }
  | { built?: undefined; submitted: SubmittedTransaction };

/** A resolution is handed to the ops wallet, or signed by the automatic resolver. */
export type ResolveOutcome = DisputeOutcome;

/** What a party's signed message brings to a dispute the platform opens. */
export interface DisputeProof {
  signature: string;
  expiresAt: string;
}

/** Context a dispute row carries, applied when it lands. */
interface DisputeContext {
  by: 'BUYER' | 'MERCHANT' | 'DEADLINE';
  reason: string | null;
}

/**
 * Everything that moves a protected payment on-chain: the builds each party
 * signs, the transactions this server signs itself (the deploy, the platform's
 * disputes, the automatic resolver's resolutions), and what a landed
 * transaction does to the row. Who may call which is the callers' to decide
 * (the merchant's service, the payment link's service, the admin route, the
 * jobs); this checks only what the payment itself allows.
 *
 * Every envelope goes through `ProtectedPaymentTransactionsService.record`
 * first, which refuses (502) anything but the exact call asked for.
 */
@Injectable()
export class ProtectedPaymentActionsService {
  private readonly logger = new Logger(ProtectedPaymentActionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: TrustlessWorkClient,
    private readonly keys: TrustlessWorkKeys,
    private readonly transactions: ProtectedPaymentTransactionsService,
    private readonly lifecycle: ProtectedPaymentLifecycle,
    private readonly accounts: StellarAccountLoader,
    private readonly stellar: StellarService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  // ── Fund (and the deploy before it) ──────────────────────────────────────

  /**
   * The buyer's deposit, to sign. The first call deploys the contract, signed
   * and paid for by the platform key, and binds `buyer`: once per payment, and
   * a different buyer afterwards (or one the merchant did not name) is
   * `409 protected_payment_buyer_mismatch`.
   */
  async fund(
    payment: ProtectedPayment,
    buyer: string,
  ): Promise<BuiltTransaction> {
    this.assertBuildable(payment, 'FUND');
    if (new Date() > payment.fundingExpiresAt) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        `The funding window of protected payment ${payment.id} closed at ` +
          `${payment.fundingExpiresAt.toISOString()}.`,
      );
    }
    this.assertBuyer(payment, buyer);

    const current = payment.contractId
      ? payment
      : await this.deploy(payment, buyer);
    // The deploy binds the buyer; a deploy adopted from an earlier call bound
    // whoever that call named.
    this.assertBuyer(current, buyer);
    const network = this.networkOf(current);
    const amount = toStroops(current.amount);
    const xdr = await this.client.fund(network, {
      contractId: current.contractId!,
      signer: buyer,
      amount: apiAmount(amount),
    });
    const { row } = await this.transactions.record(
      current,
      {
        action: 'FUND',
        signer: buyer,
        contractId: current.contractId!,
        contract: this.expectedContract(current),
        amount,
      },
      xdr,
    );
    return built(row, current);
  }

  /** The buyer a fund names must be the bound one, and none of the other roles. */
  private assertBuyer(payment: ProtectedPayment, buyer: string): void {
    if (payment.buyerAddress && payment.buyerAddress !== buyer) {
      throw ApiError.conflict(
        ApiErrorCode.ProtectedPaymentBuyerMismatch,
        'This protected payment is bound to another buyer: only ' +
          `${payment.buyerAddress} may fund it.`,
      );
    }
    if (buyer === payment.merchantAddress) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'The buyer cannot be the merchant of the protected payment.',
      );
    }
    if (this.keys.serverAccounts(this.networkOf(payment)).includes(buyer)) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'The buyer cannot be one of the platform accounts.',
      );
    }
  }

  /**
   * Deploys the contract for `buyer`, or adopts one a previous call already
   * deployed. Holds a lease on the row (`deployClaimedAt`) for the build and
   * the relay, so two fund calls at once never deploy two contracts.
   */
  private async deploy(
    payment: ProtectedPayment,
    buyer: string,
  ): Promise<ProtectedPayment> {
    const recovered = await this.recoverDeploy(payment);
    if (recovered) return recovered;

    await this.preflight(payment, buyer);
    const network = this.networkOf(payment);
    const platform = this.keys.platform(network);
    const claimed = await this.claimDeploy(
      payment,
      buyer,
      platform.publicKey(),
    );
    if (claimed.contractId) return claimed;

    try {
      const contract = this.expectedContract(claimed);
      const xdr = await this.client.deploy(network, {
        signer: platform.publicKey(),
        engagementId: claimed.id,
        title: contract.title,
        description: contract.description,
        roles: {
          approver: contract.roles.approver,
          serviceProvider: contract.roles.serviceProvider,
          platformAddress: contract.roles.platform,
          releaseSigner: contract.roles.releaseSigner,
          disputeResolver: contract.roles.disputeResolver,
          receiver: contract.roles.receiver,
        },
        amount: apiAmount(contract.amount),
        platformFee: apiPlatformFee(contract.platformFeeBps),
        milestones: [{ description: contract.milestoneDescription }],
        // An object, as the official SDK's type has it; the V1 OpenAPI says an
        // array. The check below holds the contract to USDC's SAC either way.
        trustline: {
          address: contract.token,
          symbol: PROTECTED_PAYMENT_ASSET_CODE,
        },
      });
      const { row, deploy } = await this.transactions.record(
        claimed,
        {
          action: 'DEPLOY',
          signer: platform.publicKey(),
          contract,
          pins: this.keys.pins(network),
        },
        xdr,
      );
      this.logger.log(
        `Deploying protected payment ${claimed.id} on ${network}: deployer ` +
          `${deploy!.deployer}, wasm ${deploy!.wasmHash}, contract ${deploy!.contractId}`,
      );
      return await this.finishDeploy(claimed, row, platform);
    } finally {
      await this.prisma.protectedPayment.updateMany({
        where: { id: claimed.id, deployClaimedAt: claimed.deployClaimedAt },
        data: { deployClaimedAt: null },
      });
    }
  }

  /** Relays a recorded deploy and records its contract. */
  private async finishDeploy(
    payment: ProtectedPayment,
    row: ProtectedPaymentTransaction,
    platform: Keypair,
  ): Promise<ProtectedPayment> {
    const outcome = await this.transactions.relayServerSigned(row, platform);
    const derived = contextOf(outcome.row).contractId;
    if (!outcome.succeeded || typeof derived !== 'string') {
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        `Trustless Work could not deploy the protected payment's contract` +
          `${outcome.result.message ? `: ${outcome.result.message}` : '.'}`,
      );
    }
    if (outcome.result.contractId && outcome.result.contractId !== derived) {
      // The id the network gives a deploy is derived from the deployer and the
      // salt the platform signed; Trustless Work's answer is only a report.
      this.logger.error(
        `Trustless Work reported contract ${outcome.result.contractId} for ` +
          `protected payment ${payment.id}, but the signed deploy creates ` +
          `${derived}: keeping ${derived}`,
      );
    }
    return this.lifecycle.deployed(payment.id, derived);
  }

  /**
   * A deploy a previous call already recorded: landed (adopt its contract),
   * still submittable (relay it again, which lands once at most), or lapsed but
   * perhaps landed anyway (adopt the contract when the chain shows it).
   */
  private async recoverDeploy(
    payment: ProtectedPayment,
  ): Promise<ProtectedPayment | null> {
    const last = await this.transactions.latest(payment.id, 'DEPLOY');
    if (!last) return null;
    const derived = contextOf(last).contractId;
    if (typeof derived !== 'string') return null;
    const succeeded =
      last.status === 'SUBMITTED' &&
      (last.result as { status?: unknown } | null)?.status === 'SUCCESS';
    if (succeeded) return this.lifecycle.deployed(payment.id, derived);

    const network = this.networkOf(payment);
    if (last.status !== 'SUBMITTED' && last.expiresAt > new Date()) {
      return this.finishDeploy(payment, last, this.keys.platform(network));
    }
    const onChain = await this.client.contracts(network, [derived]);
    if (onChain.some((c) => c.contractId === derived)) {
      return this.lifecycle.deployed(payment.id, derived);
    }
    return null;
  }

  /**
   * Refuses, before the platform spends anything, a deploy whose fund or
   * release could only fail: a buyer that does not exist, does not trust USDC
   * or holds less than the amount, and a merchant that cannot receive USDC.
   */
  private async preflight(
    payment: ProtectedPayment,
    buyer: string,
  ): Promise<void> {
    const network = this.networkOf(payment);
    const asset = resolveAsset(
      PROTECTED_PAYMENT_ASSET_CODE,
      payment.assetIssuer,
    );
    const buyerAccount = await this.accounts.load(network, buyer);
    this.accounts.assertTrustline(
      buyerAccount.balances,
      asset,
      buyer,
      'it can fund this protected payment',
    );
    const held = buyerAccount.balances.find(
      (b) =>
        'asset_code' in b &&
        b.asset_code === asset.code &&
        b.asset_issuer === asset.issuer,
    )?.balance;
    const amount = toStroops(payment.amount);
    if (toStroops(held ?? '0') < amount) {
      throw ApiError.badRequest(
        ApiErrorCode.InsufficientBalance,
        `Account ${buyer} holds ${held ?? '0'} USDC; this protected payment ` +
          `takes ${fromStroops(amount)}.`,
      );
    }
    const merchant = await this.accounts.load(network, payment.merchantAddress);
    this.accounts.assertCanReceive(
      merchant.balances,
      asset,
      payment.merchantAddress,
      'this protected payment',
    );
  }

  /** Takes the deploy lease and binds the buyer, or explains why it cannot. */
  private async claimDeploy(
    payment: ProtectedPayment,
    buyer: string,
    platform: string,
  ): Promise<ProtectedPayment> {
    const network = this.networkOf(payment);
    const now = new Date();
    const lease =
      this.client.timeoutMs * PROTECTED_PAYMENT_DEPLOY_CALLS +
      TRUSTLESS_WORK_SUBMIT_LEASE_MARGIN_MS;
    const claim = await this.prisma.protectedPayment.updateMany({
      where: {
        id: payment.id,
        status: 'CREATED',
        contractId: null,
        AND: [
          { OR: [{ buyerAddress: null }, { buyerAddress: buyer }] },
          {
            OR: [
              { deployClaimedAt: null },
              { deployClaimedAt: { lt: new Date(now.getTime() - lease) } },
            ],
          },
        ],
      },
      data: {
        buyerAddress: buyer,
        deployClaimedAt: now,
        platformAddress: platform,
        disputeResolverAddress: this.keys.disputeResolverFor(
          network,
          payment.deadlinePolicy,
        ),
      },
    });
    const current = await this.prisma.protectedPayment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    if (claim.count === 1) return current;
    if (current.contractId) return current;
    if (current.buyerAddress && current.buyerAddress !== buyer) {
      this.assertBuyer(current, buyer);
    }
    if (current.status !== 'CREATED') this.assertBuildable(current, 'FUND');
    throw ApiError.conflict(
      ApiErrorCode.OperationInFlight,
      'This protected payment is being deployed by another request. Retry in ' +
        'a few seconds.',
    );
  }

  // ── The parties' builds ──────────────────────────────────────────────────

  /** The merchant marks the milestone shipped, with its tracking evidence. */
  async ship(
    payment: ProtectedPayment,
    evidence: string,
  ): Promise<BuiltTransaction> {
    this.assertBuildable(payment, 'SHIP');
    const network = this.networkOf(payment);
    const xdr = await this.client.changeMilestoneStatus(network, {
      contractId: payment.contractId!,
      milestoneIndex: String(PROTECTED_PAYMENT_MILESTONE_INDEX),
      newStatus: PROTECTED_PAYMENT_SHIPPED_STATUS,
      newEvidence: evidence,
      serviceProvider: payment.merchantAddress,
    });
    const { row } = await this.transactions.record(
      payment,
      {
        action: 'SHIP',
        signer: payment.merchantAddress,
        contractId: payment.contractId!,
        milestoneIndex: PROTECTED_PAYMENT_MILESTONE_INDEX,
        status: PROTECTED_PAYMENT_SHIPPED_STATUS,
        evidence,
      },
      xdr,
      { evidence },
    );
    return built(row, payment);
  }

  /** The approver (by the release model) approves the milestone. */
  async approve(
    payment: ProtectedPayment,
    party: Party,
  ): Promise<BuiltTransaction> {
    if (!approvesUnder(payment.releaseModel, party)) {
      throw notYourRole(payment, party, 'approve');
    }
    this.assertBuildable(payment, 'APPROVE');
    const signer = this.partyAddress(payment, party);
    const xdr = await this.client.approveMilestone(this.networkOf(payment), {
      contractId: payment.contractId!,
      milestoneIndex: String(PROTECTED_PAYMENT_MILESTONE_INDEX),
      approver: signer,
    });
    const { row } = await this.transactions.record(
      payment,
      {
        action: 'APPROVE',
        signer,
        contractId: payment.contractId!,
        milestoneIndex: PROTECTED_PAYMENT_MILESTONE_INDEX,
      },
      xdr,
    );
    return built(row, payment);
  }

  /** The release signer (by the release model) releases the funds to the merchant. */
  async release(
    payment: ProtectedPayment,
    party: Party,
  ): Promise<BuiltTransaction> {
    if (!releasesUnder(payment.releaseModel, party)) {
      throw notYourRole(payment, party, 'release');
    }
    this.assertBuildable(payment, 'RELEASE');
    const signer = this.partyAddress(payment, party);
    const xdr = await this.client.releaseFunds(this.networkOf(payment), {
      contractId: payment.contractId!,
      releaseSigner: signer,
    });
    const { row } = await this.transactions.record(
      payment,
      { action: 'RELEASE', signer, contractId: payment.contractId! },
      xdr,
    );
    return built(row, payment);
  }

  /**
   * A party opens a dispute. One that holds a role in the contract signs it;
   * a buyer without one (`MERCHANT_RELEASES`) proves its key with the signed
   * challenge, and the platform key opens it.
   */
  async dispute(
    payment: ProtectedPayment,
    party: Party,
    reason: string | null,
    proof?: DisputeProof,
  ): Promise<DisputeOutcome> {
    this.assertBuildable(payment, 'DISPUTE');
    const signer = this.partyAddress(payment, party);
    const context: DisputeContext = { by: party, reason };
    if (holdsRole(payment.releaseModel, party)) {
      const row = await this.buildDispute(payment, signer, context);
      return { built: built(row, payment) };
    }
    if (!proof) {
      throw ApiError.badRequest(
        ApiErrorCode.ProtectedPaymentSignatureInvalid,
        'The buyer holds no role in this contract, so the platform opens the ' +
          'dispute: send the signed message GET returned (signature, expiresAt).',
      );
    }
    assertDisputeChallengeSigned(
      {
        protectedPaymentId: payment.id,
        buyer: signer,
        network: this.networkOf(payment),
        ...proof,
      },
      new Date(),
    );
    return { submitted: await this.platformDispute(payment, context) };
  }

  /** The platform opens a dispute and relays it at once. */
  async platformDispute(
    payment: ProtectedPayment,
    context: DisputeContext,
  ): Promise<SubmittedTransaction> {
    const platform = this.keys.platform(this.networkOf(payment));
    const row =
      (await this.pendingServerRow(
        payment.id,
        'DISPUTE',
        platform.publicKey(),
      )) ?? (await this.buildDispute(payment, platform.publicKey(), context));
    const outcome = await this.transactions.relayServerSigned(row, platform);
    return this.apply(payment, outcome);
  }

  private async buildDispute(
    payment: ProtectedPayment,
    signer: string,
    context: DisputeContext,
  ): Promise<ProtectedPaymentTransaction> {
    const xdr = await this.client.disputeEscrow(this.networkOf(payment), {
      contractId: payment.contractId!,
      signer,
    });
    const { row } = await this.transactions.record(
      payment,
      { action: 'DISPUTE', signer, contractId: payment.contractId! },
      xdr,
      { ...context },
    );
    return row;
  }

  // ── Resolution ───────────────────────────────────────────────────────────

  /**
   * Resolves a disputed payment with `split` (in stroops), which must add up
   * to the contract's balance as Trustless Work reads it from the chain. Only
   * ever the payment's own buyer and merchant (`checkedSplit`, and the
   * envelope check). The automatic resolver key signs and relays at once; an
   * ops-resolved payment answers the envelope for the ops wallet to sign.
   */
  async resolve(
    payment: ProtectedPayment,
    split: Split,
    decidedBy: string,
  ): Promise<ResolveOutcome> {
    this.assertBuildable(payment, 'RESOLVE');
    const network = this.networkOf(payment);
    const resolver = payment.disputeResolverAddress;
    if (!resolver || !payment.buyerAddress) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        `Protected payment ${payment.id} has no dispute resolver to sign.`,
      );
    }
    const balance = await this.balanceOf(payment);
    const decided = checkedSplit(split, balance);
    const serverKey = this.keys.serverKeyFor(network, resolver);
    const pending = serverKey
      ? await this.pendingServerRow(payment.id, 'RESOLVE', resolver)
      : null;
    const row =
      pending ??
      (await this.buildResolve(payment, resolver, decided, balance, decidedBy));
    if (!serverKey) return { built: built(row, payment) };
    const outcome = await this.transactions.relayServerSigned(row, serverKey);
    return { submitted: await this.apply(payment, outcome) };
  }

  private async buildResolve(
    payment: ProtectedPayment,
    resolver: string,
    split: Split,
    balance: bigint,
    decidedBy: string,
  ): Promise<ProtectedPaymentTransaction> {
    const buyer = payment.buyerAddress!;
    const merchant = payment.merchantAddress;
    const distributions = [
      { address: buyer, amount: split.buyer },
      { address: merchant, amount: split.merchant },
    ].filter((d) => d.amount > 0n);
    const xdr = await this.client.resolveDispute(this.networkOf(payment), {
      contractId: payment.contractId!,
      disputeResolver: resolver,
      distributions: distributions.map((d) => ({
        address: d.address,
        amount: apiAmount(d.amount),
      })),
    });
    const { row } = await this.transactions.record(
      payment,
      {
        action: 'RESOLVE',
        signer: resolver,
        contractId: payment.contractId!,
        distributions,
        parties: { buyer, merchant },
        balance,
      },
      xdr,
      {
        buyer: fromStroops(split.buyer),
        merchant: fromStroops(split.merchant),
        decidedBy,
      },
    );
    return row;
  }

  /** The contract's USDC balance, in stroops, as Trustless Work reads it on-chain. */
  async balanceOf(payment: ProtectedPayment): Promise<bigint> {
    const [read] = await this.client.contracts(this.networkOf(payment), [
      payment.contractId!,
    ]);
    const balance = read ? balanceStroops(read.balance) : null;
    if (balance === null) {
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        `Trustless Work does not show the balance of ${payment.contractId} yet.`,
      );
    }
    return balance;
  }

  // ── Submit ───────────────────────────────────────────────────────────────

  /** Relays a signed copy of a row built for `scope`, and applies it if it landed. */
  async submit(
    payment: ProtectedPayment,
    scope: Omit<SubmitScope, 'protectedPaymentId' | 'network'>,
    signedXdr: string,
  ): Promise<SubmittedTransaction> {
    const outcome = await this.transactions.submitSigned(
      {
        ...scope,
        protectedPaymentId: payment.id,
        network: this.networkOf(payment),
      },
      signedXdr,
    );
    return this.apply(payment, outcome);
  }

  /**
   * What a landed transaction does to the row (optimistically: the sync job
   * reads the chain later). Applied on a replay too, so a submit that stored
   * Trustless Work's answer and died before this step heals on the next one.
   */
  async apply(
    payment: ProtectedPayment,
    outcome: RelayOutcome,
  ): Promise<SubmittedTransaction> {
    const { row, result, succeeded } = outcome;
    let current = payment;
    if (succeeded && row.action !== 'DEPLOY') {
      const context = contextOf(row);
      const at = new Date();
      const data =
        row.action === 'FUND'
          ? {
              deliveryDeadlineAt: new Date(
                at.getTime() + payment.deliveryWindowHours * 3_600_000,
              ),
            }
          : row.action === 'SHIP'
            ? { evidence: stringOrNull(context.evidence) }
            : row.action === 'DISPUTE'
              ? {
                  disputedBy: stringOrNull(context.by),
                  disputeReason: stringOrNull(context.reason),
                }
              : row.action === 'RESOLVE'
                ? { resolution: context as Prisma.InputJsonValue }
                : {};
      current =
        (await this.lifecycle.step(
          payment.id,
          ACTION_STEP[row.action],
          data,
          at,
        )) ??
        (await this.prisma.protectedPayment.findUniqueOrThrow({
          where: { id: payment.id },
        }));
    }
    return {
      action: row.action,
      txHash: row.txHash,
      status: result.status,
      message: typeof result.message === 'string' ? result.message : null,
      payment: current,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * The `Escrow` struct this payment's contract must hold. The description
   * falls back to the title: the contract takes a string, and an empty one is
   * something Trustless Work may refuse.
   */
  expectedContract(payment: ProtectedPayment): ExpectedContract {
    const network = this.networkOf(payment);
    if (!payment.buyerAddress || !payment.disputeResolverAddress) {
      throw new Error(
        `Protected payment ${payment.id} has no buyer or resolver bound yet`,
      );
    }
    return {
      engagementId: payment.id,
      title: payment.title,
      description: payment.description ?? payment.title,
      roles: contractRoles(payment.releaseModel, {
        buyer: payment.buyerAddress,
        merchant: payment.merchantAddress,
        platform: payment.platformAddress,
        disputeResolver: payment.disputeResolverAddress,
      }),
      amount: toStroops(payment.amount),
      platformFeeBps: payment.platformFeeBps,
      milestoneDescription: PROTECTED_PAYMENT_MILESTONE_DESCRIPTION,
      token: new Asset(
        PROTECTED_PAYMENT_ASSET_CODE,
        payment.assetIssuer,
      ).contractId(this.stellar.passphrase(network)),
    };
  }

  /** A server-signed row of `action` still waiting to go out: reuse it. */
  private async pendingServerRow(
    protectedPaymentId: string,
    action: ProtectedPaymentAction,
    signer: string,
  ): Promise<ProtectedPaymentTransaction | null> {
    const last = await this.transactions.latest(protectedPaymentId, action);
    return last &&
      last.signer === signer &&
      last.status !== 'SUBMITTED' &&
      last.expiresAt > new Date()
      ? last
      : null;
  }

  private partyAddress(payment: ProtectedPayment, party: Party): string {
    if (party === 'MERCHANT') return payment.merchantAddress;
    if (!payment.buyerAddress) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        `Protected payment ${payment.id} has no buyer yet: it is not funded.`,
      );
    }
    return payment.buyerAddress;
  }

  private assertBuildable(
    payment: ProtectedPayment,
    action: ProtectedPaymentAction,
  ): void {
    if (!canBuild(action, payment.status)) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        `Cannot ${action.toLowerCase()} a protected payment that is ${payment.status}.`,
      );
    }
    if (action !== 'FUND' && action !== 'DEPLOY' && !payment.contractId) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        `Protected payment ${payment.id} has no contract yet.`,
      );
    }
  }

  private networkOf(
    payment: Pick<ProtectedPayment, 'network'>,
  ): StellarNetwork {
    return payment.network as StellarNetwork;
  }
}

function built(
  row: ProtectedPaymentTransaction,
  payment: ProtectedPayment,
): BuiltTransaction {
  return {
    action: row.action,
    xdr: row.xdr,
    txHash: row.txHash,
    expiresAt: row.expiresAt,
    payment,
  };
}

function contextOf(row: ProtectedPaymentTransaction): Record<string, unknown> {
  return row.context &&
    typeof row.context === 'object' &&
    !Array.isArray(row.context)
    ? row.context
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function notYourRole(
  payment: ProtectedPayment,
  party: Party,
  what: 'approve' | 'release',
): ApiError {
  return ApiError.badRequest(
    ApiErrorCode.InvalidStateTransition,
    `Under ${payment.releaseModel} the ${party.toLowerCase()} does not ${what} ` +
      'this protected payment.',
  );
}
