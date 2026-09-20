# Cosmos Pay — Payments Microservice

**English** · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [हिन्दी](./docs/i18n/README.hi.md) · [简体中文](./docs/i18n/README.zh.md)

Payments microservice built with **NestJS 12** + **Prisma 7 (PostgreSQL)**.

It is a *separate* application from the Cosmos developer platform (`paydev`). The
dev platform only **issues** APISIX access tokens (consumers + `key-auth`
credentials) for downstream services. This service is one of those downstream
services: it sits **behind APISIX**, which load-balances and authenticates every
request before forwarding it here. The service therefore never sees raw API keys
— it only trusts what the gateway forwards.

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

`/v1/admin` is cross-tenant, so `AdminGuard` also requires `X-Cosmos-Internal`.
APISIX **removes** that header from everything it proxies, so only a backend
calling the service directly with the gateway secret can send it — the developer
platform, which decides whether the signed-in account is an owner or admin. There
is no separate admin credential: the gateway secret, network isolation and the
header remove list in the gateway route are what protect cross-tenant data.

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
    *-whitelist.ts                KYC and Pollar redirect allow-lists
  prisma/                         PrismaModule + PrismaService (global)
  common/
    guards/apisix.guard.ts        THE gateway gate
    guards/public-key.guard.ts    confines the SHARED public key to @AllowPublicKey routes
    guards/console-only.guard.ts  confines a route to the platform console (alias recovery start)
    middleware/apisix-context...  extracts consumer identity from gateway headers
    decorators/                   @Public(), @CurrentConsumer(), @AllowPublicKey()
    filters/                      consistent error responses
    interceptors/                 structured access logging
    interfaces/                   GatewayConsumer + Express Request augmentation
    validators/                   IsStellarAddress (StrKey-based)
    errors/api-error.ts           ApiError + machine-readable ApiErrorCode
    services/advisory-lock...     cluster-wide lock for the background timers
  stellar/                        per-network Horizon servers (bounded timeout), account loader,
                                  SEP-7 links, signed-envelope relay, settlement repository
  payment-intents/                Stellar payment intents (controller, service, DTO) — emits events
  private-rfqs/                   Sub Rosa sealed-quote registration, reveal, selection + payment handoff
  swaps/                          Stellar native swaps (path payments): quote, build XDR, submit
  liquidity-pools/                AMM deposit/withdraw, pool + position reads, cost basis + commission on gain
  observer/                       background reconciler: swaps + LP ops against Horizon, one adapter per table
  webhooks/                       webhook endpoints CRUD + dispatcher (HMAC-signed, retried)
  blindpay/                       BlindPay core: HTTP client, Svix verify, sync + inbound webhook
  kyc/                            receivers (KYC/KYB), wallets, bank accounts, doc upload
  onramp/                         fiat → stablecoin: payin quotes, payins, virtual accounts
  offramp/                        stablecoin → fiat: payout quotes, payouts (client-signed)
  pollar/                         Pollar OAuth bridge (social login → a wallet on both networks) + operator routes
  products/                       merchant catalogue
  customers/                      payer records derived from intents
  aliases/                        claimable payment handles: signed claims, resolution, email recovery
  assets/                         curated asset registry: the (code, issuer) pairs vouched for, per network
  analytics/                      summary, balances, API logs, webhook logs
  activity/                       client telemetry ingest + feed (wallet, dashboard)
  admin/                          cross-tenant platform admin (console-only), audited
  audit/                          audit-trail writer, called inside other modules' transactions
  health/                         liveness/readiness probes (@Public)
prisma/schema.prisma              Consumer, PaymentIntent, Swap, LiquidityPoolOperation,
                                  WebhookEndpoint/Delivery/EmittedEvent, BlindpayReceiver,
                                  Blockchain/BankAccount/VirtualAccount, BlindpayQuote,
                                  BlindpayWebhookEvent, Payin, Payout, PollarOauthSession,
                                  PollarUserWallet, RequestLog, ActivityEvent,
                                  AdminAuditLog, Alias, AliasAddress,
                                  AliasChallenge, AliasRecovery
test/                             e2e suites: gateway gate, admin + alias console gates,
                                  payment intents, swaps, liquidity pools, KYC, webhooks,
                                  Pollar
