# Cosmos Pay — Payments Microservice

**English** · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [हिन्दी](./docs/i18n/README.hi.md) · [简体中文](./docs/i18n/README.zh.md)

Payments microservice built with **NestJS 12** + **Prisma 7 (PostgreSQL)**.

It is a *separate* application from the Cosmos developer platform (`paydev`). The
dev platform is a dashboard: it **issues** API keys for developers and **shows**
their data. It is not in the path of any request a client makes — every call goes
client → APISIX → this service, so the platform can be down without a wallet or an
integration noticing (see
[No request depends on the developer platform](#no-request-depends-on-the-developer-platform)).
This service sits **behind APISIX**, which load-balances and authenticates every
request before forwarding it here. It never sees raw API keys — it only trusts
what the gateway forwards.

## How "only APISIX" is enforced

A request is accepted only when **both** conditions hold (see
`src/common/guards/apisix.guard.ts`):

1. **Gateway shared secret.** The request carries `X-Gateway-Secret`, compared in
   constant time against `APISIX_GATEWAY_SECRET`. APISIX *injects* this header on
   every proxied request and *strips* any client-supplied copy, so a correct
   value can only originate from the gateway. (Defense in depth — pair it with
   network isolation so the service is not directly reachable.)
2. **Authenticated consumer.** APISIX's `key-auth` plugin, after validating the
   caller's API key, forwards `X-Consumer-Username` (and
   `X-Credential-Identifier`). The guard requires the consumer header to be
   present, proving the key was authenticated upstream.

Routes can opt out with `@Public()` (used by the health probes the orchestrator
hits directly). Enforcement is always on — there is no opt-out flag. For local
development, run behind APISIX or send `X-Gateway-Secret` + the `X-Consumer-*`
headers yourself.

`/v1/admin` is cross-tenant, so `AdminGuard` also requires `X-Cosmos-Internal`
to carry a fresh MAC keyed by the gateway secret (`src/admin/console-marker.ts`).
API-key callers never hold that secret, so only a backend calling the service
directly can mint one — the developer platform, which decides whether the
signed-in account is an owner or admin. There is no separate admin credential.
APISIX also removes the header from everything it proxies, but that is defence in
depth: a route that forgets to strip it forwards a value no client could forge.

The pipeline:

```
request → ApisixContextMiddleware  (reads consumer headers → req.gatewayConsumer)
        → ApisixGuard (APP_GUARD)  (verifies secret + consumer, or @Public bypass)
        → ValidationPipe           (DTO validation)
        → Controller / Service     (@CurrentConsumer() gives the consumer)
```

## Project layout

```
src/
  main.ts                         bootstrap: helmet, URI versioning (/v1), swagger
  app.module.ts                   wires config, prisma, guard (global) and middleware
  config/
    configuration.ts              typed config
    env.validation.ts             fail-fast env validation (secret required when enforcing)
    *-whitelist.ts                KYC redirect allow-list
  prisma/                         PrismaModule + PrismaService (global)
  common/
    guards/apisix.guard.ts        THE gateway gate
    guards/public-key.guard.ts    confines the SHARED public key to @AllowPublicKey routes
    middleware/apisix-context...  extracts consumer identity from gateway headers
    decorators/                   @Public(), @CurrentConsumer(), @AllowPublicKey()
    filters/                      consistent error responses
    interceptors/                 structured access logging
    interfaces/                   GatewayConsumer + Express Request augmentation
    validators/                   IsStellarAddress (StrKey-based)
    errors/api-error.ts           ApiError + machine-readable ApiErrorCode
    services/advisory-lock...     cluster-wide lock for the background timers
  stellar/                        per-network Horizon servers (bounded timeout), account loader,
                                  SEP-7 links, signed-envelope relay, settlement repository,
                                  mainnet Soroban RPC client (passphrase-checked)
  payment-intents/                payment intents on Stellar, Solana and Monad: controller, service, DTOs,
                                  per-chain link builders and verifiers, the observer — emits events
                                  + GET /v1/payment-links/{id}: the payer's view, read with no API key
  chains/                         chain list, per-chain address rules, units, message signatures, JSON-RPC
  solana/                         Solana RPC client (cluster-checked), Solana Pay links
  evm/                            EVM RPC client for Monad (chain-id-checked), EIP-681 links
  swaps/                          Stellar native swaps (path payments): quote, build XDR, submit
                                  + Solana (Jupiter) and Monad (Kuru Flow): venues/, chain swaps, observer
  jupiter/                        Jupiter Swap API client (Solana aggregator)
  kuru/                           Kuru Flow API client (Monad aggregator)
  cross-chain-swaps/              swaps across 35 networks via NEAR Intents (Stellar, Solana, Monad, EVM,
                                  UTXO, ...): network registry, quote, deposit address + wallet link, observer
  near-intents/                   NEAR Intents 1Click client: tokens, quote, status, deposit submit
  usdt0/                          USDT0 from Stellar to EVM networks through LayerZero's OFT: routes, quote,
                                  build + relay the Soroban `send`, status from the ledger and LayerZero Scan
  zk-payments/                    private payments: confidential transfers on Cosmos Pay's token, verified on-chain;
                                  the confidential token SDK is loaded only by confidential-sdk.ts
  liquidity-pools/                AMM deposit/withdraw, pool + position reads, cost basis + commission on gain
  observer/                       background reconciler: swaps + LP ops against Horizon, one adapter per table
  webhooks/                       webhook endpoints CRUD + dispatcher (HMAC-signed, retried)
  products/                       merchant catalogue
  customers/                      payer records derived from intents
  aliases/                        claimable payment handles: signed claims, resolution, email recovery
  assets/                         curated asset registry: the (code, issuer) pairs vouched for, per network
  public-key/                     GET /v1/public-key: the shared public key, keyless
  easy-recovery/                  moving a wallet between two devices: a five-minute mailbox for the wallet sealed
                                  to the new device's key, released once to the code on the old device's screen
  mailer/                         this service's own sender (Resend): sign-in and recovery codes
  gateway-keys/                   mints wallet accounts' keys in APISIX (admin client, consumer forwarder)
  analytics/                      summary, balances, API logs, webhook logs
  activity/                       client telemetry ingest + feed (wallet, dashboard)
  admin/                          cross-tenant platform admin (console-only), audited
  audit/                          audit-trail writer, called inside other modules' transactions
  plugins/                        plugin runtime + SDK (sdk.ts): folder loader, signatures, V8-isolate sandbox
  native-plugins/                 first-party plugins, imported only when PLUGINS_ENABLED names them:
    blindpay/                     BlindPay: client, Svix verify, sync + webhook, kyc/, onramp/, offramp/, admin/
    defindex/                     DeFindex vaults (Stellar)
  health/                         liveness/readiness probes (@Public)
prisma/schema.prisma              Consumer, PaymentIntent, Swap, ChainSwap, CrossChainSwap, LiquidityPoolOperation,
                                  WebhookEndpoint/Delivery/EmittedEvent, BlindpayReceiver,
                                  Blockchain/BankAccount/VirtualAccount, BlindpayQuote,
                                  BlindpayWebhookEvent, Payin, Payout, RequestLog,
                                  ActivityEvent,
                                  AdminAuditLog, Alias, AliasAddress,
                                  AliasChallenge, AliasRecovery, ZkPayment, Usdt0Transfer,
                                  EasyRecoverySession
                                  PluginInstallation, PluginRecord
test/                             e2e suites: gateway gate, admin + alias console gates,
                                  payment intents, swaps, liquidity pools, KYC, webhooks
plugins/                          THE plugins folder: one <slug>/ per plugin (plugin.json, index.ts, signature.json)
scripts/                          OpenAPI generator, README check, operator scripts,
                                  zk/: deploy and check the private payments token on testnet
contracts/                        PaymentForwarder.sol — Monad deposit addresses (npm run contracts:compile)
deploy/authentik/                 Authentik blueprint: the wallet sign-in and sign-up
docs/i18n/                        this README in es, pt, de, fr, hi, zh
```

## API

All routes are versioned under `/v1` (URI versioning).

Every route is listed in the [route index](#route-index) below, with its scope.
**Request and response schemas live in the generated OpenAPI contract**, which is
regenerated from the controllers and DTOs on every CI run
(`npm run openapi:check` fails the build if it drifts):

- `openapi/openapi.json` / `openapi/openapi.yaml` — committed, reviewable in a diff
- `/docs` — Swagger UI, when `SWAGGER_ENABLED=true`
- `/docs/json`, `/docs/yaml` — the same spec served live

| Area              | Base path                | What it does                                             |
| ----------------- | ------------------------ | -------------------------------------------------------- |
| Payment intents   | `/v1/payment-intents`    | `pay` intents on Stellar (SEP-7), Solana (Solana Pay) and Monad (EIP-681), SEP-7 `tx`, validation, on-chain observer |
| Payment links     | `/v1/payment-links`      | One payment intent as its payer sees it, for hosted checkout pages — no API key (`@Public`) |
| Swaps             | `/v1/swaps`              | Path-payment quote, build unsigned XDR, submit signed · Solana via Jupiter, Monad via Kuru Flow |
| Cross-chain swaps | `/v1/cross-chain-swaps` | Across 35 networks through NEAR Intents (Stellar, Solana, Monad, EVM chains, Bitcoin and the UTXO coins, ...): quote, deposit address, status |
| USDT0             | `/v1/usdt0`              | USDT0 from Stellar to 21 EVM networks through LayerZero (native USDT on Ethereum), mainnet only: quote, build, submit, status |
| Private payments  | `/v1/zk-payments`        | Confidential payments on Cosmos Pay's confidential token (amount hidden on-chain, 0.18% commission), testnet only for now |
| Private checkout  | `/v1/zk-checkout`        | The payer's half of a private payment: read it, confirm it, the network setup (`@Public`) |
| Liquidity pools   | `/v1/liquidity-pools`    | AMM deposit / withdraw, positions, commission on gain     |
| Webhooks          | `/v1/webhooks`           | Endpoint CRUD, secret rotation, deliveries, redelivery    |
| KYC               | `/v1/kyc`                | Receivers (KYC/KYB), wallets, bank accounts, doc upload   |
| Onramp            | `/v1/onramp`             | Payin quotes, payins, virtual accounts                    |
| Offramp           | `/v1/offramp`            | Payout quotes, authorize, payouts (client-signed)         |
| Products          | `/v1/products`           | Merchant catalogue                                        |
| Customers         | `/v1/customers`          | Payer records derived from intents                        |
| Aliases           | `/v1/aliases`            | Claimable payment handles: claim, resolve, recover        |
| Wallet sign-in    | `/v1/wallet`             | Google / GitHub / email code, and the encrypted seed backup |
| Easy recovery     | `/v1/wallet/easy-recovery` | Move a wallet between two devices through a five-minute mailbox this service cannot open |
| Assets            | `/v1/assets`             | Curated asset registry per network                        |
| Public key        | `/v1/public-key`         | The shared public API key, served without a key (`@Public`) |
| Analytics         | `/v1/summary`, `/v1/balances`, `/v1/logs` | Dashboard aggregates (payments, swaps, liquidity, webhooks) and logs |
| Activity          | `/v1/activity`           | Client-reported events: ingest, feed, rollup               |
| Plugins           | `/v1/plugins`            | Compiled-in extensions under a slug, installed per tenant |
| Admin             | `/v1/admin`              | Cross-tenant reads/writes — platform console only, audited |
| Health            | `/v1/health`             | Liveness / readiness (`@Public`)                          |

### Route index

Every route this service serves. **Scope** is what the API key must hold — *one
of* means any of the listed scopes is enough, and `—` means any authenticated key.
**Public key** marks the routes the shared public key may call (see
[The shared public API key](#the-shared-public-api-key)). A route marked
*platform console* takes no API key at all; only the console backend reaches it.
Paths use the OpenAPI `{param}` form.

| Method | Path | Scope | Public key |
| ------ | ---- | ----- | ---------- |
| GET | `/v1/activity/events` | `activity:read` |  |
| POST | `/v1/activity/events` | `activity:write` | ✓ |
| GET | `/v1/activity/summary` | `activity:read` |  |
| GET | `/v1/admin/audit-logs` | platform console |  |
| GET | `/v1/admin/chain-swaps` | platform console |  |
| GET | `/v1/admin/consumers` | platform console |  |
| GET | `/v1/admin/cross-chain-swaps` | platform console |  |
| GET | `/v1/admin/customers` | platform console |  |
| GET | `/v1/admin/payins` | platform console |  |
| GET | `/v1/admin/payment-intents` | platform console |  |
| GET | `/v1/admin/payouts` | platform console |  |
| GET | `/v1/admin/products` | platform console |  |
| GET | `/v1/admin/receivers` | platform console |  |
| PATCH | `/v1/admin/receivers/{id}/access` | platform console |  |
| POST | `/v1/admin/receivers/{id}/approve` | platform console |  |
| POST | `/v1/admin/receivers/{id}/enable` | platform console |  |
| POST | `/v1/admin/receivers/{id}/tos` | platform console |  |
| GET | `/v1/admin/summary` | platform console |  |
| GET | `/v1/admin/swaps` | platform console |  |
| GET | `/v1/aliases` | `payments:read` |  |
| POST | `/v1/aliases` | `payments:write` |  |
| GET | `/v1/aliases/availability/{name}` | `payments:read` | ✓ |
| GET | `/v1/aliases/by-address/{address}` | `payments:read` | ✓ |
| POST | `/v1/aliases/challenges` | `payments:write` |  |
| GET | `/v1/aliases/resolve/{name}` | `payments:read` | ✓ |
| DELETE | `/v1/aliases/{name}` | `payments:write` |  |
| POST | `/v1/aliases/{name}/addresses` | `payments:write` |  |
| DELETE | `/v1/aliases/{name}/addresses/{addressId}` | `payments:write` |  |
| POST | `/v1/aliases/{name}/recovery` | `payments:write` | ✓ |
| POST | `/v1/aliases/{name}/recovery/complete` | `payments:write` |  |
| GET | `/v1/assets` | — | ✓ |
| GET | `/v1/balances` | `payments:read` |  |
| POST | `/v1/blindpay/webhooks` | none — `@Public()`, Svix signature |  |
| GET | `/v1/cross-chain-swaps` | `swaps:read` |  |
| POST | `/v1/cross-chain-swaps` | `swaps:write` | ✓ |
| GET | `/v1/cross-chain-swaps/assets` | `swaps:read` | ✓ |
| POST | `/v1/cross-chain-swaps/quote` | `swaps:read` | ✓ |
| GET | `/v1/cross-chain-swaps/{id}` | `swaps:read` | ✓ |
| POST | `/v1/cross-chain-swaps/{id}/deposit` | `swaps:write` | ✓ |
| GET | `/v1/customers` | `customers:read` |  |
| POST | `/v1/customers` | `customers:write` |  |
| GET | `/v1/customers/{id}` | `customers:read` |  |
| PATCH | `/v1/customers/{id}` | `customers:write` |  |
| DELETE | `/v1/customers/{id}` | `customers:write` |  |
| POST | `/v1/customers/{id}/wallets` | `customers:write` |  |
| DELETE | `/v1/customers/{id}/wallets/{walletId}` | `customers:write` |  |
| GET | `/v1/health/liveness` | none — `@Public()` |  |
| GET | `/v1/health/readiness` | none — `@Public()` |  |
| GET | `/v1/kyc/bank-details` | `kyc:read` |  |
| GET | `/v1/kyc/rails` | `kyc:read` |  |
| GET | `/v1/kyc/receivers` | `kyc:read` |  |
| POST | `/v1/kyc/receivers` | `kyc:write` |  |
| GET | `/v1/kyc/receivers/{id}` | `kyc:read` |  |
| PATCH | `/v1/kyc/receivers/{id}` | `kyc:write` |  |
| DELETE | `/v1/kyc/receivers/{id}` | `kyc:write` |  |
| PATCH | `/v1/kyc/receivers/{id}/access` | `kyc:write` |  |
| POST | `/v1/kyc/receivers/{id}/approve` | `kyc:write` |  |
| POST | `/v1/kyc/receivers/{id}/enable` | `kyc:write` |  |
| POST | `/v1/kyc/receivers/{id}/tos` | `kyc:write` |  |
| GET | `/v1/kyc/receivers/{receiverId}/bank-accounts` | `kyc:read` |  |
| POST | `/v1/kyc/receivers/{receiverId}/bank-accounts` | `kyc:write` |  |
| DELETE | `/v1/kyc/receivers/{receiverId}/bank-accounts/{id}` | `kyc:write` |  |
| GET | `/v1/kyc/receivers/{receiverId}/wallets` | `kyc:read` |  |
| POST | `/v1/kyc/receivers/{receiverId}/wallets` | `kyc:write` |  |
| GET | `/v1/kyc/receivers/{receiverId}/wallets/sign-message` | `kyc:read` |  |
| DELETE | `/v1/kyc/receivers/{receiverId}/wallets/{id}` | `kyc:write` |  |
| POST | `/v1/kyc/terms-of-service` | `kyc:write` |  |
| POST | `/v1/kyc/upload` | `kyc:write` |  |
| GET | `/v1/liquidity-pools` | one of `liquidity:read`, `swaps:read` | ✓ |
| POST | `/v1/liquidity-pools/deposit` | one of `liquidity:write`, `swaps:write` | ✓ |
| GET | `/v1/liquidity-pools/operations` | one of `liquidity:read`, `swaps:read` |  |
| GET | `/v1/liquidity-pools/operations/{id}` | one of `liquidity:read`, `swaps:read` |  |
| POST | `/v1/liquidity-pools/operations/{id}/submit` | one of `liquidity:write`, `swaps:write` | ✓ |
| GET | `/v1/liquidity-pools/positions` | one of `liquidity:read`, `swaps:read` | ✓ |
| POST | `/v1/liquidity-pools/withdraw` | one of `liquidity:write`, `swaps:write` | ✓ |
| GET | `/v1/liquidity-pools/{poolId}` | one of `liquidity:read`, `swaps:read` | ✓ |
| GET | `/v1/defindex/vaults` | one of `liquidity:read`, `swaps:read` | ✓ |
| GET | `/v1/defindex/vaults/{vault}` | one of `liquidity:read`, `swaps:read` | ✓ |
| GET | `/v1/defindex/vaults/{vault}/balance` | one of `liquidity:read`, `swaps:read` | ✓ |
| POST | `/v1/defindex/vaults/{vault}/deposit` | one of `liquidity:write`, `swaps:write` | ✓ |
| POST | `/v1/defindex/vaults/{vault}/withdraw` | one of `liquidity:write`, `swaps:write` | ✓ |
| POST | `/v1/defindex/submit` | one of `liquidity:write`, `swaps:write` | ✓ |
| GET | `/v1/logs` | `payments:read` |  |
| GET | `/v1/logs/webhooks` | `webhooks:read` |  |
| GET | `/v1/offramp/payouts` | `offramp:read` |  |
| POST | `/v1/offramp/payouts` | `offramp:write` |  |
| POST | `/v1/offramp/payouts/authorize` | `offramp:write` |  |
| GET | `/v1/offramp/payouts/{id}` | `offramp:read` |  |
| POST | `/v1/offramp/payouts/{id}/documents` | `offramp:write` |  |
| POST | `/v1/offramp/quotes` | `offramp:write` |  |
| GET | `/v1/onramp/payins` | `onramp:read` |  |
| POST | `/v1/onramp/payins` | `onramp:write` |  |
| GET | `/v1/onramp/payins/{id}` | `onramp:read` |  |
| POST | `/v1/onramp/quotes` | `onramp:write` |  |
| GET | `/v1/onramp/receivers/{receiverId}/virtual-accounts` | `onramp:read` |  |
| POST | `/v1/onramp/receivers/{receiverId}/virtual-accounts` | `onramp:write` |  |
| POST | `/v1/onramp/trustline` | `onramp:write` |  |
| GET | `/v1/payment-intents` | `payments:read` |  |
| POST | `/v1/payment-intents/pay` | `payments:write` | ✓ |
| POST | `/v1/payment-intents/tx` | `payments:write` | ✓ |
| GET | `/v1/payment-intents/{id}` | `payments:read` |  |
| PATCH | `/v1/payment-intents/{id}` | `payments:write` |  |
| DELETE | `/v1/payment-intents/{id}` | `payments:write` |  |
| GET | `/v1/payment-intents/{id}/transitions` | `payments:read` |  |
| POST | `/v1/payment-intents/{id}/validate` | `payments:write` |  |
| GET | `/v1/payment-links/{id}` | none — `@Public()`, budgeted per client address |  |
| POST | `/v1/payment-links/{id}/transaction` | none: `@Public()`, budgeted per client address |  |
| POST | `/v1/payment-links/{id}/events` | none: `@Public()`, budgeted per client address |  |
| GET | `/v1/payment-links/{id}/solana-pay` | none: `@Public()`, budgeted per client address |  |
| POST | `/v1/payment-links/{id}/solana-pay` | none: `@Public()`, budgeted per client address |  |
| GET | `/v1/plugins` | `plugins:read` |  |
| GET | `/v1/plugins/{slug}` | `plugins:read` |  |
| PUT | `/v1/plugins/{slug}/installation` | `plugins:write` |  |
| DELETE | `/v1/plugins/{slug}/installation` | `plugins:write` |  |
| POST | `/v1/plugins/{slug}/queries/{action}` | `plugins:read` |  |
| POST | `/v1/plugins/{slug}/commands/{action}` | `plugins:write` |  |
| GET | `/v1/products` | `products:read` |  |
| POST | `/v1/products` | `products:write` |  |
| GET | `/v1/products/{id}` | `products:read` |  |
| PATCH | `/v1/products/{id}` | `products:write` |  |
| DELETE | `/v1/products/{id}` | `products:write` |  |
| GET | `/v1/public-key` | none — `@Public()` |  |
| GET | `/.well-known/stellar.toml` | none — `@Public()`, SEP-1 discovery (recovery servers only) |  |
| GET | `/v1/sep10/auth` | none — `@Public()`; SEP-10/SEP-30, recovery servers only |  |
| POST | `/v1/sep10/auth` | none — `@Public()`; SEP-10/SEP-30, recovery servers only |  |
| POST | `/v1/sep30/identity` | none — `@Public()`; SEP-10/SEP-30, recovery servers only |  |
| POST | `/v1/sep30/identity/email/start` | none — `@Public()`; SEP-10/SEP-30, recovery servers only |  |
| POST | `/v1/sep30/identity/email/verify` | none — `@Public()`; SEP-10/SEP-30, recovery servers only |  |
| GET | `/v1/sep30/accounts` | none — `@Public()`; SEP-10/SEP-30, recovery servers only |  |
| POST | `/v1/sep30/accounts/{address}` | none — `@Public()`; SEP-10/SEP-30, recovery servers only |  |
| PUT | `/v1/sep30/accounts/{address}` | none — `@Public()`; SEP-10/SEP-30, recovery servers only |  |
| GET | `/v1/sep30/accounts/{address}` | none — `@Public()`; SEP-10/SEP-30, recovery servers only |  |
| DELETE | `/v1/sep30/accounts/{address}` | none — `@Public()`; SEP-10/SEP-30, recovery servers only |  |
| POST | `/v1/sep30/accounts/{address}/sign/{signer}` | none — `@Public()`; SEP-10/SEP-30, recovery servers only |  |
| GET | `/v1/sep30/shares` | none — `@Public()`; SEP-10/SEP-30, recovery servers only |  |
| PUT | `/v1/sep30/shares/{address}` | none — `@Public()`; SEP-10/SEP-30, recovery servers only |  |
| GET | `/v1/sep30/shares/{address}` | none — `@Public()`; SEP-10/SEP-30, recovery servers only |  |
| DELETE | `/v1/sep30/shares/{address}` | none — `@Public()`; SEP-10/SEP-30, recovery servers only |  |
| GET | `/v1/summary` | `payments:read` |  |
| GET | `/v1/summary/series` | `payments:read` |  |
| GET | `/v1/swaps` | `swaps:read` |  |
| POST | `/v1/swaps` | `swaps:write` | ✓ |
| POST | `/v1/swaps/quote` | `swaps:read` | ✓ |
| GET | `/v1/swaps/{id}` | `swaps:read` | ✓ |
| POST | `/v1/swaps/{id}/submit` | `swaps:write` | ✓ |
| GET | `/v1/usdt0/routes` | `swaps:read` | ✓ |
| POST | `/v1/usdt0/quote` | `swaps:read` | ✓ |
| GET | `/v1/usdt0/transfers` | `swaps:read` |  |
| POST | `/v1/usdt0/transfers` | `swaps:write` | ✓ |
| GET | `/v1/usdt0/transfers/{id}` | `swaps:read` | ✓ |
| POST | `/v1/usdt0/transfers/{id}/submit` | `swaps:write` | ✓ |
| GET | `/v1/wallet/auth/providers` | `payments:read` | ✓ |
| POST | `/v1/wallet/auth/oauth/authorize` | `payments:write` | ✓ |
| GET | `/v1/wallet/auth/oauth/callback/{provider}` | none — `@Public()`, a browser redirect |  |
| GET | `/v1/wallet/auth/oauth/session/{state}` | `payments:read` | ✓ |
| POST | `/v1/wallet/auth/oauth/claim` | `payments:write` | ✓ |
| POST | `/v1/wallet/auth/email/start` | `payments:write` | ✓ |
| POST | `/v1/wallet/auth/email/verify` | `payments:write` | ✓ |
| POST | `/v1/wallet/auth/finish` | `payments:write` | ✓ |
| PUT | `/v1/wallet/backup` | `payments:write` | ✓ |
| POST | `/v1/wallet/easy-recovery/sessions` | `payments:write` | ✓ |
| GET | `/v1/wallet/easy-recovery/sessions/{id}` | `payments:read` | ✓ |
| POST | `/v1/wallet/easy-recovery/sessions/{id}/claim` | `payments:write` | ✓ |
| POST | `/v1/wallet/easy-recovery/sessions/{id}/offer` | `payments:write` | ✓ |
| POST | `/v1/wallet/recovery/setup` | `payments:write` | ✓ |
| GET | `/v1/webhooks` | `webhooks:read` |  |
| POST | `/v1/webhooks` | `webhooks:write` |  |
| GET | `/v1/webhooks/{id}` | `webhooks:read` |  |
| PATCH | `/v1/webhooks/{id}` | `webhooks:write` |  |
| DELETE | `/v1/webhooks/{id}` | `webhooks:write` |  |
| GET | `/v1/webhooks/{id}/deliveries` | `webhooks:read` |  |
| POST | `/v1/webhooks/{id}/deliveries/{deliveryId}/redeliver` | `webhooks:write` |  |
| POST | `/v1/webhooks/{id}/ping` | `webhooks:write` |  |
| POST | `/v1/webhooks/{id}/rotate-secret` | `webhooks:write` |  |
| GET | `/v1/zk-checkout/config` | none, `@Public()`, budgeted per client address |  |
| GET | `/v1/zk-checkout/{id}` | none, `@Public()`, budgeted per client address |  |
| POST | `/v1/zk-checkout/{id}/confirm` | none, `@Public()`, budgeted per client address |  |
| GET | `/v1/zk-payments` | `payments:read` |  |
| POST | `/v1/zk-payments` | `payments:write` |  |
| GET | `/v1/zk-payments/config` | `payments:read` |  |
| GET | `/v1/zk-payments/{id}` | `payments:read` |  |

### Error responses

Every failure returns the same envelope, and `code` is the stable,
machine-readable part — branch on it rather than on `message`, which is prose and
may be reworded:

```jsonc
{
  "statusCode": 409,
  "code": "idempotency_conflict",
  "error": "Conflict",
  "message": "A swap already exists for this Idempotency-Key",
  "path": "/v1/swaps",
  "timestamp": "2026-09-01T12:00:00.000Z"
}
```

The envelope and the full `code` enum are published in the OpenAPI spec as
`ApiErrorBodyEntity` (source: `ApiErrorCode` in `src/common/errors/api-error.ts`).
Each operation documents only the statuses it can actually return, and each status
carries one example per `code` it can carry — the real message, with the matching
`statusCode` and `error` — so Swagger UI and a Postman import show the body you
would really receive. **Codes are never renamed once published**; new ones may be
added, so treat an unrecognised code as its HTTP status.

A few codes also carry `details`, an object of machine-readable facts about that
failure, between `message` and `path`; the code's example in the spec shows it.
Today only `easy_recovery_code_invalid` does (`"details": { "attemptsLeft": 4 }`).
Every other envelope has no `details` key.

A few that are easy to confuse:

| Code | Status | Means |
| ---- | ------ | ----- |
| `insufficient_scope` | 403 | The API key lacks the scope. Re-provision the key |
| `account_disabled` | 403 | An operator disabled this fiat account. Not a key problem |
| `gateway_required` | 403 | The request did not arrive through APISIX |
| `admin_console_only` | 403 | The route belongs to the platform console (`/v1/admin`). No API key can call it |
| `idempotency_conflict` | 409 | This `Idempotency-Key` (or payment-intent memo) already produced a resource for a *different* request. Repeat the original request, or use a new key |
| `kyc_state_invalid` | 409 | An illegal KYC state transition — not a duplicate request |
| `operation_in_flight` | 409 | A conflicting operation is still settling |
| `payload_expired` | 409 | The delivery body is past retention and cannot be re-sent |
| `provider_unavailable` | 502/503/504 | BlindPay or Horizon is unreachable. Retry |
| `misconfigured` | 503 | A server-side configuration error. Retrying will not help |

### Running more than one replica

APISIX load-balances across instances, so every background timer runs on every
replica. Status changes are already safe — each one is a guarded `updateMany`
compare-and-swap — but duplicate ticks would multiply Horizon calls against a
rate-limited API. So each timer takes a PostgreSQL **transaction-level advisory
lock** (`AdvisoryLockService`) and skips its tick when another replica holds it:

| Timer                          | Lock key                 |
| ------------------------------ | ------------------------ |
| `SettlementObserverService`    | `SettlementObserver`     |
| `PaymentIntentObserverService`       | `PaymentIntentObserver`  |
| `RequestLogRetentionService`   | `RequestLogRetention`    |
| Webhook delivery sweeper       | `WebhookDeliverySweeper` |
| `RateLimitPruneService`        | `RateLimitPrune`         |
| `AliasChallengeSweeperService` | `AliasChallengeSweeper`  |

`pg_try_advisory_xact_lock` never blocks, and it is released when the
transaction ends, even on a crash or a dropped connection. Unlike a session-level
lock, it also works behind PgBouncer in transaction-pooling mode.

Lock ids live in the `AdvisoryLockKey` enum. Do not renumber an existing id —
during a rolling deploy, old and new replicas would take different locks — and do
not reuse a retired one.

**Several instances from one checkout, locally.** `npm run dev:local` starts the api and
a second replica from one `.env`; `npm run dev:local -- recovery` starts the api and the two
recovery servers (A on `:3002`, B on `:3003`, testnet), and `-- all` all four. Only what
differs per instance lives in `dev-instances.json` (git-ignored; the first run creates it
from `dev-instances.example.json` and generates each recovery server's keys once — keep it,
those keys derive signers that are on the ledger): a key there replaces the `.env` one, `""`
removes it, and a nested object is a prefix (`{ "RECOVERY": { "ROLE": "a" } }` is
`RECOVERY_ROLE=a`). One watch build compiles into `dist-local/`, so it never fights
`npm run dev` over `dist/` — but it starts the api too, so run one or the other. The
replicas share `DATABASE_URL` and secrets: nothing is per-process state. List both in
APISIX's upstream (the developer platform's `COSMOS_API_URL`, comma-separated, then
`npm run sync:route` there).

### Payment validation & the on-chain observer

A payment is confirmed against the Stellar network in one place
(`StellarVerifierService`): the transaction must be **successful**, contain a
**native (XLM) payment** to the intent's `destination` for the **exact amount**,
— when the intent has a memo — carry a **matching memo** (`memo_type: id`), and
have closed **no earlier than a minute before the intent was created**
(`TX_CREATED_AT_SKEW_MS`). The age floor is what stops an old on-chain payment
with the same terms from settling a new intent.

Two paths use that single rule:

- **Manual:** `POST /v1/payment-intents/:id/validate` with `{ "txHash": "<64-hex>" }`.
  On a match the intent is set to `SUCCEEDED` (and `txHash` saved) and a
  `PAYMENT_INTENT_SUCCEEDED` webhook fires. A tx that failed on-chain marks the
  intent `FAILED` **only when it was this intent's own payment** — same memo,
  destination and asset. Any other transaction, failed or not, is a mismatch that
  leaves the status unchanged, so the correct tx can still be submitted. A
  `txHash` reported with `PATCH /v1/payment-intents/:id` never settles an intent
  on its own: it must be a 64-character hex hash, is stored lowercase, and is
  unique only among the calling consumer's intents (`409 idempotency_conflict`
  on a clash with another of them).
- **Automatic (permanent observer):** `PaymentIntentObserverService` polls Horizon
  every `OBSERVER_INTERVAL_MS` for `PENDING` intents — by reported `txHash`, or by
  scanning payments to the destination — and finalizes matches the same way, so
  statuses change and events fire **without anyone calling the API**. One tick
  takes at most `OBSERVER_MAX_INTENTS_PER_CONSUMER` (10) intents per consumer and
  never scans an expired one, so one consumer cannot delay everyone else's
  settlement. Disable for local dev with `OBSERVER_ENABLED=false`.

**Expiry checks the chain first.** An intent past its lifetime is verified once
more before it is marked `EXPIRED`: if its payment is on-chain it settles as
`SUCCEEDED` instead, and if Horizon cannot be reached it is left for the next
tick. When that payment's hash already sits on another of the same consumer's
intents, the intent is expired rather than retried forever. A payment verified
after expiry, by the observer or by `validate`, still
moves an `EXPIRED` intent to `SUCCEEDED` and fires `PAYMENT_INTENT_SUCCEEDED`, so
do not treat `EXPIRED` as final. The scan reads the destination's payments back to
the intent's creation, at most 1,000 (5 pages of 200); if a destination receives
more than that during an intent's lifetime, call `validate` with the hash.

### API request logs retention

Every inbound request except `/v1/health` and `/docs` is appended to
`request_log` by `LoggingInterceptor`, and powers the dashboard **API logs**
view (`GET /v1/logs`). Rows include path, status, duration, and — when present —
the payer's `ip` / `userAgent`.

Dashboard traffic (a verified `X-Cosmos-Internal` marker) is **recorded and flagged**
(`request_log.internal`), not skipped, and the API-log view filters on that
column, so no request header can keep traffic out of the log.

Rows are **not kept forever**. `RequestLogRetentionService` deletes rows
older than `REQUEST_LOG_RETENTION_DAYS` (default **30**) on a timer
(`REQUEST_LOG_PRUNE_INTERVAL_MS`, default **1h**). Each cycle deletes in short
`REQUEST_LOG_PRUNE_BATCH_SIZE` chunks (default **1000**) and keeps looping until
the backlog is gone or `REQUEST_LOG_PRUNE_MAX_PER_CYCLE` (default **50000**) is
hit, so a large history can catch up without holding one long table lock. Set
`REQUEST_LOG_RETENTION_DAYS=0` to disable the prune entirely (the service logs
that at boot). The composite index on `(consumer, createdAt)` keeps the
dashboard query fast as volume grows.

### Client activity (what the wallet and the dashboard report)

`request_log` only records requests that reached this service. It cannot see a
wallet that crashed on its send screen, a signature the user cancelled or a
dashboard page that failed before sending anything, so the clients report those
events themselves to `POST /v1/activity/events`.

- **Batched.** Clients queue events and flush them, so an offline wallet sends
  them on the next launch. Up to `ACTIVITY_MAX_BATCH` (100) per request.
- **Safe to retry.** An event may carry the client's own `eventId`;
  `(consumerId, eventId)` is unique and duplicates are skipped. The response
  reports `accepted` and `duplicates`.
- **Attributed by the gateway.** Rows are written under the consumer APISIX
  authenticated; there is no body field for it.
- **Tolerant of bad payloads.** An over-long `message` is truncated and an
  over-sized `props` is replaced with `{"_dropped": "props_too_large"}` instead
  of rejecting the whole batch.
- **Clamped timestamps.** `occurredAt` is replaced with the receipt time when it
  is more than five minutes ahead or more than seven days behind. Both times are
  kept: `at` (the client's) and `receivedAt`.

Reading it back:

| Route                   | Scope             | Returns                                                              |
| ----------------------- | ----------------- | -------------------------------------------------------------------- |
| `GET /v1/activity/events` | `activity:read` | The feed, newest first. Filters: `source`, `level`, `category`, `type` (prefix), `network`, `since`/`until` |
| `GET /v1/activity/summary` | `activity:read` | Counts per level/source/category, top event types, top errors, sessions, devices, a daily series |

`level` on the feed is a **minimum**, not an exact match: `level=warn` returns
warnings *and* errors.

`activity_event` holds an IP, a user agent and whatever the client attached, so
it is pruned by the same job and in the same bounded batches as `request_log` —
`ACTIVITY_RETENTION_DAYS`, default **30**, `0` to keep events forever.

### Webhooks (notifying integrators)

Each integrator (APISIX consumer) registers one or more webhook endpoints. When a
payment intent changes, the platform fires a domain event; the **dispatcher**
fans it out to every enabled endpoint of that consumer subscribed to the event
type (empty subscription = all), records each attempt for traceability, and
retries with linear backoff (`WEBHOOK_*` env).

Event types: `PAYMENT_INTENT_CREATED`, `PAYMENT_INTENT_UPDATED`,
`PAYMENT_INTENT_SUCCEEDED`, `PAYMENT_INTENT_FAILED`, `PAYMENT_INTENT_CANCELLED`,
`PAYMENT_INTENT_DELETED`, `SWAP_CREATED`, `SWAP_SUBMITTED`, `SWAP_SUCCEEDED`,
`SWAP_FAILED`, `LIQUIDITY_CREATED`, `LIQUIDITY_SUBMITTED`, `LIQUIDITY_SUCCEEDED`,
`LIQUIDITY_FAILED`, `CROSS_CHAIN_SWAP_CREATED`, `CROSS_CHAIN_SWAP_UPDATED`, `CROSS_CHAIN_SWAP_SUCCEEDED`, `CROSS_CHAIN_SWAP_REFUNDED`, `CROSS_CHAIN_SWAP_FAILED`, `CROSS_CHAIN_SWAP_EXPIRED`, plus the BlindPay-sourced `RECEIVER_UPDATED`, `PAYIN_CREATED`,
`PAYIN_UPDATED`, `PAYIN_COMPLETED`, `PAYOUT_CREATED`, `PAYOUT_UPDATED` and
`PAYOUT_COMPLETED`, and `ZK_PAYMENT_SUCCEEDED`. The authoritative list is the `WebhookEventType` enum in
`prisma/schema.prisma`.

**BlindPay-sourced bodies.** `RECEIVER_UPDATED` / `PAYIN_*` / `PAYOUT_*` carry
identity and state only — ids, status, amounts, rails — never personal data. The
provider object is not forwarded, because a receiver payload is a full KYC
dossier and subscribing only needs `webhooks:write`. Fetch the details from the
API with a key that holds `kyc:read` / `onramp:read` / `offramp:read`. The field
allowlist is in `src/native-plugins/blindpay/blindpay-event-redaction.ts`.

Delivery is decoupled via NestJS `EventEmitter2` (`webhook.event`), so emitting a
notification never blocks the API request that triggered it.

**Outbound destination policy (SSRF):** endpoints must use `https` and resolve
only to public addresses. Registration rejects loopback, RFC1918 private ranges,
link-local (`169.254.0.0/16`, including cloud metadata `169.254.169.254`), and
known metadata hostnames. **Every host-dependent refusal gives the same answer**
— "the host is not an allowed destination" — and the reason goes to the log
instead: telling "does not resolve here" from "resolves to `10.0.4.7`" from
"resolves to the metadata service" would let anyone who can register an endpoint
map the network this service runs in, one URL at a time. A malformed URL, a
wrong scheme, credentials or a missing host still say exactly what is wrong:
those describe the string that was sent, not the network. The same check runs again immediately before each
delivery (DNS can change after register). The HTTP client uses `redirect: manual`
(never follows `3xx`), connect/read timeouts from env, and a max response body
size.

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `WEBHOOK_CONNECT_TIMEOUT_MS` | `3000` | Connect budget (part of AbortSignal timeout) |
| `WEBHOOK_READ_TIMEOUT_MS` | `5000` | Read budget (part of AbortSignal timeout) |
| `WEBHOOK_MAX_RESPONSE_BYTES` | `65536` | Cap on drained response body |
| `WEBHOOK_TIMEOUT_MS` | `5000` | Legacy fallback if the split timeouts are unset |
| `WEBHOOK_MAX_ATTEMPTS` / `WEBHOOK_BACKOFF_MS` | `3` / `2000` | In-process retry loop, per delivery attempt |
| `WEBHOOK_SWEEP_ENABLED` | `true` | Recovers deliveries stranded by a crash. The incident switch — set `false` to stop redelivery to an integrator that is melting down |
| `WEBHOOK_SWEEP_INTERVAL_MS` | `60000` | How often a replica tries to sweep (only one wins per tick) |
| `WEBHOOK_PAYLOAD_RETENTION_DAYS` | `30` | After this, the stored body of a settled delivery is replaced with a redaction marker. `0` keeps bodies forever |

**A delivery can be attempted up to 9 times, not 3.** `WEBHOOK_MAX_ATTEMPTS`
bounds one in-process retry loop. The sweeper then picks up deliveries still
under `WEBHOOK_MAX_ATTEMPTS × 3` total attempts, spread over hours, so a delivery
interrupted by a pod restart is not lost.

**Redelivery only works within the retention window.** After
`WEBHOOK_PAYLOAD_RETENTION_DAYS` the stored body is cleared (the delivery log is
kept). The sweeper skips those rows, and
`POST /v1/webhooks/:id/deliveries/:id/redeliver` returns `409 payload_expired`.

**Receiving webhooks.** Any `2xx` acknowledges. Answer within
`WEBHOOK_READ_TIMEOUT_MS` (5s default). Order is not guaranteed, so reconcile
against the API. Deduplicate on the event `id`; a redelivery reuses the original
`id` (at-least-once delivery).

**Migrating existing endpoints:** after deploy, run

```bash
npm run webhooks:audit-destinations
```

Unsafe rows get `destinationBlocked=true` and `enabled=false`. Integrators fix
the URL with `PATCH /v1/webhooks/:id` `{ "url": "https://…" }` (validation runs
again and clears the flag), or re-enable after DNS is public.

**Payload** (POST body to the integrator's URL):

```jsonc
{
  "id": "evt_...",                 // stable event id (use for idempotency)
  "type": "PAYMENT_INTENT_SUCCEEDED",
  "createdAt": "2026-...",
  "data": { /* the payment intent */ }
}
```

**Headers**:

- `X-Cosmos-Signature: t=<unixSeconds>,v1=<hexHmacSha256>` — HMAC-SHA256 of
  `${t}.${rawBody}` using the endpoint's `whsec_...` secret.
- `X-Cosmos-Event`, `X-Cosmos-Event-Id`, `X-Cosmos-Delivery`.

**Verifying the signature (integrator side):**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody: string, header: string, secret: string): boolean {
  const [t, v1] = header.split(',').map((p) => p.split('=')[1]);
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
```

The signing secret is returned **once** on `POST /webhooks` (and on
`rotate-secret`); list/get responses never include it. Every attempt is stored
(`webhook_delivery`) with status, attempts, response code and error — query it
via `GET /webhooks/:id/deliveries` and re-send with the `redeliver` route.

List, get and update return exactly the documented endpoint fields, and create
and `rotate-secret` add `secret`. Nothing else on the row leaves the service — not
`consumerId`, and not the `previousSecret` / `previousSecretExpiresAt` columns an
earlier grace-window rotation wrote.

**`ping` and `redeliver` are rate limited**, per consumer and client address:
`POST /v1/webhooks/:id/ping` 20 and
`POST /v1/webhooks/:id/deliveries/:deliveryId/redeliver` 30 per 10 minutes
(`429 rate_limited`). Both make this service send signed requests to a URL you
chose, and `redeliver` runs the whole retry loop inside the request. For a large
backlog, let the sweeper retry instead of redelivering one by one.

### OpenAPI / Swagger

**Security note:** `GET /docs`, `/docs/json`, and `/docs/yaml` are mounted as
**Express middleware**, not Nest controllers, so they do **not** pass through
`ApisixGuard` or `PermissionsGuard` — anyone who can reach the service port can
fetch the spec. In production, docs are **off by default** (`NODE_ENV=production`
and no `SWAGGER_ENABLED`). Set `SWAGGER_ENABLED=true` only on a trusted network.

Export the spec to files — no database or real gateway secret is needed:

```bash
npm run openapi:generate
# writes openapi/openapi.json and openapi/openapi.yaml
```

CI regenerates both committed files and rejects drift. Run the same check before
committing a controller or DTO change:

```bash
npm run openapi:check
```

Paths in the spec already include the version (`/v1/...`). To set a gateway host
in the spec's `servers`, set `OPENAPI_SERVER_URL` before generating:

```bash
OPENAPI_SERVER_URL=https://gateway.example.com npm run openapi:generate
```

**Using it from Postman.** Import `openapi/openapi.json`, or
`http://localhost:3000/docs/json` from a running service. The spec offers two
servers and two security requirements; tools that pick one take the first of each:

| Calling | Server | Auth |
| ------- | ------ | ---- |
| This service directly (local development) | `http://localhost:{port}` (`port` defaults to `3000`) | `X-Gateway-Secret` **and** `X-Consumer-Username`, together |
| Through the APISIX gateway | `OPENAPI_SERVER_URL`, listed first when set | `Authorization: Bearer <api key>` |

The committed spec is generated without `OPENAPI_SERVER_URL`, so it defaults to
the direct pair; generate it with the variable set for a collection that defaults
to the gateway. Postman keeps one API key per request: if an import sets only
`X-Gateway-Secret`, add `X-Consumer-Username` as a collection header. The health
probes are published with `security: []`.

Every operation carries vendor extensions that say what it is:
`x-cosmos-rate-limit` (its budgets: it can answer `429`), `x-cosmos-upstream`
(the provider it calls: it can answer `502`/`503`/`504`), `x-cosmos-public`,
`x-cosmos-public-key`, and `x-cosmos-scopes` / `x-cosmos-scopes-any` (the scopes
its API key must hold, all of them / one of them, published by
`@RequirePermissions` / `@RequireAnyPermission`). On every route that takes an API
key, the description written in its `@ApiOperation` ends with a sentence generated
from those scopes and `x-cosmos-public-key`, so the contract never names a scope the
guard does not check.

`npm run openapi:generate` refuses to write a spec in which an operation has no
summary or no description, a tag an operation uses has no description, any text
contains an em dash (the developer platform mirrors this contract into its docs,
which allow none), a failure has no body or example, an example's `statusCode`
disagrees with the status it documents, or a `429` sits on a route with no budget.
Whenever you add or change a route, read its regenerated operation (see `CLAUDE.md`).

### Creating intents — two SEP-7 operations, two endpoints

Per [SEP-7](https://stellar.org/protocol/sep-7), the `tx` and `pay` operations
take **different parameters** and produce **different responses**, so each has
its own endpoint, DTO and response schema. The service holds no keys — it only
assembles the request for the client's wallet (returns `uri` + `qr`, plus `xdr`
for `tx`). Asset defaults to **native XLM** when `assetCode` is omitted (or
`XLM`/`native`); any other asset requires `assetIssuer`.

**Network is dictated by the API key type** the gateway forwards: a `prod` key →
public (mainnet), a `dev` key → testnet. `STELLAR_NETWORK` is only a fallback for
local dev without the gateway. Each intent stores its own network and all Horizon
calls (build, validation, observer) target it. Every intent is stored
(`payment_intent` table) and scoped to the calling consumer:
`PENDING → SUBMITTED → SUCCEEDED/FAILED/CANCELLED/EXPIRED`. The one way out of a
final status is `EXPIRED → SUCCEEDED`, on a payment verified on-chain.

**The memo is a mandatory `MEMO_ID`** — it identifies the payment on-chain and
makes creation **idempotent**: `(consumer, memo)` is unique, so re-creating with
the same memo **and the same terms** returns the original intent. The same memo
with any different term — kind, network, destination, amount, asset, `msg`,
`callback`, or `source` for `tx` — is `409 idempotency_conflict`, and the error
says nothing about the stored intent. This matters under the shared public key,
where every anonymous wallet is the same consumer. Both builders share a budget
of **30 calls a minute** per consumer and client address (`429 rate_limited`):
each one reads the payer's account from Horizon and writes a row, and on the
shared public key the address is all that separates one anonymous wallet from
the next. If you don't pass `memo`, a
random uint64 is generated.

**The checkout design.** Both builders take an optional `checkoutTheme`, the
design the hosted checkout page (`https://payments.cosmospay.lat/<id>`) shows the
intent in: `classic` (the default), `split`, `ticket` or `card`
(`CHECKOUT_THEMES` in `src/payment-intents/payment-intents.constants.ts`).
Anything else is `400 validation_failed`. `PATCH /v1/payment-intents/{id}`
changes it in any status, final ones included, because it changes nothing about
the payment. Every response names the design: an intent stored without one —
every intent created before the field existed — answers `classic`. It is not one
of the terms a retry is compared on, so a retry with another `checkoutTheme`
returns the stored intent with its stored design; change it with `PATCH`.

**`POST /v1/payment-intents/tx`** — the payer (`source`) is known, so we build
the unsigned `TransactionEnvelope` and a `web+stellar:tx?xdr=...` URI.
For an issued asset the `destination` must already trust it: the payer signs
this envelope and the destination signs nothing, so the trustline cannot go into
it, and the build answers `400 trustline_missing` rather than hand the payer a
payment that would fail on-chain.

```jsonc
// request (source, destination, amount required)
{
  "source": "G...", "destination": "G...", "amount": "120.1234567",
  "assetCode": "USDC", "assetIssuer": "G...",     // optional (native if omitted)
  "memo": "123456789",                             // optional MEMO_ID (auto-generated if omitted)
  "msg": "Order #24", "callback": "url:https://…"  // optional SEP-7 extras
}
// response → { id, kind: "TX", memo, xdr, uri: "web+stellar:tx?xdr=…", qr, network, … }
```

**`POST /v1/payment-intents/pay`** — no source, so we return only a
`web+stellar:pay?destination=...` URI (the wallet chooses the source asset/path).

```jsonc
// request (only destination required; amount optional → donations)
{
  "destination": "G...", "amount": "120.1234567",  // amount optional
  "assetCode": "USD", "assetIssuer": "G...",        // optional (native if omitted)
  "memo": "123456789",                              // optional MEMO_ID (auto-generated if omitted)
  "msg": "pay me with lumens", "callback": "url:https://…"
}
// response → { id, kind: "PAY", memo, xdr: null, uri: "web+stellar:pay?destination=…&memo=…&memo_type=MEMO_ID", qr, network, … }
```

Example `tx` response:

```jsonc
{
  "id": "clx...",                          // persisted intent id
  "status": "PENDING",
  "network": "testnet",
  "source": "G...",
  "destination": "G...",
  "amount": "25.5",
  "memo": "123456789",
  "xdr": "AAAA...",                       // unsigned transaction envelope
  "uri": "web+stellar:tx?xdr=...",        // SEP-7 deep link
  "qr": "data:image/png;base64,...",       // QR of the SEP-7 URI (derived from uri)
  "createdAt": "2026-...",
  "updatedAt": "2026-..."
}
```

Network/Horizon/fee/timeout are configured via `STELLAR_*` env vars
(see `.env.example`). Defaults to **testnet** for safety — set
`STELLAR_NETWORK=public` for mainnet (real funds).

### Payment intents on Solana and Monad

`POST /v1/payment-intents/pay` takes an optional `chain`: `stellar` (the default),
`solana` or `monad`. A request without it is exactly the Stellar request above. The
network tier is still the API key's — a `prod` key reaches Solana mainnet-beta and
Monad mainnet (chain id 143), a `dev` key Solana devnet and Monad testnet (10143) —
and `network` is stored as `public` / `testnet` on every chain.
`POST /v1/payment-intents/tx` stays Stellar-only: a SEP-7 `tx` is a Stellar envelope.

| | Stellar | Solana | Monad |
| --- | --- | --- | --- |
| Link (`uri`) | SEP-7 `web+stellar:pay` | Solana Pay `solana:<recipient>?…` | EIP-681 `ethereum:<payee>@143?…` |
| Coin (no `assetCode`) | XLM | SOL | MON |
| Token (`assetCode` + `assetIssuer`) | issuer account | SPL mint | ERC-20 contract |
| How the payment is found | `MEMO_ID` | a fresh `reference` key per intent (`chainReference`) | the intent's own deposit address (with a relayer); else destination + exact amount |
| Observer | payments to the destination | the reference key's signatures | the deposit address's balance, native MON included (with a relayer); else the token's `Transfer` logs |
| `amount` | optional | optional | optional with a relayer, required without |
| `msg` / `callback` | both | `msg` (Solana Pay `message`) | neither |
| `txHash` for `validate` / `PATCH` | 64 hex | base58 signature | `0x` + 64 hex |

- **The memo is still the idempotency key**, and `chain` is one of the terms a
  replay must match: memo `42` on Stellar and memo `42` on Solana are different
  payments (`409 idempotency_conflict`). On Solana the memo is also written
  on-chain by the SPL Memo program.
- **A token is resolved against the chain before the intent is stored** — an SPL
  mint's decimals (Token or Token-2022 program), an ERC-20's `decimals()`. An
  address that is not one is `400 validation_failed`; an amount with more decimals
  than the token has is `400 invalid_amount`.
- **A Monad payment carries no memo.** EIP-681 has no field a wallet fills with an
  intent id, so a Monad intent is recognised by what it pays: destination, token
  and exact amount, at or after the block it was created at. Give concurrent
  intents to one destination **distinct amounts**. A **native MON** payment emits
  no log, so the observer cannot find it: settle it with
  `POST /v1/payment-intents/{id}/validate` and the transaction hash. ERC-20
  payments are found by the observer, `MONAD_LOG_BLOCK_RANGE` blocks per call and
  five calls per intent per tick, resuming where it stopped (`chainCursor`).
- **Deposit addresses (with `MONAD_RELAYER_PRIVATE_KEY`).** Every Monad intent
  gets its own address, and the link pays it instead of the merchant: a
  `CREATE2` address of `contracts/PaymentForwarder.sol` through the deterministic
  deployment proxy (`0x4e59…956c`, present on Monad mainnet and testnet), whose
  init code embeds the merchant, the asset, the relayer and the relayer's fee. The
  address is the commitment — nobody, this service included, can deploy code at
  it that pays anyone else — so the service holds no key to the money. The
  deposit forwarder watches the address's balance (native MON included, no logs
  needed); once it covers the intent (any amount above the fee, for an open one)
  the relayer deploys the forwarder, whose constructor pays the relayer its fee
  and the rest to the merchant, and the intent settles on that transaction. The
  fee is fixed when the intent is created and shown as `networkFee`: for MON, the
  forward's gas budget at the current price plus 25%; for a token, the operator's
  `MONAD_DEPOSIT_TOKEN_FEES` entry, or nothing (the relayer absorbs the gas). An
  amount the fee would swallow is `400 invalid_amount`. What arrives after an
  intent expires or is cancelled is still forwarded to the merchant, and a payer
  can settle sooner with `validate` and their own hash. The relayer key holds gas
  money only: fund it modestly and alert on its balance. The bytecode is committed
  (`src/evm/payment-forwarder.artifact.ts`) and a spec recompiles the source
  against it — every deposit address depends on it, so never change it while old
  addresses may still receive money.
- **An RPC node is checked before it is trusted**: before its first read of a
  tier the service compares the node's genesis hash (Solana) or `eth_chainId`
  (Monad) with the chain's, and answers `503 misconfigured` when a mainnet URL
  points at a test network. The public RPCs are the defaults and are heavily
  rate-limited — set `SOLANA_RPC_URL_MAINNET` and `MONAD_RPC_URL_MAINNET` to a
  provider's endpoints in production.
- **Swaps, liquidity pools and DeFindex stay Stellar-only.**

```jsonc
// POST /v1/payment-intents/pay — USDC on Solana
{ "chain": "solana", "destination": "<base58>", "amount": "25.5",
  "assetCode": "USDC", "assetIssuer": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }
// response → { chain: "solana", uri: "solana:<base58>?amount=25.5&spl-token=…&reference=…&memo=…", chainReference, qr, … }
```

### Payment links: the public read behind a hosted checkout

`GET /v1/payment-links/{id}` answers one payment intent, by id, to a caller with
no API key and no gateway secret (`@Public()`). It is what the checkout page at
`https://payments.cosmospay.lat/<id>` reads to show the amount, asset and
network, the address to pay, the link and its QR, and to poll the status until
the payment settles. The answer (`PublicPaymentLinkEntity` in the contract) is
its own shape, not the owner's `GET /v1/payment-intents/{id}` with fields
removed: it is built field by field (`toPublicPaymentLink`), so a column added to
`payment_intent` later is not published here until someone adds it on purpose.

- **The id is the capability.** Anyone holding a link reads it here, whichever
  tenant owns it — that is what a payment link is. An id that never existed and a
  deleted intent get the same `404 not_found` the owner's read gives.
- **Never returned:** the owning consumer, the payer's `source`, the envelope
  (`xdr`), the merchant's `reference` and `callback`, the status history, and the
  merchant's own address when the payer pays a deposit address. `uri` is the link
  verbatim, though, so a SEP-7 link still carries a `callback` the merchant set,
  and a `tx` link the unsigned envelope — exactly what the payer's wallet reads
  from the QR. Never put a secret in a `callback` URL.
- **`payTo` is the address inside `uri`** (`PAY_TO` in
  `src/payment-intents/pay-to.ts`, the same rule the Monad verifier checks
  payments against): the merchant's account on Stellar and Solana — never the
  Solana Pay reference key — and, on Monad with a relayer, the intent's deposit
  address, which forwards the money to the merchant less `networkFee`.
- **`checkoutTheme` is the design to draw** — `classic`, `split`, `ticket` or
  `card`, as the merchant set it on create or with `PATCH` — and is never `null`:
  an intent that names none answers `classic`. A page that meets a value it does
  not know yet should draw `classic` too; new designs are added to this list.
- **The status is live, and `EXPIRED` is not final.** Every answer carries
  `Cache-Control: no-store`. An unpaid intent past `expiresAt` reads `PENDING`
  until the observer expires it, and a payment verified later still moves
  `EXPIRED` to `SUCCEEDED`, so a page should keep polling an expired link, more
  slowly, rather than stop.
- **60 reads a minute per client address** (`PAYMENT_LINK_READ_RATE_LIMIT`; an
  IPv6 caller per /64), then `429 rate_limited` with `Retry-After`. A page polling
  every 5 s spends 12. The address is the whole key, so the page must call from
  the payer's browser: a server that proxies or server-renders these reads puts
  every payer into its one bucket.
- **An id is hard to guess, not secret.** Ids are Prisma `cuid()`s (v1): a
  millisecond timestamp, a counter, a host fingerprint and about 41 bits from
  `Math.random()`, which is not a cryptographic generator. Guessing one blind is
  out of reach at this budget; still, treat a link as private to its payer and
  merchant rather than as a credential.
- **Deploy:** serve `/v1/payment-links/*` from APISIX's keyless route (no
  `key-auth`), as `/v1/public-key` is, or the page gets `401`. This service sends
  no CORS headers on this path, so that route's CORS plugin must allow `GET` from
  the checkout's origin and expose `Retry-After` and `ratelimit-*`; without it the
  browser discards every answer.

### Wallet sign-in on Solana and Monad

`POST /v1/wallet/auth/finish` and `PUT /v1/wallet/backup` take an optional `chain`
and the account as `address`; `stellarAddress` is still accepted for Stellar, and
still returned beside `chain` and `address`. The challenge a Solana or Monad
account signs has a `chain: <chain>` line after its first one — one ed25519 key is
both a Stellar and a Solana address, and the line keeps a signature for one from
opening the other — while the Stellar challenges are unchanged byte for byte.
Solana signs the UTF-8 bytes with ed25519 (`signMessage`; base64 or base58); Monad
with EIP-191 `personal_sign` (0x-hex; high-s signatures are refused). A Monad
address is stored in its EIP-55 spelling. The recovery setup
(`POST /v1/wallet/recovery/setup`) stays Stellar-only. The account's keys are
minted the same way on every chain (see
[No request depends on the developer platform](#no-request-depends-on-the-developer-platform)).

### Easy recovery: moving a wallet between two devices

`/v1/wallet/easy-recovery` moves a wallet from the device that holds it (the old
one) to another (the new one), through a mailbox that lives five minutes and that
this service cannot open:

1. The new device generates an X25519 key pair, opens a session with
   `POST /v1/wallet/easy-recovery/sessions` (`receiverKey`: the public key,
   base64url) and shows a QR with the session `id` and that key, nothing else.
2. The old device scans it, the person confirms and unlocks, and the wallet seals
   its secret to that key (ECIES, on the device), picks a random five-digit code,
   sends both with `POST …/sessions/{id}/offer` and shows the code.
3. The person types the code on the new device, which calls
   `POST …/sessions/{id}/claim`, receives the sealed secret and opens it locally.
   Both devices poll `GET …/sessions/{id}` (`open` → `offered` → `claimed`).

| Answer | When |
| ------ | ---- |
| `201` `{ id, expiresAt }` | The session is open, for five minutes |
| `200` `{ status, expiresAt }` | A poll. Never the key, the sealed secret or the code |
| `200` `{ status: "offered" }` | The first offer |
| `200` `{ ciphertext }` | The right code, once |
| `404 easy_recovery_not_found` | Unknown, expired, burned, or (on a claim) already claimed |
| `409 easy_recovery_already_offered` | A second offer: the first one wins |
| `409 easy_recovery_not_offered` | A claim before the offer: poll for `offered` first |
| `422 easy_recovery_code_invalid` | A wrong code; `details.attemptsLeft` says how many remain |
| `410 easy_recovery_burned` | The fifth wrong code: the session and the sealed secret are deleted |

Why the shared public key may call it:

- **This service cannot open what it stores.** It never holds the receiving
  private key, and it refuses a `receiverKey` that is a low-order X25519 point,
  whose shared secret anyone could compute. The old device must refuse one too.
- **The code is what stops a phishing page.** A page that shows its own QR holds
  the receiving key, so it could read the sealed secret; it still needs the code
  on the victim's screen. Five wrong codes delete the session. Each wrong code is
  counted by a conditional update in Postgres and the right one is accepted only
  below the limit, so guesses sent in parallel get no more than five tries. Only
  SHA-256 of `{id}:{code}` is stored, and the claim wipes it with the secret.
- **One offer, five minutes.** The first offer wins, and every route answers 404
  once the session is past `expiresAt`. A sweeper deletes expired rows on the
  `WALLET_AUTH_SWEEP_*` schedule; a claimed session is kept until then only so the
  old device's poll reads `claimed`.
- **The session id is a handle, not a record token.** It is 128 random bits and
  is never listed, and its read answers only the status. It appears in the paths
  of the request logs; holding it buys five guesses at the code, never the secret.
  Everything is in Postgres, so every replica counts on the same row.

The per-route budgets (per client address) are in
`src/easy-recovery/easy-recovery.constants.ts`.

## The shared public API key

The open-source wallet ships one API key that everybody shares, so anyone can
swap, add liquidity or create a pay link without registering. Those calls pay the
`community` plan's commission (65 bps, the highest rate, the same as Starter's); a
paid plan gets a lower one. The gateway injects the rate exactly as it does for a private key
(see `resolvePlanCommissionBps`).

The difference is tenancy. Every anonymous caller arrives as the same APISIX
consumer, and read endpoints filter rows by consumer:

```ts
// swaps.service.ts
where: { id, consumer: { apisixUsername: consumer.username } }
```

So `GET /v1/swaps` under the public key would return every anonymous user's swap
history. Scopes cannot prevent this, because everyone holds the same key — and
`POST /v1/swaps/quote` needs `swaps:read`, the same scope that lists the history.

**`PublicKeyGuard` is an allowlist.** The public consumer is refused on every
route that does not carry `@AllowPublicKey()`, so new routes are closed to it by
default.

Reachable with the public key today:

| Route | Why it is safe |
| --- | --- |
| `POST /v1/swaps/quote` | Prices a path from Horizon; a pure function of the request |
| `POST /v1/swaps` | Builds an unsigned envelope the caller signs |
| `POST /v1/swaps/:id/submit` | Broadcasts a caller-signed envelope: nothing about the swap, not even its status, is answered until the body is that swap's envelope carrying a signature; a wrong `X-Record-Token` is refused, a missing one is still accepted for now (see below); rate limited |
| `GET /v1/cross-chain-swaps/assets` \| `POST /v1/cross-chain-swaps/quote` | NEAR Intents' token list and a dry quote; pure functions of the request |
| `POST /v1/cross-chain-swaps` | A deposit address for the caller's own funds; a replayed `Idempotency-Key` is answered only when the request matches |
| `POST /v1/cross-chain-swaps/:id/deposit` | Points NEAR Intents at a transaction it verifies on-chain itself; a wrong `X-Record-Token` is refused, a missing one is still accepted for now (see below); rate limited |
| `GET /v1/swaps/:id` \| `GET /v1/cross-chain-swaps/:id` | One swap by its id AND its record token (`X-Record-Token`, see below), so a swap made without an account can follow its own status; still scoped to the consumer |
| `GET /v1/usdt0/routes` \| `POST /v1/usdt0/quote` | The route catalogue and a simulated quote; pure functions of the request |
| `POST /v1/usdt0/transfers` | Builds an unsigned transaction the caller signs; a replayed `Idempotency-Key` is answered only when the request matches |
| `POST /v1/usdt0/transfers/:id/submit` | Broadcasts a caller-signed transaction, after checking it is that transfer's and carries a signature; needs the transfer's `X-Record-Token`; rate limited |
| `GET /v1/usdt0/transfers/:id` | One transfer by its id and its record token, as for a swap |
| `POST /v1/liquidity-pools/deposit` \| `withdraw` | Build unsigned envelopes |
| `POST /v1/liquidity-pools/operations/:id/submit` | Broadcasts a caller-signed envelope, under the same checks as swap submit; rate limited |
| `GET /v1/liquidity-pools` \| `/:poolId` \| `/positions` | Public on-chain data read from Horizon |
| `POST /v1/payment-intents/tx` \| `pay` | Build a SEP-7 intent from the request |
| `POST /v1/activity/events` | Telemetry ingest — see below |
| `GET /v1/assets` | The public asset catalog |
| `GET /v1/aliases/resolve/:name` \| `availability/:name` \| `by-address/:address` | A payer resolving a handle is the anonymous caller this key exists for; the answer is a pure function of the request and never includes the owner's mailbox |

Refused: `GET /v1/swaps`, `GET /v1/cross-chain-swaps`, `GET /v1/usdt0/transfers`,
`GET /v1/liquidity-pools/operations{,/:id}`, `GET /v1/activity/events`,
`GET /v1/activity/summary`, every payment-intent read, every alias owner route
(claim, list, add or remove an address, release, recovery), and everything under
`/v1/kyc`, `/v1/onramp`, `/v1/offramp` and `/v1/webhooks`. A wallet without an
account reads its history from Horizon instead, and follows one swap or transfer
by the id and the record token it was handed.

**Record tokens.** This key is one consumer for every anonymous visitor and anyone
can fetch it, so a record id is not a secret, and scoping by consumer does not keep
one visitor out of another's swap. So a create on this key (`POST /v1/swaps`,
`POST /v1/cross-chain-swaps`, `POST /v1/usdt0/transfers`) answers `publicToken`:
`base64url(HMAC-SHA256(key, "<kind>:<id>"))`, one kind per table, under a key derived
with HKDF from `APISIX_GATEWAY_SECRET` (label `public-record-token v1`). That record's
routes take it in the `X-Record-Token` header, compared in constant time, and a wrong
token answers the same `404` as a record that does not exist, before the table is read:

| Route, with the public key | A missing token |
| --- | --- |
| `GET /v1/swaps/{id}`, `GET /v1/cross-chain-swaps/{id}`, `GET /v1/usdt0/transfers/{id}`, `POST /v1/usdt0/transfers/{id}/submit` | Refused (`404`): these routes are new, nobody called them without a token |
| `POST /v1/swaps/{id}/submit`, `POST /v1/cross-chain-swaps/{id}/deposit` | Still accepted for now, and logged as a deprecation naming the route and the record id, because the wallet already calls them with the public key. Swap submit still answers nothing until the body is the swap's signed envelope. `PUBLIC_RECORD_TOKEN_REQUIRED_ON_LEGACY=true` makes the token required here too |

The token is derived, not stored: a replayed create answers the same one, and rotating
`APISIX_GATEWAY_SECRET` invalidates every token handed out. Real keys never get one
and never need one. A public page sends the header, so the gateway's CORS
`allow_headers` must list `X-Record-Token`.

**Telemetry is allowed** so crash reports from wallets without an account still
arrive. Events on this key are anonymous (one shared consumer), so the wallet
strips address, destination, amount and txHash before sending.

The guard identifies the public consumer by **either** the forwarded role
(`X-Consumer-Role: public`) **or** the `APISIX_PUBLIC_CONSUMER` username. Set
both: if the gateway stops forwarding roles, the username still matches, and
without the username the guard depends only on a header.

**Where a wallet gets it.** `GET /v1/public-key?env=dev|prod` answers
`{ env, apiKey }` with no key and no gateway secret (`@Public()`), from
`PUBLIC_API_KEY_DEV` / `PUBLIC_API_KEY_PROD`; an environment with no key answers
`503 misconfigured`. Rotating the key is changing those variables — every wallet
picks the new one up within the 5-minute cache. The APISIX route for this path
must NOT run `key-auth` (the caller has no key yet): serve it from the keyless
route, as `/v1/wallet/auth/oauth/callback/*` is.

## No request depends on the developer platform

The developer platform creates API keys for developers and shows data. Nothing a
client does passes through it: the wallet and every integration talk to APISIX,
and APISIX talks to this service. It used to be otherwise, and the platform — the
piece that goes down most — took every sign-in with it:

| Used to go through the platform | Now |
| --- | --- |
| Sending the wallet's sign-in code | This service sends it (`MAIL_FROM` + `MAIL_RESEND_API_KEY` / `MAIL_SMTP_*`) |
| Minting a wallet account's API keys at the end of a sign-in | This service mints them in APISIX (`APISIX_ADMIN_URL`, `APISIX_ADMIN_KEY`) |
| A recovery server's emailed code | Each recovery server sends its own (`RECOVERY_EMAIL_CODES=true` + its own `MAIL_*`) |
| The shared public key (`/api/public-key`) | `GET /v1/public-key` |
| The asset catalog and anonymous telemetry (`/api/assets`, `/api/telemetry`) | The wallet calls `GET /v1/assets` and `POST /v1/activity/events` with the public key |

What the platform still does is its own: developers' keys, the dashboard, and
`/v1/admin`, which it calls — never the other way round. If it is down, nobody
can create a developer key or open the dashboard; wallets sign in, pay and swap as
usual.

**Wallet keys.** A finished sign-in gets a `dev` and a `prod` key under the
consumer `cosmos_wallet_<accountId>`, with the scopes, labels and consumer
forwarder the platform used to bake (plan `community`, swap commission
`WALLET_KEY_SWAP_FEE_BPS`, default 65 bps). Every boot re-bakes the wallet consumers still carrying another
rate, so a change to `WALLET_KEY_SWAP_FEE_BPS` reaches every account at once
instead of on its next sign-in. A second sign-in returns the keys the
account already has instead of minting another pair. `organizationId` in the
answer is the account id.

**The admin key is the security trade.** APISIX has no narrower grant than its
admin key, which can rewrite every route. The client here only writes consumers
under `cosmos_wallet_` and refuses any other name before building a request, but
that is this code's promise, not APISIX's: treat `APISIX_ADMIN_KEY` like
`APISIX_GATEWAY_SECRET`, give this service's pods network access to the admin API
and nothing else to it, and never set it on a recovery server (boot refuses).

**Accounts provisioned by the platform before this change** keep working with the
keys they hold. On their next sign-in they get new keys under
`cosmos_wallet_<accountId>`, a new consumer, so history recorded under the old
consumer (`cosmos_<platformUserId>`) is not visible with the new key.

## Stellar native swaps (path payments)

Stellar has no dedicated "swap" operation. Asset exchange is done with a
**`PathPaymentStrictSend`**, which Horizon automatically routes through the best
available combination of the **Stellar DEX order books** and **AMM liquidity
pools**. Cosmos Pay wraps that into a swap flow that is, like payment intents,
**completely non-custodial** — funds never pass through the service. It only:

1. **Quotes** by querying Horizon's strict-send path search.
2. **Builds** the unsigned transaction (an optional platform-fee payment + the
   path payment) and returns its `xdr` + SEP-7 `tx` URI + QR.
3. **Relays** the transaction the customer signs in their own wallet.

```
quote → build XDR → customer signs in wallet → POST /submit → Stellar executes
```

The network is dictated by the API key type (prod → public, dev → testnet), the
same as payment intents, and every swap is **persisted** (`swap` table) and scoped
to the calling consumer (`PENDING → SUBMITTED → SUCCEEDED/FAILED`).

**Fee (per-organization, enforced server-side).** The commission is **the rate of
the calling organization's plan**, injected by the gateway as a trusted header
(`X-Plan-Swap-Fee-Bps`) that the dev platform derives from the org's plan. It is
**never a request parameter**, and APISIX overwrites any client-supplied copy, so
the rate cannot be bypassed or undercut. The fee is taken from the **source asset**
and paid to the platform wallet (`STELLAR_SWAP_FEE_WALLET`) as a first payment
operation; the **remainder** is routed through the swap. If a plan fee applies but
no platform wallet is configured, swap creation fails with `503` (operator
misconfiguration). `STELLAR_SWAP_FEE_BPS` is only a fallback for local dev without
the gateway (and is itself disabled when no wallet is set).

**Slippage.** The quote's estimate, reduced by `slippageBps` (default
`STELLAR_SWAP_SLIPPAGE_BPS`, capped by `STELLAR_SWAP_MAX_SLIPPAGE_BPS`), becomes
the path payment's on-chain `destMin` — so the swap **reverts** rather than
delivering less than the caller agreed to accept.

**Trustline.** A non-native destination asset needs a trustline on the account
that receives it, and only that account can sign the `changeTrust` that adds one.
When the receiver is `source` (a self-swap, the default) and does not trust the
asset yet, the build puts that `changeTrust` first, before the fee payment and the
path payment, so one signature adds the trustline and makes the swap; the
response's `trustline` names the asset (`null` when nothing is added), so a wallet
can say so before its user signs. A trustline locks another 0.5 XLM base reserve:
when the source could not keep its new minimum balance after the XLM the swap sends
and the network fee (sponsorships and open offers counted as the network counts
them), the build answers `400 insufficient_balance` rather than return an envelope
the network would reject. Any other `destination` signs nothing here, so one that
does not trust the asset is refused with `400 trustline_missing`, which says only
that account can add it. (XLM needs no trustline.)

**`POST /v1/swaps/quote`** — price only, nothing persisted (`swaps:read`).

```jsonc
// request — sell 100 XLM for USDC
{
  "amount": "100",                 // gross source amount (fee comes out of this)
  "destAssetCode": "USDC",
  "destAssetIssuer": "GA5ZSEJYB37JRC5AVCIA5MOP4RHTR6F3DSZL5A3W4G4M4N4A5U4QY3T6",
  "slippageBps": 50                // optional; defaults to the service setting
  // sourceAssetCode / sourceAssetIssuer omitted → native XLM
}
// response
{
  "network": "public",
  "source":      { "asset": "native", "issuer": null, "amount": "100" },
  "fee":         { "asset": "native", "issuer": null, "amount": "0.5", "bps": 50, "wallet": "G..." },
  "swap":        { "asset": "native", "issuer": null, "amount": "99.5" },
  "destination": { "asset": "USDC", "issuer": "G...", "estimated": "24.81", "minimum": "24.68595", "slippageBps": 50 },
  "path": []                       // intermediate hops chosen by the router (may be empty)
}
```

**`POST /v1/swaps`** — build the signable transaction (`swaps:write`). Takes the
same fields plus `source` (the paying/signing account); `destination` defaults to
`source` (a self-swap) and an optional `memo` (MEMO_ID) is echoed on-chain.

Optional **idempotency**: send an `Idempotency-Key` header (preferred) or
`idempotencyKey` in the body. A retry with the same key **and the same request**
— network, source, destination, both assets, amount, slippage and memo — returns
the **existing** swap (`id` + `txHash`) instead of building another transaction.
The same key with a different request is `409 idempotency_conflict`, and the
error says nothing about the stored swap. Liquidity deposits and withdrawals
follow the same rule, comparing the operation's kind as well. Without a key, the
unique `(network, txHash)` constraint still rejects a byte-identical rebuild
with **409** (sequence / XDR collision). When
`STELLAR_SWAP_SINGLE_INFLIGHT=true`, a second non-expired `PENDING` swap for the
same `(consumer, source, network)` also returns **409** naming the existing id
(default **off** — concurrent distinct swaps from one account remain allowed).
Only a swap that **may already be on-chain** holds that guard: a row whose
sequence number the account has not used yet cannot have settled, and the swap
being built now takes the same number, so at most one of the two ever can. Any
caller may name any `source`, so without that test a single dust swap froze
swapping for a stranger's account for a whole timeout window — and under the
shared public key, for as long as the attacker kept repeating it.

```jsonc
// response → { id, status: "PENDING", network, sendAmount, feeAmount, swapAmount,
//              destEstimated, destMin, path, trustline, xdr, uri: "web+stellar:tx?xdr=…", qr, txHash, … }
```

**Quoting and building are rate limited too**, per consumer and client address:
**60 quotes a minute** and **20 builds a minute**, in separate buckets from
submit's. A quote persists nothing and still costs a strict-send path search, the
most expensive call this service makes of Horizon — and that per-IP budget is
shared by swaps, liquidity pools and payment intents alike, so a price polled in
a loop degraded all three for every anonymous caller at once.

**`POST /v1/swaps/:id/submit`** — relay the signed envelope (`swaps:write`).

```jsonc
// request
{ "signedXdr": "AAAAAgAAA…(signed base64 XDR)…" }
// response
{ "submitted": true, "status": "SUCCEEDED", "txHash": "…", "swap": { … } }
// on a network rejection → { "submitted": false, "status": "FAILED", "reason": "…", "resultCodes": ["op_under_dest_min"], "swap": { … } }
// rejected, outcome not on the ledger yet → { "submitted": false, "status": "SUBMITTED", "reason": "…", "resultCodes": ["tx_bad_seq"], "swap": { … } }
```

Before broadcasting, the service checks that the signed transaction's hash
matches the one it built, so it never relays an arbitrary transaction. A swap
fires `SWAP_CREATED` / `SWAP_SUBMITTED` / `SWAP_SUCCEEDED` /
`SWAP_FAILED` webhook events through the same dispatcher.

**Submit is strict about what it relays.** Nothing about the swap — not even its
status — is answered until `signedXdr` parses, hashes to the swap's `txHash` and
carries at least one signature, so the unsigned `xdr` from the create response is
`400 validation_failed`. A swap whose envelope is past its time bounds
(`STELLAR_TX_TIMEOUT`, 300 s by default) is `400 invalid_state_transition` and is
not broadcast; if it reached the network in time, the observer still settles it.
After a network rejection the same envelope may be resubmitted at most **3**
times, then build a new swap — a retry after `503 provider_unavailable` does not
count. The route allows **20 calls a minute** per consumer and client address
(`429 rate_limited`); under the shared public key every anonymous wallet is one
consumer, so wallets behind one NAT share that budget.
`POST /v1/liquidity-pools/operations/:id/submit` follows the same rules, with a
bucket of its own, and `POST /v1/liquidity-pools/deposit` · `/withdraw` share one
budget of **20 builds a minute** — the two directions of one flow, so separate
buckets would only let a loop alternate them and take both.

### Swaps on Solana and Monad (Jupiter, Kuru Flow)

`/v1/swaps` takes an optional `chain`. Without it — or with `stellar` — every
request is answered exactly as before. `solana` goes through
[Jupiter](https://jup.ag) and `monad` through [Kuru Flow](https://kuru.io):
aggregators that search every liquidity source on their chain, so a swap gets
the best rate there rather than one pool's price. The flow is the Stellar one,
non-custodial throughout:

```
POST /v1/swaps/quote {chain} → POST /v1/swaps {chain, source} → wallet signs `transaction`
  → POST /v1/swaps/{id}/submit {signedTransaction} → observer → SUCCEEDED / FAILED
```

- **Assets** are the native ticker (`SOL`, `MON`), `native`, or the SPL mint /
  ERC-20 address. Issuers, `memo` and a separate `destination` are Stellar only
  and refused elsewhere: the output goes to `source`.
- **`transaction`** is what the wallet signs. Solana: an unsigned
  VersionedTransaction (base64), valid about a minute, until its blockhash
  expires. Monad: `{ to, data, value, chainId }`, signed as an EIP-1559
  transaction, valid two minutes. Selling an ERC-20 on Monad with too small an
  allowance also returns `approval`: the exact `approve` call to send and
  confirm first.
- **Submit** checks the signed transaction is the one built — the same message
  bytes on Solana, the same call on Monad — and signed by `source`, then
  broadcasts it through this service's own RPC. A node refusing it is
  `400 transaction_rejected` and the swap stays `PENDING`; only the chain's own
  verdict, read by the observer, makes it `SUCCEEDED` or `FAILED`. Unsubmitted
  or unseen swaps become `EXPIRED`. Webhooks are the same `SWAP_*` events.
- **Commission:** the plan rate, as on Stellar, but taken from the **output** by
  the aggregator. Jupiter pays its `platformFeeBps` into
  `SOLANA_SWAP_FEE_WALLET`'s token account for the output mint, which must
  exist — a missing one answers `503 misconfigured` naming the account to
  create. Kuru Flow pays its `referrerFeeBps` to `MONAD_SWAP_FEE_WALLET`.
- **Mainnet only**; a `dev` key is `400 network_unsupported`.
  `GET /v1/swaps?chain=solana` lists that chain; ids are unique across chains,
  so `GET /v1/swaps/{id}` and submit find any swap.
- **Keys.** Kuru Flow without `KURU_API_KEY` issues a per-address token limited
  to one request a second — enough to try it, not for production. Jupiter's
  keyless tier is the default; with `JUPITER_API_KEY`, point `JUPITER_BASE_URL`
  at `https://api.jup.ag/swap/v1`.

## Cross-chain swaps (NEAR Intents)

Swaps **across chains** are settled by
[NEAR Intents](https://intents.near.org/) through its 1Click API, between any two
networks it lists that this service can validate, 35 today: Stellar, Solana and Monad;
the EVM chains (Ethereum, Base, Arbitrum, Optimism, BNB Chain, Polygon, Avalanche,
Gnosis, Berachain, Scroll, X Layer, Abstract, Plasma, Robinhood Chain, Hyperliquid);
the UTXO coins (Bitcoin, Litecoin, Dogecoin, Bitcoin Cash, Dash, Zcash); and XRP
Ledger, Tron, TON, NEAR, Sui, Aptos, Movement, Starknet, Cardano, Aleo and Fogo.
Like the Stellar swaps above, they are **non-custodial**: the payer sends the input
to a deposit address 1Click derives for that one quote, and NEAR Intents' solvers
pay the output to the recipient on the destination chain, or refund the payer.
Neither leg passes through Cosmos Pay.

A network is named by its id: `stellar`, `solana` and `monad` as everywhere else in
this service, and 1Click's own code for the rest (`eth`, `base`, `btc`, `near`, ...;
`src/cross-chain-swaps/cross-chain-networks.ts` is the registry).
`GET /v1/cross-chain-swaps/assets` lists each token with its `chain`, a display
`chainName` and `priceUsd`, NEAR Intents' reference price: indicative only, for
showing an estimate before a quote, since every amount still comes from a quote.
1Click also lists `qtc` and `adi`; they are not offered, because their address
formats could not be confirmed and a refund address this service cannot validate is
a refund it cannot promise.

```
quote → create (deposit address + wallet link + QR) → payer sends the deposit
      → POST /deposit (optional) → observer polls 1Click → SUCCEEDED / REFUNDED / FAILED + webhook
```

**Which swaps go where.**

| Pair | Settled by | Why |
| --- | --- | --- |
| Stellar → Stellar | `/v1/swaps` (Stellar DEX) | The protocol swaps natively; `/v1/cross-chain-swaps` answers `400` and points there |
| Any two different networks | NEAR Intents | A bridge is needed, and NEAR Intents is the one |
| Solana → Solana, Monad → Monad | `/v1/swaps` with `chain` (Jupiter, Kuru Flow) | Each aggregator routes across every liquidity source on its chain for the best rate; `/v1/cross-chain-swaps` answers `400` and points there |
| Within any other network (`eth` → `eth`, ...) | NEAR Intents | This service has no venue of its own there |

What this service does itself, on every network: resolves the assets against 1Click's
token list (`GET /v1/cross-chain-swaps/assets`), validates each address against its
own network (`recipient` on the destination, `refundTo` on the origin), builds the
deposit request as a wallet link where the chain has a standard (SEP-7 `pay`, Solana
Pay, EIP-681 on the chain's verified id, the BIP-21 style `bitcoin:`, `litecoin:`,
`dogecoin:`, `bitcoincash:`, `dash:` and `zcash:` links, `ton://transfer` and CIP-13
`web+cardano:`), checks on Horizon that a Stellar recipient trusts the asset it is
about to receive, and mirrors the status into its own table.

**Some deposits have no link.** XRP Ledger, Tron, NEAR, Sui, Aptos, Movement,
Starknet, Aleo, Fogo, Robinhood Chain and Hyperliquid have no wallet-link standard
this service builds, and the TON and Cardano links carry the native coin only. There
`depositUri` is `null`: the payer sends `amountIn` to `depositAddress` from any wallet
of that chain, and `qr` encodes the address. Off Stellar this service asks 1Click
for an address of the swap's own (`depositMode: SIMPLE`), with no memo; if 1Click
ever issues one anyway, it is stored and returned in `depositMemo`, must be
attached, and no link is built that would drop it.

**Commission.** The organization's plan rate — the same trusted
`X-Plan-Swap-Fee-Bps` as Stellar swaps, never a request parameter — is sent to 1Click
as an `appFees` entry paid to `NEAR_INTENTS_FEE_RECIPIENT`, a NEAR account. NEAR
Intents takes it out of the input, the quoted output is already net of it, and it
accrues to that account inside NEAR Intents, where the operator withdraws it. A plan
with a rate and no recipient configured answers `503 misconfigured` rather than swap
for free.

**Set `NEAR_INTENTS_API_KEY`.** 1Click works without a partner key, but not at the
same price: without one (checked 2026-09-30) every quote carries a 0.2% fee of
1Click's own, and half of the commission requested in `appFees` goes to 1Click
instead of to `NEAR_INTENTS_FEE_RECIPIENT`.

**Mainnet only.** NEAR Intents has no test network. A `dev` key may list assets and
quote — the price is mainnet's either way — but `POST /v1/cross-chain-swaps` answers
`400 network_unsupported`: a deposit address would take real money.

**Stellar deposits carry a memo.** 1Click receives every Stellar deposit on one
account and tells them apart by memo, so `depositMemo` is mandatory there and the
SEP-7 link attaches it as a **`MEMO_TEXT`** — the type the deposits to that account
carry. A deposit without it, or with a `MEMO_ID`, is not credited to the swap.

**Statuses.** `AWAITING_DEPOSIT` → `DEPOSIT_DETECTED` / `INCOMPLETE_DEPOSIT` →
`PROCESSING` → `SUCCEEDED`, `REFUNDED` or `FAILED`, which are final. 1Click's own
word is kept in `providerStatus`. A swap still waiting when its deadline passes
(`CROSS_CHAIN_SWAP_DEADLINE_SECONDS`, 30 minutes by default) becomes `EXPIRED`; a
deposit that lands later is refunded by NEAR Intents, so an `EXPIRED` swap is still
polled for a day and follows it to `REFUNDED`. The observer runs with the settlement
observer (`OBSERVER_ENABLED`, `OBSERVER_INTERVAL_MS`); no wallet has to come back for
a swap to settle. Each move emits `CROSS_CHAIN_SWAP_UPDATED`, `_EXPIRED`,
`_SUCCEEDED`, `_REFUNDED` or `_FAILED`; the last three are durable and deduplicated
like the payment-intent ones.

**Keep `quoteSignature`.** It is 1Click's signature over the quote and its deposit
address — what settles a dispute with NEAR Intents. The whole signed quote is stored
server-side as well.

**Limits.** Quote: 60 calls a minute; create and deposit: 20 each, per consumer and
client address (`429 rate_limited`).

### Cross-chain swap routes

| Route | Scope | Purpose |
| --- | --- | --- |
| `GET /v1/cross-chain-swaps/assets` | `swaps:read` | The tokens NEAR Intents can swap on every network this service reaches, with an indicative USD price. Only tradable ones: a token it tags deprecated, or lists with no price (it quotes none of those), is left out, and a deprecated one is refused as `asset_unsupported` |
| `POST /v1/cross-chain-swaps/quote` | `swaps:read` | A dry quote: output, minimum, commission; persists nothing |
| `POST /v1/cross-chain-swaps` | `swaps:write` | A live quote: deposit address, memo, wallet link and QR; `Idempotency-Key` supported |
| `GET /v1/cross-chain-swaps` | `swaps:read` | The consumer's cross-chain swaps |
| `GET /v1/cross-chain-swaps/{id}` | `swaps:read` | One swap, as the observer last saw it (the shared public key too, with the swap's `X-Record-Token`) |
| `POST /v1/cross-chain-swaps/{id}/deposit` | `swaps:write` | Report the deposit transaction so NEAR Intents starts without waiting for its indexer |
## Merchant fee (your own fee on each operation)

An organization that resells these rails to other businesses through this API can
charge its own customers a fee on each operation, paid on-chain to a wallet it names.
It is apart from the plan commission Cosmos Pay charges, which does not change.

```json
"merchantFee": { "bps": 150, "fixed": "0.25", "wallet": "G...", "paidBy": "recipient" }
```

- **`bps` and `fixed`:** the fee is `amount × bps / 10,000`, rounded down, plus `fixed`
  (in the operation's asset, with at most its decimals). `bps` goes up to 1,000 (10%);
  at least one of the two must be above zero. A fee that rounds to nothing on the
  amount is refused (`400 invalid_amount`).
- **`paidBy`:** `recipient` (the default) takes the fee out of `amount`; `payer` adds it
  on top, so the payer sends `amount` plus the fee.
- **`wallet`:** where the fee is paid, on the chain it travels on.
- **What the row keeps:** `merchantFee` (`bps`, `fixed`, the `amount` charged, `asset`,
  `wallet`, `paidBy`) on every read and webhook, null without one. An `Idempotency-Key`
  replay must name the same fee, or it is `409 idempotency_conflict`, as a different
  destination is.

| Operation | How the fee is paid |
| --- | --- |
| Stellar swaps (`POST /v1/swaps`) | Its own `payment` in the source asset, in the swap's transaction, after the plan commission. `wallet` is a Stellar account that holds the source asset's trustline (otherwise refused before anything is built) |
| Stellar payment links (`POST /v1/payment-intents/tx` and `/pay`) | A second `payment` in the same envelope, to `wallet`, after the merchant's. A `tx` intent's envelope carries both. A `pay` link cannot (SEP-7 `pay` pays one account) and needs an `amount`: its `uri` is the hosted checkout (`PAYMENT_LINK_CHECKOUT_URL/<id>`), the public link reads `payerAccountRequired: true`, and `POST /v1/payment-links/{id}/transaction` builds the payer's envelope from their account. The intent settles only on a transaction that pays both legs with its memo |
| Cross-chain swaps (`POST /v1/cross-chain-swaps`) | A second NEAR Intents app fee. `wallet` is a NEAR account id, credited inside NEAR Intents. App fees are whole basis points of the deposit, so the fee becomes the basis points it amounts to, rounded down; a fee under one basis point is refused. With `payer`, the plan commission is a share of the larger deposit too |
| Solana payment links (`POST /v1/payment-intents/pay`, `chain: solana`) | A Solana Pay transfer request names one recipient, so such a link (with an `amount`) is a Solana Pay **transaction request**: `uri` is `solana:<PAYMENT_LINK_API_URL>/v1/payment-links/{id}/solana-pay`, and the wallet POSTs the payer's account there for the transaction: the memo, the merchant's transfer carrying the link's reference, and the fee's transfer (token accounts created when missing, paid by the payer). A SOL fee goes to an account that already exists. The observer finds it by the reference and settles only on both legs |
| Monad payment links (`POST /v1/payment-intents/pay`, `chain: monad`) | Only with deposit addresses (`MONAD_RELAYER_PRIVATE_KEY`; without them `merchant_fee_unsupported`) and an `amount`: the address is a `contracts/PaymentSplitForwarder.sol` (the fee's wallet and amount are two more constructor arguments, so the address commits to them), whose constructor pays the relayer its fee, then the merchant fee, then the merchant. The link asks for the deposit: the amount, plus the fee when the payer pays it |
| Swaps on Solana (`POST /v1/swaps`, `chain: solana`) | Jupiter pays one integrator fee per swap and the plan commission takes it, so the fee's transfer (out of the source, in the source asset: a System transfer for SOL, else a TransferChecked after creating the wallet's token account) is appended to Jupiter's own v0 transaction: the accounts its lookup tables load are reused, every index rewritten, its compute limit raised, and the route asked with at most 40 accounts so it still fits one packet. A SOL fee goes to an account that already exists |
| Private payments (`POST /v1/zk-payments`) | A third confidential transfer, in XLM, from the payer to `wallet`, so the fee stays as private as the payment. `wallet` must hold a confidential account on Cosmos Pay's token under auditor 0 (`400 recipient_not_registered` otherwise) and be neither the recipient nor the fee account. The 0.18% commission stays a share of `amount`, and the row's `amount` is what the payer pays in total. Confirm takes the third hash as `merchantFeeTxHash` and checks that transfer like the other two |
| Liquidity (`POST /v1/liquidity-pools/deposit` and `/withdraw`) | A deposit or withdrawal moves two assets, so the fee is `bps` of EACH (rounded down), paid to `wallet` by one payment per asset in the same transaction, after the deposit, or after the withdrawal and its plan commission; `fixed` is refused (`400 validation_failed`). On a deposit, `recipient` takes it from the amounts (less enters the pool) and `payer` adds it on top. On a withdrawal it comes out of what the withdrawal pays, as a share of its guaranteed minimums, whichever `paidBy` names. `wallet` must exist and trust both assets. The record's `amount` / `asset` are asset A's leg, and `amountB` / `assetB` asset B's |
| Swaps on Monad (`POST /v1/swaps`, `chain: monad`) | Kuru Flow pays one referrer fee per swap and the plan commission takes it, so a swap with a merchant fee goes through `contracts/MerchantFeeSwapRouter.sol`, deployed once by the operator for Kuru's router and named in `KURU_MERCHANT_FEE_ROUTER`: Kuru quotes for the router, the wallet sends (MON) or approves (ERC-20) the input plus the fee to it, and in that one transaction it pays the fee, runs Kuru's calldata, forwards the output and refunds what Kuru left, reverting below Kuru's minimum. The deployed code is checked against the artifact before a wallet is handed the address. Without the variable, `400 merchant_fee_unsupported` |
| USDT0 transfers (`POST /v1/usdt0/transfers`) | A Soroban transaction carries one operation, so such a transfer's operation is `contracts/soroban/usdt0-fee-wrapper` (`USDT0_FEE_WRAPPER`) instead of the OFT: under the holder's one authorization it transfers the fee in USDT0 to `wallet` (which must trust USDT0), then calls the OFT's `send` with the same arguments and answers its receipt. `recipient` takes the fee from `amount` (less is sent), `payer` adds it on top. The deployed wasm and the OFT and token it is bound to are checked before a holder is handed the transaction. Without the variable, `400 merchant_fee_unsupported` |

Every operation above takes the field. Where this deployment has not configured the
contract an operation needs (`KURU_MERCHANT_FEE_ROUTER`, `USDT0_FEE_WRAPPER`),
it answers `400 merchant_fee_unsupported`.

## USDT0 from Stellar (LayerZero)

[USDT0](https://docs.usdt0.to) is Tether's omnichain USDT. On Stellar it is the
classic asset `USDT0:GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q` behind
LayerZero's OFT contract (`CBOWOLFSDM5PZXNFIVDMP5NZ7U2GSIHED6H6R446QOHF266XINKUMMF6`),
and the OFT exists to send it to other networks: `send` burns the USDT0 on Stellar and
LayerZero delivers it. On Ethereum it arrives as **native USDT** (the peer there is
Tether's OFT adapter, which unlocks real USDT); on the other 20 routes it arrives as
USDT0. Every route takes an EVM recipient. `/v1/usdt0` sends it **from Stellar**: the
holder signs one Soroban transaction (with Freighter, or through the SEP-7 link), and
this service is non-custodial, as for swaps. It quotes the OFT by simulation, builds
the transaction, checks that the signed copy is that transaction, relays it, and
follows the message on LayerZero Scan.

```
routes → quote → create (unsigned XDR + SEP-7 link) → the holder signs
       → POST /submit (or the wallet broadcasts it) → GET /{id} → SUBMITTED → DELIVERED / FAILED
```

**Mainnet only.** USDT0 does not exist on Stellar testnet. A `dev` key reads
`GET /v1/usdt0/routes` as `available: false` with no routes, and gets
`400 network_unsupported` on the quote, the build and the submit.

**Two fees, both in XLM, both paid by the holder.** LayerZero's messaging fee
(`nativeFee`: about 3.5 XLM to Ethereum and 0.13 to 0.5 XLM to the others on
2026-10-25; it follows LayerZero's price feeds) and the Stellar network fee
(`networkFee`: about 1.45 XLM of Soroban resources, part of it refunded by the network).
The transaction offers LayerZero `nativeFeeLimit`, the quote plus 20%: it lands minutes
after it is built, and an offer below the fee at that moment fails on-chain and still
costs the network fee. The endpoint charges the real fee and returns the rest to the
holder in the same transaction (checked by simulation on mainnet), so the buffer costs
nothing, but the account must hold it.

**Dust.** The asset has 7 decimals and the OFT carries 6, so the 7th decimal of
`amount` cannot travel. It is `dust`, and it stays in the account: `amountSent` is what
the OFT takes. Less than 0.000001 USDT0 is all dust and is refused with
`400 invalid_amount`. `amountReceived` is also the on-chain floor: the transaction fails
rather than deliver less.

**Refused before anything is built** (`400`): a source account that does not exist
(`validation_failed`), does not trust USDT0 (`trustline_missing`), holds less USDT0 than
the transfer takes, or holds too little XLM for its minimum balance, its open offers, the
fee limit and the network fee together (`insufficient_balance`, saying how much XLM to
add); a recipient that is not an EVM address or carries a bad EIP-55 checksum
(`validation_failed`); an amount outside the OFT's limits (`invalid_amount`). What the
OFT itself refuses is `400 provider_error`, carrying its contract error.

**Statuses.** `PENDING` (built) → `SUBMITTED` (on the Stellar ledger; LayerZero is
delivering it, and `guid` is its message id) → `DELIVERED` (with `destinationTxHash`) or
`FAILED` (with `failureReason`). `EXPIRED` means the transaction never reached the ledger
before `expiresAt` (`STELLAR_TX_TIMEOUT`). There is no background observer:
`GET /v1/usdt0/transfers/{id}` refreshes a `PENDING` or `SUBMITTED` transfer from the
Stellar ledger (a wallet may broadcast the SEP-7 link itself and never call submit) and
from LayerZero Scan's public API (`scan.layerzero-api.com`, by guid first), at most once
every 15 seconds per transfer, and answers from the row when either is down. `scanStatus`
is Scan's own word: `PAYLOAD_STORED` and `BLOCKED` stay `SUBMITTED`, because anyone can
clear them on the destination network. Delivery takes about 27 minutes on every route
(the 45 transfers from Stellar that Scan listed on 2026-10-25 took 1,612 to 1,661
seconds), because LayerZero's verifiers wait for Stellar confirmations.

**No QR, usually.** A Soroban transaction's ledger footprint makes its XDR about 7,000
characters, more than a QR code holds, so `qr` is usually `null`: sign with a connected
wallet or through the `uri` link.

**Commission: the plan's rate, through the fee wrapper.** A Soroban transaction carries
one operation, so the commission rides through the same contract as a merchant fee
(`USDT0_FEE_WRAPPER`, below): `feeBps` of `amount`, rounded down, paid in USDT0 to
`STELLAR_SWAP_FEE_WALLET` (which must trust USDT0, or `503 misconfigured`), and the rest
is sent. Without the wrapper configured a transfer carries no commission (`feeBps: 0`),
by the product owner's choice (2026-10-26).

**A merchant fee rides through a contract.** With `merchantFee` (see **Merchant fee**)
the operation is the wrapper's `send` (`USDT0_FEE_WRAPPER`): it transfers the fee
in USDT0 to the fee's wallet and calls the OFT's `send` with the same arguments, under
the holder's one authorization, and answers the OFT's receipt, so the transfer is
tracked by the same guid. Deploy it once, with no owner:
`USDT0_OFT=CBOWOLFSDM5PZXNFIVDMP5NZ7U2GSIHED6H6R446QOHF266XINKUMMF6 USDT0_SAC=CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF; stellar contract deploy --wasm contracts/soroban/usdt0-fee-wrapper/usdt0_fee_wrapper.wasm --network mainnet -- --oft "$USDT0_OFT" --token "$USDT0_SAC"`.

**The RPC.** Everything goes through Stellar mainnet's Soroban RPC,
`STELLAR_RPC_URL_MAINNET` (Gateway.fm's public endpoint by default, which is rate
limited: set a provider's in production). Its passphrase is checked before use, and a
node on another network answers `503 misconfigured`.

**Limits.** Quote: 60 calls a minute; create and submit: 20 each, per consumer and
client address (`429 rate_limited`). The shared public key may call every route except
the list; reading or submitting one transfer takes the `publicToken` its create
answered, sent as `X-Record-Token`.

### USDT0 routes

| Route | Scope | Purpose |
| --- | --- | --- |
| `GET /v1/usdt0/routes` | `swaps:read` | The networks USDT0 reaches from Stellar, what arrives on each, the token and the OFT |
| `POST /v1/usdt0/quote` | `swaps:read` | What arrives, the dust, LayerZero's fee and the limit offered, by simulation; persists nothing |
| `POST /v1/usdt0/transfers` | `swaps:write` | The unsigned `send` transaction (XDR and SEP-7 link); `Idempotency-Key` supported |
| `GET /v1/usdt0/transfers` | `swaps:read` | The consumer's transfers (not on the shared public key) |
| `GET /v1/usdt0/transfers/{id}` | `swaps:read` | One transfer, refreshed from the ledger and LayerZero Scan |
| `POST /v1/usdt0/transfers/{id}/submit` | `swaps:write` | Relay the signed transaction and wait for the ledger: `SUBMITTED`, with the guid |

## Private payments (confidential amounts on Stellar)

A **private payment** is a payment whose amount is hidden on-chain. It is made on Cosmos
Pay's own instance of OpenZeppelin's Confidential Token (`stellar-confidential`
0.8.0): balances are Pedersen commitments, every transfer carries an UltraHonk proof
that the token verifies on-chain, and the amount travels encrypted to the recipient
and to the auditor. Cosmos Pay deploys that token's auditor registry, so it holds the
auditor key (id 0) of every account on it and reads the amount of every transfer
made there. Nobody else watching the ledger does.

**Why the code says ZK.** Everything a person reads calls them private payments.
The routes, variables, table and error codes call them ZK payments
(`/v1/zk-payments`, `/v1/zk-checkout`, `ZK_PAYMENTS_*`, `zk_payment`,
`ZK_PAYMENT_SUCCEEDED`), after the zero-knowledge proofs that keep the amount private.

**Testnet only, for now.** The token wraps native XLM. Mainnet stays off until an
operator deploys there and sets `ZK_PAYMENTS_MAINNET_*`: until then a `prod` key's
`GET /v1/zk-payments/config` answers `enabled: false`, and a create answers
`400 network_unsupported`.

**Commission: 0.18% (18 bps) per payment**, `ZK_PAYMENT_FEE_BPS` in
`src/zk-payments/zk-payments.constants.ts`, the same on every deployment. On a
payment of `amount`, `feeAmount = ceil(amount_in_stroops * 1 / 10000)` stroops, at
least one, and `netAmount = amount - feeAmount`: the merchant receives the net,
Cosmos Pay the fee, and the payer pays `amount` in total. An amount whose net would
be zero is refused (`400 invalid_amount`).

```
merchant: POST /v1/zk-payments (recipient registered on the token)
payer:    GET  /v1/zk-checkout/{id}
          -> confidential transfer of netAmount to the recipient
          -> confidential transfer of feeAmount to the fee account
          POST /v1/zk-checkout/{id}/confirm { paymentTxHash, feeTxHash }
          -> both read back from the chain and decrypted with the auditor key
          -> SUCCEEDED + ZK_PAYMENT_SUCCEEDED webhook
```

**Two prefixes.** The merchant's routes live under `/v1/zk-payments` and take an API
key; the payer's live under `/v1/zk-checkout` and take none (`@Public()`, budgeted
per client address). The split is for the gateway: APISIX serves a keyless read as a
prefix route, which only works when nothing under the prefix needs a key. The
merchant's confidential-account page (register, balance, withdraw) has no session
either, so it reads the contracts it proves against from
`GET /v1/zk-checkout/config?network=testnet` (or `public`): the same builder, and the
same answer, as the authenticated `GET /v1/zk-payments/config`. Everything in it is
public on-chain data; the auditor secret never leaves the server.

**The recipient must be registered first.** `POST /v1/zk-payments` reads the
recipient's confidential account from the Soroban RPC and refuses one with no account
on the token, or one registered under another auditor
(`400 recipient_not_registered`): a transfer to it would fail on-chain after the
payer had spent a proof.

**What confirm verifies, in this order.** `POST /v1/zk-checkout/{id}/confirm` reads
both transactions back through the Soroban RPC and settles the payment only when:

1. neither hash settled another private payment, of any merchant (checked in the database
   before the chain is asked anything; `409 transaction_already_settled`);
2. both transactions exist (`transaction_not_found`) and succeeded
   (`transaction_rejected`);
3. each is a single `confidential_transfer` call on the payment's token, with one
   `transfer` event;
4. both closed while the payment was open: not before it was created, less a minute
   of clock skew, and not after `expiresAt` (`expired`);
5. both come from the same account (`payer_mismatch`);
6. the payment transfer goes to the recipient, and the fee transfer to the fee
   account;
7. each decrypts with the auditor key to exactly `netAmount` or `feeAmount`, on both
   auditor channels, and the decrypted opening matches the transfer commitment
   (`C_transfer`) the invocation carried.

Steps 3, 6 and 7 answer `payment_transfer_mismatch` or `fee_transfer_mismatch`, for
the leg concerned. A refusal leaves the payment `PENDING`; a confirm with the hashes a
payment already settled with answers it again.

**With a merchant fee** (`merchantFee` on the create; see **Merchant fee**) the payer
makes a third transfer, of `merchantFee.amount` to `merchantFee.wallet`, and confirm
takes its hash as `merchantFeeTxHash`: required for such a payment, refused for any
other. It goes through every step beside the other two, in the same order; a mismatch
answers `merchant_fee_transfer_mismatch`.

**Confirm is not an amount oracle.** It is public and decrypts what it is given, so
it never says what an amount decrypted to, and it compares amounts last: a payment
created after a transfer closed refuses that transfer on the time window, and a fee
transfer from one's own account cannot vouch for someone else's payment transfer.
Keep that order when changing it.

**Statuses.** `PENDING` until confirmed, then `SUCCEEDED`. Nothing stores `EXPIRED`:
a `PENDING` payment past `expiresAt` reads `EXPIRED`, in every response and in the
list filter, and can still be confirmed, because transfers that closed before
`expiresAt` paid it. `expiresInMinutes` defaults to 60 and is at most seven days.

**Confirm soon.** The Soroban RPC keeps transactions for a limited window (about
seven days on SDF's testnet RPC); past it, confirm answers `transaction_not_found`.
A checkout confirms right after the transfers.

**Limits.** Create: 30 a minute per consumer and client address. The keyless reads
(`/config` and `/{id}` share one budget): 60 a minute per client address. Confirm:
20 a minute per client address. Each answers `429 rate_limited` with `Retry-After`.

**Deploy:** serve `/v1/zk-checkout/*` from APISIX's keyless route (no `key-auth`),
like `/v1/payment-links/*`. This service sends no CORS headers there; the route's
CORS plugin adds them.

### Deploying the testnet token

```bash
npm run zk:deploy-testnet -- --env-file .env --secrets-file .zk-secrets/testnet.json
npm run zk:e2e-testnet
```

`scripts/zk/deploy-testnet.ts` needs no Rust build and no real funds: with a
Friendbot-funded throwaway deployer, it reads the wasm hashes of the confidential
token demo's auditor registry and vanilla token from their instances on testnet,
deploys a new auditor registry (admin and manager: the deployer) with Cosmos Pay's
key `K_aud = k·H` under id 0, deploys a new vanilla token over native XLM with the
demo's verifier (its v0.8.0 verification keys are registered, and verifying is
public), checks `addr_f` parity, and registers the fee account on the token with a
register proof generated in Node. With `--env-file` it writes the
`ZK_PAYMENTS_TESTNET_*` set into that file, and with `--secrets-file` the operator's
keys (the registry admin, and the fee account's secret and confidential spending
scalar, which withdraw collected fees) into that one; without them it prints both.
The server needs none of the operator's keys. Run again, it verifies the configured
set on-chain instead of redeploying; `--redeploy` deploys a fresh set, which strands
every payment made on the old token.

`scripts/zk/e2e-testnet.ts` is the real-chain check. With Friendbot accounts it
registers a merchant and a payer, creates payments through the module's own service,
deposits, merges, makes both transfers, and confirms through the module's own
confirm: a wrong amount is refused, the right one settles, and the hashes cannot be
reused. It then pays one with a merchant fee: the third transfer goes to a third
registered account, and confirm settles it only with all three hashes.

**Testnet is reset** every few months, and its contracts with it: run the deploy
again after a reset. The verifier it reuses is the demo's; if that one is gone, the
deploy fails until a verifier with the v0.8.0 keys exists and the script names it.

### Private payment routes

| Route | Scope | Purpose |
| --- | --- | --- |
| `GET /v1/zk-payments/config` | `payments:read` | The key's network: token, registries, auditor id, commission, fee account |
| `POST /v1/zk-payments` | `payments:write` | Create a payment to a registered merchant; `Idempotency-Key` supported |
| `GET /v1/zk-payments` | `payments:read` | The consumer's private payments, filtered by status as it reads now |
| `GET /v1/zk-payments/{id}` | `payments:read` | One payment, as its owner sees it |
| `GET /v1/zk-checkout/config` | none, `@Public()` | The same setup for `?network=testnet` or `public`, for a page with no key |
| `GET /v1/zk-checkout/{id}` | none, `@Public()` | A payment as its payer sees it: what to transfer, to whom, on which contracts |
| `POST /v1/zk-checkout/{id}/confirm` | none, `@Public()` | Settle it with the two transfers (three with a merchant fee), verified on-chain |

## Aliases — claimable payment handles

An alias lets a payer type `emanuel250` instead of `GA5ZSE…`. Payers trust that
name right before sending money, so the rules below are strict: a mistake means a
payment to the wrong account.

### Claimed by proving control of a key, not by asking

```
wallet ──1. POST /v1/aliases/challenges {name, address, network} ──▶ nonce + the EXACT message to sign
wallet ──2. signs SHA-256(domain ‖ 0x00 ‖ uint32be(length) ‖ message) with that address's key
wallet ──3. POST /v1/aliases {name, email, nonce, signature} ────────▶ alias bound to the calling consumer
```

- **Sign the exact message the service returns.** Do not rebuild it on the
  client.
- **The signature covers a domain-tagged digest, never a transaction.** Nothing
  signed in this flow can be submitted to the network, and the domain
  (`Cosmos Pay alias claim v1`) is unique to this feature, so a signature obtained
  by another dapp cannot be used as a claim.
- **The purpose is inside the signed bytes** (`CLAIM`, `ADD_ADDRESS`, `RECOVER`),
  so a signature collected to add an address cannot be replayed to finish a
  recovery.
- **The address comes from the challenge, not from the claim body.** The claim
  has no address field, so nobody can sign for one address and register another.
- **Challenges are single-use and last five minutes.** The signature is verified
  *before* the challenge is spent, so an invalid signature cannot consume someone
  else's nonce, and spending it is a compare-and-swap.
- **A race is settled by the unique index on `alias.name`**, not by a pre-check;
  the loser gets `409 alias_taken`.

### What a handle may be

Lowercase `a-z`, `0-9` and `_` (never at either end), 3–32 characters, folded to
lowercase before uniqueness is decided. No Unicode: a homoglyph set is unbounded,
and no normalization makes a Cyrillic `а` safe to render next to an amount. Also
refused: reserved words (`admin`, `support`, `cosmospay`, `stellar`, …) and
anything that looks like a Stellar account (`g` or `m` followed by 20 or more
base32 characters). The rule is in `src/aliases/alias-name.ts`.

### Many addresses, one name

An alias points at up to 20 addresses across networks — a phone, a desktop, a cold
wallet, testnet — with exactly one primary per network, enforced by a partial
unique index. Adding an address takes **two** proofs: the caller owns the alias,
and the new address signs its own `ADD_ADDRESS` challenge. The last remaining
address cannot be removed (release the alias instead), and one consumer may hold
at most 25 aliases.

A `SUSPENDED` alias (an operator hold) resolves to nothing.

### Recovery goes through email, sent by this service

A claim records a recovery email so that losing a key does not mean losing the
name. Recovery works like this:

1. The wallet (any `payments:write` key, the shared public key included) calls
   `POST /v1/aliases/:name/recovery {email}`. The answer is always
   `{ accepted: true }`, whether or not the handle and mailbox matched; on a match
   this service **emails** a single-use token (30 minutes, stored only as a
   SHA-256) to the mailbox on record. The token never appears in a response.
2. The user gets a `RECOVER` challenge for the new key and calls
   `POST /v1/aliases/:name/recovery/complete {token, address, network, nonce, signature}`
   with their own API key. Both proofs are required: the token proves the mailbox,
   the signature proves the key.
3. Ownership moves to the calling consumer and **every previous address is
   removed**, so whoever holds the old keys stops receiving payments.

Starting a recovery is open to any caller because the token only ever reaches the
mailbox: all a stranger can do is make the owner receive an email. That is bounded
twice — 5 starts per 10 minutes per address (`429 rate_limited`), and at most one
email per alias per minute, whoever asks (a repeat inside that minute answers the
same and sends nothing). A deployment with no mail sender answers
`503 misconfigured`. A suspended alias cannot be recovered.

A recovery token can be presented **five** times. A presentation whose challenge
or signature fails still uses one, and the sixth is refused; the owner can start
another recovery. A token that matches no live recovery of that alias gets the
same `400 alias_recovery_invalid` and changes nothing, so nobody can burn an
owner's recovery by sending junk. `POST /v1/aliases/:name/recovery/complete`
allows 10 calls and `POST /v1/aliases/challenges` 30 calls per 10 minutes, per
consumer and client address (`429 rate_limited`).

Expired challenges and recoveries are deleted a day after they expire by
`AliasChallengeSweeperService` (hourly, one replica per tick).

### Addresses on Solana and Monad

An alias can point at Solana and Monad accounts beside Stellar ones.
`POST /v1/aliases/challenges`, `POST /v1/aliases/{name}/addresses` and
`POST /v1/aliases/{name}/recovery/complete` take an optional `chain`; the challenge
message then carries a `chain:` line, which binds the signature to that chain.
Stellar still signs the framed digest; Solana signs the challenge text with
ed25519, Monad with EIP-191 `personal_sign`. The default address is per chain and
network, so adding a Solana address never demotes a Stellar one.
`GET /v1/aliases/resolve/{name}` resolves on Stellar unless `?chain=` names another
chain — a wallet that does not ask for one is never handed an address it cannot
pay — and `GET /v1/aliases/by-address/{address}` reads the chain off the address's
own shape. A Monad address is stored and matched in its EIP-55 spelling.

### Routes

| Method | Path | Scope | Description |
| ------ | ---- | ----- | ----------- |
| GET | `/v1/aliases/resolve/:name` | `payments:read` · public key | The addresses an alias resolves to (`?network=` filters) |
| GET | `/v1/aliases/availability/:name` | `payments:read` · public key | Whether a handle is claimable, and if not why |
| GET | `/v1/aliases/by-address/:address` | `payments:read` · public key | The aliases pointing at an address |
| POST | `/v1/aliases/challenges` | `payments:write` | A nonce and the exact message to sign |
| POST | `/v1/aliases` | `payments:write` | Claim an alias with a signature |
| GET | `/v1/aliases` | `payments:read` | The caller's aliases |
| POST | `/v1/aliases/:name/addresses` | `payments:write` | Add an address, signed by that address |
| DELETE | `/v1/aliases/:name/addresses/:addressId` | `payments:write` | Remove an address |
| DELETE | `/v1/aliases/:name` | `payments:write` | Release the alias |
| POST | `/v1/aliases/:name/recovery` | `payments:write` | Start a recovery → the token is emailed to the owner |
| POST | `/v1/aliases/:name/recovery/complete` | `payments:write` | Finish a recovery with the token and the new key's signature |

## BlindPay — onramp / offramp / KYC (fiat ⇄ stablecoin)

> **A native plugin.** Everything in this section is the `blindpay` plugin
> (`src/native-plugins/blindpay/`), served only when `PLUGINS_ENABLED` lists
> `blindpay` — see *Native plugins: BlindPay and DeFindex*. BlindPay settles on
> Stellar, Solana, EVM chains (Ethereum, Base, Arbitrum, Polygon) and Tron;
> **Monad is not a BlindPay network**, so there is no fiat on/off-ramp on it.

In addition to on-chain payment intents, the service integrates
[BlindPay](https://www.blindpay.com/docs) to move money between **fiat and
stablecoins**: cash in (**onramp / payin**), cash out (**offramp / payout**), and
the mandatory **KYC** (BlindPay *receivers*) behind both. We run **one platform
BlindPay instance per API-key environment** — production for `prod` keys
(`BLINDPAY_API_KEY` + `BLINDPAY_INSTANCE_ID`), development for `dev` keys (the
`_DEV` variables); every receiver/wallet/bank-account/payin/payout is mirrored in our Postgres and
**scoped to the calling APISIX consumer**, so each integrator only ever sees their
own records. The service **never holds blockchain keys** — offramp returns the
artifact to sign (EVM `approve` contract / Stellar XDR) and accepts the signed tx
back, exactly like payment intents.

State changes are synced from BlindPay's **Svix webhooks** (verified over the raw
body) and **re-emitted** to the integrator's own webhook endpoints as new event
types (`RECEIVER_UPDATED`, `PAYIN_*`, `PAYOUT_*`) through the existing dispatcher.

**A payin or payout is recorded before BlindPay is asked to create it.**
`POST /v1/onramp/payins` and `POST /v1/offramp/payouts` first write a row in
`pending_provider` carrying the quote and its execution key, then call BlindPay
with that key as `Idempotency-Key`, then fill in the provider id. A timeout, or a
failed write after the call, therefore leaves a row rather than a payment nobody
here knows about: retrying the same create with the same quote reuses the row and
replays the key, and BlindPay's webhook fills the row in by `quote_id`. Tenant
reads leave such rows out until they have a provider id. One still without an id
after an hour becomes `provider_unconfirmed` and is logged for an operator —
nothing re-sends the create, since the caller may have paid through another quote
meanwhile. A BlindPay refusal (any 4xx but 408 and 409) removes the row.

**A webhook that matches no row is not dropped.** A payin or payout event is
attributed through the quote it executed — to the consumer that minted it —
and the mirror is created or repaired there. An event that still cannot be
attributed is acknowledged but kept open, and the BlindPay reconciler (on with
`OBSERVER_ENABLED`, once a minute, on one replica at a time) re-reads it from
BlindPay for seven days, logging its `svix-id` on every miss so the delivery can
be replayed from the Svix dashboard. The same reconciler re-reads open payins and
payouts whose webhooks went quiet and repairs their status. `PAYIN_COMPLETED` and
`PAYOUT_COMPLETED` go out once per payin or payout, whichever path sees the
completion first — the webhook, a resend under a new `svix-id`, or the reconciler.

| Method | Path                                                  | Scope          | Description |
| ------ | ----------------------------------------------------- | -------------- | ----------- |
| POST   | `/v1/kyc/receivers`                                   | `kyc:write`    | Create a receiver (start KYC/KYB) |
| GET    | `/v1/kyc/receivers` · `/:id`                          | `kyc:read`     | List / get (get refreshes KYC status) |
| PATCH  | `/v1/kyc/receivers/:id`                               | `kyc:write`    | Update a receiver (once it is at BlindPay, identity fields need an elevated key) |
| DELETE | `/v1/kyc/receivers/:id`                               | `kyc:write`    | Delete a receiver |
| POST   | `/v1/kyc/upload`                                      | `kyc:write`    | Upload a KYC document → `file_url` |
| GET    | `/v1/kyc/rails` · `/v1/kyc/bank-details?rail=`        | `kyc:read`     | Rail catalog / required fields |
| POST   | `/v1/kyc/receivers/:id/wallets`                       | `kyc:write`    | Register a blockchain wallet |
| GET    | `/v1/kyc/receivers/:id/wallets/sign-message`          | `kyc:read`     | Message to sign (secure EOA flow) |
| POST   | `/v1/kyc/receivers/:id/bank-accounts`                 | `kyc:write`    | Add a fiat bank account (any rail) |
| POST   | `/v1/onramp/quotes`                                   | `onramp:write` | Price a payin (expires ~5 min) |
| POST   | `/v1/onramp/payins`                                   | `onramp:write` | Create a payin → funding instructions |
| GET    | `/v1/onramp/payins` · `/:id`                          | `onramp:read`  | List / get (get refreshes status) |
| POST   | `/v1/onramp/trustline`                                | `onramp:write` | Build an unsigned Stellar trustline XDR |
| POST   | `/v1/onramp/receivers/:id/virtual-accounts`           | `onramp:write` | Create a virtual account |
| POST   | `/v1/offramp/quotes`                                  | `offramp:write`| Price a payout (EVM → `approve` contract) |
| POST   | `/v1/offramp/payouts/authorize`                       | `offramp:write`| Build the unsigned Stellar/Solana payout tx |
| POST   | `/v1/offramp/payouts`                                 | `offramp:write`| Create a payout from a quote |
| GET    | `/v1/offramp/payouts` · `/:id`                        | `offramp:read` | List / get (get refreshes status) |
| POST   | `/v1/offramp/payouts/:id/documents`                   | `offramp:write`| Attach a compliance document |
| POST   | `/v1/blindpay/webhooks`                               | _public_       | Inbound BlindPay (Svix) webhook |

Amounts are **integers in minor units** (e.g. `$123.45` → `12345`). Configure
the BlindPay dashboard webhook to `<gateway>/v1/blindpay/webhooks` and set
`BLINDPAY_WEBHOOK_SECRET` to that endpoint's signing secret — the whole
`whsec_…` value. Boot fails when its key decodes to fewer than 24 bytes, and the
verifier refuses such a key regardless: invalid base64 decodes to an empty key,
and anyone can sign with that. Leave the
`BLINDPAY_*` vars blank to disable the feature: those routes then return `503`
`misconfigured`, and so does the inbound webhook while `BLINDPAY_WEBHOOK_SECRET`
is unset. See `.env.example`.

**A `dev` key never reaches the production instance.** The key's environment picks
the BlindPay instance the way it picks the Stellar network, and every mirrored row
records the instance it came from, so a tenant's `dev` and `prod` keys — one
consumer — see separate receivers, wallets, bank accounts, quotes, payins and
payouts. With no development instance configured, BlindPay routes answer `dev`
keys with `503` `misconfigured`. Point both instances' dashboard webhooks at the
same `<gateway>/v1/blindpay/webhooks` and set `BLINDPAY_WEBHOOK_SECRET_DEV` for
the development one: the secret a delivery verifies against is what says which
instance sent it.

**Identity is reviewed before it reaches BlindPay, including edits.** Until a
receiver is enabled, a `PATCH` that touches KYC data sends it back to
`pending_review`. Once it exists at BlindPay, a tenant key may change only
`external_id` and `image_url`; any other field is `403` `kyc_review_required`
unless the key is elevated (`X-Consumer-Role: admin`), because that `PUT` rewrites
the identity at the provider directly.

**An approval is pinned to the dossier that was reviewed.** A receiver read
carries `dossierVersion`, which counts every edit to the submitted KYC data.
Send it back as `expected_version` when approving, and data that changed since
you read it is `409 kyc_state_invalid` rather than an approval of a dossier
nobody saw — an edit leaves the status at `pending_review`, so the approval
itself could not tell. What was signed off is kept as `reviewedVersion`, and
`POST /v1/kyc/receivers/:id/enable` refuses to create the receiver at BlindPay
while the two differ.

**The fiat routes have budgets.** Every write the provider keeps is limited per
consumer and client address, and every BlindPay-backed route also counts against
a per-consumer ceiling of **60 provider requests a minute**: one instance serves
every tenant on the key, so a tenant looping quotes fails other tenants' payins.
Over budget is `429 rate_limited` with `Retry-After`.

| Route | Budget (per consumer + client address) |
| ----- | -------------------------------------- |
| `POST /v1/kyc/upload` | 20 per 10 min |
| `POST /v1/kyc/terms-of-service` | 10 per 10 min |
| `POST /v1/onramp/quotes` · `POST /v1/offramp/quotes` | 30 a minute, separate buckets |
| `POST /v1/onramp/payins` | 10 a minute |
| `POST /v1/offramp/payouts/authorize` · `POST /v1/offramp/payouts` | 10 a minute, shared |
| `POST /v1/offramp/payouts/:id/documents` | 20 per 10 min |
| `POST /v1/onramp/trustline` | 20 a minute |

### KYC redirect URLs are allow-listed per consumer

The terms-of-service flow sends the user to BlindPay and back to a `redirect_url`
the integrator supplies. To avoid an open redirect, every `redirect_url` passes
two checks:

| Layer | Rule | Where |
| ----- | ---- | ----- |
| Shape | an absolute `https` URL with no embedded credentials (`user:pass@`), no fragment (`#…`), and no backslash, whitespace or control character | `@IsRedirectUrl()` on every DTO that carries one, and again in the service layer |
| Host | on **the calling consumer's** allow-list — the exact host, or a subdomain at a label boundary (`app.acme.com` matches `acme.com`; `evilacme.com` does not) | `KYC_REDIRECT_URL_WHITELIST`, enforced in the service layer |

```
KYC_REDIRECT_URL_WHITELIST={"cosmos_acme":["acme.com","app.acme.com"]}
```

The shape rules are what the host check is worth. A backslash is read as `/`
inside the authority by a WHATWG parser and as part of the userinfo by others, so
`https://app.acme.com\@evil.test` has two honest readings and this service is not
the last to read it — the value goes to BlindPay, comes back on a hosted page and
ends in a browser. Whitespace and control characters are the same class, a
fragment swallows the `?tos_id=` the provider appends, and credentials move the
host to the far side of the `@`.

It **fails closed**: a consumer with no entry cannot use a redirect at all, and a
host with a trailing dot or in IDN form is refused rather than normalized. Every
route that takes a `redirect_url` checks it, including the admin approval, which
uses the list of the receiver's own consumer. A refused scheme or host is a
`400`.

## Plugins — extensions under a slug

Other teams integrate their technology into this service as a **plugin**: a folder
under `plugins/`, served at `/v1/plugins/<slug>/…`, that works with a tenant's
customers, products and payment intents without ever touching the core directly.
The goal is that a plugin can be wrong — buggy, slow, greedy — without the core
being wrong with it.

### A plugin is a folder

Every plugin lives in **one folder**, `plugins/` at the repository root — the ones
Cosmos Pay support ships and the ones an operator installs. A plugin is three
readable files, and none runs until its slug is listed in `PLUGINS_ENABLED`:

```
plugins/
  README.md
  example/
    plugin.json       what the plugin is, and what it may touch
    index.ts          what it does — plain TypeScript, no build step
    signature.json    who vouches for the two files above
```

`plugin.json` says what the plugin is and what it may touch — the file a reviewer and a tenant read first:

```json
{
  "slug": "example",
  "name": "Example: payment notes",
  "version": "1.0.0",
  "description": "Keeps a timeline of notes per payment intent.",
  "author": "Cosmos Pay support",
  "capabilities": ["payment_intents:read"],
  "egress": [],
  "config": { "label": { "type": "string", "description": "Prefix for every note." } }
}
```

`index.ts` is the code: plain TypeScript, transpiled when the service boots. Its only import is the SDK (`@/plugins/sdk`):

```ts
import { defineHandlers, PluginError, requireString } from '@/plugins/sdk';

export default defineHandlers({
  queries: {
    'get-notes': async (ctx, input) => {
      const id = requireString(input, 'paymentIntentId');
      return { notes: (await ctx.storage.get('notes', id)) ?? [] };
    },
  },
  commands: {
    'add-note': async (ctx, input) => { /* … */ },
  },
  events: {
    PAYMENT_INTENT_SUCCEEDED: async (ctx, event) => { /* … */ },
  },
});
```

`example` is preinstalled and disabled: a reference plugin that uses a query, a
command, an event and a tenant setting. Start there.

### Writing one

```sh
npm run plugins -- new my-plugin          # plugins/my-plugin/ from a template
npm run plugins -- check my-plugin        # compile, load and validate it
PLUGINS_ENABLED=my-plugin PLUGINS_ALLOW_UNSIGNED=true npm run start:dev
npm run plugins -- sign my-plugin --key support.pem --key-id cosmos-support
```

`check` compiles the plugin and runs every validation the server runs at boot.
`PLUGINS_ALLOW_UNSIGNED=true` lets it run unsigned while you work locally, and is
refused when `NODE_ENV=production`. Open a pull request with the folder; once it is
reviewed, support signs it and it ships preinstalled.

Signing never runs the plugin's code — only `check` does, and CI runs it on every
pull request — so a pull request cannot get its code executed on the machine that
holds the support key. Sign what review and CI have already passed.

### What a plugin can and cannot reach

A plugin's handlers receive a `PluginContext` and nothing else — no Prisma, no Nest
provider, no `process.env`, no socket:

| `ctx.` | Reaches | Bounded by |
| ------ | ------- | ---------- |
| `storage` | the plugin's own records (`plugin_record`), for this installation only | 16 KiB per value, 10 000 records per installation |
| `core.customers`, `core.products` | list / get / create / update, through the core's own services and DTOs | the capability granted (`customers:read`, `customers:write`, …); there is no delete |
| `core.paymentIntents` | list / get, read-only | `payment_intents:read`; nothing that signs or moves money |
| `http` | HTTPS on port 443 to the hosts in `egress` | public addresses only (the webhook SSRF rules), socket pinned to the checked address, no redirects, 1 MiB responses |
| `installation.config` | the tenant's settings; secret ones decrypted for this call only | — |

What the runtime guarantees around every invocation:

- **Tenant isolation.** The context is built from the calling consumer and its
  installation; no method takes a consumer or installation id.
- **Projections, not rows.** Core reads come back as a fixed projection — no
  `consumerId`, no `xdr`/`uri`, no provider payloads — copied and frozen.
- **The core's validation still applies.** Writes go through the same DTOs the HTTP
  routes validate with; unknown fields are refused.
- **Queries cannot write.** A query is callable with `plugins:read`, so inside one
  every storage and core write refuses.
- **Budgets.** 10 s per invocation, 200 context calls, 64 KiB of input, 256 KiB of
  output. When time runs out the caller gets `504 plugin_failed` and the context is
  revoked, so work left running cannot write afterwards.
- **Failures stay contained.** A `PluginError` is `400 plugin_rejected` with its
  message; anything else is `502 plugin_failed`, logged and never echoed. A plugin
  failing on an event disturbs neither the webhook of that event nor other plugins.
- **Isolation.** Plugin code never runs in this process. Every invocation gets a
  fresh V8 isolate (`isolated-vm`) with no Node inside — no `process`, `require`,
  network, file system or timers — a 32 MB heap, and a thread of its own. Its only
  way out is a bridge that accepts the context method names above, with JSON copies
  in and out; no object of this process ever reaches it, so code written to escape
  finds nothing to climb from. When the budget ends the isolate is disposed, which
  stops the plugin wherever it is — a synchronous loop included — and nothing it
  kept in memory survives into the next call, another tenant's included. ESLint
  additionally lets `plugins/**/*.ts` import only the SDK.

### Who vouches for a plugin

A plugin runs only if a trusted key signed exactly its `plugin.json` and `index.ts`
under its slug and version (`signature.json`). Change one character of code or one
capability and the signature fails — the boot stops. Formatting of `plugin.json` and
line endings do not count as changes.

- **Preinstalled by support.** Support's public keys are in the code
  (`PLUGIN_SUPPORT_KEYS`), so a plugin support signed and committed to `plugins/`
  loads on every deployment with no configuration. `plugins/` is under
  `.github/CODEOWNERS`, and CI checks every folder in it is signed and valid.
- **Installed by hand.** Anything else is installed from a registry — any static HTTPS
  host — and must be signed by support or by a key in `PLUGINS_TRUSTED_KEYS`:

```sh
npm run plugins -- install acme@1.0.0 --registry https://plugins.example.com
# then add "acme" to PLUGINS_ENABLED and restart
```

The registry is not trusted: `install` verifies the signature before writing
anything, and the server verifies it again at every boot.

### Installing is consent

A plugin runs for a tenant only after that tenant installs it with
`PUT /v1/plugins/{slug}/installation`, sending `grantCapabilities` equal to the list
in `plugin.json` — not a subset, not a superset (`400 plugin_consent_mismatch`). When a
later version declares more, the installation keeps its old consent and every action
answers `409 plugin_not_installed` until the tenant installs again
(`installation.pendingCapabilities` shows the difference). Uninstalling deletes every
record the plugin kept for that tenant. Settings marked `secret` are sealed under
`PLUGINS_SECRET` and never returned.

### Plugin routes

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/v1/plugins` | The plugins this deployment serves, with the caller's installations |
| GET | `/v1/plugins/{slug}` | One plugin: capabilities, egress, settings, actions, installation |
| PUT | `/v1/plugins/{slug}/installation` | Install, re-consent or reconfigure |
| DELETE | `/v1/plugins/{slug}/installation` | Uninstall, deleting the plugin's records |
| POST | `/v1/plugins/{slug}/queries/{action}` | Run a read-only action (`plugins:read`) |
| POST | `/v1/plugins/{slug}/commands/{action}` | Run an action that writes (`plugins:write`) |

No plugin route admits the shared public key: a plugin acts on one tenant's data.
The two action routes share a budget of 120 requests per minute per consumer.

### Native plugins: BlindPay and DeFindex

Some integrations are not the chain itself — a fiat provider, a DeFi protocol — and
need what the sandbox withholds on purpose: tables of their own, inbound webhooks,
deployment-wide credentials. They are **native plugins**: Nest modules compiled into
the service under `src/native-plugins/<slug>/`, switched on by the same
`PLUGINS_ENABLED` list as sandboxed plugins.

| Slug | What it serves |
| ---- | -------------- |
| `blindpay` | KYC, onramp, offramp, the BlindPay webhook, its `/v1/admin` routes (`receivers`, `payins`, `payouts`) and the `fiat` section of the admin summary |
| `defindex` | `/v1/defindex` — DeFindex vaults on Stellar |

- **Not listed, not there.** A native plugin `PLUGINS_ENABLED` does not name is
  never instantiated: its routes answer 404, its jobs never start and its variables
  are not validated. The boot warns when its keys are set but its slug is not.
- **The core never imports a plugin.** Lint refuses `@/native-plugins/*` anywhere
  in `src/` except `src/native-plugins/native-plugins.module.ts`, and refuses one
  plugin importing another. Where the core needs a plugin's data — the admin
  overview — it exposes an extension point (`AdminExtensions`) the plugin
  registers into.
- **Not sandboxed, and not per tenant.** A native plugin is reviewed code with the
  core's privileges; it is not installed per tenant, and its routes keep their own
  scopes (`kyc:*`, `onramp:*`, `offramp:*`, `liquidity:*`). A sandboxed plugin may
  not take a native slug.
- **The OpenAPI contract documents every native plugin's routes**, enabled or not:
  `openapi:generate` turns them all on.

## Upgrading — breaking changes and deploy notes

### Easy recovery: a new module, a new table, and `details` on the error envelope

- **New routes** under `/v1/wallet/easy-recovery` (`payments:read` /
  `payments:write`, the shared public key allowed): moving a wallet between two
  devices, described under
  [Easy recovery](#easy-recovery-moving-a-wallet-between-two-devices). No existing
  route changed, and the gateway's existing route already serves them.
- **Migration `20261028200000_easy_recovery_sessions`** creates the
  `easy_recovery_session` table and the `EasyRecoveryStatus` enum; nothing is
  rewritten. Run `migrate deploy` before the new build serves.
- **The error envelope may carry `details`**, only on the codes that document it
  (today `easy_recovery_code_invalid`, with `attemptsLeft`). A new optional field:
  every other error is unchanged.
- **No new variables.** A new sweeper deletes expired sessions on the
  `WALLET_AUTH_SWEEP_ENABLED` / `WALLET_AUTH_SWEEP_INTERVAL_MS` schedule, under
  its own advisory lock (`881_015`).

### Payments: when the checkout last saw a link; swaps' settled volume in USD

- **Migration `20261027180000_payment_checkout_seen`:** a nullable `checkoutSeenAt` column on
  `payment_intent`; nothing is rewritten. Run `migrate deploy` before the new build serves.
- **Payment intents answer `checkoutSeenAt`:** when the hosted checkout last read the intent
  while it was open (pending or submitted). The page polls `GET /v1/payment-links/{id}` while
  a payer has it open, so a value from the last 30 seconds means someone is on the payment
  page now. Written at most every 10 seconds, without touching `updatedAt`.
- **`GET /v1/summary/series` values the swaps:** `swaps.buckets[].volumeUsd`,
  `swaps.totals.volumeUsd` (with `unpriced`) and `swaps.previous.volumeUsd`, what the
  completed swaps sold in USD at NEAR Intents' current prices.
- **The hosted checkout reports the payer's wallet:** `POST /v1/payment-links/{id}/events`
  (`@Public()`, budgeted per client address) takes `walletOpened`, `walletClosed` or `sent`, and
  intents answer them as `checkoutWalletAt`, `checkoutWalletClosedAt` and `checkoutSentAt`.
  Informational only: the status still changes on the chain. Migration
  `20261027190000_payment_checkout_events` adds the three nullable columns.

### Customers: wallets on several chains instead of one account

- **A customer holds wallets** (`wallets`: `chain`, `address`, `label`), as many as it
  needs up to 20, on Stellar, Solana or Monad. `POST /v1/customers` takes `wallets`; the new
  routes `POST /v1/customers/{id}/wallets` and `DELETE /v1/customers/{id}/wallets/{walletId}`
  add and remove one. A wallet belongs to one customer of a merchant: one another customer
  already holds answers `409 customer_wallet_taken` (a new error code).
- **`account` is deprecated, not removed.** Responses keep it as the first wallet's address
  (null without wallets). On create it adds a wallet; on `PATCH` an address replaces the
  first wallet (or adds one) and null removes it, as it edited the one account before.
  `PATCH` does not take `wallets`.
- **`payments`, `succeeded` and `total` add up every wallet** of a customer, each on its
  own chain and the key's network.
- **Migration `20261027120000_customer_wallets`:** a `customer_wallet` table; every stored
  `account` becomes its customer's first wallet, on the chain its shape names, then the
  `account` column is dropped. When two customers of one merchant held the same account,
  the older keeps it; an account that could not move is appended to the customer's `note`
  as `Previous account: ...`.
- **A settled payment's payer is matched by wallet and chain:** a payer already among a
  customer's wallets is not added again; a new one becomes an automatic customer with that
  wallet.

### Merchant fee: `merchantFee` on swaps, and a nullable column on seven tables

- **New, additive:** `merchantFee` on `POST /v1/swaps` (Stellar), `/v1/swaps/quote`,
  `POST /v1/cross-chain-swaps` and its quote; see **Merchant fee**. Responses gain a
  nullable `merchantFee` (quotes, beside `fee`). A request without one builds exactly
  what it built before.
- **Migration `20261026150000_merchant_fee`:** a nullable `merchantFee` JSONB column on
  `payment_intent`, `swap`, `chain_swap`, `cross_chain_swap`,
  `liquidity_pool_operation`, `zk_payment` and `usdt0_transfer`. No backfill: existing
  rows read as no fee.
- **New error code `merchant_fee_unsupported`** (400): a merchant fee on a Solana or
  Monad swap.
- **Stellar payment links take `merchantFee` too** (`POST /v1/payment-intents/tx` and
  `/pay`; a `pay` link needs an `amount`). Solana and Monad links answer
  `merchant_fee_unsupported`. Responses and the public link gain `merchantFee`; the
  public link also `payerAccountRequired`.
- **New route `POST /v1/payment-links/{id}/transaction`** (`@Public()`): the envelope
  the payer of a Stellar link with a merchant fee signs. **Deploy step:** APISIX's
  keyless route for `/v1/payment-links/*` must allow `POST` (and its CORS plugin
  `POST` with `Content-Type`), or the checkout cannot build it.
- **New variable `PAYMENT_LINK_CHECKOUT_URL`** (default
  `https://payments.cosmospay.lat`): where such a link's `uri` points.
- **Solana payment links take `merchantFee`** (with an `amount`): the link is a Solana Pay
  transaction request on the new keyless routes `GET` / `POST
  /v1/payment-links/{id}/solana-pay` (`@Public()`, budgeted per address), which the
  gateway's keyless payment-links route serves. **New variable `PAYMENT_LINK_API_URL`**
  (default `WALLET_AUTH_PUBLIC_BASE_URL`).
- **Monad payment links take `merchantFee`** with deposit addresses: a new contract,
  `contracts/PaymentSplitForwarder.sol` (artifact `src/evm/payment-split-forwarder.artifact.ts`,
  built by `npm run contracts:compile` beside the untouched PaymentForwarder). Migration
  `20261026190000_evm_deposit_merchant_fee` adds `feeWallet` and `merchantFee` to
  `evm_deposit_address` (null on every existing address, which stays a PaymentForwarder).
- **Solana swaps take `merchantFee`**: the fee's transfer is appended to Jupiter's
  transaction (`src/solana/solana-message.ts` reads and rewrites a v0 transaction; the
  lookup tables are read through the Solana RPC). Monad swaps still answer
  `merchant_fee_unsupported`.
- **Private payments take `merchantFee`**: a third confidential transfer to the fee's
  wallet. `POST /v1/zk-checkout/{id}/confirm` takes `merchantFeeTxHash` (required exactly
  when the payment has a merchant fee); new error code `merchant_fee_transfer_mismatch`;
  responses gain `merchantFee`, and the owner's view `merchantFeeTxHash`. Migration
  `20261026210000_zk_payment_merchant_fee_tx` adds a nullable, unique `merchantFeeTxHash`
  to `zk_payment`.
- **A merchant fee that rounds to nothing is refused** on every operation
  (`400 invalid_amount`), where a Stellar one used to build a payment of zero.
- **Liquidity operations take `merchantFee`** (`POST /v1/liquidity-pools/deposit` and
  `/withdraw`): `bps` of each asset, one payment per asset in the same transaction;
  `fixed` is refused. Responses and webhooks gain `merchantFee`, whose `amountB` /
  `assetB` are asset B's leg.
- **Monad swaps take `merchantFee`** once `KURU_MERCHANT_FEE_ROUTER` names a deployed
  `contracts/MerchantFeeSwapRouter.sol` (artifact `src/evm/merchant-fee-swap-router.artifact.ts`).
  **Deploy step:** deploy the artifact's bytecode followed by Kuru Flow's router address as
  a 32-byte word, from any account (the contract has no owner), and set the variable. Such
  a swap's wallet approves the router, not Kuru. Without it, Monad swaps still answer
  `merchant_fee_unsupported`.
- **USDT0 transfers take `merchantFee`** once `USDT0_FEE_WRAPPER` names a
  deployed `contracts/soroban/usdt0-fee-wrapper` (wasm committed beside the crate, pinned by
  `USDT0_FEE_WRAPPER_WASM_SHA256`). **Deploy step:** the `stellar contract deploy`
  command in the USDT0 section, then set the variable. Responses gain `merchantFee`.
  Without it, `merchant_fee_unsupported`.
- **USDT0 transfers charge the plan commission** through the fee wrapper
  (`USDT0_FEE_WRAPPER`, whose `send` takes a list of fees): `feeBps` of `amount` to
  `STELLAR_SWAP_FEE_WALLET`, which must trust USDT0. Migration
  `20261026230000_usdt0_commission` adds `feeBps`, `feeAmount` and `feeWallet` to
  `usdt0_transfer`; transfers and quotes answer them. Without the wrapper, no commission,
  as before.

### Lists follow the key's network; dashboard reads are cached

- **Every list is scoped to the network the key targets** (an API behaviour fix):
  `GET /v1/payment-intents`, `/v1/swaps` (with `?chain=` too), `/v1/cross-chain-swaps`,
  `/v1/usdt0/transfers`, `/v1/liquidity-pools/operations` and `/v1/zk-payments` answer only
  the rows of the key's network, in the page and in `total`, as `/v1/summary` always did. A
  production key no longer sees test-network payment intents (the dashboard on Production
  listed them), nor a sandbox key mainnet ones. Solana and Monad swaps, cross-chain swaps
  and USDT0 transfers are mainnet only, so a sandbox key lists none. Reading one row by its
  id is unchanged.
- **`/v1/summary`, `/v1/summary/series` and `/v1/balances` are reused per consumer and
  network for `ANALYTICS_CACHE_TTL_MS`** (10 s by default; `0` turns it off), and identical
  calls that arrive together share one computation. A figure can lag a new payment by up to
  that long, and each replica keeps its own cache. The logs are not cached.
- **NEAR Intents' token list is fetched at boot and refreshed in the background**: past its
  five-minute TTL the list on hand is served (for up to an hour) while one fetch replaces it,
  so the USD figures and the cross-chain asset list no longer wait about 0.8 s for 1Click
  every five minutes. `NEAR_INTENTS_TOKENS_PREFETCH=false` skips the boot fetch. No
  migration.
- **`GET /v1/summary/series` answers a `zkPayments` part**: private payments per bucket
  (`count`, `succeeded`, `expired`, `volume`, `volumeUsd`) and in both windows (with
  `fees` and `feesUsd` as well), on the key's network like every other part. Amounts are
  XLM, valued at XLM's price; `expired` counts a pending payment past its deadline, as every
  read of them does. Additive: no field changed or left. No migration.

### Dashboard: settled volume in USD

- **`GET /v1/summary` and `GET /v1/summary/series` value the settled volume in USD.**
  `volume` still adds every asset's amount; beside it `/v1/summary` answers `amountUsd`
  on each `volume` row plus `volumeUsd` and `unpriced`, and the series answers
  `volumeUsd` on each payments bucket and `volumeUsd` and `unpriced` on `totals` and
  `previous`. Additive: no field changed or left.
- **Each asset is valued at NEAR Intents' current reference price** (its token list, the
  one `GET /v1/cross-chain-swaps/assets` reads, cached for minutes): an indicative figure
  at today's price, not the price on the day of each payment. A mainnet token is priced
  only by its contract (on Stellar its code and issuer), so a token NEAR Intents does not
  list counts in `unpriced` instead; a sandbox payment is valued as its mainnet namesake
  (testnet XLM at XLM's price).
- **Prices never fail the dashboard.** When NEAR Intents' list cannot be read within
  2.5 s (`USD_PRICES_WAIT_MS`), the USD fields are null (a quiet bucket stays `"0.00"`)
  and everything else answers as before. No migration, no new variable; a deployment that
  blocks outbound calls to `NEAR_INTENTS_BASE_URL` gets null USD fields.

### USDT0 transfers, and public reads of one swap

- **New routes under `/v1/usdt0`** (`swaps:read` / `swaps:write`): USDT0 sent from
  Stellar to 21 EVM networks through LayerZero's OFT, mainnet only. What they do is
  under [USDT0 from Stellar](#usdt0-from-stellar-layerzero). No existing response
  changed.
- **`GET /v1/swaps/{id}` and `GET /v1/cross-chain-swaps/{id}` now admit the shared
  public key, with a record token**, so a swap made without an account can follow its
  own status. A create on that key now answers `publicToken`; the two reads,
  `GET /v1/usdt0/transfers/{id}` and `POST /v1/usdt0/transfers/{id}/submit` need it in
  `X-Record-Token` (or answer `404`). **Not breaking:** `POST /v1/swaps/{id}/submit`
  and `POST /v1/cross-chain-swaps/{id}/deposit`, which the wallet already calls with
  the public key, refuse a wrong token but still accept a missing one, logged as a
  deprecation. Wallets should start sending `X-Record-Token` from the create response;
  once they do, set `PUBLIC_RECORD_TOKEN_REQUIRED_ON_LEGACY=true` and those two routes
  require it too. Real keys are unaffected, and `GET /v1/swaps` and
  `GET /v1/cross-chain-swaps` stay closed to the public key. Deploy step: add
  `X-Record-Token` to the gateway's CORS `allow_headers`.
- **Migration `20261025210000_usdt0_transfers`** creates the `usdt0_transfer` table and
  the `Usdt0TransferStatus` enum; nothing is rewritten. Run `migrate deploy` before the
  new build serves traffic.
- **New variable `STELLAR_RPC_URL_MAINNET`**, optional: Stellar mainnet's Soroban RPC.
  Unset, the service uses Gateway.fm's public endpoint, which is rate limited; set a
  provider's in production.
- **`GET /v1/summary/series` counts USDT0 transfers as swaps** of a new kind, `usdt0`
  (in `swaps.totals.byKind` and in every swap figure), and answers `buckets` for
  liquidity operations and webhook deliveries as well; see the series note below.
  USDT0 transfers emit no webhook event yet.

### Swaps: the transaction adds the trustline its source lacks

- **`POST /v1/swaps` on Stellar no longer refuses a `source` that does not trust
  the asset it buys.** When the destination is the `source` (the default), the
  envelope starts with a `changeTrust` for that asset, before the fee payment and
  the path payment, and one signature covers both. It used to answer
  `400 trustline_missing`. A different `destination` without the trustline is
  still refused with `400 trustline_missing`, and the message now says only that
  account can add it (the same for a cross-chain swap's Stellar `recipient`).
- **New response field `trustline`** (`{ code, issuer }` or `null`) on the swap
  that create, the single read and submit return: the asset the transaction adds
  a trustline for. It is read from the stored envelope, so swaps built before this
  release answer `null` and an idempotent replay answers exactly as the first call
  did. `GET /v1/swaps` does not carry it, like `qr`.
- **New refusal `400 insufficient_balance`** when adding that trustline would leave
  the `source` below its new minimum balance (one more 0.5 XLM base reserve) after
  the XLM the swap sends and the network fee. The balance check of a liquidity
  deposit now also counts sponsorships and the XLM open offers hold, as the network
  does.
- **`POST /v1/payment-intents/tx` refuses an issued asset its `destination` does
  not trust** with `400 trustline_missing` (documented before, never enforced),
  reading the destination's account from Horizon to know. No migration and no new
  variable.

### Private payments: a new module, a new table and one webhook event

- **New routes** under `/v1/zk-payments` (`payments:read` / `payments:write`) and the
  keyless `/v1/zk-checkout` (`@Public()`): confidential payments on Cosmos Pay's
  confidential token, testnet only for now. What they do is under
  [Private payments](#private-payments-confidential-amounts-on-stellar). No existing response
  changed.
- **Migration `20261025180000_zk_payments`** creates the `zk_payment` table and the
  `ZkPaymentStatus` enum, and appends `ZK_PAYMENT_SUCCEEDED` to `WebhookEventType`;
  nothing is rewritten. Run `migrate deploy` before the new build serves traffic.
- **New webhook event `ZK_PAYMENT_SUCCEEDED`**, durable like the other settlement
  events. An endpoint subscribed to every event receives it; one with an explicit
  list does not until the event is added to it.
- **New variables**, all optional: the `ZK_PAYMENTS_TESTNET_*` set turns the feature
  on for `dev` keys (`npm run zk:deploy-testnet` writes it), and the boot refuses a
  half-configured set. `ZK_PAYMENTS_MAINNET_*` exists and stays unset.
- **New dependency** `stellar-confidential-token-sdk`, pinned to a commit of its
  GitHub repository (it is not on npm); `npm ci` builds its `dist/` through its
  `prepare` script. The server loads it lazily, on the first private-payment request.
- **Deploy step:** add `/v1/zk-checkout/*` to APISIX's keyless route, with CORS for
  `GET` and `POST`, exposing `Retry-After` and `ratelimit-*`, as for
  `/v1/payment-links/*`.

### Customers: an account on any chain, and stats on the key's network

- **`account` on `POST /v1/customers` and `PATCH /v1/customers/{id}` takes a Solana or
  Monad address** as well as a Stellar account, told apart by its shape. A Monad address is
  stored EIP-55 checksummed, as payment intents record a Monad payer. A Stellar account
  must now pass its StrKey checksum: a `G...` string that only looked like one, which the
  old pattern let through, is refused with `400`. No migration: stored accounts are
  unchanged.
- **`payments`, `succeeded` and `total` on `GET /v1/customers` count only the network
  the key targets** (`prod` → `public`, `dev` → `testnet`), and find the payer on any
  chain. They used to add both networks, so a sandbox key's list showed mainnet payments;
  the figures can drop for a consumer that is paid on both.

### Dashboard series: swaps, liquidity and webhooks beside payments

- **New route `GET /v1/summary/series`** (`payments:read`; `period` is `day`, `week`,
  `month` or `year`): the figures the dashboard's overview charts, in 30 days, 12 weeks,
  12 months or 5 years of UTC buckets (weeks start on Monday, a quiet bucket is a zero),
  with the window's totals and the window just before it, for growth. Payments carry
  their settled volume and distinct payers; swaps of every kind are counted per bucket
  and split by kind (`dex` for the Stellar DEX, `chain` for Jupiter and Kuru Flow,
  `crossChain` for NEAR Intents, `usdt0` for USDT0 sent from Stellar through
  LayerZero); liquidity operations (`liquidity.buckets`: `count`, `succeeded`, `failed`)
  and webhook deliveries (`webhooks.buckets`: `deliveries`, `failed`) are counted per
  bucket too, on the same buckets, besides their window totals. It only aggregates in
  Postgres: no migration, no new variable, and no existing response changed.
- **Each figure is scoped like the key's own data.** Payments, swaps and liquidity
  operations are the consumer's on the network its key targets (`prod` → `public`,
  `dev` → `testnet`), so a sandbox key counts no Solana, Monad or cross-chain swap and
  no USDT0 transfer: those run on mainnet only. Webhook deliveries are the consumer's on every endpoint,
  because an endpoint belongs to no network. `GET /v1/swaps`,
  `GET /v1/cross-chain-swaps` and `GET /v1/liquidity-pools/operations` do not filter by
  network, so their totals can be larger than the series'.
- **Succeeded, failed and in progress are one table per model** in
  `src/analytics/analytics.constants.ts`: a failed or expired swap or operation is
  failed, and so is a refunded cross-chain swap; a delivered USDT0 transfer is
  succeeded; anything not final is in progress. A new `SwapStatus`,
  `CrossChainSwapStatus` or `Usdt0TransferStatus` value does not compile until it is
  mapped there.

### Cross-chain swaps: every NEAR Intents network, and a nullable `depositUri`

- **`originChain` and `destinationChain` take 35 network ids**: `stellar`, `solana`
  and `monad` as before, and 1Click's codes for the rest (`eth`, `base`, `arb`, `op`,
  `bsc`, `pol`, `avax`, `gnosis`, `bera`, `scroll`, `xlayer`, `abs`, `plasma`, `hood`,
  `hypercore`, `btc`, `ltc`, `doge`, `bch`, `dash`, `zec`, `xrp`, `tron`, `ton`,
  `near`, `sui`, `aptos`, `movement`, `starknet`, `cardano`, `aleo`, `fogo`).
  Existing requests and stored rows are unchanged; `recipient` and `refundTo` are
  validated against the network named, and the chain enum grows in every
  cross-chain response.
- **`depositUri` can be `null`** in cross-chain swap responses and in the
  `CROSS_CHAIN_SWAP_*` webhooks, on a network with no wallet-link standard; `qr` then
  encodes `depositAddress`. A client that opens `depositUri` unconditionally must
  handle `null`.
- **A same-chain pair is quoted on every other network** (`eth` → `eth`). Stellar,
  Solana and Monad still answer `400` and point to `/v1/swaps`.
- **`GET /v1/cross-chain-swaps/assets` lists every network's tokens**, each with two
  new fields: `chainName` and `priceUsd` (indicative only, a few minutes old at most,
  never used to price). A client that refuses unknown response fields must be
  regenerated from the contract.
- **Migration `20261025120000_cross_chain_deposit_uri_nullable`** drops `NOT NULL`
  from `cross_chain_swap.depositUri`; nothing is rewritten. Run `migrate deploy`
  before the new build serves traffic: it writes `null` there.

### Payment intents: a checkout design per intent

- **New optional field `checkoutTheme`** (`classic`, `split`, `ticket` or `card`)
  on `POST /v1/payment-intents/tx`, `POST /v1/payment-intents/pay` and
  `PATCH /v1/payment-intents/{id}`, and in every payment-intent response and
  `GET /v1/payment-links/{id}`. Additive: a request without it behaves as before,
  and every existing intent answers `classic`. A client that refuses unknown
  response fields must be regenerated from the contract.
- **Migration `20261024120000_payment_intent_checkout_theme`** adds one nullable
  column, `payment_intent.checkoutTheme`; nothing is rewritten. Run
  `migrate deploy` before the new build serves traffic: every payment-intent read
  selects the column.

### Payment links: a public read for hosted checkout pages

- **New route `GET /v1/payment-links/{id}`** (`@Public()`): one payment intent as
  its payer may see it, for the checkout at `https://payments.cosmospay.lat/<id>`.
  What it returns, and why, is under API. No migration, no new variable, and no
  existing response changed.
- **Deploy step:** add `/v1/payment-links/*` to APISIX's keyless route (no
  `key-auth`), and allow `https://payments.cosmospay.lat` in that route's CORS
  plugin for `GET`, exposing `Retry-After` and `ratelimit-*`. Without the route
  the page gets `401`; without CORS the browser drops every answer.

### `X-Cosmos-Internal` must carry a gateway-secret MAC

- **A bare `X-Cosmos-Internal: 1` is refused.** `/v1/admin` answers it with `403 admin_console_only`, and the caller is no longer treated as internal anywhere: it gets the per-consumer rate limits, and its request-log rows are not flagged. The header now carries `v1.<unix seconds>.<hex>`, an HMAC-SHA256 keyed by `APISIX_GATEWAY_SECRET` and accepted within five minutes of the server's clock (`src/admin/console-marker.ts`).
- **Ops scripts that call `/v1/admin` directly must mint the marker on every call.** The `openssl` + `curl` snippet at the end of the `ADMIN_API_CREDENTIALS` entry below does it.
- **Deploy the service and the developer platform together.** The console now mints the marker. An old console against this service gets `403` on every admin call; a new console against an older service keeps working, because the older service admits any value but `0`, `false`, `no` and `off`. If the two cannot land at once, deploy the developer platform first.
- **No new environment variable.** The MAC is keyed by `APISIX_GATEWAY_SECRET`, which the service and the console already share.

### Stricter receiver fields and admin list queries

- **`POST /v1/kyc/receivers` and `PUT /v1/kyc/receivers/{id}` refuse malformed identity fields with `400`.** `country` and `id_doc_country` (top level and in `owners[]`) must be upper-case ISO 3166-1 alpha-2 codes (`US`, not `us` or `USA`); `date_of_birth` (top level and in `owners[]`) and `formation_date` must be ISO 8601 date-times with an offset (`1985-04-12T00:00:00.000Z`, not `1985-04-12`); `owners[].ownership_percentage` must be a number from 0 to 100; `website` must be an absolute `http`/`https` URL without credentials. Each of these used to be stored as typed and fail at BlindPay only when the receiver was enabled, after review.
- **`/v1/admin` list queries are validated.** An unknown `status` for that list, a `take` outside 1–200, a negative `skip` or a parameter the route does not take is now `400`; an invalid `status` used to reach the database and come back as `500`. Defaults are unchanged (`take=50`, `skip=0`).
- **The admin receiver, payin and payout reads return an explicit field list.** The fields are the ones returned before; a column added to those tables later is no longer returned until it is listed.

### BlindPay: rows before the provider call, and one completion per payment

- **Migration `20261006120000_blindpay_pending_rows`** makes `payin.blindpayId`
  and `payout.blindpayId` nullable, adds `executionKey` (unique) and
  `lastCheckedAt` to both, and adds `environment`, `blindpayId`, `appliedAt` and
  `lastAttemptAt` to `blindpay_webhook_event`. Existing delivery rows are marked
  applied.
- **No response shape changes.** Rows still waiting for a provider id
  (`pending_provider`, `provider_unconfirmed`) are not returned by the tenant
  routes; the admin lists `/v1/admin/payins` and `/v1/admin/payouts` show them,
  with `blindpayId: null`.
- **`PAYIN_COMPLETED` and `PAYOUT_COMPLETED` are deduplicated** like the other
  terminal events: a second completion under a new `svix-id` no longer produces a
  second event with a new `evt_`. Other BlindPay events are re-emitted only when
  the row actually changed.
- **The BlindPay reconciler runs with the settlement observer**
  (`OBSERVER_ENABLED`); turning the observer off turns it off too.

### Payment intents: one transaction settles one intent, across every tenant

- **Migration `20261006130000_payment_settlement`** adds `payment_settlement` and backfills it from every SUCCEEDED intent. Where one hash already settled several intents, the earliest keeps the claim; the migration file carries the query that lists the others for review.
- **A transaction that already settled a payment intent — any consumer's — no longer settles another.** `POST /v1/payment-intents/{id}/validate` and `PATCH /v1/payment-intents/{id}` with `status: SUCCEEDED` answer `409 transaction_already_settled` and leave the intent as it was. The destination is not bound to a consumer and the memo is the caller's to choose, so another tenant — or any caller under the shared public key — could copy an intent term for term and be settled by its payer's transaction. The observer treats such a match as no payment: the intent stays PENDING and expires unpaid.
- **The payment goes to the oldest intent it pays.** An intent is refused the same `409 transaction_already_settled` when the transaction also pays an older intent of another consumer, so a copy made after the original loses even when its settlement runs first, and the original settles on its next pass. A copy made BEFORE the original wins instead, but only while it is open: an EXPIRED intent outranks nobody, so once the copy expires the original settles. Making one needs the original's memo in advance, so let this service mint memos (omit `memo`) rather than sending predictable ones such as order numbers. The other side of that rule: a payment that lands after the original expired can go to a newer copy that has not. On Monad this also covers a copy paid at another intent's deposit address, whose payment the relayer's forward settled under a different hash. Only a rival the chain confirms is paid refuses a settlement, never how many rivals there are, and a rival must describe the same payment (memo, destination, asset and amount on Stellar). **Monad without a relayer is the exception:** a direct payment carries nothing that is the intent's own — destination, token and amount are public — so two direct-mode intents for the same address and amount are indistinguishable and are not ranked by age; the first to settle takes the payment. Use the relayer's deposit addresses on Monad and service-minted memos on Stellar.
- **`DELETE /v1/payment-intents/{id}` answers `409 operation_in_flight`** when the intent's status changes between its read and the delete, typically because it was just paid. It used to delete it anyway.

### Wallet sign-in: a recovered wallet's signers follow `STELLAR_NETWORK`

- **`WALLET_AUTH_SIGNERS_HORIZON_URL` now defaults to `STELLAR_NETWORK`'s Horizon** (`STELLAR_HORIZON_URL_PUBLIC` / `STELLAR_HORIZON_URL_TESTNET`, else SDF's), not always the public network's. It is read when a wallet recovered through SEP-30 signs `POST /v1/wallet/auth/finish` with the key that replaced its master. On a testnet deployment the lookup went to mainnet, found no account, and every recovered wallet's sign-in answered `400 wallet_signature_invalid`.
- **`WALLET_RECOVERY_SPONSOR_NETWORK_PASSPHRASE` and `WALLET_RECOVERY_SPONSOR_HORIZON_URL` follow it too**, so the sponsor reads the account on the same ledger.
- **Deploy step:** `STELLAR_NETWORK` itself defaults to `testnet`. A deployment that serves mainnet wallets and leaves it unset (API keys pick the network per request) must now set `STELLAR_NETWORK=public`, or these three variables, explicitly. Otherwise recovered mainnet wallets can no longer sign in, and a configured sponsor builds testnet transactions.
- **Only one ledger is ever read.** Checking both would let a key added to the same address on the other network sign for this one.

### Wallet backups: an email-recovery door, held by the two recovery servers

- **Migration `20261004120000_recovery_backup_shares`** adds `recovery_backup_share`. Only a
  recovery server (`RECOVERY_ROLE`) writes it; run the migration on both.
- **New routes on the recovery servers:** `PUT`, `GET` and `DELETE /v1/sep30/shares/{address}`,
  `@Public()` like the rest of SEP-30 and served from the same keyless route. The wallet splits
  a random key in two, files one half with each server under the account's SEP-10 token, and
  seals the backup's data key under the whole as a `recovery` door. Proving the email to BOTH
  servers (the Authentik ID token, or each server's own emailed code) returns both halves: the
  backup opens and the person sets a new password. The seed — and every chain's address —
  survives, unlike SEP-30, which recovers only the Stellar account.
- **The trust this adds:** one server alone holds random noise. Both servers together, or
  whoever controls the inbox AND gets both servers to accept it, can open a backup that has
  this door. Run the two on separate infrastructure with separate `MAIL_*` senders, as SEP-30
  already requires.
- **`GET /v1/sep30/shares` (no address) lists every half filed under the proven inbox**, paged by
  `after` like `GET /v1/sep30/accounts`. A person who backed up several wallets under one email
  forgets the password for all of them at once; one proof per server now brings every backup
  back instead of the newest alone. An identity token only — an account's SEP-10 token is refused
  with `403`, since it already reaches its one half by address.
- **`isBackupBox` accepts one `recovery` slot in a `v: 4` box**, beside at least one password or
  passkey slot. A box whose only door is `recovery` is refused.
- **A recovery server's emailed code** now also goes to an inbox that only holds a backup half
  there.

### Swaps on Solana and Monad: `chain` on `/v1/swaps`, and a new table

- **Migration `20261003120000_chain_swaps`** adds the `chain_swap` table. Nothing
  existing changes: `/v1/swaps` without `chain` answers byte for byte as before.
- **`/v1/swaps` takes `chain`** (`stellar` | `solana` | `monad`) in the quote and
  create bodies and as a list query parameter. For Solana and Monad, create, the
  single read and submit answer a `ChainSwapEntity` (`oneOf` in the contract).
- **`POST /v1/swaps/{id}/submit`:** `signedXdr` is no longer required when
  `signedTransaction` is sent. A Stellar swap still needs it, with the same message.
- **`/v1/cross-chain-swaps` now refuses every same-chain pair** — it used to quote
  Solana → Solana and Monad → Monad through NEAR Intents — and points to `/v1/swaps`.
- **A Solana or Monad node refusing a broadcast is `400 transaction_rejected`**,
  no longer `502 provider_error`. That includes the Monad deposit forwarder's
  relayer, which logs and retries as before.
- **Before enabling:** set `SOLANA_SWAP_FEE_WALLET` and create its token account
  for each output mint you expect, set `MONAD_SWAP_FEE_WALLET`, and get a
  `KURU_API_KEY` for production volume.

### Cross-chain swaps: a new module, a new table and six webhook events

- **Migration `20261002120000_cross_chain_swaps`** adds the `cross_chain_swap` table
  and appends six `WebhookEventType` values: `CROSS_CHAIN_SWAP_CREATED`, `_UPDATED`,
  `_SUCCEEDED`, `_REFUNDED`, `_FAILED`, `_EXPIRED`. Nothing existing is rewritten.
- **New routes under `/v1/cross-chain-swaps`**, reusing the `swaps:read` /
  `swaps:write` scopes; the shared public key reaches assets, quote, create and
  deposit, never the two reads.
- **Before enabling it:** set `NEAR_INTENTS_FEE_RECIPIENT` (a NEAR account) or every
  plan with a commission answers `503 misconfigured`, and set `NEAR_INTENTS_API_KEY`,
  or 1Click adds its own fee and takes half of the commission.
- **`provider_error` is also a `400` now**: NEAR Intents refusing a quote ("amount is
  too low for bridge") is something the caller can change, so it arrives as
  `400 provider_error` with 1Click's reason, as a BlindPay 4xx already did.
### Wallet backups: Argon2id and encryption at rest

- **Set `WALLET_BACKUP_ENCRYPTION_KEY` before deploying** (`openssl rand -base64 32`);
  boot refuses a sign-in door without it. Every stored box is sealed again under it
  (AES-256-GCM, bound to its `chain:address`), so a dump, replica or backup file of the
  database is not a copy of anyone's backup. Then run **`npm run backups:reencrypt`** once:
  it seals the rows written before. Rotation: move the old key to
  `WALLET_BACKUP_ENCRYPTION_PREVIOUS_KEYS`, set a new one, run the script, drop the old one.
- **`v: 4` boxes are accepted**: the slot shape of v3 with an Argon2id password door
  (`kdf: "argon2id"`, `m` ≥ 19 MiB, `t` ≥ 2). The wallet seals every new backup as v4
  (64 MiB, 2 passes) and re-seals a password-only v2/v3 box as v4 when it restores it.
  v2 and v3 are still accepted and served.
- **The wallet asks for a 12-character password** that is not a common one; existing
  passwords keep working until they are changed.
- **The database itself** still wants encryption at the storage layer (disk / volume
  encryption), encrypted backups and access limited to this service: the at-rest key
  protects the backup column, not the rest of the rows.

### Wallet backups: one per wallet, all restored at sign-in

- **Migration `20261001120000_wallet_backups_per_wallet`** turns the one-backup-per-account
  rule into one per `(chain, address)` in the account. Existing rows are kept as they are.
- **`POST /v1/wallet/auth/oauth/claim` and `email/verify` return `backups`**, every box the
  account keeps, newest first. `backup` stays as the newest of them and is deprecated.
- **`POST /v1/wallet/auth/finish` with a `backup` for another wallet adds it**; it no longer
  answers `backup_conflict`. A box for the same wallet replaces its own. `replaceBackup` is
  accepted and ignored. Up to 20 wallets per account; the 21st is
  `400 wallet_backup_limit`.

### The developer platform leaves the request path

- **Removed variables:** `WALLET_AUTH_CONSOLE_URL`, `WALLET_AUTH_CONSOLE_SECRET`,
  `RECOVERY_EMAIL_DELIVERY_URL`, `RECOVERY_EMAIL_DELIVERY_SECRET`. They are ignored.
- **The email door now needs** `MAIL_FROM` + `MAIL_RESEND_API_KEY` / `MAIL_SMTP_*` (a verified
  Resend sender) **and** `APISIX_ADMIN_URL` + `APISIX_ADMIN_KEY`. Without both,
  `GET /v1/wallet/auth/providers` reports `email: false`; a provider sign-in still
  completes the callback but `POST /v1/wallet/auth/finish` answers
  `503 misconfigured` until the admin pair is set. Each pair is set together or
  boot refuses.
- **A recovery server that emailed codes** sets `RECOVERY_EMAIL_CODES=true` and
  its own `MAIL_*`. `APISIX_ADMIN_KEY` on a recovery server refuses to boot.
- **New route `GET /v1/public-key`** (`@Public()`), fed by `PUBLIC_API_KEY_DEV` /
  `PUBLIC_API_KEY_PROD`: copy the values the platform minted for the public key.
  Add the path to APISIX's keyless route (no `key-auth`), or wallets get `401`.
- **Wallet keys now live under `cosmos_wallet_<accountId>`**; see the section above
  for accounts the platform provisioned. Response shapes are unchanged.
- **`POST /v1/wallet/auth/finish` without `backup`** connects the signing wallet to the account and returns its keys: it no longer answers `backup_conflict` when the account backs up another wallet, and it no longer moves the account's `address`. With `backup` nothing changed. This is how a wallet imported from a seed connects to Cosmos Pay now.
- **`POST /v1/aliases/{name}/recovery` is open to `payments:write` keys, the shared public key included**, and answers `{ accepted: true }` only: this service emails the token itself, so `token`, `email` and `expiresAt` are gone from the response and the platform console no longer takes part (`403 admin_console_only` is no longer returned there). Needs `MAIL_*`; without it the route answers `503 misconfigured`.
- **No migration.**

### Solana and Monad; BlindPay and DeFindex become native plugins

- **Migration `20260930120000_multichain`** adds `chain` (default `stellar`) to
  `payment_intent`, `alias_address`, `alias_challenge`, `wallet_account` and
  `wallet_backup`, plus `assetDecimals`, `chainReference` and `chainCursor` to
  `payment_intent`, and widens the alias address unique index to
  `(aliasId, chain, network, address)`. Every existing row stays Stellar; nothing
  is rewritten.
- **BlindPay (KYC, onramp, offramp) and DeFindex are served only when
  `PLUGINS_ENABLED` lists `blindpay` / `defindex`.** A deployment that had their
  keys set and does not add the slugs loses `/v1/kyc`, `/v1/onramp`,
  `/v1/offramp`, `/v1/blindpay/webhooks`, `/v1/defindex` and the BlindPay
  `/v1/admin` routes (404), and the boot logs a warning naming the slug. Set e.g.
  `PLUGINS_ENABLED=blindpay,defindex` before deploying. Routes, scopes, tables and
  responses are otherwise unchanged.
- **BlindPay's variables are checked when the plugin boots**, not by env
  validation: a half-set instance still refuses to boot, but only where `blindpay`
  is enabled.
- **`GET /v1/admin/summary` carries `fiat` only with `blindpay` enabled**, and
  `GET /v1/admin/consumers` counts `blindpayReceivers`, `payins` and `payouts` only
  then. The summary's `volume` labels a Solana or Monad row `<chain>:<asset>`.
- **New response fields** (additive): `chain` and `chainReference` on payment
  intents; `chain` on alias addresses, resolutions and by-address rows; `chain` and
  `address` on wallet backups, beside `stellarAddress`; `chain` on the dashboard's
  `volume`, `recent` and balance rows, which are now grouped per chain — SOL and
  MON no longer fold into XLM.
- **`txHash` accepts every chain's shape** on `validate` and `PATCH`, checked
  against the intent's chain (`400 validation_failed` otherwise). Only hex is
  lowercased; a Solana signature is stored as sent.
- **Alias resolution without `?chain=` returns Stellar addresses only.**
- **New variables**, all optional (public RPCs by default):
  `SOLANA_RPC_URL_MAINNET`, `SOLANA_RPC_URL_DEVNET`, `SOLANA_RPC_TIMEOUT_MS`,
  `MONAD_RPC_URL_MAINNET`, `MONAD_RPC_URL_TESTNET`, `MONAD_RPC_TIMEOUT_MS`,
  `MONAD_LOG_BLOCK_RANGE`. The observer now also polls Solana and Monad for the
  pending intents on those chains.
- **The developer platform's `/wallet/console/provision`** now receives `chain`
  and `address`, and `stellarAddress: null` for a Solana or Monad sign-in; it must
  accept that before wallets offer those chains.
- **Monad deposit addresses** are on only with `MONAD_RELAYER_PRIVATE_KEY`; the
  migration also creates `evm_deposit_address`, and intents gain `networkFee`.
  Without the key Monad intents behave as before (paying the merchant directly).
- **No APISIX change.**

### Plugins: a new module, two new tables and two new scopes

`/v1/plugins` is new; no existing route or response changed. At deploy time:

- **Migration `20260929120000_plugins`** creates `plugin_installation` and
  `plugin_record`. No core table changes.
- **The scopes `plugins:read` and `plugins:write` are new.** Existing keys do not get
  them and receive `insufficient_scope`; grant them from the developer platform.
- **Nothing runs until `PLUGINS_ENABLED` lists a plugin**, and then only for the
  tenants that installed it. `plugins/example` is preinstalled and disabled.
- **`typescript` is now a runtime dependency**: plugins' `index.ts` is transpiled at
  boot. Do not prune it from production installs.
- **Set `PLUGINS_SECRET`** before enabling a plugin with secret settings — the boot
  refuses otherwise. `PLUGINS_TRUSTED_KEYS` adds signers beside support's.
- **Ship the `plugins/` folder with the build.** It is read from the working
  directory at boot, next to `dist/`; a deployment that copies only `dist/` and
  `node_modules/` serves no plugins, and an enabled one stops the boot.
- **Node must run with `--no-node-snapshot` when a plugin is enabled** — the sandbox
  (`isolated-vm`, a native module) requires it, and the boot refuses otherwise. Every
  npm script passes it (`start`, `start:prod`, `test`, …); a process started another
  way needs it in the command or in `NODE_OPTIONS`.
- **No APISIX change:** the catch-all route already forwards `/v1/plugins`.
- **New error codes:** `plugin_not_installed`, `plugin_consent_mismatch`,
  `plugin_rejected`, `plugin_quota_exceeded`, `plugin_failed`.

### Pollar was removed

Everything under `/v1/pollar` is gone — the OAuth bridge (`/v1/pollar/oauth/*`), wallet
provisioning and trustlines (`/v1/pollar/wallets/*`) and `/v1/pollar/users` — along with the
error codes `pollar_identity_required`, `pollar_identity_mismatch` and
`elevated_key_required`, and every `POLLAR_*` variable. The routes answer `404` now.

- **Migration `20260927120000_remove_pollar`** drops `pollar_oauth_session` and
  `pollar_user_wallet`. It cannot be undone: back the two tables up first if you need their
  history.
- **Delete the APISIX routes for `/v1/pollar/*`**, the callback route with key-auth off in
  particular, and unset the `POLLAR_*` variables — they are ignored.
- **Keys may still carry `pollar:*` scopes.** Nothing checks them any more.
- **Advisory lock ids `881_005` and `881_007` are retired**, and never reused.
- **Wallets:** Cosmos Wallet removes any Pollar wallet from a device the next time it
  starts. The funds stay with Pollar, at the same address.

### Security review fixes

Most of these change nothing for a well-behaved caller; check the "Who notices"
column before deploying.

| Change | Who notices | Why |
| ------ | ----------- | --- |
| `POST /v1/aliases/:name/recovery` is **platform-console only**: an API key gets `403 admin_console_only`, and the route left the published contract | Anyone who started recoveries with an API key | The response carries the recovery token, which proves control of the owner's mailbox |
| Completing a recovery on a `SUSPENDED` alias is a `404` | Nobody legitimate | A token issued before a suspension could bypass the operator hold |
| `@Public()` routes (BlindPay webhook, health) ignore `X-Consumer-Username` | Dashboards: those requests now log as anonymous | Those routes have no key-auth, so the header came from the client |
| Refusals by `AdminGuard` and `ConsoleOnlyGuard` are logged at `warn` | Operators | Guards run before the access log, so refused requests left no trace |
| Both `POST …/trustlines` routes share a `429` budget of 20 calls per 10 minutes | Scripts that add trustlines in bulk | Each trustline locks 0.5 XLM of the operator's funding wallet |
| `GET /v1/offramp/payouts/:id` no longer returns `raw`, `consumerId`, `receiverId`, `quoteId`, `bankAccountId` or `updatedAt`; the virtual-account create response no longer returns `raw`, `receiverId`, `consumerId` or `updatedAt` | Callers reading those fields | `raw` is BlindPay's stored object, with bank and beneficiary data |
| `POST /v1/kyc/upload` returns `400` for more than 4 text fields, a field over 1 KiB, a second file, or file bytes that do not match the declared type | Nobody sending a well-formed upload | Fields were unbounded and the type check trusted the client's `Content-Type` |
| `POST /v1/payment-intents/tx` and `/pay`: the same memo with any different term is `409 idempotency_conflict`. An identical retry still returns the stored intent (`2` and `2.0` are the same amount) | Callers reusing one memo for different payments | Under the shared public key, a memo someone else created first returned their intent |
| `POST /v1/payment-intents/:id/validate` marks `FAILED` only for a failed tx that is this intent's own payment; any other failed tx is `valid: false` with the status unchanged. A tx that closed more than 60 s before the intent was created is refused ("Transaction predates this payment intent") — on validate, on `PATCH {status: SUCCEEDED}`, and in the observer | Nobody legitimate | Any failed transaction could fail an intent, and an old payment with the same terms could settle a new one |
| `PATCH /v1/payment-intents/:id` changing `txHash` on a terminal intent is `400 invalid_state_transition`; a status change racing the write is `409 operation_in_flight` | Nobody legitimate | It could rewrite the settlement evidence of a `SUCCEEDED` intent |
| The payment-intent observer reconciles at most 10 intents per consumer per tick and never scans expired rows | Operators watching observer throughput | One consumer could delay every other tenant's settlement |
| `POST /v1/swaps`, `/v1/liquidity-pools/deposit` and `/withdraw`: a reused `Idempotency-Key` with a different request — a different memo or slippage, the other network, or a deposit key reused for a withdrawal — is `409 idempotency_conflict`. A replay carrying an invalid asset, slippage or memo now gets the normal `400` | Clients reusing one key for different operations | Under the shared public key, someone could pre-create an envelope under a guessable key and have it returned to another user's retry |
| `POST /v1/liquidity-pools/withdraw` no longer answers `409 operation_in_flight` for an in-flight withdrawal whose sequence number the account has not used yet (an unsigned or abandoned envelope) | Wallet users who were blocked | An envelope built for someone else's account could block withdrawals from that position indefinitely |
| The settlement observer takes at most 10 rows per consumer per table per tick, and `GET /v1/liquidity-pools/positions` reads Horizon through one paged listing instead of one request per pool | Operators | One consumer could delay everyone else's settlement, and many pool shares meant unbounded Horizon calls |
| `GET /v1/onramp/payins/:id` no longer returns `receiverId` or `updatedAt` — the same shape `GET /v1/onramp/payins` returns | Callers reading those two fields from the single-payin read | The same payin could come back in two shapes |
| `POST /v1/kyc/upload` with a file over 10 MiB is `413` with `code: "payload_too_large"`; it was `internal_error` | Integrators branching on `code` | It is a client-side limit, not a server error |
| `POST /v1/liquidity-pools/deposit`, `/withdraw`, `GET /v1/liquidity-pools/operations`, `/operations/:id`, `POST /v1/liquidity-pools/operations/:id/submit` and the `LIQUIDITY_*` webhooks now carry `memo` (the caller's MEMO_ID, or `null`). Operations built before migration `20260915120000_liquidity_pool_operation_memo` report `null` even when their envelope carries one | Nobody, unless a client rejects unknown fields | The memo was only stored inside the XDR |
| The published contract for `GET /v1/swaps` and `GET /v1/liquidity-pools/operations` no longer lists `qr` or `commissionMemo` on list items. The responses are unchanged — those two fields were never sent there; read the single item for them | Clients generated from the OpenAPI spec | The contract declared list items with the single-item shape |
| The service refuses to boot when `APISIX_GATEWAY_SECRET` is a placeholder — the value `.env.example` used to ship, or anything containing `replace-with`, `change-me`, `your-secret` or `placeholder` — and `.env.example` now leaves it empty | Deployments still running the value copied from `.env.example` | That value is public and long enough to pass the 32-character floor, so anyone who could reach the service could name any consumer and reach `/v1/admin` |
| The service refuses to boot when `BLINDPAY_WEBHOOK_SECRET` is set but its key (the base64 after `whsec_`) is malformed or decodes to fewer than 24 bytes, and `POST /v1/blindpay/webhooks` rejects every delivery while the configured key is unusable | Deployments with a truncated or mistyped secret, whose BlindPay webhooks were already failing | Node decodes invalid base64 to a short or empty HMAC key without an error, and a delivery signed with an empty key can be forged by anyone |
| `GET /v1/health/readiness` answers a failed check with the standard error envelope (`error: "Service Unavailable"`); it used to put the health report, database error message included, in `error` | Probes that read the report from the body instead of the status code | The route is `@Public()`, and Prisma's message names the database host and user |
| `POST /v1/onramp/receivers/:id/virtual-accounts` is `403 account_disabled` when the receiver, or the receiver that owns `blockchain_wallet_id`, is disabled | Nobody legitimate | It was the one fiat operation the kill switch did not cover: a disabled account could still open a new deposit rail |
| `POST /v1/swaps/:id/submit` and `POST /v1/liquidity-pools/operations/:id/submit` check the envelope before anything else: a body that does not parse, is not the row's envelope, or carries no signatures is `400 validation_failed` whatever the row's status. An arbitrary `signedXdr` no longer returns a `SUCCEEDED` row, and an `EXPIRED` row answers a mismatched body with `validation_failed` instead of `invalid_state_transition` | Clients that submitted the unsigned `xdr` and relied on the `tx_bad_auth` rejection | Signatures do not change a transaction's hash, so the unsigned envelope could be relayed and rejected in a loop, and under the shared public key a row id alone read a settled row |
| Both submit routes refuse an envelope past its time bounds (`400 invalid_state_transition`, not broadcast; the observer still settles it if it landed) and a `FAILED` row already resubmitted 3 times (`400 invalid_state_transition`: build a new one). A retry after `503 provider_unavailable` does not count | Clients that retry submit in a loop: stop on `invalid_state_transition` | Every rejected resubmit was a Horizon submission and a new terminal webhook event, with no limit |
| A rejected submit is checked against the ledger before it is recorded. A transaction already on-chain and successful (the wallet broadcast it itself and the re-submission came back `tx_bad_seq`) answers `SUCCEEDED` and fires `*_SUCCEEDED`; one the ledger cannot answer for yet answers `submitted: false` with `status: "SUBMITTED"` and stays in flight for the observer. The observer also re-checks `FAILED` rows created in the last 24 hours and promotes one whose transaction settled, firing `*_SUCCEEDED` after the earlier `*_FAILED` | Clients that read `submitted: false` as final: check `status`, and treat a `*_SUCCEEDED` after a `*_FAILED` for the same resource as a correction | A settled swap or deposit could be recorded `FAILED` for good, with no success webhook and, for a deposit, no cost basis |
| Both submit routes allow 20 calls a minute per consumer and client address, in separate buckets (`429 rate_limited`) | Wallets behind one NAT sharing the public key | The routes take the shared public key, and each call can broadcast to Horizon |
| `GET /v1/webhooks`, `GET /v1/webhooks/:id` and `PATCH /v1/webhooks/:id` return only the documented endpoint fields; `POST /v1/webhooks` and `POST /v1/webhooks/:id/rotate-secret` return those plus `secret`. `consumerId`, `previousSecret` and `previousSecretExpiresAt` left all five | Callers reading those fields | `previousSecret` is a signing secret an integrator may still accept, and a key with only `webhooks:read` could read it |
| A recovery token that matches no live recovery of the alias no longer counts against it. A live token uses an attempt on every presentation, including one whose challenge or signature then fails; after five it is `400 alias_recovery_invalid` | Nobody legitimate | Alias names are public, so five junk tokens from any key burned every recovery the console started |
| `POST /v1/aliases/:name/recovery/complete` (10 per 10 min), `POST /v1/aliases/challenges` (30), `POST /v1/webhooks/:id/ping` (20) and `POST /v1/webhooks/:id/deliveries/:deliveryId/redeliver` (30) are `429 rate_limited` over budget, per consumer and client address | Scripts that loop these routes | Each call stores a row, tries a recovery token, or sends requests to a URL the caller chose |
| `PATCH /v1/payment-intents/:id` requires `txHash` to be a 64-character hex Stellar transaction hash (anything else is `400`) and stores it lowercase; `POST /v1/payment-intents/:id/validate` lowercases its own. A hash is unique among one consumer's intents instead of across all tenants, and a hash already on another of your intents is `409 idempotency_conflict` (it was `500`) | Callers sending placeholder or truncated hashes | Any tenant could park another tenant's transaction hash on an intent of its own; the other tenant's settlement then hit the global index, answered `500`, and the paid intent expired without `PAYMENT_INTENT_SUCCEEDED` |
| An `EXPIRED` intent moves to `SUCCEEDED` when its payment is verified on-chain: by the observer, which now checks the chain before expiring, or by `POST /v1/payment-intents/:id/validate` and `PATCH {status: SUCCEEDED}`, which answer `200` instead of `400 invalid_state_transition`. `PAYMENT_INTENT_SUCCEEDED` can follow the update `EXPIRED` emitted | Webhook consumers that treat `EXPIRED` as final | Expiry never looked at the chain, and the verifier read only the 50 newest payments to the destination, so a late or buried payment left a paid intent `EXPIRED` for good |
| Swap, liquidity-pool operation, payment-intent and customer responses return only their documented fields, plus `expiresAt` on swaps and payment intents, now documented. `consumerId` and the settlement bookkeeping (`settlementEpoch`, `lastCheckedAt`, `notFoundStreak`, `sharesReceived`, `settledAmountA`/`B`, `horizonCursor`) are no longer sent | Callers reading those fields | They are internal, and several of these routes are reachable with the shared public key |
| `PATCH /v1/kyc/receivers/:id` on a receiver that already exists at BlindPay is `403 kyc_review_required` for any field but `external_id` and `image_url`, unless the key is elevated (`X-Consumer-Role: admin`) | Integrators correcting a live receiver's identity with a tenant key: send it through the reviewer | The `PUT` sent never-reviewed identity data straight to a regulated provider, while the same edit before enabling re-enters review |
| BlindPay routes use the instance of the caller's key environment: `prod` keys the unsuffixed `BLINDPAY_*` instance, `dev` keys the `BLINDPAY_*_DEV` one, and a `dev` key with no development instance configured gets `503 misconfigured`. Receivers, wallets, bank accounts, virtual accounts, quotes, payins and payouts are only read and executed on that instance | Anyone using BlindPay with `dev` keys | A `dev` key operated the production instance: it could list and delete real KYC identities and create live payouts |
| A testnet login no longer provisions its user a mainnet wallet: `network_wallets` on a testnet redemption lists the testnet wallet only. A mainnet login still provisions testnet | Anyone reading a mainnet entry from a testnet login | A `dev` key anyone can mint spent the operator's real XLM on a mainnet reserve per login |
| `POST /v1/kyc/receivers/:id/approve` accepts `expected_version` (the `dossierVersion` you read) and answers `409 kyc_state_invalid` when the KYC data changed since. `POST /v1/kyc/receivers/:id/enable` refuses a dossier that is not the one approved, and receiver reads carry `dossierVersion` and `reviewedVersion` | Reviewers, once they start sending `expected_version`; nobody else — the field is optional | A review is a person reading the data and then approving it, and an edit in between leaves the status at `pending_review`, so the approval landed on a dossier nobody had seen and `enable` sent it to a regulated provider |
| `POST /v1/kyc/upload`, `/v1/kyc/terms-of-service`, the onramp and offramp writes, `POST /v1/payment-intents/tx` and `/pay`, `POST /v1/swaps/quote` and `/v1/swaps`, and `POST /v1/liquidity-pools/deposit` and `/withdraw` now answer `429 rate_limited` over budget, per consumer and client address. Every BlindPay-backed route also counts against a per-consumer ceiling of 60 provider requests a minute | Scripts that loop those routes; a batch importer above the ceiling should hold its own key | They had no limit at all: each one either leaves something behind at the provider that no error refunds, or spends the per-IP Horizon budget every route here shares. Only the builders' submits were capped |
| `POST /v1/swaps` no longer answers `409 operation_in_flight` for a `PENDING` swap whose sequence number the account has not used yet (an unsigned or abandoned envelope). Only applies where `STELLAR_SWAP_SINGLE_INFLIGHT=true` | Wallet users who were blocked | Any caller may name any `source`, so one dust swap froze a stranger's account for a timeout window at a time — the twin of the liquidity-pool fix above |
| A webhook destination refused for its host — unresolvable, private, link-local, metadata — is one `400` with one message; the reason is in the service log. A malformed URL, a non-https scheme, credentials or a missing host still say what is wrong | Integrators who read the reason out of the response | Registering an endpoint resolves a name this service can reach, so per-reason answers let anyone map the internal network one URL at a time |
| `redirect_url` is refused when it carries a fragment, a backslash, whitespace or a control character; https with no embedded credentials was already required | Nobody sending a plain URL | `https://app.acme.com\@evil.test` names a different host depending on who parses it, and the value is read again by BlindPay and by a browser |
| `POST /v1/wallet/auth/oauth/claim`: an Authentik sign-in whose email the provider has not confirmed (`email_verified` not `true`) completes the callback and answers `verify_email` with a code sent to that inbox, new account or not, instead of failing with `email_unverified`. No ID token is released for it, so it cannot start a SEP-30 recovery, and it shares the per-address cooldown of `POST /v1/wallet/auth/email/start` (`400 wallet_login_code_cooldown`). Run migration `20260926120000_wallet_auth_unverified_email` first | Wallets: handle `verify_email` on a new account too | The person was left on a dead-end page; the code proves the address the provider did not |
| `POST /v1/wallet/auth/finish` and `POST /v1/wallet/recovery/setup` read the session token from `X-Wallet-Session: {sessionToken}`. `Authorization: Bearer` is still read, but only reaches the service on a direct call | Wallets: send `X-Wallet-Session` next to the API key | The gateway strips `Authorization` (and `apikey`) before proxying, so through APISIX the token never arrived and both routes answered `401 wallet_session_invalid` |
| An Authentik wallet sign-in asks for `max_age=300` instead of `prompt=login`, and the ID token's `auth_time` must be within those 5 minutes (else the callback fails with `profile_invalid`). With Google / GitHub as Authentik sources, set `default-source-authentication` to *Authentication: No requirement* | Operators running Authentik with social sources | Under `prompt=login` Authentik asked a browser with no session to log in twice, and the second login through a source was refused with "Flow does not apply to current user" |
| `POST /v1/wallet/auth/finish` and `PUT /v1/wallet/backup` also accept a `v: 3` backup box: the seed under a random data key, and that key sealed once per door in `slots` (`kind: "password"` or `kind: "passkey"`, at most 8). Every password door is held to the same PBKDF2 floor a `v: 2` box is; a passkey door has no cost, because its key is the authenticator's WebAuthn PRF output. `v: 2` boxes are unchanged | Wallets: a passkey-only backup is valid, and a wallet that wrote one needs this server | Lets a person restore with a passkey instead of typing the original password, without this service ever holding a key that opens the box |
| `POST /v1/wallet/auth/oauth/authorize` accepts an optional `returnTo`. When it is listed in `WALLET_AUTH_RETURN_URLS`, `GET /v1/wallet/auth/oauth/callback/{provider}` answers `302` to it with `?state=…` (plus `&error=<reason>` on failure) instead of rendering the page; one that is not listed is `400 wallet_return_url_not_allowed`. Only the `state` travels — the handshake is still redeemed with the PKCE verifier. Run migration `20260927180000_wallet_auth_return_to` first | Native wallets (desktop and mobile): send `returnTo` and register that URL with the OS | A platform auth session (`ASWebAuthenticationSession`, a Custom Tab, a desktop deep link or loopback listener) closes only when the browser reaches the app's own URL, so the person was left on the page and had to dismiss it by hand |
| `GET /v1/wallet/auth/providers` also returns `mfaSettingsUrl`: the page of a person's Authentik account where they add or remove a second factor (security key or passkey, authenticator app, recovery codes), through the Authentik login when there is no session; `null` without Authentik. A second factor is optional on the wallet sign-in — `deploy/authentik/wallet-sign-in.yaml` sets the MFA stage back to *skip*, asks whoever has a factor for it after the password, lets a passkey sign in from the username screen, and offers whoever has none a choice after the password (not now, a security key, an authenticator app). It also adds Google / GitHub to the sign-up page above its form. Signing in and signing up with a password are unchanged | Operators running Authentik: import the blueprint. Wallets: offer the URL as a setting | A second factor was either forced on everyone or unreachable: the wallet's users never visit Authentik's own settings, the setup flows refuse a browser with no Authentik session, and the identification stage's passwordless button pointed at the same flow, so it only reloaded the page |
| `/v1/admin` requires `X-Cosmos-Internal` to carry a fresh MAC keyed by `APISIX_GATEWAY_SECRET` (`v1.<unix seconds>.<hex>`, within five minutes); a bare `1` is `403 admin_console_only`, and only a verified marker exempts a caller from per-consumer rate limits or flags its request-log rows | Ops scripts calling `/v1/admin` directly, and a developer platform deployed without this change | Any value but `0`, `false`, `no` or `off` counted, so one APISIX route that forgot to strip the header handed every API key the cross-tenant admin surface, the rate-limit exemption and a way to hide its calls from the tenant's request log |

Deploy notes that come with it:

- **Migration `20260910120000_aliases`** creates `alias`, `alias_address`,
  `alias_challenge` and `alias_recovery`. Run `migrate deploy` before the new
  build serves traffic.
- **A new advisory lock id, `881_008` (`AliasChallengeSweeper`).** Nothing to
  configure.
- **Set `NODE_ENV=production` in production.** `.env.example` ships
  `development`, and two protections key on it: a request missing
  `X-Plan-Swap-Fee-Bps` is a `503` only in production (anywhere else swaps
  silently fall back to `STELLAR_SWAP_FEE_BPS`), and `/docs` — outside every guard
  — is off by default only in production.
- **The settlement observer's log lines changed** to
  `Settlement observer started (every Nms)`,
  `Settlement observer (OBSERVER_ENABLED=false) disabled`, and
  `SettlementObserverService cycle failed` at `error`. Update alerts that match the
  old wording. `OBSERVER_ENABLED`, `OBSERVER_INTERVAL_MS` and the advisory lock are
  unchanged.
- **Migration `20260915120000_liquidity_pool_operation_memo`** adds the nullable
  `liquidity_pool_operation.memo` column: no table rewrite, only a brief exclusive
  lock. There is no backfill — older rows keep their memo in base64 XDR, which SQL
  cannot decode, and the service falls back to the envelope for them.
- **Two variables are now checked at boot.** A placeholder
  `APISIX_GATEWAY_SECRET`, or a `BLINDPAY_WEBHOOK_SECRET` whose key does not
  decode to at least 24 bytes, stops the service from starting with an error that
  names the variable. Replace a placeholder gateway secret on the APISIX route and
  here in the same change (`openssl rand -hex 32`); a mismatch makes every request
  fail as not coming from the gateway.
- **Migration `20260915150000_payment_intent_tx_hash_per_consumer`** replaces the
  unique index on `payment_intent."txHash"` with one on `("consumerId", "txHash")`.
  It is not `CONCURRENTLY`: `payment_intent` is write-locked while the index
  builds. There is no backfill.
- **Stored `webhook_endpoint.previousSecret` values are no longer returned, but
  nothing clears them.** If a rotation on an earlier release left one behind and
  you want it gone from the database, null the two columns yourself.
- **Migration `20260915160000_blindpay_environment`** adds `environment` (default
  `'prod'`) to the seven BlindPay mirror tables — a catalog-only change, no table
  rewrite — so existing rows are labelled production. **If your unsuffixed
  `BLINDPAY_*` variables pointed at a BlindPay development instance**, move them to
  the `_DEV` variables and relabel the rows (`UPDATE … SET environment = 'dev'` on
  `blindpay_receiver`, `blindpay_blockchain_wallet`, `blindpay_bank_account`,
  `blindpay_virtual_account`, `payin`, `payout` and `blindpay_quote`), or `prod`
  keys keep reading them.
- **Configure the development BlindPay instance** (`BLINDPAY_API_KEY_DEV`,
  `BLINDPAY_INSTANCE_ID_DEV`, `BLINDPAY_WEBHOOK_SECRET_DEV`) if `dev` keys use
  BlindPay, and point its dashboard webhook at the same `/v1/blindpay/webhooks` URL.
- **Migration `20260915200000_receiver_dossier_version`** adds `dossierVersion`
  (default `1`) and `reviewedVersion` to `blindpay_receiver` — a catalog-only
  change, no table rewrite — and backfills `reviewedVersion` for every receiver
  already past the review gate, so their `enable` keeps working. Receivers still
  in `inactive` or `pending_review` keep `NULL`, which is the truth about them.
- **New `429`s on routes that never returned one.** The budgets in the table
  above apply from this release; a client that loops KYC uploads, quotes, payins,
  payouts, intent builds, swap quotes or pool builds needs to honour
  `Retry-After`. `RATE_LIMIT_ENABLED=false` turns the limiter off during an
  incident.

### The OpenAPI contract lists only what each route returns

Nothing changed on the wire; the published contract did. Regenerate any client
built from `openapi/openapi.json`:

- Each operation lists only the failures it can return. `409` appears only where
  the route documents a conflict of its own, `429` only on rate-limited routes,
  `502`/`503`/`504` only where the route calls a provider, and the health probes
  list no `401`/`403`. Shared failures are `$ref`s into `components.responses`.
- Every failure example is real for its status. The spec used to show one
  `409 idempotency_conflict` under every status of every route.
- `X-Gateway-Secret` and `X-Consumer-Username` are one security requirement (both
  headers), with `Authorization: Bearer` published as the alternative for calls
  through the gateway. They used to be two alternatives, which told tools that
  either header alone was enough.
- The `503` of `GET /v1/health/readiness` is documented as the error envelope. It
  used to be documented as the Terminus report, which the exception filter never
  returns.

### NestJS 12, TypeScript 6 and a Node floor of 24.9

The service now runs on NestJS 12 and TypeScript 6 and **requires Node 24.9 or
later** (`engines`; CI pins `node-version: 24`). Update deploy targets to match.

NestJS 12 is published as ESM, and Jest can only load it on Node >= 24.9 with
`--experimental-vm-modules`, so the test scripts run Jest through Node directly:

```
"test": "node --experimental-vm-modules node_modules/jest/bin/jest.js"
```

The published OpenAPI contract gained richer health schemas from
`@nestjs/terminus@12` (status enums and `responseTime`). No business route or
schema changed.

### A shared public API key, and the guard that confines it

`PublicKeyGuard` (global, after `PermissionsGuard`) and the `@AllowPublicKey()`
decorator are new. Existing keys are not affected. At deploy time:

- **Set `APISIX_PUBLIC_CONSUMER`** to the username the dev platform provisions for
  the public key, on every deployment that publishes one. Without it the guard
  relies only on the forwarded `X-Consumer-Role`.
- **Create the public key with `role: public`** and only the scopes the
  allowlisted routes need. Extra scopes such as `kyc:*` would not open those
  routes, but a key everyone holds should not carry them.

See "The shared public API key" above.

### The asset registry: `GET /v1/assets`

A curated list of the (code, issuer) pairs this platform supports, per network,
with the issuing organization. It requires no scope, since it holds no tenant
data, but it does require an authenticated consumer (the shared public key
works).

`npm run assets:verify` checks every row against live Horizon: that the pair
exists on its network, that `contract` matches Horizon's `contract_id`, and that
the issuer flags match the chain. Run it when editing the registry; it needs
internet access, so it is not part of the unit tests.

**Registry version 2** adds the network's standard assets to mainnet: Paxos
PYUSD, Ondo USDY, Glo Dollar, GYEN, AUDD, VNX VCHF, ZEAM ZARZ/USDZ, LINK NGNC,
Anclap ARS/PEN, CLPX, Etherfuse CETES/USTRY/TESOURO/KTB, Ultra Capital
yUSDC/yBTC/yETH/BTC/ETH, Fchain XRP, SHX, MOBI, AFR, TFT, LSP and KALE, plus Velo
(listed, not verified: no home domain). Testnet gains Circle's EURC. Every new
verified row is backed by its issuer's on-chain `home_domain` and a stellar.toml
that lists it. The response shape is unchanged; clients that bundle a copy (the
wallet, the MetaMask Snap) pick the new rows up because the version is higher.

### Client activity: a new module, a new table and two new scopes

`POST /v1/activity/events` accepts telemetry from the wallet and the developer
dashboard; `GET /v1/activity/events` and `GET /v1/activity/summary` read it back.
No existing response changed. At deploy time:

- **Migration `20260906140000_activity_event`** creates `activity_event`
  (append-only, `consumerId`-scoped, unique on `(consumerId, eventId)`).
- **The scopes `activity:write` and `activity:read` are new.** Existing keys do
  not get them automatically and receive `insufficient_scope`. The developer
  platform grants both to wallet-provisioned keys and re-applies them on
  rotation; add them to keys created by hand.
- **`ACTIVITY_RETENTION_DAYS`** (default 30) joins the retention job. These rows
  hold personal data, like the access log.

### `429` now reports `rate_limited`

A `429` used to report `code: "provider_unavailable"`. It now reports
`code: "rate_limited"` (`ApiErrorCode.RateLimited`, part of the published enum).
Branch on that if you retry on throttling.

### An unconfigured BlindPay now reports `misconfigured`

When BlindPay is not configured, two responses changed:

| Request | Was | Now |
| ------- | --- | --- |
| A route that calls BlindPay — under `/v1/kyc`, `/v1/onramp` or `/v1/offramp` — while `BLINDPAY_API_KEY` or `BLINDPAY_INSTANCE_ID` is unset | `503` `provider_unavailable` | `503` `misconfigured` |
| `POST /v1/blindpay/webhooks` while `BLINDPAY_WEBHOOK_SECRET` is unset | `400` `validation_failed` | `503` `misconfigured` |

Both are deployment configuration errors that a retry cannot fix. Svix retries
any non-2xx, so webhook delivery is unchanged.

### Response shapes that changed

Three published response shapes changed under `/v1` (there is no `/v2`), so tell
integrators before you deploy.

| Endpoint | Was | Now | Why |
| -------- | --- | --- | --- |
| `GET /v1/webhooks` | bare array, silently clamped at 100 | `{ data, total, take, skip }` | Results were capped at 100 with no `total` to page against |
| `GET /v1/products` | bare array, whole table | `{ data, total, take, skip }` | Unbounded read |
| `GET /v1/webhooks/:id/deliveries` and the redelivery response | included `payload` | `payload` removed | A `RECEIVER_UPDATED` body is a full KYC dossier and these routes are gated on `webhooks:read`, not `kyc:read` |

Callers that iterate the response or read `delivery.payload` will break: read
`res.data` instead, and fetch KYC details from the KYC endpoints with a key that
holds `kyc:read`.

`RECEIVER_UPDATED` / `PAYIN_*` / `PAYOUT_*` **webhook bodies** also narrowed to
identity and state — see the Webhooks section.

### The audit-hardening migration

It ships as two files that must be applied in order:

- `20260901120000_audit_hardening` — the correctness work: a new column, a
  de-duplicating `DELETE` on `liquidity_pool_operation`, two `UNIQUE` indexes,
  two new tables. The DELETE and the unique index run in one transaction under a
  `SHARE ROW EXCLUSIVE` lock, so writers to that table block for a few
  milliseconds.
- `20260901120100_audit_hardening_indexes` — nine additive indexes, built
  `CONCURRENTLY` so the deploy does **not** block writes on `payment_intent`,
  `swap`, `webhook_delivery` or `request_log`. No maintenance window needed.

They are separate files because PostgreSQL does not allow
`CREATE INDEX CONCURRENTLY` inside a transaction, and the first file needs one.

If the second file fails partway, it can leave an **invalid** index that
`IF NOT EXISTS` treats as present. Find it, drop it, and re-run:

```sql
SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE NOT i.indisvalid;
```

### `ADMIN_API_CREDENTIALS` is gone — `/v1/admin` is the platform console's

**Delete the variable.** It is no longer read, and the matching
`COSMOS_ADMIN_API_SECRET` / `COSMOS_ADMIN_API_SECRET_READ` in the developer
platform go with it.

It was a second admin check on top of the developer platform's own role check,
and deployments that skipped it got `401 admin_credentials_required` on
cross-tenant reads from the console. Now `/v1/admin` accepts a request only when
it comes from the platform console, which two things on the request establish:

1. `X-Gateway-Secret` matches `APISIX_GATEWAY_SECRET` — checked by `ApisixGuard`
   as on every other route. Only the gateway and the console backend hold it.
2. `X-Cosmos-Internal` is a console marker: `v1.<unix seconds>.<hex>`, where
   the hex is `HMAC-SHA256(APISIX_GATEWAY_SECRET, "cosmos-admin-console:v1:" +
   seconds)` and the timestamp is within five minutes of the server's clock.
   An API-key caller holds no gateway secret, so it cannot mint one even through
   a route that forgot to strip the header (`proxy-rewrite.headers.remove`).
   The same verified flag is what exempts the console from per-consumer rate
   limits and flags its request-log rows.

A bare `X-Cosmos-Internal: 1` — what the console sent before — is refused like
any other forgery, so the service and the developer platform deploy together.
Both repositories pin the same test vector for the marker. The console is the only
place that decides who is a platform admin, and audit rows name the console
account that acted (`cosmos_<userId>`) and its platform role, on every mutation
**and** every read.

What this changes for a caller:

| Was | Now |
| --- | --- |
| `401` `admin_credentials_required` without a Bearer secret | `403` `admin_console_only` for anything that is not a console call |
| `403` `admin_role_required` for a `read` credential on a mutation | gone — the console already decided the account may act |
| `actorId` / `actorRole` on an audit row named the credential | they name the console account and its platform role |

To call `/v1/admin` directly (from an ops script, for example), send
`X-Gateway-Secret`, `X-Consumer-Username` and a freshly minted
`X-Cosmos-Internal`; add `X-Cosmos-Admin-Role: owner` to label the audit row.
Keep the service off the public internet.

```sh
TS=$(date +%s)
MAC=$(printf 'cosmos-admin-console:v1:%s' "$TS" | openssl dgst -sha256 -hmac "$APISIX_GATEWAY_SECRET" -r | cut -d' ' -f1)
curl -H "X-Gateway-Secret: $APISIX_GATEWAY_SECRET" -H "X-Consumer-Username: ops" -H "X-Cosmos-Internal: v1.$TS.$MAC" http://localhost:3000/v1/admin/summary
```

### `APISIX_GATEWAY_SECRET` now requires 32 characters

The service refuses to boot with a shorter secret. It now also protects
`/v1/admin` (see above). Generate one with `openssl rand -hex 32` and update
APISIX at the same time.

### Features from `v0.1.0`–`v0.1.5` that this release supersedes

A deployment upgrading from `v0.1.5` loses the following behaviour. Every item is
visible to integrators, so plan the upgrade around them.

| Was on `v0.1.5` | Now |
| --------------- | --- |
| `POST /v1/webhooks/:id/rotate-secret` accepted `graceSeconds` and kept the old secret verifying for `WEBHOOK_SECRET_GRACE_SECONDS` | The secret is swapped outright; the previous one stops verifying immediately. Update the receiver's stored secret in the same window as the rotate call. |
| A leased retry worker delivered webhooks (`maxAttempts` / `nextAttemptAt` / `leaseUntil`, status `RETRYING`) | The delivery sweeper does, with `WEBHOOK_MAX_ATTEMPTS` back to `3` per in-process loop (a real ceiling of 9 across sweeps). `WEBHOOK_MAX_BACKOFF_MS`, `WEBHOOK_WORKER_*`, `WEBHOOK_LEASE_MS`, `WEBHOOK_FANOUT_CONCURRENCY` and `WEBHOOK_PAUSE_AFTER_FAILURES` are gone, and no delivery is ever written as `RETRYING`. |
| `SWAP_EXPIRED` and `LIQUIDITY_EXPIRED` were emitted | Neither is emitted. Expiry is still recorded on the row; poll it, or subscribe to the `*_FAILED` events. |
| `GET /v1/products` filtered on `kind`, `active` and `reference`, and `DELETE` took `hard=true` | Neither exists. Deletes are soft (`active=false`). |
| `GET /v1/products` and `GET /v1/customers` defaulted to `take=20` | Both default to `take=100` (still the maximum), so an unparameterised call returns more rows than it did. |
| `analytics.apiLogs` / `analytics.webhookLogs` returned `{ data, total }` and honoured `take` only | Both are paginated like every other list: `take` + `skip` in, `{ data, total, take, skip, hasMore }` out. The overview's date-range filters are gone. |
| `/v1/health` reported a Stellar readiness indicator alongside the database | It reports the database only. |
| `STELLAR_HTTP_TIMEOUT_MS`, `STELLAR_MAX_ATTEMPTS`, `STELLAR_RETRY_BASE_MS` bounded Horizon calls | Horizon bounding lives in `stellar/stellar.constants.ts` and is not configurable by environment. Those three variables are no longer read or validated. |

**Nothing is dropped from the database.** The columns, indexes and enum values
those features added (`webhook_delivery.maxAttempts` / `nextAttemptAt` /
`leaseUntil`, `webhook_endpoint.previousSecret*`, `swap` and
`liquidity_pool_operation` `lastCheckedAt` / `notFoundStreak`, the
`horizon_account_cursor` table, `RETRYING`, `SWAP_EXPIRED`, `LIQUIDITY_EXPIRED`)
are still declared in `schema.prisma` and present after `migrate deploy`; they
are just no longer written. Removing them would need a destructive migration
(PostgreSQL cannot drop an enum value without recreating the type).

## Environment variables

Every variable read from `process.env` in `src/` is validated at boot by
`src/config/env.validation.ts` (fail-fast). Copy `.env.example` and adjust
at least `DATABASE_URL` and `APISIX_GATEWAY_SECRET`.

| Variable | Required | Default | Effect |
| -------- | -------- | ------- | ------ |
| `NODE_ENV` | no | `development` | Must be `development`, `test`, or `production`. **Set `production` in production** — the fail-closed plan-fee check and docs-off-by-default both key on it |
| `PORT` | no | `3000` | HTTP listen port |
| `ENV_FILE` | no | `.env` | The dotenv file this process reads (Nest and Prisma). Local instances share it — what differs per instance is in `dev-instances.json` (`npm run dev:local`); values already in the environment still win |
| `DATABASE_URL` | **yes** | — | PostgreSQL connection for Prisma |
| `APISIX_GATEWAY_SECRET` | **yes** | — | Shared secret proving the request came through APISIX. **Minimum 32 characters**; a placeholder is refused at boot |
| `APISIX_GATEWAY_SECRET_HEADER` | no | `x-gateway-secret` | Header name for the gateway secret |
| `APISIX_CONSUMER_HEADER` | no | `x-consumer-username` | Authenticated consumer username |
| `APISIX_CREDENTIAL_HEADER` | no | `x-credential-identifier` | Credential id from key-auth |
| `APISIX_ENVIRONMENT_HEADER` | no | `x-consumer-env` | Key environment (`dev` / `prod`) |
| `APISIX_ROLE_HEADER` | no | `x-consumer-role` | Consumer role forwarded by gateway |
| `APISIX_PERMISSIONS_HEADER` | no | `x-consumer-permissions` | Permission list forwarded by gateway |
| `APISIX_ORGANIZATION_HEADER` | no | `x-consumer-org` | Organization id |
| `APISIX_PLAN_HEADER` | no | `x-consumer-plan` | Organization plan |
| `APISIX_SWAP_FEE_BPS_HEADER` | no | `x-plan-swap-fee-bps` | Plan swap fee (bps) |
| `APISIX_EMAIL_HEADER` | no | `x-consumer-email` | Verified email of the key's account, forwarded by the gateway. Nothing in this service depends on it today |
| `APISIX_PUBLIC_CONSUMER` | no | — | Username of the shared public consumer (see above). Set it wherever a public key is published |
| `PUBLIC_API_KEY_DEV` | no | — | The shared public key for testnet, served by `GET /v1/public-key?env=dev`. Unset answers `503 misconfigured` |
| `PUBLIC_API_KEY_PROD` | no | — | The same for mainnet (`env=prod`) |
| `PUBLIC_RECORD_TOKEN_REQUIRED_ON_LEGACY` | no | `false` | With the shared public key, require `X-Record-Token` on `POST /v1/swaps/{id}/submit` and `POST /v1/cross-chain-swaps/{id}/deposit` too (a wrong token is refused either way). Turn it on once the wallet sends the token from the create response |
| `APISIX_ADMIN_URL` | with the admin key | — | APISIX Admin API base, e.g. `http://apisix:9180/apisix/admin`. Used only to mint wallet accounts' keys |
| `APISIX_ADMIN_KEY` | for the wallet sign-in | — | APISIX admin key. Gateway-wide — see [No request depends on the developer platform](#no-request-depends-on-the-developer-platform). Refused on a recovery server |
| `APISIX_ADMIN_TIMEOUT_MS` | no | `10000` | Budget for one Admin API call (ms) |
| `WALLET_KEY_SWAP_FEE_BPS` | no | `65` | Swap commission baked into wallet accounts' keys (the `community` plan's rate) |
| `MAIL_RESEND_API_KEY` | for the email door | — | Resend API key this service sends sign-in and recovery codes with |
| `MAIL_FROM` | with the Resend / SMTP key | — | Verified sender, e.g. `Cosmos Pay <no-reply@example.com>` |
| `MAIL_SMTP_HOST` | no | — | SMTP server, used when `MAIL_RESEND_API_KEY` is unset |
| `MAIL_SMTP_PORT` | no | `587` | SMTP port |
| `MAIL_SMTP_SECURE` | no | `false` | `true` for implicit TLS (465), `false` for STARTTLS (587) |
| `MAIL_SMTP_USER` | no | — | SMTP user |
| `MAIL_SMTP_PASS` | no | — | SMTP password |
| `MAIL_TIMEOUT_MS` | no | `15000` | Budget for one send (ms) |
| `RECOVERY_EMAIL_CODES` | no | `false` | On a recovery server: email its own codes through its `MAIL_*` |
| `WALLET_BACKUP_ENCRYPTION_KEY` | with any sign-in door | — | Seals every stored wallet backup at rest (AES-256-GCM, 32 bytes base64/hex). Lives only in the environment: a copy of the database holds ciphertext of the device's ciphertext. Losing it means the stored backups cannot be served |
| `WALLET_BACKUP_ENCRYPTION_PREVIOUS_KEYS` | no | — | Comma-separated retired keys, read-only, for a rotation; drop them after `npm run backups:reencrypt` |
| `STELLAR_NETWORK` | no | `testnet` | Fallback Stellar network (`public` / `testnet`) |
| `STELLAR_HORIZON_URL_PUBLIC` | no | `https://horizon.stellar.org` | Mainnet Horizon base URL |
| `STELLAR_HORIZON_URL_TESTNET` | no | `https://horizon-testnet.stellar.org` | Testnet Horizon base URL |
| `STELLAR_RPC_URL_MAINNET` | no | `https://soroban-rpc.mainnet.stellar.gateway.fm` | Stellar mainnet's Soroban RPC, for USDT0 transfers (passphrase checked before use). The public endpoint is rate limited: use a provider's in production |
| `USDT0_FEE_WRAPPER` | for merchant fees on USDT0 | — | A deployed `contracts/soroban/usdt0-fee-wrapper` bound to USDT0's OFT and token. Without it a USDT0 transfer with a merchant fee answers `merchant_fee_unsupported`; a contract that does not run the pinned wasm, or is bound to anything else, answers `503 misconfigured`. It also carries the plan commission; without it USDT0 transfers charge none. |
| `SOLANA_RPC_URL_MAINNET` | no | `https://api.mainnet-beta.solana.com` | Solana RPC for `prod` keys (mainnet-beta, genesis hash checked before use). The public endpoint is rate-limited: use a provider's in production |
| `SOLANA_RPC_URL_DEVNET` | no | `https://api.devnet.solana.com` | Solana RPC for `dev` keys (devnet) |
| `SOLANA_RPC_TIMEOUT_MS` | no | `10000` | Budget for one Solana RPC call (ms) |
| `MONAD_RPC_URL_MAINNET` | no | `https://rpc.monad.xyz` | Monad RPC for `prod` keys (chain id 143, checked before use) |
| `MONAD_RPC_URL_TESTNET` | no | `https://testnet-rpc.monad.xyz` | Monad RPC for `dev` keys (chain id 10143) |
| `MONAD_RPC_TIMEOUT_MS` | no | `10000` | Budget for one Monad RPC call (ms) |
| `MONAD_LOG_BLOCK_RANGE` | no | `100` | Blocks one `eth_getLogs` may span — the RPC provider's limit (the public RPC allows 100) |
| `MONAD_RELAYER_PRIVATE_KEY` | no | — | Relayer key (32-byte hex). Set, every Monad intent gets its own deposit address and the relayer forwards deposits to the merchant, less a fee. Holds gas money only: the forwarders it deploys can pay nobody else |
| `MONAD_DEPOSIT_TOKEN_FEES` | no | — | Relayer fee per ERC-20 deposit, JSON `{"0xToken": "0.05"}` in token units. A token with no entry is forwarded free (the relayer pays the gas) |
| `STELLAR_BASE_FEE` | no | `100` | Stellar base fee (stroops) for tx builds |
| `STELLAR_TX_TIMEOUT` | no | `300` | Transaction timeout (seconds) |
| `STELLAR_SWAP_FEE_WALLET` | when fee > 0 | — | Platform G... account for swap fees |
| `STELLAR_SWAP_FEE_BPS` | no | `65` | Swap fee in basis points |
| `STELLAR_SWAP_SLIPPAGE_BPS` | no | `50` | Default swap slippage tolerance (bps) |
| `STELLAR_SWAP_MAX_SLIPPAGE_BPS` | no | `500` | Hard cap on caller slippage (bps) |
| `STELLAR_SWAP_SINGLE_INFLIGHT` | no | `false` | When `true`, 409 if a non-expired PENDING swap already exists for the same source |
| `NEAR_INTENTS_BASE_URL` | no | `https://1click.chaindefuser.com` | NEAR Intents 1Click API, for cross-chain swaps |
| `NEAR_INTENTS_API_KEY` | recommended | — | 1Click partner key (`X-API-Key`). Without it 1Click adds a 0.2% fee of its own and takes half of the commission |
| `NEAR_INTENTS_FEE_RECIPIENT` | with a plan commission | — | NEAR account the cross-chain commission is paid to (`appFees`). Unset with a plan rate: `503 misconfigured` |
| `SWAP_COMMISSION_DEV_WAIVER` | no | `false` | Outside production, waive (and log) a plan commission whose recipient (`NEAR_INTENTS_FEE_RECIPIENT`, `SOLANA_SWAP_FEE_WALLET`, `MONAD_SWAP_FEE_WALLET`) is not set, instead of answering `503 misconfigured`. For a local service only: the boot refuses it when `NODE_ENV=production` |
| `NEAR_INTENTS_TIMEOUT_MS` | no | `20000` | Budget for one 1Click call (ms) |
| `NEAR_INTENTS_TOKENS_PREFETCH` | no | `true` | Fetch 1Click's token list at boot; later it is refreshed in the background while the one on hand is served. `false` leaves the first fetch to the first caller |
| `CROSS_CHAIN_SWAP_SLIPPAGE_BPS` | no | `100` | Default cross-chain slippage (bps); below the minimum NEAR Intents refunds |
| `CROSS_CHAIN_SWAP_MAX_SLIPPAGE_BPS` | no | `500` | Most slippage a caller may ask for |
| `CROSS_CHAIN_SWAP_DEADLINE_SECONDS` | no | `1800` | How long a deposit address accepts the deposit; later ones are refunded |
| `SOLANA_SWAP_FEE_WALLET` | with a plan commission | — | Owner of the token accounts the Solana swap commission is paid into (Jupiter `feeAccount`, one per output mint — create them first). Unset with a plan rate: `503 misconfigured` |
| `MONAD_SWAP_FEE_WALLET` | with a plan commission | — | Address the Monad swap commission is paid to (Kuru Flow `referrerAddress`) |
| `JUPITER_BASE_URL` | no | `https://lite-api.jup.ag/swap/v1` | Jupiter Swap API; `https://api.jup.ag/swap/v1` with a key |
| `JUPITER_API_KEY` | no | — | Jupiter API key (`x-api-key`), for higher limits |
| `JUPITER_TIMEOUT_MS` | no | `15000` | Budget for one Jupiter call (ms) |
| `KURU_BASE_URL` | no | `https://ws.kuru.io` | Kuru Flow API (Monad) |
| `KURU_API_KEY` | for production | — | Kuru Flow API key (`X-API-Key`). Without it every address gets a token limited to one request a second |
| `KURU_TIMEOUT_MS` | no | `15000` | Budget for one Kuru Flow call (ms) |
| `KURU_MERCHANT_FEE_ROUTER` | for merchant fees on Monad | — | A deployed `contracts/MerchantFeeSwapRouter.sol` for Kuru Flow's router. Without it a Monad swap with a merchant fee answers `merchant_fee_unsupported`; an address whose code is not the artifact's answers `503 misconfigured` |
| `ANALYTICS_CACHE_TTL_MS` | no | `10000` | How long `/v1/summary`, `/v1/summary/series` and `/v1/balances` reuse an answer per consumer and network (ms), per replica. `0` turns it off |
| `OBSERVER_ENABLED` | no | `true` | `true` / `false` — on-chain reconciler |
| `OBSERVER_INTERVAL_MS` | no | `15000` | Observer poll interval (ms, min 1000) |
| `OBSERVER_BATCH_SIZE` | no | `50` | Max intents/swaps per observer tick |
| `PAYMENT_INTENT_TTL_SECONDS` | no | `3600` | Unpaid intent lifetime before `EXPIRED` |
| `PAYMENT_LINK_CHECKOUT_URL` | no | `https://payments.cosmospay.lat` | The hosted checkout a Stellar payment link with a merchant fee opens (`<url>/<id>`) |
| `PAYMENT_LINK_API_URL` | no | `WALLET_AUTH_PUBLIC_BASE_URL` | The gateway's public URL for this API, which a Solana payment link with a merchant fee names as its Solana Pay transaction request; without it such a link answers `503 misconfigured` |
| `WEBHOOK_TIMEOUT_MS` | no | `5000` | Legacy webhook timeout fallback (ms) |
| `WEBHOOK_CONNECT_TIMEOUT_MS` | no | `3000` | Outbound webhook connect budget (ms) |
| `WEBHOOK_READ_TIMEOUT_MS` | no | `5000` | Outbound webhook read budget (ms) |
| `WEBHOOK_MAX_RESPONSE_BYTES` | no | `65536` | Max drained webhook response body |
| `WEBHOOK_MAX_ATTEMPTS` | no | `3` | Delivery retry count |
| `WEBHOOK_BACKOFF_MS` | no | `2000` | Linear backoff between retries (ms) |
| `WEBHOOK_SIGNATURE_HEADER` | no | `x-cosmos-signature` | HMAC header sent to integrators |
| `WEBHOOK_SWEEP_ENABLED` | no | `true` | Recover deliveries stranded by a crash. Incident switch |
| `WEBHOOK_SWEEP_INTERVAL_MS` | no | `60000` | Sweeper interval (ms, min 1000) |
| `WEBHOOK_PAYLOAD_RETENTION_DAYS` | no | `30` | Days to keep a settled delivery body before redacting it. `0` keeps it forever |
| `REQUEST_LOG_RETENTION_DAYS` | no | `30` | Days to keep `request_log` rows (payer IP / user-agent). `0` disables the prune |
| `ACTIVITY_RETENTION_DAYS` | no | `30` | Days to keep `activity_event` rows (client IP / user-agent / `props`). Pruned by the same job. `0` keeps events forever |
| `REQUEST_LOG_PRUNE_INTERVAL_MS` | no | `3600000` | Retention timer interval (ms) |
| `REQUEST_LOG_PRUNE_BATCH_SIZE` | no | `1000` | Rows per delete batch (keeps each lock short) |
| `REQUEST_LOG_PRUNE_MAX_PER_CYCLE` | no | `50000` | Hard cap on rows examined per tick |
| `SWAGGER_ENABLED` | no | off in `production` | Publish `/docs` (Express middleware, no guards) |
| `OPENAPI_SERVER_URL` | no | — | Gateway host stamped into exported OpenAPI |
| `BLINDPAY_API_KEY` | no | — | API key of the production BlindPay instance, served to `prod` keys |
| `BLINDPAY_INSTANCE_ID` | when API key set | — | BlindPay instance id (`in_...`) |
| `BLINDPAY_BASE_URL` | no | `https://api.blindpay.com/v1` | BlindPay API base URL |
| `BLINDPAY_WEBHOOK_SECRET` | when API key set | — | Svix secret for inbound BlindPay webhooks: the whole `whsec_…` value, whose key must decode to at least 24 bytes (checked at boot) |
| `BLINDPAY_API_KEY_DEV` | no | — | API key of the development BlindPay instance, served to `dev` keys. Unset: BlindPay routes answer `dev` keys `503 misconfigured` |
| `BLINDPAY_INSTANCE_ID_DEV` | when dev API key set | — | Development instance id (`in_...`) |
| `BLINDPAY_WEBHOOK_SECRET_DEV` | when dev API key set | — | Svix secret of the development instance's webhook endpoint; same rules as `BLINDPAY_WEBHOOK_SECRET` |
| `BLINDPAY_TIMEOUT_MS` | no | `15000` | BlindPay HTTP client timeout (ms) |
| `DEFINDEX_API_KEY` | no | — | DeFindex server API key. The routes exist only with `defindex` in `PLUGINS_ENABLED`; without the key they answer `503 misconfigured` |
| `DEFINDEX_BASE_URL` | no | `https://api.defindex.io` | DeFindex API base URL |
| `DEFINDEX_TIMEOUT_MS` | no | `30000` | DeFindex HTTP timeout (ms) |
| `PLUGINS_ENABLED` | no | — | Comma-separated plugin slugs this deployment serves: sandboxed ones in `plugins/`, and the native `blindpay` and `defindex`. Empty serves none; a plugin not listed is never loaded |
| `PLUGINS_SECRET` | when an enabled plugin has secret settings | — | Seals the secret settings of plugin installations (at least 32 characters). Changing it makes every stored plugin secret unreadable |
| `PLUGINS_TRUSTED_KEYS` | no | — | Signers whose plugins run here besides Cosmos Pay support: comma-separated `<keyId>:<base64url Ed25519 public key>`. A plugin signed by anyone else, or changed after signing, stops the boot |
| `PLUGINS_ALLOW_UNSIGNED` | no | `false` | Run plugins with no `signature.json`, for writing one locally. Refused when `NODE_ENV=production` |
| `KYC_REDIRECT_URL_WHITELIST` | no | — | Per-consumer KYC redirect host allow-list |
| `WALLET_AUTH_RETURN_URLS` | no | — | Comma-separated app URLs the wallet sign-in callback may redirect to (`returnTo` on `POST /v1/wallet/auth/oauth/authorize`): a custom scheme, a universal/app link, or `http://127.0.0.1/…` (any port). Exact match; an entry that is plain http off loopback, carries a query or uses `javascript:`/`data:`/`file:` is refused at boot. Unset, every callback renders the page and a `returnTo` is `400 wallet_return_url_not_allowed` |
| `WALLET_AUTH_SIGNERS_HORIZON_URL` | no | `STELLAR_NETWORK`'s Horizon | Lists who may sign for an account, read when a recovered wallet signs with the key that replaced its master. Must be the ledger the wallets live on: another one answers 404 and the sign-in is `400 wallet_signature_invalid` |
| `WALLET_RECOVERY_SPONSOR_NETWORK_PASSPHRASE` | no | `STELLAR_NETWORK`'s passphrase | Network the sponsored recovery setup (`POST /v1/wallet/recovery/setup`) is built for |
| `WALLET_RECOVERY_SPONSOR_HORIZON_URL` | no | `STELLAR_NETWORK`'s Horizon | Horizon the sponsored recovery setup reads the account from |
| `RATE_LIMIT_ENABLED` | no | `true` | Per-address caps on the routes that spend XLM. Incident switch |
| `RATE_LIMIT_PRUNE_INTERVAL_MS` | no | `600000` | Counter-window prune interval (ms, min 1000) |
| `ZK_PAYMENTS_TESTNET_TOKEN` | for private payments on testnet | none | Cosmos Pay's confidential token on testnet (C...). Its presence turns private payments on for `dev` keys; with it, every other variable of the set except `_RPC_URL` is required at boot |
| `ZK_PAYMENTS_TESTNET_AUDITOR_REGISTRY` | with the token | none | The auditor registry holding Cosmos Pay's key under id 0 (C...) |
| `ZK_PAYMENTS_TESTNET_VERIFIER` | with the token | none | The UltraHonk verifier registry the token checks proofs with (C...) |
| `ZK_PAYMENTS_TESTNET_AUDITOR_SECRET` | with the token | none | The auditor scalar `k` (64 hex): every confidential amount on the token decrypts under it. A secret of the gateway secret's weight; never in the repository |
| `ZK_PAYMENTS_TESTNET_FEE_ACCOUNT` | with the token | none | The account the 0.18% commission is transferred to (G...), registered on the token |
| `ZK_PAYMENTS_TESTNET_DEPLOYED_LEDGER` | with the token | none | The ledger the token was deployed at, where a wallet replays its balance from |
| `ZK_PAYMENTS_TESTNET_RPC_URL` | no | `https://soroban-testnet.stellar.org` | The Soroban RPC private payments read the chain through; its network passphrase is checked before use |
| `ZK_PAYMENTS_MAINNET_*` | no | none | The same set for `prod` keys (`_TOKEN`, `_AUDITOR_REGISTRY`, `_VERIFIER`, `_AUDITOR_SECRET`, `_FEE_ACCOUNT`, `_DEPLOYED_LEDGER`, `_RPC_URL`). Unset: private payments are off on mainnet. `_RPC_URL` has no default there and is required with the set |

Legacy `STELLAR_HORIZON_URL` is rejected at boot — use
`STELLAR_HORIZON_URL_PUBLIC` / `STELLAR_HORIZON_URL_TESTNET` instead.

## Getting started

```bash
cp .env.example .env          # set DATABASE_URL and a strong APISIX_GATEWAY_SECRET
npm install
npm run db:generate           # prisma generate
npm run db:migrate            # create the schema (needs a running Postgres)
npm run start:dev
```

Generate a secret:

```bash
openssl rand -hex 32
```

Run the same checks CI runs (no database needed — Prisma is mocked):

```bash
npm run lint
npm test                 # unit suites (src/**/*.spec.ts)
npm run test:e2e         # e2e suites (test/*.e2e-spec.ts)
npm run openapi:check    # the committed contract matches the controllers
npm run readme:check     # the seven READMEs match in structure and list every route
```

## APISIX route configuration

The dev platform's route helper (`paydev/src/utils/apisix.ts`) already converts
`Authorization: Bearer <token>` into the `apikey` header, validates `key-auth`,
and strips credentials before proxying. To point a route at this service, add the
**gateway secret injection** to the `proxy-rewrite` plugin so the header arrives
here — and remove any client-supplied copy:

```jsonc
"proxy-rewrite": {
  "regex_uri": ["^/payments-api/(.*)", "/v1/$1"],
  "headers": {
    "set": {
      // must equal APISIX_GATEWAY_SECRET in this service's environment
      "X-Gateway-Secret": "<the-shared-secret>"
    },
    "remove": [
      // credentials
      "Authorization", "apikey", "X-API-KEY",

      // ── Authorization inputs: this service trusts them as-is. ──
      // key-auth does not overwrite them, so whatever the client sends arrives
      // here unless it is removed below (the route then sets them from the
      // consumer's metadata). Leaving any of them out is a privilege escalation:
      //
      //   X-Consumer-Role: admin      → bypasses every scope check
      //   X-Consumer-Permissions      → grants arbitrary scopes
      //   X-Consumer-Env: prod        → moves the caller onto Stellar MAINNET
      //   X-Plan-Swap-Fee-Bps: 0      → zero platform commission on swaps
      //                                 and liquidity-pool withdrawals
      //   X-Consumer-Org              → attribution / plan resolution
      //   X-Consumer-Plan             → plan tier
      //   X-Cosmos-Internal           → admits the call to /v1/admin (every
      //                                 tenant's data, read and write)
      //   X-Cosmos-Admin-Role         → labels the admin audit trail
      //   X-Cosmos-Tos-Cooldown-Ms    → relaxes the KYC email resend limit
      "X-Consumer-Role",
      "X-Consumer-Permissions",
      "X-Consumer-Env",
      "X-Plan-Swap-Fee-Bps",
      "X-Consumer-Org",
      "X-Consumer-Plan",
      "X-Cosmos-Internal",
      "X-Cosmos-Admin-Role",
      "X-Cosmos-Tos-Cooldown-Ms"
    ]
  }
}
```

`key-auth` forwards `X-Consumer-Username` / `X-Credential-Identifier` to the
upstream after a successful auth, overwriting any client-supplied copy, and the
guard relies on that.

> **The remove list is a security control, and it cannot be verified from this
> repository.** This service accepts every header in it at face value;
> `X-Gateway-Secret` only proves the request came through a gateway, not that
> those values are honest. Review the list whenever a route is added or copied.
> `X-Cosmos-Internal` no longer depends on it — the service verifies a MAC keyed
> by the gateway secret — but every `X-Consumer-*` header still does, and a route
> that forwards a client's copy lets it name any consumer. Keep the service on a private network so APISIX is the only way
> in; the shared secret is a second layer, not the only one.
>
> In production, a missing `X-Plan-Swap-Fee-Bps` returns `503` instead of falling
> back to the environment default.
