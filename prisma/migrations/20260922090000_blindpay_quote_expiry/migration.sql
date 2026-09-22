ALTER TABLE "blindpay_quote" ADD COLUMN "expiresAt" TIMESTAMP(3);
CREATE INDEX "blindpay_quote_expiresAt_idx" ON "blindpay_quote"("expiresAt");
