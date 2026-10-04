import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { decimalPlaces, formatUnits, parseUnits } from '@/chains/units';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import { EvmRelayer } from '@/evm/evm-relayer.service';
import { EvmRpcClient } from '@/evm/evm-rpc.client';
import {
  DEPOSIT_FEE_MARGIN_BPS,
  DEPOSIT_FEE_ROUNDING_WEI,
  type EvmChain,
  FORWARDER_GAS_NATIVE,
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
}

/**
 * Mints one Monad payment intent's deposit address: a random salt, the
 * forwarder's terms (merchant, asset, relayer, fee) and the `CREATE2` address
 * they commit to. Pure but for two reads — the gas price, which prices a
 * native deposit's fee, and the relayer's address.
 *
 * The fee is fixed here, when the payer is shown the link, and baked into the
 * address: it is what the merchant will see deducted, and the relayer cannot
 * raise it later. A native deposit's fee is the forward's gas budget at
 * today's price plus a margin; a token deposit's is the operator's configured
 * fee for that token (`MONAD_DEPOSIT_TOKEN_FEES`), or zero — this service has
 * no price for a token, so without one the relayer absorbs the gas.
 */
@Injectable()
export class EvmDepositAddressFactory {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly rpc: EvmRpcClient,
    private readonly relayer: EvmRelayer,
  ) {}

  /** Whether this deployment gives Monad intents deposit addresses. */
  isEnabled(chain: EvmChain): boolean {
    return this.relayer.isEnabled(chain);
  }

  async mint(
    chain: EvmChain,
    network: StellarNetwork,
    destination: string,
    token: { address: string; decimals: number } | null,
  ): Promise<EvmDepositTerms> {
    const fee = token
      ? this.tokenFee(chain, token)
      : await this.nativeFee(chain, network);
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

  private async nativeFee(
    chain: EvmChain,
    network: StellarNetwork,
  ): Promise<bigint> {
    const price = await this.rpc.gasPrice(chain, network);
    const fee =
      (FORWARDER_GAS_NATIVE * price * DEPOSIT_FEE_MARGIN_BPS) / 10_000n;
    return (
      ((fee + DEPOSIT_FEE_ROUNDING_WEI - 1n) / DEPOSIT_FEE_ROUNDING_WEI) *
      DEPOSIT_FEE_ROUNDING_WEI
    );
  }

  private tokenFee(
    chain: EvmChain,
    token: { address: string; decimals: number },
  ): bigint {
    const configured = this.config.get(chain, { infer: true }).depositTokenFees[
      token.address.toLowerCase()
    ];
    if (!configured) return 0n;
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
