import type { AppConfig, BlindpayEnvironment } from '@/config/configuration';
import { decodeSvixSecret } from '@/native-plugins/blindpay/blindpay-signature';
import { SVIX_MIN_SECRET_BYTES } from '@/native-plugins/blindpay/blindpay.constants';

/** The variables an instance is configured by, named in the boot error. */
const INSTANCE_VARS: Record<
  BlindpayEnvironment,
  { apiKey: string; instanceId: string; webhookSecret: string }
> = {
  prod: {
    apiKey: 'BLINDPAY_API_KEY',
    instanceId: 'BLINDPAY_INSTANCE_ID',
    webhookSecret: 'BLINDPAY_WEBHOOK_SECRET',
  },
  dev: {
    apiKey: 'BLINDPAY_API_KEY_DEV',
    instanceId: 'BLINDPAY_INSTANCE_ID_DEV',
    webhookSecret: 'BLINDPAY_WEBHOOK_SECRET_DEV',
  },
};

function isNonEmpty(value: string | undefined): value is string {
  return value != null && value.trim() !== '';
}

/**
 * Each BlindPay instance is configured by its own trio of variables — unsuffixed
 * for production, `_DEV` for development — and a trio must be whole: an instance
 * id is required alongside its key, and so is the webhook secret, because without
 * it that instance's deliveries cannot be verified at all.
 *
 * Run when the `blindpay` plugin boots, so a deployment that enables it with a
 * half-configured instance refuses to start — and one that does not enable it is
 * never held to variables it does not read.
 */
export function assertBlindpayInstancesConsistent(
  blindpay: AppConfig['blindpay'],
): void {
  for (const env of Object.keys(INSTANCE_VARS) as BlindpayEnvironment[]) {
    const instance = blindpay.instances[env];
    const vars = INSTANCE_VARS[env];

    if (isNonEmpty(instance.apiKey)) {
      if (!isNonEmpty(instance.instanceId)) {
        throw new Error(
          `${vars.instanceId} is required when ${vars.apiKey} is set: ` +
            'every BlindPay API call is scoped to a platform instance id (in_...).',
        );
      }
      if (!isNonEmpty(instance.webhookSecret)) {
        throw new Error(
          `${vars.webhookSecret} is required when ${vars.apiKey} is set: ` +
            'inbound BlindPay webhooks are verified with the Svix signing secret (whsec_...).',
        );
      }
    }

    // Checked whenever it is set, not only alongside the API key: the inbound
    // webhook route reads it on its own.
    if (
      isNonEmpty(instance.webhookSecret) &&
      !decodeSvixSecret(instance.webhookSecret)
    ) {
      throw new Error(
        `${vars.webhookSecret} is not a usable Svix signing secret: it must be the ` +
          'whsec_... value BlindPay shows for the endpoint, whose base64 key decodes ' +
          `to at least ${SVIX_MIN_SECRET_BYTES} bytes. A truncated or mistyped secret ` +
          'decodes to a short or empty key, and a webhook signed with that proves nothing.',
      );
    }
  }
}
