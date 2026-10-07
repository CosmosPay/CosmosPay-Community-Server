# Cosmos Pay — Microsserviço de Pagamentos

[English](../../README.md) · [Español](./README.es.md) · **Português** · [Deutsch](./README.de.md) · [Français](./README.fr.md) · [हिन्दी](./README.hi.md) · [简体中文](./README.zh.md)

Microsserviço de pagamentos construído com **NestJS 12** + **Prisma 7 (PostgreSQL)**.

É uma aplicação *separada* da plataforma de desenvolvedores Cosmos (`paydev`). A
plataforma de desenvolvedores é um painel: **emite** API keys para desenvolvedores e
**mostra** os dados deles. Ela não está no caminho de nenhuma requisição que um
cliente faz — toda chamada vai cliente → APISIX → este serviço, então a plataforma
pode cair sem que uma wallet ou uma integração perceba (veja
[Nenhuma requisição depende da plataforma de desenvolvedores](#nenhuma-requisição-depende-da-plataforma-de-desenvolvedores)).
Este serviço fica **atrás do APISIX**, que faz o balanceamento de carga e autentica
cada requisição antes de encaminhá-la para cá. Ele nunca vê API keys em texto puro —
confia apenas no que o gateway encaminha.

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

`/v1/admin` é cross-tenant, então o `AdminGuard` também exige que
`X-Cosmos-Internal` traga um MAC recente assinado com o segredo do gateway
(`src/admin/console-marker.ts`). Quem chama com uma API key nunca tem esse segredo,
então só um backend que chama o serviço diretamente consegue gerá-lo — a plataforma de
desenvolvedores, que decide se a conta autenticada é owner ou admin. Não há uma
credencial de admin separada. O APISIX também remove o header de tudo o que passa pelo
seu proxy, mas isso é defesa em profundidade: uma rota que esqueça de removê-lo
encaminha um valor que nenhum cliente conseguiria forjar.

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
| Intenções de pagamento | `/v1/payment-intents`    | Intenções `pay` em Stellar (SEP-7), Solana (Solana Pay) e Monad (EIP-681), `tx` SEP-7, validação, observador on-chain |
| Swaps             | `/v1/swaps`              | Cotação de path payment, montagem do XDR não assinado, envio do assinado · Solana via Jupiter, Monad via Kuru Flow |
| Swaps entre redes | `/v1/cross-chain-swaps` | Stellar ⇄ Solana ⇄ Monad pela NEAR Intents: cotação, endereço de depósito, status |
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
| Chave pública     | `/v1/public-key`         | A API key pública compartilhada, servida sem chave (`@Public`) |
| Analytics         | `/v1/summary`, `/v1/balances`, `/v1/logs` | Agregados e logs do dashboard           |
| Atividade         | `/v1/activity`           | Eventos reportados pelo cliente: ingestão, feed, consolidação |
| Plugins           | `/v1/plugins`            | Extensões compiladas sob um slug, instaladas por tenant |
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
| GET | `/v1/admin/chain-swaps` | console da plataforma |  |
| GET | `/v1/admin/consumers` | console da plataforma |  |
| GET | `/v1/admin/cross-chain-swaps` | console da plataforma |  |
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
| POST | `/v1/aliases/{name}/recovery` | `payments:write` | ✓ |
| POST | `/v1/aliases/{name}/recovery/complete` | `payments:write` |  |
| GET | `/v1/assets` | — | ✓ |
| GET | `/v1/balances` | `payments:read` |  |
| POST | `/v1/blindpay/webhooks` | nenhum — `@Public()`, assinatura Svix |  |
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
| GET | `/v1/defindex/vaults` | um de `liquidity:read`, `swaps:read` | ✓ |
| GET | `/v1/defindex/vaults/{vault}` | um de `liquidity:read`, `swaps:read` | ✓ |
| GET | `/v1/defindex/vaults/{vault}/balance` | um de `liquidity:read`, `swaps:read` | ✓ |
| POST | `/v1/defindex/vaults/{vault}/deposit` | um de `liquidity:write`, `swaps:write` | ✓ |
| POST | `/v1/defindex/vaults/{vault}/withdraw` | um de `liquidity:write`, `swaps:write` | ✓ |
| POST | `/v1/defindex/submit` | um de `liquidity:write`, `swaps:write` | ✓ |
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
| GET | `/v1/sep30/shares` | none — `@Public()`; SEP-10/SEP-30, recovery servers only |  |
| PUT | `/v1/sep30/shares/{address}` | none — `@Public()`; SEP-10/SEP-30, recovery servers only |  |
| GET | `/v1/sep30/shares/{address}` | none — `@Public()`; SEP-10/SEP-30, recovery servers only |  |
| DELETE | `/v1/sep30/shares/{address}` | none — `@Public()`; SEP-10/SEP-30, recovery servers only |  |
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
| `admin_console_only` | 403 | A rota pertence ao console da plataforma (`/v1/admin`). Nenhuma API key pode chamá-la |
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
| `PaymentIntentObserverService`       | `PaymentIntentObserver`  |
| `RequestLogRetentionService`   | `RequestLogRetention`    |
| Sweeper de entregas de webhook | `WebhookDeliverySweeper` |
| `RateLimitPruneService`        | `RateLimitPrune`         |
| `AliasChallengeSweeperService` | `AliasChallengeSweeper`  |

`pg_try_advisory_xact_lock` nunca bloqueia e é liberado quando a transação termina,
mesmo em um crash ou em uma conexão perdida. Ao contrário de um lock em nível de
sessão, ele também funciona atrás do PgBouncer em modo transaction pooling.

Os ids de lock ficam no enum `AdvisoryLockKey`. Não renumere um id existente —
durante um rolling deploy, réplicas antigas e novas obteriam locks diferentes — e não
reutilize um id aposentado.

**Várias instâncias a partir do mesmo checkout, localmente.** `npm run dev:local` inicia a
api e uma segunda réplica a partir de um único `.env`; `npm run dev:local -- recovery` inicia
a api e os dois servidores de recuperação (A em `:3002`, B em `:3003`, testnet), e `-- all`
as quatro. Só o que muda por instância fica em `dev-instances.json` (ignorado pelo git; a
primeira execução o cria a partir de `dev-instances.example.json` e gera uma única vez as
chaves de cada servidor de recuperação — guarde-o, essas chaves derivam signatários que
estão no ledger): uma chave ali substitui a do `.env`, `""` a remove, e um objeto aninhado é
um prefixo (`{ "RECOVERY": { "ROLE": "a" } }` é `RECOVERY_ROLE=a`). Um único build em modo
watch compila em `dist-local/`, então nunca disputa `dist/` com `npm run dev` — mas também
inicia a api, então use um ou outro. As réplicas compartilham `DATABASE_URL` e segredos:
nada é estado por processo. Liste ambas no upstream do APISIX (`COSMOS_API_URL` do developer
platform, separadas por vírgula, e depois `npm run sync:route` lá).

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
- **Automático (observer permanente):** `PaymentIntentObserverService` consulta o Horizon
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

O tráfego do dashboard (marcador `X-Cosmos-Internal` verificado) é **registrado e marcado**
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
`LIQUIDITY_FAILED`, `CROSS_CHAIN_SWAP_CREATED`, `CROSS_CHAIN_SWAP_UPDATED`, `CROSS_CHAIN_SWAP_SUCCEEDED`, `CROSS_CHAIN_SWAP_REFUNDED`, `CROSS_CHAIN_SWAP_FAILED`, `CROSS_CHAIN_SWAP_EXPIRED`, além dos originados no BlindPay `RECEIVER_UPDATED`,
`PAYIN_CREATED`, `PAYIN_UPDATED`, `PAYIN_COMPLETED`, `PAYOUT_CREATED`,
`PAYOUT_UPDATED` e `PAYOUT_COMPLETED`. A lista oficial é o enum `WebhookEventType`
em `prisma/schema.prisma`.

**Corpos originados no BlindPay.** `RECEIVER_UPDATED` / `PAYIN_*` / `PAYOUT_*`
trazem apenas identidade e estado — ids, status, valores, rails — nunca dados
pessoais. O objeto do provedor não é encaminhado, porque o payload de um receiver é
um dossiê de KYC completo e se inscrever exige apenas `webhooks:write`. Busque os
detalhes na API com uma chave que tenha `kyc:read` / `onramp:read` / `offramp:read`.
A allowlist de campos está em `src/native-plugins/blindpay/blindpay-event-redaction.ts`.

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

### Intenções de pagamento em Solana e Monad

`POST /v1/payment-intents/pay` aceita um `chain` opcional: `stellar` (o padrão),
`solana` ou `monad`. Uma requisição sem ele é exatamente a requisição Stellar acima.
O nível de rede continua sendo o da chave de API — uma chave `prod` chega à Solana
mainnet-beta e à Monad mainnet (chain id 143), uma `dev` à Solana devnet e à Monad
testnet (10143) — e `network` é gravado como `public` / `testnet` em todas as
chains. `POST /v1/payment-intents/tx` continua só Stellar: um `tx` SEP-7 é um
envelope da Stellar.

| | Stellar | Solana | Monad |
| --- | --- | --- | --- |
| Link (`uri`) | SEP-7 `web+stellar:pay` | Solana Pay `solana:<recipient>?…` | EIP-681 `ethereum:<payee>@143?…` |
| Moeda (sem `assetCode`) | XLM | SOL | MON |
| Token (`assetCode` + `assetIssuer`) | conta emissora | mint SPL | contrato ERC-20 |
| Como o pagamento é encontrado | `MEMO_ID` | uma chave `reference` nova por intenção (`chainReference`) | o endereço de depósito próprio da intenção (com relayer); senão, destino + valor exato |
| Observador | pagamentos ao destino | as assinaturas da chave de referência | o saldo do endereço de depósito, MON nativo incluído (com relayer); senão, os logs `Transfer` do token |
| `amount` | opcional | opcional | opcional com relayer, obrigatório sem ele |
| `msg` / `callback` | ambos | `msg` (`message` do Solana Pay) | nenhum |
| `txHash` para `validate` / `PATCH` | 64 hex | assinatura base58 | `0x` + 64 hex |

- **O memo continua sendo a chave de idempotência**, e `chain` é um dos termos que
  uma repetição precisa igualar: o memo `42` na Stellar e o memo `42` na Solana são
  pagamentos diferentes (`409 idempotency_conflict`). Na Solana o memo também é
  gravado on-chain pelo programa SPL Memo.
- **Um token é resolvido contra a chain antes de a intenção ser gravada**: as
  casas decimais de um mint SPL (programa Token ou Token-2022), o `decimals()` de um
  ERC-20. Um endereço que não é um token dá `400 validation_failed`; um valor com
  mais casas decimais do que o token tem, `400 invalid_amount`.
- **Um pagamento na Monad não leva memo.** O EIP-681 não tem campo que uma wallet
  preencha com o id da intenção, então uma intenção na Monad é reconhecida pelo que
  paga: destino, token e valor exato, no bloco de criação ou depois. Dê **valores
  distintos** a intenções simultâneas para um mesmo destino. Um pagamento em **MON
  nativo** não emite log, então o observador não consegue encontrá-lo: liquide-o com
  `POST /v1/payment-intents/{id}/validate` e o hash da transação. Pagamentos ERC-20
  são encontrados pelo observador, `MONAD_LOG_BLOCK_RANGE` blocos por chamada e
  cinco chamadas por intenção por ciclo, retomando de onde parou (`chainCursor`).
- **Endereços de depósito (com `MONAD_RELAYER_PRIVATE_KEY`).** Cada intenção na
  Monad recebe seu próprio endereço, e o link paga para ele em vez do comerciante:
  um endereço `CREATE2` de `contracts/PaymentForwarder.sol` pelo proxy de deploy
  determinístico (`0x4e59…956c`, presente na Monad mainnet e testnet), cujo código
  de inicialização fixa o comerciante, o ativo, o relayer e a taxa dele. O endereço
  é o compromisso — ninguém, este serviço incluído, consegue fazer deploy ali de um
  código que pague a outro —, então o serviço não tem nenhuma chave do dinheiro. O
  encaminhador de depósitos observa o saldo do endereço (MON nativo incluído, sem
  precisar de logs); quando cobre a intenção (qualquer valor acima da taxa, se for
  aberta), o relayer faz o deploy do encaminhador, cujo construtor paga ao relayer
  a taxa e o restante ao comerciante, e a intenção é liquidada com essa transação.
  A taxa é fixada na criação da intenção e mostrada como `networkFee`: para MON, o
  orçamento de gas do encaminhamento ao preço atual mais 25%; para um token, a
  entrada de `MONAD_DEPOSIT_TOKEN_FEES` do operador, ou nada (o relayer absorve o
  gas). Um valor que a taxa consumiria dá `400 invalid_amount`. O que chega depois
  que uma intenção expira ou é cancelada ainda é encaminhado ao comerciante, e o
  pagador pode liquidar antes com `validate` e o próprio hash. A chave do relayer
  guarda só dinheiro para gas: abasteça-a com moderação e crie alertas de saldo. O
  bytecode está commitado (`src/evm/payment-forwarder.artifact.ts`) e um spec
  recompila o código-fonte para compará-lo; todo endereço de depósito depende dele,
  então nunca o altere enquanto endereços antigos ainda puderem receber dinheiro.
- **Um nó RPC é verificado antes de ser confiável**: antes da primeira leitura de
  um nível, o serviço compara o genesis hash do nó (Solana) ou seu `eth_chainId`
  (Monad) com o da chain, e responde `503 misconfigured` quando uma URL de mainnet
  aponta para uma rede de testes. Os RPCs públicos são o padrão e têm limites de
  taxa rígidos: em produção configure `SOLANA_RPC_URL_MAINNET` e
  `MONAD_RPC_URL_MAINNET` com os endpoints de um provedor.
- **Swaps, pools de liquidez e DeFindex continuam só Stellar.**

```jsonc
// POST /v1/payment-intents/pay — USDC na Solana
{ "chain": "solana", "destination": "<base58>", "amount": "25.5",
  "assetCode": "USDC", "assetIssuer": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }
// response → { chain: "solana", uri: "solana:<base58>?amount=25.5&spl-token=…&reference=…&memo=…", chainReference, qr, … }
```

### Login da wallet em Solana e Monad

`POST /v1/wallet/auth/finish` e `PUT /v1/wallet/backup` aceitam um `chain` opcional e
a conta como `address`; `stellarAddress` continua aceito para a Stellar, e continua
sendo devolvido ao lado de `chain` e `address`. O desafio que uma conta Solana ou
Monad assina tem uma linha `chain: <chain>` depois da primeira — uma mesma chave
ed25519 é endereço Stellar e Solana, e a linha impede que uma assinatura para uma
abra a outra — enquanto os desafios da Stellar não mudam um byte. A Solana assina os
bytes UTF-8 com ed25519 (`signMessage`; base64 ou base58); a Monad com
`personal_sign` do EIP-191 (hex com 0x; assinaturas high-s são recusadas). Um
endereço Monad é gravado em sua grafia EIP-55. A configuração de recuperação
(`POST /v1/wallet/recovery/setup`) continua só Stellar. As chaves da
conta são emitidas do mesmo jeito em todas as chains (veja
[Nenhuma requisição depende da plataforma de desenvolvedores](#nenhuma-requisição-depende-da-plataforma-de-desenvolvedores)).

## A API key pública compartilhada

A carteira open source distribui uma API key que todo mundo compartilha, para que
qualquer pessoa possa fazer swap, adicionar liquidez ou criar um link de pagamento
sem se cadastrar. Essas chamadas pagam a comissão do plano `community` (50 bps, a
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
| `GET /v1/cross-chain-swaps/assets` \| `POST /v1/cross-chain-swaps/quote` | A lista de tokens da NEAR Intents e uma cotação a seco; funções puras da requisição |
| `POST /v1/cross-chain-swaps` | Um endereço de depósito para os fundos de quem chama; um `Idempotency-Key` repetido só é respondido se a requisição coincidir |
| `POST /v1/cross-chain-swaps/:id/deposit` | Aponta à NEAR Intents uma transação que ela mesma verifica on-chain; com limite de taxa |
| `POST /v1/liquidity-pools/deposit` \| `withdraw` | Montam envelopes não assinados |
| `POST /v1/liquidity-pools/operations/:id/submit` | Transmite um envelope assinado por quem chama, sob as mesmas verificações do submit de swaps; com limite de taxa |
| `GET /v1/liquidity-pools` \| `/:poolId` \| `/positions` | Dados públicos on-chain lidos do Horizon |
| `POST /v1/payment-intents/tx` \| `pay` | Montam um intent SEP-7 a partir da requisição |
| `POST /v1/activity/events` | Ingestão de telemetria — veja abaixo |
| `GET /v1/assets` | O catálogo público de ativos |
| `GET /v1/aliases/resolve/:name` \| `availability/:name` \| `by-address/:address` | Um pagador resolvendo um handle é justamente o chamador anônimo para o qual esta chave existe; a resposta é uma função pura da requisição e nunca inclui a caixa de e-mail do dono |

Recusadas: `GET /v1/swaps`, `GET /v1/swaps/:id`, `GET /v1/cross-chain-swaps`, `GET /v1/cross-chain-swaps/:id`,
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

**De onde uma wallet a obtém.** `GET /v1/public-key?env=dev|prod` responde
`{ env, apiKey }` sem chave e sem segredo do gateway (`@Public()`), a partir de
`PUBLIC_API_KEY_DEV` / `PUBLIC_API_KEY_PROD`; um ambiente sem chave responde
`503 misconfigured`. Rotacionar a chave é mudar essas variáveis — toda wallet pega a
nova dentro dos 5 minutos de cache. A rota do APISIX para este path NÃO deve rodar
`key-auth` (quem chama ainda não tem chave): sirva-a pela rota sem chave, como
`/v1/wallet/auth/oauth/callback/*`.

## Nenhuma requisição depende da plataforma de desenvolvedores

A plataforma de desenvolvedores cria API keys para desenvolvedores e mostra dados.
Nada do que um cliente faz passa por ela: a wallet e toda integração falam com o
APISIX, e o APISIX com este serviço. Antes não era assim, e a plataforma — a peça
que mais cai — levava junto todo login:

| Antes passava pela plataforma | Agora |
| --- | --- |
| Enviar o código de login da wallet | Este serviço envia (`MAIL_FROM` + `MAIL_RESEND_API_KEY` / `MAIL_SMTP_*`) |
| Emitir as API keys de uma conta de wallet ao fim do login | Este serviço as emite no APISIX (`APISIX_ADMIN_URL`, `APISIX_ADMIN_KEY`) |
| O código por email de um servidor de recuperação | Cada servidor de recuperação envia o seu (`RECOVERY_EMAIL_CODES=true` + seu próprio `MAIL_*`) |
| A chave pública compartilhada (`/api/public-key`) | `GET /v1/public-key` |
| O catálogo de ativos e a telemetria anônima (`/api/assets`, `/api/telemetry`) | A wallet chama `GET /v1/assets` e `POST /v1/activity/events` com a chave pública |

O que a plataforma continua fazendo é dela: as chaves dos desenvolvedores, o painel,
e `/v1/admin`, que ela chama — nunca o contrário. Se ela estiver fora, ninguém cria
uma chave de desenvolvedor nem abre o painel; as wallets fazem login, pagam e fazem
swaps normalmente.

**Chaves de wallet.** Um login concluído recebe uma chave `dev` e uma `prod` sob o
consumer `cosmos_wallet_<accountId>`, com os scopes, labels e o forwarder de consumer
que a plataforma gerava (plano `community`, comissão de swap
`WALLET_KEY_SWAP_FEE_BPS`, 50 bps por padrão). Um segundo login devolve as chaves
que a conta já tem em vez de emitir outro par. `organizationId` na resposta é o id
da conta.

**A admin key é o custo de segurança.** O APISIX não tem permissão mais estreita que
a admin key, que pode reescrever todas as rotas. O cliente daqui só escreve consumers
sob `cosmos_wallet_` e recusa qualquer outro nome antes de montar a requisição, mas
essa é uma promessa deste código, não do APISIX: trate `APISIX_ADMIN_KEY` como
`APISIX_GATEWAY_SECRET`, dê aos pods deste serviço acesso de rede à admin API e a
nada mais dela, e nunca a defina num servidor de recuperação (o boot recusa).

**Contas que a plataforma provisionou antes desta mudança** continuam funcionando com
as chaves que têm. No próximo login recebem chaves novas sob
`cosmos_wallet_<accountId>`, um consumer novo, então o histórico gravado sob o
consumer anterior (`cosmos_<platformUserId>`) não aparece com a chave nova.

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
// rejected, outcome not on the ledger yet → { "submitted": false, "status": "SUBMITTED", "reason": "…", "resultCodes": ["tx_bad_seq"], "swap": { … } }
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

### Swaps na Solana e na Monad (Jupiter, Kuru Flow)

`/v1/swaps` aceita um `chain` opcional. Sem ele — ou com `stellar` — cada
requisição é respondida exatamente como antes. `solana` passa pelo
[Jupiter](https://jup.ag) e `monad` pelo [Kuru Flow](https://kuru.io):
agregadores que percorrem todas as fontes de liquidez da sua rede, então um swap
obtém a melhor taxa daquela rede em vez do preço de um único pool. O fluxo é o
da Stellar, não custodial de ponta a ponta:

```
POST /v1/swaps/quote {chain} → POST /v1/swaps {chain, source} → wallet signs `transaction`
  → POST /v1/swaps/{id}/submit {signedTransaction} → observer → SUCCEEDED / FAILED
```

- **Ativos:** o ticker nativo (`SOL`, `MON`), `native`, ou o endereço do mint
  SPL / ERC-20. Emissores, `memo` e um `destination` diferente são só da Stellar
  e são recusados nas outras redes: a saída vai para `source`.
- **`transaction`** é o que a carteira assina. Solana: uma VersionedTransaction
  não assinada (base64), válida cerca de um minuto, até o blockhash expirar.
  Monad: `{ to, data, value, chainId }`, assinado como transação EIP-1559, válido
  por dois minutos. Vender um ERC-20 na Monad com allowance insuficiente também
  devolve `approval`: a chamada `approve` exata a enviar e confirmar antes.
- **Submit** verifica que a transação assinada é a montada — os mesmos bytes de
  mensagem na Solana, a mesma chamada na Monad — e assinada por `source`, e a
  transmite pelo RPC próprio deste serviço. Um nó recusá-la é
  `400 transaction_rejected` e o swap fica `PENDING`; só o veredito da própria
  rede, lido pelo observador, o torna `SUCCEEDED` ou `FAILED`. Swaps não enviados
  ou não vistos passam a `EXPIRED`. Os webhooks são os mesmos eventos `SWAP_*`.
- **Comissão:** a taxa do plano, como na Stellar, mas o agregador a tira da
  **saída**. O Jupiter paga seu `platformFeeBps` na conta de tokens de
  `SOLANA_SWAP_FEE_WALLET` para o mint de saída, que precisa existir — se faltar,
  a resposta é `503 misconfigured` indicando a conta a criar. O Kuru Flow paga
  seu `referrerFeeBps` a `MONAD_SWAP_FEE_WALLET`.
- **Somente mainnet**; uma chave `dev` é `400 network_unsupported`.
  `GET /v1/swaps?chain=solana` lista aquela rede; os ids são únicos entre redes,
  então `GET /v1/swaps/{id}` e submit encontram qualquer swap.
- **Chaves.** O Kuru Flow sem `KURU_API_KEY` emite um token por endereço limitado
  a uma requisição por segundo — suficiente para testar, não para produção. O
  nível sem chave do Jupiter é o padrão; com `JUPITER_API_KEY`, aponte
  `JUPITER_BASE_URL` para `https://api.jup.ag/swap/v1`.

## Swaps entre redes (NEAR Intents)

Os swaps **entre** Stellar, Solana e Monad são liquidados pela
[NEAR Intents](https://intents.near.org/) através da sua API 1Click. Como os swaps
da Stellar acima, eles são **não custodiais**: quem paga envia a entrada para um
endereço de depósito que o 1Click deriva para aquela única cotação, e os solvers da
NEAR Intents pagam a saída ao destinatário na outra rede, ou reembolsam quem pagou.
Nenhuma das duas pernas passa pela Cosmos Pay.

```
quote → create (deposit address + wallet link + QR) → payer sends the deposit
      → POST /deposit (optional) → observer polls 1Click → SUCCEEDED / REFUNDED / FAILED + webhook
```

**Qual swap vai por onde.**

| Par | Liquidado por | Por quê |
| --- | --- | --- |
| Stellar → Stellar | `/v1/swaps` (DEX da Stellar) | O protocolo faz o swap nativamente; `/v1/cross-chain-swaps` responde `400` e aponta para lá |
| Stellar ⇄ Solana ⇄ Monad | NEAR Intents | É preciso uma ponte, e a NEAR Intents é essa ponte |
| Solana → Solana, Monad → Monad | `/v1/swaps` com `chain` (Jupiter, Kuru Flow) | Cada agregador percorre todas as fontes de liquidez da sua rede pela melhor taxa; `/v1/cross-chain-swaps` responde `400` e aponta para lá |

O que este serviço faz por conta própria, em cada rede: resolve os ativos contra a
lista de tokens do 1Click (`GET /v1/cross-chain-swaps/assets`), valida cada endereço
contra a sua própria rede, monta a solicitação de depósito no padrão de carteira
daquela rede — SEP-7 `pay`, Solana Pay, EIP-681 —, verifica no Horizon que um
destinatário da Stellar confia no ativo que vai receber, e espelha o status na sua
própria tabela.

**Comissão.** A taxa do plano da organização — o mesmo `X-Plan-Swap-Fee-Bps`
confiável dos swaps da Stellar, nunca um parâmetro da requisição — é enviada ao
1Click como uma entrada de `appFees` paga a `NEAR_INTENTS_FEE_RECIPIENT`, uma conta
NEAR. A NEAR Intents a desconta da entrada, a saída cotada já vem líquida dela, e ela
se acumula nessa conta dentro da NEAR Intents, de onde o operador a saca. Um plano
com taxa e sem destinatário configurado responde `503 misconfigured` em vez de fazer
o swap de graça.

**Configure `NEAR_INTENTS_API_KEY`.** O 1Click funciona sem chave de parceiro, mas
não pelo mesmo preço: sem ela (verificado em 2026-09-30) cada cotação leva uma taxa
própria do 1Click de 0,2 %, e metade da comissão pedida em `appFees` vai para o
1Click em vez de para `NEAR_INTENTS_FEE_RECIPIENT`.

**Somente mainnet.** A NEAR Intents não tem rede de testes. Uma chave `dev` pode
listar ativos e cotar — o preço é o da mainnet de qualquer forma —, mas
`POST /v1/cross-chain-swaps` responde `400 network_unsupported`: um endereço de
depósito receberia dinheiro real.

**Depósitos na Stellar levam memo.** O 1Click recebe todos os depósitos da Stellar
em uma única conta e os distingue pelo memo, então `depositMemo` é obrigatório ali e
o link SEP-7 o anexa como **`MEMO_TEXT`** — o tipo que os depósitos para essa conta
carregam. Um depósito sem ele, ou com um `MEMO_ID`, não é creditado ao swap.

**Status.** `AWAITING_DEPOSIT` → `DEPOSIT_DETECTED` / `INCOMPLETE_DEPOSIT` →
`PROCESSING` → `SUCCEEDED`, `REFUNDED` ou `FAILED`, que são finais. A palavra do
próprio 1Click fica em `providerStatus`. Um swap ainda esperando quando o prazo vence
(`CROSS_CHAIN_SWAP_DEADLINE_SECONDS`, 30 minutos por padrão) passa a `EXPIRED`; um
depósito que chega depois é reembolsado pela NEAR Intents, então um swap `EXPIRED`
continua sendo consultado por um dia e o acompanha até `REFUNDED`. O observador roda
junto com o observador de liquidação (`OBSERVER_ENABLED`, `OBSERVER_INTERVAL_MS`);
nenhuma carteira precisa voltar para que um swap seja liquidado. Cada mudança emite
`CROSS_CHAIN_SWAP_UPDATED`, `_EXPIRED`, `_SUCCEEDED`, `_REFUNDED` ou `_FAILED`; os três
últimos são duráveis e deduplicados como os das payment intents.

**Guarde `quoteSignature`.** É a assinatura do 1Click sobre a cotação e o seu
endereço de depósito — o que resolve uma disputa com a NEAR Intents. A cotação
assinada completa também é armazenada do lado do servidor.

**Limites.** Quote: 60 chamadas por minuto; create e deposit: 20 cada, por
consumidor e endereço de cliente (`429 rate_limited`).

### Rotas de swaps entre redes

| Rota | Scope | Finalidade |
| --- | --- | --- |
| `GET /v1/cross-chain-swaps/assets` | `swaps:read` | Os tokens que a NEAR Intents pode trocar na Stellar, Solana e Monad |
| `POST /v1/cross-chain-swaps/quote` | `swaps:read` | Uma cotação a seco: saída, mínimo, comissão; não persiste nada |
| `POST /v1/cross-chain-swaps` | `swaps:write` | Uma cotação ao vivo: endereço de depósito, memo, link de carteira e QR; aceita `Idempotency-Key` |
| `GET /v1/cross-chain-swaps` | `swaps:read` | Os swaps entre redes do consumidor |
| `GET /v1/cross-chain-swaps/{id}` | `swaps:read` | Um swap, como o observador o viu por último |
| `POST /v1/cross-chain-swaps/{id}/deposit` | `swaps:write` | Informar a transação de depósito para que a NEAR Intents comece sem esperar o seu indexador |
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

### A recuperação passa pelo e-mail, enviado por este serviço

Uma reivindicação registra um e-mail de recuperação para que perder uma chave não
signifique perder o nome. A recuperação funciona assim:

1. A wallet (qualquer chave com `payments:write`, inclusive a chave pública
   compartilhada) chama `POST /v1/aliases/:name/recovery {email}`. A resposta é
   sempre `{ accepted: true }`, coincidam ou não o identificador e a caixa de e-mail;
   se coincidirem, este serviço **envia por e-mail** um token de uso único (30
   minutos, armazenado só como SHA-256) para a caixa registrada. O token nunca aparece
   numa resposta.
2. O usuário obtém um desafio `RECOVER` para a nova chave e chama
   `POST /v1/aliases/:name/recovery/complete {token, address, network, nonce, signature}`
   com a sua própria API key. As duas provas são necessárias: o token prova a caixa de
   e-mail e a assinatura prova a chave.
3. A propriedade passa para o consumer que chama e **todos os endereços anteriores são
   removidos**, então quem tiver as chaves antigas deixa de receber pagamentos.

Iniciar uma recuperação é aberto a qualquer um porque o token só chega à caixa de
e-mail: tudo o que um estranho consegue é fazer o dono receber um e-mail. Isso é
limitado duas vezes — 5 inícios a cada 10 minutos por endereço (`429 rate_limited`), e
no máximo um e-mail por alias por minuto, peça quem pedir (uma repetição dentro desse
minuto responde igual e não envia nada). Um deploy sem remetente de e-mail responde
`503 misconfigured`. Um alias suspenso não pode ser recuperado.

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

### Endereços em Solana e Monad

Um alias pode apontar para contas Solana e Monad além das Stellar.
`POST /v1/aliases/challenges`, `POST /v1/aliases/{name}/addresses` e
`POST /v1/aliases/{name}/recovery/complete` aceitam um `chain` opcional; a mensagem
do desafio passa a ter uma linha `chain:`, que prende a assinatura àquela chain. A
Stellar continua assinando o digest emoldurado; a Solana assina o texto do desafio
com ed25519, a Monad com `personal_sign` do EIP-191. O endereço padrão é por chain e
rede, então adicionar um endereço Solana nunca rebaixa um Stellar.
`GET /v1/aliases/resolve/{name}` resolve na Stellar a menos que `?chain=` nomeie
outra chain — uma wallet que não pede nenhuma nunca recebe um endereço que não
consegue pagar — e `GET /v1/aliases/by-address/{address}` deduz a chain pelo formato
do próprio endereço. Um endereço Monad é gravado e comparado em sua grafia EIP-55.

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
| POST | `/v1/aliases/:name/recovery` | `payments:write` | Iniciar uma recuperação → o token é enviado por e-mail ao dono |
| POST | `/v1/aliases/:name/recovery/complete` | `payments:write` | Concluir uma recuperação com o token e a assinatura da nova chave |

## BlindPay — onramp / offramp / KYC (fiat ⇄ stablecoin)

> **Um plugin nativo.** Tudo nesta seção é o plugin `blindpay`
> (`src/native-plugins/blindpay/`), servido só quando `PLUGINS_ENABLED` lista
> `blindpay`; veja *Plugins nativos: BlindPay e DeFindex*. A BlindPay liquida em
> Stellar, Solana, chains EVM (Ethereum, Base, Arbitrum, Polygon) e Tron; **a Monad
> não é uma rede da BlindPay**, então nela não há rampa fiat de entrada nem de saída.

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

**Um payin ou payout é registrado antes de o BlindPay ser chamado para criá-lo.**
`POST /v1/onramp/payins` e `POST /v1/offramp/payouts` primeiro gravam uma linha em
`pending_provider` com a cotação e sua chave de execução, depois chamam o BlindPay
com essa chave como `Idempotency-Key` e por fim preenchem o id do provedor. Um
timeout, ou uma gravação que falha depois da chamada, deixa portanto uma linha, e não
um pagamento que ninguém aqui conhece: repetir o mesmo create com a mesma cotação
reutiliza a linha e repete a chave, e o webhook do BlindPay preenche a linha pelo
`quote_id`. As leituras do tenant omitem essas linhas até que tenham um id do
provedor. Uma que continua sem id depois de uma hora passa a `provider_unconfirmed`
e é registrada no log para um operador — nada reenvia o create, porque quem chamou
pode ter pago com outra cotação nesse meio-tempo. Uma recusa do BlindPay (qualquer
4xx exceto 408 e 409) remove a linha.

**Um webhook que não corresponde a nenhuma linha não é descartado.** Um evento de
payin ou payout é atribuído pela cotação que executou — ao consumer que a emitiu — e
o espelho é criado ou reparado ali. Um evento que ainda assim não pode ser atribuído
é confirmado mas fica aberto, e o reconciliador do BlindPay (ativo com
`OBSERVER_ENABLED`, uma vez por minuto, em uma réplica por vez) o relê do BlindPay
durante sete dias, registrando seu `svix-id` a cada tentativa sem sucesso para que a
entrega possa ser reenviada pelo painel do Svix. O mesmo reconciliador relê os
payins e payouts abertos cujos webhooks pararam de chegar e repara seu status.
`PAYIN_COMPLETED` e `PAYOUT_COMPLETED` saem uma única vez por payin ou payout, qualquer
que seja o caminho que veja a conclusão primeiro — o webhook, um reenvio com um
`svix-id` novo ou o reconciliador.

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

## Plugins — extensões sob um slug

Outras equipes integram sua tecnologia a este serviço como um **plugin**: uma pasta em
`plugins/`, servida em `/v1/plugins/<slug>/…`, que trabalha com os clientes, produtos e
intents de pagamento de um tenant sem nunca tocar o core diretamente. O objetivo é que
um plugin possa estar errado — com bugs, lento, guloso — sem que o core fique errado
junto.

### Um plugin é uma pasta

Todos os plugins vivem em **uma única pasta**, `plugins/` na raiz do repositório — os
que o suporte da Cosmos Pay distribui e os que um operador instala. Um plugin são três
arquivos legíveis, e nenhum roda até que seu slug esteja em `PLUGINS_ENABLED`:

```
plugins/
  README.md
  example/
    plugin.json       what the plugin is, and what it may touch
    index.ts          what it does — plain TypeScript, no build step
    signature.json    who vouches for the two files above
```

`plugin.json` diz o que o plugin é e o que pode tocar — o primeiro arquivo que um revisor e um tenant leem:

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

`index.ts` é o código: TypeScript comum, transpilado quando o serviço inicia. Seu único import é o SDK (`@/plugins/sdk`):

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

`example` vem pré-instalado e desativado: um plugin de referência que usa uma query, um
command, um evento e uma configuração do tenant. Comece por ele.

### Escrevendo um

```sh
npm run plugins -- new my-plugin          # plugins/my-plugin/ from a template
npm run plugins -- check my-plugin        # compile, load and validate it
PLUGINS_ENABLED=my-plugin PLUGINS_ALLOW_UNSIGNED=true npm run start:dev
npm run plugins -- sign my-plugin --key support.pem --key-id cosmos-support
```

`check` compila o plugin e roda todas as validações que o servidor roda na
inicialização. `PLUGINS_ALLOW_UNSIGNED=true` deixa rodar sem assinatura enquanto você
trabalha localmente, e é recusado quando `NODE_ENV=production`. Abra um pull request com
a pasta; depois da revisão, o suporte assina e ele passa a ser distribuído
pré-instalado.

Assinar nunca executa o código do plugin — só o `check` executa, e a CI o roda em
todo pull request —, então um pull request não consegue ter seu código executado na
máquina que guarda a chave do suporte. Assine o que a revisão e a CI já aprovaram.

### O que um plugin pode e não pode alcançar

Os handlers de um plugin recebem um `PluginContext` e nada mais: nada de Prisma,
provider do Nest, `process.env` ou socket:

| `ctx.` | Alcança | Limitado por |
| ------ | ------- | ------------ |
| `storage` | os registros próprios do plugin (`plugin_record`), apenas desta instalação | 16 KiB por valor, 10 000 registros por instalação |
| `core.customers`, `core.products` | listar / ler / criar / atualizar, pelos serviços e DTOs do próprio core | a capacidade concedida (`customers:read`, `customers:write`, …); não existe exclusão |
| `core.paymentIntents` | listar / ler, somente leitura | `payment_intents:read`; nada que assine ou movimente dinheiro |
| `http` | HTTPS na porta 443 para os hosts em `egress` | apenas endereços públicos (as regras SSRF dos webhooks), socket fixado no endereço verificado, sem redirecionamentos, respostas de 1 MiB |
| `installation.config` | as configurações do tenant; as secretas, decifradas só para esta chamada | — |

O que o runtime garante em cada invocação:

- **Isolamento entre tenants.** O contexto é construído a partir do consumer que chama
  e da sua instalação; nenhum método recebe um id de consumer ou de instalação.
- **Projeções, não linhas.** As leituras do core chegam como uma projeção fixa — sem
  `consumerId`, sem `xdr`/`uri`, sem payloads de provedores —, copiadas e congeladas.
- **A validação do core continua valendo.** As escritas passam pelos mesmos DTOs com
  que as rotas HTTP validam; campos desconhecidos são recusados.
- **Queries não podem escrever.** Uma query pode ser chamada com `plugins:read`, então
  dentro dela toda escrita no storage ou no core é recusada.
- **Orçamentos.** 10 s por invocação, 200 chamadas ao contexto, 64 KiB de entrada,
  256 KiB de saída. Quando o tempo acaba, quem chamou recebe `504 plugin_failed` e o
  contexto é revogado, então o trabalho que ficou rodando não consegue escrever depois.
- **Falhas ficam contidas.** Um `PluginError` vira `400 plugin_rejected` com a mensagem
  dele; qualquer outra coisa vira `502 plugin_failed`, registrada e nunca devolvida. Um
  plugin que falha num evento não afeta o webhook desse evento nem outros plugins.
- **Isolamento.** O código de um plugin nunca roda neste processo. Cada invocação
  recebe um isolate V8 novo (`isolated-vm`) sem nada do Node dentro — sem `process`,
  `require`, rede, sistema de arquivos ou timers —, um heap de 32 MB e uma thread
  própria. Sua única saída é uma ponte que aceita os nomes dos métodos do contexto
  acima, com cópias JSON na ida e na volta; nenhum objeto deste processo chega a ele,
  então código escrito para escapar não encontra de onde subir. Quando o orçamento
  acaba o isolate é descartado, o que para o plugin onde estiver — um loop síncrono
  inclusive — e nada que ele guardou em memória sobrevive à próxima chamada, nem à de
  outro tenant. Além disso, o ESLint só deixa `plugins/**/*.ts` importar o SDK.

### Quem responde por um plugin

Um plugin só roda se uma chave confiável assinou exatamente seu `plugin.json` e seu
`index.ts` com seu slug e sua versão (`signature.json`). Mude um caractere do código ou
uma capacidade e a assinatura falha — a inicialização para. A formatação do
`plugin.json` e os finais de linha não contam como mudanças.

- **Pré-instalado pelo suporte.** As chaves públicas do suporte estão no código
  (`PLUGIN_SUPPORT_KEYS`), então um plugin assinado pelo suporte e versionado em
  `plugins/` carrega em qualquer implantação sem configuração. `plugins/` está no
  `.github/CODEOWNERS`, e a CI verifica que cada pasta está assinada e válida.
- **Instalado manualmente.** Todo o resto é instalado de um registry — qualquer host
  HTTPS estático — e deve ser assinado pelo suporte ou por uma chave de
  `PLUGINS_TRUSTED_KEYS`:

```sh
npm run plugins -- install acme@1.0.0 --registry https://plugins.example.com
# then add "acme" to PLUGINS_ENABLED and restart
```

O registry não é confiável: `install` verifica a assinatura antes de escrever qualquer
coisa, e o servidor a verifica de novo a cada inicialização.

### Instalar é consentir

Um plugin roda para um tenant só depois que esse tenant o instala com
`PUT /v1/plugins/{slug}/installation`, enviando `grantCapabilities` igual à lista do
`plugin.json` — nem um subconjunto, nem um superconjunto
(`400 plugin_consent_mismatch`). Quando uma versão posterior declara mais, a instalação
mantém o consentimento anterior e toda ação responde `409 plugin_not_installed` até o
tenant instalar de novo (`installation.pendingCapabilities` mostra a diferença).
Desinstalar apaga todos os registros que o plugin guardou para esse tenant.
Configurações marcadas como `secret` são seladas com `PLUGINS_SECRET` e nunca
devolvidas.

### Rotas de plugins

| Método | Caminho | Finalidade |
| ------ | ------- | ---------- |
| GET | `/v1/plugins` | Os plugins que esta implantação serve, com as instalações de quem chama |
| GET | `/v1/plugins/{slug}` | Um plugin: capacidades, egress, configurações, ações, instalação |
| PUT | `/v1/plugins/{slug}/installation` | Instalar, consentir de novo ou reconfigurar |
| DELETE | `/v1/plugins/{slug}/installation` | Desinstalar, apagando os registros do plugin |
| POST | `/v1/plugins/{slug}/queries/{action}` | Executar uma ação somente leitura (`plugins:read`) |
| POST | `/v1/plugins/{slug}/commands/{action}` | Executar uma ação que escreve (`plugins:write`) |

Nenhuma rota de plugins admite a API key pública compartilhada: um plugin age sobre os
dados de um único tenant. As duas rotas de ações compartilham um orçamento de 120
requisições por minuto por consumer.

### Plugins nativos: BlindPay e DeFindex

Algumas integrações não são a chain em si — um provedor fiat, um protocolo DeFi — e
precisam do que o sandbox nega de propósito: tabelas próprias, webhooks de entrada,
credenciais do deploy inteiro. São **plugins nativos**: módulos Nest compilados no
serviço em `src/native-plugins/<slug>/`, ligados pela mesma lista
`PLUGINS_ENABLED` que os plugins isolados.

| Slug | O que serve |
| ---- | ----------- |
| `blindpay` | KYC, onramp, offramp, o webhook da BlindPay, suas rotas de `/v1/admin` (`receivers`, `payins`, `payouts`) e a seção `fiat` do resumo de administração |
| `defindex` | `/v1/defindex` — vaults da DeFindex na Stellar |

- **Fora da lista, não existe.** Um plugin nativo que `PLUGINS_ENABLED` não nomeia
  nunca é instanciado: suas rotas respondem 404, suas tarefas nunca iniciam e suas
  variáveis não são validadas. O boot avisa quando suas chaves estão configuradas mas
  seu slug não.
- **O núcleo nunca importa um plugin.** O lint recusa `@/native-plugins/*` em
  qualquer lugar de `src/` exceto `src/native-plugins/native-plugins.module.ts`, e
  recusa que um plugin importe outro. Onde o núcleo precisa de dados de um plugin —
  a visão geral de administração — ele expõe um ponto de extensão
  (`AdminExtensions`) no qual o plugin se registra.
- **Nem isolado, nem por tenant.** Um plugin nativo é código revisado com os
  privilégios do núcleo; não é instalado por tenant, e suas rotas mantêm seus
  próprios scopes (`kyc:*`, `onramp:*`, `offramp:*`, `liquidity:*`). Um plugin
  isolado não pode usar um slug nativo.
- **O contrato OpenAPI documenta as rotas de todo plugin nativo**, ligado ou não:
  `openapi:generate` liga todos.

## Atualização — mudanças incompatíveis e notas de deploy

### `X-Cosmos-Internal` precisa trazer um MAC do segredo do gateway

- **Um `X-Cosmos-Internal: 1` puro é recusado.** `/v1/admin` responde `403 admin_console_only`, e quem chama deixa de ser tratado como interno em qualquer lugar: recebe os limites de taxa por consumidor, e suas linhas no log de requisições não são marcadas. O header agora traz `v1.<unix seconds>.<hex>`, um HMAC-SHA256 assinado com `APISIX_GATEWAY_SECRET` e aceito dentro de cinco minutos do relógio do servidor (`src/admin/console-marker.ts`).
- **Scripts de operações que chamam `/v1/admin` diretamente precisam gerar o marcador a cada chamada.** O trecho `openssl` + `curl` no fim da entrada de `ADMIN_API_CREDENTIALS`, mais abaixo, faz isso.
- **Implante o serviço e a plataforma de desenvolvedores juntos.** Agora é o console que gera o marcador. Um console antigo contra este serviço recebe `403` em toda chamada de admin; um console novo contra um serviço anterior continua funcionando, porque o serviço anterior aceita qualquer valor exceto `0`, `false`, `no` e `off`. Se os dois não puderem sair ao mesmo tempo, implante primeiro a plataforma de desenvolvedores.
- **Nenhuma variável de ambiente nova.** O MAC é assinado com `APISIX_GATEWAY_SECRET`, que o serviço e o console já compartilham.

### Campos de recebedor e consultas de listas de admin mais rígidos

- **`POST /v1/kyc/receivers` e `PUT /v1/kyc/receivers/{id}` recusam com `400` campos de identidade malformados.** `country` e `id_doc_country` (no nível superior e em `owners[]`) devem ser códigos ISO 3166-1 alfa-2 em maiúsculas (`US`, não `us` nem `USA`); `date_of_birth` (no nível superior e em `owners[]`) e `formation_date` devem ser data-horas ISO 8601 com deslocamento (`1985-04-12T00:00:00.000Z`, não `1985-04-12`); `owners[].ownership_percentage` deve ser um número de 0 a 100; `website` deve ser uma URL `http`/`https` absoluta sem credenciais. Antes cada um era guardado como digitado e falhava na BlindPay só ao habilitar o recebedor, depois da revisão.
- **As consultas das listas de `/v1/admin` são validadas.** Um `status` desconhecido para aquela lista, um `take` fora de 1–200, um `skip` negativo ou um parâmetro que a rota não aceita agora é `400`; um `status` inválido chegava antes ao banco de dados e voltava como `500`. Os padrões não mudam (`take=50`, `skip=0`).
- **As leituras de admin de recebedores, payins e payouts retornam uma lista explícita de campos.** Os campos são os que eram retornados antes; uma coluna adicionada depois a essas tabelas não é mais retornada até ser incluída na lista.

### BlindPay: linhas antes da chamada ao provedor, e uma única conclusão por pagamento

- **A migração `20261006120000_blindpay_pending_rows`** torna anuláveis
  `payin.blindpayId` e `payout.blindpayId`, adiciona `executionKey` (único) e
  `lastCheckedAt` às duas tabelas, e adiciona `environment`, `blindpayId`,
  `appliedAt` e `lastAttemptAt` a `blindpay_webhook_event`. As linhas de entrega
  existentes são marcadas como aplicadas.
- **Nenhuma resposta muda de formato.** As linhas que ainda esperam um id do provedor
  (`pending_provider`, `provider_unconfirmed`) não são devolvidas pelas rotas do
  tenant; as listas de administração `/v1/admin/payins` e `/v1/admin/payouts` as
  mostram, com `blindpayId: null`.
- **`PAYIN_COMPLETED` e `PAYOUT_COMPLETED` são deduplicados** como os demais eventos
  terminais: uma segunda conclusão com um `svix-id` novo não produz mais um segundo
  evento com um `evt_` novo. Os outros eventos do BlindPay são reemitidos apenas
  quando a linha realmente mudou.
- **O reconciliador do BlindPay roda junto com o observador de liquidação**
  (`OBSERVER_ENABLED`); desligar o observador também o desliga.

### Payment intents: uma transação liquida um único intent, entre todos os tenants

- **A migração `20261006130000_payment_settlement`** adiciona `payment_settlement` e a preenche a partir de cada intent SUCCEEDED. Onde um mesmo hash já liquidou vários intents, o mais antigo mantém a reivindicação; o arquivo da migração traz a consulta que lista os demais para revisão.
- **Uma transação que já liquidou um payment intent — de qualquer consumer — não liquida mais outro.** `POST /v1/payment-intents/{id}/validate` e `PATCH /v1/payment-intents/{id}` com `status: SUCCEEDED` respondem `409 transaction_already_settled` e deixam o intent como estava. O destino não está vinculado a um consumer e o memo é escolhido por quem chama, então outro tenant — ou qualquer chamador sob a chave pública compartilhada — podia copiar um intent termo a termo e ser liquidado pela transação do pagador dele. O observer trata essa correspondência como ausência de pagamento: o intent continua PENDING e expira sem pagamento.
- **O pagamento vai para o intent mais antigo que ele paga.** Um intent recebe o mesmo `409 transaction_already_settled` quando a transação também paga um intent mais antigo de outro consumer, então uma cópia feita depois do original perde mesmo que sua liquidação rode primeiro, e o original é liquidado na passada seguinte. Uma cópia feita ANTES do original vence, mas só enquanto está aberta: um intent EXPIRED não supera ninguém, então quando a cópia expira o original é liquidado. Criá-la exige conhecer o memo do original de antemão, então deixe este serviço gerar os memos (omita `memo`) em vez de enviar memos previsíveis como números de pedido. O outro lado da regra: um pagamento que chega depois que o original expirou pode ir para uma cópia mais recente que não expirou. Na Monad isso também cobre uma cópia paga no endereço de depósito de outro intent, cujo pagamento o repasse do relayer liquidou com outro hash. Só um rival que a cadeia confirma como pago recusa uma liquidação, nunca a quantidade de rivais, e um rival precisa descrever o mesmo pagamento (memo, destino, ativo e valor na Stellar). **Monad sem relayer é a exceção:** um pagamento direto não carrega nada próprio do intent — destino, token e valor são públicos —, então dois intents em modo direto para o mesmo endereço e valor são indistinguíveis e não são ordenados por idade; o primeiro a liquidar fica com o pagamento. Use os endereços de depósito do relayer na Monad e memos gerados pelo serviço na Stellar.
- **`DELETE /v1/payment-intents/{id}` responde `409 operation_in_flight`** quando o status do intent muda entre a leitura e a exclusão, normalmente porque acabou de ser pago. Antes ele era excluído mesmo assim.

### Login da wallet: os signatários de uma wallet recuperada seguem `STELLAR_NETWORK`

- **`WALLET_AUTH_SIGNERS_HORIZON_URL` agora usa por padrão o Horizon de `STELLAR_NETWORK`** (`STELLAR_HORIZON_URL_PUBLIC` / `STELLAR_HORIZON_URL_TESTNET`, ou o da SDF), e não sempre o da rede pública. É consultado quando uma wallet recuperada via SEP-30 assina `POST /v1/wallet/auth/finish` com a chave que substituiu sua chave mestra. Num deploy em testnet a consulta ia para a mainnet, não encontrava a conta, e o login de toda wallet recuperada respondia `400 wallet_signature_invalid`.
- **`WALLET_RECOVERY_SPONSOR_NETWORK_PASSPHRASE` e `WALLET_RECOVERY_SPONSOR_HORIZON_URL` também a seguem**, para que o sponsor leia a conta no mesmo ledger.
- **Passo de deploy:** `STELLAR_NETWORK` vale `testnet` por padrão. Um deploy que serve wallets da mainnet e a deixa sem definir (as API keys escolhem a rede a cada request) agora precisa definir `STELLAR_NETWORK=public`, ou estas três variáveis, explicitamente. Caso contrário, as wallets da mainnet recuperadas não conseguem mais fazer login, e um sponsor configurado monta transações de testnet.
- **Só um ledger é consultado.** Consultar os dois permitiria que uma chave adicionada ao mesmo endereço na outra rede assinasse por esta.

### Backups da carteira: uma porta de recuperação por email, nas mãos dos dois servidores de recuperação

- **A migração `20261004120000_recovery_backup_shares`** adiciona `recovery_backup_share`. Só um
  servidor de recuperação (`RECOVERY_ROLE`) a escreve; aplique a migração nos dois.
- **Rotas novas nos servidores de recuperação:** `PUT`, `GET` e `DELETE /v1/sep30/shares/{address}`,
  `@Public()` como o resto do SEP-30 e servidas pela mesma rota sem chave. A carteira divide uma
  chave aleatória em duas, entrega uma metade a cada servidor com o token SEP-10 da conta e sela
  a chave de dados do backup sob a chave inteira como uma porta `recovery`. Provar o email aos
  DOIS servidores (o ID token do Authentik, ou o código que cada servidor envia) devolve as duas
  metades: o backup abre e a pessoa define uma senha nova. A semente — e o endereço em cada
  rede — sobrevive, ao contrário do SEP-30, que recupera só a conta Stellar.
- **A confiança que isto acrescenta:** um servidor sozinho guarda ruído aleatório. Os dois
  juntos, ou quem controle a caixa de email E consiga que os dois servidores a aceitem, podem
  abrir um backup com esta porta. Execute os dois em infraestrutura separada e com remetentes
  `MAIL_*` distintos, como o SEP-30 já exige.
- **`GET /v1/sep30/shares` (sem endereço) lista todas as metades arquivadas sob o e-mail
  comprovado**, paginado por `after` como `GET /v1/sep30/accounts`. Quem fez backup de várias
  carteiras com um mesmo e-mail esquece a senha de todas de uma vez; agora uma prova por servidor
  devolve todos os backups e não só o mais recente. Apenas com um token de identidade: o token
  SEP-10 de uma conta recebe `403`, pois já alcança a sua única metade pelo endereço.
- **`isBackupBox` aceita um slot `recovery` numa caixa `v: 4`**, ao lado de pelo menos um slot de
  senha ou de passkey. Uma caixa cuja única porta seja `recovery` é recusada.
- **O código por email de um servidor de recuperação** agora também vai para uma caixa de email
  que só guarda ali uma metade de backup.

### Swaps na Solana e na Monad: `chain` em `/v1/swaps` e uma tabela nova

- **A migração `20261003120000_chain_swaps`** adiciona a tabela `chain_swap`. Nada
  existente muda: `/v1/swaps` sem `chain` responde byte a byte como antes.
- **`/v1/swaps` aceita `chain`** (`stellar` | `solana` | `monad`) nos corpos de quote
  e create, e como parâmetro da listagem. Para Solana e Monad, create, a leitura
  individual e submit respondem um `ChainSwapEntity` (`oneOf` no contrato).
- **`POST /v1/swaps/{id}/submit`:** `signedXdr` deixa de ser obrigatório quando
  `signedTransaction` é enviado. Um swap da Stellar continua exigindo-o, com a
  mesma mensagem.
- **`/v1/cross-chain-swaps` agora recusa todo par na mesma rede** — antes cotava
  Solana → Solana e Monad → Monad pela NEAR Intents — e aponta para `/v1/swaps`.
- **Um nó da Solana ou da Monad recusar uma transmissão é `400 transaction_rejected`**,
  não mais `502 provider_error`. Isso inclui o relayer do encaminhador de depósitos
  da Monad, que registra e tenta de novo como antes.
- **Antes de habilitar:** configure `SOLANA_SWAP_FEE_WALLET` e crie sua conta de
  tokens para cada mint de saída esperado, configure `MONAD_SWAP_FEE_WALLET` e obtenha
  uma `KURU_API_KEY` para volume de produção.

### Swaps entre redes: um módulo novo, uma tabela nova e seis eventos de webhook

- **A migração `20261002120000_cross_chain_swaps`** adiciona a tabela
  `cross_chain_swap` e acrescenta seis valores a `WebhookEventType`:
  `CROSS_CHAIN_SWAP_CREATED`, `_UPDATED`, `_SUCCEEDED`, `_REFUNDED`, `_FAILED`,
  `_EXPIRED`. Nada existente é reescrito.
- **Rotas novas sob `/v1/cross-chain-swaps`**, reutilizando os scopes `swaps:read` /
  `swaps:write`; a chave pública compartilhada alcança assets, quote, create e
  deposit, nunca as duas leituras.
- **Antes de habilitar:** configure `NEAR_INTENTS_FEE_RECIPIENT` (uma conta NEAR) ou
  todo plano com comissão responde `503 misconfigured`, e configure
  `NEAR_INTENTS_API_KEY`, ou o 1Click adiciona a própria taxa e fica com metade da
  comissão.
- **`provider_error` agora também é um `400`**: a NEAR Intents recusar uma cotação
  ("amount is too low for bridge") é algo que quem chama pode mudar, então chega como
  `400 provider_error` com o motivo do 1Click, como já acontecia com um 4xx do
  BlindPay.
### Backups de wallet: Argon2id e cifragem em repouso

- **Defina `WALLET_BACKUP_ENCRYPTION_KEY` antes do deploy** (`openssl rand -base64 32`); o
  boot recusa uma porta de login sem ela. Cada caixa guardada é cifrada de novo com ela
  (AES-256-GCM, ligada ao seu `chain:address`), então um dump, réplica ou backup do banco
  não é uma cópia do backup de ninguém. Depois rode **`npm run backups:reencrypt`** uma vez:
  ele cifra as linhas escritas antes. Rotação: mova a chave antiga para
  `WALLET_BACKUP_ENCRYPTION_PREVIOUS_KEYS`, defina uma nova, rode o script e remova a antiga.
- **Caixas `v: 4` são aceitas**: o formato por slots do v3 com uma porta de senha Argon2id
  (`kdf: "argon2id"`, `m` ≥ 19 MiB, `t` ≥ 2). A wallet sela todo backup novo como v4
  (64 MiB, 2 passadas) e sela de novo como v4 uma caixa v2/v3 só com senha ao restaurá-la.
  v2 e v3 continuam aceitas e entregues.
- **A wallet pede uma senha de 12 caracteres** que não seja comum; as senhas existentes
  continuam funcionando até serem trocadas.
- **O banco em si** ainda precisa de cifragem na camada de armazenamento (disco / volume),
  backups cifrados e acesso limitado a este serviço: a chave em repouso protege a coluna de
  backups, não o resto das linhas.

### Backups de wallet: um por wallet, todos restaurados no login

- **A migração `20261001120000_wallet_backups_per_wallet`** troca a regra de um backup por
  conta por um por `(chain, address)` dentro da conta. As linhas existentes são mantidas
  como estão.
- **`POST /v1/wallet/auth/oauth/claim` e `email/verify` devolvem `backups`**, todas as caixas
  que a conta guarda, da mais nova para a mais antiga. `backup` continua como a mais nova e
  fica obsoleto.
- **`POST /v1/wallet/auth/finish` com um `backup` de outra wallet o adiciona**; não responde
  mais `backup_conflict`. Uma caixa da mesma wallet substitui a sua. `replaceBackup` é aceito
  e ignorado. Até 20 wallets por conta; a 21ª é `400 wallet_backup_limit`.

### A plataforma de desenvolvedores sai do caminho das requisições

- **Variáveis removidas:** `WALLET_AUTH_CONSOLE_URL`, `WALLET_AUTH_CONSOLE_SECRET`,
  `RECOVERY_EMAIL_DELIVERY_URL`, `RECOVERY_EMAIL_DELIVERY_SECRET`. São ignoradas.
- **A porta de email agora precisa de** `MAIL_FROM` + `MAIL_RESEND_API_KEY` / `MAIL_SMTP_*` (um
  remetente verificado no Resend) **e** `APISIX_ADMIN_URL` + `APISIX_ADMIN_KEY`. Sem
  os dois, `GET /v1/wallet/auth/providers` informa `email: false`; um login por
  provedor ainda conclui o callback, mas `POST /v1/wallet/auth/finish` responde
  `503 misconfigured` até o par admin ser definido. Cada par é definido junto ou o
  boot recusa.
- **Um servidor de recuperação que enviava códigos por email** define
  `RECOVERY_EMAIL_CODES=true` e seu próprio `MAIL_*`. `APISIX_ADMIN_KEY` num servidor
  de recuperação impede o boot.
- **Nova rota `GET /v1/public-key`** (`@Public()`), alimentada por
  `PUBLIC_API_KEY_DEV` / `PUBLIC_API_KEY_PROD`: copie os valores que a plataforma
  emitiu para a chave pública. Adicione o path à rota sem chave do APISIX (sem
  `key-auth`), ou as wallets recebem `401`.
- **As chaves de wallet agora ficam sob `cosmos_wallet_<accountId>`**; veja a seção
  acima para as contas que a plataforma provisionou. Os formatos de resposta não
  mudam.
- **`POST /v1/wallet/auth/finish` sem `backup`** conecta a wallet que assina à conta e devolve suas chaves: não responde mais `backup_conflict` quando a conta faz backup de outra wallet, e não move mais o `address` da conta. Com `backup` nada mudou. É assim que uma wallet importada de uma seed se conecta agora ao Cosmos Pay.
- **`POST /v1/aliases/{name}/recovery` fica aberto a chaves com `payments:write`, inclusive a chave pública compartilhada**, e responde só `{ accepted: true }`: este serviço envia o token por e-mail ele mesmo, então `token`, `email` e `expiresAt` saem da resposta e o console da plataforma não participa mais (essa rota não devolve mais `403 admin_console_only`). Precisa de `MAIL_*`; sem ele a rota responde `503 misconfigured`.
- **Sem migração.**

### Solana e Monad; BlindPay e DeFindex viram plugins nativos

- **A migração `20260930120000_multichain`** adiciona `chain` (padrão `stellar`) a
  `payment_intent`, `alias_address`, `alias_challenge`, `wallet_account` e
  `wallet_backup`, além de `assetDecimals`, `chainReference` e `chainCursor` a
  `payment_intent`, e amplia o índice único de endereços de alias para
  `(aliasId, chain, network, address)`. Toda linha existente continua Stellar; nada
  é reescrito.
- **BlindPay (KYC, onramp, offramp) e DeFindex só são servidos quando
  `PLUGINS_ENABLED` lista `blindpay` / `defindex`.** Um deploy que tinha as chaves
  configuradas e não adiciona os slugs perde `/v1/kyc`, `/v1/onramp`,
  `/v1/offramp`, `/v1/blindpay/webhooks`, `/v1/defindex` e as rotas da BlindPay em
  `/v1/admin` (404), e o boot registra um aviso com o slug. Configure por exemplo
  `PLUGINS_ENABLED=blindpay,defindex` antes do deploy. Fora isso, rotas, scopes,
  tabelas e respostas não mudam.
- **As variáveis da BlindPay são verificadas quando o plugin inicia**, não pela
  validação do ambiente: uma instância configurada pela metade continua impedindo o
  boot, mas só onde `blindpay` está ligado.
- **`GET /v1/admin/summary` traz `fiat` só com `blindpay` ligado**, e
  `GET /v1/admin/consumers` conta `blindpayReceivers`, `payins` e `payouts` só então.
  O `volume` do resumo rotula uma linha Solana ou Monad como `<chain>:<asset>`.
- **Campos novos nas respostas** (aditivos): `chain` e `chainReference` nas
  intenções de pagamento; `chain` nos endereços de alias, nas resoluções e nas linhas
  de by-address; `chain` e `address` nos backups da wallet, ao lado de
  `stellarAddress`; `chain` nas linhas `volume`, `recent` e de saldos do painel, que
  agora são agrupadas por chain — SOL e MON não se somam mais ao XLM.
- **`txHash` aceita o formato de qualquer chain** em `validate` e `PATCH`,
  verificado contra a chain da intenção (senão, `400 validation_failed`). Só o hex é
  passado para minúsculas; uma assinatura Solana é gravada como chega.
- **A resolução de alias sem `?chain=` devolve só endereços Stellar.**
- **Variáveis novas**, todas opcionais (RPCs públicos por padrão):
  `SOLANA_RPC_URL_MAINNET`, `SOLANA_RPC_URL_DEVNET`, `SOLANA_RPC_TIMEOUT_MS`,
  `MONAD_RPC_URL_MAINNET`, `MONAD_RPC_URL_TESTNET`, `MONAD_RPC_TIMEOUT_MS`,
  `MONAD_LOG_BLOCK_RANGE`. O observador agora também consulta Solana e Monad para as
  intenções pendentes nessas chains.
- **`/wallet/console/provision` da plataforma de desenvolvimento** agora recebe
  `chain` e `address`, e `stellarAddress: null` num login Solana ou Monad; ela
  precisa aceitar isso antes que as wallets ofereçam essas chains.
- **Os endereços de depósito da Monad** só são ativados com
  `MONAD_RELAYER_PRIVATE_KEY`; a migração também cria `evm_deposit_address`, e as
  intenções ganham `networkFee`. Sem a chave, as intenções na Monad se comportam
  como antes (pagando diretamente ao comerciante).
- **Nenhuma mudança no APISIX.**

### Plugins: um novo módulo, duas novas tabelas e dois novos escopos

`/v1/plugins` é novo; nenhuma rota ou resposta existente mudou. Na implantação:

- **A migração `20260929120000_plugins`** cria `plugin_installation` e
  `plugin_record`. Nenhuma tabela do core muda.
- **Os escopos `plugins:read` e `plugins:write` são novos.** Keys existentes não os
  recebem e ganham `insufficient_scope`; conceda-os pela plataforma de
  desenvolvedores.
- **Nada roda até que `PLUGINS_ENABLED` liste um plugin**, e então só para os tenants
  que o instalaram. `plugins/example` vem pré-instalado e desativado.
- **`typescript` agora é dependência de runtime**: o `index.ts` dos plugins é
  transpilado na inicialização. Não o remova das instalações de produção.
- **Defina `PLUGINS_SECRET`** antes de habilitar um plugin com configurações secretas —
  caso contrário a inicialização recusa. `PLUGINS_TRUSTED_KEYS` adiciona assinantes
  além dos do suporte.
- **Implante a pasta `plugins/` junto com o build.** Ela é lida do diretório de
  trabalho na inicialização, ao lado de `dist/`; uma implantação que copia só `dist/`
  e `node_modules/` não serve nenhum plugin, e um habilitado interrompe a
  inicialização.
- **O Node deve rodar com `--no-node-snapshot` quando um plugin está habilitado** — o
  sandbox (`isolated-vm`, um módulo nativo) exige isso, e sem ele a inicialização
  recusa. Todos os scripts npm o passam (`start`, `start:prod`, `test`, …); um processo
  iniciado de outra forma precisa dele no comando ou em `NODE_OPTIONS`.
- **Nenhuma mudança no APISIX:** a rota coringa já encaminha `/v1/plugins`.
- **Novos códigos de erro:** `plugin_not_installed`, `plugin_consent_mismatch`,
  `plugin_rejected`, `plugin_quota_exceeded`, `plugin_failed`.

### O Pollar foi removido

Tudo o que havia sob `/v1/pollar` foi removido — o bridge OAuth (`/v1/pollar/oauth/*`), o
provisionamento de wallets e trustlines (`/v1/pollar/wallets/*`) e `/v1/pollar/users` — junto
com os códigos de erro `pollar_identity_required`, `pollar_identity_mismatch` e
`elevated_key_required`, e todas as variáveis `POLLAR_*`. Essas rotas agora respondem `404`.

- **A migração `20260927120000_remove_pollar`** remove `pollar_oauth_session` e
  `pollar_user_wallet`. Não pode ser desfeita: se precisar desse histórico, faça backup das
  duas tabelas antes.
- **Apague as rotas do APISIX para `/v1/pollar/*`**, em especial a do callback sem
  key-auth, e remova as variáveis `POLLAR_*` — são ignoradas.
- **As keys ainda podem ter scopes `pollar:*`.** Nada mais os verifica.
- **Os ids de advisory lock `881_005` e `881_007` ficam aposentados** e não são reutilizados.
- **Wallets:** a Cosmos Wallet remove qualquer wallet Pollar do dispositivo na próxima vez
  que inicia. Os fundos continuam na Pollar, no mesmo endereço.

### Correções da revisão de segurança

A maioria destas mudanças não altera nada para quem chama de forma correta; confira
a coluna "Quem percebe" antes do deploy.

| Mudança | Quem percebe | Por quê |
| ------- | ------------ | ------- |
| `POST /v1/aliases/:name/recovery` é **exclusiva do console da plataforma**: uma API key recebe `403 admin_console_only`, e a rota saiu do contrato publicado | Quem iniciava recuperações com uma API key | A resposta traz o token de recuperação, que prova o controle da caixa de e-mail do dono |
| Concluir uma recuperação em um alias `SUSPENDED` resulta em `404` | Ninguém legítimo | Um token emitido antes de uma suspensão podia contornar o bloqueio do operador |
| Rotas `@Public()` (webhook do BlindPay, health) ignoram `X-Consumer-Username` | Dashboards: essas requisições agora aparecem no log como anônimas | Essas rotas não têm key-auth, então o header vinha do cliente |
| Recusas do `AdminGuard` e do `ConsoleOnlyGuard` são registradas em nível `warn` | Operadores | Os guards rodam antes do log de acesso, então as requisições recusadas não deixavam rastro |
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
| `POST /v1/swaps/:id/submit` e `POST /v1/liquidity-pools/operations/:id/submit` verificam o envelope antes de qualquer outra coisa: um corpo que não analisa, que não é o envelope da linha, ou que não traz assinaturas é `400 validation_failed` seja qual for o status da linha. Um `signedXdr` arbitrário não retorna mais uma linha `SUCCEEDED`, e uma linha `EXPIRED` responde a um corpo incompatível com `validation_failed` em vez de `invalid_state_transition` | Clientes que enviavam o `xdr` não assinado e contavam com a rejeição `tx_bad_auth` | Assinaturas não mudam o hash de uma transação, então o envelope não assinado podia ser retransmitido e rejeitado em loop, e sob a chave pública compartilhada só o id da linha bastava para ler uma linha já liquidada |
| As duas rotas de submit recusam um envelope fora do seu prazo (`400 invalid_state_transition`, não transmitido; o observer ainda o liquida se ele chegou à rede) e uma linha `FAILED` já reenviada 3 vezes (`400 invalid_state_transition`: monte uma nova). Uma retentativa após `503 provider_unavailable` não conta | Clientes que reenviam o submit em loop: pare em `invalid_state_transition` | Cada reenvio recusado era uma submissão ao Horizon e um novo evento de webhook terminal, sem limite |
| Um submit recusado é conferido com o ledger antes de ser registrado. Uma transação já on-chain e bem-sucedida (a wallet a transmitiu por conta própria e o reenvio voltou com `tx_bad_seq`) responde `SUCCEEDED` e dispara `*_SUCCEEDED`; uma pela qual o ledger ainda não consegue responder responde `submitted: false` com `status: "SUBMITTED"` e fica em andamento para o observer. O observer também reverifica as linhas `FAILED` criadas nas últimas 24 horas e promove aquela cuja transação foi liquidada, disparando `*_SUCCEEDED` depois do `*_FAILED` anterior | Clientes que leem `submitted: false` como definitivo: verifiquem `status`, e tratem um `*_SUCCEEDED` posterior a um `*_FAILED` do mesmo recurso como uma correção | Um swap ou depósito liquidado podia ficar `FAILED` para sempre, sem webhook de sucesso e, num depósito, sem base de custo |
| As duas rotas de submit permitem 20 chamadas por minuto por consumer e endereço do cliente, em orçamentos separados (`429 rate_limited`) | Carteiras atrás de um mesmo NAT compartilhando a chave pública | As rotas aceitam a chave pública compartilhada, e cada chamada pode transmitir para o Horizon |
| `GET /v1/webhooks`, `GET /v1/webhooks/:id` e `PATCH /v1/webhooks/:id` retornam apenas os campos documentados do endpoint; `POST /v1/webhooks` e `POST /v1/webhooks/:id/rotate-secret` retornam esses mais `secret`. `consumerId`, `previousSecret` e `previousSecretExpiresAt` saíram dos cinco | Quem lê esses campos | `previousSecret` é um segredo de assinatura que um integrador ainda pode aceitar, e uma chave com apenas `webhooks:read` conseguia lê-lo |
| Um token de recuperação que não corresponde a nenhuma recuperação ativa do alias deixa de contar contra ela. Um token ativo consome uma tentativa em toda apresentação, inclusive uma cujo challenge ou assinatura depois falha; após cinco é `400 alias_recovery_invalid` | Ninguém legítimo | Nomes de alias são públicos, então cinco tokens de lixo vindos de qualquer chave queimavam toda recuperação que o console iniciava |
| `POST /v1/aliases/:name/recovery/complete` (10 a cada 10 min), `POST /v1/aliases/challenges` (30), `POST /v1/webhooks/:id/ping` (20) e `POST /v1/webhooks/:id/deliveries/:deliveryId/redeliver` (30) são `429 rate_limited` acima do orçamento, por consumer e endereço do cliente | Scripts que fazem loop nessas rotas | Cada chamada grava uma linha, tenta um token de recuperação, ou envia requisições para uma URL que quem chama escolheu |
| `PATCH /v1/payment-intents/:id` exige que `txHash` seja um hash de transação Stellar em hex de 64 caracteres (qualquer outra coisa é `400`) e o armazena em minúsculas; `POST /v1/payment-intents/:id/validate` converte o seu próprio para minúsculas. Um hash é único entre os intents de um consumer, em vez de em todos os tenants, e um hash já presente em outro dos seus intents é `409 idempotency_conflict` (era `500`) | Chamadores enviando hashes placeholder ou truncados | Qualquer tenant podia estacionar o hash de transação de outro tenant em um intent próprio; a liquidação do outro tenant então caía no índice global, respondia `500`, e o intent pago expirava sem `PAYMENT_INTENT_SUCCEEDED` |
| Um intent `EXPIRED` passa a `SUCCEEDED` quando o seu pagamento é verificado on-chain: pelo observer, que agora verifica a chain antes de expirar, ou por `POST /v1/payment-intents/:id/validate` e `PATCH {status: SUCCEEDED}`, que passam a responder `200` em vez de `400 invalid_state_transition`. `PAYMENT_INTENT_SUCCEEDED` pode seguir a atualização que `EXPIRED` disparou | Consumidores de webhook que tratam `EXPIRED` como final | A expiração nunca olhava para a chain, e o verificador lia apenas os 50 pagamentos mais recentes ao destino, então um pagamento atrasado ou enterrado deixava um intent pago `EXPIRED` para sempre |
| As respostas de swaps, operações de liquidity pool, payment intents e customers retornam apenas os campos documentados, mais `expiresAt` em swaps e payment intents, agora documentado. `consumerId` e a contabilidade de liquidação (`settlementEpoch`, `lastCheckedAt`, `notFoundStreak`, `sharesReceived`, `settledAmountA`/`B`, `horizonCursor`) não são mais enviados | Quem lia esses campos | São internos, e várias dessas rotas são alcançáveis com a key pública compartilhada |
| `PATCH /v1/kyc/receivers/:id` em um receiver que já existe no BlindPay é `403 kyc_review_required` para qualquer campo exceto `external_id` e `image_url`, a menos que a key seja elevada (`X-Consumer-Role: admin`) | Integradores corrigindo a identidade de um receiver ativo com uma key de tenant: passe pelo revisor | O `PUT` enviava dados de identidade nunca revisados direto a um provedor regulado, enquanto a mesma edição antes de habilitar volta para revisão |
| As rotas do BlindPay usam a instância do ambiente da key: keys `prod` a das variáveis `BLINDPAY_*` sem sufixo, keys `dev` a de `BLINDPAY_*_DEV`, e uma key `dev` sem instância de desenvolvimento configurada recebe `503 misconfigured`. Receivers, carteiras, contas bancárias, contas virtuais, cotações, payins e payouts só são lidos e executados nessa instância | Quem usa o BlindPay com keys `dev` | Uma key `dev` operava a instância de produção: podia listar e excluir identidades KYC reais e criar payouts reais |
| Um login na testnet não provisiona mais uma carteira de mainnet para o usuário: `network_wallets` num resgate na testnet lista só a carteira da testnet. Um login na mainnet continua provisionando a testnet | Quem lê uma entrada de mainnet de um login na testnet | Uma key `dev` que qualquer um pode gerar gastava XLM real do operador numa reserva de mainnet a cada login |
| `POST /v1/kyc/receivers/:id/approve` aceita `expected_version` (o `dossierVersion` que você leu) e responde `409 kyc_state_invalid` quando os dados de KYC mudaram desde então. `POST /v1/kyc/receivers/:id/enable` recusa um dossiê que não é o aprovado, e as leituras de receiver trazem `dossierVersion` e `reviewedVersion` | Os revisores, quando começarem a enviar `expected_version`; mais ninguém — o campo é opcional | Uma revisão é uma pessoa lendo os dados e então aprovando, e uma edição no meio deixa o status em `pending_review`, então a aprovação recaía sobre um dossiê que ninguém tinha visto e o `enable` o enviava a um provedor regulado |
| `POST /v1/kyc/upload`, `/v1/kyc/terms-of-service`, as escritas de onramp e offramp, `POST /v1/payment-intents/tx` e `/pay`, `POST /v1/swaps/quote` e `/v1/swaps`, e `POST /v1/liquidity-pools/deposit` e `/withdraw` agora respondem `429 rate_limited` acima do orçamento, por consumer e endereço do cliente. Toda rota apoiada no BlindPay conta também contra um teto por consumer de 60 requisições ao provedor por minuto | Scripts que rodam essas rotas em loop; um importador em lote acima do teto deve ter a própria chave | Não tinham limite nenhum: cada uma deixa algo no provedor que erro nenhum devolve, ou gasta o orçamento por IP do Horizon que todas as rotas daqui compartilham. Só os submits eram limitados |
| `POST /v1/swaps` não responde mais `409 operation_in_flight` para um swap `PENDING` cujo sequence number a conta ainda não usou (um envelope não assinado ou abandonado). Só vale com `STELLAR_SWAP_SINGLE_INFLIGHT=true` | Usuários de carteira que ficavam bloqueados | Qualquer um pode indicar qualquer `source`, então um swap de poeira congelava a conta de um terceiro uma janela de expiração após a outra — o gêmeo da correção de liquidity pools acima |
| Um destino de webhook recusado pelo host — não resolve, privado, link-local, metadata — é um único `400` com uma única mensagem; o motivo fica no log do serviço. Uma URL malformada, um esquema que não é https, credenciais ou a falta de host continuam dizendo o que está errado | Integradores que liam o motivo na resposta | Cadastrar um endpoint resolve um nome que este serviço alcança, então uma resposta por motivo permitia mapear a rede interna uma URL por vez |
| Uma `redirect_url` é recusada quando traz fragmento, barra invertida, espaços ou caractere de controle; https sem credenciais embutidas já era obrigatório | Ninguém que envie uma URL comum | `https://app.acme.com\@evil.test` nomeia um host diferente dependendo de quem a analisa, e o valor ainda é lido pelo BlindPay e por um navegador |
| `POST /v1/wallet/auth/oauth/claim`: um login com Authentik cujo email o provedor não confirmou (`email_verified` diferente de `true`) conclui o callback e responde `verify_email` com um código enviado para essa caixa, com ou sem conta, em vez de falhar com `email_unverified`. Nenhum ID token é liberado nesse caso, então ele não pode iniciar uma recuperação SEP-30, e compartilha o intervalo por endereço de `POST /v1/wallet/auth/email/start` (`400 wallet_login_code_cooldown`). Rode antes a migração `20260926120000_wallet_auth_unverified_email` | Wallets: tratar `verify_email` também em uma conta nova | A pessoa ficava numa página sem saída; o código prova o endereço que o provedor não confirmou |
| `POST /v1/wallet/auth/finish` e `POST /v1/wallet/recovery/setup` leem o token de sessão de `X-Wallet-Session: {sessionToken}`. `Authorization: Bearer` continua sendo lido, mas só chega ao serviço numa chamada direta | Wallets: enviar `X-Wallet-Session` junto com a API key | O gateway remove `Authorization` (e `apikey`) antes do proxy, então via APISIX o token nunca chegava e as duas rotas respondiam `401 wallet_session_invalid` |
| Um login do wallet com Authentik pede `max_age=300` em vez de `prompt=login`, e o `auth_time` do ID token precisa estar dentro desses 5 minutos (senão o callback falha com `profile_invalid`). Com Google / GitHub como fontes do Authentik, configure `default-source-authentication` como *Authentication: No requirement* | Operadores com Authentik e fontes sociais | Com `prompt=login`, o Authentik pedia dois logins a um navegador sem sessão, e o segundo login por uma fonte era recusado com "Flow does not apply to current user" |
| `POST /v1/wallet/auth/finish` e `PUT /v1/wallet/backup` também aceitam uma caixa de backup `v: 3`: a semente sob uma chave de dados aleatória, e essa chave selada uma vez por porta em `slots` (`kind: "password"` ou `kind: "passkey"`, no máximo 8). Toda porta de palavra-passe tem o mesmo mínimo de PBKDF2 de uma caixa `v: 2`; uma porta de passkey não tem custo, porque a sua chave é a saída PRF do WebAuthn do autenticador. As caixas `v: 2` não mudam | Wallets: um backup só com passkey é válido, e uma wallet que escreveu um precisa deste servidor | Permite recuperar com uma passkey em vez de digitar a palavra-passe original, sem que este serviço tenha alguma vez uma chave que abra a caixa |
| `POST /v1/wallet/auth/oauth/authorize` aceita um `returnTo` opcional. Quando ele está em `WALLET_AUTH_RETURN_URLS`, `GET /v1/wallet/auth/oauth/callback/{provider}` responde `302` para ele com `?state=…` (mais `&error=<reason>` em caso de falha) em vez de renderizar a página; um que não está na lista é `400 wallet_return_url_not_allowed`. Só o `state` viaja — o handshake continua sendo resgatado com o verificador PKCE. Rode antes a migração `20260927180000_wallet_auth_return_to` | Wallets nativas (desktop e mobile): enviar `returnTo` e registrar essa URL no sistema operacional | Uma sessão de autenticação da plataforma (`ASWebAuthenticationSession`, uma Custom Tab, um deep link ou listener loopback de desktop) só fecha quando o navegador chega a uma URL do próprio app, então a pessoa ficava na página e tinha que fechá-la à mão |
| `GET /v1/wallet/auth/providers` também retorna `mfaSettingsUrl`: a página da conta do Authentik onde a pessoa adiciona ou remove um segundo fator (chave de segurança ou passkey, app autenticador, códigos de recuperação), passando pelo login do Authentik quando não há sessão; `null` sem Authentik. O segundo fator é opcional no login da wallet: `deploy/authentik/wallet-sign-in.yaml` volta a etapa de MFA para *skip*, pede o fator depois da senha a quem tem um, deixa entrar com passkey pela tela do usuário e, a quem não tem nenhum, oferece uma escolha depois da senha (agora não, uma chave de segurança, um app autenticador). Também adiciona Google / GitHub à página de cadastro, acima do formulário. O login e o cadastro com senha não mudam | Operadores com Authentik: importar o blueprint. Wallets: oferecer a URL como uma configuração | O segundo fator era obrigatório para todos ou inalcançável: os usuários da wallet nunca abrem as configurações do Authentik, os flows de configuração recusam um navegador sem sessão do Authentik, e o botão passwordless da etapa de identificação apontava para o mesmo flow, então só recarregava a página |
| `/v1/admin` exige que `X-Cosmos-Internal` traga um MAC recente assinado com `APISIX_GATEWAY_SECRET` (`v1.<unix seconds>.<hex>`, dentro de cinco minutos); um `1` puro é `403 admin_console_only`, e só um marcador verificado isenta quem chama dos limites de taxa por consumidor ou marca suas linhas no log de requisições | Scripts de operações que chamam `/v1/admin` diretamente, e uma plataforma de desenvolvedores implantada sem esta mudança | Qualquer valor exceto `0`, `false`, `no` ou `off` valia, então uma única rota do APISIX que esquecesse de remover o header dava a toda API key a superfície de admin cross-tenant, a isenção de limites de taxa e um jeito de esconder suas chamadas do log de requisições do tenant |

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
- **A migration `20260915200000_receiver_dossier_version`** adiciona `dossierVersion`
  (padrão `1`) e `reviewedVersion` a `blindpay_receiver` — só catálogo, sem reescrita
  da tabela — e preenche `reviewedVersion` em todo receiver que já passou pelo portão
  de revisão, para que o `enable` deles continue funcionando. Receivers ainda em
  `inactive` ou `pending_review` ficam com `NULL`, que é a verdade sobre eles.
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
retry em qualquer resposta que não seja 2xx, então a entrega de webhooks não muda.

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
2. `X-Cosmos-Internal` é um marcador do console: `v1.<unix seconds>.<hex>`, onde
   o hex é `HMAC-SHA256(APISIX_GATEWAY_SECRET, "cosmos-admin-console:v1:" +
   seconds)` e o timestamp está a até cinco minutos do relógio do servidor. Quem
   chama com uma API key não tem o segredo do gateway, então não consegue gerá-lo nem
   mesmo por uma rota que esqueceu de remover o header
   (`proxy-rewrite.headers.remove`). É essa mesma verificação que isenta o console dos
   limites de taxa por consumidor e marca suas linhas no log de requisições.

Um `X-Cosmos-Internal: 1` puro — o que o console enviava antes — é recusado como
qualquer outra falsificação, então o serviço e a plataforma de desenvolvedores são
implantados juntos. Os dois repositórios fixam o mesmo vetor de teste para o marcador.
O console é o único lugar que decide quem é admin da plataforma, e as linhas de
auditoria nomeiam a conta do console que agiu (`cosmos_<userId>`) e o seu papel na
plataforma, em toda mutação **e** em toda leitura.

O que isso muda para quem chama:

| Antes | Agora |
| ----- | ----- |
| `401` `admin_credentials_required` sem um segredo Bearer | `403` `admin_console_only` para tudo o que não for uma chamada do console |
| `403` `admin_role_required` para uma credencial `read` em uma mutação | não existe mais — o console já decidiu que a conta pode agir |
| `actorId` / `actorRole` em uma linha de auditoria nomeavam a credencial | eles nomeiam a conta do console e o seu papel na plataforma |

Para chamar `/v1/admin` diretamente (de um script de operações, por exemplo), envie
`X-Gateway-Secret`, `X-Consumer-Username` e um `X-Cosmos-Internal` recém-gerado;
adicione `X-Cosmos-Admin-Role: owner` para rotular a linha de auditoria. Mantenha o
serviço fora da internet pública.

```sh
TS=$(date +%s)
MAC=$(printf 'cosmos-admin-console:v1:%s' "$TS" | openssl dgst -sha256 -hmac "$APISIX_GATEWAY_SECRET" -r | cut -d' ' -f1)
curl -H "X-Gateway-Secret: $APISIX_GATEWAY_SECRET" -H "X-Consumer-Username: ops" -H "X-Cosmos-Internal: v1.$TS.$MAC" http://localhost:3000/v1/admin/summary
```

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
| `ENV_FILE` | não | `.env` | O arquivo dotenv que este processo lê (Nest e Prisma). As instâncias locais o compartilham — o que muda por instância está em `dev-instances.json` (`npm run dev:local`); valores já presentes no ambiente continuam prevalecendo |
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
| `APISIX_EMAIL_HEADER` | não | `x-consumer-email` | E-mail verificado da conta da key, repassado pelo gateway. Hoje nada neste serviço depende dele |
| `APISIX_PUBLIC_CONSUMER` | não | — | Username do consumer público compartilhado (veja acima). Defina-o onde quer que uma chave pública seja publicada |
| `PUBLIC_API_KEY_DEV` | não | — | A chave pública compartilhada da testnet, servida por `GET /v1/public-key?env=dev`. Sem definir responde `503 misconfigured` |
| `PUBLIC_API_KEY_PROD` | não | — | O mesmo para a mainnet (`env=prod`) |
| `APISIX_ADMIN_URL` | com a admin key | — | Base da Admin API do APISIX, ex. `http://apisix:9180/apisix/admin`. Usada só para emitir as chaves das contas de wallet |
| `APISIX_ADMIN_KEY` | para o login da wallet | — | Admin key do APISIX. Vale para todo o gateway — veja [Nenhuma requisição depende da plataforma de desenvolvedores](#nenhuma-requisição-depende-da-plataforma-de-desenvolvedores). Recusada num servidor de recuperação |
| `APISIX_ADMIN_TIMEOUT_MS` | não | `10000` | Orçamento de uma chamada à Admin API (ms) |
| `WALLET_KEY_SWAP_FEE_BPS` | não | `50` | Comissão de swap embutida nas chaves das contas de wallet (a taxa do plano `community`) |
| `MAIL_RESEND_API_KEY` | para a porta de email | — | API key do Resend com a qual este serviço envia os códigos de login e de recuperação |
| `MAIL_FROM` | com a chave do Resend / SMTP | — | Remetente verificado, ex. `Cosmos Pay <no-reply@example.com>` |
| `MAIL_SMTP_HOST` | não | — | Servidor SMTP, usado quando `MAIL_RESEND_API_KEY` não está definida |
| `MAIL_SMTP_PORT` | não | `587` | Porta SMTP |
| `MAIL_SMTP_SECURE` | não | `false` | `true` para TLS implícito (465), `false` para STARTTLS (587) |
| `MAIL_SMTP_USER` | não | — | Usuário SMTP |
| `MAIL_SMTP_PASS` | não | — | Senha SMTP |
| `MAIL_TIMEOUT_MS` | não | `15000` | Orçamento de um envio (ms) |
| `RECOVERY_EMAIL_CODES` | não | `false` | Num servidor de recuperação: envia os próprios códigos pelo seu `MAIL_*` |
| `WALLET_BACKUP_ENCRYPTION_KEY` | com qualquer porta de login | — | Cifra em repouso cada backup de wallet guardado (AES-256-GCM, 32 bytes em base64/hex). Fica só no ambiente: uma cópia do banco contém cifra da cifra do dispositivo. Perdê-la significa que os backups guardados não podem mais ser entregues |
| `WALLET_BACKUP_ENCRYPTION_PREVIOUS_KEYS` | não | — | Chaves aposentadas separadas por vírgula, só leitura, para uma rotação; remova-as depois de `npm run backups:reencrypt` |
| `STELLAR_NETWORK` | não | `testnet` | Rede Stellar de fallback (`public` / `testnet`) |
| `STELLAR_HORIZON_URL_PUBLIC` | não | `https://horizon.stellar.org` | URL base do Horizon da mainnet |
| `STELLAR_HORIZON_URL_TESTNET` | não | `https://horizon-testnet.stellar.org` | URL base do Horizon da testnet |
| `SOLANA_RPC_URL_MAINNET` | não | `https://api.mainnet-beta.solana.com` | RPC da Solana para chaves `prod` (mainnet-beta; o genesis hash é verificado antes do uso). O endpoint público tem limite de taxa: em produção use o de um provedor |
| `SOLANA_RPC_URL_DEVNET` | não | `https://api.devnet.solana.com` | RPC da Solana para chaves `dev` (devnet) |
| `SOLANA_RPC_TIMEOUT_MS` | não | `10000` | Orçamento de uma chamada RPC à Solana (ms) |
| `MONAD_RPC_URL_MAINNET` | não | `https://rpc.monad.xyz` | RPC da Monad para chaves `prod` (chain id 143, verificado antes do uso) |
| `MONAD_RPC_URL_TESTNET` | não | `https://testnet-rpc.monad.xyz` | RPC da Monad para chaves `dev` (chain id 10143) |
| `MONAD_RPC_TIMEOUT_MS` | não | `10000` | Orçamento de uma chamada RPC à Monad (ms) |
| `MONAD_LOG_BLOCK_RANGE` | não | `100` | Blocos que um `eth_getLogs` pode abranger: o limite do provedor RPC (o RPC público permite 100) |
| `MONAD_RELAYER_PRIVATE_KEY` | não | — | Chave do relayer (hex de 32 bytes). Configurada, cada intenção na Monad recebe seu próprio endereço de depósito e o relayer encaminha os depósitos ao comerciante, menos uma taxa. Guarda só dinheiro para gas: os encaminhadores que ela implanta não podem pagar mais ninguém |
| `MONAD_DEPOSIT_TOKEN_FEES` | não | — | Taxa do relayer por depósito de cada ERC-20, JSON `{"0xToken": "0.05"}` em unidades do token. Um token sem entrada é encaminhado de graça (o relayer paga o gas) |
| `STELLAR_BASE_FEE` | não | `100` | Taxa base da Stellar (stroops) para montagem de tx |
| `STELLAR_TX_TIMEOUT` | não | `300` | Timeout da transação (segundos) |
| `STELLAR_SWAP_FEE_WALLET` | quando fee > 0 | — | Conta G... da plataforma para as taxas de swap |
| `STELLAR_SWAP_FEE_BPS` | não | `50` | Taxa de swap em basis points |
| `STELLAR_SWAP_SLIPPAGE_BPS` | não | `50` | Tolerância de slippage padrão do swap (bps) |
| `STELLAR_SWAP_MAX_SLIPPAGE_BPS` | não | `500` | Limite rígido para o slippage de quem chama (bps) |
| `STELLAR_SWAP_SINGLE_INFLIGHT` | não | `false` | Quando `true`, 409 se já existir um swap PENDING não expirado para a mesma origem |
| `NEAR_INTENTS_BASE_URL` | não | `https://1click.chaindefuser.com` | API 1Click da NEAR Intents, para os swaps entre redes |
| `NEAR_INTENTS_API_KEY` | recomendada | — | Chave de parceiro do 1Click (`X-API-Key`). Sem ela o 1Click adiciona uma taxa própria de 0,2 % e fica com metade da comissão |
| `NEAR_INTENTS_FEE_RECIPIENT` | com comissão de plano | — | Conta NEAR que recebe a comissão entre redes (`appFees`). Sem configurar e com taxa de plano: `503 misconfigured` |
| `NEAR_INTENTS_TIMEOUT_MS` | não | `20000` | Orçamento de uma chamada ao 1Click (ms) |
| `CROSS_CHAIN_SWAP_SLIPPAGE_BPS` | não | `100` | Slippage padrão entre redes (bps); abaixo do mínimo a NEAR Intents reembolsa |
| `CROSS_CHAIN_SWAP_MAX_SLIPPAGE_BPS` | não | `500` | O maior slippage que quem chama pode pedir |
| `CROSS_CHAIN_SWAP_DEADLINE_SECONDS` | não | `1800` | Por quanto tempo um endereço de depósito aceita o depósito; os posteriores são reembolsados |
| `SOLANA_SWAP_FEE_WALLET` | com comissão de plano | — | Dono das contas de tokens onde a comissão dos swaps na Solana é paga (`feeAccount` do Jupiter, uma por mint de saída — crie-as antes). Sem configurar e com taxa de plano: `503 misconfigured` |
| `MONAD_SWAP_FEE_WALLET` | com comissão de plano | — | Endereço que recebe a comissão dos swaps na Monad (`referrerAddress` do Kuru Flow) |
| `JUPITER_BASE_URL` | não | `https://lite-api.jup.ag/swap/v1` | API de swaps do Jupiter; `https://api.jup.ag/swap/v1` com chave |
| `JUPITER_API_KEY` | não | — | Chave de API do Jupiter (`x-api-key`), para limites maiores |
| `JUPITER_TIMEOUT_MS` | não | `15000` | Orçamento de uma chamada ao Jupiter (ms) |
| `KURU_BASE_URL` | não | `https://ws.kuru.io` | API do Kuru Flow (Monad) |
| `KURU_API_KEY` | para produção | — | Chave de API do Kuru Flow (`X-API-Key`). Sem ela cada endereço recebe um token limitado a uma requisição por segundo |
| `KURU_TIMEOUT_MS` | não | `15000` | Orçamento de uma chamada ao Kuru Flow (ms) |
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
| `DEFINDEX_API_KEY` | não | — | Chave de API de servidor da DeFindex. As rotas só existem com `defindex` em `PLUGINS_ENABLED`; sem a chave respondem `503 misconfigured` |
| `DEFINDEX_BASE_URL` | não | `https://api.defindex.io` | URL base da API DeFindex |
| `DEFINDEX_TIMEOUT_MS` | não | `30000` | Timeout HTTP DeFindex (ms) |
| `PLUGINS_ENABLED` | não | — | Slugs, separados por vírgula, dos plugins que este deploy serve: os isolados em `plugins/` e os nativos `blindpay` e `defindex`. Vazio não serve nenhum; um plugin não listado nunca é carregado |
| `PLUGINS_SECRET` | quando um plugin habilitado tem configurações secretas | — | Sela as configurações secretas das instalações de plugins (no mínimo 32 caracteres). Alterá-lo torna ilegíveis todos os segredos de plugins armazenados |
| `PLUGINS_TRUSTED_KEYS` | não | — | Assinantes cujos plugins rodam aqui além do suporte da Cosmos Pay: `<keyId>:<chave pública Ed25519 em base64url>` separados por vírgula. Um plugin assinado por outro, ou alterado depois de assinado, interrompe a inicialização |
| `PLUGINS_ALLOW_UNSIGNED` | não | `false` | Rodar plugins sem `signature.json`, para escrever um localmente. Recusado quando `NODE_ENV=production` |
| `KYC_REDIRECT_URL_WHITELIST` | não | — | Allow-list por consumer de hosts de redirecionamento do KYC |
| `WALLET_AUTH_RETURN_URLS` | não | — | URLs do app, separadas por vírgula, para as quais o callback do login da wallet pode redirecionar (`returnTo` em `POST /v1/wallet/auth/oauth/authorize`): um esquema próprio, um universal/app link, ou `http://127.0.0.1/…` (qualquer porta). Correspondência exata; uma entrada em http puro fora do loopback, com query ou com `javascript:`/`data:`/`file:` é recusada na inicialização. Sem valor, todo callback renderiza a página e um `returnTo` é `400 wallet_return_url_not_allowed` |
| `WALLET_AUTH_SIGNERS_HORIZON_URL` | não | o Horizon de `STELLAR_NETWORK` | Lista quem pode assinar por uma conta; consultado quando uma wallet recuperada assina com a chave que substituiu sua chave mestra. Precisa ser o ledger onde as wallets vivem: outro responde 404 e o login é `400 wallet_signature_invalid` |
| `WALLET_RECOVERY_SPONSOR_NETWORK_PASSPHRASE` | não | a passphrase de `STELLAR_NETWORK` | Rede para a qual o setup de recuperação patrocinado (`POST /v1/wallet/recovery/setup`) é montado |
| `WALLET_RECOVERY_SPONSOR_HORIZON_URL` | não | o Horizon de `STELLAR_NETWORK` | Horizon do qual o setup de recuperação patrocinado lê a conta |
| `RATE_LIMIT_ENABLED` | não | `true` | Limites por endereço nas rotas que gastam XLM. Chave de incidente |
| `RATE_LIMIT_PRUNE_INTERVAL_MS` | não | `600000` | Intervalo de limpeza das janelas do contador (ms, mín. 1000) |

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
> valores são honestos. Revise a lista sempre que uma rota for adicionada ou copiada.
> `X-Cosmos-Internal` não depende mais dela — o serviço verifica um MAC assinado com o
> segredo do gateway —, mas cada header `X-Consumer-*` ainda depende, e uma rota que
> encaminhe a cópia de um cliente permite que ele se passe por qualquer consumidor.
> Mantenha o serviço em uma rede privada para que o APISIX seja o único caminho de
> entrada; o segredo compartilhado é uma segunda camada, não a única.
>
> Em produção, a ausência de `X-Plan-Swap-Fee-Bps` retorna `503` em vez de recorrer ao
> padrão do ambiente.
