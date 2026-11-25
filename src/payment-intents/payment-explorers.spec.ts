import { paymentExplorerTxUrl } from '@/payment-intents/payment-explorers';

const HASH = `0x${'AB'.repeat(32)}`;

describe('paymentExplorerTxUrl', () => {
  it('links an Arc transaction on each tier’s explorer, hash lowercased', () => {
    expect(paymentExplorerTxUrl('arc', 'public', HASH)).toBe(
      `https://explorer.arc.io/tx/${HASH.toLowerCase()}`,
    );
    expect(paymentExplorerTxUrl('arc', 'testnet', HASH)).toBe(
      `https://explorer.testnet.arc.io/tx/${HASH.toLowerCase()}`,
    );
  });

  it('links nothing for a value that is not an EVM hash, or no hash at all', () => {
    expect(paymentExplorerTxUrl('arc', 'public', 'AB'.repeat(32))).toBeNull();
    expect(paymentExplorerTxUrl('arc', 'public', `${HASH}/../evil`)).toBeNull();
    expect(paymentExplorerTxUrl('arc', 'public', null)).toBeNull();
  });

  it('keeps Monad’s explorers as they were', () => {
    expect(paymentExplorerTxUrl('monad', 'testnet', HASH)).toBe(
      `https://testnet.monadexplorer.com/tx/${HASH.toLowerCase()}`,
    );
  });
});
