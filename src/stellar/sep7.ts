import QRCode from 'qrcode';
import { ResolvedAsset } from '@/stellar/asset';

/** The optional parameters either SEP-7 operation may carry. */
export interface Sep7Extras {
  msg?: string;
  callback?: string;
}

/** The terms a SEP-7 `pay` request encodes. */
export interface Sep7PayTerms extends Sep7Extras {
  destination: string;
  /** Absent for an open amount: the payer chooses. */
  amount?: string;
  asset: ResolvedAsset;
  /** A MEMO_ID, already validated or minted. */
  memo: string;
}

/**
 * The SEP-7 wire format: the `web+stellar:` URIs a wallet opens, and the QR code
 * a wallet scans for one.
 *
 * Payment intents, swaps and liquidity pools each spelled this out themselves —
 * `web+stellar:tx?` over a `URLSearchParams`, then `QRCode.toDataURL` — three
 * copies of a format a wallet parses byte for byte. A parameter name, its order
 * or its encoding is a change for every flow at once, so it is written once.
 *
 * Plain functions rather than a provider: nothing here reads config or the
 * network, and every output is a pure function of its input. Building the
 * envelope a `tx` link carries is each flow's own business and stays with it.
 */

/**
 * SEP-7 `tx`: a URI carrying an unsigned envelope for the wallet to sign, with
 * `callback` before `msg` when either is given.
 */
export function sep7TxUri(xdr: string, extras: Sep7Extras = {}): string {
  const params = new URLSearchParams({ xdr });
  appendExtras(params, extras);
  return `web+stellar:tx?${params.toString()}`;
}

/**
 * SEP-7 `pay`: no source and no envelope. The wallet builds the transaction,
 * so the URI has to carry every term the payment must match — `memo_type`
 * included, because SEP-7 defaults a memo to text and the verifier only
 * accepts a MEMO_ID.
 */
export function sep7PayUri(terms: Sep7PayTerms): string {
  const params = new URLSearchParams({ destination: terms.destination });
  if (terms.amount) params.set('amount', terms.amount);
  if (terms.asset.code !== 'native') {
    params.set('asset_code', terms.asset.code);
    if (terms.asset.issuer) {
      params.set('asset_issuer', terms.asset.issuer);
    }
  }
  params.set('memo', terms.memo);
  params.set('memo_type', 'MEMO_ID');
  appendExtras(params, terms);
  return `web+stellar:pay?${params.toString()}`;
}

/** The QR a wallet scans for `uri`, as a PNG data URL. Derived, never stored. */
export function sep7Qr(uri: string): Promise<string> {
  return QRCode.toDataURL(uri);
}

/** Appends the parameters both operations share, `callback` before `msg`. */
function appendExtras(params: URLSearchParams, extras: Sep7Extras): void {
  if (extras.callback) params.set('callback', extras.callback);
  if (extras.msg) params.set('msg', extras.msg);
}
