# Cosmos Pay — Zahlungs-Microservice

[English](../../README.md) · [Español](./README.es.md) · [Português](./README.pt.md) · **Deutsch** · [Français](./README.fr.md) · [हिन्दी](./README.hi.md) · [简体中文](./README.zh.md)

Zahlungs-Microservice auf Basis von **NestJS 12** + **Prisma 7 (PostgreSQL)**.

Er ist eine *eigenständige* Anwendung, getrennt von der Cosmos-Entwicklerplattform
(`paydev`). Die Entwicklerplattform **stellt** lediglich APISIX-Zugriffstoken
(Consumer + `key-auth`-Credentials) für nachgelagerte Dienste **aus**. Dieser Dienst
ist einer dieser nachgelagerten Dienste: Er steht **hinter APISIX**, das jede Anfrage
lastverteilt und authentifiziert, bevor es sie hierher weiterleitet. Der Dienst sieht
daher nie rohe API-Keys — er vertraut ausschließlich dem, was das Gateway weiterleitet.

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
| Payment Intents   | `/v1/payment-intents`    | SEP-7-Intents `tx` / `pay`, Validierung, On-Chain-Observer |
| Swaps             | `/v1/swaps`              | Path-Payment-Quote, unsigniertes XDR bauen, signiertes übermitteln |
| Liquiditätspools  | `/v1/liquidity-pools`    | AMM-Einzahlung / -Auszahlung, Positionen, Provision auf Gewinn |
| Webhooks          | `/v1/webhooks`           | Endpunkt-CRUD, Secret-Rotation, Zustellungen, erneute Zustellung |
| KYC               | `/v1/kyc`                | Receiver (KYC/KYB), Wallets, Bankkonten, Dokument-Upload  |
| Onramp            | `/v1/onramp`             | Payin-Quotes, Payins, virtuelle Konten                    |
| Offramp           | `/v1/offramp`            | Payout-Quotes, Autorisierung, Payouts (vom Client signiert) |
| Produkte          | `/v1/products`           | Händlerkatalog                                            |
| Kunden            | `/v1/customers`          | Aus Intents abgeleitete Zahlerdatensätze                  |
| Aliase            | `/v1/aliases`            | Beanspruchbare Zahlungs-Handles: beanspruchen, auflösen, wiederherstellen |
| Assets            | `/v1/assets`             | Kuratiertes Asset-Register pro Netzwerk                   |
| Pollar            | `/v1/pollar`             | OAuth-Bridge (Social Login → Wallet) + Operator-Routen    |
| Analytik          | `/v1/summary`, `/v1/balances`, `/v1/logs` | Dashboard-Aggregate und Logs             |
| Aktivität         | `/v1/activity`           | Vom Client gemeldete Events: Aufnahme, Feed, Zusammenfassung |
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
| GET | `/v1/admin/consumers` | Plattform-Konsole |  |
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
| POST | `/v1/aliases/{name}/recovery` | Plattform-Konsole |  |
| POST | `/v1/aliases/{name}/recovery/complete` | `payments:write` |  |
| GET | `/v1/assets` | — | ✓ |
| GET | `/v1/balances` | `payments:read` |  |
| POST | `/v1/blindpay/webhooks` | keiner — `@Public()`, Svix-Signatur |  |
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
| GET | `/v1/pollar/oauth/callback` | keiner — `@Public()` |  |
| GET | `/v1/pollar/oauth/callback/{state}` | keiner — `@Public()` |  |
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
`ApiErrorBodyEntity` an jeder Operation veröffentlicht, sodass generierte Clients auch
den Fehlertyp erhalten (Quelle: `ApiErrorCode` in `src/common/errors/api-error.ts`).
**Einmal veröffentlichte Codes werden nie umbenannt**; neue können hinzukommen,
behandeln Sie einen unbekannten Code daher gemäß seinem HTTP-Status.

Einige, die leicht verwechselt werden:

| Code | Status | Bedeutung |
| ---- | ------ | --------- |
| `insufficient_scope` | 403 | Dem API-Key fehlt der Scope. Stellen Sie den Key neu aus |
| `account_disabled` | 403 | Ein Operator hat dieses Fiat-Konto deaktiviert. Kein Problem des Keys |
| `gateway_required` | 403 | Die Anfrage kam nicht über APISIX |
| `admin_console_only` | 403 | Die Route gehört zur Plattform-Konsole (`/v1/admin`, Start einer Alias-Wiederherstellung). Kein API-Key kann sie aufrufen |
| `elevated_key_required` | 403 | Die Route schreibt in etwas, das alle Tenants teilen (das Pollar-Benutzerverzeichnis). Nur ein erhöhter (Admin-)Key darf sie aufrufen; mehr Scopes helfen nicht |
| `pollar_identity_required` | 403 | Das Gateway hat für diesen Key keine Konto-E-Mail weitergeleitet, daher kann ein Pollar-Login nicht an ihn gebunden werden |
| `pollar_identity_mismatch` | 403 | Der Pollar-Login wurde von einem anderen Konto als dem des Keys abgeschlossen. Die Sitzung wurde widerrufen, nicht zurückgegeben |
| `idempotency_conflict` | 409 | Dieser `Idempotency-Key` (oder dieses Payment-Intent-Memo) hat bereits eine Ressource für eine *andere* Anfrage erzeugt. Wiederholen Sie die ursprüngliche Anfrage oder verwenden Sie einen neuen Key |
| `kyc_state_invalid` | 409 | Ein unzulässiger KYC-Zustandsübergang — keine doppelte Anfrage |
| `operation_in_flight` | 409 | Eine kollidierende Operation wird noch abgewickelt |
| `payload_expired` | 409 | Der Body der Zustellung hat die Aufbewahrungsfrist überschritten und kann nicht erneut gesendet werden |
| `provider_unavailable` | 503/504 | BlindPay oder Horizon ist nicht erreichbar. Erneut versuchen |
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
| `StellarObserverService`       | `PaymentIntentObserver`  |
| `RequestLogRetentionService`   | `RequestLogRetention`    |
| Sweeper für Webhook-Zustellungen | `WebhookDeliverySweeper` |
| `PollarOauthSweeperService`    | `PollarOauthSweeper`     |
| `RateLimitPruneService`        | `RateLimitPrune`         |
| `PollarWalletProvisionSweeperService` | `PollarWalletProvisionSweeper` |
| `AliasChallengeSweeperService` | `AliasChallengeSweeper`  |

`pg_try_advisory_xact_lock` blockiert nie und wird am Ende der Transaktion freigegeben,
auch bei einem Absturz oder einer abgebrochenen Verbindung. Anders als ein Lock auf
Sitzungsebene funktioniert er auch hinter PgBouncer im Transaction-Pooling-Modus.

Lock-IDs stehen in der Enum `AdvisoryLockKey`. Nummerieren Sie eine bestehende ID nicht
um — während eines Rolling Deploys würden alte und neue Replikate unterschiedliche Locks
nehmen — und verwenden Sie keine ausgemusterte ID wieder.

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
- **Automatisch (permanenter Observer):** `StellarObserverService` fragt Horizon alle
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
`LIQUIDITY_FAILED` sowie die aus BlindPay stammenden `RECEIVER_UPDATED`,
`PAYIN_CREATED`, `PAYIN_UPDATED`, `PAYIN_COMPLETED`, `PAYOUT_CREATED`, `PAYOUT_UPDATED`
und `PAYOUT_COMPLETED`. Die maßgebliche Liste ist die Enum `WebhookEventType` in
`prisma/schema.prisma`.

