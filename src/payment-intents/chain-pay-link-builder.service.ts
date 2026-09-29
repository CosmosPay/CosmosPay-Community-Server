import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { encodeBase58, normalizeAddress } from '@/chains/chain-address';
import {
  MAX_TOKEN_DECIMALS,
  NATIVE_ASSET_CODES,
  NATIVE_DECIMALS,
  type OtherChain,
} from '@/chains/chains.constants';
import { decimalPlaces, parseUnits } from '@/chains/units';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { StellarNetwork } from '@/config/configuration';
import { eip681Uri } from '@/evm/eip681';
import { EvmRpcClient } from '@/evm/evm-rpc.client';
import {
  EvmDepositAddressFactory,
  type EvmDepositTerms,
} from '@/payment-intents/evm-deposit-address.factory';
import { solanaPayUri } from '@/solana/solana-pay';
import { SolanaRpcClient } from '@/solana/solana-rpc.client';

/** What a PAY request on Solana or Monad asks for, after DTO validation. */
export interface ChainPayRequest {
  network: StellarNetwork;
  destination: string;
  amount?: string;
  assetCode?: string;
  assetIssuer?: string;
  memo: string;
  msg?: string;
}

/** The columns a Solana/Monad PAY intent is stored with. */
export interface ChainPayLink {
  destination: string;
  asset: string;
  assetIssuer: string | null;
  assetDecimals: number | null;
  uri: string;
  chainReference: string | null;
  chainCursor: string | null;
  /** What is deducted before the merchant is paid, as a decimal; null for nothing. */
  networkFee: string | null;
  /** A Monad intent's deposit address and its terms, when the relayer is on. */
  deposit: EvmDepositTerms | null;
}

/** The asset an intent settles in, resolved against the chain. */
interface ResolvedAsset {
  /** `native`, or the code the caller labelled the token with. */
  code: string;
  /** SPL mint / ERC-20 contract, in its stored spelling; null for the coin. */
  issuer: string | null;
  decimals: number;
}

/**
 * Builds the payment link of a PAY intent on a chain other than Stellar — a
 * Solana Pay transfer request or an EIP-681 URI — resolving the asset against
 * the chain on the way, so an intent is never stored for a token that does not
 * exist or for an amount the token cannot represent.
 *
 * The Stellar equivalent is `Sep7LinkBuilder`. The two are not one class
 * because nothing in them is shared: SEP-7 has a memo and a callback, Solana
 * Pay a reference key, EIP-681 a chain id; each chain is one method here.
 */
@Injectable()
export class ChainPayLinkBuilder {
  constructor(
    private readonly solana: SolanaRpcClient,
    private readonly evm: EvmRpcClient,
    private readonly deposits: EvmDepositAddressFactory,
  ) {}

  build(chain: OtherChain, request: ChainPayRequest): Promise<ChainPayLink> {
    const builders: Record<OtherChain, () => Promise<ChainPayLink>> = {
      solana: () => this.solanaPay(request),
      monad: () => this.monadPay(request),
    };
    return builders[chain]();
  }

  /** The destination and token, in the spelling this chain stores them in. */
  normalize(
    chain: OtherChain,
    request: Pick<ChainPayRequest, 'destination' | 'assetCode' | 'assetIssuer'>,
  ): { destination: string; asset: string; assetIssuer: string | null } {
    const native = isNative(chain, request.assetCode, request.assetIssuer);
    return {
      destination: normalizeAddress(chain, request.destination),
      asset: native ? 'native' : (request.assetCode ?? '').toUpperCase(),
      assetIssuer:
        native || !request.assetIssuer
          ? null
          : normalizeAddress(chain, request.assetIssuer),
    };
  }

  private async solanaPay(request: ChainPayRequest): Promise<ChainPayLink> {
    const asset = await this.resolveAsset('solana', request, (mint) =>
      this.solana.getMintDecimals(request.network, mint),
    );
    checkAmount(request.amount, asset, false);
    // A fresh key per intent, never derived from anything a caller chose:
    // the reference is how a payment is told apart from every other transfer
    // to the same destination, so it must be one nobody else can put there.
    const reference = encodeBase58(randomBytes(32));
    const uri = solanaPayUri({
      recipient: request.destination,
      amount: request.amount,
      splToken: asset.issuer ?? undefined,
      reference,
      message: request.msg,
      memo: request.memo,
    });
    return {
      destination: request.destination,
      asset: asset.code,
      assetIssuer: asset.issuer,
      assetDecimals: asset.issuer ? asset.decimals : null,
      uri,
      chainReference: reference,
      chainCursor: null,
      networkFee: null,
      deposit: null,
    };
  }