scripts/                          OpenAPI generator, README check, operator scripts
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
| Payment intents   | `/v1/payment-intents`    | SEP-7 `tx` / `pay` intents, validation, on-chain observer |
| Private RFQs      | `/v1/private-rfqs`       | Sub Rosa sealed quotes before a Cosmos Pay intent         |
| Swaps             | `/v1/swaps`              | Path-payment quote, build unsigned XDR, submit signed     |
| Liquidity pools   | `/v1/liquidity-pools`    | AMM deposit / withdraw, positions, commission on gain     |
| Webhooks          | `/v1/webhooks`           | Endpoint CRUD, secret rotation, deliveries, redelivery    |
| KYC               | `/v1/kyc`                | Receivers (KYC/KYB), wallets, bank accounts, doc upload   |
| Onramp            | `/v1/onramp`             | Payin quotes, payins, virtual accounts                    |
| Offramp           | `/v1/offramp`            | Payout quotes, authorize, payouts (client-signed)         |
| Products          | `/v1/products`           | Merchant catalogue                                        |
| Customers         | `/v1/customers`          | Payer records derived from intents                        |
| Aliases           | `/v1/aliases`            | Claimable payment handles: claim, resolve, recover        |
| Assets            | `/v1/assets`             | Curated asset registry per network                        |
| Pollar            | `/v1/pollar`             | OAuth bridge (social login → wallet) + operator routes    |
| Analytics         | `/v1/summary`, `/v1/balances`, `/v1/logs` | Dashboard aggregates and logs            |
| Activity          | `/v1/activity`           | Client-reported events: ingest, feed, rollup               |
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
| GET | `/v1/admin/consumers` | platform console |  |
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
| POST | `/v1/aliases/{name}/recovery` | platform console |  |
| POST | `/v1/aliases/{name}/recovery/complete` | `payments:write` |  |
| GET | `/v1/assets` | — | ✓ |
| GET | `/v1/balances` | `payments:read` |  |
| POST | `/v1/blindpay/webhooks` | none — `@Public()`, Svix signature |  |
| GET | `/v1/customers` | `customers:read` |  |
| POST | `/v1/customers` | `customers:write` |  |
| GET | `/v1/customers/{id}` | `customers:read` |  |
| PATCH | `/v1/customers/{id}` | `customers:write` |  |
| DELETE | `/v1/customers/{id}` | `customers:write` |  |
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
| GET | `/v1/private-rfqs` | `private-rfqs:read` |  |
| POST | `/v1/private-rfqs` | `private-rfqs:write` |  |
| GET | `/v1/private-rfqs/{id}` | `private-rfqs:read` |  |
| POST | `/v1/private-rfqs/{id}/payment-intent` | `private-rfqs:write`, `payments:write` |  |
| POST | `/v1/private-rfqs/{id}/select` | `private-rfqs:write` |  |
| POST | `/v1/private-rfqs/{id}/sync` | `private-rfqs:write` |  |
| POST | `/v1/pollar/oauth/authorize` | `pollar:write` |  |
| GET | `/v1/pollar/oauth/callback` | none — `@Public()` |  |
| GET | `/v1/pollar/oauth/callback/{state}` | none — `@Public()` |  |
| POST | `/v1/pollar/oauth/logout` | `pollar:write` |  |
| POST | `/v1/pollar/oauth/refresh` | `pollar:write` |  |
| GET | `/v1/pollar/oauth/sessions/{state}` | `pollar:read` |  |
| POST | `/v1/pollar/oauth/token` | `pollar:write` |  |
| POST | `/v1/pollar/tokens/verify` | `pollar:read` |  |
| POST | `/v1/pollar/users` | `pollar:write` |  |
| POST | `/v1/pollar/users/with-wallet` | `pollar:write` |  |
| POST | `/v1/pollar/wallets/activate` | `pollar:write` |  |
| POST | `/v1/pollar/wallets/{address}/trustlines` | `pollar:write` |  |
| POST | `/v1/pollar/wallets/{address}/trustlines/default` | `pollar:write` |  |
| DELETE | `/v1/pollar/wallets/{address}/trustlines/{code}/{issuer}` | `pollar:write` |  |
| GET | `/v1/products` | `products:read` |  |
| POST | `/v1/products` | `products:write` |  |
| GET | `/v1/products/{id}` | `products:read` |  |
| PATCH | `/v1/products/{id}` | `products:write` |  |
| DELETE | `/v1/products/{id}` | `products:write` |  |
| GET | `/v1/summary` | `payments:read` |  |
| GET | `/v1/swaps` | `swaps:read` |  |
| POST | `/v1/swaps` | `swaps:write` | ✓ |
| POST | `/v1/swaps/quote` | `swaps:read` | ✓ |
| GET | `/v1/swaps/{id}` | `swaps:read` |  |
| POST | `/v1/swaps/{id}/submit` | `swaps:write` | ✓ |
| GET | `/v1/webhooks` | `webhooks:read` |  |
| POST | `/v1/webhooks` | `webhooks:write` |  |
| GET | `/v1/webhooks/{id}` | `webhooks:read` |  |
| PATCH | `/v1/webhooks/{id}` | `webhooks:write` |  |
| DELETE | `/v1/webhooks/{id}` | `webhooks:write` |  |
| GET | `/v1/webhooks/{id}/deliveries` | `webhooks:read` |  |
| POST | `/v1/webhooks/{id}/deliveries/{deliveryId}/redeliver` | `webhooks:write` |  |
| POST | `/v1/webhooks/{id}/ping` | `webhooks:write` |  |
| POST | `/v1/webhooks/{id}/rotate-secret` | `webhooks:write` |  |

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
`ApiErrorBodyEntity` on every operation, so generated clients get the error type
too (source: `ApiErrorCode` in `src/common/errors/api-error.ts`). **Codes are
never renamed once published**; new ones may be added, so treat an unrecognised
code as its HTTP status.

A few that are easy to confuse:

| Code | Status | Means |
| ---- | ------ | ----- |
| `insufficient_scope` | 403 | The API key lacks the scope. Re-provision the key |
| `account_disabled` | 403 | An operator disabled this fiat account. Not a key problem |
| `gateway_required` | 403 | The request did not arrive through APISIX |
| `admin_console_only` | 403 | The route belongs to the platform console (`/v1/admin`, starting an alias recovery). No API key can call it |
| `elevated_key_required` | 403 | The route writes to something every tenant shares (the Pollar user directory). Only an elevated (admin) key may call it; more scopes will not help |
| `pollar_identity_required` | 403 | The gateway forwarded no account email for this key, so a Pollar login cannot be tied to it |
| `pollar_identity_mismatch` | 403 | The Pollar login was completed by a different account than the key's. The session was revoked, not returned |
| `idempotency_conflict` | 409 | This `Idempotency-Key` (or payment-intent memo) already produced a resource for a *different* request. Repeat the original request, or use a new key |
| `kyc_state_invalid` | 409 | An illegal KYC state transition — not a duplicate request |
| `operation_in_flight` | 409 | A conflicting operation is still settling |
| `payload_expired` | 409 | The delivery body is past retention and cannot be re-sent |
| `provider_unavailable` | 503/504 | BlindPay or Horizon is unreachable. Retry |
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
| `StellarObserverService`       | `PaymentIntentObserver`  |
| `RequestLogRetentionService`   | `RequestLogRetention`    |
| Webhook delivery sweeper       | `WebhookDeliverySweeper` |
| `PollarOauthSweeperService`    | `PollarOauthSweeper`     |
| `RateLimitPruneService`        | `RateLimitPrune`         |
| `PollarWalletProvisionSweeperService` | `PollarWalletProvisionSweeper` |
| `AliasChallengeSweeperService` | `AliasChallengeSweeper`  |

`pg_try_advisory_xact_lock` never blocks, and it is released when the
transaction ends, even on a crash or a dropped connection. Unlike a session-level
lock, it also works behind PgBouncer in transaction-pooling mode.

Lock ids live in the `AdvisoryLockKey` enum. Do not renumber an existing id —
during a rolling deploy, old and new replicas would take different locks — and do
not reuse a retired one.

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
- **Automatic (permanent observer):** `StellarObserverService` polls Horizon
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

Dashboard traffic (`X-Cosmos-Internal`) is **recorded and flagged**
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
`LIQUIDITY_FAILED`, `PRIVATE_RFQ_CREATED`, `PRIVATE_RFQ_REVEALED`,
`PRIVATE_RFQ_SELECTED`, plus the BlindPay-sourced `RECEIVER_UPDATED`, `PAYIN_CREATED`,
`PAYIN_UPDATED`, `PAYIN_COMPLETED`, `PAYOUT_CREATED`, `PAYOUT_UPDATED` and
`PAYOUT_COMPLETED`. The authoritative list is the `WebhookEventType` enum in
`prisma/schema.prisma`.

**BlindPay-sourced bodies.** `RECEIVER_UPDATED` / `PAYIN_*` / `PAYOUT_*` carry
identity and state only — ids, status, amounts, rails — never personal data. The
provider object is not forwarded, because a receiver payload is a full KYC
dossier and subscribing only needs `webhooks:write`. Fetch the details from the
API with a key that holds `kyc:read` / `onramp:read` / `offramp:read`. The field
allowlist is in `src/blindpay/blindpay-event-redaction.ts`.

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

The two APISIX headers (`X-Gateway-Secret`, `X-Consumer-Username`) are
documented as security schemes in the spec.

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

**`POST /v1/payment-intents/tx`** — the payer (`source`) is known, so we build
the unsigned `TransactionEnvelope` and a `web+stellar:tx?xdr=...` URI.

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

## Private RFQs with Sub Rosa

