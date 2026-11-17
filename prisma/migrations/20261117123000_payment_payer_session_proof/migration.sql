-- A checkout session's proof: the account its wallet pays from and the
-- transaction its wallet answered, registered through the token-authenticated
-- wallet events. The receipt and the customer link go to the session whose proof
-- matches the settlement. Additive: three nullable columns.
-- AlterTable
ALTER TABLE "payment_payer_session" ADD COLUMN     "provenAt" TIMESTAMP(3),
ADD COLUMN     "walletAddress" TEXT,
ADD COLUMN     "walletTxHash" TEXT;

