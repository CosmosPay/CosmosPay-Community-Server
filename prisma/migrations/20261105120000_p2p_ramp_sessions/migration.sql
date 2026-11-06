-- Purchases and sales opened on the P2P marketplace's widget (native plugin
-- `eldorado`): the order each one filled in and its URL, so a consumer can list
-- and read them.
--
-- A new table; nothing existing is rewritten.
-- CreateTable
CREATE TABLE "p2p_ramp_session" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "estimatedAmountOut" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "widgetUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "p2p_ramp_session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "p2p_ramp_session_reference_key" ON "p2p_ramp_session"("reference");

-- CreateIndex
CREATE INDEX "p2p_ramp_session_consumerId_network_side_createdAt_idx" ON "p2p_ramp_session"("consumerId", "network", "side", "createdAt");

-- AddForeignKey
ALTER TABLE "p2p_ramp_session" ADD CONSTRAINT "p2p_ramp_session_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
