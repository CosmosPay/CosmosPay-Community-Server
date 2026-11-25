-- Payment links: the payer's email and checkout language (receipts), the
-- receipt's claim and sending time, the merchant's own limits on payments from
-- another network per link, the merchant fee a deposit pays as an app fee, and
-- on `customer` whether its email was typed by a payer (unverified).
--
-- Nullable columns and one boolean with a default only; nothing existing is
-- rewritten, so it applies online on every database.
-- AlterTable
ALTER TABLE "customer" ADD COLUMN     "emailProvidedByPayer" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "payment_intent" ADD COLUMN     "depositBudgetPerWindow" INTEGER,
ADD COLUMN     "depositMaxPerPayer" INTEGER,
ADD COLUMN     "payerEmail" TEXT,
ADD COLUMN     "payerLang" TEXT,
ADD COLUMN     "receiptClaimedAt" TIMESTAMP(3),
ADD COLUMN     "receiptSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "payment_deposit" ADD COLUMN     "merchantFee" JSONB,
ADD COLUMN     "payerEmail" TEXT,
ADD COLUMN     "payerLang" TEXT;

