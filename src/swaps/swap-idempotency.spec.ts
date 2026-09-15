import { Keypair } from '@stellar/stellar-sdk';
import { SwapRequestTerms, swapMatchesRequest } from '@/swaps/swap-idempotency';

const VICTIM = Keypair.random().publicKey();
const ATTACKER = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();

function terms(overrides: Partial<SwapRequestTerms> = {}): SwapRequestTerms {
  return {
    network: 'public',
    source: VICTIM,
    destination: VICTIM,
    sendAsset: 'native',
    sendAssetIssuer: null,
    sendAmount: '100',
    destAsset: 'USDC',
    destAssetIssuer: ISSUER,
    slippageBps: 50,
    memo: null,
    ...overrides,
  };
}

describe('swapMatchesRequest', () => {
  it('matches the request that built the swap', () => {
    expect(swapMatchesRequest(terms(), terms())).toBe(true);
  });

  it('compares the amount by value, not by spelling', () => {
    expect(
      swapMatchesRequest(
        terms({ sendAmount: '100' }),
        terms({ sendAmount: '100.0000000' }),
      ),
    ).toBe(true);
  });

  it('refuses a stored swap that pays someone other than the caller asked', () => {
    // The attack this exists for: under the shared public key everyone is one
    // consumer, so a swap pre-built with the victim as source and the attacker
    // as destination sat behind a guessable key waiting for the victim's wallet.
    expect(swapMatchesRequest(terms({ destination: ATTACKER }), terms())).toBe(
      false,
    );
  });

  it.each<[string, Partial<SwapRequestTerms>]>([
    ['network', { network: 'testnet' }],
    ['source', { source: ATTACKER }],
    ['source asset', { sendAsset: 'USDC', sendAssetIssuer: ISSUER }],
    ['amount', { sendAmount: '100.0000001' }],
    ['destination asset', { destAsset: 'EURC' }],
    ['destination asset issuer', { destAssetIssuer: ATTACKER }],
    ['slippage', { slippageBps: 500 }],
    ['memo', { memo: '42' }],
  ])('refuses a different %s', (_field, change) => {
    expect(swapMatchesRequest(terms(change), terms())).toBe(false);
  });

  it('refuses an amount that does not parse instead of throwing', () => {
    expect(
      swapMatchesRequest(terms(), terms({ sendAmount: '1000000000000' })),
    ).toBe(false);
  });
});
