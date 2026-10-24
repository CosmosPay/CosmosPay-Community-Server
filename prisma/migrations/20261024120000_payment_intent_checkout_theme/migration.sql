-- The design a payment intent's hosted checkout page is shown in. Nullable:
-- null reads as 'classic', so every existing intent keeps the page it had and
-- nothing is rewritten. TEXT, not an enum, so a new design needs no migration;
-- the API validates the value on the way in (`CHECKOUT_THEMES`).
ALTER TABLE "payment_intent" ADD COLUMN "checkoutTheme" TEXT;
