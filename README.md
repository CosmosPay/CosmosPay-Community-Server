# Cosmos Pay — Payments Microservice

**English** · [Español](./README.es.md) · [Português](./README.pt.md) · [Deutsch](./README.de.md) · [Français](./README.fr.md) · [हिन्दी](./README.hi.md) · [简体中文](./README.zh.md)

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

One surface reads more out of those same two conditions. `/v1/admin` is
cross-tenant, and `AdminGuard` admits a request there only when it also carries
`X-Cosmos-Internal` — a header APISIX **removes** from everything it proxies, so
only a direct call from a backend holding the gateway secret can present it. That
backend is the developer platform, which has already decided whether the
signed-in account is an owner/admin. There is no separate admin credential to
deploy (see the upgrade note on `ADMIN_API_CREDENTIALS`), which makes the gateway
secret and network isolation the whole boundary in front of cross-tenant data —
and makes the strip list in the gateway route security-relevant, not hygiene.

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
  stellar/                        per-network Horizon servers (bounded timeout)
  payment-intents/                Stellar payment intents (controller, service, DTO) — emits events
  swaps/                          Stellar native swaps (path payments): quote, build XDR, submit
  liquidity-pools/                AMM deposit/withdraw, cost basis + commission on gain
  observer/                       background reconciler: swaps + LP ops against Horizon
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
  health/                         liveness/readiness probes (@Public)
prisma/schema.prisma              Consumer, PaymentIntent, Swap, LiquidityPoolOperation,
                                  WebhookEndpoint/Delivery/EmittedEvent, BlindpayReceiver,
                                  Blockchain/BankAccount/VirtualAccount, BlindpayQuote,
                                  BlindpayWebhookEvent, Payin, Payout, PollarOauthSession,
                                  PollarUserWallet, RequestLog, ActivityEvent,
                                  AdminAuditLog, Alias, AliasAddress,
                                  AliasChallenge, AliasRecovery
test/                             e2e suites: gateway gate, admin + alias console gates,
                                  payment intents, KYC, webhooks, Pollar
scripts/                          OpenAPI generator, README check, operator scripts
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
Paths use the OpenAPI `{param}` form, and `npm run readme:check` fails CI when a
route in the contract is missing from this table.

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
`ApiErrorBodyEntity`, attached to every operation — so a generated client gets
the error type too, and you do not have to read this repo to discover the codes.
The source of truth is `ApiErrorCode` in `src/common/errors/api-error.ts`.
**Codes are never renamed once published**; new ones may be added, so treat an
unrecognised code as its HTTP status.

A few that are easy to confuse:

| Code | Status | Means |
| ---- | ------ | ----- |
| `insufficient_scope` | 403 | The API key lacks the scope. Re-provision the key |
| `account_disabled` | 403 | An operator disabled this fiat account. Not a key problem |
| `gateway_required` | 403 | The request did not arrive through APISIX |
| `admin_console_only` | 403 | The route belongs to the platform console (`/v1/admin`, starting an alias recovery). No API key can call it |
| `idempotency_conflict` | 409 | This `Idempotency-Key` (or payment-intent memo) already produced a resource for a *different* request. Repeat the original request, or use a new key |
| `kyc_state_invalid` | 409 | An illegal KYC state transition — not a duplicate request |
| `operation_in_flight` | 409 | A conflicting operation is still settling |
| `payload_expired` | 409 | The delivery body is past retention and cannot be re-sent |
| `provider_unavailable` | 503/504 | BlindPay or Horizon is unreachable. Retry |
| `misconfigured` | 503 | A server-side configuration error. Retrying will not help |

Every intent is **persisted** (`payment_intent` table) and scoped to the
authenticated APISIX consumer, so reads/updates/deletes only ever touch that
consumer's own records — full traceability of each intent's lifecycle
(`PENDING → SUBMITTED → SUCCEEDED/FAILED/CANCELLED/EXPIRED`).

### Running more than one replica

APISIX load-balances across instances, so every `setInterval` in this service
runs once per replica. Correctness was never the problem — each status change
goes through a guarded `updateMany` compare-and-swap, so only one writer wins —
but three replicas meant three times the Horizon round-trips for identical work
against an API that rate-limits, and replicas racing to delete the same
`request_log` tuples.

Each background timer now takes a PostgreSQL **transaction-level advisory lock**
(`AdvisoryLockService`, `src/common/services/advisory-lock.service.ts`) and skips
its tick when another replica holds it:

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

`pg_try_advisory_xact_lock` is used rather than the session-level variant for
three reasons: it never blocks (a replica that loses simply skips, which is what
a poller wants), it is released when the transaction ends — including on a crash
or a dropped connection, so a killed pod cannot wedge the lock — and it therefore
stays correct behind PgBouncer in transaction-pooling mode, where session-level
locks are unsafe because connections are not sticky.

Lock ids live in the `AdvisoryLockKey` enum and are the identity of the task:
renaming a member with a new number silently disables the exclusion, so retired
numbers are never reused.

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
  leaves the status unchanged, so a correct tx can still be submitted; otherwise
  the hash of any failed transaction on the network would fail an intent for good.
- **Automatic (permanent observer):** `StellarObserverService` polls Horizon
  every `OBSERVER_INTERVAL_MS` for `PENDING` intents — by reported `txHash`, or by
  scanning payments to the destination — and finalizes matches the same way, so
  statuses change and events fire **without anyone calling the API**. One tick
  takes at most `OBSERVER_MAX_INTENTS_PER_CONSUMER` (10) intents per consumer and
  never scans an expired one, so a flood from one consumer — the shared public key
  included — cannot starve everyone else's settlement. Disable for local dev with
  `OBSERVER_ENABLED=false`.

### API request logs retention

Every inbound request except `/v1/health` and `/docs` is appended to
`request_log` by `LoggingInterceptor`, and powers the dashboard **API logs**
view (`GET /v1/logs`). Rows include path, status, duration, and — when present —
the payer's `ip` / `userAgent`.

Dashboard traffic (`X-Cosmos-Internal`) is **recorded and flagged**
(`request_log.internal`), not skipped, and the API-log view filters on that
column. An earlier version returned early on the header, which meant anyone able
to set it kept their requests out of the audit log entirely — a request header
must never be able to make traffic invisible.

Those rows are **not kept forever**. `RequestLogRetentionService` deletes rows
older than `REQUEST_LOG_RETENTION_DAYS` (default **30**) on a timer
(`REQUEST_LOG_PRUNE_INTERVAL_MS`, default **1h**). Each cycle deletes in short
`REQUEST_LOG_PRUNE_BATCH_SIZE` chunks (default **1000**) and keeps looping until
the backlog is gone or `REQUEST_LOG_PRUNE_MAX_PER_CYCLE` (default **50000**) is
hit, so a large history can catch up without holding one long table lock. Set
`REQUEST_LOG_RETENTION_DAYS=0` to disable the prune entirely (the service logs
that at boot). The composite index on `(consumer, createdAt)` keeps the
dashboard query fast as volume grows.

### Client activity (what the wallet and the dashboard report)

`request_log` records what reached this service. It cannot record what a client
*did*: a wallet that crashed on its send screen, a signature the user cancelled,
a dashboard page that threw before any request left the browser. None of those
produce an HTTP call here, and they are exactly the events worth having when
something is wrong — so the clients report their own, to `POST
/v1/activity/events`.

- **A batch, not a call per event.** Clients queue and flush, so an offline
  wallet keeps its events and sends them on the next launch. Up to
  `ACTIVITY_MAX_BATCH` (100) per request, written in one statement.
- **Retrying a flush is safe.** An event may carry the client's own `eventId`;
  `(consumerId, eventId)` is unique and the insert skips duplicates, so a batch
  that was written but whose acknowledgement never arrived can be re-sent
  without doubling every row. The response reports `accepted` and `duplicates`.
- **Attribution is the gateway's, never the body's.** Rows are written under the
  consumer APISIX authenticated. A client cannot file events against another
  account, and there is no field that would let it try.
- **Ingest does not fail on the shape of a payload.** An over-long `message` is
  truncated and an over-sized `props` is replaced with `{"_dropped":
  "props_too_large"}`; a 400 would cost the whole batch, and the batch matters
  most when the client is in a state nobody anticipated.
