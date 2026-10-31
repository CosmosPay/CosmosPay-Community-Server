-- An Authentik emailed sign-in skips the server's own code only when the claim
-- presents a value the callback sent to the browser that opened the link. Only its
-- hash is kept. Nullable: null keeps the code, as before.
ALTER TABLE "wallet_auth_handshake" ADD COLUMN "bindingHash" TEXT;