Private RFQs add a sealed competitive-quote step before the existing Cosmos Pay
payment-intent flow. Cosmos Pay imports `@sub-rosa/sdk` and reads the canonical
Sub Rosa contract directly. The server never holds a Stellar secret key, never
creates or signs a round transaction, and never stores quote plaintext.

The client creates a Sub Rosa Core v2 round with its own wallet using:

- `ReceiptOnly` mode and `LowestBid` clearing;
- the SDK's `SEALED_PROPOSAL_SCHEMA_REF`;
- the canonical Sub Rosa contract for the API key's network; and
- `itemRef = sha256("cosmos-pay:private-rfq:v1:" + reference.trim())`.

It then registers the on-chain round:

```jsonc
POST /v1/private-rfqs
{
  "reference": "rfq_procurement_2026_09",
  "network": "testnet",
  "contractId": "CCOVGOQQZJKZ2R55GRWBLTJTGBAMSHXZVN3ICPG3WRVMLMM6RHISC5OV",
  "roundId": "42",
  "assetCode": "USDC",
  "assetIssuer": "G...",
  "assetDecimals": 7
}
```

`POST /v1/private-rfqs/:id/sync` refreshes the lifecycle from Soroban and emits
`PRIVATE_RFQ_REVEALED` once reveal is complete. `GET /v1/private-rfqs/:id`
performs a live read; proposals stay redacted until the whole reveal is complete
(or the round is cleared/settled). Only the round link, deadlines, lifecycle,
selection and payment-intent id are persisted.

After reveal, select a valid bidder with
`POST /v1/private-rfqs/:id/select { "provider": "G..." }`, then create the
existing Cosmos Pay settlement artifact:

```jsonc
POST /v1/private-rfqs/:id/payment-intent
{ "kind": "TX", "source": "G..." }
```

The selected bidder becomes the destination, the revealed envelope amount is
converted from `assetDecimals`, and the request is handed to
`PaymentIntentsService.createTx` (or `createPay` for `{ "kind": "PAY" }`). The
returned XDR/SEP-7 URI follows the normal non-custodial Cosmos Pay signing flow.
The handoff uses a deterministic MEMO_ID, so concurrent retries resolve to the
same intent.

## The shared public API key

The open-source wallet ships one API key that everybody shares, so anyone can
swap, add liquidity or create a pay link without registering. Those calls pay the
`community` plan's commission (150 bps, the highest rate); registering gets a
lower one. The gateway injects the rate exactly as it does for a private key
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
| `POST /v1/swaps/:id/submit` | Broadcasts a caller-signed envelope — nothing about the swap, not even its status, is answered until the body is that swap's envelope carrying a signature; rate limited |
| `POST /v1/liquidity-pools/deposit` \| `withdraw` | Build unsigned envelopes |
| `POST /v1/liquidity-pools/operations/:id/submit` | Broadcasts a caller-signed envelope, under the same checks as swap submit; rate limited |
| `GET /v1/liquidity-pools` \| `/:poolId` \| `/positions` | Public on-chain data read from Horizon |
| `POST /v1/payment-intents/tx` \| `pay` | Build a SEP-7 intent from the request |
| `POST /v1/activity/events` | Telemetry ingest — see below |
| `GET /v1/assets` | The public asset catalog |
| `GET /v1/aliases/resolve/:name` \| `availability/:name` \| `by-address/:address` | A payer resolving a handle is the anonymous caller this key exists for; the answer is a pure function of the request and never includes the owner's mailbox |

Refused: `GET /v1/swaps`, `GET /v1/swaps/:id`,
`GET /v1/liquidity-pools/operations{,/:id}`, `GET /v1/activity/events`,
`GET /v1/activity/summary`, every payment-intent read, every alias owner route
(claim, list, add or remove an address, release, recovery), and everything under
`/v1/kyc`, `/v1/onramp`, `/v1/offramp` and `/v1/webhooks`. A wallet without an
account reads its history from Horizon instead.

**Telemetry is allowed** so crash reports from wallets without an account still
arrive. Events on this key are anonymous (one shared consumer), so the wallet
strips address, destination, amount and txHash before sending.

The guard identifies the public consumer by **either** the forwarded role
(`X-Consumer-Role: public`) **or** the `APISIX_PUBLIC_CONSUMER` username. Set
both: if the gateway stops forwarding roles, the username still matches, and
without the username the guard depends only on a header.

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

**Trustline.** A non-native destination asset must already be trusted by the
destination account; the build step checks this and returns a clear error
otherwise. (XLM needs no trustline.)

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
//              destEstimated, destMin, path, xdr, uri: "web+stellar:tx?xdr=…", qr, txHash, … }
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

### Recovery goes through email, and through the platform console

A claim records a recovery email so that losing a key does not mean losing the
name. Recovery works like this:

1. The **platform console** calls `POST /v1/aliases/:name/recovery {email}`. The
   response is identical whether or not the handle and mailbox matched; on a match
   it carries a single-use token (30 minutes, stored only as a SHA-256), which the
   console emails. This service sends no mail.
2. The user gets a `RECOVER` challenge for the new key and calls
   `POST /v1/aliases/:name/recovery/complete {token, address, network, nonce, signature}`
   with their own API key. Both proofs are required: the token proves the mailbox,
   the signature proves the key.
3. Ownership moves to the calling consumer and **every previous address is
   removed**, so whoever holds the old keys stops receiving payments.

Step 1 is console-only because the token proves control of the mailbox, so it
must only reach whoever sends the email. `ConsoleOnlyGuard` refuses every API-key
caller with `403 admin_console_only` before the alias is looked up, and the route
is not in the published contract. A suspended alias cannot be recovered.

A recovery token can be presented **five** times. A presentation whose challenge
or signature fails still uses one, and the sixth is refused; the owner can start
another recovery. A token that matches no live recovery of that alias gets the
same `400 alias_recovery_invalid` and changes nothing, so nobody can burn an
owner's recovery by sending junk. `POST /v1/aliases/:name/recovery/complete`
allows 10 calls and `POST /v1/aliases/challenges` 30 calls per 10 minutes, per
consumer and client address (`429 rate_limited`).

Expired challenges and recoveries are deleted a day after they expire by
`AliasChallengeSweeperService` (hourly, one replica per tick).

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
| POST | `/v1/aliases/:name/recovery` | _platform console only_ | Start a recovery → a token for the console to email |
| POST | `/v1/aliases/:name/recovery/complete` | `payments:write` | Finish a recovery with the token and the new key's signature |

## BlindPay — onramp / offramp / KYC (fiat ⇄ stablecoin)

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

## Pollar — social login that hands back a Stellar wallet

