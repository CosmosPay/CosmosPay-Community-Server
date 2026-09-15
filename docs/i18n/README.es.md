# Cosmos Pay — Microservicio de pagos

[English](../../README.md) · **Español** · [Português](./README.pt.md) · [Deutsch](./README.de.md) · [Français](./README.fr.md) · [हिन्दी](./README.hi.md) · [简体中文](./README.zh.md)

Microservicio de pagos construido con **NestJS 12** + **Prisma 7 (PostgreSQL)**.

Es una aplicación *independiente* de la plataforma para desarrolladores de Cosmos
(`paydev`). La plataforma para desarrolladores solo **emite** tokens de acceso de
APISIX (consumidores + credenciales `key-auth`) para los servicios downstream. Este
servicio es uno de esos servicios downstream: se ubica **detrás de APISIX**, que
balancea la carga y autentica cada solicitud antes de reenviarla aquí. Por lo tanto,
el servicio nunca ve las API keys en crudo — solo confía en lo que el gateway reenvía.

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

Una superficie obtiene algo más de esas mismas dos condiciones. `/v1/admin` abarca a
todos los tenants, y `AdminGuard` solo admite una solicitud allí cuando además
incluye `X-Cosmos-Internal` — un header que APISIX **elimina** de todo lo que
reenvía, de modo que solo una llamada directa desde un backend que posea el secreto
del gateway puede presentarlo. Ese backend es la plataforma para desarrolladores, que
ya decidió si la cuenta con sesión iniciada es owner/admin. No hay una credencial de
administración separada que desplegar (ver la nota de actualización sobre
`ADMIN_API_CREDENTIALS`), lo que convierte al secreto del gateway y al aislamiento de
red en toda la frontera frente a los datos de todos los tenants — y hace que la lista
de headers eliminados en la ruta del gateway sea relevante para la seguridad, no una
simple cuestión de higiene.

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
| Intenciones de pago   | `/v1/payment-intents`    | Intenciones SEP-7 `tx` / `pay`, validación, observador on-chain |
| Swaps                 | `/v1/swaps`              | Cotización de path payment, construcción del XDR sin firmar, envío del firmado |
| Pools de liquidez     | `/v1/liquidity-pools`    | Depósito / retiro en AMM, posiciones, comisión sobre la ganancia |
| Webhooks              | `/v1/webhooks`           | CRUD de endpoints, rotación de secretos, entregas, reenvío |
| KYC                   | `/v1/kyc`                | Receivers (KYC/KYB), wallets, cuentas bancarias, carga de documentos |
| Onramp                | `/v1/onramp`             | Cotizaciones de payin, payins, cuentas virtuales          |
| Offramp               | `/v1/offramp`            | Cotizaciones de payout, autorización, payouts (firmados por el cliente) |
| Productos             | `/v1/products`           | Catálogo del comercio                                     |
| Clientes              | `/v1/customers`          | Registros de pagadores derivados de las intenciones       |
| Alias                 | `/v1/aliases`            | Identificadores de pago reclamables: reclamar, resolver, recuperar |
| Activos               | `/v1/assets`             | Registro curado de activos por red                        |
| Pollar                | `/v1/pollar`             | Puente OAuth (inicio de sesión social → wallet) + rutas de operador |
| Analítica             | `/v1/summary`, `/v1/balances`, `/v1/logs` | Agregados y logs del dashboard           |
| Actividad             | `/v1/activity`           | Eventos reportados por los clientes: ingesta, feed, resumen |
| Administración        | `/v1/admin`              | Lecturas/escrituras entre tenants — solo consola de la plataforma, auditadas |
| Salud                 | `/v1/health`             | Liveness / readiness (`@Public`)                          |

### Índice de rutas

