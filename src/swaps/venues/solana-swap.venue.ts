import { Injectable } from '@nestjs/common';
import type { ChainSwap } from '@generated/prisma/client';
import { decodeBase58 } from '@/chains/chain-address';
import { NATIVE_DECIMALS } from '@/chains/chains.constants';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { JupiterClient, type JupiterQuote } from '@/jupiter/jupiter.client';
import { associatedTokenAddress } from '@/solana/associated-token-account';
import { SolanaRpcClient } from '@/solana/solana-rpc.client';
import {
  hasValidSignatures,
  type ParsedSolanaTransaction,
  parseSolanaTransaction,
  transactionId,
} from '@/solana/solana-transaction';
import {
  SPL_TOKEN_PROGRAM_IDS,
  WRAPPED_SOL_MINT,
} from '@/solana/solana.constants';
import type {
  ChainSwapVenue,
  VenueAsset,
  VenueBuild,
  VenueQuote,
  VenueRequest,
  VenueSettlement,
} from '@/swaps/venues/chain-swap-venue';

/** Jupiter only serves Solana mainnet. */
const NETWORK = 'public' as const;

/**
 * Same-chain Solana swaps, priced and built by Jupiter.
 *
 * The commission is Jupiter's `platformFeeBps`, taken from the output and paid
 * into `SOLANA_SWAP_FEE_WALLET`'s associated token account for the output mint.
 * That account must already exist: Jupiter does not create it, and a
 * transaction naming a missing one fails on-chain after the payer signed.
 */
@Injectable()
export class SolanaSwapVenue implements ChainSwapVenue {
  constructor(
    private readonly jupiter: JupiterClient,
    private readonly rpc: SolanaRpcClient,
  ) {}

  async resolveAsset(asset: string): Promise<VenueAsset> {
    const lower = asset.toLowerCase();
    if (lower === 'native' || lower === 'sol') {
      return { asset: 'native', decimals: NATIVE_DECIMALS.solana };
    }
    const decimals = await this.rpc.getMintDecimals(NETWORK, asset);
    if (decimals === null) {
      throw ApiError.badRequest(
        ApiErrorCode.AssetUnsupported,
        `${asset} is not an SPL mint on Solana`,
      );
    }
    return { asset, decimals };
  }

  async quote(request: VenueRequest): Promise<VenueQuote> {
    return this.toVenueQuote(await this.jupiterQuote(request), request);
  }

  async build(request: VenueRequest & { source: string }): Promise<VenueBuild> {
    const feeAccount =
      request.feeBps > 0 && request.feeWallet
        ? await this.feeAccount(request.feeWallet, mintOf(request.dest))
        : null;
    const quote = await this.jupiterQuote(request);
    const built = await this.jupiter.swapTransaction({
      quote,
      userPublicKey: request.source,
      feeAccount,
    });
    return {
      ...this.toVenueQuote(quote, request),
      transaction: {
        encoding: 'base64',
        data: built.swapTransaction,
        lastValidBlockHeight: built.lastValidBlockHeight,
      },
      approval: null,
    };
  }

  verify(swap: ChainSwap, signed: string): string {
    const signedTx = parse(
      signed,
      'signedTransaction is not a Solana transaction',
    );
    const builtTx = parse(
      (swap.transaction as { data: string }).data,
      'The stored transaction for this swap is unreadable',
    );
    if (!sameBytes(signedTx.message, builtTx.message)) {
      throw invalid(
        'signedTransaction is not the transaction built for this swap',
      );
    }
    if (signedTx.signers[0] !== swap.source) {
      throw invalid('signedTransaction is not paid by the swap source');
    }
    const keys = signedTx.signers.map((s) => decodeBase58(s)!);
    if (!hasValidSignatures(signedTx, keys)) {
      throw invalid(
        'signedTransaction carries no valid signature from its signers',
      );
    }
    return transactionId(signedTx);
  }

  async broadcast(signed: string): Promise<void> {
    await this.rpc.sendTransaction(NETWORK, signed);
  }

  async settlement(txHash: string): Promise<VenueSettlement> {
    const status = await this.rpc.getSignatureStatus(NETWORK, txHash);
    if (!status) return null;
    if (status.err) return 'FAILED';
    return status.confirmationStatus === 'confirmed' ||
      status.confirmationStatus === 'finalized'
      ? 'SUCCEEDED'
      : null;
  }

  private jupiterQuote(request: VenueRequest): Promise<JupiterQuote> {
    return this.jupiter.quote({
      inputMint: mintOf(request.send),
      outputMint: mintOf(request.dest),
      amount: request.amount.toString(),
      slippageBps: request.slippageBps,
      platformFeeBps: request.feeBps,
    });
  }

  private toVenueQuote(quote: JupiterQuote, request: VenueRequest): VenueQuote {
    const outputMint = mintOf(request.dest);
    const hops = new Set(
      quote.routePlan
        .map((step) => step.swapInfo.outputMint)
        .filter((mint) => mint !== outputMint),
    );
    return {
      destEstimated: BigInt(quote.outAmount),
      destMin: BigInt(quote.otherAmountThreshold),
      feeAmount: BigInt(quote.platformFee?.amount ?? '0'),
      path: [...hops].map((mint) => ({ code: mint, issuer: null })),
      raw: quote,
    };
  }

  /**
   * The fee wallet's associated token account for `mint`, which must exist:
   * refused loudly otherwise, rather than swapped without the commission.
   */
  private async feeAccount(owner: string, mint: string): Promise<string> {
    const program = await this.rpc.getAccountOwner(NETWORK, mint);
    if (!program || !SPL_TOKEN_PROGRAM_IDS.includes(program)) {
      throw ApiError.badRequest(
        ApiErrorCode.AssetUnsupported,
        `${mint} is not an SPL mint on Solana`,
      );
    }
    const account = associatedTokenAddress(owner, mint, program);
    if (!(await this.rpc.getAccountOwner(NETWORK, account))) {
      throw ApiError.unavailable(
        ApiErrorCode.Misconfigured,
        `The swap commission in ${mint} is paid into ${account}, the ` +
          `SOLANA_SWAP_FEE_WALLET token account for that mint, which does not ` +
          'exist yet. Create it, then retry.',
      );
    }
    return account;
  }
}

/** Jupiter names SOL by the wrapped-SOL mint and wraps it in the same transaction. */
function mintOf(asset: VenueAsset): string {
  return asset.asset === 'native' ? WRAPPED_SOL_MINT : asset.asset;
}

function parse(base64: string, message: string): ParsedSolanaTransaction {
  try {
    return parseSolanaTransaction(
      Uint8Array.from(Buffer.from(base64, 'base64')),
    );
  } catch {
    throw invalid(message);
  }
}

function invalid(message: string): ApiError {
  return ApiError.badRequest(ApiErrorCode.ValidationFailed, message);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
}
