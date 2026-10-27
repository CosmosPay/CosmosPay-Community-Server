-- Cross-chain swaps reach every network NEAR Intents lists and this service can
-- validate, and not every one of them has a wallet-link standard (XRP Ledger,
-- Tron, NEAR, Sui, ...). Their deposits have no link: the payer sends to the
-- deposit address (and memo) with any wallet of that chain, and the QR encodes
-- the address. Every existing row keeps its link; nothing is rewritten.

-- AlterTable
ALTER TABLE "cross_chain_swap" ALTER COLUMN "depositUri" DROP NOT NULL;