- **A wrong device clock cannot reorder the feed.** `occurredAt` is clamped to
  receipt time when it is more than five minutes ahead or more than seven days
  behind, so a phone an hour fast cannot pin its events to the top of a
  newest-first list. Both times are kept: `at` (the client's) and `receivedAt`.

Reading it back:

| Route                   | Scope             | Returns                                                              |
| ----------------------- | ----------------- | -------------------------------------------------------------------- |
| `GET /v1/activity/events` | `activity:read` | The feed, newest first. Filters: `source`, `level`, `category`, `type` (prefix), `network`, `since`/`until` |
| `GET /v1/activity/summary` | `activity:read` | Counts per level/source/category, top event types, top errors, sessions, devices, a daily series |

`level` on the feed is a **floor**, not an exact match: `level=warn` returns
warnings *and* errors. A filter that returned only the rows somebody labelled
`error` would hide the warnings that led to them.

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
`LIQUIDITY_FAILED`, plus the BlindPay-sourced `RECEIVER_UPDATED`, `PAYIN_CREATED`,
`PAYIN_UPDATED`, `PAYIN_COMPLETED`, `PAYOUT_CREATED`, `PAYOUT_UPDATED` and
`PAYOUT_COMPLETED`. The authoritative list is the `WebhookEventType` enum in
`prisma/schema.prisma`.

**What a BlindPay-sourced body contains.** `RECEIVER_UPDATED` / `PAYIN_*` /
`PAYOUT_*` carry identity and state only — ids, status, amounts, rails — never
personal data. The provider object is *not* forwarded verbatim: a receiver
payload is a full KYC dossier (tax id, date of birth, address, document links)
and subscribing to an event needs only `webhooks:write`, which would make the
webhook a way to have that dossier delivered to any host. Fetch the details from
the API with a key that holds `kyc:read` / `onramp:read` / `offramp:read`. See
`src/blindpay/blindpay-event-redaction.ts` for the exact field allowlist.

Delivery is decoupled via NestJS `EventEmitter2` (`webhook.event`), so emitting a
notification never blocks the API request that triggered it.

**Outbound destination policy (SSRF):** endpoints must use `https` and resolve
only to public addresses. Registration rejects loopback, RFC1918 private ranges,
link-local (`169.254.0.0/16`, including cloud metadata `169.254.169.254`), and
known metadata hostnames. The same check runs again immediately before each
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

**The real attempt ceiling is 9, not 3.** `WEBHOOK_MAX_ATTEMPTS` bounds one
in-process retry loop. The sweeper then picks up deliveries that are still
within `WEBHOOK_MAX_ATTEMPTS × 3` total attempts, so a delivery can be attempted
up to nine times spread over hours. That is deliberate — a pod killed mid-backoff
used to strand a PENDING delivery forever, which meant a settled payment that
notified nobody.

**Redelivery is best-effort within the retention window.** After
`WEBHOOK_PAYLOAD_RETENTION_DAYS` the stored body is cleared (a
`RECEIVER_UPDATED` body is a KYC dossier, and the delivery log is retained). The
sweeper skips those rows and `POST /v1/webhooks/:id/deliveries/:id/redeliver`
returns `409 payload_expired` rather than sending a redacted body under a real
event type with a valid signature.

**Receiver contract.** Any `2xx` acknowledges. Answer within
`WEBHOOK_READ_TIMEOUT_MS` (5s default). There is no ordering guarantee, so treat
the events as a set and reconcile against the API. Deduplicate on the event `id`
— note that a redelivery reuses the original `id`, so a receiver that dedupes
strictly will ignore it; that is the intended trade (at-least-once delivery,
exactly-once effect).

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

### OpenAPI / Swagger

**Security note:** `GET /docs`, `/docs/json`, and `/docs/yaml` are mounted by
`SwaggerModule.setup` as **Express middleware**, not Nest controllers. They do
**not** pass through `ApisixGuard` or `PermissionsGuard` — anyone who can reach
the service port can fetch the full API spec unless docs are disabled. In
production, docs are **off by default** (`NODE_ENV=production` and no
`SWAGGER_ENABLED`). Set `SWAGGER_ENABLED=true` only when you deliberately want
to publish the spec on a trusted network.

Live docs (when enabled):

- `GET /docs` — Swagger UI
- `GET /docs/json` — OpenAPI 3.0 spec (JSON)
- `GET /docs/yaml` — OpenAPI 3.0 spec (YAML)

Export the spec to files (so another server can host/consume it) — no database
connection or real gateway secret is required; it runs in Nest preview mode
with local placeholders when those environment variables are absent:

```bash
npm run openapi:generate
# writes openapi/openapi.json and openapi/openapi.yaml
```

CI and the release gate regenerate both committed files and reject drift. Run
the same check before committing a controller or DTO change:

```bash
npm run openapi:check
```

Paths in the spec already include the version (`/v1/...`). To stamp
a concrete gateway host into the spec's `servers`, set `OPENAPI_SERVER_URL`
before generating:

```bash
OPENAPI_SERVER_URL=https://gateway.example.com npm run openapi:generate
```

The Swagger config (`src/swagger.ts`) is shared by the running server and the
generator, so both stay in sync. The two APISIX headers (`X-Gateway-Secret`,
`X-Consumer-Username`) are documented as security schemes in the spec.

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
calls (build, validation, observer) target it.

**The memo is a mandatory `MEMO_ID`** — it identifies the payment on-chain and
gives the intent **idempotency**: `(consumer, memo)` is unique, so re-creating
with the same memo **and the same terms** returns the original intent. The same
memo with any different term — kind, network, destination, amount, asset, `msg`,
`callback`, or `source` for `tx` — is `409 idempotency_conflict`, and the error
says nothing about the stored intent. That comparison exists because of the
shared public key: every anonymous wallet is one consumer, so without it a memo
someone else used first handed you *their* intent, with a QR that paid them. If
you don't pass `memo`, a random uint64 is generated.

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

Each endpoint documents a typed response
with example payloads in the OpenAPI spec (`TxPaymentIntentEntity`,
`PayPaymentIntentEntity`, `ValidationOutcomeEntity`), so Swagger shows a concrete
sample response, not an empty body.

Response:

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

## The shared public API key

The wallet is open source and ships one API key that everybody holds, so a person
can swap, add liquidity or create a pay link without registering. They pay the
`community` plan's commission — 150 bps, the highest rate on the board — and
registering is what buys a lower one. The gateway injects the rate per consumer
exactly as it does for a private key (see `resolvePlanCommissionBps`), so nothing
about pricing is special-cased here.

What *is* special is tenancy. Every anonymous caller on the network arrives as the
same APISIX consumer, and the read endpoints filter rows by precisely that
consumer:

```ts
// swaps.service.ts
where: { id, consumer: { apisixUsername: consumer.username } }
```

So `GET /v1/swaps` under the public key would hand each anonymous user the whole
anonymous population's swap history. Scopes cannot fix this — a scope is a
property of the key and they all hold the same key — and the overlap is not
hypothetical: `POST /v1/swaps/quote` requires `swaps:read`, which is the same
scope that lists the history.

**`PublicKeyGuard` is therefore an allowlist, not a denylist.** A public consumer
is refused on every route that does not carry `@AllowPublicKey()`, so a route
added next year is unreachable by the public key until someone says otherwise in
the same diff. Forgetting the decorator produces a support ticket; forgetting a
denylist entry produces a data leak.

Reachable with the public key today:

| Route | Why it is safe |
| --- | --- |
| `POST /v1/swaps/quote` | Prices a path from Horizon; a pure function of the request |
| `POST /v1/swaps` | Builds an unsigned envelope the caller signs |
| `POST /v1/swaps/:id/submit` | Broadcasts a caller-signed envelope — needs the swap's UUID *and* a signature from its source account |
| `POST /v1/liquidity-pools/deposit` \| `withdraw` | Build unsigned envelopes |
| `POST /v1/liquidity-pools/operations/:id/submit` | Broadcasts a caller-signed envelope |
| `GET /v1/liquidity-pools` \| `/:poolId` \| `/positions` | Public on-chain data read from Horizon |
| `POST /v1/payment-intents/tx` \| `pay` | Build a SEP-7 intent from the request |
| `POST /v1/activity/events` | Telemetry ingest — see below |
| `GET /v1/assets` | The public asset catalog |
| `GET /v1/aliases/resolve/:name` \| `availability/:name` \| `by-address/:address` | A payer resolving a handle is the anonymous caller this key exists for; the answer is a pure function of the request and never includes the owner's mailbox |

Refused, and deliberately: `GET /v1/swaps`, `GET /v1/swaps/:id`,
`GET /v1/liquidity-pools/operations{,/:id}`, `GET /v1/activity/events`,
`GET /v1/activity/summary`, every payment-intent read, every alias owner route
(claim, list, add or remove an address, release, recovery), and everything under
`/v1/kyc`, `/v1/onramp`, `/v1/offramp` and `/v1/webhooks`. A wallet with no
account builds its history from Horizon instead, which is the authoritative
source for on-chain activity anyway.

**Telemetry is on the list on purpose.** A wallet with no CosmosPay account still
crashes, and refusing its error reports would blind us to exactly the population
that meets first-run failures — the ingest route would answer `403` and the
reports would be dropped. Events arriving on this key are anonymous by
construction (one shared consumer), so nothing account-identifying may travel with
them; the wallet strips address, destination, amount and txHash before sending.

The guard identifies the public consumer by **either** the forwarded role
(`X-Consumer-Role: public`) **or** the configured `APISIX_PUBLIC_CONSUMER`
username. Two signals, because each alone fails open in a way that costs user
data: a gateway that stops forwarding roles would promote every anonymous caller
to an ordinary tenant, and a deployment that never set the env var would rely on a
header it does not control. Set both.

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

Optional **idempotency** (issue #17): send an `Idempotency-Key` header (preferred)
or `idempotencyKey` in the body. A retry with the same key **and the same request**
— network, source, destination, both assets, amount, slippage and memo — returns
the **existing** swap (`id` + `txHash`) instead of building another Stellar
transaction. The same key with any different request is `409 idempotency_conflict`,
and the error names nothing about the stored swap. Liquidity deposits and
withdrawals follow the same rule, with the operation's kind compared as well. The
comparison exists because of the shared public key: every anonymous wallet is one
consumer, so a key someone else used first handed you *their* unsigned envelope —
one that could move your funds to them. Without a key, the unique
`(network, txHash)` constraint still rejects
a byte-identical rebuild with **409** (sequence / XDR collision). When
`STELLAR_SWAP_SINGLE_INFLIGHT=true`, a second non-expired `PENDING` swap for the
same `(consumer, source, network)` also returns **409** naming the existing id
(default **off** — concurrent distinct swaps from one account remain allowed).

```jsonc
// response → { id, status: "PENDING", network, sendAmount, feeAmount, swapAmount,
//              destEstimated, destMin, path, xdr, uri: "web+stellar:tx?xdr=…", qr, txHash, … }
```

**`POST /v1/swaps/:id/submit`** — relay the signed envelope (`swaps:write`).

```jsonc
// request
{ "signedXdr": "AAAAAgAAA…(signed base64 XDR)…" }
// response
{ "submitted": true, "status": "SUCCEEDED", "txHash": "…", "swap": { … } }
// on a network rejection → { "submitted": false, "status": "FAILED", "reason": "…", "resultCodes": ["op_under_dest_min"], "swap": { … } }
```

The signed transaction's hash is verified against the one the service built before
it is broadcast, so a caller can never have the service relay an arbitrary
transaction. A swap fires `SWAP_CREATED` / `SWAP_SUBMITTED` / `SWAP_SUCCEEDED` /
`SWAP_FAILED` webhook events through the same dispatcher.

## Aliases — claimable payment handles

An alias lets a payer type `emanuel250` instead of `GA5ZSE…`. It is also what a
payer reads immediately before authorising a transfer, so every rule below exists
because getting it wrong does not produce a bad row — it produces a payment to
the wrong account under a name the payer trusted.

### Claimed by proving control of a key, not by asking

```
wallet ──1. POST /v1/aliases/challenges {name, address, network} ──▶ nonce + the EXACT message to sign
wallet ──2. signs SHA-256(domain ‖ 0x00 ‖ uint32be(length) ‖ message) with that address's key
wallet ──3. POST /v1/aliases {name, email, nonce, signature} ────────▶ alias bound to the calling consumer
```

- **The service returns the message; the client never rebuilds it.** A client that
  assembles it from documentation is one field-order change away from signatures
  that are refused with nothing on either side saying why.
- **The signature covers a domain-tagged digest, never a transaction.** Nothing
  this flow asks a wallet to sign can be submitted to the network, and the domain
  (`Cosmos Pay alias claim v1`) belongs to this feature alone, so a dapp that talks
  a user into signing an arbitrary message cannot come away with a valid claim.
- **The purpose is inside the signed bytes** (`CLAIM`, `ADD_ADDRESS`, `RECOVER`),
  so a signature collected to add an address cannot be replayed to finish a
  recovery.
- **The address comes from the challenge, not from the claim body.** The claim
  has no address field, so nobody can sign for one address and register another.
- **Challenges are single-use and live five minutes.** The signature is verified
  *before* the challenge is spent, so a junk signature cannot burn a rival's
  in-flight nonce, and spending it is a compare-and-swap, so two requests cannot
  both spend one.
- **A race is settled by the unique index on `alias.name`**, not by a pre-check;
  the loser gets `409 alias_taken`.

### What a handle may be

Lowercase `a-z`, `0-9` and `_` (never at either end), 3–32 characters, folded to
lowercase before uniqueness is decided. No Unicode: a homoglyph set is unbounded,
and no normalization makes a Cyrillic `а` safe to render next to an amount. Also
refused: reserved words that would impersonate the product or an operator
(`admin`, `support`, `cosmospay`, `stellar`, …) and anything that reads like a
Stellar account (`g` or `m` followed by 20 or more base32 characters). The rule is
`src/aliases/alias-name.ts`.

### Many addresses, one name

An alias points at up to 20 addresses across networks — a phone, a desktop, a cold
wallet, testnet — with exactly one primary per network, enforced by a partial
unique index. Adding an address takes **two** proofs: the caller owns the alias,
and the new address signs its own `ADD_ADDRESS` challenge. The last remaining
address cannot be removed (release the alias instead), and one consumer may hold
at most 25 aliases.

A `SUSPENDED` alias — an operator hold — resolves to nothing. A suspension that
still hands out an account does nothing about the money.

### Recovery goes through email, and through the platform console

Keys get lost, and a lost key must not leave a name unreachable forever, so a claim
records a recovery mailbox. That makes recovery the most dangerous path in the
module:

1. The **platform console** calls `POST /v1/aliases/:name/recovery {email}`. The
   response is identical whether or not the handle and mailbox matched; on a match
   it carries a single-use token (30 minutes, stored only as a SHA-256), which the
   console emails. This service sends no mail.
2. The user gets a `RECOVER` challenge for the new key and calls
   `POST /v1/aliases/:name/recovery/complete {token, address, network, nonce, signature}`
   with their own API key. Both proofs are required: the token proves the mailbox,
   the signature proves the key.
3. Ownership moves to the calling consumer and **every previous address is
   dropped**. Recovery exists because the old keys are gone, and leaving them
   resolvable would keep whoever holds them receiving the payments.

**Why step 1 belongs to the console.** The token *is* the proof of mailbox control,
so it may only reach the party that delivers the mail. The route used to accept any
key holding `payments:write` and returned the token to whoever asked — so anyone
who knew a handle and its owner's email could take the alias, and every payment
sent to it. `ConsoleOnlyGuard` now refuses every API-key caller with
`403 admin_console_only` before the alias is even looked up, and the route is kept
out of the published contract. Five wrong tokens burn a recovery (the owner simply
starts another; an attacker cannot lock a name by failing at it), and a suspended
alias cannot be recovered.

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
the mandatory **KYC** (BlindPay *receivers*) behind both. We run a **single
platform BlindPay instance** (`BLINDPAY_API_KEY` + `BLINDPAY_INSTANCE_ID` in env);
every receiver/wallet/bank-account/payin/payout is mirrored in our Postgres and
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
| PATCH  | `/v1/kyc/receivers/:id`                               | `kyc:write`    | Update a receiver |
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
`BLINDPAY_WEBHOOK_SECRET` to that endpoint's signing secret. Leave the
`BLINDPAY_*` vars blank to disable the feature (those routes return `503`). See
`.env.example`.

### KYC redirect URLs are allow-listed per consumer

The terms-of-service flow sends the user to BlindPay and back to a `redirect_url`
the integrator supplies. Accepted as a free string, that is an open redirect
wearing the platform's name: a link that starts on a trusted KYC page and lands
wherever an attacker chose. So every `redirect_url` passes two layers:

| Layer | Rule | Where |
| ----- | ---- | ----- |
| Shape | an absolute `https` URL with no embedded credentials (`user:pass@`) | `@IsRedirectUrl()` on every DTO that carries one |
| Host | on **the calling consumer's** allow-list — the exact host, or a subdomain at a label boundary (`app.acme.com` matches `acme.com`; `evilacme.com` does not) | `KYC_REDIRECT_URL_WHITELIST`, enforced in the service layer |

```
KYC_REDIRECT_URL_WHITELIST={"cosmos_acme":["acme.com","app.acme.com"]}
```

It **fails closed**: a consumer with no entry cannot use a redirect at all, and a
host with a trailing dot or in IDN form is refused rather than normalized. The
list is per consumer because a domain one integrator vouches for says nothing
about another. Every entry point that takes a `redirect_url` checks it —
initiating, requesting and approving terms of service, the admin approval
included, which applies the list of the receiver's own consumer. A refused scheme
or host is a `400`.

## Pollar — social login that hands back a Stellar wallet

[Pollar](https://docs.pollar.xyz/docs) turns a Google/GitHub login into a Stellar
account: it authenticates the user, creates a wallet, custodies the key in AWS
KMS, adds the configured trustlines and funds the reserve — the user never sees a
seed phrase. This service exposes it as an **OAuth bridge**, the same shape a game
launcher or console uses when the client finishes the code exchange locally.

### Why a bridge and not a passthrough

Pollar's hosted login is designed for a browser SDK. It hands the user to
`GET /auth/{provider}` with a publishable key, a client-session id and a
`redirect_uri` — and that redirect URI must be a host **registered with Pollar**.
A wallet cannot satisfy any of that: a loopback listener on an ephemeral port or
a `cosmospay://` deep link can never be a registered host, and the assembly needs
keys and session ids the wallet should not be handling.

So the bridge owns the Pollar-facing half. The wallet gets a two-step contract it
already understands — **open an authorization, redeem a code** — and absorbs
nothing but that code.

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

Step 6 is the point of the whole thing: the redemption response also carries the
`publishable_key` and `api_base_url`, so from there the wallet reads balances,
builds and submits transactions against the virtual wallet itself. **This service
never proxies that surface and holds no key that could.**

### Two ways to absorb the code

|                  | Redirect flow                                    | Poll flow                                       |
| ---------------- | ------------------------------------------------ | ----------------------------------------------- |
| Wallet supplies  | `redirect_uri` (must be allow-listed)            | nothing                                         |
| Code arrives     | as `?code=…&state=…` on the redirect             | from `GET /v1/pollar/oauth/sessions/{state}`    |
| The browser sees | your own URI                                     | a plain "you can close this window" page — never the code |
| Use it when      | the wallet has a deep link or loopback listener  | it has neither (kiosk, headless, embedded view) |

Each poll issues a fresh code and retires the previous one, so redeem the code
from your most recent poll. That falls out of never storing a live credential:
the row keeps a SHA-256 of the code, and a hash cannot be un-hashed.

**Prefer the poll flow.** Pollar does not return the browser to the callback: its
hosted flow ends on its own page — `www.pollar.xyz/auth/status` — whether the
consent was refused or granted, and a granted one simply leaves the client
session `READY` on Pollar's side. The `redirect_uri` the authorization URL
carries is never navigated to, so a handshake that waits to be called back waits
until it expires.

So the poll route asks Pollar instead of waiting to be told: while a handshake is
`pending` it checks the client session's own status, and promotes the handshake
the moment Pollar reports `READY` — the same condition the redemption already
waits for. The wallet's contract does not change; what changed is that `pending`
now ends on its own.

Two operational notes fall out of that:

- **The callback route still exists and is still registered with Pollar.** It
  works if a redirect does arrive, and it is what a redirect-flow handshake
  depends on — that flow has nowhere to put a code otherwise. It just cannot be
  the only way a login is noticed.
- **The provider is asked at most once every two seconds per handshake**
  (`POLLAR_SESSION_PROBE_INTERVAL_MS`), a compare-and-swap on
  `providerCheckedAt` that every replica shares. A wallet polling every second
  therefore costs Pollar 30 requests a minute, not 60, against a key whose whole
  budget is 200.

A handshake whose client session Pollar has disowned (`INVALID_CLIENT_SESSION_ID`,
`EXPIRED_CLIENT_ID`, or a `404`/`410`) is closed as `failed` with that code on the
spot, rather than polled until the TTL runs out.

### One login, a wallet on both networks

Pollar runs mainnet and testnet as two separate applications with two separate
key pairs, so a hosted login can only ever produce a wallet on the network its
API key resolved to (`prod` → `public`, `dev` → `testnet` — see `resolveNetwork`).
A user who then moves between environments has no wallet on the other side: the
address they funded on testnet is not the address that receives on mainnet, and
the second wallet ends up being created at whatever moment they first need it,
which is the moment least able to absorb a provider failure.

So a redemption also registers the user on the **other** network, through the
Server API's `POST /users/with-wallet`, and `POST /v1/pollar/oauth/token`
reports both:

```jsonc
"network_wallets": [
  { "network": "testnet", "status": "ready",   "address": "GA5Z…" },
  { "network": "public",  "status": "pending", "address": null    }
]
```

**A `pending` entry is not an error.** The login succeeded; the second wallet is
the part that did not land yet, and the whole point of the design is that it
cannot take the login down with it. The attempt on the request path gets five
seconds and one try, and whatever it does not finish is retried in the background
by the provisioning sweeper — same switch and cadence as the handshake sweeper
(`POLLAR_SWEEP_*`), with an exponential backoff and a total budget of ten
attempts before the row goes `failed`.

The common reason for `pending` is prosaic: **the other network's keys are not
configured.** Until they are, every login leaves a pending counterpart; the
moment they land, one sweep provisions the whole backlog without anyone logging
in again. That is why the keys for both networks are worth setting even when you
only serve one today.

Two consequences worth knowing:

- **The join key is the OAuth email**, because that is what a later hosted login
  on the other network resolves the same person by. A provider that vouches for
  no email gets no counterpart wallet at all — better than an orphan wallet that
  cost XLM and that no login ever reaches.
- **It spends XLM on both networks.** A mainnet login now also funds a testnet
  reserve and vice versa. The per-network state lives in `pollar_user_wallet`,
  one row per (consumer, email, network), which is also the idempotency: a repeat
  login upserts through it instead of provisioning again.

### What the bridge stores

A handshake row, and nothing in it can spend money: the unguessable `state`, the
Pollar client-session id, a **hash** of the code, and the resulting public Stellar
address. **No Pollar token is ever persisted** — the `/auth/login` exchange runs
inside the redemption request and the tokens go straight out in its response.
Handshakes nobody finished are expired on a timer (`POLLAR_SWEEP_*`), because an
`AUTHORIZED` row is a redeemable code until it is swept.

Every transition is a compare-and-swap on the row's status, so a replayed
callback mints no second code, and two wallets racing one code cannot both win.

### Hardening worth knowing about

- **PKCE (RFC 7636, S256)** is optional but recommended: pass `code_challenge` at
  authorize and `code_verifier` at redemption, and a code that leaks from a
  browser or a log is useless without the verifier.
- **`dpop_jwk`** binds the tokens Pollar mints to the wallet's own P-256 key
  (RFC 9449), so a stolen access token is inert without a signed proof. It also
  means the bridge can no longer act for the wallet — `/refresh` and `/logout`
  serve bearer sessions, and a DPoP-bound wallet calls Pollar directly.
- **`POLLAR_REDIRECT_URI_WHITELIST`** is per consumer and fails closed. A redirect
  URI is where a single-use code lands, so an unvetted one is an exfiltration
  channel. It accepts loopback hosts (any port, per RFC 8252), private-use scheme
  deep links, and https hosts.
- **Keep API keys that hold `pollar:*` on a server.** The poll flow hands the code
  to whoever holds the handshake's `state` *and* a key with `pollar:read`. An
  attacker who extracts such a key from an app shipped to users can open a login,
  send its `authorization_url` to a victim, poll for the code once the victim
  consents on the real Google/GitHub page, and redeem it with a PKCE verifier of
  their own — PKCE and `dpop_jwk` do not help, because the attacker supplies both.
  That is the device-code phishing shape, and the defence is that the key never
  leaves a backend you control.

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
| POST   | `/v1/pollar/users` · `/v1/pollar/users/with-wallet`   | `pollar:write` | Register a user, optionally with a wallet |
| POST   | `/v1/pollar/tokens/verify`                            | `pollar:read`  | Validate a token a wallet presented to you |

The last six need Pollar's **secret** key, which is exactly why they live here
rather than in the wallet. Request and response schemas for all of them are in
the generated contract — Swagger UI at `/docs`, or `openapi/openapi.{json,yaml}`.
The table above is for orientation; the contract is the source of truth.

### Rate limiting: what stops wallet generation being spammed

Creating a Pollar wallet is not free. Pollar creates the Stellar account, funds
its base reserve (1 XLM) and adds a trustline per configured asset (0.5 XLM
each) — **out of your funding wallet**. A loop against the login flow is
therefore a way for a stranger to spend your money, and it does not need a real
user at the far end to do it.

So the caps live here, in this service, rather than only at the gateway: this is
the process that knows a request is about to create an account, and it is the
one that can refuse before the XLM leaves.

**The control point is `authorize`, not `token`.** A handshake yields at most one
wallet, so bounding how many handshakes one address may open bounds how many
wallets it can cause. `token` stays deliberately looser, because the 409 path
tells the caller to retry that exact request while Pollar provisions the account
— a tight budget there would throttle our own documented retry, and redeeming
creates nothing the handshake had not already allowed.

| Route | Budget (per 10 min) | Why that number |
| ----- | ------------------- | --------------- |
| `POST /v1/pollar/oauth/authorize` | 20 | The cap on wallet generation. Far above a human retrying a failed consent screen, far below a rate that drains an account |
| `POST /v1/pollar/oauth/token` | 60 | Loose on purpose — see above |
| `GET /v1/pollar/oauth/callback` | 60 | The only route reachable without an API key, so the only one an anonymous flood can reach. A user refreshing the tab is normal |
| `POST /v1/pollar/users/with-wallet` | 10 | Creates a wallet with no consent screen pacing it — the tightest budget in the set |
| `POST /v1/pollar/wallets/activate` | 20 | Spends XLM per call, but cannot create anything new |

Exceeding one returns **`429` with `code: "rate_limited"`**, a `Retry-After`, and
the `RateLimit-Limit` / `-Remaining` / `-Reset` triple. Everything else in the
service is unlimited here; general traffic shaping is APISIX's job, since it sees
the request before this process does.

**The counter is in Postgres, not in memory.** The service runs behind a load
balancer, so a per-process limiter would hand each replica the full budget: the
effective limit becomes `limit × replicas` and changes silently whenever the
deployment scales. That is fine for a cosmetic throttle and not fine for
something guarding a real balance. It is a fixed window — one atomic
`INSERT … ON CONFLICT … RETURNING` per request — which does mean a client can
spend a full budget on each side of a boundary, so treat the numbers above as
"at most twice this per window". They are set knowing that.

**How the address is decided, and why it cannot be spoofed.** `main.ts` sets
`trust proxy` to `1`, which makes Express read the *rightmost* entry of
`X-Forwarded-For` — the one APISIX appended, i.e. the peer as the gateway saw
it. A client may prepend entries to that header, but everything it writes lands
to the left of APISIX's and is ignored.

> **Do not raise `trust proxy`.** At `2` Express starts honouring the first
> client-supplied hop, and every limit here becomes bypassable by adding one
> header. `src/common/client-ip.spec.ts` pins both behaviours so the change
> cannot pass review unnoticed.

An IPv6 caller is bucketed per **/64**, not per address: a client is routinely
handed a whole /64 and can rotate through it for free, so per-address limiting
there is not limiting. The cost is that two users behind one /64 share a bucket,
exactly as two users behind one IPv4 NAT already do. Buckets are also keyed by
consumer, so one integrator's traffic cannot eat another's.

If the counter cannot be written the limiter **fails closed** (`503`). A limiter
that quietly stops limiting during a database incident is worth less than none,
because nothing tells you it happened — and every route behind it needs the same
database anyway, so refusing costs no availability that was not already lost.

Set `RATE_LIMIT_ENABLED=false` as the incident switch.

### Setup

1. Create an app at [dashboard.pollar.xyz](https://dashboard.pollar.xyz) and take
   both keys for your network (`pub_testnet_…` / `sec_testnet_…`). Do it for
   **both** networks: a login provisions a wallet on each, and a network with no
   keys leaves every user's second wallet `pending` until they are set. The two
   dashboards are separate — register the callback host in each.
2. Register the **gateway host** of `POLLAR_BRIDGE_CALLBACK_URL` under
   **Build → Domains**. This is not only about the redirect: the SDK API checks
   that list on *every* call, against the `Origin` header, and the bridge sends
   this host's origin as that header (`POLLAR_SDK_ORIGIN` overrides it). An
   unregistered host is `403 ORIGIN_NOT_ALLOWED` on `POST /auth/session` — the
   first call of every login, before the user ever sees a consent screen.
3. Set `POLLAR_BRIDGE_CALLBACK_URL` to `<gateway>/v1/pollar/oauth/callback` — the
   bridge appends `/{state}` itself.
4. Add each wallet's redirect URI to `POLLAR_REDIRECT_URI_WHITELIST`, or omit it
   and use the poll flow.

Keys are per network, and Pollar encodes the network and key type in the prefix,
so a mismatch is a hard rejection — the env validator catches it at boot instead
of on a user-facing login. Leave the keys blank to disable the feature (Pollar
routes then return `503`). See `.env.example`.

## Upgrading — breaking changes and deploy notes

### Security review fixes

A review of the whole service found the issues below. Each is fixed and pinned by a
test that fails without the fix. Most change nothing for a well-behaved caller, but
every row is visible to someone — read the "Who notices" column before deploying.

| Change | Who notices | Why |
| ------ | ----------- | --- |
| `POST /v1/aliases/:name/recovery` is **platform-console only**: an API key gets `403 admin_console_only`, and the route left the published contract | Anyone who started recoveries with an API key | The response carries the recovery token, which is the proof of the owner's mailbox. Behind a scope alone, anyone who knew a handle and its owner's email received the token and could take the alias and every payment sent to it |
| Completing a recovery on a `SUSPENDED` alias is a `404` | Nobody legitimate | A token minted before a suspension was a way out of the operator hold |
| `@Public()` routes (Pollar callback, BlindPay webhook, health) ignore `X-Consumer-Username` | Dashboards: those requests now log as anonymous | Those routes run without key-auth, so the header was the client's own: a new name per request was a fresh rate-limit budget, and naming a victim filed forged rows into their API-log view |
| Refusals by `AdminGuard` and `ConsoleOnlyGuard` are logged at `warn` | Operators | Guards run before the access log, so a probe of `/v1/admin` left no trace anywhere |
| `POST /v1/pollar/wallets/activate` and the three `/v1/pollar/wallets/:address/trustlines…` routes return `404` for a wallet the calling consumer did not obtain through this service on that network | Integrators acting on wallets they only saw through `tokens/verify`, on non-primary wallets of a login, or on a counterpart wallet another tenant already registered | Every tenant shares one set of Pollar secret keys, so without the check one tenant could remove another tenant's users' trustlines or spend the operator's XLM on their reserves. A foreign and an unknown wallet get the same `404`, so the answer is not an ownership oracle |
| Both `POST …/trustlines` routes share a `429` budget of 20 calls per 10 minutes | Scripts that add trustlines in bulk | Each trustline locks 0.5 XLM of reserve out of the operator's funding wallet, and these were the only XLM-spending routes without a cap |
| `GET /v1/offramp/payouts/:id` no longer returns `raw`, `consumerId`, `receiverId`, `quoteId`, `bankAccountId` or `updatedAt`; the virtual-account create response no longer returns `raw`, `receiverId`, `consumerId` or `updatedAt` | Callers reading those fields | `raw` is BlindPay's stored object, with bank and beneficiary data, and it reached any key holding `offramp:read` — the read path ignored the public projection every other payout read uses |
| `POST /v1/kyc/upload` returns `400` for more than 4 text fields, a field over 1 KiB, a second file, or file bytes that do not match the declared type | Nobody sending a well-formed upload | Multer's defaults left fields unbounded and 1 MB each in memory, and the type check trusted the client's `Content-Type` |
| `POST /v1/payment-intents/tx` and `/pay`: the same memo with any different term is `409 idempotency_conflict`. An identical retry still returns the stored intent (`2` and `2.0` are the same amount) | Callers reusing one memo for different payments | Under the shared public key every anonymous wallet is one consumer, so a memo someone else created first returned *their* intent — with a QR that paid them |
| `POST /v1/payment-intents/:id/validate` marks `FAILED` only for a failed tx that is this intent's own payment; any other failed tx is `valid: false` with the status unchanged. A tx that closed more than 60 s before the intent was created is refused ("Transaction predates this payment intent") — on validate, on `PATCH {status: SUCCEEDED}`, and in the observer | Nobody legitimate | The hash of any failed transaction on the network failed an intent permanently, and an old payment with the same terms could settle a new intent |
| `PATCH /v1/payment-intents/:id` changing `txHash` on a terminal intent is `400 invalid_state_transition`; a status change racing the write is `409 operation_in_flight` | Nobody legitimate | It rewrote the settlement evidence of a `SUCCEEDED` intent |
| The payment-intent observer reconciles at most 10 intents per consumer per tick and never scans expired rows | Operators watching observer throughput | A flood of open-amount intents from one consumer starved every other tenant's settlement and spent the shared Horizon budget |
| `POST /v1/swaps`, `/v1/liquidity-pools/deposit` and `/withdraw`: a reused `Idempotency-Key` with a different request — a different memo or slippage, the other network, or a deposit key reused for a withdrawal — is `409 idempotency_conflict`. A replay carrying an invalid asset, slippage or memo now gets the normal `400` | Clients reusing one key for different operations | Under the shared public key, an attacker could pre-create a swap or withdrawal from a victim's account to their own under a guessable key, and the victim's retry returned that envelope for them to sign |
| `POST /v1/liquidity-pools/withdraw` no longer answers `409 operation_in_flight` for an in-flight withdrawal whose sequence number the account has not used yet (an unsigned or abandoned envelope) | Wallet users who were blocked | A dust withdrawal built for someone else's account and re-sent every 300 s locked every public-key user out of withdrawing that position. The two envelopes share a sequence number, so at most one can ever settle |
| The settlement observer takes at most 10 rows per consumer per table per tick, and `GET /v1/liquidity-pools/positions` reads Horizon through one paged listing instead of one request per pool | Operators | One consumer's flood starved everyone else's settlement, and an account holding many pool shares fanned out unbounded Horizon calls |

Deploy notes that come with it:

- **Migration `20260910120000_aliases`** creates `alias`, `alias_address`,
  `alias_challenge` and `alias_recovery`. Run `migrate deploy` before the new
  build serves traffic.
- **A new advisory lock id, `881_008` (`AliasChallengeSweeper`).** Nothing to
  configure; listed so the number is never reused.
- **Set `NODE_ENV=production` in production.** `.env.example` ships
  `development`, and two protections key on it: a request missing
  `X-Plan-Swap-Fee-Bps` is a `503` only in production (anywhere else swaps
  silently fall back to `STELLAR_SWAP_FEE_BPS`), and `/docs` — outside every guard
  — is off by default only in production.

### NestJS 12, TypeScript 6 and a Node floor of 24.9

The whole NestJS line moved to 12 and TypeScript to 6. **This raises the minimum
Node version to 24.9** (`engines`, and both workflows now pin `node-version: 24`);
anything older cannot run the test suite at all. Deploy targets have to move with
it.

The reason is the test runner, not the framework. NestJS 12 publishes as pure ESM
(`"type": "module"`), and Jest running under CommonJS cannot `require()` it — every
one of the 62 suites failed to load. Jest supports `require(esm)` natively, but only
on Node >= 24.9 **and** with `--experimental-vm-modules`, because the capability it
checks for (`vm.SourceTextModule.prototype.hasAsyncGraph`) does not exist without
that flag. So the test scripts now invoke Jest through Node directly:

```
"test": "node --experimental-vm-modules node_modules/jest/bin/jest.js"
```

Not a `NODE_OPTIONS=` prefix: that is not portable to Windows shells, and CI, the
release job and a developer's machine must run the same command.

Two consequences worth knowing:

- **`transformIgnorePatterns` is gone from both Jest configs.** It listed the ESM
  packages (`@stellar`, `@noble`, `@exodus`, `uint8array-extras`) to be transpiled
  to CommonJS by ts-jest — a workaround for not being able to load ESM. Now that
  Jest loads ESM natively the workaround actively breaks: a package compiled to
  CJS gets evaluated as ESM and dies on `exports is not defined`. If a dependency
  ever needs transforming again, that is the file to look at.
- **`tsconfig.json` gained `types` and `rootDir`.** TypeScript 6 no longer
  auto-includes every `@types` package, so the two ambient ones (`node`, `jest`)
  are named explicitly — without that, every spec lost `describe`/`it` while still
  running green under ts-jest. And TS 6 refuses to infer `rootDir` when a
  compilation covers one directory (TS5011), which is what the ts-node scripts do;
  `"./"` is what the full build already inferred, so the emitted layout is
  unchanged.

Code changes the majors forced, all small:

- `EventEmitter2` is imported from `eventemitter2`, not `@nestjs/event-emitter`.
  It is the same class object at runtime — the DI token is unchanged — but the
  Nest re-export is typed for the package's CJS shape and resolves to `any` under
  this repo's `node10` module resolution, which silently turned every `.emit()`
  into an unchecked call. `eventemitter2` is now a direct dependency for that
  reason.
- `OperationObject` comes from `@nestjs/swagger` rather than
  `@nestjs/swagger/dist/interfaces/open-api-spec.interface`. Swagger 12 publishes
  an `exports` map exposing only `.` and `./plugin`, so deep paths no longer
  resolve.
- `AccountLoaderService.load` carries an explicit `Promise<Horizon.AccountResponse>`
  return type; TS 6 will not infer a type it cannot name portably.
- Two test mocks (`fetch`, `Reflector.getAllAndOverride`) now match the real
  signatures instead of narrower hand-written ones.

The published OpenAPI grew: `@nestjs/terminus@12` emits richer health schemas
(status enums and a `responseTime` property). Purely additive — no business route
or schema changed.

### A shared public API key, and the guard that confines it

New in this release: `PublicKeyGuard` (global, after `PermissionsGuard`) and the
`@AllowPublicKey()` decorator. Nothing changes for existing keys — the guard has
no opinion about a consumer that is not the shared public one — but two things
need doing at deploy time:

- **Set `APISIX_PUBLIC_CONSUMER`** to the username the dev platform provisions for
  the public key, on every deployment that publishes one. Without it the guard
  falls back to the forwarded `X-Consumer-Role` alone.
- **The public key must be minted with `role: public`** and only the scopes the
  allowlisted routes need. Granting it `kyc:*` or `webhooks:*` would not open
  those routes — the guard refuses them regardless — but it would be a credential
  wider than its job, held by everyone.

See "The shared public API key" above for what it may reach and why.

### The asset registry: `GET /v1/assets`

A curated table of the (code, issuer) pairs this platform vouches for, per
network, with the issuing organization named. It requires no scope — the catalog
holds no tenant data, and gating it would only mean every key minted before the
scope existed reads an empty token picker — but it does require an authenticated
consumer, the shared public key included.

`npm run assets:verify` re-checks every row against live Horizon: that the pair
exists on the network it is filed under, that `contract` matches Horizon's
`contract_id`, and that the issuer flags match the chain. Run it when editing the
registry. It is not a unit test because it needs the public internet, and a test
that fails when Horizon is slow is a test people learn to skip.

### Client activity: a new module, a new table and two new scopes

`POST /v1/activity/events` accepts telemetry from the wallet and the developer
dashboard; `GET /v1/activity/events` and `GET /v1/activity/summary` read it back.
Nothing existing changed shape, but three things need doing at deploy time:

- **Migration `20260906140000_activity_event`** creates `activity_event`
  (append-only, `consumerId`-scoped, unique on `(consumerId, eventId)`).
- **The scopes `activity:write` and `activity:read` are new.** A key without them
  gets `insufficient_scope`, which is the correct answer — but it means an
  existing key does not gain the ability to report telemetry by upgrading. The
  developer platform grants both to wallet-provisioned keys and re-applies the
  set on rotation; keys minted by hand need them added.
- **`ACTIVITY_RETENTION_DAYS`** (default 30) joins the retention job. It is
  personal data on the same footing as the access log; set it to `0` only
  deliberately.

### The Pollar poll route now discovers a finished login itself

`GET /v1/pollar/oauth/sessions/{state}` used to report whatever the bridge
callback had recorded. Pollar never calls that callback — its hosted flow ends on
`www.pollar.xyz/auth/status` and leaves the client session `READY` — so a
poll-flow handshake stayed `pending` until it expired, under a wallet that was
doing everything right. The poll now asks Pollar directly and promotes the
handshake on `READY`.

No API shape changed and no client change is needed: a login that used to hang on
`pending` now reaches `authorized` within a poll of the user finishing. Two
things to be aware of when deploying:

- **Migration `20260906120000_pollar_oauth_provider_probe`** adds a nullable
  `providerCheckedAt` to `pollar_oauth_session`. It is the shared floor on how
  often the question reaches Pollar; nothing backfills.
- **Poll traffic now reaches Pollar.** Budget for one provider request per
  in-flight login every two seconds, on the publishable key for that network.

### Pollar logins now provision a wallet on both networks

`POST /v1/pollar/oauth/token` gained a `network_wallets` array — one entry per
Stellar network, each `ready`, `pending` or `failed`. Additive, so nothing
breaks, but two operational notes:

- **Run the migration.** `20260905120000_pollar_user_wallet` adds
  `pollar_user_wallet` and the `PollarWalletStatus` enum. Without it every
  redemption logs a failed provisioning and the counterpart wallet stays
  unrecorded — the login itself keeps working.
- **Set the keys for both networks.** `POLLAR_*_MAINNET` and `POLLAR_*_TESTNET`
  are each optional on their own, and a network with no keys now shows up as a
  `pending` wallet on every login rather than as nothing at all. Configure the
  second pair and the sweeper drains the backlog on its next tick; leave it
  unset deliberately and the rows sit `pending` until the ten-attempt budget
  retires them. Either way no login fails.

Budget for the XLM: a login now funds a reserve on *both* networks, so mainnet
spend per new user is unchanged but testnet spend appears where there was none.

### `429` now reports `rate_limited`

A bare `429` used to fall back to `code: "provider_unavailable"`, which said an
upstream was in trouble when in fact this service had refused the request
itself — sending integrators to investigate something that was perfectly
healthy. It now reports `code: "rate_limited"`, and `ApiErrorCode.RateLimited`
is part of the published enum. Branch on that if you retry on throttling.


### Response shapes that changed

Three published shapes changed in the audit-hardening release. All three are
under `/v1`; there is no `/v2`, so integrators must be told before you deploy.

| Endpoint | Was | Now | Why |
| -------- | --- | --- | --- |
| `GET /v1/webhooks` | bare array, silently clamped at 100 | `{ data, total, take, skip }` | A consumer with 120 endpoints got 100 with nothing saying so, and no `total` to page against |
| `GET /v1/products` | bare array, whole table | `{ data, total, take, skip }` | Unbounded read |
| `GET /v1/webhooks/:id/deliveries` and the redelivery response | included `payload` | `payload` removed | A `RECEIVER_UPDATED` body is a full KYC dossier and these routes are gated on `webhooks:read`, not `kyc:read` |

A caller doing `for (const x of res)` or reading `delivery.payload` breaks on
deploy. Migration is mechanical: read `res.data`, and fetch KYC details from the
KYC endpoints with a key that holds `kyc:read`.

`RECEIVER_UPDATED` / `PAYIN_*` / `PAYOUT_*` **webhook bodies** also narrowed to
identity and state — see the Webhooks section.

### The audit-hardening migration

It ships as two files that must be applied in order:

- `20260901120000_audit_hardening` — the correctness work: a new column, a
  de-duplicating `DELETE` on `liquidity_pool_operation`, two `UNIQUE` indexes,
  two new tables. The DELETE and the unique index it feeds run inside an
  explicit transaction under a `SHARE ROW EXCLUSIVE` lock, so a rolling deploy
  cannot slip a duplicate between them. Writers to that one table block for the
  few milliseconds it spans.
- `20260901120100_audit_hardening_indexes` — nine additive indexes, built
  `CONCURRENTLY` so the deploy does **not** block writes on `payment_intent`,
  `swap`, `webhook_delivery` or `request_log`. No maintenance window needed.

The split is not stylistic: PostgreSQL refuses `CREATE INDEX CONCURRENTLY`
inside a transaction block, and the first file needs one. Both are verified in
CI against a real PostgreSQL, which also asserts no index was left `INVALID` and
that the migrations still match `schema.prisma`.

If the second file fails partway, a `CONCURRENTLY` build leaves an **invalid**
index rather than failing cleanly, and `IF NOT EXISTS` considers it present. Drop
it, then re-run:

```sql
SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE NOT i.indisvalid;
```

### `ADMIN_API_CREDENTIALS` is gone — `/v1/admin` is the platform console's

**Delete the variable.** It is no longer read, and the matching
`COSMOS_ADMIN_API_SECRET` / `COSMOS_ADMIN_API_SECRET_READ` in the developer
platform go with it.

It was a second credential that decided, in this service, who is a platform
admin — and the developer platform had already decided that against the
signed-in account's role. Two answers to one question, and every deployment that
set up the gateway but skipped this secret got the split in its most confusing
form: an owner could change another account's plan and role in the console,
which never asks for this secret, yet every cross-tenant read answered `401
admin_credentials_required`. Nothing in that error points at a missing
deployment secret rather than at the account's own rights.

So the question the guard asks changed from "does the caller hold the admin
secret?" to "did this call come from the platform console?", which is settled by
two facts already on the request:

1. `X-Gateway-Secret` matches `APISIX_GATEWAY_SECRET` — checked by `ApisixGuard`
   as on every other route. Only the gateway and the console backend hold it.
2. `X-Cosmos-Internal` is present. APISIX strips it from every request it
   proxies (`proxy-rewrite.headers.remove`), so an API-key caller cannot carry
   it; only a direct call from a backend holding the gateway secret can.

Name the trade plainly: fact 2 rests on gateway routing configuration that lives
in the developer-platform repo, not on a secret this service holds. Two things
pay for it. The console is now the single place that answers "who is a platform
admin", so the two answers cannot disagree; and attribution got sharper rather
than weaker — an audit row used to name a shared credential (`owner`, `viewer`),
and now names the console account that acted (`cosmos_<userId>`) plus the
platform role it asserted, on every mutation **and** every read.

What this changes for a caller:

| Was | Now |
| --- | --- |
| `401` `admin_credentials_required` without a Bearer secret | `403` `admin_console_only` for anything that is not a console call |
| `403` `admin_role_required` for a `read` credential on a mutation | gone — the console already decided the account may act |
| `actorId` / `actorRole` on an audit row named the credential | they name the console account and its platform role |

If you reach `/v1/admin` directly (an ops script, say), send `X-Gateway-Secret`,
`X-Consumer-Username` and `X-Cosmos-Internal: 1`; add
`X-Cosmos-Admin-Role: owner` so the audit row is labelled. Keep the service off
the public internet — with the admin secret gone, network isolation and the
gateway secret are what stand in front of cross-tenant data.

### `APISIX_GATEWAY_SECRET` now requires 32 characters

The service refuses to boot below that. It previously accepted a single
character, and it is now the *only* secret standing between the outside world and
the platform-admin surface (see above), so it carries more weight than it used
to. Generate one with `openssl rand -hex 32` and rotate it in APISIX at the same
time.

### Features from `v0.1.0`–`v0.1.5` that this release supersedes

`main` and this branch solved several of the same problems independently while
they were apart. Where both had an answer, this branch's design is the one that
ships, so a deployment coming from `v0.1.5` loses the following. None of it is
an accident — each is a deliberate resolution — but every item is visible to an
integrator, so plan the upgrade around them.

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
are all still declared in `schema.prisma` and still present after
`migrate deploy`. They are simply never written. Dropping live columns — and an
enum value, which PostgreSQL cannot remove without recreating the type — would
be a destructive migration bought for nothing, and keeping them declared is what
lets `prisma migrate diff` stay clean.

## Environment variables

Every variable read from `process.env` in `src/` is validated at boot by
`src/config/env.validation.ts` (fail-fast). Copy `.env.example` and adjust
at least `DATABASE_URL` and `APISIX_GATEWAY_SECRET`.

| Variable | Required | Default | Effect |
| -------- | -------- | ------- | ------ |
| `NODE_ENV` | no | `development` | Must be `development`, `test`, or `production`. **Set `production` in production** — the fail-closed plan-fee check and docs-off-by-default both key on it |
| `PORT` | no | `3000` | HTTP listen port |
| `DATABASE_URL` | **yes** | — | PostgreSQL connection for Prisma |
| `APISIX_GATEWAY_SECRET` | **yes** | — | Shared secret proving the request came through APISIX. **Minimum 32 characters** — this is the whole boundary between "arrived through the gateway" and "anyone who can reach the pod" |
| `APISIX_GATEWAY_SECRET_HEADER` | no | `x-gateway-secret` | Header name for the gateway secret |
| `APISIX_CONSUMER_HEADER` | no | `x-consumer-username` | Authenticated consumer username |
| `APISIX_CREDENTIAL_HEADER` | no | `x-credential-identifier` | Credential id from key-auth |
| `APISIX_ENVIRONMENT_HEADER` | no | `x-consumer-env` | Key environment (`dev` / `prod`) |
| `APISIX_ROLE_HEADER` | no | `x-consumer-role` | Consumer role forwarded by gateway |
| `APISIX_PERMISSIONS_HEADER` | no | `x-consumer-permissions` | Permission list forwarded by gateway |
| `APISIX_ORGANIZATION_HEADER` | no | `x-consumer-org` | Organization id |
| `APISIX_PLAN_HEADER` | no | `x-consumer-plan` | Organization plan |
| `APISIX_SWAP_FEE_BPS_HEADER` | no | `x-plan-swap-fee-bps` | Plan swap fee (bps) |
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
| `BLINDPAY_API_KEY` | no | — | BlindPay platform API key |
| `BLINDPAY_INSTANCE_ID` | when API key set | — | BlindPay instance id (`in_...`) |
| `BLINDPAY_BASE_URL` | no | `https://api.blindpay.com/v1` | BlindPay API base URL |
| `BLINDPAY_WEBHOOK_SECRET` | when API key set | — | Svix secret for inbound BlindPay webhooks |
| `BLINDPAY_TIMEOUT_MS` | no | `15000` | BlindPay HTTP client timeout (ms) |
| `KYC_REDIRECT_URL_WHITELIST` | no | — | Per-consumer KYC redirect host allow-list |
| `RATE_LIMIT_ENABLED` | no | `true` | Per-address caps on the routes that spend XLM. Incident switch |
| `RATE_LIMIT_PRUNE_INTERVAL_MS` | no | `600000` | Counter-window prune interval (ms, min 1000) |
| `POLLAR_PUBLISHABLE_KEY_TESTNET` / `_MAINNET` | no | — | Pollar publishable key (`pub_<network>_…`), for the OAuth bridge |
| `POLLAR_SECRET_KEY_TESTNET` / `_MAINNET` | with the publishable key | — | Pollar secret key (`sec_<network>_…`), for the operator routes |
| `POLLAR_BRIDGE_CALLBACK_URL` | when a Pollar key is set | — | Public URL Pollar returns the browser to. Must be `<gateway>/v1/pollar/oauth/callback` **and** a host registered under Pollar's Build → Domains |
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

      // ── Authorization inputs. THIS SERVICE TRUSTS THESE COMPLETELY. ──
      // They are not key-auth outputs, so APISIX does not overwrite them for
      // you: whatever the client sends arrives here verbatim unless it is
      // removed below, and only then re-set by the route from the consumer's
      // own metadata. Omitting any one of them is a privilege-escalation bug,
      // not a cosmetic gap:
      //
      //   X-Consumer-Role: admin      → bypasses every scope check
      //                                 (PermissionsGuard treats admin as
      //                                 full access)
      //   X-Consumer-Permissions      → grants arbitrary scopes
      //   X-Consumer-Env: prod        → moves the caller onto Stellar MAINNET
      //   X-Plan-Swap-Fee-Bps: 0      → zero platform commission on every swap
      //                                 and liquidity-pool withdrawal
      //   X-Consumer-Org              → attribution / plan resolution
      //   X-Consumer-Plan             → plan tier, read into GatewayConsumer
      //   X-Cosmos-Internal           → marks the call as coming from the platform
      //                                 console, which is what ADMITS IT TO
      //                                 /v1/admin — every tenant's data, read and
      //                                 write. Leave this one out and any key
      //                                 holder gets there by setting a header.
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

> **The remove list is load-bearing, and it is the one part of this security
> model that cannot be verified from inside this repository.** Every header in
> the block above is an authorization input that the service accepts at face
> value; `X-Gateway-Secret` proves only that the request came through *a*
> gateway, not that the values are honest. Treat that list as production
> configuration with the same review bar as code: audit it whenever a route is
> added or copied, and keep the service on a private network so the only
> reachable path is through APISIX. The shared secret is the second layer, not
> the only one.
>
> The service now fails closed on the one input where silence used to be
> profitable: a missing `X-Plan-Swap-Fee-Bps` in a production configuration is a
> 503 rather than a silent fallback to the environment default.
>
> `X-Cosmos-Internal` carries more weight than it used to: with
> `ADMIN_API_CREDENTIALS` removed, it is what tells this service a request came
> from the platform console rather than from an API key, and therefore what opens
> `/v1/admin`. It is still only reachable by a caller that already presented the
> gateway secret, so the exposure is bounded by that and by network isolation —
> but a route that forgets to strip it turns every API key into a platform
> admin.

> Keep the service on a private network so the only reachable path is through
> APISIX; the shared secret is the second layer, not the only one.

## Keeping this document honest

**The README is part of the change, not a follow-up.** Nothing in CI catches its
drift — the build stays green while these pages quietly describe a service that
no longer exists — so it is updated in the same commit as the code it describes.
The full convention, including which section each kind of change touches, is in
[`CLAUDE.md`](./CLAUDE.md); the short version:

| When you… | Update |
| --------- | ------ |
| add or remove a module under `src/` | [Project layout](#project-layout) |
| add, rename or delete a `process.env` read | [Environment variables](#environment-variables) **and** `.env.example` |
| integrate a provider, or change how one behaves | that provider's own `##` section |
| change a published response shape, status code, or scope | [Upgrading](#upgrading--breaking-changes-and-deploy-notes) |
| add, rename, remove or re-scope a route | [Route index](#route-index), and the module's own section |
| learn something an operator or integrator must not miss | the section it belongs to |

**This document exists in seven languages** — English, Español, Português,
Deutsch, Français, हिन्दी and 简体中文 — and a change to one is a change to all
seven, in the same commit. English is the source and the others are translations
of it: the same headings, tables and code blocks, with identifiers (routes, env
vars, headers, error codes) left exactly as they are. `npm run readme:check` fails
CI when a language file is missing, when its headings stop matching the English,
or when a route in the OpenAPI contract is missing from its route index.

Two things deliberately do **not** live here: **request and response schemas**,
which belong to the generated OpenAPI contract (`npm run openapi:check` keeps it
honest), and **anything the code already states** — this document is for *why* a
thing is the way it is and how to operate it, because a second copy of *what* it
does is just a second copy to keep true.
