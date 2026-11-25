import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CHAINS } from '@/chains/chains.constants';
import { CROSS_CHAIN_NETWORK_IDS } from '@/cross-chain-swaps/cross-chain-swaps.constants';
import { CreatePayPaymentIntentDto } from '@/payment-intents/dto/create-pay-payment-intent.dto';
import {
  isDepositNetwork,
  isRoutedNetwork,
  PAYMENT_NETWORK_RULES,
  PAYMENT_NETWORKS,
  paymentAddressRule,
  paymentNetworkName,
  paymentNetworkOf,
} from '@/payment-intents/payment-networks';

function errorsOf(body: Record<string, unknown>): string[] {
  return validateSync(plainToInstance(CreatePayPaymentIntentDto, body)).flatMap(
    (e) => Object.values(e.constraints ?? {}),
  );
}

describe('payment networks', () => {
  it('are every chain, then every other network cross-chain swaps reach: derived, not a copy', () => {
    expect(PAYMENT_NETWORKS).toEqual([
      ...CHAINS,
      ...CROSS_CHAIN_NETWORK_IDS.filter(
        (id) => !(CHAINS as readonly string[]).includes(id),
      ),
    ]);
    expect(PAYMENT_NETWORKS.slice(0, 4)).toEqual([
      'stellar',
      'solana',
      'monad',
      'arc',
    ]);
    expect(new Set(PAYMENT_NETWORKS).size).toBe(PAYMENT_NETWORKS.length);
    expect(PAYMENT_NETWORKS.length).toBe(CROSS_CHAIN_NETWORK_IDS.length + 1);
  });

  it('has Arc as a native chain the cross-chain route does not reach', () => {
    expect(PAYMENT_NETWORKS).toContain('arc');
    expect(CROSS_CHAIN_NETWORK_IDS as readonly string[]).not.toContain('arc');
    expect(isRoutedNetwork('arc')).toBe(false);
    expect(isRoutedNetwork('monad')).toBe(true);
    expect(paymentNetworkOf('arc')).toBe('arc');
    expect(paymentNetworkName('arc')).toBe('Arc');
    expect(PAYMENT_NETWORK_RULES.arc.nativeSymbol).toBe('USDC');
    const rule = paymentAddressRule('arc');
    expect(rule.caseInsensitive).toBe(true);
    expect(rule.normalize('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')).toBe(
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    );
    const hash = `0x${'AB'.repeat(32)}`;
    expect(PAYMENT_NETWORK_RULES.arc.txId.isValid(hash)).toBe(true);
    expect(PAYMENT_NETWORK_RULES.arc.txId.normalize(hash)).toBe(
      hash.toLowerCase(),
    );
  });

  it('settle through deposits everywhere but Stellar, Solana, Monad and Arc', () => {
    for (const network of PAYMENT_NETWORKS) {
      expect(isDepositNetwork(network)).toBe(
        !(CHAINS as readonly string[]).includes(network),
      );
    }
    expect(isDepositNetwork('qtc')).toBe(false);
  });

  it('reads a stored chain, Stellar when there is none, and refuses one it does not know', () => {
    expect(paymentNetworkOf(null)).toBe('stellar');
    expect(paymentNetworkOf('btc')).toBe('btc');
    expect(() => paymentNetworkOf('qtc')).toThrow(/unknown chain/);
  });
});

describe('CreatePayPaymentIntentDto on every network', () => {
  it('takes a Stellar destination with no chain, with the message it always had', () => {
    expect(
      errorsOf({
        destination: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
      }),
    ).toEqual([]);
    expect(errorsOf({ destination: 'nope' })).toEqual([
      'destination must be a valid Stellar account address (G...)',
    ]);
  });

  it.each([
    ['eth', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'],
    ['base', '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'],
    ['btc', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'],
    ['tron', 'TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy'],
    ['xrp', 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe'],
    ['near', 'merchant.near'],
    ['solana', 'mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN'],
  ])('takes a %s address on %s', (chain, destination) => {
    expect(errorsOf({ chain, destination, amount: '1' })).toEqual([]);
  });

  it("refuses another network's address, naming the network's own format", () => {
    expect(
      errorsOf({
        chain: 'tron',
        destination: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      }),
    ).toEqual([
      'destination must be a valid Tron address (T..., 34 base58) for chain tron',
    ]);
  });

  it('refuses a network payment links do not settle on', () => {
    const errors = errorsOf({ chain: 'qtc', destination: 'whatever' });
    expect(errors.some((e) => e.startsWith('chain must be one of'))).toBe(true);
  });

  it('takes a token as the route names it off the three chains, an address on them', () => {
    // A Sui coin type is not an address.
    expect(
      errorsOf({
        chain: 'sui',
        destination: `0x${'a'.repeat(64)}`,
        amount: '1',
        assetCode: 'USDC',
        assetIssuer:
          '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
      }),
    ).toEqual([]);
    expect(
      errorsOf({
        chain: 'sui',
        destination: `0x${'a'.repeat(64)}`,
        assetIssuer: 'has a space',
      }),
    ).toEqual([
      "assetIssuer must be the token's contract as the cross-chain route lists it for chain sui",
    ]);
    expect(
      errorsOf({
        chain: 'solana',
        destination: 'mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN',
        assetIssuer: '0xdba3::usdc::USDC',
      }),
    ).toEqual([
      'assetIssuer must be a valid Solana address (base58, 32 bytes) for chain solana',
    ]);
  });
});
