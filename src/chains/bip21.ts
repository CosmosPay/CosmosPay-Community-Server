import { BIP21_SCHEME } from '@/chains/chains.constants';

/** What a BIP-21 payment request carries. */
export interface Bip21Request {
  /** The payee: any Bitcoin address. */
  address: string;
  /**
   * Decimal BTC — not satoshis — written with a dot and no exponent, as the
   * BIP specifies. Omitted, the wallet asks the payer how much.
   */
  amount?: string;
}

/**
 * A BIP-21 URI: `bitcoin:<address>?amount=<BTC>`, the form every Bitcoin
 * wallet opens from a link or a QR code. Pure: everything in it comes from the
 * request.
 */
export function bip21Uri(request: Bip21Request): string {
  const params = new URLSearchParams();
  if (request.amount !== undefined) params.set('amount', request.amount);
  const query = params.toString();
  return `${BIP21_SCHEME}${request.address}${query ? `?${query}` : ''}`;
}
