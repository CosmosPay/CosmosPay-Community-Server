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

Uma superfície tira mais proveito dessas mesmas duas condições. `/v1/admin` é
cross-tenant, e o `AdminGuard` só admite ali uma requisição que também traga
`X-Cosmos-Internal` — um header que o APISIX **remove** de tudo o que passa pelo seu
proxy, de modo que só uma chamada direta de um backend que detém o segredo do
gateway pode apresentá-lo. Esse backend é a plataforma de desenvolvedores, que já
decidiu se a conta autenticada é owner/admin. Não há uma credencial de admin
separada para implantar (veja a nota de atualização sobre `ADMIN_API_CREDENTIALS`),
o que faz do segredo do gateway e do isolamento de rede a fronteira inteira diante
dos dados cross-tenant — e torna a lista de remoção de headers na rota do gateway
uma questão de segurança, não de higiene.

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
                                  payment intents, KYC, webhooks, Pollar
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
console chega até ela. Os caminhos usam a forma `{param}` do OpenAPI, e
`npm run readme:check` quebra a CI quando uma rota do contrato falta nesta tabela.

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
`ApiErrorBodyEntity`, anexado a toda operação — assim um client gerado também recebe
o tipo de erro, e você não precisa ler este repositório para descobrir os códigos.
A fonte da verdade é `ApiErrorCode` em `src/common/errors/api-error.ts`.
**Códigos nunca são renomeados depois de publicados**; novos podem ser adicionados,
então trate um código desconhecido pelo seu status HTTP.

Alguns que são fáceis de confundir:

| Código | Status | Significa |
| ------ | ------ | --------- |
| `insufficient_scope` | 403 | A API key não tem o escopo. Provisione a chave novamente |
| `account_disabled` | 403 | Um operador desativou esta conta fiat. Não é um problema da chave |
| `gateway_required` | 403 | A requisição não chegou pelo APISIX |
| `admin_console_only` | 403 | A rota pertence ao console da plataforma (`/v1/admin`, iniciar a recuperação de um alias). Nenhuma API key pode chamá-la |
| `idempotency_conflict` | 409 | Este `Idempotency-Key` (ou o memo do payment intent) já produziu um recurso para uma requisição *diferente*. Repita a requisição original ou use uma chave nova |
| `kyc_state_invalid` | 409 | Uma transição de estado de KYC ilegal — não é uma requisição duplicada |
| `operation_in_flight` | 409 | Uma operação conflitante ainda está sendo liquidada |
| `payload_expired` | 409 | O corpo da entrega passou do período de retenção e não pode ser reenviado |
| `provider_unavailable` | 503/504 | BlindPay ou Horizon está inacessível. Tente novamente |
| `misconfigured` | 503 | Um erro de configuração do lado do servidor. Tentar novamente não vai ajudar |

Todo intent é **persistido** (tabela `payment_intent`) e vinculado ao consumer do
APISIX autenticado, então leituras/atualizações/exclusões só tocam os registros do
próprio consumer — rastreabilidade completa do ciclo de vida de cada intent
(`PENDING → SUBMITTED → SUCCEEDED/FAILED/CANCELLED/EXPIRED`).

### Executando mais de uma réplica

O APISIX faz o balanceamento de carga entre instâncias, então cada `setInterval`
deste serviço roda uma vez por réplica. A corretude nunca foi o problema — cada
mudança de status passa por um compare-and-swap protegido com `updateMany`, então
só um escritor vence —, mas três réplicas significavam o triplo de idas e voltas ao
Horizon para um trabalho idêntico, contra uma API que aplica rate limit, e réplicas
disputando para apagar as mesmas tuplas de `request_log`.

Cada timer em segundo plano agora obtém um **advisory lock em nível de transação**
do PostgreSQL (`AdvisoryLockService`, `src/common/services/advisory-lock.service.ts`)
e pula o seu ciclo quando outra réplica o detém:

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

`pg_try_advisory_xact_lock` é usado em vez da variante em nível de sessão por três
motivos: ele nunca bloqueia (uma réplica que perde simplesmente pula, que é o que um
poller quer), é liberado quando a transação termina — inclusive em um crash ou em
uma conexão perdida, então um pod derrubado não consegue travar o lock — e, por
isso, continua correto atrás do PgBouncer em modo transaction pooling, no qual locks
em nível de sessão são inseguros porque as conexões não são fixas.

Os ids de lock ficam no enum `AdvisoryLockKey` e são a identidade da tarefa:
renomear um membro com um número novo desativa a exclusão silenciosamente, por isso
números aposentados nunca são reutilizados.

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
  divergência que deixa o status inalterado, para que uma tx correta ainda possa ser
  enviada; do contrário, o hash de qualquer transação com falha na rede faria um
  intent falhar de vez.
- **Automático (observer permanente):** `StellarObserverService` consulta o Horizon
  a cada `OBSERVER_INTERVAL_MS` em busca de intents `PENDING` — pelo `txHash`
  informado, ou varrendo os pagamentos para o destino — e finaliza as
  correspondências da mesma forma, de modo que os status mudam e os eventos disparam
  **sem que ninguém chame a API**. Um ciclo processa no máximo
  `OBSERVER_MAX_INTENTS_PER_CONSUMER` (10) intents por consumer e nunca varre um
  intent expirado, então uma enxurrada vinda de um único consumer — incluindo a chave
  pública compartilhada — não consegue travar a liquidação de todos os outros.
  Desative em desenvolvimento local com `OBSERVER_ENABLED=false`.

### Retenção dos logs de requisições da API

Toda requisição recebida, exceto `/v1/health` e `/docs`, é gravada em
`request_log` pelo `LoggingInterceptor` e alimenta a visão **API logs** do dashboard
(`GET /v1/logs`). As linhas incluem caminho, status, duração e — quando presentes —
o `ip` / `userAgent` do pagador.

O tráfego do dashboard (`X-Cosmos-Internal`) é **registrado e marcado**
(`request_log.internal`), não ignorado, e a visão de logs da API filtra por essa
coluna. Uma versão anterior retornava cedo ao ver o header, o que significava que
qualquer um capaz de defini-lo mantinha suas requisições totalmente fora do log de
auditoria — um header de requisição nunca pode ser capaz de tornar tráfego invisível.

Essas linhas **não são mantidas para sempre**. `RequestLogRetentionService` apaga as
linhas mais antigas que `REQUEST_LOG_RETENTION_DAYS` (padrão **30**) em um timer
(`REQUEST_LOG_PRUNE_INTERVAL_MS`, padrão **1h**). Cada ciclo apaga em lotes curtos de
`REQUEST_LOG_PRUNE_BATCH_SIZE` (padrão **1000**) e continua em loop até o backlog
acabar ou até atingir `REQUEST_LOG_PRUNE_MAX_PER_CYCLE` (padrão **50000**), para que
um histórico grande possa ser posto em dia sem segurar um lock longo na tabela.
Defina `REQUEST_LOG_RETENTION_DAYS=0` para desativar a limpeza por completo (o
serviço registra isso no boot). O índice composto em `(consumer, createdAt)` mantém
a consulta do dashboard rápida à medida que o volume cresce.

### Atividade do cliente (o que a carteira e o dashboard reportam)

`request_log` registra o que chegou a este serviço. Ele não consegue registrar o que
um cliente *fez*: uma carteira que travou na tela de envio, uma assinatura que o
usuário cancelou, uma página do dashboard que lançou um erro antes de qualquer
requisição sair do navegador. Nada disso produz uma chamada HTTP aqui, e são
exatamente os eventos que vale a pena ter quando algo dá errado — então os clientes
reportam os seus próprios, para `POST
/v1/activity/events`.

- **Um lote, não uma chamada por evento.** Os clientes enfileiram e descarregam, então
  uma carteira offline guarda os seus eventos e os envia na próxima inicialização. Até
  `ACTIVITY_MAX_BATCH` (100) por requisição, gravados em uma única instrução.
- **Repetir um envio é seguro.** Um evento pode trazer o `eventId` do próprio
  cliente; `(consumerId, eventId)` é único e o insert ignora duplicatas, então um
  lote que foi gravado, mas cuja confirmação nunca chegou, pode ser reenviado sem
  duplicar cada linha. A resposta informa `accepted` e `duplicates`.
- **A atribuição é do gateway, nunca do corpo.** As linhas são gravadas sob o
  consumer que o APISIX autenticou. Um cliente não pode registrar eventos em nome de
  outra conta, e não existe campo que lhe permita tentar.
- **A ingestão não falha por causa do formato de um payload.** Um `message` longo
  demais é truncado e um `props` grande demais é substituído por `{"_dropped":
  "props_too_large"}`; um 400 custaria o lote inteiro, e o lote importa mais
  justamente quando o cliente está em um estado que ninguém previu.
- **Um relógio de dispositivo errado não reordena o feed.** `occurredAt` é ajustado
  ao horário de recebimento quando está mais de cinco minutos adiantado ou mais de
  sete dias atrasado, então um celular uma hora adiantado não consegue fixar os seus
  eventos no topo de uma lista ordenada da mais nova para a mais antiga. Os dois
  horários são mantidos: `at` (o do cliente) e `receivedAt`.

Para ler de volta:

| Rota                    | Escopo            | Retorna                                                              |
| ----------------------- | ----------------- | -------------------------------------------------------------------- |
| `GET /v1/activity/events` | `activity:read` | O feed, do mais novo para o mais antigo. Filtros: `source`, `level`, `category`, `type` (prefixo), `network`, `since`/`until` |
| `GET /v1/activity/summary` | `activity:read` | Contagens por level/source/category, principais tipos de evento, principais erros, sessões, dispositivos, uma série diária |

`level` no feed é um **piso**, não uma correspondência exata: `level=warn` retorna
avisos *e* erros. Um filtro que retornasse só as linhas que alguém rotulou como
`error` esconderia os avisos que levaram a elas.

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

