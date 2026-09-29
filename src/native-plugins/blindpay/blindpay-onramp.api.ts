import { Injectable } from '@nestjs/common';
import type { BlindpayEnvironment } from '@/config/configuration';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { BlindpayClient } from '@/blindpay/blindpay.client';
import type { BlindpayObject } from '@/blindpay/blindpay-sync.service';

/**
 * BlindPay's onramp surface — payin quotes, payins, virtual accounts and the Stellar
 * trustline helper — as named calls, so the onramp module never builds a provider
 * URL. See `BlindpayKycApi` for why the paths live in the provider module, and why
 * every call names its instance.
 */
@Injectable()
export class BlindpayOnrampApi {
  constructor(private readonly client: BlindpayClient) {}

  /** The BlindPay instance that serves `consumer`. */
  environmentFor(consumer: GatewayConsumer): BlindpayEnvironment {
    return this.client.environmentFor(consumer);
  }

  createPayinQuote(
    env: BlindpayEnvironment,
    body: object,
  ): Promise<BlindpayObject> {
    const instance = this.client.instance(env);
    return instance.post<BlindpayObject>(
      instance.instancePath('/payin-quotes'),
      body,
    );
  }

  /**
   * Executes a payin quote. BlindPay exposes a single payin execution route
   * (`/payins/evm`) for all destination networks — the chain is determined by the
   * quote's wallet, not by the path.
   */
  createPayin(
    env: BlindpayEnvironment,
    body: { payin_quote_id: string },
    idempotencyKey: string,
  ): Promise<BlindpayObject> {
    const instance = this.client.instance(env);
    return instance.post<BlindpayObject>(
      instance.instancePath('/payins/evm'),
      body,
      { headers: { 'Idempotency-Key': idempotencyKey } },
    );
  }

  getPayin(env: BlindpayEnvironment, payinId: string): Promise<BlindpayObject> {
    const instance = this.client.instance(env);
    return instance.get<BlindpayObject>(
      instance.instancePath(`/payins/${payinId}`),
    );
  }

  /** Builds an unsigned Stellar trustline transaction (XDR) for `address`. */
  createAssetTrustline(
    env: BlindpayEnvironment,
    body: { address: string },
  ): Promise<BlindpayObject> {
    const instance = this.client.instance(env);
    return instance.post<BlindpayObject>(
      instance.instancePath('/create-asset-trustline'),
      body,
    );
  }

  createVirtualAccount(
    env: BlindpayEnvironment,
    receiverId: string,
    body: object,
  ): Promise<BlindpayObject> {
    const instance = this.client.instance(env);
    return instance.post<BlindpayObject>(
      instance.instancePath(`/customers/${receiverId}/virtual-accounts`),
      body,
    );
  }
}
