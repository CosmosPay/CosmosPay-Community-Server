import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChainSwap } from '@generated/prisma/client';
import { toChecksumAddress } from '@/chains/chain-address';
import { MONAD_CHAIN_IDS, NATIVE_DECIMALS } from '@/chains/chains.constants';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { AppConfig } from '@/config/configuration';
import { approveCalldata } from '@/evm/erc20';
import { EvmRpcClient } from '@/evm/evm-rpc.client';
import {
  type DecodedEip1559,
  decodeSignedEip1559,
} from '@/evm/evm-transaction';
import {
  merchantFeeSwapCalldata,
  readAggregator,
  routerAggregatorCalldata,
  routerInitCode,
} from '@/evm/merchant-fee-swap-router';
import { KuruClient, type KuruQuote } from '@/kuru/kuru.client';
import { KURU_NATIVE_TOKEN, KURU_QUOTE_ADDRESS } from '@/kuru/kuru.constants';
import type {
  ChainSwapVenue,
  VenueAsset,
  VenueBuild,
  VenueQuote,
  VenueRequest,
  VenueSettlement,
} from '@/swaps/venues/chain-swap-venue';

/** Kuru Flow only serves Monad mainnet. */
const NETWORK = 'public' as const;
const CHAIN_ID = MONAD_CHAIN_IDS.public;

/** What a Monad swap's wallet signs: Kuru Flow's call, on chain 143. */
interface MonadCall {
  to: string;
  data: string;
  /** Wei, decimal. */
  value: string;
  chainId: number;
}

/** A configured merchant fee router whose code matched the artifact. */
interface VerifiedRouter {
  address: string;
  /** The Kuru Flow router it was deployed for. */
  aggregator: string;
}

/**
 * Same-chain Monad swaps, priced and built by Kuru Flow.
 *
 * The commission is Kuru's `referrerFeeBps`, paid to `MONAD_SWAP_FEE_WALLET`
 * out of the output. Selling an ERC-20 needs the router to hold an allowance;
 * when the wallet's is short, the swap comes with the exact `approve` call to
 * send first. The wallet broadcasts that one itself — it moves nothing.
 *
 * A merchant fee needs a second payment Kuru cannot make, so such a swap goes
 * through `contracts/MerchantFeeSwapRouter.sol` (`KURU_MERCHANT_FEE_ROUTER`):
 * quoted for the router as the user, it takes the input and the fee from the
 * wallet, pays the fee, runs Kuru's calldata and forwards the output. The
 * wallet then approves the router, not Kuru.
 */
@Injectable()
export class MonadSwapVenue implements ChainSwapVenue {
  /** The router's check, made once per configured address. */
  private verified: { address: string; check: Promise<VerifiedRouter> } | null =
    null;

