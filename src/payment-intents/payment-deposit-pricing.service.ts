import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaymentIntent } from '@generated/prisma/client';
import { formatUnits, parseUnits } from '@/chains/units';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { commissionWithRecipient } from '@/common/plan-commission';
import type { AppConfig } from '@/config/configuration';
import {
  type CrossChainAsset,
  isDeprecatedToken,
  resolveCrossChainAsset,
  tradableAssets,
} from '@/cross-chain-swaps/cross-chain-assets';
import { CROSS_CHAIN_NETWORKS } from '@/cross-chain-swaps/cross-chain-networks';
import type { CrossChainNetworkId } from '@/cross-chain-swaps/cross-chain-swaps.constants';
import { NearIntentsClient } from '@/near-intents/near-intents.client';
import { NEAR_INTENTS_REFERRAL } from '@/near-intents/near-intents.constants';
import type {
  NearIntentsQuoteRequest,
  NearIntentsQuoteResponse,
} from '@/near-intents/near-intents.types';
import type { PaymentDepositRequestDto } from '@/payment-intents/dto/payment-deposit.dto';
import {
  linkAssetRequest,
  requestedAmountOut,
} from '@/payment-intents/payment-deposit-rules';
import {
  type MerchantFeeRecord,
  readMerchantFeeRecord,
} from '@/common/merchant-fee/merchant-fee';
import {
  type DepositNetwork,
  isDepositNetwork,
  paymentNetworkName,
} from '@/payment-intents/payment-networks';

/** The intent columns a payment from another network is priced from. */
export type PricedIntentFields = Pick<
  PaymentIntent,
  | 'chain'
  | 'destination'
  | 'amount'
  | 'asset'
  | 'assetIssuer'
  | 'assetDecimals'
  | 'merchantFee'
  | 'crossChainFeeBps'
>;

/** Paying one intent from one origin asset, priced by the cross-chain route. */
export interface PricedPaymentDeposit {
  origin: CrossChainAsset;
  destination: CrossChainAsset;
  /** What to send (decimal, origin asset): the route's `amountIn`. */
  amountIn: string;
  minAmountIn: string;
  /**
   * What the merchant receives (decimal, the link's asset): the link's amount,
   * or the payer's on a link without one, less a merchant fee the recipient
   * pays.
   */
  amountOut: string;
  feeBps: number;
  feeAmount: string;
  /**
   * The link's merchant fee as this deposit pays it: an app fee of the route,
   * credited to the fee's account in the origin asset. Null without one.
   */
  merchantFee: MerchantFeeRecord | null;
  slippageBps: number;
  recipient: string;
  refundTo: string;
  request: NearIntentsQuoteRequest;
  response: NearIntentsQuoteResponse;
}

/**
 * Prices payment links against the cross-chain route: which asset a new link
 * on a network beyond Stellar, Solana and Monad is in, which assets a payer can
 * pay from, and what paying one intent from one of them costs.
 *
 * A payment from another network is an EXACT_OUTPUT quote: the merchant is
 * paid exactly the link's amount in the link's asset, and the payer's deposit
 * carries everything on top (the route's own costs, the plan commission as an
 * app fee, and a slippage buffer the route refunds when it is not used). Kept
 * apart from `PaymentDepositsService` so the intent create can resolve a
 * link's asset without depending on the deposits, which depend on it.
 */
