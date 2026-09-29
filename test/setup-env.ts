import 'reflect-metadata';

// Runs before any module (and thus before ConfigModule's env validation) loads.
process.env.APISIX_GATEWAY_SECRET = 'topsecret-topsecret-topsecret-topsecret';
// The shared public key's consumer, so the suites can identify it by name as
// well as by the forwarded role — PublicKeyGuard must match on either alone.
process.env.APISIX_PUBLIC_CONSUMER = 'cosmos_public';
process.env.DATABASE_URL = 'postgresql://x:x@localhost:5432/x';
process.env.NODE_ENV = 'test';
process.env.STELLAR_SWAP_FEE_WALLET =
  'GARMB7W3FCR3GKIM3FLWVJASC2PUZ4VHUJZTNJVWWKNTCJNKO6TBCT76';
// Keep the on-chain observer off during tests (no Horizon polling).
process.env.OBSERVER_ENABLED = 'false';
// Same for the webhook delivery sweeper (no background redelivery attempts).
process.env.WEBHOOK_SWEEP_ENABLED = 'false';
// Keep request-log prune off during tests (no background deleteMany).
process.env.REQUEST_LOG_RETENTION_DAYS = '0';
// ConfigModule still runs dotenv against the repo's .env, and dotenv does not
// overwrite values already in process.env — so a developer whose .env carries a
// real BLINDPAY_API_KEY would otherwise trip env validation ("BLINDPAY_
// INSTANCE_ID/WEBHOOK_SECRET required when BLINDPAY_API_KEY is set") and fail
// every suite locally while CI, which has no .env, stayed green. Pin all three
// so the suite is hermetic.
process.env.BLINDPAY_API_KEY = 'test-blindpay-key';
process.env.BLINDPAY_INSTANCE_ID = 'in_test';
// Real length: env validation refuses a Svix secret whose key decodes to fewer
// than SVIX_MIN_SECRET_BYTES, which the old `whsec_test` (3 bytes) did.
process.env.BLINDPAY_WEBHOOK_SECRET = `whsec_${Buffer.from(
  'e2e-blindpay-webhook-key',
).toString('base64')}`;
// The wallet return URL the callback suite redirects to. Pinned for the same
// reason as the BlindPay trio: a developer's .env may list others.
process.env.WALLET_AUTH_RETURN_URLS = 'cosmoswallet://auth/done';
// No Authentik: a developer's .env usually points at a local one, which would
// change what GET /v1/wallet/auth/providers reports here and nowhere in CI.
// Empty rather than deleted, because dotenv does not overwrite a set variable;
// all three, because identity-env refuses the trio half-configured.
process.env.WALLET_AUTH_OIDC_ISSUER = '';
process.env.WALLET_AUTH_OIDC_CLIENT_ID = '';
process.env.WALLET_AUTH_OIDC_CLIENT_SECRET = '';
// The key that seals a sign-in session token. Without it every route that seals or
// opens one answers 503 `misconfigured`, so a suite asserting how a bad token is
// refused would only ever see the missing configuration.
process.env.WALLET_AUTH_SESSION_SECRET =
  'e2e-wallet-session-secret-e2e-wallet-session-secret';
// Serve the example plugin preinstalled in plugins/, so the plugins suite goes
// through the real loader, signature check and registry. Pinned for the same
// reason as the rest: a developer's .env may enable others, or none.
process.env.PLUGINS_ENABLED = 'example';
process.env.PLUGINS_TRUSTED_KEYS = '';
process.env.PLUGINS_ALLOW_UNSIGNED = 'false';
