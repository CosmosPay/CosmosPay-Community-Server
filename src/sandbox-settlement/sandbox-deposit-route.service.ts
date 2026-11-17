import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { formatUnits, parseUnits } from '@/chains/units';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { readMerchantFeeRecord } from '@/common/merchant-fee/merchant-fee';
import type { AppConfig } from '@/config/configuration';
import type { CrossChainAsset } from '@/cross-chain-swaps/cross-chain-assets';
import { CROSS_CHAIN_NETWORKS } from '@/cross-chain-swaps/cross-chain-networks';
import type { CrossChainNetworkId } from '@/cross-chain-swaps/cross-chain-swaps.constants';
import { addressOfSecretKey } from '@/evm/evm-transaction';
import { NEAR_INTENTS_REFERRAL } from '@/near-intents/near-intents.constants';
import type {
  NearIntentsQuoteRequest,
  NearIntentsQuoteResponse,
} from '@/near-intents/near-intents.types';
import type { PaymentDepositRequestDto } from '@/payment-intents/dto/payment-deposit.dto';
import type {
  PricedIntentFields,
  PricedPaymentDeposit,
} from '@/payment-intents/payment-deposit-pricing.service';
import { requestedAmountOut } from '@/payment-intents/payment-deposit-rules';
import {
  PAYMENT_NETWORKS,
  type PaymentNetwork,
  paymentNetworkName,
} from '@/payment-intents/payment-networks';
import {
  depositPath,
  depositSecretKey,
  newDepositIndexes,
} from '@/sandbox-settlement/sandbox-hd';
import {
  sandboxAmountIn,
  sandboxAssetId,
} from '@/sandbox-settlement/sandbox-quote';
import {
  SANDBOX_CORRELATION_PREFIX,
  SANDBOX_DEPOSIT_DEADLINE_SECONDS,
  SANDBOX_MERCHANT_FEE_REFUSAL,
  SANDBOX_NETWORKS,
  SANDBOX_TIME_ESTIMATE_SECONDS,
} from '@/sandbox-settlement/sandbox-settlement.constants';

/** Whether the sandbox settles on a network, and in which stablecoin. */
export interface SandboxAvailability {
  network: PaymentNetwork;
  available: boolean;
  /** Why not, in words a merchant reads; null when available. */
  reason: string | null;
  /** The stablecoin a link there is in and a payer pays with; null when unavailable. */
  asset: CrossChainAsset | null;
}

/**
 * The sandbox's side of a payment from another network: which test networks
 * and stablecoins it settles, the address a payer deposits to, and the price
 * (one for one). The deposit row, its limits and its statuses are the payment
 * links' own (`PaymentDepositsService`): this only answers what the
 * cross-chain route answers on mainnet, with the shapes it answers them in.
 */
@Injectable()
export class SandboxDepositRoute {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  /** Both secrets set: without them no test network is settled. */
  isConfigured(): boolean {
    const { depositSeed, treasuryPrivateKey } = this.config.get('sandbox', {
      infer: true,
    });
    return depositSeed !== '' && treasuryPrivateKey !== '';
  }

  availability(network: PaymentNetwork): SandboxAvailability {
    const entry = SANDBOX_NETWORKS[network];
    const unavailable = (reason: string): SandboxAvailability => ({
      network,
      available: false,
      reason,
      asset: null,
    });
    if (entry.kind !== 'evm') return unavailable(entry.reason);
    if (!this.isConfigured()) {
      return unavailable(
        'Sandbox payments from other networks are not set up on this deployment.',
      );
    }
    const contract =
      entry.stablecoin.contract ??
      this.config.get('sandbox', { infer: true }).cusdAddresses[network] ??
      null;
    if (!contract) {
      return unavailable(
        `The test stablecoin (${entry.stablecoin.symbol}) is not deployed on ${entry.testnetName} yet.`,
      );
    }
    return {
      network,
      available: true,
      reason: null,
      asset: {
        chain: network,
        chainName: entry.testnetName,
        symbol: entry.stablecoin.symbol,
        assetId: sandboxAssetId(network, contract),
        decimals: entry.stablecoin.decimals,
        contract,
        // A stablecoin, on a test network: indicative, like every priceUsd.
        priceUsd: 1,
      },
    };
  }

  /** Every network, with what the sandbox does there. */
  catalog(): SandboxAvailability[] {
    return PAYMENT_NETWORKS.map((n) => this.availability(n));
  }

  /** What a payer can pay from in the sandbox: each available network's stablecoin. */
  payableAssets(): CrossChainAsset[] {
    return this.catalog().flatMap((a) => (a.asset ? [a.asset] : []));
  }

  /**
   * The asset a payer names on `chain`: the network's test stablecoin, by its
   * symbol or its contract. Anything else (the native coin above all: nothing
   * prices it on a test network) is refused.
   */
  originAsset(chain: CrossChainNetworkId, requested: string): CrossChainAsset {
    const { asset, reason } = this.availability(chain);
    if (!asset) {
      throw ApiError.badRequest(
        ApiErrorCode.AssetUnsupported,
        `${paymentNetworkName(chain)} cannot be paid from in the sandbox: ${reason}`,
      );
    }
    if (!this.names(asset, requested)) {
      throw ApiError.badRequest(
        ApiErrorCode.AssetUnsupported,
        `In the sandbox a payer pays with the network's test stablecoin (${asset.symbol} on ${asset.chainName}).`,
      );
    }
    return asset;
  }

