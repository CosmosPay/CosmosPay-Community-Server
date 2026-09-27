ALTER TABLE "blindpay_quote" ADD COLUMN "executionKey" TEXT;
UPDATE "blindpay_quote"
SET "executionKey" = md5(random()::text || clock_timestamp()::text)::uuid::text
WHERE "executionKey" IS NULL;
ALTER TABLE "blindpay_quote" ALTER COLUMN "executionKey" SET NOT NULL;
CREATE UNIQUE INDEX "blindpay_quote_executionKey_key" ON "blindpay_quote"("executionKey");
