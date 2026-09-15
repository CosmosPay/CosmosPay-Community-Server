import { Injectable } from '@nestjs/common';
import type { BlindpayEnvironment } from '@/config/configuration';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { BlindpayClient } from '@/blindpay/blindpay.client';
import type { BlindpayObject } from '@/blindpay/blindpay-sync.service';
import type { ChainVariant } from '@/blindpay/blindpay.constants';

/** What BlindPay needs to authorize a payout on a non-EVM chain. */
export interface BlindpayPayoutAuthorization {
  quote_id: string;
  sender_wallet_address: string;
}

/** What BlindPay needs to execute a payout; `signed_transaction` is non-EVM only. */
export interface BlindpayPayoutRequest extends BlindpayPayoutAuthorization {
  signed_transaction?: string;
}

/**
 * BlindPay's offramp surface — payout quotes, the non-EVM authorize step, payouts
 * and their compliance documents — as named calls, so the offramp module never
 * builds a provider URL. See `BlindpayKycApi` for why the paths live here, and why
 * every call names its instance.
 */
@Injectable()
export class BlindpayOfframpApi {
  constructor(private readonly client: BlindpayClient) {}

  /** The BlindPay instance that serves `consumer`. */
  environmentFor(consumer: GatewayConsumer): BlindpayEnvironment {
    return this.client.environmentFor(consumer);
  }

  createPayoutQuote(
    env: BlindpayEnvironment,
    body: object,
  ): Promise<BlindpayObject> {
    const instance = this.client.instance(env);
    return instance.post<BlindpayObject>(
      instance.instancePath('/quotes'),
      body,
    );
  }

  /** Returns the unsigned transaction the customer signs (Stellar/Solana). */
  authorizePayout(
    env: BlindpayEnvironment,
    chain: ChainVariant,
    body: BlindpayPayoutAuthorization,
  ): Promise<BlindpayObject> {
    const instance = this.client.instance(env);
    return instance.post<BlindpayObject>(
      instance.instancePath(`/payouts/${chain}/authorize`),
      body,
    );
  }

  createPayout(
    env: BlindpayEnvironment,
    chain: ChainVariant,
    body: BlindpayPayoutRequest,
  ): Promise<BlindpayObject> {
    const instance = this.client.instance(env);
    return instance.post<BlindpayObject>(
      instance.instancePath(`/payouts/${chain}`),
      body,
    );
  }

  getPayout(
    env: BlindpayEnvironment,
    payoutId: string,
  ): Promise<BlindpayObject> {
    const instance = this.client.instance(env);
    return instance.get<BlindpayObject>(
      instance.instancePath(`/payouts/${payoutId}`),
    );
  }

  addPayoutDocument(
    env: BlindpayEnvironment,
    payoutId: string,
    body: object,
  ): Promise<BlindpayObject> {
    const instance = this.client.instance(env);
    return instance.post<BlindpayObject>(
      instance.instancePath(`/payouts/${payoutId}/documents`),
      body,
    );
  }
}
