# Cosmos Pay — Microsserviço de Pagamentos

[English](../../README.md) · [Español](./README.es.md) · **Português** · [Deutsch](./README.de.md) · [Français](./README.fr.md) · [हिन्दी](./README.hi.md) · [简体中文](./README.zh.md)

Microsserviço de pagamentos construído com **NestJS 12** + **Prisma 7 (PostgreSQL)**.

É uma aplicação *separada* da plataforma de desenvolvedores Cosmos (`paydev`). A
plataforma de desenvolvedores apenas **emite** tokens de acesso do APISIX (consumers +
credenciais `key-auth`) para os serviços downstream. Este serviço é um desses
serviços downstream: ele fica **atrás do APISIX**, que faz o balanceamento de carga e
autentica cada requisição antes de encaminhá-la para cá. Por isso, o serviço nunca
vê API keys em texto puro — ele confia apenas no que o gateway encaminha.

## Como "somente APISIX" é garantido

Uma requisição só é aceita quando **ambas** as condições são satisfeitas (veja
`src/common/guards/apisix.guard.ts`):

1. **Segredo compartilhado do gateway.** A requisição traz `X-Gateway-Secret`,
   comparado em tempo constante com `APISIX_GATEWAY_SECRET`. O APISIX *injeta* esse
   header em toda requisição que passa pelo proxy e *remove* qualquer cópia enviada
   pelo cliente, de modo que um valor correto só pode ter origem no gateway. (Defesa
   em profundidade — combine com isolamento de rede para que o serviço não seja
   acessível diretamente.)
2. **Consumer autenticado.** O plugin `key-auth` do APISIX, depois de validar a API
   key de quem chama, encaminha `X-Consumer-Username` (e
   `X-Credential-Identifier`). O guard exige a presença do header do consumer, o que
   prova que a chave foi autenticada upstream.

As rotas podem ficar de fora com `@Public()` (usado pelas probes de health que o
orquestrador chama diretamente). A verificação está sempre ativa — não existe flag
para desligá-la. Em desenvolvimento local, rode atrás do APISIX ou envie você mesmo
`X-Gateway-Secret` + os headers `X-Consumer-*`.

`/v1/admin` é cross-tenant, então o `AdminGuard` também exige `X-Cosmos-Internal`.
O APISIX **remove** esse header de tudo o que passa pelo seu proxy, então só um
backend que chama o serviço diretamente com o segredo do gateway pode enviá-lo — a
plataforma de desenvolvedores, que decide se a conta autenticada é owner ou admin.
Não há uma credencial de admin separada: o segredo do gateway, o isolamento de rede
e a lista de remoção de headers na rota do gateway são o que protege os dados
cross-tenant.

O pipeline:

```
request → ApisixContextMiddleware  (reads consumer headers → req.gatewayConsumer)
        → ApisixGuard (APP_GUARD)  (verifies secret + consumer, or @Public bypass)
        → ValidationPipe           (DTO validation)
        → Controller / Service     (@CurrentConsumer() gives the consumer)
```

## Estrutura do projeto

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

Todas as rotas são versionadas sob `/v1` (versionamento por URI).

