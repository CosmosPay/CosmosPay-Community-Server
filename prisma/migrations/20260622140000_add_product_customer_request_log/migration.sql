-- CreateTable
CREATE TABLE "product" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "amount" TEXT,
    "asset" TEXT NOT NULL DEFAULT 'native',
    "kind" TEXT NOT NULL DEFAULT 'one_time',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "account" TEXT,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_log" (
    "id" TEXT NOT NULL,
    "consumer" TEXT,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_consumerId_idx" ON "product"("consumerId");

-- CreateIndex
CREATE INDEX "customer_consumerId_idx" ON "customer"("consumerId");

-- CreateIndex
CREATE INDEX "request_log_consumer_idx" ON "request_log"("consumer");

-- CreateIndex
CREATE INDEX "request_log_createdAt_idx" ON "request_log"("createdAt");

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
