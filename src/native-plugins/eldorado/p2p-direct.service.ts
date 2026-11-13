import { randomUUID } from 'node:crypto';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { UpstreamStatusError } from '@/common/upstream-http';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import {
  EldoradoClient,
  type BuyOrderRequest,
} from '@/native-plugins/eldorado/eldorado.client';
import {
  P2P_DIRECT_COUNTRY,
  P2P_DIRECT_CURRENCY,
  P2P_DIRECT_PAYMENT_METHOD,
  P2P_MARKETPLACE,
} from '@/native-plugins/eldorado/eldorado.constants';
import { sessionReference } from '@/native-plugins/eldorado/p2p-market';
import {
  accountDetails,
  directConfigured,
  directErrors,
  directLanguage,
  directRefusal,
  generatedUsername,
  isAccountId,
  isEmailAddress,
  isLoginCode,
  isPhoneCode,
  normalizeArPhone,
  parseDirectAccount,
  ORDER_CANCELLABLE_STATUSES,
  ORDER_PAYABLE_STATUS,
  quoteIdOf,
  readDirectAccounts,
  readDirectOrder,
  readKyc,
  readLoginChallenge,
  readLoginSession,
  remainingLimitUsd,
  type DirectAccount,
  type DirectKyc,
  type DirectLoginChallenge,
  type DirectOrder,
  type DirectStep,
  type ReadDirectOrder,
} from '@/native-plugins/eldorado/p2p-direct';
import {
  openPayerSession,
  sealPayerSession,
  sessionExpiry,
} from '@/native-plugins/eldorado/p2p-direct-session';
import { paymentRequestUrl } from '@/native-plugins/eldorado/p2p-payment-request';
import { P2pPaymentRequestLedger } from '@/native-plugins/eldorado/p2p-payment-request-ledger.service';
import {
  P2pPaymentRequestsService,
  REQUEST_ID_RE,
} from '@/native-plugins/eldorado/p2p-payment-requests.service';
import { PrismaService } from '@/prisma/prisma.service';

/** What the direct flow reads of a request: its terms, its owner and where it delivers. Never answered. */
const DIRECT_REQUEST_SELECT = {
  id: true,
  consumerId: true,
  network: true,
  currency: true,
  amount: true,
  chainId: true,
  token: true,
  tokenAddress: true,
  address: true,
} as const;

interface DirectRequest {
  id: string;
  consumerId: string;
  network: StellarNetwork;
  currency: string;
  amount: string;
  chainId: number;
  token: string;
  tokenAddress: string;
  address: string;
}

const NOT_FOUND = 'Payment request not found';

/**
 * The direct flow (`/v1/payment-links/fiat/{id}/direct/*`, keyless): a payer
 * pays an ARS payment request from our page, through the P2P marketplace's API
 * and under its API referral id, without ever seeing the marketplace. They
 * verify their email (the marketplace's own sign-in), their phone and an ID
 * document (its verification), pick or type the bank account in their name
 * they will pay from, and are told whom to transfer the exact amount to. The
 * marketplace stays the counterparty; the token goes to the seller's own
 * wallet, as with the widget.
 *
 * What the request id unlocks is bounded the same way as the rest of the
 * payer's page: an order always delivers the request's own token to the
 * request's own address, for its amount, and names the request in
 * `externalReferenceId`; an order read, marked paid or cancelled through a
 * request must name that request there (else the 404 of a missing order). The
 * payer's marketplace token lives only inside the sealed `X-Payer-Session`,
 * bound to the request and the network. Nothing about the payer (email, name,
 * account, document, token) is stored or logged: only the order id, on the
 * seller's session record, so the webhook settles the request
 * (`P2pOrderEventsService`). Marking an order paid moves the request to
 * `processing` (`markDirectProcessing`); its cancellation reopens it.
 */
@Injectable()
export class P2pDirectService {
  private readonly logger = new Logger(P2pDirectService.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly client: EldoradoClient,
    private readonly requests: P2pPaymentRequestsService,
    private readonly ledger: P2pPaymentRequestLedger,
  ) {}

  // --- signing in -----------------------------------------------------------

