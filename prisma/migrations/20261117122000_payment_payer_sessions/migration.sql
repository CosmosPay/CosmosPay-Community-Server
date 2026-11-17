-- The payer's email moves from one field per payment link (which anyone holding
-- the link could overwrite, or lock with a first write) to one row per hosted
-- checkout session, keyed by the SHA-256 of a random token only that session's
-- browser holds. The dropped columns were added by the two migrations before this
-- one, in the same release, and never held data in production.
-- AlterTable
ALTER TABLE "payment_intent" DROP COLUMN "payerClientKey",
DROP COLUMN "payerEmail",
DROP COLUMN "payerLang",
ADD COLUMN     "receiptSkippedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "payment_deposit" DROP COLUMN "payerEmail",
DROP COLUMN "payerLang",
ADD COLUMN     "payerSessionId" TEXT;

-- CreateTable
CREATE TABLE "payment_payer_session" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "lang" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_payer_session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_payer_session_tokenHash_key" ON "payment_payer_session"("tokenHash");

-- CreateIndex
CREATE INDEX "payment_payer_session_intentId_createdAt_idx" ON "payment_payer_session"("intentId", "createdAt");

-- AddForeignKey
ALTER TABLE "payment_deposit" ADD CONSTRAINT "payment_deposit_payerSessionId_fkey" FOREIGN KEY ("payerSessionId") REFERENCES "payment_payer_session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_payer_session" ADD CONSTRAINT "payment_payer_session_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "payment_intent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

