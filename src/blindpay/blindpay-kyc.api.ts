import { Injectable } from '@nestjs/common';
import type { BlindpayEnvironment } from '@/config/configuration';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { BlindpayClient, UploadableFile } from '@/blindpay/blindpay.client';
import type { BlindpayObject } from '@/blindpay/blindpay-sync.service';

/** The body of BlindPay's hosted terms-of-service request. */
export interface BlindpayTosRequest {
  idempotency_key: string;
  /** An existing BlindPay receiver (`re_...`), or null for one not created yet. */
  receiver_id: string | null;
  redirect_url: string;
}

/**
 * BlindPay's KYC surface — receivers (BlindPay calls them customers), their
 * blockchain wallets and bank accounts, terms of service, document upload and the
 * rail catalog — as named calls.
 *
 * Every path the KYC module reaches lives here and nowhere else. They used to be
 * built inline in four feature services, so a provider route change meant grepping
 * `receivers.service.ts` for `/e/instances/`, and a feature spec had to know
 * BlindPay's URL layout to assert anything. The feature services now say what they
 * want (`requestTos`, `deleteBankAccount`) and this class says where it is.
 *
 * Every call names the instance it goes to (`env`), which a feature service
 * resolves once per request with {@link environmentFor} — see `BlindpayClient`
 * for why there are two.
 *
 * Split from the onramp and offramp surfaces so each feature module injects only the
 * calls it makes, not a facade over the whole provider.
 */
@Injectable()
export class BlindpayKycApi {
  constructor(private readonly client: BlindpayClient) {}

  /** The BlindPay instance that serves `consumer`. */
  environmentFor(consumer: GatewayConsumer): BlindpayEnvironment {
    return this.client.environmentFor(consumer);
  }

  /**
   * Starts BlindPay's hosted terms-of-service flow and returns the acceptance URL.
   * This route lives at `/e/instances/{id}/tos`, outside the normal instance path, so
   * it cannot go through `BlindpayInstance.instancePath`.
   */
  requestTos(
    env: BlindpayEnvironment,
    body: BlindpayTosRequest,
  ): Promise<{ url: string }> {
    const instance = this.client.instance(env);
    return instance.post<{ url: string }>(
      `/e/instances/${instance.instanceId}/tos`,
      body,
    );
  }

  /** Creates the receiver at BlindPay — the irreversible step of `enable`. */
  createReceiver(
    env: BlindpayEnvironment,
    payload: object,
  ): Promise<BlindpayObject> {
    const instance = this.client.instance(env);
    return instance.post<BlindpayObject>(
      instance.instancePath('/customers'),
      payload,
    );
  }

  getReceiver(
    env: BlindpayEnvironment,
    receiverId: string,
  ): Promise<BlindpayObject> {
    const instance = this.client.instance(env);
    return instance.get<BlindpayObject>(
      instance.instancePath(`/customers/${receiverId}`),
    );
  }

  updateReceiver(
    env: BlindpayEnvironment,
    receiverId: string,
    patch: object,
  ): Promise<BlindpayObject> {
    const instance = this.client.instance(env);
    return instance.put<BlindpayObject>(
      instance.instancePath(`/customers/${receiverId}`),
      patch,
    );
  }

  deleteReceiver(
    env: BlindpayEnvironment,
    receiverId: string,
  ): Promise<unknown> {
    const instance = this.client.instance(env);
    return instance.delete(instance.instancePath(`/customers/${receiverId}`));
  }

  createBlockchainWallet(
    env: BlindpayEnvironment,
    receiverId: string,
    body: object,
  ): Promise<BlindpayObject> {
    const instance = this.client.instance(env);
    return instance.post<BlindpayObject>(
      instance.instancePath(`/customers/${receiverId}/blockchain-wallets`),
      body,
    );
  }

  /** The message a customer signs to prove an EOA wallet is theirs. */
  getWalletSignMessage(
    env: BlindpayEnvironment,
    receiverId: string,
  ): Promise<BlindpayObject> {
    const instance = this.client.instance(env);
    return instance.get<BlindpayObject>(
      instance.instancePath(
        `/customers/${receiverId}/blockchain-wallets/sign-message`,
      ),
    );
  }

  deleteBlockchainWallet(
    env: BlindpayEnvironment,
    receiverId: string,
    walletId: string,
  ): Promise<unknown> {
    const instance = this.client.instance(env);
    return instance.delete(
      instance.instancePath(
        `/customers/${receiverId}/blockchain-wallets/${walletId}`,
      ),
    );
  }

  createBankAccount(
    env: BlindpayEnvironment,
    receiverId: string,
    body: object,
  ): Promise<BlindpayObject> {
    const instance = this.client.instance(env);
    return instance.post<BlindpayObject>(
      instance.instancePath(`/customers/${receiverId}/bank-accounts`),
      body,
    );
  }

  deleteBankAccount(
    env: BlindpayEnvironment,
    receiverId: string,
    bankAccountId: string,
  ): Promise<unknown> {
    const instance = this.client.instance(env);
    return instance.delete(
      instance.instancePath(
        `/customers/${receiverId}/bank-accounts/${bankAccountId}`,
      ),
    );
  }

  /** Uploads a KYC document into one of BlindPay's storage buckets. */
  uploadFile(
    env: BlindpayEnvironment,
    file: UploadableFile,
    bucket: string,
  ): Promise<{ file_url: string }> {
    return this.client.instance(env).uploadFile(file, bucket);
  }

  /** The bank rails available to the platform instance (not instance-scoped). */
  listRails(env: BlindpayEnvironment): Promise<BlindpayObject> {
    return this.client.instance(env).get<BlindpayObject>('/available/rails');
  }

  /** The field schema a rail requires (not instance-scoped). */
  getBankDetails(
    env: BlindpayEnvironment,
    rail: string,
  ): Promise<BlindpayObject> {
    return this.client
      .instance(env)
      .get<BlindpayObject>('/available/bank-details', { query: { rail } });
  }
}
