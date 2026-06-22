# Cosmos Pay — Payments Microservice

Payments microservice built with **NestJS 11** + **Prisma 6 (PostgreSQL)**.

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
hits directly). Local development can disable enforcement entirely with
`ENFORCE_GATEWAY=false`.

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
  payment-intents/                Stellar payment intents (controller, service, DTO) — emits events
  webhooks/                       webhook endpoints CRUD + dispatcher (HMAC-signed, retried)
  health/                         liveness/readiness probes (@Public)
prisma/schema.prisma              Consumer, PaymentIntent, WebhookEndpoint, WebhookDelivery
test/                             e2e suite proving the gateway gate
```

## API

All routes are versioned under `/v1` (URI versioning).

| Method | Path                          | Description                                  |
| ------ | ----------------------------- | -------------------------------------------- |
| POST   | `/v1/payment-intents/tx`  | Create a SEP-7 `tx` intent (source → XDR + URI + QR) |
| POST   | `/v1/payment-intents/pay` | Create a SEP-7 `pay` intent (no source → URI + QR) |
| GET    | `/v1/payment-intents`     | List the consumer's intents (`?status&take&skip`) |
| GET    | `/v1/payment-intents/:id` | Get one intent by id                         |
| POST   | `/v1/payment-intents/:id/validate` | Validate a submitted tx, finalize status, fire event |
| PATCH  | `/v1/payment-intents/:id` | Update status / txHash / reference           |
| DELETE | `/v1/payment-intents/:id` | Delete an intent                             |
| POST   | `/v1/webhooks`            | Register a webhook endpoint (returns secret) |
| GET    | `/v1/webhooks`            | List the consumer's endpoints                |
| GET    | `/v1/webhooks/:id`        | Get an endpoint                              |
| PATCH  | `/v1/webhooks/:id`        | Update (url/description/enabled/eventTypes)  |
| DELETE | `/v1/webhooks/:id`        | Delete an endpoint                          |
| POST   | `/v1/webhooks/:id/rotate-secret` | Rotate the signing secret           |
| POST   | `/v1/webhooks/:id/ping`   | Send a test event                           |
| GET    | `/v1/webhooks/:id/deliveries` | Delivery audit trail                    |
| POST   | `/v1/webhooks/:id/deliveries/:deliveryId/redeliver` | Re-send a delivery    |
| GET    | `/v1/health/liveness`     | Liveness (public)                            |
| GET    | `/v1/health/readiness`    | Readiness incl. DB (public)                  |

Every intent is **persisted** (`payment_intent` table) and scoped to the
authenticated APISIX consumer, so reads/updates/deletes only ever touch that
consumer's own records — full traceability of each intent's lifecycle
(`PENDING → SUBMITTED → SUCCEEDED/FAILED/CANCELLED/EXPIRED`).

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

### Webhooks (notifying integrators)

Each integrator (APISIX consumer) registers one or more webhook endpoints. When a
payment intent changes, the platform fires a domain event; the **dispatcher**
fans it out to every enabled endpoint of that consumer subscribed to the event
type (empty subscription = all), records each attempt for traceability, and
retries with linear backoff (`WEBHOOK_*` env).

Event types: `PAYMENT_INTENT_CREATED`, `PAYMENT_INTENT_UPDATED`,
`PAYMENT_INTENT_SUCCEEDED`, `PAYMENT_INTENT_FAILED`, `PAYMENT_INTENT_CANCELLED`,
`PAYMENT_INTENT_DELETED`.

Delivery is decoupled via NestJS `EventEmitter2` (`webhook.event`), so emitting a
notification never blocks the API request that triggered it.

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

Live (non-production), served by the app:

- `GET /docs` — Swagger UI
- `GET /docs/json` — OpenAPI 3.0 spec (JSON)
- `GET /docs/yaml` — OpenAPI 3.0 spec (YAML)

Export the spec to files (so another server can host/consume it) — no database
required, runs in Nest preview mode:

```bash
npm run openapi:generate
# writes openapi/openapi.json and openapi/openapi.yaml
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
    "remove": ["Authorization", "apikey", "X-API-KEY"]
  }
}
```

`key-auth` already forwards `X-Consumer-Username` / `X-Credential-Identifier`
to the upstream after a successful auth, which the guard relies on.

> Keep the service on a private network so the only reachable path is through
> APISIX; the shared secret is the second layer, not the only one.