Todas las rutas que sirve este servicio. **Scope** es lo que debe tener la API key —
*uno de* significa que basta con cualquiera de los scopes listados, y `—` significa
cualquier key autenticada. **API key pública** marca las rutas que puede llamar la API
key pública compartida (ver
[La API key pública compartida](#la-api-key-pública-compartida)). Una ruta marcada
como *consola de la plataforma* no acepta ninguna API key; solo el backend de la
consola llega a ella. Las rutas usan la forma `{param}` de OpenAPI, y
`npm run readme:check` hace fallar CI cuando una ruta del contrato no figura en esta
tabla.

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
| GET | `/v1/pollar/oauth/callback` | ninguno — `@Public()` |  |
| GET | `/v1/pollar/oauth/callback/{state}` | ninguno — `@Public()` |  |
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
como `ApiErrorBodyEntity`, adjunta a cada operación, de modo que un cliente generado
también obtiene el tipo de error y no hace falta leer este repositorio para descubrir
los códigos. La fuente de verdad es `ApiErrorCode` en `src/common/errors/api-error.ts`.
**Los códigos nunca se renombran una vez publicados**; pueden agregarse nuevos, así
que un código no reconocido debe tratarse según su status HTTP.

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
| `provider_unavailable` | 503/504 | BlindPay u Horizon no están accesibles. Reintentar |
| `misconfigured` | 503 | Un error de configuración del lado del servidor. Reintentar no ayudará |

Cada intención se **persiste** (tabla `payment_intent`) y queda limitada al
consumidor de APISIX autenticado, por lo que las lecturas/actualizaciones/eliminaciones
solo afectan los registros propios de ese consumidor — trazabilidad completa del ciclo
de vida de cada intención (`PENDING → SUBMITTED → SUCCEEDED/FAILED/CANCELLED/EXPIRED`).

### Ejecución con más de una réplica

APISIX balancea la carga entre instancias, por lo que cada `setInterval` de este
servicio se ejecuta una vez por réplica. La corrección nunca fue el problema — cada
cambio de estado pasa por un compare-and-swap con `updateMany` protegido, así que
solo gana un escritor — pero tres réplicas implicaban el triple de viajes de ida y
vuelta a Horizon para un trabajo idéntico, contra una API que aplica rate limits, y
réplicas compitiendo por eliminar las mismas tuplas de `request_log`.

Cada temporizador en segundo plano ahora toma un **advisory lock a nivel de
transacción** de PostgreSQL (`AdvisoryLockService`,
`src/common/services/advisory-lock.service.ts`) y omite su ciclo cuando otra réplica
lo tiene:

| Temporizador                   | Clave del lock           |
| ------------------------------ | ------------------------ |
| `SettlementObserverService`    | `SettlementObserver`     |
| `StellarObserverService`       | `PaymentIntentObserver`  |
| `RequestLogRetentionService`   | `RequestLogRetention`    |
| Sweeper de entregas de webhooks | `WebhookDeliverySweeper` |
| `PollarOauthSweeperService`    | `PollarOauthSweeper`     |
| `RateLimitPruneService`        | `RateLimitPrune`         |
| `PollarWalletProvisionSweeperService` | `PollarWalletProvisionSweeper` |
| `AliasChallengeSweeperService` | `AliasChallengeSweeper`  |

Se usa `pg_try_advisory_xact_lock` en lugar de la variante a nivel de sesión por tres
razones: nunca bloquea (una réplica que pierde simplemente omite el ciclo, que es lo
que necesita un proceso de sondeo), se libera cuando termina la transacción — incluso
ante una caída o una conexión perdida, por lo que un pod terminado no puede dejar el
lock trabado — y, por lo tanto, sigue siendo correcto detrás de PgBouncer en modo
transaction pooling, donde los locks a nivel de sesión no son seguros porque las
conexiones no son persistentes.

Los ids de lock están en el enum `AdvisoryLockKey` y son la identidad de la tarea:
renombrar un miembro con un número nuevo desactiva la exclusión en silencio, por lo
que los números retirados nunca se reutilizan.

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
  deja el estado sin cambios, de modo que todavía pueda enviarse una tx correcta; de
  lo contrario, el hash de cualquier transacción fallida de la red haría fallar una
  intención para siempre.
- **Automático (observador permanente):** `StellarObserverService` consulta Horizon
  cada `OBSERVER_INTERVAL_MS` en busca de intenciones `PENDING` — por el `txHash`
  reportado, o recorriendo los pagos al destino — y finaliza las coincidencias de la
  misma forma, de modo que los estados cambian y los eventos se disparan **sin que
  nadie llame a la API**. Un ciclo toma como máximo
  `OBSERVER_MAX_INTENTS_PER_CONSUMER` (10) intenciones por consumidor y nunca recorre
  una expirada, por lo que una avalancha de un solo consumidor — incluida la API key
  pública compartida — no puede dejar sin liquidar a todos los demás. Para
  desactivarlo en desarrollo local, usar `OBSERVER_ENABLED=false`.

### Retención de los logs de solicitudes de la API

Toda solicitud entrante, excepto `/v1/health` y `/docs`, se agrega a `request_log`
mediante `LoggingInterceptor` y alimenta la vista **API logs** del dashboard
(`GET /v1/logs`). Las filas incluyen ruta, status, duración y — cuando están
presentes — `ip` / `userAgent` del pagador.

El tráfico del dashboard (`X-Cosmos-Internal`) se **registra y se marca**
(`request_log.internal`), no se omite, y la vista de logs de la API filtra por esa
columna. Una versión anterior retornaba anticipadamente ante ese header, lo que
significaba que cualquiera capaz de establecerlo dejaba sus solicitudes completamente
fuera del log de auditoría — un header de solicitud nunca debe poder volver invisible
el tráfico.

Esas filas **no se conservan para siempre**. `RequestLogRetentionService` elimina las
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

`request_log` registra lo que llegó a este servicio. No puede registrar lo que un
cliente *hizo*: una wallet que se cerró inesperadamente en su pantalla de envío, una
firma que el usuario canceló, una página del dashboard que lanzó un error antes de que
cualquier solicitud saliera del navegador. Ninguno de esos casos produce una llamada
HTTP aquí, y son exactamente los eventos que vale la pena tener cuando algo sale mal
— por eso los clientes reportan los suyos a `POST
/v1/activity/events`.

- **Un lote, no una llamada por evento.** Los clientes encolan y luego vacían la
  cola, por lo que una wallet sin conexión conserva sus eventos y los envía en el
  siguiente inicio. Hasta `ACTIVITY_MAX_BATCH` (100) por solicitud, escritos en una
  sola sentencia.
- **Reintentar un envío es seguro.** Un evento puede incluir el `eventId` propio del
  cliente; `(consumerId, eventId)` es único y la inserción omite los duplicados, de
  modo que un lote que se escribió pero cuyo acuse de recibo nunca llegó puede
  reenviarse sin duplicar cada fila. La respuesta informa `accepted` y `duplicates`.
- **La atribución la da el gateway, nunca el cuerpo.** Las filas se escriben bajo el
  consumidor que APISIX autenticó. Un cliente no puede registrar eventos a nombre de
  otra cuenta, y no existe ningún campo que le permita intentarlo.
- **La ingesta no falla por la forma de un payload.** Un `message` demasiado largo se
  trunca y un `props` demasiado grande se reemplaza por `{"_dropped":
  "props_too_large"}`; un 400 costaría el lote completo, y el lote importa más cuando
  el cliente está en un estado que nadie anticipó.
- **Un reloj de dispositivo desajustado no puede reordenar el feed.** `occurredAt` se
  ajusta a la hora de recepción cuando está más de cinco minutos adelantado o más de
  siete días atrasado, de modo que un teléfono con una hora de adelanto no puede fijar
  sus eventos al principio de una lista ordenada de más reciente a más antiguo. Se
  conservan ambas horas: `at` (la del cliente) y `receivedAt`.

Consulta de los datos:

| Ruta                    | Scope             | Devuelve                                                             |
| ----------------------- | ----------------- | -------------------------------------------------------------------- |
| `GET /v1/activity/events` | `activity:read` | El feed, del más reciente al más antiguo. Filtros: `source`, `level`, `category`, `type` (prefijo), `network`, `since`/`until` |
| `GET /v1/activity/summary` | `activity:read` | Conteos por level/source/category, tipos de evento más frecuentes, errores más frecuentes, sesiones, dispositivos, una serie diaria |

`level` en el feed es un **mínimo**, no una coincidencia exacta: `level=warn` devuelve
advertencias *y* errores. Un filtro que devolviera solo las filas que alguien etiquetó
como `error` ocultaría las advertencias que llevaron a ellas.

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

**Qué contiene un cuerpo proveniente de BlindPay.** `RECEIVER_UPDATED` / `PAYIN_*` /
`PAYOUT_*` incluyen solo identidad y estado — ids, status, montos, rails — nunca datos
personales. El objeto del proveedor *no* se reenvía tal cual: el payload de un receiver
es un expediente KYC completo (identificación fiscal, fecha de nacimiento, dirección,
enlaces a documentos) y suscribirse a un evento solo requiere `webhooks:write`, lo que
convertiría al webhook en una forma de hacer llegar ese expediente a cualquier host.
Los detalles deben obtenerse de la API con una key que tenga `kyc:read` /
`onramp:read` / `offramp:read`. Ver `src/blindpay/blindpay-event-redaction.ts` para la
lista exacta de campos permitidos.

La entrega está desacoplada mediante `EventEmitter2` de NestJS (`webhook.event`), por
lo que emitir una notificación nunca bloquea la solicitud a la API que la originó.

**Política de destinos salientes (SSRF):** los endpoints deben usar `https` y
resolver solo a direcciones públicas. El registro rechaza loopback, rangos privados
RFC1918, link-local (`169.254.0.0/16`, incluido el endpoint de metadatos de la nube
`169.254.169.254`) y hostnames de metadatos conocidos. La misma verificación se
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

**El techo real de intentos es 9, no 3.** `WEBHOOK_MAX_ATTEMPTS` limita un bucle de
reintentos en proceso. Luego el sweeper toma las entregas que todavía están dentro de
`WEBHOOK_MAX_ATTEMPTS × 3` intentos totales, por lo que una entrega puede intentarse
hasta nueve veces, distribuidas a lo largo de horas. Es deliberado — un pod terminado
a mitad del backoff solía dejar varada para siempre una entrega PENDING, lo que
significaba un pago liquidado que no notificaba a nadie.

**El reenvío es best-effort dentro de la ventana de retención.** Después de
`WEBHOOK_PAYLOAD_RETENTION_DAYS` el cuerpo almacenado se borra (un cuerpo
`RECEIVER_UPDATED` es un expediente KYC, y el log de entregas se conserva). El sweeper
omite esas filas y `POST /v1/webhooks/:id/deliveries/:id/redeliver` devuelve
`409 payload_expired` en lugar de enviar un cuerpo redactado bajo un tipo de evento
real con una firma válida.

**Contrato del receptor.** Cualquier `2xx` confirma la recepción. Responder dentro de
`WEBHOOK_READ_TIMEOUT_MS` (5s por defecto). No hay garantía de orden, así que los
eventos deben tratarse como un conjunto y conciliarse con la API. Deduplicar por el
`id` del evento — hay que tener en cuenta que un reenvío reutiliza el `id` original,
por lo que un receptor que deduplica estrictamente lo ignorará; ese es el compromiso
buscado (entrega at-least-once, efecto exactly-once).

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

### OpenAPI / Swagger

**Nota de seguridad:** `GET /docs`, `/docs/json` y `/docs/yaml` se montan mediante
`SwaggerModule.setup` como **middleware de Express**, no como controllers de Nest.
**No** pasan por `ApisixGuard` ni por `PermissionsGuard` — cualquiera que pueda
alcanzar el puerto del servicio puede obtener la especificación completa de la API,
salvo que la documentación esté deshabilitada. En producción, la documentación está
**desactivada por defecto** (`NODE_ENV=production` y sin `SWAGGER_ENABLED`).
Establecer `SWAGGER_ENABLED=true` solo cuando se quiera publicar deliberadamente la
especificación en una red de confianza.

Documentación en vivo (cuando está habilitada):

- `GET /docs` — Swagger UI
- `GET /docs/json` — especificación OpenAPI 3.0 (JSON)
- `GET /docs/yaml` — especificación OpenAPI 3.0 (YAML)

Exportar la especificación a archivos (para que otro servidor pueda alojarla o
consumirla) no requiere conexión a una base de datos ni un secreto de gateway real; se
ejecuta en modo preview de Nest con valores de relleno locales cuando esas variables
de entorno no están definidas:

```bash
npm run openapi:generate
# writes openapi/openapi.json and openapi/openapi.yaml
```

CI y el gate de release regeneran ambos archivos versionados y rechazan divergencias.
Ejecutar la misma verificación antes de hacer commit de un cambio en un controller o
DTO:

```bash
npm run openapi:check
```

Las rutas de la especificación ya incluyen la versión (`/v1/...`). Para fijar un host
concreto del gateway en los `servers` de la especificación, establecer
`OPENAPI_SERVER_URL` antes de generarla:

```bash
OPENAPI_SERVER_URL=https://gateway.example.com npm run openapi:generate
```

La configuración de Swagger (`src/swagger.ts`) la comparten el servidor en ejecución
y el generador, por lo que ambos se mantienen sincronizados. Los dos headers de APISIX
(`X-Gateway-Secret`, `X-Consumer-Username`) están documentados como esquemas de
seguridad en la especificación.

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
llamadas a Horizon (construcción, validación, observador) apuntan a ella.

**El memo es un `MEMO_ID` obligatorio** — identifica el pago on-chain y le da
**idempotencia** a la intención: `(consumer, memo)` es único, por lo que volver a
crearla con el mismo memo **y los mismos términos** devuelve la intención original.
El mismo memo con cualquier término diferente — tipo, red, destino, monto, activo,
`msg`, `callback`, o `source` para `tx` — es `409 idempotency_conflict`, y el error no
dice nada sobre la intención almacenada. Esa comparación existe por la API key pública
compartida: todas las wallets anónimas son un único consumidor, así que sin ella un
memo que otra persona usó primero le entregaba a quien llamaba *la intención de esa
persona*, con un QR que le pagaba a ella. Si no se envía `memo`, se genera un uint64
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

Cada endpoint documenta una respuesta tipada con payloads de ejemplo en la
especificación OpenAPI (`TxPaymentIntentEntity`, `PayPaymentIntentEntity`,
`ValidationOutcomeEntity`), por lo que Swagger muestra una respuesta de ejemplo
concreta, no un cuerpo vacío.

Respuesta:

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

## La API key pública compartida

La wallet es de código abierto e incluye una API key que todos tienen, para que una
persona pueda hacer swaps, agregar liquidez o crear un enlace de pago sin registrarse.
Esas personas pagan la comisión del plan `community` — 150 bps, la tarifa más alta de
la tabla — y registrarse es lo que permite obtener una menor. El gateway inyecta la
tarifa por consumidor exactamente igual que para una key privada (ver
`resolvePlanCommissionBps`), por lo que nada del precio recibe un tratamiento especial
aquí.

Lo que *sí* es especial es el aislamiento entre tenants. Todo llamante anónimo de la
red llega como el mismo consumidor de APISIX, y los endpoints de lectura filtran las
filas precisamente por ese consumidor:

```ts
// swaps.service.ts
where: { id, consumer: { apisixUsername: consumer.username } }
```

Por lo tanto, `GET /v1/swaps` con la key pública le entregaría a cada usuario anónimo
el historial de swaps de toda la población anónima. Los scopes no pueden solucionarlo
— un scope es una propiedad de la key, y todos tienen la misma key — y la superposición
no es hipotética: `POST /v1/swaps/quote` requiere `swaps:read`, que es el mismo scope
que lista el historial.

**Por eso `PublicKeyGuard` es una allowlist, no una denylist.** Un consumidor público
es rechazado en toda ruta que no tenga `@AllowPublicKey()`, de modo que una ruta
agregada el año próximo es inaccesible para la key pública hasta que alguien indique
lo contrario en el mismo diff. Olvidar el decorador produce un ticket de soporte;
olvidar una entrada de la denylist produce una fuga de datos.

Accesible hoy con la key pública:

| Ruta | Por qué es seguro |
| --- | --- |
| `POST /v1/swaps/quote` | Cotiza un camino desde Horizon; es una función pura de la solicitud |
| `POST /v1/swaps` | Construye un envelope sin firmar que firma quien llama |
| `POST /v1/swaps/:id/submit` | Transmite un envelope firmado por quien llama — requiere el UUID del swap *y* una firma de su cuenta de origen |
| `POST /v1/liquidity-pools/deposit` \| `withdraw` | Construyen envelopes sin firmar |
| `POST /v1/liquidity-pools/operations/:id/submit` | Transmite un envelope firmado por quien llama |
| `GET /v1/liquidity-pools` \| `/:poolId` \| `/positions` | Datos públicos on-chain leídos desde Horizon |
| `POST /v1/payment-intents/tx` \| `pay` | Construyen una intención SEP-7 a partir de la solicitud |
| `POST /v1/activity/events` | Ingesta de telemetría — ver más abajo |
| `GET /v1/assets` | El catálogo público de activos |
| `GET /v1/aliases/resolve/:name` \| `availability/:name` \| `by-address/:address` | Un pagador que resuelve un identificador es precisamente el llamante anónimo para el que existe esta key; la respuesta es una función pura de la solicitud y nunca incluye el buzón del propietario |

Rechazadas, y deliberadamente: `GET /v1/swaps`, `GET /v1/swaps/:id`,
`GET /v1/liquidity-pools/operations{,/:id}`, `GET /v1/activity/events`,
`GET /v1/activity/summary`, toda lectura de intenciones de pago, toda ruta de
propietario de alias (reclamar, listar, agregar o quitar una dirección, liberar,
recuperar), y todo lo que está bajo `/v1/kyc`, `/v1/onramp`, `/v1/offramp` y
`/v1/webhooks`. Una wallet sin cuenta construye su historial desde Horizon, que de
todos modos es la fuente autoritativa de la actividad on-chain.

**La telemetría está en la lista a propósito.** Una wallet sin cuenta de CosmosPay
también falla, y rechazar sus reportes de error dejaría sin visibilidad justamente a
la población que se encuentra con fallas en el primer uso — la ruta de ingesta
respondería `403` y los reportes se descartarían. Los eventos que llegan con esta key
son anónimos por construcción (un único consumidor compartido), por lo que nada que
identifique una cuenta puede viajar con ellos; la wallet elimina dirección, destino,
monto y txHash antes de enviarlos.

El guard identifica al consumidor público por **cualquiera** de dos señales: el rol
reenviado (`X-Consumer-Role: public`) **o** el nombre de usuario configurado en
`APISIX_PUBLIC_CONSUMER`. Dos señales, porque cada una por separado falla en modo
abierto de una forma que cuesta datos de usuarios: un gateway que deja de reenviar
roles promovería a cada llamante anónimo a tenant ordinario, y un despliegue que nunca
definió la variable de entorno dependería de un header que no controla. Definir ambas.

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

**Idempotencia** opcional (issue #17): enviar un header `Idempotency-Key` (preferido)
o `idempotencyKey` en el cuerpo. Un reintento con la misma key **y la misma
solicitud** — red, origen, destino, ambos activos, monto, slippage y memo — devuelve
el swap **existente** (`id` + `txHash`) en lugar de construir otra transacción de
Stellar. La misma key con cualquier solicitud diferente es `409 idempotency_conflict`,
y el error no revela nada sobre el swap almacenado. Los depósitos y retiros de
liquidez siguen la misma regla, comparando además el tipo de operación. La comparación
existe por la API key pública compartida: todas las wallets anónimas son un único
consumidor, así que una key que otra persona usó primero le entregaba a quien llamaba
*el envelope sin firmar de esa persona* — uno que podía transferirle a ella los fondos
de quien llamaba. Sin key, la restricción única `(network, txHash)`
igualmente rechaza una reconstrucción idéntica byte a byte con **409** (colisión de
secuencia / XDR). Cuando `STELLAR_SWAP_SINGLE_INFLIGHT=true`, un segundo swap
`PENDING` no expirado para el mismo `(consumer, source, network)` también devuelve
**409** indicando el id existente (por defecto **desactivado** — los swaps
concurrentes distintos desde una misma cuenta siguen estando permitidos).

```jsonc
// response → { id, status: "PENDING", network, sendAmount, feeAmount, swapAmount,
//              destEstimated, destMin, path, xdr, uri: "web+stellar:tx?xdr=…", qr, txHash, … }
```

**`POST /v1/swaps/:id/submit`** — retransmite el envelope firmado (`swaps:write`).

```jsonc
// request
{ "signedXdr": "AAAAAgAAA…(signed base64 XDR)…" }
// response
{ "submitted": true, "status": "SUCCEEDED", "txHash": "…", "swap": { … } }
// on a network rejection → { "submitted": false, "status": "FAILED", "reason": "…", "resultCodes": ["op_under_dest_min"], "swap": { … } }
```

Antes de transmitirla, el hash de la transacción firmada se verifica contra el de la
transacción que construyó el servicio, por lo que quien llama nunca puede lograr que
el servicio retransmita una transacción arbitraria. Un swap dispara los eventos de
webhook `SWAP_CREATED` / `SWAP_SUBMITTED` / `SWAP_SUCCEEDED` / `SWAP_FAILED` a través
del mismo dispatcher.

## Alias — identificadores de pago reclamables

Un alias permite que un pagador escriba `emanuel250` en lugar de `GA5ZSE…`. También es
lo que un pagador lee inmediatamente antes de autorizar una transferencia, por lo que
cada regla de abajo existe porque equivocarse no produce una fila incorrecta — produce
un pago a la cuenta equivocada bajo un nombre en el que el pagador confiaba.

### Se reclama demostrando el control de una clave, no pidiéndolo

```
wallet ──1. POST /v1/aliases/challenges {name, address, network} ──▶ nonce + the EXACT message to sign
wallet ──2. signs SHA-256(domain ‖ 0x00 ‖ uint32be(length) ‖ message) with that address's key
wallet ──3. POST /v1/aliases {name, email, nonce, signature} ────────▶ alias bound to the calling consumer
```

- **El servicio devuelve el mensaje; el cliente nunca lo reconstruye.** Un cliente que
  lo arma a partir de la documentación está a un cambio en el orden de los campos de
  producir firmas que se rechazan sin que nada, de ninguno de los dos lados, explique
  por qué.
- **La firma cubre un digest etiquetado con un dominio, nunca una transacción.** Nada
  de lo que este flujo le pide firmar a una wallet puede enviarse a la red, y el
  dominio (`Cosmos Pay alias claim v1`) pertenece solo a esta funcionalidad, por lo que
  una dapp que convence a un usuario de firmar un mensaje arbitrario no puede obtener
  con eso un reclamo válido.
- **El propósito está dentro de los bytes firmados** (`CLAIM`, `ADD_ADDRESS`,
  `RECOVER`), por lo que una firma obtenida para agregar una dirección no puede
  reutilizarse para completar una recuperación.
- **La dirección proviene del desafío, no del cuerpo del reclamo.** El reclamo no
  tiene campo de dirección, así que nadie puede firmar con una dirección y registrar
  otra.
- **Los desafíos son de un solo uso y duran cinco minutos.** La firma se verifica
  *antes* de consumir el desafío, por lo que una firma basura no puede quemar el nonce
  en curso de un rival, y consumirlo es un compare-and-swap, por lo que dos solicitudes
  no pueden consumir ambas el mismo.
- **Una carrera se resuelve con el índice único sobre `alias.name`**, no con una
  verificación previa; el perdedor recibe `409 alias_taken`.

### Qué puede ser un identificador

`a-z` en minúsculas, `0-9` y `_` (nunca en los extremos), 3–32 caracteres, convertido
a minúsculas antes de decidir la unicidad. Sin Unicode: el conjunto de homoglifos no
tiene límite, y ninguna normalización hace seguro mostrar una `а` cirílica junto a un
monto. También se rechazan las palabras reservadas que suplantarían al producto o a un
operador (`admin`, `support`, `cosmospay`, `stellar`, …) y cualquier cosa que parezca
una cuenta de Stellar (`g` o `m` seguida de 20 o más caracteres base32). La regla está
en `src/aliases/alias-name.ts`.

### Muchas direcciones, un solo nombre

Un alias apunta a hasta 20 direcciones en distintas redes — un teléfono, una
computadora de escritorio, una cold wallet, testnet — con exactamente una principal
por red, garantizado por un índice único parcial. Agregar una dirección requiere
**dos** pruebas: que quien llama es propietario del alias, y que la nueva dirección
firma su propio desafío `ADD_ADDRESS`. La última dirección restante no puede
eliminarse (en su lugar, se libera el alias), y un consumidor puede tener como máximo
25 alias.

Un alias `SUSPENDED` — una retención impuesta por un operador — no resuelve a nada.
Una suspensión que sigue entregando una cuenta no hace nada respecto del dinero.

### La recuperación pasa por el correo electrónico y por la consola de la plataforma

Las claves se pierden, y una clave perdida no debe dejar un nombre inaccesible para
siempre, así que un reclamo registra un buzón de recuperación. Eso convierte a la
recuperación en el camino más peligroso del módulo:

1. La **consola de la plataforma** llama a `POST /v1/aliases/:name/recovery {email}`.
   La respuesta es idéntica coincidan o no el identificador y el buzón; si coinciden,
   incluye un token de un solo uso (30 minutos, almacenado solo como SHA-256), que la
   consola envía por correo. Este servicio no envía correos.
2. El usuario obtiene un desafío `RECOVER` para la nueva clave y llama a
   `POST /v1/aliases/:name/recovery/complete {token, address, network, nonce, signature}`
   con su propia API key. Se requieren ambas pruebas: el token demuestra el buzón y la
   firma demuestra la clave.
3. La propiedad pasa al consumidor que llama y **se eliminan todas las direcciones
   anteriores**. La recuperación existe porque las claves antiguas se perdieron, y
   dejarlas resolubles haría que quien las tenga siguiera recibiendo los pagos.

**Por qué el paso 1 pertenece a la consola.** El token *es* la prueba de control del
buzón, por lo que solo puede llegar a la parte que entrega el correo. Antes, la ruta
aceptaba cualquier key con `payments:write` y devolvía el token a quien lo pidiera —
así, cualquiera que conociera un identificador y el correo de su propietario podía
quedarse con el alias, y con cada pago enviado a él. `ConsoleOnlyGuard` ahora rechaza
a todo llamante con API key con `403 admin_console_only` antes siquiera de buscar el
alias, y la ruta se mantiene fuera del contrato publicado. Cinco tokens incorrectos
invalidan una recuperación (el propietario simplemente inicia otra; un atacante no
puede bloquear un nombre fallando a propósito), y un alias suspendido no puede
recuperarse.

`AliasChallengeSweeperService` elimina los desafíos y las recuperaciones expirados un
día después de su expiración (cada hora, una réplica por ciclo).

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

Además de las intenciones de pago on-chain, el servicio integra
[BlindPay](https://www.blindpay.com/docs) para mover dinero entre **fiat y
stablecoins**: ingreso de dinero (**onramp / payin**), retiro de dinero (**offramp /
payout**) y el **KYC** obligatorio (los *receivers* de BlindPay) que respalda a ambos.
Se ejecuta una **única instancia de BlindPay de la plataforma** (`BLINDPAY_API_KEY` +
`BLINDPAY_INSTANCE_ID` en el entorno); cada receiver/wallet/cuenta bancaria/payin/payout
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
| PATCH  | `/v1/kyc/receivers/:id`                               | `kyc:write`    | Actualizar un receiver |
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
y establecer `BLINDPAY_WEBHOOK_SECRET` con el secreto de firma de ese endpoint. Dejar
vacías las variables `BLINDPAY_*` desactiva la funcionalidad: esas rutas devuelven
entonces `503` `misconfigured`, igual que el webhook entrante mientras
`BLINDPAY_WEBHOOK_SECRET` no esté definido. Ver `.env.example`.

### Las URL de redirección de KYC se validan contra una lista de permitidos por consumidor

El flujo de términos de servicio envía al usuario a BlindPay y luego de vuelta a una
`redirect_url` que proporciona el integrador. Aceptada como texto libre, sería una
redirección abierta con el nombre de la plataforma: un enlace que empieza en una
página de KYC de confianza y termina donde un atacante haya elegido. Por eso cada
`redirect_url` pasa por dos capas:

| Capa | Regla | Dónde |
| ---- | ----- | ----- |
| Forma | una URL `https` absoluta sin credenciales incrustadas (`user:pass@`) | `@IsRedirectUrl()` en cada DTO que incluye una |
| Host | en la lista de permitidos **del consumidor que llama** — el host exacto, o un subdominio en un límite de etiqueta (`app.acme.com` coincide con `acme.com`; `evilacme.com` no) | `KYC_REDIRECT_URL_WHITELIST`, aplicada en la capa de servicio |

```
KYC_REDIRECT_URL_WHITELIST={"cosmos_acme":["acme.com","app.acme.com"]}
```

**Falla en modo cerrado**: un consumidor sin entrada no puede usar ninguna
redirección, y un host con un punto al final o en forma IDN se rechaza en lugar de
normalizarse. La lista es por consumidor porque un dominio que avala un integrador no
dice nada sobre otro. Cada punto de entrada que recibe una `redirect_url` la verifica
— iniciar, solicitar y aprobar los términos de servicio, incluida la aprobación desde
administración, que aplica la lista del consumidor al que pertenece el receiver. Un
esquema o un host rechazado es un `400`.

## Pollar — inicio de sesión social que entrega una wallet de Stellar

[Pollar](https://docs.pollar.xyz/docs) convierte un inicio de sesión con Google/GitHub
en una cuenta de Stellar: autentica al usuario, crea una wallet, custodia la clave en
AWS KMS, agrega las trustlines configuradas y fondea la reserva — el usuario nunca ve
una frase semilla. Este servicio lo expone como un **puente OAuth**, la misma forma que
usa un launcher de juegos o una consola cuando el cliente completa localmente el
intercambio del código.

### Por qué un puente y no un passthrough

El login alojado de Pollar está diseñado para un SDK de navegador. Envía al usuario a
`GET /auth/{provider}` con una publishable key, un id de sesión de cliente y una
`redirect_uri` — y esa URI de redirección debe ser un host **registrado en Pollar**.
Una wallet no puede cumplir nada de eso: un listener de loopback en un puerto efímero
o un deep link `cosmospay://` nunca puede ser un host registrado, y el armado de la
solicitud requiere claves e ids de sesión que la wallet no debería manejar.

Por eso el puente se encarga de la mitad que interactúa con Pollar. La wallet recibe
un contrato de dos pasos que ya entiende — **abrir una autorización, canjear un
código** — y no recibe nada más que ese código.

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

El paso 6 es el objetivo de todo esto: la respuesta del canje también incluye la
`publishable_key` y `api_base_url`, de modo que a partir de ahí la wallet consulta
saldos, construye y envía transacciones directamente contra la propia wallet virtual.
**Este servicio nunca hace de proxy de esa superficie y no guarda ninguna clave que
pudiera hacerlo.**

### Dos formas de recibir el código

|                  | Flujo de redirección                             | Flujo de sondeo                                 |
| ---------------- | ------------------------------------------------ | ----------------------------------------------- |
| La wallet proporciona | `redirect_uri` (debe estar en la lista de permitidos) | nada                                   |
| El código llega  | como `?code=…&state=…` en la redirección         | desde `GET /v1/pollar/oauth/sessions/{state}`   |
| El navegador ve  | la URI propia de la wallet                       | una página simple de "ya puede cerrar esta ventana" — nunca el código |
| Conviene usarlo cuando | la wallet tiene un deep link o un listener de loopback | no tiene ninguno de los dos (kiosco, headless, vista embebida) |

Cada sondeo emite un código nuevo y retira el anterior, así que se debe canjear el
código del sondeo más reciente. Eso se desprende de no almacenar nunca una credencial
vigente: la fila guarda un SHA-256 del código, y un hash no puede revertirse.

**Preferir el flujo de sondeo.** Pollar no devuelve el navegador al callback: su flujo
alojado termina en su propia página — `www.pollar.xyz/auth/status` — tanto si el
consentimiento se rechazó como si se otorgó, y uno otorgado simplemente deja la sesión
de cliente en `READY` del lado de Pollar. Nunca se navega a la `redirect_uri` que
incluye la URL de autorización, por lo que un handshake que espera a que lo llamen de
vuelta espera hasta expirar.

Por eso la ruta de sondeo le pregunta a Pollar en lugar de esperar a que le avisen:
mientras un handshake está en `pending`, consulta el estado de la propia sesión de
cliente y promueve el handshake en el momento en que Pollar informa `READY` — la misma
condición que el canje ya espera. El contrato de la wallet no cambia; lo que cambió es
que `pending` ahora termina por sí solo.

De eso se desprenden dos notas operativas:

- **La ruta de callback sigue existiendo y sigue registrada en Pollar.** Funciona si
  llega una redirección, y es de la que depende un handshake con flujo de redirección
  — ese flujo no tiene otro lugar donde dejar un código. Simplemente no puede ser la
  única forma de detectar un inicio de sesión.
- **Al proveedor se le consulta como máximo una vez cada dos segundos por handshake**
  (`POLLAR_SESSION_PROBE_INTERVAL_MS`), mediante un compare-and-swap sobre
  `providerCheckedAt` que comparten todas las réplicas. Por lo tanto, una wallet que
  sondea cada segundo le cuesta a Pollar 30 solicitudes por minuto, no 60, contra una
  key cuyo presupuesto total es 200.

Un handshake cuya sesión de cliente Pollar ya no reconoce (`INVALID_CLIENT_SESSION_ID`,
`EXPIRED_CLIENT_ID`, o un `404`/`410`) se cierra en el acto como `failed` con ese
código, en lugar de seguir sondeándose hasta que venza el TTL.

### Un inicio de sesión, una wallet en ambas redes

Pollar opera mainnet y testnet como dos aplicaciones separadas con dos pares de claves
separados, por lo que un login alojado solo puede producir una wallet en la red a la
que resolvió su API key (`prod` → `public`, `dev` → `testnet` — ver `resolveNetwork`).
Un usuario que luego se mueve entre entornos no tiene wallet del otro lado: la
dirección que fondeó en testnet no es la dirección que recibe en mainnet, y la segunda
wallet termina creándose en el momento en que la necesita por primera vez, que es el
momento menos capaz de absorber una falla del proveedor.

Por eso un canje también registra al usuario en la **otra** red, mediante el
`POST /users/with-wallet` de la Server API, y `POST /v1/pollar/oauth/token` informa
ambas:

```jsonc
"network_wallets": [
  { "network": "testnet", "status": "ready",   "address": "GA5Z…" },
  { "network": "public",  "status": "pending", "address": null    }
]
```

**Una entrada `pending` no es un error.** El inicio de sesión se completó; la segunda
wallet es la parte que todavía no está lista, y el sentido del diseño es precisamente
que no pueda hacer fallar el inicio de sesión. El intento dentro de la solicitud
dispone de cinco segundos y una sola oportunidad, y lo que no alcance a terminar lo
reintenta en segundo plano el sweeper de aprovisionamiento — con el mismo interruptor y
la misma cadencia que el sweeper de handshakes (`POLLAR_SWEEP_*`), con backoff
exponencial y un presupuesto total de diez intentos antes de que la fila pase a
`failed`.

La razón habitual de `pending` es prosaica: **las claves de la otra red no están
configuradas.** Hasta que lo estén, cada inicio de sesión deja una contraparte
pendiente; en cuanto se configuran, un solo barrido aprovisiona todo lo acumulado sin
que nadie tenga que volver a iniciar sesión. Por eso vale la pena configurar las claves
de ambas redes incluso cuando hoy solo se atiende una.

Dos consecuencias que conviene conocer:

- **La clave de unión es el correo de OAuth**, porque es con lo que un login alojado
  posterior en la otra red identifica a la misma persona. Un proveedor que no avala
  ningún correo no obtiene wallet de contraparte — mejor eso que una wallet huérfana
  que costó XLM y a la que ningún inicio de sesión llega nunca.
- **Gasta XLM en ambas redes.** Un inicio de sesión en mainnet ahora también fondea
  una reserva en testnet, y viceversa. El estado por red vive en `pollar_user_wallet`,
  una fila por (consumer, email, network), que es también la idempotencia: un inicio de
  sesión repetido hace upsert sobre ella en lugar de volver a aprovisionar.

### Qué almacena el puente

Una fila de handshake, y nada en ella puede gastar dinero: el `state` imposible de
adivinar, el id de sesión de cliente de Pollar, un **hash** del código y la dirección
pública de Stellar resultante. **Nunca se persiste ningún token de Pollar** — el
intercambio `/auth/login` se ejecuta dentro de la solicitud de canje y los tokens salen
directamente en su respuesta. Los handshakes que nadie completó se expiran mediante un
temporizador (`POLLAR_SWEEP_*`), porque una fila `AUTHORIZED` es un código canjeable
hasta que se barre.

Cada transición es un compare-and-swap sobre el estado de la fila, por lo que un
callback repetido no emite un segundo código, y dos wallets que compiten por un mismo
código no pueden ganar ambas.

### Medidas de endurecimiento que conviene conocer

- **PKCE (RFC 7636, S256)** es opcional pero recomendado: enviar `code_challenge` al
  autorizar y `code_verifier` al canjear; así, un código que se filtre desde un
  navegador o un log es inútil sin el verifier.
- **`dpop_jwk`** vincula los tokens que emite Pollar a la propia clave P-256 de la
  wallet (RFC 9449), por lo que un access token robado es inerte sin una prueba
  firmada. También significa que el puente ya no puede actuar en nombre de la wallet —
  `/refresh` y `/logout` atienden sesiones bearer, y una wallet vinculada con DPoP
  llama a Pollar directamente.
- **`POLLAR_REDIRECT_URI_WHITELIST`** es por consumidor y falla en modo cerrado. Una
  URI de redirección es donde aterriza un código de un solo uso, por lo que una no
  validada es un canal de exfiltración. Acepta hosts de loopback (cualquier puerto,
  según RFC 8252), deep links con esquema de uso privado y hosts https.
- **Mantener en un servidor las API keys que tienen `pollar:*`.** El flujo de sondeo
  entrega el código a quien tenga el `state` del handshake *y* una key con
  `pollar:read`. Un atacante que extraiga una key así de una app distribuida a usuarios
  puede abrir un inicio de sesión, enviar su `authorization_url` a una víctima,
  sondear hasta obtener el código una vez que la víctima da su consentimiento en la
  página real de Google/GitHub, y canjearlo con un verifier PKCE propio — PKCE y
  `dpop_jwk` no ayudan, porque el atacante proporciona ambos. Es el patrón de phishing
  de device code, y la defensa es que la key nunca salga de un backend bajo control
  propio.

### Rutas

| Método | Ruta                                                  | Scope          | Descripción |
| ------ | ----------------------------------------------------- | -------------- | ----------- |
| POST   | `/v1/pollar/oauth/authorize`                          | `pollar:write` | Abrir un inicio de sesión → `authorization_url` + `state` |
| GET    | `/v1/pollar/oauth/callback/:state`                    | _público_      | Adonde Pollar devuelve el navegador (una navegación — no hay key que enviar) |
| GET    | `/v1/pollar/oauth/callback?state=`                    | _público_      | El mismo callback, para una cadena de redirecciones que conserva la query pero no el path |
| GET    | `/v1/pollar/oauth/sessions/:state`                    | `pollar:read`  | Sondear un handshake y obtener su código |
| POST   | `/v1/pollar/oauth/token`                              | `pollar:write` | Canjear el código → sesión de Pollar + wallet |
| POST   | `/v1/pollar/oauth/refresh`                            | `pollar:write` | Rotar un par de tokens (sesiones bearer) |
| POST   | `/v1/pollar/oauth/logout`                             | `pollar:write` | Revocar una sesión (la de este dispositivo, o todas) |
| POST   | `/v1/pollar/wallets/activate`                         | `pollar:write` | Fondear la reserva de XLM (modo de fondeo Deferred) |
| POST   | `/v1/pollar/wallets/:address/trustlines/default`      | `pollar:write` | Habilitar los activos configurados de la app |
| POST   | `/v1/pollar/wallets/:address/trustlines`              | `pollar:write` | Habilitar activos específicos |
| DELETE | `/v1/pollar/wallets/:address/trustlines/:code/:issuer`| `pollar:write` | Eliminar una trustline (solo con saldo cero) |
| POST   | `/v1/pollar/users` · `/v1/pollar/users/with-wallet`   | `pollar:write` | Registrar un usuario, opcionalmente con una wallet |
| POST   | `/v1/pollar/tokens/verify`                            | `pollar:read`  | Validar un token que una wallet presentó al integrador |

Las últimas seis requieren la clave **secreta** de Pollar, que es justamente la razón
por la que están aquí y no en la wallet. Los esquemas de solicitud y respuesta de
todas ellas están en el contrato generado — Swagger UI en `/docs`, u
`openapi/openapi.{json,yaml}`. La tabla de arriba sirve para orientarse; el contrato
es la fuente de verdad.

### Rate limiting: qué impide abusar de la generación de wallets

Crear una wallet de Pollar no es gratis. Pollar crea la cuenta de Stellar, fondea su
reserva base (1 XLM) y agrega una trustline por cada activo configurado (0.5 XLM cada
una) — **con fondos de la propia wallet de fondeo**. Por lo tanto, un bucle contra el
flujo de inicio de sesión es una forma de que un desconocido gaste ese dinero, y no
necesita un usuario real del otro lado para hacerlo.

Por eso los límites viven aquí, en este servicio, y no solo en el gateway: este es el
proceso que sabe que una solicitud está a punto de crear una cuenta, y es el que puede
rechazarla antes de que salga el XLM.

**El punto de control es `authorize`, no `token`.** Un handshake produce como máximo
una wallet, por lo que limitar cuántos handshakes puede abrir una dirección limita
cuántas wallets puede generar. `token` se mantiene deliberadamente más laxo, porque la
respuesta 409 le indica a quien llama que reintente exactamente esa solicitud mientras
Pollar aprovisiona la cuenta — un presupuesto ajustado ahí frenaría el propio
reintento documentado, y canjear no crea nada que el handshake no hubiera permitido
ya.

| Ruta | Presupuesto (por 10 min) | Por qué ese número |
| ----- | ------------------- | --------------- |
| `POST /v1/pollar/oauth/authorize` | 20 | El límite de generación de wallets. Muy por encima de una persona que reintenta una pantalla de consentimiento fallida, muy por debajo de un ritmo que vacía una cuenta |
| `POST /v1/pollar/oauth/token` | 60 | Laxo a propósito — ver arriba |
| `GET /v1/pollar/oauth/callback` | 60 | La única ruta accesible sin API key, y por lo tanto la única a la que puede llegar una avalancha anónima. Que un usuario recargue la pestaña es normal |
| `POST /v1/pollar/users/with-wallet` | 10 | Crea una wallet sin una pantalla de consentimiento que marque el ritmo — el presupuesto más ajustado del conjunto |
| `POST /v1/pollar/wallets/activate` | 20 | Gasta XLM en cada llamada, pero no puede crear nada nuevo |

Superar uno devuelve **`429` con `code: "rate_limited"`**, un `Retry-After` y el trío
`RateLimit-Limit` / `-Remaining` / `-Reset`. Todo lo demás en el servicio no tiene
límite aquí; el control general del tráfico es tarea de APISIX, que ve la solicitud
antes que este proceso.

**El contador está en Postgres, no en memoria.** El servicio corre detrás de un
balanceador de carga, por lo que un limitador por proceso le daría a cada réplica el
presupuesto completo: el límite efectivo pasa a ser `limit × replicas` y cambia en
silencio cada vez que el despliegue escala. Eso está bien para un throttle cosmético,
pero no para algo que protege un saldo real. Es una ventana fija — un
`INSERT … ON CONFLICT … RETURNING` atómico por solicitud — lo que significa que un
cliente puede gastar un presupuesto completo a cada lado del límite entre ventanas, así
que los números de arriba deben leerse como "como máximo el doble de esto por ventana".
Están definidos teniendo eso en cuenta.

**Cómo se determina la dirección, y por qué no puede falsificarse.** `main.ts`
establece `trust proxy` en `1`, lo que hace que Express lea la entrada *más a la
derecha* de `X-Forwarded-For` — la que agregó APISIX, es decir, el par tal como lo vio
el gateway. Un cliente puede anteponer entradas a ese header, pero todo lo que escribe
queda a la izquierda de la entrada de APISIX y se ignora.

> **No aumentar `trust proxy`.** Con `2`, Express empieza a aceptar el primer salto
> proporcionado por el cliente, y cada límite de aquí se vuelve evadible agregando un
> header. `src/common/client-ip.spec.ts` fija ambos comportamientos para que el cambio
> no pueda pasar la revisión inadvertido.

Un llamante IPv6 se agrupa por **/64**, no por dirección: a un cliente se le asigna
habitualmente un /64 completo y puede rotar dentro de él sin costo, por lo que limitar
por dirección ahí no es limitar. El costo es que dos usuarios detrás de un mismo /64
comparten un bucket, exactamente como ya ocurre con dos usuarios detrás de un mismo
NAT IPv4. Los buckets también se indexan por consumidor, por lo que el tráfico de un
integrador no puede consumir el de otro.

Si el contador no puede escribirse, el limitador **falla en modo cerrado** (`503`). Un
limitador que deja de limitar en silencio durante un incidente de base de datos vale
menos que ninguno, porque nada avisa que ocurrió — y cada ruta detrás de él necesita
la misma base de datos de todos modos, así que rechazar no cuesta ninguna
disponibilidad que no se hubiera perdido ya.

Establecer `RATE_LIMIT_ENABLED=false` como interruptor de incidentes.

### Configuración

1. Crear una app en [dashboard.pollar.xyz](https://dashboard.pollar.xyz) y obtener
   ambas claves de la red correspondiente (`pub_testnet_…` / `sec_testnet_…`). Hacerlo
   para **ambas** redes: un inicio de sesión aprovisiona una wallet en cada una, y una
   red sin claves deja la segunda wallet de cada usuario en `pending` hasta que se
   configuren. Los dos dashboards son independientes — registrar el host del callback
   en cada uno.
2. Registrar el **host del gateway** de `POLLAR_BRIDGE_CALLBACK_URL` en
   **Build → Domains**. No se trata solo de la redirección: la SDK API verifica esa
   lista en *cada* llamada, contra el header `Origin`, y el puente envía el origin de
   este host como ese header (`POLLAR_SDK_ORIGIN` lo sobrescribe). Un host no
   registrado produce `403 ORIGIN_NOT_ALLOWED` en `POST /auth/session` — la primera
   llamada de cada inicio de sesión, antes de que el usuario llegue a ver una pantalla
   de consentimiento.
3. Establecer `POLLAR_BRIDGE_CALLBACK_URL` en `<gateway>/v1/pollar/oauth/callback` —
   el puente agrega `/{state}` por su cuenta.
4. Agregar la URI de redirección de cada wallet a `POLLAR_REDIRECT_URI_WHITELIST`, u
   omitirla y usar el flujo de sondeo.

Las claves son por red, y Pollar codifica la red y el tipo de clave en el prefijo, por
lo que una discrepancia es un rechazo definitivo — el validador de entorno lo detecta
en el arranque en lugar de en un inicio de sesión frente al usuario. Dejar las claves
vacías desactiva la funcionalidad (las rutas de Pollar devuelven entonces `503`). Ver
`.env.example`.

## Actualización — cambios incompatibles y notas de despliegue

### Correcciones de la revisión de seguridad

Una revisión de todo el servicio encontró los problemas que se detallan abajo. Cada uno
está corregido y cubierto por una prueba que falla sin la corrección. La mayoría no
cambia nada para un llamante que se comporta correctamente, pero cada fila es visible
para alguien — leer la columna "Quién lo nota" antes de desplegar.

| Cambio | Quién lo nota | Por qué |
| ------ | ------------- | ------- |
| `POST /v1/aliases/:name/recovery` es **solo para la consola de la plataforma**: una API key recibe `403 admin_console_only`, y la ruta salió del contrato publicado | Quien iniciaba recuperaciones con una API key | La respuesta incluye el token de recuperación, que es la prueba del buzón del propietario. Protegida solo por un scope, cualquiera que conociera un identificador y el correo de su propietario recibía el token y podía quedarse con el alias y con cada pago enviado a él |
| Completar una recuperación sobre un alias `SUSPENDED` es un `404` | Nadie legítimo | Un token emitido antes de una suspensión era una forma de escapar de la retención impuesta por el operador |
| Las rutas `@Public()` (callback de Pollar, webhook de BlindPay, health) ignoran `X-Consumer-Username` | Dashboards: esas solicitudes ahora se registran como anónimas | Esas rutas se ejecutan sin key-auth, así que el header lo ponía el propio cliente: un nombre nuevo por solicitud era un presupuesto de rate limit nuevo, y nombrar a una víctima registraba filas falsificadas en su vista de logs de la API |
| Los rechazos de `AdminGuard` y `ConsoleOnlyGuard` se registran en nivel `warn` | Operadores | Los guards se ejecutan antes del log de acceso, así que un sondeo de `/v1/admin` no dejaba rastro en ningún lado |
| `POST /v1/pollar/wallets/activate` y las tres rutas `/v1/pollar/wallets/:address/trustlines…` devuelven `404` para una wallet que el consumidor que llama no obtuvo a través de este servicio en esa red | Integradores que operan sobre wallets que solo vieron mediante `tokens/verify`, sobre wallets no principales de un inicio de sesión, o sobre una wallet de contraparte que otro tenant ya registró | Todos los tenants comparten un mismo juego de claves secretas de Pollar, así que sin esta verificación un tenant podía eliminar las trustlines de los usuarios de otro tenant o gastar el XLM del operador en sus reservas. Una wallet ajena y una desconocida reciben el mismo `404`, por lo que la respuesta no sirve como oráculo de propiedad |
| Ambas rutas `POST …/trustlines` comparten un presupuesto de `429` de 20 llamadas cada 10 minutos | Scripts que agregan trustlines de forma masiva | Cada trustline inmoviliza 0.5 XLM de reserva de la wallet de fondeo del operador, y estas eran las únicas rutas que gastan XLM sin límite |
| `GET /v1/offramp/payouts/:id` ya no devuelve `raw`, `consumerId`, `receiverId`, `quoteId`, `bankAccountId` ni `updatedAt`; la respuesta de creación de una cuenta virtual ya no devuelve `raw`, `receiverId`, `consumerId` ni `updatedAt` | Quienes leen esos campos | `raw` es el objeto almacenado de BlindPay, con datos bancarios y del beneficiario, y llegaba a cualquier key con `offramp:read` — esa ruta de lectura ignoraba la proyección pública que usan todas las demás lecturas de payouts |
| `POST /v1/kyc/upload` devuelve `400` ante más de 4 campos de texto, un campo de más de 1 KiB, un segundo archivo, o bytes de archivo que no coinciden con el tipo declarado | Nadie que envíe una carga bien formada | Los valores por defecto de Multer dejaban los campos sin límite y de hasta 1 MB cada uno en memoria, y la verificación de tipo confiaba en el `Content-Type` del cliente |
| `POST /v1/payment-intents/tx` y `/pay`: el mismo memo con cualquier término diferente es `409 idempotency_conflict`. Un reintento idéntico sigue devolviendo la intención almacenada (`2` y `2.0` son el mismo monto) | Quienes reutilizan un mismo memo para pagos distintos | Con la API key pública compartida, todas las wallets anónimas son un único consumidor, por lo que un memo que otra persona creó primero devolvía *su* intención — con un QR que le pagaba a ella |
| `POST /v1/payment-intents/:id/validate` marca `FAILED` solo ante una tx fallida que sea el pago propio de esta intención; cualquier otra tx fallida es `valid: false` con el estado sin cambios. Una tx que se cerró más de 60 s antes de crearse la intención se rechaza ("Transaction predates this payment intent") — en validate, en `PATCH {status: SUCCEEDED}` y en el observador | Nadie legítimo | El hash de cualquier transacción fallida de la red hacía fallar una intención de forma permanente, y un pago antiguo con los mismos términos podía liquidar una intención nueva |
| `PATCH /v1/payment-intents/:id` que cambia `txHash` en una intención en estado terminal es `400 invalid_state_transition`; un cambio de estado que compite con esa escritura es `409 operation_in_flight` | Nadie legítimo | Reescribía la evidencia de liquidación de una intención `SUCCEEDED` |
| El observador de intenciones de pago concilia como máximo 10 intenciones por consumidor en cada ciclo y nunca recorre filas expiradas | Operadores que monitorean el throughput del observador | Una avalancha de intenciones de monto abierto de un solo consumidor dejaba sin liquidar a todos los demás tenants y consumía el presupuesto compartido de Horizon |
| `POST /v1/swaps`, `/v1/liquidity-pools/deposit` y `/withdraw`: un `Idempotency-Key` reutilizado con una solicitud diferente — otro memo u otro slippage, la otra red, o una key de depósito reutilizada para un retiro — es `409 idempotency_conflict`. Un replay con un activo, slippage o memo inválido ahora recibe el `400` normal | Clientes que reutilizan una misma key para operaciones distintas | Con la API key pública compartida, un atacante podía crear de antemano, bajo una key adivinable, un swap o un retiro desde la cuenta de una víctima hacia la suya, y el reintento de la víctima le devolvía ese envelope para que lo firmara |
| `POST /v1/liquidity-pools/withdraw` ya no responde `409 operation_in_flight` ante un retiro en curso cuyo número de secuencia la cuenta todavía no usó (un envelope sin firmar o abandonado) | Usuarios de wallets que quedaban bloqueados | Un retiro de monto ínfimo construido para la cuenta de otra persona y reenviado cada 300 s impedía a todos los usuarios de la key pública retirar esa posición. Los dos envelopes comparten número de secuencia, por lo que como máximo uno de ellos puede liquidarse |
| El observador de liquidaciones toma como máximo 10 filas por consumidor por tabla en cada ciclo, y `GET /v1/liquidity-pools/positions` lee Horizon mediante un único listado paginado en lugar de una solicitud por pool | Operadores | La avalancha de un solo consumidor dejaba sin liquidar a todos los demás, y una cuenta con participaciones en muchos pools disparaba llamadas a Horizon sin límite |
| `GET /v1/onramp/payins/:id` ya no devuelve `receiverId` ni `updatedAt` — la misma forma que devuelve `GET /v1/onramp/payins` | Quien lea esos dos campos en la lectura de un solo payin | Un payin con una fila espejo reciente se devolvía tal como estaba almacenado, así que el mismo payin llegaba con dos formas según la antigüedad de su espejo, una de ellas con un id interno |
| `POST /v1/kyc/upload` con un archivo de más de 10 MiB es `413` con `code: "payload_too_large"`; antes era `internal_error` | Integradores que ramifican según `code` | Un límite que quien llama puede respetar se leía como un bug de este servicio |
| `POST /v1/liquidity-pools/deposit`, `/withdraw`, `GET /v1/liquidity-pools/operations`, `/operations/:id`, `POST /v1/liquidity-pools/operations/:id/submit` y los webhooks `LIQUIDITY_*` ahora incluyen `memo` (el MEMO_ID de quien llama, o `null`). Las operaciones creadas antes de la migración `20260915120000_liquidity_pool_operation_memo` devuelven `null` aunque su envelope lleve uno | Nadie, salvo un cliente que rechace campos desconocidos | El memo solo quedaba registrado dentro del XDR, así que cada replay con `Idempotency-Key` decodificaba el envelope para compararlo |
| El contrato publicado de `GET /v1/swaps` y `GET /v1/liquidity-pools/operations` ya no declara `qr` ni `commissionMemo` en los elementos de la lista. Las respuestas no cambian — esos dos campos nunca se enviaban ahí; se obtienen leyendo el elemento individual | Clientes generados a partir del spec OpenAPI | El contrato declaraba los elementos de la lista con la forma de la lectura individual, así que un cliente generado tipaba dos campos que la lista nunca traía |

Notas de despliegue que lo acompañan:

- **La migración `20260910120000_aliases`** crea `alias`, `alias_address`,
  `alias_challenge` y `alias_recovery`. Ejecutar `migrate deploy` antes de que el
  nuevo build reciba tráfico.
- **Un nuevo id de advisory lock, `881_008` (`AliasChallengeSweeper`).** No hay nada
  que configurar; se lista para que el número nunca se reutilice.
- **Establecer `NODE_ENV=production` en producción.** `.env.example` viene con
  `development`, y dos protecciones dependen de ese valor: una solicitud sin
  `X-Plan-Swap-Fee-Bps` es un `503` solo en producción (en cualquier otro entorno los
  swaps recurren en silencio a `STELLAR_SWAP_FEE_BPS`), y `/docs` — fuera de todo
  guard — está desactivado por defecto solo en producción.
- **El observador de liquidaciones ahora se ejecuta sobre `ScheduledJob`.**
  `OBSERVER_ENABLED`, `OBSERVER_INTERVAL_MS` y su advisory lock no cambian, pero sus
  líneas de log son las compartidas: `Settlement observer started (every Nms)`,
  `Settlement observer (OBSERVER_ENABLED=false) disabled` y
  `SettlementObserverService cycle failed` en nivel `error`. Una alerta que busque
  el texto anterior debe actualizarse.
- **La migración `20260915120000_liquidity_pool_operation_memo`** añade la columna
  nullable `liquidity_pool_operation.memo`: no reescribe la tabla, solo toma un lock
  exclusivo breve. No hay backfill — el memo de las filas anteriores vive en XDR
  base64, que SQL no puede decodificar, y el servicio recurre al envelope para ellas.
- **La migración `20260915120100_lookup_indexes`** construye dos índices
  `CONCURRENTLY` para la comprobación de propiedad de wallets de Pollar
  (`pollar_oauth_session(consumerId, network, walletAddress)` y
  `pollar_user_wallet(consumerId, network, address)`). No bloquea escrituras, pero un
  build fallido deja un índice `INVALID` que `IF NOT EXISTS` considera presente:
  encontrarlo con
  `SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE NOT i.indisvalid;`,
  eliminarlo con `DROP INDEX CONCURRENTLY`, ejecutar
  `prisma migrate resolve --rolled-back 20260915120100_lookup_indexes` y volver a
  desplegar.

### NestJS 12, TypeScript 6 y Node 24.9 como versión mínima

Toda la línea de NestJS pasó a 12 y TypeScript a 6. **Esto eleva la versión mínima de
Node a 24.9** (`engines`, y ambos workflows ahora fijan `node-version: 24`); con una
versión anterior ni siquiera puede ejecutarse la suite de pruebas. Los entornos de
despliegue deben actualizarse en consecuencia.

La razón es el test runner, no el framework. NestJS 12 se publica como ESM puro
(`"type": "module"`), y Jest ejecutándose bajo CommonJS no puede hacerle `require()` —
las 62 suites fallaban al cargar. Jest soporta `require(esm)` de forma nativa, pero
solo en Node >= 24.9 **y** con `--experimental-vm-modules`, porque la capacidad que
verifica (`vm.SourceTextModule.prototype.hasAsyncGraph`) no existe sin ese flag. Por
eso los scripts de pruebas ahora invocan Jest directamente a través de Node:

```
"test": "node --experimental-vm-modules node_modules/jest/bin/jest.js"
```

No con un prefijo `NODE_OPTIONS=`: eso no es portable a las shells de Windows, y CI,
el job de release y la máquina de un desarrollador deben ejecutar el mismo comando.

Dos consecuencias que conviene conocer:

- **`transformIgnorePatterns` se eliminó de ambas configuraciones de Jest.** Listaba
  los paquetes ESM (`@stellar`, `@noble`, `@exodus`, `uint8array-extras`) para que
  ts-jest los transpilara a CommonJS — un workaround para no poder cargar ESM. Ahora
  que Jest carga ESM de forma nativa, el workaround rompe activamente: un paquete
  compilado a CJS se evalúa como ESM y falla con `exports is not defined`. Si alguna
  dependencia vuelve a necesitar transformación, ese es el archivo que hay que revisar.
- **`tsconfig.json` incorporó `types` y `rootDir`.** TypeScript 6 ya no incluye
  automáticamente todos los paquetes `@types`, por lo que los dos ambientales (`node`,
  `jest`) se nombran explícitamente — sin eso, cada spec perdía `describe`/`it` aunque
  siguiera pasando en verde bajo ts-jest. Además, TS 6 se niega a inferir `rootDir`
  cuando una compilación abarca un solo directorio (TS5011), que es lo que hacen los
  scripts de ts-node; `"./"` es lo que el build completo ya infería, por lo que la
  estructura emitida no cambia.

Cambios de código que forzaron las nuevas versiones mayores, todos pequeños:

- `EventEmitter2` se importa desde `eventemitter2`, no desde `@nestjs/event-emitter`.
  Es el mismo objeto de clase en runtime — el token de DI no cambia — pero el
  re-export de Nest está tipado para la forma CJS del paquete y resuelve a `any` con
  la resolución de módulos `node10` de este repositorio, lo que convertía en silencio
  cada `.emit()` en una llamada sin verificación de tipos. Por esa razón,
  `eventemitter2` es ahora una dependencia directa.
- `OperationObject` proviene de `@nestjs/swagger` en lugar de
  `@nestjs/swagger/dist/interfaces/open-api-spec.interface`. Swagger 12 publica un
  mapa `exports` que expone solo `.` y `./plugin`, por lo que las rutas profundas ya no
  resuelven.
- `AccountLoaderService.load` declara un tipo de retorno explícito
  `Promise<Horizon.AccountResponse>`; TS 6 no infiere un tipo que no puede nombrar de
  forma portable.
- Dos mocks de pruebas (`fetch`, `Reflector.getAllAndOverride`) ahora coinciden con las
  firmas reales en lugar de usar otras más estrechas escritas a mano.

El OpenAPI publicado creció: `@nestjs/terminus@12` emite esquemas de health más ricos
(enums de status y una propiedad `responseTime`). Es puramente aditivo — no cambió
ninguna ruta ni esquema de negocio.

### Una API key pública compartida y el guard que la restringe

Nuevo en esta versión: `PublicKeyGuard` (global, después de `PermissionsGuard`) y el
decorador `@AllowPublicKey()`. Nada cambia para las keys existentes — el guard no
interviene ante un consumidor que no sea el público compartido — pero hay dos cosas
que hacer al desplegar:

- **Establecer `APISIX_PUBLIC_CONSUMER`** con el nombre de usuario que la plataforma
  para desarrolladores aprovisiona para la key pública, en cada despliegue que publique
  una. Sin esa variable, el guard recurre únicamente al `X-Consumer-Role` reenviado.
- **La key pública debe emitirse con `role: public`** y solo con los scopes que
  necesitan las rutas de la allowlist. Otorgarle `kyc:*` o `webhooks:*` no abriría esas
  rutas — el guard las rechaza de todos modos — pero sería una credencial más amplia
  que su función, en manos de todos.

Ver "La API key pública compartida" más arriba para saber a qué puede acceder y por
qué.

### El registro de activos: `GET /v1/assets`

Una tabla curada de los pares (code, issuer) que esta plataforma avala, por red, con
el nombre de la organización emisora. No requiere scope — el catálogo no contiene
datos de tenants, y restringirlo solo haría que cada key emitida antes de que existiera
el scope viera un selector de tokens vacío — pero sí requiere un consumidor
autenticado, incluida la key pública compartida.

`npm run assets:verify` vuelve a verificar cada fila contra Horizon en vivo: que el par
exista en la red bajo la que está registrado, que `contract` coincida con el
`contract_id` de Horizon y que los flags del emisor coincidan con la cadena. Ejecutarlo
al editar el registro. No es una prueba unitaria porque necesita acceso a internet, y
una prueba que falla cuando Horizon está lento es una prueba que la gente aprende a
ignorar.

### Actividad del cliente: un módulo nuevo, una tabla nueva y dos scopes nuevos

`POST /v1/activity/events` acepta telemetría de la wallet y del dashboard para
desarrolladores; `GET /v1/activity/events` y `GET /v1/activity/summary` permiten
consultarla. Nada existente cambió de forma, pero hay tres cosas que hacer al
desplegar:

- **La migración `20260906140000_activity_event`** crea `activity_event` (solo de
  inserción, limitada por `consumerId`, única sobre `(consumerId, eventId)`).
- **Los scopes `activity:write` y `activity:read` son nuevos.** Una key sin ellos
  recibe `insufficient_scope`, que es la respuesta correcta — pero significa que una
  key existente no obtiene la capacidad de reportar telemetría solo por actualizar el
  servicio. La plataforma para desarrolladores otorga ambos a las keys aprovisionadas
  para wallets y vuelve a aplicar el conjunto al rotarlas; a las keys emitidas
  manualmente hay que agregárselos.
- **`ACTIVITY_RETENTION_DAYS`** (por defecto 30) se suma al job de retención. Son
  datos personales al mismo nivel que el log de acceso; establecerlo en `0` solo de
  forma deliberada.

### La ruta de sondeo de Pollar ahora detecta por sí misma un inicio de sesión completado

`GET /v1/pollar/oauth/sessions/{state}` antes informaba lo que hubiera registrado el
callback del puente. Pollar nunca llama a ese callback — su flujo alojado termina en
`www.pollar.xyz/auth/status` y deja la sesión de cliente en `READY` — por lo que un
handshake con flujo de sondeo quedaba en `pending` hasta expirar, aunque la wallet
hiciera todo bien. Ahora el sondeo le pregunta directamente a Pollar y promueve el
handshake al recibir `READY`.

No cambió ninguna forma de la API y no se requiere ningún cambio en el cliente: un
inicio de sesión que antes quedaba colgado en `pending` ahora llega a `authorized`
dentro del sondeo siguiente a que el usuario termine. Dos cosas a tener en cuenta al
desplegar:

- **La migración `20260906120000_pollar_oauth_provider_probe`** agrega un
  `providerCheckedAt` anulable a `pollar_oauth_session`. Es el límite compartido de con
  qué frecuencia llega la consulta a Pollar; no se hace backfill de nada.
- **El tráfico de sondeo ahora llega a Pollar.** Hay que prever una solicitud al
  proveedor cada dos segundos por cada inicio de sesión en curso, con la publishable
  key de esa red.

### Los inicios de sesión de Pollar ahora aprovisionan una wallet en ambas redes

`POST /v1/pollar/oauth/token` incorporó un array `network_wallets` — una entrada por
red de Stellar, cada una `ready`, `pending` o `failed`. Es aditivo, así que nada se
rompe, pero hay dos notas operativas:

- **Ejecutar la migración.** `20260905120000_pollar_user_wallet` agrega
  `pollar_user_wallet` y el enum `PollarWalletStatus`. Sin ella, cada canje registra un
  aprovisionamiento fallido y la wallet de contraparte queda sin registrar — el inicio
  de sesión en sí sigue funcionando.
- **Configurar las claves de ambas redes.** `POLLAR_*_MAINNET` y `POLLAR_*_TESTNET`
  son opcionales por separado, y una red sin claves ahora aparece como una wallet
  `pending` en cada inicio de sesión en lugar de no aparecer en absoluto. Al configurar
  el segundo par, el sweeper vacía lo acumulado en su siguiente ciclo; si se deja sin
  configurar deliberadamente, las filas quedan en `pending` hasta que el presupuesto de
  diez intentos las retire. En ningún caso falla un inicio de sesión.

Prever el gasto de XLM: un inicio de sesión ahora fondea una reserva en *ambas* redes,
por lo que el gasto en mainnet por usuario nuevo no cambia, pero aparece gasto en
testnet donde antes no lo había.

### `429` ahora reporta `rate_limited`

Antes, un `429` sin más recurría a `code: "provider_unavailable"`, que indicaba que un
servicio upstream tenía problemas cuando en realidad era este servicio el que había
rechazado la solicitud — lo que llevaba a los integradores a investigar algo que
funcionaba perfectamente. Ahora reporta `code: "rate_limited"`, y
`ApiErrorCode.RateLimited` forma parte del enum publicado. Conviene ramificar según ese
valor si se reintenta ante throttling.

### Un BlindPay sin configurar ahora reporta `misconfigured`

Dos rechazos culpaban a la parte equivocada cuando BlindPay no está configurado:

| Solicitud | Antes | Ahora |
| --------- | ----- | ----- |
| Una ruta que llama a BlindPay — bajo `/v1/kyc`, `/v1/onramp` o `/v1/offramp` — mientras `BLINDPAY_API_KEY` o `BLINDPAY_INSTANCE_ID` no están definidos | `503` `provider_unavailable` | `503` `misconfigured` |
| `POST /v1/blindpay/webhooks` mientras `BLINDPAY_WEBHOOK_SECRET` no está definido | `400` `validation_failed` | `503` `misconfigured` |

`provider_unavailable` indica que el proveedor está caído y que un reintento puede
funcionar, así que un integrador que lo seguía reintentaba contra un proveedor que
estaba bien, durante todo el tiempo que el despliegue siguiera sin configurar. El
`400` del webhook le decía a quien leyera el log de Svix que BlindPay había enviado
una entrega malformada. Ambas fallas son de la configuración de este despliegue, y
solo un operador puede corregirlas. Svix reintenta ante cualquier respuesta que no
sea 2xx, así que la entrega de webhooks en sí no cambia. Pollar ya respondía
`misconfigured` en la misma situación.

### Formatos de respuesta que cambiaron

Tres formatos publicados cambiaron en la versión de audit-hardening. Los tres están
bajo `/v1`; no existe `/v2`, por lo que hay que avisar a los integradores antes de
desplegar.

| Endpoint | Antes | Ahora | Por qué |
| -------- | ----- | ----- | ------- |
| `GET /v1/webhooks` | array simple, recortado en silencio a 100 | `{ data, total, take, skip }` | Un consumidor con 120 endpoints recibía 100 sin que nada lo indicara, y sin un `total` con el que paginar |
| `GET /v1/products` | array simple, tabla completa | `{ data, total, take, skip }` | Lectura sin límite |
| `GET /v1/webhooks/:id/deliveries` y la respuesta de reenvío | incluía `payload` | `payload` eliminado | Un cuerpo `RECEIVER_UPDATED` es un expediente KYC completo y estas rutas están protegidas por `webhooks:read`, no por `kyc:read` |

Un llamante que hace `for (const x of res)` o lee `delivery.payload` se rompe al
desplegar. La migración es mecánica: leer `res.data`, y obtener los detalles de KYC
desde los endpoints de KYC con una key que tenga `kyc:read`.

Los **cuerpos de webhook** `RECEIVER_UPDATED` / `PAYIN_*` / `PAYOUT_*` también se
redujeron a identidad y estado — ver la sección Webhooks.

### La migración de audit-hardening

Se distribuye como dos archivos que deben aplicarse en orden:

- `20260901120000_audit_hardening` — el trabajo de corrección: una columna nueva, un
  `DELETE` de deduplicación sobre `liquidity_pool_operation`, dos índices `UNIQUE` y
  dos tablas nuevas. El DELETE y el índice único que depende de él se ejecutan dentro
  de una transacción explícita bajo un lock `SHARE ROW EXCLUSIVE`, por lo que un
  despliegue gradual no puede colar un duplicado entre ambos. Las escrituras en esa
  tabla se bloquean durante los pocos milisegundos que dura.
- `20260901120100_audit_hardening_indexes` — nueve índices aditivos, construidos con
  `CONCURRENTLY` para que el despliegue **no** bloquee escrituras en `payment_intent`,
  `swap`, `webhook_delivery` o `request_log`. No se necesita ventana de mantenimiento.

La separación no es estética: PostgreSQL rechaza `CREATE INDEX CONCURRENTLY` dentro
de un bloque de transacción, y el primer archivo necesita uno. Ambos se verifican en
CI contra un PostgreSQL real, que además comprueba que no haya quedado ningún índice
`INVALID` y que las migraciones sigan coincidiendo con `schema.prisma`.

Si el segundo archivo falla a mitad de camino, una construcción `CONCURRENTLY` deja un
índice **inválido** en lugar de fallar limpiamente, e `IF NOT EXISTS` lo considera
presente. Eliminarlo y volver a ejecutar:

```sql
SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE NOT i.indisvalid;
```

### `ADMIN_API_CREDENTIALS` desaparece — `/v1/admin` pertenece a la consola de la plataforma

**Eliminar la variable.** Ya no se lee, y las correspondientes
`COSMOS_ADMIN_API_SECRET` / `COSMOS_ADMIN_API_SECRET_READ` de la plataforma para
desarrolladores se eliminan con ella.

Era una segunda credencial que decidía, en este servicio, quién es administrador de la
plataforma — y la plataforma para desarrolladores ya lo había decidido según el rol de
la cuenta con sesión iniciada. Dos respuestas a una misma pregunta, y cada despliegue
que configuró el gateway pero omitió este secreto sufrió la discrepancia en su forma
más confusa: un owner podía cambiar el plan y el rol de otra cuenta en la consola, que
nunca pide este secreto, y sin embargo cada lectura entre tenants respondía `401
admin_credentials_required`. Nada en ese error apunta a un secreto de despliegue
faltante en lugar de a los permisos de la propia cuenta.

Por eso la pregunta que hace el guard cambió de "¿tiene quien llama el secreto de
administración?" a "¿esta llamada vino de la consola de la plataforma?", lo que se
resuelve con dos hechos que ya están en la solicitud:

1. `X-Gateway-Secret` coincide con `APISIX_GATEWAY_SECRET` — verificado por
   `ApisixGuard`, como en cualquier otra ruta. Solo el gateway y el backend de la
   consola lo tienen.
2. `X-Cosmos-Internal` está presente. APISIX lo elimina de toda solicitud que reenvía
   (`proxy-rewrite.headers.remove`), por lo que un llamante con API key no puede
   incluirlo; solo puede hacerlo una llamada directa desde un backend que tenga el
   secreto del gateway.

Hay que nombrar el compromiso con claridad: el hecho 2 se apoya en configuración de
enrutamiento del gateway que vive en el repositorio de la plataforma para
desarrolladores, no en un secreto que tenga este servicio. Dos cosas lo compensan. La
consola es ahora el único lugar que responde "quién es administrador de la
plataforma", por lo que las dos respuestas no pueden contradecirse; y la atribución se
volvió más precisa en lugar de más débil — una fila de auditoría antes nombraba una
credencial compartida (`owner`, `viewer`), y ahora nombra la cuenta de la consola que
actuó (`cosmos_<userId>`) más el rol de plataforma que declaró, en cada mutación **y**
en cada lectura.

Lo que esto cambia para quien llama:

| Antes | Ahora |
| ----- | ----- |
| `401` `admin_credentials_required` sin un secreto Bearer | `403` `admin_console_only` para todo lo que no sea una llamada de la consola |
| `403` `admin_role_required` para una credencial `read` en una mutación | eliminado — la consola ya decidió que la cuenta puede actuar |
| `actorId` / `actorRole` en una fila de auditoría nombraban la credencial | nombran la cuenta de la consola y su rol de plataforma |

Si se accede a `/v1/admin` directamente (por ejemplo, desde un script de operaciones),
enviar `X-Gateway-Secret`, `X-Consumer-Username` y `X-Cosmos-Internal: 1`; agregar
`X-Cosmos-Admin-Role: owner` para que la fila de auditoría quede etiquetada. Mantener
el servicio fuera de internet pública — sin el secreto de administración, el
aislamiento de red y el secreto del gateway son lo único que protege los datos de
todos los tenants.

### `APISIX_GATEWAY_SECRET` ahora requiere 32 caracteres

El servicio se niega a arrancar si el valor es más corto. Antes aceptaba un solo
carácter, y ahora es el *único* secreto entre el mundo exterior y la superficie de
administración de la plataforma (ver arriba), por lo que tiene más peso que antes.
Generar uno con `openssl rand -hex 32` y rotarlo en APISIX al mismo tiempo.

### Funcionalidades de `v0.1.0`–`v0.1.5` que esta versión reemplaza

`main` y esta rama resolvieron varios de los mismos problemas de forma independiente
mientras estuvieron separadas. Donde ambas tenían una solución, el diseño de esta rama
es el que se publica, por lo que un despliegue que viene de `v0.1.5` pierde lo
siguiente. Nada de ello es accidental — cada punto es una resolución deliberada — pero
todos son visibles para un integrador, así que conviene planificar la actualización en
función de ellos.

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
`SWAP_EXPIRED`, `LIQUIDITY_EXPIRED`) siguen declarados en `schema.prisma` y siguen
presentes después de `migrate deploy`. Simplemente nunca se escriben. Eliminar columnas
en uso — y un valor de enum, que PostgreSQL no puede quitar sin recrear el tipo —
sería una migración destructiva a cambio de nada, y mantenerlos declarados es lo que
permite que `prisma migrate diff` siga limpio.

## Variables de entorno

Cada variable leída de `process.env` en `src/` se valida en el arranque mediante
`src/config/env.validation.ts` (fail-fast). Copiar `.env.example` y ajustar al menos
`DATABASE_URL` y `APISIX_GATEWAY_SECRET`.

| Variable | Obligatoria | Valor por defecto | Efecto |
| -------- | ----------- | ----------------- | ------ |
| `NODE_ENV` | no | `development` | Debe ser `development`, `test` o `production`. **Establecer `production` en producción** — tanto la verificación fail-closed de la comisión del plan como la documentación desactivada por defecto dependen de ese valor |
| `PORT` | no | `3000` | Puerto HTTP de escucha |
| `DATABASE_URL` | **sí** | — | Conexión PostgreSQL para Prisma |
| `APISIX_GATEWAY_SECRET` | **sí** | — | Secreto compartido que demuestra que la solicitud pasó por APISIX. **Mínimo 32 caracteres** — es toda la frontera entre "llegó a través del gateway" y "cualquiera que pueda alcanzar el pod" |
| `APISIX_GATEWAY_SECRET_HEADER` | no | `x-gateway-secret` | Nombre del header del secreto del gateway |
| `APISIX_CONSUMER_HEADER` | no | `x-consumer-username` | Nombre de usuario del consumidor autenticado |
| `APISIX_CREDENTIAL_HEADER` | no | `x-credential-identifier` | Id de la credencial de key-auth |
| `APISIX_ENVIRONMENT_HEADER` | no | `x-consumer-env` | Entorno de la key (`dev` / `prod`) |
| `APISIX_ROLE_HEADER` | no | `x-consumer-role` | Rol del consumidor reenviado por el gateway |
| `APISIX_PERMISSIONS_HEADER` | no | `x-consumer-permissions` | Lista de permisos reenviada por el gateway |
| `APISIX_ORGANIZATION_HEADER` | no | `x-consumer-org` | Id de la organización |
| `APISIX_PLAN_HEADER` | no | `x-consumer-plan` | Plan de la organización |
| `APISIX_SWAP_FEE_BPS_HEADER` | no | `x-plan-swap-fee-bps` | Comisión de swap del plan (bps) |
| `APISIX_PUBLIC_CONSUMER` | no | — | Nombre de usuario del consumidor público compartido (ver arriba). Definirla en todo despliegue donde se publique una key pública |
| `STELLAR_NETWORK` | no | `testnet` | Red de Stellar de fallback (`public` / `testnet`) |
| `STELLAR_HORIZON_URL_PUBLIC` | no | `https://horizon.stellar.org` | URL base de Horizon para mainnet |
| `STELLAR_HORIZON_URL_TESTNET` | no | `https://horizon-testnet.stellar.org` | URL base de Horizon para testnet |
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
| `BLINDPAY_API_KEY` | no | — | API key de la plataforma en BlindPay |
| `BLINDPAY_INSTANCE_ID` | si hay API key | — | Id de instancia de BlindPay (`in_...`) |
| `BLINDPAY_BASE_URL` | no | `https://api.blindpay.com/v1` | URL base de la API de BlindPay |
| `BLINDPAY_WEBHOOK_SECRET` | si hay API key | — | Secreto Svix para los webhooks entrantes de BlindPay |
| `BLINDPAY_TIMEOUT_MS` | no | `15000` | Timeout del cliente HTTP de BlindPay (ms) |
| `KYC_REDIRECT_URL_WHITELIST` | no | — | Lista de hosts permitidos por consumidor para las redirecciones de KYC |
| `RATE_LIMIT_ENABLED` | no | `true` | Límites por dirección en las rutas que gastan XLM. Interruptor de incidentes |
| `RATE_LIMIT_PRUNE_INTERVAL_MS` | no | `600000` | Intervalo de depuración de las ventanas del contador (ms, mín. 1000) |
| `POLLAR_PUBLISHABLE_KEY_TESTNET` / `_MAINNET` | no | — | Publishable key de Pollar (`pub_<network>_…`), para el puente OAuth |
| `POLLAR_SECRET_KEY_TESTNET` / `_MAINNET` | junto con la publishable key | — | Clave secreta de Pollar (`sec_<network>_…`), para las rutas de operador |
| `POLLAR_BRIDGE_CALLBACK_URL` | si hay una key de Pollar | — | URL pública a la que Pollar devuelve el navegador. Debe ser `<gateway>/v1/pollar/oauth/callback` **y** un host registrado en Build → Domains de Pollar |
| `POLLAR_REDIRECT_URI_WHITELIST` | no | — | Lista de URIs de redirección de wallets permitidas por consumidor. Vacía ⇒ ese consumidor solo puede usar el flujo de sondeo |
| `POLLAR_SDK_ORIGIN` | no | origin de `POLLAR_BRIDGE_CALLBACK_URL` | `Origin` enviado a la SDK API de Pollar, que lo verifica contra Build → Domains. Definirla solo cuando el host del callback y el host registrado difieren |
| `POLLAR_SDK_BASE_URL` | no | `https://sdk.api.pollar.xyz` | URL base de la SDK API de Pollar |
| `POLLAR_SERVER_BASE_URL` | no | `https://api.pollar.xyz` | URL base de la Server API de Pollar |
| `POLLAR_TIMEOUT_MS` | no | `15000` | Timeout del cliente HTTP de Pollar (ms) |
| `POLLAR_AUTHORIZATION_TTL_MS` | no | `300000` | Cuánto tiempo permanece abierto un handshake de inicio de sesión |
| `POLLAR_CODE_TTL_MS` | no | `120000` | Cuánto tiempo sigue siendo canjeable un código emitido por el puente |
| `POLLAR_LOGIN_WAIT_MS` | no | `20000` | Cuánto tiempo espera el canje a que Pollar aprovisione la wallet |
| `POLLAR_SWEEP_ENABLED` | no | `true` | Expirar los handshakes que nadie completó y reintentar las wallets de la otra red que un inicio de sesión dejó en `pending` |
| `POLLAR_SWEEP_INTERVAL_MS` | no | `60000` | Intervalo del sweeper de handshakes (ms, mín. 1000) |

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

`key-auth` reenvía `X-Consumer-Username` / `X-Credential-Identifier` al upstream
después de una autenticación exitosa, sobrescribiendo cualquier copia enviada por el
cliente, y el guard depende de eso.

> **La lista de eliminación es crítica, y es la única parte de este modelo de
> seguridad que no puede verificarse desde dentro de este repositorio.** Cada header
> del bloque de arriba es un dato de autorización que el servicio acepta tal cual;
> `X-Gateway-Secret` solo demuestra que la solicitud pasó por *un* gateway, no que
> los valores sean honestos. Esa lista debe tratarse como configuración de producción,
> con el mismo nivel de revisión que el código: auditarla cada vez que se agrega o se
> copia una ruta, y mantener el servicio en una red privada para que el único camino
> accesible sea a través de APISIX. El secreto compartido es la segunda capa, no la
> única.
>
> El servicio ahora falla en modo cerrado en el único dato en el que el silencio solía
> ser rentable: la ausencia de `X-Plan-Swap-Fee-Bps` en una configuración de
> producción es un 503 en lugar de un fallback silencioso al valor por defecto del
> entorno.
>
> `X-Cosmos-Internal` tiene más peso que antes: con `ADMIN_API_CREDENTIALS` eliminado,
> es lo que le indica a este servicio que una solicitud vino de la consola de la
> plataforma y no de una API key, y por lo tanto lo que abre `/v1/admin`. Sigue
> siendo accesible solo para un llamante que ya presentó el secreto del gateway, así
> que la exposición está acotada por eso y por el aislamiento de red — pero una ruta
> que olvida eliminarlo convierte cada API key en administrador de la plataforma.

> Mantener el servicio en una red privada para que el único camino accesible sea a
> través de APISIX; el secreto compartido es la segunda capa, no la única.

## Cómo mantener este documento fiel a la realidad

**El README es parte del cambio, no una tarea posterior.** Nada en CI detecta que se
desactualice — el build sigue en verde mientras estas páginas describen en silencio un
servicio que ya no existe — por lo que se actualiza en el mismo commit que el código
que describe. La convención completa, incluida qué sección toca cada tipo de cambio,
está en [`CLAUDE.md`](../../CLAUDE.md); la versión corta:

| Cuando se… | Actualizar |
| ---------- | ---------- |
| agrega o elimina un módulo bajo `src/` | [Estructura del proyecto](#estructura-del-proyecto) |
| agrega, renombra o elimina una lectura de `process.env` | [Variables de entorno](#variables-de-entorno) **y** `.env.example` |
| integra un proveedor, o cambia el comportamiento de uno | la propia sección `##` de ese proveedor |
| cambia un formato de respuesta publicado, un código de estado o un scope | [Actualización](#actualización--cambios-incompatibles-y-notas-de-despliegue) |
| agrega, renombra, elimina o cambia el scope de una ruta | [Índice de rutas](#índice-de-rutas), y la propia sección del módulo |
| aprende algo que un operador o integrador no debe pasar por alto | la sección a la que corresponde |

**Este documento existe en siete idiomas** — English, Español, Português, Deutsch,
Français, हिन्दी y 简体中文 — y un cambio en uno es un cambio en los siete, en el
mismo commit. El inglés es la fuente, y los demás —en [`docs/i18n/`](./)— son traducciones de él: los mismos
encabezados, tablas y bloques de código, con los identificadores (rutas, variables de
entorno, headers, códigos de error) exactamente como están. `npm run readme:check` hace
fallar CI cuando falta un archivo de idioma, cuando sus encabezados dejan de coincidir
con los del inglés, o cuando una ruta del contrato OpenAPI no figura en su índice de
rutas.

Hay dos cosas que deliberadamente **no** están aquí: los **esquemas de solicitud y
respuesta**, que pertenecen al contrato OpenAPI generado (`npm run openapi:check` lo
mantiene fiel), y **cualquier cosa que el código ya dice** — este documento sirve para
explicar *por qué* algo es como es y cómo operarlo, porque una segunda copia de *qué*
hace es simplemente una segunda copia que mantener correcta.
