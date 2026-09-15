import { Injectable } from '@nestjs/common';
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
 * Split from the onramp and offramp surfaces so each feature module injects only the
 * calls it makes, not a facade over the whole provider.
 */
@Injectable()
export class BlindpayKycApi {
  constructor(private readonly client: BlindpayClient) {}

  /**
   * Starts BlindPay's hosted terms-of-service flow and returns the acceptance URL.
   * This route lives at `/e/instances/{id}/tos`, outside the normal instance path, so
   * it cannot go through {@link BlindpayClient.instancePath}.
   */
  requestTos(body: BlindpayTosRequest): Promise<{ url: string }> {
    return this.client.post<{ url: string }>(
      `/e/instances/${this.client.instanceId}/tos`,
      body,
    );
  }

  /** Creates the receiver at BlindPay — the irreversible step of `enable`. */
  createReceiver(payload: object): Promise<BlindpayObject> {
    return this.client.post<BlindpayObject>(
      this.client.instancePath('/customers'),
      payload,
    );
  }

  getReceiver(receiverId: string): Promise<BlindpayObject> {
    return this.client.get<BlindpayObject>(
      this.client.instancePath(`/customers/${receiverId}`),
    );
  }

  updateReceiver(receiverId: string, patch: object): Promise<BlindpayObject> {
    return this.client.put<BlindpayObject>(
      this.client.instancePath(`/customers/${receiverId}`),
      patch,
    );
  }

  deleteReceiver(receiverId: string): Promise<unknown> {
    return this.client.delete(
      this.client.instancePath(`/customers/${receiverId}`),
    );
  }

  createBlockchainWallet(
    receiverId: string,
    body: object,
  ): Promise<BlindpayObject> {
    return this.client.post<BlindpayObject>(
      this.client.instancePath(`/customers/${receiverId}/blockchain-wallets`),
      body,
    );
  }

  /** The message a customer signs to prove an EOA wallet is theirs. */
  getWalletSignMessage(receiverId: string): Promise<BlindpayObject> {
    return this.client.get<BlindpayObject>(
      this.client.instancePath(
        `/customers/${receiverId}/blockchain-wallets/sign-message`,
      ),
    );
  }

  deleteBlockchainWallet(
    receiverId: string,
    walletId: string,
  ): Promise<unknown> {
    return this.client.delete(
      this.client.instancePath(
        `/customers/${receiverId}/blockchain-wallets/${walletId}`,
      ),
    );
  }

  createBankAccount(receiverId: string, body: object): Promise<BlindpayObject> {
    return this.client.post<BlindpayObject>(
      this.client.instancePath(`/customers/${receiverId}/bank-accounts`),
      body,
    );
  }

  deleteBankAccount(
    receiverId: string,
    bankAccountId: string,
  ): Promise<unknown> {
    return this.client.delete(
      this.client.instancePath(
        `/customers/${receiverId}/bank-accounts/${bankAccountId}`,
      ),
    );
  }

  /** Uploads a KYC document into one of BlindPay's storage buckets. */
  uploadFile(
    file: UploadableFile,
    bucket: string,
  ): Promise<{ file_url: string }> {
    return this.client.uploadFile(file, bucket);
  }

  /** The bank rails available to the platform instance (not instance-scoped). */
  listRails(): Promise<BlindpayObject> {
    return this.client.get<BlindpayObject>('/available/rails');
  }

  /** The field schema a rail requires (not instance-scoped). */
  getBankDetails(rail: string): Promise<BlindpayObject> {
    return this.client.get<BlindpayObject>('/available/bank-details', {
      query: { rail },
    });
  }
}
