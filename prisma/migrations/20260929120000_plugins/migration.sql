-- Plugins: a consumer's installation of (and consent to) a plugin, and the
-- plugin's own records under that installation. No core table changes: a plugin
-- owns no column outside these two tables.
CREATE TABLE "plugin_installation" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "pluginSlug" TEXT NOT NULL,
    "pluginVersion" TEXT NOT NULL,
    "grantedCapabilities" TEXT[],
    "config" JSONB NOT NULL DEFAULT '{}',
    "sealedSecrets" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plugin_installation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "plugin_record" (
    "id" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "collection" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plugin_record_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plugin_installation_consumerId_pluginSlug_key" ON "plugin_installation"("consumerId", "pluginSlug");
CREATE INDEX "plugin_installation_pluginSlug_idx" ON "plugin_installation"("pluginSlug");
CREATE UNIQUE INDEX "plugin_record_installationId_collection_key_key" ON "plugin_record"("installationId", "collection", "key");

ALTER TABLE "plugin_installation" ADD CONSTRAINT "plugin_installation_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plugin_record" ADD CONSTRAINT "plugin_record_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "plugin_installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