**O que contém um corpo originado no BlindPay.** `RECEIVER_UPDATED` / `PAYIN_*` /
`PAYOUT_*` trazem apenas identidade e estado — ids, status, valores, rails — nunca
dados pessoais. O objeto do provedor *não* é encaminhado literalmente: o payload de
um receiver é um dossiê de KYC completo (tax id, data de nascimento, endereço, links
de documentos), e se inscrever em um evento exige apenas `webhooks:write`, o que
faria do webhook uma forma de mandar entregar esse dossiê a qualquer host. Busque os
detalhes na API com uma chave que tenha `kyc:read` / `onramp:read` / `offramp:read`.
Veja `src/blindpay/blindpay-event-redaction.ts` para a allowlist exata de campos.

A entrega é desacoplada via `EventEmitter2` do NestJS (`webhook.event`), então
emitir uma notificação nunca bloqueia a requisição da API que a disparou.

**Política de destino de saída (SSRF):** os endpoints precisam usar `https` e
resolver apenas para endereços públicos. O cadastro rejeita loopback, faixas
privadas RFC1918, link-local (`169.254.0.0/16`, incluindo o endpoint de metadata de
nuvem `169.254.169.254`) e hostnames de metadata conhecidos. A mesma verificação
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

**O teto real de tentativas é 9, não 3.** `WEBHOOK_MAX_ATTEMPTS` limita um loop de
retry em processo. Depois, o sweeper pega as entregas que ainda estão dentro de
`WEBHOOK_MAX_ATTEMPTS × 3` tentativas no total, então uma entrega pode ser tentada
até nove vezes, distribuídas ao longo de horas. Isso é deliberado — um pod derrubado
no meio do backoff costumava deixar uma entrega PENDING abandonada para sempre, o
que significava um pagamento liquidado que não notificava ninguém.

**A reentrega é best-effort dentro da janela de retenção.** Depois de
`WEBHOOK_PAYLOAD_RETENTION_DAYS`, o corpo armazenado é apagado (um corpo
`RECEIVER_UPDATED` é um dossiê de KYC, e o log de entregas é mantido). O sweeper
ignora essas linhas e `POST /v1/webhooks/:id/deliveries/:id/redeliver` retorna
`409 payload_expired` em vez de enviar um corpo redigido sob um tipo de evento real
com uma assinatura válida.

**Contrato do receptor.** Qualquer `2xx` confirma o recebimento. Responda dentro de
`WEBHOOK_READ_TIMEOUT_MS` (5s por padrão). Não há garantia de ordem, então trate os
eventos como um conjunto e reconcilie com a API. Deduplique pelo `id` do evento —
observe que uma reentrega reutiliza o `id` original, então um receptor que deduplica
estritamente vai ignorá-la; essa é a troca pretendida (entrega at-least-once, efeito
exactly-once).

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

### OpenAPI / Swagger

**Nota de segurança:** `GET /docs`, `/docs/json` e `/docs/yaml` são montados por
`SwaggerModule.setup` como **middleware do Express**, não como controllers do Nest.
Eles **não** passam pelo `ApisixGuard` nem pelo `PermissionsGuard` — qualquer um que
alcance a porta do serviço pode baixar a spec completa da API, a menos que a
documentação esteja desativada. Em produção, a documentação fica **desligada por
padrão** (`NODE_ENV=production` e sem `SWAGGER_ENABLED`). Defina
`SWAGGER_ENABLED=true` apenas quando quiser deliberadamente publicar a spec em uma
rede confiável.

Documentação ao vivo (quando habilitada):

- `GET /docs` — Swagger UI
- `GET /docs/json` — spec OpenAPI 3.0 (JSON)
- `GET /docs/yaml` — spec OpenAPI 3.0 (YAML)

Exporte a spec para arquivos (para que outro servidor possa hospedá-la ou consumi-la)
— não é necessária conexão com o banco de dados nem o segredo real do gateway; ela
roda no modo preview do Nest com placeholders locais quando essas variáveis de
ambiente estão ausentes:

```bash
npm run openapi:generate
# writes openapi/openapi.json and openapi/openapi.yaml
```

A CI e o gate de release regeneram os dois arquivos versionados e rejeitam
divergências. Rode a mesma verificação antes de fazer commit de uma mudança em um
controller ou DTO:

```bash
npm run openapi:check
```

Os caminhos na spec já incluem a versão (`/v1/...`). Para gravar um host concreto do
gateway em `servers` da spec, defina `OPENAPI_SERVER_URL` antes de gerar:

```bash
OPENAPI_SERVER_URL=https://gateway.example.com npm run openapi:generate
```

A configuração do Swagger (`src/swagger.ts`) é compartilhada pelo servidor em
execução e pelo gerador, então os dois ficam sincronizados. Os dois headers do
APISIX (`X-Gateway-Secret`, `X-Consumer-Username`) são documentados como security
schemes na spec.

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

**O memo é um `MEMO_ID` obrigatório** — ele identifica o pagamento on-chain e dá
**idempotência** ao intent: `(consumer, memo)` é único, então recriar com o mesmo
memo **e os mesmos termos** retorna o intent original. O mesmo memo com qualquer
termo diferente — tipo, rede, destino, valor, ativo, `msg`, `callback`, ou `source`
no caso de `tx` — resulta em `409 idempotency_conflict`, e o erro não diz nada sobre
o intent armazenado. Essa comparação existe por causa da chave pública compartilhada:
toda carteira anônima é um único consumer, então, sem ela, um memo que outra pessoa
usou primeiro entregava a você o intent *dela*, com um QR que pagava a ela. Se você
não passar `memo`, um uint64 aleatório é gerado.

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

Cada endpoint documenta uma resposta tipada com payloads de exemplo na spec OpenAPI
(`TxPaymentIntentEntity`, `PayPaymentIntentEntity`, `ValidationOutcomeEntity`), então
o Swagger mostra um exemplo concreto de resposta, e não um corpo vazio.

Resposta:

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

A carteira é open source e distribui uma API key que todo mundo tem, para que uma
pessoa possa fazer swap, adicionar liquidez ou criar um link de pagamento sem se
cadastrar. Ela paga a comissão do plano `community` — 150 bps, a taxa mais alta da
tabela —, e é o cadastro que dá acesso a uma menor. O gateway injeta a taxa por
consumer exatamente como faz para uma chave privada (veja
`resolvePlanCommissionBps`), então nada na precificação é tratado como caso especial
aqui.

O que *é* especial é o isolamento entre tenants. Todo chamador anônimo da rede chega
como o mesmo consumer do APISIX, e os endpoints de leitura filtram as linhas
exatamente por esse consumer:

```ts
// swaps.service.ts
where: { id, consumer: { apisixUsername: consumer.username } }
```

Então `GET /v1/swaps` sob a chave pública entregaria a cada usuário anônimo o
histórico de swaps de toda a população anônima. Escopos não resolvem isso — um escopo
é uma propriedade da chave, e todos têm a mesma chave — e a sobreposição não é
hipotética: `POST /v1/swaps/quote` exige `swaps:read`, que é o mesmo escopo que lista
o histórico.

**Por isso o `PublicKeyGuard` é uma allowlist, não uma denylist.** Um consumer
público é recusado em toda rota que não traga `@AllowPublicKey()`, então uma rota
adicionada no ano que vem fica inacessível para a chave pública até que alguém diga o
contrário no mesmo diff. Esquecer o decorator gera um ticket de suporte; esquecer uma
entrada da denylist gera um vazamento de dados.

Acessível com a chave pública hoje:

| Rota | Por que é seguro |
| --- | --- |
| `POST /v1/swaps/quote` | Precifica um caminho a partir do Horizon; uma função pura da requisição |
| `POST /v1/swaps` | Monta um envelope não assinado que quem chama assina |
| `POST /v1/swaps/:id/submit` | Transmite um envelope assinado por quem chama — exige o UUID do swap *e* uma assinatura da sua conta de origem |
| `POST /v1/liquidity-pools/deposit` \| `withdraw` | Montam envelopes não assinados |
| `POST /v1/liquidity-pools/operations/:id/submit` | Transmite um envelope assinado por quem chama |
| `GET /v1/liquidity-pools` \| `/:poolId` \| `/positions` | Dados públicos on-chain lidos do Horizon |
| `POST /v1/payment-intents/tx` \| `pay` | Montam um intent SEP-7 a partir da requisição |
| `POST /v1/activity/events` | Ingestão de telemetria — veja abaixo |
| `GET /v1/assets` | O catálogo público de ativos |
| `GET /v1/aliases/resolve/:name` \| `availability/:name` \| `by-address/:address` | Um pagador resolvendo um handle é justamente o chamador anônimo para o qual esta chave existe; a resposta é uma função pura da requisição e nunca inclui a caixa de e-mail do dono |

Recusadas, e de propósito: `GET /v1/swaps`, `GET /v1/swaps/:id`,
`GET /v1/liquidity-pools/operations{,/:id}`, `GET /v1/activity/events`,
`GET /v1/activity/summary`, toda leitura de payment intent, toda rota do dono de um
alias (reivindicar, listar, adicionar ou remover um endereço, liberar, recuperar) e
tudo sob `/v1/kyc`, `/v1/onramp`, `/v1/offramp` e `/v1/webhooks`. Uma carteira sem
conta monta o seu histórico a partir do Horizon, que de qualquer forma é a fonte
oficial da atividade on-chain.

**A telemetria está na lista de propósito.** Uma carteira sem conta na CosmosPay
também trava, e recusar os seus relatórios de erro nos deixaria cegos justamente
para a população que encontra as falhas da primeira execução — a rota de ingestão
responderia `403` e os relatórios seriam descartados. Os eventos que chegam por esta
chave são anônimos por construção (um único consumer compartilhado), então nada que
identifique uma conta pode viajar com eles; a carteira remove endereço, destino,
valor e txHash antes de enviar.

O guard identifica o consumer público **ou** pelo papel encaminhado
(`X-Consumer-Role: public`) **ou** pelo username configurado em
`APISIX_PUBLIC_CONSUMER`. São dois sinais porque cada um, sozinho, falha aberto de
um jeito que custa dados de usuários: um gateway que deixasse de encaminhar papéis
promoveria todo chamador anônimo a tenant comum, e um deploy que nunca definiu a
variável de ambiente dependeria de um header que não controla. Defina os dois.

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