Toda rota está listada no [índice de rotas](#índice-de-rotas) abaixo, com o seu
escopo. **Os schemas de requisição e resposta ficam no contrato OpenAPI gerado**, que
é regenerado a partir dos controllers e DTOs a cada execução da CI
(`npm run openapi:check` quebra o build se houver divergência):

- `openapi/openapi.json` / `openapi/openapi.yaml` — versionados no repositório, revisáveis em um diff
- `/docs` — Swagger UI, quando `SWAGGER_ENABLED=true`
- `/docs/json`, `/docs/yaml` — a mesma spec servida ao vivo

| Área              | Caminho base             | O que faz                                                |
| ----------------- | ------------------------ | -------------------------------------------------------- |
| Payment intents   | `/v1/payment-intents`    | Intents SEP-7 `tx` / `pay`, validação, observer on-chain |
| Swaps             | `/v1/swaps`              | Cotação de path payment, montagem do XDR não assinado, envio do assinado |
| Liquidity pools   | `/v1/liquidity-pools`    | Depósito / saque em AMM, posições, comissão sobre o ganho |
| Webhooks          | `/v1/webhooks`           | CRUD de endpoints, rotação de segredo, entregas, reentrega |
| KYC               | `/v1/kyc`                | Receivers (KYC/KYB), carteiras, contas bancárias, upload de documentos |
| Onramp            | `/v1/onramp`             | Cotações de payin, payins, contas virtuais               |
| Offramp           | `/v1/offramp`            | Cotações de payout, autorização, payouts (assinados pelo cliente) |
| Produtos          | `/v1/products`           | Catálogo do comerciante                                  |
| Clientes          | `/v1/customers`          | Registros de pagadores derivados dos intents             |
| Aliases           | `/v1/aliases`            | Handles de pagamento reivindicáveis: reivindicar, resolver, recuperar |
| Login da carteira | `/v1/wallet` | Google / GitHub / código por e-mail, e o backup cifrado da seed |
| Ativos            | `/v1/assets`             | Registro curado de ativos por rede                       |
| Pollar            | `/v1/pollar`             | Bridge OAuth (login social → carteira) + rotas de operador |
| Analytics         | `/v1/summary`, `/v1/balances`, `/v1/logs` | Agregados e logs do dashboard           |
| Atividade         | `/v1/activity`           | Eventos reportados pelo cliente: ingestão, feed, consolidação |
| Admin             | `/v1/admin`              | Leituras/escritas cross-tenant — somente console da plataforma, auditado |
| Health            | `/v1/health`             | Liveness / readiness (`@Public`)                         |

### Índice de rotas

Toda rota que este serviço atende. **Escopo** é o que a API key precisa ter — *um
de* significa que qualquer um dos escopos listados basta, e `—` significa qualquer
chave autenticada. **Chave pública** marca as rotas que a API key pública
compartilhada pode chamar (veja
[A API key pública compartilhada](#a-api-key-pública-compartilhada)). Uma rota
marcada como *console da plataforma* não aceita API key nenhuma; só o backend do
console chega até ela. Os caminhos usam a forma `{param}` do OpenAPI.

| Método | Caminho | Escopo | Chave pública |
| ------ | ------- | ------ | ------------- |
| GET | `/v1/activity/events` | `activity:read` |  |
| POST | `/v1/activity/events` | `activity:write` | ✓ |
| GET | `/v1/activity/summary` | `activity:read` |  |
| GET | `/v1/admin/audit-logs` | console da plataforma |  |
| GET | `/v1/admin/consumers` | console da plataforma |  |
| GET | `/v1/admin/customers` | console da plataforma |  |
| GET | `/v1/admin/payins` | console da plataforma |  |
| GET | `/v1/admin/payment-intents` | console da plataforma |  |
| GET | `/v1/admin/payouts` | console da plataforma |  |
| GET | `/v1/admin/products` | console da plataforma |  |
| GET | `/v1/admin/receivers` | console da plataforma |  |
| PATCH | `/v1/admin/receivers/{id}/access` | console da plataforma |  |
| POST | `/v1/admin/receivers/{id}/approve` | console da plataforma |  |
| POST | `/v1/admin/receivers/{id}/enable` | console da plataforma |  |
| POST | `/v1/admin/receivers/{id}/tos` | console da plataforma |  |
| GET | `/v1/admin/summary` | console da plataforma |  |
| GET | `/v1/admin/swaps` | console da plataforma |  |
| GET | `/v1/aliases` | `payments:read` |  |
| POST | `/v1/aliases` | `payments:write` |  |
| GET | `/v1/aliases/availability/{name}` | `payments:read` | ✓ |
| GET | `/v1/aliases/by-address/{address}` | `payments:read` | ✓ |
| POST | `/v1/aliases/challenges` | `payments:write` |  |
| GET | `/v1/aliases/resolve/{name}` | `payments:read` | ✓ |
| DELETE | `/v1/aliases/{name}` | `payments:write` |  |
| POST | `/v1/aliases/{name}/addresses` | `payments:write` |  |
| DELETE | `/v1/aliases/{name}/addresses/{addressId}` | `payments:write` |  |
| POST | `/v1/aliases/{name}/recovery` | console da plataforma |  |
| POST | `/v1/aliases/{name}/recovery/complete` | `payments:write` |  |
| GET | `/v1/assets` | — | ✓ |
| GET | `/v1/balances` | `payments:read` |  |
| POST | `/v1/blindpay/webhooks` | nenhum — `@Public()`, assinatura Svix |  |
| GET | `/v1/customers` | `customers:read` |  |
| POST | `/v1/customers` | `customers:write` |  |
| GET | `/v1/customers/{id}` | `customers:read` |  |
| PATCH | `/v1/customers/{id}` | `customers:write` |  |
| DELETE | `/v1/customers/{id}` | `customers:write` |  |
| GET | `/v1/health/liveness` | nenhum — `@Public()` |  |
| GET | `/v1/health/readiness` | nenhum — `@Public()` |  |
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
| GET | `/v1/liquidity-pools` | um de `liquidity:read`, `swaps:read` | ✓ |
| POST | `/v1/liquidity-pools/deposit` | um de `liquidity:write`, `swaps:write` | ✓ |
| GET | `/v1/liquidity-pools/operations` | um de `liquidity:read`, `swaps:read` |  |
| GET | `/v1/liquidity-pools/operations/{id}` | um de `liquidity:read`, `swaps:read` |  |
| POST | `/v1/liquidity-pools/operations/{id}/submit` | um de `liquidity:write`, `swaps:write` | ✓ |
| GET | `/v1/liquidity-pools/positions` | um de `liquidity:read`, `swaps:read` | ✓ |
| POST | `/v1/liquidity-pools/withdraw` | um de `liquidity:write`, `swaps:write` | ✓ |
| GET | `/v1/liquidity-pools/{poolId}` | um de `liquidity:read`, `swaps:read` | ✓ |
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
| GET | `/v1/pollar/oauth/callback` | nenhum — `@Public()` |  |
| GET | `/v1/pollar/oauth/callback/{state}` | nenhum — `@Public()` |  |
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
| GET | `/v1/wallet/auth/providers` | `payments:read` | ✓ |
| POST | `/v1/wallet/auth/oauth/authorize` | `payments:write` | ✓ |
| GET | `/v1/wallet/auth/oauth/callback/{provider}` | none — `@Public()`, a browser redirect |  |
| GET | `/v1/wallet/auth/oauth/session/{state}` | `payments:read` | ✓ |
| POST | `/v1/wallet/auth/oauth/claim` | `payments:write` | ✓ |
| POST | `/v1/wallet/auth/email/start` | `payments:write` | ✓ |
| POST | `/v1/wallet/auth/email/verify` | `payments:write` | ✓ |
| POST | `/v1/wallet/auth/finish` | `payments:write` | ✓ |
| PUT | `/v1/wallet/backup` | `payments:write` | ✓ |
| GET | `/v1/webhooks` | `webhooks:read` |  |
| POST | `/v1/webhooks` | `webhooks:write` |  |
| GET | `/v1/webhooks/{id}` | `webhooks:read` |  |
| PATCH | `/v1/webhooks/{id}` | `webhooks:write` |  |
| DELETE | `/v1/webhooks/{id}` | `webhooks:write` |  |
| GET | `/v1/webhooks/{id}/deliveries` | `webhooks:read` |  |
| POST | `/v1/webhooks/{id}/deliveries/{deliveryId}/redeliver` | `webhooks:write` |  |
| POST | `/v1/webhooks/{id}/ping` | `webhooks:write` |  |
| POST | `/v1/webhooks/{id}/rotate-secret` | `webhooks:write` |  |

### Respostas de erro

Toda falha retorna o mesmo envelope, e `code` é a parte estável e legível por
máquina — decida com base nele, e não em `message`, que é texto livre e pode ser
reescrito:

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

O envelope e o enum completo de `code` são publicados na spec OpenAPI como
`ApiErrorBodyEntity` (fonte: `ApiErrorCode` em `src/common/errors/api-error.ts`).
Cada operação documenta apenas os status que realmente pode retornar, e cada status
traz um exemplo por `code` que pode carregar — a mensagem real, com o `statusCode` e
o `error` correspondentes —, então o Swagger UI e uma importação no Postman mostram o
corpo que você de fato recebe. **Códigos nunca são renomeados depois de
publicados**; novos podem ser adicionados, então trate um código desconhecido pelo
seu status HTTP.

Alguns que são fáceis de confundir:

| Código | Status | Significa |
| ------ | ------ | --------- |
| `insufficient_scope` | 403 | A API key não tem o escopo. Provisione a chave novamente |
| `account_disabled` | 403 | Um operador desativou esta conta fiat. Não é um problema da chave |
| `gateway_required` | 403 | A requisição não chegou pelo APISIX |
| `admin_console_only` | 403 | A rota pertence ao console da plataforma (`/v1/admin`, iniciar a recuperação de um alias). Nenhuma API key pode chamá-la |
| `elevated_key_required` | 403 | A rota escreve em algo que todos os tenants compartilham (o diretório de usuários da Pollar). Só uma key elevada (admin) pode chamá-la; mais scopes não ajudam |
| `pollar_identity_required` | 403 | O gateway não encaminhou o e-mail da conta desta key, então um login da Pollar não pode ser vinculado a ela |
| `pollar_identity_mismatch` | 403 | O login da Pollar foi concluído por uma conta diferente da conta da key. A sessão foi revogada, não devolvida |
| `idempotency_conflict` | 409 | Este `Idempotency-Key` (ou o memo do payment intent) já produziu um recurso para uma requisição *diferente*. Repita a requisição original ou use uma chave nova |
| `kyc_state_invalid` | 409 | Uma transição de estado de KYC ilegal — não é uma requisição duplicada |
| `operation_in_flight` | 409 | Uma operação conflitante ainda está sendo liquidada |
| `payload_expired` | 409 | O corpo da entrega passou do período de retenção e não pode ser reenviado |
| `provider_unavailable` | 502/503/504 | BlindPay ou Horizon está inacessível. Tente novamente |
| `misconfigured` | 503 | Um erro de configuração do lado do servidor. Tentar novamente não vai ajudar |

### Executando mais de uma réplica

O APISIX faz o balanceamento de carga entre instâncias, então todo timer em segundo
plano roda em todas as réplicas. As mudanças de status já são seguras — cada uma é um
compare-and-swap protegido com `updateMany` —, mas ciclos duplicados multiplicariam
as chamadas ao Horizon, uma API que aplica rate limit. Por isso, cada timer obtém um
**advisory lock em nível de transação** do PostgreSQL (`AdvisoryLockService`) e pula
o seu ciclo quando outra réplica o detém:

| Timer                          | Chave do lock            |
| ------------------------------ | ------------------------ |
| `SettlementObserverService`    | `SettlementObserver`     |
| `StellarObserverService`       | `PaymentIntentObserver`  |
| `RequestLogRetentionService`   | `RequestLogRetention`    |
| Sweeper de entregas de webhook | `WebhookDeliverySweeper` |
| `PollarOauthSweeperService`    | `PollarOauthSweeper`     |
| `RateLimitPruneService`        | `RateLimitPrune`         |
| `PollarWalletProvisionSweeperService` | `PollarWalletProvisionSweeper` |
| `AliasChallengeSweeperService` | `AliasChallengeSweeper`  |

`pg_try_advisory_xact_lock` nunca bloqueia e é liberado quando a transação termina,
mesmo em um crash ou em uma conexão perdida. Ao contrário de um lock em nível de
sessão, ele também funciona atrás do PgBouncer em modo transaction pooling.

Os ids de lock ficam no enum `AdvisoryLockKey`. Não renumere um id existente —
durante um rolling deploy, réplicas antigas e novas obteriam locks diferentes — e não
reutilize um id aposentado.

### Validação de pagamentos e o observer on-chain

Um pagamento é confirmado contra a rede Stellar em um único lugar
(`StellarVerifierService`): a transação precisa ser **bem-sucedida**, conter um
**pagamento nativo (XLM)** para o `destination` do intent no **valor exato**,
— quando o intent tem memo — trazer um **memo correspondente** (`memo_type: id`) e
ter sido fechada **no máximo um minuto antes de o intent ser criado**
(`TX_CREATED_AT_SKEW_MS`). Esse piso de idade é o que impede que um pagamento
on-chain antigo com os mesmos termos liquide um intent novo.

Dois caminhos usam essa regra única:

- **Manual:** `POST /v1/payment-intents/:id/validate` com `{ "txHash": "<64-hex>" }`.
  Se houver correspondência, o intent passa a `SUCCEEDED` (e o `txHash` é salvo) e
  um webhook `PAYMENT_INTENT_SUCCEEDED` é disparado. Uma tx que falhou on-chain marca
  o intent como `FAILED` **somente quando era o próprio pagamento deste intent** —
  mesmo memo, destino e ativo. Qualquer outra transação, com falha ou não, é uma
  divergência que deixa o status inalterado, para que a tx correta ainda possa ser
  enviada. Um `txHash` informado via `PATCH /v1/payment-intents/:id` nunca liquida um
  intent sozinho: precisa ser um hash hex de 64 caracteres, é armazenado em
  minúsculas e é único apenas entre os intents do consumer que chama
  (`409 idempotency_conflict` em caso de colisão com outro intent dele).
- **Automático (observer permanente):** `StellarObserverService` consulta o Horizon
  a cada `OBSERVER_INTERVAL_MS` em busca de intents `PENDING` — pelo `txHash`
  informado, ou varrendo os pagamentos para o destino — e finaliza as
  correspondências da mesma forma, de modo que os status mudam e os eventos disparam
  **sem que ninguém chame a API**. Um ciclo processa no máximo
  `OBSERVER_MAX_INTENTS_PER_CONSUMER` (10) intents por consumer e nunca varre um
  intent expirado, então um único consumer não consegue atrasar a liquidação de todos
  os outros. Desative em desenvolvimento local com `OBSERVER_ENABLED=false`.

**A expiração verifica a chain primeiro.** Um intent que passou de sua validade é
verificado mais uma vez antes de ser marcado como `EXPIRED`: se o pagamento está
on-chain, ele é liquidado como `SUCCEEDED` em vez disso, e se o Horizon não pode ser
alcançado, ele fica para o próximo ciclo. Quando esse hash já está em outro intent do
mesmo consumer, o intent é expirado em vez de ser tentado para sempre. Um pagamento
verificado após a expiração, seja pelo observer ou por `validate`, ainda move um
intent `EXPIRED` para `SUCCEEDED` e dispara `PAYMENT_INTENT_SUCCEEDED`, então não
trate `EXPIRED` como final. A varredura lê os pagamentos do destino até a criação do
intent, no máximo 1.000 (5 páginas de 200); se um destino receber mais que isso
durante a vida de um intent, chame `validate` com o hash.

### Retenção dos logs de requisições da API

Toda requisição recebida, exceto `/v1/health` e `/docs`, é gravada em
`request_log` pelo `LoggingInterceptor` e alimenta a visão **API logs** do dashboard
(`GET /v1/logs`). As linhas incluem caminho, status, duração e — quando presentes —
o `ip` / `userAgent` do pagador.

O tráfego do dashboard (`X-Cosmos-Internal`) é **registrado e marcado**
(`request_log.internal`), não ignorado, e a visão de logs da API filtra por essa
coluna, então nenhum header de requisição consegue deixar tráfego fora do log.

As linhas **não são mantidas para sempre**. `RequestLogRetentionService` apaga as
linhas mais antigas que `REQUEST_LOG_RETENTION_DAYS` (padrão **30**) em um timer
(`REQUEST_LOG_PRUNE_INTERVAL_MS`, padrão **1h**). Cada ciclo apaga em lotes curtos de
`REQUEST_LOG_PRUNE_BATCH_SIZE` (padrão **1000**) e continua em loop até o backlog
acabar ou até atingir `REQUEST_LOG_PRUNE_MAX_PER_CYCLE` (padrão **50000**), para que
um histórico grande possa ser posto em dia sem segurar um lock longo na tabela.
Defina `REQUEST_LOG_RETENTION_DAYS=0` para desativar a limpeza por completo (o
serviço registra isso no boot). O índice composto em `(consumer, createdAt)` mantém
a consulta do dashboard rápida à medida que o volume cresce.

### Atividade do cliente (o que a carteira e o dashboard reportam)

`request_log` registra apenas as requisições que chegaram a este serviço. Ele não
enxerga uma carteira que travou na tela de envio, uma assinatura que o usuário
cancelou ou uma página do dashboard que falhou antes de enviar qualquer coisa, então
os próprios clientes reportam esses eventos para `POST /v1/activity/events`.

- **Em lotes.** Os clientes enfileiram os eventos e os descarregam, então uma
  carteira offline os envia na próxima inicialização. Até `ACTIVITY_MAX_BATCH` (100)
  por requisição.
- **Seguro para repetir.** Um evento pode trazer o `eventId` do próprio cliente;
  `(consumerId, eventId)` é único e as duplicatas são ignoradas. A resposta informa
  `accepted` e `duplicates`.
- **Atribuição pelo gateway.** As linhas são gravadas sob o consumer que o APISIX
  autenticou; não existe campo no corpo para isso.
- **Tolerante a payloads ruins.** Um `message` longo demais é truncado e um `props`
  grande demais é substituído por `{"_dropped": "props_too_large"}`, em vez de
  rejeitar o lote inteiro.
- **Timestamps ajustados.** `occurredAt` é substituído pelo horário de recebimento
  quando está mais de cinco minutos adiantado ou mais de sete dias atrasado. Os dois
  horários são mantidos: `at` (o do cliente) e `receivedAt`.

Para ler de volta:

| Rota                    | Escopo            | Retorna                                                              |
| ----------------------- | ----------------- | -------------------------------------------------------------------- |
| `GET /v1/activity/events` | `activity:read` | O feed, do mais novo para o mais antigo. Filtros: `source`, `level`, `category`, `type` (prefixo), `network`, `since`/`until` |
| `GET /v1/activity/summary` | `activity:read` | Contagens por level/source/category, principais tipos de evento, principais erros, sessões, dispositivos, uma série diária |

`level` no feed é um **mínimo**, não uma correspondência exata: `level=warn` retorna
avisos *e* erros.

`activity_event` guarda um IP, um user agent e o que mais o cliente tiver anexado,
então é limpo pelo mesmo job e nos mesmos lotes limitados que `request_log` —
`ACTIVITY_RETENTION_DAYS`, padrão **30**, `0` para manter os eventos para sempre.

### Webhooks (notificando integradores)

Cada integrador (consumer do APISIX) registra um ou mais endpoints de webhook.
Quando um payment intent muda, a plataforma dispara um evento de domínio; o
**dispatcher** o distribui para cada endpoint habilitado desse consumer inscrito no
tipo de evento (inscrição vazia = todos), registra cada tentativa para
rastreabilidade e tenta novamente com backoff linear (env `WEBHOOK_*`).

Tipos de evento: `PAYMENT_INTENT_CREATED`, `PAYMENT_INTENT_UPDATED`,
`PAYMENT_INTENT_SUCCEEDED`, `PAYMENT_INTENT_FAILED`, `PAYMENT_INTENT_CANCELLED`,
`PAYMENT_INTENT_DELETED`, `SWAP_CREATED`, `SWAP_SUBMITTED`, `SWAP_SUCCEEDED`,
`SWAP_FAILED`, `LIQUIDITY_CREATED`, `LIQUIDITY_SUBMITTED`, `LIQUIDITY_SUCCEEDED`,
`LIQUIDITY_FAILED`, além dos originados no BlindPay `RECEIVER_UPDATED`,
`PAYIN_CREATED`, `PAYIN_UPDATED`, `PAYIN_COMPLETED`, `PAYOUT_CREATED`,
`PAYOUT_UPDATED` e `PAYOUT_COMPLETED`. A lista oficial é o enum `WebhookEventType`
em `prisma/schema.prisma`.

**Corpos originados no BlindPay.** `RECEIVER_UPDATED` / `PAYIN_*` / `PAYOUT_*`
trazem apenas identidade e estado — ids, status, valores, rails — nunca dados
pessoais. O objeto do provedor não é encaminhado, porque o payload de um receiver é
um dossiê de KYC completo e se inscrever exige apenas `webhooks:write`. Busque os
detalhes na API com uma chave que tenha `kyc:read` / `onramp:read` / `offramp:read`.
A allowlist de campos está em `src/blindpay/blindpay-event-redaction.ts`.

A entrega é desacoplada via `EventEmitter2` do NestJS (`webhook.event`), então
emitir uma notificação nunca bloqueia a requisição da API que a disparou.

**Política de destino de saída (SSRF):** os endpoints precisam usar `https` e
resolver apenas para endereços públicos. O cadastro rejeita loopback, faixas
privadas RFC1918, link-local (`169.254.0.0/16`, incluindo o endpoint de metadata de
nuvem `169.254.169.254`) e hostnames de metadata conhecidos. **Toda recusa que depende
do host dá a mesma resposta** — «o host não é um destino permitido» — e o motivo vai
para o log: distinguir «aqui não resolve» de «resolve para `10.0.4.7`» e de «resolve
para o serviço de metadata» deixaria qualquer um que possa cadastrar um endpoint
mapear a rede em que este serviço roda, uma URL por vez. Uma URL malformada, um
esquema que não é https, credenciais ou a falta de host continuam dizendo exatamente o
que está errado: descrevem a string enviada, não a rede. A mesma verificação
roda de novo imediatamente antes de cada entrega (o DNS pode mudar depois do
cadastro). O client HTTP usa `redirect: manual` (nunca segue `3xx`), timeouts de
conexão/leitura vindos do env e um tamanho máximo de corpo de resposta.

| Variável | Padrão | Significado |
| -------- | ------ | ----------- |
| `WEBHOOK_CONNECT_TIMEOUT_MS` | `3000` | Orçamento de conexão (parte do timeout do AbortSignal) |
| `WEBHOOK_READ_TIMEOUT_MS` | `5000` | Orçamento de leitura (parte do timeout do AbortSignal) |
| `WEBHOOK_MAX_RESPONSE_BYTES` | `65536` | Limite do corpo de resposta drenado |
| `WEBHOOK_TIMEOUT_MS` | `5000` | Fallback legado se os timeouts separados não estiverem definidos |
| `WEBHOOK_MAX_ATTEMPTS` / `WEBHOOK_BACKOFF_MS` | `3` / `2000` | Loop de retry em processo, por tentativa de entrega |
| `WEBHOOK_SWEEP_ENABLED` | `true` | Recupera entregas abandonadas por um crash. É a chave de incidente — defina `false` para interromper a reentrega a um integrador que está entrando em colapso |
| `WEBHOOK_SWEEP_INTERVAL_MS` | `60000` | Com que frequência uma réplica tenta fazer a varredura (só uma vence por ciclo) |
| `WEBHOOK_PAYLOAD_RETENTION_DAYS` | `30` | Depois disso, o corpo armazenado de uma entrega concluída é substituído por um marcador de redação. `0` mantém os corpos para sempre |

**Uma entrega pode ser tentada até 9 vezes, não 3.** `WEBHOOK_MAX_ATTEMPTS` limita
um loop de retry em processo. Depois, o sweeper pega as entregas que ainda estão
abaixo de `WEBHOOK_MAX_ATTEMPTS × 3` tentativas no total, distribuídas ao longo de
horas, então uma entrega interrompida por um restart de pod não se perde.

**A reentrega só funciona dentro da janela de retenção.** Depois de
`WEBHOOK_PAYLOAD_RETENTION_DAYS`, o corpo armazenado é apagado (o log de entregas é
mantido). O sweeper ignora essas linhas, e
`POST /v1/webhooks/:id/deliveries/:id/redeliver` retorna `409 payload_expired`.

**Recebendo webhooks.** Qualquer `2xx` confirma o recebimento. Responda dentro de
`WEBHOOK_READ_TIMEOUT_MS` (5s por padrão). A ordem não é garantida, então reconcilie
com a API. Deduplique pelo `id` do evento; uma reentrega reutiliza o `id` original
(entrega at-least-once).

**Migrando endpoints existentes:** depois do deploy, execute

```bash
npm run webhooks:audit-destinations
```

As linhas inseguras recebem `destinationBlocked=true` e `enabled=false`. Os
integradores corrigem a URL com `PATCH /v1/webhooks/:id` `{ "url": "https://…" }`
(a validação roda de novo e limpa a flag), ou reativam o endpoint depois que o DNS
passar a ser público.

**Payload** (corpo do POST para a URL do integrador):

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
  `${t}.${rawBody}` usando o segredo `whsec_...` do endpoint.
- `X-Cosmos-Event`, `X-Cosmos-Event-Id`, `X-Cosmos-Delivery`.

**Verificando a assinatura (lado do integrador):**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody: string, header: string, secret: string): boolean {
  const [t, v1] = header.split(',').map((p) => p.split('=')[1]);
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
```

O segredo de assinatura é retornado **uma única vez** em `POST /webhooks` (e em
`rotate-secret`); as respostas de listagem/consulta nunca o incluem. Toda tentativa
é armazenada (`webhook_delivery`) com status, tentativas, código de resposta e erro
— consulte via `GET /webhooks/:id/deliveries` e reenvie com a rota `redeliver`.

Listar, obter e atualizar retornam exatamente os campos documentados do endpoint, e
criar e `rotate-secret` acrescentam `secret`. Mais nada da linha sai do serviço —
nem `consumerId`, nem as colunas `previousSecret` / `previousSecretExpiresAt` que
uma rotação com janela de graça anterior gravou.

**`ping` e `redeliver` têm limite de taxa**, por consumer e endereço do cliente:
`POST /v1/webhooks/:id/ping` 20 e
`POST /v1/webhooks/:id/deliveries/:deliveryId/redeliver` 30 a cada 10 minutos
(`429 rate_limited`). Ambas fazem este serviço enviar requisições assinadas para uma
URL que você escolheu, e `redeliver` roda todo o loop de retry dentro da
requisição. Para um backlog grande, deixe o sweeper reenviar em vez de reenviar uma
por uma.

### OpenAPI / Swagger

**Nota de segurança:** `GET /docs`, `/docs/json` e `/docs/yaml` são montados como
**middleware do Express**, não como controllers do Nest, então **não** passam pelo
`ApisixGuard` nem pelo `PermissionsGuard` — qualquer um que alcance a porta do serviço
pode baixar a spec. Em produção, a documentação fica **desligada por padrão**
(`NODE_ENV=production` e sem `SWAGGER_ENABLED`). Defina `SWAGGER_ENABLED=true` apenas
em uma rede confiável.

Exporte a spec para arquivos — não é preciso banco de dados nem o segredo real do
gateway:

```bash
npm run openapi:generate
# writes openapi/openapi.json and openapi/openapi.yaml
```

A CI regenera os dois arquivos versionados e rejeita divergências. Rode a mesma
verificação antes de fazer commit de uma mudança em um controller ou DTO:

```bash
npm run openapi:check
```

Os caminhos na spec já incluem a versão (`/v1/...`). Para colocar um host do gateway
em `servers` da spec, defina `OPENAPI_SERVER_URL` antes de gerar:

```bash
OPENAPI_SERVER_URL=https://gateway.example.com npm run openapi:generate
```

**Usando pelo Postman.** Importe `openapi/openapi.json`, ou
`http://localhost:3000/docs/json` de um serviço em execução. A spec oferece dois
servidores e dois requisitos de segurança; ferramentas que escolhem um pegam o
primeiro de cada lista:

| Chamada | Servidor | Autenticação |
| ------- | -------- | ------------ |
| Direto a este serviço (desenvolvimento local) | `http://localhost:{port}` (`port` padrão `3000`) | `X-Gateway-Secret` **e** `X-Consumer-Username`, juntos |
| Pelo gateway APISIX | `OPENAPI_SERVER_URL`, primeiro da lista quando definido | `Authorization: Bearer <api key>` |

A spec versionada é gerada sem `OPENAPI_SERVER_URL`, então o padrão é o par direto;
gere com a variável definida para ter uma collection que usa o gateway por padrão. O
Postman guarda uma única API key por request: se a importação configurar só
`X-Gateway-Secret`, adicione `X-Consumer-Username` como header da collection. Os
probes de saúde são publicados com `security: []`.

Cada operação traz extensões de fornecedor que dizem o que ela é:
`x-cosmos-rate-limit` (seus orçamentos; pode responder `429`), `x-cosmos-upstream`
(o provedor que chama; pode responder `502`/`503`/`504`), `x-cosmos-public` e
`x-cosmos-public-key`.

`npm run openapi:generate` se recusa a escrever uma spec em que uma operação não tem
summary, uma falha não tem corpo nem exemplo, o `statusCode` de um exemplo não bate
com o status que documenta, ou um `429` aparece em uma rota sem orçamento. Sempre que
adicionar ou alterar uma rota, revise a operação regenerada; veja `CLAUDE.md`.

### Criando intents — duas operações SEP-7, dois endpoints

Conforme a [SEP-7](https://stellar.org/protocol/sep-7), as operações `tx` e `pay`
recebem **parâmetros diferentes** e produzem **respostas diferentes**, então cada uma
tem o seu próprio endpoint, DTO e schema de resposta. O serviço não guarda chaves —
ele apenas monta a requisição para a carteira do cliente (retorna `uri` + `qr`, mais
`xdr` para `tx`). O ativo assume **XLM nativo** por padrão quando `assetCode` é
omitido (ou é `XLM`/`native`); qualquer outro ativo exige `assetIssuer`.

**A rede é determinada pelo tipo da API key** que o gateway encaminha: uma chave
`prod` → public (mainnet), uma chave `dev` → testnet. `STELLAR_NETWORK` é apenas um
fallback para desenvolvimento local sem o gateway. Cada intent armazena a sua própria
rede, e todas as chamadas ao Horizon (montagem, validação, observer) apontam para ela.
Todo intent é armazenado (tabela `payment_intent`) e vinculado ao consumer que chama:
`PENDING → SUBMITTED → SUCCEEDED/FAILED/CANCELLED/EXPIRED`. A única saída de um
status final é `EXPIRED → SUCCEEDED`, mediante um pagamento verificado on-chain.

**O memo é um `MEMO_ID` obrigatório** — ele identifica o pagamento on-chain e torna a
criação **idempotente**: `(consumer, memo)` é único, então recriar com o mesmo memo
**e os mesmos termos** retorna o intent original. O mesmo memo com qualquer termo
diferente — tipo, rede, destino, valor, ativo, `msg`, `callback`, ou `source` no caso
de `tx` — resulta em `409 idempotency_conflict`, e o erro não diz nada sobre o intent
armazenado. Isso importa sob a chave pública compartilhada, em que toda carteira
anônima é o mesmo consumer. Os dois construtores dividem um orçamento de **30 chamadas
por minuto** por consumer e endereço do cliente (`429 rate_limited`): cada um lê a
conta do pagador no Horizon e escreve uma linha, e sob a chave pública compartilhada o
endereço é tudo o que separa uma carteira anônima da seguinte. Se você não passar
`memo`, um uint64 aleatório é gerado.

**`POST /v1/payment-intents/tx`** — o pagador (`source`) é conhecido, então montamos
o `TransactionEnvelope` não assinado e uma URI `web+stellar:tx?xdr=...`.

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

**`POST /v1/payment-intents/pay`** — sem source, então retornamos apenas uma URI
`web+stellar:pay?destination=...` (a carteira escolhe o ativo/caminho de origem).

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

Exemplo de resposta de `tx`:

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

Rede/Horizon/taxa/timeout são configurados pelas variáveis de ambiente `STELLAR_*`
(veja `.env.example`). O padrão é **testnet** por segurança — defina
`STELLAR_NETWORK=public` para mainnet (fundos reais).

## A API key pública compartilhada

A carteira open source distribui uma API key que todo mundo compartilha, para que
qualquer pessoa possa fazer swap, adicionar liquidez ou criar um link de pagamento
sem se cadastrar. Essas chamadas pagam a comissão do plano `community` (150 bps, a
taxa mais alta); o cadastro dá acesso a uma menor. O gateway injeta a taxa
exatamente como faz para uma chave privada (veja `resolvePlanCommissionBps`).

A diferença está no isolamento entre tenants. Todo chamador anônimo chega como o
mesmo consumer do APISIX, e os endpoints de leitura filtram as linhas por consumer:

```ts
// swaps.service.ts
where: { id, consumer: { apisixUsername: consumer.username } }
```

Então `GET /v1/swaps` sob a chave pública retornaria o histórico de swaps de todos
os usuários anônimos. Escopos não impedem isso, porque todos têm a mesma chave — e
`POST /v1/swaps/quote` exige `swaps:read`, o mesmo escopo que lista o histórico.

**O `PublicKeyGuard` é uma allowlist.** O consumer público é recusado em toda rota
que não traga `@AllowPublicKey()`, então rotas novas ficam fechadas para ele por
padrão.

Acessível com a chave pública hoje:

| Rota | Por que é seguro |
| --- | --- |
| `POST /v1/swaps/quote` | Precifica um caminho a partir do Horizon; uma função pura da requisição |
| `POST /v1/swaps` | Monta um envelope não assinado que quem chama assina |
| `POST /v1/swaps/:id/submit` | Transmite um envelope assinado por quem chama — nada sobre o swap, nem mesmo seu status, é respondido até que o corpo seja o envelope daquele swap trazendo uma assinatura; com limite de taxa |
| `POST /v1/liquidity-pools/deposit` \| `withdraw` | Montam envelopes não assinados |
| `POST /v1/liquidity-pools/operations/:id/submit` | Transmite um envelope assinado por quem chama, sob as mesmas verificações do submit de swaps; com limite de taxa |
| `GET /v1/liquidity-pools` \| `/:poolId` \| `/positions` | Dados públicos on-chain lidos do Horizon |
| `POST /v1/payment-intents/tx` \| `pay` | Montam um intent SEP-7 a partir da requisição |
| `POST /v1/activity/events` | Ingestão de telemetria — veja abaixo |
| `GET /v1/assets` | O catálogo público de ativos |
| `GET /v1/aliases/resolve/:name` \| `availability/:name` \| `by-address/:address` | Um pagador resolvendo um handle é justamente o chamador anônimo para o qual esta chave existe; a resposta é uma função pura da requisição e nunca inclui a caixa de e-mail do dono |

Recusadas: `GET /v1/swaps`, `GET /v1/swaps/:id`,
`GET /v1/liquidity-pools/operations{,/:id}`, `GET /v1/activity/events`,
`GET /v1/activity/summary`, toda leitura de payment intent, toda rota do dono de um
alias (reivindicar, listar, adicionar ou remover um endereço, liberar, recuperar) e
tudo sob `/v1/kyc`, `/v1/onramp`, `/v1/offramp` e `/v1/webhooks`. Uma carteira sem
conta lê o seu histórico no Horizon.

**A telemetria é permitida** para que os relatórios de crash de carteiras sem conta
continuem chegando. Os eventos desta chave são anônimos (um único consumer
compartilhado), então a carteira remove endereço, destino, valor e txHash antes de
enviar.

O guard identifica o consumer público **ou** pelo papel encaminhado
(`X-Consumer-Role: public`) **ou** pelo username em `APISIX_PUBLIC_CONSUMER`. Defina
os dois: se o gateway deixar de encaminhar papéis, o username continua
correspondendo, e sem o username o guard depende apenas de um header.

## Swaps nativos da Stellar (path payments)

A Stellar não tem uma operação dedicada de "swap". A troca de ativos é feita com um
**`PathPaymentStrictSend`**, que o Horizon roteia automaticamente pela melhor
combinação disponível de **order books da DEX da Stellar** e **liquidity pools AMM**.
A Cosmos Pay encapsula isso em um fluxo de swap que, assim como os payment intents, é
**completamente não custodial** — os fundos nunca passam pelo serviço. Ele apenas:

1. **Cota**, consultando a busca de caminhos strict-send do Horizon.
2. **Monta** a transação não assinada (um pagamento opcional da taxa da plataforma +
   o path payment) e retorna o seu `xdr` + URI SEP-7 `tx` + QR.
3. **Retransmite** a transação que o cliente assina na sua própria carteira.

```
quote → build XDR → customer signs in wallet → POST /submit → Stellar executes
```

A rede é determinada pelo tipo da API key (prod → public, dev → testnet), igual aos
payment intents, e todo swap é **persistido** (tabela `swap`) e vinculado ao consumer
que chama (`PENDING → SUBMITTED → SUCCEEDED/FAILED`).

**Taxa (por organização, aplicada no servidor).** A comissão é **a taxa do plano da
organização que chama**, injetada pelo gateway como um header confiável
(`X-Plan-Swap-Fee-Bps`) que a plataforma de desenvolvedores deriva do plano da
organização. Ela **nunca é um parâmetro da requisição**, e o APISIX sobrescreve
qualquer cópia enviada pelo cliente, então a taxa não pode ser contornada nem
reduzida. A taxa é cobrada do **ativo de origem** e paga à carteira da plataforma
(`STELLAR_SWAP_FEE_WALLET`) como uma primeira operação de pagamento; o **restante** é
roteado pelo swap. Se uma taxa de plano se aplica, mas nenhuma carteira da plataforma
está configurada, a criação do swap falha com `503` (erro de configuração do
operador). `STELLAR_SWAP_FEE_BPS` é apenas um fallback para desenvolvimento local sem
o gateway (e ele próprio fica desativado quando nenhuma carteira está definida).

**Slippage.** A estimativa da cotação, reduzida por `slippageBps` (padrão
`STELLAR_SWAP_SLIPPAGE_BPS`, limitado por `STELLAR_SWAP_MAX_SLIPPAGE_BPS`), vira o
`destMin` on-chain do path payment — então o swap **é revertido** em vez de entregar
menos do que quem chama aceitou receber.

**Trustline.** Um ativo de destino não nativo precisa já ter trustline na conta de
destino; a etapa de montagem verifica isso e, caso contrário, retorna um erro claro.
(XLM não precisa de trustline.)

**`POST /v1/swaps/quote`** — apenas preço, nada é persistido (`swaps:read`).

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

**`POST /v1/swaps`** — monta a transação assinável (`swaps:write`). Recebe os mesmos
campos mais `source` (a conta que paga/assina); `destination` assume `source` por
padrão (um self-swap), e um `memo` opcional (MEMO_ID) é repetido on-chain.

**Idempotência** opcional: envie um header `Idempotency-Key` (preferível) ou
`idempotencyKey` no corpo. Uma retentativa com a mesma chave **e a mesma requisição**
— rede, origem, destino, os dois ativos, valor, slippage e memo — retorna o swap
**existente** (`id` + `txHash`) em vez de montar outra transação. A mesma chave com
uma requisição diferente resulta em `409 idempotency_conflict`, e o erro não diz nada
sobre o swap armazenado. Depósitos e saques de liquidez seguem a mesma regra,
comparando também o tipo da operação. Sem chave, a constraint única
`(network, txHash)` ainda rejeita uma remontagem idêntica byte a byte com **409**
(colisão de sequence / XDR). Quando
`STELLAR_SWAP_SINGLE_INFLIGHT=true`, um segundo swap `PENDING` não expirado para o
mesmo `(consumer, source, network)` também retorna **409**, citando o id existente
(padrão **desligado** — swaps distintos e concorrentes a partir de uma mesma conta
continuam permitidos). Só segura esse guard um swap que **pode já estar on-chain**:
uma linha cujo sequence number a conta ainda não usou não pode ter liquidado, e o swap
que está sendo montado agora toma esse mesmo número, então no máximo um dos dois vai
conseguir. Qualquer um pode indicar qualquer `source`, então sem essa checagem um
único swap de poeira congelava os swaps da conta de um terceiro por toda uma janela de
expiração — e, sob a chave pública compartilhada, pelo tempo que o atacante
repetisse.

```jsonc
// response → { id, status: "PENDING", network, sendAmount, feeAmount, swapAmount,
//              destEstimated, destMin, path, xdr, uri: "web+stellar:tx?xdr=…", qr, txHash, … }
```

**Cotar e montar também têm limite**, por consumer e endereço do cliente: **60
cotações por minuto** e **20 montagens por minuto**, em buckets separados do submit.
Uma cotação não persiste nada e ainda assim custa uma busca de caminho strict-send, a
chamada mais cara que este serviço faz ao Horizon — e esse orçamento por IP é
compartilhado por swaps, liquidity pools e payment intents, então um preço consultado
em loop degradava os três de uma vez para todos os chamadores anônimos.

**`POST /v1/swaps/:id/submit`** — retransmite o envelope assinado (`swaps:write`).

```jsonc
// request
{ "signedXdr": "AAAAAgAAA…(signed base64 XDR)…" }
// response
{ "submitted": true, "status": "SUCCEEDED", "txHash": "…", "swap": { … } }
// on a network rejection → { "submitted": false, "status": "FAILED", "reason": "…", "resultCodes": ["op_under_dest_min"], "swap": { … } }
```

Antes de transmitir, o serviço verifica se o hash da transação assinada corresponde
ao da transação que ele montou, então nunca retransmite uma transação arbitrária. Um
swap dispara os eventos de webhook `SWAP_CREATED` / `SWAP_SUBMITTED` /
`SWAP_SUCCEEDED` / `SWAP_FAILED` pelo mesmo dispatcher.

**O submit é rigoroso sobre o que retransmite.** Nada sobre o swap — nem mesmo seu
status — é respondido até que `signedXdr` seja analisado, tenha o hash do `txHash`
do swap e traga ao menos uma assinatura, então o `xdr` não assinado da resposta de
criação é `400 validation_failed`. Um swap cujo envelope está fora do seu prazo
(`STELLAR_TX_TIMEOUT`, 300 s por padrão) é `400 invalid_state_transition` e não é
transmitido; se ele chegou à rede a tempo, o observer ainda o liquida. Depois de uma
rejeição da rede, o mesmo envelope pode ser reenviado no máximo **3** vezes; depois
disso, monte um novo swap — uma retentativa após `503 provider_unavailable` não
conta. A rota permite **20 chamadas por minuto** por consumer e endereço do cliente
(`429 rate_limited`); sob a chave pública compartilhada, cada carteira anônima é um
único consumer, então carteiras atrás de um mesmo NAT compartilham esse orçamento.
`POST /v1/liquidity-pools/operations/:id/submit` segue as mesmas regras, com um
orçamento só seu, e `POST /v1/liquidity-pools/deposit` · `/withdraw` dividem um
orçamento de **20 montagens por minuto** — as duas direções de um mesmo fluxo, então
buckets separados só deixariam um loop alternar entre elas e levar os dois.

## Aliases — handles de pagamento reivindicáveis

Um alias permite que um pagador digite `emanuel250` em vez de `GA5ZSE…`. O pagador
confia nesse nome logo antes de enviar dinheiro, então as regras abaixo são rígidas:
um erro significa um pagamento para a conta errada.

### Reivindicado provando o controle de uma chave, não pedindo

```
wallet ──1. POST /v1/aliases/challenges {name, address, network} ──▶ nonce + the EXACT message to sign
wallet ──2. signs SHA-256(domain ‖ 0x00 ‖ uint32be(length) ‖ message) with that address's key
wallet ──3. POST /v1/aliases {name, email, nonce, signature} ────────▶ alias bound to the calling consumer
```

- **Assine exatamente a mensagem que o serviço retorna.** Não a reconstrua no
  cliente.
- **A assinatura cobre um digest com tag de domínio, nunca uma transação.** Nada do
  que é assinado neste fluxo pode ser enviado à rede, e o domínio
  (`Cosmos Pay alias claim v1`) é exclusivo desta funcionalidade, então uma
  assinatura obtida por outro dapp não pode ser usada como reivindicação.
- **O propósito está dentro dos bytes assinados** (`CLAIM`, `ADD_ADDRESS`,
  `RECOVER`), então uma assinatura coletada para adicionar um endereço não pode ser
  reutilizada para concluir uma recuperação.
- **O endereço vem do challenge, não do corpo da reivindicação.** A reivindicação não
  tem campo de endereço, então ninguém consegue assinar por um endereço e registrar
  outro.
- **Os challenges são de uso único e duram cinco minutos.** A assinatura é verificada
  *antes* de o challenge ser consumido, então uma assinatura inválida não consegue
  consumir o nonce de outra pessoa, e consumi-lo é um compare-and-swap.
- **Uma corrida é decidida pelo índice único em `alias.name`**, e não por uma
  verificação prévia; o perdedor recebe `409 alias_taken`.

### O que um handle pode ser

`a-z` minúsculo, `0-9` e `_` (nunca em nenhuma das pontas), de 3 a 32 caracteres,
convertido para minúsculas antes de a unicidade ser decidida. Sem Unicode: o conjunto
de homóglifos é ilimitado, e nenhuma normalização torna um `а` cirílico seguro de
exibir ao lado de um valor. Também são recusadas: palavras reservadas (`admin`,
`support`, `cosmospay`, `stellar`, …) e qualquer coisa que pareça uma conta Stellar
(`g` ou `m` seguido de 20 ou mais caracteres base32). A regra está em
`src/aliases/alias-name.ts`.

### Muitos endereços, um nome

Um alias aponta para até 20 endereços em várias redes — um celular, um desktop, uma
cold wallet, testnet — com exatamente um primário por rede, garantido por um índice
único parcial. Adicionar um endereço exige **duas** provas: quem chama é dono do
alias, e o novo endereço assina o seu próprio challenge `ADD_ADDRESS`. O último
endereço restante não pode ser removido (libere o alias em vez disso), e um consumer
pode ter no máximo 25 aliases.

Um alias `SUSPENDED` (um bloqueio imposto por um operador) não resolve para nada.

### A recuperação passa pelo e-mail e pelo console da plataforma

Uma reivindicação registra um e-mail de recuperação, para que perder uma chave não
signifique perder o nome. A recuperação funciona assim:

1. O **console da plataforma** chama `POST /v1/aliases/:name/recovery {email}`. A
   resposta é idêntica quer o handle e a caixa de e-mail coincidam, quer não; quando
   coincidem, ela traz um token de uso único (30 minutos, armazenado apenas como
   SHA-256), que o console envia por e-mail. Este serviço não envia e-mail.
2. O usuário obtém um challenge `RECOVER` para a nova chave e chama
   `POST /v1/aliases/:name/recovery/complete {token, address, network, nonce, signature}`
   com a sua própria API key. As duas provas são exigidas: o token prova a caixa de
   e-mail, a assinatura prova a chave.
3. A titularidade passa para o consumer que chama e **todos os endereços anteriores
   são removidos**, então quem detém as chaves antigas deixa de receber pagamentos.

O passo 1 é exclusivo do console porque o token prova o controle da caixa de e-mail,
então ele só pode chegar a quem envia o e-mail. O `ConsoleOnlyGuard` recusa todo
chamador com API key com `403 admin_console_only` antes de o alias ser consultado, e
a rota não está no contrato publicado. Um alias suspenso não pode ser recuperado.

Um token de recuperação pode ser apresentado **cinco** vezes. Uma apresentação cujo
challenge ou assinatura falhe ainda consome uma tentativa, e a sexta é recusada; o
dono pode iniciar outra recuperação. Um token que não corresponde a nenhuma
recuperação ativa desse alias recebe o mesmo `400 alias_recovery_invalid` e não muda
nada, de modo que ninguém consegue queimar a recuperação de um dono enviando lixo.
`POST /v1/aliases/:name/recovery/complete` permite 10 chamadas e
`POST /v1/aliases/challenges` 30 chamadas a cada 10 minutos, por consumer e
endereço do cliente (`429 rate_limited`).

Challenges e recuperações expirados são apagados um dia depois de expirarem pelo
`AliasChallengeSweeperService` (de hora em hora, uma réplica por ciclo).

### Rotas

| Método | Caminho | Escopo | Descrição |
| ------ | ------- | ------ | --------- |
| GET | `/v1/aliases/resolve/:name` | `payments:read` · chave pública | Os endereços para os quais um alias resolve (`?network=` filtra) |
| GET | `/v1/aliases/availability/:name` | `payments:read` · chave pública | Se um handle pode ser reivindicado e, se não, por quê |
| GET | `/v1/aliases/by-address/:address` | `payments:read` · chave pública | Os aliases que apontam para um endereço |
| POST | `/v1/aliases/challenges` | `payments:write` | Um nonce e a mensagem exata a assinar |
| POST | `/v1/aliases` | `payments:write` | Reivindicar um alias com uma assinatura |
| GET | `/v1/aliases` | `payments:read` | Os aliases de quem chama |
| POST | `/v1/aliases/:name/addresses` | `payments:write` | Adicionar um endereço, assinado por esse endereço |
| DELETE | `/v1/aliases/:name/addresses/:addressId` | `payments:write` | Remover um endereço |
| DELETE | `/v1/aliases/:name` | `payments:write` | Liberar o alias |
| POST | `/v1/aliases/:name/recovery` | _somente console da plataforma_ | Iniciar uma recuperação → um token para o console enviar por e-mail |
| POST | `/v1/aliases/:name/recovery/complete` | `payments:write` | Concluir uma recuperação com o token e a assinatura da nova chave |

## BlindPay — onramp / offramp / KYC (fiat ⇄ stablecoin)

Além dos payment intents on-chain, o serviço integra o
[BlindPay](https://www.blindpay.com/docs) para movimentar dinheiro entre **fiat e
stablecoins**: entrada (**onramp / payin**), saída (**offramp / payout**) e o **KYC**
obrigatório (os *receivers* do BlindPay) por trás de ambos. Rodamos **uma instância
BlindPay da plataforma por ambiente de API key** — produção para keys `prod`
(`BLINDPAY_API_KEY` + `BLINDPAY_INSTANCE_ID`), desenvolvimento para keys `dev` (as
variáveis `_DEV`); todo receiver/carteira/conta bancária/payin/payout é espelhado no nosso
Postgres e **vinculado ao consumer do APISIX que chama**, então cada integrador só vê
os seus próprios registros. O serviço **nunca guarda chaves de blockchain** — o
offramp retorna o artefato a assinar (contrato EVM `approve` / XDR Stellar) e aceita
de volta a tx assinada, exatamente como os payment intents.

As mudanças de estado são sincronizadas a partir dos **webhooks Svix** do BlindPay
(verificados sobre o corpo bruto) e **reemitidas** para os endpoints de webhook do
próprio integrador como novos tipos de evento (`RECEIVER_UPDATED`, `PAYIN_*`,
`PAYOUT_*`) pelo dispatcher existente.

| Método | Caminho                                               | Escopo         | Descrição |
| ------ | ----------------------------------------------------- | -------------- | --------- |
| POST   | `/v1/kyc/receivers`                                   | `kyc:write`    | Criar um receiver (iniciar KYC/KYB) |
| GET    | `/v1/kyc/receivers` · `/:id`                          | `kyc:read`     | Listar / consultar (a consulta atualiza o status de KYC) |
| PATCH  | `/v1/kyc/receivers/:id`                               | `kyc:write`    | Atualizar um receiver (uma vez no BlindPay, campos de identidade exigem uma key elevada) |
| DELETE | `/v1/kyc/receivers/:id`                               | `kyc:write`    | Excluir um receiver |
| POST   | `/v1/kyc/upload`                                      | `kyc:write`    | Enviar um documento de KYC → `file_url` |
| GET    | `/v1/kyc/rails` · `/v1/kyc/bank-details?rail=`        | `kyc:read`     | Catálogo de rails / campos obrigatórios |
| POST   | `/v1/kyc/receivers/:id/wallets`                       | `kyc:write`    | Registrar uma carteira de blockchain |
| GET    | `/v1/kyc/receivers/:id/wallets/sign-message`          | `kyc:read`     | Mensagem a assinar (fluxo EOA seguro) |
| POST   | `/v1/kyc/receivers/:id/bank-accounts`                 | `kyc:write`    | Adicionar uma conta bancária fiat (qualquer rail) |
| POST   | `/v1/onramp/quotes`                                   | `onramp:write` | Cotar um payin (expira em ~5 min) |
| POST   | `/v1/onramp/payins`                                   | `onramp:write` | Criar um payin → instruções de pagamento |
| GET    | `/v1/onramp/payins` · `/:id`                          | `onramp:read`  | Listar / consultar (a consulta atualiza o status) |
| POST   | `/v1/onramp/trustline`                                | `onramp:write` | Montar um XDR de trustline Stellar não assinado |
| POST   | `/v1/onramp/receivers/:id/virtual-accounts`           | `onramp:write` | Criar uma conta virtual |
| POST   | `/v1/offramp/quotes`                                  | `offramp:write`| Cotar um payout (EVM → contrato `approve`) |
| POST   | `/v1/offramp/payouts/authorize`                       | `offramp:write`| Montar a tx de payout Stellar/Solana não assinada |
| POST   | `/v1/offramp/payouts`                                 | `offramp:write`| Criar um payout a partir de uma cotação |
| GET    | `/v1/offramp/payouts` · `/:id`                        | `offramp:read` | Listar / consultar (a consulta atualiza o status) |
| POST   | `/v1/offramp/payouts/:id/documents`                   | `offramp:write`| Anexar um documento de compliance |
| POST   | `/v1/blindpay/webhooks`                               | _público_      | Webhook de entrada do BlindPay (Svix) |

Os valores são **inteiros em unidades menores** (por exemplo, `$123.45` → `12345`).
Configure o webhook no dashboard do BlindPay para `<gateway>/v1/blindpay/webhooks` e
defina `BLINDPAY_WEBHOOK_SECRET` com o segredo de assinatura desse endpoint — o
valor `whsec_…` completo. O boot falha quando a sua chave decodifica para menos de
24 bytes, e o verificador recusa essa chave de qualquer forma: base64 inválido
decodifica para uma chave vazia, e qualquer um consegue assinar com ela. Deixe as
variáveis `BLINDPAY_*` em branco para desativar a funcionalidade: essas rotas passam a
retornar `503` `misconfigured`, assim como o webhook de entrada enquanto
`BLINDPAY_WEBHOOK_SECRET` não estiver definido. Veja `.env.example`.

**Uma key `dev` nunca chega à instância de produção.** O ambiente da key escolhe a
instância do BlindPay do mesmo jeito que escolhe a rede Stellar, e cada linha
espelhada registra a instância de onde veio, então as keys `dev` e `prod` de um
tenant — um mesmo consumer — veem receivers, carteiras, contas bancárias, cotações,
payins e payouts separados. Sem instância de desenvolvimento configurada, as rotas do
BlindPay respondem `503` `misconfigured` às keys `dev`. Aponte os webhooks do
dashboard das duas instâncias para o mesmo `<gateway>/v1/blindpay/webhooks` e defina
`BLINDPAY_WEBHOOK_SECRET_DEV` para a de desenvolvimento: o segredo com que uma
entrega é verificada é o que diz qual instância a enviou.

**A identidade é revisada antes de chegar ao BlindPay, inclusive nas edições.** Até um
receiver ser habilitado, um `PATCH` que toca dados de KYC o devolve para
`pending_review`. Depois que ele existe no BlindPay, uma key de tenant só pode mudar
`external_id` e `image_url`; qualquer outro campo é `403` `kyc_review_required`, a
menos que a key seja elevada (`X-Consumer-Role: admin`), porque esse `PUT` reescreve
a identidade diretamente no provedor.

**Uma aprovação fica presa ao dossiê que foi revisado.** A leitura de um receiver traz
`dossierVersion`, que conta cada edição dos dados de KYC enviados. Devolva esse valor
como `expected_version` ao aprovar e um dossiê que mudou desde que você o leu vira
`409 kyc_state_invalid`, em vez da aprovação de dados que ninguém viu — uma edição
deixa o status em `pending_review`, então a aprovação sozinha não tinha como perceber.
O que foi aprovado fica em `reviewedVersion`, e
`POST /v1/kyc/receivers/:id/enable` se recusa a criar o receiver no BlindPay enquanto
os dois forem diferentes.

**As rotas de fiat têm orçamentos.** Toda escrita que o provedor guarda é limitada por
consumer e endereço do cliente, e toda rota apoiada no BlindPay conta também contra um
teto por consumer de **60 requisições ao provedor por minuto**: uma única instância
atende todos os tenants da chave, então um tenant em loop nas cotações derruba os
payins dos outros. Passar do orçamento é `429 rate_limited` com `Retry-After`.

| Rota | Orçamento (por consumer + endereço do cliente) |
| ---- | --------------------------------------------- |
| `POST /v1/kyc/upload` | 20 a cada 10 min |
| `POST /v1/kyc/terms-of-service` | 10 a cada 10 min |
| `POST /v1/onramp/quotes` · `POST /v1/offramp/quotes` | 30 por minuto, buckets separados |
| `POST /v1/onramp/payins` | 10 por minuto |
| `POST /v1/offramp/payouts/authorize` · `POST /v1/offramp/payouts` | 10 por minuto, compartilhado |
| `POST /v1/offramp/payouts/:id/documents` | 20 a cada 10 min |
| `POST /v1/onramp/trustline` | 20 por minuto |

### As URLs de redirecionamento do KYC ficam em allow-list por consumer

O fluxo de termos de serviço envia o usuário ao BlindPay e de volta para uma
`redirect_url` fornecida pelo integrador. Para evitar um open redirect, toda
`redirect_url` passa por duas verificações:

| Camada | Regra | Onde |
| ------ | ----- | ---- |
| Formato | uma URL `https` absoluta sem credenciais embutidas (`user:pass@`), sem fragmento (`#…`) e sem barra invertida, espaços ou caracteres de controle | `@IsRedirectUrl()` em todo DTO que traz uma, e de novo na camada de serviço |
| Host | na allow-list **do consumer que chama** — o host exato, ou um subdomínio em um limite de label (`app.acme.com` corresponde a `acme.com`; `evilacme.com` não) | `KYC_REDIRECT_URL_WHITELIST`, aplicado na camada de serviço |

```
KYC_REDIRECT_URL_WHITELIST={"cosmos_acme":["acme.com","app.acme.com"]}
```

As regras de formato são o que dá valor à verificação de host. Uma barra invertida é
lida como `/` dentro da autoridade por um parser WHATWG e como parte do userinfo por
outros, então `https://app.acme.com\@evil.test` tem duas leituras honestas e este
serviço não é o último a lê-la — o valor vai ao BlindPay, volta em uma página
hospedada e termina em um navegador. Espaços e caracteres de controle são da mesma
categoria, um fragmento engole o `?tos_id=` que o provedor acrescenta, e credenciais
movem o host para o outro lado do `@`.

Ela é **fail-closed**: um consumer sem entrada não pode usar redirecionamento algum, e
um host com ponto final ou em forma IDN é recusado em vez de normalizado. Toda rota
que recebe uma `redirect_url` a verifica, incluindo a aprovação pelo admin, que usa a
lista do próprio consumer do receiver. Um esquema ou host recusado resulta em `400`.

## Pollar — login social que devolve uma carteira Stellar

A [Pollar](https://docs.pollar.xyz/docs) transforma um login Google/GitHub em uma
conta Stellar: autentica o usuário, cria uma carteira, custodia a chave no AWS KMS,
adiciona as trustlines configuradas e financia a reserva — o usuário nunca vê uma
seed phrase. Este serviço a expõe como uma **bridge OAuth**.

### Por que uma bridge e não um passthrough

O login hospedado da Pollar foi projetado para um SDK de navegador. Ele leva o
usuário a `GET /auth/{provider}` com uma publishable key, um id de client session e
uma `redirect_uri` — e essa redirect URI precisa ser um host **registrado na
Pollar**. Uma carteira não consegue cumprir esses requisitos: um listener de loopback
ou um deep link `cosmospay://` nunca é um host registrado, e a carteira não deveria
lidar com essas chaves e ids de sessão. Então a bridge cuida do lado da Pollar, e a
carteira faz só dois passos: **abrir uma autorização, resgatar um código**.

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

A partir do passo 6, a carteira fala diretamente com a Pollar: a resposta do resgate
inclui a `publishable_key` e a `api_base_url`, que a carteira usa para ler saldos e
montar e enviar transações. **Este serviço não faz proxy dessas chamadas.**

### Duas formas de absorver o código

|                  | Fluxo de redirect                                | Fluxo de polling                                |
| ---------------- | ------------------------------------------------ | ----------------------------------------------- |
| A carteira fornece | `redirect_uri` (precisa estar na allow-list) e um `code_challenge` PKCE | nada (PKCE opcional) |
| O código chega   | como `?code=…&state=…` no redirect               | por `GET /v1/pollar/oauth/sessions/{state}`     |
| O navegador vê   | a sua própria URI                                | uma página simples de "você pode fechar esta janela" — nunca o código |
| Use quando       | a carteira tem um deep link ou um listener de loopback | não tem nenhum dos dois (quiosque, headless, view embutida) |

Cada polling emite um código novo e invalida o anterior, então resgate o código do
seu polling mais recente. Só um SHA-256 do código é armazenado.

**Prefira o fluxo de polling.** O fluxo hospedado da Pollar não devolve o navegador
para o callback: ele termina na sua própria página (`www.pollar.xyz/auth/status`) e
marca a client session como `READY` do lado da Pollar. Por isso, enquanto um
handshake está `pending`, a rota de polling consulta a client session na Pollar e
promove o handshake assim que a Pollar informa `READY`.

- **Mantenha a rota de callback registrada na Pollar.** O fluxo de redirect depende
  dela.
- **A Pollar é consultada no máximo uma vez a cada dois segundos por handshake**
  (`POLLAR_SESSION_PROBE_INTERVAL_MS`), limite compartilhado entre as réplicas por
  meio de `providerCheckedAt`. Uma carteira fazendo polling a cada segundo custa 30
  requisições por minuto à Pollar, contra um orçamento de 200 da chave.

Um handshake cuja client session a Pollar rejeita (`INVALID_CLIENT_SESSION_ID`,
`EXPIRED_CLIENT_ID`, ou um `404`/`410`) é encerrado imediatamente como `failed` com
esse código.

### Um login, uma carteira em ambas as redes

A Pollar roda mainnet e testnet como aplicações separadas, com pares de chaves
separados, então um login hospedado só cria uma carteira na rede para a qual a sua
API key resolve (`prod` → `public`, `dev` → `testnet` — veja `resolveNetwork`). Para
dar ao usuário uma carteira nas duas, um resgate na **mainnet** também o registra na
**testnet**, pelo `POST /users/with-wallet` da Server API, e `POST /v1/pollar/oauth/token`
informa as duas. Um resgate na testnet não provisiona a mainnet: a testnet é onde caem as
keys `dev`, e uma key que qualquer um pode gerar não deve gastar XLM real numa reserva de
mainnet a cada login. A carteira de mainnet desse usuário vem do seu primeiro login na
mainnet.

```jsonc
"network_wallets": [
  { "network": "public",  "status": "ready",   "address": "GA5Z…" },
  { "network": "testnet", "status": "pending", "address": null    }
]
```

**Uma entrada `pending` não é um erro.** O login teve sucesso; só a segunda carteira
ainda não está pronta, e ela nunca faz o login falhar. A requisição faz uma única
tentativa de cinco segundos; o que não terminar é retentado em segundo plano pelo
sweeper de provisionamento (`POLLAR_SWEEP_*`), com backoff exponencial e até dez
tentativas antes de a linha passar a `failed`.

A causa mais comum de `pending` é que **as chaves da outra rede não estão
configuradas**. Assim que forem definidas, a próxima varredura provisiona o backlog
sem que os usuários precisem fazer login de novo, então defina as chaves das duas
redes mesmo que você só atenda uma.

- **Os usuários são associados pelo e-mail do OAuth**, a mesma chave que um login
  hospedado na outra rede usa. Um provedor que não retorna e-mail não recebe segunda
  carteira.
- **Um login na mainnet gasta XLM nas duas redes** — a própria reserva e uma na
  testnet. Um login na testnet só gasta XLM de testnet. O estado fica em `pollar_user_wallet`, uma linha por
  (consumer, email, network), então um login repetido não provisiona de novo.

### O que a bridge armazena

Uma linha de handshake, sem nada que possa gastar dinheiro: o `state` impossível
de adivinhar, o id da client session da Pollar, um **hash** do código e o endereço
Stellar público resultante. **Nenhum token da Pollar é persistido** — a troca
`/auth/login` roda dentro da requisição de resgate e os tokens saem direto na
resposta dela. Handshakes que ninguém concluiu são expirados por um timer
(`POLLAR_SWEEP_*`), porque uma linha `AUTHORIZED` é um código resgatável até ser
varrida.

Toda transição é um compare-and-swap no status da linha, então um callback repetido
não emite um segundo código, e duas carteiras disputando um mesmo código não podem
vencer as duas.

### Endurecimento

- **PKCE (RFC 7636, S256)** é **obrigatório no fluxo de redirect** e opcional no de
  polling: passe `code_challenge` no authorize e `code_verifier` no resgate, e um
  código que vaze de um navegador ou de um log fica inútil sem o verifier. Um código
  do fluxo de redirect atravessa um navegador, e o callback público o entrega a quem
  apresentar o `state` — que está dentro de `authorization_url` —, por isso
  `authorize` com `redirect_uri` e sem `code_challenge` é `400 validation_failed`.
- **`dpop_jwk`** vincula os tokens que a Pollar emite à própria chave P-256 da
  carteira (RFC 9449), então um access token roubado fica inerte sem uma prova
  assinada. Isso também significa que a bridge não pode mais agir em nome da carteira
  — `/refresh` e `/logout` atendem sessões bearer, e uma carteira vinculada por DPoP
  chama a Pollar diretamente.
- **`POLLAR_REDIRECT_URI_WHITELIST`** é por consumer e fail-closed, já que a
  redirect URI recebe o código. Aceita hosts de loopback (qualquer porta, conforme a
  RFC 8252), deep links com esquema de uso privado e hosts https.
- **Uma sessão só volta para a conta que consentiu.** Todos os tenants compartilham uma
  aplicação da Pollar, e um link de login funciona no navegador de qualquer pessoa: uma key
  poderia enviar a sua `authorization_url` a alguém, esperar o consentimento e resgatar a
  carteira dessa pessoa — PKCE e `dpop_jwk` não ajudam, porque foi essa key que abriu o
  handshake. Por isso `POST /v1/pollar/oauth/token` compara o e-mail que a Pollar informa
  para o login com o e-mail da conta que o gateway encaminha para a key
  (`X-Consumer-Email`, veja `APISIX_EMAIL_HEADER`). Uma divergência revoga a sessão na
  Pollar, marca o handshake como `failed` e retorna `403 pollar_identity_mismatch`; uma
  key sem e-mail encaminhado é recusada no `authorize` com `403 pollar_identity_required`.
  A única exceção é o onboarding intermediado do dev platform (`X-Cosmos-Internal`): ele
  faz login de pessoas que ainda não têm key, e comprova o e-mail por conta própria antes
  de entregar qualquer coisa.
- **`POST /v1/pollar/users` e `/users/with-wallet` exigem uma key elevada**
  (`X-Consumer-Role: admin`, caso contrário `403 elevated_key_required`). Um usuário
  registrado ali é o mesmo que um login social posterior resolve pelo e-mail; de outra
  forma, uma key de tenant poderia reivindicar o e-mail de um estranho e ficar registrada
  como dona da carteira que ele recebe.

### Rotas

| Método | Caminho                                               | Escopo         | Descrição |
| ------ | ----------------------------------------------------- | -------------- | --------- |
| POST   | `/v1/pollar/oauth/authorize`                          | `pollar:write` | Abrir um login → `authorization_url` + `state` |
| GET    | `/v1/pollar/oauth/callback/:state`                    | _público_      | Para onde a Pollar devolve o navegador (uma navegação — não há chave para enviar) |
| GET    | `/v1/pollar/oauth/callback?state=`                    | _público_      | O mesmo callback, para uma cadeia de redirects que preserva a query, mas não o path |
| GET    | `/v1/pollar/oauth/sessions/:state`                    | `pollar:read`  | Consultar um handshake e coletar o seu código |
| POST   | `/v1/pollar/oauth/token`                              | `pollar:write` | Resgatar o código → sessão Pollar + carteira |
| POST   | `/v1/pollar/oauth/refresh`                            | `pollar:write` | Rotacionar um par de tokens (sessões bearer) |
| POST   | `/v1/pollar/oauth/logout`                             | `pollar:write` | Revogar uma sessão (este dispositivo, ou todas) |
| POST   | `/v1/pollar/wallets/activate`                         | `pollar:write` | Financiar a reserva de XLM (modo de financiamento Deferred) |
| POST   | `/v1/pollar/wallets/:address/trustlines/default`      | `pollar:write` | Habilitar os ativos configurados do app |
| POST   | `/v1/pollar/wallets/:address/trustlines`              | `pollar:write` | Habilitar ativos específicos |
| DELETE | `/v1/pollar/wallets/:address/trustlines/:code/:issuer`| `pollar:write` | Remover uma trustline (somente com saldo zero) |
| POST   | `/v1/pollar/users` · `/v1/pollar/users/with-wallet`   | `pollar:write` | Registrar um usuário, opcionalmente com uma carteira (só keys elevadas) |
| POST   | `/v1/pollar/tokens/verify`                            | `pollar:read`  | Validar um token que uma carteira apresentou a você |

As últimas seis usam a chave **secreta** da Pollar, e é por isso que rodam aqui e
não na carteira.

### Rate limiting

Criar uma carteira Pollar custa dinheiro: a Pollar cria a conta Stellar, financia a
sua reserva base (1 XLM) e adiciona uma trustline por ativo configurado (0.5 XLM
cada) **a partir da sua carteira de financiamento**. Um script em loop sobre o fluxo
de login poderia gastar isso sem nenhum usuário real, então este serviço aplica os
limites por conta própria, antes que qualquer XLM seja gasto.

**O limite fica no `authorize`, não no `token`.** Um handshake gera no máximo uma
carteira, então limitar os handshakes por endereço limita as carteiras. `token` é
mais frouxo porque os clientes são orientados a repeti-lo enquanto a Pollar
provisiona a conta, e resgatar não cria nada novo.

| Rota | Orçamento (por 10 min) | Por quê |
| ---- | ---------------------- | ------- |
| `POST /v1/pollar/oauth/authorize` | 20 | Limita a criação de carteiras |
| `POST /v1/pollar/oauth/token` | 60 | Os clientes o repetem enquanto a conta é provisionada |
| `GET /v1/pollar/oauth/callback` | 60 | A única acessível sem API key |
| `GET /v1/pollar/oauth/sessions/{state}` | 400 | Uma carteira faz polling a cada poucos segundos; cada polling pode chegar à Pollar |
| `POST /v1/pollar/oauth/refresh` · `/logout` | 60, compartilhado | Uma requisição à Pollar cada |
| `POST /v1/pollar/users` · `/users/with-wallet` | 10, compartilhado | Escrevem no diretório de usuários que todos os tenants compartilham; `with-wallet` também cria uma carteira sem tela de consentimento |
| `POST /v1/pollar/wallets/activate` | 20 | Gasta XLM a cada chamada |
| `POST /v1/pollar/wallets/:address/trustlines` · `/default` | 20, compartilhado | Cada asset bloqueia reserva da carteira de financiamento |
| `DELETE /v1/pollar/wallets/:address/trustlines/:code/:issuer` | 20 | Uma requisição à Pollar cada |
| `POST /v1/pollar/tokens/verify` | 120 | Uma requisição à Pollar cada |

**Dois tetos são por consumer em vez de por endereço**, então trocar de endereço não os
multiplica: as requisições à Pollar que um consumer pode causar (100 por minuto, em todas
as rotas acima exceto o polling e o callback — a Pollar orça a key em 200 por minuto e
todos os tenants a compartilham) e as carteiras que ele pode causar (`authorize` e
`users/with-wallet`, 50 por dia). As chamadas do console (`X-Cosmos-Internal`) ficam
isentas de ambos: o dev platform intermedia toda carteira sem key através de um único
consumer e orça esse tráfego por conta própria.

Exceder um deles retorna **`429` com `code: "rate_limited"`**, um `Retry-After` e os
headers `RateLimit-Limit` / `-Remaining` / `-Reset`. O mesmo limitador protege
as rotas fora do Pollar cujo custo um erro não devolve — os construtores de swap e de
liquidity-pool e os seus submits, os construtores de payment intent, o upload de
documentos e os termos de serviço do KYC, as escritas de onramp e offramp (com um teto
por consumer do BlindPay por cima), `ping` e `redeliver` de webhook, challenges e
recuperação de alias, ingestão de activity — e cada seção informa o seu orçamento. O rate limiting geral é papel do APISIX.

**O contador fica no Postgres, não em memória**, então o limite vale para todas as
réplicas juntas. É uma janela fixa (um `INSERT … ON CONFLICT … RETURNING` atômico por
requisição), então um cliente pode usar um orçamento inteiro de cada lado de uma
virada de janela.

**Endereço do cliente.** `main.ts` define `trust proxy` como `1`, então o Express lê a
entrada *mais à direita* de `X-Forwarded-For` — a que o APISIX acrescentou. As
entradas que um cliente adiciona ficam à esquerda dela e são ignoradas.

> **Não aumente `trust proxy`.** Em `2`, o Express confia em um hop fornecido pelo
> cliente, e qualquer cliente consegue contornar esses limites com um header.

Chamadores IPv6 são agrupados por **/64**, já que um cliente normalmente controla um
/64 inteiro; usuários que compartilham um /64 compartilham um limite, como
aconteceria atrás de um NAT IPv4. Os limites também são por consumer, então o tráfego
de um integrador não afeta o de outro.

Se o contador não puder ser gravado, o limitador é **fail-closed** (`503`); essas
rotas precisam do banco de qualquer forma. Defina `RATE_LIMIT_ENABLED=false` para
desligar os limites durante um incidente.

### Configuração

1. Crie um app em [dashboard.pollar.xyz](https://dashboard.pollar.xyz) e pegue as duas
   chaves da sua rede (`pub_testnet_…` / `sec_testnet_…`). Faça isso para **as duas**
   redes: um login na mainnet também provisiona uma carteira na testnet, e sem chaves de
   testnet essa segunda carteira fica `pending` até que elas sejam definidas. Os dois
   dashboards são separados — registre o host de callback em cada um.
2. Registre o **host do gateway** de `POLLAR_BRIDGE_CALLBACK_URL` em
   **Build → Domains**. A SDK API verifica essa lista em *toda* chamada, contra o
   header `Origin`, que a bridge define com esse host (`POLLAR_SDK_ORIGIN` o
   sobrescreve). Um host não registrado recebe `403 ORIGIN_NOT_ALLOWED` em
   `POST /auth/session`, a primeira chamada de todo login.
3. Defina `POLLAR_BRIDGE_CALLBACK_URL` como `<gateway>/v1/pollar/oauth/callback` — a
   bridge acrescenta `/{state}` por conta própria.
4. Adicione a redirect URI de cada carteira a `POLLAR_REDIRECT_URI_WHITELIST`, ou
   omita-a e use o fluxo de polling.

A Pollar codifica a rede e o tipo de chave no prefixo da chave, e o validador de env
rejeita uma incompatibilidade no boot. Deixe as chaves em branco para desativar a
funcionalidade (as rotas da Pollar passam a retornar `503`). Veja `.env.example`.

## Atualização — mudanças incompatíveis e notas de deploy

### Correções da revisão de segurança

A maioria destas mudanças não altera nada para quem chama de forma correta; confira
a coluna "Quem percebe" antes do deploy.

| Mudança | Quem percebe | Por quê |
| ------- | ------------ | ------- |
| `POST /v1/aliases/:name/recovery` é **exclusiva do console da plataforma**: uma API key recebe `403 admin_console_only`, e a rota saiu do contrato publicado | Quem iniciava recuperações com uma API key | A resposta traz o token de recuperação, que prova o controle da caixa de e-mail do dono |
| Concluir uma recuperação em um alias `SUSPENDED` resulta em `404` | Ninguém legítimo | Um token emitido antes de uma suspensão podia contornar o bloqueio do operador |
| Rotas `@Public()` (callback da Pollar, webhook do BlindPay, health) ignoram `X-Consumer-Username` | Dashboards: essas requisições agora aparecem no log como anônimas | Essas rotas não têm key-auth, então o header vinha do cliente |
| Recusas do `AdminGuard` e do `ConsoleOnlyGuard` são registradas em nível `warn` | Operadores | Os guards rodam antes do log de acesso, então as requisições recusadas não deixavam rastro |
| `POST /v1/pollar/wallets/activate` e as três rotas `/v1/pollar/wallets/:address/trustlines…` retornam `404` para uma carteira que o consumer que chama não obteve por meio deste serviço naquela rede | Integradores que agem sobre carteiras que só viram via `tokens/verify`, sobre carteiras não primárias de um login ou sobre uma carteira de contraparte que outro tenant já registrou | Todos os tenants compartilham um único conjunto de chaves secretas da Pollar. Carteiras alheias e desconhecidas recebem o mesmo `404`, então a resposta não revela a titularidade |
| As duas rotas `POST …/trustlines` compartilham um orçamento de `429` de 20 chamadas a cada 10 minutos | Scripts que adicionam trustlines em massa | Cada trustline trava 0.5 XLM da carteira de financiamento do operador |
| `GET /v1/offramp/payouts/:id` não retorna mais `raw`, `consumerId`, `receiverId`, `quoteId`, `bankAccountId` nem `updatedAt`; a resposta de criação de conta virtual não retorna mais `raw`, `receiverId`, `consumerId` nem `updatedAt` | Quem lê esses campos | `raw` é o objeto armazenado do BlindPay, com dados bancários e do beneficiário |
| `POST /v1/kyc/upload` retorna `400` para mais de 4 campos de texto, um campo acima de 1 KiB, um segundo arquivo ou bytes de arquivo que não correspondem ao tipo declarado | Ninguém que envie um upload bem formado | Os campos não tinham limite e a verificação de tipo confiava no `Content-Type` do cliente |
| `POST /v1/payment-intents/tx` e `/pay`: o mesmo memo com qualquer termo diferente resulta em `409 idempotency_conflict`. Uma repetição idêntica continua retornando o intent armazenado (`2` e `2.0` são o mesmo valor) | Quem reutiliza um memo para pagamentos diferentes | Sob a chave pública compartilhada, um memo que outra pessoa criou primeiro retornava o intent dela |
| `POST /v1/payment-intents/:id/validate` marca `FAILED` somente para uma tx com falha que seja o próprio pagamento deste intent; qualquer outra tx com falha resulta em `valid: false` com o status inalterado. Uma tx fechada mais de 60 s antes de o intent ser criado é recusada ("Transaction predates this payment intent") — no validate, no `PATCH {status: SUCCEEDED}` e no observer | Ninguém legítimo | Qualquer transação com falha podia fazer um intent falhar, e um pagamento antigo com os mesmos termos podia liquidar um intent novo |
| `PATCH /v1/payment-intents/:id` alterando o `txHash` de um intent em estado terminal resulta em `400 invalid_state_transition`; uma mudança de status concorrente com a escrita resulta em `409 operation_in_flight` | Ninguém legítimo | Isso podia reescrever a evidência de liquidação de um intent `SUCCEEDED` |
| O observer de payment intents reconcilia no máximo 10 intents por consumer por ciclo e nunca varre linhas expiradas | Operadores que acompanham a vazão do observer | Um único consumer podia atrasar a liquidação de todos os outros tenants |
| `POST /v1/swaps`, `/v1/liquidity-pools/deposit` e `/withdraw`: um `Idempotency-Key` reutilizado com uma requisição diferente — outro memo ou slippage, a outra rede, ou uma chave de depósito reutilizada para um saque — resulta em `409 idempotency_conflict`. Uma repetição com ativo, slippage ou memo inválido agora recebe o `400` normal | Clientes que reutilizam uma chave para operações diferentes | Sob a chave pública compartilhada, alguém podia criar de antemão um envelope sob uma chave adivinhável e fazê-lo ser retornado na retentativa de outro usuário |
| `POST /v1/liquidity-pools/withdraw` não responde mais `409 operation_in_flight` para um saque em andamento cujo número de sequência a conta ainda não usou (um envelope não assinado ou abandonado) | Usuários de carteira que ficavam bloqueados | Um envelope montado para a conta de outra pessoa podia bloquear indefinidamente os saques daquela posição |
| O observer de liquidação processa no máximo 10 linhas por consumer, por tabela, por ciclo, e `GET /v1/liquidity-pools/positions` lê o Horizon por meio de uma única listagem paginada em vez de uma requisição por pool | Operadores | Um único consumer podia atrasar a liquidação de todos os outros, e muitas participações em pools significavam chamadas sem limite ao Horizon |
| `GET /v1/onramp/payins/:id` não retorna mais `receiverId` nem `updatedAt` — o mesmo formato que `GET /v1/onramp/payins` retorna | Quem lê esses dois campos na leitura de um único payin | O mesmo payin podia chegar em dois formatos |
| `POST /v1/kyc/upload` com um arquivo acima de 10 MiB é `413` com `code: "payload_too_large"`; antes era `internal_error` | Integradores que decidem pelo `code` | É um limite do lado do cliente, não um erro do servidor |
| `POST /v1/liquidity-pools/deposit`, `/withdraw`, `GET /v1/liquidity-pools/operations`, `/operations/:id`, `POST /v1/liquidity-pools/operations/:id/submit` e os webhooks `LIQUIDITY_*` agora trazem `memo` (o MEMO_ID de quem chama, ou `null`). Operações criadas antes da migration `20260915120000_liquidity_pool_operation_memo` retornam `null` mesmo quando o envelope carrega um | Ninguém, a menos que um cliente rejeite campos desconhecidos | O memo só ficava armazenado dentro do XDR |
| O contrato publicado de `GET /v1/swaps` e `GET /v1/liquidity-pools/operations` não declara mais `qr` nem `commissionMemo` nos itens da lista. As respostas não mudam — esses dois campos nunca foram enviados ali; obtenha-os lendo o item individual | Clientes gerados a partir do spec OpenAPI | O contrato declarava os itens da lista com o formato do item individual |
| O serviço recusa iniciar quando `APISIX_GATEWAY_SECRET` é um placeholder — o valor que o `.env.example` costumava trazer, ou qualquer coisa contendo `replace-with`, `change-me`, `your-secret` ou `placeholder` — e o `.env.example` agora o deixa vazio | Deploys ainda rodando o valor copiado do `.env.example` | Esse valor é público e longo o suficiente para passar do piso de 32 caracteres, então qualquer um que alcançasse o serviço podia nomear qualquer consumer e chegar a `/v1/admin` |
| O serviço recusa iniciar quando `BLINDPAY_WEBHOOK_SECRET` está definido mas a sua chave (o base64 depois de `whsec_`) é malformada ou decodifica para menos de 24 bytes, e `POST /v1/blindpay/webhooks` rejeita toda entrega enquanto a chave configurada estiver inutilizável | Deploys com um segredo truncado ou digitado errado, cujos webhooks do BlindPay já estavam falhando | O Node decodifica base64 inválido para uma chave HMAC curta ou vazia sem erro, e uma entrega assinada com uma chave vazia pode ser forjada por qualquer um |
| `GET /v1/health/readiness` responde uma verificação com falha com o envelope de erro padrão (`error: "Service Unavailable"`); antes colocava o relatório de saúde, incluindo a mensagem de erro do banco, em `error` | Probes que leem o relatório do corpo em vez do status code | A rota é `@Public()`, e a mensagem do Prisma nomeia o host e o usuário do banco |
| `POST /v1/onramp/receivers/:id/virtual-accounts` é `403 account_disabled` quando o receiver, ou o receiver dono de `blockchain_wallet_id`, está desabilitado | Ninguém legítimo | Era a única operação fiat que o kill switch não cobria: uma conta desabilitada ainda podia abrir um novo trilho de depósito |
| `POST /v1/pollar/oauth/token` não resgata mais um código que um polling mais recente de `GET /v1/pollar/oauth/sessions/:state` substituiu, mesmo quando esse polling ocorre no meio do resgate | Ninguém legítimo | A claim correspondia ao handshake mas não ao código, então um código aposentado ainda podia ser gasto nessa janela |
| `POST /v1/swaps/:id/submit` e `POST /v1/liquidity-pools/operations/:id/submit` verificam o envelope antes de qualquer outra coisa: um corpo que não analisa, que não é o envelope da linha, ou que não traz assinaturas é `400 validation_failed` seja qual for o status da linha. Um `signedXdr` arbitrário não retorna mais uma linha `SUCCEEDED`, e uma linha `EXPIRED` responde a um corpo incompatível com `validation_failed` em vez de `invalid_state_transition` | Clientes que enviavam o `xdr` não assinado e contavam com a rejeição `tx_bad_auth` | Assinaturas não mudam o hash de uma transação, então o envelope não assinado podia ser retransmitido e rejeitado em loop, e sob a chave pública compartilhada só o id da linha bastava para ler uma linha já liquidada |
| As duas rotas de submit recusam um envelope fora do seu prazo (`400 invalid_state_transition`, não transmitido; o observer ainda o liquida se ele chegou à rede) e uma linha `FAILED` já reenviada 3 vezes (`400 invalid_state_transition`: monte uma nova). Uma retentativa após `503 provider_unavailable` não conta | Clientes que reenviam o submit em loop: pare em `invalid_state_transition` | Cada reenvio recusado era uma submissão ao Horizon e um novo evento de webhook terminal, sem limite |
| As duas rotas de submit permitem 20 chamadas por minuto por consumer e endereço do cliente, em orçamentos separados (`429 rate_limited`) | Carteiras atrás de um mesmo NAT compartilhando a chave pública | As rotas aceitam a chave pública compartilhada, e cada chamada pode transmitir para o Horizon |
| `GET /v1/webhooks`, `GET /v1/webhooks/:id` e `PATCH /v1/webhooks/:id` retornam apenas os campos documentados do endpoint; `POST /v1/webhooks` e `POST /v1/webhooks/:id/rotate-secret` retornam esses mais `secret`. `consumerId`, `previousSecret` e `previousSecretExpiresAt` saíram dos cinco | Quem lê esses campos | `previousSecret` é um segredo de assinatura que um integrador ainda pode aceitar, e uma chave com apenas `webhooks:read` conseguia lê-lo |
| Um token de recuperação que não corresponde a nenhuma recuperação ativa do alias deixa de contar contra ela. Um token ativo consome uma tentativa em toda apresentação, inclusive uma cujo challenge ou assinatura depois falha; após cinco é `400 alias_recovery_invalid` | Ninguém legítimo | Nomes de alias são públicos, então cinco tokens de lixo vindos de qualquer chave queimavam toda recuperação que o console iniciava |
| `POST /v1/aliases/:name/recovery/complete` (10 a cada 10 min), `POST /v1/aliases/challenges` (30), `POST /v1/webhooks/:id/ping` (20) e `POST /v1/webhooks/:id/deliveries/:deliveryId/redeliver` (30) são `429 rate_limited` acima do orçamento, por consumer e endereço do cliente | Scripts que fazem loop nessas rotas | Cada chamada grava uma linha, tenta um token de recuperação, ou envia requisições para uma URL que quem chama escolheu |
| `PATCH /v1/payment-intents/:id` exige que `txHash` seja um hash de transação Stellar em hex de 64 caracteres (qualquer outra coisa é `400`) e o armazena em minúsculas; `POST /v1/payment-intents/:id/validate` converte o seu próprio para minúsculas. Um hash é único entre os intents de um consumer, em vez de em todos os tenants, e um hash já presente em outro dos seus intents é `409 idempotency_conflict` (era `500`) | Chamadores enviando hashes placeholder ou truncados | Qualquer tenant podia estacionar o hash de transação de outro tenant em um intent próprio; a liquidação do outro tenant então caía no índice global, respondia `500`, e o intent pago expirava sem `PAYMENT_INTENT_SUCCEEDED` |
| Um intent `EXPIRED` passa a `SUCCEEDED` quando o seu pagamento é verificado on-chain: pelo observer, que agora verifica a chain antes de expirar, ou por `POST /v1/payment-intents/:id/validate` e `PATCH {status: SUCCEEDED}`, que passam a responder `200` em vez de `400 invalid_state_transition`. `PAYMENT_INTENT_SUCCEEDED` pode seguir a atualização que `EXPIRED` disparou | Consumidores de webhook que tratam `EXPIRED` como final | A expiração nunca olhava para a chain, e o verificador lia apenas os 50 pagamentos mais recentes ao destino, então um pagamento atrasado ou enterrado deixava um intent pago `EXPIRED` para sempre |
| `POST /v1/pollar/oauth/authorize` com `redirect_uri` exige `code_challenge` (PKCE, S256), e resgatar esse handshake exige `code_verifier`; sem ele a chamada é `400 validation_failed` antes de uma sessão Pollar ser aberta. O fluxo de polling não muda | Carteiras do fluxo de redirect que não enviam PKCE | O callback público entrega o código a quem apresentar o `state`, que está dentro de `authorization_url`, e sem PKCE esse código era resgatado como estava |
| As respostas de swaps, operações de liquidity pool, payment intents e customers retornam apenas os campos documentados, mais `expiresAt` em swaps e payment intents, agora documentado. `consumerId` e a contabilidade de liquidação (`settlementEpoch`, `lastCheckedAt`, `notFoundStreak`, `sharesReceived`, `settledAmountA`/`B`, `horizonCursor`) não são mais enviados | Quem lia esses campos | São internos, e várias dessas rotas são alcançáveis com a key pública compartilhada |
| `PATCH /v1/kyc/receivers/:id` em um receiver que já existe no BlindPay é `403 kyc_review_required` para qualquer campo exceto `external_id` e `image_url`, a menos que a key seja elevada (`X-Consumer-Role: admin`) | Integradores corrigindo a identidade de um receiver ativo com uma key de tenant: passe pelo revisor | O `PUT` enviava dados de identidade nunca revisados direto a um provedor regulado, enquanto a mesma edição antes de habilitar volta para revisão |
| As rotas do BlindPay usam a instância do ambiente da key: keys `prod` a das variáveis `BLINDPAY_*` sem sufixo, keys `dev` a de `BLINDPAY_*_DEV`, e uma key `dev` sem instância de desenvolvimento configurada recebe `503 misconfigured`. Receivers, carteiras, contas bancárias, contas virtuais, cotações, payins e payouts só são lidos e executados nessa instância | Quem usa o BlindPay com keys `dev` | Uma key `dev` operava a instância de produção: podia listar e excluir identidades KYC reais e criar payouts reais |
| `POST /v1/pollar/oauth/token` só retorna uma sessão quando o e-mail que a Pollar informa para o login é o e-mail da conta que o gateway encaminha para a key (`X-Consumer-Email`). Uma divergência revoga a sessão, falha o handshake e é `403 pollar_identity_mismatch`; uma key sem e-mail encaminhado recebe `403 pollar_identity_required` no `authorize` | Tenants que fazem login dos próprios usuários finais pela aplicação compartilhada da Pollar, e quem entra com um e-mail diferente do da sua conta | Todos os tenants compartilham uma aplicação da Pollar e um link de login funciona em qualquer navegador: uma key podia enviar a sua `authorization_url` a alguém, esperar o consentimento e resgatar a carteira custodiada dessa pessoa |
| `POST /v1/pollar/users` e `/v1/pollar/users/with-wallet` exigem uma key elevada; uma key de tenant recebe `403 elevated_key_required` | Integradores que pré-registram usuários com uma key de tenant | Um usuário registrado é o que um login social posterior resolve pelo e-mail, então uma key de tenant podia reivindicar o e-mail de um estranho e ficar registrada como dona da carteira dele |
| Um login na testnet não provisiona mais uma carteira de mainnet para o usuário: `network_wallets` num resgate na testnet lista só a carteira da testnet. Um login na mainnet continua provisionando a testnet | Quem lê uma entrada de mainnet de um login na testnet | Uma key `dev` que qualquer um pode gerar gastava XLM real do operador numa reserva de mainnet a cada login |
| As rotas da Pollar de polling, refresh, logout, verificação de token, registro de usuários e remoção de trustline têm limite, e além dos orçamentos por endereço valem uma cota por consumer (100 requisições à Pollar por minuto) e um teto de carteiras (50 por dia); o excesso é `429 rate_limited` | Clientes que martelam essas rotas | Não tinham limite, e cada chamada gasta o orçamento de requisições à Pollar que todos os tenants compartilham — um tenant podia derrubar os logins de todos os outros |
| `POST /v1/kyc/receivers/:id/approve` aceita `expected_version` (o `dossierVersion` que você leu) e responde `409 kyc_state_invalid` quando os dados de KYC mudaram desde então. `POST /v1/kyc/receivers/:id/enable` recusa um dossiê que não é o aprovado, e as leituras de receiver trazem `dossierVersion` e `reviewedVersion` | Os revisores, quando começarem a enviar `expected_version`; mais ninguém — o campo é opcional | Uma revisão é uma pessoa lendo os dados e então aprovando, e uma edição no meio deixa o status em `pending_review`, então a aprovação recaía sobre um dossiê que ninguém tinha visto e o `enable` o enviava a um provedor regulado |
| `POST /v1/kyc/upload`, `/v1/kyc/terms-of-service`, as escritas de onramp e offramp, `POST /v1/payment-intents/tx` e `/pay`, `POST /v1/swaps/quote` e `/v1/swaps`, e `POST /v1/liquidity-pools/deposit` e `/withdraw` agora respondem `429 rate_limited` acima do orçamento, por consumer e endereço do cliente. Toda rota apoiada no BlindPay conta também contra um teto por consumer de 60 requisições ao provedor por minuto | Scripts que rodam essas rotas em loop; um importador em lote acima do teto deve ter a própria chave | Não tinham limite nenhum: cada uma deixa algo no provedor que erro nenhum devolve, ou gasta o orçamento por IP do Horizon que todas as rotas daqui compartilham. Só os submits eram limitados |
| `POST /v1/swaps` não responde mais `409 operation_in_flight` para um swap `PENDING` cujo sequence number a conta ainda não usou (um envelope não assinado ou abandonado). Só vale com `STELLAR_SWAP_SINGLE_INFLIGHT=true` | Usuários de carteira que ficavam bloqueados | Qualquer um pode indicar qualquer `source`, então um swap de poeira congelava a conta de um terceiro uma janela de expiração após a outra — o gêmeo da correção de liquidity pools acima |
| Um destino de webhook recusado pelo host — não resolve, privado, link-local, metadata — é um único `400` com uma única mensagem; o motivo fica no log do serviço. Uma URL malformada, um esquema que não é https, credenciais ou a falta de host continuam dizendo o que está errado | Integradores que liam o motivo na resposta | Cadastrar um endpoint resolve um nome que este serviço alcança, então uma resposta por motivo permitia mapear a rede interna uma URL por vez |
| Uma `redirect_url` é recusada quando traz fragmento, barra invertida, espaços ou caractere de controle; https sem credenciais embutidas já era obrigatório | Ninguém que envie uma URL comum | `https://app.acme.com\@evil.test` nomeia um host diferente dependendo de quem a analisa, e o valor ainda é lido pelo BlindPay e por um navegador |
| O serviço se recusa a subir quando `POLLAR_BRIDGE_CALLBACK_URL` é `http` puro em um host roteável | Deploys que terminam TLS em outro ponto e configuram o callback como `http` | A Pollar devolve o navegador para essa URL com o código de autorização na query string, e esse código é trocado pela sessão do usuário |

Notas de deploy que vêm junto:

- **A migration `20260910120000_aliases`** cria `alias`, `alias_address`,
  `alias_challenge` e `alias_recovery`. Rode `migrate deploy` antes de o novo build
  receber tráfego.
- **Um novo id de advisory lock, `881_008` (`AliasChallengeSweeper`).** Nada a
  configurar.
- **Defina `NODE_ENV=production` em produção.** O `.env.example` vem com
  `development`, e duas proteções dependem disso: uma requisição sem
  `X-Plan-Swap-Fee-Bps` é um `503` apenas em produção (em qualquer outro ambiente os
  swaps recorrem silenciosamente a `STELLAR_SWAP_FEE_BPS`), e `/docs` — fora de todo
  guard — fica desligado por padrão apenas em produção.
- **As linhas de log do observer de liquidação mudaram** para
  `Settlement observer started (every Nms)`,
  `Settlement observer (OBSERVER_ENABLED=false) disabled` e
  `SettlementObserverService cycle failed` no nível `error`. Atualize os alertas que
  procuram o texto antigo. `OBSERVER_ENABLED`, `OBSERVER_INTERVAL_MS` e o advisory
  lock não mudam.
- **A migration `20260915120000_liquidity_pool_operation_memo`** adiciona a coluna
  anulável `liquidity_pool_operation.memo`: não reescreve a tabela, apenas um lock
  exclusivo breve. Não há backfill — o memo das linhas antigas está em XDR base64,
  que o SQL não consegue decodificar, e o serviço recorre ao envelope para elas.
- **A migration `20260915120100_lookup_indexes`** constrói dois índices
  `CONCURRENTLY` para a verificação de posse de wallets Pollar
  (`pollar_oauth_session(consumerId, network, walletAddress)` e
  `pollar_user_wallet(consumerId, network, address)`). Não bloqueia escritas, mas um
  build que falha deixa um índice `INVALID` que `IF NOT EXISTS` considera presente:
  encontre-o com
  `SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE NOT i.indisvalid;`,
  remova-o com `DROP INDEX CONCURRENTLY`, rode
  `prisma migrate resolve --rolled-back 20260915120100_lookup_indexes` e faça o
  deploy de novo.
- **Duas variáveis agora são verificadas no boot.** Um `APISIX_GATEWAY_SECRET`
  placeholder, ou um `BLINDPAY_WEBHOOK_SECRET` cuja chave não decodifica para pelo
  menos 24 bytes, impede o serviço de iniciar com um erro que nomeia a variável.
  Troque um gateway secret placeholder na rota do APISIX e aqui, na mesma mudança
  (`openssl rand -hex 32`); uma incompatibilidade faz toda requisição falhar como
  se não viesse do gateway.
- **A migration `20260915150000_payment_intent_tx_hash_per_consumer`** substitui o
  índice único em `payment_intent."txHash"` por um em `("consumerId", "txHash")`.
  Não é `CONCURRENTLY`: `payment_intent` fica com lock de escrita enquanto o índice
  é construído. Não há backfill.
- **Valores armazenados em `webhook_endpoint.previousSecret` não são mais
  retornados, mas nada os limpa.** Se uma rotação de um release anterior deixou um
  para trás e você quiser removê-lo do banco, zere as duas colunas você mesmo.
- **A migration `20260915160000_blindpay_environment`** adiciona `environment`
  (padrão `'prod'`) às sete tabelas espelho do BlindPay — uma mudança só de catálogo,
  sem reescrever tabelas —, então as linhas existentes ficam marcadas como produção.
  **Se as suas variáveis `BLINDPAY_*` sem sufixo apontavam para uma instância de
  desenvolvimento do BlindPay**, mova-as para as variáveis `_DEV` e reetiquete as
  linhas (`UPDATE … SET environment = 'dev'` em `blindpay_receiver`,
  `blindpay_blockchain_wallet`, `blindpay_bank_account`, `blindpay_virtual_account`,
  `payin`, `payout` e `blindpay_quote`), ou as keys `prod` continuarão lendo-as.
- **Configure a instância de desenvolvimento do BlindPay** (`BLINDPAY_API_KEY_DEV`,
  `BLINDPAY_INSTANCE_ID_DEV`, `BLINDPAY_WEBHOOK_SECRET_DEV`) se keys `dev` usam o
  BlindPay, e aponte o webhook do dashboard dela para a mesma URL `/v1/blindpay/webhooks`.
- **Faça o deploy da mudança do forwarder do dev platform primeiro.** O `authorize`
  recusa toda key para a qual o gateway não encaminha `X-Consumer-Email`. O forwarder grava
  o e-mail por conta sempre que as keys dessa conta são sincronizadas, então ressincronize
  os consumers existentes (listar as keys de um usuário no dashboard faz isso para esse
  usuário). Até lá a carteira recorre ao login intermediado do dev platform, que não
  precisa do header; os outros clientes recebem `403 pollar_identity_required`.
- **O login social de usuários finais de terceiros pela aplicação compartilhada da Pollar
  deixa de funcionar.** Um tenant cujo app faz login dos próprios usuários recebe
  `403 pollar_identity_mismatch` para todo usuário cujo e-mail não seja o da conta da key.
- **A migration `20260915180000_pollar_testnet_counterpart_mainnet`** fecha as carteiras
  de mainnet que logins na testnet tinham deixado `pending` (`FAILED`,
  `COUNTERPART_FROM_TESTNET_DISABLED`), para que o sweeper pare de financiá-las. Só dados,
  sem mudança de schema.
- **A migration `20260915200000_receiver_dossier_version`** adiciona `dossierVersion`
  (padrão `1`) e `reviewedVersion` a `blindpay_receiver` — só catálogo, sem reescrita
  da tabela — e preenche `reviewedVersion` em todo receiver que já passou pelo portão
  de revisão, para que o `enable` deles continue funcionando. Receivers ainda em
  `inactive` ou `pending_review` ficam com `NULL`, que é a verdade sobre eles.
- **Confira `POLLAR_BRIDGE_CALLBACK_URL` antes do deploy.** `http` puro em um host
  roteável agora impede o serviço de subir, com um erro que nomeia a variável.
  Loopback (`http://127.0.0.1:…`) continua aceito, para desenvolvimento local.
- **Novos `429` em rotas que nunca retornaram um.** Os orçamentos da tabela acima valem
  a partir desta versão; um cliente que roda em loop uploads de KYC, cotações, payins,
  payouts, montagem de intents, cotações de swap ou montagens de pool precisa respeitar
  o `Retry-After`. `RATE_LIMIT_ENABLED=false` desliga o limitador durante um
  incidente.

### O contrato OpenAPI lista apenas o que cada rota retorna

Nada mudou na resposta real; mudou o contrato publicado. Regenere qualquer client
gerado a partir de `openapi/openapi.json`:

- Cada operação lista apenas as falhas que pode retornar. `409` aparece só onde a
  rota documenta um conflito próprio, `429` só em rotas com rate limit,
  `502`/`503`/`504` só onde a rota chama um provedor, e os probes de saúde não listam
  `401`/`403`. Falhas compartilhadas são `$ref` para `components.responses`.
- Todo exemplo de falha é real para o seu status. Antes a spec mostrava um único
  `409 idempotency_conflict` sob todos os status de todas as rotas.
- `X-Gateway-Secret` e `X-Consumer-Username` formam um único requisito de segurança
  (os dois headers), com `Authorization: Bearer` publicado como alternativa para
  chamadas pelo gateway. Antes eram duas alternativas, o que dizia às ferramentas que
  qualquer um dos headers bastava.
- O `503` de `GET /v1/health/readiness` é documentado como o envelope de erro. Antes
  era documentado como o relatório do Terminus, que o filtro de exceções nunca
  retorna.

### NestJS 12, TypeScript 6 e Node 24.9 como versão mínima

O serviço agora roda sobre NestJS 12 e TypeScript 6 e **exige Node 24.9 ou
superior** (`engines`; a CI fixa `node-version: 24`). Atualize os ambientes de
deploy de acordo.

O NestJS 12 é publicado como ESM, e o Jest só consegue carregá-lo no Node >= 24.9
com `--experimental-vm-modules`, por isso os scripts de teste rodam o Jest
diretamente pelo Node:

```
"test": "node --experimental-vm-modules node_modules/jest/bin/jest.js"
```

O contrato OpenAPI publicado ganhou schemas de health mais ricos vindos do
`@nestjs/terminus@12` (enums de status e `responseTime`). Nenhuma rota ou schema de
negócio mudou.

### Uma API key pública compartilhada, e o guard que a restringe

`PublicKeyGuard` (global, depois do `PermissionsGuard`) e o decorator
`@AllowPublicKey()` são novos. As chaves existentes não são afetadas. No deploy:

- **Defina `APISIX_PUBLIC_CONSUMER`** com o username que a plataforma de
  desenvolvedores provisiona para a chave pública, em todo deploy que publique uma.
  Sem ela, o guard depende apenas do `X-Consumer-Role` encaminhado.
- **Crie a chave pública com `role: public`** e apenas com os escopos de que as rotas
  da allowlist precisam. Escopos extras como `kyc:*` não abririam essas rotas, mas
  uma chave que todo mundo tem não deveria carregá-los.

Veja "A API key pública compartilhada" acima.

### O registro de ativos: `GET /v1/assets`

Uma lista curada dos pares (code, issuer) que esta plataforma suporta, por rede, com
a organização emissora. Não exige escopo, já que não guarda dados de tenants, mas
exige um consumer autenticado (a chave pública compartilhada serve).

`npm run assets:verify` confere cada linha contra o Horizon ao vivo: que o par existe
na sua rede, que `contract` corresponde ao `contract_id` do Horizon e que as flags do
emissor batem com a chain. Rode-o ao editar o registro; ele precisa de acesso à
internet, por isso não faz parte dos testes unitários.

### Atividade do cliente: um novo módulo, uma nova tabela e dois novos escopos

`POST /v1/activity/events` aceita telemetria da carteira e do dashboard de
desenvolvedores; `GET /v1/activity/events` e `GET /v1/activity/summary` a leem de
volta. Nenhuma resposta existente mudou. No deploy:

- **A migration `20260906140000_activity_event`** cria `activity_event`
  (append-only, restrita por `consumerId`, única em `(consumerId, eventId)`).
- **Os escopos `activity:write` e `activity:read` são novos.** As chaves existentes
  não os ganham automaticamente e recebem `insufficient_scope`. A plataforma de
  desenvolvedores concede ambos às chaves provisionadas pela carteira e os reaplica na
  rotação; adicione-os às chaves criadas manualmente.
- **`ACTIVITY_RETENTION_DAYS`** (padrão 30) entra no job de retenção. Essas linhas
  guardam dados pessoais, como o log de acesso.

### A rota de polling da Pollar agora descobre sozinha um login concluído

`GET /v1/pollar/oauth/sessions/{state}` costumava esperar o callback da bridge, que
a Pollar nunca chama, então os logins do fluxo de polling ficavam `pending` até
expirar. O polling agora consulta a Pollar e promove o handshake em `READY`. Nenhuma
mudança de formato da API ou do cliente é necessária. No deploy:

- **A migration `20260906120000_pollar_oauth_provider_probe`** adiciona uma coluna
  anulável `providerCheckedAt` a `pollar_oauth_session`. Sem backfill.
- **O tráfego de polling agora chega à Pollar.** Reserve orçamento para uma
  requisição ao provedor por login em andamento a cada dois segundos, na publishable
  key daquela rede.

### Logins da Pollar agora provisionam uma carteira nas duas redes

`POST /v1/pollar/oauth/token` ganhou um array `network_wallets` — uma entrada por
rede Stellar, cada uma `ready`, `pending` ou `failed`. A mudança é aditiva. No
deploy:

- **Rode a migration.** `20260905120000_pollar_user_wallet` adiciona
  `pollar_user_wallet` e o enum `PollarWalletStatus`. Sem ela, todo resgate registra
  um provisionamento com falha e a carteira de contraparte fica sem registro — o
  login em si continua funcionando.
- **Defina as chaves das duas redes.** `POLLAR_*_MAINNET` e `POLLAR_*_TESTNET` são
  opcionais individualmente, e uma rede sem chaves aparece como uma carteira
  `pending` em todo login. Assim que o segundo par for definido, o sweeper provisiona
  o backlog no próximo ciclo; caso contrário, as linhas ficam `pending` até esgotarem
  as tentativas. Em nenhum dos casos um login falha.

Um login na mainnet financia uma reserva nas *duas* redes. Um login na testnet só financia
a testnet — antes também financiava a mainnet, o que as correções da revisão de segurança
acima removeram.

### `429` agora informa `rate_limited`

Um `429` costumava informar `code: "provider_unavailable"`. Agora ele informa
`code: "rate_limited"` (`ApiErrorCode.RateLimited`, parte do enum publicado). Use-o
como critério se você faz retry em caso de throttling.

### Um BlindPay não configurado agora informa `misconfigured`

Quando o BlindPay não está configurado, duas respostas mudaram:

| Requisição | Antes | Agora |
| ---------- | ----- | ----- |
| Uma rota que chama o BlindPay — sob `/v1/kyc`, `/v1/onramp` ou `/v1/offramp` — enquanto `BLINDPAY_API_KEY` ou `BLINDPAY_INSTANCE_ID` não estão definidos | `503` `provider_unavailable` | `503` `misconfigured` |
| `POST /v1/blindpay/webhooks` enquanto `BLINDPAY_WEBHOOK_SECRET` não está definido | `400` `validation_failed` | `503` `misconfigured` |

As duas são erros de configuração do deploy que um retry não resolve. O Svix faz
retry em qualquer resposta que não seja 2xx, então a entrega de webhooks não muda. O
Pollar já retornava `misconfigured` na mesma situação.

### Formatos de resposta que mudaram

Três formatos de resposta publicados mudaram sob `/v1` (não existe `/v2`), então
avise os integradores antes do deploy.

| Endpoint | Antes | Agora | Por quê |
| -------- | ----- | ----- | ------- |
| `GET /v1/webhooks` | array puro, cortado silenciosamente em 100 | `{ data, total, take, skip }` | Os resultados eram cortados em 100, sem `total` para paginar |
| `GET /v1/products` | array puro, a tabela inteira | `{ data, total, take, skip }` | Leitura sem limite |
| `GET /v1/webhooks/:id/deliveries` e a resposta de reentrega | incluíam `payload` | `payload` removido | Um corpo `RECEIVER_UPDATED` é um dossiê de KYC completo, e essas rotas são protegidas por `webhooks:read`, não por `kyc:read` |

Quem itera sobre a resposta ou lê `delivery.payload` vai quebrar: leia `res.data` em
vez disso, e busque os detalhes de KYC nos endpoints de KYC com uma chave que tenha
`kyc:read`.

Os **corpos de webhook** `RECEIVER_UPDATED` / `PAYIN_*` / `PAYOUT_*` também foram
reduzidos a identidade e estado — veja a seção Webhooks.

### A migration de audit-hardening

Ela é distribuída como dois arquivos que precisam ser aplicados em ordem:

- `20260901120000_audit_hardening` — o trabalho de corretude: uma nova coluna, um
  `DELETE` de deduplicação em `liquidity_pool_operation`, dois índices `UNIQUE`, duas
  tabelas novas. O DELETE e o índice único rodam em uma única transação sob um lock
  `SHARE ROW EXCLUSIVE`, então as escritas nessa tabela ficam bloqueadas por alguns
  milissegundos.
- `20260901120100_audit_hardening_indexes` — nove índices aditivos, criados
  `CONCURRENTLY` para que o deploy **não** bloqueie escritas em `payment_intent`,
  `swap`, `webhook_delivery` ou `request_log`. Não é necessária janela de manutenção.

São arquivos separados porque o PostgreSQL não permite `CREATE INDEX CONCURRENTLY`
dentro de uma transação, e o primeiro arquivo precisa de uma.

Se o segundo arquivo falhar no meio, ele pode deixar um índice **inválido** que
`IF NOT EXISTS` considera presente. Encontre-o, remova-o e rode de novo:

```sql
SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE NOT i.indisvalid;
```

### `ADMIN_API_CREDENTIALS` foi removida — `/v1/admin` é do console da plataforma

**Apague a variável.** Ela não é mais lida, e as correspondentes
`COSMOS_ADMIN_API_SECRET` / `COSMOS_ADMIN_API_SECRET_READ` na plataforma de
desenvolvedores vão junto.

Era uma segunda verificação de admin por cima da verificação de papel da própria
plataforma de desenvolvedores, e os deploys que a pulavam recebiam
`401 admin_credentials_required` nas leituras cross-tenant feitas pelo console. Agora
`/v1/admin` só aceita uma requisição quando ela vem do console da plataforma, o que é
estabelecido por duas coisas presentes na requisição:

1. `X-Gateway-Secret` corresponde a `APISIX_GATEWAY_SECRET` — verificado pelo
   `ApisixGuard`, como em todas as outras rotas. Só o gateway e o backend do console o
   têm.
2. `X-Cosmos-Internal` está presente. O APISIX o remove de toda requisição que passa
   pelo seu proxy (`proxy-rewrite.headers.remove`), então quem chama com uma API key
   não consegue enviá-lo; só uma chamada direta de um backend que detém o segredo do
   gateway consegue.

O ponto 2 depende da configuração de rotas do gateway no repositório da plataforma
de desenvolvedores, e não de um segredo guardado por este serviço. Em troca, o console
é o único lugar que decide quem é admin da plataforma, e as linhas de auditoria
nomeiam a conta do console que agiu (`cosmos_<userId>`) e o seu papel na plataforma,
em toda mutação **e** em toda leitura.

O que isso muda para quem chama:

| Antes | Agora |
| ----- | ----- |
| `401` `admin_credentials_required` sem um segredo Bearer | `403` `admin_console_only` para tudo o que não for uma chamada do console |
| `403` `admin_role_required` para uma credencial `read` em uma mutação | não existe mais — o console já decidiu que a conta pode agir |
| `actorId` / `actorRole` em uma linha de auditoria nomeavam a credencial | eles nomeiam a conta do console e o seu papel na plataforma |

Para chamar `/v1/admin` diretamente (de um script de operações, por exemplo), envie
`X-Gateway-Secret`, `X-Consumer-Username` e `X-Cosmos-Internal: 1`; adicione
`X-Cosmos-Admin-Role: owner` para rotular a linha de auditoria. Mantenha o serviço
fora da internet pública.

### `APISIX_GATEWAY_SECRET` agora exige 32 caracteres

O serviço se recusa a iniciar com um segredo mais curto. Agora ele também protege
`/v1/admin` (veja acima). Gere um com `openssl rand -hex 32` e atualize o APISIX ao
mesmo tempo.

### Funcionalidades de `v0.1.0`–`v0.1.5` que esta versão substitui

Um deploy que atualiza a partir da `v0.1.5` perde o comportamento abaixo. Todos os
itens são visíveis para os integradores, então planeje a atualização levando-os em
conta.

| Existia na `v0.1.5` | Agora |
| ------------------- | ----- |
| `POST /v1/webhooks/:id/rotate-secret` aceitava `graceSeconds` e mantinha o segredo antigo válido para verificação por `WEBHOOK_SECRET_GRACE_SECONDS` | O segredo é trocado de uma vez; o anterior deixa de verificar imediatamente. Atualize o segredo armazenado no receptor na mesma janela da chamada de rotação. |
| Um worker de retry com lease entregava os webhooks (`maxAttempts` / `nextAttemptAt` / `leaseUntil`, status `RETRYING`) | O sweeper de entregas faz isso, com `WEBHOOK_MAX_ATTEMPTS` de volta a `3` por loop em processo (um teto real de 9 somando as varreduras). `WEBHOOK_MAX_BACKOFF_MS`, `WEBHOOK_WORKER_*`, `WEBHOOK_LEASE_MS`, `WEBHOOK_FANOUT_CONCURRENCY` e `WEBHOOK_PAUSE_AFTER_FAILURES` foram removidas, e nenhuma entrega é gravada como `RETRYING`. |
| `SWAP_EXPIRED` e `LIQUIDITY_EXPIRED` eram emitidos | Nenhum dos dois é emitido. A expiração continua registrada na linha; consulte-a, ou assine os eventos `*_FAILED`. |
| `GET /v1/products` filtrava por `kind`, `active` e `reference`, e `DELETE` aceitava `hard=true` | Nada disso existe. As exclusões são lógicas (`active=false`). |
| `GET /v1/products` e `GET /v1/customers` usavam `take=20` por padrão | Ambos usam `take=100` por padrão (ainda o máximo), então uma chamada sem parâmetros retorna mais linhas do que antes. |
| `analytics.apiLogs` / `analytics.webhookLogs` retornavam `{ data, total }` e respeitavam apenas `take` | Ambos são paginados como qualquer outra lista: `take` + `skip` na entrada, `{ data, total, take, skip, hasMore }` na saída. Os filtros de intervalo de datas da visão geral foram removidos. |
| `/v1/health` informava um indicador de readiness da Stellar junto com o banco de dados | Informa apenas o banco de dados. |
| `STELLAR_HTTP_TIMEOUT_MS`, `STELLAR_MAX_ATTEMPTS`, `STELLAR_RETRY_BASE_MS` limitavam as chamadas ao Horizon | Os limites das chamadas ao Horizon ficam em `stellar/stellar.constants.ts` e não são configuráveis por ambiente. Essas três variáveis não são mais lidas nem validadas. |

**Nada é removido do banco de dados.** As colunas, índices e valores de enum que
essas funcionalidades adicionaram (`webhook_delivery.maxAttempts` / `nextAttemptAt` /
`leaseUntil`, `webhook_endpoint.previousSecret*`, `lastCheckedAt` / `notFoundStreak`
de `swap` e `liquidity_pool_operation`, a tabela `horizon_account_cursor`,
`RETRYING`, `SWAP_EXPIRED`, `LIQUIDITY_EXPIRED`) continuam declarados em
`schema.prisma` e presentes depois de `migrate deploy`; apenas não são mais gravados.
Removê-los exigiria uma migration destrutiva (o PostgreSQL não consegue remover um
valor de enum sem recriar o tipo).

## Variáveis de ambiente

Toda variável lida de `process.env` em `src/` é validada no boot por
`src/config/env.validation.ts` (fail-fast). Copie `.env.example` e ajuste pelo menos
`DATABASE_URL` e `APISIX_GATEWAY_SECRET`.

| Variável | Obrigatória | Padrão | Efeito |
| -------- | ----------- | ------ | ------ |
| `NODE_ENV` | não | `development` | Deve ser `development`, `test` ou `production`. **Defina `production` em produção** — a verificação fail-closed da taxa do plano e a documentação desligada por padrão dependem disso |
| `PORT` | não | `3000` | Porta HTTP de escuta |
| `DATABASE_URL` | **sim** | — | Conexão PostgreSQL para o Prisma |
| `APISIX_GATEWAY_SECRET` | **sim** | — | Segredo compartilhado que prova que a requisição veio pelo APISIX. **Mínimo de 32 caracteres**; um placeholder é recusado no boot |
| `APISIX_GATEWAY_SECRET_HEADER` | não | `x-gateway-secret` | Nome do header do segredo do gateway |
| `APISIX_CONSUMER_HEADER` | não | `x-consumer-username` | Username do consumer autenticado |
| `APISIX_CREDENTIAL_HEADER` | não | `x-credential-identifier` | Id da credencial vindo do key-auth |
| `APISIX_ENVIRONMENT_HEADER` | não | `x-consumer-env` | Ambiente da chave (`dev` / `prod`) |
| `APISIX_ROLE_HEADER` | não | `x-consumer-role` | Papel do consumer encaminhado pelo gateway |
| `APISIX_PERMISSIONS_HEADER` | não | `x-consumer-permissions` | Lista de permissões encaminhada pelo gateway |
| `APISIX_ORGANIZATION_HEADER` | não | `x-consumer-org` | Id da organização |
| `APISIX_PLAN_HEADER` | não | `x-consumer-plan` | Plano da organização |
| `APISIX_SWAP_FEE_BPS_HEADER` | não | `x-plan-swap-fee-bps` | Taxa de swap do plano (bps) |
| `APISIX_EMAIL_HEADER` | não | `x-consumer-email` | E-mail verificado da conta da key. O bridge da Pollar só devolve a sessão de um login a essa conta, e recusa uma key sem ele |
| `APISIX_PUBLIC_CONSUMER` | não | — | Username do consumer público compartilhado (veja acima). Defina-o onde quer que uma chave pública seja publicada |
| `STELLAR_NETWORK` | não | `testnet` | Rede Stellar de fallback (`public` / `testnet`) |
| `STELLAR_HORIZON_URL_PUBLIC` | não | `https://horizon.stellar.org` | URL base do Horizon da mainnet |
| `STELLAR_HORIZON_URL_TESTNET` | não | `https://horizon-testnet.stellar.org` | URL base do Horizon da testnet |
| `STELLAR_BASE_FEE` | não | `100` | Taxa base da Stellar (stroops) para montagem de tx |
| `STELLAR_TX_TIMEOUT` | não | `300` | Timeout da transação (segundos) |
| `STELLAR_SWAP_FEE_WALLET` | quando fee > 0 | — | Conta G... da plataforma para as taxas de swap |
| `STELLAR_SWAP_FEE_BPS` | não | `50` | Taxa de swap em basis points |
| `STELLAR_SWAP_SLIPPAGE_BPS` | não | `50` | Tolerância de slippage padrão do swap (bps) |
| `STELLAR_SWAP_MAX_SLIPPAGE_BPS` | não | `500` | Limite rígido para o slippage de quem chama (bps) |
| `STELLAR_SWAP_SINGLE_INFLIGHT` | não | `false` | Quando `true`, 409 se já existir um swap PENDING não expirado para a mesma origem |
| `OBSERVER_ENABLED` | não | `true` | `true` / `false` — reconciliador on-chain |
| `OBSERVER_INTERVAL_MS` | não | `15000` | Intervalo de polling do observer (ms, mín. 1000) |
| `OBSERVER_BATCH_SIZE` | não | `50` | Máximo de intents/swaps por ciclo do observer |
| `PAYMENT_INTENT_TTL_SECONDS` | não | `3600` | Tempo de vida de um intent não pago antes de `EXPIRED` |
| `WEBHOOK_TIMEOUT_MS` | não | `5000` | Fallback legado do timeout de webhook (ms) |
| `WEBHOOK_CONNECT_TIMEOUT_MS` | não | `3000` | Orçamento de conexão do webhook de saída (ms) |
| `WEBHOOK_READ_TIMEOUT_MS` | não | `5000` | Orçamento de leitura do webhook de saída (ms) |
| `WEBHOOK_MAX_RESPONSE_BYTES` | não | `65536` | Tamanho máximo do corpo de resposta de webhook drenado |
| `WEBHOOK_MAX_ATTEMPTS` | não | `3` | Número de retentativas de entrega |
| `WEBHOOK_BACKOFF_MS` | não | `2000` | Backoff linear entre retentativas (ms) |
| `WEBHOOK_SIGNATURE_HEADER` | não | `x-cosmos-signature` | Header HMAC enviado aos integradores |
| `WEBHOOK_SWEEP_ENABLED` | não | `true` | Recupera entregas abandonadas por um crash. Chave de incidente |
| `WEBHOOK_SWEEP_INTERVAL_MS` | não | `60000` | Intervalo do sweeper (ms, mín. 1000) |
| `WEBHOOK_PAYLOAD_RETENTION_DAYS` | não | `30` | Dias para manter o corpo de uma entrega concluída antes de redigi-lo. `0` o mantém para sempre |
| `REQUEST_LOG_RETENTION_DAYS` | não | `30` | Dias para manter as linhas de `request_log` (IP / user-agent do pagador). `0` desativa a limpeza |
| `ACTIVITY_RETENTION_DAYS` | não | `30` | Dias para manter as linhas de `activity_event` (IP / user-agent / `props` do cliente). Limpas pelo mesmo job. `0` mantém os eventos para sempre |
| `REQUEST_LOG_PRUNE_INTERVAL_MS` | não | `3600000` | Intervalo do timer de retenção (ms) |
| `REQUEST_LOG_PRUNE_BATCH_SIZE` | não | `1000` | Linhas por lote de exclusão (mantém cada lock curto) |
| `REQUEST_LOG_PRUNE_MAX_PER_CYCLE` | não | `50000` | Limite rígido de linhas examinadas por ciclo |
| `SWAGGER_ENABLED` | não | desligado em `production` | Publica `/docs` (middleware do Express, sem guards) |
| `OPENAPI_SERVER_URL` | não | — | Host do gateway gravado no OpenAPI exportado |
| `BLINDPAY_API_KEY` | não | — | API key da instância de produção do BlindPay, usada pelas keys `prod` |
| `BLINDPAY_INSTANCE_ID` | quando a API key estiver definida | — | Id da instância BlindPay (`in_...`) |
| `BLINDPAY_BASE_URL` | não | `https://api.blindpay.com/v1` | URL base da API do BlindPay |
| `BLINDPAY_WEBHOOK_SECRET` | quando a API key estiver definida | — | Segredo Svix para os webhooks de entrada do BlindPay: o valor `whsec_…` completo, cuja chave precisa decodificar para pelo menos 24 bytes (verificado no boot) |
| `BLINDPAY_API_KEY_DEV` | não | — | API key da instância de desenvolvimento do BlindPay, usada pelas keys `dev`. Não definida: as rotas do BlindPay respondem `503 misconfigured` às keys `dev` |
| `BLINDPAY_INSTANCE_ID_DEV` | quando a API key de dev estiver definida | — | Id da instância de desenvolvimento (`in_...`) |
| `BLINDPAY_WEBHOOK_SECRET_DEV` | quando a API key de dev estiver definida | — | Segredo Svix do endpoint de webhook da instância de desenvolvimento; mesmas regras de `BLINDPAY_WEBHOOK_SECRET` |
| `BLINDPAY_TIMEOUT_MS` | não | `15000` | Timeout do client HTTP do BlindPay (ms) |
| `KYC_REDIRECT_URL_WHITELIST` | não | — | Allow-list por consumer de hosts de redirecionamento do KYC |
| `RATE_LIMIT_ENABLED` | não | `true` | Limites por endereço nas rotas que gastam XLM. Chave de incidente |
| `RATE_LIMIT_PRUNE_INTERVAL_MS` | não | `600000` | Intervalo de limpeza das janelas do contador (ms, mín. 1000) |
| `POLLAR_PUBLISHABLE_KEY_TESTNET` / `_MAINNET` | não | — | Publishable key da Pollar (`pub_<network>_…`), para a bridge OAuth |
| `POLLAR_SECRET_KEY_TESTNET` / `_MAINNET` | junto com a publishable key | — | Chave secreta da Pollar (`sec_<network>_…`), para as rotas de operador |
| `POLLAR_BRIDGE_CALLBACK_URL` | quando uma chave da Pollar estiver definida | — | URL pública para a qual a Pollar devolve o navegador. Precisa ser `<gateway>/v1/pollar/oauth/callback`, **https** (`http` puro só em host loopback — caso contrário o boot falha: o código de autorização viaja na query string) **e** um host registrado em Build → Domains na Pollar |
| `POLLAR_REDIRECT_URI_WHITELIST` | não | — | Allow-list por consumer das redirect URIs das carteiras. Vazia ⇒ esse consumer só pode usar o fluxo de polling |
| `POLLAR_SDK_ORIGIN` | não | origem de `POLLAR_BRIDGE_CALLBACK_URL` | `Origin` enviado à SDK API da Pollar, que o confere com Build → Domains. Defina apenas quando o host de callback e o host registrado forem diferentes |
| `POLLAR_SDK_BASE_URL` | não | `https://sdk.api.pollar.xyz` | URL base da SDK API da Pollar |
| `POLLAR_SERVER_BASE_URL` | não | `https://api.pollar.xyz` | URL base da Server API da Pollar |
| `POLLAR_TIMEOUT_MS` | não | `15000` | Timeout do client HTTP da Pollar (ms) |
| `POLLAR_AUTHORIZATION_TTL_MS` | não | `300000` | Por quanto tempo um handshake de login fica aberto |
| `POLLAR_CODE_TTL_MS` | não | `120000` | Por quanto tempo um código emitido pela bridge continua resgatável |
| `POLLAR_LOGIN_WAIT_MS` | não | `20000` | Quanto tempo o resgate espera a Pollar provisionar a carteira |
| `POLLAR_SWEEP_ENABLED` | não | `true` | Expira handshakes que ninguém concluiu e retenta as carteiras na outra rede que um login deixou `pending` |
| `POLLAR_SWEEP_INTERVAL_MS` | não | `60000` | Intervalo do sweeper de handshakes (ms, mín. 1000) |

O antigo `STELLAR_HORIZON_URL` é rejeitado no boot — use
`STELLAR_HORIZON_URL_PUBLIC` / `STELLAR_HORIZON_URL_TESTNET` no lugar dele.

## Primeiros passos

```bash
cp .env.example .env          # set DATABASE_URL and a strong APISIX_GATEWAY_SECRET
npm install
npm run db:generate           # prisma generate
npm run db:migrate            # create the schema (needs a running Postgres)
npm run start:dev
```

Gere um segredo:

```bash
openssl rand -hex 32
```

Rode as mesmas verificações que a CI roda (não é preciso banco de dados — o Prisma é
mockado):

```bash
npm run lint
npm test                 # unit suites (src/**/*.spec.ts)
npm run test:e2e         # e2e suites (test/*.e2e-spec.ts)
npm run openapi:check    # the committed contract matches the controllers
npm run readme:check     # the seven READMEs match in structure and list every route
```

## Configuração de rotas do APISIX

O helper de rotas da plataforma de desenvolvedores (`paydev/src/utils/apisix.ts`) já
converte `Authorization: Bearer <token>` no header `apikey`, valida o `key-auth` e
remove as credenciais antes de fazer o proxy. Para apontar uma rota para este serviço,
adicione a **injeção do segredo do gateway** ao plugin `proxy-rewrite`, para que o
header chegue aqui — e remova qualquer cópia enviada pelo cliente:

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

O `key-auth` encaminha `X-Consumer-Username` / `X-Credential-Identifier` ao upstream
depois de uma autenticação bem-sucedida, sobrescrevendo qualquer cópia enviada pelo
cliente, e o guard depende disso.

> **A lista de remoção é um controle de segurança, e não pode ser verificada a partir
> deste repositório.** Este serviço aceita cada header dela pelo valor declarado;
> `X-Gateway-Secret` só prova que a requisição passou por um gateway, não que esses
> valores são honestos. Revise a lista sempre que uma rota for adicionada ou copiada —
> uma rota que não remova `X-Cosmos-Internal` dá a toda API key acesso a `/v1/admin`.
> Mantenha o serviço em uma rede privada para que o APISIX seja o único caminho de
> entrada; o segredo compartilhado é uma segunda camada, não a única.
>
> Em produção, a ausência de `X-Plan-Swap-Fee-Bps` retorna `503` em vez de recorrer ao
> padrão do ambiente.
