-- Customer statistics filter payment intents by owner and payer account.
CREATE INDEX "payment_intent_consumerId_source_idx" ON "payment_intent"("consumerId", "source");
