# Cosmos Pay — Microservicio de pagos

[English](../../README.md) · **Español** · [Português](./README.pt.md) · [Deutsch](./README.de.md) · [Français](./README.fr.md) · [हिन्दी](./README.hi.md) · [简体中文](./README.zh.md)

Microservicio de pagos construido con **NestJS 12** + **Prisma 7 (PostgreSQL)**.

Es una aplicación *independiente* de la plataforma para desarrolladores de Cosmos
(`paydev`). La plataforma para desarrolladores es un panel: **emite** API keys para
desarrolladores y **muestra** sus datos. No está en el camino de ninguna solicitud que
haga un cliente — cada llamada va cliente → APISIX → este servicio, así que la
plataforma puede caerse sin que un wallet o una integración lo note (ver
[Ninguna solicitud depende de la plataforma para desarrolladores](#ninguna-solicitud-depende-de-la-plataforma-para-desarrolladores)).
Este servicio se ubica **detrás de APISIX**, que balancea la carga y autentica cada
solicitud antes de reenviarla aquí. Nunca ve las API keys en crudo — solo confía en
lo que el gateway reenvía.

## Cómo se garantiza "solo APISIX"

Una solicitud se acepta únicamente cuando se cumplen **ambas** condiciones (ver
`src/common/guards/apisix.guard.ts`):

1. **Secreto compartido del gateway.** La solicitud incluye `X-Gateway-Secret`, que
   se compara en tiempo constante con `APISIX_GATEWAY_SECRET`. APISIX *inyecta* este
   header en cada solicitud que reenvía y *elimina* cualquier copia enviada por el
   cliente, por lo que un valor correcto solo puede provenir del gateway. (Defensa en
   profundidad: combinarlo con aislamiento de red para que el servicio no sea
   accesible directamente.)
2. **Consumidor autenticado.** El plugin `key-auth` de APISIX, después de validar la
   API key de quien llama, reenvía `X-Consumer-Username` (y
   `X-Credential-Identifier`). El guard exige que el header del consumidor esté
   presente, lo que demuestra que la key se autenticó upstream.

Las rutas pueden excluirse con `@Public()` (lo usan las sondas de salud que el
orquestador consulta directamente). La verificación está siempre activa: no existe
un flag para desactivarla. Para desarrollo local, ejecutar detrás de APISIX o enviar
manualmente `X-Gateway-Secret` + los headers `X-Consumer-*`.

`/v1/admin` abarca a todos los tenants, así que `AdminGuard` además exige
`X-Cosmos-Internal`. APISIX **elimina** ese header de todo lo que reenvía, por lo que
solo puede enviarlo un backend que llame directamente al servicio con el secreto del
gateway: la plataforma para desarrolladores, que decide si la cuenta con sesión
iniciada es owner o admin. No hay una credencial de administración separada: el
secreto del gateway, el aislamiento de red y la lista de headers eliminados en la ruta
del gateway son lo que protege los datos de todos los tenants.

El pipeline:

```
request → ApisixContextMiddleware  (reads consumer headers → req.gatewayConsumer)
        → ApisixGuard (APP_GUARD)  (verifies secret + consumer, or @Public bypass)
        → ValidationPipe           (DTO validation)
        → Controller / Service     (@CurrentConsumer() gives the consumer)
```

## Estructura del proyecto

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
  payment-intents/                payment intents on Stellar, Solana and Monad: controller, service, DTOs,
                                  per-chain link builders and verifiers, the observer — emits events
  chains/                         chain list, per-chain address rules, units, message signatures, JSON-RPC
  solana/                         Solana RPC client (cluster-checked), Solana Pay links
  evm/                            EVM RPC client for Monad (chain-id-checked), EIP-681 links
  swaps/                          Stellar native swaps (path payments): quote, build XDR, submit
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
prisma/schema.prisma              Consumer, PaymentIntent, Swap, LiquidityPoolOperation,
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

Todas las rutas están versionadas bajo `/v1` (versionado por URI).

Cada ruta figura en el [índice de rutas](#índice-de-rutas) más abajo, con su scope.
**Los esquemas de solicitud y respuesta están en el contrato OpenAPI generado**, que
se regenera a partir de los controllers y DTOs en cada ejecución de CI
(`npm run openapi:check` hace fallar el build si hay divergencias):

- `openapi/openapi.json` / `openapi/openapi.yaml` — versionados en el repositorio, revisables en un diff
- `/docs` — Swagger UI, cuando `SWAGGER_ENABLED=true`
- `/docs/json`, `/docs/yaml` — la misma especificación servida en vivo

| Área                  | Ruta base                | Qué hace                                                  |
| --------------------- | ------------------------ | --------------------------------------------------------- |
| Intenciones de pago   | `/v1/payment-intents`    | Intenciones `pay` en Stellar (SEP-7), Solana (Solana Pay) y Monad (EIP-681), `tx` SEP-7, validación, observador on-chain |
| Swaps                 | `/v1/swaps`              | Cotización de path payment, construcción del XDR sin firmar, envío del firmado |
| Pools de liquidez     | `/v1/liquidity-pools`    | Depósito / retiro en AMM, posiciones, comisión sobre la ganancia |
| Webhooks              | `/v1/webhooks`           | CRUD de endpoints, rotación de secretos, entregas, reenvío |
| KYC                   | `/v1/kyc`                | Receivers (KYC/KYB), wallets, cuentas bancarias, carga de documentos |
| Onramp                | `/v1/onramp`             | Cotizaciones de payin, payins, cuentas virtuales          |
| Offramp               | `/v1/offramp`            | Cotizaciones de payout, autorización, payouts (firmados por el cliente) |
| Productos             | `/v1/products`           | Catálogo del comercio                                     |
| Clientes              | `/v1/customers`          | Registros de pagadores derivados de las intenciones       |
| Alias                 | `/v1/aliases`            | Identificadores de pago reclamables: reclamar, resolver, recuperar |
| Inicio de sesión del wallet | `/v1/wallet` | Google / GitHub / código por email, y el respaldo cifrado de la semilla |
| Activos               | `/v1/assets`             | Registro curado de activos por red                        |
| Key pública           | `/v1/public-key`         | La API key pública compartida, servida sin key (`@Public`) |
| Analítica             | `/v1/summary`, `/v1/balances`, `/v1/logs` | Agregados y logs del dashboard           |
| Actividad             | `/v1/activity`           | Eventos reportados por los clientes: ingesta, feed, resumen |
| Plugins               | `/v1/plugins`            | Extensiones compiladas bajo un slug, instaladas por tenant |
| Administración        | `/v1/admin`              | Lecturas/escrituras entre tenants — solo consola de la plataforma, auditadas |
| Salud                 | `/v1/health`             | Liveness / readiness (`@Public`)                          |

### Índice de rutas

Todas las rutas que sirve este servicio. **Scope** es lo que debe tener la API key —
*uno de* significa que basta con cualquiera de los scopes listados, y `—` significa
cualquier key autenticada. **API key pública** marca las rutas que puede llamar la API
key pública compartida (ver
[La API key pública compartida](#la-api-key-pública-compartida)). Una ruta marcada
como *consola de la plataforma* no acepta ninguna API key; solo el backend de la
consola llega a ella. Las rutas usan la forma `{param}` de OpenAPI.

| Método | Ruta | Scope | API key pública |
| ------ | ---- | ----- | --------------- |
| GET | `/v1/activity/events` | `activity:read` |  |
| POST | `/v1/activity/events` | `activity:write` | ✓ |
| GET | `/v1/activity/summary` | `activity:read` |  |
| GET | `/v1/admin/audit-logs` | consola de la plataforma |  |
| GET | `/v1/admin/consumers` | consola de la plataforma |  |
| GET | `/v1/admin/customers` | consola de la plataforma |  |
| GET | `/v1/admin/payins` | consola de la plataforma |  |
| GET | `/v1/admin/payment-intents` | consola de la plataforma |  |
| GET | `/v1/admin/payouts` | consola de la plataforma |  |
| GET | `/v1/admin/products` | consola de la plataforma |  |
| GET | `/v1/admin/receivers` | consola de la plataforma |  |
| PATCH | `/v1/admin/receivers/{id}/access` | consola de la plataforma |  |
| POST | `/v1/admin/receivers/{id}/approve` | consola de la plataforma |  |
| POST | `/v1/admin/receivers/{id}/enable` | consola de la plataforma |  |
| POST | `/v1/admin/receivers/{id}/tos` | consola de la plataforma |  |
| GET | `/v1/admin/summary` | consola de la plataforma |  |
| GET | `/v1/admin/swaps` | consola de la plataforma |  |
| GET | `/v1/aliases` | `payments:read` |  |
| POST | `/v1/aliases` | `payments:write` |  |
| GET | `/v1/aliases/availability/{name}` | `payments:read` | ✓ |
| GET | `/v1/aliases/by-address/{address}` | `payments:read` | ✓ |
| POST | `/v1/aliases/challenges` | `payments:write` |  |
| GET | `/v1/aliases/resolve/{name}` | `payments:read` | ✓ |
| DELETE | `/v1/aliases/{name}` | `payments:write` |  |
| POST | `/v1/aliases/{name}/addresses` | `payments:write` |  |
| DELETE | `/v1/aliases/{name}/addresses/{addressId}` | `payments:write` |  |
| POST | `/v1/aliases/{name}/recovery` | consola de la plataforma |  |
| POST | `/v1/aliases/{name}/recovery/complete` | `payments:write` |  |
| GET | `/v1/assets` | — | ✓ |
| GET | `/v1/balances` | `payments:read` |  |
| POST | `/v1/blindpay/webhooks` | ninguno — `@Public()`, firma Svix |  |
| GET | `/v1/customers` | `customers:read` |  |
| POST | `/v1/customers` | `customers:write` |  |
| GET | `/v1/customers/{id}` | `customers:read` |  |
| PATCH | `/v1/customers/{id}` | `customers:write` |  |
| DELETE | `/v1/customers/{id}` | `customers:write` |  |
| GET | `/v1/health/liveness` | ninguno — `@Public()` |  |
| GET | `/v1/health/readiness` | ninguno — `@Public()` |  |
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
| GET | `/v1/liquidity-pools` | uno de `liquidity:read`, `swaps:read` | ✓ |
| POST | `/v1/liquidity-pools/deposit` | uno de `liquidity:write`, `swaps:write` | ✓ |
| GET | `/v1/liquidity-pools/operations` | uno de `liquidity:read`, `swaps:read` |  |
| GET | `/v1/liquidity-pools/operations/{id}` | uno de `liquidity:read`, `swaps:read` |  |
| POST | `/v1/liquidity-pools/operations/{id}/submit` | uno de `liquidity:write`, `swaps:write` | ✓ |
| GET | `/v1/liquidity-pools/positions` | uno de `liquidity:read`, `swaps:read` | ✓ |
| POST | `/v1/liquidity-pools/withdraw` | uno de `liquidity:write`, `swaps:write` | ✓ |
| GET | `/v1/liquidity-pools/{poolId}` | uno de `liquidity:read`, `swaps:read` | ✓ |
| GET | `/v1/defindex/vaults` | uno de `liquidity:read`, `swaps:read` | ✓ |
| GET | `/v1/defindex/vaults/{vault}` | uno de `liquidity:read`, `swaps:read` | ✓ |
| GET | `/v1/defindex/vaults/{vault}/balance` | uno de `liquidity:read`, `swaps:read` | ✓ |
| POST | `/v1/defindex/vaults/{vault}/deposit` | uno de `liquidity:write`, `swaps:write` | ✓ |
| POST | `/v1/defindex/vaults/{vault}/withdraw` | uno de `liquidity:write`, `swaps:write` | ✓ |
| POST | `/v1/defindex/submit` | uno de `liquidity:write`, `swaps:write` | ✓ |
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

### Respuestas de error

Toda falla devuelve la misma estructura, y `code` es la parte estable y legible por
máquina — conviene ramificar según ese campo y no según `message`, que es texto en
prosa y puede reformularse:

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

La estructura y el enum completo de `code` se publican en la especificación OpenAPI
como `ApiErrorBodyEntity` (fuente: `ApiErrorCode` en
`src/common/errors/api-error.ts`). Cada operación documenta solo los status que
realmente puede devolver, y cada status lleva un ejemplo por cada `code` que puede
traer —el mensaje real, con el `statusCode` y el `error` que le corresponden—, de
modo que Swagger UI y una importación en Postman muestran el cuerpo que de verdad se
recibe. **Los códigos nunca se renombran una vez publicados**; pueden agregarse
nuevos, así que un código no reconocido debe tratarse según su status HTTP.

Algunos que es fácil confundir:

| Código | Estado | Significado |
| ------ | ------ | ----------- |
| `insufficient_scope` | 403 | La API key no tiene el scope. Volver a aprovisionar la key |
| `account_disabled` | 403 | Un operador deshabilitó esta cuenta fiat. No es un problema de la key |
| `gateway_required` | 403 | La solicitud no llegó a través de APISIX |
| `admin_console_only` | 403 | La ruta pertenece a la consola de la plataforma (`/v1/admin`, iniciar una recuperación de alias). Ninguna API key puede llamarla |
| `idempotency_conflict` | 409 | Este `Idempotency-Key` (o el memo de una intención de pago) ya produjo un recurso para una solicitud *diferente*. Repetir la solicitud original o usar una key nueva |
| `kyc_state_invalid` | 409 | Una transición de estado de KYC no permitida — no una solicitud duplicada |
| `operation_in_flight` | 409 | Una operación en conflicto todavía se está liquidando |
| `payload_expired` | 409 | El cuerpo de la entrega superó el período de retención y no puede reenviarse |
| `provider_unavailable` | 502/503/504 | BlindPay u Horizon no están accesibles. Reintentar |
| `misconfigured` | 503 | Un error de configuración del lado del servidor. Reintentar no ayudará |

### Ejecución con más de una réplica

APISIX balancea la carga entre instancias, por lo que cada temporizador en segundo
plano se ejecuta en todas las réplicas. Los cambios de estado ya son seguros — cada uno
es un compare-and-swap con `updateMany` protegido — pero los ciclos duplicados
multiplicarían las llamadas a Horizon contra una API que aplica rate limits. Por eso
cada temporizador toma un **advisory lock a nivel de transacción** de PostgreSQL
(`AdvisoryLockService`) y omite su ciclo cuando otra réplica lo tiene:

| Temporizador                   | Clave del lock           |
| ------------------------------ | ------------------------ |
| `SettlementObserverService`    | `SettlementObserver`     |
| `PaymentIntentObserverService`       | `PaymentIntentObserver`  |
| `RequestLogRetentionService`   | `RequestLogRetention`    |
| Sweeper de entregas de webhooks | `WebhookDeliverySweeper` |
| `RateLimitPruneService`        | `RateLimitPrune`         |
| `AliasChallengeSweeperService` | `AliasChallengeSweeper`  |

`pg_try_advisory_xact_lock` nunca bloquea y se libera cuando termina la transacción,
incluso ante una caída o una conexión perdida. A diferencia de un lock a nivel de
sesión, también funciona detrás de PgBouncer en modo transaction pooling.

Los ids de lock están en el enum `AdvisoryLockKey`. No cambiar el número de un id
existente — durante un despliegue gradual, las réplicas antiguas y las nuevas tomarían
locks distintos — ni reutilizar uno retirado.

### Validación de pagos y el observador on-chain

Un pago se confirma contra la red Stellar en un solo lugar
(`StellarVerifierService`): la transacción debe ser **exitosa**, contener un **pago
nativo (XLM)** al `destination` de la intención por el **monto exacto**, — cuando la
intención tiene memo — llevar un **memo coincidente** (`memo_type: id`), y haberse
cerrado **no antes de un minuto previo a la creación de la intención**
(`TX_CREATED_AT_SKEW_MS`). Ese límite de antigüedad es lo que impide que un pago
on-chain antiguo con los mismos términos liquide una intención nueva.

Dos caminos usan esa única regla:

- **Manual:** `POST /v1/payment-intents/:id/validate` con `{ "txHash": "<64-hex>" }`.
  Si coincide, la intención pasa a `SUCCEEDED` (y se guarda `txHash`) y se dispara un
  webhook `PAYMENT_INTENT_SUCCEEDED`. Una tx que falló on-chain marca la intención
  como `FAILED` **solo cuando era el pago propio de esta intención** — mismo memo,
  destino y activo. Cualquier otra transacción, fallida o no, es una discrepancia que
  deja el estado sin cambios, de modo que todavía pueda enviarse la tx correcta. Un
  `txHash` reportado con `PATCH /v1/payment-intents/:id` nunca liquida una intención
  por sí solo: debe ser un hash hex de 64 caracteres, se guarda en minúsculas, y es
  único solo entre las intenciones del consumidor que llama (`409
  idempotency_conflict` ante un choque con otra de las suyas).
- **Automático (observador permanente):** `PaymentIntentObserverService` consulta Horizon
  cada `OBSERVER_INTERVAL_MS` en busca de intenciones `PENDING` — por el `txHash`
  reportado, o recorriendo los pagos al destino — y finaliza las coincidencias de la
  misma forma, de modo que los estados cambian y los eventos se disparan **sin que
  nadie llame a la API**. Un ciclo toma como máximo
  `OBSERVER_MAX_INTENTS_PER_CONSUMER` (10) intenciones por consumidor y nunca recorre
  una expirada, por lo que un solo consumidor no puede retrasar la liquidación de
  todos los demás. Para desactivarlo en desarrollo local, usar
  `OBSERVER_ENABLED=false`.

**La expiración primero verifica la cadena.** Una intención que superó su tiempo de
vida se verifica una vez más antes de marcarse `EXPIRED`: si su pago está on-chain,
se liquida como `SUCCEEDED` en su lugar, y si Horizon no puede alcanzarse, se deja
para el siguiente ciclo. Cuando el hash de ese pago ya está en otra de las
intenciones del mismo consumidor, la intención se expira en lugar de reintentarse
para siempre. Un pago verificado después de la expiración, por el observador o por
`validate`, igualmente mueve una intención `EXPIRED` a `SUCCEEDED` y dispara
`PAYMENT_INTENT_SUCCEEDED`, así que no hay que tratar `EXPIRED` como estado final.
El recorrido lee los pagos al destino hasta la creación de la intención, como
máximo 1000 (5 páginas de 200); si un destino recibe más que eso durante la vida de
una intención, hay que llamar a `validate` con el hash.

### Retención de los logs de solicitudes de la API

Toda solicitud entrante, excepto `/v1/health` y `/docs`, se agrega a `request_log`
mediante `LoggingInterceptor` y alimenta la vista **API logs** del dashboard
(`GET /v1/logs`). Las filas incluyen ruta, status, duración y — cuando están
presentes — `ip` / `userAgent` del pagador.

El tráfico del dashboard (`X-Cosmos-Internal`) se **registra y se marca**
(`request_log.internal`), no se omite, y la vista de logs de la API filtra por esa
columna, así que ningún header de solicitud puede dejar tráfico fuera del log.

Las filas **no se conservan para siempre**. `RequestLogRetentionService` elimina las
filas con una antigüedad mayor a `REQUEST_LOG_RETENTION_DAYS` (por defecto **30**)
mediante un temporizador (`REQUEST_LOG_PRUNE_INTERVAL_MS`, por defecto **1h**). Cada
ciclo elimina en bloques cortos de `REQUEST_LOG_PRUNE_BATCH_SIZE` (por defecto
**1000**) y sigue iterando hasta que no queda nada acumulado o se alcanza
`REQUEST_LOG_PRUNE_MAX_PER_CYCLE` (por defecto **50000**), de modo que un historial
grande puede ponerse al día sin mantener un lock largo sobre la tabla. Establecer
`REQUEST_LOG_RETENTION_DAYS=0` desactiva la depuración por completo (el servicio lo
registra en el arranque). El índice compuesto sobre `(consumer, createdAt)` mantiene
rápida la consulta del dashboard a medida que crece el volumen.

### Actividad del cliente (lo que reportan la wallet y el dashboard)

`request_log` solo registra las solicitudes que llegaron a este servicio. No puede ver
una wallet que se cerró inesperadamente en su pantalla de envío, una firma que el
usuario canceló ni una página del dashboard que falló antes de enviar nada, así que
los propios clientes reportan esos eventos a `POST /v1/activity/events`.

- **Por lotes.** Los clientes encolan los eventos y los envían juntos, por lo que una
  wallet sin conexión los envía en el siguiente inicio. Hasta `ACTIVITY_MAX_BATCH`
  (100) por solicitud.
- **Reintentar es seguro.** Un evento puede incluir el `eventId` propio del cliente;
  `(consumerId, eventId)` es único y los duplicados se omiten. La respuesta informa
  `accepted` y `duplicates`.
- **La atribución la da el gateway.** Las filas se escriben bajo el consumidor que
  APISIX autenticó; no hay ningún campo del cuerpo para eso.
- **Tolera payloads incorrectos.** Un `message` demasiado largo se trunca y un `props`
  demasiado grande se reemplaza por `{"_dropped": "props_too_large"}` en lugar de
  rechazar el lote completo.
- **Marcas de tiempo acotadas.** `occurredAt` se reemplaza por la hora de recepción
  cuando está más de cinco minutos adelantado o más de siete días atrasado. Se
  conservan ambas horas: `at` (la del cliente) y `receivedAt`.

Consulta de los datos:

| Ruta                    | Scope             | Devuelve                                                             |
| ----------------------- | ----------------- | -------------------------------------------------------------------- |
| `GET /v1/activity/events` | `activity:read` | El feed, del más reciente al más antiguo. Filtros: `source`, `level`, `category`, `type` (prefijo), `network`, `since`/`until` |
| `GET /v1/activity/summary` | `activity:read` | Conteos por level/source/category, tipos de evento más frecuentes, errores más frecuentes, sesiones, dispositivos, una serie diaria |

`level` en el feed es un **mínimo**, no una coincidencia exacta: `level=warn` devuelve
advertencias *y* errores.

`activity_event` contiene una IP, un user agent y lo que el cliente haya adjuntado, por
lo que se depura con el mismo job y en los mismos lotes acotados que `request_log` —
`ACTIVITY_RETENTION_DAYS`, por defecto **30**, `0` para conservar los eventos para
siempre.

### Webhooks (notificaciones a integradores)

Cada integrador (consumidor de APISIX) registra uno o más endpoints de webhook. Cuando
una intención de pago cambia, la plataforma dispara un evento de dominio; el
**dispatcher** lo distribuye a cada endpoint habilitado de ese consumidor que esté
suscrito al tipo de evento (suscripción vacía = todos), registra cada intento para
trazabilidad y reintenta con backoff lineal (variables de entorno `WEBHOOK_*`).

Tipos de evento: `PAYMENT_INTENT_CREATED`, `PAYMENT_INTENT_UPDATED`,
`PAYMENT_INTENT_SUCCEEDED`, `PAYMENT_INTENT_FAILED`, `PAYMENT_INTENT_CANCELLED`,
`PAYMENT_INTENT_DELETED`, `SWAP_CREATED`, `SWAP_SUBMITTED`, `SWAP_SUCCEEDED`,
`SWAP_FAILED`, `LIQUIDITY_CREATED`, `LIQUIDITY_SUBMITTED`, `LIQUIDITY_SUCCEEDED`,
`LIQUIDITY_FAILED`, además de los provenientes de BlindPay `RECEIVER_UPDATED`,
`PAYIN_CREATED`, `PAYIN_UPDATED`, `PAYIN_COMPLETED`, `PAYOUT_CREATED`,
`PAYOUT_UPDATED` y `PAYOUT_COMPLETED`. La lista autoritativa es el enum
`WebhookEventType` en `prisma/schema.prisma`.

**Cuerpos provenientes de BlindPay.** `RECEIVER_UPDATED` / `PAYIN_*` / `PAYOUT_*`
incluyen solo identidad y estado — ids, status, montos, rails — nunca datos personales.
El objeto del proveedor no se reenvía, porque el payload de un receiver es un
expediente KYC completo y suscribirse solo requiere `webhooks:write`. Los detalles
deben obtenerse de la API con una key que tenga `kyc:read` / `onramp:read` /
`offramp:read`. La lista de campos permitidos está en
`src/native-plugins/blindpay/blindpay-event-redaction.ts`.

La entrega está desacoplada mediante `EventEmitter2` de NestJS (`webhook.event`), por
lo que emitir una notificación nunca bloquea la solicitud a la API que la originó.

**Política de destinos salientes (SSRF):** los endpoints deben usar `https` y
resolver solo a direcciones públicas. El registro rechaza loopback, rangos privados
RFC1918, link-local (`169.254.0.0/16`, incluido el endpoint de metadatos de la nube
`169.254.169.254`) y hostnames de metadatos conocidos. **Todo rechazo que dependa del
host da la misma respuesta** — «el host no es un destino permitido» — y el motivo va
al log: distinguir «aquí no resuelve» de «resuelve a `10.0.4.7`» y de «resuelve al
servicio de metadatos» le permitiría a cualquiera que pueda registrar un endpoint
mapear la red en la que corre este servicio, una URL a la vez. Una URL malformada, un
esquema incorrecto, credenciales o la falta de host siguen diciendo exactamente qué
está mal: describen la cadena enviada, no la red. La misma verificación se
ejecuta de nuevo inmediatamente antes de cada entrega (el DNS puede cambiar después
del registro). El cliente HTTP usa `redirect: manual` (nunca sigue `3xx`), timeouts de
conexión/lectura definidos por variables de entorno y un tamaño máximo para el cuerpo
de la respuesta.

| Variable | Valor por defecto | Significado |
| -------- | ----------------- | ----------- |
| `WEBHOOK_CONNECT_TIMEOUT_MS` | `3000` | Presupuesto de conexión (parte del timeout de AbortSignal) |
| `WEBHOOK_READ_TIMEOUT_MS` | `5000` | Presupuesto de lectura (parte del timeout de AbortSignal) |
| `WEBHOOK_MAX_RESPONSE_BYTES` | `65536` | Límite del cuerpo de respuesta que se consume |
| `WEBHOOK_TIMEOUT_MS` | `5000` | Fallback heredado si no se definen los timeouts separados |
| `WEBHOOK_MAX_ATTEMPTS` / `WEBHOOK_BACKOFF_MS` | `3` / `2000` | Bucle de reintentos en proceso, por intento de entrega |
| `WEBHOOK_SWEEP_ENABLED` | `true` | Recupera entregas varadas por una caída. Es el interruptor de incidentes — establecer `false` para detener el reenvío a un integrador que está colapsando |
| `WEBHOOK_SWEEP_INTERVAL_MS` | `60000` | Con qué frecuencia una réplica intenta el barrido (solo una gana por ciclo) |
| `WEBHOOK_PAYLOAD_RETENTION_DAYS` | `30` | Pasado este plazo, el cuerpo almacenado de una entrega finalizada se reemplaza por un marcador de redacción. `0` conserva los cuerpos para siempre |

**Una entrega puede intentarse hasta 9 veces, no 3.** `WEBHOOK_MAX_ATTEMPTS` limita un
bucle de reintentos en proceso. Luego el sweeper toma las entregas que todavía no
superan `WEBHOOK_MAX_ATTEMPTS × 3` intentos totales, distribuidos a lo largo de horas,
por lo que una entrega interrumpida por el reinicio de un pod no se pierde.

**El reenvío solo funciona dentro de la ventana de retención.** Después de
`WEBHOOK_PAYLOAD_RETENTION_DAYS` el cuerpo almacenado se borra (el log de entregas se
conserva). El sweeper omite esas filas, y
`POST /v1/webhooks/:id/deliveries/:id/redeliver` devuelve `409 payload_expired`.

**Recepción de webhooks.** Cualquier `2xx` confirma la recepción. Responder dentro de
`WEBHOOK_READ_TIMEOUT_MS` (5s por defecto). El orden no está garantizado, así que hay
que conciliar con la API. Deduplicar por el `id` del evento; un reenvío reutiliza el
`id` original (entrega at-least-once).

**Migración de endpoints existentes:** después del despliegue, ejecutar

```bash
npm run webhooks:audit-destinations
```

Las filas inseguras quedan con `destinationBlocked=true` y `enabled=false`. Los
integradores corrigen la URL con `PATCH /v1/webhooks/:id` `{ "url": "https://…" }`
(la validación se ejecuta de nuevo y limpia el flag), o las vuelven a habilitar cuando
el DNS sea público.

**Payload** (cuerpo del POST a la URL del integrador):

```jsonc
{
  "id": "evt_...",                 // stable event id (use for idempotency)
  "type": "PAYMENT_INTENT_SUCCEEDED",
  "createdAt": "2026-...",
  "data": { /* the payment intent */ }
}
```

**Headers**:

- `X-Cosmos-Signature: t=<unixSeconds>,v1=<hexHmacSha256>` — HMAC-SHA256 de
  `${t}.${rawBody}` usando el secreto `whsec_...` del endpoint.
- `X-Cosmos-Event`, `X-Cosmos-Event-Id`, `X-Cosmos-Delivery`.

**Verificación de la firma (del lado del integrador):**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody: string, header: string, secret: string): boolean {
  const [t, v1] = header.split(',').map((p) => p.split('=')[1]);
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
```

El secreto de firma se devuelve **una sola vez** en `POST /webhooks` (y en
`rotate-secret`); las respuestas de listado/obtención nunca lo incluyen. Cada intento
se almacena (`webhook_delivery`) con status, intentos, código de respuesta y error —
se puede consultar mediante `GET /webhooks/:id/deliveries` y reenviar con la ruta
`redeliver`.

List, get y update devuelven exactamente los campos documentados del endpoint, y
create y `rotate-secret` agregan `secret`. Nada más de la fila sale del servicio —
ni `consumerId`, ni las columnas `previousSecret` / `previousSecretExpiresAt` que
escribió una rotación anterior con ventana de gracia.

**`ping` y `redeliver` tienen límite de tasa**, por consumidor y dirección del
cliente: `POST /v1/webhooks/:id/ping` 20 y
`POST /v1/webhooks/:id/deliveries/:deliveryId/redeliver` 30 cada 10 minutos
(`429 rate_limited`). Ambas hacen que este servicio envíe solicitudes firmadas a
una URL que uno eligió, y `redeliver` ejecuta todo el bucle de reintentos dentro de
la solicitud. Ante un backlog grande, conviene dejar que el sweeper reintente en
lugar de reenviar una por una.

### OpenAPI / Swagger

**Nota de seguridad:** `GET /docs`, `/docs/json` y `/docs/yaml` se montan como
**middleware de Express**, no como controllers de Nest, por lo que **no** pasan por
`ApisixGuard` ni por `PermissionsGuard` — cualquiera que pueda alcanzar el puerto del
servicio puede obtener la especificación. En producción, la documentación está
**desactivada por defecto** (`NODE_ENV=production` y sin `SWAGGER_ENABLED`).
Establecer `SWAGGER_ENABLED=true` solo en una red de confianza.

Exportar la especificación a archivos — no se necesita base de datos ni un secreto de
gateway real:

```bash
npm run openapi:generate
# writes openapi/openapi.json and openapi/openapi.yaml
```

CI regenera ambos archivos versionados y rechaza divergencias. Ejecutar la misma
verificación antes de hacer commit de un cambio en un controller o DTO:

```bash
npm run openapi:check
```

Las rutas de la especificación ya incluyen la versión (`/v1/...`). Para definir un host
del gateway en los `servers` de la especificación, establecer `OPENAPI_SERVER_URL`
antes de generarla:

```bash
OPENAPI_SERVER_URL=https://gateway.example.com npm run openapi:generate
```

**Uso desde Postman.** Importar `openapi/openapi.json`, o
`http://localhost:3000/docs/json` desde un servicio en ejecución. La especificación
ofrece dos servidores y dos requisitos de seguridad; las herramientas que eligen uno
toman el primero de cada lista:

| Llamada | Servidor | Autenticación |
| ------- | -------- | ------------- |
| Directo a este servicio (desarrollo local) | `http://localhost:{port}` (`port` por defecto `3000`) | `X-Gateway-Secret` **y** `X-Consumer-Username`, juntos |
| A través del gateway APISIX | `OPENAPI_SERVER_URL`, primero en la lista cuando está definido | `Authorization: Bearer <api key>` |

La especificación versionada se genera sin `OPENAPI_SERVER_URL`, así que por defecto
usa el par directo; generarla con la variable definida produce una colección que usa
el gateway por defecto. Postman guarda una sola API key por request: si la
importación configura solo `X-Gateway-Secret`, agregar `X-Consumer-Username` como
header de la colección. Los probes de salud se publican con `security: []`.

Cada operación lleva extensiones de proveedor que dicen qué es:
`x-cosmos-rate-limit` (sus presupuestos; puede responder `429`),
`x-cosmos-upstream` (el proveedor al que llama; puede responder
`502`/`503`/`504`), `x-cosmos-public` y `x-cosmos-public-key`.

`npm run openapi:generate` se niega a escribir una especificación en la que una
operación no tiene summary, un fallo no tiene cuerpo ni ejemplo, el `statusCode` de
un ejemplo no coincide con el status que documenta, o aparece un `429` en una ruta
sin presupuesto. Cada vez que se agrega o cambia una ruta, revisar su operación
regenerada; ver `CLAUDE.md`.

### Creación de intenciones — dos operaciones SEP-7, dos endpoints

Según [SEP-7](https://stellar.org/protocol/sep-7), las operaciones `tx` y `pay`
reciben **parámetros diferentes** y producen **respuestas diferentes**, por lo que
cada una tiene su propio endpoint, DTO y esquema de respuesta. El servicio no guarda
claves — solo arma la solicitud para la wallet del cliente (devuelve `uri` + `qr`,
además de `xdr` para `tx`). El activo por defecto es **XLM nativo** cuando se omite
`assetCode` (o cuando es `XLM`/`native`); cualquier otro activo requiere
`assetIssuer`.

**La red la determina el tipo de API key** que reenvía el gateway: una key `prod` →
public (mainnet), una key `dev` → testnet. `STELLAR_NETWORK` es solo un fallback para
desarrollo local sin el gateway. Cada intención almacena su propia red, y todas las
llamadas a Horizon (construcción, validación, observador) apuntan a ella. Cada
intención se almacena (tabla `payment_intent`) y queda limitada al consumidor que
llama: `PENDING → SUBMITTED → SUCCEEDED/FAILED/CANCELLED/EXPIRED`. La única salida
de un estado final es `EXPIRED → SUCCEEDED`, ante un pago verificado on-chain.

**El memo es un `MEMO_ID` obligatorio** — identifica el pago on-chain y hace que la
creación sea **idempotente**: `(consumer, memo)` es único, por lo que volver a crear
una intención con el mismo memo **y los mismos términos** devuelve la original. El
mismo memo con cualquier término diferente — tipo, red, destino, monto, activo, `msg`,
`callback`, o `source` para `tx` — es `409 idempotency_conflict`, y el error no dice
nada sobre la intención almacenada. Esto importa con la API key pública compartida,
donde todas las wallets anónimas son el mismo consumidor. Ambos constructores
comparten un presupuesto de **30 llamadas por minuto** por consumidor y dirección del
cliente (`429 rate_limited`): cada uno lee la cuenta del pagador desde Horizon y
escribe una fila, y con la key pública compartida la dirección es lo único que separa
a una wallet anónima de la siguiente. Si no se envía `memo`, se genera un uint64
aleatorio.

**`POST /v1/payment-intents/tx`** — el pagador (`source`) es conocido, así que se
construye el `TransactionEnvelope` sin firmar y una URI `web+stellar:tx?xdr=...`.

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

**`POST /v1/payment-intents/pay`** — no hay source, así que solo se devuelve una URI
`web+stellar:pay?destination=...` (la wallet elige el activo y el camino de origen).

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

Ejemplo de respuesta de `tx`:

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

Red/Horizon/fee/timeout se configuran mediante las variables de entorno `STELLAR_*`
(ver `.env.example`). Por seguridad, el valor por defecto es **testnet** — establecer
`STELLAR_NETWORK=public` para mainnet (fondos reales).

### Intenciones de pago en Solana y Monad

`POST /v1/payment-intents/pay` acepta un `chain` opcional: `stellar` (por defecto),
`solana` o `monad`. Una petición sin él es exactamente la petición Stellar de arriba.
El nivel de red sigue siendo el de la clave API —una clave `prod` llega a Solana
mainnet-beta y a Monad mainnet (chain id 143), una `dev` a Solana devnet y a Monad
testnet (10143)— y `network` se guarda como `public` / `testnet` en todas las
cadenas. `POST /v1/payment-intents/tx` sigue siendo solo Stellar: un `tx` SEP-7 es un
sobre de Stellar.

| | Stellar | Solana | Monad |
| --- | --- | --- | --- |
| Enlace (`uri`) | SEP-7 `web+stellar:pay` | Solana Pay `solana:<recipient>?…` | EIP-681 `ethereum:<payee>@143?…` |
| Moneda (sin `assetCode`) | XLM | SOL | MON |
| Token (`assetCode` + `assetIssuer`) | cuenta emisora | mint SPL | contrato ERC-20 |
| Cómo se encuentra el pago | `MEMO_ID` | una clave `reference` nueva por intención (`chainReference`) | la dirección de depósito propia de la intención (con relayer); si no, destino + importe exacto |
| Observador | pagos al destino | las firmas de la clave de referencia | el saldo de la dirección de depósito, MON nativo incluido (con relayer); si no, los logs `Transfer` del token |
| `amount` | opcional | opcional | opcional con relayer, obligatorio sin él |
| `msg` / `callback` | ambos | `msg` (`message` de Solana Pay) | ninguno |
| `txHash` para `validate` / `PATCH` | 64 hex | firma base58 | `0x` + 64 hex |

- **El memo sigue siendo la clave de idempotencia**, y `chain` es uno de los
  términos que una repetición debe igualar: el memo `42` en Stellar y el memo `42`
  en Solana son pagos distintos (`409 idempotency_conflict`). En Solana el memo
  además queda escrito on-chain por el programa SPL Memo.
- **Un token se resuelve contra la cadena antes de guardar la intención**: los
  decimales de un mint SPL (programa Token o Token-2022), el `decimals()` de un
  ERC-20. Una dirección que no lo es da `400 validation_failed`; un importe con más
  decimales de los que tiene el token, `400 invalid_amount`.
- **Un pago en Monad no lleva memo.** EIP-681 no tiene ningún campo que una wallet
  rellene con el id de la intención, así que una intención en Monad se reconoce por
  lo que paga: destino, token e importe exacto, en o después del bloque en que se
  creó. Dé **importes distintos** a las intenciones simultáneas hacia un mismo
  destino. Un pago en **MON nativo** no emite ningún log, así que el observador no
  puede encontrarlo: liquídelo con `POST /v1/payment-intents/{id}/validate` y el
  hash de la transacción. Los pagos ERC-20 los encuentra el observador,
  `MONAD_LOG_BLOCK_RANGE` bloques por llamada y cinco llamadas por intención y por
  ciclo, retomando donde se detuvo (`chainCursor`).
- **Direcciones de depósito (con `MONAD_RELAYER_PRIVATE_KEY`).** Cada intención
  en Monad recibe su propia dirección, y el enlace paga a ella en vez de al
  comercio: una dirección `CREATE2` de `contracts/PaymentForwarder.sol` a través del
  proxy de despliegue determinista (`0x4e59…956c`, presente en Monad mainnet y
  testnet), cuyo código de inicialización fija el comercio, el activo, el relayer y
  su comisión. La dirección es el compromiso —nadie, este servicio incluido, puede
  desplegar ahí código que pague a otro—, así que el servicio no tiene ninguna
  clave del dinero. El reenviador de depósitos vigila el saldo de la dirección (MON
  nativo incluido, sin necesidad de logs); cuando cubre la intención (cualquier
  importe por encima de la comisión, si es abierta), el relayer despliega el
  reenviador, cuyo constructor paga al relayer su comisión y el resto al comercio,
  y la intención se liquida con esa transacción. La comisión se fija al crear la
  intención y se muestra como `networkFee`: para MON, el presupuesto de gas del
  reenvío al precio actual más un 25 %; para un token, la entrada de
  `MONAD_DEPOSIT_TOKEN_FEES` del operador, o nada (el relayer absorbe el gas). Un
  importe que la comisión se comería es `400 invalid_amount`. Lo que llega después
  de que una intención expire o se cancele se reenvía igualmente al comercio, y el
  pagador puede liquidar antes con `validate` y su propio hash. La clave del relayer
  solo guarda dinero para gas: fondéela con moderación y ponga alertas de saldo. El
  bytecode está commiteado (`src/evm/payment-forwarder.artifact.ts`) y un spec
  recompila la fuente para compararlo; toda dirección de depósito depende de él, así
  que nunca lo cambie mientras direcciones antiguas puedan seguir recibiendo dinero.
- **Un nodo RPC se comprueba antes de confiar en él**: antes de su primera lectura
  de un nivel, el servicio compara el genesis hash del nodo (Solana) o su
  `eth_chainId` (Monad) con el de la cadena, y responde `503 misconfigured` cuando
  una URL de mainnet apunta a una red de pruebas. Los RPC públicos son los valores
  por defecto y tienen límites de tasa estrictos: en producción configure
  `SOLANA_RPC_URL_MAINNET` y `MONAD_RPC_URL_MAINNET` con los endpoints de un
  proveedor.
- **Los swaps, los pools de liquidez y DeFindex siguen siendo solo Stellar.**

```jsonc
// POST /v1/payment-intents/pay — USDC en Solana
{ "chain": "solana", "destination": "<base58>", "amount": "25.5",
  "assetCode": "USDC", "assetIssuer": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }
// response → { chain: "solana", uri: "solana:<base58>?amount=25.5&spl-token=…&reference=…&memo=…", chainReference, qr, … }
```

### Inicio de sesión de la wallet en Solana y Monad

`POST /v1/wallet/auth/finish` y `PUT /v1/wallet/backup` aceptan un `chain` opcional y
la cuenta como `address`; `stellarAddress` se sigue aceptando para Stellar, y se
sigue devolviendo junto a `chain` y `address`. El desafío que firma una cuenta de
Solana o Monad lleva una línea `chain: <chain>` tras la primera —una misma clave
ed25519 es a la vez dirección de Stellar y de Solana, y la línea impide que una
firma para una abra la otra— mientras que los desafíos de Stellar no cambian ni un
byte. Solana firma los bytes UTF-8 con ed25519 (`signMessage`; base64 o base58);
Monad con `personal_sign` de EIP-191 (hex con 0x; se rechazan las firmas high-s).
Una dirección de Monad se guarda en su grafía EIP-55. La configuración de
recuperación (`POST /v1/wallet/recovery/setup`) sigue siendo solo Stellar. Las keys
de la cuenta se emiten igual en todas las cadenas (ver
[Ninguna solicitud depende de la plataforma para desarrolladores](#ninguna-solicitud-depende-de-la-plataforma-para-desarrolladores)).

## La API key pública compartida

La wallet de código abierto incluye una API key que comparten todos, para que
cualquiera pueda hacer swaps, agregar liquidez o crear un enlace de pago sin
registrarse. Esas llamadas pagan la comisión del plan `community` (150 bps, la tarifa
más alta); registrarse permite obtener una menor. El gateway inyecta la tarifa
exactamente igual que para una key privada (ver `resolvePlanCommissionBps`).

La diferencia está en el aislamiento entre tenants. Todo llamante anónimo llega como el
mismo consumidor de APISIX, y los endpoints de lectura filtran las filas por
consumidor:

```ts
// swaps.service.ts
where: { id, consumer: { apisixUsername: consumer.username } }
```

Por lo tanto, `GET /v1/swaps` con la key pública devolvería el historial de swaps de
todos los usuarios anónimos. Los scopes no pueden evitarlo, porque todos tienen la
misma key — y `POST /v1/swaps/quote` requiere `swaps:read`, el mismo scope que lista
el historial.

**`PublicKeyGuard` es una allowlist.** El consumidor público es rechazado en toda ruta
que no tenga `@AllowPublicKey()`, por lo que las rutas nuevas le quedan cerradas por
defecto.

Accesible hoy con la key pública:

| Ruta | Por qué es seguro |
| --- | --- |
| `POST /v1/swaps/quote` | Cotiza un camino desde Horizon; es una función pura de la solicitud |
| `POST /v1/swaps` | Construye un envelope sin firmar que firma quien llama |
| `POST /v1/swaps/:id/submit` | Transmite un envelope firmado por quien llama — no se responde nada sobre el swap, ni siquiera su estado, hasta que el cuerpo sea el envelope de ese swap con al menos una firma; con límite de tasa |
| `POST /v1/liquidity-pools/deposit` \| `withdraw` | Construyen envelopes sin firmar |
| `POST /v1/liquidity-pools/operations/:id/submit` | Transmite un envelope firmado por quien llama, bajo las mismas verificaciones que el submit de swaps; con límite de tasa |
| `GET /v1/liquidity-pools` \| `/:poolId` \| `/positions` | Datos públicos on-chain leídos desde Horizon |
| `POST /v1/payment-intents/tx` \| `pay` | Construyen una intención SEP-7 a partir de la solicitud |
| `POST /v1/activity/events` | Ingesta de telemetría — ver más abajo |
| `GET /v1/assets` | El catálogo público de activos |
| `GET /v1/aliases/resolve/:name` \| `availability/:name` \| `by-address/:address` | Un pagador que resuelve un identificador es precisamente el llamante anónimo para el que existe esta key; la respuesta es una función pura de la solicitud y nunca incluye el buzón del propietario |

Rechazadas: `GET /v1/swaps`, `GET /v1/swaps/:id`,
`GET /v1/liquidity-pools/operations{,/:id}`, `GET /v1/activity/events`,
`GET /v1/activity/summary`, toda lectura de intenciones de pago, toda ruta de
propietario de alias (reclamar, listar, agregar o quitar una dirección, liberar,
recuperar), y todo lo que está bajo `/v1/kyc`, `/v1/onramp`, `/v1/offramp` y
`/v1/webhooks`. Una wallet sin cuenta lee su historial desde Horizon.

**La telemetría está permitida** para que sigan llegando los reportes de fallos de las
wallets sin cuenta. Los eventos que llegan con esta key son anónimos (un único
consumidor compartido), por lo que la wallet elimina dirección, destino, monto y
txHash antes de enviarlos.

El guard identifica al consumidor público por **cualquiera** de dos señales: el rol
reenviado (`X-Consumer-Role: public`) **o** el nombre de usuario de
`APISIX_PUBLIC_CONSUMER`. Definir ambas: si el gateway deja de reenviar roles, el
nombre de usuario sigue coincidiendo, y sin el nombre de usuario el guard depende solo
de un header.

**De dónde la obtiene un wallet.** `GET /v1/public-key?env=dev|prod` responde
`{ env, apiKey }` sin key y sin secreto del gateway (`@Public()`), a partir de
`PUBLIC_API_KEY_DEV` / `PUBLIC_API_KEY_PROD`; un entorno sin key responde
`503 misconfigured`. Rotar la key es cambiar esas variables — cada wallet toma la
nueva dentro de los 5 minutos de caché. La ruta de APISIX para este path NO debe
ejecutar `key-auth` (quien llama todavía no tiene key): sírvela desde la ruta sin
key, como `/v1/wallet/auth/oauth/callback/*`.

## Ninguna solicitud depende de la plataforma para desarrolladores

La plataforma para desarrolladores crea API keys para desarrolladores y muestra
datos. Nada de lo que hace un cliente pasa por ella: el wallet y cada integración
hablan con APISIX, y APISIX con este servicio. Antes no era así, y la plataforma —
la pieza que más se cae — se llevaba consigo cada inicio de sesión:

| Antes pasaba por la plataforma | Ahora |
| --- | --- |
| Enviar el código de inicio de sesión del wallet | Lo envía este servicio (`MAIL_FROM` + `MAIL_RESEND_API_KEY` / `MAIL_SMTP_*`) |
| Emitir las API keys de una cuenta de wallet al terminar el inicio de sesión | Las emite este servicio en APISIX (`APISIX_ADMIN_URL`, `APISIX_ADMIN_KEY`) |
| El código por email de un servidor de recuperación | Cada servidor de recuperación envía el suyo (`RECOVERY_EMAIL_CODES=true` + su propio `MAIL_*`) |
| La key pública compartida (`/api/public-key`) | `GET /v1/public-key` |
| El catálogo de activos y la telemetría anónima (`/api/assets`, `/api/telemetry`) | El wallet llama a `GET /v1/assets` y `POST /v1/activity/events` con la key pública |

Lo que la plataforma sigue haciendo es suyo: las keys de los desarrolladores, el
panel, y `/v1/admin`, al que ella llama — nunca al revés. Si está caída, nadie puede
crear una key de desarrollador ni abrir el panel; los wallets inician sesión, pagan
y hacen swaps como siempre.

**Keys de wallet.** Un inicio de sesión terminado recibe una key `dev` y una `prod`
bajo el consumidor `cosmos_wallet_<accountId>`, con los scopes, labels y el
forwarder de consumidor que antes generaba la plataforma (plan `community`, comisión
de swap `WALLET_KEY_SWAP_FEE_BPS`, 150 bps por defecto). Un segundo inicio de sesión
devuelve las keys que la cuenta ya tiene en lugar de emitir otro par.
`organizationId` en la respuesta es el id de la cuenta.

**La admin key es el costo de seguridad.** APISIX no tiene un permiso más acotado que
su admin key, que puede reescribir todas las rutas. El cliente de aquí solo escribe
consumidores bajo `cosmos_wallet_` y rechaza cualquier otro nombre antes de armar la
solicitud, pero esa es una promesa de este código, no de APISIX: trata
`APISIX_ADMIN_KEY` como `APISIX_GATEWAY_SECRET`, da a los pods de este servicio
acceso de red a la admin API y a nada más de ella, y nunca la definas en un servidor
de recuperación (el arranque lo rechaza).

**Las cuentas que la plataforma aprovisionó antes de este cambio** siguen funcionando
con las keys que tienen. En su próximo inicio de sesión reciben keys nuevas bajo
`cosmos_wallet_<accountId>`, un consumidor nuevo, así que el historial registrado bajo
el consumidor anterior (`cosmos_<platformUserId>`) no es visible con la key nueva.

## Swaps nativos de Stellar (path payments)

Stellar no tiene una operación de "swap" dedicada. El intercambio de activos se
realiza con un **`PathPaymentStrictSend`**, que Horizon enruta automáticamente a
través de la mejor combinación disponible de los **libros de órdenes del DEX de
Stellar** y los **pools de liquidez AMM**. Cosmos Pay lo envuelve en un flujo de swap
que, igual que las intenciones de pago, es **completamente no custodial** — los fondos
nunca pasan por el servicio. Este solo:

1. **Cotiza**, consultando la búsqueda de caminos strict-send de Horizon.
2. **Construye** la transacción sin firmar (un pago opcional de la comisión de la
   plataforma + el path payment) y devuelve su `xdr` + URI SEP-7 `tx` + QR.
3. **Retransmite** la transacción que el cliente firma en su propia wallet.

```
quote → build XDR → customer signs in wallet → POST /submit → Stellar executes
```

La red la determina el tipo de API key (prod → public, dev → testnet), igual que en
las intenciones de pago, y cada swap se **persiste** (tabla `swap`) y queda limitado
al consumidor que llama (`PENDING → SUBMITTED → SUCCEEDED/FAILED`).

**Comisión (por organización, aplicada del lado del servidor).** La comisión es **la
tarifa del plan de la organización que llama**, inyectada por el gateway como un
header de confianza (`X-Plan-Swap-Fee-Bps`) que la plataforma para desarrolladores
deriva del plan de la organización. **Nunca es un parámetro de la solicitud**, y
APISIX sobrescribe cualquier copia enviada por el cliente, por lo que la tarifa no
puede evadirse ni reducirse. La comisión se toma del **activo de origen** y se paga a
la wallet de la plataforma (`STELLAR_SWAP_FEE_WALLET`) como una primera operación de
pago; el **resto** se enruta a través del swap. Si corresponde una comisión de plan
pero no hay una wallet de la plataforma configurada, la creación del swap falla con
`503` (error de configuración del operador). `STELLAR_SWAP_FEE_BPS` es solo un
fallback para desarrollo local sin el gateway (y queda desactivado cuando no hay una
wallet definida).

**Slippage.** La estimación de la cotización, reducida en `slippageBps` (por defecto
`STELLAR_SWAP_SLIPPAGE_BPS`, con tope en `STELLAR_SWAP_MAX_SLIPPAGE_BPS`), se
convierte en el `destMin` on-chain del path payment — de modo que el swap **se
revierte** en lugar de entregar menos de lo que quien llama aceptó recibir.

**Trustline.** Un activo de destino no nativo ya debe tener una trustline en la cuenta
de destino; el paso de construcción lo verifica y, si no la tiene, devuelve un error
claro. (XLM no necesita trustline.)

**`POST /v1/swaps/quote`** — solo precio, no se persiste nada (`swaps:read`).

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

**`POST /v1/swaps`** — construye la transacción firmable (`swaps:write`). Recibe los
mismos campos más `source` (la cuenta que paga y firma); `destination` toma por
defecto el valor de `source` (un self-swap) y un `memo` opcional (MEMO_ID) se replica
on-chain.

**Idempotencia** opcional: enviar un header `Idempotency-Key` (preferido) o
`idempotencyKey` en el cuerpo. Un reintento con la misma key **y la misma solicitud**
— red, origen, destino, ambos activos, monto, slippage y memo — devuelve el swap
**existente** (`id` + `txHash`) en lugar de construir otra transacción. La misma key
con una solicitud diferente es `409 idempotency_conflict`, y el error no dice nada
sobre el swap almacenado. Los depósitos y retiros de liquidez siguen la misma regla,
comparando además el tipo de operación. Sin key, la restricción única
`(network, txHash)` igualmente rechaza una reconstrucción idéntica byte a byte con
**409** (colisión de secuencia / XDR). Cuando `STELLAR_SWAP_SINGLE_INFLIGHT=true`, un segundo swap
`PENDING` no expirado para el mismo `(consumer, source, network)` también devuelve
**409** indicando el id existente (por defecto **desactivado** — los swaps
concurrentes distintos desde una misma cuenta siguen estando permitidos). Solo
retiene ese guard un swap que **podría estar ya on-chain**: una fila cuyo número de
secuencia la cuenta todavía no usó no puede haberse liquidado, y el swap que se está
construyendo toma ese mismo número, así que como mucho uno de los dos podrá hacerlo.
Cualquiera puede indicar cualquier `source`, así que sin esa comprobación un solo swap
de polvo congelaba los swaps de la cuenta de un tercero durante toda una ventana de
expiración — y con la key pública compartida, tanto tiempo como el atacante lo
repitiera.

```jsonc
// response → { id, status: "PENDING", network, sendAmount, feeAmount, swapAmount,
//              destEstimated, destMin, path, xdr, uri: "web+stellar:tx?xdr=…", qr, txHash, … }
```

**Cotizar y construir también tienen límite**, por consumidor y dirección del
cliente: **60 cotizaciones por minuto** y **20 construcciones por minuto**, en buckets
separados del de submit. Una cotización no persiste nada y aun así cuesta una búsqueda
de ruta strict-send, la llamada más cara que este servicio le hace a Horizon — y ese
presupuesto por IP lo comparten swaps, liquidity pools e intenciones de pago por
igual, así que un precio consultado en bucle degradaba los tres a la vez para todos
los llamadores anónimos.

**`POST /v1/swaps/:id/submit`** — retransmite el envelope firmado (`swaps:write`).

```jsonc
// request
{ "signedXdr": "AAAAAgAAA…(signed base64 XDR)…" }
// response
{ "submitted": true, "status": "SUCCEEDED", "txHash": "…", "swap": { … } }
// on a network rejection → { "submitted": false, "status": "FAILED", "reason": "…", "resultCodes": ["op_under_dest_min"], "swap": { … } }
```

Antes de transmitirla, el servicio verifica que el hash de la transacción firmada
coincida con el de la que construyó, por lo que nunca retransmite una transacción
arbitraria. Un swap dispara los eventos de
webhook `SWAP_CREATED` / `SWAP_SUBMITTED` / `SWAP_SUCCEEDED` / `SWAP_FAILED` a través
del mismo dispatcher.

**El submit es estricto sobre lo que retransmite.** No se responde nada sobre el
swap — ni siquiera su estado — hasta que `signedXdr` se puede parsear, su hash
coincide con el `txHash` del swap y lleva al menos una firma, por lo que el `xdr`
sin firmar de la respuesta de creación es `400 validation_failed`. Un swap cuyo
envelope superó sus límites de tiempo (`STELLAR_TX_TIMEOUT`, 300 s por defecto) es
`400 invalid_state_transition` y no se transmite; si llegó a la red a tiempo, el
observador igual lo liquida. Tras un rechazo de la red, el mismo envelope puede
reenviarse como máximo **3** veces, y luego hay que construir un swap nuevo — un
reintento después de `503 provider_unavailable` no cuenta. La ruta permite **20
llamadas por minuto** por consumidor y dirección del cliente (`429 rate_limited`);
bajo la key pública compartida, cada wallet anónima es un solo consumidor, así que
las wallets detrás de un mismo NAT comparten ese cupo.
`POST /v1/liquidity-pools/operations/:id/submit` sigue las mismas reglas, con su
propio cupo, y `POST /v1/liquidity-pools/deposit` · `/withdraw` comparten un
presupuesto de **20 construcciones por minuto** — las dos direcciones de un mismo
flujo, así que buckets separados solo dejarían que un bucle las alternara y se llevara
ambos.

## Alias — identificadores de pago reclamables

Un alias permite que un pagador escriba `emanuel250` en lugar de `GA5ZSE…`. Los
pagadores confían en ese nombre justo antes de enviar dinero, por lo que las reglas de
abajo son estrictas: un error significa un pago a la cuenta equivocada.

### Se reclama demostrando el control de una clave, no pidiéndolo

```
wallet ──1. POST /v1/aliases/challenges {name, address, network} ──▶ nonce + the EXACT message to sign
wallet ──2. signs SHA-256(domain ‖ 0x00 ‖ uint32be(length) ‖ message) with that address's key
wallet ──3. POST /v1/aliases {name, email, nonce, signature} ────────▶ alias bound to the calling consumer
```

- **Firmar el mensaje exacto que devuelve el servicio.** No reconstruirlo en el
  cliente.
- **La firma cubre un digest etiquetado con un dominio, nunca una transacción.** Nada
  de lo que se firma en este flujo puede enviarse a la red, y el dominio
  (`Cosmos Pay alias claim v1`) es exclusivo de esta funcionalidad, por lo que una
  firma obtenida por otra dapp no puede usarse como reclamo.
- **El propósito está dentro de los bytes firmados** (`CLAIM`, `ADD_ADDRESS`,
  `RECOVER`), por lo que una firma obtenida para agregar una dirección no puede
  reutilizarse para completar una recuperación.
- **La dirección proviene del desafío, no del cuerpo del reclamo.** El reclamo no
  tiene campo de dirección, así que nadie puede firmar con una dirección y registrar
  otra.
- **Los desafíos son de un solo uso y duran cinco minutos.** La firma se verifica
  *antes* de consumir el desafío, por lo que una firma inválida no puede consumir el
  nonce de otra persona, y consumirlo es un compare-and-swap.
- **Una carrera se resuelve con el índice único sobre `alias.name`**, no con una
  verificación previa; el perdedor recibe `409 alias_taken`.

### Qué puede ser un identificador

`a-z` en minúsculas, `0-9` y `_` (nunca en los extremos), 3–32 caracteres, convertido
a minúsculas antes de decidir la unicidad. Sin Unicode: el conjunto de homoglifos no
tiene límite, y ninguna normalización hace seguro mostrar una `а` cirílica junto a un
monto. También se rechazan las palabras reservadas (`admin`, `support`, `cosmospay`,
`stellar`, …) y cualquier cosa que parezca una cuenta de Stellar (`g` o `m` seguida de
20 o más caracteres base32). La regla está en `src/aliases/alias-name.ts`.

### Muchas direcciones, un solo nombre

Un alias apunta a hasta 20 direcciones en distintas redes — un teléfono, una
computadora de escritorio, una cold wallet, testnet — con exactamente una principal
por red, garantizado por un índice único parcial. Agregar una dirección requiere
**dos** pruebas: que quien llama es propietario del alias, y que la nueva dirección
firma su propio desafío `ADD_ADDRESS`. La última dirección restante no puede
eliminarse (en su lugar, se libera el alias), y un consumidor puede tener como máximo
25 alias.

Un alias `SUSPENDED` (una retención impuesta por un operador) no resuelve a nada.

### La recuperación pasa por el correo electrónico y por la consola de la plataforma

Un reclamo registra un correo de recuperación para que perder una clave no signifique
perder el nombre. La recuperación funciona así:

1. La **consola de la plataforma** llama a `POST /v1/aliases/:name/recovery {email}`.
   La respuesta es idéntica coincidan o no el identificador y el buzón; si coinciden,
   incluye un token de un solo uso (30 minutos, almacenado solo como SHA-256), que la
   consola envía por correo. Este servicio no envía correos.
2. El usuario obtiene un desafío `RECOVER` para la nueva clave y llama a
   `POST /v1/aliases/:name/recovery/complete {token, address, network, nonce, signature}`
   con su propia API key. Se requieren ambas pruebas: el token demuestra el buzón y la
   firma demuestra la clave.
3. La propiedad pasa al consumidor que llama y **se eliminan todas las direcciones
   anteriores**, por lo que quien tenga las claves antiguas deja de recibir pagos.

El paso 1 es solo para la consola porque el token demuestra el control del buzón, así
que solo debe llegar a quien envía el correo. `ConsoleOnlyGuard` rechaza a todo
llamante con API key con `403 admin_console_only` antes de buscar el alias, y la ruta
no figura en el contrato publicado. Un alias suspendido no puede recuperarse.

Un token de recuperación puede presentarse **cinco** veces. Una presentación cuyo
desafío o firma falle igual consume un intento, y la sexta se rechaza; el
propietario puede iniciar otra recuperación. Un token que no coincide con ninguna
recuperación vigente de ese alias recibe el mismo `400 alias_recovery_invalid` y no
cambia nada, de modo que nadie puede agotar la recuperación de un propietario
enviando tokens al azar. `POST /v1/aliases/:name/recovery/complete` permite 10
llamadas y `POST /v1/aliases/challenges` 30 llamadas cada 10 minutos, por
consumidor y dirección del cliente (`429 rate_limited`).

`AliasChallengeSweeperService` elimina los desafíos y las recuperaciones expirados un
día después de su expiración (cada hora, una réplica por ciclo).

### Direcciones en Solana y Monad

Un alias puede apuntar a cuentas de Solana y Monad además de las de Stellar.
`POST /v1/aliases/challenges`, `POST /v1/aliases/{name}/addresses` y
`POST /v1/aliases/{name}/recovery/complete` aceptan un `chain` opcional; el mensaje
del desafío lleva entonces una línea `chain:`, que ata la firma a esa cadena.
Stellar sigue firmando el digest enmarcado; Solana firma el texto del desafío con
ed25519 y Monad con `personal_sign` de EIP-191. La dirección por defecto es por
cadena y red, así que añadir una dirección de Solana nunca degrada una de Stellar.
`GET /v1/aliases/resolve/{name}` resuelve en Stellar salvo que `?chain=` nombre otra
cadena —una wallet que no pide ninguna nunca recibe una dirección que no puede
pagar— y `GET /v1/aliases/by-address/{address}` deduce la cadena de la forma de la
propia dirección. Una dirección de Monad se guarda y se compara en su grafía EIP-55.

### Rutas

| Método | Ruta | Scope | Descripción |
| ------ | ---- | ----- | ----------- |
| GET | `/v1/aliases/resolve/:name` | `payments:read` · API key pública | Las direcciones a las que resuelve un alias (`?network=` filtra) |
| GET | `/v1/aliases/availability/:name` | `payments:read` · API key pública | Si un identificador puede reclamarse y, si no, por qué |
| GET | `/v1/aliases/by-address/:address` | `payments:read` · API key pública | Los alias que apuntan a una dirección |
| POST | `/v1/aliases/challenges` | `payments:write` | Un nonce y el mensaje exacto que debe firmarse |
| POST | `/v1/aliases` | `payments:write` | Reclamar un alias con una firma |
| GET | `/v1/aliases` | `payments:read` | Los alias de quien llama |
| POST | `/v1/aliases/:name/addresses` | `payments:write` | Agregar una dirección, firmada por esa dirección |
| DELETE | `/v1/aliases/:name/addresses/:addressId` | `payments:write` | Eliminar una dirección |
| DELETE | `/v1/aliases/:name` | `payments:write` | Liberar el alias |
| POST | `/v1/aliases/:name/recovery` | _solo consola de la plataforma_ | Iniciar una recuperación → un token para que la consola lo envíe por correo |
| POST | `/v1/aliases/:name/recovery/complete` | `payments:write` | Completar una recuperación con el token y la firma de la nueva clave |

## BlindPay — onramp / offramp / KYC (fiat ⇄ stablecoin)

> **Un plugin nativo.** Todo lo de esta sección es el plugin `blindpay`
> (`src/native-plugins/blindpay/`), que solo se sirve cuando `PLUGINS_ENABLED` lista
> `blindpay`; vea *Plugins nativos: BlindPay y DeFindex*. BlindPay liquida en
> Stellar, Solana, cadenas EVM (Ethereum, Base, Arbitrum, Polygon) y Tron;
> **Monad no es una red de BlindPay**, así que en ella no hay rampa fiat de entrada
> ni de salida.

Además de las intenciones de pago on-chain, el servicio integra
[BlindPay](https://www.blindpay.com/docs) para mover dinero entre **fiat y
stablecoins**: ingreso de dinero (**onramp / payin**), retiro de dinero (**offramp /
payout**) y el **KYC** obligatorio (los *receivers* de BlindPay) que respalda a ambos.
Se ejecuta **una instancia de BlindPay de la plataforma por entorno de API key** —
producción para las keys `prod` (`BLINDPAY_API_KEY` + `BLINDPAY_INSTANCE_ID`),
desarrollo para las keys `dev` (las variables `_DEV`); cada receiver/wallet/cuenta bancaria/payin/payout
se replica en el Postgres del servicio y **queda limitado al consumidor de APISIX que
llama**, por lo que cada integrador solo ve sus propios registros. El servicio **nunca
guarda claves de blockchain** — el offramp devuelve el artefacto a firmar (contrato
`approve` de EVM / XDR de Stellar) y acepta de vuelta la tx firmada, exactamente igual
que las intenciones de pago.

Los cambios de estado se sincronizan desde los **webhooks Svix** de BlindPay
(verificados sobre el cuerpo en crudo) y se **reemiten** a los propios endpoints de
webhook del integrador como nuevos tipos de evento (`RECEIVER_UPDATED`, `PAYIN_*`,
`PAYOUT_*`) a través del dispatcher existente.

| Método | Ruta                                                  | Scope          | Descripción |
| ------ | ----------------------------------------------------- | -------------- | ----------- |
| POST   | `/v1/kyc/receivers`                                   | `kyc:write`    | Crear un receiver (iniciar KYC/KYB) |
| GET    | `/v1/kyc/receivers` · `/:id`                          | `kyc:read`     | Listar / obtener (obtener actualiza el estado de KYC) |
| PATCH  | `/v1/kyc/receivers/:id`                               | `kyc:write`    | Actualizar un receiver (una vez en BlindPay, los campos de identidad requieren una key elevada) |
| DELETE | `/v1/kyc/receivers/:id`                               | `kyc:write`    | Eliminar un receiver |
| POST   | `/v1/kyc/upload`                                      | `kyc:write`    | Subir un documento de KYC → `file_url` |
| GET    | `/v1/kyc/rails` · `/v1/kyc/bank-details?rail=`        | `kyc:read`     | Catálogo de rails / campos requeridos |
| POST   | `/v1/kyc/receivers/:id/wallets`                       | `kyc:write`    | Registrar una wallet de blockchain |
| GET    | `/v1/kyc/receivers/:id/wallets/sign-message`          | `kyc:read`     | Mensaje a firmar (flujo EOA seguro) |
| POST   | `/v1/kyc/receivers/:id/bank-accounts`                 | `kyc:write`    | Agregar una cuenta bancaria fiat (cualquier rail) |
| POST   | `/v1/onramp/quotes`                                   | `onramp:write` | Cotizar un payin (expira en ~5 min) |
| POST   | `/v1/onramp/payins`                                   | `onramp:write` | Crear un payin → instrucciones de fondeo |
| GET    | `/v1/onramp/payins` · `/:id`                          | `onramp:read`  | Listar / obtener (obtener actualiza el estado) |
| POST   | `/v1/onramp/trustline`                                | `onramp:write` | Construir un XDR de trustline de Stellar sin firmar |
| POST   | `/v1/onramp/receivers/:id/virtual-accounts`           | `onramp:write` | Crear una cuenta virtual |
| POST   | `/v1/offramp/quotes`                                  | `offramp:write`| Cotizar un payout (EVM → contrato `approve`) |
| POST   | `/v1/offramp/payouts/authorize`                       | `offramp:write`| Construir la tx de payout de Stellar/Solana sin firmar |
| POST   | `/v1/offramp/payouts`                                 | `offramp:write`| Crear un payout a partir de una cotización |
| GET    | `/v1/offramp/payouts` · `/:id`                        | `offramp:read` | Listar / obtener (obtener actualiza el estado) |
| POST   | `/v1/offramp/payouts/:id/documents`                   | `offramp:write`| Adjuntar un documento de cumplimiento normativo |
| POST   | `/v1/blindpay/webhooks`                               | _público_      | Webhook entrante de BlindPay (Svix) |

Los montos son **enteros en unidades menores** (p. ej., `$123.45` → `12345`).
Configurar el webhook del dashboard de BlindPay hacia `<gateway>/v1/blindpay/webhooks`
y establecer `BLINDPAY_WEBHOOK_SECRET` con el secreto de firma de ese endpoint — el
valor `whsec_…` completo. El arranque falla cuando su clave decodifica a menos de
24 bytes, y el verificador rechaza esa clave de todos modos: un base64 inválido
decodifica a una clave vacía, y cualquiera puede firmar con eso. Dejar
vacías las variables `BLINDPAY_*` desactiva la funcionalidad: esas rutas devuelven
entonces `503` `misconfigured`, igual que el webhook entrante mientras
`BLINDPAY_WEBHOOK_SECRET` no esté definido. Ver `.env.example`.

**Una key `dev` nunca llega a la instancia de producción.** El entorno de la key elige
la instancia de BlindPay igual que elige la red de Stellar, y cada fila espejada
registra la instancia de la que viene, así que las keys `dev` y `prod` de un tenant
— un mismo consumidor — ven receivers, wallets, cuentas bancarias, cotizaciones,
payins y payouts separados. Sin instancia de desarrollo configurada, las rutas de
BlindPay responden `503` `misconfigured` a las keys `dev`. Apuntar los webhooks del
dashboard de ambas instancias al mismo `<gateway>/v1/blindpay/webhooks` y establecer
`BLINDPAY_WEBHOOK_SECRET_DEV` para la de desarrollo: el secreto con el que verifica
una entrega es lo que dice qué instancia la envió.

**La identidad se revisa antes de llegar a BlindPay, también en las ediciones.** Hasta
que un receiver se habilita, un `PATCH` que toca datos de KYC lo devuelve a
`pending_review`. Una vez que existe en BlindPay, una key de tenant solo puede cambiar
`external_id` e `image_url`; cualquier otro campo es `403` `kyc_review_required` salvo
que la key sea elevada (`X-Consumer-Role: admin`), porque ese `PUT` reescribe la
identidad directamente en el proveedor.

**Una aprobación queda fijada al expediente que se revisó.** La lectura de un receiver
incluye `dossierVersion`, que cuenta cada edición de los datos de KYC enviados.
Devuélvelo como `expected_version` al aprobar y un expediente que cambió desde que lo
leíste es `409 kyc_state_invalid` en lugar de la aprobación de datos que nadie vio —
una edición deja el estado en `pending_review`, así que la aprobación por sí sola no
podía notarlo. Lo aprobado queda como `reviewedVersion`, y
`POST /v1/kyc/receivers/:id/enable` se niega a crear el receiver en BlindPay mientras
los dos difieran.

**Las rutas de fiat tienen presupuestos.** Cada escritura que el proveedor conserva
está limitada por consumidor y dirección del cliente, y toda ruta respaldada por
BlindPay cuenta además contra un techo por consumidor de **60 solicitudes al proveedor
por minuto**: una sola instancia atiende a todos los tenants de la key, así que un
tenant en bucle sobre las cotizaciones hace fallar los payins de los demás. Pasarse es
`429 rate_limited` con `Retry-After`.

| Ruta | Presupuesto (por consumidor + dirección del cliente) |
| ---- | --------------------------------------------------- |
| `POST /v1/kyc/upload` | 20 cada 10 min |
| `POST /v1/kyc/terms-of-service` | 10 cada 10 min |
| `POST /v1/onramp/quotes` · `POST /v1/offramp/quotes` | 30 por minuto, buckets separados |
| `POST /v1/onramp/payins` | 10 por minuto |
| `POST /v1/offramp/payouts/authorize` · `POST /v1/offramp/payouts` | 10 por minuto, compartido |
| `POST /v1/offramp/payouts/:id/documents` | 20 cada 10 min |
| `POST /v1/onramp/trustline` | 20 por minuto |

### Las URL de redirección de KYC se validan contra una lista de permitidos por consumidor

El flujo de términos de servicio envía al usuario a BlindPay y luego de vuelta a una
`redirect_url` que proporciona el integrador. Para evitar una redirección abierta, cada
`redirect_url` pasa por dos verificaciones:

| Capa | Regla | Dónde |
| ---- | ----- | ----- |
| Forma | una URL `https` absoluta sin credenciales incrustadas (`user:pass@`), sin fragmento (`#…`) y sin barra invertida, espacios ni caracteres de control | `@IsRedirectUrl()` en cada DTO que incluye una, y de nuevo en la capa de servicio |
| Host | en la lista de permitidos **del consumidor que llama** — el host exacto, o un subdominio en un límite de etiqueta (`app.acme.com` coincide con `acme.com`; `evilacme.com` no) | `KYC_REDIRECT_URL_WHITELIST`, aplicada en la capa de servicio |

```
KYC_REDIRECT_URL_WHITELIST={"cosmos_acme":["acme.com","app.acme.com"]}
```

Las reglas de forma son lo que hace valiosa la verificación del host. Una barra
invertida se lee como `/` dentro de la parte de autoridad para un parser WHATWG y como
parte del userinfo para otros, así que `https://app.acme.com\@evil.test` tiene dos
lecturas honestas y este servicio no es el último en leerla — el valor va a BlindPay,
vuelve en una página alojada y termina en un navegador. Los espacios y los caracteres
de control son la misma categoría, un fragmento se traga el `?tos_id=` que añade el
proveedor, y las credenciales mueven el host al otro lado del `@`.

**Falla en modo cerrado**: un consumidor sin entrada no puede usar ninguna
redirección, y un host con un punto al final o en forma IDN se rechaza en lugar de
normalizarse. Cada ruta que recibe una `redirect_url` la verifica, incluida la
aprobación desde administración, que usa la lista del consumidor al que pertenece el
receiver. Un esquema o un host rechazado es un `400`.

## Plugins — extensiones bajo un slug

Otros equipos integran su tecnología en este servicio como un **plugin**: una carpeta
en `plugins/`, servida en `/v1/plugins/<slug>/…`, que trabaja con los clientes,
productos e intents de pago de un tenant sin tocar nunca el core directamente. El
objetivo es que un plugin pueda estar mal —con bugs, lento, voraz— sin que el core
quede mal con él.

### Un plugin es una carpeta

Todos los plugins viven en **una sola carpeta**, `plugins/` en la raíz del
repositorio: los que distribuye soporte de Cosmos Pay y los que instala un operador.
Un plugin son tres archivos legibles, y ninguno corre hasta que su slug esté en
`PLUGINS_ENABLED`:

```
plugins/
  README.md
  example/
    plugin.json       what the plugin is, and what it may touch
    index.ts          what it does — plain TypeScript, no build step
    signature.json    who vouches for the two files above
```

`plugin.json` dice qué es el plugin y qué puede tocar; es lo primero que lee un revisor y un tenant:

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

`index.ts` es el código: TypeScript normal, transpilado al arrancar el servicio. Su único import es el SDK (`@/plugins/sdk`):

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

`example` viene preinstalado y desactivado: un plugin de referencia que usa una query,
un command, un evento y un ajuste del tenant. Empieza por ahí.

### Escribir uno

```sh
npm run plugins -- new my-plugin          # plugins/my-plugin/ from a template
npm run plugins -- check my-plugin        # compile, load and validate it
PLUGINS_ENABLED=my-plugin PLUGINS_ALLOW_UNSIGNED=true npm run start:dev
npm run plugins -- sign my-plugin --key support.pem --key-id cosmos-support
```

`check` compila el plugin y corre todas las validaciones que hace el servidor al
arrancar. `PLUGINS_ALLOW_UNSIGNED=true` lo deja correr sin firma mientras trabajas en
local, y se rechaza cuando `NODE_ENV=production`. Abre un pull request con la carpeta;
una vez revisado, soporte lo firma y se distribuye preinstalado.

Firmar nunca ejecuta el código del plugin —solo lo hace `check`, y la CI lo corre en
cada pull request—, así que un pull request no puede lograr que su código se ejecute en
la máquina que guarda la clave de soporte. Firma lo que ya pasó la revisión y la CI.

### Qué puede y qué no puede alcanzar un plugin

Los handlers de un plugin reciben un `PluginContext` y nada más: ni Prisma, ni
providers de Nest, ni `process.env`, ni sockets:

| `ctx.` | Alcanza | Limitado por |
| ------ | ------- | ------------ |
| `storage` | los registros propios del plugin (`plugin_record`), solo de esta instalación | 16 KiB por valor, 10 000 registros por instalación |
| `core.customers`, `core.products` | listar / leer / crear / actualizar, a través de los servicios y DTOs del propio core | la capacidad concedida (`customers:read`, `customers:write`, …); no existe borrar |
| `core.paymentIntents` | listar / leer, solo lectura | `payment_intents:read`; nada que firme o mueva dinero |
| `http` | HTTPS en el puerto 443 a los hosts de `egress` | solo direcciones públicas (las reglas SSRF de los webhooks), socket fijado a la dirección verificada, sin redirecciones, respuestas de 1 MiB |
| `installation.config` | los ajustes del tenant; los secretos, descifrados solo para esta llamada | — |

Lo que el runtime garantiza en cada invocación:

- **Aislamiento entre tenants.** El contexto se construye a partir del consumer que
  llama y de su instalación; ningún método recibe un id de consumer o de instalación.
- **Proyecciones, no filas.** Las lecturas del core llegan como una proyección fija
  —sin `consumerId`, sin `xdr`/`uri`, sin payloads de proveedores—, copiadas y
  congeladas.
- **La validación del core sigue aplicando.** Las escrituras pasan por los mismos DTOs
  que validan las rutas HTTP; los campos desconocidos se rechazan.
- **Las queries no pueden escribir.** Una query se puede llamar con `plugins:read`, así
  que dentro de ella toda escritura de storage o del core se rechaza.
- **Presupuestos.** 10 s por invocación, 200 llamadas al contexto, 64 KiB de entrada,
  256 KiB de salida. Cuando se acaba el tiempo, quien llama recibe `504 plugin_failed`
  y el contexto se revoca, así que el trabajo que quedó corriendo no puede escribir
  después.
- **Los fallos quedan contenidos.** Un `PluginError` es `400 plugin_rejected` con su
  mensaje; cualquier otra cosa es `502 plugin_failed`, registrada y nunca devuelta. Un
  plugin que falla con un evento no afecta el webhook de ese evento ni a otros plugins.
- **Aislamiento.** El código de un plugin nunca corre en este proceso. Cada
  invocación recibe un isolate de V8 nuevo (`isolated-vm`) sin nada de Node dentro
  —sin `process`, `require`, red, sistema de archivos ni timers—, un heap de 32 MB y un
  hilo propio. Su única salida es un puente que acepta los nombres de los métodos del
  contexto de arriba, con copias JSON de ida y vuelta; ningún objeto de este proceso
  llega nunca a él, así que el código escrito para escapar no encuentra de dónde
  trepar. Cuando se agota el presupuesto el isolate se destruye, lo que detiene al
  plugin donde esté —un bucle síncrono incluido— y nada de lo que guardó en memoria
  sobrevive a la siguiente llamada, tampoco la de otro tenant. Además, ESLint solo
  deja que `plugins/**/*.ts` importe el SDK.

### Quién responde por un plugin

Un plugin solo corre si una clave de confianza firmó exactamente su `plugin.json` y su
`index.ts` con su slug y su versión (`signature.json`). Si cambia un carácter del código
o una capacidad, la firma falla y el arranque se detiene. El formato de `plugin.json` y
los finales de línea no cuentan como cambios.

- **Preinstalado por soporte.** Las claves públicas de soporte están en el código
  (`PLUGIN_SUPPORT_KEYS`), así que un plugin firmado por soporte y versionado en
  `plugins/` carga en cualquier despliegue sin configuración. `plugins/` está en
  `.github/CODEOWNERS`, y la CI comprueba que cada carpeta esté firmada y sea válida.
- **Instalado a mano.** Todo lo demás se instala desde un registry —cualquier host HTTPS
  estático— y debe estar firmado por soporte o por una clave de `PLUGINS_TRUSTED_KEYS`:

```sh
npm run plugins -- install acme@1.0.0 --registry https://plugins.example.com
# then add "acme" to PLUGINS_ENABLED and restart
```

El registry no es de confianza: `install` verifica la firma antes de escribir nada, y
el servidor la vuelve a verificar en cada arranque.

### Instalar es dar consentimiento

Un plugin corre para un tenant solo después de que ese tenant lo instala con
`PUT /v1/plugins/{slug}/installation`, enviando `grantCapabilities` igual a la lista de
`plugin.json`: ni un subconjunto ni un superconjunto (`400 plugin_consent_mismatch`).
Si una versión posterior declara más, la instalación conserva su consentimiento anterior
y cada acción responde `409 plugin_not_installed` hasta que el tenant lo instale de nuevo
(`installation.pendingCapabilities` muestra la diferencia). Desinstalar borra todos los
registros que el plugin guardó para ese tenant. Los ajustes marcados como `secret` se
sellan con `PLUGINS_SECRET` y nunca se devuelven.

### Rutas de plugins

| Método | Ruta | Propósito |
| ------ | ---- | --------- |
| GET | `/v1/plugins` | Los plugins que sirve este despliegue, con las instalaciones de quien llama |
| GET | `/v1/plugins/{slug}` | Un plugin: capacidades, egress, ajustes, acciones, instalación |
| PUT | `/v1/plugins/{slug}/installation` | Instalar, volver a consentir o reconfigurar |
| DELETE | `/v1/plugins/{slug}/installation` | Desinstalar, borrando los registros del plugin |
| POST | `/v1/plugins/{slug}/queries/{action}` | Ejecutar una acción de solo lectura (`plugins:read`) |
| POST | `/v1/plugins/{slug}/commands/{action}` | Ejecutar una acción que escribe (`plugins:write`) |

Ninguna ruta de plugins admite la API key pública compartida: un plugin actúa sobre los
datos de un solo tenant. Las dos rutas de acciones comparten un presupuesto de 120
solicitudes por minuto por consumer.

### Plugins nativos: BlindPay y DeFindex

Algunas integraciones no son la cadena en sí —un proveedor fiat, un protocolo DeFi— y
necesitan lo que el sandbox niega a propósito: tablas propias, webhooks entrantes,
credenciales de todo el despliegue. Son **plugins nativos**: módulos de Nest
compilados en el servicio bajo `src/native-plugins/<slug>/`, que se activan con la
misma lista `PLUGINS_ENABLED` que los plugins aislados.

| Slug | Qué sirve |
| ---- | --------- |
| `blindpay` | KYC, onramp, offramp, el webhook de BlindPay, sus rutas de `/v1/admin` (`receivers`, `payins`, `payouts`) y la sección `fiat` del resumen de administración |
| `defindex` | `/v1/defindex`: vaults de DeFindex en Stellar |

- **Si no está en la lista, no existe.** Un plugin nativo que `PLUGINS_ENABLED` no
  nombra nunca se instancia: sus rutas responden 404, sus tareas nunca arrancan y
  sus variables no se validan. El arranque avisa cuando sus claves están
  configuradas pero su slug no.
- **El núcleo nunca importa un plugin.** El lint rechaza `@/native-plugins/*` en
  cualquier parte de `src/` salvo `src/native-plugins/native-plugins.module.ts`, y
  rechaza que un plugin importe a otro. Donde el núcleo necesita datos de un plugin
  —la vista general de administración— expone un punto de extensión
  (`AdminExtensions`) en el que el plugin se registra.
- **Ni aislado ni por inquilino.** Un plugin nativo es código revisado con los
  privilegios del núcleo; no se instala por inquilino, y sus rutas conservan sus
  propios scopes (`kyc:*`, `onramp:*`, `offramp:*`, `liquidity:*`). Un plugin
  aislado no puede tomar un slug nativo.
- **El contrato OpenAPI documenta las rutas de todos los plugins nativos**, estén
  activados o no: `openapi:generate` los activa todos.

## Actualización — cambios incompatibles y notas de despliegue

### La plataforma para desarrolladores sale del camino de las solicitudes

- **Variables eliminadas:** `WALLET_AUTH_CONSOLE_URL`, `WALLET_AUTH_CONSOLE_SECRET`,
  `RECOVERY_EMAIL_DELIVERY_URL`, `RECOVERY_EMAIL_DELIVERY_SECRET`. Se ignoran.
- **La puerta de email ahora necesita** `MAIL_FROM` + `MAIL_RESEND_API_KEY` / `MAIL_SMTP_*` (un
  remitente verificado en Resend) **y** `APISIX_ADMIN_URL` + `APISIX_ADMIN_KEY`. Sin
  ambos, `GET /v1/wallet/auth/providers` informa `email: false`; un inicio de sesión
  con proveedor completa igual el callback, pero `POST /v1/wallet/auth/finish`
  responde `503 misconfigured` hasta que el par admin esté definido. Cada par se
  define junto o el arranque lo rechaza.
- **Un servidor de recuperación que enviaba códigos por email** define
  `RECOVERY_EMAIL_CODES=true` y su propio `MAIL_*`. `APISIX_ADMIN_KEY` en un servidor
  de recuperación impide el arranque.
- **Nueva ruta `GET /v1/public-key`** (`@Public()`), alimentada por
  `PUBLIC_API_KEY_DEV` / `PUBLIC_API_KEY_PROD`: copia los valores que la plataforma
  emitió para la key pública. Agrega el path a la ruta sin key de APISIX (sin
  `key-auth`), o los wallets reciben `401`.
- **Las keys de wallet viven ahora bajo `cosmos_wallet_<accountId>`**; ver la sección
  de arriba para las cuentas que aprovisionó la plataforma. Las formas de respuesta
  no cambian.
- **`POST /v1/wallet/auth/finish` sin `backup`** conecta el wallet que firma a la cuenta y devuelve sus keys: ya no responde `backup_conflict` cuando la cuenta respalda otro wallet, y ya no mueve el `address` de la cuenta. Con `backup` no cambió nada. Así se conecta ahora a Cosmos Pay un wallet importado desde una semilla.
- **Sin migración.**

### Solana y Monad; BlindPay y DeFindex pasan a ser plugins nativos

- **La migración `20260930120000_multichain`** añade `chain` (por defecto
  `stellar`) a `payment_intent`, `alias_address`, `alias_challenge`,
  `wallet_account` y `wallet_backup`, más `assetDecimals`, `chainReference` y
  `chainCursor` a `payment_intent`, y amplía el índice único de direcciones de
  alias a `(aliasId, chain, network, address)`. Toda fila existente sigue siendo
  Stellar; no se reescribe nada.
- **BlindPay (KYC, onramp, offramp) y DeFindex solo se sirven cuando
  `PLUGINS_ENABLED` lista `blindpay` / `defindex`.** Un despliegue que tenía sus
  claves configuradas y no añade los slugs pierde `/v1/kyc`, `/v1/onramp`,
  `/v1/offramp`, `/v1/blindpay/webhooks`, `/v1/defindex` y las rutas de BlindPay en
  `/v1/admin` (404), y el arranque registra un aviso con el slug. Configure por
  ejemplo `PLUGINS_ENABLED=blindpay,defindex` antes de desplegar. Por lo demás,
  rutas, scopes, tablas y respuestas no cambian.
- **Las variables de BlindPay se comprueban cuando arranca el plugin**, no en la
  validación del entorno: una instancia a medio configurar sigue impidiendo el
  arranque, pero solo donde `blindpay` está activado.
- **`GET /v1/admin/summary` incluye `fiat` solo con `blindpay` activado**, y
  `GET /v1/admin/consumers` cuenta `blindpayReceivers`, `payins` y `payouts` solo
  entonces. El `volume` del resumen etiqueta una fila de Solana o Monad como
  `<chain>:<asset>`.
- **Campos nuevos en las respuestas** (aditivos): `chain` y `chainReference` en las
  intenciones de pago; `chain` en las direcciones de alias, las resoluciones y las
  filas de by-address; `chain` y `address` en las copias de seguridad de la wallet,
  junto a `stellarAddress`; `chain` en las filas `volume`, `recent` y de saldos del
  panel, que ahora se agrupan por cadena: SOL y MON ya no se suman a XLM.
- **`txHash` acepta la forma de cualquier cadena** en `validate` y `PATCH`, y se
  comprueba contra la cadena de la intención (si no, `400 validation_failed`). Solo
  el hex se pasa a minúsculas; una firma de Solana se guarda tal como llega.
- **La resolución de alias sin `?chain=` devuelve solo direcciones de Stellar.**
- **Variables nuevas**, todas opcionales (RPC públicos por defecto):
  `SOLANA_RPC_URL_MAINNET`, `SOLANA_RPC_URL_DEVNET`, `SOLANA_RPC_TIMEOUT_MS`,
  `MONAD_RPC_URL_MAINNET`, `MONAD_RPC_URL_TESTNET`, `MONAD_RPC_TIMEOUT_MS`,
  `MONAD_LOG_BLOCK_RANGE`. El observador ahora también consulta Solana y Monad para
  las intenciones pendientes en esas cadenas.
- **`/wallet/console/provision` de la plataforma de desarrollo** recibe ahora
  `chain` y `address`, y `stellarAddress: null` en un inicio de sesión de Solana o
  Monad; debe aceptarlo antes de que las wallets ofrezcan esas cadenas.
- **Las direcciones de depósito de Monad** solo se activan con
  `MONAD_RELAYER_PRIVATE_KEY`; la migración también crea `evm_deposit_address`, y
  las intenciones ganan `networkFee`. Sin la clave, las intenciones en Monad se
  comportan como antes (pagando directamente al comercio).
- **Sin cambios en APISIX.**

### Plugins: un módulo nuevo, dos tablas nuevas y dos scopes nuevos

`/v1/plugins` es nuevo; ninguna ruta ni respuesta existente cambió. Al desplegar:

- **La migración `20260929120000_plugins`** crea `plugin_installation` y
  `plugin_record`. Ninguna tabla del core cambia.
- **Los scopes `plugins:read` y `plugins:write` son nuevos.** Las keys existentes no los
  tienen y reciben `insufficient_scope`; concédelos desde la plataforma para
  desarrolladores.
- **Nada corre hasta que `PLUGINS_ENABLED` liste un plugin**, y entonces solo para los
  tenants que lo instalaron. `plugins/example` viene preinstalado y desactivado.
- **`typescript` ahora es dependencia de runtime**: el `index.ts` de los plugins se
  transpila al arrancar. No lo quites de las instalaciones de producción.
- **Define `PLUGINS_SECRET`** antes de habilitar un plugin con ajustes secretos: de lo
  contrario el arranque se niega. `PLUGINS_TRUSTED_KEYS` añade firmantes además de los
  de soporte.
- **Despliega la carpeta `plugins/` junto con el build.** Se lee desde el directorio
  de trabajo al arrancar, al lado de `dist/`; un despliegue que solo copia `dist/` y
  `node_modules/` no sirve ningún plugin, y uno habilitado detiene el arranque.
- **Node debe correr con `--no-node-snapshot` cuando hay un plugin habilitado**: el
  sandbox (`isolated-vm`, un módulo nativo) lo requiere, y si falta el arranque se
  niega. Todos los scripts de npm lo pasan (`start`, `start:prod`, `test`, …); un
  proceso iniciado de otra forma lo necesita en el comando o en `NODE_OPTIONS`.
- **Sin cambios en APISIX:** la ruta comodín ya reenvía `/v1/plugins`.
- **Códigos de error nuevos:** `plugin_not_installed`, `plugin_consent_mismatch`,
  `plugin_rejected`, `plugin_quota_exceeded`, `plugin_failed`.

### Pollar se eliminó

Todo lo que había bajo `/v1/pollar` desapareció — el bridge OAuth (`/v1/pollar/oauth/*`), el
aprovisionamiento de wallets y trustlines (`/v1/pollar/wallets/*`) y `/v1/pollar/users` — junto
con los códigos de error `pollar_identity_required`, `pollar_identity_mismatch` y
`elevated_key_required`, y todas las variables `POLLAR_*`. Esas rutas ahora responden `404`.

- **La migración `20260927120000_remove_pollar`** elimina `pollar_oauth_session` y
  `pollar_user_wallet`. No se puede deshacer: si necesitás ese historial, respaldá las dos
  tablas antes.
- **Borrá las rutas de APISIX para `/v1/pollar/*`**, en especial la del callback sin
  key-auth, y quitá las variables `POLLAR_*` — se ignoran.
- **Las keys pueden seguir teniendo scopes `pollar:*`.** Ya nada los comprueba.
- **Los ids de advisory lock `881_005` y `881_007` quedan retirados** y no se reutilizan.
- **Wallets:** Cosmos Wallet quita cualquier wallet de Pollar del dispositivo la próxima vez
  que arranca. Los fondos siguen en Pollar, en la misma dirección.

### Correcciones de la revisión de seguridad

La mayoría no cambia nada para un llamante que se comporta correctamente; revisar la
columna "Quién lo nota" antes de desplegar.

| Cambio | Quién lo nota | Por qué |
| ------ | ------------- | ------- |
| `POST /v1/aliases/:name/recovery` es **solo para la consola de la plataforma**: una API key recibe `403 admin_console_only`, y la ruta salió del contrato publicado | Quien iniciaba recuperaciones con una API key | La respuesta incluye el token de recuperación, que demuestra el control del buzón del propietario |
| Completar una recuperación sobre un alias `SUSPENDED` es un `404` | Nadie legítimo | Un token emitido antes de una suspensión podía saltarse la retención impuesta por el operador |
| Las rutas `@Public()` (webhook de BlindPay, health) ignoran `X-Consumer-Username` | Dashboards: esas solicitudes ahora se registran como anónimas | Esas rutas no tienen key-auth, así que el header lo ponía el cliente |
| Los rechazos de `AdminGuard` y `ConsoleOnlyGuard` se registran en nivel `warn` | Operadores | Los guards se ejecutan antes del log de acceso, así que las solicitudes rechazadas no dejaban rastro |
| Ambas rutas `POST …/trustlines` comparten un presupuesto de `429` de 20 llamadas cada 10 minutos | Scripts que agregan trustlines de forma masiva | Cada trustline inmoviliza 0.5 XLM de la wallet de fondeo del operador |
| `GET /v1/offramp/payouts/:id` ya no devuelve `raw`, `consumerId`, `receiverId`, `quoteId`, `bankAccountId` ni `updatedAt`; la respuesta de creación de una cuenta virtual ya no devuelve `raw`, `receiverId`, `consumerId` ni `updatedAt` | Quienes leen esos campos | `raw` es el objeto almacenado de BlindPay, con datos bancarios y del beneficiario |
| `POST /v1/kyc/upload` devuelve `400` ante más de 4 campos de texto, un campo de más de 1 KiB, un segundo archivo, o bytes de archivo que no coinciden con el tipo declarado | Nadie que envíe una carga bien formada | Los campos no tenían límite y la verificación de tipo confiaba en el `Content-Type` del cliente |
| `POST /v1/payment-intents/tx` y `/pay`: el mismo memo con cualquier término diferente es `409 idempotency_conflict`. Un reintento idéntico sigue devolviendo la intención almacenada (`2` y `2.0` son el mismo monto) | Quienes reutilizan un mismo memo para pagos distintos | Con la API key pública compartida, un memo que otra persona creó primero devolvía su intención |
| `POST /v1/payment-intents/:id/validate` marca `FAILED` solo ante una tx fallida que sea el pago propio de esta intención; cualquier otra tx fallida es `valid: false` con el estado sin cambios. Una tx que se cerró más de 60 s antes de crearse la intención se rechaza ("Transaction predates this payment intent") — en validate, en `PATCH {status: SUCCEEDED}` y en el observador | Nadie legítimo | Cualquier transacción fallida podía hacer fallar una intención, y un pago antiguo con los mismos términos podía liquidar una nueva |
| `PATCH /v1/payment-intents/:id` que cambia `txHash` en una intención en estado terminal es `400 invalid_state_transition`; un cambio de estado que compite con esa escritura es `409 operation_in_flight` | Nadie legítimo | Podía reescribir la evidencia de liquidación de una intención `SUCCEEDED` |
| El observador de intenciones de pago concilia como máximo 10 intenciones por consumidor en cada ciclo y nunca recorre filas expiradas | Operadores que monitorean el throughput del observador | Un solo consumidor podía retrasar la liquidación de todos los demás tenants |
| `POST /v1/swaps`, `/v1/liquidity-pools/deposit` y `/withdraw`: un `Idempotency-Key` reutilizado con una solicitud diferente — otro memo u otro slippage, la otra red, o una key de depósito reutilizada para un retiro — es `409 idempotency_conflict`. Un replay con un activo, slippage o memo inválido ahora recibe el `400` normal | Clientes que reutilizan una misma key para operaciones distintas | Con la API key pública compartida, alguien podía crear de antemano un envelope bajo una key adivinable y hacer que se devolviera al reintento de otro usuario |
| `POST /v1/liquidity-pools/withdraw` ya no responde `409 operation_in_flight` ante un retiro en curso cuyo número de secuencia la cuenta todavía no usó (un envelope sin firmar o abandonado) | Usuarios de wallets que quedaban bloqueados | Un envelope construido para la cuenta de otra persona podía bloquear indefinidamente los retiros de esa posición |
| El observador de liquidaciones toma como máximo 10 filas por consumidor por tabla en cada ciclo, y `GET /v1/liquidity-pools/positions` lee Horizon mediante un único listado paginado en lugar de una solicitud por pool | Operadores | Un solo consumidor podía retrasar la liquidación de todos los demás, y muchas participaciones en pools implicaban llamadas a Horizon sin límite |
| `GET /v1/onramp/payins/:id` ya no devuelve `receiverId` ni `updatedAt` — la misma forma que devuelve `GET /v1/onramp/payins` | Quien lea esos dos campos en la lectura de un solo payin | El mismo payin podía llegar con dos formas distintas |
| `POST /v1/kyc/upload` con un archivo de más de 10 MiB es `413` con `code: "payload_too_large"`; antes era `internal_error` | Integradores que ramifican según `code` | Es un límite del lado del cliente, no un error del servidor |
| `POST /v1/liquidity-pools/deposit`, `/withdraw`, `GET /v1/liquidity-pools/operations`, `/operations/:id`, `POST /v1/liquidity-pools/operations/:id/submit` y los webhooks `LIQUIDITY_*` ahora incluyen `memo` (el MEMO_ID de quien llama, o `null`). Las operaciones creadas antes de la migración `20260915120000_liquidity_pool_operation_memo` devuelven `null` aunque su envelope lleve uno | Nadie, salvo un cliente que rechace campos desconocidos | El memo solo se guardaba dentro del XDR |
| El contrato publicado de `GET /v1/swaps` y `GET /v1/liquidity-pools/operations` ya no declara `qr` ni `commissionMemo` en los elementos de la lista. Las respuestas no cambian — esos dos campos nunca se enviaban ahí; se obtienen leyendo el elemento individual | Clientes generados a partir del spec OpenAPI | El contrato declaraba los elementos de la lista con la forma de la lectura individual |
| El servicio se niega a arrancar cuando `APISIX_GATEWAY_SECRET` es un placeholder — el valor que `.env.example` traía antes, o cualquier cosa que contenga `replace-with`, `change-me`, `your-secret` o `placeholder` — y `.env.example` ahora lo deja vacío | Despliegues que todavía usan el valor copiado de `.env.example` | Ese valor es público y suficientemente largo para superar el piso de 32 caracteres, así que cualquiera que pudiera alcanzar el servicio podía nombrar cualquier consumidor y llegar a `/v1/admin` |
| El servicio se niega a arrancar cuando `BLINDPAY_WEBHOOK_SECRET` está definido pero su clave (el base64 después de `whsec_`) está mal formada o decodifica a menos de 24 bytes, y `POST /v1/blindpay/webhooks` rechaza toda entrega mientras la clave configurada sea inutilizable | Despliegues con un secreto truncado o mal tipeado, cuyos webhooks de BlindPay ya venían fallando | Node decodifica un base64 inválido a una clave HMAC corta o vacía sin lanzar error, y una entrega firmada con una clave vacía puede ser falsificada por cualquiera |
| `GET /v1/health/readiness` responde una verificación fallida con el envelope de error estándar (`error: "Service Unavailable"`); antes ponía el reporte de salud, mensaje de error de la base de datos incluido, en `error` | Sondas que leen el reporte del cuerpo en lugar del código de estado | La ruta es `@Public()`, y el mensaje de Prisma nombra el host y el usuario de la base de datos |
| `POST /v1/onramp/receivers/:id/virtual-accounts` es `403 account_disabled` cuando el receiver, o el receiver dueño de `blockchain_wallet_id`, está deshabilitado | Nadie legítimo | Era la única operación fiat que el kill switch no cubría: una cuenta deshabilitada todavía podía abrir un nuevo riel de depósito |
| `POST /v1/swaps/:id/submit` y `POST /v1/liquidity-pools/operations/:id/submit` verifican el envelope antes que cualquier otra cosa: un cuerpo que no se puede parsear, que no es el envelope de la fila, o que no lleva firmas, es `400 validation_failed` sea cual sea el estado de la fila. Un `signedXdr` arbitrario ya no devuelve una fila `SUCCEEDED`, y una fila `EXPIRED` responde a un cuerpo que no coincide con `validation_failed` en lugar de `invalid_state_transition` | Clientes que enviaban el `xdr` sin firmar y dependían del rechazo `tx_bad_auth` | Las firmas no cambian el hash de una transacción, así que el envelope sin firmar podía retransmitirse y rechazarse en bucle, y bajo la key pública compartida el id de una fila por sí solo permitía leer una fila ya liquidada |
| Ambas rutas de submit rechazan un envelope que superó sus límites de tiempo (`400 invalid_state_transition`, no se transmite; el observador igual lo liquida si llegó a la red) y una fila `FAILED` que ya se reenvió 3 veces (`400 invalid_state_transition`: hay que construir una nueva). Un reintento después de `503 provider_unavailable` no cuenta | Clientes que reintentan el submit en bucle: deben detenerse ante `invalid_state_transition` | Cada reenvío rechazado era una nueva presentación a Horizon y un nuevo evento de webhook terminal, sin ningún límite |
| Ambas rutas de submit permiten 20 llamadas por minuto por consumidor y dirección del cliente, en cupos separados (`429 rate_limited`) | Wallets detrás de un mismo NAT que comparten la key pública | Las rutas aceptan la key pública compartida, y cada llamada puede transmitir a Horizon |
| `GET /v1/webhooks`, `GET /v1/webhooks/:id` y `PATCH /v1/webhooks/:id` devuelven solo los campos documentados del endpoint; `POST /v1/webhooks` y `POST /v1/webhooks/:id/rotate-secret` devuelven esos más `secret`. `consumerId`, `previousSecret` y `previousSecretExpiresAt` salieron de las cinco | Quienes leen esos campos | `previousSecret` es un secreto de firma que un integrador todavía podría aceptar, y una key con solo `webhooks:read` podía leerlo |
| Un token de recuperación que no coincide con ninguna recuperación vigente del alias ya no cuenta en su contra. Un token vigente consume un intento en cada presentación, incluida una cuyo desafío o firma luego falle; al quinto es `400 alias_recovery_invalid` | Nadie legítimo | Los nombres de alias son públicos, así que cinco tokens al azar desde cualquier key agotaban toda recuperación que la consola iniciara |
| `POST /v1/aliases/:name/recovery/complete` (10 cada 10 min), `POST /v1/aliases/challenges` (30), `POST /v1/webhooks/:id/ping` (20) y `POST /v1/webhooks/:id/deliveries/:deliveryId/redeliver` (30) son `429 rate_limited` al superar el presupuesto, por consumidor y dirección del cliente | Scripts que repiten estas rutas en bucle | Cada llamada guarda una fila, prueba un token de recuperación, o envía solicitudes a una URL que eligió quien llama |
| `PATCH /v1/payment-intents/:id` exige que `txHash` sea un hash de transacción de Stellar en hex de 64 caracteres (cualquier otra cosa es `400`) y lo guarda en minúsculas; `POST /v1/payment-intents/:id/validate` convierte el suyo a minúsculas también. Un hash es único entre las intenciones de un consumidor, en lugar de entre todos los tenants, y un hash que ya está en otra de tus intenciones es `409 idempotency_conflict` (antes era `500`) | Llamantes que envían hashes de relleno o truncados | Cualquier tenant podía dejar el hash de transacción de otro tenant en una intención propia; la liquidación del otro tenant entonces chocaba con el índice global, respondía `500`, y la intención pagada expiraba sin `PAYMENT_INTENT_SUCCEEDED` |
| Una intención `EXPIRED` pasa a `SUCCEEDED` cuando su pago se verifica on-chain: por el observador, que ahora revisa la cadena antes de expirar, o por `POST /v1/payment-intents/:id/validate` y `PATCH {status: SUCCEEDED}`, que responden `200` en lugar de `400 invalid_state_transition`. `PAYMENT_INTENT_SUCCEEDED` puede seguir a la actualización que emitió `EXPIRED` | Consumidores de webhooks que tratan `EXPIRED` como estado final | La expiración nunca miraba la cadena, y el verificador leía solo los 50 pagos más recientes al destino, así que un pago tardío o enterrado dejaba una intención pagada `EXPIRED` para siempre |
| Las respuestas de swaps, operaciones de liquidity pools, payment intents y customers devuelven solo sus campos documentados, más `expiresAt` en swaps y payment intents, ahora documentado. `consumerId` y la contabilidad de liquidación (`settlementEpoch`, `lastCheckedAt`, `notFoundStreak`, `sharesReceived`, `settledAmountA`/`B`, `horizonCursor`) ya no se envían | Quienes leían esos campos | Son internos, y varias de estas rutas son accesibles con la key pública compartida |
| `PATCH /v1/kyc/receivers/:id` sobre un receiver que ya existe en BlindPay es `403 kyc_review_required` para cualquier campo salvo `external_id` e `image_url`, a menos que la key sea elevada (`X-Consumer-Role: admin`) | Integradores que corrigen la identidad de un receiver activo con una key de tenant: hay que pasarla por el revisor | El `PUT` enviaba datos de identidad nunca revisados directamente a un proveedor regulado, mientras la misma edición antes de habilitarlo vuelve a revisión |
| Las rutas de BlindPay usan la instancia del entorno de la key: las keys `prod` la de las variables `BLINDPAY_*` sin sufijo, las keys `dev` la de `BLINDPAY_*_DEV`, y una key `dev` sin instancia de desarrollo configurada recibe `503 misconfigured`. Receivers, wallets, cuentas bancarias, cuentas virtuales, cotizaciones, payins y payouts solo se leen y ejecutan en esa instancia | Quien use BlindPay con keys `dev` | Una key `dev` operaba la instancia de producción: podía listar y borrar identidades KYC reales y crear payouts reales |
| Un login en testnet ya no aprovisiona una wallet de mainnet a su usuario: `network_wallets` en un canje de testnet lista solo la wallet de testnet. Un login en mainnet sigue aprovisionando testnet | Quien lea una entrada de mainnet de un login de testnet | Una key `dev` que cualquiera puede generar gastaba XLM real del operador en una reserva de mainnet por cada login |
| `POST /v1/kyc/receivers/:id/approve` acepta `expected_version` (el `dossierVersion` que leíste) y responde `409 kyc_state_invalid` cuando los datos de KYC cambiaron desde entonces. `POST /v1/kyc/receivers/:id/enable` rechaza un expediente que no es el aprobado, y las lecturas de receivers incluyen `dossierVersion` y `reviewedVersion` | Los revisores, cuando empiecen a enviar `expected_version`; nadie más — el campo es opcional | Una revisión es una persona leyendo los datos y aprobándolos después, y una edición en medio deja el estado en `pending_review`, así que la aprobación recaía sobre un expediente que nadie había visto y `enable` lo enviaba a un proveedor regulado |
| `POST /v1/kyc/upload`, `/v1/kyc/terms-of-service`, las escrituras de onramp y offramp, `POST /v1/payment-intents/tx` y `/pay`, `POST /v1/swaps/quote` y `/v1/swaps`, y `POST /v1/liquidity-pools/deposit` y `/withdraw` ahora responden `429 rate_limited` al pasarse del presupuesto, por consumidor y dirección del cliente. Toda ruta respaldada por BlindPay cuenta además contra un techo por consumidor de 60 peticiones al proveedor por minuto | Scripts que repiten esas rutas en bucle; un importador masivo por encima del techo debería tener su propia key | No tenían ningún límite: cada una deja algo en el proveedor que ningún error devuelve, o gasta el presupuesto de Horizon por IP que comparten todas las rutas de aquí. Solo los submits estaban limitados |
| `POST /v1/swaps` ya no responde `409 operation_in_flight` por un swap `PENDING` cuyo número de secuencia la cuenta todavía no usó (un envelope sin firmar o abandonado). Solo aplica con `STELLAR_SWAP_SINGLE_INFLIGHT=true` | Usuarios de wallet que quedaban bloqueados | Cualquiera puede indicar cualquier `source`, así que un swap de polvo congelaba la cuenta de un tercero una ventana de expiración tras otra — el gemelo de la corrección de liquidity pools de arriba |
| Un destino de webhook rechazado por su host — no resuelve, privado, link-local, metadatos — es un solo `400` con un solo mensaje; el motivo queda en el log del servicio. Una URL malformada, un esquema que no es https, credenciales o la falta de host siguen diciendo qué está mal | Integradores que leían el motivo en la respuesta | Registrar un endpoint resuelve un nombre al que este servicio puede llegar, así que una respuesta por motivo permitía mapear la red interna una URL a la vez |
| Una `redirect_url` se rechaza cuando lleva un fragmento, una barra invertida, espacios o un carácter de control; https sin credenciales incrustadas ya era obligatorio | Nadie que envíe una URL normal | `https://app.acme.com\@evil.test` nombra un host distinto según quién la parsee, y el valor lo vuelven a leer BlindPay y un navegador |
| `POST /v1/wallet/auth/oauth/claim`: un inicio de sesión con Authentik cuyo email el proveedor no ha confirmado (`email_verified` distinto de `true`) completa el callback y responde `verify_email` con un código enviado a esa bandeja, haya cuenta o no, en lugar de fallar con `email_unverified`. No se entrega ID token en ese caso, así que no puede iniciar una recuperación SEP-30, y comparte el enfriamiento por dirección de `POST /v1/wallet/auth/email/start` (`400 wallet_login_code_cooldown`). Ejecuta antes la migración `20260926120000_wallet_auth_unverified_email` | Wallets: manejar `verify_email` también en una cuenta nueva | La persona quedaba en una página sin salida; el código prueba la dirección que el proveedor no confirmó |
| `POST /v1/wallet/auth/finish` y `POST /v1/wallet/recovery/setup` leen el token de sesión de `X-Wallet-Session: {sessionToken}`. `Authorization: Bearer` se sigue leyendo, pero solo llega al servicio en una llamada directa | Wallets: enviar `X-Wallet-Session` junto a la API key | El gateway elimina `Authorization` (y `apikey`) antes de hacer proxy, así que a través de APISIX el token nunca llegaba y ambas rutas respondían `401 wallet_session_invalid` |
| Un inicio de sesión del wallet con Authentik pide `max_age=300` en lugar de `prompt=login`, y el `auth_time` del ID token debe estar dentro de esos 5 minutos (si no, el callback falla con `profile_invalid`). Con Google / GitHub como fuentes de Authentik, configura `default-source-authentication` en *Authentication: No requirement* | Operadores con Authentik y fuentes sociales | Con `prompt=login`, Authentik pedía iniciar sesión dos veces a un navegador sin sesión, y el segundo inicio a través de una fuente se rechazaba con "Flow does not apply to current user" |
| `POST /v1/wallet/auth/finish` y `PUT /v1/wallet/backup` también aceptan una caja de backup `v: 3`: la semilla bajo una clave de datos aleatoria, y esa clave sellada una vez por puerta en `slots` (`kind: "password"` o `kind: "passkey"`, como máximo 8). Toda puerta de contraseña tiene el mismo mínimo de PBKDF2 que una caja `v: 2`; una puerta de passkey no tiene costo, porque su clave es la salida PRF de WebAuthn del autenticador. Las cajas `v: 2` no cambian | Wallets: un backup solo con passkey es válido, y una wallet que escribió uno necesita este servidor | Permite restaurar con una passkey en lugar de tipear la contraseña original, sin que este servicio tenga nunca una clave que abra la caja |
| `POST /v1/wallet/auth/oauth/authorize` acepta un `returnTo` opcional. Si está en `WALLET_AUTH_RETURN_URLS`, `GET /v1/wallet/auth/oauth/callback/{provider}` responde `302` hacia él con `?state=…` (más `&error=<reason>` si falla) en lugar de mostrar la página; uno que no está en la lista es `400 wallet_return_url_not_allowed`. Solo viaja el `state`: el handshake se sigue canjeando con el verificador PKCE. Ejecutá antes la migración `20260927180000_wallet_auth_return_to` | Wallets nativas (escritorio y móvil): enviar `returnTo` y registrar esa URL en el sistema operativo | Una sesión de autenticación de la plataforma (`ASWebAuthenticationSession`, una Custom Tab, un deep link o listener loopback de escritorio) solo se cierra cuando el navegador llega a una URL de la app, así que la persona quedaba en la página y tenía que cerrarla a mano |
| `GET /v1/wallet/auth/providers` también devuelve `mfaSettingsUrl`: la página de la cuenta de Authentik donde una persona agrega o quita un segundo factor (llave de seguridad o passkey, app autenticadora, códigos de recuperación), pasando por el login de Authentik si no hay sesión; `null` sin Authentik. El segundo factor es opcional en el inicio de sesión de la wallet: `deploy/authentik/wallet-sign-in.yaml` devuelve la etapa de MFA a *skip*, pide el factor después de la contraseña a quien tiene uno, deja entrar con passkey desde la pantalla del usuario y, a quien no tiene ninguno, le ofrece elegir después de la contraseña (ahora no, una llave de seguridad, una app autenticadora). También suma Google / GitHub a la página de registro, arriba del formulario. El inicio de sesión y el registro con contraseña no cambian | Operadores con Authentik: importar el blueprint. Wallets: ofrecer la URL como un ajuste | El segundo factor era obligatorio para todos o inalcanzable: los usuarios de la wallet nunca entran a los ajustes de Authentik, los flows de configuración rechazan a un navegador sin sesión de Authentik, y el botón passwordless de la etapa de identificación apuntaba al mismo flow, así que solo recargaba la página |

Notas de despliegue que lo acompañan:

- **La migración `20260910120000_aliases`** crea `alias`, `alias_address`,
  `alias_challenge` y `alias_recovery`. Ejecutar `migrate deploy` antes de que el
  nuevo build reciba tráfico.
- **Un nuevo id de advisory lock, `881_008` (`AliasChallengeSweeper`).** No hay nada
  que configurar.
- **Establecer `NODE_ENV=production` en producción.** `.env.example` viene con
  `development`, y dos protecciones dependen de ese valor: una solicitud sin
  `X-Plan-Swap-Fee-Bps` es un `503` solo en producción (en cualquier otro entorno los
  swaps recurren en silencio a `STELLAR_SWAP_FEE_BPS`), y `/docs` — fuera de todo
  guard — está desactivado por defecto solo en producción.
- **Cambiaron las líneas de log del observador de liquidaciones** a
  `Settlement observer started (every Nms)`,
  `Settlement observer (OBSERVER_ENABLED=false) disabled` y
  `SettlementObserverService cycle failed` en nivel `error`. Actualizar las alertas
  que busquen el texto anterior. `OBSERVER_ENABLED`, `OBSERVER_INTERVAL_MS` y el
  advisory lock no cambian.
- **La migración `20260915120000_liquidity_pool_operation_memo`** añade la columna
  nullable `liquidity_pool_operation.memo`: no reescribe la tabla, solo toma un lock
  exclusivo breve. No hay backfill — el memo de las filas anteriores vive en XDR
  base64, que SQL no puede decodificar, y el servicio recurre al envelope para ellas.
- **Dos variables ahora se verifican en el arranque.** Un `APISIX_GATEWAY_SECRET`
  de tipo placeholder, o un `BLINDPAY_WEBHOOK_SECRET` cuya clave no decodifique a
  al menos 24 bytes, impide que el servicio arranque, con un error que nombra la
  variable. Hay que reemplazar un gateway secret de placeholder en la ruta de
  APISIX y aquí, en el mismo cambio (`openssl rand -hex 32`); un desajuste hace que
  toda solicitud falle como si no viniera del gateway.
- **La migración `20260915150000_payment_intent_tx_hash_per_consumer`** reemplaza
  el índice único sobre `payment_intent."txHash"` por uno sobre `("consumerId",
  "txHash")`. No es `CONCURRENTLY`: `payment_intent` queda bloqueada para
  escritura mientras se construye el índice. No hay backfill.
- **Los valores almacenados de `webhook_endpoint.previousSecret` ya no se
  devuelven, pero nada los borra.** Si una rotación en una versión anterior dejó
  uno y se quiere que desaparezca de la base de datos, hay que anular las dos
  columnas manualmente.
- **La migración `20260915160000_blindpay_environment`** añade `environment` (por
  defecto `'prod'`) a las siete tablas espejo de BlindPay — un cambio solo de
  catálogo, sin reescribir tablas —, así que las filas existentes quedan marcadas
  como producción. **Si las variables `BLINDPAY_*` sin sufijo apuntaban a una
  instancia de desarrollo de BlindPay**, hay que moverlas a las variables `_DEV` y
  reetiquetar las filas (`UPDATE … SET environment = 'dev'` en `blindpay_receiver`,
  `blindpay_blockchain_wallet`, `blindpay_bank_account`, `blindpay_virtual_account`,
  `payin`, `payout` y `blindpay_quote`), o las keys `prod` las seguirán leyendo.
- **Configurar la instancia de desarrollo de BlindPay** (`BLINDPAY_API_KEY_DEV`,
  `BLINDPAY_INSTANCE_ID_DEV`, `BLINDPAY_WEBHOOK_SECRET_DEV`) si las keys `dev` usan
  BlindPay, y apuntar su webhook del dashboard a la misma URL `/v1/blindpay/webhooks`.
- **La migración `20260915200000_receiver_dossier_version`** agrega `dossierVersion`
  (por defecto `1`) y `reviewedVersion` a `blindpay_receiver` — solo catálogo, sin
  reescritura de la tabla — y rellena `reviewedVersion` en todo receiver que ya pasó
  la revisión, para que su `enable` siga funcionando. Los receivers todavía en
  `inactive` o `pending_review` quedan en `NULL`, que es la verdad sobre ellos.
- **Nuevos `429` en rutas que nunca devolvían uno.** Los presupuestos de la tabla de
  arriba rigen desde esta versión; un cliente que repita en bucle subidas de KYC,
  cotizaciones, payins, payouts, construcción de intenciones, cotizaciones de swap o
  construcciones de pool tiene que respetar `Retry-After`. `RATE_LIMIT_ENABLED=false`
  apaga el limitador durante un incidente.

### El contrato OpenAPI lista solo lo que devuelve cada ruta

Nada cambió en la respuesta real; cambió el contrato publicado. Regenerar cualquier
cliente construido a partir de `openapi/openapi.json`:

- Cada operación lista solo los fallos que puede devolver. `409` aparece solo donde
  la ruta documenta un conflicto propio, `429` solo en rutas con rate limit,
  `502`/`503`/`504` solo donde la ruta llama a un proveedor, y los probes de salud no
  listan `401`/`403`. Los fallos compartidos son `$ref` a `components.responses`.
- Cada ejemplo de fallo es real para su status. Antes la especificación mostraba un
  único `409 idempotency_conflict` bajo todos los status de todas las rutas.
- `X-Gateway-Secret` y `X-Consumer-Username` forman un solo requisito de seguridad
  (ambos headers), con `Authorization: Bearer` publicado como alternativa para las
  llamadas a través del gateway. Antes eran dos alternativas, lo que les decía a las
  herramientas que bastaba con cualquiera de los dos.
- El `503` de `GET /v1/health/readiness` se documenta como la estructura de error.
  Antes se documentaba como el reporte de Terminus, que el filtro de excepciones
  nunca devuelve.

### NestJS 12, TypeScript 6 y Node 24.9 como versión mínima

El servicio ahora usa NestJS 12 y TypeScript 6 y **requiere Node 24.9 o posterior**
(`engines`; CI fija `node-version: 24`). Actualizar los entornos de despliegue en
consecuencia.

NestJS 12 se publica como ESM, y Jest solo puede cargarlo en Node >= 24.9 con
`--experimental-vm-modules`, por lo que los scripts de pruebas ejecutan Jest
directamente a través de Node:

```
"test": "node --experimental-vm-modules node_modules/jest/bin/jest.js"
```

El contrato OpenAPI publicado incorporó esquemas de health más completos de
`@nestjs/terminus@12` (enums de status y `responseTime`). No cambió ninguna ruta ni
esquema de negocio.

### Una API key pública compartida y el guard que la restringe

`PublicKeyGuard` (global, después de `PermissionsGuard`) y el decorador
`@AllowPublicKey()` son nuevos. Las keys existentes no se ven afectadas. Al desplegar:

- **Establecer `APISIX_PUBLIC_CONSUMER`** con el nombre de usuario que la plataforma
  para desarrolladores aprovisiona para la key pública, en cada despliegue que publique
  una. Sin esa variable, el guard depende únicamente del `X-Consumer-Role` reenviado.
- **Crear la key pública con `role: public`** y solo con los scopes que necesitan las
  rutas de la allowlist. Scopes adicionales como `kyc:*` no abrirían esas rutas, pero
  una key que tienen todos no debería llevarlos.

Ver "La API key pública compartida" más arriba.

### El registro de activos: `GET /v1/assets`

Una lista curada de los pares (code, issuer) que admite esta plataforma, por red, con
la organización emisora. No requiere scope, ya que no contiene datos de tenants, pero
sí requiere un consumidor autenticado (la key pública compartida sirve).

`npm run assets:verify` verifica cada fila contra Horizon en vivo: que el par exista en
su red, que `contract` coincida con el `contract_id` de Horizon y que los flags del
emisor coincidan con la cadena. Ejecutarlo al editar el registro; necesita acceso a
internet, por lo que no forma parte de las pruebas unitarias.

### Actividad del cliente: un módulo nuevo, una tabla nueva y dos scopes nuevos

`POST /v1/activity/events` acepta telemetría de la wallet y del dashboard para
desarrolladores; `GET /v1/activity/events` y `GET /v1/activity/summary` permiten
consultarla. No cambió ninguna respuesta existente. Al desplegar:

- **La migración `20260906140000_activity_event`** crea `activity_event` (solo de
  inserción, limitada por `consumerId`, única sobre `(consumerId, eventId)`).
- **Los scopes `activity:write` y `activity:read` son nuevos.** Las keys existentes no
  los obtienen automáticamente y reciben `insufficient_scope`. La plataforma para
  desarrolladores otorga ambos a las keys aprovisionadas para wallets y los vuelve a
  aplicar al rotarlas; hay que agregarlos a las keys creadas manualmente.
- **`ACTIVITY_RETENTION_DAYS`** (por defecto 30) se suma al job de retención. Estas
  filas contienen datos personales, igual que el log de acceso.

### `429` ahora reporta `rate_limited`

Antes, un `429` reportaba `code: "provider_unavailable"`. Ahora reporta
`code: "rate_limited"` (`ApiErrorCode.RateLimited`, parte del enum publicado).
Conviene ramificar según ese valor si se reintenta ante throttling.

### Un BlindPay sin configurar ahora reporta `misconfigured`

Cuando BlindPay no está configurado, cambiaron dos respuestas:

| Solicitud | Antes | Ahora |
| --------- | ----- | ----- |
| Una ruta que llama a BlindPay — bajo `/v1/kyc`, `/v1/onramp` o `/v1/offramp` — mientras `BLINDPAY_API_KEY` o `BLINDPAY_INSTANCE_ID` no están definidos | `503` `provider_unavailable` | `503` `misconfigured` |
| `POST /v1/blindpay/webhooks` mientras `BLINDPAY_WEBHOOK_SECRET` no está definido | `400` `validation_failed` | `503` `misconfigured` |

Ambos son errores de configuración del despliegue que un reintento no puede resolver.
Svix reintenta ante cualquier respuesta que no sea 2xx, así que la entrega de webhooks
no cambia.

### Formatos de respuesta que cambiaron

Cambiaron tres formatos de respuesta publicados bajo `/v1` (no existe `/v2`), así que
hay que avisar a los integradores antes de desplegar.

| Endpoint | Antes | Ahora | Por qué |
| -------- | ----- | ----- | ------- |
| `GET /v1/webhooks` | array simple, recortado en silencio a 100 | `{ data, total, take, skip }` | Los resultados se recortaban a 100 sin un `total` con el que paginar |
| `GET /v1/products` | array simple, tabla completa | `{ data, total, take, skip }` | Lectura sin límite |
| `GET /v1/webhooks/:id/deliveries` y la respuesta de reenvío | incluía `payload` | `payload` eliminado | Un cuerpo `RECEIVER_UPDATED` es un expediente KYC completo y estas rutas están protegidas por `webhooks:read`, no por `kyc:read` |

Los llamantes que iteran la respuesta o leen `delivery.payload` se rompen: leer
`res.data` en su lugar, y obtener los detalles de KYC desde los endpoints de KYC con
una key que tenga `kyc:read`.

Los **cuerpos de webhook** `RECEIVER_UPDATED` / `PAYIN_*` / `PAYOUT_*` también se
redujeron a identidad y estado — ver la sección Webhooks.

### La migración de audit-hardening

Se distribuye como dos archivos que deben aplicarse en orden:

- `20260901120000_audit_hardening` — el trabajo de corrección: una columna nueva, un
  `DELETE` de deduplicación sobre `liquidity_pool_operation`, dos índices `UNIQUE` y
  dos tablas nuevas. El DELETE y el índice único se ejecutan en una sola transacción
  bajo un lock `SHARE ROW EXCLUSIVE`, por lo que las escrituras en esa tabla se
  bloquean durante unos pocos milisegundos.
- `20260901120100_audit_hardening_indexes` — nueve índices aditivos, construidos con
  `CONCURRENTLY` para que el despliegue **no** bloquee escrituras en `payment_intent`,
  `swap`, `webhook_delivery` o `request_log`. No se necesita ventana de mantenimiento.

Son archivos separados porque PostgreSQL no permite `CREATE INDEX CONCURRENTLY` dentro
de una transacción, y el primer archivo necesita una.

Si el segundo archivo falla a mitad de camino, puede dejar un índice **inválido** que
`IF NOT EXISTS` considera presente. Encontrarlo, eliminarlo y volver a ejecutar:

```sql
SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE NOT i.indisvalid;
```

### `ADMIN_API_CREDENTIALS` desaparece — `/v1/admin` pertenece a la consola de la plataforma

**Eliminar la variable.** Ya no se lee, y las correspondientes
`COSMOS_ADMIN_API_SECRET` / `COSMOS_ADMIN_API_SECRET_READ` de la plataforma para
desarrolladores se eliminan con ella.

Era una segunda verificación de administración, además de la verificación de rol de la
propia plataforma para desarrolladores, y los despliegues que no la configuraban
recibían `401 admin_credentials_required` en las lecturas entre tenants desde la
consola. Ahora `/v1/admin` acepta una solicitud solo cuando viene de la consola de la
plataforma, algo que establecen dos datos de la solicitud:

1. `X-Gateway-Secret` coincide con `APISIX_GATEWAY_SECRET` — verificado por
   `ApisixGuard`, como en cualquier otra ruta. Solo el gateway y el backend de la
   consola lo tienen.
2. `X-Cosmos-Internal` está presente. APISIX lo elimina de toda solicitud que reenvía
   (`proxy-rewrite.headers.remove`), por lo que un llamante con API key no puede
   incluirlo; solo puede hacerlo una llamada directa desde un backend que tenga el
   secreto del gateway.

El punto 2 depende de la configuración de la ruta del gateway en el repositorio de la
plataforma para desarrolladores, no de un secreto que tenga este servicio. A cambio, la
consola es el único lugar que decide quién es administrador de la plataforma, y las
filas de auditoría nombran la cuenta de la consola que actuó (`cosmos_<userId>`) y su
rol de plataforma, en cada mutación **y** en cada lectura.

Lo que esto cambia para quien llama:

| Antes | Ahora |
| ----- | ----- |
| `401` `admin_credentials_required` sin un secreto Bearer | `403` `admin_console_only` para todo lo que no sea una llamada de la consola |
| `403` `admin_role_required` para una credencial `read` en una mutación | eliminado — la consola ya decidió que la cuenta puede actuar |
| `actorId` / `actorRole` en una fila de auditoría nombraban la credencial | nombran la cuenta de la consola y su rol de plataforma |

Para llamar a `/v1/admin` directamente (por ejemplo, desde un script de operaciones),
enviar `X-Gateway-Secret`, `X-Consumer-Username` y `X-Cosmos-Internal: 1`; agregar
`X-Cosmos-Admin-Role: owner` para etiquetar la fila de auditoría. Mantener el servicio
fuera de internet pública.

### `APISIX_GATEWAY_SECRET` ahora requiere 32 caracteres

El servicio se niega a arrancar con un secreto más corto. Ahora también protege
`/v1/admin` (ver arriba). Generar uno con `openssl rand -hex 32` y actualizarlo en
APISIX al mismo tiempo.

### Funcionalidades de `v0.1.0`–`v0.1.5` que esta versión reemplaza

Un despliegue que se actualiza desde `v0.1.5` pierde el siguiente comportamiento.
Todos los puntos son visibles para los integradores, así que conviene planificar la
actualización en función de ellos.

| Existía en `v0.1.5` | Ahora |
| ------------------- | ----- |
| `POST /v1/webhooks/:id/rotate-secret` aceptaba `graceSeconds` y mantenía el secreto anterior verificando durante `WEBHOOK_SECRET_GRACE_SECONDS` | El secreto se reemplaza directamente; el anterior deja de verificar de inmediato. Actualizar el secreto almacenado en el receptor en la misma ventana que la llamada de rotación. |
| Un worker de reintentos con lease entregaba los webhooks (`maxAttempts` / `nextAttemptAt` / `leaseUntil`, estado `RETRYING`) | Lo hace el sweeper de entregas, con `WEBHOOK_MAX_ATTEMPTS` de vuelta en `3` por bucle en proceso (un techo real de 9 entre barridos). `WEBHOOK_MAX_BACKOFF_MS`, `WEBHOOK_WORKER_*`, `WEBHOOK_LEASE_MS`, `WEBHOOK_FANOUT_CONCURRENCY` y `WEBHOOK_PAUSE_AFTER_FAILURES` desaparecieron, y ninguna entrega se escribe nunca como `RETRYING`. |
| Se emitían `SWAP_EXPIRED` y `LIQUIDITY_EXPIRED` | No se emite ninguno de los dos. La expiración se sigue registrando en la fila; consultarla, o suscribirse a los eventos `*_FAILED`. |
| `GET /v1/products` filtraba por `kind`, `active` y `reference`, y `DELETE` aceptaba `hard=true` | Nada de eso existe. Las eliminaciones son lógicas (`active=false`). |
| `GET /v1/products` y `GET /v1/customers` usaban por defecto `take=20` | Ambos usan por defecto `take=100` (que sigue siendo el máximo), por lo que una llamada sin parámetros devuelve más filas que antes. |
| `analytics.apiLogs` / `analytics.webhookLogs` devolvían `{ data, total }` y solo respetaban `take` | Ambos se paginan como cualquier otro listado: `take` + `skip` de entrada, `{ data, total, take, skip, hasMore }` de salida. Los filtros por rango de fechas de la vista general desaparecieron. |
| `/v1/health` reportaba un indicador de readiness de Stellar junto con la base de datos | Solo reporta la base de datos. |
| `STELLAR_HTTP_TIMEOUT_MS`, `STELLAR_MAX_ATTEMPTS`, `STELLAR_RETRY_BASE_MS` acotaban las llamadas a Horizon | Los límites de las llamadas a Horizon viven en `stellar/stellar.constants.ts` y no son configurables por entorno. Esas tres variables ya no se leen ni se validan. |

**No se elimina nada de la base de datos.** Las columnas, índices y valores de enum que
agregaron esas funcionalidades (`webhook_delivery.maxAttempts` / `nextAttemptAt` /
`leaseUntil`, `webhook_endpoint.previousSecret*`, `lastCheckedAt` / `notFoundStreak` de
`swap` y `liquidity_pool_operation`, la tabla `horizon_account_cursor`, `RETRYING`,
`SWAP_EXPIRED`, `LIQUIDITY_EXPIRED`) siguen declarados en `schema.prisma` y presentes
después de `migrate deploy`; simplemente ya no se escriben. Eliminarlos requeriría una
migración destructiva (PostgreSQL no puede quitar un valor de enum sin recrear el
tipo).

## Variables de entorno

Cada variable leída de `process.env` en `src/` se valida en el arranque mediante
`src/config/env.validation.ts` (fail-fast). Copiar `.env.example` y ajustar al menos
`DATABASE_URL` y `APISIX_GATEWAY_SECRET`.

| Variable | Obligatoria | Valor por defecto | Efecto |
| -------- | ----------- | ----------------- | ------ |
| `NODE_ENV` | no | `development` | Debe ser `development`, `test` o `production`. **Establecer `production` en producción** — tanto la verificación fail-closed de la comisión del plan como la documentación desactivada por defecto dependen de ese valor |
| `PORT` | no | `3000` | Puerto HTTP de escucha |
| `DATABASE_URL` | **sí** | — | Conexión PostgreSQL para Prisma |
| `APISIX_GATEWAY_SECRET` | **sí** | — | Secreto compartido que demuestra que la solicitud pasó por APISIX. **Mínimo 32 caracteres**; un placeholder se rechaza en el arranque |
| `APISIX_GATEWAY_SECRET_HEADER` | no | `x-gateway-secret` | Nombre del header del secreto del gateway |
| `APISIX_CONSUMER_HEADER` | no | `x-consumer-username` | Nombre de usuario del consumidor autenticado |
| `APISIX_CREDENTIAL_HEADER` | no | `x-credential-identifier` | Id de la credencial de key-auth |
| `APISIX_ENVIRONMENT_HEADER` | no | `x-consumer-env` | Entorno de la key (`dev` / `prod`) |
| `APISIX_ROLE_HEADER` | no | `x-consumer-role` | Rol del consumidor reenviado por el gateway |
| `APISIX_PERMISSIONS_HEADER` | no | `x-consumer-permissions` | Lista de permisos reenviada por el gateway |
| `APISIX_ORGANIZATION_HEADER` | no | `x-consumer-org` | Id de la organización |
| `APISIX_PLAN_HEADER` | no | `x-consumer-plan` | Plan de la organización |
| `APISIX_SWAP_FEE_BPS_HEADER` | no | `x-plan-swap-fee-bps` | Comisión de swap del plan (bps) |
| `APISIX_EMAIL_HEADER` | no | `x-consumer-email` | Email verificado de la cuenta de la key, reenviado por el gateway. Hoy nada en este servicio depende de él |
| `APISIX_PUBLIC_CONSUMER` | no | — | Nombre de usuario del consumidor público compartido (ver arriba). Definirla en todo despliegue donde se publique una key pública |
| `PUBLIC_API_KEY_DEV` | no | — | La key pública compartida de testnet, servida por `GET /v1/public-key?env=dev`. Sin definir responde `503 misconfigured` |
| `PUBLIC_API_KEY_PROD` | no | — | Lo mismo para mainnet (`env=prod`) |
| `APISIX_ADMIN_URL` | con la admin key | — | Base de la Admin API de APISIX, p. ej. `http://apisix:9180/apisix/admin`. Solo se usa para emitir las keys de las cuentas de wallet |
| `APISIX_ADMIN_KEY` | para el inicio de sesión del wallet | — | Admin key de APISIX. Vale para todo el gateway — ver [Ninguna solicitud depende de la plataforma para desarrolladores](#ninguna-solicitud-depende-de-la-plataforma-para-desarrolladores). Rechazada en un servidor de recuperación |
| `APISIX_ADMIN_TIMEOUT_MS` | no | `10000` | Presupuesto de una llamada a la Admin API (ms) |
| `WALLET_KEY_SWAP_FEE_BPS` | no | `150` | Comisión de swap incluida en las keys de las cuentas de wallet (la tarifa del plan `community`) |
| `MAIL_RESEND_API_KEY` | para la puerta de email | — | API key de Resend con la que este servicio envía los códigos de inicio de sesión y de recuperación |
| `MAIL_FROM` | con la key de Resend / SMTP | — | Remitente verificado, p. ej. `Cosmos Pay <no-reply@example.com>` |
| `MAIL_SMTP_HOST` | no | — | Servidor SMTP, usado cuando `MAIL_RESEND_API_KEY` no está definida |
| `MAIL_SMTP_PORT` | no | `587` | Puerto SMTP |
| `MAIL_SMTP_SECURE` | no | `false` | `true` para TLS implícito (465), `false` para STARTTLS (587) |
| `MAIL_SMTP_USER` | no | — | Usuario SMTP |
| `MAIL_SMTP_PASS` | no | — | Contraseña SMTP |
| `MAIL_TIMEOUT_MS` | no | `15000` | Presupuesto de un envío (ms) |
| `RECOVERY_EMAIL_CODES` | no | `false` | En un servidor de recuperación: envía sus propios códigos con su `MAIL_*` |
| `STELLAR_NETWORK` | no | `testnet` | Red de Stellar de fallback (`public` / `testnet`) |
| `STELLAR_HORIZON_URL_PUBLIC` | no | `https://horizon.stellar.org` | URL base de Horizon para mainnet |
| `STELLAR_HORIZON_URL_TESTNET` | no | `https://horizon-testnet.stellar.org` | URL base de Horizon para testnet |
| `SOLANA_RPC_URL_MAINNET` | no | `https://api.mainnet-beta.solana.com` | RPC de Solana para claves `prod` (mainnet-beta; el genesis hash se comprueba antes de usarlo). El endpoint público tiene límites de tasa: en producción use el de un proveedor |
| `SOLANA_RPC_URL_DEVNET` | no | `https://api.devnet.solana.com` | RPC de Solana para claves `dev` (devnet) |
| `SOLANA_RPC_TIMEOUT_MS` | no | `10000` | Presupuesto de una llamada RPC a Solana (ms) |
| `MONAD_RPC_URL_MAINNET` | no | `https://rpc.monad.xyz` | RPC de Monad para claves `prod` (chain id 143, comprobado antes de usarlo) |
| `MONAD_RPC_URL_TESTNET` | no | `https://testnet-rpc.monad.xyz` | RPC de Monad para claves `dev` (chain id 10143) |
| `MONAD_RPC_TIMEOUT_MS` | no | `10000` | Presupuesto de una llamada RPC a Monad (ms) |
| `MONAD_LOG_BLOCK_RANGE` | no | `100` | Bloques que puede abarcar un `eth_getLogs`: el límite del proveedor RPC (el RPC público admite 100) |
| `MONAD_RELAYER_PRIVATE_KEY` | no | — | Clave del relayer (hex de 32 bytes). Configurada, cada intención en Monad recibe su propia dirección de depósito y el relayer reenvía los depósitos al comercio, menos una comisión. Solo guarda dinero para gas: los reenviadores que despliega no pueden pagar a nadie más |
| `MONAD_DEPOSIT_TOKEN_FEES` | no | — | Comisión del relayer por depósito de cada ERC-20, JSON `{"0xToken": "0.05"}` en unidades del token. Un token sin entrada se reenvía gratis (el relayer paga el gas) |
| `STELLAR_BASE_FEE` | no | `100` | Fee base de Stellar (stroops) para construir txs |
| `STELLAR_TX_TIMEOUT` | no | `300` | Timeout de la transacción (segundos) |
| `STELLAR_SWAP_FEE_WALLET` | cuando fee > 0 | — | Cuenta G... de la plataforma para las comisiones de swap |
| `STELLAR_SWAP_FEE_BPS` | no | `50` | Comisión de swap en puntos básicos |
| `STELLAR_SWAP_SLIPPAGE_BPS` | no | `50` | Tolerancia de slippage por defecto para swaps (bps) |
| `STELLAR_SWAP_MAX_SLIPPAGE_BPS` | no | `500` | Tope máximo del slippage que puede pedir quien llama (bps) |
| `STELLAR_SWAP_SINGLE_INFLIGHT` | no | `false` | Cuando es `true`, 409 si ya existe un swap PENDING no expirado para el mismo source |
| `OBSERVER_ENABLED` | no | `true` | `true` / `false` — reconciliador on-chain |
| `OBSERVER_INTERVAL_MS` | no | `15000` | Intervalo de sondeo del observador (ms, mín. 1000) |
| `OBSERVER_BATCH_SIZE` | no | `50` | Máximo de intenciones/swaps por ciclo del observador |
| `PAYMENT_INTENT_TTL_SECONDS` | no | `3600` | Vida de una intención impaga antes de pasar a `EXPIRED` |
| `WEBHOOK_TIMEOUT_MS` | no | `5000` | Fallback heredado del timeout de webhooks (ms) |
| `WEBHOOK_CONNECT_TIMEOUT_MS` | no | `3000` | Presupuesto de conexión de los webhooks salientes (ms) |
| `WEBHOOK_READ_TIMEOUT_MS` | no | `5000` | Presupuesto de lectura de los webhooks salientes (ms) |
| `WEBHOOK_MAX_RESPONSE_BYTES` | no | `65536` | Tamaño máximo del cuerpo de respuesta del webhook que se consume |
| `WEBHOOK_MAX_ATTEMPTS` | no | `3` | Cantidad de reintentos de entrega |
| `WEBHOOK_BACKOFF_MS` | no | `2000` | Backoff lineal entre reintentos (ms) |
| `WEBHOOK_SIGNATURE_HEADER` | no | `x-cosmos-signature` | Header HMAC enviado a los integradores |
| `WEBHOOK_SWEEP_ENABLED` | no | `true` | Recuperar entregas varadas por una caída. Interruptor de incidentes |
| `WEBHOOK_SWEEP_INTERVAL_MS` | no | `60000` | Intervalo del sweeper (ms, mín. 1000) |
| `WEBHOOK_PAYLOAD_RETENTION_DAYS` | no | `30` | Días que se conserva el cuerpo de una entrega finalizada antes de redactarlo. `0` lo conserva para siempre |
| `REQUEST_LOG_RETENTION_DAYS` | no | `30` | Días que se conservan las filas de `request_log` (IP / user-agent del pagador). `0` desactiva la depuración |
| `ACTIVITY_RETENTION_DAYS` | no | `30` | Días que se conservan las filas de `activity_event` (IP / user-agent / `props` del cliente). Las depura el mismo job. `0` conserva los eventos para siempre |
| `REQUEST_LOG_PRUNE_INTERVAL_MS` | no | `3600000` | Intervalo del temporizador de retención (ms) |
| `REQUEST_LOG_PRUNE_BATCH_SIZE` | no | `1000` | Filas por lote de eliminación (mantiene corto cada lock) |
| `REQUEST_LOG_PRUNE_MAX_PER_CYCLE` | no | `50000` | Tope máximo de filas examinadas por ciclo |
| `SWAGGER_ENABLED` | no | desactivado en `production` | Publicar `/docs` (middleware de Express, sin guards) |
| `OPENAPI_SERVER_URL` | no | — | Host del gateway que se fija en el OpenAPI exportado |
| `BLINDPAY_API_KEY` | no | — | API key de la instancia de producción de BlindPay, usada por las keys `prod` |
| `BLINDPAY_INSTANCE_ID` | si hay API key | — | Id de instancia de BlindPay (`in_...`) |
| `BLINDPAY_BASE_URL` | no | `https://api.blindpay.com/v1` | URL base de la API de BlindPay |
| `BLINDPAY_WEBHOOK_SECRET` | si hay API key | — | Secreto Svix para los webhooks entrantes de BlindPay: el valor `whsec_…` completo, cuya clave debe decodificar a al menos 24 bytes (verificado en el arranque) |
| `BLINDPAY_API_KEY_DEV` | no | — | API key de la instancia de desarrollo de BlindPay, usada por las keys `dev`. Sin definir: las rutas de BlindPay responden `503 misconfigured` a las keys `dev` |
| `BLINDPAY_INSTANCE_ID_DEV` | si hay API key de desarrollo | — | Id de la instancia de desarrollo (`in_...`) |
| `BLINDPAY_WEBHOOK_SECRET_DEV` | si hay API key de desarrollo | — | Secreto Svix del endpoint de webhook de la instancia de desarrollo; mismas reglas que `BLINDPAY_WEBHOOK_SECRET` |
| `BLINDPAY_TIMEOUT_MS` | no | `15000` | Timeout del cliente HTTP de BlindPay (ms) |
| `DEFINDEX_API_KEY` | no | — | Clave API de servidor de DeFindex. Las rutas existen solo con `defindex` en `PLUGINS_ENABLED`; sin la clave responden `503 misconfigured` |
| `DEFINDEX_BASE_URL` | no | `https://api.defindex.io` | URL base de la API DeFindex |
| `DEFINDEX_TIMEOUT_MS` | no | `30000` | Timeout HTTP de DeFindex (ms) |
| `PLUGINS_ENABLED` | no | — | Slugs, separados por comas, de los plugins que sirve este despliegue: los aislados de `plugins/` y los nativos `blindpay` y `defindex`. Vacío no sirve ninguno; un plugin no listado nunca se carga |
| `PLUGINS_SECRET` | cuando un plugin habilitado tiene ajustes secretos | — | Sella los ajustes secretos de las instalaciones de plugins (mínimo 32 caracteres). Cambiarlo deja ilegibles todos los secretos de plugins guardados |
| `PLUGINS_TRUSTED_KEYS` | no | — | Firmantes cuyos plugins corren aquí además de soporte de Cosmos Pay: `<keyId>:<clave pública Ed25519 en base64url>` separados por comas. Un plugin firmado por otro, o modificado después de firmarse, detiene el arranque |
| `PLUGINS_ALLOW_UNSIGNED` | no | `false` | Ejecutar plugins sin `signature.json`, para escribir uno en local. Se rechaza cuando `NODE_ENV=production` |
| `KYC_REDIRECT_URL_WHITELIST` | no | — | Lista de hosts permitidos por consumidor para las redirecciones de KYC |
| `WALLET_AUTH_RETURN_URLS` | no | — | URLs de la app, separadas por comas, a las que el callback del inicio de sesión de la wallet puede redirigir (`returnTo` en `POST /v1/wallet/auth/oauth/authorize`): un esquema propio, un universal/app link, o `http://127.0.0.1/…` (cualquier puerto). Coincidencia exacta; una entrada en http plano fuera de loopback, con query o con `javascript:`/`data:`/`file:` se rechaza al arrancar. Sin definir, todo callback muestra la página y un `returnTo` es `400 wallet_return_url_not_allowed` |
| `RATE_LIMIT_ENABLED` | no | `true` | Límites por dirección en las rutas que gastan XLM. Interruptor de incidentes |
| `RATE_LIMIT_PRUNE_INTERVAL_MS` | no | `600000` | Intervalo de depuración de las ventanas del contador (ms, mín. 1000) |

La variable heredada `STELLAR_HORIZON_URL` se rechaza en el arranque — usar
`STELLAR_HORIZON_URL_PUBLIC` / `STELLAR_HORIZON_URL_TESTNET` en su lugar.

## Primeros pasos

```bash
cp .env.example .env          # set DATABASE_URL and a strong APISIX_GATEWAY_SECRET
npm install
npm run db:generate           # prisma generate
npm run db:migrate            # create the schema (needs a running Postgres)
npm run start:dev
```

Generar un secreto:

```bash
openssl rand -hex 32
```

Ejecutar las mismas verificaciones que ejecuta CI (no se necesita base de datos —
Prisma está mockeado):

```bash
npm run lint
npm test                 # unit suites (src/**/*.spec.ts)
npm run test:e2e         # e2e suites (test/*.e2e-spec.ts)
npm run openapi:check    # the committed contract matches the controllers
npm run readme:check     # the seven READMEs match in structure and list every route
```

## Configuración de rutas en APISIX

El helper de rutas de la plataforma para desarrolladores (`paydev/src/utils/apisix.ts`)
ya convierte `Authorization: Bearer <token>` en el header `apikey`, valida `key-auth`
y elimina las credenciales antes de reenviar. Para apuntar una ruta a este servicio,
agregar la **inyección del secreto del gateway** al plugin `proxy-rewrite` para que el
header llegue aquí — y eliminar cualquier copia enviada por el cliente:

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

`key-auth` reenvía `X-Consumer-Username` / `X-Credential-Identifier` al upstream
después de una autenticación exitosa, sobrescribiendo cualquier copia enviada por el
cliente, y el guard depende de eso.

> **La lista de eliminación es un control de seguridad, y no puede verificarse desde
> este repositorio.** Este servicio acepta tal cual cada header de esa lista;
> `X-Gateway-Secret` solo demuestra que la solicitud pasó por un gateway, no que esos
> valores sean honestos. Revisar la lista cada vez que se agrega o se copia una ruta —
> una ruta que no elimina `X-Cosmos-Internal` le da acceso a `/v1/admin` a cualquier
> API key. Mantener el servicio en una red privada para que APISIX sea la única vía de
> entrada; el secreto compartido es una segunda capa, no la única.
>
> En producción, la ausencia de `X-Plan-Swap-Fee-Bps` devuelve `503` en lugar de
> recurrir al valor por defecto del entorno.
