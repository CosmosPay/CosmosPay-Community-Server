import { Injectable } from '@nestjs/common';
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
 * builds a provider URL. See `BlindpayKycApi` for why the paths live here.
 */
@Injectable()
export class BlindpayOfframpApi {
  constructor(private readonly client: BlindpayClient) {}

  createPayoutQuote(body: object): Promise<BlindpayObject> {
    return this.client.post<BlindpayObject>(
      this.client.instancePath('/quotes'),
      body,
    );
  }

  /** Returns the unsigned transaction the customer signs (Stellar/Solana). */
  authorizePayout(
    chain: ChainVariant,
    body: BlindpayPayoutAuthorization,
  ): Promise<BlindpayObject> {
    return this.client.post<BlindpayObject>(
      this.client.instancePath(`/payouts/${chain}/authorize`),
      body,
    );
  }

  createPayout(
    chain: ChainVariant,
    body: BlindpayPayoutRequest,
  ): Promise<BlindpayObject> {
    return this.client.post<BlindpayObject>(
      this.client.instancePath(`/payouts/${chain}`),
      body,
    );
  }

  getPayout(payoutId: string): Promise<BlindpayObject> {
    return this.client.get<BlindpayObject>(
      this.client.instancePath(`/payouts/${payoutId}`),
    );
  }

  addPayoutDocument(payoutId: string, body: object): Promise<BlindpayObject> {
    return this.client.post<BlindpayObject>(
      this.client.instancePath(`/payouts/${payoutId}/documents`),
      body,
    );
  }
}
