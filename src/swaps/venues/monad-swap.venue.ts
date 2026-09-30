import { Injectable } from '@nestjs/common';
import type { ChainSwap } from '@generated/prisma/client';
import { toChecksumAddress } from '@/chains/chain-address';
import { MONAD_CHAIN_IDS, NATIVE_DECIMALS } from '@/chains/chains.constants';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { approveCalldata } from '@/evm/erc20';
import { EvmRpcClient } from '@/evm/evm-rpc.client';
import {
  type DecodedEip1559,
  decodeSignedEip1559,
} from '@/evm/evm-transaction';
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

/**
 * Same-chain Monad swaps, priced and built by Kuru Flow.
 *
 * The commission is Kuru's `referrerFeeBps`, paid to `MONAD_SWAP_FEE_WALLET`
 * out of the output. Selling an ERC-20 needs the router to hold an allowance;
 * when the wallet's is short, the swap comes with the exact `approve` call to
 * send first. The wallet broadcasts that one itself — it moves nothing.
 */
@Injectable()
export class MonadSwapVenue implements ChainSwapVenue {
  constructor(
    private readonly kuru: KuruClient,
    private readonly rpc: EvmRpcClient,
  ) {}

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
    return this.toVenueQuote(await this.kuruQuote(request), request);
  }

  async build(request: VenueRequest & { source: string }): Promise<VenueBuild> {
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
      approval: await this.approval(request, call.to),
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

  private kuruQuote(request: VenueRequest): Promise<KuruQuote> {
    return this.kuru.quote({
      // Kuru prices for an address; a quote names none, so it prices for a
      // stand-in — the route does not depend on who swaps.
      userAddress: request.source ?? KURU_QUOTE_ADDRESS,
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

  /** The `approve` call an ERC-20 sale needs first, or null when it needs none. */
  private async approval(
    request: VenueRequest & { source: string },
    spender: string,
  ): Promise<Record<string, unknown> | null> {
    if (request.send.asset === 'native') return null;
    const allowance = await this.rpc.erc20Allowance(
      'monad',
      NETWORK,
      request.send.asset,
      request.source,
      spender,
    );
    if (allowance >= request.amount) return null;
    return {
      to: request.send.asset,
      data: approveCalldata(spender, request.amount),
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
