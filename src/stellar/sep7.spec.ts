import { Keypair } from '@stellar/stellar-sdk';
import QRCode from 'qrcode';
import { resolveAsset } from '@/stellar/asset';
import { sep7PayUri, sep7Qr, sep7TxUri } from '@/stellar/sep7';

/**
 * A wallet parses these byte for byte, and swaps, liquidity pools and payment
 * intents persist the URI on their rows — so the exact strings are pinned, not
 * just their shape.
 */
describe('sep7TxUri', () => {
  // Characters URLSearchParams must escape in an XDR: `+`, `/` and `=`.
  const xdr = 'AAAA+bc/de==';

  it('carries the envelope alone, form-encoded, when nothing else is given', () => {
    expect(sep7TxUri(xdr)).toBe('web+stellar:tx?xdr=AAAA%2Bbc%2Fde%3D%3D');
    // Exactly what swaps and liquidity pools used to build inline.
    expect(sep7TxUri(xdr)).toBe(
      `web+stellar:tx?${new URLSearchParams({ xdr }).toString()}`,
    );
  });

  it('appends callback before msg', () => {
    expect(
      sep7TxUri(xdr, {
        msg: 'Order #7',
        callback: 'url:https://merchant.example/cb',
      }),
    ).toBe(
      'web+stellar:tx?xdr=AAAA%2Bbc%2Fde%3D%3D' +
        '&callback=url%3Ahttps%3A%2F%2Fmerchant.example%2Fcb&msg=Order+%237',
    );
  });

  it('leaves out empty extras', () => {
    expect(sep7TxUri(xdr, { msg: '', callback: '' })).toBe(sep7TxUri(xdr));
  });
});

describe('sep7PayUri', () => {
  const destination = Keypair.random().publicKey();
  const issuer = Keypair.random().publicKey();

  it('carries every term of the payment, in the order it has always been emitted', () => {
    expect(
      sep7PayUri({
        destination,
        amount: '10',
        asset: resolveAsset('USDC', issuer),
        memo: '42',
        msg: 'Order #42',
        callback: 'url:https://merchant.example/cb',
      }),
    ).toBe(
      `web+stellar:pay?destination=${destination}&amount=10` +
        `&asset_code=USDC&asset_issuer=${issuer}` +
        '&memo=42&memo_type=MEMO_ID' +
        '&callback=url%3Ahttps%3A%2F%2Fmerchant.example%2Fcb&msg=Order+%2342',
    );
  });

  it('omits an open amount and the asset fields for lumens', () => {
    expect(sep7PayUri({ destination, asset: resolveAsset(), memo: '7' })).toBe(
      `web+stellar:pay?destination=${destination}&memo=7&memo_type=MEMO_ID`,
    );
  });
});

describe('sep7Qr', () => {
  it('renders the URI as the PNG data URL the qrcode library produces for it', async () => {
    const uri = sep7TxUri('AAAA');

    const qr = await sep7Qr(uri);

    expect(qr).toMatch(/^data:image\/png;base64,/);
    expect(qr).toBe(await QRCode.toDataURL(uri));
  });
});
