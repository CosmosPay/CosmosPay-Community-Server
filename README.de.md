# Cosmos Pay — Zahlungs-Microservice

[English](./README.md) · [Español](./README.es.md) · [Português](./README.pt.md) · **Deutsch** · [Français](./README.fr.md) · [हिन्दी](./README.hi.md) · [简体中文](./README.zh.md)

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

Eine Oberfläche liest aus denselben zwei Bedingungen mehr heraus. `/v1/admin` ist
mandantenübergreifend, und `AdminGuard` lässt eine Anfrage dort nur zu, wenn sie
zusätzlich `X-Cosmos-Internal` trägt — einen Header, den APISIX aus allem, was es
weiterleitet, **entfernt**, sodass ihn nur ein direkter Aufruf eines Backends vorlegen
kann, das das Gateway-Secret besitzt. Dieses Backend ist die Entwicklerplattform, die
bereits entschieden hat, ob das angemeldete Konto Owner/Admin ist. Es gibt kein
separates Admin-Credential zu deployen (siehe den Upgrade-Hinweis zu
`ADMIN_API_CREDENTIALS`). Damit sind das Gateway-Secret und die Netzwerkisolation die
gesamte Grenze vor mandantenübergreifenden Daten — und die Entfernungsliste in der
Gateway-Route ist sicherheitsrelevant, nicht bloße Hygiene.

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
Konsolen-Backend erreicht sie. Pfade verwenden die OpenAPI-Form `{param}`, und
`npm run readme:check` lässt CI fehlschlagen, wenn eine Route aus dem Vertrag in dieser
Tabelle fehlt.

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
`ApiErrorBodyEntity` veröffentlicht und an jede Operation angehängt — ein generierter
Client erhält also auch den Fehlertyp, und Sie müssen dieses Repository nicht lesen, um
die Codes zu finden. Maßgeblich ist `ApiErrorCode` in `src/common/errors/api-error.ts`.
**Einmal veröffentlichte Codes werden nie umbenannt**; neue können hinzukommen,
behandeln Sie einen unbekannten Code daher gemäß seinem HTTP-Status.

Einige, die leicht verwechselt werden:

| Code | Status | Bedeutung |
| ---- | ------ | --------- |
| `insufficient_scope` | 403 | Dem API-Key fehlt der Scope. Stellen Sie den Key neu aus |
| `account_disabled` | 403 | Ein Operator hat dieses Fiat-Konto deaktiviert. Kein Problem des Keys |
| `gateway_required` | 403 | Die Anfrage kam nicht über APISIX |
| `admin_console_only` | 403 | Die Route gehört zur Plattform-Konsole (`/v1/admin`, Start einer Alias-Wiederherstellung). Kein API-Key kann sie aufrufen |
| `idempotency_conflict` | 409 | Dieser `Idempotency-Key` (oder dieses Payment-Intent-Memo) hat bereits eine Ressource für eine *andere* Anfrage erzeugt. Wiederholen Sie die ursprüngliche Anfrage oder verwenden Sie einen neuen Key |
| `kyc_state_invalid` | 409 | Ein unzulässiger KYC-Zustandsübergang — keine doppelte Anfrage |
| `operation_in_flight` | 409 | Eine kollidierende Operation wird noch abgewickelt |
| `payload_expired` | 409 | Der Body der Zustellung hat die Aufbewahrungsfrist überschritten und kann nicht erneut gesendet werden |
| `provider_unavailable` | 503/504 | BlindPay oder Horizon ist nicht erreichbar. Erneut versuchen |
| `misconfigured` | 503 | Ein serverseitiger Konfigurationsfehler. Ein erneuter Versuch hilft nicht |

Jeder Intent wird **persistiert** (Tabelle `payment_intent`) und ist dem
authentifizierten APISIX-Consumer zugeordnet, sodass Lese-, Update- und Löschvorgänge
stets nur die eigenen Datensätze dieses Consumers betreffen — vollständige
Nachvollziehbarkeit des Lebenszyklus jedes Intents
(`PENDING → SUBMITTED → SUCCEEDED/FAILED/CANCELLED/EXPIRED`).

### Betrieb mit mehr als einem Replikat

APISIX verteilt die Last auf mehrere Instanzen, daher läuft jedes `setInterval` in
diesem Dienst einmal pro Replikat. Die Korrektheit war nie das Problem — jede
Statusänderung läuft über ein abgesichertes `updateMany`-Compare-and-Swap, sodass nur
ein Schreiber gewinnt —, aber drei Replikate bedeuteten die dreifache Zahl an
Horizon-Roundtrips für identische Arbeit gegen eine API mit Rate Limit, und Replikate,
die um das Löschen derselben `request_log`-Tupel konkurrierten.

Jeder Hintergrund-Timer nimmt jetzt einen PostgreSQL-**Advisory-Lock auf
Transaktionsebene** (`AdvisoryLockService`,
`src/common/services/advisory-lock.service.ts`) und überspringt seinen Tick, wenn ein
anderes Replikat ihn hält:

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

`pg_try_advisory_xact_lock` wird aus drei Gründen statt der Variante auf Sitzungsebene
verwendet: Er blockiert nie (ein Replikat, das verliert, überspringt einfach, und genau
das will ein Poller), er wird am Ende der Transaktion freigegeben — auch bei einem
Absturz oder einer abgebrochenen Verbindung, sodass ein beendeter Pod den Lock nicht
blockieren kann —, und er bleibt deshalb auch hinter PgBouncer im
Transaction-Pooling-Modus korrekt, wo Locks auf Sitzungsebene unsicher sind, weil
Verbindungen nicht fest zugeordnet sind.

Lock-IDs stehen in der Enum `AdvisoryLockKey` und sind die Identität der Aufgabe: Ein
Mitglied umzubenennen und ihm eine neue Nummer zu geben, deaktiviert den gegenseitigen
Ausschluss stillschweigend; ausgemusterte Nummern werden daher nie wiederverwendet.

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
  Nichtübereinstimmung, die den Status unverändert lässt, sodass eine korrekte
  Transaktion weiterhin eingereicht werden kann; andernfalls würde der Hash jeder
  beliebigen fehlgeschlagenen Transaktion im Netzwerk einen Intent endgültig scheitern
  lassen.
- **Automatisch (permanenter Observer):** `StellarObserverService` fragt Horizon alle
  `OBSERVER_INTERVAL_MS` nach `PENDING`-Intents ab — über den gemeldeten `txHash` oder
  durch Durchsuchen der Zahlungen an die Zieladresse — und finalisiert Treffer auf
  dieselbe Weise, sodass sich Status ändern und Events ausgelöst werden, **ohne dass
  jemand die API aufruft**. Ein Tick übernimmt höchstens
  `OBSERVER_MAX_INTENTS_PER_CONSUMER` (10) Intents pro Consumer und durchsucht nie einen
  abgelaufenen, sodass eine Flut von einem einzelnen Consumer — den gemeinsamen
  öffentlichen Key eingeschlossen — die Abwicklung aller anderen nicht aushungern kann.
  Für die lokale Entwicklung mit `OBSERVER_ENABLED=false` deaktivieren.

### Aufbewahrung der API-Request-Logs

Jede eingehende Anfrage außer `/v1/health` und `/docs` wird von `LoggingInterceptor`
an `request_log` angehängt und speist die Dashboard-Ansicht **API-Logs**
(`GET /v1/logs`). Die Zeilen enthalten Pfad, Status, Dauer und — falls vorhanden —
`ip` / `userAgent` des Zahlers.

Dashboard-Traffic (`X-Cosmos-Internal`) wird **aufgezeichnet und markiert**
(`request_log.internal`), nicht übersprungen, und die API-Log-Ansicht filtert nach
dieser Spalte. Eine frühere Version kehrte bei diesem Header vorzeitig zurück, was
bedeutete, dass jeder, der ihn setzen konnte, seine Anfragen vollständig aus dem
Audit-Log heraushielt — ein Request-Header darf Traffic niemals unsichtbar machen können.

Diese Zeilen werden **nicht dauerhaft aufbewahrt**. `RequestLogRetentionService`
löscht Zeilen, die älter als `REQUEST_LOG_RETENTION_DAYS` (Standard **30**) sind, per
Timer (`REQUEST_LOG_PRUNE_INTERVAL_MS`, Standard **1h**). Jeder Zyklus löscht in kurzen
Blöcken von `REQUEST_LOG_PRUNE_BATCH_SIZE` (Standard **1000**) und läuft weiter, bis
der Rückstand abgebaut oder `REQUEST_LOG_PRUNE_MAX_PER_CYCLE` (Standard **50000**)
erreicht ist, sodass ein großer Bestand aufholen kann, ohne einen langen Tabellen-Lock
zu halten. Setzen Sie `REQUEST_LOG_RETENTION_DAYS=0`, um das Bereinigen ganz zu
deaktivieren (der Dienst protokolliert das beim Start). Der zusammengesetzte Index auf
`(consumer, createdAt)` hält die Dashboard-Abfrage auch bei wachsendem Volumen schnell.

### Client-Aktivität (was Wallet und Dashboard melden)

`request_log` zeichnet auf, was diesen Dienst erreicht hat. Es kann nicht aufzeichnen,
was ein Client *getan* hat: eine Wallet, die auf ihrem Senden-Bildschirm abgestürzt ist,
eine Signatur, die der Benutzer abgebrochen hat, eine Dashboard-Seite, die einen Fehler
warf, bevor überhaupt eine Anfrage den Browser verließ. Nichts davon erzeugt hier einen
HTTP-Aufruf, und genau das sind die Events, die man haben möchte, wenn etwas nicht
stimmt — deshalb melden die Clients ihre eigenen, an `POST /v1/activity/events`.

- **Ein Batch, kein Aufruf pro Event.** Clients sammeln Events in einer Warteschlange
  und senden sie gebündelt, sodass eine Offline-Wallet ihre Events behält und beim
  nächsten Start sendet. Bis zu `ACTIVITY_MAX_BATCH` (100) pro Anfrage, geschrieben in
  einer einzigen Anweisung.
- **Ein erneuter Sendeversuch ist sicher.** Ein Event kann die eigene `eventId` des
  Clients tragen; `(consumerId, eventId)` ist eindeutig und der Insert überspringt
  Duplikate, sodass ein Batch, der geschrieben wurde, dessen Bestätigung aber nie
  ankam, erneut gesendet werden kann, ohne jede Zeile zu verdoppeln. Die Antwort meldet
  `accepted` und `duplicates`.
- **Die Zuordnung stammt vom Gateway, nie aus dem Body.** Zeilen werden unter dem
  Consumer geschrieben, den APISIX authentifiziert hat. Ein Client kann keine Events
  für ein anderes Konto einreichen, und es gibt kein Feld, mit dem er es versuchen könnte.
- **Die Aufnahme scheitert nicht an der Form eines Payloads.** Eine überlange `message`
  wird gekürzt, und ein übergroßes `props` wird durch
  `{"_dropped": "props_too_large"}` ersetzt; ein 400 würde den ganzen Batch kosten, und
  der Batch ist gerade dann am wichtigsten, wenn sich der Client in einem Zustand
  befindet, den niemand vorhergesehen hat.
- **Eine falsch gehende Geräteuhr kann den Feed nicht umsortieren.** `occurredAt` wird
  auf den Empfangszeitpunkt begrenzt, wenn es mehr als fünf Minuten in der Zukunft oder
  mehr als sieben Tage in der Vergangenheit liegt, sodass ein Telefon, das eine Stunde
  vorgeht, seine Events nicht an die Spitze einer nach Neuestem sortierten Liste heften
  kann. Beide Zeiten werden gespeichert: `at` (die des Clients) und `receivedAt`.

Auslesen:

