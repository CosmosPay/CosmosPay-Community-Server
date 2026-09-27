-- Pollar is gone: the OAuth bridge (`/v1/pollar/oauth/*`) and the wallet provisioning
-- (`/v1/pollar/wallets/*`, `/v1/pollar/users`) were removed with it. Nothing reads these
-- tables any more. Irreversible: the handshake and provisioning history goes with them.

-- DropTable
DROP TABLE IF EXISTS "pollar_oauth_session";
DROP TABLE IF EXISTS "pollar_user_wallet";

-- DropEnum
DROP TYPE IF EXISTS "PollarOauthStatus";
DROP TYPE IF EXISTS "PollarWalletStatus";
