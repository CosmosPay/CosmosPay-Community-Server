import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NATIVE_DECIMALS } from '@/chains/chains.constants';
import { decimalPlaces, formatUnits, parseUnits } from '@/chains/units';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import { EvmRelayer } from '@/evm/evm-relayer.service';
import { EvmRpcClient } from '@/evm/evm-rpc.client';
import {
  DEPOSIT_FEE_MARGIN_BPS,
  DEPOSIT_FEE_ROUNDING_WEI,
  EVM_NATIVE_TOKEN_INTERFACES,
  type EvmChain,
  FORWARDER_GAS_NATIVE,
  FORWARDER_GAS_TOKEN,
} from '@/evm/evm.constants';
import { depositAddress, forwarderInitCode } from '@/evm/payment-forwarder';

/** A deposit address, and every term that went into it. */
export interface EvmDepositTerms {
  address: string;
  salt: string;
  destination: string;
  token: string | null;
  relayer: string;
  /** The relayer's fee, in the asset's base units. */
  fee: bigint;
  /** The merchant fee the address pays in its constructor (a PaymentSplitForwarder); null without one. */
  merchantFee: { wallet: string; amount: bigint } | null;
}

/**
 * Mints one EVM payment intent's deposit address (Monad, Arc): a random salt,
 * the forwarder's terms (merchant, asset, relayer, fee) and the `CREATE2`
 * address they commit to. Pure but for two reads: the gas price, which
 * prices a native deposit's fee, and the relayer's address.
 *
 * The fee is fixed here, when the payer is shown the link, and baked into the
 * address: it is what the merchant will see deducted, and the relayer cannot
 * raise it later. A native deposit's fee is the forward's gas budget at
 * today's price plus a margin; a token deposit's is the operator's configured
 * fee for that token (`<CHAIN>_DEPOSIT_TOKEN_FEES`), or zero: this service has
 * no price for a token, so without one the relayer absorbs the gas. The one
 * token it can price is the chain's own gas coin seen as an ERC-20 (Arc's
 * USDC): with no configured fee, that deposit's fee is the token forward's gas
 * budget at today's price plus the margin, written in the token's decimals.
 */
@Injectable()
export class EvmDepositAddressFactory {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly rpc: EvmRpcClient,
    private readonly relayer: EvmRelayer,
  ) {}

  /** Whether this deployment gives the chain's intents deposit addresses. */
  isEnabled(chain: EvmChain): boolean {
    return this.relayer.isEnabled(chain);
  }

  async mint(
    chain: EvmChain,
    network: StellarNetwork,
    destination: string,
    token: { address: string; decimals: number } | null,
    merchantFee: { wallet: string; amount: bigint } | null = null,
  ): Promise<EvmDepositTerms> {
    const fee = token
      ? await this.tokenFee(chain, network, token)
      : await this.nativeFee(chain, network, FORWARDER_GAS_NATIVE);
    const relayer = this.relayer.address(chain);
    // Never derived from anything a caller chose: an address someone could
    // predict is one they could front-run a deployment of — harmless to the
    // money, but not a door worth leaving open.
    const salt = `0x${randomBytes(32).toString('hex')}`;
    const terms = {
      destination,
      token: token?.address ?? null,
      relayer,
      fee,
      merchantFee,
    };
    return {
      ...terms,
      salt,
      address: depositAddress(salt, forwarderInitCode(terms)),
    };
  }

  /** `fee` as a decimal in the asset's units — what the intent shows. */
  static displayFee(fee: bigint, decimals: number): string {
    return formatUnits(fee, decimals);
  }

  /** `gas` at today's gas price plus the margin, in wei, rounded up. */
  private async nativeFee(
    chain: EvmChain,
    network: StellarNetwork,
    gas: bigint,
  ): Promise<bigint> {
    const price = await this.rpc.gasPrice(chain, network);
    const fee = (gas * price * DEPOSIT_FEE_MARGIN_BPS) / 10_000n;
    return (
      ((fee + DEPOSIT_FEE_ROUNDING_WEI - 1n) / DEPOSIT_FEE_ROUNDING_WEI) *
      DEPOSIT_FEE_ROUNDING_WEI
    );
  }

  private async tokenFee(
    chain: EvmChain,
    network: StellarNetwork,
    token: { address: string; decimals: number },
  ): Promise<bigint> {
    const configured = this.config.get(chain, { infer: true }).depositTokenFees[
      token.address.toLowerCase()
    ];
    if (!configured) {
      const gasCoin = EVM_NATIVE_TOKEN_INTERFACES[chain];
      if (
        gasCoin === null ||
        gasCoin.token.toLowerCase() !== token.address.toLowerCase()
      ) {
        return 0n;
      }
      // The gas is paid in this very coin: price it, then write it in the
      // interface's decimals, rounded up so the relayer is never short.
      const wei = await this.nativeFee(chain, network, FORWARDER_GAS_TOKEN);
      const scale = 10n ** BigInt(NATIVE_DECIMALS[chain] - gasCoin.decimals);
      return (wei + scale - 1n) / scale;
    }
    // A fee finer than the token can express would be a fee nobody can pay:
    // round it down to the token's precision rather than refuse the intent.
    const places = Math.min(decimalPlaces(configured), token.decimals);
    const [whole, fraction = ''] = configured.split('.');
    return parseUnits(
      places > 0 ? `${whole}.${fraction.slice(0, places)}` : whole,
      token.decimals,
    );
  }
}