| Route                   | Scope             | Liefert                                                              |
| ----------------------- | ----------------- | -------------------------------------------------------------------- |
| `GET /v1/activity/events` | `activity:read` | Den Feed, neueste zuerst. Filter: `source`, `level`, `category`, `type` (Präfix), `network`, `since`/`until` |
| `GET /v1/activity/summary` | `activity:read` | Anzahlen pro Level/Quelle/Kategorie, häufigste Event-Typen, häufigste Fehler, Sitzungen, Geräte, eine Tagesreihe |

`level` ist im Feed eine **Untergrenze**, keine exakte Übereinstimmung: `level=warn`
liefert Warnungen *und* Fehler. Ein Filter, der nur die Zeilen liefert, die jemand als
`error` gekennzeichnet hat, würde die Warnungen verbergen, die zu ihnen geführt haben.

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

**Was ein aus BlindPay stammender Body enthält.** `RECEIVER_UPDATED` / `PAYIN_*` /
`PAYOUT_*` tragen nur Identität und Zustand — IDs, Status, Beträge, Rails — nie
personenbezogene Daten. Das Provider-Objekt wird *nicht* unverändert weitergeleitet:
Ein Receiver-Payload ist ein vollständiges KYC-Dossier (Steuernummer, Geburtsdatum,
Adresse, Dokumentlinks), und für das Abonnieren eines Events genügt `webhooks:write` —
der Webhook wäre damit ein Weg, sich dieses Dossier an einen beliebigen Host liefern zu
lassen. Rufen Sie die Details über die API mit einem Key ab, der `kyc:read` /
`onramp:read` / `offramp:read` besitzt. Die genaue Feld-Allowlist steht in
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

**Die tatsächliche Obergrenze liegt bei 9 Versuchen, nicht bei 3.**
`WEBHOOK_MAX_ATTEMPTS` begrenzt eine In-Process-Retry-Schleife. Der Sweeper übernimmt
anschließend Zustellungen, die noch innerhalb von `WEBHOOK_MAX_ATTEMPTS × 3` Versuchen
insgesamt liegen, sodass eine Zustellung bis zu neunmal, verteilt über Stunden,
versucht werden kann. Das ist beabsichtigt — ein während des Backoffs beendeter Pod
ließ früher eine PENDING-Zustellung für immer liegen, was eine abgewickelte Zahlung
bedeutete, über die niemand benachrichtigt wurde.

**Die erneute Zustellung erfolgt nach bestem Bemühen innerhalb der Aufbewahrungsfrist.**
Nach `WEBHOOK_PAYLOAD_RETENTION_DAYS` wird der gespeicherte Body geleert (ein
`RECEIVER_UPDATED`-Body ist ein KYC-Dossier, und das Zustellprotokoll wird
aufbewahrt). Der Sweeper überspringt diese Zeilen, und
`POST /v1/webhooks/:id/deliveries/:id/redeliver` liefert `409 payload_expired`, statt
einen geschwärzten Body unter einem echten Event-Typ mit gültiger Signatur zu senden.

**Vertrag für Empfänger.** Jeder `2xx` gilt als Bestätigung. Antworten Sie innerhalb von
`WEBHOOK_READ_TIMEOUT_MS` (standardmäßig 5s). Es gibt keine Reihenfolgegarantie;
behandeln Sie die Events daher als Menge und gleichen Sie gegen die API ab.
Deduplizieren Sie anhand der Event-`id` — beachten Sie, dass eine erneute Zustellung
die ursprüngliche `id` wiederverwendet, sodass ein strikt deduplizierender Empfänger
sie ignoriert; das ist der beabsichtigte Kompromiss (At-least-once-Zustellung,
Exactly-once-Wirkung).

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

### OpenAPI / Swagger

**Sicherheitshinweis:** `GET /docs`, `/docs/json` und `/docs/yaml` werden von
`SwaggerModule.setup` als **Express-Middleware** eingehängt, nicht als Nest-Controller.
Sie laufen **nicht** durch `ApisixGuard` oder `PermissionsGuard` — jeder, der den Port
des Dienstes erreicht, kann die vollständige API-Spezifikation abrufen, sofern die Docs
nicht deaktiviert sind. In Produktion sind die Docs **standardmäßig aus**
(`NODE_ENV=production` und kein `SWAGGER_ENABLED`). Setzen Sie `SWAGGER_ENABLED=true`
nur, wenn Sie die Spezifikation bewusst in einem vertrauenswürdigen Netzwerk
veröffentlichen wollen.

Live-Docs (wenn aktiviert):

- `GET /docs` — Swagger UI
- `GET /docs/json` — OpenAPI-3.0-Spezifikation (JSON)
- `GET /docs/yaml` — OpenAPI-3.0-Spezifikation (YAML)

Exportieren Sie die Spezifikation in Dateien (damit ein anderer Server sie hosten oder
verwenden kann) — dafür sind weder eine Datenbankverbindung noch ein echtes
Gateway-Secret nötig; der Export läuft im Nest-Preview-Modus mit lokalen Platzhaltern,
wenn diese Umgebungsvariablen fehlen:

```bash
npm run openapi:generate
# writes openapi/openapi.json and openapi/openapi.yaml
```

CI und das Release-Gate erzeugen beide eingecheckten Dateien neu und weisen
Abweichungen zurück. Führen Sie dieselbe Prüfung aus, bevor Sie eine Änderung an einem
Controller oder DTO committen:

```bash
npm run openapi:check
```

Pfade in der Spezifikation enthalten bereits die Version (`/v1/...`). Um einen
konkreten Gateway-Host in die `servers` der Spezifikation einzutragen, setzen Sie
`OPENAPI_SERVER_URL` vor dem Generieren:

```bash
OPENAPI_SERVER_URL=https://gateway.example.com npm run openapi:generate
```

Die Swagger-Konfiguration (`src/swagger.ts`) wird vom laufenden Server und vom
Generator gemeinsam genutzt, sodass beide synchron bleiben. Die beiden APISIX-Header
(`X-Gateway-Secret`, `X-Consumer-Username`) sind in der Spezifikation als Security
Schemes dokumentiert.

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

**Das Memo ist ein verpflichtendes `MEMO_ID`** — es identifiziert die Zahlung on-chain
und verleiht dem Intent **Idempotenz**: `(consumer, memo)` ist eindeutig, sodass ein
erneutes Anlegen mit demselben Memo **und denselben Konditionen** den ursprünglichen
Intent zurückgibt. Dasselbe Memo mit irgendeiner abweichenden Kondition — Art,
Netzwerk, Zieladresse, Betrag, Asset, `msg`, `callback` oder bei `tx` die `source` —
ergibt `409 idempotency_conflict`, und der Fehler verrät nichts über den gespeicherten
Intent. Dieser Vergleich existiert wegen des gemeinsamen öffentlichen Keys: Jede anonyme
Wallet ist ein und derselbe Consumer, sodass ohne ihn ein Memo, das jemand anderes
zuerst verwendet hatte, Ihnen *dessen* Intent auslieferte — mit einem QR-Code, der an
ihn zahlte. Wenn Sie kein `memo` übergeben, wird ein zufälliges uint64 erzeugt.

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

Jeder Endpunkt dokumentiert in der OpenAPI-Spezifikation eine typisierte Antwort
mit Beispiel-Payloads (`TxPaymentIntentEntity`,
`PayPaymentIntentEntity`, `ValidationOutcomeEntity`), sodass Swagger eine konkrete
Beispielantwort zeigt statt eines leeren Bodys.

Antwort:

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

Die Wallet ist Open Source und liefert einen API-Key mit, den alle besitzen, sodass eine
Person swappen, Liquidität bereitstellen oder einen Zahlungslink erstellen kann, ohne
sich zu registrieren. Sie zahlt die Provision des `community`-Plans — 150 bps, der
höchste Satz überhaupt —, und erst eine Registrierung verschafft einen niedrigeren. Das
Gateway injiziert den Satz pro Consumer genau wie bei einem privaten Key (siehe
`resolvePlanCommissionBps`), sodass die Preisgestaltung hier keinerlei Sonderbehandlung
erfährt.

Besonders ist dagegen die Mandantentrennung. Jeder anonyme Aufrufer im Netz kommt als
derselbe APISIX-Consumer an, und die Lese-Endpunkte filtern Zeilen genau nach diesem
Consumer:

```ts
// swaps.service.ts
where: { id, consumer: { apisixUsername: consumer.username } }
```

`GET /v1/swaps` unter dem öffentlichen Key würde also jedem anonymen Benutzer die
Swap-Historie der gesamten anonymen Nutzerschaft ausliefern. Scopes können das nicht
beheben — ein Scope ist eine Eigenschaft des Keys, und alle besitzen denselben Key —,
und die Überschneidung ist nicht hypothetisch: `POST /v1/swaps/quote` erfordert
`swaps:read`, also denselben Scope, mit dem die Historie aufgelistet wird.

**`PublicKeyGuard` ist daher eine Allowlist, keine Denylist.** Ein öffentlicher Consumer
wird auf jeder Route abgewiesen, die nicht `@AllowPublicKey()` trägt, sodass eine im
nächsten Jahr hinzugefügte Route für den öffentlichen Key unerreichbar bleibt, bis
jemand im selben Diff etwas anderes festlegt. Ein vergessener Decorator erzeugt ein
Support-Ticket; ein vergessener Denylist-Eintrag erzeugt ein Datenleck.

Heute mit dem öffentlichen Key erreichbar:

| Route | Warum sie sicher ist |
| --- | --- |
| `POST /v1/swaps/quote` | Bepreist einen Pfad über Horizon; eine reine Funktion der Anfrage |
| `POST /v1/swaps` | Baut einen unsignierten Envelope, den der Aufrufer signiert |
| `POST /v1/swaps/:id/submit` | Sendet einen vom Aufrufer signierten Envelope — erfordert die UUID des Swaps *und* eine Signatur seines Quellkontos |
| `POST /v1/liquidity-pools/deposit` \| `withdraw` | Bauen unsignierte Envelopes |
| `POST /v1/liquidity-pools/operations/:id/submit` | Sendet einen vom Aufrufer signierten Envelope |
| `GET /v1/liquidity-pools` \| `/:poolId` \| `/positions` | Öffentliche On-Chain-Daten, gelesen von Horizon |
| `POST /v1/payment-intents/tx` \| `pay` | Bauen einen SEP-7-Intent aus der Anfrage |
| `POST /v1/activity/events` | Telemetrie-Aufnahme — siehe unten |
| `GET /v1/assets` | Der öffentliche Asset-Katalog |
| `GET /v1/aliases/resolve/:name` \| `availability/:name` \| `by-address/:address` | Ein Zahler, der ein Handle auflöst, ist genau der anonyme Aufrufer, für den dieser Key existiert; die Antwort ist eine reine Funktion der Anfrage und enthält nie das Postfach des Inhabers |

Abgewiesen, und zwar bewusst: `GET /v1/swaps`, `GET /v1/swaps/:id`,
`GET /v1/liquidity-pools/operations{,/:id}`, `GET /v1/activity/events`,
`GET /v1/activity/summary`, jeder Lesezugriff auf Payment Intents, jede Inhaber-Route
für Aliase (Beanspruchen, Auflisten, Hinzufügen oder Entfernen einer Adresse, Freigeben,
Wiederherstellung) sowie alles unter `/v1/kyc`, `/v1/onramp`, `/v1/offramp` und
`/v1/webhooks`. Eine Wallet ohne Konto baut ihre Historie stattdessen aus Horizon auf,
das ohnehin die maßgebliche Quelle für On-Chain-Aktivität ist.