**Aus BlindPay stammende Bodies.** `RECEIVER_UPDATED` / `PAYIN_*` / `PAYOUT_*` tragen
nur Identität und Zustand — IDs, Status, Beträge, Rails — nie personenbezogene Daten.
Das Provider-Objekt wird nicht weitergeleitet, weil ein Receiver-Payload ein
vollständiges KYC-Dossier ist und für ein Abonnement nur `webhooks:write` nötig ist.
Rufen Sie die Details über die API mit einem Key ab, der `kyc:read` / `onramp:read` /
`offramp:read` besitzt. Die Feld-Allowlist steht in
`src/blindpay/blindpay-event-redaction.ts`.

Die Zustellung ist über NestJS `EventEmitter2` (`webhook.event`) entkoppelt, sodass das
Auslösen einer Benachrichtigung die API-Anfrage, die sie verursacht hat, nie blockiert.

**Richtlinie für ausgehende Ziele (SSRF):** Endpunkte müssen `https` verwenden und
dürfen nur auf öffentliche Adressen auflösen. Die Registrierung lehnt Loopback, private
RFC1918-Bereiche, Link-Local (`169.254.0.0/16`, einschließlich Cloud-Metadaten
`169.254.169.254`) und bekannte Metadaten-Hostnamen ab. Dieselbe Prüfung läuft
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

Die beiden APISIX-Header (`X-Gateway-Secret`, `X-Consumer-Username`) sind in der
Spezifikation als Security Schemes dokumentiert.

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
derselbe Consumer ist. Wenn Sie kein `memo` übergeben, wird ein zufälliges uint64
erzeugt.

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
| `POST /v1/liquidity-pools/deposit` \| `withdraw` | Bauen unsignierte Envelopes |
| `POST /v1/liquidity-pools/operations/:id/submit` | Sendet einen vom Aufrufer signierten Envelope, unter denselben Prüfungen wie beim Swap-Submit; rate-limitiert |
| `GET /v1/liquidity-pools` \| `/:poolId` \| `/positions` | Öffentliche On-Chain-Daten, gelesen von Horizon |
| `POST /v1/payment-intents/tx` \| `pay` | Bauen einen SEP-7-Intent aus der Anfrage |
| `POST /v1/activity/events` | Telemetrie-Aufnahme — siehe unten |
| `GET /v1/assets` | Der öffentliche Asset-Katalog |
| `GET /v1/aliases/resolve/:name` \| `availability/:name` \| `by-address/:address` | Ein Zahler, der ein Handle auflöst, ist genau der anonyme Aufrufer, für den dieser Key existiert; die Antwort ist eine reine Funktion der Anfrage und enthält nie das Postfach des Inhabers |

Abgewiesen: `GET /v1/swaps`, `GET /v1/swaps/:id`,
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
voneinander verschiedene Swaps von einem Konto bleiben erlaubt).

```jsonc
// response → { id, status: "PENDING", network, sendAmount, feeAmount, swapAmount,
//              destEstimated, destMin, path, xdr, uri: "web+stellar:tx?xdr=…", qr, txHash, … }
```

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
denselben Regeln, mit einem eigenen Kontingent.

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

### Die Wiederherstellung läuft über E-Mail und über die Plattform-Konsole

Ein Claim hinterlegt eine Wiederherstellungs-E-Mail-Adresse, damit ein verlorener
Schlüssel nicht auch den Namen kostet. Die Wiederherstellung läuft so ab:

1. Die **Plattform-Konsole** ruft `POST /v1/aliases/:name/recovery {email}` auf. Die
   Antwort ist identisch, ob Handle und Postfach übereinstimmten oder nicht; bei
   Übereinstimmung enthält sie ein einmalig verwendbares Token (30 Minuten, nur als
   SHA-256 gespeichert), das die Konsole per E-Mail versendet. Dieser Dienst versendet
   keine E-Mails.
2. Der Benutzer holt sich eine `RECOVER`-Challenge für den neuen Schlüssel und ruft
   `POST /v1/aliases/:name/recovery/complete {token, address, network, nonce, signature}`
   mit seinem eigenen API-Key auf. Beide Nachweise sind erforderlich: Das Token belegt
   das Postfach, die Signatur den Schlüssel.
3. Der Besitz geht auf den aufrufenden Consumer über, und **alle bisherigen Adressen
   werden entfernt**, sodass derjenige, der die alten Schlüssel besitzt, keine Zahlungen
   mehr erhält.

Schritt 1 ist der Konsole vorbehalten, weil das Token die Kontrolle über das Postfach
belegt und daher nur bei demjenigen ankommen darf, der die E-Mail versendet.
`ConsoleOnlyGuard` weist jeden API-Key-Aufrufer mit `403 admin_console_only` ab, bevor
der Alias nachgeschlagen wird, und die Route ist nicht im veröffentlichten Vertrag.
Ein gesperrter Alias kann nicht wiederhergestellt werden.

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
| POST | `/v1/aliases/:name/recovery` | _nur Plattform-Konsole_ | Eine Wiederherstellung starten → ein Token, das die Konsole per E-Mail versendet |
| POST | `/v1/aliases/:name/recovery/complete` | `payments:write` | Eine Wiederherstellung mit dem Token und der Signatur des neuen Schlüssels abschließen |

## BlindPay — Onramp / Offramp / KYC (Fiat ⇄ Stablecoin)

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

### KYC-Redirect-URLs werden pro Consumer per Allowlist freigegeben

Der Ablauf für die Nutzungsbedingungen schickt den Benutzer zu BlindPay und zurück an
eine `redirect_url`, die der Integrator angibt. Um einen Open Redirect zu verhindern,
durchläuft jede `redirect_url` zwei Prüfungen:

| Ebene | Regel | Wo |
| ----- | ----- | -- |
| Form | eine absolute `https`-URL ohne eingebettete Zugangsdaten (`user:pass@`) | `@IsRedirectUrl()` auf jedem DTO, das eine trägt |
| Host | auf der Allowlist **des aufrufenden Consumers** — der exakte Host oder eine Subdomain an einer Label-Grenze (`app.acme.com` passt zu `acme.com`; `evilacme.com` nicht) | `KYC_REDIRECT_URL_WHITELIST`, durchgesetzt in der Service-Schicht |

```
KYC_REDIRECT_URL_WHITELIST={"cosmos_acme":["acme.com","app.acme.com"]}
```

Die Prüfung arbeitet **fail-closed**: Ein Consumer ohne Eintrag kann überhaupt keinen
Redirect verwenden, und ein Host mit abschließendem Punkt oder in IDN-Form wird
abgewiesen statt normalisiert. Jede Route, die eine `redirect_url` entgegennimmt, prüft
sie, auch die Admin-Genehmigung, die die Liste des Consumers verwendet, dem der Receiver
gehört. Ein abgewiesenes Schema oder ein abgewiesener Host ergibt `400`.