**Idempotência** opcional (issue #17): envie um header `Idempotency-Key` (preferível)
ou `idempotencyKey` no corpo. Uma retentativa com a mesma chave **e a mesma
requisição** — rede, origem, destino, os dois ativos, valor, slippage e memo —
retorna o swap **existente** (`id` + `txHash`) em vez de montar outra transação
Stellar. A mesma chave com qualquer requisição diferente resulta em
`409 idempotency_conflict`, e o erro não revela nada sobre o swap armazenado.
Depósitos e saques de liquidez seguem a mesma regra, comparando também o tipo da
operação. A comparação existe por causa da chave pública compartilhada: toda carteira
anônima é um único consumer, então uma chave que outra pessoa usou primeiro entregava
a você o envelope não assinado *dela* — um envelope capaz de mover os seus fundos
para ela. Sem chave, a constraint única `(network, txHash)` ainda rejeita uma
remontagem idêntica byte a byte com **409** (colisão de sequence / XDR). Quando
`STELLAR_SWAP_SINGLE_INFLIGHT=true`, um segundo swap `PENDING` não expirado para o
mesmo `(consumer, source, network)` também retorna **409**, citando o id existente
(padrão **desligado** — swaps distintos e concorrentes a partir de uma mesma conta
continuam permitidos).

```jsonc
// response → { id, status: "PENDING", network, sendAmount, feeAmount, swapAmount,
//              destEstimated, destMin, path, xdr, uri: "web+stellar:tx?xdr=…", qr, txHash, … }
```

**`POST /v1/swaps/:id/submit`** — retransmite o envelope assinado (`swaps:write`).

```jsonc
// request
{ "signedXdr": "AAAAAgAAA…(signed base64 XDR)…" }
// response
{ "submitted": true, "status": "SUCCEEDED", "txHash": "…", "swap": { … } }
// on a network rejection → { "submitted": false, "status": "FAILED", "reason": "…", "resultCodes": ["op_under_dest_min"], "swap": { … } }
```

O hash da transação assinada é comparado com o da transação que o serviço montou
antes de ser transmitida, então quem chama nunca consegue fazer o serviço retransmitir
uma transação arbitrária. Um swap dispara os eventos de webhook `SWAP_CREATED` /
`SWAP_SUBMITTED` / `SWAP_SUCCEEDED` / `SWAP_FAILED` pelo mesmo dispatcher.

## Aliases — handles de pagamento reivindicáveis

Um alias permite que um pagador digite `emanuel250` em vez de `GA5ZSE…`. É também o
que um pagador lê imediatamente antes de autorizar uma transferência, então cada
regra abaixo existe porque errar não produz uma linha ruim no banco — produz um
pagamento para a conta errada, sob um nome em que o pagador confiou.

### Reivindicado provando o controle de uma chave, não pedindo

```
wallet ──1. POST /v1/aliases/challenges {name, address, network} ──▶ nonce + the EXACT message to sign
wallet ──2. signs SHA-256(domain ‖ 0x00 ‖ uint32be(length) ‖ message) with that address's key
wallet ──3. POST /v1/aliases {name, email, nonce, signature} ────────▶ alias bound to the calling consumer
```

- **O serviço retorna a mensagem; o cliente nunca a reconstrói.** Um cliente que a
  monta a partir da documentação está a uma mudança na ordem dos campos de ter
  assinaturas recusadas sem que nada, de nenhum dos lados, diga por quê.
- **A assinatura cobre um digest com tag de domínio, nunca uma transação.** Nada do
  que este fluxo pede para uma carteira assinar pode ser enviado à rede, e o domínio
  (`Cosmos Pay alias claim v1`) pertence só a esta funcionalidade, então um dapp que
  convence um usuário a assinar uma mensagem arbitrária não sai dali com uma
  reivindicação válida.
- **O propósito está dentro dos bytes assinados** (`CLAIM`, `ADD_ADDRESS`,
  `RECOVER`), então uma assinatura coletada para adicionar um endereço não pode ser
  reutilizada para concluir uma recuperação.
- **O endereço vem do challenge, não do corpo da reivindicação.** A reivindicação não
  tem campo de endereço, então ninguém consegue assinar por um endereço e registrar
  outro.
- **Os challenges são de uso único e duram cinco minutos.** A assinatura é verificada
  *antes* de o challenge ser consumido, então uma assinatura inválida não consegue
  queimar o nonce em andamento de um concorrente; e consumi-lo é um compare-and-swap,
  então duas requisições não conseguem consumir o mesmo challenge.
- **Uma corrida é decidida pelo índice único em `alias.name`**, e não por uma
  verificação prévia; o perdedor recebe `409 alias_taken`.

### O que um handle pode ser

`a-z` minúsculo, `0-9` e `_` (nunca em nenhuma das pontas), de 3 a 32 caracteres,
convertido para minúsculas antes de a unicidade ser decidida. Sem Unicode: o conjunto
de homóglifos é ilimitado, e nenhuma normalização torna um `а` cirílico seguro de
exibir ao lado de um valor. Também são recusadas: palavras reservadas que se
passariam pelo produto ou por um operador (`admin`, `support`, `cosmospay`,
`stellar`, …) e qualquer coisa que pareça uma conta Stellar (`g` ou `m` seguido de 20
ou mais caracteres base32). A regra está em `src/aliases/alias-name.ts`.

### Muitos endereços, um nome

Um alias aponta para até 20 endereços em várias redes — um celular, um desktop, uma
cold wallet, testnet — com exatamente um primário por rede, garantido por um índice
único parcial. Adicionar um endereço exige **duas** provas: quem chama é dono do
alias, e o novo endereço assina o seu próprio challenge `ADD_ADDRESS`. O último
endereço restante não pode ser removido (libere o alias em vez disso), e um consumer
pode ter no máximo 25 aliases.

Um alias `SUSPENDED` — um bloqueio imposto por um operador — não resolve para nada.
Uma suspensão que continua entregando uma conta não faz nada a respeito do dinheiro.

### A recuperação passa pelo e-mail e pelo console da plataforma

Chaves se perdem, e uma chave perdida não pode deixar um nome inalcançável para
sempre, então uma reivindicação registra uma caixa de e-mail de recuperação. Isso faz
da recuperação o caminho mais perigoso do módulo:

1. O **console da plataforma** chama `POST /v1/aliases/:name/recovery {email}`. A
   resposta é idêntica quer o handle e a caixa de e-mail coincidam, quer não; quando
   coincidem, ela traz um token de uso único (30 minutos, armazenado apenas como
   SHA-256), que o console envia por e-mail. Este serviço não envia e-mail.
2. O usuário obtém um challenge `RECOVER` para a nova chave e chama
   `POST /v1/aliases/:name/recovery/complete {token, address, network, nonce, signature}`
   com a sua própria API key. As duas provas são exigidas: o token prova a caixa de
   e-mail, a assinatura prova a chave.
3. A titularidade passa para o consumer que chama e **todos os endereços anteriores
   são descartados**. A recuperação existe porque as chaves antigas se foram, e
   deixá-las resolvíveis faria com que quem as detém continuasse recebendo os
   pagamentos.

**Por que o passo 1 pertence ao console.** O token *é* a prova de controle da caixa
de e-mail, então ele só pode chegar à parte que entrega o e-mail. A rota costumava
aceitar qualquer chave com `payments:write` e devolvia o token a quem pedisse — então
qualquer um que conhecesse um handle e o e-mail do seu dono podia tomar o alias, e
com ele todo pagamento enviado a ele. O `ConsoleOnlyGuard` agora recusa todo
chamador com API key com `403 admin_console_only` antes mesmo de o alias ser
consultado, e a rota fica fora do contrato publicado. Cinco tokens errados queimam
uma recuperação (o dono simplesmente inicia outra; um atacante não consegue bloquear
um nome errando de propósito), e um alias suspenso não pode ser recuperado.

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
obrigatório (os *receivers* do BlindPay) por trás de ambos. Rodamos uma **única
instância BlindPay da plataforma** (`BLINDPAY_API_KEY` + `BLINDPAY_INSTANCE_ID` no
env); todo receiver/carteira/conta bancária/payin/payout é espelhado no nosso
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
| PATCH  | `/v1/kyc/receivers/:id`                               | `kyc:write`    | Atualizar um receiver |
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
defina `BLINDPAY_WEBHOOK_SECRET` com o segredo de assinatura desse endpoint. Deixe as
variáveis `BLINDPAY_*` em branco para desativar a funcionalidade (essas rotas retornam
`503`). Veja `.env.example`.

### As URLs de redirecionamento do KYC ficam em allow-list por consumer

O fluxo de termos de serviço envia o usuário ao BlindPay e de volta para uma
`redirect_url` fornecida pelo integrador. Aceita como string livre, isso é um open
redirect vestindo o nome da plataforma: um link que começa em uma página de KYC
confiável e termina onde um atacante quiser. Por isso, toda `redirect_url` passa por
duas camadas:

| Camada | Regra | Onde |
| ------ | ----- | ---- |
| Formato | uma URL `https` absoluta sem credenciais embutidas (`user:pass@`) | `@IsRedirectUrl()` em todo DTO que traz uma |
| Host | na allow-list **do consumer que chama** — o host exato, ou um subdomínio em um limite de label (`app.acme.com` corresponde a `acme.com`; `evilacme.com` não) | `KYC_REDIRECT_URL_WHITELIST`, aplicado na camada de serviço |

```
KYC_REDIRECT_URL_WHITELIST={"cosmos_acme":["acme.com","app.acme.com"]}
```

Ela é **fail-closed**: um consumer sem entrada não pode usar redirecionamento algum, e
um host com ponto final ou em forma IDN é recusado em vez de normalizado. A lista é
por consumer porque um domínio que um integrador avaliza não diz nada sobre outro.
Todo ponto de entrada que recebe uma `redirect_url` a verifica — iniciar, solicitar e
aprovar os termos de serviço, incluindo a aprovação pelo admin, que aplica a lista do
próprio consumer do receiver. Um esquema ou host recusado resulta em `400`.

## Pollar — login social que devolve uma carteira Stellar

A [Pollar](https://docs.pollar.xyz/docs) transforma um login Google/GitHub em uma
conta Stellar: autentica o usuário, cria uma carteira, custodia a chave no AWS KMS,
adiciona as trustlines configuradas e financia a reserva — o usuário nunca vê uma
seed phrase. Este serviço a expõe como uma **bridge OAuth**, o mesmo formato que um
launcher de jogos ou um console usa quando o cliente conclui a troca do código
localmente.

### Por que uma bridge e não um passthrough

O login hospedado da Pollar foi projetado para um SDK de navegador. Ele leva o
usuário a `GET /auth/{provider}` com uma publishable key, um id de client session e
uma `redirect_uri` — e essa redirect URI precisa ser um host **registrado na
Pollar**. Uma carteira não consegue satisfazer nada disso: um listener de loopback em
uma porta efêmera ou um deep link `cosmospay://` nunca pode ser um host registrado, e
a montagem exige chaves e ids de sessão com os quais a carteira não deveria lidar.

Então a bridge fica com a metade voltada para a Pollar. A carteira recebe um contrato
de dois passos que já entende — **abrir uma autorização, resgatar um código** — e
não absorve nada além desse código.

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

O passo 6 é o objetivo de tudo isso: a resposta do resgate também traz a
`publishable_key` e a `api_base_url`, então dali em diante a carteira lê saldos,
monta e envia transações diretamente contra a própria carteira virtual. **Este
serviço nunca faz proxy dessa superfície e não guarda nenhuma chave que permitiria
fazê-lo.**

### Duas formas de absorver o código

|                  | Fluxo de redirect                                | Fluxo de polling                                |
| ---------------- | ------------------------------------------------ | ----------------------------------------------- |
| A carteira fornece | `redirect_uri` (precisa estar na allow-list)   | nada                                            |
| O código chega   | como `?code=…&state=…` no redirect               | por `GET /v1/pollar/oauth/sessions/{state}`     |
| O navegador vê   | a sua própria URI                                | uma página simples de "você pode fechar esta janela" — nunca o código |
| Use quando       | a carteira tem um deep link ou um listener de loopback | não tem nenhum dos dois (quiosque, headless, view embutida) |

Cada polling emite um código novo e aposenta o anterior, então resgate o código do
seu polling mais recente. Isso decorre de nunca armazenar uma credencial ativa: a
linha guarda um SHA-256 do código, e um hash não pode ser revertido.

**Prefira o fluxo de polling.** A Pollar não devolve o navegador para o callback: o
seu fluxo hospedado termina na sua própria página — `www.pollar.xyz/auth/status` —
quer o consentimento tenha sido recusado, quer concedido, e um consentimento
concedido simplesmente deixa a client session `READY` do lado da Pollar. A
`redirect_uri` que a URL de autorização carrega nunca é visitada, então um handshake
que espera ser chamado de volta espera até expirar.

Por isso, a rota de polling pergunta à Pollar em vez de esperar ser avisada: enquanto
um handshake está `pending`, ela verifica o status da própria client session e
promove o handshake no momento em que a Pollar informa `READY` — a mesma condição
pela qual o resgate já espera. O contrato da carteira não muda; o que mudou é que
`pending` agora termina sozinho.

Duas notas operacionais decorrem disso:

- **A rota de callback ainda existe e continua registrada na Pollar.** Ela funciona
  se um redirect chegar, e é dela que depende um handshake do fluxo de redirect —
  esse fluxo não tem outro lugar onde colocar um código. Ela só não pode ser a única
  forma de perceber um login.
- **O provedor é consultado no máximo uma vez a cada dois segundos por handshake**
  (`POLLAR_SESSION_PROBE_INTERVAL_MS`), por meio de um compare-and-swap em
  `providerCheckedAt` compartilhado por todas as réplicas. Uma carteira fazendo
  polling a cada segundo custa, portanto, 30 requisições por minuto à Pollar, e não
  60, contra uma chave cujo orçamento total é 200.

Um handshake cuja client session a Pollar deixou de reconhecer
(`INVALID_CLIENT_SESSION_ID`, `EXPIRED_CLIENT_ID`, ou um `404`/`410`) é encerrado na
hora como `failed` com esse código, em vez de continuar sendo consultado até o TTL
acabar.

### Um login, uma carteira em ambas as redes

A Pollar roda mainnet e testnet como duas aplicações separadas, com dois pares de
chaves separados, então um login hospedado só consegue produzir uma carteira na rede
para a qual a sua API key resolveu (`prod` → `public`, `dev` → `testnet` — veja
`resolveNetwork`). Um usuário que depois transita entre ambientes não tem carteira do
outro lado: o endereço que ele financiou na testnet não é o endereço que recebe na
mainnet, e a segunda carteira acaba sendo criada no momento em que ele precisa dela
pela primeira vez, que é o momento menos capaz de absorver uma falha do provedor.

Por isso, um resgate também registra o usuário na **outra** rede, pelo
`POST /users/with-wallet` da Server API, e `POST /v1/pollar/oauth/token` informa as
duas:

```jsonc
"network_wallets": [
  { "network": "testnet", "status": "ready",   "address": "GA5Z…" },
  { "network": "public",  "status": "pending", "address": null    }
]
```

**Uma entrada `pending` não é um erro.** O login teve sucesso; a segunda carteira é a
parte que ainda não ficou pronta, e o objetivo do design é justamente que ela não
possa derrubar o login junto. A tentativa feita no caminho da requisição tem cinco
segundos e uma única chance, e o que ela não terminar é retentado em segundo plano
pelo sweeper de provisionamento — mesma chave e mesma cadência do sweeper de
handshakes (`POLLAR_SWEEP_*`), com backoff exponencial e um orçamento total de dez
tentativas antes de a linha passar a `failed`.

O motivo mais comum de `pending` é prosaico: **as chaves da outra rede não estão
configuradas.** Enquanto não estiverem, todo login deixa uma contraparte pendente; no
momento em que forem definidas, uma única varredura provisiona todo o backlog sem que
ninguém precise fazer login de novo. É por isso que vale definir as chaves das duas
redes mesmo quando você só atende uma hoje.

Duas consequências que vale conhecer:

- **A chave de junção é o e-mail do OAuth**, porque é por ele que um login hospedado
  posterior na outra rede identifica a mesma pessoa. Um provedor que não garante
  nenhum e-mail não recebe carteira de contraparte alguma — melhor do que uma
  carteira órfã que custou XLM e que nenhum login jamais alcança.
- **Isso gasta XLM nas duas redes.** Um login na mainnet agora também financia uma
  reserva na testnet, e vice-versa. O estado por rede fica em `pollar_user_wallet`,
  uma linha por (consumer, email, network), que também é a idempotência: um login
  repetido faz upsert por ela em vez de provisionar de novo.

### O que a bridge armazena

Uma linha de handshake, e nada nela pode gastar dinheiro: o `state` impossível de
adivinhar, o id da client session da Pollar, um **hash** do código e o endereço
Stellar público resultante. **Nenhum token da Pollar é persistido** — a troca
`/auth/login` roda dentro da requisição de resgate e os tokens saem direto na
resposta dela. Handshakes que ninguém concluiu são expirados por um timer
(`POLLAR_SWEEP_*`), porque uma linha `AUTHORIZED` é um código resgatável até ser
varrida.

Toda transição é um compare-and-swap no status da linha, então um callback repetido
não emite um segundo código, e duas carteiras disputando um mesmo código não podem
vencer as duas.

### Endurecimento que vale conhecer

- **PKCE (RFC 7636, S256)** é opcional, mas recomendado: passe `code_challenge` no
  authorize e `code_verifier` no resgate, e um código que vaze de um navegador ou de
  um log fica inútil sem o verifier.
- **`dpop_jwk`** vincula os tokens que a Pollar emite à própria chave P-256 da
  carteira (RFC 9449), então um access token roubado fica inerte sem uma prova
  assinada. Isso também significa que a bridge não pode mais agir em nome da carteira
  — `/refresh` e `/logout` atendem sessões bearer, e uma carteira vinculada por DPoP
  chama a Pollar diretamente.
- **`POLLAR_REDIRECT_URI_WHITELIST`** é por consumer e fail-closed. Uma redirect URI
  é onde um código de uso único chega, então uma URI não verificada é um canal de
  exfiltração. Aceita hosts de loopback (qualquer porta, conforme a RFC 8252), deep
  links com esquema de uso privado e hosts https.
- **Mantenha em um servidor as API keys que têm `pollar:*`.** O fluxo de polling
  entrega o código a quem tiver o `state` do handshake *e* uma chave com
  `pollar:read`. Um atacante que extraia uma chave dessas de um app distribuído a
  usuários pode abrir um login, enviar a sua `authorization_url` a uma vítima, fazer
  polling do código assim que a vítima consentir na página real do Google/GitHub e
  resgatá-lo com um verifier PKCE próprio — PKCE e `dpop_jwk` não ajudam, porque o
  atacante fornece os dois. Esse é o formato do phishing de device code, e a defesa é
  que a chave nunca saia de um backend que você controla.

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
| POST   | `/v1/pollar/users` · `/v1/pollar/users/with-wallet`   | `pollar:write` | Registrar um usuário, opcionalmente com uma carteira |
| POST   | `/v1/pollar/tokens/verify`                            | `pollar:read`  | Validar um token que uma carteira apresentou a você |

As últimas seis precisam da chave **secreta** da Pollar, e é exatamente por isso que
ficam aqui e não na carteira. Os schemas de requisição e resposta de todas elas estão
no contrato gerado — Swagger UI em `/docs`, ou `openapi/openapi.{json,yaml}`. A
tabela acima serve para orientação; o contrato é a fonte da verdade.

### Rate limiting: o que impede o abuso da geração de carteiras

Criar uma carteira Pollar não é de graça. A Pollar cria a conta Stellar, financia a
sua reserva base (1 XLM) e adiciona uma trustline por ativo configurado (0.5 XLM
cada) — **a partir da sua carteira de financiamento**. Um loop contra o fluxo de
login é, portanto, uma forma de um estranho gastar o seu dinheiro, e ele não precisa
de um usuário real do outro lado para isso.

Por isso os limites ficam aqui, neste serviço, e não só no gateway: este é o processo
que sabe que uma requisição está prestes a criar uma conta, e é ele que pode recusar
antes de o XLM sair.

**O ponto de controle é o `authorize`, não o `token`.** Um handshake gera no máximo
uma carteira, então limitar quantos handshakes um endereço pode abrir limita quantas
carteiras ele pode provocar. `token` fica deliberadamente mais frouxo, porque o
caminho do 409 diz a quem chama para repetir exatamente essa requisição enquanto a
Pollar provisiona a conta — um orçamento apertado ali estrangularia o nosso próprio
retry documentado, e resgatar não cria nada que o handshake já não tivesse permitido.

| Rota | Orçamento (por 10 min) | Por que esse número |
| ---- | ---------------------- | ------------------- |
| `POST /v1/pollar/oauth/authorize` | 20 | O limite da geração de carteiras. Muito acima de um humano repetindo uma tela de consentimento que falhou, muito abaixo de uma taxa que esvazia uma conta |
| `POST /v1/pollar/oauth/token` | 60 | Frouxo de propósito — veja acima |
| `GET /v1/pollar/oauth/callback` | 60 | A única rota acessível sem API key, portanto a única que uma enxurrada anônima alcança. Um usuário recarregando a aba é normal |
| `POST /v1/pollar/users/with-wallet` | 10 | Cria uma carteira sem uma tela de consentimento para ditar o ritmo — o orçamento mais apertado do conjunto |
| `POST /v1/pollar/wallets/activate` | 20 | Gasta XLM a cada chamada, mas não consegue criar nada novo |

Exceder um deles retorna **`429` com `code: "rate_limited"`**, um `Retry-After` e o
trio `RateLimit-Limit` / `-Remaining` / `-Reset`. Todo o resto do serviço não tem
limite aqui; a modelagem geral de tráfego é trabalho do APISIX, já que ele vê a
requisição antes deste processo.

**O contador fica no Postgres, não em memória.** O serviço roda atrás de um load
balancer, então um limitador por processo daria a cada réplica o orçamento inteiro: o
limite efetivo vira `limit × replicas` e muda silenciosamente sempre que o deploy
escala. Isso serve para um throttle cosmético e não serve para algo que protege um
saldo real. É uma janela fixa — um `INSERT … ON CONFLICT … RETURNING` atômico por
requisição —, o que significa que um cliente pode gastar um orçamento inteiro de cada
lado de uma virada de janela, então trate os números acima como "no máximo o dobro
disso por janela". Eles foram definidos sabendo disso.

**Como o endereço é decidido, e por que não pode ser falsificado.** `main.ts` define
`trust proxy` como `1`, o que faz o Express ler a entrada *mais à direita* de
`X-Forwarded-For` — a que o APISIX acrescentou, ou seja, o peer tal como o gateway o
viu. Um cliente pode prefixar entradas nesse header, mas tudo o que ele escreve fica à
esquerda da entrada do APISIX e é ignorado.

> **Não aumente `trust proxy`.** Em `2`, o Express passa a honrar o primeiro hop
> fornecido pelo cliente, e todo limite aqui se torna contornável com a adição de um
> header. `src/common/client-ip.spec.ts` fixa os dois comportamentos para que a
> mudança não passe despercebida na revisão.

Um chamador IPv6 é agrupado por **/64**, e não por endereço: um cliente rotineiramente
recebe um /64 inteiro e pode alternar entre os seus endereços de graça, então limitar
por endereço ali não é limitar. O custo é que dois usuários atrás de um mesmo /64
compartilham um bucket, exatamente como dois usuários atrás de um mesmo NAT IPv4 já
compartilham. Os buckets também são separados por consumer, então o tráfego de um
integrador não consegue consumir o de outro.

Se o contador não puder ser gravado, o limitador é **fail-closed** (`503`). Um
limitador que para de limitar em silêncio durante um incidente no banco vale menos que
nenhum, porque nada avisa que isso aconteceu — e toda rota atrás dele precisa do mesmo
banco de qualquer forma, então recusar não custa nenhuma disponibilidade que já não
estivesse perdida.

Defina `RATE_LIMIT_ENABLED=false` como chave de incidente.

### Configuração

1. Crie um app em [dashboard.pollar.xyz](https://dashboard.pollar.xyz) e pegue as duas
   chaves da sua rede (`pub_testnet_…` / `sec_testnet_…`). Faça isso para **as duas**
   redes: um login provisiona uma carteira em cada uma, e uma rede sem chaves deixa a
   segunda carteira de todo usuário `pending` até que elas sejam definidas. Os dois
   dashboards são separados — registre o host de callback em cada um.
2. Registre o **host do gateway** de `POLLAR_BRIDGE_CALLBACK_URL` em
   **Build → Domains**. Não se trata só do redirect: a SDK API verifica essa lista em
   *toda* chamada, contra o header `Origin`, e a bridge envia a origem desse host
   nesse header (`POLLAR_SDK_ORIGIN` a sobrescreve). Um host não registrado resulta em
   `403 ORIGIN_NOT_ALLOWED` em `POST /auth/session` — a primeira chamada de todo
   login, antes de o usuário ver qualquer tela de consentimento.
3. Defina `POLLAR_BRIDGE_CALLBACK_URL` como `<gateway>/v1/pollar/oauth/callback` — a
   bridge acrescenta `/{state}` por conta própria.
4. Adicione a redirect URI de cada carteira a `POLLAR_REDIRECT_URI_WHITELIST`, ou
   omita-a e use o fluxo de polling.

As chaves são por rede, e a Pollar codifica a rede e o tipo de chave no prefixo,
então uma incompatibilidade é uma rejeição definitiva — o validador de env a detecta
no boot, e não em um login diante do usuário. Deixe as chaves em branco para desativar
a funcionalidade (as rotas da Pollar passam a retornar `503`). Veja `.env.example`.

## Atualização — mudanças incompatíveis e notas de deploy

### Correções da revisão de segurança

Uma revisão de todo o serviço encontrou os problemas abaixo. Cada um está corrigido e
fixado por um teste que falha sem a correção. A maioria não muda nada para quem chama
de forma correta, mas cada linha é visível para alguém — leia a coluna "Quem percebe"
antes do deploy.

| Mudança | Quem percebe | Por quê |
| ------- | ------------ | ------- |
| `POST /v1/aliases/:name/recovery` é **exclusiva do console da plataforma**: uma API key recebe `403 admin_console_only`, e a rota saiu do contrato publicado | Quem iniciava recuperações com uma API key | A resposta traz o token de recuperação, que é a prova da caixa de e-mail do dono. Protegida apenas por um escopo, qualquer um que conhecesse um handle e o e-mail do seu dono recebia o token e podia tomar o alias e todo pagamento enviado a ele |
| Concluir uma recuperação em um alias `SUSPENDED` resulta em `404` | Ninguém legítimo | Um token emitido antes de uma suspensão era uma forma de escapar do bloqueio do operador |
| Rotas `@Public()` (callback da Pollar, webhook do BlindPay, health) ignoram `X-Consumer-Username` | Dashboards: essas requisições agora aparecem no log como anônimas | Essas rotas rodam sem key-auth, então o header era do próprio cliente: um nome novo por requisição era um orçamento de rate limit novo, e usar o nome de uma vítima registrava linhas forjadas na visão de logs da API dela |
| Recusas do `AdminGuard` e do `ConsoleOnlyGuard` são registradas em nível `warn` | Operadores | Os guards rodam antes do log de acesso, então uma sondagem de `/v1/admin` não deixava rastro em lugar nenhum |
| `POST /v1/pollar/wallets/activate` e as três rotas `/v1/pollar/wallets/:address/trustlines…` retornam `404` para uma carteira que o consumer que chama não obteve por meio deste serviço naquela rede | Integradores que agem sobre carteiras que só viram via `tokens/verify`, sobre carteiras não primárias de um login ou sobre uma carteira de contraparte que outro tenant já registrou | Todos os tenants compartilham um único conjunto de chaves secretas da Pollar, então, sem a verificação, um tenant podia remover as trustlines dos usuários de outro tenant ou gastar o XLM do operador nas reservas deles. Uma carteira alheia e uma desconhecida recebem o mesmo `404`, então a resposta não é um oráculo de titularidade |
| As duas rotas `POST …/trustlines` compartilham um orçamento de `429` de 20 chamadas a cada 10 minutos | Scripts que adicionam trustlines em massa | Cada trustline trava 0.5 XLM de reserva na carteira de financiamento do operador, e estas eram as únicas rotas que gastam XLM sem limite |
| `GET /v1/offramp/payouts/:id` não retorna mais `raw`, `consumerId`, `receiverId`, `quoteId`, `bankAccountId` nem `updatedAt`; a resposta de criação de conta virtual não retorna mais `raw`, `receiverId`, `consumerId` nem `updatedAt` | Quem lê esses campos | `raw` é o objeto armazenado do BlindPay, com dados bancários e do beneficiário, e chegava a qualquer chave com `offramp:read` — esse caminho de leitura ignorava a projeção pública que todas as outras leituras de payout usam |
| `POST /v1/kyc/upload` retorna `400` para mais de 4 campos de texto, um campo acima de 1 KiB, um segundo arquivo ou bytes de arquivo que não correspondem ao tipo declarado | Ninguém que envie um upload bem formado | Os padrões do Multer deixavam os campos sem limite e com 1 MB cada em memória, e a verificação de tipo confiava no `Content-Type` do cliente |
| `POST /v1/payment-intents/tx` e `/pay`: o mesmo memo com qualquer termo diferente resulta em `409 idempotency_conflict`. Uma repetição idêntica continua retornando o intent armazenado (`2` e `2.0` são o mesmo valor) | Quem reutiliza um memo para pagamentos diferentes | Sob a chave pública compartilhada, toda carteira anônima é um único consumer, então um memo que outra pessoa criou primeiro retornava o intent *dela* — com um QR que pagava a ela |
| `POST /v1/payment-intents/:id/validate` marca `FAILED` somente para uma tx com falha que seja o próprio pagamento deste intent; qualquer outra tx com falha resulta em `valid: false` com o status inalterado. Uma tx fechada mais de 60 s antes de o intent ser criado é recusada ("Transaction predates this payment intent") — no validate, no `PATCH {status: SUCCEEDED}` e no observer | Ninguém legítimo | O hash de qualquer transação com falha na rede fazia um intent falhar permanentemente, e um pagamento antigo com os mesmos termos podia liquidar um intent novo |
| `PATCH /v1/payment-intents/:id` alterando o `txHash` de um intent em estado terminal resulta em `400 invalid_state_transition`; uma mudança de status concorrente com a escrita resulta em `409 operation_in_flight` | Ninguém legítimo | Isso reescrevia a evidência de liquidação de um intent `SUCCEEDED` |
| O observer de payment intents reconcilia no máximo 10 intents por consumer por ciclo e nunca varre linhas expiradas | Operadores que acompanham a vazão do observer | Uma enxurrada de intents de valor aberto vinda de um único consumer travava a liquidação de todos os outros tenants e gastava o orçamento compartilhado do Horizon |
| `POST /v1/swaps`, `/v1/liquidity-pools/deposit` e `/withdraw`: um `Idempotency-Key` reutilizado com uma requisição diferente — outro memo ou slippage, a outra rede, ou uma chave de depósito reutilizada para um saque — resulta em `409 idempotency_conflict`. Uma repetição com ativo, slippage ou memo inválido agora recebe o `400` normal | Clientes que reutilizam uma chave para operações diferentes | Sob a chave pública compartilhada, um atacante podia criar de antemão, sob uma chave adivinhável, um swap ou saque da conta de uma vítima para a própria conta, e a retentativa da vítima retornava esse envelope para ela assinar |
| `POST /v1/liquidity-pools/withdraw` não responde mais `409 operation_in_flight` para um saque em andamento cujo número de sequência a conta ainda não usou (um envelope não assinado ou abandonado) | Usuários de carteira que ficavam bloqueados | Um saque de valor ínfimo montado para a conta de outra pessoa e reenviado a cada 300 s impedia todos os usuários da chave pública de sacar aquela posição. Os dois envelopes compartilham um número de sequência, então no máximo um deles pode ser liquidado |
| O observer de liquidação processa no máximo 10 linhas por consumer, por tabela, por ciclo, e `GET /v1/liquidity-pools/positions` lê o Horizon por meio de uma única listagem paginada em vez de uma requisição por pool | Operadores | A enxurrada de um único consumer travava a liquidação de todos os outros, e uma conta com participações em muitos pools disparava chamadas sem limite ao Horizon |
| `GET /v1/onramp/payins/:id` não retorna mais `receiverId` nem `updatedAt` — o mesmo formato que `GET /v1/onramp/payins` retorna | Quem lê esses dois campos na leitura de um único payin | Um payin com linha espelho recente era devolvido como estava armazenado, então o mesmo payin chegava em dois formatos conforme a idade do espelho, um deles com um id interno |
| `POST /v1/kyc/upload` com um arquivo acima de 10 MiB é `413` com `code: "payload_too_large"`; antes era `internal_error` | Integradores que decidem pelo `code` | Um limite que quem chama pode respeitar parecia um bug deste serviço |
| `POST /v1/liquidity-pools/deposit`, `/withdraw`, `GET /v1/liquidity-pools/operations`, `/operations/:id`, `POST /v1/liquidity-pools/operations/:id/submit` e os webhooks `LIQUIDITY_*` agora trazem `memo` (o MEMO_ID de quem chama, ou `null`). Operações criadas antes da migration `20260915120000_liquidity_pool_operation_memo` retornam `null` mesmo quando o envelope carrega um | Ninguém, a menos que um cliente rejeite campos desconhecidos | O memo só ficava registrado dentro do XDR, então cada replay com `Idempotency-Key` decodificava o envelope para compará-lo |
| O contrato publicado de `GET /v1/swaps` e `GET /v1/liquidity-pools/operations` não declara mais `qr` nem `commissionMemo` nos itens da lista. As respostas não mudam — esses dois campos nunca foram enviados ali; obtenha-os lendo o item individual | Clientes gerados a partir do spec OpenAPI | O contrato declarava os itens da lista com o formato da leitura individual, então um cliente gerado tipava dois campos que a lista nunca trazia |

Notas de deploy que vêm junto:

- **A migration `20260910120000_aliases`** cria `alias`, `alias_address`,
  `alias_challenge` e `alias_recovery`. Rode `migrate deploy` antes de o novo build
  receber tráfego.
- **Um novo id de advisory lock, `881_008` (`AliasChallengeSweeper`).** Nada a
  configurar; listado para que o número nunca seja reutilizado.
- **Defina `NODE_ENV=production` em produção.** O `.env.example` vem com
  `development`, e duas proteções dependem disso: uma requisição sem
  `X-Plan-Swap-Fee-Bps` é um `503` apenas em produção (em qualquer outro ambiente os
  swaps recorrem silenciosamente a `STELLAR_SWAP_FEE_BPS`), e `/docs` — fora de todo
  guard — fica desligado por padrão apenas em produção.
- **O observer de liquidação agora roda sobre `ScheduledJob`.** `OBSERVER_ENABLED`,
  `OBSERVER_INTERVAL_MS` e o advisory lock não mudam, mas as linhas de log passam a
  ser as compartilhadas: `Settlement observer started (every Nms)`,
  `Settlement observer (OBSERVER_ENABLED=false) disabled` e
  `SettlementObserverService cycle failed` no nível `error`. Um alerta que procure o
  texto antigo precisa ser atualizado.
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

### NestJS 12, TypeScript 6 e Node 24.9 como versão mínima

Toda a linha do NestJS passou para a 12 e o TypeScript para a 6. **Isso eleva a
versão mínima do Node para 24.9** (`engines`, e os dois workflows agora fixam
`node-version: 24`); qualquer versão anterior não consegue sequer rodar a suíte de
testes. Os ambientes de deploy precisam acompanhar.

O motivo é o test runner, não o framework. O NestJS 12 é publicado como ESM puro
(`"type": "module"`), e o Jest rodando sob CommonJS não consegue fazer `require()`
dele — todas as 62 suítes falhavam ao carregar. O Jest suporta `require(esm)`
nativamente, mas só no Node >= 24.9 **e** com `--experimental-vm-modules`, porque a
capacidade que ele verifica (`vm.SourceTextModule.prototype.hasAsyncGraph`) não
existe sem essa flag. Por isso, os scripts de teste agora invocam o Jest diretamente
pelo Node:

```
"test": "node --experimental-vm-modules node_modules/jest/bin/jest.js"
```

E não com um prefixo `NODE_OPTIONS=`: isso não é portável para shells do Windows, e a
CI, o job de release e a máquina de um desenvolvedor precisam rodar o mesmo comando.

Duas consequências que vale conhecer:

- **`transformIgnorePatterns` saiu das duas configurações do Jest.** Ele listava os
  pacotes ESM (`@stellar`, `@noble`, `@exodus`, `uint8array-extras`) a serem
  transpilados para CommonJS pelo ts-jest — um contorno para a impossibilidade de
  carregar ESM. Agora que o Jest carrega ESM nativamente, o contorno atrapalha
  ativamente: um pacote compilado para CJS é avaliado como ESM e morre com
  `exports is not defined`. Se alguma dependência voltar a precisar de
  transformação, esse é o arquivo a olhar.
- **O `tsconfig.json` ganhou `types` e `rootDir`.** O TypeScript 6 não inclui mais
  automaticamente todo pacote `@types`, então os dois pacotes de tipos globais
  (`node`, `jest`) são nomeados explicitamente — sem isso, toda spec perdia
  `describe`/`it` e, mesmo assim, passava verde no ts-jest. E o TS 6 se recusa a
  inferir `rootDir` quando uma compilação cobre um único diretório (TS5011), que é o
  que os scripts ts-node fazem; `"./"` é o que o build completo já inferia, então o
  layout emitido não muda.

Mudanças de código que as versões major forçaram, todas pequenas:

- `EventEmitter2` é importado de `eventemitter2`, não de `@nestjs/event-emitter`. É o
  mesmo objeto de classe em runtime — o token de DI não muda —, mas o re-export do
  Nest é tipado para o formato CJS do pacote e resolve para `any` sob a resolução de
  módulos `node10` deste repositório, o que silenciosamente transformava cada
  `.emit()` em uma chamada sem verificação de tipos. É por isso que `eventemitter2`
  agora é uma dependência direta.
- `OperationObject` vem de `@nestjs/swagger` em vez de
  `@nestjs/swagger/dist/interfaces/open-api-spec.interface`. O Swagger 12 publica um
  mapa `exports` que expõe apenas `.` e `./plugin`, então caminhos profundos deixaram
  de resolver.
- `AccountLoaderService.load` tem um tipo de retorno explícito
  `Promise<Horizon.AccountResponse>`; o TS 6 não infere um tipo que não consegue
  nomear de forma portável.
- Dois mocks de teste (`fetch`, `Reflector.getAllAndOverride`) agora correspondem às
  assinaturas reais, em vez de versões mais estreitas escritas à mão.

O OpenAPI publicado cresceu: `@nestjs/terminus@12` emite schemas de health mais ricos
(enums de status e uma propriedade `responseTime`). Puramente aditivo — nenhuma rota
ou schema de negócio mudou.

### Uma API key pública compartilhada, e o guard que a restringe

Novo nesta versão: `PublicKeyGuard` (global, depois do `PermissionsGuard`) e o
decorator `@AllowPublicKey()`. Nada muda para as chaves existentes — o guard não tem
opinião sobre um consumer que não seja o público compartilhado —, mas duas coisas
precisam ser feitas no deploy:

- **Defina `APISIX_PUBLIC_CONSUMER`** com o username que a plataforma de
  desenvolvedores provisiona para a chave pública, em todo deploy que publique uma.
  Sem ela, o guard recorre apenas ao `X-Consumer-Role` encaminhado.
- **A chave pública precisa ser emitida com `role: public`** e apenas com os escopos
  de que as rotas da allowlist precisam. Conceder `kyc:*` ou `webhooks:*` a ela não
  abriria essas rotas — o guard as recusa de qualquer forma —, mas seria uma
  credencial mais ampla do que a sua função, nas mãos de todo mundo.

Veja "A API key pública compartilhada" acima para saber o que ela pode alcançar e
por quê.

### O registro de ativos: `GET /v1/assets`

Uma tabela curada dos pares (code, issuer) que esta plataforma avaliza, por rede, com
o nome da organização emissora. Não exige escopo — o catálogo não guarda dados de
tenants, e protegê-lo só faria com que toda chave emitida antes de o escopo existir
visse um seletor de tokens vazio —, mas exige um consumer autenticado, incluindo a
chave pública compartilhada.

`npm run assets:verify` confere de novo cada linha contra o Horizon ao vivo: que o
par existe na rede em que está cadastrado, que `contract` corresponde ao
`contract_id` do Horizon e que as flags do emissor batem com a chain. Rode-o ao
editar o registro. Não é um teste unitário porque precisa da internet pública, e um
teste que falha quando o Horizon está lento é um teste que as pessoas aprendem a
pular.

### Atividade do cliente: um novo módulo, uma nova tabela e dois novos escopos

`POST /v1/activity/events` aceita telemetria da carteira e do dashboard de
desenvolvedores; `GET /v1/activity/events` e `GET /v1/activity/summary` a leem de
volta. Nada do que existia mudou de formato, mas três coisas precisam ser feitas no
deploy:

- **A migration `20260906140000_activity_event`** cria `activity_event`
  (append-only, restrita por `consumerId`, única em `(consumerId, eventId)`).
- **Os escopos `activity:write` e `activity:read` são novos.** Uma chave sem eles
  recebe `insufficient_scope`, que é a resposta correta — mas isso significa que uma
  chave existente não ganha a capacidade de reportar telemetria só com a atualização.
  A plataforma de desenvolvedores concede ambos às chaves provisionadas pela carteira
  e reaplica o conjunto na rotação; chaves emitidas manualmente precisam recebê-los.
- **`ACTIVITY_RETENTION_DAYS`** (padrão 30) entra no job de retenção. São dados
  pessoais no mesmo patamar do log de acesso; defina `0` apenas deliberadamente.

### A rota de polling da Pollar agora descobre sozinha um login concluído

`GET /v1/pollar/oauth/sessions/{state}` costumava informar o que o callback da bridge
tivesse registrado. A Pollar nunca chama esse callback — o seu fluxo hospedado termina
em `www.pollar.xyz/auth/status` e deixa a client session `READY` —, então um
handshake do fluxo de polling ficava `pending` até expirar, com uma carteira que
estava fazendo tudo certo. O polling agora pergunta diretamente à Pollar e promove o
handshake em `READY`.

Nenhum formato de API mudou e nenhuma mudança no cliente é necessária: um login que
costumava travar em `pending` agora chega a `authorized` no primeiro polling depois de
o usuário concluir. Duas coisas a considerar no deploy:

- **A migration `20260906120000_pollar_oauth_provider_probe`** adiciona uma coluna
  anulável `providerCheckedAt` a `pollar_oauth_session`. Ela é o limite compartilhado
  de com que frequência a pergunta chega à Pollar; nada é preenchido retroativamente.
- **O tráfego de polling agora chega à Pollar.** Reserve orçamento para uma
  requisição ao provedor por login em andamento a cada dois segundos, na publishable
  key daquela rede.

### Logins da Pollar agora provisionam uma carteira nas duas redes

`POST /v1/pollar/oauth/token` ganhou um array `network_wallets` — uma entrada por
rede Stellar, cada uma `ready`, `pending` ou `failed`. É aditivo, então nada quebra,
mas há duas notas operacionais:

- **Rode a migration.** `20260905120000_pollar_user_wallet` adiciona
  `pollar_user_wallet` e o enum `PollarWalletStatus`. Sem ela, todo resgate registra
  um provisionamento com falha e a carteira de contraparte fica sem registro — o
  login em si continua funcionando.
- **Defina as chaves das duas redes.** `POLLAR_*_MAINNET` e `POLLAR_*_TESTNET` são
  opcionais individualmente, e uma rede sem chaves agora aparece como uma carteira
  `pending` em todo login, em vez de simplesmente não aparecer. Configure o segundo
  par e o sweeper esvazia o backlog no próximo ciclo; deixe-o sem definir de
  propósito e as linhas ficam `pending` até que o orçamento de dez tentativas as
  aposente. Em nenhum dos casos um login falha.

Reserve orçamento para o XLM: um login agora financia uma reserva nas *duas* redes,
então o gasto em mainnet por novo usuário não muda, mas surge um gasto em testnet
onde antes não havia nenhum.

### `429` agora informa `rate_limited`

Um `429` puro costumava cair em `code: "provider_unavailable"`, o que dizia que um
serviço upstream estava com problemas quando, na verdade, este serviço tinha recusado
a requisição por conta própria — mandando integradores investigar algo que estava
perfeitamente saudável. Agora ele informa `code: "rate_limited"`, e
`ApiErrorCode.RateLimited` faz parte do enum publicado. Use-o como critério se você
faz retry em caso de throttling.


### Formatos de resposta que mudaram

Três formatos publicados mudaram na versão de audit-hardening. Os três estão sob
`/v1`; não existe `/v2`, então os integradores precisam ser avisados antes do deploy.

| Endpoint | Antes | Agora | Por quê |
| -------- | ----- | ----- | ------- |
| `GET /v1/webhooks` | array puro, cortado silenciosamente em 100 | `{ data, total, take, skip }` | Um consumer com 120 endpoints recebia 100 sem nenhum aviso, e sem `total` para paginar |
| `GET /v1/products` | array puro, a tabela inteira | `{ data, total, take, skip }` | Leitura sem limite |
| `GET /v1/webhooks/:id/deliveries` e a resposta de reentrega | incluíam `payload` | `payload` removido | Um corpo `RECEIVER_UPDATED` é um dossiê de KYC completo, e essas rotas são protegidas por `webhooks:read`, não por `kyc:read` |

Quem faz `for (const x of res)` ou lê `delivery.payload` quebra no deploy. A
migração é mecânica: leia `res.data` e busque os detalhes de KYC nos endpoints de KYC
com uma chave que tenha `kyc:read`.

Os **corpos de webhook** `RECEIVER_UPDATED` / `PAYIN_*` / `PAYOUT_*` também foram
reduzidos a identidade e estado — veja a seção Webhooks.

### A migration de audit-hardening

Ela é distribuída como dois arquivos que precisam ser aplicados em ordem:

- `20260901120000_audit_hardening` — o trabalho de corretude: uma nova coluna, um
  `DELETE` de deduplicação em `liquidity_pool_operation`, dois índices `UNIQUE`, duas
  tabelas novas. O DELETE e o índice único que ele alimenta rodam dentro de uma
  transação explícita sob um lock `SHARE ROW EXCLUSIVE`, para que um rolling deploy
  não consiga inserir uma duplicata entre os dois. As escritas nessa única tabela
  ficam bloqueadas pelos poucos milissegundos que isso dura.
- `20260901120100_audit_hardening_indexes` — nove índices aditivos, criados
  `CONCURRENTLY` para que o deploy **não** bloqueie escritas em `payment_intent`,
  `swap`, `webhook_delivery` ou `request_log`. Não é necessária janela de manutenção.

A divisão não é estilística: o PostgreSQL recusa `CREATE INDEX CONCURRENTLY` dentro
de um bloco de transação, e o primeiro arquivo precisa de um. Os dois são verificados
na CI contra um PostgreSQL real, que também garante que nenhum índice ficou `INVALID`
e que as migrations ainda correspondem ao `schema.prisma`.

Se o segundo arquivo falhar no meio, um build `CONCURRENTLY` deixa um índice
**inválido** em vez de falhar de forma limpa, e `IF NOT EXISTS` o considera presente.
Remova-o e rode de novo:

```sql
SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE NOT i.indisvalid;
```

### `ADMIN_API_CREDENTIALS` foi removida — `/v1/admin` é do console da plataforma

**Apague a variável.** Ela não é mais lida, e as correspondentes
`COSMOS_ADMIN_API_SECRET` / `COSMOS_ADMIN_API_SECRET_READ` na plataforma de
desenvolvedores vão junto.

Era uma segunda credencial que decidia, neste serviço, quem é admin da plataforma — e
a plataforma de desenvolvedores já tinha decidido isso com base no papel da conta
autenticada. Duas respostas para uma mesma pergunta, e todo deploy que configurou o
gateway mas pulou este segredo recebia a divergência na sua forma mais confusa: um
owner podia mudar o plano e o papel de outra conta no console, que nunca pede este
segredo, e ainda assim toda leitura cross-tenant respondia `401
admin_credentials_required`. Nada nesse erro aponta para um segredo de deploy ausente
em vez de para as permissões da própria conta.

Então a pergunta que o guard faz mudou de "quem chama tem o segredo de admin?" para
"esta chamada veio do console da plataforma?", o que é resolvido por dois fatos que já
estão na requisição:

1. `X-Gateway-Secret` corresponde a `APISIX_GATEWAY_SECRET` — verificado pelo
   `ApisixGuard`, como em todas as outras rotas. Só o gateway e o backend do console o
   têm.
2. `X-Cosmos-Internal` está presente. O APISIX o remove de toda requisição que passa
   pelo seu proxy (`proxy-rewrite.headers.remove`), então quem chama com uma API key
   não consegue enviá-lo; só uma chamada direta de um backend que detém o segredo do
   gateway consegue.

Vale dizer claramente qual é a troca: o fato 2 depende de uma configuração de
roteamento do gateway que fica no repositório da plataforma de desenvolvedores, e não
de um segredo que este serviço guarda. Duas coisas compensam isso. O console agora é o
único lugar que responde "quem é admin da plataforma", então as duas respostas não
podem divergir; e a atribuição ficou mais precisa, e não mais fraca — uma linha de
auditoria costumava nomear uma credencial compartilhada (`owner`, `viewer`), e agora
nomeia a conta do console que agiu (`cosmos_<userId>`) mais o papel na plataforma que
ela declarou, em toda mutação **e** em toda leitura.

O que isso muda para quem chama:

| Antes | Agora |
| ----- | ----- |
| `401` `admin_credentials_required` sem um segredo Bearer | `403` `admin_console_only` para tudo o que não for uma chamada do console |
| `403` `admin_role_required` para uma credencial `read` em uma mutação | não existe mais — o console já decidiu que a conta pode agir |
| `actorId` / `actorRole` em uma linha de auditoria nomeavam a credencial | eles nomeiam a conta do console e o seu papel na plataforma |

Se você acessa `/v1/admin` diretamente (um script de operações, por exemplo), envie
`X-Gateway-Secret`, `X-Consumer-Username` e `X-Cosmos-Internal: 1`; adicione
`X-Cosmos-Admin-Role: owner` para que a linha de auditoria seja rotulada. Mantenha o
serviço fora da internet pública — sem o segredo de admin, o isolamento de rede e o
segredo do gateway são o que fica diante dos dados cross-tenant.

### `APISIX_GATEWAY_SECRET` agora exige 32 caracteres

O serviço se recusa a iniciar abaixo disso. Antes ele aceitava um único caractere, e
agora ele é o *único* segredo entre o mundo externo e a superfície de admin da
plataforma (veja acima), então carrega mais peso do que antes. Gere um com
`openssl rand -hex 32` e rotacione-o no APISIX ao mesmo tempo.

### Funcionalidades de `v0.1.0`–`v0.1.5` que esta versão substitui

`main` e este branch resolveram vários dos mesmos problemas de forma independente
enquanto estavam separados. Onde os dois tinham uma resposta, o design deste branch é
o que vai para produção, então um deploy vindo da `v0.1.5` perde o que está abaixo.
Nada disso é acidental — cada item é uma resolução deliberada —, mas todos são
visíveis para um integrador, então planeje a atualização levando-os em conta.

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
`RETRYING`, `SWAP_EXPIRED`, `LIQUIDITY_EXPIRED`) continuam todos declarados em
`schema.prisma` e presentes depois de `migrate deploy`. Eles simplesmente nunca são
gravados. Remover colunas em uso — e um valor de enum, que o PostgreSQL não consegue
remover sem recriar o tipo — seria uma migration destrutiva comprada por nada, e
mantê-los declarados é o que permite que `prisma migrate diff` continue limpo.

## Variáveis de ambiente

Toda variável lida de `process.env` em `src/` é validada no boot por
`src/config/env.validation.ts` (fail-fast). Copie `.env.example` e ajuste pelo menos
`DATABASE_URL` e `APISIX_GATEWAY_SECRET`.

| Variável | Obrigatória | Padrão | Efeito |
| -------- | ----------- | ------ | ------ |
| `NODE_ENV` | não | `development` | Deve ser `development`, `test` ou `production`. **Defina `production` em produção** — a verificação fail-closed da taxa do plano e a documentação desligada por padrão dependem disso |
| `PORT` | não | `3000` | Porta HTTP de escuta |
| `DATABASE_URL` | **sim** | — | Conexão PostgreSQL para o Prisma |
| `APISIX_GATEWAY_SECRET` | **sim** | — | Segredo compartilhado que prova que a requisição veio pelo APISIX. **Mínimo de 32 caracteres** — esta é a fronteira inteira entre "chegou pelo gateway" e "qualquer um que alcance o pod" |
| `APISIX_GATEWAY_SECRET_HEADER` | não | `x-gateway-secret` | Nome do header do segredo do gateway |
| `APISIX_CONSUMER_HEADER` | não | `x-consumer-username` | Username do consumer autenticado |
| `APISIX_CREDENTIAL_HEADER` | não | `x-credential-identifier` | Id da credencial vindo do key-auth |
| `APISIX_ENVIRONMENT_HEADER` | não | `x-consumer-env` | Ambiente da chave (`dev` / `prod`) |
| `APISIX_ROLE_HEADER` | não | `x-consumer-role` | Papel do consumer encaminhado pelo gateway |
| `APISIX_PERMISSIONS_HEADER` | não | `x-consumer-permissions` | Lista de permissões encaminhada pelo gateway |
| `APISIX_ORGANIZATION_HEADER` | não | `x-consumer-org` | Id da organização |
| `APISIX_PLAN_HEADER` | não | `x-consumer-plan` | Plano da organização |
| `APISIX_SWAP_FEE_BPS_HEADER` | não | `x-plan-swap-fee-bps` | Taxa de swap do plano (bps) |
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
| `BLINDPAY_API_KEY` | não | — | API key da plataforma no BlindPay |
| `BLINDPAY_INSTANCE_ID` | quando a API key estiver definida | — | Id da instância BlindPay (`in_...`) |
| `BLINDPAY_BASE_URL` | não | `https://api.blindpay.com/v1` | URL base da API do BlindPay |
| `BLINDPAY_WEBHOOK_SECRET` | quando a API key estiver definida | — | Segredo Svix para os webhooks de entrada do BlindPay |
| `BLINDPAY_TIMEOUT_MS` | não | `15000` | Timeout do client HTTP do BlindPay (ms) |
| `KYC_REDIRECT_URL_WHITELIST` | não | — | Allow-list por consumer de hosts de redirecionamento do KYC |
| `RATE_LIMIT_ENABLED` | não | `true` | Limites por endereço nas rotas que gastam XLM. Chave de incidente |
| `RATE_LIMIT_PRUNE_INTERVAL_MS` | não | `600000` | Intervalo de limpeza das janelas do contador (ms, mín. 1000) |
| `POLLAR_PUBLISHABLE_KEY_TESTNET` / `_MAINNET` | não | — | Publishable key da Pollar (`pub_<network>_…`), para a bridge OAuth |
| `POLLAR_SECRET_KEY_TESTNET` / `_MAINNET` | junto com a publishable key | — | Chave secreta da Pollar (`sec_<network>_…`), para as rotas de operador |
| `POLLAR_BRIDGE_CALLBACK_URL` | quando uma chave da Pollar estiver definida | — | URL pública para a qual a Pollar devolve o navegador. Precisa ser `<gateway>/v1/pollar/oauth/callback` **e** um host registrado em Build → Domains na Pollar |
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

O `key-auth` encaminha `X-Consumer-Username` / `X-Credential-Identifier` ao upstream
depois de uma autenticação bem-sucedida, sobrescrevendo qualquer cópia enviada pelo
cliente, e o guard depende disso.

> **A lista de remoção é estrutural, e é a única parte deste modelo de segurança que
> não pode ser verificada de dentro deste repositório.** Todo header no bloco acima é
> uma entrada de autorização que o serviço aceita pelo valor declarado;
> `X-Gateway-Secret` prova apenas que a requisição passou por *um* gateway, não que os
> valores são honestos. Trate essa lista como configuração de produção, com o mesmo
> rigor de revisão do código: audite-a sempre que uma rota for adicionada ou copiada,
> e mantenha o serviço em uma rede privada para que o único caminho acessível seja
> pelo APISIX. O segredo compartilhado é a segunda camada, não a única.
>
> O serviço agora é fail-closed na única entrada em que o silêncio costumava ser
> lucrativo: a ausência de `X-Plan-Swap-Fee-Bps` em uma configuração de produção
> resulta em 503, em vez de um fallback silencioso para o padrão do ambiente.
>
> `X-Cosmos-Internal` carrega mais peso do que antes: com `ADMIN_API_CREDENTIALS`
> removida, é ele que diz a este serviço que uma requisição veio do console da
> plataforma, e não de uma API key, e portanto é ele que abre `/v1/admin`. Ele continua
> acessível apenas a quem já apresentou o segredo do gateway, então a exposição é
> limitada por isso e pelo isolamento de rede — mas uma rota que esqueça de removê-lo
> transforma toda API key em admin da plataforma.

> Mantenha o serviço em uma rede privada para que o único caminho acessível seja pelo
> APISIX; o segredo compartilhado é a segunda camada, não a única.

## Mantendo este documento fiel

**O README faz parte da mudança, não é um trabalho posterior.** Nada na CI detecta a
sua defasagem — o build continua verde enquanto estas páginas descrevem, em silêncio,
um serviço que não existe mais —, então ele é atualizado no mesmo commit que o código
que descreve. A convenção completa, incluindo qual seção cada tipo de mudança afeta,
está em [`CLAUDE.md`](../../CLAUDE.md); a versão curta:

| Quando você… | Atualize |
| ------------ | -------- |
| adiciona ou remove um módulo em `src/` | [Estrutura do projeto](#estrutura-do-projeto) |
| adiciona, renomeia ou apaga uma leitura de `process.env` | [Variáveis de ambiente](#variáveis-de-ambiente) **e** `.env.example` |
| integra um provedor, ou muda como um deles se comporta | a seção `##` do próprio provedor |
| muda o formato de uma resposta publicada, um status code ou um escopo | [Atualização](#atualização--mudanças-incompatíveis-e-notas-de-deploy) |
| adiciona, renomeia, remove ou muda o escopo de uma rota | [Índice de rotas](#índice-de-rotas), e a seção do próprio módulo |
| aprende algo que um operador ou integrador não pode deixar passar | a seção a que isso pertence |

**Este documento existe em sete idiomas** — English, Español, Português, Deutsch,
Français, हिन्दी e 简体中文 — e uma mudança em um deles é uma mudança em todos os sete,
no mesmo commit. O inglês é a fonte, e os outros — em [`docs/i18n/`](./) — são traduções dele: os mesmos
títulos, tabelas e blocos de código, com os identificadores (rotas, variáveis de
ambiente, headers, códigos de erro) mantidos exatamente como estão.
`npm run readme:check` quebra a CI quando falta o arquivo de algum idioma, quando os
seus títulos deixam de corresponder aos do inglês ou quando uma rota do contrato
OpenAPI falta no seu índice de rotas.

Duas coisas deliberadamente **não** ficam aqui: **schemas de requisição e resposta**,
que pertencem ao contrato OpenAPI gerado (`npm run openapi:check` o mantém fiel), e
**qualquer coisa que o código já diga** — este documento serve para explicar *por que*
algo é como é e como operá-lo, porque uma segunda cópia do *que* ele faz é só mais uma
cópia para manter verdadeira.