**Telemetrie steht mit Absicht auf der Liste.** Auch eine Wallet ohne CosmosPay-Konto
stürzt ab, und ihre Fehlerberichte abzulehnen, würde uns genau gegenüber der
Nutzergruppe blind machen, die auf Fehler beim ersten Start trifft — die Aufnahme-Route
würde `403` antworten und die Berichte würden verworfen. Events, die über diesen Key
eintreffen, sind konstruktionsbedingt anonym (ein gemeinsamer Consumer), daher darf
nichts Kontoidentifizierendes mit ihnen übertragen werden; die Wallet entfernt Adresse,
Ziel, Betrag und txHash vor dem Senden.

Der Guard erkennt den öffentlichen Consumer **entweder** an der weitergeleiteten Rolle
(`X-Consumer-Role: public`) **oder** am konfigurierten Benutzernamen
`APISIX_PUBLIC_CONSUMER`. Zwei Signale, weil jedes für sich allein auf eine Weise offen
versagt, die Benutzerdaten kostet: Ein Gateway, das keine Rollen mehr weiterleitet,
würde jeden anonymen Aufrufer zu einem gewöhnlichen Mandanten befördern, und ein
Deployment, das die Umgebungsvariable nie gesetzt hat, würde sich auf einen Header
verlassen, den es nicht kontrolliert. Setzen Sie beides.

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

