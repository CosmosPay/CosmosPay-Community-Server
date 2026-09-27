-- A native wallet asks the provider callback to redirect to its own URL, which
-- is what closes its auth session. Nullable: null renders the page as before.
ALTER TABLE "wallet_auth_handshake" ADD COLUMN "returnTo" TEXT;
