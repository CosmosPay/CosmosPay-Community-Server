import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReadThroughCache } from '@/common/read-through-cache';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import {
  conversionTarget,
  railTokenFor,
  type ConversionTarget,
  type RailSettings,
} from '@/native-plugins/koywe/bank-transfer-rail';
import {
  pooledMerchantId,
  railNetworks,
} from '@/native-plugins/koywe/koywe-config';
import {
  TRANSFER_ACCOUNT_CACHE_MAX_ENTRIES,
  TRANSFER_ACCOUNT_CACHE_TTL_MS,
  type KoyweNetwork,
  type KoyweToken,
} from '@/native-plugins/koywe/koywe.constants';
import { accountReady } from '@/native-plugins/koywe/transfer-account';
import { TransferAccountsService } from '@/native-plugins/koywe/transfer-accounts.service';
import {
  PaymentRequestRails,
  type PaymentRequestRail,
  type PaymentRequestTerms,
  type PaymentRequestToken,
} from '@/payment-request-rails/payment-request-rails';

/** Whose provider merchant a request's payers transfer to. */
export interface Payee {
  merchantId: string;
  /** Cosmos Pay's own merchant (pooled mode) rather than the seller's. */
  pooled: boolean;
  /** The seller's deposit account; null in pooled mode, whose account is read apart. */
  account: {
    holder: string;
    alias: string;
    cvu: string;
    bank: string | null;
  } | null;
}

/**
 * The bank transfer rail, registered into the core's
 * {@link PaymentRequestRails} as `transfer`: a request can be paid by bank
 * transfer when its terms fit the rail (`railTokenFor`: a served network, ARS,
 * the bounds, a served pair) and its owner has somewhere to be paid, their
 * own approved account or, in pooled mode, Cosmos Pay's merchant. The owner's
 * account is reused for a few seconds, so a list of requests asks once.
 */
@Injectable()
export class BankTransferRail implements PaymentRequestRail, OnModuleInit {
  readonly method = 'transfer' as const;
  private readonly logger = new Logger(BankTransferRail.name);
  private readonly payees = new ReadThroughCache<Payee | null>(
    TRANSFER_ACCOUNT_CACHE_TTL_MS,
    TRANSFER_ACCOUNT_CACHE_MAX_ENTRIES,
  );

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly rails: PaymentRequestRails,
    private readonly accounts: TransferAccountsService,
  ) {}

  onModuleInit(): void {
    this.rails.registerRail(this);
  }

  async accepts(
    terms: PaymentRequestTerms,
    listed: PaymentRequestToken | null,
  ): Promise<PaymentRequestToken | null> {
    const token = railTokenFor(terms, listed, this.settings());
    if (!token) return null;
    try {
      return (await this.payee(terms.ownerId, terms.network)) ? token : null;
    } catch (error) {
      // The other ways to pay must not fail with this one: it is off for now.
      this.logger.warn(
        `Bank transfers are left out of a payment request: the seller's account could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /**
   * Where `ownerId`'s payers transfer to on `network`: their own approved
   * account with its CVU and alias, else Cosmos Pay's merchant in pooled mode,
   * else nowhere. `fresh` skips the few seconds' reuse (a payer about to be
   * given the instructions).
   */
  payee(
    ownerId: string,
    network: StellarNetwork,
    fresh = false,
  ): Promise<Payee | null> {
    const load = () => this.loadPayee(ownerId, network);
    return fresh ? load() : this.payees.get(`${ownerId}:${network}`, load);
  }

  /** Where a request's deposit is converted to, or null for a pair the rail does not serve. */
  target(
    network: StellarNetwork,
    chainId: number,
    tokenAddress: string,
    stored: PaymentRequestToken,
  ): ConversionTarget | null {
    return conversionTarget(
      network,
      chainId,
      tokenAddress,
      stored,
      this.settings().sandbox,
    );
  }

  /** The deployment, as the rail rules read it. */
  settings(): RailSettings {
    const koywe = this.config.get('koywe', { infer: true });
    return {
      networks: railNetworks(koywe),
      minArs: koywe.minArs,
      maxArs: koywe.maxArs,
      sandbox: {
        network: koywe.sandboxNetwork as KoyweNetwork,
        token: koywe.sandboxToken as KoyweToken,
      },
    };
  }

  private async loadPayee(
    ownerId: string,
    network: StellarNetwork,
  ): Promise<Payee | null> {
    const koywe = this.config.get('koywe', { infer: true });
    if (!railNetworks(koywe).includes(network)) return null;
    const account = await this.accounts.forOwner(ownerId, network);
    if (account && accountReady(account)) {
      return {
        merchantId: account.providerMerchantId!,
        pooled: false,
        account: {
          holder: account.name,
          alias: account.alias!,
          cvu: account.cvu!,
          bank: account.bank,
        },
      };
    }
    const pooled = pooledMerchantId(koywe, network);
    return pooled ? { merchantId: pooled, pooled: true, account: null } : null;
  }
}
