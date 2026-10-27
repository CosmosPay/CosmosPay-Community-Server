import {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { ChainPayLinkBuilder } from '@/payment-intents/chain-pay-link-builder.service';
import { PAY_TO } from '@/payment-intents/pay-to';
import { Sep7LinkBuilder } from '@/payment-intents/sep7-link-builder.service';
import { resolveAsset } from '@/stellar/asset';

const SOL_DEST = 'mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN';
const SOL_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const EVM_DEST = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const EVM_TOKEN = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
const DEPOSIT = '0xC830d264C14ebDB31cdEa0Fb6f83C5b0D8EEc52F';

/**
 * The address a payment link pays, read back out of the link the way a wallet
 * reads it — not from the columns the link builder also returned, which is the
 * thing under test.
 */
function recipientOf(uri: string): string {
  const [head, query = ''] = uri.split('?');
  const params = new URLSearchParams(query);
  if (head === 'web+stellar:pay') return params.get('destination')!;
  if (head === 'web+stellar:tx') {
    const tx = TransactionBuilder.fromXDR(params.get('xdr')!, Networks.TESTNET);
    const [payment] = tx.operations as Operation.Payment[];
    return payment.destination;
  }
  if (head.startsWith('solana:')) return head.slice('solana:'.length);
  if (head.startsWith('ethereum:')) {
    // An ERC-20 link names the token before `@` and the payee in `address`.
    return head.endsWith('/transfer')
      ? params.get('address')!
      : head.slice('ethereum:'.length, head.indexOf('@'));
  }
  throw new Error(`not a payment link: ${uri}`);
}

function chainLinks(depositsEnabled: boolean): ChainPayLinkBuilder {
  const solana = { getMintDecimals: jest.fn().mockResolvedValue(6) };
  const evm = {
    erc20Decimals: jest.fn().mockResolvedValue(6),
    chainId: jest.fn().mockReturnValue(10143),
    blockNumber: jest.fn().mockResolvedValue(12_345n),
  };
  const deposits = {
    isEnabled: () => depositsEnabled,
    mint: jest.fn(
      async (
        _chain: string,
        _network: string,
        destination: string,
        token: { address: string } | null,
      ) => ({
        address: DEPOSIT,
        salt: `0x${'11'.repeat(32)}`,
        destination,
        token: token?.address ?? null,
        relayer: '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
        fee: 10n ** 4n,
      }),
    ),
  };
  return new ChainPayLinkBuilder(
    solana as never,
    evm as never,
    deposits as never,
  );
}

describe('PAY_TO', () => {
  describe('is the address inside the link the builder wrote', () => {
    it('Stellar pay: the SEP-7 destination', () => {
      const destination = Keypair.random().publicKey();
      const uri = new Sep7LinkBuilder(
        {} as never,
        {} as never,
        {} as never,
      ).pay({ destination, amount: '25.5', asset: resolveAsset(), memo: '42' });
      const payTo = PAY_TO.stellar({ destination, chainReference: null });
      expect(payTo).toBe(destination);
      expect(recipientOf(uri)).toBe(payTo);
    });

    it('Stellar tx: the destination the envelope pays', async () => {
      const source = Keypair.random().publicKey();
      const destination = Keypair.random().publicKey();
      const sep7 = new Sep7LinkBuilder(
        { get: () => ({ baseFee: '100', timeoutSeconds: 300 }) } as never,
        { passphrase: () => Networks.TESTNET } as never,
        { load: async () => new Account(source, '1') } as never,
      );
      const { uri } = await sep7.tx('testnet', {
        source,
        destination,
        amount: '25.5',
        asset: resolveAsset(),
        memo: '42',
      });
      expect(recipientOf(uri)).toBe(
        PAY_TO.stellar({ destination, chainReference: null }),
      );
    });

    it.each([
      ['SOL', {}],
      ['an SPL token', { assetCode: 'USDC', assetIssuer: SOL_MINT }],
    ])(
      'Solana (%s): the recipient, never the reference key',
      async (_label, asset) => {
        const link = await chainLinks(false).build('solana', {
          network: 'testnet',
          destination: SOL_DEST,
          amount: '1.5',
          memo: '42',
          ...asset,
        });
        const payTo = PAY_TO.solana(link);
        expect(payTo).toBe(SOL_DEST);
        expect(recipientOf(link.uri)).toBe(payTo);
        // The reference is a random key nobody holds: paying it burns the money.
        expect(link.chainReference).not.toBeNull();
        expect(payTo).not.toBe(link.chainReference);
      },
    );

    it.each([
      ['MON', {}],
      ['an ERC-20', { assetCode: 'USDC', assetIssuer: EVM_TOKEN }],
    ])(
      'Monad with a relayer (%s): the deposit address, not the merchant',
      async (_label, asset) => {
        const link = await chainLinks(true).build('monad', {
          network: 'testnet',
          destination: EVM_DEST,
          amount: '1',
          memo: '42',
          ...asset,
        });
        const payTo = PAY_TO.monad(link);
        expect(payTo).toBe(DEPOSIT);
        expect(payTo).not.toBe(EVM_DEST);
        expect(recipientOf(link.uri)).toBe(payTo);
      },
    );

    it.each([
      ['MON', {}],
      ['an ERC-20', { assetCode: 'USDC', assetIssuer: EVM_TOKEN }],
    ])('Monad without a relayer (%s): the merchant', async (_label, asset) => {
      const link = await chainLinks(false).build('monad', {
        network: 'testnet',
        destination: EVM_DEST,
        amount: '1',
        memo: '42',
        ...asset,
      });
      const payTo = PAY_TO.monad(link);
      expect(payTo).toBe(EVM_DEST);
      expect(recipientOf(link.uri)).toBe(payTo);
    });
  });
});
