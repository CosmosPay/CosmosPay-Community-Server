-- The merchant fee an operation charged (src/common/merchant-fee/): nullable, so every
-- existing row reads as "no merchant fee".
ALTER TABLE "payment_intent" ADD COLUMN "merchantFee" JSONB;
ALTER TABLE "swap" ADD COLUMN "merchantFee" JSONB;
ALTER TABLE "chain_swap" ADD COLUMN "merchantFee" JSONB;
ALTER TABLE "cross_chain_swap" ADD COLUMN "merchantFee" JSONB;
ALTER TABLE "liquidity_pool_operation" ADD COLUMN "merchantFee" JSONB;
ALTER TABLE "zk_payment" ADD COLUMN "merchantFee" JSONB;
ALTER TABLE "usdt0_transfer" ADD COLUMN "merchantFee" JSONB;
