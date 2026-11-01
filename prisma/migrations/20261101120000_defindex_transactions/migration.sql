-- DeFindex vault transactions this service built, so POST /v1/defindex/submit relays
-- only a signed copy of one of them (same consumer, same network, before it expires,
-- once).
--
-- A new table and two new enums; nothing existing is rewritten.
-- CreateEnum
CREATE TYPE "DefindexTransactionStatus" AS ENUM ('BUILT', 'SUBMITTING', 'SUBMITTED');

-- CreateEnum
CREATE TYPE "DefindexOperationKind" AS ENUM ('DEPOSIT', 'WITHDRAW');

-- CreateTable
CREATE TABLE "defindex_transaction" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "kind" "DefindexOperationKind" NOT NULL,
    "status" "DefindexTransactionStatus" NOT NULL DEFAULT 'BUILT',
    "vault" TEXT NOT NULL,
    "caller" TEXT NOT NULL,
    "xdr" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "defindex_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "defindex_transaction_consumerId_txHash_key" ON "defindex_transaction"("consumerId", "txHash");

-- AddForeignKey
ALTER TABLE "defindex_transaction" ADD CONSTRAINT "defindex_transaction_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