@Injectable()
export class PaymentDepositPricing {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly nearIntents: NearIntentsClient,
  ) {}

  /** What a payer can pay from: every asset the route still trades. */
  async payableAssets(): Promise<CrossChainAsset[]> {
    return tradableAssets(await this.nearIntents.tokens());
  }

  /**
   * The asset a new link on `chain` is in: `assetIssuer` (the token's contract
   * as the route lists it) when given, else `assetCode` (a symbol listed once
   * on the network, or its native ticker), else the network's native coin.
   * Both given must name the same token. Refused unless the route trades it
   * today: a link nobody could pay is worse than a 400.
   */
  async linkAssetForCreate(
    chain: DepositNetwork,
    assetCode: string | undefined,
    assetIssuer: string | undefined,
  ): Promise<CrossChainAsset> {
    const tokens = await this.nearIntents.tokens();
    const asset = resolveCrossChainAsset(
      tokens,
      chain,
      assetIssuer ?? assetCode ?? 'native',
    );
    if (
      assetIssuer !== undefined &&
      assetCode !== undefined &&
      assetCode.toLowerCase() !== asset.symbol.toLowerCase() &&
      !(asset.contract === null && assetCode.toLowerCase() === 'native')
    ) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        `assetIssuer ${assetIssuer} is ${asset.symbol} on ${chain}, not ${assetCode}`,
      );
    }
    this.assertTradable(
      asset,
      `${asset.symbol} on ${paymentNetworkName(chain)} cannot be paid right now: ` +
        'GET /v1/cross-chain-swaps/assets lists what can.',
    );
    return asset;
  }

  /**
   * What paying `intent` from `request.originAsset` on `request.originChain`
   * costs: a dry quote (`live` false: a price, nothing reserved) or a live one
   * (a deposit address made for this payment). The caller has checked the
   * intent accepts payments from another network.
   */
  async price(
    intent: PricedIntentFields,
    request: PaymentDepositRequestDto,
    live: boolean,
  ): Promise<PricedPaymentDeposit> {
    const tokens = await this.nearIntents.tokens();
    const destination = this.linkAsset(intent, tokens);
    const origin = this.tradableOrigin(
      tokens,
      request.originChain,
      request.originAsset,
    );

    let amountOut: bigint;
    try {
      amountOut = parseUnits(
        requestedAmountOut(intent, request.amount),
        destination.decimals,
      );
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw ApiError.badRequest(
        ApiErrorCode.InvalidAmount,
        `This payment link's amount has more decimal places than ${destination.symbol} allows`,
      );
    }
    // A merchant fee on a network paid through deposits rides as the route's
    // own app fee (`merchantAppFee`): the recipient receives the rest.
    const merchant = this.merchantAppFee(intent, amountOut, destination);
    if (merchant) amountOut = merchant.netOut;

    const nearCfg = this.config.get('nearIntents', { infer: true });
    // The rate was the organization's when the link was made; where it is paid
    // is this deployment's setting now, and a rate with nowhere to go is a
    // misconfiguration rather than a free payment.
    const feeBps = commissionWithRecipient(
      this.config,
      intent.crossChainFeeBps ?? 0,
      nearCfg.feeRecipient,
      'NEAR_INTENTS_FEE_RECIPIENT',
    );
    const slippageBps = nearCfg.slippageBps;
    const refundTo = this.normalized(request.originChain, request.refundTo);
    const recipient = intent.destination;

    const quoteRequest: NearIntentsQuoteRequest = {
      dry: !live,
      swapType: 'EXACT_OUTPUT',
      // The route's Stellar deposits are one shared account told apart by memo.
      depositMode: origin.chain === 'stellar' ? 'MEMO' : 'SIMPLE',
      slippageTolerance: slippageBps,
      originAsset: origin.assetId,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: destination.assetId,
      amount: amountOut.toString(),
      refundTo,
      refundType: 'ORIGIN_CHAIN',
      recipient,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(
        Date.now() + nearCfg.deadlineSeconds * 1000,
      ).toISOString(),
      referral: NEAR_INTENTS_REFERRAL,
      ...(feeBps > 0 || merchant
        ? {
            appFees: [
              ...(feeBps > 0
                ? [{ recipient: nearCfg.feeRecipient, fee: feeBps }]
                : []),
              ...(merchant
                ? [{ recipient: merchant.record.wallet, fee: merchant.bps }]
                : []),
            ],
          }
        : {}),
    };
    const response = await this.nearIntents.quote(quoteRequest);
    const { quote } = response;
    // An exact-output quote pays exactly what was asked. One that promises less
    // would settle a link the merchant was underpaid for, so it is refused.
    if (BigInt(quote.minAmountOut) < amountOut) {
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        "The cross-chain route quoted less than the payment link's amount. Retry shortly.",
      );
    }
    const amountIn = BigInt(quote.amountIn);
    return {
      origin,
      destination,
      amountIn: formatUnits(amountIn, origin.decimals),
      minAmountIn: formatUnits(BigInt(quote.minAmountIn), origin.decimals),
      amountOut: formatUnits(amountOut, destination.decimals),
      feeBps,
      feeAmount: formatUnits(
        (amountIn * BigInt(feeBps)) / 10_000n,
        origin.decimals,
      ),
      merchantFee: merchant
        ? {
            ...merchant.record,
            amount: formatUnits(
              (amountIn * BigInt(merchant.bps)) / 10_000n,
              origin.decimals,
            ),
            asset: origin.symbol,
          }
        : null,
      slippageBps,
      recipient,
      refundTo,
      request: quoteRequest,
      response,
    };
  }

  /**
   * A merchant fee on a link on a network paid through deposit addresses, as
   * the route pays it: an app fee (the route's own multi-recipient fee), in
   * whole basis points of the deposit, credited to the fee's account inside the
   * route rather than sent on the link's network. Its basis points are the fee's
   * share of everything that is paid out (`fee / (net + fee)`), rounded down so
   * the payer is never charged above the link's terms; under one basis point it
   * cannot be paid and is refused. Null on a link without a fee, and on
   * Stellar, Solana and Monad, whose fees are paid on the chain itself.
   */
  private merchantAppFee(
    intent: PricedIntentFields,
    amountOut: bigint,
    destination: CrossChainAsset,
  ): { bps: number; netOut: bigint; record: MerchantFeeRecord } | null {
    if (!isDepositNetwork(intent.chain)) return null;
    const record = readMerchantFeeRecord(intent.merchantFee);
    if (!record) return null;
    const fee = parseUnits(record.amount, destination.decimals);
    const netOut = record.paidBy === 'recipient' ? amountOut - fee : amountOut;
    const bps = Number((fee * 10_000n) / (netOut + fee));
    if (netOut <= 0n || bps === 0) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidAmount,
        'The merchant fee is under one basis point of the payment, the least the cross-chain route can pay',
      );
    }
    return { bps, netOut, record };
  }

  /**
   * The asset a payer names to send (`originAsset` on `originChain`), refused
   * unless the route trades it today.
   */
  async originAsset(
    chain: CrossChainNetworkId,
    requested: string,
  ): Promise<CrossChainAsset> {
    return this.tradableOrigin(
      await this.nearIntents.tokens(),
      chain,
      requested,
    );
  }

  private tradableOrigin(
    tokens: Awaited<ReturnType<NearIntentsClient['tokens']>>,
    chain: CrossChainNetworkId,
    requested: string,
  ): CrossChainAsset {
    const origin = resolveCrossChainAsset(tokens, chain, requested);
    this.assertTradable(
      origin,
      `${origin.symbol} on ${chain} cannot be sent right now: ` +
        'GET /v1/payment-links/{id}/deposit-assets lists what can.',
    );
    return origin;
  }

  /**
   * The intent's own asset in the route's list, by its contract (or as the
   * native coin): never by symbol, since the merchant named a contract.
   */
  private linkAsset(
    intent: PricedIntentFields,
    tokens: Awaited<ReturnType<NearIntentsClient['tokens']>>,
  ): CrossChainAsset {
    const unpayable = () =>
      ApiError.badRequest(
        ApiErrorCode.AssetUnsupported,
        "This payment link's asset cannot be paid from another network right now.",
      );
    let asset: CrossChainAsset;
    try {
      asset = resolveCrossChainAsset(
        tokens,
        intent.chain as CrossChainNetworkId,
        linkAssetRequest(intent),
      );
    } catch {
      throw unpayable();
    }
    if (!this.isTradable(asset)) throw unpayable();
    return asset;
  }

  private isTradable(asset: CrossChainAsset): boolean {
    return (
      asset.priceUsd !== null &&
      asset.priceUsd > 0 &&
      !isDeprecatedToken(asset.symbol)
    );
  }

  /**
   * The route answers every quote for a token it lists without a price with a
   * refusal, so such a token is refused here with a message that says so.
   */
  private assertTradable(asset: CrossChainAsset, message: string): void {
    if (!this.isTradable(asset)) {
      throw ApiError.badRequest(ApiErrorCode.AssetUnsupported, message);
    }
  }

  /** The one spelling of `address` on `chain`, stored and sent to the route. */
  private normalized(chain: CrossChainNetworkId, address: string): string {
    return CROSS_CHAIN_NETWORKS[chain].address.normalize(address);
  }
}
