import { bip21Uri } from '@/chains/bip21';

const ADDRESS = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

describe('bip21Uri', () => {
  it('asks for the amount in decimal BTC, never in satoshis', () => {
    expect(bip21Uri({ address: ADDRESS, amount: '0.00125' })).toBe(
      `bitcoin:${ADDRESS}?amount=0.00125`,
    );
  });

  it('leaves the amount to the payer when none is given', () => {
    expect(bip21Uri({ address: ADDRESS })).toBe(`bitcoin:${ADDRESS}`);
  });
});
