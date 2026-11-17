import { CROSS_CHAIN_NETWORKS } from '@/cross-chain-swaps/cross-chain-networks';
import type { StellarNetwork } from '@/config/configuration';
import type { PaymentNetwork } from '@/payment-intents/payment-networks';

type TxUrl = (hash: string) => string;

/* An Etherscan-style explorer: /tx/<hash>. */
const scan =
  (origin: string): TxUrl =>
  (h) =>
    `${origin}/tx/${h}`;
/* Blockchair, for the Bitcoin family: /<chain>/transaction/<hash>. */
const blockchair =
  (chain: string): TxUrl =>
  (h) =>
    `https://blockchair.com/${chain}/transaction/${h}`;

/**
 * Where a payment's transaction can be looked at, per network and tier: the
 * same explorers the developer platform links (its `src/lib/chains.ts`).
 * Stellar, Solana and Monad have a test network; every other network is paid
 * on mainnet only. A network with no explorer we checked (Robinhood Chain,
 * Aleo, Fogo) has none, and the receipt names the transaction without a link.
 */
const PAYMENT_EXPLORERS: Record<
  PaymentNetwork,
  Partial<Record<StellarNetwork, TxUrl>>
> = {
  stellar: {
    public: (h) => `https://stellar.expert/explorer/public/tx/${h}`,
    testnet: (h) => `https://stellar.expert/explorer/testnet/tx/${h}`,
  },
  solana: {
    public: (h) => `https://solscan.io/tx/${h}`,
    testnet: (h) => `https://explorer.solana.com/tx/${h}?cluster=devnet`,
  },
  monad: {
    public: scan('https://monadscan.com'),
    testnet: scan('https://testnet.monadexplorer.com'),
  },
  eth: { public: scan('https://etherscan.io') },
  base: { public: scan('https://basescan.org') },
  arb: { public: scan('https://arbiscan.io') },
  op: { public: scan('https://optimistic.etherscan.io') },
  bsc: { public: scan('https://bscscan.com') },
  pol: { public: scan('https://polygonscan.com') },
  avax: { public: scan('https://snowtrace.io') },
  gnosis: { public: scan('https://gnosisscan.io') },
  bera: { public: scan('https://berascan.com') },
  scroll: { public: scan('https://scrollscan.com') },
  xlayer: { public: scan('https://www.oklink.com/xlayer') },
  abs: { public: scan('https://abscan.org') },
  plasma: { public: scan('https://plasmascan.to') },
  hood: {},
  hypercore: {
    public: (h) => `https://app.hyperliquid.xyz/explorer/tx/${h}`,
  },
  btc: { public: blockchair('bitcoin') },
  ltc: { public: blockchair('litecoin') },
  doge: { public: blockchair('dogecoin') },
  bch: { public: blockchair('bitcoin-cash') },
  dash: { public: blockchair('dash') },
  zec: { public: blockchair('zcash') },
  xrp: { public: (h) => `https://livenet.xrpl.org/transactions/${h}` },
  tron: { public: (h) => `https://tronscan.org/#/transaction/${h}` },
  ton: { public: (h) => `https://tonviewer.com/transaction/${h}` },
  near: { public: (h) => `https://nearblocks.io/txns/${h}` },
  sui: { public: (h) => `https://suiscan.xyz/mainnet/tx/${h}` },
  aptos: {
    public: (h) => `https://explorer.aptoslabs.com/txn/${h}?network=mainnet`,
  },
  movement: {
    public: (h) =>
      `https://explorer.movementnetwork.xyz/txn/${h}?network=mainnet`,
  },
  starknet: { public: (h) => `https://voyager.online/tx/${h}` },
  cardano: { public: (h) => `https://cardanoscan.io/transaction/${h}` },
  aleo: {},
  fogo: {},
};

/**
 * The explorer page of transaction `hash` on `chain`, or null when the network
 * has no explorer on that tier or the hash is not one of the network's shape.
 * The hash is checked against the network's own rule and encoded, so a stored
 * value can never turn into another URL.
 */
export function paymentExplorerTxUrl(
  chain: PaymentNetwork,
  network: StellarNetwork,
  hash: string | null | undefined,
): string | null {
  if (!hash) return null;
  const rule = CROSS_CHAIN_NETWORKS[chain].txId;
  if (!rule.isValid(hash)) return null;
  const url = PAYMENT_EXPLORERS[chain][network];
  return url ? url(encodeURIComponent(rule.normalize(hash))) : null;
}
