-- What the payer did with a wallet from the hosted checkout (opened, came back, sent), as the page
-- reports it. Nullable: null until the page reports it.
ALTER TABLE "payment_intent" ADD COLUMN "checkoutWalletAt" TIMESTAMP(3);
ALTER TABLE "payment_intent" ADD COLUMN "checkoutWalletClosedAt" TIMESTAMP(3);
ALTER TABLE "payment_intent" ADD COLUMN "checkoutSentAt" TIMESTAMP(3);