## Pollar — Social Login, der eine Stellar-Wallet zurückgibt

[Pollar](https://docs.pollar.xyz/docs) macht aus einem Google-/GitHub-Login ein
Stellar-Konto: Es authentifiziert den Benutzer, erstellt eine Wallet, verwahrt den
Schlüssel in AWS KMS, fügt die konfigurierten Trustlines hinzu und finanziert die
Reserve — der Benutzer sieht nie eine Seed-Phrase. Dieser Dienst stellt das als
**OAuth-Bridge** bereit.

### Warum eine Bridge und kein Passthrough

Der gehostete Login von Pollar ist für ein Browser-SDK konzipiert. Er leitet den
Benutzer mit einem Publishable Key, einer Client-Session-ID und einer `redirect_uri` an
`GET /auth/{provider}` weiter — und diese Redirect-URI muss ein **bei Pollar
registrierter** Host sein. Eine Wallet kann diese Anforderungen nicht erfüllen: Ein
Loopback-Listener oder ein `cosmospay://`-Deep-Link ist nie ein registrierter Host, und
die Wallet sollte mit diesen Schlüsseln und Session-IDs nicht hantieren. Deshalb
übernimmt die Bridge die Pollar-Seite, und die Wallet erledigt nur zwei Schritte:
**eine Autorisierung öffnen, einen Code einlösen**.

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

Ab Schritt 6 spricht die Wallet direkt mit Pollar: Die Einlöse-Antwort enthält
`publishable_key` und `api_base_url`, mit denen die Wallet Guthaben liest sowie
Transaktionen baut und übermittelt. **Dieser Dienst leitet diese Aufrufe nicht weiter.**

### Zwei Wege, den Code entgegenzunehmen

|                   | Redirect-Flow                                    | Poll-Flow                                       |
| ----------------- | ------------------------------------------------ | ----------------------------------------------- |
| Die Wallet liefert | `redirect_uri` (muss auf der Allowlist stehen) und eine PKCE-`code_challenge` | nichts (PKCE optional) |
| Der Code kommt an | als `?code=…&state=…` im Redirect                | über `GET /v1/pollar/oauth/sessions/{state}`    |
| Der Browser sieht | Ihre eigene URI                                  | eine schlichte Seite „Sie können dieses Fenster schließen“ — nie den Code |
| Verwenden, wenn   | die Wallet einen Deep Link oder Loopback-Listener hat | sie weder das eine noch das andere hat (Kiosk, headless, eingebettete Ansicht) |

Jede Abfrage stellt einen neuen Code aus und macht den vorherigen ungültig; lösen Sie
daher den Code aus Ihrer letzten Abfrage ein. Gespeichert wird nur ein SHA-256 des Codes.

**Bevorzugen Sie den Poll-Flow.** Der gehostete Ablauf von Pollar leitet den Browser
nicht zum Callback zurück: Er endet auf einer eigenen Seite
(`www.pollar.xyz/auth/status`) und setzt die Client-Session auf Seiten von Pollar auf
`READY`. Solange ein Handshake `pending` ist, prüft die Poll-Route daher die
Client-Session bei Pollar und stuft den Handshake hoch, sobald Pollar `READY` meldet.

- **Lassen Sie die Callback-Route bei Pollar registriert.** Der Redirect-Flow ist auf
  sie angewiesen.
- **Pollar wird höchstens alle zwei Sekunden pro Handshake gefragt**
  (`POLLAR_SESSION_PROBE_INTERVAL_MS`), über `providerCheckedAt` für alle Replikate
  gemeinsam. Eine Wallet, die jede Sekunde abfragt, kostet 30 Pollar-Anfragen pro
  Minute, bei einem Key-Budget von 200.

Ein Handshake, dessen Client-Session Pollar ablehnt (`INVALID_CLIENT_SESSION_ID`,
`EXPIRED_CLIENT_ID` oder ein `404`/`410`), wird sofort mit diesem Code als `failed`
geschlossen.

### Ein Login, eine Wallet in beiden Netzwerken

Pollar betreibt Mainnet und Testnet als getrennte Anwendungen mit getrennten
Schlüsselpaaren, sodass ein gehosteter Login nur in dem Netzwerk eine Wallet erstellt,
auf das sein API-Key aufgelöst wird (`prod` → `public`, `dev` → `testnet` — siehe
`resolveNetwork`). Damit der Benutzer in beiden eine Wallet hat, registriert ihn eine
**Mainnet**-Einlösung auch im **Testnet**, über `POST /users/with-wallet` der Server API,
und `POST /v1/pollar/oauth/token` meldet beide. Eine Testnet-Einlösung stellt kein Mainnet
bereit: Im Testnet landen `dev`-Keys, und ein Key, den jeder erzeugen kann, darf nicht pro
Login echte XLM für eine Mainnet-Reserve ausgeben. Die Mainnet-Wallet dieses Benutzers
entsteht bei seinem ersten Mainnet-Login.

```jsonc
"network_wallets": [
  { "network": "public",  "status": "ready",   "address": "GA5Z…" },
  { "network": "testnet", "status": "pending", "address": null    }
]
```

**Ein `pending`-Eintrag ist kein Fehler.** Der Login war erfolgreich; nur die zweite
Wallet ist noch nicht bereit, und sie lässt den Login nie scheitern. Die Anfrage
unternimmt einen Versuch von fünf Sekunden; was nicht fertig wird, versucht der
Provisioning-Sweeper (`POLLAR_SWEEP_*`) im Hintergrund erneut, mit exponentiellem
Backoff und bis zu zehn Versuchen, bevor die Zeile auf `failed` geht.

Der übliche Grund für `pending` ist, dass **die Schlüssel des anderen Netzwerks nicht
konfiguriert sind**. Sobald sie gesetzt sind, stellt der nächste Sweep den Rückstand
bereit, ohne dass sich Benutzer erneut anmelden müssen; setzen Sie daher die Schlüssel
für beide Netzwerke, auch wenn Sie nur eines bedienen.

- **Benutzer werden über ihre OAuth-E-Mail-Adresse zugeordnet**, denselben Schlüssel,
  den ein gehosteter Login im anderen Netzwerk verwendet. Ein Provider, der keine
  E-Mail-Adresse liefert, erhält keine zweite Wallet.
- **Ein Mainnet-Login gibt XLM in beiden Netzwerken aus** — die eigene Reserve und eine
  im Testnet. Ein Testnet-Login gibt nur Testnet-XLM aus. Der Zustand liegt in `pollar_user_wallet`, eine
  Zeile pro (Consumer, E-Mail, Netzwerk), sodass ein wiederholter Login nicht erneut
  bereitstellt.

### Was die Bridge speichert

Eine Handshake-Zeile, in der nichts Geld ausgeben kann: der nicht erratbare `state`,
die Client-Session-ID von Pollar, ein **Hash** des Codes und die resultierende
öffentliche Stellar-Adresse. **Kein Pollar-Token wird je persistiert** — der
`/auth/login`-Austausch läuft innerhalb der Einlöse-Anfrage, und die Tokens gehen
direkt in deren Antwort hinaus. Handshakes, die niemand abgeschlossen hat, werden per
Timer (`POLLAR_SWEEP_*`) als abgelaufen markiert, weil eine `AUTHORIZED`-Zeile ein
einlösbarer Code ist, bis sie bereinigt wird.

Jeder Übergang ist ein Compare-and-Swap auf den Status der Zeile, sodass ein erneut
eingespielter Callback keinen zweiten Code erzeugt und zwei Wallets, die um einen Code
konkurrieren, nicht beide gewinnen können.

### Härtung

- **PKCE (RFC 7636, S256)** ist **im Redirect-Flow Pflicht** und im Poll-Flow optional:
  Übergeben Sie `code_challenge` beim Authorize und `code_verifier` bei der Einlösung,
  dann ist ein Code, der aus einem Browser oder einem Log entweicht, ohne den Verifier
  nutzlos. Ein Code aus dem Redirect-Flow durchquert einen Browser, und der öffentliche
  Callback gibt ihn jedem, der den `state` vorlegt — der in `authorization_url`
  steckt —, daher ist `authorize` mit `redirect_uri` und ohne `code_challenge`
  `400 validation_failed`.
- **`dpop_jwk`** bindet die von Pollar ausgestellten Tokens an den eigenen
  P-256-Schlüssel der Wallet (RFC 9449), sodass ein gestohlenes Access-Token ohne
  signierten Nachweis wirkungslos ist. Es bedeutet auch, dass die Bridge nicht mehr für
  die Wallet handeln kann — `/refresh` und `/logout` bedienen Bearer-Sessions, und eine
  DPoP-gebundene Wallet ruft Pollar direkt auf.
- **`POLLAR_REDIRECT_URI_WHITELIST`** gilt pro Consumer und arbeitet fail-closed, da
  die Redirect-URI den Code empfängt. Sie akzeptiert Loopback-Hosts (beliebiger Port,
  gemäß RFC 8252), Deep Links mit Private-Use-Schema und https-Hosts.
- **Eine Sitzung geht nur an das Konto zurück, das zugestimmt hat.** Alle Tenants teilen
  eine Pollar-Anwendung, und ein Login-Link funktioniert in jedem Browser: Ein Key könnte
  seine `authorization_url` an jemanden senden, auf dessen Zustimmung warten und dessen
  Wallet einlösen — PKCE und `dpop_jwk` helfen nicht, da genau dieser Key den Handshake
  geöffnet hat. Deshalb vergleicht `POST /v1/pollar/oauth/token` die E-Mail, die Pollar
  für den Login meldet, mit der Konto-E-Mail, die das Gateway für den Key weiterleitet
  (`X-Consumer-Email`, siehe `APISIX_EMAIL_HEADER`). Bei einer Abweichung wird die Sitzung
  bei Pollar widerrufen, der Handshake auf `failed` gesetzt und
  `403 pollar_identity_mismatch` zurückgegeben; ein Key ohne weitergeleitete E-Mail wird
  bei `authorize` mit `403 pollar_identity_required` abgewiesen. Die einzige Ausnahme ist
  das vermittelte Onboarding der Dev-Plattform (`X-Cosmos-Internal`): Es meldet Personen
  an, die noch keinen Key haben, und prüft die E-Mail selbst, bevor es etwas weitergibt.
- **`POST /v1/pollar/users` und `/users/with-wallet` brauchen einen erhöhten Key**
  (`X-Consumer-Role: admin`, sonst `403 elevated_key_required`). Ein dort registrierter
  Benutzer ist derselbe, den ein späterer Social Login per E-Mail auflöst; ein Tenant-Key
  könnte sonst die E-Mail eines Fremden beanspruchen und als Eigentümer der Wallet erfasst
  werden, die dieser erhält.

### Routen

| Methode | Pfad                                                  | Scope          | Beschreibung |
| ------- | ----------------------------------------------------- | -------------- | ------------ |
| POST   | `/v1/pollar/oauth/authorize`                          | `pollar:write` | Einen Login öffnen → `authorization_url` + `state` |
| GET    | `/v1/pollar/oauth/callback/:state`                    | _öffentlich_   | Wohin Pollar den Browser zurückleitet (eine Navigation — kein Key zum Mitsenden) |
| GET    | `/v1/pollar/oauth/callback?state=`                    | _öffentlich_   | Derselbe Callback, für eine Redirect-Kette, die die Query, aber nicht den Pfad erhält |
| GET    | `/v1/pollar/oauth/sessions/:state`                    | `pollar:read`  | Einen Handshake abfragen und seinen Code abholen |
| POST   | `/v1/pollar/oauth/token`                              | `pollar:write` | Den Code einlösen → Pollar-Session + Wallet |
| POST   | `/v1/pollar/oauth/refresh`                            | `pollar:write` | Ein Token-Paar rotieren (Bearer-Sessions) |
| POST   | `/v1/pollar/oauth/logout`                             | `pollar:write` | Eine Session widerrufen (dieses Gerät oder alle) |
| POST   | `/v1/pollar/wallets/activate`                         | `pollar:write` | Die XLM-Reserve finanzieren (Funding-Modus „Deferred“) |
| POST   | `/v1/pollar/wallets/:address/trustlines/default`      | `pollar:write` | Die konfigurierten Assets der App aktivieren |
| POST   | `/v1/pollar/wallets/:address/trustlines`              | `pollar:write` | Bestimmte Assets aktivieren |
| DELETE | `/v1/pollar/wallets/:address/trustlines/:code/:issuer`| `pollar:write` | Eine Trustline entfernen (nur bei Guthaben null) |
| POST   | `/v1/pollar/users` · `/v1/pollar/users/with-wallet`   | `pollar:write` | Einen Benutzer registrieren, optional mit Wallet (nur erhöhte Keys) |
| POST   | `/v1/pollar/tokens/verify`                            | `pollar:read`  | Ein Token prüfen, das Ihnen eine Wallet vorgelegt hat |

Die letzten sechs verwenden den **Secret Key** von Pollar und laufen deshalb hier statt
in der Wallet.

### Rate Limiting

Das Erstellen einer Pollar-Wallet kostet Geld: Pollar erstellt das Stellar-Konto,
finanziert dessen Basisreserve (1 XLM) und fügt pro konfiguriertem Asset eine Trustline
hinzu (je 0.5 XLM) **aus Ihrer Funding-Wallet**. Ein Skript, das den Login-Ablauf in
einer Schleife aufruft, könnte das ganz ohne echten Benutzer ausgeben; deshalb setzt
dieser Dienst die Limits selbst durch, bevor XLM ausgegeben wird.

**Das Limit liegt auf `authorize`, nicht auf `token`.** Ein Handshake ergibt höchstens
eine Wallet; wer die Handshakes pro Adresse begrenzt, begrenzt also die Wallets. `token`
ist lockerer, weil Clients es wiederholen sollen, während Pollar das Konto bereitstellt,
und das Einlösen nichts Neues erzeugt.

| Route | Budget (pro 10 min) | Warum |
| ----- | ------------------- | ----- |
| `POST /v1/pollar/oauth/authorize` | 20 | Begrenzt die Wallet-Erstellung |
| `POST /v1/pollar/oauth/token` | 60 | Clients wiederholen es, während das Konto bereitgestellt wird |
| `GET /v1/pollar/oauth/callback` | 60 | Die einzige Route, die ohne API-Key erreichbar ist |
| `GET /v1/pollar/oauth/sessions/{state}` | 400 | Eine Wallet fragt alle paar Sekunden ab; jede Abfrage kann Pollar erreichen |
| `POST /v1/pollar/oauth/refresh` · `/logout` | 60, gemeinsam | Je eine Pollar-Anfrage |
| `POST /v1/pollar/users` · `/users/with-wallet` | 10, gemeinsam | Schreiben in das Benutzerverzeichnis, das alle Tenants teilen; `with-wallet` erstellt zudem eine Wallet ohne Zustimmungsbildschirm |
| `POST /v1/pollar/wallets/activate` | 20 | Gibt bei jedem Aufruf XLM aus |
| `POST /v1/pollar/wallets/:address/trustlines` · `/default` | 20, gemeinsam | Jedes Asset bindet Reserve der Finanzierungs-Wallet |
| `DELETE /v1/pollar/wallets/:address/trustlines/:code/:issuer` | 20 | Je eine Pollar-Anfrage |
| `POST /v1/pollar/tokens/verify` | 120 | Je eine Pollar-Anfrage |

**Zwei Obergrenzen gelten pro Consumer statt pro Adresse**, sodass wechselnde Adressen
sie nicht vervielfachen: die Pollar-Anfragen, die ein Consumer auslösen kann (100 pro
Minute, auf allen Routen oben außer der Abfrage und dem Callback — Pollar budgetiert den
Key mit 200 pro Minute, und alle Tenants teilen ihn), und die Wallets, die er auslösen kann
(`authorize` und `users/with-wallet`, 50 pro Tag). Konsolenaufrufe (`X-Cosmos-Internal`)
sind von beiden ausgenommen: Die Dev-Plattform vermittelt jede Wallet ohne Key über einen
einzigen Consumer und budgetiert diesen Verkehr selbst.

Eine Überschreitung liefert **`429` mit `code: "rate_limited"`**, einen `Retry-After`
und die Header `RateLimit-Limit` / `-Remaining` / `-Reset`. Derselbe Limiter schützt
auch einige Routen außerhalb von Pollar — Swap- und Liquiditätspool-Submit, die
Webhook-Routen `ping` und `redeliver`, Alias-Challenges und -Wiederherstellung,
die Aktivitäts-Aufnahme —, und jeder Abschnitt nennt sein eigenes Budget.
Allgemeines Rate Limiting gehört in APISIX.

**Der Zähler liegt in Postgres, nicht im Speicher**, sodass das Limit über alle
Replikate hinweg gilt. Es ist ein festes Zeitfenster (ein atomares
`INSERT … ON CONFLICT … RETURNING` pro Anfrage), sodass ein Client auf jeder Seite einer
Fenstergrenze ein volles Budget verbrauchen kann.

**Client-Adresse.** `main.ts` setzt `trust proxy` auf `1`, sodass Express den
*rechtesten* Eintrag von `X-Forwarded-For` liest — den, den APISIX angehängt hat.
Einträge, die ein Client hinzufügt, landen links davon und werden ignoriert.

> **Erhöhen Sie `trust proxy` nicht.** Bei `2` vertraut Express einem vom Client
> gelieferten Hop, und jeder Client kann diese Limits mit einem Header umgehen.

IPv6-Aufrufer werden pro **/64** zusammengefasst, da ein Client meist ein ganzes /64
kontrolliert; Benutzer, die sich ein /64 teilen, teilen sich auch ein Limit, wie hinter
einem IPv4-NAT. Limits gelten außerdem pro Consumer, sodass der Traffic eines
Integrators keinen anderen beeinträchtigt.

Wenn der Zähler nicht geschrieben werden kann, arbeitet der Limiter **fail-closed**
(`503`); diese Routen brauchen die Datenbank ohnehin. Setzen Sie
`RATE_LIMIT_ENABLED=false`, um die Limits während eines Vorfalls abzuschalten.

### Einrichtung

1. Legen Sie unter [dashboard.pollar.xyz](https://dashboard.pollar.xyz) eine App an und
   übernehmen Sie beide Schlüssel für Ihr Netzwerk (`pub_testnet_…` / `sec_testnet_…`).
   Tun Sie das für **beide** Netzwerke: Ein Mainnet-Login stellt auch eine Testnet-Wallet
   bereit, und ohne Testnet-Schlüssel bleibt diese zweite Wallet auf `pending`, bis sie
   gesetzt sind. Die beiden Dashboards sind getrennt — registrieren
   Sie den Callback-Host in jedem.
2. Registrieren Sie den **Gateway-Host** von `POLLAR_BRIDGE_CALLBACK_URL` unter
   **Build → Domains**. Die SDK API prüft diese Liste bei *jedem* Aufruf anhand des
   `Origin`-Headers, den die Bridge auf diesen Host setzt (`POLLAR_SDK_ORIGIN`
   überschreibt ihn). Ein nicht registrierter Host erhält `403 ORIGIN_NOT_ALLOWED` bei
   `POST /auth/session`, dem ersten Aufruf jedes Logins.
3. Setzen Sie `POLLAR_BRIDGE_CALLBACK_URL` auf `<gateway>/v1/pollar/oauth/callback` —
   die Bridge hängt `/{state}` selbst an.
4. Fügen Sie die Redirect-URI jeder Wallet zu `POLLAR_REDIRECT_URI_WHITELIST` hinzu,
   oder lassen Sie sie weg und verwenden Sie den Poll-Flow.

Pollar kodiert Netzwerk und Schlüsseltyp im Präfix des Schlüssels, und der
Env-Validator weist eine Nichtübereinstimmung beim Start ab. Lassen Sie die Schlüssel
leer, um die Funktion zu deaktivieren (Pollar-Routen liefern dann `503`). Siehe
`.env.example`.

## Upgrade — Breaking Changes und Deploy-Hinweise

### Korrekturen aus dem Security-Review

Die meisten dieser Änderungen betreffen einen sich korrekt verhaltenden Aufrufer nicht;
prüfen Sie vor dem Deployment die Spalte „Wer es bemerkt“.

| Änderung | Wer es bemerkt | Warum |
| -------- | -------------- | ----- |
| `POST /v1/aliases/:name/recovery` ist **nur für die Plattform-Konsole**: Ein API-Key erhält `403 admin_console_only`, und die Route wurde aus dem veröffentlichten Vertrag entfernt | Jeder, der Wiederherstellungen mit einem API-Key gestartet hat | Die Antwort enthält das Wiederherstellungs-Token, das die Kontrolle über das Postfach des Inhabers belegt |
| Das Abschließen einer Wiederherstellung für einen `SUSPENDED`-Alias ergibt `404` | Niemand mit legitimen Absichten | Ein vor einer Sperre ausgestelltes Token konnte die Sperre durch den Operator umgehen |
| `@Public()`-Routen (Pollar-Callback, BlindPay-Webhook, Health) ignorieren `X-Consumer-Username` | Dashboards: Diese Anfragen werden jetzt als anonym protokolliert | Diese Routen haben kein key-auth, der Header kam also vom Client |
| Ablehnungen durch `AdminGuard` und `ConsoleOnlyGuard` werden auf `warn` protokolliert | Operatoren | Guards laufen vor dem Access-Log, sodass abgewiesene Anfragen keine Spur hinterließen |
| `POST /v1/pollar/wallets/activate` und die drei Routen `/v1/pollar/wallets/:address/trustlines…` liefern `404` für eine Wallet, die der aufrufende Consumer nicht über diesen Dienst in diesem Netzwerk erhalten hat | Integratoren, die auf Wallets einwirken, die sie nur über `tokens/verify` gesehen haben, auf nicht-primäre Wallets eines Logins oder auf eine Gegenstück-Wallet, die ein anderer Mandant bereits registriert hat | Alle Mandanten teilen sich einen Satz Pollar-Secret-Keys. Fremde und unbekannte Wallets erhalten beide `404`, sodass die Antwort nichts über das Eigentum verrät |
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
| `POST /v1/pollar/oauth/token` löst keinen Code mehr ein, den eine neuere Abfrage von `GET /v1/pollar/oauth/sessions/:state` ersetzt hat, selbst wenn diese Abfrage mitten in der Einlösung eintrifft | Niemand mit legitimen Absichten | Der Anspruch passte zum Handshake, aber nicht zum Code, sodass ein zurückgezogener Code in diesem Zeitfenster noch verwendet werden konnte |
| `POST /v1/swaps/:id/submit` und `POST /v1/liquidity-pools/operations/:id/submit` prüfen den Envelope vor allem anderen: Ein Body, der sich nicht parsen lässt, nicht der Envelope der Zeile ist oder keine Signaturen trägt, ergibt `400 validation_failed`, unabhängig vom Status der Zeile. Ein beliebiges `signedXdr` liefert keine `SUCCEEDED`-Zeile mehr, und eine `EXPIRED`-Zeile beantwortet einen nicht passenden Body mit `validation_failed` statt mit `invalid_state_transition` | Clients, die das unsignierte `xdr` eingereicht und sich auf die Ablehnung mit `tx_bad_auth` verlassen haben | Signaturen ändern den Hash einer Transaktion nicht, sodass der unsignierte Envelope in einer Schleife weitergeleitet und abgelehnt werden konnte, und unter dem gemeinsamen öffentlichen Key genügte allein die ID einer Zeile, um eine abgewickelte Zeile zu lesen |
| Beide Submit-Routen weisen einen Envelope ab, dessen Zeitgrenzen überschritten sind (`400 invalid_state_transition`, wird nicht gesendet; landete er dennoch, wickelt ihn der Observer trotzdem ab), sowie eine `FAILED`-Zeile, die bereits 3-mal erneut eingereicht wurde (`400 invalid_state_transition`: bauen Sie eine neue). Ein Wiederholungsversuch nach `503 provider_unavailable` zählt nicht mit | Clients, die Submit in einer Schleife wiederholen: Halten Sie bei `invalid_state_transition` an | Jeder abgelehnte Wiederholungsversuch war eine Horizon-Einreichung und ein neues terminales Webhook-Event, ohne Obergrenze |
| Beide Submit-Routen erlauben 20 Aufrufe pro Minute pro Consumer und Client-Adresse, in getrennten Kontingenten (`429 rate_limited`) | Wallets hinter demselben NAT, die sich den öffentlichen Key teilen | Die Routen nehmen den gemeinsamen öffentlichen Key an, und jeder Aufruf kann an Horizon senden |
| `GET /v1/webhooks`, `GET /v1/webhooks/:id` und `PATCH /v1/webhooks/:id` liefern nur die dokumentierten Endpunktfelder; `POST /v1/webhooks` und `POST /v1/webhooks/:id/rotate-secret` liefern diese plus `secret`. `consumerId`, `previousSecret` und `previousSecretExpiresAt` sind bei allen fünf entfallen | Aufrufer, die diese Felder lesen | `previousSecret` ist ein Signatur-Secret, das ein Integrator noch akzeptieren kann, und ein Key mit nur `webhooks:read` konnte es lesen |
| Ein Wiederherstellungs-Token, das zu keiner laufenden Wiederherstellung des Alias passt, zählt nicht mehr gegen sie. Ein laufendes Token verbraucht bei jeder Vorlage einen Versuch, auch wenn dessen Challenge oder Signatur anschließend fehlschlägt; nach fünf ist es `400 alias_recovery_invalid` | Niemand mit legitimen Absichten | Alias-Namen sind öffentlich, sodass fünf Datenmüll-Tokens von einem beliebigen Key jede von der Konsole gestartete Wiederherstellung verbrauchten |
| `POST /v1/aliases/:name/recovery/complete` (10 pro 10 min), `POST /v1/aliases/challenges` (30), `POST /v1/webhooks/:id/ping` (20) und `POST /v1/webhooks/:id/deliveries/:deliveryId/redeliver` (30) ergeben bei Budgetüberschreitung `429 rate_limited`, pro Consumer und Client-Adresse | Skripte, die diese Routen in einer Schleife aufrufen | Jeder Aufruf speichert eine Zeile, probiert ein Wiederherstellungs-Token oder sendet Anfragen an eine vom Aufrufer gewählte URL |
| `PATCH /v1/payment-intents/:id` verlangt, dass `txHash` ein 64-stelliger Hex-Stellar-Transaktions-Hash ist (alles andere ergibt `400`), und speichert ihn kleingeschrieben; `POST /v1/payment-intents/:id/validate` schreibt seinen eigenen ebenfalls klein. Ein Hash ist nur unter den Intents eines Consumers eindeutig statt mandantenübergreifend, und ein Hash, der bereits auf einem anderen Ihrer Intents liegt, ergibt `409 idempotency_conflict` (früher `500`) | Aufrufer, die Platzhalter- oder abgeschnittene Hashes senden | Jeder Mandant konnte den Transaktions-Hash eines anderen Mandanten auf einem eigenen Intent ablegen; die Abwicklung des anderen Mandanten traf dann auf den globalen Index, antwortete mit `500`, und der bezahlte Intent lief ab, ohne dass `PAYMENT_INTENT_SUCCEEDED` ausgelöst wurde |
| Ein `EXPIRED`-Intent wechselt nach `SUCCEEDED`, wenn seine Zahlung on-chain bestätigt wird: durch den Observer, der jetzt vor dem Ablaufen die Chain prüft, oder durch `POST /v1/payment-intents/:id/validate` und `PATCH {status: SUCCEEDED}`, die jetzt mit `200` statt mit `400 invalid_state_transition` antworten. `PAYMENT_INTENT_SUCCEEDED` kann auf das von `EXPIRED` ausgelöste Update folgen | Webhook-Consumer, die `EXPIRED` als endgültig behandeln | Der Ablauf prüfte nie die Chain, und der Verifier las nur die 50 neuesten Zahlungen an die Zieladresse, sodass eine späte oder vergrabene Zahlung einen bezahlten Intent dauerhaft `EXPIRED` ließ |
| `POST /v1/pollar/oauth/authorize` mit `redirect_uri` verlangt `code_challenge` (PKCE, S256), und das Einlösen dieses Handshakes verlangt `code_verifier`; ohne ihn ist der Aufruf `400 validation_failed`, bevor eine Pollar-Session eröffnet wird. Der Poll-Flow bleibt unverändert | Wallets im Redirect-Flow, die kein PKCE senden | Der öffentliche Callback gibt den Code jedem, der den `state` vorlegt, der in `authorization_url` steckt, und ohne PKCE ließ sich dieser Code unverändert einlösen |
| Antworten zu Swaps, Liquidity-Pool-Operationen, Payment Intents und Customers enthalten nur noch ihre dokumentierten Felder, plus das jetzt dokumentierte `expiresAt` bei Swaps und Payment Intents. `consumerId` und die Settlement-Buchführung (`settlementEpoch`, `lastCheckedAt`, `notFoundStreak`, `sharesReceived`, `settledAmountA`/`B`, `horizonCursor`) werden nicht mehr gesendet | Wer diese Felder liest | Sie sind intern, und mehrere dieser Routen sind mit dem gemeinsamen öffentlichen Key erreichbar |
| `PATCH /v1/kyc/receivers/:id` auf einen Receiver, der bereits bei BlindPay existiert, ist `403 kyc_review_required` für jedes Feld außer `external_id` und `image_url`, es sei denn, der Key ist erhöht (`X-Consumer-Role: admin`) | Integratoren, die die Identität eines aktiven Receivers mit einem Tenant-Key korrigieren: über den Prüfer leiten | Das `PUT` schickte nie geprüfte Identitätsdaten direkt an einen regulierten Anbieter, während dieselbe Änderung vor dem Aktivieren erneut in die Prüfung geht |
| BlindPay-Routen nutzen die Instanz der Key-Umgebung: `prod`-Keys die der unsuffigierten `BLINDPAY_*`-Variablen, `dev`-Keys die von `BLINDPAY_*_DEV`, und ein `dev`-Key ohne konfigurierte Entwicklungsinstanz erhält `503 misconfigured`. Receiver, Wallets, Bankkonten, virtuelle Konten, Quotes, Payins und Payouts werden nur auf dieser Instanz gelesen und ausgeführt | Alle, die BlindPay mit `dev`-Keys nutzen | Ein `dev`-Key bediente die Produktionsinstanz: Er konnte echte KYC-Identitäten auflisten und löschen und echte Payouts anlegen |
| `POST /v1/pollar/oauth/token` gibt eine Sitzung nur zurück, wenn die E-Mail, die Pollar für den Login meldet, die Konto-E-Mail ist, die das Gateway für den Key weiterleitet (`X-Consumer-Email`). Eine Abweichung widerruft die Sitzung, lässt den Handshake scheitern und ist `403 pollar_identity_mismatch`; ein Key ohne weitergeleitete E-Mail erhält bei `authorize` `403 pollar_identity_required` | Tenants, die ihre eigenen Endbenutzer über die gemeinsame Pollar-Anwendung anmelden, und alle, die sich mit einer anderen E-Mail als der ihres Kontos anmelden | Alle Tenants teilen eine Pollar-Anwendung, und ein Login-Link funktioniert in jedem Browser: Ein Key konnte seine `authorization_url` an jemanden senden, die Zustimmung abwarten und die verwahrte Wallet dieser Person einlösen |
| `POST /v1/pollar/users` und `/v1/pollar/users/with-wallet` verlangen einen erhöhten Key; ein Tenant-Key erhält `403 elevated_key_required` | Integratoren, die Benutzer mit einem Tenant-Key vorregistrieren | Ein registrierter Benutzer ist der, den ein späterer Social Login per E-Mail auflöst; ein Tenant-Key konnte also die E-Mail eines Fremden beanspruchen und als Eigentümer von dessen Wallet erfasst werden |
| Ein Testnet-Login stellt seinem Benutzer keine Mainnet-Wallet mehr bereit: `network_wallets` einer Testnet-Einlösung listet nur die Testnet-Wallet. Ein Mainnet-Login stellt weiterhin Testnet bereit | Wer einen Mainnet-Eintrag aus einem Testnet-Login liest | Ein `dev`-Key, den jeder erzeugen kann, gab pro Login echte XLM des Betreibers für eine Mainnet-Reserve aus |
| Die Pollar-Routen für Abfrage, Refresh, Logout, Token-Prüfung, Benutzerregistrierung und Trustline-Entfernung sind begrenzt, und zusätzlich zu den Budgets pro Adresse gelten eine Quote pro Consumer (100 Pollar-Anfragen pro Minute) und eine Wallet-Obergrenze (50 pro Tag); Überschreitungen sind `429 rate_limited` | Clients, die diese Routen massenhaft aufrufen | Sie hatten kein Limit, und jeder Aufruf verbraucht das Pollar-Anfragebudget, das alle Tenants teilen — ein Tenant konnte die Logins aller anderen scheitern lassen |

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
- **Migration `20260915120100_lookup_indexes`** baut zwei Indizes `CONCURRENTLY` für
  die Eigentumsprüfung von Pollar-Wallets
  (`pollar_oauth_session(consumerId, network, walletAddress)` und
  `pollar_user_wallet(consumerId, network, address)`). Schreibzugriffe werden nicht
  blockiert, aber ein fehlgeschlagener Build hinterlässt einen `INVALID`-Index, den
  `IF NOT EXISTS` als vorhanden ansieht: Finden Sie ihn mit
  `SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE NOT i.indisvalid;`,
  entfernen Sie ihn mit `DROP INDEX CONCURRENTLY`, führen Sie
  `prisma migrate resolve --rolled-back 20260915120100_lookup_indexes` aus und
  deployen Sie erneut.
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
- **Deployen Sie zuerst die Forwarder-Änderung der Dev-Plattform.** `authorize` weist jeden
  Key ab, für den das Gateway kein `X-Consumer-Email` weiterleitet. Der Forwarder hinterlegt
  die E-Mail pro Konto, sobald dessen Keys synchronisiert werden; synchronisieren Sie also
  bestehende Consumer neu (das Auflisten der Keys eines Benutzers im Dashboard erledigt das
  für diesen Benutzer). Bis dahin weicht die Wallet auf den vermittelten Login der
  Dev-Plattform aus, der den Header nicht braucht; andere Clients erhalten
  `403 pollar_identity_required`.
- **Social Login für Endbenutzer Dritter über die gemeinsame Pollar-Anwendung endet.** Ein
  Tenant, dessen App seine eigenen Benutzer anmeldet, erhält
  `403 pollar_identity_mismatch` für jeden Benutzer, dessen E-Mail nicht die Konto-E-Mail
  des Keys ist.
- **Migration `20260915180000_pollar_testnet_counterpart_mainnet`** schließt die
  Mainnet-Wallets, die Testnet-Logins auf `pending` hinterlassen hatten (`FAILED`,
  `COUNTERPART_FROM_TESTNET_DISABLED`), damit der Sweeper sie nicht mehr finanziert. Nur
  Daten, keine Schemaänderung.

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

### Die Pollar-Poll-Route erkennt einen abgeschlossenen Login jetzt selbst

`GET /v1/pollar/oauth/sessions/{state}` wartete früher auf den Bridge-Callback, den
Pollar nie aufruft, sodass Logins im Poll-Flow `pending` blieben, bis sie abliefen. Die
Abfrage prüft jetzt bei Pollar nach und stuft den Handshake bei `READY` hoch. Weder an
der API-Form noch an Clients ist eine Änderung nötig. Beim Deployment:

- **Migration `20260906120000_pollar_oauth_provider_probe`** fügt
  `pollar_oauth_session` ein nullbares `providerCheckedAt` hinzu. Kein Backfill.
- **Poll-Traffic erreicht jetzt Pollar.** Planen Sie eine Provider-Anfrage pro
  laufendem Login alle zwei Sekunden ein, über den Publishable Key des jeweiligen
  Netzwerks.

### Pollar-Logins stellen jetzt in beiden Netzwerken eine Wallet bereit

`POST /v1/pollar/oauth/token` hat ein `network_wallets`-Array erhalten — ein Eintrag
pro Stellar-Netzwerk, jeweils `ready`, `pending` oder `failed`. Die Änderung ist
additiv. Beim Deployment:

- **Führen Sie die Migration aus.** `20260905120000_pollar_user_wallet` fügt
  `pollar_user_wallet` und die Enum `PollarWalletStatus` hinzu. Ohne sie protokolliert
  jede Einlösung eine fehlgeschlagene Bereitstellung, und die Gegenstück-Wallet bleibt
  unerfasst — der Login selbst funktioniert weiterhin.
- **Setzen Sie die Schlüssel für beide Netzwerke.** `POLLAR_*_MAINNET` und
  `POLLAR_*_TESTNET` sind jeweils optional, und ein Netzwerk ohne Schlüssel erscheint
  bei jedem Login als `pending`-Wallet. Sobald das zweite Paar gesetzt ist, stellt der
  Sweeper den Rückstand beim nächsten Tick bereit; andernfalls bleiben die Zeilen
  `pending`, bis ihre Versuche aufgebraucht sind. Logins schlagen in keinem Fall fehl.

Ein Mainnet-Login finanziert eine Reserve in *beiden* Netzwerken. Ein Testnet-Login
finanziert nur das Testnet — früher finanzierte er auch das Mainnet, was die Korrekturen
aus dem Security Review oben entfernt haben.

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
Pollar lieferte in derselben Situation bereits `misconfigured`.

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
| `APISIX_EMAIL_HEADER` | nein | `x-consumer-email` | Verifizierte E-Mail des Kontos des Keys. Die Pollar-Bridge gibt die Sitzung eines Logins nur an dieses Konto zurück und weist einen Key ohne sie ab |
| `APISIX_PUBLIC_CONSUMER` | nein | — | Benutzername des gemeinsamen öffentlichen Consumers (siehe oben). Setzen Sie ihn überall, wo ein öffentlicher Key veröffentlicht wird |
| `STELLAR_NETWORK` | nein | `testnet` | Fallback-Stellar-Netzwerk (`public` / `testnet`) |
| `STELLAR_HORIZON_URL_PUBLIC` | nein | `https://horizon.stellar.org` | Horizon-Basis-URL für Mainnet |
| `STELLAR_HORIZON_URL_TESTNET` | nein | `https://horizon-testnet.stellar.org` | Horizon-Basis-URL für Testnet |
| `STELLAR_BASE_FEE` | nein | `100` | Stellar-Basisgebühr (Stroops) für Transaktions-Builds |
| `STELLAR_TX_TIMEOUT` | nein | `300` | Transaktions-Timeout (Sekunden) |
| `STELLAR_SWAP_FEE_WALLET` | wenn Gebühr > 0 | — | G...-Plattformkonto für Swap-Gebühren |
| `STELLAR_SWAP_FEE_BPS` | nein | `50` | Swap-Gebühr in Basispunkten |
| `STELLAR_SWAP_SLIPPAGE_BPS` | nein | `50` | Standardtoleranz für Swap-Slippage (bps) |
| `STELLAR_SWAP_MAX_SLIPPAGE_BPS` | nein | `500` | Harte Obergrenze für die Slippage des Aufrufers (bps) |
| `STELLAR_SWAP_SINGLE_INFLIGHT` | nein | `false` | Bei `true` 409, wenn für dieselbe Quelle bereits ein nicht abgelaufener PENDING-Swap existiert |
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
| `KYC_REDIRECT_URL_WHITELIST` | nein | — | Allowlist der KYC-Redirect-Hosts pro Consumer |
| `RATE_LIMIT_ENABLED` | nein | `true` | Obergrenzen pro Adresse auf den Routen, die XLM ausgeben. Notfallschalter |
| `RATE_LIMIT_PRUNE_INTERVAL_MS` | nein | `600000` | Bereinigungsintervall der Zählerfenster (ms, mind. 1000) |
| `POLLAR_PUBLISHABLE_KEY_TESTNET` / `_MAINNET` | nein | — | Publishable Key von Pollar (`pub_<network>_…`), für die OAuth-Bridge |
| `POLLAR_SECRET_KEY_TESTNET` / `_MAINNET` | mit dem Publishable Key | — | Secret Key von Pollar (`sec_<network>_…`), für die Operator-Routen |
| `POLLAR_BRIDGE_CALLBACK_URL` | wenn ein Pollar-Key gesetzt ist | — | Öffentliche URL, zu der Pollar den Browser zurückleitet. Muss `<gateway>/v1/pollar/oauth/callback` sein **und** ein unter Build → Domains von Pollar registrierter Host |
| `POLLAR_REDIRECT_URI_WHITELIST` | nein | — | Allowlist der Wallet-Redirect-URIs pro Consumer. Leer ⇒ dieser Consumer kann nur den Poll-Flow verwenden |
| `POLLAR_SDK_ORIGIN` | nein | Origin von `POLLAR_BRIDGE_CALLBACK_URL` | `Origin`, der an die SDK API von Pollar gesendet wird, die ihn gegen Build → Domains prüft. Nur setzen, wenn Callback-Host und registrierter Host voneinander abweichen |
| `POLLAR_SDK_BASE_URL` | nein | `https://sdk.api.pollar.xyz` | Basis-URL der Pollar SDK API |
| `POLLAR_SERVER_BASE_URL` | nein | `https://api.pollar.xyz` | Basis-URL der Pollar Server API |
| `POLLAR_TIMEOUT_MS` | nein | `15000` | Timeout des Pollar-HTTP-Clients (ms) |
| `POLLAR_AUTHORIZATION_TTL_MS` | nein | `300000` | Wie lange ein Login-Handshake offen bleibt |
| `POLLAR_CODE_TTL_MS` | nein | `120000` | Wie lange ein ausgestellter Bridge-Code einlösbar bleibt |
| `POLLAR_LOGIN_WAIT_MS` | nein | `20000` | Wie lange die Einlösung wartet, bis Pollar die Wallet bereitgestellt hat |
| `POLLAR_SWEEP_ENABLED` | nein | `true` | Handshakes ablaufen lassen, die niemand abgeschlossen hat, und die netzwerkübergreifenden Wallets erneut versuchen, die ein Login auf `pending` gelassen hat |
| `POLLAR_SWEEP_INTERVAL_MS` | nein | `60000` | Intervall des Handshake-Sweepers (ms, mind. 1000) |

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
