-- When the hosted checkout last read an open payment link, so the merchant sees a payer on the
-- payment page. Nullable: null until a page opened it.
ALTER TABLE "payment_intent" ADD COLUMN "checkoutSeenAt" TIMESTAMP(3);
