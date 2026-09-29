import { isTxIdFor, normalizeTxId } from '@/payment-intents/tx-id';

const STELLAR = 'AB'.repeat(32);
const MONAD = `0x${'CD'.repeat(32)}`;
const SOLANA =
  '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

describe('transaction ids per chain', () => {
  it('accepts each chain’s own shape and no other', () => {
    expect(isTxIdFor('stellar', STELLAR)).toBe(true);
    expect(isTxIdFor('stellar', MONAD)).toBe(false);
    expect(isTxIdFor('monad', MONAD)).toBe(true);
    expect(isTxIdFor('monad', STELLAR)).toBe(false);
    expect(isTxIdFor('solana', SOLANA)).toBe(true);
    expect(isTxIdFor('solana', STELLAR)).toBe(false);
  });

  it('stores hex lowercase and base58 exactly as given', () => {
    expect(normalizeTxId('stellar', STELLAR)).toBe(STELLAR.toLowerCase());
    expect(normalizeTxId('monad', MONAD)).toBe(MONAD.toLowerCase());
    expect(normalizeTxId('solana', SOLANA)).toBe(SOLANA);
  });
});
