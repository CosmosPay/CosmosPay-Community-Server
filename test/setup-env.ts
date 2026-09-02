import 'reflect-metadata';

// Runs before any module (and thus before ConfigModule's env validation) loads.
process.env.APISIX_GATEWAY_SECRET = 'topsecret-topsecret-topsecret-topsecret';
process.env.DATABASE_URL = 'postgresql://x:x@localhost:5432/x';
process.env.NODE_ENV = 'test';
process.env.STELLAR_SWAP_FEE_WALLET =
  'GARMB7W3FCR3GKIM3FLWVJASC2PUZ4VHUJZTNJVWWKNTCJNKO6TBCT76';
// Keep the on-chain observer off during tests (no Horizon polling).
process.env.OBSERVER_ENABLED = 'false';
// Same for the webhook delivery sweeper (no background redelivery attempts).
process.env.WEBHOOK_SWEEP_ENABLED = 'false';
// Platform-admin credentials for issue #34 auth suites.
process.env.ADMIN_API_CREDENTIALS = JSON.stringify([
  { id: 'viewer', secret: 'read-secret-000000', role: 'read' },
  { id: 'owner', secret: 'write-secret-00000', role: 'write' },
]);
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
process.env.BLINDPAY_WEBHOOK_SECRET = 'whsec_test';