  private async monadPay(request: ChainPayRequest): Promise<ChainPayLink> {
    if (request.msg !== undefined) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'msg is not supported on monad: an EIP-681 link has no message field.',
      );
    }
    const destination = normalizeAddress('monad', request.destination);
    const asset = await this.resolveAsset('monad', request, (token) =>
      this.evm.erc20Decimals('monad', request.network, token),
    );
    const chainId = this.evm.chainId('monad', request.network);
    return this.deposits.isEnabled('monad')
      ? this.monadDeposit(request, destination, asset, chainId)
      : this.monadDirect(request, destination, asset, chainId);
  }

  /**
   * With a relayer: the payer pays the intent's own CREATE2 deposit address,
   * so the payment is recognised by where it went rather than by its amount —
   * native MON included, and an open amount is possible. The relayer later
   * forwards it to the merchant, less the fee fixed here.
   */
  private async monadDeposit(
    request: ChainPayRequest,
    destination: string,
    asset: ResolvedAsset,
    chainId: number,
  ): Promise<ChainPayLink> {
    const value = checkAmount(request.amount, asset, false);
    const deposit = await this.deposits.mint(
      'monad',
      request.network,
      destination,
      asset.issuer ? { address: asset.issuer, decimals: asset.decimals } : null,
    );
    if (value !== null && value <= deposit.fee) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidAmount,
        `amount must be more than the network fee (${EvmDepositAddressFactory.displayFee(
          deposit.fee,
          asset.decimals,
        )}), which is deducted before the merchant is paid`,
      );
    }
    return {
      destination,
      asset: asset.code,
      assetIssuer: asset.issuer,
      assetDecimals: asset.issuer ? asset.decimals : null,
      uri: eip681Uri({
        chainId,
        recipient: deposit.address,
        value: value ?? undefined,
        token: asset.issuer ?? undefined,
      }),
      chainReference: deposit.address,
      chainCursor: null,
      networkFee:
        deposit.fee > 0n
          ? EvmDepositAddressFactory.displayFee(deposit.fee, asset.decimals)
          : null,
      deposit,
    };
  }

  /**
   * Without a relayer: the payer pays the merchant directly. An EVM payment
   * carries no memo, so the amount is part of what identifies it — an
   * open-amount link could be settled by any transfer.
   */
  private async monadDirect(
    request: ChainPayRequest,
    destination: string,
    asset: ResolvedAsset,
    chainId: number,
  ): Promise<ChainPayLink> {
    const value = checkAmount(request.amount, asset, true)!;
    const head = await this.evm.blockNumber('monad', request.network);
    return {
      destination,
      asset: asset.code,
      assetIssuer: asset.issuer,
      assetDecimals: asset.issuer ? asset.decimals : null,
      uri: eip681Uri({
        chainId,
        recipient: destination,
        value,
        token: asset.issuer ?? undefined,
      }),
      chainReference: null,
      // The observer scans for the payment from the block after this one.
      chainCursor: head.toString(),
      networkFee: null,
      deposit: null,
    };
  }

  /**
   * The chain's coin when `assetCode` names it (or nothing is named), else the
   * token at `assetIssuer`, whose decimals the chain must confirm.
   */
  private async resolveAsset(
    chain: OtherChain,
    request: ChainPayRequest,
    readDecimals: (token: string) => Promise<number | null>,
  ): Promise<ResolvedAsset> {
    if (isNative(chain, request.assetCode, request.assetIssuer)) {
      if (request.assetIssuer) {
        throw ApiError.badRequest(
          ApiErrorCode.ValidationFailed,
          `assetIssuer must be omitted for ${NATIVE_ASSET_CODES[chain]}`,
        );
      }
      return { code: 'native', issuer: null, decimals: NATIVE_DECIMALS[chain] };
    }
    if (!request.assetIssuer) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        `assetIssuer is required for a token on ${chain}: the ` +
          (chain === 'solana' ? 'SPL mint' : 'ERC-20 contract'),
      );
    }
    if (!request.assetCode) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'assetCode is required with assetIssuer: the ticker the intent and its ' +
          'webhooks name the token by (e.g. USDC)',
      );
    }
    const issuer = normalizeAddress(chain, request.assetIssuer);
    const decimals = await readDecimals(issuer);
    if (decimals === null || decimals > MAX_TOKEN_DECIMALS) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        `assetIssuer ${issuer} is not a ` +
          (chain === 'solana' ? 'SPL token mint' : 'ERC-20 token') +
          ` on ${chain} ${request.network}`,
      );
    }
    return { code: request.assetCode.toUpperCase(), issuer, decimals };
  }
}

/** Whether a request means the chain's own coin. */
function isNative(
  chain: OtherChain,
  assetCode: string | undefined,
  assetIssuer: string | undefined,
): boolean {
  if (assetCode === undefined) return !assetIssuer;
  const code = assetCode.toUpperCase();
  return code === 'NATIVE' || code === NATIVE_ASSET_CODES[chain];
}

/**
 * The amount in base units, or null for an open amount. Refuses more decimals
 * than the asset has — rounding them away would quietly ask for a different
 * amount — and zero, which settles nothing.
 */
function checkAmount(
  amount: string | undefined,
  asset: ResolvedAsset,
  required: boolean,
): bigint | null {
  if (amount === undefined) {
    if (required) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidAmount,
        'amount is required on monad without deposit addresses: an EIP-681 ' +
          'payment carries no memo, so the amount is part of how it is recognised.',
      );
    }
    return null;
  }
  if (decimalPlaces(amount) > asset.decimals) {
    throw ApiError.badRequest(
      ApiErrorCode.InvalidAmount,
      `amount has more than the ${asset.decimals} decimal places this asset supports`,
    );
  }
  const value = parseUnits(amount, asset.decimals);
  if (value <= 0n) {
    throw ApiError.badRequest(
      ApiErrorCode.InvalidAmount,
      'amount must be greater than zero',
    );
  }
  return value;
}
