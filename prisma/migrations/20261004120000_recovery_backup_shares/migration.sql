-- CreateTable
CREATE TABLE "recovery_backup_share" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "share" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recovery_backup_share_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recovery_backup_share_role_email_idx" ON "recovery_backup_share"("role", "email");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_backup_share_role_address_key" ON "recovery_backup_share"("role", "address");
