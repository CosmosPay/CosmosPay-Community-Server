# Cosmos Pay — Payments Microservice

Payments microservice built with **NestJS 11** + **Prisma 7 (PostgreSQL)**.

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
    middleware/apisix-context...  extracts consumer identity from gateway headers
    decorators/                   @Public(), @CurrentConsumer()
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
  products/                       merchant catalogue
  customers/                      payer records derived from intents
  analytics/                      summary, balances, API logs, webhook logs
  admin/                          cross-tenant platform admin (Bearer + role), audited
  health/                         liveness/readiness probes (@Public)
prisma/schema.prisma              Consumer, PaymentIntent, Swap, LiquidityPoolOperation,
                                  WebhookEndpoint/Delivery/EmittedEvent, BlindpayReceiver,
                                  Blockchain/BankAccount/VirtualAccount, BlindpayQuote,
                                  BlindpayWebhookEvent, Payin, Payout, RequestLog, AdminAuditLog
test/                             e2e suite proving the gateway gate
```

## API

All routes are versioned under `/v1` (URI versioning).

**The route list lives in the generated OpenAPI contract, not here.** A
hand-maintained table drifted to 22 of ~80 endpoints and omitted five shipped
modules; the spec is regenerated from the controllers and DTOs on every CI run
(`npm run openapi:check` fails the build if it drifts), so it cannot go stale:

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
| Analytics         | `/v1/summary`, `/v1/balances`, `/v1/logs` | Dashboard aggregates and logs            |
| Admin             | `/v1/admin`              | Cross-tenant reads/writes — Bearer + role, audited        |
| Health            | `/v1/health`             | Liveness / readiness (`@Public`)                          |

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
| `idempotency_conflict` | 409 | This `Idempotency-Key` already produced a resource |
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
and — when the intent has a memo — the tx **memo must match** (`memo_type: id`).

Two paths use that single rule:

- **Manual:** `POST /v1/payment-intents/:id/validate` with `{ "txHash": "<64-hex>" }`.
  On a match the intent is set to `SUCCEEDED` (and `txHash` saved) and a
  `PAYMENT_INTENT_SUCCEEDED` webhook fires; a tx that failed on-chain → `FAILED`;
  a mismatch leaves the status unchanged so a correct tx can still be submitted.
- **Automatic (permanent observer):** `StellarObserverService` polls Horizon
  every `OBSERVER_INTERVAL_MS` for `PENDING` intents — by reported `txHash`, or by
  scanning payments to the destination — and finalizes matches the same way, so
  statuses change and events fire **without anyone calling the API**. Disable for
  local dev with `OBSERVER_ENABLED=false`.

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
with the same memo returns the original intent. If you don't pass `memo`, a
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
or `idempotencyKey` in the body. Retries with the same key for the same consumer
return the **existing** swap (`id` + `txHash`) instead of building another Stellar
transaction. Without a key, the unique `(network, txHash)` constraint still rejects
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

## Upgrading — breaking changes and deploy notes

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

### `APISIX_GATEWAY_SECRET` now requires 32 characters

The service refuses to boot below that. It previously accepted a single
character, while admin credentials already demanded 16 — and this secret is a
stronger boundary than those. Generate one with `openssl rand -hex 32` and
rotate it in APISIX at the same time.

## Environment variables

Every variable read from `process.env` in `src/` is validated at boot by
`src/config/env.validation.ts` (fail-fast). Copy `.env.example` and adjust
at least `DATABASE_URL` and `APISIX_GATEWAY_SECRET`.

| Variable | Required | Default | Effect |
| -------- | -------- | ------- | ------ |
| `NODE_ENV` | no | `development` | Must be `development`, `test`, or `production` |
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
| `ADMIN_API_CREDENTIALS` | no | — | JSON admin bearer secrets (issue #34) |
| `KYC_REDIRECT_URL_WHITELIST` | no | — | Per-consumer KYC redirect host allow-list |

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

Run the tests (no DB needed — Prisma is mocked):

```bash
npm run test:e2e
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
      //   X-Cosmos-Internal           → marks traffic as dashboard-internal
      //   X-Cosmos-Tos-Cooldown-Ms    → relaxes the KYC email resend limit
      "X-Consumer-Role",
      "X-Consumer-Permissions",
      "X-Consumer-Env",
      "X-Plan-Swap-Fee-Bps",
      "X-Consumer-Org",
      "X-Consumer-Plan",
      "X-Cosmos-Internal",
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

> Keep the service on a private network so the only reachable path is through
> APISIX; the shared secret is the second layer, not the only one.