  /** Emails the payer a code; `acceptLanguage` picks its language. */
  async login(
    id: string,
    email: string,
    acceptLanguage: string | undefined,
  ): Promise<DirectLoginChallenge> {
    const request = await this.payable(id);
    if (!isEmailAddress(email)) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidEmail,
        'email must be an email address',
      );
    }
    const answer = await this.call('login', () =>
      this.client.sendLoginCode(
        request.network,
        email,
        directLanguage(acceptLanguage),
      ),
    );
    const challenge = readLoginChallenge(answer);
    if (!challenge) {
      this.logger.error(
        `The ${P2P_MARKETPLACE} (${request.network}) answered a sign-in start with no challenge`,
      );
      throw directErrors.unavailable();
    }
    return challenge;
  }

  /**
   * Trades the emailed code for the payer's session on this request. A new
   * account the marketplace insists on naming gets a generated username, once.
   */
  async verify(
    id: string,
    challenge: string,
    code: string,
  ): Promise<{ session: string; expiresAt: string }> {
    const request = await this.payable(id);
    if (!isLoginCode(code)) throw directErrors.invalidCode();
    const body = { otp: code, otpIdentifier: challenge };
    let answer: unknown;
    try {
      answer = await this.client.verifyLoginCode(request.network, body);
    } catch (error) {
      if (
        !(error instanceof UpstreamStatusError) ||
        error.status !== 400 ||
        !error.mentions('username')
      ) {
        throw this.mapped('verify', error);
      }
      answer = await this.call('verify', () =>
        this.client.verifyLoginCode(request.network, {
          ...body,
          username: generatedUsername(),
        }),
      );
    }
    const signedIn = readLoginSession(answer);
    if (!signedIn) {
      this.logger.error(
        `The ${P2P_MARKETPLACE} (${request.network}) answered a verified sign-in with no token`,
      );
      throw directErrors.unavailable();
    }
    const now = Date.now();
    const expires = sessionExpiry(now, signedIn.expiresAt);
    if (expires <= now) throw directErrors.invalidCode();
    return {
      session: sealPayerSession(
        { t: signedIn.token, n: request.network, r: request.id, e: expires },
        this.secret,
      ),
      expiresAt: new Date(expires).toISOString(),
    };
  }

  // --- verification ---------------------------------------------------------

  /** Where the payer stands in their verification. */
  async kyc(id: string, session: string | undefined): Promise<DirectKyc> {
    const { request, token } = await this.payableSession(id, session);
    return this.kycOf(request.network, token, true);
  }

  /** Sends the first level's data (country AR, the city and the phone), then answers the new state. */
  async submitKycDetails(
    id: string,
    session: string | undefined,
    city: string,
    phone: string,
  ): Promise<DirectKyc> {
    const { request, token } = await this.payableSession(id, session);
    const phoneNumber = normalizeArPhone(phone);
    if (!phoneNumber) throw directErrors.invalidPhone();
    await this.call('kycDetails', () =>
      this.client.submitKycDetails(request.network, token, {
        countryOfResidence: P2P_DIRECT_COUNTRY,
        cityOfResidence: city,
        phoneNumber,
      }),
    );
    return this.kycOf(request.network, token, true);
  }

  /** Verifies the phone with the texted code, then answers the new state. */
  async verifyKycPhone(
    id: string,
    session: string | undefined,
    code: string,
  ): Promise<DirectKyc> {
    const { request, token } = await this.payableSession(id, session);
    if (!isPhoneCode(code)) throw directErrors.invalidCode();
    await this.call('kycPhone', () =>
      this.client.verifyKycPhone(request.network, token, code),
    );
    return this.kycOf(request.network, token, true);
  }

  // --- paying ---------------------------------------------------------------

  /** The payer's saved accounts in their own name, never a full number. */
  async accounts(
    id: string,
    session: string | undefined,
  ): Promise<{ accounts: DirectAccount[] }> {
    const { request, token } = await this.payableSession(id, session);
    const answer = await this.call('accounts', () =>
      this.client.paymentDetails(request.network, token),
    );
    return { accounts: readDirectAccounts(answer?.paymentDetails) };
  }

  /**
   * Opens an order for the request: a firm quote of its exact amount in ARS
   * delivering its token to its address, then a buy order from that quote,
   * paid from the saved account `accountId` or the typed `account`, naming the
   * request in `externalReferenceId`. The order id is recorded on the seller's
   * session record before it is answered; when that fails, the order is
   * cancelled rather than left unsettleable.
   */
  async createOrder(
    id: string,
    session: string | undefined,
    input: { accountId?: string; account?: unknown },
  ): Promise<DirectOrder> {
    const { request, token } = await this.payableSession(id, session);
    const fiatDetails = directFiatDetails(input);
    const kyc = await this.kycOf(request.network, token, false);
    if (kyc.step !== 'ready') throw directErrors.kycRequired();

    const chainId = String(request.chainId);
    const quote = await this.call('quote', () =>
      this.client.directBuyQuote(request.network, token, {
        token: request.tokenAddress,
        chainId,
        fiatCurrencyId: P2P_DIRECT_CURRENCY,
        paymentMethodId: P2P_DIRECT_PAYMENT_METHOD,
        amount: request.amount,
        fixedAmountSide: 'IN',
        addressTo: request.address,
      }),
    );
    const quoteId = quoteIdOf(quote);
    if (!quoteId) {
      this.logger.warn(
        `The ${P2P_MARKETPLACE} (${request.network}) answered a quote with no usable id for payment request ${request.id}`,
      );
      throw directErrors.noSellers();
    }
    const answer = await this.call('order', () =>
      this.client.createBuyOrder(request.network, token, {
        quoteId,
        fiatDetails,
        cryptoDetails: {
          recipientAddress: request.address,
          tokenAddress: request.tokenAddress,
          chainId,
        },
        externalReferenceId: request.id,
      }),
    );
    const order = readDirectOrder(answer, request);
    if (!order) {
      this.logger.error(
        `The ${P2P_MARKETPLACE} (${request.network}) answered an order this service cannot read for payment request ${request.id}`,
      );
      throw directErrors.unavailable();
    }
    this.noteUnmapped(order);
    try {
      await this.recordOrder(request, order);
    } catch (error) {
      this.logger.error(
        `Order ${order.view.id} of payment request ${request.id} could not be recorded; cancelling it: ${describe(error)}`,
      );
      await this.cancelQuietly(request, token, order.view.id);
      throw error;
    }
    this.logger.log(
      `Order ${order.view.id} opened for payment request ${request.id} (${order.rawStatus})`,
    );
    return order.view;
  }

  /** One order of this request, read through the payer's session. */
  async order(
    id: string,
    orderId: string,
    session: string | undefined,
  ): Promise<DirectOrder> {
    const { request, token } = await this.orderSession(id, session);
    return (await this.ownOrder(request, token, orderId)).view;
  }

  /**
   * The payer says they transferred: an order waiting for the transfer
   * (ACCEPTED, `pay`) becomes FIAT_PAID (`confirming`), and the request reads
   * `processing` because of it until the marketplace completes or cancels it.
   * `409 order_not_payable` at any other status.
   */
  async markPaid(
    id: string,
    orderId: string,
    session: string | undefined,
  ): Promise<DirectOrder> {
    const { request, token } = await this.orderSession(id, session);
    const before = await this.ownOrder(request, token, orderId);
    if (before.rawStatus !== ORDER_PAYABLE_STATUS) {
      throw directErrors.notPayable(before.view.status);
    }
    const answer = await this.call('paid', () =>
      this.client.markOrderPaid(request.network, token, orderId),
    );
    const read = readDirectOrder(answer, request);
    const after: ReadDirectOrder =
      read && read.view.id === orderId
        ? read
        : {
            ...before,
            rawStatus: 'FIAT_PAID',
            view: { ...before.view, status: 'confirming' },
          };
    this.noteUnmapped(after);
    const sessionId = await this.recordOrder(request, after);
    if (after.view.status === 'confirming') {
      await this.ledger.markDirectProcessing(request.id, sessionId, new Date());
    }
    return after.view;
  }

  /** Cancels an order the payer has not paid (REQUESTED or ACCEPTED); `409 order_not_cancellable` otherwise. */
  async cancel(
    id: string,
    orderId: string,
    session: string | undefined,
  ): Promise<DirectOrder> {
    const { request, token } = await this.orderSession(id, session);
    const before = await this.ownOrder(request, token, orderId);
    if (!ORDER_CANCELLABLE_STATUSES.includes(before.rawStatus)) {
      throw directErrors.notCancellable(before.view.status);
    }
    await this.call('cancel', () =>
      this.client.cancelOrder(request.network, token, orderId),
    );
    let after: ReadDirectOrder;
    try {
      after = await this.ownOrder(request, token, orderId);
    } catch {
      // Cancelled: an answer that cannot be read now changes nothing about that.
      after = {
        ...before,
        rawStatus: 'CANCELLED',
        view: { ...before.view, status: 'cancelled', payTo: null, dueAt: null },
      };
    }
    await this.recordOrder(request, after);
    return after.view;
  }

  // --- the request, the session, the order -----------------------------------

  /**
   * A request a payer can start paying from this page: it exists (404), it is
   * open (`409 request_closed`) and `p2pDirect` holds for it right now
   * (`400 method_unavailable`), decided by the same read the page polls.
   */
  private async payable(id: string): Promise<DirectRequest> {
    const view = await this.requests.findPublic(id);
    if (view.status !== 'open') {
      throw ApiError.conflict(
        ApiErrorCode.RequestClosed,
        `Payment request ${id} is ${view.status}: it can no longer be paid`,
      );
    }
    if (!view.p2pDirect) {
      throw ApiError.badRequest(
        ApiErrorCode.MethodUnavailable,
        `Payment request ${id} cannot be paid with a transfer to a verified seller from this page`,
      );
    }
    return this.load(id);
  }

  /** {@link payable}, and the payer's session on it. */
  private async payableSession(
    id: string,
    session: string | undefined,
  ): Promise<{ request: DirectRequest; token: string }> {
    const request = await this.payable(id);
    return { request, token: this.tokenOf(request, session) };
  }

  /**
   * The request and the payer's session for an order already under way:
   * whatever the request reads as now (paid, expired, cancelled, processing),
   * the payer must be able to follow, finish or cancel what they started. Only
   * a deployment that no longer serves the flow refuses (`503 p2p_unavailable`).
   */
  private async orderSession(
    id: string,
    session: string | undefined,
  ): Promise<{ request: DirectRequest; token: string }> {
    const request = await this.load(id);
    if (!directConfigured(this.config.get('eldorado', { infer: true }))) {
      throw directErrors.unavailable();
    }
    return { request, token: this.tokenOf(request, session) };
  }

  private async load(id: string): Promise<DirectRequest> {
    const row = REQUEST_ID_RE.test(id)
      ? await this.prisma.p2pPaymentRequest.findUnique({
          where: { id },
          select: DIRECT_REQUEST_SELECT,
        })
      : null;
    if (!row) throw ApiError.notFound(NOT_FOUND);
    return { ...row, network: row.network as StellarNetwork };
  }

  /** The payer's marketplace token from their session on `request`; `401 session_expired` otherwise. */
  private tokenOf(request: DirectRequest, session: string | undefined): string {
    const claims = openPayerSession(
      session,
      this.secret,
      { requestId: request.id, network: request.network },
      Date.now(),
    );
    if (!claims) throw directErrors.sessionExpired();
    return claims.t;
  }

  /**
   * One order through the payer's token, only when it names `request` in its
   * `externalReferenceId`: any other order, theirs or not, is the 404 of a
   * missing one.
   */
  private async ownOrder(
    request: DirectRequest,
    token: string,
    orderId: string,
  ): Promise<ReadDirectOrder> {
    const answer = await this.call('orderRead', () =>
      this.client.order(request.network, token, orderId),
    );
    const order = readDirectOrder(answer, request);
    if (!order || order.reference !== request.id) {
      throw directErrors.orderNotFound();
    }
    this.noteUnmapped(order);
    return order;
  }

  /**
   * The seller's session record of `order` (created the first time, with the
   * order id the webhook matches it by), its marketplace status brought up to
   * date unless a completion was already recorded. Answers its id.
   */
  private async recordOrder(
    request: DirectRequest,
    order: ReadDirectOrder,
  ): Promise<string> {
    const existing = await this.prisma.p2pRampSession.findFirst({
      where: {
        paymentRequestId: request.id,
        providerOrderId: order.view.id,
        network: request.network,
      },
      select: { id: true },
    });
    if (existing) {
      await this.prisma.p2pRampSession.updateMany({
        where: { id: existing.id, completedAt: null },
        data: { providerStatus: order.rawStatus },
      });
      return existing.id;
    }
    const created = await this.prisma.p2pRampSession.create({
      data: {
        consumerId: request.consumerId,
        network: request.network,
        side: 'buy',
        currency: request.currency,
        paymentMethod: P2P_DIRECT_PAYMENT_METHOD,
        amount: request.amount,
        token: request.token,
        tokenAddress: request.tokenAddress,
        chainId: request.chainId,
        address: request.address,
        estimatedAmountOut: order.amountOut,
        reference: sessionReference(randomUUID()),
        // No widget: the payer pays it in the request's own page.
        widgetUrl: paymentRequestUrl(
          this.config.get('paymentIntents', { infer: true }).checkoutUrl,
          request.id,
        ),
        paymentRequestId: request.id,
        providerOrderId: order.view.id,
        providerStatus: order.rawStatus,
      },
      select: { id: true },
    });
    return created.id;
  }

  /** Best effort, for an order this service could not record: ops reads the log when it fails. */
  private async cancelQuietly(
    request: DirectRequest,
    token: string,
    orderId: string,
  ): Promise<void> {
    try {
      await this.client.cancelOrder(request.network, token, orderId);
    } catch (error) {
      this.logger.error(
        `Order ${orderId} of payment request ${request.id} was not recorded and could not be cancelled: ${describe(error)}`,
      );
    }
  }

  /**
   * The payer's verification state, with what they may still pay this month
   * when `withLimit` and they are ready (null when it cannot be read). A payer
   * the marketplace has no verification record for is at the first step.
   */
  private async kycOf(
    network: StellarNetwork,
    token: string,
    withLimit: boolean,
  ): Promise<DirectKyc> {
    let raw: unknown = null;
    try {
      raw = (await this.client.kyc(network, token))?.kyc;
    } catch (error) {
      if (!(error instanceof UpstreamStatusError && error.status === 404)) {
        throw this.mapped('kyc', error);
      }
    }
    const { kyc, unmapped } = readKyc(raw);
    if (unmapped) {
      this.logger.warn(
        `The ${P2P_MARKETPLACE} (${network}) reported a verification state the mapping does not expect (${unmapped}): answered ${kyc.step}`,
      );
    }
    const limitUsd =
      withLimit && kyc.step === 'ready'
        ? await this.limitOf(network, token)
        : null;
    return { ...kyc, limitUsd };
  }

  private async limitOf(
    network: StellarNetwork,
    token: string,
  ): Promise<string | null> {
    try {
      return remainingLimitUsd(
        (await this.client.userInfo(network, token))?.allowance,
      );
    } catch (error) {
      this.logger.warn(
        `The payer's allowance could not be read (${network}): ${describe(error)}`,
      );
      return null;
    }
  }

  private noteUnmapped(order: ReadDirectOrder): void {
    if (order.unmapped) {
      this.logger.warn(
        `Order ${order.view.id} has a status the mapping does not expect (${order.unmapped}): answered ${order.view.status}`,
      );
    }
  }

  /** Runs one marketplace call of `step`, its failure as this service's error. */
  private async call<T>(step: DirectStep, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw this.mapped(step, error);
    }
  }

  /**
   * A marketplace refusal as {@link directRefusal} reads it. A timeout or a
   * dead socket (the shared upstream errors) is the marketplace being down:
   * `503 p2p_unavailable`. This service's own errors pass as they are.
   */
  private mapped(step: DirectStep, error: unknown): unknown {
    if (error instanceof UpstreamStatusError) return directRefusal(step, error);
    if (
      error instanceof HttpException &&
      !(error instanceof ApiError && error.code === ApiErrorCode.P2pUnavailable)
    ) {
      const status = error.getStatus();
      if (status === 502 || status === 503 || status === 504) {
        return directErrors.unavailable();
      }
    }
    return error;
  }

  private get secret(): string {
    return this.config.get('eldorado', { infer: true }).directSessionSecret;
  }
}

/**
 * What an order pays from: the saved account `accountId`, or the typed
 * `account` read field by field (`parseDirectAccount`); exactly one of them.
 * Each refusal is a 400 with the field's own code.
 */
function directFiatDetails(input: {
  accountId?: string;
  account?: unknown;
}): BuyOrderRequest['fiatDetails'] {
  const hasId = input.accountId !== undefined && input.accountId !== '';
  const hasAccount = input.account !== undefined && input.account !== null;
  if (hasId === hasAccount) {
    throw ApiError.badRequest(
      ApiErrorCode.InvalidAccount,
      'Send either accountId (a saved account) or account (a new one)',
    );
  }
  if (hasId) {
    if (!isAccountId(input.accountId!)) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidAccount,
        'accountId must be an id from the saved accounts',
      );
    }
    return { detailsId: input.accountId! };
  }
  const parsed = parseDirectAccount(input.account);
  if ('refusal' in parsed) {
    throw ApiError.badRequest(parsed.refusal.code, parsed.refusal.message);
  }
  return { details: accountDetails(parsed.account) };
}

/** An error as a log line may show it: its message, never a value it carries. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