  /**
   * The asset a new sandbox link on `chain` is in: the network's test
   * stablecoin. Omitting both `assetCode` and `assetIssuer` means it too (there
   * is no other choice); naming another asset is refused.
   */
  linkAssetForCreate(
    chain: PaymentNetwork,
    assetCode: string | undefined,
    assetIssuer: string | undefined,
  ): CrossChainAsset {
    const { asset, reason } = this.availability(chain);
    if (!asset) {
      throw ApiError.badRequest(
        ApiErrorCode.NetworkUnsupported,
        `A payment link on ${paymentNetworkName(chain)} is not available in the sandbox: ${reason}`,
      );
    }
    const named =
      (assetCode === undefined || this.names(asset, assetCode)) &&
      (assetIssuer === undefined || this.names(asset, assetIssuer));
    if (!named) {
      throw ApiError.badRequest(
        ApiErrorCode.AssetUnsupported,
        `In the sandbox a link on ${paymentNetworkName(chain)} is in its test stablecoin (${asset.symbol}).`,
      );
    }
    return asset;
  }

  /**
   * Prices paying `intent` from `request`'s asset in the sandbox: one for one,
   * no commission, for the link's amount or, on a link without one, the
   * amount the payer typed (`requestedAmountOut`, as on mainnet). A live price
   * also makes the deposit address: a fresh HD path, whose address is the
   * deposit's and whose path is kept as the correlation id (the key is never
   * stored: the seed rebuilds it). A merchant fee is refused for now.
   */
  price(
    intent: PricedIntentFields,
    request: PaymentDepositRequestDto,
    live: boolean,
  ): PricedPaymentDeposit {
    const destination = this.linkAssetForCreate(
      intent.chain as PaymentNetwork,
      undefined,
      intent.assetIssuer ?? undefined,
    );
    if (readMerchantFeeRecord(intent.merchantFee)) {
      throw ApiError.badRequest(
        ApiErrorCode.MerchantFeeUnsupported,
        SANDBOX_MERCHANT_FEE_REFUSAL,
      );
    }
    const origin = this.originAsset(request.originChain, request.originAsset);
    const requested = requestedAmountOut(intent, request.amount);
    let amountOut: string;
    try {
      amountOut = formatUnits(
        parseUnits(requested, destination.decimals),
        destination.decimals,
      );
    } catch {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidAmount,
        `This payment link's amount has more decimal places than ${destination.symbol} allows`,
      );
    }
    const amountIn = sandboxAmountIn(amountOut, destination, origin);
    const refundTo = CROSS_CHAIN_NETWORKS[
      request.originChain
    ].address.normalize(request.refundTo);
    const deadline = new Date(
      Date.now() + SANDBOX_DEPOSIT_DEADLINE_SECONDS * 1000,
    ).toISOString();
    const indexes = live ? newDepositIndexes() : null;
    const depositAddress = indexes
      ? addressOfSecretKey(
          depositSecretKey(
            this.config.get('sandbox', { infer: true }).depositSeed,
            indexes,
          ),
        )
      : undefined;

    const quoteRequest: NearIntentsQuoteRequest = {
      dry: !live,
      swapType: 'EXACT_OUTPUT',
      depositMode: 'SIMPLE',
      slippageTolerance: 0,
      originAsset: origin.assetId,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: destination.assetId,
      amount: parseUnits(amountOut, destination.decimals).toString(),
      refundTo,
      refundType: 'ORIGIN_CHAIN',
      recipient: intent.destination,
      recipientType: 'DESTINATION_CHAIN',
      deadline,
      referral: NEAR_INTENTS_REFERRAL,
    };
    const amountInUnits = parseUnits(amountIn, origin.decimals).toString();
    const response: NearIntentsQuoteResponse = {
      correlationId: indexes
        ? `${SANDBOX_CORRELATION_PREFIX}${depositPath(indexes)}`
        : `${SANDBOX_CORRELATION_PREFIX}dry`,
      timestamp: new Date().toISOString(),
      signature: 'sandbox',
      quoteRequest,
      quote: {
        ...(depositAddress ? { depositAddress, deadline } : {}),
        amountIn: amountInUnits,
        amountInFormatted: amountIn,
        amountInUsd: amountIn,
        minAmountIn: amountInUnits,
        amountOut: quoteRequest.amount,
        amountOutFormatted: amountOut,
        amountOutUsd: amountOut,
        minAmountOut: quoteRequest.amount,
        timeEstimate: SANDBOX_TIME_ESTIMATE_SECONDS,
      },
    };
    return {
      origin,
      destination,
      amountIn,
      minAmountIn: amountIn,
      amountOut,
      feeBps: 0,
      feeAmount: '0',
      merchantFee: null,
      slippageBps: 0,
      recipient: intent.destination,
      refundTo,
      request: quoteRequest,
      response,
    };
  }

  /** Whether `requested` names `asset`: its symbol, or its contract (any case). */
  private names(asset: CrossChainAsset, requested: string): boolean {
    const wanted = requested.trim().toLowerCase();
    return (
      wanted === asset.symbol.toLowerCase() ||
      (asset.contract !== null && wanted === asset.contract.toLowerCase())
    );
  }
}
