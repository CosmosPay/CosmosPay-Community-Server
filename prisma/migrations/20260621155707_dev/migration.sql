-- AlterTable
ALTER TABLE "payment_intent" ADD COLUMN     "callback" TEXT,
ADD COLUMN     "memoType" TEXT,
ADD COLUMN     "msg" TEXT;
