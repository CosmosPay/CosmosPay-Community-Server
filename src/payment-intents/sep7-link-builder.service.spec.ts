import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { resolveAsset } from '@/stellar/asset';
import { Sep7LinkBuilder } from '@/payment-intents/sep7-link-builder.service';

/**
 * A wallet parses the URI and a payer signs the envelope, so both are pinned
 * where the bytes matter: the parameter names and order this service has always
 * emitted, and the operation, memo, fee and timebounds the transaction commits
 * the payer to.
 */
describe('Sep7LinkBuilder', () => {
  const source = Keypair.random().publicKey();
  const destination = Keypair.random().publicKey();
  const issuer = Keypair.random().publicKey();

  function build() {
    const accounts = {
      load: jest.fn(
        async (_network: string, id: string) => new Account(id, '41'),
      ),
    };
    const stellar = { passphrase: jest.fn(() => Networks.TESTNET) };
    const config = {
      get: () => ({ baseFee: '250', timeoutSeconds: 300 }),
    } as never;
    const links = new Sep7LinkBuilder(
      config,
      stellar as never,
      accounts as never,
    );
    return { links, accounts, stellar };
  }

  describe('tx', () => {
    it('builds one unsigned payment from the loaded source, with the MEMO_ID, fee and timeout', async () => {
      const { links, accounts, stellar } = build();
      const before = Math.floor(Date.now() / 1000);

      const { xdr } = await links.tx('testnet', {
        source,
        destination,
        amount: '25.5',
        asset: resolveAsset('USDC', issuer),
        memo: '18446744073709551615',
      });

      // Sequence number and passphrase both come from the caller's network.
      expect(accounts.load).toHaveBeenCalledWith('testnet', source);
      expect(stellar.passphrase).toHaveBeenCalledWith('testnet');

      const tx = TransactionBuilder.fromXDR(
        xdr,
        Networks.TESTNET,
      ) as Transaction;
      expect(tx.signatures).toHaveLength(0);
      expect(tx.source).toBe(source);
      expect(tx.sequence).toBe('42');
      expect(tx.fee).toBe('250');
      expect(tx.memo.type).toBe('id');
      expect(tx.memo.value).toBe('18446744073709551615');
      expect(tx.operations).toHaveLength(1);
      const payment = tx.operations[0] as Operation.Payment;
      expect(payment.type).toBe('payment');
      expect(payment.destination).toBe(destination);
      expect(payment.amount).toBe('25.5000000');
      expect(payment.asset.equals(new Asset('USDC', issuer))).toBe(true);
      expect(Number(tx.timeBounds?.maxTime)).toBeGreaterThanOrEqual(
        before + 300,
      );
    });

    it('carries the envelope in a tx URI, followed by callback and msg', async () => {
      const { links } = build();

      const { xdr, uri } = await links.tx('testnet', {
        source,
        destination,
        amount: '1',
        asset: resolveAsset(),
        memo: '7',
        msg: 'Order #7',
        callback: 'url:https://merchant.example/cb',
      });

      const params = new URLSearchParams({
        xdr,
        callback: 'url:https://merchant.example/cb',
        msg: 'Order #7',
      });
      expect(uri).toBe(`web+stellar:tx?${params.toString()}`);
    });

    it("builds nothing and passes the loader's error through when the source cannot be loaded", async () => {
      const { links, accounts, stellar } = build();
      const unfunded = ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        `Account ${source} not found or not funded on the testnet network`,
      );
      accounts.load.mockRejectedValueOnce(unfunded);

      await expect(
        links.tx('testnet', {
          source,
          destination,
          amount: '1',
          asset: resolveAsset(),
          memo: '7',
        }),
      ).rejects.toBe(unfunded);
      expect(stellar.passphrase).not.toHaveBeenCalled();
    });
  });

  describe('pay', () => {
    it('carries every term of the payment, in the order this service has always emitted them', () => {
      const { links } = build();

      const uri = links.pay({
        destination,
        amount: '10',
        asset: resolveAsset('USDC', issuer),
        memo: '42',
        msg: 'Order #42',
        callback: 'url:https://merchant.example/cb',
      });

      expect(uri).toBe(
        `web+stellar:pay?destination=${destination}&amount=10` +
          `&asset_code=USDC&asset_issuer=${issuer}` +
          '&memo=42&memo_type=MEMO_ID' +
          '&callback=url%3Ahttps%3A%2F%2Fmerchant.example%2Fcb&msg=Order+%2342',
      );
    });

    it('omits the amount of an open intent and the asset fields for lumens', () => {
      const { links } = build();

      expect(links.pay({ destination, asset: resolveAsset(), memo: '7' })).toBe(
        `web+stellar:pay?destination=${destination}&memo=7&memo_type=MEMO_ID`,
      );
    });
  });

  describe('qr', () => {
    it('renders the URI as a PNG data URL', async () => {
      const { links } = build();

      await expect(
        links.qr(`web+stellar:pay?destination=${destination}`),
      ).resolves.toMatch(/^data:image\/png;base64,/);
    });
  });
});
