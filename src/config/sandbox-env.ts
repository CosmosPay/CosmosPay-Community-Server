import {
  isPaymentNetwork,
  type PaymentNetwork,
} from '@/payment-intents/payment-networks';

/**
 * `net=value,net=value` (`SANDBOX_RPC_URLS`, `SANDBOX_CUSD_ADDRESSES`), read as a
 * map from payment network to value. Each value must pass `valid`; a key that is
 * no payment network, a repeated key or a bad value refuses the boot, naming the
 * variable: a sandbox that silently ignores a typo pays from a node nobody chose.
 */
export function parseNetworkMap(
  raw: string | undefined,
  variable: string,
  valid: (value: string) => boolean,
): Partial<Record<PaymentNetwork, string>> {
  const map: Partial<Record<PaymentNetwork, string>> = {};
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf('=');
    const key = at > 0 ? trimmed.slice(0, at).trim() : '';
    const value = at > 0 ? trimmed.slice(at + 1).trim() : '';
    if (!isPaymentNetwork(key)) {
      throw new Error(
        `${variable}: "${key || trimmed}" is not a payment network id`,
      );
    }
    if (map[key] !== undefined) {
      throw new Error(`${variable}: ${key} is listed twice`);
    }
    if (!valid(value)) {
      throw new Error(`${variable}: the value for ${key} is not valid`);
    }
    map[key] = value;
  }
  return map;
}

/** An http(s) URL with a host. */
export function isRpcUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') && !!url.host
    );
  } catch {
    return false;
  }
}

/** An EVM address, 0x + 40 hex. */
export function isEvmAddressValue(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}
