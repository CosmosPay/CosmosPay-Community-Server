# Cosmos Pay — Zahlungs-Microservice

[English](../../README.md) · [Español](./README.es.md) · [Português](./README.pt.md) · **Deutsch** · [Français](./README.fr.md) · [हिन्दी](./README.hi.md) · [简体中文](./README.zh.md)

Zahlungs-Microservice auf Basis von **NestJS 12** + **Prisma 7 (PostgreSQL)**.

Er ist eine *eigenständige* Anwendung, getrennt von der Cosmos-Entwicklerplattform
(`paydev`). Die Entwicklerplattform ist ein Dashboard: Sie **stellt** API-Keys für
Entwickler **aus** und **zeigt** deren Daten. Sie liegt im Pfad keiner Anfrage, die
ein Client stellt — jeder Aufruf läuft Client → APISIX → dieser Dienst, sodass die
Plattform ausfallen kann, ohne dass eine Wallet oder eine Integration es bemerkt
(siehe [Keine Anfrage hängt von der Entwicklerplattform ab](#keine-anfrage-hängt-von-der-entwicklerplattform-ab)).
Dieser Dienst steht **hinter APISIX**, das jede Anfrage lastverteilt und
authentifiziert, bevor es sie hierher weiterleitet. Er sieht nie rohe API-Keys — er
vertraut ausschließlich dem, was das Gateway weiterleitet.

## Wie „nur APISIX“ durchgesetzt wird

Eine Anfrage wird nur akzeptiert, wenn **beide** Bedingungen erfüllt sind (siehe
`src/common/guards/apisix.guard.ts`):

1. **Gemeinsames Gateway-Secret.** Die Anfrage trägt `X-Gateway-Secret`, das in
   konstanter Zeit mit `APISIX_GATEWAY_SECRET` verglichen wird. APISIX *injiziert*
   diesen Header in jede weitergeleitete Anfrage und *entfernt* jede vom Client
   mitgeschickte Kopie, sodass ein korrekter Wert nur vom Gateway stammen kann.
   (Defense in Depth — kombinieren Sie das mit Netzwerkisolation, damit der Dienst
   nicht direkt erreichbar ist.)
2. **Authentifizierter Consumer.** Das `key-auth`-Plugin von APISIX leitet nach der
   Prüfung des API-Keys des Aufrufers `X-Consumer-Username` (und
   `X-Credential-Identifier`) weiter. Der Guard verlangt, dass der Consumer-Header
   vorhanden ist, was belegt, dass der Key vorgelagert authentifiziert wurde.

Routen können sich mit `@Public()` ausnehmen (verwendet für die Health-Probes, die der
Orchestrator direkt aufruft). Die Durchsetzung ist immer aktiv — es gibt kein Flag zum
Abschalten. Für die lokale Entwicklung betreiben Sie den Dienst hinter APISIX oder
senden `X-Gateway-Secret` + die `X-Consumer-*`-Header selbst.

`/v1/admin` ist mandantenübergreifend, daher verlangt `AdminGuard` zusätzlich
`X-Cosmos-Internal`. APISIX **entfernt** diesen Header aus allem, was es weiterleitet,
sodass ihn nur ein Backend senden kann, das den Dienst direkt mit dem Gateway-Secret
aufruft — die Entwicklerplattform, die entscheidet, ob das angemeldete Konto Owner oder
Admin ist. Es gibt kein separates Admin-Credential: Das Gateway-Secret, die
Netzwerkisolation und die Entfernungsliste für Header in der Gateway-Route schützen die
mandantenübergreifenden Daten.

Die Pipeline:

```
request → ApisixContextMiddleware  (reads consumer headers → req.gatewayConsumer)
        → ApisixGuard (APP_GUARD)  (verifies secret + consumer, or @Public bypass)
        → ValidationPipe           (DTO validation)
        → Controller / Service     (@CurrentConsumer() gives the consumer)
```

## Projektstruktur

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
                                  SEP-7 links, signed-envelope relay, settlement repository
  payment-intents/                payment intents on Stellar, Solana and Monad: controller, service, DTOs,
                                  per-chain link builders and verifiers, the observer — emits events
  chains/                         chain list, per-chain address rules, units, message signatures, JSON-RPC
  solana/                         Solana RPC client (cluster-checked), Solana Pay links
  evm/                            EVM RPC client for Monad (chain-id-checked), EIP-681 links
  swaps/                          Stellar native swaps (path payments): quote, build XDR, submit
                                  + Solana (Jupiter) and Monad (Kuru Flow): venues/, chain swaps, observer
  jupiter/                        Jupiter Swap API client (Solana aggregator)
  kuru/                           Kuru Flow API client (Monad aggregator)
  cross-chain-swaps/              swaps between Stellar, Solana and Monad via NEAR Intents: quote,
                                  deposit address + per-chain wallet link, status observer
  near-intents/                   NEAR Intents 1Click client: tokens, quote, status, deposit submit
  liquidity-pools/                AMM deposit/withdraw, pool + position reads, cost basis + commission on gain
  observer/                       background reconciler: swaps + LP ops against Horizon, one adapter per table
  webhooks/                       webhook endpoints CRUD + dispatcher (HMAC-signed, retried)
  products/                       merchant catalogue
  customers/                      payer records derived from intents
  aliases/                        claimable payment handles: signed claims, resolution, email recovery
  assets/                         curated asset registry: the (code, issuer) pairs vouched for, per network
  public-key/                     GET /v1/public-key: the shared public key, keyless
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
                                  AliasChallenge, AliasRecovery
                                  PluginInstallation, PluginRecord
test/                             e2e suites: gateway gate, admin + alias console gates,
                                  payment intents, swaps, liquidity pools, KYC, webhooks
plugins/                          THE plugins folder: one <slug>/ per plugin (plugin.json, index.ts, signature.json)
scripts/                          OpenAPI generator, README check, operator scripts
contracts/                        PaymentForwarder.sol — Monad deposit addresses (npm run contracts:compile)
deploy/authentik/                 Authentik blueprint: the wallet sign-in and sign-up
docs/i18n/                        this README in es, pt, de, fr, hi, zh
```

## API

Alle Routen sind unter `/v1` versioniert (URI-Versionierung).

Jede Route ist im [Routenindex](#routenindex) unten mit ihrem Scope aufgeführt.
**Request- und Response-Schemas stehen im generierten OpenAPI-Vertrag**, der bei
jedem CI-Lauf aus den Controllern und DTOs neu erzeugt wird
(`npm run openapi:check` lässt den Build fehlschlagen, wenn er abweicht):

- `openapi/openapi.json` / `openapi/openapi.yaml` — eingecheckt, im Diff überprüfbar
- `/docs` — Swagger UI, wenn `SWAGGER_ENABLED=true`
- `/docs/json`, `/docs/yaml` — dieselbe Spezifikation, live ausgeliefert

| Bereich           | Basispfad                | Funktion                                                  |
| ----------------- | ------------------------ | --------------------------------------------------------- |
| Zahlungsabsichten   | `/v1/payment-intents`    | `pay`-Absichten auf Stellar (SEP-7), Solana (Solana Pay) und Monad (EIP-681), SEP-7-`tx`, Validierung, On-Chain-Beobachter |
| Swaps             | `/v1/swaps`              | Path-Payment-Quote, unsigniertes XDR bauen, signiertes übermitteln · Solana über Jupiter, Monad über Kuru Flow |
| Chain-übergreifende Swaps | `/v1/cross-chain-swaps` | Stellar ⇄ Solana ⇄ Monad über NEAR Intents: Quote, Einzahlungsadresse, Status |
| Liquiditätspools  | `/v1/liquidity-pools`    | AMM-Einzahlung / -Auszahlung, Positionen, Provision auf Gewinn |
| Webhooks          | `/v1/webhooks`           | Endpunkt-CRUD, Secret-Rotation, Zustellungen, erneute Zustellung |
| KYC               | `/v1/kyc`                | Receiver (KYC/KYB), Wallets, Bankkonten, Dokument-Upload  |
| Onramp            | `/v1/onramp`             | Payin-Quotes, Payins, virtuelle Konten                    |
| Offramp           | `/v1/offramp`            | Payout-Quotes, Autorisierung, Payouts (vom Client signiert) |
| Produkte          | `/v1/products`           | Händlerkatalog                                            |
| Kunden            | `/v1/customers`          | Aus Intents abgeleitete Zahlerdatensätze                  |
| Aliase            | `/v1/aliases`            | Beanspruchbare Zahlungs-Handles: beanspruchen, auflösen, wiederherstellen |
| Wallet-Anmeldung | `/v1/wallet` | Google / GitHub / E-Mail-Code, und das verschlüsselte Seed-Backup |
| Assets            | `/v1/assets`             | Kuratiertes Asset-Register pro Netzwerk                   |
| Öffentlicher Key  | `/v1/public-key`         | Der gemeinsame öffentliche API-Key, ohne Key ausgeliefert (`@Public`) |
| Analytik          | `/v1/summary`, `/v1/balances`, `/v1/logs` | Dashboard-Aggregate und Logs             |
| Aktivität         | `/v1/activity`           | Vom Client gemeldete Events: Aufnahme, Feed, Zusammenfassung |
| Plugins           | `/v1/plugins`            | Einkompilierte Erweiterungen unter einem Slug, pro Tenant installiert |
| Admin             | `/v1/admin`              | Mandantenübergreifende Lese-/Schreibzugriffe — nur Plattform-Konsole, auditiert |
| Health            | `/v1/health`             | Liveness / Readiness (`@Public`)                          |

### Routenindex

Jede Route, die dieser Dienst bereitstellt. **Scope** ist das, was der API-Key besitzen
muss — *eines von* bedeutet, dass einer der aufgeführten Scopes genügt, und `—` bedeutet
jeden authentifizierten Key. **Öffentlicher Key** markiert die Routen, die der gemeinsame
öffentliche Key aufrufen darf (siehe
[Der gemeinsame öffentliche API-Key](#der-gemeinsame-öffentliche-api-key)). Eine mit
*Plattform-Konsole* markierte Route nimmt überhaupt keinen API-Key an; nur das
Konsolen-Backend erreicht sie. Pfade verwenden die OpenAPI-Form `{param}`.

| Methode | Pfad | Scope | Öffentlicher Key |
| ------- | ---- | ----- | ---------------- |
| GET | `/v1/activity/events` | `activity:read` |  |
| POST | `/v1/activity/events` | `activity:write` | ✓ |
| GET | `/v1/activity/summary` | `activity:read` |  |
| GET | `/v1/admin/audit-logs` | Plattform-Konsole |  |
| GET | `/v1/admin/chain-swaps` | Plattform-Konsole |  |
| GET | `/v1/admin/consumers` | Plattform-Konsole |  |
| GET | `/v1/admin/cross-chain-swaps` | Plattform-Konsole |  |
| GET | `/v1/admin/customers` | Plattform-Konsole |  |
| GET | `/v1/admin/payins` | Plattform-Konsole |  |
| GET | `/v1/admin/payment-intents` | Plattform-Konsole |  |
| GET | `/v1/admin/payouts` | Plattform-Konsole |  |
| GET | `/v1/admin/products` | Plattform-Konsole |  |
| GET | `/v1/admin/receivers` | Plattform-Konsole |  |
| PATCH | `/v1/admin/receivers/{id}/access` | Plattform-Konsole |  |
| POST | `/v1/admin/receivers/{id}/approve` | Plattform-Konsole |  |
| POST | `/v1/admin/receivers/{id}/enable` | Plattform-Konsole |  |
| POST | `/v1/admin/receivers/{id}/tos` | Plattform-Konsole |  |
| GET | `/v1/admin/summary` | Plattform-Konsole |  |
| GET | `/v1/admin/swaps` | Plattform-Konsole |  |
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
| POST | `/v1/blindpay/webhooks` | keiner — `@Public()`, Svix-Signatur |  |
| GET | `/v1/cross-chain-swaps` | `swaps:read` |  |
| POST | `/v1/cross-chain-swaps` | `swaps:write` | ✓ |
| GET | `/v1/cross-chain-swaps/assets` | `swaps:read` | ✓ |
| POST | `/v1/cross-chain-swaps/quote` | `swaps:read` | ✓ |
| GET | `/v1/cross-chain-swaps/{id}` | `swaps:read` |  |
| POST | `/v1/cross-chain-swaps/{id}/deposit` | `swaps:write` | ✓ |
| GET | `/v1/customers` | `customers:read` |  |
| POST | `/v1/customers` | `customers:write` |  |
| GET | `/v1/customers/{id}` | `customers:read` |  |
| PATCH | `/v1/customers/{id}` | `customers:write` |  |
| DELETE | `/v1/customers/{id}` | `customers:write` |  |
| GET | `/v1/health/liveness` | keiner — `@Public()` |  |
| GET | `/v1/health/readiness` | keiner — `@Public()` |  |
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
| GET | `/v1/liquidity-pools` | eines von `liquidity:read`, `swaps:read` | ✓ |
| POST | `/v1/liquidity-pools/deposit` | eines von `liquidity:write`, `swaps:write` | ✓ |
| GET | `/v1/liquidity-pools/operations` | eines von `liquidity:read`, `swaps:read` |  |
| GET | `/v1/liquidity-pools/operations/{id}` | eines von `liquidity:read`, `swaps:read` |  |
| POST | `/v1/liquidity-pools/operations/{id}/submit` | eines von `liquidity:write`, `swaps:write` | ✓ |
| GET | `/v1/liquidity-pools/positions` | eines von `liquidity:read`, `swaps:read` | ✓ |
| POST | `/v1/liquidity-pools/withdraw` | eines von `liquidity:write`, `swaps:write` | ✓ |
| GET | `/v1/liquidity-pools/{poolId}` | eines von `liquidity:read`, `swaps:read` | ✓ |
| GET | `/v1/defindex/vaults` | eines von `liquidity:read`, `swaps:read` | ✓ |
| GET | `/v1/defindex/vaults/{vault}` | eines von `liquidity:read`, `swaps:read` | ✓ |
| GET | `/v1/defindex/vaults/{vault}/balance` | eines von `liquidity:read`, `swaps:read` | ✓ |
| POST | `/v1/defindex/vaults/{vault}/deposit` | eines von `liquidity:write`, `swaps:write` | ✓ |
| POST | `/v1/defindex/vaults/{vault}/withdraw` | eines von `liquidity:write`, `swaps:write` | ✓ |
| POST | `/v1/defindex/submit` | eines von `liquidity:write`, `swaps:write` | ✓ |
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
| GET | `/v1/summary` | `payments:read` |  |
| GET | `/v1/swaps` | `swaps:read` |  |
| POST | `/v1/swaps` | `swaps:write` | ✓ |
| POST | `/v1/swaps/quote` | `swaps:read` | ✓ |
| GET | `/v1/swaps/{id}` | `swaps:read` |  |
| POST | `/v1/swaps/{id}/submit` | `swaps:write` | ✓ |
| GET | `/v1/wallet/auth/providers` | `payments:read` | ✓ |
| POST | `/v1/wallet/auth/oauth/authorize` | `payments:write` | ✓ |
| GET | `/v1/wallet/auth/oauth/callback/{provider}` | none — `@Public()`, a browser redirect |  |
| GET | `/v1/wallet/auth/oauth/session/{state}` | `payments:read` | ✓ |
| POST | `/v1/wallet/auth/oauth/claim` | `payments:write` | ✓ |
| POST | `/v1/wallet/auth/email/start` | `payments:write` | ✓ |
| POST | `/v1/wallet/auth/email/verify` | `payments:write` | ✓ |
| POST | `/v1/wallet/auth/finish` | `payments:write` | ✓ |
| PUT | `/v1/wallet/backup` | `payments:write` | ✓ |
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

### Fehlerantworten

Jeder Fehler liefert denselben Umschlag, und `code` ist der stabile,
maschinenlesbare Teil — verzweigen Sie anhand dieses Werts statt anhand von
`message`, das Fließtext ist und umformuliert werden kann:

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

Der Umschlag und die vollständige `code`-Enum werden in der OpenAPI-Spezifikation als
`ApiErrorBodyEntity` veröffentlicht (Quelle: `ApiErrorCode` in
`src/common/errors/api-error.ts`). Jede Operation dokumentiert nur die Status, die sie
tatsächlich zurückgeben kann, und jeder Status trägt ein Beispiel pro möglichem `code` –
die echte Meldung, mit passendem `statusCode` und `error` –, sodass Swagger UI und ein
Postman-Import den Body zeigen, den Sie wirklich erhalten. **Einmal veröffentlichte
Codes werden nie umbenannt**; neue können hinzukommen, behandeln Sie einen unbekannten
Code daher gemäß seinem HTTP-Status.

Einige, die leicht verwechselt werden:

| Code | Status | Bedeutung |
| ---- | ------ | --------- |
| `insufficient_scope` | 403 | Dem API-Key fehlt der Scope. Stellen Sie den Key neu aus |
| `account_disabled` | 403 | Ein Operator hat dieses Fiat-Konto deaktiviert. Kein Problem des Keys |
| `gateway_required` | 403 | Die Anfrage kam nicht über APISIX |
| `admin_console_only` | 403 | Die Route gehört zur Plattform-Konsole (`/v1/admin`). Kein API-Key kann sie aufrufen |
| `idempotency_conflict` | 409 | Dieser `Idempotency-Key` (oder dieses Payment-Intent-Memo) hat bereits eine Ressource für eine *andere* Anfrage erzeugt. Wiederholen Sie die ursprüngliche Anfrage oder verwenden Sie einen neuen Key |
| `kyc_state_invalid` | 409 | Ein unzulässiger KYC-Zustandsübergang — keine doppelte Anfrage |
| `operation_in_flight` | 409 | Eine kollidierende Operation wird noch abgewickelt |
| `payload_expired` | 409 | Der Body der Zustellung hat die Aufbewahrungsfrist überschritten und kann nicht erneut gesendet werden |
| `provider_unavailable` | 502/503/504 | BlindPay oder Horizon ist nicht erreichbar. Erneut versuchen |
| `misconfigured` | 503 | Ein serverseitiger Konfigurationsfehler. Ein erneuter Versuch hilft nicht |

### Betrieb mit mehr als einem Replikat

APISIX verteilt die Last auf mehrere Instanzen, daher läuft jeder Hintergrund-Timer auf
jedem Replikat. Statusänderungen sind bereits sicher — jede ist ein abgesichertes
`updateMany`-Compare-and-Swap —, doppelte Ticks würden aber die Horizon-Aufrufe gegen
eine API mit Rate Limit vervielfachen. Deshalb nimmt jeder Timer einen
PostgreSQL-**Advisory-Lock auf Transaktionsebene** (`AdvisoryLockService`) und
überspringt seinen Tick, wenn ein anderes Replikat ihn hält:

| Timer                          | Lock-Schlüssel           |
| ------------------------------ | ------------------------ |
| `SettlementObserverService`    | `SettlementObserver`     |
| `PaymentIntentObserverService`       | `PaymentIntentObserver`  |
| `RequestLogRetentionService`   | `RequestLogRetention`    |
| Sweeper für Webhook-Zustellungen | `WebhookDeliverySweeper` |
| `RateLimitPruneService`        | `RateLimitPrune`         |
| `AliasChallengeSweeperService` | `AliasChallengeSweeper`  |

`pg_try_advisory_xact_lock` blockiert nie und wird am Ende der Transaktion freigegeben,
auch bei einem Absturz oder einer abgebrochenen Verbindung. Anders als ein Lock auf
Sitzungsebene funktioniert er auch hinter PgBouncer im Transaction-Pooling-Modus.

Lock-IDs stehen in der Enum `AdvisoryLockKey`. Nummerieren Sie eine bestehende ID nicht
um — während eines Rolling Deploys würden alte und neue Replikate unterschiedliche Locks
nehmen — und verwenden Sie keine ausgemusterte ID wieder.

**Zwei Repliken aus einem Checkout, lokal.** Kopieren Sie `.env` nach `.env.b`
und ändern Sie `PORT` (und `WALLET_AUTH_PUBLIC_BASE_URL`, wenn der Anmelde-Callback
bei dieser Replik ankommen soll — registrieren Sie diese Callback-URL auch beim
OIDC-Provider). Dann startet `npm run dev:replica` sie aus `.env.b` und kompiliert
nach `dist-replica/`, damit sich die beiden `--watch`-Builds nicht überschreiben;
`ENV_FILE=.env.b` wählt die Datei für jedes andere Skript. Gleiche `DATABASE_URL`
und gleiche Secrets: nichts ist prozesslokaler Zustand. Tragen Sie beide im
APISIX-Upstream ein (`COSMOS_API_URL` der Entwicklerplattform, kommagetrennt, dann
dort `npm run sync:route`).

### Zahlungsvalidierung und der On-Chain-Observer

Eine Zahlung wird an genau einer Stelle gegen das Stellar-Netzwerk bestätigt
(`StellarVerifierService`): Die Transaktion muss **erfolgreich** sein, eine **native
(XLM-)Zahlung** an die `destination` des Intents über den **exakten Betrag** enthalten,
— wenn der Intent ein Memo hat — ein **übereinstimmendes Memo** tragen
(`memo_type: id`) und **frühestens eine Minute vor dem Anlegen des Intents**
abgeschlossen worden sein (`TX_CREATED_AT_SKEW_MS`). Diese Altersgrenze verhindert,
dass eine alte On-Chain-Zahlung mit denselben Konditionen einen neuen Intent begleicht.

Zwei Pfade nutzen diese eine Regel:

- **Manuell:** `POST /v1/payment-intents/:id/validate` mit `{ "txHash": "<64-hex>" }`.
  Bei Übereinstimmung wird der Intent auf `SUCCEEDED` gesetzt (und `txHash`
  gespeichert), und ein `PAYMENT_INTENT_SUCCEEDED`-Webhook wird ausgelöst. Eine
  on-chain fehlgeschlagene Transaktion setzt den Intent **nur dann auf `FAILED`, wenn
  sie die eigene Zahlung dieses Intents war** — gleiches Memo, gleiche Zieladresse und
  gleiches Asset. Jede andere Transaktion, ob fehlgeschlagen oder nicht, ist eine
  Nichtübereinstimmung, die den Status unverändert lässt, sodass die korrekte
  Transaktion weiterhin eingereicht werden kann. Ein per
  `PATCH /v1/payment-intents/:id` gemeldeter `txHash` begleicht einen Intent nie
  von sich aus: Er muss ein 64-stelliger Hex-Hash sein, wird kleingeschrieben
  gespeichert und ist nur unter den Intents des aufrufenden Consumers eindeutig
  (`409 idempotency_conflict` bei einer Kollision mit einem anderen davon).
- **Automatisch (permanenter Observer):** `PaymentIntentObserverService` fragt Horizon alle
  `OBSERVER_INTERVAL_MS` nach `PENDING`-Intents ab — über den gemeldeten `txHash` oder
  durch Durchsuchen der Zahlungen an die Zieladresse — und finalisiert Treffer auf
  dieselbe Weise, sodass sich Status ändern und Events ausgelöst werden, **ohne dass
  jemand die API aufruft**. Ein Tick übernimmt höchstens
  `OBSERVER_MAX_INTENTS_PER_CONSUMER` (10) Intents pro Consumer und durchsucht nie einen
  abgelaufenen, sodass ein einzelner Consumer die Abwicklung aller anderen nicht
  verzögern kann. Für die lokale Entwicklung mit `OBSERVER_ENABLED=false` deaktivieren.

**Der Ablauf prüft zuerst die Chain.** Ein Intent, dessen Lebensdauer abgelaufen
ist, wird noch einmal geprüft, bevor er auf `EXPIRED` gesetzt wird: Steht seine
Zahlung on-chain, wird er stattdessen auf `SUCCEEDED` abgewickelt, und ist
Horizon nicht erreichbar, bleibt er für den nächsten Tick liegen. Sitzt der Hash
dieser Zahlung bereits auf einem anderen Intent desselben Consumers, läuft der
Intent ab, statt endlos erneut versucht zu werden. Eine Zahlung, die nach dem
Ablauf bestätigt wird — durch den Observer oder durch `validate` —, bewegt einen
`EXPIRED`-Intent weiterhin nach `SUCCEEDED` und löst `PAYMENT_INTENT_SUCCEEDED`
aus; behandeln Sie `EXPIRED` also nicht als endgültig. Der Scan liest die
Zahlungen an die Zieladresse bis zur Erstellung des Intents zurück, höchstens
1.000 (5 Seiten zu 200); erhält eine Zieladresse während der Lebensdauer eines
Intents mehr als das, rufen Sie `validate` mit dem Hash auf.

### Aufbewahrung der API-Request-Logs

Jede eingehende Anfrage außer `/v1/health` und `/docs` wird von `LoggingInterceptor`
an `request_log` angehängt und speist die Dashboard-Ansicht **API-Logs**
(`GET /v1/logs`). Die Zeilen enthalten Pfad, Status, Dauer und — falls vorhanden —
`ip` / `userAgent` des Zahlers.

Dashboard-Traffic (`X-Cosmos-Internal`) wird **aufgezeichnet und markiert**
(`request_log.internal`), nicht übersprungen, und die API-Log-Ansicht filtert nach
dieser Spalte, sodass kein Request-Header Traffic aus dem Log heraushalten kann.

Die Zeilen werden **nicht dauerhaft aufbewahrt**. `RequestLogRetentionService`
löscht Zeilen, die älter als `REQUEST_LOG_RETENTION_DAYS` (Standard **30**) sind, per
Timer (`REQUEST_LOG_PRUNE_INTERVAL_MS`, Standard **1h**). Jeder Zyklus löscht in kurzen
Blöcken von `REQUEST_LOG_PRUNE_BATCH_SIZE` (Standard **1000**) und läuft weiter, bis
der Rückstand abgebaut oder `REQUEST_LOG_PRUNE_MAX_PER_CYCLE` (Standard **50000**)
erreicht ist, sodass ein großer Bestand aufholen kann, ohne einen langen Tabellen-Lock
zu halten. Setzen Sie `REQUEST_LOG_RETENTION_DAYS=0`, um das Bereinigen ganz zu
deaktivieren (der Dienst protokolliert das beim Start). Der zusammengesetzte Index auf
`(consumer, createdAt)` hält die Dashboard-Abfrage auch bei wachsendem Volumen schnell.

### Client-Aktivität (was Wallet und Dashboard melden)

`request_log` zeichnet nur Anfragen auf, die diesen Dienst erreicht haben. Es sieht
weder eine Wallet, die auf ihrem Senden-Bildschirm abgestürzt ist, noch eine Signatur,
die der Benutzer abgebrochen hat, noch eine Dashboard-Seite, die einen Fehler warf,
bevor sie etwas gesendet hat. Deshalb melden die Clients diese Events selbst an
`POST /v1/activity/events`.

- **Gebündelt.** Clients sammeln Events in einer Warteschlange und senden sie in
  Batches, sodass eine Offline-Wallet sie beim nächsten Start nachliefert. Bis zu
  `ACTIVITY_MAX_BATCH` (100) pro Anfrage.
- **Sicher wiederholbar.** Ein Event kann die eigene `eventId` des Clients tragen;
  `(consumerId, eventId)` ist eindeutig, und Duplikate werden übersprungen. Die Antwort
  meldet `accepted` und `duplicates`.
- **Zuordnung durch das Gateway.** Zeilen werden unter dem Consumer geschrieben, den
  APISIX authentifiziert hat; im Body gibt es dafür kein Feld.
- **Tolerant gegenüber fehlerhaften Payloads.** Eine überlange `message` wird gekürzt,
  und ein übergroßes `props` wird durch `{"_dropped": "props_too_large"}` ersetzt, statt
  den ganzen Batch abzuweisen.
- **Begrenzte Zeitstempel.** `occurredAt` wird durch den Empfangszeitpunkt ersetzt, wenn
  es mehr als fünf Minuten in der Zukunft oder mehr als sieben Tage in der Vergangenheit
  liegt. Beide Zeiten werden gespeichert: `at` (die des Clients) und `receivedAt`.

Auslesen:

| Route                   | Scope             | Liefert                                                              |
| ----------------------- | ----------------- | -------------------------------------------------------------------- |
| `GET /v1/activity/events` | `activity:read` | Den Feed, neueste zuerst. Filter: `source`, `level`, `category`, `type` (Präfix), `network`, `since`/`until` |
| `GET /v1/activity/summary` | `activity:read` | Anzahlen pro Level/Quelle/Kategorie, häufigste Event-Typen, häufigste Fehler, Sitzungen, Geräte, eine Tagesreihe |

`level` ist im Feed eine **Mindeststufe**, keine exakte Übereinstimmung: `level=warn`
liefert Warnungen *und* Fehler.

`activity_event` enthält eine IP, einen User-Agent und alles, was der Client angehängt
hat, und wird daher vom selben Job und in denselben begrenzten Batches bereinigt wie
`request_log` — `ACTIVITY_RETENTION_DAYS`, Standard **30**, `0`, um Events dauerhaft
aufzubewahren.

### Webhooks (Benachrichtigung der Integratoren)

Jeder Integrator (APISIX-Consumer) registriert einen oder mehrere Webhook-Endpunkte.
Wenn sich ein Payment Intent ändert, löst die Plattform ein Domain-Event aus; der
**Dispatcher** verteilt es an jeden aktivierten Endpunkt dieses Consumers, der den
Event-Typ abonniert hat (leeres Abonnement = alle), zeichnet jeden Versuch zur
Nachvollziehbarkeit auf und wiederholt mit linearem Backoff (`WEBHOOK_*`-Umgebungsvariablen).

Event-Typen: `PAYMENT_INTENT_CREATED`, `PAYMENT_INTENT_UPDATED`,
`PAYMENT_INTENT_SUCCEEDED`, `PAYMENT_INTENT_FAILED`, `PAYMENT_INTENT_CANCELLED`,
`PAYMENT_INTENT_DELETED`, `SWAP_CREATED`, `SWAP_SUBMITTED`, `SWAP_SUCCEEDED`,
`SWAP_FAILED`, `LIQUIDITY_CREATED`, `LIQUIDITY_SUBMITTED`, `LIQUIDITY_SUCCEEDED`,
`LIQUIDITY_FAILED`, `CROSS_CHAIN_SWAP_CREATED`, `CROSS_CHAIN_SWAP_UPDATED`, `CROSS_CHAIN_SWAP_SUCCEEDED`, `CROSS_CHAIN_SWAP_REFUNDED`, `CROSS_CHAIN_SWAP_FAILED`, `CROSS_CHAIN_SWAP_EXPIRED` sowie die aus BlindPay stammenden `RECEIVER_UPDATED`,
`PAYIN_CREATED`, `PAYIN_UPDATED`, `PAYIN_COMPLETED`, `PAYOUT_CREATED`, `PAYOUT_UPDATED`
und `PAYOUT_COMPLETED`. Die maßgebliche Liste ist die Enum `WebhookEventType` in
`prisma/schema.prisma`.

**Aus BlindPay stammende Bodies.** `RECEIVER_UPDATED` / `PAYIN_*` / `PAYOUT_*` tragen
nur Identität und Zustand — IDs, Status, Beträge, Rails — nie personenbezogene Daten.
Das Provider-Objekt wird nicht weitergeleitet, weil ein Receiver-Payload ein
vollständiges KYC-Dossier ist und für ein Abonnement nur `webhooks:write` nötig ist.
Rufen Sie die Details über die API mit einem Key ab, der `kyc:read` / `onramp:read` /
`offramp:read` besitzt. Die Feld-Allowlist steht in
`src/native-plugins/blindpay/blindpay-event-redaction.ts`.

Die Zustellung ist über NestJS `EventEmitter2` (`webhook.event`) entkoppelt, sodass das
Auslösen einer Benachrichtigung die API-Anfrage, die sie verursacht hat, nie blockiert.

**Richtlinie für ausgehende Ziele (SSRF):** Endpunkte müssen `https` verwenden und
dürfen nur auf öffentliche Adressen auflösen. Die Registrierung lehnt Loopback, private
RFC1918-Bereiche, Link-Local (`169.254.0.0/16`, einschließlich Cloud-Metadaten
`169.254.169.254`) und bekannte Metadaten-Hostnamen ab. **Jede host-abhängige Ablehnung
gibt dieselbe Antwort** — „der Host ist kein erlaubtes Ziel“ — und der Grund geht
stattdessen ins Log: „löst hier nicht auf“ von „löst auf `10.0.4.7` auf“ und von „löst
auf den Metadatendienst auf“ zu unterscheiden, ließe jeden, der einen Endpunkt
registrieren kann, das Netz kartieren, in dem dieser Dienst läuft — eine URL nach der
anderen. Eine fehlerhafte URL, ein falsches Schema, Zugangsdaten oder ein fehlender
Host sagen weiterhin genau, was falsch ist: Sie beschreiben die gesendete
Zeichenkette, nicht das Netz. Dieselbe Prüfung läuft
unmittelbar vor jeder Zustellung erneut (DNS kann sich nach der Registrierung ändern).
Der HTTP-Client verwendet `redirect: manual` (folgt nie `3xx`), Verbindungs- und
Lese-Timeouts aus der Umgebung und eine maximale Größe des Response-Bodys.

| Variable | Standard | Bedeutung |
| -------- | -------- | --------- |
| `WEBHOOK_CONNECT_TIMEOUT_MS` | `3000` | Budget für den Verbindungsaufbau (Teil des AbortSignal-Timeouts) |
| `WEBHOOK_READ_TIMEOUT_MS` | `5000` | Budget für das Lesen (Teil des AbortSignal-Timeouts) |
| `WEBHOOK_MAX_RESPONSE_BYTES` | `65536` | Obergrenze für den ausgelesenen Response-Body |
| `WEBHOOK_TIMEOUT_MS` | `5000` | Veralteter Fallback, falls die getrennten Timeouts nicht gesetzt sind |
| `WEBHOOK_MAX_ATTEMPTS` / `WEBHOOK_BACKOFF_MS` | `3` / `2000` | In-Process-Retry-Schleife, pro Zustellversuch |
| `WEBHOOK_SWEEP_ENABLED` | `true` | Stellt Zustellungen wieder her, die durch einen Absturz liegen geblieben sind. Der Notfallschalter — auf `false` setzen, um die erneute Zustellung an einen Integrator zu stoppen, dessen System gerade zusammenbricht |
| `WEBHOOK_SWEEP_INTERVAL_MS` | `60000` | Wie oft ein Replikat einen Sweep versucht (nur eines gewinnt pro Tick) |
| `WEBHOOK_PAYLOAD_RETENTION_DAYS` | `30` | Danach wird der gespeicherte Body einer abgeschlossenen Zustellung durch eine Schwärzungsmarkierung ersetzt. `0` bewahrt Bodies dauerhaft auf |

**Eine Zustellung kann bis zu neunmal versucht werden, nicht dreimal.**
`WEBHOOK_MAX_ATTEMPTS` begrenzt eine In-Process-Retry-Schleife. Der Sweeper übernimmt
anschließend Zustellungen, die noch unter `WEBHOOK_MAX_ATTEMPTS × 3` Versuchen insgesamt
liegen, verteilt über Stunden, sodass eine durch einen Pod-Neustart unterbrochene
Zustellung nicht verloren geht.

**Die erneute Zustellung funktioniert nur innerhalb der Aufbewahrungsfrist.** Nach
`WEBHOOK_PAYLOAD_RETENTION_DAYS` wird der gespeicherte Body geleert (das
Zustellprotokoll bleibt erhalten). Der Sweeper überspringt diese Zeilen, und
`POST /v1/webhooks/:id/deliveries/:id/redeliver` liefert `409 payload_expired`.

**Webhooks empfangen.** Jeder `2xx` gilt als Bestätigung. Antworten Sie innerhalb von
`WEBHOOK_READ_TIMEOUT_MS` (standardmäßig 5s). Die Reihenfolge ist nicht garantiert,
gleichen Sie daher gegen die API ab. Deduplizieren Sie anhand der Event-`id`; eine
erneute Zustellung verwendet die ursprüngliche `id` wieder (At-least-once-Zustellung).

**Migration bestehender Endpunkte:** Führen Sie nach dem Deployment aus:

```bash
npm run webhooks:audit-destinations
```

Unsichere Zeilen erhalten `destinationBlocked=true` und `enabled=false`. Integratoren
korrigieren die URL mit `PATCH /v1/webhooks/:id` `{ "url": "https://…" }` (die
Validierung läuft erneut und entfernt die Markierung) oder aktivieren den Endpunkt
wieder, sobald das DNS öffentlich ist.

**Payload** (POST-Body an die URL des Integrators):

```jsonc
{
  "id": "evt_...",                 // stable event id (use for idempotency)
  "type": "PAYMENT_INTENT_SUCCEEDED",
  "createdAt": "2026-...",
  "data": { /* the payment intent */ }
}
```

**Header**:

- `X-Cosmos-Signature: t=<unixSeconds>,v1=<hexHmacSha256>` — HMAC-SHA256 von
  `${t}.${rawBody}` mit dem `whsec_...`-Secret des Endpunkts.
- `X-Cosmos-Event`, `X-Cosmos-Event-Id`, `X-Cosmos-Delivery`.

**Prüfen der Signatur (auf Seite des Integrators):**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody: string, header: string, secret: string): boolean {
  const [t, v1] = header.split(',').map((p) => p.split('=')[1]);
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
```

Das Signatur-Secret wird **einmalig** bei `POST /webhooks` (und bei `rotate-secret`)
zurückgegeben; List- und Get-Antworten enthalten es nie. Jeder Versuch wird mit Status,
Anzahl der Versuche, Response-Code und Fehler gespeichert (`webhook_delivery`) —
abfragbar über `GET /webhooks/:id/deliveries` und erneut sendbar über die
`redeliver`-Route.

List, Get und Update liefern genau die dokumentierten Endpunktfelder, und Create
und `rotate-secret` ergänzen `secret`. Sonst verlässt nichts von der Zeile den
Dienst — weder `consumerId` noch die Spalten `previousSecret` /
`previousSecretExpiresAt`, die eine frühere Rotation mit Übergangsfenster
geschrieben hat.

**`ping` und `redeliver` sind rate-limitiert**, pro Consumer und Client-Adresse:
`POST /v1/webhooks/:id/ping` 20 und
`POST /v1/webhooks/:id/deliveries/:deliveryId/redeliver` 30 pro 10 Minuten
(`429 rate_limited`). Beide lassen diesen Dienst signierte Anfragen an eine von
Ihnen gewählte URL senden, und `redeliver` durchläuft die gesamte
Wiederholungsschleife innerhalb der Anfrage. Bei einem großen Rückstand lassen
Sie den Sweeper erneut versuchen, statt einzeln erneut zuzustellen.

### OpenAPI / Swagger

**Sicherheitshinweis:** `GET /docs`, `/docs/json` und `/docs/yaml` werden als
**Express-Middleware** eingehängt, nicht als Nest-Controller, und laufen daher **nicht**
durch `ApisixGuard` oder `PermissionsGuard` — jeder, der den Port des Dienstes erreicht,
kann die Spezifikation abrufen. In Produktion sind die Docs **standardmäßig aus**
(`NODE_ENV=production` und kein `SWAGGER_ENABLED`). Setzen Sie `SWAGGER_ENABLED=true`
nur in einem vertrauenswürdigen Netzwerk.

Exportieren Sie die Spezifikation in Dateien — dafür sind weder eine Datenbank noch ein
echtes Gateway-Secret nötig:

```bash
npm run openapi:generate
# writes openapi/openapi.json and openapi/openapi.yaml
```

CI erzeugt beide eingecheckten Dateien neu und weist Abweichungen zurück. Führen Sie
dieselbe Prüfung aus, bevor Sie eine Änderung an einem Controller oder DTO committen:

```bash
npm run openapi:check
```

Pfade in der Spezifikation enthalten bereits die Version (`/v1/...`). Um einen
Gateway-Host in den `servers` der Spezifikation festzulegen, setzen Sie
`OPENAPI_SERVER_URL` vor dem Generieren:

```bash
OPENAPI_SERVER_URL=https://gateway.example.com npm run openapi:generate
```

**Verwendung mit Postman.** Importieren Sie `openapi/openapi.json` oder
`http://localhost:3000/docs/json` von einem laufenden Dienst. Die Spezifikation bietet
zwei Server und zwei Security-Anforderungen; Werkzeuge, die nur eine auswählen, nehmen
jeweils die erste:

| Aufruf | Server | Authentifizierung |
| ------ | ------ | ----------------- |
| Direkt an diesen Dienst (lokale Entwicklung) | `http://localhost:{port}` (`port` standardmäßig `3000`) | `X-Gateway-Secret` **und** `X-Consumer-Username`, zusammen |
| Über das APISIX-Gateway | `OPENAPI_SERVER_URL`, zuerst gelistet, wenn gesetzt | `Authorization: Bearer <api key>` |

Die eingecheckte Spezifikation wird ohne `OPENAPI_SERVER_URL` erzeugt und verwendet
daher standardmäßig das direkte Header-Paar; mit gesetzter Variable erzeugt, ergibt sie
eine Collection, die standardmäßig das Gateway verwendet. Postman speichert pro Request
nur einen API-Key: Setzt der Import nur `X-Gateway-Secret`, fügen Sie
`X-Consumer-Username` als Collection-Header hinzu. Die Health-Probes werden mit
`security: []` veröffentlicht.

Jede Operation trägt Vendor-Extensions, die sagen, was sie ist: `x-cosmos-rate-limit`
(ihre Budgets – sie kann `429` antworten), `x-cosmos-upstream` (der aufgerufene
Anbieter – sie kann `502`/`503`/`504` antworten), `x-cosmos-public` und
`x-cosmos-public-key`.

`npm run openapi:generate` verweigert das Schreiben einer Spezifikation, in der eine
Operation keine Summary hat, ein Fehler weder Body noch Beispiel hat, der `statusCode`
eines Beispiels nicht zum dokumentierten Status passt oder ein `429` an einer Route ohne
Budget steht. Lesen Sie bei jeder neuen oder geänderten Route deren neu erzeugte
Operation – siehe `CLAUDE.md`.

### Intents anlegen — zwei SEP-7-Operationen, zwei Endpunkte

Gemäß [SEP-7](https://stellar.org/protocol/sep-7) nehmen die Operationen `tx` und
`pay` **unterschiedliche Parameter** entgegen und erzeugen **unterschiedliche
Antworten**, daher hat jede ihren eigenen Endpunkt, ihr eigenes DTO und ihr eigenes
Response-Schema. Der Dienst hält keine Schlüssel — er stellt lediglich die Anfrage für
die Wallet des Clients zusammen (liefert `uri` + `qr`, bei `tx` zusätzlich `xdr`). Das
Asset ist standardmäßig **natives XLM**, wenn `assetCode` fehlt (oder
`XLM`/`native` ist); jedes andere Asset erfordert `assetIssuer`.

**Das Netzwerk wird durch den Typ des API-Keys bestimmt**, den das Gateway weiterleitet:
ein `prod`-Key → public (Mainnet), ein `dev`-Key → Testnet. `STELLAR_NETWORK` ist nur
ein Fallback für die lokale Entwicklung ohne Gateway. Jeder Intent speichert sein
eigenes Netzwerk, und alle Horizon-Aufrufe (Build, Validierung, Observer) zielen darauf.
Jeder Intent wird gespeichert (Tabelle `payment_intent`) und dem aufrufenden Consumer
zugeordnet: `PENDING → SUBMITTED → SUCCEEDED/FAILED/CANCELLED/EXPIRED`. Der einzige
Ausweg aus einem Endzustand ist `EXPIRED → SUCCEEDED`, bei einer on-chain
bestätigten Zahlung.

**Das Memo ist ein verpflichtendes `MEMO_ID`** — es identifiziert die Zahlung on-chain
und macht das Anlegen **idempotent**: `(consumer, memo)` ist eindeutig, sodass ein
erneutes Anlegen mit demselben Memo **und denselben Konditionen** den ursprünglichen
Intent zurückgibt. Dasselbe Memo mit irgendeiner abweichenden Kondition — Art,
Netzwerk, Zieladresse, Betrag, Asset, `msg`, `callback` oder bei `tx` die `source` —
ergibt `409 idempotency_conflict`, und der Fehler verrät nichts über den gespeicherten
Intent. Das ist beim gemeinsamen öffentlichen Key wichtig, bei dem jede anonyme Wallet
derselbe Consumer ist. Beide Bauer teilen sich ein Budget von **30 Aufrufen pro
Minute** pro Consumer und Client-Adresse (`429 rate_limited`): Jeder liest das Konto
des Zahlers von Horizon und schreibt eine Zeile, und unter dem gemeinsamen
öffentlichen Key ist die Adresse das Einzige, was eine anonyme Wallet von der nächsten
trennt. Wenn Sie kein `memo` übergeben, wird ein zufälliges uint64 erzeugt.

**`POST /v1/payment-intents/tx`** — der Zahler (`source`) ist bekannt, daher bauen wir
das unsignierte `TransactionEnvelope` und eine `web+stellar:tx?xdr=...`-URI.

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

**`POST /v1/payment-intents/pay`** — keine Quelle, daher liefern wir nur eine
`web+stellar:pay?destination=...`-URI (die Wallet wählt Quell-Asset und Pfad).

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

Beispielantwort für `tx`:

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

Netzwerk, Horizon, Gebühr und Timeout werden über die `STELLAR_*`-Umgebungsvariablen
konfiguriert (siehe `.env.example`). Aus Sicherheitsgründen ist **Testnet** der
Standard — setzen Sie `STELLAR_NETWORK=public` für Mainnet (echte Gelder).

### Zahlungsabsichten auf Solana und Monad

`POST /v1/payment-intents/pay` nimmt ein optionales `chain` an: `stellar`
(Standard), `solana` oder `monad`. Eine Anfrage ohne das Feld ist genau die
Stellar-Anfrage von oben. Die Netzwerkstufe bleibt die des API-Schlüssels — ein
`prod`-Schlüssel erreicht Solana mainnet-beta und Monad mainnet (Chain-ID 143), ein
`dev`-Schlüssel Solana devnet und Monad testnet (10143) — und `network` wird auf
jeder Chain als `public` / `testnet` gespeichert. `POST /v1/payment-intents/tx`
bleibt Stellar-only: ein SEP-7-`tx` ist ein Stellar-Envelope.

| | Stellar | Solana | Monad |
| --- | --- | --- | --- |
| Link (`uri`) | SEP-7 `web+stellar:pay` | Solana Pay `solana:<recipient>?…` | EIP-681 `ethereum:<payee>@143?…` |
| Münze (ohne `assetCode`) | XLM | SOL | MON |
| Token (`assetCode` + `assetIssuer`) | Emittentenkonto | SPL-Mint | ERC-20-Vertrag |
| Wie die Zahlung gefunden wird | `MEMO_ID` | ein neuer `reference`-Schlüssel je Absicht (`chainReference`) | die eigene Einzahlungsadresse der Absicht (mit Relayer); sonst Ziel + exakter Betrag |
| Beobachter | Zahlungen an das Ziel | die Signaturen des Referenzschlüssels | das Guthaben der Einzahlungsadresse, natives MON eingeschlossen (mit Relayer); sonst die `Transfer`-Logs des Tokens |
| `amount` | optional | optional | optional mit Relayer, sonst Pflicht |
| `msg` / `callback` | beide | `msg` (Solana-Pay-`message`) | keines |
| `txHash` für `validate` / `PATCH` | 64 Hex | Base58-Signatur | `0x` + 64 Hex |

- **Das Memo bleibt der Idempotenzschlüssel**, und `chain` gehört zu den
  Bedingungen, die eine Wiederholung erfüllen muss: Memo `42` auf Stellar und Memo
  `42` auf Solana sind verschiedene Zahlungen (`409 idempotency_conflict`). Auf
  Solana schreibt das SPL-Memo-Programm das Memo zusätzlich on-chain.
- **Ein Token wird gegen die Chain aufgelöst, bevor die Absicht gespeichert
  wird** — die Dezimalstellen eines SPL-Mints (Token- oder Token-2022-Programm), das
  `decimals()` eines ERC-20. Eine Adresse, die keiner ist, ergibt
  `400 validation_failed`; ein Betrag mit mehr Dezimalstellen, als der Token hat,
  `400 invalid_amount`.
- **Eine Monad-Zahlung trägt kein Memo.** EIP-681 hat kein Feld, das eine Wallet
  mit der ID der Absicht füllt, also wird eine Monad-Absicht an dem erkannt, was sie
  zahlt: Ziel, Token und exakter Betrag, im Erstellungsblock oder danach. Geben Sie
  gleichzeitigen Absichten an dasselbe Ziel **unterschiedliche Beträge**. Eine
  Zahlung in **nativem MON** erzeugt kein Log, also kann der Beobachter sie nicht
  finden: schließen Sie sie mit `POST /v1/payment-intents/{id}/validate` und dem
  Transaktions-Hash ab. ERC-20-Zahlungen findet der Beobachter,
  `MONAD_LOG_BLOCK_RANGE` Blöcke pro Aufruf und fünf Aufrufe je Absicht und Durchlauf,
  und setzt dort fort, wo er aufgehört hat (`chainCursor`).
- **Einzahlungsadressen (mit `MONAD_RELAYER_PRIVATE_KEY`).** Jede Monad-Absicht
  erhält eine eigene Adresse, und der Link zahlt an sie statt an den Händler: eine
  `CREATE2`-Adresse von `contracts/PaymentForwarder.sol` über den deterministischen
  Deployment-Proxy (`0x4e59…956c`, auf Monad mainnet und testnet vorhanden), dessen
  Init-Code Händler, Asset, Relayer und dessen Gebühr festschreibt. Die Adresse ist
  die Zusage — niemand, auch dieser Dienst nicht, kann dort Code deployen, der an
  jemand anderen zahlt —, daher hält der Dienst keinen Schlüssel zum Geld. Der
  Einzahlungs-Weiterleiter beobachtet das Guthaben der Adresse (natives MON
  eingeschlossen, ohne Logs); sobald es die Absicht deckt (bei offenem Betrag jeder
  Betrag über der Gebühr), deployt der Relayer den Weiterleiter, dessen Konstruktor
  dem Relayer seine Gebühr und den Rest dem Händler zahlt, und die Absicht wird mit
  dieser Transaktion abgeschlossen. Die Gebühr wird beim Erstellen der Absicht
  festgelegt und als `networkFee` angezeigt: für MON das Gas-Budget der
  Weiterleitung zum aktuellen Preis plus 25 %; für einen Token der Eintrag des
  Betreibers in `MONAD_DEPOSIT_TOKEN_FEES` oder nichts (der Relayer trägt das Gas).
  Ein Betrag, den die Gebühr aufzehren würde, ergibt `400 invalid_amount`. Was nach
  Ablauf oder Stornierung einer Absicht ankommt, wird trotzdem an den Händler
  weitergeleitet, und der Zahler kann mit `validate` und seinem eigenen Hash früher
  abschließen. Der Relayer-Schlüssel hält nur Gas-Geld: sparsam aufladen und den
  Kontostand überwachen. Der Bytecode ist eingecheckt
  (`src/evm/payment-forwarder.artifact.ts`), und ein Spec kompiliert den Quelltext
  dagegen neu; jede Einzahlungsadresse hängt von ihm ab, also nie ändern, solange
  alte Adressen noch Geld erhalten können.
- **Ein RPC-Knoten wird geprüft, bevor ihm vertraut wird**: vor seinem ersten Lesen
  einer Stufe vergleicht der Dienst den Genesis-Hash (Solana) bzw. `eth_chainId`
  (Monad) des Knotens mit dem der Chain und antwortet mit `503 misconfigured`, wenn
  eine Mainnet-URL auf ein Testnetz zeigt. Die öffentlichen RPCs sind der Standard
  und stark ratenbegrenzt — setzen Sie in Produktion `SOLANA_RPC_URL_MAINNET` und
  `MONAD_RPC_URL_MAINNET` auf die Endpunkte eines Anbieters.
- **Swaps, Liquiditätspools und DeFindex bleiben Stellar-only.**

```jsonc
// POST /v1/payment-intents/pay — USDC auf Solana
{ "chain": "solana", "destination": "<base58>", "amount": "25.5",
  "assetCode": "USDC", "assetIssuer": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }
// response → { chain: "solana", uri: "solana:<base58>?amount=25.5&spl-token=…&reference=…&memo=…", chainReference, qr, … }
```

### Wallet-Anmeldung auf Solana und Monad

`POST /v1/wallet/auth/finish` und `PUT /v1/wallet/backup` nehmen ein optionales
`chain` und das Konto als `address` an; `stellarAddress` wird für Stellar weiterhin
akzeptiert und weiterhin neben `chain` und `address` zurückgegeben. Die
Herausforderung, die ein Solana- oder Monad-Konto signiert, hat nach der ersten
Zeile eine Zeile `chain: <chain>` — ein ed25519-Schlüssel ist zugleich Stellar- und
Solana-Adresse, und die Zeile verhindert, dass eine Signatur für das eine das andere
öffnet —, während die Stellar-Herausforderungen byte-genau unverändert bleiben.
Solana signiert die UTF-8-Bytes mit ed25519 (`signMessage`; Base64 oder Base58),
Monad mit EIP-191 `personal_sign` (0x-Hex; High-s-Signaturen werden abgelehnt). Eine
Monad-Adresse wird in ihrer EIP-55-Schreibweise gespeichert. Die
Wiederherstellungseinrichtung (`POST /v1/wallet/recovery/setup`) bleibt
Stellar-only. Die Keys des Kontos werden auf jeder Chain gleich ausgestellt (siehe
[Keine Anfrage hängt von der Entwicklerplattform ab](#keine-anfrage-hängt-von-der-entwicklerplattform-ab)).

## Der gemeinsame öffentliche API-Key

Die Open-Source-Wallet liefert einen API-Key mit, den sich alle teilen, sodass jeder
swappen, Liquidität bereitstellen oder einen Zahlungslink erstellen kann, ohne sich zu
registrieren. Diese Aufrufe zahlen die Provision des `community`-Plans (150 bps, der
höchste Satz); mit einer Registrierung gibt es einen niedrigeren. Das Gateway injiziert
den Satz genau wie bei einem privaten Key (siehe `resolvePlanCommissionBps`).

Der Unterschied liegt in der Mandantentrennung. Jeder anonyme Aufrufer kommt als
derselbe APISIX-Consumer an, und Lese-Endpunkte filtern Zeilen nach Consumer:

```ts
// swaps.service.ts
where: { id, consumer: { apisixUsername: consumer.username } }
```

`GET /v1/swaps` unter dem öffentlichen Key würde also die Swap-Historie aller anonymen
Benutzer liefern. Scopes können das nicht verhindern, weil alle denselben Key besitzen —
und `POST /v1/swaps/quote` braucht `swaps:read`, denselben Scope, mit dem die Historie
aufgelistet wird.

**`PublicKeyGuard` ist eine Allowlist.** Der öffentliche Consumer wird auf jeder Route
abgewiesen, die nicht `@AllowPublicKey()` trägt, sodass neue Routen für ihn
standardmäßig gesperrt sind.

Heute mit dem öffentlichen Key erreichbar:

| Route | Warum sie sicher ist |
| --- | --- |
| `POST /v1/swaps/quote` | Bepreist einen Pfad über Horizon; eine reine Funktion der Anfrage |
| `POST /v1/swaps` | Baut einen unsignierten Envelope, den der Aufrufer signiert |
| `POST /v1/swaps/:id/submit` | Sendet einen vom Aufrufer signierten Envelope — nichts zum Swap, nicht einmal sein Status, wird beantwortet, bevor der Body der Envelope dieses Swaps mit einer Signatur ist; rate-limitiert |
| `GET /v1/cross-chain-swaps/assets` \| `POST /v1/cross-chain-swaps/quote` | Die Token-Liste von NEAR Intents und ein Trocken-Quote; reine Funktionen des Requests |
| `POST /v1/cross-chain-swaps` | Eine Einzahlungsadresse für das eigene Geld des Aufrufers; ein wiederholter `Idempotency-Key` wird nur beantwortet, wenn der Request übereinstimmt |
| `POST /v1/cross-chain-swaps/:id/deposit` | Verweist NEAR Intents auf eine Transaktion, die es selbst on-chain prüft; rate-limitiert |
| `POST /v1/liquidity-pools/deposit` \| `withdraw` | Bauen unsignierte Envelopes |
| `POST /v1/liquidity-pools/operations/:id/submit` | Sendet einen vom Aufrufer signierten Envelope, unter denselben Prüfungen wie beim Swap-Submit; rate-limitiert |
| `GET /v1/liquidity-pools` \| `/:poolId` \| `/positions` | Öffentliche On-Chain-Daten, gelesen von Horizon |
| `POST /v1/payment-intents/tx` \| `pay` | Bauen einen SEP-7-Intent aus der Anfrage |
| `POST /v1/activity/events` | Telemetrie-Aufnahme — siehe unten |
| `GET /v1/assets` | Der öffentliche Asset-Katalog |
| `GET /v1/aliases/resolve/:name` \| `availability/:name` \| `by-address/:address` | Ein Zahler, der ein Handle auflöst, ist genau der anonyme Aufrufer, für den dieser Key existiert; die Antwort ist eine reine Funktion der Anfrage und enthält nie das Postfach des Inhabers |

Abgewiesen: `GET /v1/swaps`, `GET /v1/swaps/:id`, `GET /v1/cross-chain-swaps`, `GET /v1/cross-chain-swaps/:id`,
`GET /v1/liquidity-pools/operations{,/:id}`, `GET /v1/activity/events`,
`GET /v1/activity/summary`, jeder Lesezugriff auf Payment Intents, jede Inhaber-Route
für Aliase (Beanspruchen, Auflisten, Hinzufügen oder Entfernen einer Adresse, Freigeben,
Wiederherstellung) sowie alles unter `/v1/kyc`, `/v1/onramp`, `/v1/offramp` und
`/v1/webhooks`. Eine Wallet ohne Konto liest ihre Historie stattdessen aus Horizon.

**Telemetrie ist erlaubt**, damit Absturzberichte von Wallets ohne Konto trotzdem
ankommen. Events über diesen Key sind anonym (ein gemeinsamer Consumer), daher entfernt
die Wallet Adresse, Ziel, Betrag und txHash vor dem Senden.

Der Guard erkennt den öffentlichen Consumer **entweder** an der weitergeleiteten Rolle
(`X-Consumer-Role: public`) **oder** am Benutzernamen `APISIX_PUBLIC_CONSUMER`. Setzen
Sie beides: Leitet das Gateway keine Rollen mehr weiter, passt immer noch der
Benutzername, und ohne den Benutzernamen hängt der Guard allein von einem Header ab.

**Woher eine Wallet ihn bekommt.** `GET /v1/public-key?env=dev|prod` antwortet
`{ env, apiKey }` ohne Key und ohne Gateway-Secret (`@Public()`), aus
`PUBLIC_API_KEY_DEV` / `PUBLIC_API_KEY_PROD`; eine Umgebung ohne Key antwortet
`503 misconfigured`. Den Key zu rotieren heißt, diese Variablen zu ändern — jede
Wallet übernimmt den neuen innerhalb des 5-Minuten-Caches. Die APISIX-Route für
diesen Pfad darf KEIN `key-auth` ausführen (der Aufrufer hat noch keinen Key):
liefern Sie ihn über die schlüssellose Route aus, wie
`/v1/wallet/auth/oauth/callback/*`.

## Keine Anfrage hängt von der Entwicklerplattform ab

Die Entwicklerplattform erstellt API-Keys für Entwickler und zeigt Daten an. Nichts,
was ein Client tut, läuft über sie: Die Wallet und jede Integration sprechen mit
APISIX, und APISIX mit diesem Dienst. Früher war das anders, und die Plattform — das
Teil, das am häufigsten ausfällt — riss jede Anmeldung mit:

| Lief früher über die Plattform | Jetzt |
| --- | --- |
| Den Anmeldecode der Wallet senden | Dieser Dienst sendet ihn (`MAIL_FROM` + `MAIL_RESEND_API_KEY` / `MAIL_SMTP_*`) |
| Die API-Keys eines Wallet-Kontos am Ende einer Anmeldung ausstellen | Dieser Dienst stellt sie in APISIX aus (`APISIX_ADMIN_URL`, `APISIX_ADMIN_KEY`) |
| Der per E-Mail versandte Code eines Wiederherstellungsservers | Jeder Wiederherstellungsserver sendet seinen eigenen (`RECOVERY_EMAIL_CODES=true` + eigenes `MAIL_*`) |
| Der gemeinsame öffentliche Key (`/api/public-key`) | `GET /v1/public-key` |
| Der Asset-Katalog und anonyme Telemetrie (`/api/assets`, `/api/telemetry`) | Die Wallet ruft `GET /v1/assets` und `POST /v1/activity/events` mit dem öffentlichen Key auf |

Was die Plattform weiterhin tut, ist ihr Eigenes: die Keys der Entwickler, das
Dashboard und `/v1/admin`, das sie aufruft — nie umgekehrt. Ist sie ausgefallen,
kann niemand einen Entwickler-Key erstellen oder das Dashboard öffnen; Wallets melden
sich an, zahlen und tauschen wie gewohnt.

**Wallet-Keys.** Eine abgeschlossene Anmeldung erhält einen `dev`- und einen
`prod`-Key unter dem Consumer `cosmos_wallet_<accountId>`, mit den Scopes, Labels und
dem Consumer-Forwarder, den früher die Plattform erzeugte (Plan `community`,
Swap-Provision `WALLET_KEY_SWAP_FEE_BPS`, standardmäßig 150 bps). Eine zweite
Anmeldung liefert die Keys zurück, die das Konto schon hat, statt ein weiteres Paar
auszustellen. `organizationId` in der Antwort ist die Konto-ID.

**Der Admin-Key ist der Sicherheitspreis.** APISIX kennt keine engere Berechtigung
als seinen Admin-Key, der jede Route umschreiben kann. Der Client hier schreibt nur
Consumer unter `cosmos_wallet_` und lehnt jeden anderen Namen ab, bevor er eine
Anfrage baut — aber das ist ein Versprechen dieses Codes, nicht von APISIX: Behandeln
Sie `APISIX_ADMIN_KEY` wie `APISIX_GATEWAY_SECRET`, geben Sie den Pods dieses Dienstes
Netzwerkzugriff auf die Admin-API und auf nichts sonst davon, und setzen Sie ihn nie
auf einem Wiederherstellungsserver (der Start verweigert es).

**Konten, die die Plattform vor dieser Änderung provisioniert hat,** funktionieren mit
ihren Keys weiter. Bei ihrer nächsten Anmeldung erhalten sie neue Keys unter
`cosmos_wallet_<accountId>`, einem neuen Consumer; die unter dem alten Consumer
(`cosmos_<platformUserId>`) erfasste Historie ist mit dem neuen Key nicht sichtbar.

## Native Stellar-Swaps (Path Payments)

Stellar hat keine eigene „Swap“-Operation. Der Tausch von Assets erfolgt mit einem
**`PathPaymentStrictSend`**, das Horizon automatisch über die beste verfügbare
Kombination aus den **Orderbüchern der Stellar DEX** und **AMM-Liquiditätspools**
routet. Cosmos Pay verpackt das in einen Swap-Ablauf, der wie Payment Intents
**vollständig non-custodial** ist — Gelder fließen nie durch den Dienst. Er
beschränkt sich auf Folgendes:

1. **Bepreisen** durch Abfrage der Strict-Send-Pfadsuche von Horizon.
2. **Bauen** der unsignierten Transaktion (eine optionale Zahlung der Plattformgebühr +
   das Path Payment) und Rückgabe von `xdr` + SEP-7-`tx`-URI + QR.
3. **Weiterleiten** der Transaktion, die der Kunde in seiner eigenen Wallet signiert.

```
quote → build XDR → customer signs in wallet → POST /submit → Stellar executes
```

Das Netzwerk wird durch den Typ des API-Keys bestimmt (prod → public, dev → testnet),
genau wie bei Payment Intents, und jeder Swap wird **persistiert** (Tabelle `swap`) und
dem aufrufenden Consumer zugeordnet (`PENDING → SUBMITTED → SUCCEEDED/FAILED`).

**Gebühr (pro Organisation, serverseitig durchgesetzt).** Die Provision ist **der Satz
des Plans der aufrufenden Organisation**, vom Gateway als vertrauenswürdiger Header
(`X-Plan-Swap-Fee-Bps`) injiziert, den die Entwicklerplattform aus dem Plan der
Organisation ableitet. Sie ist **nie ein Request-Parameter**, und APISIX überschreibt
jede vom Client mitgeschickte Kopie, sodass der Satz weder umgangen noch unterboten
werden kann. Die Gebühr wird vom **Quell-Asset** abgezogen und als erste
Payment-Operation an die Plattform-Wallet (`STELLAR_SWAP_FEE_WALLET`) gezahlt; der
**Rest** wird durch den Swap geroutet. Wenn eine Plan-Gebühr gilt, aber keine
Plattform-Wallet konfiguriert ist, schlägt das Anlegen des Swaps mit `503` fehl
(Fehlkonfiguration durch den Operator). `STELLAR_SWAP_FEE_BPS` ist nur ein Fallback für
die lokale Entwicklung ohne Gateway (und ist selbst deaktiviert, wenn keine Wallet
gesetzt ist).

**Slippage.** Die Schätzung des Quotes, verringert um `slippageBps` (Standard
`STELLAR_SWAP_SLIPPAGE_BPS`, begrenzt durch `STELLAR_SWAP_MAX_SLIPPAGE_BPS`), wird zum
On-Chain-`destMin` des Path Payments — der Swap wird also **rückgängig gemacht**, statt
weniger zu liefern, als der Aufrufer zu akzeptieren bereit war.

**Trustline.** Einem nicht-nativen Ziel-Asset muss das Zielkonto bereits vertrauen; der
Build-Schritt prüft das und liefert andernfalls einen eindeutigen Fehler. (XLM benötigt
keine Trustline.)

**`POST /v1/swaps/quote`** — nur Preis, nichts wird persistiert (`swaps:read`).

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

**`POST /v1/swaps`** — baut die signierbare Transaktion (`swaps:write`). Nimmt dieselben
Felder plus `source` (das zahlende und signierende Konto) entgegen; `destination` ist
standardmäßig `source` (ein Self-Swap), und ein optionales `memo` (MEMO_ID) wird
on-chain übernommen.

Optionale **Idempotenz**: Senden Sie einen `Idempotency-Key`-Header (bevorzugt) oder
`idempotencyKey` im Body. Ein Wiederholungsversuch mit demselben Key **und derselben
Anfrage** — Netzwerk, Quelle, Ziel, beide Assets, Betrag, Slippage und Memo — liefert
den **bestehenden** Swap (`id` + `txHash`), statt eine weitere Transaktion zu bauen.
Derselbe Key mit einer abweichenden Anfrage ergibt `409 idempotency_conflict`, und der
Fehler verrät nichts über den gespeicherten Swap. Einzahlungen in und Auszahlungen aus
Liquiditätspools folgen derselben Regel, wobei zusätzlich die Art der Operation
verglichen wird. Ohne Key weist die Unique-Constraint `(network, txHash)` einen
byte-identischen Neubau dennoch mit **409** ab (Sequenz- bzw. XDR-Kollision). Wenn
`STELLAR_SWAP_SINGLE_INFLIGHT=true` gesetzt ist, liefert ein
zweiter, nicht abgelaufener `PENDING`-Swap für dasselbe `(consumer, source, network)`
ebenfalls **409** mit Nennung der bestehenden ID (standardmäßig **aus** — gleichzeitige,
voneinander verschiedene Swaps von einem Konto bleiben erlaubt). Diese Sperre hält nur
ein Swap, der **bereits on-chain sein könnte**: Eine Zeile, deren Sequenznummer das
Konto noch nicht verbraucht hat, kann nicht abgeschlossen sein, und der gerade gebaute
Swap nimmt dieselbe Nummer — höchstens einer von beiden kann es also je werden. Jeder
darf jede `source` nennen, ohne diese Prüfung fror ein einziger Staub-Swap die Swaps
eines fremden Kontos für ein ganzes Timeout-Fenster ein — und unter dem gemeinsamen
öffentlichen Key so lange, wie der Angreifer es wiederholte.

```jsonc
// response → { id, status: "PENDING", network, sendAmount, feeAmount, swapAmount,
//              destEstimated, destMin, path, xdr, uri: "web+stellar:tx?xdr=…", qr, txHash, … }
```

**Auch Angebot und Bau sind begrenzt**, pro Consumer und Client-Adresse: **60 Angebote
pro Minute** und **20 Bauvorgänge pro Minute**, in eigenen Buckets neben dem des
Submit. Ein Angebot speichert nichts und kostet trotzdem eine Strict-Send-Pfadsuche,
den teuersten Aufruf, den dieser Dienst an Horizon stellt — und dieses Budget pro IP
teilen sich Swaps, Liquiditätspools und Payment Intents, eine in einer Schleife
abgefragte Preisangabe verschlechterte also alle drei auf einmal für jeden anonymen
Aufrufer.

**`POST /v1/swaps/:id/submit`** — leitet den signierten Envelope weiter (`swaps:write`).

```jsonc
// request
{ "signedXdr": "AAAAAgAAA…(signed base64 XDR)…" }
// response
{ "submitted": true, "status": "SUCCEEDED", "txHash": "…", "swap": { … } }
// on a network rejection → { "submitted": false, "status": "FAILED", "reason": "…", "resultCodes": ["op_under_dest_min"], "swap": { … } }
```

Vor dem Senden prüft der Dienst, ob der Hash der signierten Transaktion mit dem der von
ihm gebauten übereinstimmt, sodass er nie eine beliebige Transaktion weiterleitet. Ein
Swap löst die Webhook-Events `SWAP_CREATED` / `SWAP_SUBMITTED` / `SWAP_SUCCEEDED` /
`SWAP_FAILED` über denselben Dispatcher aus.

**Submit ist streng bei dem, was es weiterleitet.** Nichts zum Swap — nicht
einmal sein Status — wird beantwortet, bevor `signedXdr` sich parsen lässt, auf
den `txHash` des Swaps hasht und mindestens eine Signatur trägt, sodass das
unsignierte `xdr` aus der Create-Antwort `400 validation_failed` ergibt. Ein
Swap, dessen Envelope seine Zeitgrenzen überschritten hat (`STELLAR_TX_TIMEOUT`,
standardmäßig 300 s), ergibt `400 invalid_state_transition` und wird nicht
gesendet; erreichte er das Netzwerk rechtzeitig, wickelt ihn der Observer
trotzdem ab. Nach einer Ablehnung durch das Netzwerk darf derselbe Envelope
höchstens **3**-mal erneut eingereicht werden, danach bauen Sie einen neuen
Swap — ein Wiederholungsversuch nach `503 provider_unavailable` zählt nicht
mit. Die Route erlaubt **20 Aufrufe pro Minute** pro Consumer und
Client-Adresse (`429 rate_limited`); unter dem gemeinsamen öffentlichen Key ist
jede anonyme Wallet derselbe Consumer, sodass sich Wallets hinter demselben NAT
dieses Budget teilen. `POST /v1/liquidity-pools/operations/:id/submit` folgt
denselben Regeln, mit einem eigenen Kontingent, und `POST
/v1/liquidity-pools/deposit` · `/withdraw` teilen sich ein Budget von **20
Bauvorgängen pro Minute** — die beiden Richtungen eines Ablaufs, getrennte Buckets
würden eine Schleife nur zwischen ihnen wechseln und beide verbrauchen lassen.

### Swaps auf Solana und Monad (Jupiter, Kuru Flow)

`/v1/swaps` nimmt ein optionales `chain`. Ohne es — oder mit `stellar` — wird
jede Anfrage genau wie bisher beantwortet. `solana` läuft über
[Jupiter](https://jup.ag) und `monad` über [Kuru Flow](https://kuru.io):
Aggregatoren, die jede Liquiditätsquelle ihrer Chain durchsuchen, sodass ein
Swap dort den besten Kurs bekommt statt des Preises eines einzelnen Pools. Der
Ablauf ist der von Stellar, durchgehend nicht verwahrend:

```
POST /v1/swaps/quote {chain} → POST /v1/swaps {chain, source} → wallet signs `transaction`
  → POST /v1/swaps/{id}/submit {signedTransaction} → observer → SUCCEEDED / FAILED
```

- **Assets** sind der native Ticker (`SOL`, `MON`), `native` oder die SPL-Mint- /
  ERC-20-Adresse. Issuer, `memo` und eine abweichende `destination` gibt es nur
  auf Stellar; anderswo werden sie abgelehnt: Der Output geht an `source`.
- **`transaction`** ist das, was die Wallet signiert. Solana: eine unsignierte
  VersionedTransaction (base64), etwa eine Minute gültig, bis ihr Blockhash
  abläuft. Monad: `{ to, data, value, chainId }`, als EIP-1559-Transaktion
  signiert, zwei Minuten gültig. Wer auf Monad ein ERC-20 mit zu kleiner
  Allowance verkauft, bekommt zusätzlich `approval`: den exakten
  `approve`-Aufruf, der zuerst gesendet und bestätigt werden muss.
- **Submit** prüft, dass die signierte Transaktion die gebaute ist — dieselben
  Message-Bytes auf Solana, derselbe Aufruf auf Monad — und von `source`
  signiert, und sendet sie über den eigenen RPC dieses Dienstes. Lehnt ein Node
  sie ab, ist das `400 transaction_rejected` und der Swap bleibt `PENDING`; nur
  das Urteil der Chain selbst, vom Observer gelesen, macht ihn `SUCCEEDED` oder
  `FAILED`. Nicht übermittelte oder nicht gesehene Swaps werden `EXPIRED`. Die
  Webhooks sind dieselben `SWAP_*`-Events.
- **Provision:** der Plan-Satz wie auf Stellar, aber vom Aggregator aus dem
  **Output** genommen. Jupiter zahlt seine `platformFeeBps` auf das Token-Konto
  von `SOLANA_SWAP_FEE_WALLET` für die Output-Mint, das existieren muss — fehlt
  es, lautet die Antwort `503 misconfigured` mit dem anzulegenden Konto. Kuru
  Flow zahlt seine `referrerFeeBps` an `MONAD_SWAP_FEE_WALLET`.
- **Nur Mainnet**; ein `dev`-Key ist `400 network_unsupported`.
  `GET /v1/swaps?chain=solana` listet diese Chain; IDs sind über alle Chains
  eindeutig, daher finden `GET /v1/swaps/{id}` und Submit jeden Swap.
- **Keys.** Kuru Flow ohne `KURU_API_KEY` stellt pro Adresse ein Token aus, das
  auf eine Anfrage pro Sekunde begrenzt ist — genug zum Ausprobieren, nicht für
  Produktion. Jupiters Stufe ohne Key ist der Standard; mit `JUPITER_API_KEY`
  `JUPITER_BASE_URL` auf `https://api.jup.ag/swap/v1` setzen.

## Chain-übergreifende Swaps (NEAR Intents)

Swaps **zwischen** Stellar, Solana und Monad werden von
[NEAR Intents](https://intents.near.org/) über dessen 1Click-API abgewickelt. Wie die
Stellar-Swaps oben sind sie **nicht verwahrend**: Der Zahlende sendet den Input an
eine Einzahlungsadresse, die 1Click für genau dieses eine Quote ableitet, und die
Solver von NEAR Intents zahlen den Output an den Empfänger auf der anderen Chain aus
— oder erstatten den Zahlenden. Keines der beiden Beine läuft über Cosmos Pay.

```
quote → create (deposit address + wallet link + QR) → payer sends the deposit
      → POST /deposit (optional) → observer polls 1Click → SUCCEEDED / REFUNDED / FAILED + webhook
```

**Welcher Swap wohin geht.**

| Paar | Abgewickelt von | Warum |
| --- | --- | --- |
| Stellar → Stellar | `/v1/swaps` (Stellar-DEX) | Das Protokoll swappt nativ; `/v1/cross-chain-swaps` antwortet mit `400` und verweist dorthin |
| Stellar ⇄ Solana ⇄ Monad | NEAR Intents | Es braucht eine Brücke, und NEAR Intents ist diese Brücke |
| Solana → Solana, Monad → Monad | `/v1/swaps` mit `chain` (Jupiter, Kuru Flow) | Jeder Aggregator routet über jede Liquiditätsquelle seiner Chain zum besten Kurs; `/v1/cross-chain-swaps` antwortet mit `400` und verweist dorthin |

Was dieser Dienst auf jeder Chain selbst erledigt: Er löst die Assets gegen die
Token-Liste von 1Click auf (`GET /v1/cross-chain-swaps/assets`), validiert jede
Adresse gegen ihre eigene Chain, baut die Einzahlungsanfrage im Wallet-Standard
dieser Chain — SEP-7 `pay`, Solana Pay, EIP-681 —, prüft auf Horizon, dass ein
Stellar-Empfänger dem Asset vertraut, das er gleich erhält, und spiegelt den Status
in seine eigene Tabelle.

**Provision.** Der Satz aus dem Plan der Organisation — derselbe vertrauenswürdige
`X-Plan-Swap-Fee-Bps` wie bei Stellar-Swaps, nie ein Request-Parameter — geht als
`appFees`-Eintrag an 1Click, zahlbar an `NEAR_INTENTS_FEE_RECIPIENT`, ein NEAR-Konto.
NEAR Intents zieht ihn vom Input ab, der quotierte Output ist bereits netto, und er
sammelt sich auf diesem Konto innerhalb von NEAR Intents, von wo der Betreiber ihn
abhebt. Ein Plan mit Satz ohne konfigurierten Empfänger antwortet mit
`503 misconfigured`, statt kostenlos zu swappen.

**Setze `NEAR_INTENTS_API_KEY`.** 1Click funktioniert ohne Partner-Key, aber nicht
zum selben Preis: Ohne ihn (geprüft am 2026-09-30) trägt jedes Quote eine eigene
1Click-Gebühr von 0,2 %, und die Hälfte der in `appFees` angefragten Provision geht an
1Click statt an `NEAR_INTENTS_FEE_RECIPIENT`.

**Nur Mainnet.** NEAR Intents hat kein Testnetz. Ein `dev`-Key darf Assets auflisten
und quoten — der Preis ist ohnehin der des Mainnets —, aber
`POST /v1/cross-chain-swaps` antwortet mit `400 network_unsupported`: Eine
Einzahlungsadresse würde echtes Geld annehmen.

**Stellar-Einzahlungen tragen ein Memo.** 1Click empfängt jede Stellar-Einzahlung auf
einem einzigen Konto und unterscheidet sie am Memo, deshalb ist `depositMemo` dort
Pflicht, und der SEP-7-Link hängt es als **`MEMO_TEXT`** an — den Typ, den die
Einzahlungen auf dieses Konto tragen. Eine Einzahlung ohne Memo oder mit `MEMO_ID`
wird dem Swap nicht gutgeschrieben.

**Status.** `AWAITING_DEPOSIT` → `DEPOSIT_DETECTED` / `INCOMPLETE_DEPOSIT` →
`PROCESSING` → `SUCCEEDED`, `REFUNDED` oder `FAILED`, die endgültig sind. Das eigene
Wort von 1Click steht in `providerStatus`. Ein Swap, der beim Ablauf seiner Frist
noch wartet (`CROSS_CHAIN_SWAP_DEADLINE_SECONDS`, standardmäßig 30 Minuten), wird
`EXPIRED`; eine später eintreffende Einzahlung erstattet NEAR Intents, daher wird ein
`EXPIRED`-Swap noch einen Tag lang abgefragt und folgt bis `REFUNDED`. Der Observer
läuft mit dem Settlement-Observer (`OBSERVER_ENABLED`, `OBSERVER_INTERVAL_MS`); keine
Wallet muss zurückkommen, damit ein Swap abgeschlossen wird. Jeder Wechsel sendet
`CROSS_CHAIN_SWAP_UPDATED`, `_EXPIRED`, `_SUCCEEDED`, `_REFUNDED` oder `_FAILED`; die
letzten drei sind dauerhaft und dedupliziert wie die der Payment Intents.

**Bewahre `quoteSignature` auf.** Das ist die Signatur von 1Click über das Quote und
seine Einzahlungsadresse — das, was einen Streit mit NEAR Intents entscheidet. Das
vollständige signierte Quote wird zusätzlich serverseitig gespeichert.

**Limits.** Quote: 60 Aufrufe pro Minute; Create und Deposit: je 20, pro Consumer und
Client-Adresse (`429 rate_limited`).

### Routen für chain-übergreifende Swaps

| Route | Scope | Zweck |
| --- | --- | --- |
| `GET /v1/cross-chain-swaps/assets` | `swaps:read` | Die Token, die NEAR Intents auf Stellar, Solana und Monad swappen kann |
| `POST /v1/cross-chain-swaps/quote` | `swaps:read` | Ein Trocken-Quote: Output, Minimum, Provision; speichert nichts |
| `POST /v1/cross-chain-swaps` | `swaps:write` | Ein Live-Quote: Einzahlungsadresse, Memo, Wallet-Link und QR; unterstützt `Idempotency-Key` |
| `GET /v1/cross-chain-swaps` | `swaps:read` | Die chain-übergreifenden Swaps des Consumers |
| `GET /v1/cross-chain-swaps/{id}` | `swaps:read` | Ein Swap, wie der Observer ihn zuletzt gesehen hat |
| `POST /v1/cross-chain-swaps/{id}/deposit` | `swaps:write` | Die Einzahlungstransaktion melden, damit NEAR Intents startet, ohne auf seinen Indexer zu warten |
## Aliase — beanspruchbare Zahlungs-Handles

Ein Alias ermöglicht es einem Zahler, `emanuel250` statt `GA5ZSE…` einzugeben. Zahler
vertrauen diesem Namen unmittelbar, bevor sie Geld senden, daher sind die folgenden
Regeln streng: Ein Fehler bedeutet eine Zahlung an das falsche Konto.

### Beansprucht durch den Nachweis der Kontrolle über einen Schlüssel, nicht auf Zuruf

```
wallet ──1. POST /v1/aliases/challenges {name, address, network} ──▶ nonce + the EXACT message to sign
wallet ──2. signs SHA-256(domain ‖ 0x00 ‖ uint32be(length) ‖ message) with that address's key
wallet ──3. POST /v1/aliases {name, email, nonce, signature} ────────▶ alias bound to the calling consumer
```

- **Signieren Sie genau die Nachricht, die der Dienst liefert.** Bauen Sie sie nicht
  auf dem Client nach.
- **Die Signatur deckt einen Digest mit Domain-Tag ab, nie eine Transaktion.** Nichts,
  was in diesem Ablauf signiert wird, kann an das Netzwerk übermittelt werden, und die
  Domain (`Cosmos Pay alias claim v1`) gibt es nur für diese Funktion, sodass eine
  Signatur, die eine andere Dapp eingeholt hat, nicht als Claim verwendet werden kann.
- **Der Zweck steckt in den signierten Bytes** (`CLAIM`, `ADD_ADDRESS`, `RECOVER`),
  sodass eine Signatur, die zum Hinzufügen einer Adresse eingeholt wurde, nicht erneut
  verwendet werden kann, um eine Wiederherstellung abzuschließen.
- **Die Adresse stammt aus der Challenge, nicht aus dem Claim-Body.** Der Claim hat
  kein Adressfeld, sodass niemand für eine Adresse signieren und eine andere
  registrieren kann.
- **Challenges sind einmalig verwendbar und fünf Minuten gültig.** Die Signatur wird
  geprüft, *bevor* die Challenge verbraucht wird, sodass eine ungültige Signatur nicht
  die Nonce eines anderen verbrauchen kann, und das Verbrauchen ist ein Compare-and-Swap.
- **Ein Wettlauf wird durch den eindeutigen Index auf `alias.name` entschieden**, nicht
  durch eine Vorabprüfung; der Verlierer erhält `409 alias_taken`.

### Was ein Handle sein darf

Kleinbuchstaben `a-z`, `0-9` und `_` (nie am Anfang oder Ende), 3–32 Zeichen, vor der
Eindeutigkeitsprüfung in Kleinbuchstaben umgewandelt. Kein Unicode: Die Menge der
Homoglyphen ist unbegrenzt, und keine Normalisierung macht ein kyrillisches `а` sicher
genug, um es neben einem Betrag darzustellen. Ebenfalls abgewiesen: reservierte Wörter
(`admin`, `support`, `cosmospay`, `stellar`, …) und alles, was wie ein Stellar-Konto
aussieht (`g` oder `m` gefolgt von 20 oder mehr Base32-Zeichen). Die Regel steht in
`src/aliases/alias-name.ts`.

### Viele Adressen, ein Name

Ein Alias verweist auf bis zu 20 Adressen über Netzwerke hinweg — ein Telefon, ein
Desktop, eine Cold Wallet, Testnet — mit genau einer primären Adresse pro Netzwerk,
erzwungen durch einen partiellen eindeutigen Index. Das Hinzufügen einer Adresse
erfordert **zwei** Nachweise: Der Aufrufer besitzt den Alias, und die neue Adresse
signiert ihre eigene `ADD_ADDRESS`-Challenge. Die letzte verbleibende Adresse kann nicht
entfernt werden (geben Sie stattdessen den Alias frei), und ein Consumer darf höchstens
25 Aliase halten.

Ein `SUSPENDED`-Alias (eine Sperre durch einen Operator) löst zu nichts auf.

### Die Wiederherstellung läuft über E-Mail, versendet von diesem Dienst

Ein Anspruch hinterlegt eine Wiederherstellungs-E-Mail, damit der Verlust eines
Schlüssels nicht den Verlust des Namens bedeutet. Die Wiederherstellung läuft so ab:

1. Die Wallet (jeder Key mit `payments:write`, auch der gemeinsame öffentliche Key)
   ruft `POST /v1/aliases/:name/recovery {email}` auf. Die Antwort ist immer
   `{ accepted: true }`, ob Handle und Postfach übereinstimmen oder nicht; bei
   Übereinstimmung **sendet dieser Dienst** ein Einmal-Token (30 Minuten, nur als
   SHA-256 gespeichert) per E-Mail an das hinterlegte Postfach. Das Token erscheint
   nie in einer Antwort.
2. Der Nutzer holt sich eine `RECOVER`-Challenge für den neuen Schlüssel und ruft
   `POST /v1/aliases/:name/recovery/complete {token, address, network, nonce, signature}`
   mit seinem eigenen API-Key auf. Beide Nachweise sind nötig: Das Token belegt das
   Postfach, die Signatur den Schlüssel.
3. Der Besitz geht an den aufrufenden Consumer über und **alle bisherigen Adressen
   werden entfernt**, sodass wer die alten Schlüssel hält, keine Zahlungen mehr erhält.

Der Start einer Wiederherstellung steht jedem offen, weil das Token nur das Postfach
erreicht: Ein Fremder kann höchstens bewirken, dass der Besitzer eine E-Mail erhält.
Das ist doppelt begrenzt — 5 Starts pro 10 Minuten und Adresse (`429 rate_limited`)
und höchstens eine E-Mail pro Alias und Minute, egal wer fragt (eine Wiederholung
innerhalb dieser Minute antwortet gleich und sendet nichts). Ein Deployment ohne
E-Mail-Absender antwortet `503 misconfigured`. Ein gesperrter Alias kann nicht
wiederhergestellt werden.

Ein Wiederherstellungs-Token kann **fünf**-mal vorgelegt werden. Eine Vorlage,
deren Challenge oder Signatur fehlschlägt, verbraucht trotzdem einen Versuch,
und die sechste wird abgewiesen; der Inhaber kann eine neue Wiederherstellung
starten. Ein Token, das zu keiner laufenden Wiederherstellung dieses Alias
passt, erhält denselben `400 alias_recovery_invalid` und ändert nichts, sodass
niemand die Wiederherstellung eines Inhabers durch das Senden von Datenmüll
verbrauchen kann. `POST /v1/aliases/:name/recovery/complete` erlaubt 10 Aufrufe
und `POST /v1/aliases/challenges` 30 Aufrufe pro 10 Minuten, pro Consumer und
Client-Adresse (`429 rate_limited`).

Abgelaufene Challenges und Wiederherstellungen werden einen Tag nach ihrem Ablauf von
`AliasChallengeSweeperService` gelöscht (stündlich, ein Replikat pro Tick).

### Adressen auf Solana und Monad

Ein Alias kann neben Stellar- auch auf Solana- und Monad-Konten zeigen.
`POST /v1/aliases/challenges`, `POST /v1/aliases/{name}/addresses` und
`POST /v1/aliases/{name}/recovery/complete` nehmen ein optionales `chain` an; die
Challenge-Nachricht trägt dann eine Zeile `chain:`, die die Signatur an diese Chain
bindet. Stellar signiert weiterhin den gerahmten Digest; Solana signiert den
Challenge-Text mit ed25519, Monad mit EIP-191 `personal_sign`. Die Standardadresse
gilt je Chain und Netzwerk, also stuft eine hinzugefügte Solana-Adresse nie eine
Stellar-Adresse herab. `GET /v1/aliases/resolve/{name}` löst auf Stellar auf, sofern
`?chain=` keine andere Chain nennt — eine Wallet, die nach keiner fragt, bekommt nie
eine Adresse, die sie nicht bezahlen kann —, und
`GET /v1/aliases/by-address/{address}` liest die Chain an der Form der Adresse ab.
Eine Monad-Adresse wird in ihrer EIP-55-Schreibweise gespeichert und verglichen.

### Routen

| Methode | Pfad | Scope | Beschreibung |
| ------- | ---- | ----- | ------------ |
| GET | `/v1/aliases/resolve/:name` | `payments:read` · öffentlicher Key | Die Adressen, auf die ein Alias auflöst (`?network=` filtert) |
| GET | `/v1/aliases/availability/:name` | `payments:read` · öffentlicher Key | Ob ein Handle beanspruchbar ist, und falls nicht, warum |
| GET | `/v1/aliases/by-address/:address` | `payments:read` · öffentlicher Key | Die Aliase, die auf eine Adresse verweisen |
| POST | `/v1/aliases/challenges` | `payments:write` | Eine Nonce und die exakte zu signierende Nachricht |
| POST | `/v1/aliases` | `payments:write` | Einen Alias mit einer Signatur beanspruchen |
| GET | `/v1/aliases` | `payments:read` | Die Aliase des Aufrufers |
| POST | `/v1/aliases/:name/addresses` | `payments:write` | Eine Adresse hinzufügen, signiert von dieser Adresse |
| DELETE | `/v1/aliases/:name/addresses/:addressId` | `payments:write` | Eine Adresse entfernen |
| DELETE | `/v1/aliases/:name` | `payments:write` | Den Alias freigeben |
| POST | `/v1/aliases/:name/recovery` | `payments:write` | Eine Wiederherstellung starten → das Token wird dem Besitzer per E-Mail gesendet |
| POST | `/v1/aliases/:name/recovery/complete` | `payments:write` | Eine Wiederherstellung mit dem Token und der Signatur des neuen Schlüssels abschließen |

## BlindPay — Onramp / Offramp / KYC (Fiat ⇄ Stablecoin)

> **Ein natives Plugin.** Alles in diesem Abschnitt ist das Plugin `blindpay`
> (`src/native-plugins/blindpay/`), das nur ausgeliefert wird, wenn
> `PLUGINS_ENABLED` `blindpay` aufführt — siehe *Native Plugins: BlindPay und
> DeFindex*. BlindPay wickelt auf Stellar, Solana, EVM-Chains (Ethereum, Base,
> Arbitrum, Polygon) und Tron ab; **Monad ist kein BlindPay-Netzwerk**, dort gibt es
> also keine Fiat-On-/Off-Ramp.

Zusätzlich zu On-Chain-Payment-Intents integriert der Dienst
[BlindPay](https://www.blindpay.com/docs), um Geld zwischen **Fiat und Stablecoins** zu
bewegen: Einzahlung (**Onramp / Payin**), Auszahlung (**Offramp / Payout**) und das für
beides verpflichtende **KYC** (BlindPay-*Receiver*). Wir betreiben **eine
BlindPay-Plattforminstanz pro API-Key-Umgebung** — Produktion für `prod`-Keys
(`BLINDPAY_API_KEY` + `BLINDPAY_INSTANCE_ID`), Entwicklung für `dev`-Keys (die
`_DEV`-Variablen); jeder Receiver, jede Wallet, jedes Bankkonto, jeder Payin und jeder Payout
wird in unserer Postgres-Datenbank gespiegelt und ist **dem aufrufenden
APISIX-Consumer zugeordnet**, sodass jeder Integrator nur seine eigenen Datensätze
sieht. Der Dienst **hält nie Blockchain-Schlüssel** — der Offramp liefert das zu
signierende Artefakt (EVM-`approve`-Contract / Stellar-XDR) und nimmt die signierte
Transaktion wieder entgegen, genau wie bei Payment Intents.

Zustandsänderungen werden über die **Svix-Webhooks** von BlindPay synchronisiert (über
den rohen Body verifiziert) und als neue Event-Typen (`RECEIVER_UPDATED`, `PAYIN_*`,
`PAYOUT_*`) über den bestehenden Dispatcher an die eigenen Webhook-Endpunkte des
Integrators **weitergegeben**.

| Methode | Pfad                                                  | Scope          | Beschreibung |
| ------- | ----------------------------------------------------- | -------------- | ------------ |
| POST   | `/v1/kyc/receivers`                                   | `kyc:write`    | Einen Receiver anlegen (KYC/KYB starten) |
| GET    | `/v1/kyc/receivers` · `/:id`                          | `kyc:read`     | Auflisten / abrufen (Abrufen aktualisiert den KYC-Status) |
| PATCH  | `/v1/kyc/receivers/:id`                               | `kyc:write`    | Einen Receiver aktualisieren (sobald er bei BlindPay existiert, brauchen Identitätsfelder einen erhöhten Key) |
| DELETE | `/v1/kyc/receivers/:id`                               | `kyc:write`    | Einen Receiver löschen |
| POST   | `/v1/kyc/upload`                                      | `kyc:write`    | Ein KYC-Dokument hochladen → `file_url` |
| GET    | `/v1/kyc/rails` · `/v1/kyc/bank-details?rail=`        | `kyc:read`     | Rail-Katalog / Pflichtfelder |
| POST   | `/v1/kyc/receivers/:id/wallets`                       | `kyc:write`    | Eine Blockchain-Wallet registrieren |
| GET    | `/v1/kyc/receivers/:id/wallets/sign-message`          | `kyc:read`     | Zu signierende Nachricht (sicherer EOA-Ablauf) |
| POST   | `/v1/kyc/receivers/:id/bank-accounts`                 | `kyc:write`    | Ein Fiat-Bankkonto hinzufügen (beliebige Rail) |
| POST   | `/v1/onramp/quotes`                                   | `onramp:write` | Einen Payin bepreisen (läuft nach ~5 min ab) |
| POST   | `/v1/onramp/payins`                                   | `onramp:write` | Einen Payin anlegen → Einzahlungsanweisungen |
| GET    | `/v1/onramp/payins` · `/:id`                          | `onramp:read`  | Auflisten / abrufen (Abrufen aktualisiert den Status) |
| POST   | `/v1/onramp/trustline`                                | `onramp:write` | Ein unsigniertes Stellar-Trustline-XDR bauen |
| POST   | `/v1/onramp/receivers/:id/virtual-accounts`           | `onramp:write` | Ein virtuelles Konto anlegen |
| POST   | `/v1/offramp/quotes`                                  | `offramp:write`| Einen Payout bepreisen (EVM → `approve`-Contract) |
| POST   | `/v1/offramp/payouts/authorize`                       | `offramp:write`| Die unsignierte Stellar/Solana-Payout-Transaktion bauen |
| POST   | `/v1/offramp/payouts`                                 | `offramp:write`| Einen Payout aus einem Quote anlegen |
| GET    | `/v1/offramp/payouts` · `/:id`                        | `offramp:read` | Auflisten / abrufen (Abrufen aktualisiert den Status) |
| POST   | `/v1/offramp/payouts/:id/documents`                   | `offramp:write`| Ein Compliance-Dokument anhängen |
| POST   | `/v1/blindpay/webhooks`                               | _öffentlich_   | Eingehender BlindPay-(Svix-)Webhook |

Beträge sind **Ganzzahlen in kleinsten Währungseinheiten** (z. B. `$123.45` →
`12345`). Konfigurieren Sie den Webhook im BlindPay-Dashboard auf
`<gateway>/v1/blindpay/webhooks` und setzen Sie `BLINDPAY_WEBHOOK_SECRET` auf das
Signatur-Secret dieses Endpunkts — den vollständigen `whsec_…`-Wert. Der Start
schlägt fehl, wenn dessen Schlüssel zu weniger als 24 Byte dekodiert, und der
Verifier weist einen solchen Schlüssel ohnehin ab: Ungültiges Base64 dekodiert zu
einem leeren Schlüssel, mit dem jeder signieren kann. Lassen Sie die
`BLINDPAY_*`-Variablen leer, um die
Funktion zu deaktivieren: Diese Routen liefern dann `503` `misconfigured`, ebenso der
eingehende Webhook, solange `BLINDPAY_WEBHOOK_SECRET` nicht gesetzt ist. Siehe
`.env.example`.

**Ein `dev`-Key erreicht nie die Produktionsinstanz.** Die Umgebung des Keys wählt die
BlindPay-Instanz so, wie sie das Stellar-Netzwerk wählt, und jede gespiegelte Zeile
hält fest, von welcher Instanz sie stammt; die `dev`- und `prod`-Keys eines Tenants —
ein einziger Consumer — sehen also getrennte Receiver, Wallets, Bankkonten, Quotes,
Payins und Payouts. Ohne konfigurierte Entwicklungsinstanz antworten die
BlindPay-Routen `dev`-Keys mit `503` `misconfigured`. Richten Sie die
Dashboard-Webhooks beider Instanzen auf dasselbe `<gateway>/v1/blindpay/webhooks` und
setzen Sie `BLINDPAY_WEBHOOK_SECRET_DEV` für die Entwicklungsinstanz: Das Secret, gegen
das eine Zustellung verifiziert wird, bestimmt, welche Instanz sie gesendet hat.

**Identität wird geprüft, bevor sie BlindPay erreicht — auch bei Änderungen.** Bis ein
Receiver aktiviert ist, schickt ein `PATCH`, das KYC-Daten berührt, ihn zurück nach
`pending_review`. Sobald er bei BlindPay existiert, darf ein Tenant-Key nur
`external_id` und `image_url` ändern; jedes andere Feld ist `403`
`kyc_review_required`, es sei denn, der Key ist erhöht (`X-Consumer-Role: admin`), weil
dieses `PUT` die Identität direkt beim Anbieter überschreibt.

**Eine Genehmigung ist an das geprüfte Dossier gebunden.** Ein Receiver-Read liefert
`dossierVersion` mit, das jede Änderung an den eingereichten KYC-Daten zählt. Schicken
Sie den Wert beim Genehmigen als `expected_version` zurück, dann ergibt ein seit dem
Lesen geändertes Dossier `409 kyc_state_invalid` statt der Genehmigung von Daten, die
niemand gesehen hat — eine Änderung belässt den Status auf `pending_review`, die
Genehmigung allein konnte es also nicht merken. Was abgezeichnet wurde, steht in
`reviewedVersion`, und `POST /v1/kyc/receivers/:id/enable` weigert sich, den Receiver
bei BlindPay anzulegen, solange die beiden auseinanderlaufen.

**Die Fiat-Routen haben Budgets.** Jeder Schreibvorgang, den der Anbieter behält, ist
pro Consumer und Client-Adresse begrenzt, und jede BlindPay-gestützte Route zählt
zusätzlich gegen eine Obergrenze pro Consumer von **60 Anbieteranfragen pro Minute**:
Eine Instanz bedient alle Tenants eines Keys, ein Tenant in einer Angebotsschleife
lässt also die Payins der anderen scheitern. Über Budget ist `429 rate_limited` mit
`Retry-After`.

| Route | Budget (pro Consumer + Client-Adresse) |
| ----- | -------------------------------------- |
| `POST /v1/kyc/upload` | 20 pro 10 Min. |
| `POST /v1/kyc/terms-of-service` | 10 pro 10 Min. |
| `POST /v1/onramp/quotes` · `POST /v1/offramp/quotes` | je 30 pro Minute, getrennte Buckets |
| `POST /v1/onramp/payins` | 10 pro Minute |
| `POST /v1/offramp/payouts/authorize` · `POST /v1/offramp/payouts` | 10 pro Minute, gemeinsam |
| `POST /v1/offramp/payouts/:id/documents` | 20 pro 10 Min. |
| `POST /v1/onramp/trustline` | 20 pro Minute |

### KYC-Redirect-URLs werden pro Consumer per Allowlist freigegeben

Der Ablauf für die Nutzungsbedingungen schickt den Benutzer zu BlindPay und zurück an
eine `redirect_url`, die der Integrator angibt. Um einen Open Redirect zu verhindern,
durchläuft jede `redirect_url` zwei Prüfungen:

| Ebene | Regel | Wo |
| ----- | ----- | -- |
| Form | eine absolute `https`-URL ohne eingebettete Zugangsdaten (`user:pass@`), ohne Fragment (`#…`) und ohne Backslash, Leerzeichen oder Steuerzeichen | `@IsRedirectUrl()` auf jedem DTO, das eine trägt, und erneut in der Service-Schicht |
| Host | auf der Allowlist **des aufrufenden Consumers** — der exakte Host oder eine Subdomain an einer Label-Grenze (`app.acme.com` passt zu `acme.com`; `evilacme.com` nicht) | `KYC_REDIRECT_URL_WHITELIST`, durchgesetzt in der Service-Schicht |

```
KYC_REDIRECT_URL_WHITELIST={"cosmos_acme":["acme.com","app.acme.com"]}
```

Die Formregeln sind das, was die Host-Prüfung wert ist. Ein Backslash wird von einem
WHATWG-Parser innerhalb der Authority als `/` gelesen und von anderen als Teil der
Userinfo, `https://app.acme.com\@evil.test` hat also zwei ehrliche Lesarten — und
dieser Dienst ist nicht der letzte Leser: Der Wert geht an BlindPay, kommt auf einer
gehosteten Seite zurück und landet in einem Browser. Leerzeichen und Steuerzeichen sind
dieselbe Klasse, ein Fragment verschluckt das `?tos_id=`, das der Anbieter anhängt, und
Zugangsdaten schieben den Host auf die andere Seite des `@`.

Die Prüfung arbeitet **fail-closed**: Ein Consumer ohne Eintrag kann überhaupt keinen
Redirect verwenden, und ein Host mit abschließendem Punkt oder in IDN-Form wird
abgewiesen statt normalisiert. Jede Route, die eine `redirect_url` entgegennimmt, prüft
sie, auch die Admin-Genehmigung, die die Liste des Consumers verwendet, dem der Receiver
gehört. Ein abgewiesenes Schema oder ein abgewiesener Host ergibt `400`.

## Plugins — Erweiterungen unter einem Slug

Andere Teams integrieren ihre Technologie als **Plugin** in diesen Service: ein Ordner
unter `plugins/`, bereitgestellt unter `/v1/plugins/<slug>/…`, der mit den Kunden,
Produkten und Payment Intents eines Tenants arbeitet, ohne je den Core direkt
anzufassen. Ziel ist, dass ein Plugin fehlerhaft sein kann — verbuggt, langsam, gierig
—, ohne dass der Core mit ihm fehlerhaft wird.

### Ein Plugin ist ein Ordner

Alle Plugins liegen in **einem einzigen Ordner**, `plugins/` im Wurzelverzeichnis
des Repositorys — die, die der Cosmos-Pay-Support ausliefert, und die, die ein Betreiber
installiert. Ein Plugin besteht aus drei lesbaren Dateien, und keines läuft, bevor sein
Slug in `PLUGINS_ENABLED` steht:

```
plugins/
  README.md
  example/
    plugin.json       what the plugin is, and what it may touch
    index.ts          what it does — plain TypeScript, no build step
    signature.json    who vouches for the two files above
```

`plugin.json` sagt, was das Plugin ist und was es anfassen darf — die Datei, die ein Reviewer und ein Tenant zuerst lesen:

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

`index.ts` ist der Code: normales TypeScript, beim Start des Service transpiliert. Sein einziger Import ist das SDK (`@/plugins/sdk`):

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

`example` ist vorinstalliert und deaktiviert: ein Referenz-Plugin, das eine Query, ein
Command, ein Event und eine Tenant-Einstellung nutzt. Fang dort an.

### Eines schreiben

```sh
npm run plugins -- new my-plugin          # plugins/my-plugin/ from a template
npm run plugins -- check my-plugin        # compile, load and validate it
PLUGINS_ENABLED=my-plugin PLUGINS_ALLOW_UNSIGNED=true npm run start:dev
npm run plugins -- sign my-plugin --key support.pem --key-id cosmos-support
```

`check` kompiliert das Plugin und führt jede Validierung aus, die der Server beim Start
ausführt. `PLUGINS_ALLOW_UNSIGNED=true` lässt es unsigniert laufen, während du lokal
arbeitest, und wird bei `NODE_ENV=production` abgelehnt. Öffne einen Pull Request mit
dem Ordner; nach dem Review signiert der Support es, und es wird vorinstalliert
ausgeliefert.

Signieren führt den Code des Plugins nie aus — nur `check` tut das, und die CI führt
es bei jedem Pull Request aus —, also kann ein Pull Request seinen Code nicht auf dem
Rechner ausführen lassen, der den Support-Schlüssel hält. Signiere, was Review und CI
bereits bestanden hat.

### Was ein Plugin erreichen kann und was nicht

Die Handler eines Plugins erhalten einen `PluginContext` und sonst nichts — kein
Prisma, keinen Nest-Provider, kein `process.env`, keinen Socket:

| `ctx.` | Erreicht | Begrenzt durch |
| ------ | -------- | -------------- |
| `storage` | die eigenen Datensätze des Plugins (`plugin_record`), nur für diese Installation | 16 KiB pro Wert, 10 000 Datensätze pro Installation |
| `core.customers`, `core.products` | auflisten / lesen / anlegen / ändern, über die eigenen Services und DTOs des Core | die gewährte Capability (`customers:read`, `customers:write`, …); Löschen gibt es nicht |
| `core.paymentIntents` | auflisten / lesen, nur lesend | `payment_intents:read`; nichts, was signiert oder Geld bewegt |
| `http` | HTTPS auf Port 443 zu den Hosts in `egress` | nur öffentliche Adressen (die SSRF-Regeln der Webhooks), Socket an die geprüfte Adresse gebunden, keine Redirects, 1-MiB-Antworten |
| `installation.config` | die Einstellungen des Tenants; geheime nur für diesen Aufruf entschlüsselt | — |

Was die Runtime bei jedem Aufruf garantiert:

- **Tenant-Isolation.** Der Kontext wird aus dem aufrufenden Consumer und seiner
  Installation gebaut; keine Methode nimmt eine Consumer- oder Installations-ID.
- **Projektionen, keine Zeilen.** Lesezugriffe auf den Core liefern eine feste
  Projektion — kein `consumerId`, kein `xdr`/`uri`, keine Provider-Payloads —, kopiert
  und eingefroren.
- **Die Validierung des Core gilt weiter.** Schreibzugriffe laufen durch dieselben DTOs
  wie die HTTP-Routen; unbekannte Felder werden abgelehnt.
- **Queries können nicht schreiben.** Eine Query ist mit `plugins:read` aufrufbar, daher
  lehnt darin jeder Storage- und Core-Schreibzugriff ab.
- **Budgets.** 10 s pro Aufruf, 200 Kontext-Aufrufe, 64 KiB Eingabe, 256 KiB Ausgabe.
  Läuft die Zeit ab, erhält der Aufrufer `504 plugin_failed` und der Kontext wird
  widerrufen, sodass weiterlaufende Arbeit danach nicht mehr schreiben kann.
- **Fehler bleiben eingegrenzt.** Ein `PluginError` wird zu `400 plugin_rejected` mit
  seiner Meldung; alles andere zu `502 plugin_failed`, geloggt und nie zurückgegeben.
  Ein Plugin, das bei einem Event scheitert, stört weder den Webhook dieses Events noch
  andere Plugins.
- **Isolation.** Plugin-Code läuft nie in diesem Prozess. Jeder Aufruf erhält einen
  frischen V8-Isolate (`isolated-vm`) ohne Node darin — kein `process`, `require`,
  Netzwerk, Dateisystem oder Timer —, einen Heap von 32 MB und einen eigenen Thread.
  Sein einziger Weg nach draußen ist eine Brücke, die die obigen Kontext-Methodennamen
  mit JSON-Kopien hin und zurück annimmt; kein Objekt dieses Prozesses erreicht ihn je,
  also findet Code, der ausbrechen will, nichts zum Hochklettern. Endet das Budget,
  wird der Isolate verworfen, was das Plugin stoppt, wo immer es ist — eine synchrone
  Schleife eingeschlossen —, und nichts, was es im Speicher hielt, überlebt bis zum
  nächsten Aufruf, auch nicht bis zu dem eines anderen Tenants. Zusätzlich erlaubt
  ESLint `plugins/**/*.ts` nur den Import des SDK.

### Wer für ein Plugin bürgt

Ein Plugin läuft nur, wenn ein vertrauenswürdiger Schlüssel genau seine `plugin.json`
und seine `index.ts` unter seinem Slug und seiner Version signiert hat
(`signature.json`). Ändere ein Zeichen Code oder eine Capability, und die Signatur
schlägt fehl — der Start bricht ab. Die Formatierung von `plugin.json` und Zeilenenden
zählen nicht als Änderung.

- **Vom Support vorinstalliert.** Die öffentlichen Schlüssel des Supports stehen im Code
  (`PLUGIN_SUPPORT_KEYS`), daher lädt ein vom Support signiertes und in `plugins/`
  eingechecktes Plugin auf jedem Deployment ohne Konfiguration. `plugins/` steht in
  `.github/CODEOWNERS`, und die CI prüft, dass jeder Ordner darin signiert und gültig
  ist.
- **Von Hand installiert.** Alles andere wird aus einer Registry installiert — einem
  beliebigen statischen HTTPS-Host — und muss vom Support oder von einem Schlüssel aus
  `PLUGINS_TRUSTED_KEYS` signiert sein:

```sh
npm run plugins -- install acme@1.0.0 --registry https://plugins.example.com
# then add "acme" to PLUGINS_ENABLED and restart
```

Der Registry wird nicht vertraut: `install` prüft die Signatur, bevor etwas geschrieben
wird, und der Server prüft sie bei jedem Start erneut.

### Installieren heißt zustimmen

Ein Plugin läuft für einen Tenant erst, nachdem dieser es mit
`PUT /v1/plugins/{slug}/installation` installiert und `grantCapabilities` genau gleich
der Liste in `plugin.json` sendet — keine Teilmenge, keine Obermenge
(`400 plugin_consent_mismatch`). Deklariert eine spätere Version mehr, behält die
Installation ihre alte Zustimmung, und jede Aktion antwortet `409 plugin_not_installed`,
bis der Tenant erneut installiert (`installation.pendingCapabilities` zeigt den
Unterschied). Deinstallieren löscht alle Datensätze des Plugins für diesen Tenant. Als
`secret` markierte Einstellungen werden mit `PLUGINS_SECRET` versiegelt und nie
zurückgegeben.

### Plugin-Routen

| Methode | Pfad | Zweck |
| ------- | ---- | ----- |
| GET | `/v1/plugins` | Die Plugins dieses Deployments, mit den Installationen des Aufrufers |
| GET | `/v1/plugins/{slug}` | Ein Plugin: Capabilities, Egress, Einstellungen, Aktionen, Installation |
| PUT | `/v1/plugins/{slug}/installation` | Installieren, erneut zustimmen oder umkonfigurieren |
| DELETE | `/v1/plugins/{slug}/installation` | Deinstallieren und die Datensätze des Plugins löschen |
| POST | `/v1/plugins/{slug}/queries/{action}` | Eine nur lesende Aktion ausführen (`plugins:read`) |
| POST | `/v1/plugins/{slug}/commands/{action}` | Eine schreibende Aktion ausführen (`plugins:write`) |

Keine Plugin-Route lässt den gemeinsamen öffentlichen API-Key zu: Ein Plugin handelt
auf den Daten genau eines Tenants. Die beiden Aktionsrouten teilen sich ein Budget von
120 Anfragen pro Minute und Consumer.

### Native Plugins: BlindPay und DeFindex

Manche Integrationen sind nicht die Chain selbst — ein Fiat-Anbieter, ein
DeFi-Protokoll — und brauchen, was die Sandbox absichtlich verweigert: eigene
Tabellen, eingehende Webhooks, deploymentweite Zugangsdaten. Das sind **native
Plugins**: Nest-Module, die unter `src/native-plugins/<slug>/` in den Dienst
kompiliert und über dieselbe Liste `PLUGINS_ENABLED` wie isolierte Plugins
eingeschaltet werden.

| Slug | Was es ausliefert |
| ---- | ----------------- |
| `blindpay` | KYC, Onramp, Offramp, den BlindPay-Webhook, seine `/v1/admin`-Routen (`receivers`, `payins`, `payouts`) und den Abschnitt `fiat` der Admin-Übersicht |
| `defindex` | `/v1/defindex` — DeFindex-Vaults auf Stellar |

- **Nicht aufgeführt, nicht vorhanden.** Ein natives Plugin, das `PLUGINS_ENABLED`
  nicht nennt, wird nie instanziiert: seine Routen antworten mit 404, seine Jobs
  starten nie und seine Variablen werden nicht validiert. Der Start warnt, wenn seine
  Schlüssel gesetzt sind, sein Slug aber nicht.
- **Der Kern importiert nie ein Plugin.** Der Lint verweigert `@/native-plugins/*`
  überall in `src/` außer in `src/native-plugins/native-plugins.module.ts` und
  verweigert, dass ein Plugin ein anderes importiert. Wo der Kern Daten eines Plugins
  braucht — die Admin-Übersicht —, stellt er einen Erweiterungspunkt
  (`AdminExtensions`) bereit, in den sich das Plugin einträgt.
- **Weder isoliert noch pro Mandant.** Ein natives Plugin ist geprüfter Code mit den
  Rechten des Kerns; es wird nicht pro Mandant installiert, und seine Routen behalten
  ihre eigenen Scopes (`kyc:*`, `onramp:*`, `offramp:*`, `liquidity:*`). Ein
  isoliertes Plugin darf keinen nativen Slug verwenden.
- **Der OpenAPI-Vertrag dokumentiert die Routen jedes nativen Plugins**, ob
  eingeschaltet oder nicht: `openapi:generate` schaltet alle ein.

## Upgrade — Breaking Changes und Deploy-Hinweise

### Swaps auf Solana und Monad: `chain` auf `/v1/swaps` und eine neue Tabelle

- **Die Migration `20261003120000_chain_swaps`** legt die Tabelle `chain_swap` an.
  Nichts Bestehendes ändert sich: `/v1/swaps` ohne `chain` antwortet Byte für Byte
  wie bisher.
- **`/v1/swaps` nimmt `chain`** (`stellar` | `solana` | `monad`) in den Bodies von
  Quote und Create sowie als Query-Parameter der Liste. Für Solana und Monad
  antworten Create, der Einzelabruf und Submit mit einer `ChainSwapEntity`
  (`oneOf` im Vertrag).
- **`POST /v1/swaps/{id}/submit`:** `signedXdr` ist nicht mehr Pflicht, wenn
  `signedTransaction` gesendet wird. Ein Stellar-Swap braucht es weiterhin, mit
  derselben Meldung.
- **`/v1/cross-chain-swaps` lehnt jetzt jedes Paar auf derselben Chain ab** — früher
  quotierte es Solana → Solana und Monad → Monad über NEAR Intents — und verweist
  auf `/v1/swaps`.
- **Lehnt ein Solana- oder Monad-Node einen Broadcast ab, ist das
  `400 transaction_rejected`**, nicht mehr `502 provider_error`. Das gilt auch für
  den Relayer des Monad-Einzahlungs-Forwarders, der wie bisher loggt und es erneut
  versucht.
- **Vor dem Aktivieren:** `SOLANA_SWAP_FEE_WALLET` setzen und dessen Token-Konto für
  jede erwartete Output-Mint anlegen, `MONAD_SWAP_FEE_WALLET` setzen und für
  Produktionsvolumen einen `KURU_API_KEY` besorgen.

### Chain-übergreifende Swaps: ein neues Modul, eine neue Tabelle und sechs Webhook-Events

- **Die Migration `20261002120000_cross_chain_swaps`** legt die Tabelle
  `cross_chain_swap` an und hängt sechs Werte an `WebhookEventType` an:
  `CROSS_CHAIN_SWAP_CREATED`, `_UPDATED`, `_SUCCEEDED`, `_REFUNDED`, `_FAILED`,
  `_EXPIRED`. Nichts Bestehendes wird umgeschrieben.
- **Neue Routen unter `/v1/cross-chain-swaps`**, die die Scopes `swaps:read` /
  `swaps:write` wiederverwenden; der gemeinsame öffentliche Key erreicht assets,
  quote, create und deposit, nie die beiden Lesezugriffe.
- **Vor dem Aktivieren:** `NEAR_INTENTS_FEE_RECIPIENT` (ein NEAR-Konto) setzen, sonst
  antwortet jeder Plan mit Provision mit `503 misconfigured`, und
  `NEAR_INTENTS_API_KEY` setzen, sonst erhebt 1Click eine eigene Gebühr und behält die
  Hälfte der Provision.
- **`provider_error` ist jetzt auch ein `400`**: Lehnt NEAR Intents ein Quote ab
  ("amount is too low for bridge"), kann der Aufrufer das ändern, daher kommt es als
  `400 provider_error` mit dem Grund von 1Click an, wie schon ein 4xx von BlindPay.
### Wallet-Backups: Argon2id und Verschlüsselung im Ruhezustand

- **Setzen Sie `WALLET_BACKUP_ENCRYPTION_KEY` vor dem Deployment**
  (`openssl rand -base64 32`); der Start verweigert eine Anmeldetür ohne ihn. Jede
  gespeicherte Box wird damit erneut verschlüsselt (AES-256-GCM, an ihr `chain:address`
  gebunden), sodass ein Dump, eine Replik oder ein Backup der Datenbank keine Kopie von
  jemandes Backup ist. Führen Sie danach einmal **`npm run backups:reencrypt`** aus: Es
  verschlüsselt die zuvor geschriebenen Zeilen. Rotation: alten Schlüssel nach
  `WALLET_BACKUP_ENCRYPTION_PREVIOUS_KEYS` verschieben, neuen setzen, Skript ausführen, alten
  entfernen.
- **`v: 4`-Boxen werden akzeptiert**: die Slot-Form von v3 mit einer Argon2id-Passworttür
  (`kdf: "argon2id"`, `m` ≥ 19 MiB, `t` ≥ 2). Die Wallet versiegelt jedes neue Backup als v4
  (64 MiB, 2 Durchläufe) und versiegelt eine reine Passwort-v2/v3-Box bei der
  Wiederherstellung erneut als v4. v2 und v3 werden weiter akzeptiert und ausgeliefert.
- **Die Wallet verlangt ein 12-stelliges Passwort**, das nicht gängig ist; bestehende
  Passwörter funktionieren weiter, bis sie geändert werden.
- **Die Datenbank selbst** braucht weiterhin Verschlüsselung auf Speicherebene (Festplatte /
  Volume), verschlüsselte Backups und auf diesen Dienst beschränkten Zugriff: Der
  Ruheschlüssel schützt die Backup-Spalte, nicht die übrigen Zeilen.

### Wallet-Backups: eines pro Wallet, alle bei der Anmeldung wiederhergestellt

- **Die Migration `20261001120000_wallet_backups_per_wallet`** ersetzt die Regel „ein Backup
  pro Konto“ durch „eines pro `(chain, address)` im Konto“. Bestehende Zeilen bleiben
  unverändert.
- **`POST /v1/wallet/auth/oauth/claim` und `email/verify` liefern `backups`**, alle Boxen des
  Kontos, die neueste zuerst. `backup` bleibt als die neueste erhalten und ist veraltet.
- **`POST /v1/wallet/auth/finish` mit einem `backup` für ein anderes Wallet fügt es hinzu**;
  es antwortet nicht mehr `backup_conflict`. Eine Box desselben Wallets ersetzt dessen eigene.
  `replaceBackup` wird akzeptiert und ignoriert. Bis zu 20 Wallets pro Konto; das 21. ist
  `400 wallet_backup_limit`.

### Die Entwicklerplattform verlässt den Anfragepfad

- **Entfernte Variablen:** `WALLET_AUTH_CONSOLE_URL`, `WALLET_AUTH_CONSOLE_SECRET`,
  `RECOVERY_EMAIL_DELIVERY_URL`, `RECOVERY_EMAIL_DELIVERY_SECRET`. Sie werden
  ignoriert.
- **Die E-Mail-Tür braucht jetzt** `MAIL_FROM` + `MAIL_RESEND_API_KEY` / `MAIL_SMTP_*` (einen bei
  Resend verifizierten Absender) **und** `APISIX_ADMIN_URL` + `APISIX_ADMIN_KEY`. Ohne
  beide meldet `GET /v1/wallet/auth/providers` `email: false`; eine Anmeldung über
  einen Provider schließt den Callback zwar ab, aber `POST /v1/wallet/auth/finish`
  antwortet `503 misconfigured`, bis das Admin-Paar gesetzt ist. Jedes Paar wird
  gemeinsam gesetzt, sonst verweigert der Start.
- **Ein Wiederherstellungsserver, der Codes per E-Mail versandte,** setzt
  `RECOVERY_EMAIL_CODES=true` und sein eigenes `MAIL_*`. `APISIX_ADMIN_KEY` auf einem
  Wiederherstellungsserver verhindert den Start.
- **Neue Route `GET /v1/public-key`** (`@Public()`), gespeist aus
  `PUBLIC_API_KEY_DEV` / `PUBLIC_API_KEY_PROD`: Übernehmen Sie die Werte, die die
  Plattform für den öffentlichen Key ausgestellt hat. Fügen Sie den Pfad der
  schlüssellosen APISIX-Route hinzu (ohne `key-auth`), sonst erhalten Wallets `401`.
- **Wallet-Keys liegen jetzt unter `cosmos_wallet_<accountId>`**; zu den von der
  Plattform provisionierten Konten siehe den Abschnitt oben. Die Antwortformen
  bleiben unverändert.
- **`POST /v1/wallet/auth/finish` ohne `backup`** verbindet die signierende Wallet mit dem Konto und liefert dessen Keys: Es antwortet nicht mehr `backup_conflict`, wenn das Konto eine andere Wallet sichert, und verschiebt die `address` des Kontos nicht mehr. Mit `backup` hat sich nichts geändert. So verbindet sich jetzt eine aus einer Seed importierte Wallet mit Cosmos Pay.
- **`POST /v1/aliases/{name}/recovery` steht Keys mit `payments:write` offen, auch dem gemeinsamen öffentlichen Key**, und antwortet nur `{ accepted: true }`: Dieser Dienst versendet das Token selbst per E-Mail, daher fallen `token`, `email` und `expiresAt` aus der Antwort weg und die Plattform-Konsole ist nicht mehr beteiligt (die Route liefert kein `403 admin_console_only` mehr). Benötigt `MAIL_*`; ohne antwortet die Route `503 misconfigured`.
- **Keine Migration.**

### Solana und Monad; BlindPay und DeFindex werden native Plugins

- **Die Migration `20260930120000_multichain`** fügt `payment_intent`,
  `alias_address`, `alias_challenge`, `wallet_account` und `wallet_backup` die Spalte
  `chain` (Standard `stellar`) hinzu, dazu `assetDecimals`, `chainReference` und
  `chainCursor` in `payment_intent`, und erweitert den eindeutigen Index der
  Alias-Adressen auf `(aliasId, chain, network, address)`. Jede bestehende Zeile
  bleibt Stellar; nichts wird umgeschrieben.
- **BlindPay (KYC, Onramp, Offramp) und DeFindex werden nur ausgeliefert, wenn
  `PLUGINS_ENABLED` `blindpay` / `defindex` aufführt.** Ein Deployment, das ihre
  Schlüssel gesetzt hatte und die Slugs nicht ergänzt, verliert `/v1/kyc`,
  `/v1/onramp`, `/v1/offramp`, `/v1/blindpay/webhooks`, `/v1/defindex` und die
  BlindPay-Routen unter `/v1/admin` (404), und der Start protokolliert eine Warnung
  mit dem Slug. Setzen Sie vor dem Deployment z. B.
  `PLUGINS_ENABLED=blindpay,defindex`. Routen, Scopes, Tabellen und Antworten bleiben
  ansonsten unverändert.
- **Die BlindPay-Variablen werden beim Start des Plugins geprüft**, nicht von der
  Umgebungsvalidierung: eine halb konfigurierte Instanz verhindert den Start
  weiterhin, aber nur dort, wo `blindpay` eingeschaltet ist.
- **`GET /v1/admin/summary` enthält `fiat` nur mit eingeschaltetem `blindpay`**,
  und `GET /v1/admin/consumers` zählt `blindpayReceivers`, `payins` und `payouts` nur
  dann. Das `volume` der Übersicht beschriftet eine Solana- oder Monad-Zeile als
  `<chain>:<asset>`.
- **Neue Antwortfelder** (additiv): `chain` und `chainReference` an
  Zahlungsabsichten; `chain` an Alias-Adressen, Auflösungen und by-address-Zeilen;
  `chain` und `address` an Wallet-Backups, neben `stellarAddress`; `chain` an den
  Zeilen `volume`, `recent` und den Salden des Dashboards, die jetzt je Chain
  gruppiert werden — SOL und MON fallen nicht mehr mit XLM zusammen.
- **`txHash` akzeptiert die Form jeder Chain** bei `validate` und `PATCH` und wird
  gegen die Chain der Absicht geprüft (sonst `400 validation_failed`). Nur Hex wird
  kleingeschrieben; eine Solana-Signatur wird so gespeichert, wie sie ankommt.
- **Die Alias-Auflösung ohne `?chain=` liefert nur Stellar-Adressen.**
- **Neue Variablen**, alle optional (öffentliche RPCs als Standard):
  `SOLANA_RPC_URL_MAINNET`, `SOLANA_RPC_URL_DEVNET`, `SOLANA_RPC_TIMEOUT_MS`,
  `MONAD_RPC_URL_MAINNET`, `MONAD_RPC_URL_TESTNET`, `MONAD_RPC_TIMEOUT_MS`,
  `MONAD_LOG_BLOCK_RANGE`. Der Beobachter fragt jetzt auch Solana und Monad nach
  offenen Absichten auf diesen Chains ab.
- **`/wallet/console/provision` der Entwicklerplattform** erhält jetzt `chain` und
  `address` sowie `stellarAddress: null` bei einer Solana- oder Monad-Anmeldung; sie
  muss das akzeptieren, bevor Wallets diese Chains anbieten.
- **Monad-Einzahlungsadressen** sind nur mit `MONAD_RELAYER_PRIVATE_KEY` aktiv;
  die Migration legt zusätzlich `evm_deposit_address` an, und Absichten erhalten
  `networkFee`. Ohne den Schlüssel verhalten sich Monad-Absichten wie bisher
  (Zahlung direkt an den Händler).
- **Keine Änderung an APISIX.**

### Plugins: ein neues Modul, zwei neue Tabellen und zwei neue Scopes

`/v1/plugins` ist neu; keine bestehende Route und keine Antwort hat sich geändert. Beim
Deployment:

- **Die Migration `20260929120000_plugins`** legt `plugin_installation` und
  `plugin_record` an. Keine Core-Tabelle ändert sich.
- **Die Scopes `plugins:read` und `plugins:write` sind neu.** Bestehende Keys haben sie
  nicht und erhalten `insufficient_scope`; vergib sie über die Entwicklerplattform.
- **Nichts läuft, bevor `PLUGINS_ENABLED` ein Plugin auflistet**, und dann nur für die
  Tenants, die es installiert haben. `plugins/example` ist vorinstalliert und
  deaktiviert.
- **`typescript` ist jetzt eine Laufzeitabhängigkeit**: Die `index.ts` der Plugins wird
  beim Start transpiliert. Entferne es nicht aus Produktionsinstallationen.
- **Setze `PLUGINS_SECRET`**, bevor du ein Plugin mit geheimen Einstellungen
  aktivierst — sonst verweigert der Start. `PLUGINS_TRUSTED_KEYS` fügt Signierer neben
  denen des Supports hinzu.
- **Liefere den Ordner `plugins/` mit dem Build aus.** Er wird beim Start aus dem
  Arbeitsverzeichnis gelesen, neben `dist/`; ein Deployment, das nur `dist/` und
  `node_modules/` kopiert, stellt keine Plugins bereit, und ein aktiviertes bricht den
  Start ab.
- **Node muss mit `--no-node-snapshot` laufen, wenn ein Plugin aktiviert ist** — die
  Sandbox (`isolated-vm`, ein natives Modul) verlangt es, sonst verweigert der Start.
  Alle npm-Skripte übergeben es (`start`, `start:prod`, `test`, …); ein anders
  gestarteter Prozess braucht es im Befehl oder in `NODE_OPTIONS`.
- **Keine APISIX-Änderung:** Die Catch-all-Route leitet `/v1/plugins` bereits weiter.
- **Neue Fehlercodes:** `plugin_not_installed`, `plugin_consent_mismatch`,
  `plugin_rejected`, `plugin_quota_exceeded`, `plugin_failed`.

### Pollar wurde entfernt

Alles unter `/v1/pollar` ist entfallen — die OAuth-Bridge (`/v1/pollar/oauth/*`), die
Wallet- und Trustline-Bereitstellung (`/v1/pollar/wallets/*`) und `/v1/pollar/users` —
zusammen mit den Fehlercodes `pollar_identity_required`, `pollar_identity_mismatch` und
`elevated_key_required` sowie allen `POLLAR_*`-Variablen. Die Routen antworten jetzt mit `404`.

- **Die Migration `20260927120000_remove_pollar`** löscht `pollar_oauth_session` und
  `pollar_user_wallet`. Sie lässt sich nicht rückgängig machen: Sichern Sie die beiden
  Tabellen vorher, wenn Sie deren Verlauf brauchen.
- **Löschen Sie die APISIX-Routen für `/v1/pollar/*`**, insbesondere die Callback-Route
  ohne key-auth, und entfernen Sie die `POLLAR_*`-Variablen — sie werden ignoriert.
- **Keys können weiterhin `pollar:*`-Scopes tragen.** Nichts prüft sie mehr.
- **Die Advisory-Lock-IDs `881_005` und `881_007` sind außer Dienst** und werden nie
  wiederverwendet.
- **Wallets:** Die Cosmos Wallet entfernt jede Pollar-Wallet beim nächsten Start vom Gerät.
  Das Guthaben bleibt bei Pollar, unter derselben Adresse.

### Korrekturen aus dem Security-Review

Die meisten dieser Änderungen betreffen einen sich korrekt verhaltenden Aufrufer nicht;
prüfen Sie vor dem Deployment die Spalte „Wer es bemerkt“.

| Änderung | Wer es bemerkt | Warum |
| -------- | -------------- | ----- |
| `POST /v1/aliases/:name/recovery` ist **nur für die Plattform-Konsole**: Ein API-Key erhält `403 admin_console_only`, und die Route wurde aus dem veröffentlichten Vertrag entfernt | Jeder, der Wiederherstellungen mit einem API-Key gestartet hat | Die Antwort enthält das Wiederherstellungs-Token, das die Kontrolle über das Postfach des Inhabers belegt |
| Das Abschließen einer Wiederherstellung für einen `SUSPENDED`-Alias ergibt `404` | Niemand mit legitimen Absichten | Ein vor einer Sperre ausgestelltes Token konnte die Sperre durch den Operator umgehen |
| `@Public()`-Routen (BlindPay-Webhook, Health) ignorieren `X-Consumer-Username` | Dashboards: Diese Anfragen werden jetzt als anonym protokolliert | Diese Routen haben kein key-auth, der Header kam also vom Client |
| Ablehnungen durch `AdminGuard` und `ConsoleOnlyGuard` werden auf `warn` protokolliert | Operatoren | Guards laufen vor dem Access-Log, sodass abgewiesene Anfragen keine Spur hinterließen |
| Beide `POST …/trustlines`-Routen teilen sich ein `429`-Budget von 20 Aufrufen pro 10 Minuten | Skripte, die Trustlines massenhaft hinzufügen | Jede Trustline bindet 0.5 XLM aus der Funding-Wallet des Operators |
| `GET /v1/offramp/payouts/:id` liefert `raw`, `consumerId`, `receiverId`, `quoteId`, `bankAccountId` und `updatedAt` nicht mehr; die Antwort beim Anlegen eines virtuellen Kontos liefert `raw`, `receiverId`, `consumerId` und `updatedAt` nicht mehr | Aufrufer, die diese Felder lesen | `raw` ist das gespeicherte Objekt von BlindPay mit Bank- und Begünstigtendaten |
| `POST /v1/kyc/upload` liefert `400` bei mehr als 4 Textfeldern, einem Feld über 1 KiB, einer zweiten Datei oder Dateibytes, die nicht zum deklarierten Typ passen | Niemand, der einen wohlgeformten Upload sendet | Felder waren unbegrenzt, und die Typprüfung vertraute dem `Content-Type` des Clients |
| `POST /v1/payment-intents/tx` und `/pay`: Dasselbe Memo mit irgendeiner abweichenden Kondition ergibt `409 idempotency_conflict`. Ein identischer Wiederholungsversuch liefert weiterhin den gespeicherten Intent (`2` und `2.0` sind derselbe Betrag) | Aufrufer, die ein Memo für verschiedene Zahlungen wiederverwenden | Unter dem gemeinsamen öffentlichen Key gab ein Memo, das jemand anderes zuerst angelegt hatte, dessen Intent zurück |
| `POST /v1/payment-intents/:id/validate` setzt `FAILED` nur bei einer fehlgeschlagenen Transaktion, die die eigene Zahlung dieses Intents ist; jede andere fehlgeschlagene Transaktion ergibt `valid: false` bei unverändertem Status. Eine Transaktion, die mehr als 60 s vor dem Anlegen des Intents abgeschlossen wurde, wird abgewiesen ("Transaction predates this payment intent") — bei validate, bei `PATCH {status: SUCCEEDED}` und im Observer | Niemand mit legitimen Absichten | Jede beliebige fehlgeschlagene Transaktion konnte einen Intent scheitern lassen, und eine alte Zahlung mit denselben Konditionen konnte einen neuen begleichen |
| `PATCH /v1/payment-intents/:id`, das `txHash` bei einem Intent in einem Endzustand ändert, ergibt `400 invalid_state_transition`; eine Statusänderung, die mit dem Schreibvorgang konkurriert, ergibt `409 operation_in_flight` | Niemand mit legitimen Absichten | Es konnte den Abwicklungsnachweis eines `SUCCEEDED`-Intents überschreiben |
| Der Payment-Intent-Observer gleicht pro Tick höchstens 10 Intents pro Consumer ab und durchsucht nie abgelaufene Zeilen | Operatoren, die den Durchsatz des Observers beobachten | Ein einzelner Consumer konnte die Abwicklung aller anderen Mandanten verzögern |
| `POST /v1/swaps`, `/v1/liquidity-pools/deposit` und `/withdraw`: Ein wiederverwendeter `Idempotency-Key` mit einer abweichenden Anfrage — einem anderen Memo oder einer anderen Slippage, dem anderen Netzwerk oder einem für eine Auszahlung wiederverwendeten Einzahlungs-Key — ergibt `409 idempotency_conflict`. Eine Wiederholung mit ungültigem Asset, ungültiger Slippage oder ungültigem Memo erhält jetzt das normale `400` | Clients, die einen Key für verschiedene Operationen wiederverwenden | Unter dem gemeinsamen öffentlichen Key konnte jemand unter einem erratbaren Key vorab einen Envelope anlegen, der dann beim Wiederholungsversuch eines anderen Benutzers zurückgegeben wurde |
| `POST /v1/liquidity-pools/withdraw` antwortet nicht mehr mit `409 operation_in_flight` auf eine laufende Auszahlung, deren Sequenznummer das Konto noch nicht verwendet hat (ein unsignierter oder aufgegebener Envelope) | Wallet-Benutzer, die blockiert waren | Ein für das Konto eines anderen gebauter Envelope konnte Auszahlungen aus dieser Position unbegrenzt blockieren |
| Der Settlement-Observer übernimmt pro Tick höchstens 10 Zeilen pro Consumer pro Tabelle, und `GET /v1/liquidity-pools/positions` liest Horizon über eine einzige paginierte Auflistung statt über eine Anfrage pro Pool | Operatoren | Ein einzelner Consumer konnte die Abwicklung aller anderen verzögern, und viele Pool-Anteile bedeuteten unbegrenzt viele Horizon-Aufrufe |
| `GET /v1/onramp/payins/:id` liefert `receiverId` und `updatedAt` nicht mehr — dieselbe Form, die `GET /v1/onramp/payins` liefert | Aufrufer, die diese beiden Felder aus dem Einzelabruf eines Payins lesen | Derselbe Payin konnte in zwei Formen zurückkommen |
| `POST /v1/kyc/upload` mit einer Datei über 10 MiB ergibt `413` mit `code: "payload_too_large"`; bisher war es `internal_error` | Integratoren, die nach `code` verzweigen | Es ist ein Limit auf Seiten des Clients, kein Serverfehler |
| `POST /v1/liquidity-pools/deposit`, `/withdraw`, `GET /v1/liquidity-pools/operations`, `/operations/:id`, `POST /v1/liquidity-pools/operations/:id/submit` und die `LIQUIDITY_*`-Webhooks enthalten jetzt `memo` (die MEMO_ID des Aufrufers oder `null`). Operationen, die vor der Migration `20260915120000_liquidity_pool_operation_memo` erstellt wurden, liefern `null`, auch wenn ihr Envelope eine trägt | Niemand, außer ein Client lehnt unbekannte Felder ab | Das Memo war nur im XDR gespeichert |
| Der veröffentlichte Vertrag für `GET /v1/swaps` und `GET /v1/liquidity-pools/operations` führt `qr` und `commissionMemo` bei Listeneinträgen nicht mehr auf. Die Antworten bleiben unverändert — diese beiden Felder wurden dort nie gesendet; man erhält sie über den Einzelabruf | Aus der OpenAPI-Spezifikation generierte Clients | Der Vertrag beschrieb Listeneinträge in der Form des Einzelabrufs |
| Der Dienst verweigert den Start, wenn `APISIX_GATEWAY_SECRET` ein Platzhalter ist — der Wert, den `.env.example` früher auslieferte, oder alles, was `replace-with`, `change-me`, `your-secret` oder `placeholder` enthält —, und `.env.example` lässt sie jetzt leer | Deployments, die noch den aus `.env.example` kopierten Wert verwenden | Dieser Wert ist öffentlich und lang genug, um die 32-Zeichen-Untergrenze zu erfüllen, sodass jeder, der den Dienst erreichen konnte, jeden beliebigen Consumer benennen und `/v1/admin` erreichen konnte |
| Der Dienst verweigert den Start, wenn `BLINDPAY_WEBHOOK_SECRET` gesetzt ist, sein Schlüssel (das Base64 nach `whsec_`) aber fehlgeformt ist oder zu weniger als 24 Byte dekodiert, und `POST /v1/blindpay/webhooks` weist jede Zustellung ab, solange der konfigurierte Schlüssel unbrauchbar ist | Deployments mit einem abgeschnittenen oder falsch getippten Secret, deren BlindPay-Webhooks bereits fehlschlugen | Node dekodiert ungültiges Base64 ohne Fehler zu einem kurzen oder leeren HMAC-Schlüssel, und eine mit einem leeren Schlüssel signierte Zustellung kann von jedem gefälscht werden |
| `GET /v1/health/readiness` beantwortet eine fehlgeschlagene Prüfung mit dem Standard-Fehlerumschlag (`error: "Service Unavailable"`); früher legte sie den Health-Report, einschließlich der Datenbank-Fehlermeldung, in `error` ab | Probes, die den Report aus dem Body statt aus dem Statuscode lesen | Die Route ist `@Public()`, und die Meldung von Prisma nennt Datenbank-Host und -Benutzer |
| `POST /v1/onramp/receivers/:id/virtual-accounts` ergibt `403 account_disabled`, wenn der Receiver oder der Receiver, dem `blockchain_wallet_id` gehört, deaktiviert ist | Niemand mit legitimen Absichten | Es war die eine Fiat-Operation, die der Kill-Switch nicht abdeckte: Ein deaktiviertes Konto konnte weiterhin eine neue Einzahlungs-Rail eröffnen |
| `POST /v1/swaps/:id/submit` und `POST /v1/liquidity-pools/operations/:id/submit` prüfen den Envelope vor allem anderen: Ein Body, der sich nicht parsen lässt, nicht der Envelope der Zeile ist oder keine Signaturen trägt, ergibt `400 validation_failed`, unabhängig vom Status der Zeile. Ein beliebiges `signedXdr` liefert keine `SUCCEEDED`-Zeile mehr, und eine `EXPIRED`-Zeile beantwortet einen nicht passenden Body mit `validation_failed` statt mit `invalid_state_transition` | Clients, die das unsignierte `xdr` eingereicht und sich auf die Ablehnung mit `tx_bad_auth` verlassen haben | Signaturen ändern den Hash einer Transaktion nicht, sodass der unsignierte Envelope in einer Schleife weitergeleitet und abgelehnt werden konnte, und unter dem gemeinsamen öffentlichen Key genügte allein die ID einer Zeile, um eine abgewickelte Zeile zu lesen |
| Beide Submit-Routen weisen einen Envelope ab, dessen Zeitgrenzen überschritten sind (`400 invalid_state_transition`, wird nicht gesendet; landete er dennoch, wickelt ihn der Observer trotzdem ab), sowie eine `FAILED`-Zeile, die bereits 3-mal erneut eingereicht wurde (`400 invalid_state_transition`: bauen Sie eine neue). Ein Wiederholungsversuch nach `503 provider_unavailable` zählt nicht mit | Clients, die Submit in einer Schleife wiederholen: Halten Sie bei `invalid_state_transition` an | Jeder abgelehnte Wiederholungsversuch war eine Horizon-Einreichung und ein neues terminales Webhook-Event, ohne Obergrenze |
| Beide Submit-Routen erlauben 20 Aufrufe pro Minute pro Consumer und Client-Adresse, in getrennten Kontingenten (`429 rate_limited`) | Wallets hinter demselben NAT, die sich den öffentlichen Key teilen | Die Routen nehmen den gemeinsamen öffentlichen Key an, und jeder Aufruf kann an Horizon senden |
| `GET /v1/webhooks`, `GET /v1/webhooks/:id` und `PATCH /v1/webhooks/:id` liefern nur die dokumentierten Endpunktfelder; `POST /v1/webhooks` und `POST /v1/webhooks/:id/rotate-secret` liefern diese plus `secret`. `consumerId`, `previousSecret` und `previousSecretExpiresAt` sind bei allen fünf entfallen | Aufrufer, die diese Felder lesen | `previousSecret` ist ein Signatur-Secret, das ein Integrator noch akzeptieren kann, und ein Key mit nur `webhooks:read` konnte es lesen |
| Ein Wiederherstellungs-Token, das zu keiner laufenden Wiederherstellung des Alias passt, zählt nicht mehr gegen sie. Ein laufendes Token verbraucht bei jeder Vorlage einen Versuch, auch wenn dessen Challenge oder Signatur anschließend fehlschlägt; nach fünf ist es `400 alias_recovery_invalid` | Niemand mit legitimen Absichten | Alias-Namen sind öffentlich, sodass fünf Datenmüll-Tokens von einem beliebigen Key jede von der Konsole gestartete Wiederherstellung verbrauchten |
| `POST /v1/aliases/:name/recovery/complete` (10 pro 10 min), `POST /v1/aliases/challenges` (30), `POST /v1/webhooks/:id/ping` (20) und `POST /v1/webhooks/:id/deliveries/:deliveryId/redeliver` (30) ergeben bei Budgetüberschreitung `429 rate_limited`, pro Consumer und Client-Adresse | Skripte, die diese Routen in einer Schleife aufrufen | Jeder Aufruf speichert eine Zeile, probiert ein Wiederherstellungs-Token oder sendet Anfragen an eine vom Aufrufer gewählte URL |
| `PATCH /v1/payment-intents/:id` verlangt, dass `txHash` ein 64-stelliger Hex-Stellar-Transaktions-Hash ist (alles andere ergibt `400`), und speichert ihn kleingeschrieben; `POST /v1/payment-intents/:id/validate` schreibt seinen eigenen ebenfalls klein. Ein Hash ist nur unter den Intents eines Consumers eindeutig statt mandantenübergreifend, und ein Hash, der bereits auf einem anderen Ihrer Intents liegt, ergibt `409 idempotency_conflict` (früher `500`) | Aufrufer, die Platzhalter- oder abgeschnittene Hashes senden | Jeder Mandant konnte den Transaktions-Hash eines anderen Mandanten auf einem eigenen Intent ablegen; die Abwicklung des anderen Mandanten traf dann auf den globalen Index, antwortete mit `500`, und der bezahlte Intent lief ab, ohne dass `PAYMENT_INTENT_SUCCEEDED` ausgelöst wurde |
| Ein `EXPIRED`-Intent wechselt nach `SUCCEEDED`, wenn seine Zahlung on-chain bestätigt wird: durch den Observer, der jetzt vor dem Ablaufen die Chain prüft, oder durch `POST /v1/payment-intents/:id/validate` und `PATCH {status: SUCCEEDED}`, die jetzt mit `200` statt mit `400 invalid_state_transition` antworten. `PAYMENT_INTENT_SUCCEEDED` kann auf das von `EXPIRED` ausgelöste Update folgen | Webhook-Consumer, die `EXPIRED` als endgültig behandeln | Der Ablauf prüfte nie die Chain, und der Verifier las nur die 50 neuesten Zahlungen an die Zieladresse, sodass eine späte oder vergrabene Zahlung einen bezahlten Intent dauerhaft `EXPIRED` ließ |
| Antworten zu Swaps, Liquidity-Pool-Operationen, Payment Intents und Customers enthalten nur noch ihre dokumentierten Felder, plus das jetzt dokumentierte `expiresAt` bei Swaps und Payment Intents. `consumerId` und die Settlement-Buchführung (`settlementEpoch`, `lastCheckedAt`, `notFoundStreak`, `sharesReceived`, `settledAmountA`/`B`, `horizonCursor`) werden nicht mehr gesendet | Wer diese Felder liest | Sie sind intern, und mehrere dieser Routen sind mit dem gemeinsamen öffentlichen Key erreichbar |
| `PATCH /v1/kyc/receivers/:id` auf einen Receiver, der bereits bei BlindPay existiert, ist `403 kyc_review_required` für jedes Feld außer `external_id` und `image_url`, es sei denn, der Key ist erhöht (`X-Consumer-Role: admin`) | Integratoren, die die Identität eines aktiven Receivers mit einem Tenant-Key korrigieren: über den Prüfer leiten | Das `PUT` schickte nie geprüfte Identitätsdaten direkt an einen regulierten Anbieter, während dieselbe Änderung vor dem Aktivieren erneut in die Prüfung geht |
| BlindPay-Routen nutzen die Instanz der Key-Umgebung: `prod`-Keys die der unsuffigierten `BLINDPAY_*`-Variablen, `dev`-Keys die von `BLINDPAY_*_DEV`, und ein `dev`-Key ohne konfigurierte Entwicklungsinstanz erhält `503 misconfigured`. Receiver, Wallets, Bankkonten, virtuelle Konten, Quotes, Payins und Payouts werden nur auf dieser Instanz gelesen und ausgeführt | Alle, die BlindPay mit `dev`-Keys nutzen | Ein `dev`-Key bediente die Produktionsinstanz: Er konnte echte KYC-Identitäten auflisten und löschen und echte Payouts anlegen |
| Ein Testnet-Login stellt seinem Benutzer keine Mainnet-Wallet mehr bereit: `network_wallets` einer Testnet-Einlösung listet nur die Testnet-Wallet. Ein Mainnet-Login stellt weiterhin Testnet bereit | Wer einen Mainnet-Eintrag aus einem Testnet-Login liest | Ein `dev`-Key, den jeder erzeugen kann, gab pro Login echte XLM des Betreibers für eine Mainnet-Reserve aus |
| `POST /v1/kyc/receivers/:id/approve` nimmt `expected_version` entgegen (die gelesene `dossierVersion`) und antwortet `409 kyc_state_invalid`, wenn sich die KYC-Daten seitdem geändert haben. `POST /v1/kyc/receivers/:id/enable` weist ein Dossier ab, das nicht das genehmigte ist, und Receiver-Reads liefern `dossierVersion` und `reviewedVersion` | Prüfer, sobald sie `expected_version` senden; sonst niemand — das Feld ist optional | Eine Prüfung ist ein Mensch, der die Daten liest und danach genehmigt, und eine Änderung dazwischen belässt den Status auf `pending_review` — die Genehmigung traf also ein Dossier, das niemand gesehen hatte, und `enable` schickte es an einen regulierten Anbieter |
| `POST /v1/kyc/upload`, `/v1/kyc/terms-of-service`, die Schreibvorgänge von Onramp und Offramp, `POST /v1/payment-intents/tx` und `/pay`, `POST /v1/swaps/quote` und `/v1/swaps` sowie `POST /v1/liquidity-pools/deposit` und `/withdraw` antworten über Budget jetzt `429 rate_limited`, pro Consumer und Client-Adresse. Jede BlindPay-gestützte Route zählt zusätzlich gegen eine Obergrenze pro Consumer von 60 Anbieteranfragen pro Minute | Skripte, die diese Routen in Schleifen aufrufen; ein Massenimport über der Obergrenze sollte einen eigenen Key haben | Sie hatten überhaupt kein Limit: Jede hinterlässt entweder etwas beim Anbieter, das kein Fehler zurückholt, oder verbraucht das Horizon-Budget pro IP, das sich alle Routen hier teilen. Begrenzt waren nur die Submits |
| `POST /v1/swaps` antwortet nicht mehr `409 operation_in_flight` für einen `PENDING`-Swap, dessen Sequenznummer das Konto noch nicht verbraucht hat (ein unsignierter oder aufgegebener Envelope). Gilt nur bei `STELLAR_SWAP_SINGLE_INFLIGHT=true` | Wallet-Nutzer, die blockiert waren | Jeder darf jede `source` nennen, ein Staub-Swap fror also ein fremdes Konto ein Timeout-Fenster nach dem anderen ein — das Gegenstück zur Liquiditätspool-Korrektur oben |
| Ein wegen seines Hosts abgelehntes Webhook-Ziel — nicht auflösbar, privat, Link-Local, Metadaten — ist ein `400` mit einer Meldung; der Grund steht im Log des Dienstes. Eine fehlerhafte URL, ein Schema, das nicht https ist, Zugangsdaten oder ein fehlender Host sagen weiterhin, was falsch ist | Integratoren, die den Grund aus der Antwort gelesen haben | Einen Endpunkt zu registrieren löst einen Namen auf, den dieser Dienst erreichen kann — eine Antwort pro Grund ließ das interne Netz eine URL nach der anderen kartieren |
| Eine `redirect_url` wird abgewiesen, wenn sie ein Fragment, einen Backslash, Leerzeichen oder ein Steuerzeichen trägt; https ohne eingebettete Zugangsdaten war bereits Pflicht | Niemand, der eine gewöhnliche URL sendet | `https://app.acme.com\@evil.test` benennt je nach Parser einen anderen Host, und der Wert wird von BlindPay und von einem Browser erneut gelesen |
| `POST /v1/wallet/auth/oauth/claim`: Eine Authentik-Anmeldung, deren E-Mail der Anbieter nicht bestätigt hat (`email_verified` nicht `true`), schließt den Callback ab und antwortet mit `verify_email` und einem Code an dieses Postfach, ob ein Konto existiert oder nicht, statt mit `email_unverified` zu scheitern. Dabei wird kein ID-Token herausgegeben, sie kann also keine SEP-30-Wiederherstellung starten, und sie teilt die Sperrfrist pro Adresse von `POST /v1/wallet/auth/email/start` (`400 wallet_login_code_cooldown`). Vorher Migration `20260926120000_wallet_auth_unverified_email` ausführen | Wallets: `verify_email` auch bei einem neuen Konto behandeln | Die Person landete auf einer Sackgassen-Seite; der Code beweist die Adresse, die der Anbieter nicht bestätigt hat |
| `POST /v1/wallet/auth/finish` und `POST /v1/wallet/recovery/setup` lesen das Sitzungstoken aus `X-Wallet-Session: {sessionToken}`. `Authorization: Bearer` wird weiter gelesen, erreicht den Dienst aber nur bei einem direkten Aufruf | Wallets: `X-Wallet-Session` neben dem API-Key senden | Das Gateway entfernt `Authorization` (und `apikey`) vor dem Proxying, daher kam das Token über APISIX nie an und beide Routen antworteten mit `401 wallet_session_invalid` |
| Eine Wallet-Anmeldung über Authentik fordert `max_age=300` statt `prompt=login` an, und das `auth_time` des ID-Tokens muss innerhalb dieser 5 Minuten liegen (sonst scheitert der Callback mit `profile_invalid`). Mit Google / GitHub als Authentik-Quellen `default-source-authentication` auf *Authentication: No requirement* stellen | Betreiber mit Authentik und Social-Quellen | Unter `prompt=login` verlangte Authentik von einem Browser ohne Sitzung zwei Anmeldungen, und die zweite über eine Quelle wurde mit "Flow does not apply to current user" abgelehnt |
| `POST /v1/wallet/auth/finish` und `PUT /v1/wallet/backup` akzeptieren auch eine Backup-Box `v: 3`: der Seed unter einem zufälligen Datenschlüssel, und dieser Schlüssel einmal pro Tür in `slots` versiegelt (`kind: "password"` oder `kind: "passkey"`, höchstens 8). Jede Passwort-Tür unterliegt derselben PBKDF2-Untergrenze wie eine `v: 2`-Box; eine Passkey-Tür hat keine Kosten, weil ihr Schlüssel die WebAuthn-PRF-Ausgabe des Authentifikators ist. `v: 2`-Boxen bleiben unverändert | Wallets: ein Backup nur mit Passkey ist gültig, und eine Wallet, die eines geschrieben hat, braucht diesen Server | Ermöglicht die Wiederherstellung mit einem Passkey statt des ursprünglichen Passworts, ohne dass dieser Dienst je einen Schlüssel hält, der die Box öffnet |
| `POST /v1/wallet/auth/oauth/authorize` akzeptiert ein optionales `returnTo`. Steht es in `WALLET_AUTH_RETURN_URLS`, antwortet `GET /v1/wallet/auth/oauth/callback/{provider}` mit `302` dorthin, mit `?state=…` (plus `&error=<reason>` bei Fehlschlag), statt die Seite zu rendern; ein nicht gelistetes ist `400 wallet_return_url_not_allowed`. Nur der `state` wird übertragen — der Handshake wird weiterhin mit dem PKCE-Verifier eingelöst. Zuerst Migration `20260927180000_wallet_auth_return_to` ausführen | Native Wallets (Desktop und Mobil): `returnTo` senden und diese URL beim Betriebssystem registrieren | Eine Auth-Session der Plattform (`ASWebAuthenticationSession`, ein Custom Tab, ein Desktop-Deep-Link oder Loopback-Listener) schließt sich erst, wenn der Browser eine URL der App erreicht; die Person blieb also auf der Seite und musste sie von Hand schließen |
| `GET /v1/wallet/auth/providers` liefert zusätzlich `mfaSettingsUrl`: die Seite des Authentik-Kontos, auf der eine Person einen zweiten Faktor hinzufügt oder entfernt (Sicherheitsschlüssel oder Passkey, Authenticator-App, Wiederherstellungscodes), ohne Sitzung über die Authentik-Anmeldung; `null` ohne Authentik. Ein zweiter Faktor ist bei der Wallet-Anmeldung optional — `deploy/authentik/wallet-sign-in.yaml` setzt die MFA-Stage auf *skip* zurück, fragt Personen mit einem Faktor nach dem Passwort danach, lässt einen Passkey direkt auf der Benutzernamen-Seite anmelden und bietet allen ohne Faktor nach dem Passwort eine Auswahl an (jetzt nicht, ein Sicherheitsschlüssel, eine Authenticator-App). Außerdem bietet die Registrierungsseite Google / GitHub über dem Formular an. Anmeldung und Registrierung mit Passwort bleiben unverändert | Betreiber mit Authentik: Blueprint importieren. Wallets: die URL als Einstellung anbieten | Ein zweiter Faktor war entweder für alle Pflicht oder unerreichbar: Wallet-Nutzer öffnen nie die Einstellungen von Authentik, die Einrichtungs-Flows lehnen einen Browser ohne Authentik-Sitzung ab, und der Passwordless-Button der Identification-Stage zeigte auf denselben Flow und lud die Seite nur neu |

Dazugehörige Deploy-Hinweise:

- **Migration `20260910120000_aliases`** erstellt `alias`, `alias_address`,
  `alias_challenge` und `alias_recovery`. Führen Sie `migrate deploy` aus, bevor der
  neue Build Traffic bedient.
- **Eine neue Advisory-Lock-ID, `881_008` (`AliasChallengeSweeper`).** Nichts zu
  konfigurieren.
- **Setzen Sie `NODE_ENV=production` in Produktion.** `.env.example` liefert
  `development` aus, und zwei Schutzmaßnahmen hängen davon ab: Eine Anfrage ohne
  `X-Plan-Swap-Fee-Bps` ergibt nur in Produktion `503` (überall sonst fallen Swaps
  stillschweigend auf `STELLAR_SWAP_FEE_BPS` zurück), und `/docs` — außerhalb jedes
  Guards — ist nur in Produktion standardmäßig aus.
- **Die Logzeilen des Settlement-Observers lauten jetzt**
  `Settlement observer started (every Nms)`,
  `Settlement observer (OBSERVER_ENABLED=false) disabled` und
  `SettlementObserverService cycle failed` auf Level `error`. Passen Sie Alerts an, die
  auf den alten Wortlaut prüfen. `OBSERVER_ENABLED`, `OBSERVER_INTERVAL_MS` und der
  Advisory-Lock bleiben unverändert.
- **Migration `20260915120000_liquidity_pool_operation_memo`** fügt die nullbare
  Spalte `liquidity_pool_operation.memo` hinzu: kein Neuschreiben der Tabelle, nur ein
  kurzer exklusiver Lock. Es gibt kein Backfill — das Memo älterer Zeilen steckt in
  base64-XDR, das SQL nicht dekodieren kann, und der Service greift für sie auf das
  Envelope zurück.
- **Zwei Variablen werden jetzt beim Start geprüft.** Ein platzhalterhaftes
  `APISIX_GATEWAY_SECRET` oder ein `BLINDPAY_WEBHOOK_SECRET`, dessen Schlüssel
  nicht zu mindestens 24 Byte dekodiert, hindert den Dienst am Start, mit einer
  Fehlermeldung, die die Variable nennt. Ersetzen Sie ein platzhalterhaftes
  Gateway-Secret auf der APISIX-Route und hier in derselben Änderung
  (`openssl rand -hex 32`); eine Abweichung lässt jede Anfrage fehlschlagen, als
  käme sie nicht vom Gateway.
- **Migration `20260915150000_payment_intent_tx_hash_per_consumer`** ersetzt den
  eindeutigen Index auf `payment_intent."txHash"` durch einen auf
  `("consumerId", "txHash")`. Sie läuft nicht `CONCURRENTLY`: `payment_intent`
  ist während des Indexaufbaus schreibgesperrt. Es gibt kein Backfill.
- **Gespeicherte `webhook_endpoint.previousSecret`-Werte werden nicht mehr
  zurückgegeben, aber nichts löscht sie.** Hat eine Rotation in einem früheren
  Release einen solchen Wert hinterlassen und Sie möchten ihn aus der Datenbank
  entfernen, setzen Sie die beiden Spalten selbst auf null.
- **Migration `20260915160000_blindpay_environment`** fügt den sieben
  BlindPay-Spiegeltabellen `environment` (Standard `'prod'`) hinzu — eine reine
  Katalogänderung ohne Neuschreiben der Tabellen —, sodass bestehende Zeilen als
  Produktion markiert sind. **Zeigten Ihre unsuffigierten `BLINDPAY_*`-Variablen auf
  eine BlindPay-Entwicklungsinstanz**, verschieben Sie sie in die `_DEV`-Variablen
  und markieren Sie die Zeilen um (`UPDATE … SET environment = 'dev'` auf
  `blindpay_receiver`, `blindpay_blockchain_wallet`, `blindpay_bank_account`,
  `blindpay_virtual_account`, `payin`, `payout` und `blindpay_quote`), sonst lesen
  `prod`-Keys sie weiterhin.
- **Konfigurieren Sie die BlindPay-Entwicklungsinstanz** (`BLINDPAY_API_KEY_DEV`,
  `BLINDPAY_INSTANCE_ID_DEV`, `BLINDPAY_WEBHOOK_SECRET_DEV`), wenn `dev`-Keys
  BlindPay nutzen, und richten Sie ihren Dashboard-Webhook auf dieselbe URL
  `/v1/blindpay/webhooks`.
- **Migration `20260915200000_receiver_dossier_version`** fügt `blindpay_receiver` die
  Spalten `dossierVersion` (Standard `1`) und `reviewedVersion` hinzu — nur Katalog,
  kein Tabellen-Rewrite — und füllt `reviewedVersion` für jeden Receiver, der das
  Prüf-Tor bereits passiert hat, damit dessen `enable` weiter funktioniert. Receiver in
  `inactive` oder `pending_review` behalten `NULL`, was die Wahrheit über sie ist.
- **Neue `429` auf Routen, die nie eine geliefert haben.** Die Budgets in der Tabelle
  oben gelten ab dieser Version; ein Client, der KYC-Uploads, Angebote, Payins,
  Payouts, Intent-Bauvorgänge, Swap-Angebote oder Pool-Bauvorgänge in Schleifen
  aufruft, muss `Retry-After` beachten. `RATE_LIMIT_ENABLED=false` schaltet den Limiter
  während eines Vorfalls ab.

### Der OpenAPI-Vertrag listet nur, was jede Route zurückgibt

Auf der Leitung hat sich nichts geändert, wohl aber der veröffentlichte Vertrag.
Erzeugen Sie jeden aus `openapi/openapi.json` generierten Client neu:

- Jede Operation listet nur die Fehler, die sie zurückgeben kann. `409` erscheint nur,
  wo die Route einen eigenen Konflikt dokumentiert, `429` nur an Routen mit
  Rate-Limit, `502`/`503`/`504` nur, wo die Route einen Anbieter aufruft, und die
  Health-Probes listen kein `401`/`403`. Gemeinsame Fehler sind `$ref`s auf
  `components.responses`.
- Jedes Fehlerbeispiel ist für seinen Status echt. Früher zeigte die Spezifikation ein
  einziges `409 idempotency_conflict` unter jedem Status jeder Route.
- `X-Gateway-Secret` und `X-Consumer-Username` bilden eine Security-Anforderung (beide
  Header), mit `Authorization: Bearer` als veröffentlichter Alternative für Aufrufe über
  das Gateway. Früher waren es zwei Alternativen, was Werkzeugen sagte, dass einer der
  beiden Header genüge.
- Das `503` von `GET /v1/health/readiness` ist als Fehler-Umschlag dokumentiert.
  Früher war es als Terminus-Bericht dokumentiert, den der Exception-Filter nie
  zurückgibt.

### NestJS 12, TypeScript 6 und Node 24.9 als Mindestversion

Der Dienst läuft jetzt auf NestJS 12 und TypeScript 6 und **erfordert Node 24.9 oder
neuer** (`engines`; CI pinnt `node-version: 24`). Passen Sie die Deploy-Ziele
entsprechend an.

NestJS 12 wird als ESM veröffentlicht, und Jest kann es nur auf Node >= 24.9 mit
`--experimental-vm-modules` laden, daher rufen die Testskripte Jest direkt über Node auf:

```
"test": "node --experimental-vm-modules node_modules/jest/bin/jest.js"
```

Der veröffentlichte OpenAPI-Vertrag hat durch `@nestjs/terminus@12` reichhaltigere
Health-Schemas erhalten (Status-Enums und `responseTime`). Keine fachliche Route und
kein Schema hat sich geändert.

### Ein gemeinsamer öffentlicher API-Key und der Guard, der ihn eingrenzt

`PublicKeyGuard` (global, nach `PermissionsGuard`) und der Decorator `@AllowPublicKey()`
sind neu. Bestehende Keys sind nicht betroffen. Beim Deployment:

- **Setzen Sie `APISIX_PUBLIC_CONSUMER`** auf den Benutzernamen, den die
  Entwicklerplattform für den öffentlichen Key bereitstellt, und zwar auf jedem
  Deployment, das einen veröffentlicht. Ohne ihn stützt sich der Guard nur auf das
  weitergeleitete `X-Consumer-Role`.
- **Stellen Sie den öffentlichen Key mit `role: public` aus** und nur mit den Scopes,
  die die freigegebenen Routen benötigen. Zusätzliche Scopes wie `kyc:*` würden diese
  Routen nicht öffnen, aber ein Key, den alle besitzen, sollte sie nicht tragen.

Siehe „Der gemeinsame öffentliche API-Key“ oben.

### Das Asset-Register: `GET /v1/assets`

Eine kuratierte Liste der (code, issuer)-Paare, die diese Plattform unterstützt, pro
Netzwerk und mit der ausgebenden Organisation. Sie erfordert keinen Scope, da sie keine
Mandantendaten enthält, aber einen authentifizierten Consumer (der gemeinsame
öffentliche Key funktioniert).

`npm run assets:verify` prüft jede Zeile gegen das Live-Horizon: dass das Paar in seinem
Netzwerk existiert, dass `contract` mit der `contract_id` von Horizon übereinstimmt und
dass die Issuer-Flags zur Chain passen. Führen Sie es aus, wenn Sie das Register
bearbeiten; es braucht Internetzugang und ist deshalb nicht Teil der Unit-Tests.

### Client-Aktivität: ein neues Modul, eine neue Tabelle und zwei neue Scopes

`POST /v1/activity/events` nimmt Telemetrie von der Wallet und dem
Entwickler-Dashboard entgegen; `GET /v1/activity/events` und
`GET /v1/activity/summary` lesen sie aus. Keine bestehende Antwort hat sich geändert.
Beim Deployment:

- **Migration `20260906140000_activity_event`** erstellt `activity_event` (nur
  anhängend, `consumerId`-bezogen, eindeutig auf `(consumerId, eventId)`).
- **Die Scopes `activity:write` und `activity:read` sind neu.** Bestehende Keys erhalten
  sie nicht automatisch und bekommen `insufficient_scope`. Die Entwicklerplattform
  gewährt beide an von der Wallet bereitgestellte Keys und wendet sie bei der Rotation
  erneut an; ergänzen Sie sie bei von Hand ausgestellten Keys.
- **`ACTIVITY_RETENTION_DAYS`** (Standard 30) kommt zum Aufbewahrungs-Job hinzu. Diese
  Zeilen enthalten personenbezogene Daten, wie das Access-Log.

### `429` meldet jetzt `rate_limited`

Ein `429` meldete früher `code: "provider_unavailable"`. Jetzt meldet es
`code: "rate_limited"` (`ApiErrorCode.RateLimited`, Teil der veröffentlichten Enum).
Verzweigen Sie darauf, wenn Sie bei Drosselung erneut versuchen.

### Ein nicht konfiguriertes BlindPay meldet jetzt `misconfigured`

Wenn BlindPay nicht konfiguriert ist, haben sich zwei Antworten geändert:

| Anfrage | Vorher | Jetzt |
| ------- | ------ | ----- |
| Eine Route, die BlindPay aufruft — unter `/v1/kyc`, `/v1/onramp` oder `/v1/offramp` —, während `BLINDPAY_API_KEY` oder `BLINDPAY_INSTANCE_ID` nicht gesetzt ist | `503` `provider_unavailable` | `503` `misconfigured` |
| `POST /v1/blindpay/webhooks`, während `BLINDPAY_WEBHOOK_SECRET` nicht gesetzt ist | `400` `validation_failed` | `503` `misconfigured` |

Beides sind Konfigurationsfehler des Deployments, die ein erneuter Versuch nicht behebt.
Svix wiederholt jede Nicht-2xx-Antwort, die Webhook-Zustellung ändert sich also nicht.

### Geänderte Antwortformate

Drei veröffentlichte Antwortformate haben sich unter `/v1` geändert (es gibt kein
`/v2`); informieren Sie daher die Integratoren, bevor Sie deployen.

| Endpunkt | Vorher | Jetzt | Warum |
| -------- | ------ | ----- | ----- |
| `GET /v1/webhooks` | bloßes Array, stillschweigend auf 100 begrenzt | `{ data, total, take, skip }` | Ergebnisse wurden auf 100 begrenzt, ohne `total` zum Blättern |
| `GET /v1/products` | bloßes Array, gesamte Tabelle | `{ data, total, take, skip }` | Unbegrenzter Lesezugriff |
| `GET /v1/webhooks/:id/deliveries` und die Redelivery-Antwort | enthielten `payload` | `payload` entfernt | Ein `RECEIVER_UPDATED`-Body ist ein vollständiges KYC-Dossier, und diese Routen sind über `webhooks:read` abgesichert, nicht über `kyc:read` |

Aufrufer, die über die Antwort iterieren oder `delivery.payload` lesen, brechen: Lesen
Sie stattdessen `res.data`, und rufen Sie KYC-Details über die KYC-Endpunkte mit einem
Key ab, der `kyc:read` besitzt.

Auch die **Webhook-Bodies** von `RECEIVER_UPDATED` / `PAYIN_*` / `PAYOUT_*` wurden auf
Identität und Zustand eingeschränkt — siehe den Abschnitt zu Webhooks.

### Die Audit-Hardening-Migration

Sie wird als zwei Dateien ausgeliefert, die in dieser Reihenfolge angewendet werden
müssen:

- `20260901120000_audit_hardening` — die Korrektheitsarbeit: eine neue Spalte, ein
  deduplizierendes `DELETE` auf `liquidity_pool_operation`, zwei `UNIQUE`-Indizes, zwei
  neue Tabellen. Das DELETE und der eindeutige Index laufen in einer Transaktion unter
  einem `SHARE ROW EXCLUSIVE`-Lock, sodass Schreiber auf diese Tabelle für einige
  Millisekunden blockieren.
- `20260901120100_audit_hardening_indexes` — neun additive Indizes, `CONCURRENTLY`
  erstellt, sodass das Deployment Schreibvorgänge auf `payment_intent`, `swap`,
  `webhook_delivery` oder `request_log` **nicht** blockiert. Kein Wartungsfenster nötig.

Es sind getrennte Dateien, weil PostgreSQL `CREATE INDEX CONCURRENTLY` innerhalb einer
Transaktion nicht erlaubt und die erste Datei eine braucht.

Schlägt die zweite Datei mittendrin fehl, kann sie einen **ungültigen** Index
hinterlassen, den `IF NOT EXISTS` für vorhanden hält. Finden Sie ihn, löschen Sie ihn
und führen Sie die Migration erneut aus:

```sql
SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE NOT i.indisvalid;
```

### `ADMIN_API_CREDENTIALS` entfällt — `/v1/admin` gehört der Plattform-Konsole

**Löschen Sie die Variable.** Sie wird nicht mehr gelesen, und die zugehörigen
`COSMOS_ADMIN_API_SECRET` / `COSMOS_ADMIN_API_SECRET_READ` in der Entwicklerplattform
entfallen mit ihr.

Sie war eine zweite Admin-Prüfung zusätzlich zur eigenen Rollenprüfung der
Entwicklerplattform, und Deployments, die sie ausgelassen hatten, bekamen bei
mandantenübergreifenden Lesezugriffen aus der Konsole `401 admin_credentials_required`.
Jetzt nimmt `/v1/admin` eine Anfrage nur an, wenn sie von der Plattform-Konsole kommt,
was zwei Dinge in der Anfrage belegen:

1. `X-Gateway-Secret` stimmt mit `APISIX_GATEWAY_SECRET` überein — geprüft von
   `ApisixGuard` wie auf jeder anderen Route. Nur das Gateway und das Konsolen-Backend
   besitzen es.
2. `X-Cosmos-Internal` ist vorhanden. APISIX entfernt den Header aus jeder
   weitergeleiteten Anfrage (`proxy-rewrite.headers.remove`), sodass ein
   API-Key-Aufrufer ihn nicht mitsenden kann; das kann nur ein direkter Aufruf eines
   Backends, das das Gateway-Secret besitzt.

Punkt 2 hängt von der Konfiguration der Gateway-Route im Repository der
Entwicklerplattform ab, nicht von einem Secret, das dieser Dienst hält. Im Gegenzug ist
die Konsole der einzige Ort, der entscheidet, wer Plattform-Admin ist, und Audit-Zeilen
nennen das Konsolenkonto, das gehandelt hat (`cosmos_<userId>`), und seine
Plattformrolle, bei jeder Mutation **und** jedem Lesezugriff.

Was sich für einen Aufrufer ändert:

| Vorher | Jetzt |
| ------ | ----- |
| `401` `admin_credentials_required` ohne Bearer-Secret | `403` `admin_console_only` für alles, was kein Konsolenaufruf ist |
| `403` `admin_role_required` für ein `read`-Credential bei einer Mutation | entfällt — die Konsole hat bereits entschieden, dass das Konto handeln darf |
| `actorId` / `actorRole` in einer Audit-Zeile nannten das Credential | sie nennen das Konsolenkonto und seine Plattformrolle |

Um `/v1/admin` direkt aufzurufen (etwa aus einem Ops-Skript), senden Sie
`X-Gateway-Secret`, `X-Consumer-Username` und `X-Cosmos-Internal: 1`; fügen Sie
`X-Cosmos-Admin-Role: owner` hinzu, um die Audit-Zeile zu kennzeichnen. Halten Sie den
Dienst vom öffentlichen Internet fern.

### `APISIX_GATEWAY_SECRET` erfordert jetzt 32 Zeichen

Mit einem kürzeren Secret verweigert der Dienst den Start. Es schützt jetzt auch
`/v1/admin` (siehe oben). Erzeugen Sie eines mit `openssl rand -hex 32` und
aktualisieren Sie es gleichzeitig in APISIX.

### Funktionen aus `v0.1.0`–`v0.1.5`, die dieses Release ersetzt

Ein Deployment, das von `v0.1.5` aktualisiert wird, verliert das folgende Verhalten.
Jeder Punkt ist für Integratoren sichtbar; planen Sie das Upgrade daher entsprechend.

| Auf `v0.1.5` | Jetzt |
| ------------ | ----- |
| `POST /v1/webhooks/:id/rotate-secret` akzeptierte `graceSeconds` und ließ das alte Secret für `WEBHOOK_SECRET_GRACE_SECONDS` weiterhin gültig | Das Secret wird direkt ausgetauscht; das vorherige verifiziert sofort nicht mehr. Aktualisieren Sie das gespeicherte Secret des Empfängers im selben Zeitfenster wie den Rotationsaufruf. |
| Ein Retry-Worker mit Leases stellte Webhooks zu (`maxAttempts` / `nextAttemptAt` / `leaseUntil`, Status `RETRYING`) | Das übernimmt der Zustellungs-Sweeper, mit `WEBHOOK_MAX_ATTEMPTS` wieder bei `3` pro In-Process-Schleife (eine tatsächliche Obergrenze von 9 über Sweeps hinweg). `WEBHOOK_MAX_BACKOFF_MS`, `WEBHOOK_WORKER_*`, `WEBHOOK_LEASE_MS`, `WEBHOOK_FANOUT_CONCURRENCY` und `WEBHOOK_PAUSE_AFTER_FAILURES` entfallen, und keine Zustellung wird je als `RETRYING` geschrieben. |
| `SWAP_EXPIRED` und `LIQUIDITY_EXPIRED` wurden ausgelöst | Keines von beiden wird ausgelöst. Der Ablauf wird weiterhin in der Zeile festgehalten; fragen Sie ihn ab oder abonnieren Sie die `*_FAILED`-Events. |
| `GET /v1/products` filterte nach `kind`, `active` und `reference`, und `DELETE` akzeptierte `hard=true` | Beides existiert nicht mehr. Löschvorgänge sind weich (`active=false`). |
| `GET /v1/products` und `GET /v1/customers` hatten `take=20` als Standard | Beide haben jetzt `take=100` als Standard (weiterhin das Maximum), sodass ein Aufruf ohne Parameter mehr Zeilen liefert als zuvor. |
| `analytics.apiLogs` / `analytics.webhookLogs` lieferten `{ data, total }` und berücksichtigten nur `take` | Beide sind wie jede andere Liste paginiert: `take` + `skip` hinein, `{ data, total, take, skip, hasMore }` heraus. Die Datumsbereichsfilter der Übersicht entfallen. |
| `/v1/health` meldete neben der Datenbank einen Stellar-Readiness-Indikator | Es meldet nur die Datenbank. |
| `STELLAR_HTTP_TIMEOUT_MS`, `STELLAR_MAX_ATTEMPTS`, `STELLAR_RETRY_BASE_MS` begrenzten Horizon-Aufrufe | Die Begrenzung für Horizon liegt in `stellar/stellar.constants.ts` und ist nicht über die Umgebung konfigurierbar. Diese drei Variablen werden nicht mehr gelesen oder validiert. |

**Nichts wird aus der Datenbank entfernt.** Die Spalten, Indizes und Enum-Werte, die
diese Funktionen hinzugefügt haben (`webhook_delivery.maxAttempts` / `nextAttemptAt` /
`leaseUntil`, `webhook_endpoint.previousSecret*`, `swap` und
`liquidity_pool_operation` `lastCheckedAt` / `notFoundStreak`, die Tabelle
`horizon_account_cursor`, `RETRYING`, `SWAP_EXPIRED`, `LIQUIDITY_EXPIRED`) sind weiterhin
in `schema.prisma` deklariert und nach `migrate deploy` vorhanden; sie werden nur nicht
mehr geschrieben. Sie zu entfernen, würde eine destruktive Migration erfordern
(PostgreSQL kann einen Enum-Wert nicht entfernen, ohne den Typ neu zu erstellen).

## Umgebungsvariablen

Jede Variable, die in `src/` aus `process.env` gelesen wird, wird beim Start von
`src/config/env.validation.ts` validiert (Fail-fast). Kopieren Sie `.env.example` und
passen Sie mindestens `DATABASE_URL` und `APISIX_GATEWAY_SECRET` an.

| Variable | Erforderlich | Standard | Wirkung |
| -------- | ------------ | -------- | ------- |
| `NODE_ENV` | nein | `development` | Muss `development`, `test` oder `production` sein. **Setzen Sie in Produktion `production`** — die Fail-closed-Prüfung der Plan-Gebühr und die standardmäßig deaktivierten Docs hängen beide davon ab |
| `PORT` | nein | `3000` | HTTP-Port, auf dem der Dienst lauscht |
| `ENV_FILE` | nein | `.env` | Die dotenv-Datei, die dieser Prozess liest (Nest und Prisma). Eine zweite lokale Replik setzt `.env.b`; Werte, die schon in der Umgebung stehen, haben Vorrang |
| `DATABASE_URL` | **ja** | — | PostgreSQL-Verbindung für Prisma |
| `APISIX_GATEWAY_SECRET` | **ja** | — | Gemeinsames Secret, das belegt, dass die Anfrage über APISIX kam. **Mindestens 32 Zeichen**; ein Platzhalter wird beim Start abgewiesen |
| `APISIX_GATEWAY_SECRET_HEADER` | nein | `x-gateway-secret` | Header-Name für das Gateway-Secret |
| `APISIX_CONSUMER_HEADER` | nein | `x-consumer-username` | Benutzername des authentifizierten Consumers |
| `APISIX_CREDENTIAL_HEADER` | nein | `x-credential-identifier` | Credential-ID aus key-auth |
| `APISIX_ENVIRONMENT_HEADER` | nein | `x-consumer-env` | Umgebung des Keys (`dev` / `prod`) |
| `APISIX_ROLE_HEADER` | nein | `x-consumer-role` | Vom Gateway weitergeleitete Consumer-Rolle |
| `APISIX_PERMISSIONS_HEADER` | nein | `x-consumer-permissions` | Vom Gateway weitergeleitete Berechtigungsliste |
| `APISIX_ORGANIZATION_HEADER` | nein | `x-consumer-org` | Organisations-ID |
| `APISIX_PLAN_HEADER` | nein | `x-consumer-plan` | Plan der Organisation |
| `APISIX_SWAP_FEE_BPS_HEADER` | nein | `x-plan-swap-fee-bps` | Swap-Gebühr des Plans (bps) |
| `APISIX_EMAIL_HEADER` | nein | `x-consumer-email` | Verifizierte E-Mail des Kontos des Keys, vom Gateway weitergereicht. Derzeit hängt in diesem Dienst nichts davon ab |
| `APISIX_PUBLIC_CONSUMER` | nein | — | Benutzername des gemeinsamen öffentlichen Consumers (siehe oben). Setzen Sie ihn überall, wo ein öffentlicher Key veröffentlicht wird |
| `PUBLIC_API_KEY_DEV` | nein | — | Der gemeinsame öffentliche Key für das Testnet, ausgeliefert von `GET /v1/public-key?env=dev`. Nicht gesetzt: `503 misconfigured` |
| `PUBLIC_API_KEY_PROD` | nein | — | Dasselbe für das Mainnet (`env=prod`) |
| `APISIX_ADMIN_URL` | mit dem Admin-Key | — | Basis der APISIX-Admin-API, z. B. `http://apisix:9180/apisix/admin`. Nur zum Ausstellen der Keys von Wallet-Konten |
| `APISIX_ADMIN_KEY` | für die Wallet-Anmeldung | — | APISIX-Admin-Key. Gilt für das ganze Gateway — siehe [Keine Anfrage hängt von der Entwicklerplattform ab](#keine-anfrage-hängt-von-der-entwicklerplattform-ab). Auf einem Wiederherstellungsserver abgelehnt |
| `APISIX_ADMIN_TIMEOUT_MS` | nein | `10000` | Budget für einen Admin-API-Aufruf (ms) |
| `WALLET_KEY_SWAP_FEE_BPS` | nein | `150` | Swap-Provision in den Keys von Wallet-Konten (der Satz des Plans `community`) |
| `MAIL_RESEND_API_KEY` | für die E-Mail-Tür | — | Resend-API-Key, mit dem dieser Dienst Anmelde- und Wiederherstellungscodes sendet |
| `MAIL_FROM` | mit dem Resend / SMTP-Key | — | Verifizierter Absender, z. B. `Cosmos Pay <no-reply@example.com>` |
| `MAIL_SMTP_HOST` | nein | — | SMTP-Server, genutzt wenn `MAIL_RESEND_API_KEY` nicht gesetzt ist |
| `MAIL_SMTP_PORT` | nein | `587` | SMTP-Port |
| `MAIL_SMTP_SECURE` | nein | `false` | `true` für implizites TLS (465), `false` für STARTTLS (587) |
| `MAIL_SMTP_USER` | nein | — | SMTP-Benutzer |
| `MAIL_SMTP_PASS` | nein | — | SMTP-Passwort |
| `MAIL_TIMEOUT_MS` | nein | `15000` | Budget für einen Versand (ms) |
| `RECOVERY_EMAIL_CODES` | nein | `false` | Auf einem Wiederherstellungsserver: eigene Codes über sein `MAIL_*` senden |
| `WALLET_BACKUP_ENCRYPTION_KEY` | mit jeder Anmeldetür | — | Verschlüsselt jedes gespeicherte Wallet-Backup im Ruhezustand (AES-256-GCM, 32 Bytes base64/hex). Liegt nur in der Umgebung: Eine Kopie der Datenbank enthält Chiffretext des Geräte-Chiffretexts. Geht er verloren, können die gespeicherten Backups nicht mehr ausgeliefert werden |
| `WALLET_BACKUP_ENCRYPTION_PREVIOUS_KEYS` | nein | — | Kommagetrennte ausgemusterte Schlüssel, nur lesend, für eine Rotation; nach `npm run backups:reencrypt` entfernen |
| `STELLAR_NETWORK` | nein | `testnet` | Fallback-Stellar-Netzwerk (`public` / `testnet`) |
| `STELLAR_HORIZON_URL_PUBLIC` | nein | `https://horizon.stellar.org` | Horizon-Basis-URL für Mainnet |
| `STELLAR_HORIZON_URL_TESTNET` | nein | `https://horizon-testnet.stellar.org` | Horizon-Basis-URL für Testnet |
| `SOLANA_RPC_URL_MAINNET` | nein | `https://api.mainnet-beta.solana.com` | Solana-RPC für `prod`-Schlüssel (mainnet-beta; der Genesis-Hash wird vor der Nutzung geprüft). Der öffentliche Endpunkt ist ratenbegrenzt: in Produktion den eines Anbieters verwenden |
| `SOLANA_RPC_URL_DEVNET` | nein | `https://api.devnet.solana.com` | Solana-RPC für `dev`-Schlüssel (devnet) |
| `SOLANA_RPC_TIMEOUT_MS` | nein | `10000` | Budget für einen Solana-RPC-Aufruf (ms) |
| `MONAD_RPC_URL_MAINNET` | nein | `https://rpc.monad.xyz` | Monad-RPC für `prod`-Schlüssel (Chain-ID 143, vor der Nutzung geprüft) |
| `MONAD_RPC_URL_TESTNET` | nein | `https://testnet-rpc.monad.xyz` | Monad-RPC für `dev`-Schlüssel (Chain-ID 10143) |
| `MONAD_RPC_TIMEOUT_MS` | nein | `10000` | Budget für einen Monad-RPC-Aufruf (ms) |
| `MONAD_LOG_BLOCK_RANGE` | nein | `100` | Blöcke, die ein `eth_getLogs` umfassen darf — das Limit des RPC-Anbieters (der öffentliche RPC erlaubt 100) |
| `MONAD_RELAYER_PRIVATE_KEY` | nein | — | Relayer-Schlüssel (32-Byte-Hex). Gesetzt, erhält jede Monad-Absicht eine eigene Einzahlungsadresse, und der Relayer leitet Einzahlungen abzüglich einer Gebühr an den Händler weiter. Hält nur Gas-Geld: die von ihm deployten Weiterleiter können niemand anderen bezahlen |
| `MONAD_DEPOSIT_TOKEN_FEES` | nein | — | Relayer-Gebühr je ERC-20-Einzahlung, JSON `{"0xToken": "0.05"}` in Token-Einheiten. Ein Token ohne Eintrag wird gebührenfrei weitergeleitet (der Relayer zahlt das Gas) |
| `STELLAR_BASE_FEE` | nein | `100` | Stellar-Basisgebühr (Stroops) für Transaktions-Builds |
| `STELLAR_TX_TIMEOUT` | nein | `300` | Transaktions-Timeout (Sekunden) |
| `STELLAR_SWAP_FEE_WALLET` | wenn Gebühr > 0 | — | G...-Plattformkonto für Swap-Gebühren |
| `STELLAR_SWAP_FEE_BPS` | nein | `50` | Swap-Gebühr in Basispunkten |
| `STELLAR_SWAP_SLIPPAGE_BPS` | nein | `50` | Standardtoleranz für Swap-Slippage (bps) |
| `STELLAR_SWAP_MAX_SLIPPAGE_BPS` | nein | `500` | Harte Obergrenze für die Slippage des Aufrufers (bps) |
| `STELLAR_SWAP_SINGLE_INFLIGHT` | nein | `false` | Bei `true` 409, wenn für dieselbe Quelle bereits ein nicht abgelaufener PENDING-Swap existiert |
| `NEAR_INTENTS_BASE_URL` | nein | `https://1click.chaindefuser.com` | 1Click-API von NEAR Intents, für chain-übergreifende Swaps |
| `NEAR_INTENTS_API_KEY` | empfohlen | — | 1Click-Partner-Key (`X-API-Key`). Ohne ihn erhebt 1Click eine eigene Gebühr von 0,2 % und behält die Hälfte der Provision |
| `NEAR_INTENTS_FEE_RECIPIENT` | bei Plan-Provision | — | NEAR-Konto, an das die chain-übergreifende Provision geht (`appFees`). Ungesetzt bei einem Plan-Satz: `503 misconfigured` |
| `NEAR_INTENTS_TIMEOUT_MS` | nein | `20000` | Budget für einen 1Click-Aufruf (ms) |
| `CROSS_CHAIN_SWAP_SLIPPAGE_BPS` | nein | `100` | Standard-Slippage chain-übergreifend (bps); unter dem Minimum erstattet NEAR Intents |
| `CROSS_CHAIN_SWAP_MAX_SLIPPAGE_BPS` | nein | `500` | Die höchste Slippage, die ein Aufrufer verlangen darf |
| `CROSS_CHAIN_SWAP_DEADLINE_SECONDS` | nein | `1800` | Wie lange eine Einzahlungsadresse die Einzahlung annimmt; spätere werden erstattet |
| `SOLANA_SWAP_FEE_WALLET` | bei Plan-Provision | — | Eigentümer der Token-Konten, auf die die Provision der Solana-Swaps geht (Jupiter-`feeAccount`, eines pro Output-Mint — vorher anlegen). Ungesetzt bei einem Plan-Satz: `503 misconfigured` |
| `MONAD_SWAP_FEE_WALLET` | bei Plan-Provision | — | Adresse, an die die Provision der Monad-Swaps geht (Kuru-Flow-`referrerAddress`) |
| `JUPITER_BASE_URL` | nein | `https://lite-api.jup.ag/swap/v1` | Jupiter-Swap-API; mit Key `https://api.jup.ag/swap/v1` |
| `JUPITER_API_KEY` | nein | — | Jupiter-API-Key (`x-api-key`), für höhere Limits |
| `JUPITER_TIMEOUT_MS` | nein | `15000` | Budget für einen Jupiter-Aufruf (ms) |
| `KURU_BASE_URL` | nein | `https://ws.kuru.io` | Kuru-Flow-API (Monad) |
| `KURU_API_KEY` | für Produktion | — | Kuru-Flow-API-Key (`X-API-Key`). Ohne ihn bekommt jede Adresse ein Token mit einer Anfrage pro Sekunde |
| `KURU_TIMEOUT_MS` | nein | `15000` | Budget für einen Kuru-Flow-Aufruf (ms) |
| `OBSERVER_ENABLED` | nein | `true` | `true` / `false` — On-Chain-Reconciler |
| `OBSERVER_INTERVAL_MS` | nein | `15000` | Abfrageintervall des Observers (ms, mind. 1000) |
| `OBSERVER_BATCH_SIZE` | nein | `50` | Max. Intents/Swaps pro Observer-Tick |
| `PAYMENT_INTENT_TTL_SECONDS` | nein | `3600` | Lebensdauer eines unbezahlten Intents bis `EXPIRED` |
| `WEBHOOK_TIMEOUT_MS` | nein | `5000` | Veralteter Fallback für das Webhook-Timeout (ms) |
| `WEBHOOK_CONNECT_TIMEOUT_MS` | nein | `3000` | Budget für den Verbindungsaufbau ausgehender Webhooks (ms) |
| `WEBHOOK_READ_TIMEOUT_MS` | nein | `5000` | Lese-Budget ausgehender Webhooks (ms) |
| `WEBHOOK_MAX_RESPONSE_BYTES` | nein | `65536` | Max. ausgelesener Webhook-Response-Body |
| `WEBHOOK_MAX_ATTEMPTS` | nein | `3` | Anzahl der Zustellversuche |
| `WEBHOOK_BACKOFF_MS` | nein | `2000` | Linearer Backoff zwischen Wiederholungen (ms) |
| `WEBHOOK_SIGNATURE_HEADER` | nein | `x-cosmos-signature` | An Integratoren gesendeter HMAC-Header |
| `WEBHOOK_SWEEP_ENABLED` | nein | `true` | Durch einen Absturz liegen gebliebene Zustellungen wiederherstellen. Notfallschalter |
| `WEBHOOK_SWEEP_INTERVAL_MS` | nein | `60000` | Sweeper-Intervall (ms, mind. 1000) |
| `WEBHOOK_PAYLOAD_RETENTION_DAYS` | nein | `30` | Tage, die der Body einer abgeschlossenen Zustellung vor dem Schwärzen aufbewahrt wird. `0` bewahrt ihn dauerhaft auf |
| `REQUEST_LOG_RETENTION_DAYS` | nein | `30` | Tage, die `request_log`-Zeilen (IP / User-Agent des Zahlers) aufbewahrt werden. `0` deaktiviert das Bereinigen |
| `ACTIVITY_RETENTION_DAYS` | nein | `30` | Tage, die `activity_event`-Zeilen (Client-IP / User-Agent / `props`) aufbewahrt werden. Vom selben Job bereinigt. `0` bewahrt Events dauerhaft auf |
| `REQUEST_LOG_PRUNE_INTERVAL_MS` | nein | `3600000` | Intervall des Aufbewahrungs-Timers (ms) |
| `REQUEST_LOG_PRUNE_BATCH_SIZE` | nein | `1000` | Zeilen pro Lösch-Batch (hält jeden Lock kurz) |
| `REQUEST_LOG_PRUNE_MAX_PER_CYCLE` | nein | `50000` | Harte Obergrenze für pro Tick untersuchte Zeilen |
| `SWAGGER_ENABLED` | nein | aus in `production` | `/docs` veröffentlichen (Express-Middleware, keine Guards) |
| `OPENAPI_SERVER_URL` | nein | — | In die exportierte OpenAPI-Spezifikation eingetragener Gateway-Host |
| `BLINDPAY_API_KEY` | nein | — | API-Key der BlindPay-Produktionsinstanz, genutzt von `prod`-Keys |
| `BLINDPAY_INSTANCE_ID` | wenn API-Key gesetzt | — | BlindPay-Instanz-ID (`in_...`) |
| `BLINDPAY_BASE_URL` | nein | `https://api.blindpay.com/v1` | Basis-URL der BlindPay API |
| `BLINDPAY_WEBHOOK_SECRET` | wenn API-Key gesetzt | — | Svix-Secret für eingehende BlindPay-Webhooks: der vollständige `whsec_…`-Wert, dessen Schlüssel zu mindestens 24 Byte dekodieren muss (wird beim Start geprüft) |
| `BLINDPAY_API_KEY_DEV` | nein | — | API-Key der BlindPay-Entwicklungsinstanz, genutzt von `dev`-Keys. Nicht gesetzt: BlindPay-Routen antworten `dev`-Keys mit `503 misconfigured` |
| `BLINDPAY_INSTANCE_ID_DEV` | wenn Dev-API-Key gesetzt | — | ID der Entwicklungsinstanz (`in_...`) |
| `BLINDPAY_WEBHOOK_SECRET_DEV` | wenn Dev-API-Key gesetzt | — | Svix-Secret des Webhook-Endpunkts der Entwicklungsinstanz; gleiche Regeln wie `BLINDPAY_WEBHOOK_SECRET` |
| `BLINDPAY_TIMEOUT_MS` | nein | `15000` | Timeout des BlindPay-HTTP-Clients (ms) |
| `DEFINDEX_API_KEY` | nein | — | Server-API-Schlüssel von DeFindex. Die Routen existieren nur mit `defindex` in `PLUGINS_ENABLED`; ohne Schlüssel antworten sie mit `503 misconfigured` |
| `DEFINDEX_BASE_URL` | nein | `https://api.defindex.io` | Basis-URL der DeFindex-API |
| `DEFINDEX_TIMEOUT_MS` | nein | `30000` | DeFindex-HTTP-Timeout (ms) |
| `PLUGINS_ENABLED` | nein | — | Kommagetrennte Slugs der Plugins, die dieses Deployment ausliefert: die isolierten in `plugins/` und die nativen `blindpay` und `defindex`. Leer liefert keines aus; ein nicht aufgeführtes Plugin wird nie geladen |
| `PLUGINS_SECRET` | wenn ein aktiviertes Plugin geheime Einstellungen hat | — | Versiegelt die geheimen Einstellungen von Plugin-Installationen (mindestens 32 Zeichen). Eine Änderung macht alle gespeicherten Plugin-Geheimnisse unlesbar |
| `PLUGINS_TRUSTED_KEYS` | nein | — | Signierer, deren Plugins hier neben dem Cosmos-Pay-Support laufen: kommagetrennt `<keyId>:<base64url Ed25519 Public Key>`. Ein von jemand anderem signiertes oder nach dem Signieren verändertes Plugin bricht den Start ab |
| `PLUGINS_ALLOW_UNSIGNED` | nein | `false` | Plugins ohne `signature.json` ausführen, um lokal eines zu schreiben. Abgelehnt bei `NODE_ENV=production` |
| `KYC_REDIRECT_URL_WHITELIST` | nein | — | Allowlist der KYC-Redirect-Hosts pro Consumer |
| `WALLET_AUTH_RETURN_URLS` | nein | — | Kommagetrennte App-URLs, auf die der Callback der Wallet-Anmeldung umleiten darf (`returnTo` bei `POST /v1/wallet/auth/oauth/authorize`): ein eigenes Schema, ein Universal/App Link oder `http://127.0.0.1/…` (beliebiger Port). Exakter Vergleich; ein Eintrag mit reinem http außerhalb von Loopback, mit Query oder mit `javascript:`/`data:`/`file:` wird beim Start abgelehnt. Ohne Wert rendert jeder Callback die Seite, und ein `returnTo` ist `400 wallet_return_url_not_allowed` |
| `RATE_LIMIT_ENABLED` | nein | `true` | Obergrenzen pro Adresse auf den Routen, die XLM ausgeben. Notfallschalter |
| `RATE_LIMIT_PRUNE_INTERVAL_MS` | nein | `600000` | Bereinigungsintervall der Zählerfenster (ms, mind. 1000) |

Das veraltete `STELLAR_HORIZON_URL` wird beim Start abgewiesen — verwenden Sie
stattdessen `STELLAR_HORIZON_URL_PUBLIC` / `STELLAR_HORIZON_URL_TESTNET`.

## Erste Schritte

```bash
cp .env.example .env          # set DATABASE_URL and a strong APISIX_GATEWAY_SECRET
npm install
npm run db:generate           # prisma generate
npm run db:migrate            # create the schema (needs a running Postgres)
npm run start:dev
```

Ein Secret erzeugen:

```bash
openssl rand -hex 32
```

Dieselben Prüfungen ausführen, die CI ausführt (keine Datenbank nötig — Prisma wird
gemockt):

```bash
npm run lint
npm test                 # unit suites (src/**/*.spec.ts)
npm run test:e2e         # e2e suites (test/*.e2e-spec.ts)
npm run openapi:check    # the committed contract matches the controllers
npm run readme:check     # the seven READMEs match in structure and list every route
```

## APISIX-Routenkonfiguration

Der Routen-Helper der Entwicklerplattform (`paydev/src/utils/apisix.ts`) wandelt
`Authorization: Bearer <token>` bereits in den `apikey`-Header um, validiert `key-auth`
und entfernt Credentials vor dem Weiterleiten. Um eine Route auf diesen Dienst zu
richten, fügen Sie dem `proxy-rewrite`-Plugin die **Injektion des Gateway-Secrets**
hinzu, damit der Header hier ankommt — und entfernen Sie jede vom Client mitgeschickte
Kopie:

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

`key-auth` leitet nach erfolgreicher Authentifizierung `X-Consumer-Username` /
`X-Credential-Identifier` an den Upstream weiter und überschreibt dabei jede vom Client
mitgeschickte Kopie; der Guard verlässt sich darauf.

> **Die Entfernungsliste ist eine Sicherheitskontrolle, und sie lässt sich nicht aus
> diesem Repository heraus verifizieren.** Dieser Dienst akzeptiert jeden Header darin
> unbesehen; `X-Gateway-Secret` belegt nur, dass die Anfrage durch ein Gateway kam,
> nicht, dass diese Werte ehrlich sind. Prüfen Sie die Liste, wann immer eine Route
> hinzugefügt oder kopiert wird — eine Route, die `X-Cosmos-Internal` nicht entfernt,
> verschafft jedem API-Key Zugriff auf `/v1/admin`. Halten Sie den Dienst in einem
> privaten Netzwerk, sodass APISIX der einzige Zugang ist; das gemeinsame Secret ist
> eine zweite Schutzschicht, nicht die einzige.
>
> In Produktion liefert ein fehlendes `X-Plan-Swap-Fee-Bps` `503`, statt auf den
> Standardwert aus der Umgebung zurückzufallen.