Optionale **Idempotenz** (Issue #17): Senden Sie einen `Idempotency-Key`-Header
(bevorzugt) oder `idempotencyKey` im Body. Ein Wiederholungsversuch mit demselben Key
**und derselben Anfrage** — Netzwerk, Quelle, Ziel, beide Assets, Betrag, Slippage und
Memo — liefert den **bestehenden** Swap (`id` + `txHash`), statt eine weitere
Stellar-Transaktion zu bauen. Derselbe Key mit einer irgendwie abweichenden Anfrage
ergibt `409 idempotency_conflict`, und der Fehler verrät nichts über den gespeicherten
Swap. Einzahlungen in und Auszahlungen aus Liquiditätspools folgen derselben Regel,
wobei zusätzlich die Art der Operation verglichen wird. Der Vergleich existiert wegen
des gemeinsamen öffentlichen Keys: Jede anonyme Wallet ist ein und derselbe Consumer,
sodass ein Key, den jemand anderes zuerst verwendet hatte, Ihnen *dessen* unsignierten
Envelope auslieferte — einen, der Ihre Gelder zu ihm hätte bewegen können. Ohne Key
weist die Unique-Constraint `(network, txHash)` einen byte-identischen Neubau dennoch
mit **409** ab (Sequenz- bzw.
XDR-Kollision). Wenn `STELLAR_SWAP_SINGLE_INFLIGHT=true` gesetzt ist, liefert ein
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

Der Hash der signierten Transaktion wird vor dem Senden mit dem vom Dienst gebauten
abgeglichen, sodass ein Aufrufer den Dienst niemals eine beliebige Transaktion
weiterleiten lassen kann. Ein Swap löst die Webhook-Events `SWAP_CREATED` /
`SWAP_SUBMITTED` / `SWAP_SUCCEEDED` / `SWAP_FAILED` über denselben Dispatcher aus.

## Aliase — beanspruchbare Zahlungs-Handles

Ein Alias ermöglicht es einem Zahler, `emanuel250` statt `GA5ZSE…` einzugeben. Er ist
zugleich das, was ein Zahler unmittelbar vor der Autorisierung einer Überweisung liest;
jede der folgenden Regeln existiert daher, weil ein Fehler hier keine fehlerhafte Zeile
erzeugt — sondern eine Zahlung an das falsche Konto unter einem Namen, dem der Zahler
vertraut hat.

### Beansprucht durch den Nachweis der Kontrolle über einen Schlüssel, nicht auf Zuruf

```
wallet ──1. POST /v1/aliases/challenges {name, address, network} ──▶ nonce + the EXACT message to sign
wallet ──2. signs SHA-256(domain ‖ 0x00 ‖ uint32be(length) ‖ message) with that address's key
wallet ──3. POST /v1/aliases {name, email, nonce, signature} ────────▶ alias bound to the calling consumer
```

- **Der Dienst liefert die Nachricht; der Client baut sie nie nach.** Ein Client, der
  sie anhand der Dokumentation zusammensetzt, ist nur eine geänderte Feldreihenfolge
  von Signaturen entfernt, die abgewiesen werden, ohne dass eine der beiden Seiten
  sagt, warum.
- **Die Signatur deckt einen Digest mit Domain-Tag ab, nie eine Transaktion.** Nichts,
  was dieser Ablauf eine Wallet signieren lässt, kann an das Netzwerk übermittelt
  werden, und die Domain (`Cosmos Pay alias claim v1`) gehört allein zu dieser
  Funktion, sodass eine Dapp, die einen Benutzer zum Signieren einer beliebigen
  Nachricht überredet, damit keinen gültigen Claim erlangen kann.
- **Der Zweck steckt in den signierten Bytes** (`CLAIM`, `ADD_ADDRESS`, `RECOVER`),
  sodass eine Signatur, die zum Hinzufügen einer Adresse eingeholt wurde, nicht erneut
  verwendet werden kann, um eine Wiederherstellung abzuschließen.
- **Die Adresse stammt aus der Challenge, nicht aus dem Claim-Body.** Der Claim hat
  kein Adressfeld, sodass niemand für eine Adresse signieren und eine andere
  registrieren kann.
- **Challenges sind einmalig verwendbar und fünf Minuten gültig.** Die Signatur wird
  geprüft, *bevor* die Challenge verbraucht wird, sodass eine unbrauchbare Signatur die
  laufende Nonce eines Konkurrenten nicht verbrennen kann, und das Verbrauchen ist ein
  Compare-and-Swap, sodass nicht zwei Anfragen dieselbe Challenge verbrauchen können.
- **Ein Wettlauf wird durch den eindeutigen Index auf `alias.name` entschieden**, nicht
  durch eine Vorabprüfung; der Verlierer erhält `409 alias_taken`.

### Was ein Handle sein darf

Kleinbuchstaben `a-z`, `0-9` und `_` (nie am Anfang oder Ende), 3–32 Zeichen, vor der
Eindeutigkeitsprüfung in Kleinbuchstaben umgewandelt. Kein Unicode: Die Menge der
Homoglyphen ist unbegrenzt, und keine Normalisierung macht ein kyrillisches `а` sicher
genug, um es neben einem Betrag darzustellen. Ebenfalls abgewiesen: reservierte Wörter,
die das Produkt oder einen Operator imitieren würden (`admin`, `support`, `cosmospay`,
`stellar`, …), und alles, was wie ein Stellar-Konto aussieht (`g` oder `m` gefolgt von
20 oder mehr Base32-Zeichen). Die Regel steht in `src/aliases/alias-name.ts`.

### Viele Adressen, ein Name

Ein Alias verweist auf bis zu 20 Adressen über Netzwerke hinweg — ein Telefon, ein
Desktop, eine Cold Wallet, Testnet — mit genau einer primären Adresse pro Netzwerk,
erzwungen durch einen partiellen eindeutigen Index. Das Hinzufügen einer Adresse
erfordert **zwei** Nachweise: Der Aufrufer besitzt den Alias, und die neue Adresse
signiert ihre eigene `ADD_ADDRESS`-Challenge. Die letzte verbleibende Adresse kann nicht
entfernt werden (geben Sie stattdessen den Alias frei), und ein Consumer darf höchstens
25 Aliase halten.

Ein `SUSPENDED`-Alias — eine Sperre durch einen Operator — löst zu nichts auf. Eine
Sperre, die weiterhin ein Konto herausgibt, bewirkt nichts in Bezug auf das Geld.

### Die Wiederherstellung läuft über E-Mail und über die Plattform-Konsole

Schlüssel gehen verloren, und ein verlorener Schlüssel darf einen Namen nicht für immer
unerreichbar machen; deshalb hinterlegt ein Claim ein Wiederherstellungs-Postfach. Das
macht die Wiederherstellung zum gefährlichsten Pfad des Moduls:

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
   werden entfernt**. Die Wiederherstellung existiert, weil die alten Schlüssel weg
   sind, und sie weiter auflösbar zu lassen, würde dafür sorgen, dass derjenige, der
   sie besitzt, weiterhin die Zahlungen erhält.

**Warum Schritt 1 zur Konsole gehört.** Das Token *ist* der Nachweis der Kontrolle über
das Postfach und darf daher nur die Partei erreichen, die die E-Mail zustellt. Die Route
akzeptierte früher jeden Key mit `payments:write` und gab das Token an jeden zurück, der
danach fragte — jeder, der ein Handle und die E-Mail-Adresse seines Inhabers kannte,
konnte also den Alias übernehmen und damit jede daran gesendete Zahlung.
`ConsoleOnlyGuard` weist jetzt jeden API-Key-Aufrufer mit `403 admin_console_only` ab,
noch bevor der Alias überhaupt nachgeschlagen wird, und die Route bleibt aus dem
veröffentlichten Vertrag heraus. Fünf falsche Tokens verbrennen eine Wiederherstellung
(der Inhaber startet einfach eine neue; ein Angreifer kann einen Namen nicht dadurch
sperren, dass er daran scheitert), und ein gesperrter Alias kann nicht wiederhergestellt
werden.

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
beides verpflichtende **KYC** (BlindPay-*Receiver*). Wir betreiben eine **einzige
BlindPay-Plattforminstanz** (`BLINDPAY_API_KEY` + `BLINDPAY_INSTANCE_ID` in der
Umgebung); jeder Receiver, jede Wallet, jedes Bankkonto, jeder Payin und jeder Payout
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
| PATCH  | `/v1/kyc/receivers/:id`                               | `kyc:write`    | Einen Receiver aktualisieren |
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
Signatur-Secret dieses Endpunkts. Lassen Sie die `BLINDPAY_*`-Variablen leer, um die
Funktion zu deaktivieren (diese Routen liefern dann `503`). Siehe `.env.example`.

### KYC-Redirect-URLs werden pro Consumer per Allowlist freigegeben

Der Ablauf für die Nutzungsbedingungen schickt den Benutzer zu BlindPay und zurück an
eine `redirect_url`, die der Integrator angibt. Als freier String akzeptiert, wäre das
ein Open Redirect unter dem Namen der Plattform: ein Link, der auf einer
vertrauenswürdigen KYC-Seite beginnt und dort landet, wo ein Angreifer es wollte.
Deshalb durchläuft jede `redirect_url` zwei Ebenen:

| Ebene | Regel | Wo |
| ----- | ----- | -- |
| Form | eine absolute `https`-URL ohne eingebettete Zugangsdaten (`user:pass@`) | `@IsRedirectUrl()` auf jedem DTO, das eine trägt |
| Host | auf der Allowlist **des aufrufenden Consumers** — der exakte Host oder eine Subdomain an einer Label-Grenze (`app.acme.com` passt zu `acme.com`; `evilacme.com` nicht) | `KYC_REDIRECT_URL_WHITELIST`, durchgesetzt in der Service-Schicht |

```
KYC_REDIRECT_URL_WHITELIST={"cosmos_acme":["acme.com","app.acme.com"]}
```

Die Prüfung arbeitet **fail-closed**: Ein Consumer ohne Eintrag kann überhaupt keinen
Redirect verwenden, und ein Host mit abschließendem Punkt oder in IDN-Form wird
abgewiesen statt normalisiert. Die Liste gilt pro Consumer, weil eine Domain, für die
ein Integrator bürgt, nichts über einen anderen aussagt. Jeder Einstiegspunkt, der eine
`redirect_url` entgegennimmt, prüft sie — Initiieren, Anfordern und Genehmigen der
Nutzungsbedingungen, einschließlich der Admin-Genehmigung, die die Liste des Consumers
anwendet, dem der Receiver gehört. Ein abgewiesenes Schema oder ein abgewiesener Host
ergibt `400`.

## Pollar — Social Login, der eine Stellar-Wallet zurückgibt

[Pollar](https://docs.pollar.xyz/docs) macht aus einem Google-/GitHub-Login ein
Stellar-Konto: Es authentifiziert den Benutzer, erstellt eine Wallet, verwahrt den
Schlüssel in AWS KMS, fügt die konfigurierten Trustlines hinzu und finanziert die
Reserve — der Benutzer sieht nie eine Seed-Phrase. Dieser Dienst stellt das als
**OAuth-Bridge** bereit, in derselben Form, die ein Game-Launcher oder eine Konsole
verwendet, wenn der Client den Code-Austausch lokal abschließt.

### Warum eine Bridge und kein Passthrough

Der gehostete Login von Pollar ist für ein Browser-SDK konzipiert. Er leitet den
Benutzer mit einem Publishable Key, einer Client-Session-ID und einer `redirect_uri` an
`GET /auth/{provider}` weiter — und diese Redirect-URI muss ein **bei Pollar
registrierter** Host sein. Eine Wallet kann nichts davon erfüllen: Ein
Loopback-Listener auf einem ephemeren Port oder ein `cosmospay://`-Deep-Link kann nie
ein registrierter Host sein, und das Zusammenstellen erfordert Schlüssel und
Session-IDs, mit denen die Wallet nicht hantieren sollte.

Die Bridge übernimmt daher die Pollar-seitige Hälfte. Die Wallet erhält einen
zweistufigen Vertrag, den sie bereits versteht — **eine Autorisierung öffnen, einen
Code einlösen** —, und nimmt nichts als diesen Code entgegen.

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

Schritt 6 ist der eigentliche Zweck des Ganzen: Die Einlöse-Antwort enthält auch
`publishable_key` und `api_base_url`, sodass die Wallet von da an Guthaben liest sowie
Transaktionen direkt gegen die virtuelle Wallet baut und übermittelt. **Dieser Dienst
leitet diese Schnittstelle nie weiter und hält keinen Schlüssel, mit dem er es könnte.**

### Zwei Wege, den Code entgegenzunehmen

|                   | Redirect-Flow                                    | Poll-Flow                                       |
| ----------------- | ------------------------------------------------ | ----------------------------------------------- |
| Die Wallet liefert | `redirect_uri` (muss auf der Allowlist stehen)  | nichts                                          |
| Der Code kommt an | als `?code=…&state=…` im Redirect                | über `GET /v1/pollar/oauth/sessions/{state}`    |
| Der Browser sieht | Ihre eigene URI                                  | eine schlichte Seite „Sie können dieses Fenster schließen“ — nie den Code |
| Verwenden, wenn   | die Wallet einen Deep Link oder Loopback-Listener hat | sie weder das eine noch das andere hat (Kiosk, headless, eingebettete Ansicht) |

Jede Abfrage stellt einen neuen Code aus und zieht den vorherigen zurück; lösen Sie
daher den Code aus Ihrer jüngsten Abfrage ein. Das ergibt sich daraus, dass nie ein
gültiges Credential gespeichert wird: Die Zeile enthält einen SHA-256 des Codes, und
ein Hash lässt sich nicht umkehren.

**Bevorzugen Sie den Poll-Flow.** Pollar leitet den Browser nicht zum Callback zurück:
Sein gehosteter Ablauf endet auf einer eigenen Seite — `www.pollar.xyz/auth/status` —,
unabhängig davon, ob die Zustimmung verweigert oder erteilt wurde, und eine erteilte
Zustimmung versetzt die Client-Session auf Seiten von Pollar lediglich in den Zustand
`READY`. Die `redirect_uri`, die die Autorisierungs-URL trägt, wird nie aufgerufen,
sodass ein Handshake, der auf einen Rückruf wartet, so lange wartet, bis er abläuft.

Die Poll-Route fragt daher bei Pollar nach, statt darauf zu warten, benachrichtigt zu
werden: Solange ein Handshake `pending` ist, prüft sie den Status der Client-Session
selbst und stuft den Handshake hoch, sobald Pollar `READY` meldet — dieselbe
Bedingung, auf die die Einlösung ohnehin wartet. Der Vertrag der Wallet ändert sich
nicht; geändert hat sich, dass `pending` jetzt von selbst endet.

Daraus ergeben sich zwei betriebliche Hinweise:

- **Die Callback-Route existiert weiterhin und ist weiterhin bei Pollar registriert.**
  Sie funktioniert, falls doch ein Redirect ankommt, und ein Handshake im Redirect-Flow
  ist auf sie angewiesen — dieser Ablauf hätte sonst keinen Ort, an dem er einen Code
  ablegen könnte. Sie kann nur nicht der einzige Weg sein, auf dem ein Login bemerkt
  wird.
- **Der Provider wird höchstens alle zwei Sekunden pro Handshake gefragt**
  (`POLLAR_SESSION_PROBE_INTERVAL_MS`), über ein Compare-and-Swap auf
  `providerCheckedAt`, das sich alle Replikate teilen. Eine Wallet, die jede Sekunde
  abfragt, kostet Pollar daher 30 Anfragen pro Minute statt 60 — bei einem Key, dessen
  gesamtes Budget 200 beträgt.

Ein Handshake, dessen Client-Session Pollar nicht mehr anerkennt
(`INVALID_CLIENT_SESSION_ID`, `EXPIRED_CLIENT_ID` oder ein `404`/`410`), wird sofort mit
diesem Code als `failed` geschlossen, statt weiter abgefragt zu werden, bis die TTL
abläuft.

### Ein Login, eine Wallet in beiden Netzwerken

Pollar betreibt Mainnet und Testnet als zwei getrennte Anwendungen mit zwei getrennten
Schlüsselpaaren, sodass ein gehosteter Login immer nur eine Wallet in dem Netzwerk
erzeugen kann, auf das sein API-Key aufgelöst wurde (`prod` → `public`, `dev` →
`testnet` — siehe `resolveNetwork`). Ein Benutzer, der dann zwischen Umgebungen
wechselt, hat auf der anderen Seite keine Wallet: Die Adresse, die er im Testnet
aufgeladen hat, ist nicht die Adresse, die im Mainnet empfängt, und die zweite Wallet
wird letztlich in dem Moment erstellt, in dem er sie zum ersten Mal braucht — genau dem
Moment, der einen Provider-Ausfall am wenigsten verkraftet.

Eine Einlösung registriert den Benutzer daher auch im **anderen** Netzwerk, über
`POST /users/with-wallet` der Server API, und `POST /v1/pollar/oauth/token` meldet
beide:

```jsonc
"network_wallets": [
  { "network": "testnet", "status": "ready",   "address": "GA5Z…" },
  { "network": "public",  "status": "pending", "address": null    }
]
```

**Ein `pending`-Eintrag ist kein Fehler.** Der Login war erfolgreich; die zweite Wallet
ist der Teil, der noch nicht angekommen ist, und der Kern des Designs ist, dass sie den
Login nicht mit sich reißen kann. Der Versuch im Request-Pfad erhält fünf Sekunden und
einen Anlauf, und was er nicht abschließt, wird im Hintergrund vom Provisioning-Sweeper
erneut versucht — gleicher Schalter und gleicher Takt wie beim Handshake-Sweeper
(`POLLAR_SWEEP_*`), mit exponentiellem Backoff und einem Gesamtbudget von zehn
Versuchen, bevor die Zeile auf `failed` geht.

Der häufigste Grund für `pending` ist banal: **Die Schlüssel des anderen Netzwerks sind
nicht konfiguriert.** Solange das so ist, hinterlässt jeder Login ein ausstehendes
Gegenstück; sobald sie gesetzt sind, stellt ein einziger Sweep den gesamten Rückstand
bereit, ohne dass sich jemand erneut anmelden muss. Deshalb lohnt es sich, die
Schlüssel für beide Netzwerke zu setzen, auch wenn Sie heute nur eines bedienen.

Zwei Konsequenzen, die man kennen sollte:

- **Der Verknüpfungsschlüssel ist die OAuth-E-Mail-Adresse**, weil ein späterer
  gehosteter Login im anderen Netzwerk dieselbe Person darüber zuordnet. Ein Provider,
  der für keine E-Mail-Adresse bürgt, erhält überhaupt keine Gegenstück-Wallet —
  besser als eine verwaiste Wallet, die XLM gekostet hat und die kein Login je erreicht.
- **Es wird XLM in beiden Netzwerken ausgegeben.** Ein Mainnet-Login finanziert jetzt
  auch eine Testnet-Reserve und umgekehrt. Der Zustand pro Netzwerk liegt in
  `pollar_user_wallet`, eine Zeile pro (Consumer, E-Mail, Netzwerk), was zugleich die
  Idempotenz bildet: Ein wiederholter Login führt darüber ein Upsert aus, statt erneut
  bereitzustellen.

### Was die Bridge speichert

Eine Handshake-Zeile, und nichts darin kann Geld ausgeben: der nicht erratbare `state`,
die Client-Session-ID von Pollar, ein **Hash** des Codes und die resultierende
öffentliche Stellar-Adresse. **Kein Pollar-Token wird je persistiert** — der
`/auth/login`-Austausch läuft innerhalb der Einlöse-Anfrage, und die Tokens gehen
direkt in deren Antwort hinaus. Handshakes, die niemand abgeschlossen hat, werden per
Timer (`POLLAR_SWEEP_*`) als abgelaufen markiert, weil eine `AUTHORIZED`-Zeile ein
einlösbarer Code ist, bis sie bereinigt wird.

Jeder Übergang ist ein Compare-and-Swap auf den Status der Zeile, sodass ein erneut
eingespielter Callback keinen zweiten Code erzeugt und zwei Wallets, die um einen Code
konkurrieren, nicht beide gewinnen können.

### Härtungsmaßnahmen, die man kennen sollte

- **PKCE (RFC 7636, S256)** ist optional, aber empfohlen: Übergeben Sie
  `code_challenge` beim Authorize und `code_verifier` bei der Einlösung, dann ist ein
  Code, der aus einem Browser oder einem Log entweicht, ohne den Verifier nutzlos.
- **`dpop_jwk`** bindet die von Pollar ausgestellten Tokens an den eigenen
  P-256-Schlüssel der Wallet (RFC 9449), sodass ein gestohlenes Access-Token ohne
  signierten Nachweis wirkungslos ist. Es bedeutet auch, dass die Bridge nicht mehr für
  die Wallet handeln kann — `/refresh` und `/logout` bedienen Bearer-Sessions, und eine
  DPoP-gebundene Wallet ruft Pollar direkt auf.
- **`POLLAR_REDIRECT_URI_WHITELIST`** gilt pro Consumer und arbeitet fail-closed. Eine
  Redirect-URI ist der Ort, an dem ein einmalig verwendbarer Code landet, eine
  ungeprüfte ist also ein Exfiltrationskanal. Sie akzeptiert Loopback-Hosts (beliebiger
  Port, gemäß RFC 8252), Deep Links mit Private-Use-Schema und https-Hosts.
- **Bewahren Sie API-Keys mit `pollar:*` auf einem Server auf.** Der Poll-Flow übergibt
  den Code an jeden, der den `state` des Handshakes *und* einen Key mit `pollar:read`
  besitzt. Ein Angreifer, der einen solchen Key aus einer an Benutzer ausgelieferten App
  extrahiert, kann einen Login öffnen, dessen `authorization_url` an ein Opfer senden,
  den Code abfragen, sobald das Opfer auf der echten Google-/GitHub-Seite zustimmt, und
  ihn mit einem eigenen PKCE-Verifier einlösen — PKCE und `dpop_jwk` helfen nicht, weil
  der Angreifer beides selbst liefert. Das ist das Muster des Device-Code-Phishings, und
  die Abwehr besteht darin, dass der Key nie ein Backend verlässt, das Sie kontrollieren.

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
| POST   | `/v1/pollar/users` · `/v1/pollar/users/with-wallet`   | `pollar:write` | Einen Benutzer registrieren, optional mit Wallet |
| POST   | `/v1/pollar/tokens/verify`                            | `pollar:read`  | Ein Token prüfen, das Ihnen eine Wallet vorgelegt hat |

Die letzten sechs benötigen den **Secret Key** von Pollar, und genau deshalb liegen sie
hier statt in der Wallet. Request- und Response-Schemas für alle stehen im generierten
Vertrag — Swagger UI unter `/docs` oder `openapi/openapi.{json,yaml}`. Die obige Tabelle
dient der Orientierung; maßgeblich ist der Vertrag.

### Rate Limiting: was massenhafte Wallet-Erzeugung verhindert

Das Erstellen einer Pollar-Wallet ist nicht kostenlos. Pollar erstellt das
Stellar-Konto, finanziert dessen Basisreserve (1 XLM) und fügt pro konfiguriertem Asset
eine Trustline hinzu (je 0.5 XLM) — **aus Ihrer Funding-Wallet**. Eine Schleife gegen
den Login-Ablauf ist daher ein Weg, auf dem ein Fremder Ihr Geld ausgeben kann, und
dafür braucht es am anderen Ende nicht einmal einen echten Benutzer.

Die Obergrenzen liegen daher hier, in diesem Dienst, und nicht nur am Gateway: Dies ist
der Prozess, der weiß, dass eine Anfrage gleich ein Konto erstellen wird, und er ist
derjenige, der ablehnen kann, bevor das XLM abfließt.

**Der Kontrollpunkt ist `authorize`, nicht `token`.** Ein Handshake ergibt höchstens
eine Wallet; wer begrenzt, wie viele Handshakes eine Adresse öffnen darf, begrenzt also,
wie viele Wallets sie verursachen kann. `token` bleibt bewusst lockerer, weil der
409-Pfad den Aufrufer auffordert, genau diese Anfrage zu wiederholen, während Pollar das
Konto bereitstellt — ein knappes Budget dort würde unseren eigenen dokumentierten Retry
drosseln, und das Einlösen erzeugt nichts, was der Handshake nicht bereits erlaubt
hätte.

| Route | Budget (pro 10 min) | Warum diese Zahl |
| ----- | ------------------- | ---------------- |
| `POST /v1/pollar/oauth/authorize` | 20 | Die Obergrenze für die Wallet-Erzeugung. Weit über einem Menschen, der einen fehlgeschlagenen Zustimmungsbildschirm wiederholt, weit unter einer Rate, die ein Konto leert |
| `POST /v1/pollar/oauth/token` | 60 | Bewusst locker — siehe oben |
| `GET /v1/pollar/oauth/callback` | 60 | Die einzige Route, die ohne API-Key erreichbar ist, und damit die einzige, die eine anonyme Flut erreichen kann. Ein Benutzer, der den Tab neu lädt, ist normal |
| `POST /v1/pollar/users/with-wallet` | 10 | Erstellt eine Wallet, ohne dass ein Zustimmungsbildschirm das Tempo bremst — das knappste Budget der Reihe |
| `POST /v1/pollar/wallets/activate` | 20 | Gibt pro Aufruf XLM aus, kann aber nichts Neues erstellen |

Eine Überschreitung liefert **`429` mit `code: "rate_limited"`**, einen `Retry-After`
und das Tripel `RateLimit-Limit` / `-Remaining` / `-Reset`. Alles andere im Dienst ist
hier unbegrenzt; allgemeine Traffic-Steuerung ist Aufgabe von APISIX, da es die Anfrage
sieht, bevor dieser Prozess sie sieht.

**Der Zähler liegt in Postgres, nicht im Speicher.** Der Dienst läuft hinter einem Load
Balancer, sodass ein prozesslokaler Limiter jedem Replikat das volle Budget geben
würde: Das effektive Limit wird zu `limit × replicas` und ändert sich stillschweigend,
sobald das Deployment skaliert. Für eine kosmetische Drosselung ist das in Ordnung,
nicht aber für etwas, das ein echtes Guthaben schützt. Es ist ein festes Zeitfenster —
ein atomares `INSERT … ON CONFLICT … RETURNING` pro Anfrage —, was bedeutet, dass ein
Client auf jeder Seite einer Fenstergrenze ein volles Budget verbrauchen kann; lesen Sie
die obigen Zahlen daher als „höchstens das Doppelte davon pro Fenster“. Sie wurden in
diesem Wissen festgelegt.

**Wie die Adresse bestimmt wird und warum sie nicht gefälscht werden kann.** `main.ts`
setzt `trust proxy` auf `1`, wodurch Express den *rechtesten* Eintrag von
`X-Forwarded-For` liest — den, den APISIX angehängt hat, also den Peer, wie ihn das
Gateway gesehen hat. Ein Client kann diesem Header Einträge voranstellen, aber alles,
was er schreibt, landet links vom Eintrag von APISIX und wird ignoriert.

> **Erhöhen Sie `trust proxy` nicht.** Bei `2` beginnt Express, den ersten vom Client
> gelieferten Hop zu berücksichtigen, und jedes Limit hier lässt sich durch Hinzufügen
> eines einzigen Headers umgehen. `src/common/client-ip.spec.ts` legt beide
> Verhaltensweisen fest, sodass die Änderung nicht unbemerkt durch das Review kommen kann.

Ein IPv6-Aufrufer wird pro **/64** zusammengefasst, nicht pro Adresse: Einem Client wird
routinemäßig ein ganzes /64 zugewiesen, das er kostenlos durchrotieren kann, sodass eine
Begrenzung pro Adresse dort keine Begrenzung ist. Der Preis ist, dass sich zwei
Benutzer hinter einem /64 einen Bucket teilen, genau wie es zwei Benutzer hinter einem
IPv4-NAT bereits tun. Buckets sind außerdem nach Consumer geschlüsselt, sodass der
Traffic eines Integrators nicht das Budget eines anderen aufbrauchen kann.

Wenn der Zähler nicht geschrieben werden kann, arbeitet der Limiter **fail-closed**
(`503`). Ein Limiter, der während eines Datenbankvorfalls stillschweigend aufhört zu
begrenzen, ist weniger wert als gar keiner, weil Ihnen nichts sagt, dass es passiert ist
— und jede Route dahinter braucht ohnehin dieselbe Datenbank, sodass die Ablehnung keine
Verfügbarkeit kostet, die nicht ohnehin schon verloren war.

Setzen Sie `RATE_LIMIT_ENABLED=false` als Notfallschalter.

### Einrichtung

1. Legen Sie unter [dashboard.pollar.xyz](https://dashboard.pollar.xyz) eine App an und
   übernehmen Sie beide Schlüssel für Ihr Netzwerk (`pub_testnet_…` / `sec_testnet_…`).
   Tun Sie das für **beide** Netzwerke: Ein Login stellt in jedem eine Wallet bereit,
   und ein Netzwerk ohne Schlüssel lässt die zweite Wallet jedes Benutzers auf
   `pending`, bis sie gesetzt sind. Die beiden Dashboards sind getrennt — registrieren
   Sie den Callback-Host in jedem.
2. Registrieren Sie den **Gateway-Host** von `POLLAR_BRIDGE_CALLBACK_URL` unter
   **Build → Domains**. Dabei geht es nicht nur um den Redirect: Die SDK API prüft diese
   Liste bei *jedem* Aufruf anhand des `Origin`-Headers, und die Bridge sendet den
   Origin dieses Hosts als diesen Header (`POLLAR_SDK_ORIGIN` überschreibt ihn). Ein
   nicht registrierter Host ergibt `403 ORIGIN_NOT_ALLOWED` bei `POST /auth/session` —
   dem ersten Aufruf jedes Logins, noch bevor der Benutzer überhaupt einen
   Zustimmungsbildschirm sieht.
3. Setzen Sie `POLLAR_BRIDGE_CALLBACK_URL` auf `<gateway>/v1/pollar/oauth/callback` —
   die Bridge hängt `/{state}` selbst an.
4. Fügen Sie die Redirect-URI jeder Wallet zu `POLLAR_REDIRECT_URI_WHITELIST` hinzu,
   oder lassen Sie sie weg und verwenden Sie den Poll-Flow.

Schlüssel gelten pro Netzwerk, und Pollar kodiert Netzwerk und Schlüsseltyp im Präfix,
sodass eine Nichtübereinstimmung eine harte Ablehnung ist — der Env-Validator erkennt
sie beim Start statt erst bei einem Login eines Benutzers. Lassen Sie die Schlüssel
leer, um die Funktion zu deaktivieren (Pollar-Routen liefern dann `503`). Siehe
`.env.example`.

## Upgrade — Breaking Changes und Deploy-Hinweise

### Korrekturen aus dem Security-Review

Ein Review des gesamten Dienstes hat die folgenden Probleme gefunden. Jedes ist behoben
und durch einen Test abgesichert, der ohne die Korrektur fehlschlägt. Die meisten ändern
nichts für einen sich korrekt verhaltenden Aufrufer, aber jede Zeile ist für
irgendjemanden sichtbar — lesen Sie vor dem Deployment die Spalte „Wer es bemerkt“.

| Änderung | Wer es bemerkt | Warum |
| -------- | -------------- | ----- |
| `POST /v1/aliases/:name/recovery` ist **nur für die Plattform-Konsole**: Ein API-Key erhält `403 admin_console_only`, und die Route wurde aus dem veröffentlichten Vertrag entfernt | Jeder, der Wiederherstellungen mit einem API-Key gestartet hat | Die Antwort enthält das Wiederherstellungs-Token, das der Nachweis über das Postfach des Inhabers ist. Nur hinter einem Scope erhielt jeder, der ein Handle und die E-Mail-Adresse seines Inhabers kannte, das Token und konnte den Alias sowie jede daran gesendete Zahlung übernehmen |
| Das Abschließen einer Wiederherstellung für einen `SUSPENDED`-Alias ergibt `404` | Niemand mit legitimen Absichten | Ein vor einer Sperre ausgestelltes Token war ein Weg aus der Sperre durch den Operator heraus |
| `@Public()`-Routen (Pollar-Callback, BlindPay-Webhook, Health) ignorieren `X-Consumer-Username` | Dashboards: Diese Anfragen werden jetzt als anonym protokolliert | Diese Routen laufen ohne key-auth, der Header stammte also vom Client selbst: Ein neuer Name pro Anfrage war ein neues Rate-Limit-Budget, und die Angabe eines Opfers legte gefälschte Zeilen in dessen API-Log-Ansicht ab |
| Ablehnungen durch `AdminGuard` und `ConsoleOnlyGuard` werden auf `warn` protokolliert | Operatoren | Guards laufen vor dem Access-Log, sodass eine Sondierung von `/v1/admin` nirgends eine Spur hinterließ |
| `POST /v1/pollar/wallets/activate` und die drei Routen `/v1/pollar/wallets/:address/trustlines…` liefern `404` für eine Wallet, die der aufrufende Consumer nicht über diesen Dienst in diesem Netzwerk erhalten hat | Integratoren, die auf Wallets einwirken, die sie nur über `tokens/verify` gesehen haben, auf nicht-primäre Wallets eines Logins oder auf eine Gegenstück-Wallet, die ein anderer Mandant bereits registriert hat | Alle Mandanten teilen sich einen Satz Pollar-Secret-Keys, sodass ohne die Prüfung ein Mandant die Trustlines der Benutzer eines anderen Mandanten entfernen oder das XLM des Operators für deren Reserven ausgeben konnte. Eine fremde und eine unbekannte Wallet erhalten dasselbe `404`, sodass die Antwort kein Eigentums-Orakel ist |
| Beide `POST …/trustlines`-Routen teilen sich ein `429`-Budget von 20 Aufrufen pro 10 Minuten | Skripte, die Trustlines massenhaft hinzufügen | Jede Trustline bindet 0.5 XLM Reserve aus der Funding-Wallet des Operators, und dies waren die einzigen XLM ausgebenden Routen ohne Obergrenze |
| `GET /v1/offramp/payouts/:id` liefert `raw`, `consumerId`, `receiverId`, `quoteId`, `bankAccountId` und `updatedAt` nicht mehr; die Antwort beim Anlegen eines virtuellen Kontos liefert `raw`, `receiverId`, `consumerId` und `updatedAt` nicht mehr | Aufrufer, die diese Felder lesen | `raw` ist das gespeicherte Objekt von BlindPay mit Bank- und Begünstigtendaten, und es erreichte jeden Key mit `offramp:read` — der Lesepfad ignorierte die öffentliche Projektion, die jeder andere Payout-Lesezugriff verwendet |
| `POST /v1/kyc/upload` liefert `400` bei mehr als 4 Textfeldern, einem Feld über 1 KiB, einer zweiten Datei oder Dateibytes, die nicht zum deklarierten Typ passen | Niemand, der einen wohlgeformten Upload sendet | Die Standardwerte von Multer ließen Felder unbegrenzt und je 1 MB im Speicher zu, und die Typprüfung vertraute dem `Content-Type` des Clients |
| `POST /v1/payment-intents/tx` und `/pay`: Dasselbe Memo mit irgendeiner abweichenden Kondition ergibt `409 idempotency_conflict`. Ein identischer Wiederholungsversuch liefert weiterhin den gespeicherten Intent (`2` und `2.0` sind derselbe Betrag) | Aufrufer, die ein Memo für verschiedene Zahlungen wiederverwenden | Unter dem gemeinsamen öffentlichen Key ist jede anonyme Wallet ein und derselbe Consumer, sodass ein Memo, das jemand anderes zuerst angelegt hatte, *dessen* Intent zurückgab — mit einem QR-Code, der an ihn zahlte |
| `POST /v1/payment-intents/:id/validate` setzt `FAILED` nur bei einer fehlgeschlagenen Transaktion, die die eigene Zahlung dieses Intents ist; jede andere fehlgeschlagene Transaktion ergibt `valid: false` bei unverändertem Status. Eine Transaktion, die mehr als 60 s vor dem Anlegen des Intents abgeschlossen wurde, wird abgewiesen ("Transaction predates this payment intent") — bei validate, bei `PATCH {status: SUCCEEDED}` und im Observer | Niemand mit legitimen Absichten | Der Hash jeder beliebigen fehlgeschlagenen Transaktion im Netzwerk ließ einen Intent dauerhaft scheitern, und eine alte Zahlung mit denselben Konditionen konnte einen neuen Intent begleichen |
| `PATCH /v1/payment-intents/:id`, das `txHash` bei einem Intent in einem Endzustand ändert, ergibt `400 invalid_state_transition`; eine Statusänderung, die mit dem Schreibvorgang konkurriert, ergibt `409 operation_in_flight` | Niemand mit legitimen Absichten | Es überschrieb den Abwicklungsnachweis eines `SUCCEEDED`-Intents |
| Der Payment-Intent-Observer gleicht pro Tick höchstens 10 Intents pro Consumer ab und durchsucht nie abgelaufene Zeilen | Operatoren, die den Durchsatz des Observers beobachten | Eine Flut von Intents mit offenem Betrag von einem einzelnen Consumer hungerte die Abwicklung aller anderen Mandanten aus und verbrauchte das gemeinsame Horizon-Budget |
| `POST /v1/swaps`, `/v1/liquidity-pools/deposit` und `/withdraw`: Ein wiederverwendeter `Idempotency-Key` mit einer abweichenden Anfrage — einem anderen Memo oder einer anderen Slippage, dem anderen Netzwerk oder einem für eine Auszahlung wiederverwendeten Einzahlungs-Key — ergibt `409 idempotency_conflict`. Eine Wiederholung mit ungültigem Asset, ungültiger Slippage oder ungültigem Memo erhält jetzt das normale `400` | Clients, die einen Key für verschiedene Operationen wiederverwenden | Unter dem gemeinsamen öffentlichen Key konnte ein Angreifer unter einem erratbaren Key vorab einen Swap oder eine Auszahlung vom Konto eines Opfers auf sein eigenes anlegen, und der Wiederholungsversuch des Opfers lieferte diesen Envelope zum Signieren aus |
| `POST /v1/liquidity-pools/withdraw` antwortet nicht mehr mit `409 operation_in_flight` auf eine laufende Auszahlung, deren Sequenznummer das Konto noch nicht verwendet hat (ein unsignierter oder aufgegebener Envelope) | Wallet-Benutzer, die blockiert waren | Eine Kleinstbetrag-Auszahlung, die für das Konto eines anderen gebaut und alle 300 s erneut gesendet wurde, sperrte jeden Benutzer des öffentlichen Keys davon aus, diese Position auszuzahlen. Die beiden Envelopes teilen sich eine Sequenznummer, sodass höchstens einer je abgewickelt werden kann |
| Der Settlement-Observer übernimmt pro Tick höchstens 10 Zeilen pro Consumer pro Tabelle, und `GET /v1/liquidity-pools/positions` liest Horizon über eine einzige paginierte Auflistung statt über eine Anfrage pro Pool | Operatoren | Die Flut eines einzelnen Consumers hungerte die Abwicklung aller anderen aus, und ein Konto mit Anteilen an vielen Pools löste unbegrenzt viele Horizon-Aufrufe aus |

Dazugehörige Deploy-Hinweise:

- **Migration `20260910120000_aliases`** erstellt `alias`, `alias_address`,
  `alias_challenge` und `alias_recovery`. Führen Sie `migrate deploy` aus, bevor der
  neue Build Traffic bedient.
- **Eine neue Advisory-Lock-ID, `881_008` (`AliasChallengeSweeper`).** Nichts zu
  konfigurieren; aufgeführt, damit die Nummer nie wiederverwendet wird.
- **Setzen Sie `NODE_ENV=production` in Produktion.** `.env.example` liefert
  `development` aus, und zwei Schutzmaßnahmen hängen davon ab: Eine Anfrage ohne
  `X-Plan-Swap-Fee-Bps` ergibt nur in Produktion `503` (überall sonst fallen Swaps
  stillschweigend auf `STELLAR_SWAP_FEE_BPS` zurück), und `/docs` — außerhalb jedes
  Guards — ist nur in Produktion standardmäßig aus.

### NestJS 12, TypeScript 6 und Node 24.9 als Mindestversion

Die gesamte NestJS-Reihe ist auf 12 umgestiegen und TypeScript auf 6. **Dadurch steigt
die minimale Node-Version auf 24.9** (`engines`, und beide Workflows pinnen jetzt
`node-version: 24`); mit älteren Versionen lässt sich die Testsuite überhaupt nicht
ausführen. Deploy-Ziele müssen mitziehen.

Der Grund ist der Test-Runner, nicht das Framework. NestJS 12 wird als reines ESM
veröffentlicht (`"type": "module"`), und Jest kann es unter CommonJS nicht per
`require()` laden — jede der 62 Suites scheiterte beim Laden. Jest unterstützt
`require(esm)` nativ, aber nur auf Node >= 24.9 **und** mit
`--experimental-vm-modules`, weil die Fähigkeit, auf die es prüft
(`vm.SourceTextModule.prototype.hasAsyncGraph`), ohne dieses Flag nicht existiert. Die
Testskripte rufen Jest daher jetzt direkt über Node auf:

```
"test": "node --experimental-vm-modules node_modules/jest/bin/jest.js"
```

Kein `NODE_OPTIONS=`-Präfix: Das ist nicht auf Windows-Shells portierbar, und CI, der
Release-Job und der Rechner eines Entwicklers müssen denselben Befehl ausführen.

Zwei Konsequenzen, die man kennen sollte:

- **`transformIgnorePatterns` ist aus beiden Jest-Konfigurationen verschwunden.** Es
  listete die ESM-Pakete (`@stellar`, `@noble`, `@exodus`, `uint8array-extras`) auf,
  die von ts-jest nach CommonJS transpiliert werden sollten — ein Workaround dafür,
  dass ESM nicht geladen werden konnte. Da Jest ESM jetzt nativ lädt, richtet der
  Workaround aktiv Schaden an: Ein nach CJS kompiliertes Paket wird als ESM ausgewertet
  und bricht mit `exports is not defined` ab. Falls eine Abhängigkeit jemals wieder
  transformiert werden muss, ist das die Datei, die man sich ansehen sollte.
- **`tsconfig.json` hat `types` und `rootDir` erhalten.** TypeScript 6 bindet nicht
  mehr automatisch jedes `@types`-Paket ein, daher werden die beiden ambienten (`node`,
  `jest`) explizit genannt — ohne das verlor jede Spec `describe`/`it`, lief unter
  ts-jest aber weiterhin grün. Und TS 6 weigert sich, `rootDir` abzuleiten, wenn eine
  Kompilierung ein einzelnes Verzeichnis abdeckt (TS5011), was die ts-node-Skripte tun;
  `"./"` ist das, was der vollständige Build ohnehin abgeleitet hat, sodass das
  ausgegebene Layout unverändert bleibt.

Durch die Major-Versionen erzwungene Codeänderungen, alle klein:

- `EventEmitter2` wird aus `eventemitter2` importiert, nicht aus
  `@nestjs/event-emitter`. Zur Laufzeit ist es dasselbe Klassenobjekt — das DI-Token
  ist unverändert —, aber der Nest-Re-Export ist für die CJS-Form des Pakets typisiert
  und löst unter der `node10`-Modulauflösung dieses Repositorys zu `any` auf, wodurch
  jedes `.emit()` stillschweigend zu einem ungeprüften Aufruf wurde. `eventemitter2`
  ist aus diesem Grund jetzt eine direkte Abhängigkeit.
- `OperationObject` kommt aus `@nestjs/swagger` statt aus
  `@nestjs/swagger/dist/interfaces/open-api-spec.interface`. Swagger 12 veröffentlicht
  eine `exports`-Map, die nur `.` und `./plugin` freigibt, sodass tiefe Pfade nicht
  mehr aufgelöst werden.
- `AccountLoaderService.load` trägt einen expliziten Rückgabetyp
  `Promise<Horizon.AccountResponse>`; TS 6 leitet keinen Typ ab, den es nicht portabel
  benennen kann.
- Zwei Test-Mocks (`fetch`, `Reflector.getAllAndOverride`) entsprechen jetzt den echten
  Signaturen statt engerer, von Hand geschriebener.

Die veröffentlichte OpenAPI-Spezifikation ist gewachsen: `@nestjs/terminus@12` erzeugt
reichhaltigere Health-Schemas (Status-Enums und eine `responseTime`-Eigenschaft). Rein
additiv — keine fachliche Route und kein Schema hat sich geändert.

### Ein gemeinsamer öffentlicher API-Key und der Guard, der ihn eingrenzt

Neu in diesem Release: `PublicKeyGuard` (global, nach `PermissionsGuard`) und der
Decorator `@AllowPublicKey()`. Für bestehende Keys ändert sich nichts — der Guard hat
keine Meinung zu einem Consumer, der nicht der gemeinsame öffentliche ist —, aber beim
Deployment ist zweierlei zu tun:

- **Setzen Sie `APISIX_PUBLIC_CONSUMER`** auf den Benutzernamen, den die
  Entwicklerplattform für den öffentlichen Key bereitstellt, und zwar auf jedem
  Deployment, das einen veröffentlicht. Ohne ihn stützt sich der Guard allein auf das
  weitergeleitete `X-Consumer-Role`.
- **Der öffentliche Key muss mit `role: public` ausgestellt werden** und nur mit den
  Scopes, die die freigegebenen Routen benötigen. Ihm `kyc:*` oder `webhooks:*` zu
  gewähren, würde diese Routen nicht öffnen — der Guard weist sie ohnehin ab —, aber es
  wäre ein Credential, das weiter reicht als seine Aufgabe, und im Besitz aller.

Siehe „Der gemeinsame öffentliche API-Key“ oben dazu, was er erreichen darf und warum.

### Das Asset-Register: `GET /v1/assets`

Eine kuratierte Tabelle der (code, issuer)-Paare, für die diese Plattform bürgt, pro
Netzwerk und mit Nennung der ausgebenden Organisation. Sie erfordert keinen Scope — der
Katalog enthält keine Mandantendaten, und ihn abzusichern würde nur bedeuten, dass
jeder Key, der vor Einführung des Scopes ausgestellt wurde, eine leere Token-Auswahl
sieht —, aber sie erfordert einen authentifizierten Consumer, den gemeinsamen
öffentlichen Key eingeschlossen.

`npm run assets:verify` prüft jede Zeile erneut gegen das Live-Horizon: dass das Paar
in dem Netzwerk existiert, unter dem es eingetragen ist, dass `contract` mit der
`contract_id` von Horizon übereinstimmt und dass die Issuer-Flags zur Chain passen.
Führen Sie es aus, wenn Sie das Register bearbeiten. Es ist kein Unit-Test, weil es das
öffentliche Internet benötigt, und einen Test, der fehlschlägt, wenn Horizon langsam
ist, gewöhnen sich alle an zu überspringen.

### Client-Aktivität: ein neues Modul, eine neue Tabelle und zwei neue Scopes

`POST /v1/activity/events` nimmt Telemetrie von der Wallet und dem
Entwickler-Dashboard entgegen; `GET /v1/activity/events` und
`GET /v1/activity/summary` lesen sie aus. Nichts Bestehendes hat seine Form geändert,
aber beim Deployment ist dreierlei zu tun:

- **Migration `20260906140000_activity_event`** erstellt `activity_event` (nur
  anhängend, `consumerId`-bezogen, eindeutig auf `(consumerId, eventId)`).
- **Die Scopes `activity:write` und `activity:read` sind neu.** Ein Key ohne sie erhält
  `insufficient_scope`, was die richtige Antwort ist — es bedeutet aber, dass ein
  bestehender Key durch das Upgrade nicht die Fähigkeit erhält, Telemetrie zu melden.
  Die Entwicklerplattform gewährt beide an von der Wallet bereitgestellte Keys und
  wendet den Satz bei der Rotation erneut an; bei von Hand ausgestellten Keys müssen sie
  ergänzt werden.
- **`ACTIVITY_RETENTION_DAYS`** (Standard 30) kommt zum Aufbewahrungs-Job hinzu. Es
  handelt sich um personenbezogene Daten auf gleicher Stufe wie das Access-Log; setzen
  Sie den Wert nur bewusst auf `0`.

### Die Pollar-Poll-Route erkennt einen abgeschlossenen Login jetzt selbst

`GET /v1/pollar/oauth/sessions/{state}` meldete früher, was auch immer der
Bridge-Callback aufgezeichnet hatte. Pollar ruft diesen Callback nie auf — sein
gehosteter Ablauf endet auf `www.pollar.xyz/auth/status` und hinterlässt die
Client-Session im Zustand `READY` —, sodass ein Handshake im Poll-Flow `pending` blieb,
bis er ablief, und das bei einer Wallet, die alles richtig machte. Die Abfrage fragt
jetzt direkt bei Pollar nach und stuft den Handshake bei `READY` hoch.

Keine API-Form hat sich geändert, und keine Client-Änderung ist nötig: Ein Login, der
früher auf `pending` hing, erreicht jetzt `authorized` innerhalb einer Abfrage, nachdem
der Benutzer fertig ist. Zwei Dinge sollten Sie beim Deployment beachten:

- **Migration `20260906120000_pollar_oauth_provider_probe`** fügt
  `pollar_oauth_session` ein nullbares `providerCheckedAt` hinzu. Es ist die gemeinsame
  Untergrenze dafür, wie oft die Frage Pollar erreicht; nichts wird nachträglich befüllt.
- **Poll-Traffic erreicht jetzt Pollar.** Planen Sie eine Provider-Anfrage pro
  laufendem Login alle zwei Sekunden ein, über den Publishable Key des jeweiligen
  Netzwerks.

### Pollar-Logins stellen jetzt in beiden Netzwerken eine Wallet bereit

`POST /v1/pollar/oauth/token` hat ein `network_wallets`-Array erhalten — ein Eintrag
pro Stellar-Netzwerk, jeweils `ready`, `pending` oder `failed`. Additiv, es bricht also
nichts, aber zwei betriebliche Hinweise:

- **Führen Sie die Migration aus.** `20260905120000_pollar_user_wallet` fügt
  `pollar_user_wallet` und die Enum `PollarWalletStatus` hinzu. Ohne sie protokolliert
  jede Einlösung eine fehlgeschlagene Bereitstellung, und die Gegenstück-Wallet bleibt
  unerfasst — der Login selbst funktioniert weiterhin.
- **Setzen Sie die Schlüssel für beide Netzwerke.** `POLLAR_*_MAINNET` und
  `POLLAR_*_TESTNET` sind jeweils für sich optional, und ein Netzwerk ohne Schlüssel
  erscheint jetzt bei jedem Login als `pending`-Wallet statt als gar nichts.
  Konfigurieren Sie das zweite Paar, und der Sweeper baut den Rückstand beim nächsten
  Tick ab; lassen Sie es bewusst ungesetzt, und die Zeilen bleiben `pending`, bis das
  Budget von zehn Versuchen sie ausmustert. So oder so schlägt kein Login fehl.

Planen Sie das XLM ein: Ein Login finanziert jetzt eine Reserve in *beiden* Netzwerken,
die Mainnet-Ausgaben pro neuem Benutzer bleiben also unverändert, aber Testnet-Ausgaben
entstehen dort, wo es vorher keine gab.

### `429` meldet jetzt `rate_limited`

Ein bloßes `429` fiel früher auf `code: "provider_unavailable"` zurück, was besagte,
ein vorgelagerter Dienst habe Probleme, obwohl in Wirklichkeit dieser Dienst selbst die
Anfrage abgelehnt hatte — womit Integratoren losgeschickt wurden, etwas zu untersuchen,
das völlig in Ordnung war. Es meldet jetzt `code: "rate_limited"`, und
`ApiErrorCode.RateLimited` ist Teil der veröffentlichten Enum. Verzweigen Sie darauf,
wenn Sie bei Drosselung erneut versuchen.


### Geänderte Antwortformate

Drei veröffentlichte Formate haben sich im Audit-Hardening-Release geändert. Alle drei
liegen unter `/v1`; es gibt kein `/v2`, daher müssen Integratoren informiert werden,
bevor Sie deployen.

| Endpunkt | Vorher | Jetzt | Warum |
| -------- | ------ | ----- | ----- |
| `GET /v1/webhooks` | bloßes Array, stillschweigend auf 100 begrenzt | `{ data, total, take, skip }` | Ein Consumer mit 120 Endpunkten erhielt 100, ohne dass etwas darauf hinwies, und ohne `total`, anhand dessen er hätte blättern können |
| `GET /v1/products` | bloßes Array, gesamte Tabelle | `{ data, total, take, skip }` | Unbegrenzter Lesezugriff |
| `GET /v1/webhooks/:id/deliveries` und die Redelivery-Antwort | enthielten `payload` | `payload` entfernt | Ein `RECEIVER_UPDATED`-Body ist ein vollständiges KYC-Dossier, und diese Routen sind über `webhooks:read` abgesichert, nicht über `kyc:read` |

Ein Aufrufer, der `for (const x of res)` ausführt oder `delivery.payload` liest, bricht
beim Deployment. Die Migration ist mechanisch: Lesen Sie `res.data`, und rufen Sie
KYC-Details über die KYC-Endpunkte mit einem Key ab, der `kyc:read` besitzt.

Auch die **Webhook-Bodies** von `RECEIVER_UPDATED` / `PAYIN_*` / `PAYOUT_*` wurden auf
Identität und Zustand eingeschränkt — siehe den Abschnitt zu Webhooks.

### Die Audit-Hardening-Migration

Sie wird als zwei Dateien ausgeliefert, die in dieser Reihenfolge angewendet werden
müssen:

- `20260901120000_audit_hardening` — die Korrektheitsarbeit: eine neue Spalte, ein
  deduplizierendes `DELETE` auf `liquidity_pool_operation`, zwei `UNIQUE`-Indizes, zwei
  neue Tabellen. Das DELETE und der eindeutige Index, den es vorbereitet, laufen in
  einer expliziten Transaktion unter einem `SHARE ROW EXCLUSIVE`-Lock, sodass ein
  Rolling Deploy kein Duplikat zwischen die beiden schieben kann. Schreiber auf diese
  eine Tabelle blockieren für die wenigen Millisekunden, die das dauert.
- `20260901120100_audit_hardening_indexes` — neun additive Indizes, `CONCURRENTLY`
  erstellt, sodass das Deployment Schreibvorgänge auf `payment_intent`, `swap`,
  `webhook_delivery` oder `request_log` **nicht** blockiert. Kein Wartungsfenster nötig.

Die Aufteilung ist keine Stilfrage: PostgreSQL verweigert `CREATE INDEX CONCURRENTLY`
innerhalb eines Transaktionsblocks, und die erste Datei braucht einen. Beide werden in
CI gegen ein echtes PostgreSQL verifiziert, wobei außerdem sichergestellt wird, dass
kein Index `INVALID` zurückgeblieben ist und die Migrationen weiterhin zu
`schema.prisma` passen.

Schlägt die zweite Datei mittendrin fehl, hinterlässt ein `CONCURRENTLY`-Build einen
**ungültigen** Index, statt sauber fehlzuschlagen, und `IF NOT EXISTS` hält ihn für
vorhanden. Löschen Sie ihn und führen Sie die Migration dann erneut aus:

```sql
SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE NOT i.indisvalid;
```

### `ADMIN_API_CREDENTIALS` entfällt — `/v1/admin` gehört der Plattform-Konsole

**Löschen Sie die Variable.** Sie wird nicht mehr gelesen, und die zugehörigen
`COSMOS_ADMIN_API_SECRET` / `COSMOS_ADMIN_API_SECRET_READ` in der Entwicklerplattform
entfallen mit ihr.

Sie war ein zweites Credential, das in diesem Dienst entschied, wer Plattform-Admin ist
— und die Entwicklerplattform hatte das bereits anhand der Rolle des angemeldeten Kontos
entschieden. Zwei Antworten auf eine Frage, und jedes Deployment, das das Gateway
eingerichtet, dieses Secret aber ausgelassen hatte, bekam den Widerspruch in seiner
verwirrendsten Form: Ein Owner konnte in der Konsole, die nie nach diesem Secret fragt,
Plan und Rolle eines anderen Kontos ändern, und doch antwortete jeder
mandantenübergreifende Lesezugriff mit `401 admin_credentials_required`. Nichts an
diesem Fehler weist auf ein fehlendes Deployment-Secret hin statt auf die eigenen
Rechte des Kontos.

Die Frage, die der Guard stellt, hat sich daher geändert — von „Besitzt der Aufrufer das
Admin-Secret?“ zu „Kam dieser Aufruf von der Plattform-Konsole?“ —, und sie wird durch
zwei Tatsachen entschieden, die bereits in der Anfrage stehen:

1. `X-Gateway-Secret` stimmt mit `APISIX_GATEWAY_SECRET` überein — geprüft von
   `ApisixGuard` wie auf jeder anderen Route. Nur das Gateway und das Konsolen-Backend
   besitzen es.
2. `X-Cosmos-Internal` ist vorhanden. APISIX entfernt den Header aus jeder
   weitergeleiteten Anfrage (`proxy-rewrite.headers.remove`), sodass ein
   API-Key-Aufrufer ihn nicht mitsenden kann; das kann nur ein direkter Aufruf eines
   Backends, das das Gateway-Secret besitzt.

Benennen wir den Kompromiss klar: Tatsache 2 beruht auf der Routing-Konfiguration des
Gateways, die im Repository der Entwicklerplattform liegt, nicht auf einem Secret, das
dieser Dienst hält. Zwei Dinge wiegen das auf. Die Konsole ist jetzt der einzige Ort,
der beantwortet, „wer Plattform-Admin ist“, sodass die beiden Antworten nicht mehr
voneinander abweichen können; und die Zuordnung wurde schärfer statt schwächer — eine
Audit-Zeile nannte früher ein gemeinsam genutztes Credential (`owner`, `viewer`) und
nennt jetzt das Konsolenkonto, das gehandelt hat (`cosmos_<userId>`), sowie die
Plattformrolle, die es geltend gemacht hat, bei jeder Mutation **und** jedem
Lesezugriff.

Was sich für einen Aufrufer ändert:

| Vorher | Jetzt |
| ------ | ----- |
| `401` `admin_credentials_required` ohne Bearer-Secret | `403` `admin_console_only` für alles, was kein Konsolenaufruf ist |
| `403` `admin_role_required` für ein `read`-Credential bei einer Mutation | entfällt — die Konsole hat bereits entschieden, dass das Konto handeln darf |
| `actorId` / `actorRole` in einer Audit-Zeile nannten das Credential | sie nennen das Konsolenkonto und seine Plattformrolle |

Wenn Sie `/v1/admin` direkt aufrufen (etwa aus einem Ops-Skript), senden Sie
`X-Gateway-Secret`, `X-Consumer-Username` und `X-Cosmos-Internal: 1`; fügen Sie
`X-Cosmos-Admin-Role: owner` hinzu, damit die Audit-Zeile gekennzeichnet ist. Halten
Sie den Dienst vom öffentlichen Internet fern — ohne das Admin-Secret stehen nur noch
Netzwerkisolation und das Gateway-Secret vor mandantenübergreifenden Daten.

### `APISIX_GATEWAY_SECRET` erfordert jetzt 32 Zeichen

Darunter verweigert der Dienst den Start. Zuvor akzeptierte er ein einzelnes Zeichen,
und es ist jetzt das *einzige* Secret zwischen der Außenwelt und der
Plattform-Admin-Oberfläche (siehe oben), es trägt also mehr Gewicht als früher.
Erzeugen Sie eines mit `openssl rand -hex 32` und rotieren Sie es gleichzeitig in APISIX.

### Funktionen aus `v0.1.0`–`v0.1.5`, die dieses Release ersetzt

`main` und dieser Branch haben mehrere gleiche Probleme unabhängig voneinander gelöst,
während sie getrennt waren. Wo beide eine Antwort hatten, wird das Design dieses
Branches ausgeliefert, sodass ein Deployment, das von `v0.1.5` kommt, Folgendes
verliert. Nichts davon ist ein Versehen — jeder Punkt ist eine bewusste Entscheidung —,
aber jeder ist für einen Integrator sichtbar; planen Sie das Upgrade daher entsprechend.

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
`horizon_account_cursor`, `RETRYING`, `SWAP_EXPIRED`, `LIQUIDITY_EXPIRED`), sind alle
weiterhin in `schema.prisma` deklariert und nach `migrate deploy` weiterhin vorhanden.
Sie werden schlicht nie geschrieben. Live-Spalten zu entfernen — und einen Enum-Wert,
den PostgreSQL nicht entfernen kann, ohne den Typ neu zu erstellen — wäre eine
destruktive Migration ohne jeden Gewinn, und sie deklariert zu lassen ist das, was
`prisma migrate diff` sauber hält.

## Umgebungsvariablen

Jede Variable, die in `src/` aus `process.env` gelesen wird, wird beim Start von
`src/config/env.validation.ts` validiert (Fail-fast). Kopieren Sie `.env.example` und
passen Sie mindestens `DATABASE_URL` und `APISIX_GATEWAY_SECRET` an.

| Variable | Erforderlich | Standard | Wirkung |
| -------- | ------------ | -------- | ------- |
| `NODE_ENV` | nein | `development` | Muss `development`, `test` oder `production` sein. **Setzen Sie in Produktion `production`** — die Fail-closed-Prüfung der Plan-Gebühr und die standardmäßig deaktivierten Docs hängen beide davon ab |
| `PORT` | nein | `3000` | HTTP-Port, auf dem der Dienst lauscht |
| `DATABASE_URL` | **ja** | — | PostgreSQL-Verbindung für Prisma |
| `APISIX_GATEWAY_SECRET` | **ja** | — | Gemeinsames Secret, das belegt, dass die Anfrage über APISIX kam. **Mindestens 32 Zeichen** — dies ist die gesamte Grenze zwischen „kam über das Gateway“ und „jeder, der den Pod erreichen kann“ |
| `APISIX_GATEWAY_SECRET_HEADER` | nein | `x-gateway-secret` | Header-Name für das Gateway-Secret |
| `APISIX_CONSUMER_HEADER` | nein | `x-consumer-username` | Benutzername des authentifizierten Consumers |
| `APISIX_CREDENTIAL_HEADER` | nein | `x-credential-identifier` | Credential-ID aus key-auth |
| `APISIX_ENVIRONMENT_HEADER` | nein | `x-consumer-env` | Umgebung des Keys (`dev` / `prod`) |
| `APISIX_ROLE_HEADER` | nein | `x-consumer-role` | Vom Gateway weitergeleitete Consumer-Rolle |
| `APISIX_PERMISSIONS_HEADER` | nein | `x-consumer-permissions` | Vom Gateway weitergeleitete Berechtigungsliste |
| `APISIX_ORGANIZATION_HEADER` | nein | `x-consumer-org` | Organisations-ID |
| `APISIX_PLAN_HEADER` | nein | `x-consumer-plan` | Plan der Organisation |
| `APISIX_SWAP_FEE_BPS_HEADER` | nein | `x-plan-swap-fee-bps` | Swap-Gebühr des Plans (bps) |
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
| `BLINDPAY_API_KEY` | nein | — | API-Key der BlindPay-Plattform |
| `BLINDPAY_INSTANCE_ID` | wenn API-Key gesetzt | — | BlindPay-Instanz-ID (`in_...`) |
| `BLINDPAY_BASE_URL` | nein | `https://api.blindpay.com/v1` | Basis-URL der BlindPay API |
| `BLINDPAY_WEBHOOK_SECRET` | wenn API-Key gesetzt | — | Svix-Secret für eingehende BlindPay-Webhooks |
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

`key-auth` leitet nach erfolgreicher Authentifizierung `X-Consumer-Username` /
`X-Credential-Identifier` an den Upstream weiter und überschreibt dabei jede vom Client
mitgeschickte Kopie; der Guard verlässt sich darauf.

> **Die Entfernungsliste ist tragend, und sie ist der einzige Teil dieses
> Sicherheitsmodells, der sich nicht innerhalb dieses Repositorys verifizieren lässt.**
> Jeder Header im obigen Block ist eine Autorisierungseingabe, die der Dienst unbesehen
> akzeptiert; `X-Gateway-Secret` belegt nur, dass die Anfrage durch *ein* Gateway kam,
> nicht, dass die Werte ehrlich sind. Behandeln Sie diese Liste als
> Produktionskonfiguration mit derselben Review-Hürde wie Code: Prüfen Sie sie, wann
> immer eine Route hinzugefügt oder kopiert wird, und halten Sie den Dienst in einem
> privaten Netzwerk, sodass der einzige erreichbare Pfad über APISIX führt. Das
> gemeinsame Secret ist die zweite Schutzschicht, nicht die einzige.
>
> Der Dienst arbeitet jetzt fail-closed bei der einen Eingabe, bei der sich Schweigen
> früher auszahlte: Ein fehlendes `X-Plan-Swap-Fee-Bps` in einer
> Produktionskonfiguration ergibt 503 statt eines stillen Rückfalls auf den Standardwert
> aus der Umgebung.
>
> `X-Cosmos-Internal` trägt mehr Gewicht als früher: Seit `ADMIN_API_CREDENTIALS`
> entfernt wurde, ist er das, was diesem Dienst sagt, dass eine Anfrage von der
> Plattform-Konsole kam und nicht von einem API-Key, und damit das, was `/v1/admin`
> öffnet. Er ist weiterhin nur für einen Aufrufer erreichbar, der bereits das
> Gateway-Secret vorgelegt hat, sodass die Exposition dadurch und durch
> Netzwerkisolation begrenzt ist — aber eine Route, die vergisst, ihn zu entfernen,
> macht jeden API-Key zum Plattform-Admin.

> Halten Sie den Dienst in einem privaten Netzwerk, sodass der einzige erreichbare Pfad
> über APISIX führt; das gemeinsame Secret ist die zweite Schutzschicht, nicht die
> einzige.

## Dieses Dokument ehrlich halten

**Das README ist Teil der Änderung, kein Nachtrag.** Nichts in CI erkennt, wenn es
veraltet — der Build bleibt grün, während diese Seiten stillschweigend einen Dienst
beschreiben, den es nicht mehr gibt —, daher wird es im selben Commit aktualisiert wie
der Code, den es beschreibt. Die vollständige Konvention, einschließlich der Frage,
welchen Abschnitt jede Art von Änderung betrifft, steht in [`CLAUDE.md`](./CLAUDE.md);
die Kurzfassung:

| Wenn Sie … | Aktualisieren Sie |
| ---------- | ----------------- |
| ein Modul unter `src/` hinzufügen oder entfernen | [Projektstruktur](#projektstruktur) |
| einen `process.env`-Lesezugriff hinzufügen, umbenennen oder löschen | [Umgebungsvariablen](#umgebungsvariablen) **und** `.env.example` |
| einen Provider integrieren oder ändern, wie sich einer verhält | den eigenen `##`-Abschnitt dieses Providers |
| ein veröffentlichtes Antwortformat, einen Statuscode oder einen Scope ändern | [Upgrade](#upgrade--breaking-changes-und-deploy-hinweise) |
| eine Route hinzufügen, umbenennen, entfernen oder ihren Scope ändern | [Routenindex](#routenindex) und den eigenen Abschnitt des Moduls |
| etwas lernen, das ein Operator oder Integrator nicht übersehen darf | den Abschnitt, zu dem es gehört |

**Dieses Dokument existiert in sieben Sprachen** — English, Español, Português,
Deutsch, Français, हिन्दी und 简体中文 —, und eine Änderung an einer ist eine Änderung an
allen sieben, im selben Commit. Englisch ist die Quelle, und die anderen sind
Übersetzungen davon: dieselben Überschriften, Tabellen und Codeblöcke, wobei Bezeichner
(Routen, Umgebungsvariablen, Header, Fehlercodes) exakt so bleiben, wie sie sind.
`npm run readme:check` lässt CI fehlschlagen, wenn eine Sprachdatei fehlt, wenn ihre
Überschriften nicht mehr mit den englischen übereinstimmen oder wenn eine Route aus dem
OpenAPI-Vertrag in ihrem Routenindex fehlt.

Zwei Dinge stehen bewusst **nicht** hier: **Request- und Response-Schemas**, die in den
generierten OpenAPI-Vertrag gehören (`npm run openapi:check` hält ihn ehrlich), und
**alles, was der Code bereits aussagt** — dieses Dokument ist dafür da, *warum* etwas so
ist, wie es ist, und wie man es betreibt, denn eine zweite Kopie dessen, *was* es tut,
ist nur eine weitere Kopie, die man wahrheitsgetreu halten muss.