  constructor(
    private readonly kuru: KuruClient,
    private readonly rpc: EvmRpcClient,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  merchantFeeUnsupported(): string | null {
    return this.routerAddress()
      ? null
      : 'Kuru Flow takes one referrer fee per swap and the plan commission ' +
          'uses it, and no merchant fee router is configured ' +
          '(KURU_MERCHANT_FEE_ROUTER)';
  }

  async resolveAsset(asset: string): Promise<VenueAsset> {
    const lower = asset.toLowerCase();
    if (lower === 'native' || lower === 'mon') {
      return { asset: 'native', decimals: NATIVE_DECIMALS.monad };
    }
    const decimals = await this.rpc.erc20Decimals('monad', NETWORK, asset);
    if (decimals === null) {
      throw ApiError.badRequest(
        ApiErrorCode.AssetUnsupported,
        `${asset} is not an ERC-20 token on Monad`,
      );
    }
    return { asset: toChecksumAddress(asset), decimals };
  }

  async quote(request: VenueRequest): Promise<VenueQuote> {
    const router = request.merchantFee ? await this.router() : null;
    return this.toVenueQuote(
      await this.kuruQuote(request, router?.address),
      request,
    );
  }

  async build(request: VenueRequest & { source: string }): Promise<VenueBuild> {
    if (request.merchantFee) {
      return this.buildWithMerchantFee(request, request.merchantFee);
    }
    const quote = await this.kuruQuote(request);
    const call: MonadCall = {
      to: toChecksumAddress(quote.transaction.to),
      data: `0x${quote.transaction.calldata.replace(/^0x/, '').toLowerCase()}`,
      value: BigInt(quote.transaction.value || '0').toString(),
      chainId: CHAIN_ID,
    };
    return {
      ...this.toVenueQuote(quote, request),
      transaction: { ...call },
      approval: await this.approval(request, call.to, request.amount),
    };
  }

  /**
   * The swap through the merchant fee router: Kuru quoted for the router, the
   * wallet's call to the router with Kuru's calldata inside, the fee and the
   * input sent (or approved to the router) together.
   */
  private async buildWithMerchantFee(
    request: VenueRequest & { source: string },
    merchantFee: { wallet: string; amount: bigint },
  ): Promise<VenueBuild> {
    const router = await this.router();
    const quote = await this.kuruQuote(request, router.address);
    const native = request.send.asset === 'native';
    if (
      quote.transaction.to.toLowerCase() !== router.aggregator.toLowerCase()
    ) {
      throw ApiError.unavailable(
        ApiErrorCode.Misconfigured,
        `Kuru Flow now routes through ${quote.transaction.to}, not ` +
          `${router.aggregator}, the router KURU_MERCHANT_FEE_ROUTER was ` +
          'deployed for. Deploy a MerchantFeeSwapRouter for the new one.',
      );
    }
    if (
      BigInt(quote.transaction.value || '0') !== (native ? request.amount : 0n)
    ) {
      throw ApiError.badRequest(
        ApiErrorCode.ProviderError,
        'Kuru Flow quoted another input value than the amount asked for',
      );
    }
    const call: MonadCall = {
      to: router.address,
      data: merchantFeeSwapCalldata({
        tokenIn: tokenOf(request.send),
        amountIn: request.amount,
        tokenOut: tokenOf(request.dest),
        minOut: BigInt(quote.minOut),
        feeWallet: merchantFee.wallet,
        fee: merchantFee.amount,
        recipient: request.source,
        data: quote.transaction.calldata,
      }),
      value: (native ? request.amount + merchantFee.amount : 0n).toString(),
      chainId: CHAIN_ID,
    };
    return {
      ...this.toVenueQuote(quote, request),
      transaction: { ...call },
      approval: await this.approval(
        request,
        router.address,
        request.amount + merchantFee.amount,
      ),
    };
  }

  private routerAddress(): string | null {
    return this.config.get('swapAggregators', { infer: true }).kuru
      .merchantFeeRouter;
  }

  /**
   * The configured router, once its deployed code is checked against the
   * artifact: the code a creation of the artifact for its own `aggregator()`
   * would leave, byte for byte. Wallets approve this address, so an address
   * that is anything else is refused (503) rather than handed out.
   */
  private router(): Promise<VerifiedRouter> {
    const address = this.routerAddress();
    if (!address) {
      return Promise.reject(
        ApiError.badRequest(
          ApiErrorCode.MerchantFeeUnsupported,
          `A merchant fee is not available on monad swaps on this deployment: ${this.merchantFeeUnsupported()}.`,
        ),
      );
    }
    if (this.verified?.address !== address) {
      const check = this.verifyRouter(address);
      this.verified = { address, check };
      // A failed check (an RPC hiccup included) is asked again next time.
      check.catch(() => {
        if (this.verified?.check === check) this.verified = null;
      });
    }
    return this.verified.check;
  }

  private async verifyRouter(address: string): Promise<VerifiedRouter> {
    const aggregator = readAggregator(
      await this.rpc
        .ethCall('monad', NETWORK, {
          to: address,
          data: routerAggregatorCalldata(),
        })
        .catch(() => '0x'),
    );
    const [deployed, expected] = aggregator
      ? await Promise.all([
          this.rpc.getCode('monad', NETWORK, address),
          this.rpc.ethCall('monad', NETWORK, {
            data: routerInitCode(aggregator),
          }),
        ])
      : ['', null];
    if (!aggregator || deployed.toLowerCase() !== expected?.toLowerCase()) {
      throw ApiError.unavailable(
        ApiErrorCode.Misconfigured,
        `KURU_MERCHANT_FEE_ROUTER (${address}) is not a MerchantFeeSwapRouter ` +
          'built from src/evm/merchant-fee-swap-router.artifact.ts.',
      );
    }
    return {
      address: toChecksumAddress(address),
      aggregator: toChecksumAddress(aggregator),
    };
  }

  verify(swap: ChainSwap, signed: string): string {
    let tx: DecodedEip1559;
    try {
      tx = decodeSignedEip1559(signed);
    } catch {
      throw invalid(
        'signedTransaction is not a signed EIP-1559 (type 2) transaction',
      );
    }
    const built = swap.transaction as unknown as MonadCall;
    if (
      tx.chainId !== built.chainId ||
      tx.to.toLowerCase() !== built.to.toLowerCase() ||
      tx.data.toLowerCase() !== built.data.toLowerCase() ||
      tx.value !== BigInt(built.value)
    ) {
      throw invalid(
        'signedTransaction is not the transaction built for this swap',
      );
    }
    if (tx.from !== toChecksumAddress(swap.source)) {
      throw invalid('signedTransaction is not signed by the swap source');
    }
    return tx.hash.toLowerCase();
  }

  async broadcast(signed: string): Promise<void> {
    await this.rpc.sendRawTransaction('monad', NETWORK, signed);
  }

  async settlement(txHash: string): Promise<VenueSettlement> {
    const receipt = await this.rpc.getReceipt('monad', NETWORK, txHash);
    if (!receipt) return null;
    return receipt.status === '0x1' ? 'SUCCEEDED' : 'FAILED';
  }

  /**
   * Kuru's quote for `user`: the merchant fee router when one carries the
   * swap (Kuru then takes the input from it and pays the output to it), else
   * the wallet.
   */
  private kuruQuote(request: VenueRequest, user?: string): Promise<KuruQuote> {
    return this.kuru.quote({
      // Kuru prices for an address; a quote names none, so it prices for a
      // stand-in — the route does not depend on who swaps.
      userAddress: user ?? request.source ?? KURU_QUOTE_ADDRESS,
      tokenIn: tokenOf(request.send),
      tokenOut: tokenOf(request.dest),
      amount: request.amount.toString(),
      slippageBps: request.slippageBps,
      referrerAddress: request.feeWallet,
      referrerFeeBps: request.feeBps,
    });
  }

  /**
   * Kuru's `output` is already net of the referrer fee (a quote at 100 bps is
   * exactly 1% under one at zero), so the fee is recovered from it rather than
   * taken again.
   */
  private toVenueQuote(quote: KuruQuote, request: VenueRequest): VenueQuote {
    const output = BigInt(quote.output);
    return {
      destEstimated: output,
      destMin: BigInt(quote.minOut),
      feeAmount:
        request.feeBps > 0
          ? (output * BigInt(request.feeBps)) / BigInt(10_000 - request.feeBps)
          : 0n,
      path: [],
      raw: quote,
    };
  }

  /**
   * The `approve` call an ERC-20 sale needs first (of `needed`, to
   * `spender`), or null when it needs none.
   */
  private async approval(
    request: VenueRequest & { source: string },
    spender: string,
    needed: bigint,
  ): Promise<Record<string, unknown> | null> {
    if (request.send.asset === 'native') return null;
    const allowance = await this.rpc.erc20Allowance(
      'monad',
      NETWORK,
      request.send.asset,
      request.source,
      spender,
    );
    if (allowance >= needed) return null;
    return {
      to: request.send.asset,
      data: approveCalldata(spender, needed),
      value: '0',
      chainId: CHAIN_ID,
    };
  }
}

function tokenOf(asset: VenueAsset): string {
  return asset.asset === 'native' ? KURU_NATIVE_TOKEN : asset.asset;
}

function invalid(message: string): ApiError {
  return ApiError.badRequest(ApiErrorCode.ValidationFailed, message);
}