[Pollar](https://docs.pollar.xyz/docs) turns a Google/GitHub login into a Stellar
account: it authenticates the user, creates a wallet, custodies the key in AWS
KMS, adds the configured trustlines and funds the reserve — the user never sees a
seed phrase. This service exposes it as an **OAuth bridge**.

### Why a bridge and not a passthrough

Pollar's hosted login is designed for a browser SDK. It hands the user to
`GET /auth/{provider}` with a publishable key, a client-session id and a
`redirect_uri` — and that redirect URI must be a host **registered with Pollar**.
A wallet cannot meet those requirements: a loopback listener or a `cosmospay://`
deep link is never a registered host, and the wallet should not handle those keys
and session ids. So the bridge handles the Pollar side, and the wallet only does
two steps: **open an authorization, redeem a code**.

```
wallet ──1. POST /v1/pollar/oauth/authorize ────────────▶ bridge ──▶ POST /v2/auth/session
       ◀── authorization_url + state ──────────────────── bridge     (Pollar mints a client session)

browser ─2. open authorization_url ──▶ Pollar ──▶ Google/GitHub consent
        ◀─────────────── 3. redirect ─────────── Pollar ──▶ GET /v1/pollar/oauth/callback/{state}
                                                                     (bridge mints a single-use code)

wallet ──4. absorbs the code ────── from its own redirect URI, or GET /oauth/sessions/{state}
wallet ──5. POST /v1/pollar/oauth/token ────────────────▶ bridge ──▶ POST /v2/auth/login
       ◀── access_token + refresh_token + wallet ──────── bridge     (waits for Pollar to be READY)

wallet ──6. talks to Pollar DIRECTLY from here on ──────▶ https://sdk.api.pollar.xyz/v2
```

After step 6 the wallet talks to Pollar directly: the redemption response includes
the `publishable_key` and `api_base_url`, which the wallet uses to read balances
and build and submit transactions. **This service does not proxy those calls.**

### Two ways to absorb the code

|                  | Redirect flow                                    | Poll flow                                       |
| ---------------- | ------------------------------------------------ | ----------------------------------------------- |
| Wallet supplies  | `redirect_uri` (must be allow-listed) and a PKCE `code_challenge` | nothing (PKCE optional)       |
| Code arrives     | as `?code=…&state=…` on the redirect             | from `GET /v1/pollar/oauth/sessions/{state}`    |
| The browser sees | your own URI                                     | a plain "you can close this window" page — never the code |
| Use it when      | the wallet has a deep link or loopback listener  | it has neither (kiosk, headless, embedded view) |

Each poll issues a new code and invalidates the previous one, so redeem the code
from your latest poll. Only a SHA-256 of the code is stored.

**Prefer the poll flow.** Pollar's hosted flow does not send the browser back to
the callback: it ends on its own page (`www.pollar.xyz/auth/status`) and marks the
client session `READY` on Pollar's side. So while a handshake is `pending`, the
poll route checks the client session with Pollar and promotes the handshake as
soon as Pollar reports `READY`.

- **Keep the callback route registered with Pollar.** The redirect flow depends
  on it.
- **Pollar is checked at most once every two seconds per handshake**
  (`POLLAR_SESSION_PROBE_INTERVAL_MS`), shared across replicas through
  `providerCheckedAt`. A wallet polling every second costs 30 Pollar requests a
  minute, against a key budget of 200.

A handshake whose client session Pollar rejects (`INVALID_CLIENT_SESSION_ID`,
`EXPIRED_CLIENT_ID`, or a `404`/`410`) is closed immediately as `failed` with
that code.

### One login, a wallet on both networks

Pollar runs mainnet and testnet as separate applications with separate key pairs,
so a hosted login only creates a wallet on the network its API key resolves to
(`prod` → `public`, `dev` → `testnet` — see `resolveNetwork`). To give the user a
wallet on both, a **mainnet** redemption also registers them on **testnet** through
the Server API's `POST /users/with-wallet`, and `POST /v1/pollar/oauth/token`
reports both. A testnet redemption does not provision mainnet: testnet is where
`dev` keys land, and a key anyone can mint must not spend real XLM on a mainnet
reserve per login. That user's mainnet wallet comes from their first mainnet login.

```jsonc
"network_wallets": [
  { "network": "public",  "status": "ready",   "address": "GA5Z…" },
  { "network": "testnet", "status": "pending", "address": null    }
]
```

**A `pending` entry is not an error.** The login succeeded; only the second
wallet is not ready yet, and it never makes the login fail. The request makes one
five-second attempt; anything unfinished is retried in the background by the
provisioning sweeper (`POLLAR_SWEEP_*`), with exponential backoff and up to ten
attempts before the row becomes `failed`.

The usual cause of `pending` is that **the other network's keys are not
configured**. Once they are, the next sweep provisions the backlog without users
logging in again, so set keys for both networks even if you only serve one.

- **Users are matched by their OAuth email**, the same key a hosted login on the
  other network uses. A provider that returns no email gets no second wallet.
- **A mainnet login spends XLM on both networks** — its own reserve and a testnet
  one. A testnet login spends testnet XLM only. State lives in `pollar_user_wallet`, one row per
  (consumer, email, network), so a repeat login does not provision again.

### What the bridge stores

One handshake row, with nothing that can spend money: the unguessable `state`, the
Pollar client-session id, a **hash** of the code, and the resulting public Stellar
address. **No Pollar token is ever persisted** — the `/auth/login` exchange runs
inside the redemption request and the tokens go straight out in its response.
Handshakes nobody finished are expired on a timer (`POLLAR_SWEEP_*`), because an
`AUTHORIZED` row is a redeemable code until it is swept.

Every transition is a compare-and-swap on the row's status, so a replayed
callback mints no second code, and two wallets racing one code cannot both win.

### Hardening

- **PKCE (RFC 7636, S256)** is **required in the redirect flow** and optional in
  the poll flow: pass `code_challenge` at authorize and `code_verifier` at
  redemption, and a code that leaks from a browser or a log is useless without the
  verifier. A redirect-flow code crosses a browser, and the public callback hands
  it to whoever presents `state` — which is inside `authorization_url` — so
  `authorize` with `redirect_uri` and no `code_challenge` is `400 validation_failed`.
- **`dpop_jwk`** binds the tokens Pollar mints to the wallet's own P-256 key
  (RFC 9449), so a stolen access token is inert without a signed proof. It also
  means the bridge can no longer act for the wallet — `/refresh` and `/logout`
  serve bearer sessions, and a DPoP-bound wallet calls Pollar directly.
- **`POLLAR_REDIRECT_URI_WHITELIST`** is per consumer and fails closed, since the
  redirect URI receives the code. It accepts loopback hosts (any port, per
  RFC 8252), private-use scheme deep links, and https hosts.
- **A session only goes back to the account that consented.** Every tenant shares
  one Pollar application, and a login link works in anyone's browser: a key could
  send its `authorization_url` to someone, wait for them to consent, and redeem
  their wallet — PKCE and `dpop_jwk` do not help, since that key opened the
  handshake. So `POST /v1/pollar/oauth/token` compares the email Pollar reports for
  the login with the account email the gateway forwards for the key
  (`X-Consumer-Email`, see `APISIX_EMAIL_HEADER`). A mismatch revokes the session at
  Pollar, marks the handshake `failed` and returns `403 pollar_identity_mismatch`;
  a key with no forwarded email is refused at `authorize` with
  `403 pollar_identity_required`. The one exception is the dev platform's brokered
  onboarding (`X-Cosmos-Internal`): it logs in people who have no key yet, and
  proves the email itself before it hands anything on.
- **`POST /v1/pollar/users` and `/users/with-wallet` need an elevated key**
  (`X-Consumer-Role: admin`, otherwise `403 elevated_key_required`). A user
  registered there is the same user a later social login resolves by email, so a
  tenant key could otherwise claim a stranger's email and be recorded as the owner
  of the wallet it gets.

### Routes

| Method | Path                                                  | Scope          | Description |
| ------ | ----------------------------------------------------- | -------------- | ----------- |
| POST   | `/v1/pollar/oauth/authorize`                          | `pollar:write` | Open a login → `authorization_url` + `state` |
| GET    | `/v1/pollar/oauth/callback/:state`                    | _public_       | Where Pollar returns the browser (a navigation — no key to carry) |
| GET    | `/v1/pollar/oauth/callback?state=`                    | _public_       | Same callback, for a redirect chain that keeps the query but not the path |
| GET    | `/v1/pollar/oauth/sessions/:state`                    | `pollar:read`  | Poll a handshake, and collect its code |
| POST   | `/v1/pollar/oauth/token`                              | `pollar:write` | Redeem the code → Pollar session + wallet |
| POST   | `/v1/pollar/oauth/refresh`                            | `pollar:write` | Rotate a token pair (bearer sessions) |
| POST   | `/v1/pollar/oauth/logout`                             | `pollar:write` | Revoke a session (this device, or all) |
| POST   | `/v1/pollar/wallets/activate`                         | `pollar:write` | Fund the XLM reserve (Deferred funding mode) |
| POST   | `/v1/pollar/wallets/:address/trustlines/default`      | `pollar:write` | Enable the app's configured assets |
| POST   | `/v1/pollar/wallets/:address/trustlines`              | `pollar:write` | Enable specific assets |
| DELETE | `/v1/pollar/wallets/:address/trustlines/:code/:issuer`| `pollar:write` | Remove a trustline (zero balance only) |
| POST   | `/v1/pollar/users` · `/v1/pollar/users/with-wallet`   | `pollar:write` | Register a user, optionally with a wallet (elevated keys only) |
| POST   | `/v1/pollar/tokens/verify`                            | `pollar:read`  | Validate a token a wallet presented to you |

The last six use Pollar's **secret** key, which is why they run here and not in
the wallet.

### Rate limiting

Creating a Pollar wallet costs money: Pollar creates the Stellar account, funds
its base reserve (1 XLM) and adds a trustline per configured asset (0.5 XLM
each) **out of your funding wallet**. A script looping over the login flow could
spend that without any real user, so this service enforces limits itself, before
any XLM is spent.

**The limit is on `authorize`, not `token`.** A handshake yields at most one
wallet, so limiting handshakes per address limits wallets. `token` is looser
because clients are told to retry it while Pollar provisions the account, and
redeeming creates nothing new.

| Route | Budget (per 10 min) | Why |
| ----- | ------------------- | --- |
| `POST /v1/pollar/oauth/authorize` | 20 | Caps wallet creation |
| `POST /v1/pollar/oauth/token` | 60 | Clients retry it while the account is provisioned |
| `GET /v1/pollar/oauth/callback` | 60 | The only one reachable without an API key |
| `GET /v1/pollar/oauth/sessions/{state}` | 400 | A wallet polls every couple of seconds; each poll can reach Pollar |
| `POST /v1/pollar/oauth/refresh` · `/logout` | 60, shared | One Pollar request each |
| `POST /v1/pollar/users` · `/users/with-wallet` | 10, shared | Writes to the user directory every tenant shares; `with-wallet` also creates a wallet without a consent screen |
| `POST /v1/pollar/wallets/activate` | 20 | Spends XLM on each call |
| `POST /v1/pollar/wallets/:address/trustlines` · `/default` | 20, shared | Each asset locks reserve out of the funding wallet |
| `DELETE /v1/pollar/wallets/:address/trustlines/:code/:issuer` | 20 | One Pollar request each |
| `POST /v1/pollar/tokens/verify` | 120 | One Pollar request each |

**Two ceilings are per consumer instead of per address**, so rotating addresses
does not multiply them: the Pollar requests one consumer can cause (100 a minute,
on every route above but the poll and the callback — Pollar budgets the key at 200
a minute and every tenant shares it), and the wallets it can cause (`authorize` and
`users/with-wallet`, 50 a day). Console calls (`X-Cosmos-Internal`) are exempt from
both: the dev platform brokers every keyless wallet through one consumer and
budgets that traffic itself.

Exceeding one returns **`429` with `code: "rate_limited"`**, a `Retry-After`, and
the `RateLimit-Limit` / `-Remaining` / `-Reset` headers. The same limiter guards the
routes outside Pollar whose cost an error cannot refund — the swap and
liquidity-pool builders and their submits, the payment-intent builders, KYC
upload and terms-of-service, the onramp and offramp writes (with a per-consumer
BlindPay ceiling on top), webhook `ping` and `redeliver`, alias challenges and
recovery, activity ingest — and each section gives its budget. General rate limiting belongs in APISIX.

**The counter is in Postgres, not in memory**, so the limit holds across
replicas. It is a fixed window (one atomic `INSERT … ON CONFLICT … RETURNING` per
request), so a client can use a full budget on each side of a window boundary.

**Client address.** `main.ts` sets `trust proxy` to `1`, so Express reads the
*rightmost* entry of `X-Forwarded-For` — the one APISIX appended. Entries a client
adds land to its left and are ignored.

> **Do not raise `trust proxy`.** At `2`, Express trusts one client-supplied hop
> and any client can bypass these limits with a header.

IPv6 callers are grouped per **/64**, since a client usually controls a whole
/64; users sharing one /64 share a limit, as they would behind an IPv4 NAT.
Limits are also per consumer, so one integrator's traffic does not affect
another's.

If the counter cannot be written, the limiter **fails closed** (`503`); these
routes need the database anyway. Set `RATE_LIMIT_ENABLED=false` to turn limits off
during an incident.

### Setup

1. Create an app at [dashboard.pollar.xyz](https://dashboard.pollar.xyz) and take
   both keys for your network (`pub_testnet_…` / `sec_testnet_…`). Do it for
   **both** networks: a mainnet login also provisions a testnet wallet, and missing
   testnet keys leave that second wallet `pending` until they are set. The two
   dashboards are separate — register the callback host in each.
2. Register the **gateway host** of `POLLAR_BRIDGE_CALLBACK_URL` under
   **Build → Domains**. The SDK API checks that list on *every* call against the
   `Origin` header, which the bridge sets to this host (`POLLAR_SDK_ORIGIN`
   overrides it). An unregistered host gets `403 ORIGIN_NOT_ALLOWED` on
   `POST /auth/session`, the first call of every login.
3. Set `POLLAR_BRIDGE_CALLBACK_URL` to `<gateway>/v1/pollar/oauth/callback` — the
   bridge appends `/{state}` itself.
4. Add each wallet's redirect URI to `POLLAR_REDIRECT_URI_WHITELIST`, or omit it
   and use the poll flow.

Pollar encodes the network and key type in the key prefix, and the env validator
rejects a mismatch at boot. Leave the keys blank to disable the feature (Pollar
routes then return `503`). See `.env.example`.

## Upgrading — breaking changes and deploy notes

### Security review fixes

Most of these change nothing for a well-behaved caller; check the "Who notices"
column before deploying.

| Change | Who notices | Why |
| ------ | ----------- | --- |
| `POST /v1/aliases/:name/recovery` is **platform-console only**: an API key gets `403 admin_console_only`, and the route left the published contract | Anyone who started recoveries with an API key | The response carries the recovery token, which proves control of the owner's mailbox |
| Completing a recovery on a `SUSPENDED` alias is a `404` | Nobody legitimate | A token issued before a suspension could bypass the operator hold |
| `@Public()` routes (Pollar callback, BlindPay webhook, health) ignore `X-Consumer-Username` | Dashboards: those requests now log as anonymous | Those routes have no key-auth, so the header came from the client |
| Refusals by `AdminGuard` and `ConsoleOnlyGuard` are logged at `warn` | Operators | Guards run before the access log, so refused requests left no trace |
| `POST /v1/pollar/wallets/activate` and the three `/v1/pollar/wallets/:address/trustlines…` routes return `404` for a wallet the calling consumer did not obtain through this service on that network | Integrators acting on wallets they only saw through `tokens/verify`, on non-primary wallets of a login, or on a counterpart wallet another tenant already registered | All tenants share one set of Pollar secret keys. Foreign and unknown wallets both get `404`, so the response does not reveal ownership |
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
| `POST /v1/pollar/oauth/token` no longer redeems a code that a newer poll of `GET /v1/pollar/oauth/sessions/:state` replaced, even when that poll lands mid-redemption | Nobody legitimate | The claim matched the handshake but not the code, so a retired code could still be spent in that window |
| `POST /v1/swaps/:id/submit` and `POST /v1/liquidity-pools/operations/:id/submit` check the envelope before anything else: a body that does not parse, is not the row's envelope, or carries no signatures is `400 validation_failed` whatever the row's status. An arbitrary `signedXdr` no longer returns a `SUCCEEDED` row, and an `EXPIRED` row answers a mismatched body with `validation_failed` instead of `invalid_state_transition` | Clients that submitted the unsigned `xdr` and relied on the `tx_bad_auth` rejection | Signatures do not change a transaction's hash, so the unsigned envelope could be relayed and rejected in a loop, and under the shared public key a row id alone read a settled row |
| Both submit routes refuse an envelope past its time bounds (`400 invalid_state_transition`, not broadcast; the observer still settles it if it landed) and a `FAILED` row already resubmitted 3 times (`400 invalid_state_transition`: build a new one). A retry after `503 provider_unavailable` does not count | Clients that retry submit in a loop: stop on `invalid_state_transition` | Every rejected resubmit was a Horizon submission and a new terminal webhook event, with no limit |
| Both submit routes allow 20 calls a minute per consumer and client address, in separate buckets (`429 rate_limited`) | Wallets behind one NAT sharing the public key | The routes take the shared public key, and each call can broadcast to Horizon |
| `GET /v1/webhooks`, `GET /v1/webhooks/:id` and `PATCH /v1/webhooks/:id` return only the documented endpoint fields; `POST /v1/webhooks` and `POST /v1/webhooks/:id/rotate-secret` return those plus `secret`. `consumerId`, `previousSecret` and `previousSecretExpiresAt` left all five | Callers reading those fields | `previousSecret` is a signing secret an integrator may still accept, and a key with only `webhooks:read` could read it |
| A recovery token that matches no live recovery of the alias no longer counts against it. A live token uses an attempt on every presentation, including one whose challenge or signature then fails; after five it is `400 alias_recovery_invalid` | Nobody legitimate | Alias names are public, so five junk tokens from any key burned every recovery the console started |
| `POST /v1/aliases/:name/recovery/complete` (10 per 10 min), `POST /v1/aliases/challenges` (30), `POST /v1/webhooks/:id/ping` (20) and `POST /v1/webhooks/:id/deliveries/:deliveryId/redeliver` (30) are `429 rate_limited` over budget, per consumer and client address | Scripts that loop these routes | Each call stores a row, tries a recovery token, or sends requests to a URL the caller chose |
| `PATCH /v1/payment-intents/:id` requires `txHash` to be a 64-character hex Stellar transaction hash (anything else is `400`) and stores it lowercase; `POST /v1/payment-intents/:id/validate` lowercases its own. A hash is unique among one consumer's intents instead of across all tenants, and a hash already on another of your intents is `409 idempotency_conflict` (it was `500`) | Callers sending placeholder or truncated hashes | Any tenant could park another tenant's transaction hash on an intent of its own; the other tenant's settlement then hit the global index, answered `500`, and the paid intent expired without `PAYMENT_INTENT_SUCCEEDED` |
| An `EXPIRED` intent moves to `SUCCEEDED` when its payment is verified on-chain: by the observer, which now checks the chain before expiring, or by `POST /v1/payment-intents/:id/validate` and `PATCH {status: SUCCEEDED}`, which answer `200` instead of `400 invalid_state_transition`. `PAYMENT_INTENT_SUCCEEDED` can follow the update `EXPIRED` emitted | Webhook consumers that treat `EXPIRED` as final | Expiry never looked at the chain, and the verifier read only the 50 newest payments to the destination, so a late or buried payment left a paid intent `EXPIRED` for good |
| `POST /v1/pollar/oauth/authorize` with `redirect_uri` requires `code_challenge` (PKCE, S256), and redeeming that handshake requires `code_verifier`; without it the call is `400 validation_failed` before a Pollar session is opened. The poll flow is unchanged | Redirect-flow wallets that do not send PKCE | The public callback hands the code to whoever presents `state`, which is inside `authorization_url`, and without PKCE that code redeemed as is |
| Swap, liquidity-pool operation, payment-intent and customer responses return only their documented fields, plus `expiresAt` on swaps and payment intents, now documented. `consumerId` and the settlement bookkeeping (`settlementEpoch`, `lastCheckedAt`, `notFoundStreak`, `sharesReceived`, `settledAmountA`/`B`, `horizonCursor`) are no longer sent | Callers reading those fields | They are internal, and several of these routes are reachable with the shared public key |
| `PATCH /v1/kyc/receivers/:id` on a receiver that already exists at BlindPay is `403 kyc_review_required` for any field but `external_id` and `image_url`, unless the key is elevated (`X-Consumer-Role: admin`) | Integrators correcting a live receiver's identity with a tenant key: send it through the reviewer | The `PUT` sent never-reviewed identity data straight to a regulated provider, while the same edit before enabling re-enters review |
| BlindPay routes use the instance of the caller's key environment: `prod` keys the unsuffixed `BLINDPAY_*` instance, `dev` keys the `BLINDPAY_*_DEV` one, and a `dev` key with no development instance configured gets `503 misconfigured`. Receivers, wallets, bank accounts, virtual accounts, quotes, payins and payouts are only read and executed on that instance | Anyone using BlindPay with `dev` keys | A `dev` key operated the production instance: it could list and delete real KYC identities and create live payouts |
| `POST /v1/pollar/oauth/token` only returns a session when the email Pollar reports for the login is the account email the gateway forwards for the key (`X-Consumer-Email`). A mismatch revokes the session, fails the handshake and is `403 pollar_identity_mismatch`; a key with no forwarded email is `403 pollar_identity_required` at `authorize` | Tenants that log their own end users in through the shared Pollar application, and anyone signing in with another email than their account's | Every tenant shares one Pollar application and a login link works in any browser: a key could send its `authorization_url` to someone, wait for the consent, and redeem that person's custodial wallet |
| `POST /v1/pollar/users` and `/v1/pollar/users/with-wallet` require an elevated key; a tenant key gets `403 elevated_key_required` | Integrators pre-registering users with a tenant key | A registered user is the one a later social login resolves by email, so a tenant key could claim a stranger's email and be recorded as the owner of their wallet |
| A testnet login no longer provisions its user a mainnet wallet: `network_wallets` on a testnet redemption lists the testnet wallet only. A mainnet login still provisions testnet | Anyone reading a mainnet entry from a testnet login | A `dev` key anyone can mint spent the operator's real XLM on a mainnet reserve per login |
| The poll, refresh, logout, token-verify, user-registration and trustline-removal Pollar routes are rate limited, and a per-consumer quota (100 Pollar requests a minute) and wallet ceiling (50 a day) apply on top of the per-address budgets; excess is `429 rate_limited` | Clients hammering those routes | They had no limit, and each call spends the Pollar request budget every tenant shares — one tenant could fail every other tenant's logins |
| `POST /v1/kyc/receivers/:id/approve` accepts `expected_version` (the `dossierVersion` you read) and answers `409 kyc_state_invalid` when the KYC data changed since. `POST /v1/kyc/receivers/:id/enable` refuses a dossier that is not the one approved, and receiver reads carry `dossierVersion` and `reviewedVersion` | Reviewers, once they start sending `expected_version`; nobody else — the field is optional | A review is a person reading the data and then approving it, and an edit in between leaves the status at `pending_review`, so the approval landed on a dossier nobody had seen and `enable` sent it to a regulated provider |
| `POST /v1/kyc/upload`, `/v1/kyc/terms-of-service`, the onramp and offramp writes, `POST /v1/payment-intents/tx` and `/pay`, `POST /v1/swaps/quote` and `/v1/swaps`, and `POST /v1/liquidity-pools/deposit` and `/withdraw` now answer `429 rate_limited` over budget, per consumer and client address. Every BlindPay-backed route also counts against a per-consumer ceiling of 60 provider requests a minute | Scripts that loop those routes; a batch importer above the ceiling should hold its own key | They had no limit at all: each one either leaves something behind at the provider that no error refunds, or spends the per-IP Horizon budget every route here shares. Only the builders' submits were capped |
| `POST /v1/swaps` no longer answers `409 operation_in_flight` for a `PENDING` swap whose sequence number the account has not used yet (an unsigned or abandoned envelope). Only applies where `STELLAR_SWAP_SINGLE_INFLIGHT=true` | Wallet users who were blocked | Any caller may name any `source`, so one dust swap froze a stranger's account for a timeout window at a time — the twin of the liquidity-pool fix above |
| A webhook destination refused for its host — unresolvable, private, link-local, metadata — is one `400` with one message; the reason is in the service log. A malformed URL, a non-https scheme, credentials or a missing host still say what is wrong | Integrators who read the reason out of the response | Registering an endpoint resolves a name this service can reach, so per-reason answers let anyone map the internal network one URL at a time |
| `redirect_url` is refused when it carries a fragment, a backslash, whitespace or a control character; https with no embedded credentials was already required | Nobody sending a plain URL | `https://app.acme.com\@evil.test` names a different host depending on who parses it, and the value is read again by BlindPay and by a browser |
| The service refuses to boot when `POLLAR_BRIDGE_CALLBACK_URL` is plain `http` on a routable host | Deployments terminating TLS elsewhere and configuring the callback as `http` | Pollar returns the browser to it with the authorization code in the query string, and that code exchanges for the user's session |

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
- **Migration `20260915120100_lookup_indexes`** builds two indexes `CONCURRENTLY`
  for the Pollar wallet ownership check
  (`pollar_oauth_session(consumerId, network, walletAddress)` and
  `pollar_user_wallet(consumerId, network, address)`). It does not block writes, but
  a failed build leaves an `INVALID` index that `IF NOT EXISTS` treats as present:
  find it with
  `SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE NOT i.indisvalid;`,
  drop it with `DROP INDEX CONCURRENTLY`, run
  `prisma migrate resolve --rolled-back 20260915120100_lookup_indexes`, and deploy
  again.
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
- **Deploy the dev platform's forwarder change first.** `authorize` refuses every
  key the gateway forwards no `X-Consumer-Email` for. The forwarder bakes the email
  per account whenever that account's keys are synced, so re-sync existing
  consumers (listing a user's keys in the dashboard does it for that user). Until
  then the wallet falls back to the dev platform's brokered login, which does not
  need the header; other clients get `403 pollar_identity_required`.
- **Social login for third-party end users through the shared Pollar application
  stops.** A tenant whose app logs in its own users gets
  `403 pollar_identity_mismatch` for every user whose email is not the key's
  account email.
- **Migration `20260915180000_pollar_testnet_counterpart_mainnet`** closes the
  mainnet wallets that testnet logins had left `pending` (`FAILED`,
  `COUNTERPART_FROM_TESTNET_DISABLED`), so the sweeper stops funding them. Data
  only, no schema change.
- **Migration `20260915200000_receiver_dossier_version`** adds `dossierVersion`
  (default `1`) and `reviewedVersion` to `blindpay_receiver` — a catalog-only
  change, no table rewrite — and backfills `reviewedVersion` for every receiver
  already past the review gate, so their `enable` keeps working. Receivers still
  in `inactive` or `pending_review` keep `NULL`, which is the truth about them.
- **Check `POLLAR_BRIDGE_CALLBACK_URL` before deploying.** Plain `http` on a
  routable host now stops the service from starting with an error naming the
  variable. Loopback (`http://127.0.0.1:…`) is still accepted, for local
  development.
- **New `429`s on routes that never returned one.** The budgets in the table
  above apply from this release; a client that loops KYC uploads, quotes, payins,
  payouts, intent builds, swap quotes or pool builds needs to honour
  `Retry-After`. `RATE_LIMIT_ENABLED=false` turns the limiter off during an
  incident.

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

### The Pollar poll route now discovers a finished login itself

`GET /v1/pollar/oauth/sessions/{state}` used to wait for the bridge callback,
which Pollar never calls, so poll-flow logins stayed `pending` until they expired.
The poll now checks with Pollar and promotes the handshake on `READY`. No API
shape or client change is needed. At deploy time:

- **Migration `20260906120000_pollar_oauth_provider_probe`** adds a nullable
  `providerCheckedAt` to `pollar_oauth_session`. No backfill.
- **Poll traffic now reaches Pollar.** Budget for one provider request per
  in-flight login every two seconds, on the publishable key for that network.

### Pollar logins now provision a wallet on both networks

`POST /v1/pollar/oauth/token` gained a `network_wallets` array — one entry per
Stellar network, each `ready`, `pending` or `failed`. The change is additive. At
deploy time:

- **Run the migration.** `20260905120000_pollar_user_wallet` adds
  `pollar_user_wallet` and the `PollarWalletStatus` enum. Without it every
  redemption logs a failed provisioning and the counterpart wallet stays
  unrecorded — the login itself keeps working.
- **Set the keys for both networks.** `POLLAR_*_MAINNET` and `POLLAR_*_TESTNET`
  are each optional, and a network with no keys shows up as a `pending` wallet on
  every login. Once the second pair is set, the sweeper provisions the backlog on
  its next tick; otherwise rows stay `pending` until they run out of attempts.
  Logins never fail either way.

A mainnet login funds a reserve on *both* networks. A testnet login funds testnet
only — it used to fund mainnet as well, which the security review fixes above
removed.

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
any non-2xx, so webhook delivery is unchanged. Pollar already returned
`misconfigured` in the same situation.

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
2. `X-Cosmos-Internal` is present. APISIX strips it from every request it
   proxies (`proxy-rewrite.headers.remove`), so an API-key caller cannot carry
   it; only a direct call from a backend holding the gateway secret can.

Point 2 depends on the gateway route configuration in the developer-platform
repo, not on a secret held by this service. In exchange, the console is the only
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
`X-Gateway-Secret`, `X-Consumer-Username` and `X-Cosmos-Internal: 1`; add
`X-Cosmos-Admin-Role: owner` to label the audit row. Keep the service off the
public internet.

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
| `APISIX_EMAIL_HEADER` | no | `x-consumer-email` | Verified email of the key's account. The Pollar bridge only returns a login's session to that account, and refuses a key without one |
| `APISIX_PUBLIC_CONSUMER` | no | — | Username of the shared public consumer (see above). Set it wherever a public key is published |
| `STELLAR_NETWORK` | no | `testnet` | Fallback Stellar network (`public` / `testnet`) |
| `STELLAR_HORIZON_URL_PUBLIC` | no | `https://horizon.stellar.org` | Mainnet Horizon base URL |
| `STELLAR_HORIZON_URL_TESTNET` | no | `https://horizon-testnet.stellar.org` | Testnet Horizon base URL |
| `STELLAR_BASE_FEE` | no | `100` | Stellar base fee (stroops) for tx builds |
| `STELLAR_TX_TIMEOUT` | no | `300` | Transaction timeout (seconds) |
| `STELLAR_SWAP_FEE_WALLET` | when fee > 0 | — | Platform G... account for swap fees |
| `STELLAR_SWAP_FEE_BPS` | no | `50` | Swap fee in basis points |
| `STELLAR_SWAP_SLIPPAGE_BPS` | no | `50` | Default swap slippage tolerance (bps) |
| `STELLAR_SWAP_MAX_SLIPPAGE_BPS` | no | `500` | Hard cap on caller slippage (bps) |
| `STELLAR_SWAP_SINGLE_INFLIGHT` | no | `false` | When `true`, 409 if a non-expired PENDING swap already exists for the same source |
| `OBSERVER_ENABLED` | no | `true` | `true` / `false` — on-chain reconciler |
| `OBSERVER_INTERVAL_MS` | no | `15000` | Observer poll interval (ms, min 1000) |
| `OBSERVER_BATCH_SIZE` | no | `50` | Max intents/swaps per observer tick |
| `PAYMENT_INTENT_TTL_SECONDS` | no | `3600` | Unpaid intent lifetime before `EXPIRED` |
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
| `KYC_REDIRECT_URL_WHITELIST` | no | — | Per-consumer KYC redirect host allow-list |
| `RATE_LIMIT_ENABLED` | no | `true` | Per-address caps on the routes that spend XLM. Incident switch |
| `RATE_LIMIT_PRUNE_INTERVAL_MS` | no | `600000` | Counter-window prune interval (ms, min 1000) |
| `POLLAR_PUBLISHABLE_KEY_TESTNET` / `_MAINNET` | no | — | Pollar publishable key (`pub_<network>_…`), for the OAuth bridge |
| `POLLAR_SECRET_KEY_TESTNET` / `_MAINNET` | with the publishable key | — | Pollar secret key (`sec_<network>_…`), for the operator routes |
| `POLLAR_BRIDGE_CALLBACK_URL` | when a Pollar key is set | — | Public URL Pollar returns the browser to. Must be `<gateway>/v1/pollar/oauth/callback`, **https** (plain `http` only on a loopback host — boot fails otherwise, the authorization code travels in its query string) **and** a host registered under Pollar's Build → Domains |
| `POLLAR_REDIRECT_URI_WHITELIST` | no | — | Per-consumer allow-list of wallet redirect URIs. Empty ⇒ that consumer can only use the poll flow |
| `POLLAR_SDK_ORIGIN` | no | origin of `POLLAR_BRIDGE_CALLBACK_URL` | `Origin` sent to Pollar's SDK API, which checks it against Build → Domains. Set only when the callback host and the registered host differ |
| `POLLAR_SDK_BASE_URL` | no | `https://sdk.api.pollar.xyz` | Pollar SDK API base URL |
| `POLLAR_SERVER_BASE_URL` | no | `https://api.pollar.xyz` | Pollar Server API base URL |
| `POLLAR_TIMEOUT_MS` | no | `15000` | Pollar HTTP client timeout (ms) |
| `POLLAR_AUTHORIZATION_TTL_MS` | no | `300000` | How long a login handshake stays open |
| `POLLAR_CODE_TTL_MS` | no | `120000` | How long a minted bridge code stays redeemable |
| `POLLAR_LOGIN_WAIT_MS` | no | `20000` | How long redemption waits for Pollar to provision the wallet |
| `POLLAR_SWEEP_ENABLED` | no | `true` | Expire handshakes nobody finished, and retry the cross-network wallets a login left `pending` |
| `POLLAR_SWEEP_INTERVAL_MS` | no | `60000` | Handshake sweeper interval (ms, min 1000) |

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
> those values are honest. Review the list whenever a route is added or copied —
> a route that does not strip `X-Cosmos-Internal` gives every API key access to
> `/v1/admin`. Keep the service on a private network so APISIX is the only way
> in; the shared secret is a second layer, not the only one.
>
> In production, a missing `X-Plan-Swap-Fee-Bps` returns `503` instead of falling
> back to the environment default.
