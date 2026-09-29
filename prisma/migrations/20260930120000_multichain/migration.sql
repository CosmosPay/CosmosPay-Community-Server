-- Solana and Monad beside Stellar.
--
-- Every new `chain` column defaults to 'stellar', so each existing row keeps
-- meaning exactly what it meant: nothing is rewritten, and a deployment that
-- never creates a Solana or Monad row reads the same data it did before.

-- Payment intents: the chain, the asset's decimals where the chain does not fix
-- them, and how a payment is found where there is no Stellar memo (Solana Pay
-- reference key; Monad log-scan cursor).
ALTER TABLE "payment_intent" ADD COLUMN     "assetDecimals" INTEGER,
ADD COLUMN     "chain" TEXT NOT NULL DEFAULT 'stellar',
ADD COLUMN     "chainCursor" TEXT,
ADD COLUMN     "chainReference" TEXT;

CREATE INDEX "payment_intent_consumerId_chain_createdAt_idx" ON "payment_intent"("consumerId", "chain", "createdAt");

-- Aliases: an address is unique per (alias, chain, network) now — the same
-- ed25519 key is a Stellar G… and a Solana base58 address, and the two are
-- different destinations.
ALTER TABLE "alias_address" ADD COLUMN     "chain" TEXT NOT NULL DEFAULT 'stellar';
ALTER TABLE "alias_challenge" ADD COLUMN     "chain" TEXT NOT NULL DEFAULT 'stellar';

DROP INDEX "alias_address_aliasId_network_idx";
DROP INDEX "alias_address_aliasId_network_address_key";
CREATE INDEX "alias_address_aliasId_chain_network_idx" ON "alias_address"("aliasId", "chain", "network");
CREATE UNIQUE INDEX "alias_address_aliasId_chain_network_address_key" ON "alias_address"("aliasId", "chain", "network", "address");

-- Wallet sign-in: the account an identity is attached to may be on any chain.
-- The address columns keep their name ("stellarAddress"); the Prisma field is
-- `address`.
ALTER TABLE "wallet_account" ADD COLUMN     "chain" TEXT NOT NULL DEFAULT 'stellar';
ALTER TABLE "wallet_backup" ADD COLUMN     "chain" TEXT NOT NULL DEFAULT 'stellar';
