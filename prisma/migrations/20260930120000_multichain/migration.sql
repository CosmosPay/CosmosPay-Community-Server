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
ADD COLUMN     "chainReference" TEXT,
ADD COLUMN     "networkFee" TEXT;

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

-- Monad deposit addresses: one CREATE2 forwarder per intent (see
-- contracts/PaymentForwarder.sol). Every constructor argument is kept — the
-- address can only ever be deployed from exactly these.
CREATE TYPE "EvmDepositStatus" AS ENUM ('AWAITING', 'FORWARDING', 'FORWARDED');

CREATE TABLE "evm_deposit_address" (
    "id" TEXT NOT NULL,
    "intentId" TEXT,
    "chain" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "token" TEXT,
    "relayer" TEXT NOT NULL,
    "fee" TEXT NOT NULL,
    "status" "EvmDepositStatus" NOT NULL DEFAULT 'AWAITING',
    "forwardTxHash" TEXT,
    "forwardedAmount" TEXT,
    "forwardSentAt" TIMESTAMP(3),
    "forwardAttempts" INTEGER NOT NULL DEFAULT 0,
    "forwardedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "evm_deposit_address_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "evm_deposit_address_intentId_key" ON "evm_deposit_address"("intentId");
CREATE UNIQUE INDEX "evm_deposit_address_address_key" ON "evm_deposit_address"("address");
CREATE INDEX "evm_deposit_address_status_createdAt_idx" ON "evm_deposit_address"("status", "createdAt");

-- SET NULL: deleting an intent must not forget an address that holds, or may
-- still receive, the merchant's money.
ALTER TABLE "evm_deposit_address" ADD CONSTRAINT "evm_deposit_address_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "payment_intent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
