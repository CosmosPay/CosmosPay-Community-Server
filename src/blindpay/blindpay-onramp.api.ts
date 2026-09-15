import { Injectable } from '@nestjs/common';
import { BlindpayClient } from '@/blindpay/blindpay.client';
import type { BlindpayObject } from '@/blindpay/blindpay-sync.service';

/**
 * BlindPay's onramp surface — payin quotes, payins, virtual accounts and the Stellar
 * trustline helper — as named calls, so the onramp module never builds a provider
 * URL. See `BlindpayKycApi` for why the paths live in the provider module.
 */
@Injectable()
export class BlindpayOnrampApi {
  constructor(private readonly client: BlindpayClient) {}

  createPayinQuote(body: object): Promise<BlindpayObject> {
    return this.client.post<BlindpayObject>(
      this.client.instancePath('/payin-quotes'),
      body,
    );
  }

  /**
   * Executes a payin quote. BlindPay exposes a single payin execution route
   * (`/payins/evm`) for all destination networks — the chain is determined by the
   * quote's wallet, not by the path.
   */
  createPayin(body: { payin_quote_id: string }): Promise<BlindpayObject> {
    return this.client.post<BlindpayObject>(
      this.client.instancePath('/payins/evm'),
      body,
    );
  }

  getPayin(payinId: string): Promise<BlindpayObject> {
    return this.client.get<BlindpayObject>(
      this.client.instancePath(`/payins/${payinId}`),
    );
  }

  /** Builds an unsigned Stellar trustline transaction (XDR) for `address`. */
  createAssetTrustline(body: { address: string }): Promise<BlindpayObject> {
    return this.client.post<BlindpayObject>(
      this.client.instancePath('/create-asset-trustline'),
      body,
    );
  }

  createVirtualAccount(
    receiverId: string,
    body: object,
  ): Promise<BlindpayObject> {
    return this.client.post<BlindpayObject>(
      this.client.instancePath(`/customers/${receiverId}/virtual-accounts`),
      body,
    );
  }
}
