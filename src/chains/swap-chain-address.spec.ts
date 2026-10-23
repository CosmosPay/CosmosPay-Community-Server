import { CHAIN_ADDRESS_RULES } from '@/chains/chain-address';
import { CHAINS, SWAP_CHAINS, type SwapChain } from '@/chains/chains.constants';
import {
  normalizeSwapAddress,
  SWAP_CHAIN_ADDRESS_RULES,
} from '@/chains/swap-chain-address';

const STELLAR = 'GARMB7W3FCR3GKIM3FLWVJASC2PUZ4VHUJZTNJVWWKNTCJNKO6TBCT76';
const SOLANA = 'So11111111111111111111111111111111111111112';
const EVM = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const BITCOIN = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

/** One address per address family; the EVM chains share theirs. */
const VALID: Record<SwapChain, string> = {
  stellar: STELLAR,
  solana: SOLANA,
  monad: EVM,
  ethereum: EVM,
  arbitrum: EVM,
  base: EVM,
  bitcoin: BITCOIN,
};

describe('SWAP_CHAIN_ADDRESS_RULES', () => {
  it('keeps the payment chains’ rules exactly as they are', () => {
    for (const chain of CHAINS) {
      expect(SWAP_CHAIN_ADDRESS_RULES[chain]).toBe(CHAIN_ADDRESS_RULES[chain]);
    }
  });

  it('does not widen the payment chains’ table', () => {
    expect(Object.keys(CHAIN_ADDRESS_RULES).sort()).toEqual([...CHAINS].sort());
  });

  it.each(SWAP_CHAINS)(
    'accepts %s’s own address family and no other',
    (chain) => {
      for (const other of SWAP_CHAINS) {
        const sameFamily = VALID[other] === VALID[chain];
        expect(SWAP_CHAIN_ADDRESS_RULES[chain].isValid(VALID[other])).toBe(
          sameFamily,
        );
      }
    },
  );

  it.each(['ethereum', 'arbitrum', 'base'] as const)(
    'stores a %s address EIP-55 checksummed, as Monad does',
    (chain) => {
      expect(normalizeSwapAddress(chain, EVM.toLowerCase())).toBe(EVM);
      expect(SWAP_CHAIN_ADDRESS_RULES[chain].expected).toMatch(/0x \+ 40 hex/);
    },
  );

  it('stores a segwit address lower-case and names what Bitcoin expects', () => {
    expect(normalizeSwapAddress('bitcoin', BITCOIN.toUpperCase())).toBe(
      BITCOIN,
    );
    expect(SWAP_CHAIN_ADDRESS_RULES.bitcoin.expected).toMatch(
      /Bitcoin mainnet/,
    );
  });
});
