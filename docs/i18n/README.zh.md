# Cosmos Pay — 支付微服务

[English](../../README.md) · [Español](./README.es.md) · [Português](./README.pt.md) · [Deutsch](./README.de.md) · [Français](./README.fr.md) · [हिन्दी](./README.hi.md) · **简体中文**

基于 **NestJS 12** + **Prisma 7 (PostgreSQL)** 构建的支付微服务。

它是一个与 Cosmos 开发者平台（`paydev`）*相互独立*的应用。开发者平台只负责为下游服务**签发** APISIX 访问令牌（消费者 + `key-auth` 凭证）。本服务正是这些下游服务之一：它位于 **APISIX 之后**，APISIX 对每个请求进行负载均衡和身份验证，然后才将其转发到这里。因此本服务从不接触原始 API key——它只信任网关转发过来的内容。

## 如何强制“只经由 APISIX”

只有**同时**满足以下两个条件，请求才会被接受（见 `src/common/guards/apisix.guard.ts`）：

1. **网关共享密钥。** 请求携带 `X-Gateway-Secret`，并以恒定时间与 `APISIX_GATEWAY_SECRET` 进行比较。APISIX 会在每个代理的请求上*注入*该请求头，并*剥离*客户端自行提供的副本，因此正确的值只可能来自网关。（纵深防御——请配合网络隔离，确保服务无法被直接访问。）
2. **已认证的消费者。** APISIX 的 `key-auth` 插件在验证调用方的 API key 之后，会转发 `X-Consumer-Username`（以及 `X-Credential-Identifier`）。guard 要求消费者请求头必须存在，以此证明该 key 已在上游完成认证。

路由可以通过 `@Public()` 退出该检查（编排器直接访问的健康探针使用了它）。强制检查始终开启——不存在关闭它的开关。本地开发时，请在 APISIX 之后运行，或自行发送 `X-Gateway-Secret` + `X-Consumer-*` 请求头。

有一个接口从这两个条件中读出了更多信息。`/v1/admin` 是跨租户的，`AdminGuard` 只有在请求还携带 `X-Cosmos-Internal` 时才会放行——APISIX 会从它代理的所有请求中**移除**这个请求头，因此只有持有网关密钥的后端发起的直接调用才能带上它。这个后端就是开发者平台，它已经判定了当前登录的账户是否为 owner/admin。无需另外部署管理员凭证（见关于 `ADMIN_API_CREDENTIALS` 的升级说明），这使得网关密钥和网络隔离构成了跨租户数据之前的全部边界——也使得网关路由中的剥离列表关乎安全，而不仅仅是良好习惯。

处理流程：

```
request → ApisixContextMiddleware  (reads consumer headers → req.gatewayConsumer)
        → ApisixGuard (APP_GUARD)  (verifies secret + consumer, or @Public bypass)
        → ValidationPipe           (DTO validation)
        → Controller / Service     (@CurrentConsumer() gives the consumer)
```

## 项目结构

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

所有路由都在 `/v1` 下进行版本化（URI 版本控制）。

每个路由及其 scope 都列在下方的[路由索引](#路由索引)中。**请求和响应的 schema 位于生成的 OpenAPI 契约中**，该契约在每次 CI 运行时都会根据 controller 和 DTO 重新生成（一旦出现偏差，`npm run openapi:check` 会让构建失败）：

- `openapi/openapi.json` / `openapi/openapi.yaml` — 已提交到仓库，可在 diff 中审查
- `/docs` — Swagger UI，当 `SWAGGER_ENABLED=true` 时启用
- `/docs/json`、`/docs/yaml` — 实时提供的同一份规范

| 领域 | 基础路径 | 功能 |
| ----------------- | ------------------------ | -------------------------------------------------------- |
| 支付意图 | `/v1/payment-intents` | SEP-7 `tx` / `pay` 意图、验证、链上观察器 |
| Swap | `/v1/swaps` | 路径支付报价、构建未签名 XDR、提交已签名交易 |
| 流动性池 | `/v1/liquidity-pools` | AMM 存入 / 取出、持仓、按收益收取佣金 |
| Webhooks | `/v1/webhooks` | 端点 CRUD、密钥轮换、投递记录、重新投递 |
| KYC | `/v1/kyc` | Receiver（KYC/KYB）、钱包、银行账户、文档上传 |
| Onramp | `/v1/onramp` | Payin 报价、payin、虚拟账户 |
| Offramp | `/v1/offramp` | Payout 报价、授权、payout（客户端签名） |
| 商品 | `/v1/products` | 商户商品目录 |
| 客户 | `/v1/customers` | 由支付意图派生的付款方记录 |
| 别名 | `/v1/aliases` | 可认领的支付标识：认领、解析、恢复 |
| 资产 | `/v1/assets` | 按网络划分的精选资产注册表 |
| Pollar | `/v1/pollar` | OAuth 桥接（社交登录 → 钱包）+ 运营方路由 |
| 分析 | `/v1/summary`, `/v1/balances`, `/v1/logs` | 仪表盘汇总与日志 |
| 活动 | `/v1/activity` | 客户端上报的事件：接收、事件流、汇总 |
| 管理 | `/v1/admin` | 跨租户读写 — 仅限平台控制台，全程审计 |
| 健康检查 | `/v1/health` | 存活 / 就绪（`@Public`） |

### 路由索引

本服务提供的全部路由。**Scope** 是 API key 必须持有的权限——*之一* 表示持有所列 scope 中的任意一个即可，`—` 表示任何已认证的 key 均可。**公共 key** 标记了共享公共 key 可以调用的路由（见[共享公共 API key](#共享公共-api-key)）。标记为*平台控制台*的路由完全不接受 API key；只有控制台后端能够访问它们。路径使用 OpenAPI 的 `{param}` 形式；如果契约中的某个路由在此表中缺失，`npm run readme:check` 会让 CI 失败。

| 方法 | 路径 | Scope | 公共 key |
| ------ | ---- | ----- | ---------- |
| GET | `/v1/activity/events` | `activity:read` |  |
| POST | `/v1/activity/events` | `activity:write` | ✓ |
| GET | `/v1/activity/summary` | `activity:read` |  |
| GET | `/v1/admin/audit-logs` | 平台控制台 |  |
| GET | `/v1/admin/consumers` | 平台控制台 |  |
| GET | `/v1/admin/customers` | 平台控制台 |  |
| GET | `/v1/admin/payins` | 平台控制台 |  |
| GET | `/v1/admin/payment-intents` | 平台控制台 |  |
| GET | `/v1/admin/payouts` | 平台控制台 |  |
| GET | `/v1/admin/products` | 平台控制台 |  |
| GET | `/v1/admin/receivers` | 平台控制台 |  |
| PATCH | `/v1/admin/receivers/{id}/access` | 平台控制台 |  |
| POST | `/v1/admin/receivers/{id}/approve` | 平台控制台 |  |
| POST | `/v1/admin/receivers/{id}/enable` | 平台控制台 |  |
| POST | `/v1/admin/receivers/{id}/tos` | 平台控制台 |  |
| GET | `/v1/admin/summary` | 平台控制台 |  |
| GET | `/v1/admin/swaps` | 平台控制台 |  |
| GET | `/v1/aliases` | `payments:read` |  |
| POST | `/v1/aliases` | `payments:write` |  |
| GET | `/v1/aliases/availability/{name}` | `payments:read` | ✓ |
| GET | `/v1/aliases/by-address/{address}` | `payments:read` | ✓ |
| POST | `/v1/aliases/challenges` | `payments:write` |  |
| GET | `/v1/aliases/resolve/{name}` | `payments:read` | ✓ |
| DELETE | `/v1/aliases/{name}` | `payments:write` |  |
| POST | `/v1/aliases/{name}/addresses` | `payments:write` |  |
| DELETE | `/v1/aliases/{name}/addresses/{addressId}` | `payments:write` |  |
| POST | `/v1/aliases/{name}/recovery` | 平台控制台 |  |
| POST | `/v1/aliases/{name}/recovery/complete` | `payments:write` |  |
| GET | `/v1/assets` | — | ✓ |
| GET | `/v1/balances` | `payments:read` |  |
| POST | `/v1/blindpay/webhooks` | 无 — `@Public()`，Svix 签名 |  |
| GET | `/v1/customers` | `customers:read` |  |
| POST | `/v1/customers` | `customers:write` |  |
| GET | `/v1/customers/{id}` | `customers:read` |  |
| PATCH | `/v1/customers/{id}` | `customers:write` |  |
| DELETE | `/v1/customers/{id}` | `customers:write` |  |
| GET | `/v1/health/liveness` | 无 — `@Public()` |  |
| GET | `/v1/health/readiness` | 无 — `@Public()` |  |
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
| GET | `/v1/liquidity-pools` | `liquidity:read`、`swaps:read` 之一 | ✓ |
| POST | `/v1/liquidity-pools/deposit` | `liquidity:write`、`swaps:write` 之一 | ✓ |
| GET | `/v1/liquidity-pools/operations` | `liquidity:read`、`swaps:read` 之一 |  |
| GET | `/v1/liquidity-pools/operations/{id}` | `liquidity:read`、`swaps:read` 之一 |  |
| POST | `/v1/liquidity-pools/operations/{id}/submit` | `liquidity:write`、`swaps:write` 之一 | ✓ |
| GET | `/v1/liquidity-pools/positions` | `liquidity:read`、`swaps:read` 之一 | ✓ |
| POST | `/v1/liquidity-pools/withdraw` | `liquidity:write`、`swaps:write` 之一 | ✓ |
| GET | `/v1/liquidity-pools/{poolId}` | `liquidity:read`、`swaps:read` 之一 | ✓ |
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
| GET | `/v1/pollar/oauth/callback` | 无 — `@Public()` |  |
| GET | `/v1/pollar/oauth/callback/{state}` | 无 — `@Public()` |  |
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

### 错误响应

所有失败都返回相同的响应结构，其中 `code` 是稳定的、机器可读的部分——请基于它做分支判断，而不是基于 `message`，后者是描述性文字，措辞可能会调整：

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

该响应结构及完整的 `code` 枚举以 `ApiErrorBodyEntity` 的形式发布在 OpenAPI 规范中，并附加到每个操作上——因此生成的客户端也能获得错误类型，你无需阅读本仓库即可了解这些错误码。事实来源是 `src/common/errors/api-error.ts` 中的 `ApiErrorCode`。**错误码一经发布便永不重命名**；可能会新增错误码，因此请把无法识别的错误码按其 HTTP 状态码处理。

几个容易混淆的错误码：

| 错误码 | 状态码 | 含义 |
| ---- | ------ | ----- |
| `insufficient_scope` | 403 | API key 缺少所需的 scope。请重新配置该 key |
| `account_disabled` | 403 | 运营人员停用了该法币账户。与 key 无关 |
| `gateway_required` | 403 | 请求并非经由 APISIX 到达 |
| `admin_console_only` | 403 | 该路由属于平台控制台（`/v1/admin`、发起别名恢复）。任何 API key 都无法调用 |
| `idempotency_conflict` | 409 | 该 `Idempotency-Key`（或支付意图的 memo）已经为一个*不同的*请求创建过资源。请重复原始请求，或改用新的 key |
| `kyc_state_invalid` | 409 | 非法的 KYC 状态转换——并非重复请求 |
| `operation_in_flight` | 409 | 一个与之冲突的操作仍在结算中 |
| `payload_expired` | 409 | 投递内容已超出保留期，无法重新发送 |
| `provider_unavailable` | 503/504 | BlindPay 或 Horizon 无法访问。请重试 |
| `misconfigured` | 503 | 服务端配置错误。重试无济于事 |

每个支付意图都会被**持久化**（`payment_intent` 表），并限定在经过认证的 APISIX 消费者范围内，因此读取/更新/删除只会作用于该消费者自己的记录——每个意图的生命周期都可完整追溯（`PENDING → SUBMITTED → SUCCEEDED/FAILED/CANCELLED/EXPIRED`）。

### 运行多个副本

APISIX 会在多个实例之间进行负载均衡，因此本服务中的每个 `setInterval` 在每个副本上都会各运行一次。正确性从来不是问题——每次状态变更都经过带条件的 `updateMany` compare-and-swap，只有一个写入方能够成功——但三个副本意味着针对一个有速率限制的 API，相同的工作要发起三倍的 Horizon 往返请求，而且多个副本会竞相删除同一批 `request_log` 行。

现在，每个后台定时器都会获取一个 PostgreSQL **事务级咨询锁（advisory lock）**（`AdvisoryLockService`，`src/common/services/advisory-lock.service.ts`），当另一个副本持有该锁时就跳过本轮执行：

| 定时器 | 锁键 |
| ------------------------------ | ------------------------ |
| `SettlementObserverService`    | `SettlementObserver`     |
| `StellarObserverService`       | `PaymentIntentObserver`  |
| `RequestLogRetentionService`   | `RequestLogRetention`    |
| Webhook 投递清扫器             | `WebhookDeliverySweeper` |
| `PollarOauthSweeperService`    | `PollarOauthSweeper`     |
| `RateLimitPruneService`        | `RateLimitPrune`         |
| `PollarWalletProvisionSweeperService` | `PollarWalletProvisionSweeper` |
| `AliasChallengeSweeperService` | `AliasChallengeSweeper`  |

之所以使用 `pg_try_advisory_xact_lock` 而不是会话级的变体，有三个原因：它从不阻塞（抢锁失败的副本直接跳过，这正是轮询器想要的）；它在事务结束时释放——包括崩溃或连接断开的情况，因此被杀掉的 pod 无法把锁卡死；也正因如此，它在事务池模式的 PgBouncer 之后依然正确，而在该模式下会话级锁并不安全，因为连接不是固定分配的。

锁 id 定义在 `AdvisoryLockKey` 枚举中，它们就是任务的身份：给某个成员改名并换用新编号会悄无声息地让互斥失效，因此已退役的编号永不复用。

### 支付验证与链上观察器

支付只在一个地方（`StellarVerifierService`）根据 Stellar 网络进行确认：交易必须**成功**；必须包含一笔发往意图 `destination` 的**原生（XLM）支付**且**金额完全一致**；当意图带有 memo 时，必须带有**匹配的 memo**（`memo_type: id`）；并且其关闭时间**不得早于意图创建前一分钟**（`TX_CREATED_AT_SKEW_MS`）。正是这个时间下限，阻止了一笔条款相同的旧链上支付去结算一个新的意图。

有两条路径使用这同一条规则：

- **手动：** `POST /v1/payment-intents/:id/validate`，请求体为 `{ "txHash": "<64-hex>" }`。匹配时，意图被置为 `SUCCEEDED`（并保存 `txHash`），同时触发 `PAYMENT_INTENT_SUCCEEDED` webhook。链上失败的交易**只有在它确实是该意图自己的支付时**——memo、目标地址和资产均相同——才会把意图标记为 `FAILED`。其他任何交易，无论失败与否，都属于不匹配，状态保持不变，以便仍可提交正确的交易；否则，网络上任意一笔失败交易的哈希都能让一个意图永久失败。
- **自动（常驻观察器）：** `StellarObserverService` 每隔 `OBSERVER_INTERVAL_MS` 轮询一次 Horizon，查找 `PENDING` 状态的意图——按上报的 `txHash`，或扫描发往目标地址的支付——并以同样的方式终结匹配的意图，因此状态会变化、事件会触发，**无需任何人调用 API**。每个周期对每个消费者最多处理 `OBSERVER_MAX_INTENTS_PER_CONSUMER`（10）个意图，且从不扫描已过期的意图，因此来自某一个消费者的洪泛——包括共享公共 key——无法让其他所有人的结算陷入饥饿。本地开发时可用 `OBSERVER_ENABLED=false` 关闭。

### API 请求日志的保留期

除 `/v1/health` 和 `/docs` 之外，每个入站请求都会由 `LoggingInterceptor` 追加到 `request_log`，并为仪表盘的 **API 日志**视图（`GET /v1/logs`）提供数据。每行包含路径、状态码、耗时，以及——如果存在——付款方的 `ip` / `userAgent`。

仪表盘流量（`X-Cosmos-Internal`）会被**记录并打上标记**（`request_log.internal`），而不是被跳过，API 日志视图基于该列进行过滤。早期版本一看到该请求头就提前返回，这意味着任何能设置它的人都可以让自己的请求完全不出现在审计日志中——请求头绝不能让流量隐身。

这些行**不会永久保留**。`RequestLogRetentionService` 通过定时器（`REQUEST_LOG_PRUNE_INTERVAL_MS`，默认 **1h**）删除早于 `REQUEST_LOG_RETENTION_DAYS`（默认 **30**）的行。每个周期以较小的 `REQUEST_LOG_PRUNE_BATCH_SIZE` 分块删除（默认 **1000**），并持续循环，直到积压清空或达到 `REQUEST_LOG_PRUNE_MAX_PER_CYCLE`（默认 **50000**），这样大量历史数据可以逐步清理完毕，而无需长时间持有表锁。设置 `REQUEST_LOG_RETENTION_DAYS=0` 可完全禁用清理（服务会在启动时记录这一点）。`(consumer, createdAt)` 上的复合索引可在数据量增长时保持仪表盘查询的速度。

### 客户端活动（钱包和仪表盘上报的内容）

`request_log` 记录的是到达本服务的内容。它无法记录客户端*做了*什么：在发送页面崩溃的钱包、被用户取消的签名、在任何请求离开浏览器之前就抛出异常的仪表盘页面。这些都不会在这里产生 HTTP 调用，而它们恰恰是出问题时最值得掌握的事件——因此客户端会自行上报，发送到 `POST /v1/activity/events`。

- **批量发送，而不是每个事件调用一次。** 客户端先排队再批量刷新，因此离线的钱包会保留事件，并在下次启动时发送。每个请求最多 `ACTIVITY_MAX_BATCH`（100）条，在一条语句中写入。
- **重试刷新是安全的。** 事件可以携带客户端自己的 `eventId`；`(consumerId, eventId)` 是唯一的，插入时会跳过重复项，因此一个已经写入、但确认从未送达的批次可以重新发送，而不会让每一行都翻倍。响应会报告 `accepted` 和 `duplicates`。
- **归属由网关决定，而非请求体。** 行会写在 APISIX 认证过的消费者名下。客户端无法以另一个账户的名义提交事件，也没有任何字段可以让它尝试这样做。
- **接收不会因 payload 的格式而失败。** 过长的 `message` 会被截断，过大的 `props` 会被替换为 `{"_dropped": "props_too_large"}`；返回 400 会让整个批次作废，而当客户端处于无人预料的状态时，这个批次恰恰最重要。
- **错误的设备时钟无法打乱事件流的顺序。** 当 `occurredAt` 比接收时间快五分钟以上或慢七天以上时，会被钳制为接收时间，因此一台时钟快了一小时的手机无法把自己的事件钉在按最新优先排序的列表顶部。两个时间都会保留：`at`（客户端的时间）和 `receivedAt`。

读取这些数据：

| 路由 | Scope | 返回 |
| ----------------------- | ----------------- | -------------------------------------------------------------------- |
| `GET /v1/activity/events` | `activity:read` | 事件流，最新的在前。过滤条件：`source`、`level`、`category`、`type`（前缀）、`network`、`since`/`until` |
| `GET /v1/activity/summary` | `activity:read` | 按 level/source/category 的计数、最常见的事件类型、最常见的错误、会话、设备、按日序列 |

事件流上的 `level` 是一个**下限**，而不是精确匹配：`level=warn` 会返回警告*和*错误。如果过滤只返回被标记为 `error` 的行，就会隐藏引发这些错误的警告。

`activity_event` 保存 IP、user agent 以及客户端附加的任何内容，因此它由同一个任务、以与 `request_log` 相同的有界批次进行清理——`ACTIVITY_RETENTION_DAYS`，默认 **30**，设为 `0` 则永久保留事件。

### Webhooks（通知集成方）

每个集成方（APISIX 消费者）可以注册一个或多个 webhook 端点。当支付意图发生变化时，平台会触发一个领域事件；**分发器（dispatcher）**会将其扇出到该消费者所有已启用、且订阅了该事件类型的端点（订阅为空 = 全部），记录每次尝试以便追溯，并按线性退避进行重试（`WEBHOOK_*` 环境变量）。

事件类型：`PAYMENT_INTENT_CREATED`、`PAYMENT_INTENT_UPDATED`、`PAYMENT_INTENT_SUCCEEDED`、`PAYMENT_INTENT_FAILED`、`PAYMENT_INTENT_CANCELLED`、`PAYMENT_INTENT_DELETED`、`SWAP_CREATED`、`SWAP_SUBMITTED`、`SWAP_SUCCEEDED`、`SWAP_FAILED`、`LIQUIDITY_CREATED`、`LIQUIDITY_SUBMITTED`、`LIQUIDITY_SUCCEEDED`、`LIQUIDITY_FAILED`，以及来自 BlindPay 的 `RECEIVER_UPDATED`、`PAYIN_CREATED`、`PAYIN_UPDATED`、`PAYIN_COMPLETED`、`PAYOUT_CREATED`、`PAYOUT_UPDATED` 和 `PAYOUT_COMPLETED`。权威列表是 `prisma/schema.prisma` 中的 `WebhookEventType` 枚举。

**来自 BlindPay 的事件体包含什么。** `RECEIVER_UPDATED` / `PAYIN_*` / `PAYOUT_*` 只携带标识和状态——id、状态、金额、支付通道——绝不包含个人数据。服务商对象*不会*原样转发：receiver 的 payload 是一份完整的 KYC 档案（税号、出生日期、地址、证件链接），而订阅事件只需要 `webhooks:write`，这会让 webhook 变成把这份档案投递到任意主机的途径。请使用持有 `kyc:read` / `onramp:read` / `offramp:read` 的 key 通过 API 获取详细信息。确切的字段白名单见 `src/blindpay/blindpay-event-redaction.ts`。

投递通过 NestJS `EventEmitter2`（`webhook.event`）解耦，因此发出通知永远不会阻塞触发它的 API 请求。

**出站目标策略（SSRF）：** 端点必须使用 `https`，且只能解析到公网地址。注册时会拒绝回环地址、RFC1918 私有地址段、链路本地地址（`169.254.0.0/16`，包括云元数据地址 `169.254.169.254`）以及已知的元数据主机名。每次投递之前会立即再次执行同样的检查（注册之后 DNS 可能发生变化）。HTTP 客户端使用 `redirect: manual`（从不跟随 `3xx`）、来自环境变量的连接/读取超时，以及响应体大小上限。

| 变量 | 默认值 | 含义 |
| -------- | ------- | ------- |
| `WEBHOOK_CONNECT_TIMEOUT_MS` | `3000` | 连接时间预算（AbortSignal 超时的一部分） |
| `WEBHOOK_READ_TIMEOUT_MS` | `5000` | 读取时间预算（AbortSignal 超时的一部分） |
| `WEBHOOK_MAX_RESPONSE_BYTES` | `65536` | 读取响应体的字节上限 |
| `WEBHOOK_TIMEOUT_MS` | `5000` | 未设置拆分超时时使用的旧版回退值 |
| `WEBHOOK_MAX_ATTEMPTS` / `WEBHOOK_BACKOFF_MS` | `3` / `2000` | 进程内重试循环，按每次投递尝试计 |
| `WEBHOOK_SWEEP_ENABLED` | `true` | 恢复因崩溃而滞留的投递。事故开关——当某个集成方的服务正在崩溃时，设为 `false` 可停止向其重新投递 |
| `WEBHOOK_SWEEP_INTERVAL_MS` | `60000` | 副本尝试清扫的频率（每个周期只有一个副本胜出） |
| `WEBHOOK_PAYLOAD_RETENTION_DAYS` | `30` | 超过该期限后，已结束投递的存储内容会被替换为脱敏标记。`0` 表示永久保留 |

**实际的尝试上限是 9 次，而不是 3 次。** `WEBHOOK_MAX_ATTEMPTS` 限制的是一次进程内重试循环。随后清扫器会接手总尝试次数仍在 `WEBHOOK_MAX_ATTEMPTS × 3` 以内的投递，因此一次投递最多可以在数小时内被尝试九次。这是有意为之——过去，一个在退避期间被杀掉的 pod 会让一条 PENDING 投递永远滞留，结果就是一笔已结算的支付没有通知任何人。

**在保留期内，重新投递是尽力而为的。** 超过 `WEBHOOK_PAYLOAD_RETENTION_DAYS` 后，存储的内容会被清除（`RECEIVER_UPDATED` 的内容是一份 KYC 档案，而投递日志会被保留）。清扫器会跳过这些行，`POST /v1/webhooks/:id/deliveries/:id/redeliver` 会返回 `409 payload_expired`，而不是以真实的事件类型和有效的签名发送一份已脱敏的内容。

**接收方约定。** 任何 `2xx` 都视为确认。请在 `WEBHOOK_READ_TIMEOUT_MS`（默认 5s）内响应。不保证顺序，因此请把事件当作一个集合，并通过 API 进行对账。基于事件 `id` 去重——注意重新投递会复用原始 `id`，因此严格去重的接收方会忽略它；这是有意的取舍（至少一次投递，恰好一次生效）。

**迁移现有端点：** 部署后运行

```bash
npm run webhooks:audit-destinations
```

不安全的行会被设置为 `destinationBlocked=true` 和 `enabled=false`。集成方可以通过 `PATCH /v1/webhooks/:id` `{ "url": "https://…" }` 修正 URL（校验会再次执行并清除该标记），或者在 DNS 解析为公网地址后重新启用。

**Payload**（发送到集成方 URL 的 POST 请求体）：

```jsonc
{
  "id": "evt_...",                 // stable event id (use for idempotency)
  "type": "PAYMENT_INTENT_SUCCEEDED",
  "createdAt": "2026-...",
  "data": { /* the payment intent */ }
}
```

**请求头**：

- `X-Cosmos-Signature: t=<unixSeconds>,v1=<hexHmacSha256>` — 使用端点的 `whsec_...` 密钥对 `${t}.${rawBody}` 计算的 HMAC-SHA256。
- `X-Cosmos-Event`、`X-Cosmos-Event-Id`、`X-Cosmos-Delivery`。

**验证签名（集成方侧）：**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody: string, header: string, secret: string): boolean {
  const [t, v1] = header.split(',').map((p) => p.split('=')[1]);
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
```

签名密钥只在 `POST /webhooks`（以及 `rotate-secret`）时返回**一次**；列表/详情响应中永远不会包含它。每次尝试都会被存储（`webhook_delivery`），包含状态、尝试次数、响应码和错误——可通过 `GET /webhooks/:id/deliveries` 查询，并用 `redeliver` 路由重新发送。

### OpenAPI / Swagger

**安全提示：** `GET /docs`、`/docs/json` 和 `/docs/yaml` 由 `SwaggerModule.setup` 以 **Express 中间件**的形式挂载，而不是 Nest controller。它们**不会**经过 `ApisixGuard` 或 `PermissionsGuard`——除非禁用文档，否则任何能访问服务端口的人都可以获取完整的 API 规范。在生产环境中，文档**默认关闭**（`NODE_ENV=production` 且未设置 `SWAGGER_ENABLED`）。只有当你确实希望在受信任的网络中发布规范时，才设置 `SWAGGER_ENABLED=true`。

实时文档（启用时）：

- `GET /docs` — Swagger UI
- `GET /docs/json` — OpenAPI 3.0 规范（JSON）
- `GET /docs/yaml` — OpenAPI 3.0 规范（YAML）

将规范导出为文件（以便其他服务器托管/使用）——不需要数据库连接，也不需要真实的网关密钥；当这些环境变量缺失时，它会以 Nest 预览模式、使用本地占位值运行：

```bash
npm run openapi:generate
# writes openapi/openapi.json and openapi/openapi.yaml
```

CI 和发布门禁会重新生成这两个已提交的文件，并拒绝任何偏差。提交 controller 或 DTO 的变更之前，请运行同样的检查：

```bash
npm run openapi:check
```

规范中的路径已经包含版本（`/v1/...`）。若要把具体的网关主机写入规范的 `servers`，请在生成之前设置 `OPENAPI_SERVER_URL`：

```bash
OPENAPI_SERVER_URL=https://gateway.example.com npm run openapi:generate
```

Swagger 配置（`src/swagger.ts`）由运行中的服务器和生成器共享，因此两者保持同步。两个 APISIX 请求头（`X-Gateway-Secret`、`X-Consumer-Username`）在规范中被记录为安全方案（security scheme）。

### 创建支付意图 — 两种 SEP-7 操作，两个端点

根据 [SEP-7](https://stellar.org/protocol/sep-7)，`tx` 和 `pay` 操作接受**不同的参数**并产生**不同的响应**，因此各自拥有独立的端点、DTO 和响应 schema。本服务不持有任何密钥——它只为客户端的钱包组装请求（返回 `uri` + `qr`，`tx` 还会返回 `xdr`）。省略 `assetCode`（或其值为 `XLM`/`native`）时，资产默认为**原生 XLM**；其他任何资产都需要 `assetIssuer`。

**网络由网关转发的 API key 类型决定**：`prod` key → public（主网），`dev` key → testnet。`STELLAR_NETWORK` 只是没有网关的本地开发环境中的回退值。每个意图都会存储自己的网络，所有 Horizon 调用（构建、验证、观察器）都以该网络为目标。

**memo 是必需的 `MEMO_ID`**——它在链上标识这笔支付，并赋予意图**幂等性**：`(consumer, memo)` 是唯一的，因此使用相同的 memo **且相同的条款**再次创建会返回原来的意图。相同的 memo 搭配任何不同的条款——类型（kind）、网络、目标地址、金额、资产、`msg`、`callback`，或 `tx` 的 `source`——都会返回 `409 idempotency_conflict`，且该错误不会透露已存储意图的任何信息。之所以要做这项比较，是因为共享公共 key：每个匿名钱包都是同一个消费者，没有这项比较时，别人先用过的 memo 会把*他们的*意图交给你，附带一个付款给他们的二维码。如果不传 `memo`，会随机生成一个 uint64。

**`POST /v1/payment-intents/tx`** — 付款方（`source`）已知，因此我们构建未签名的 `TransactionEnvelope` 和一个 `web+stellar:tx?xdr=...` URI。

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

**`POST /v1/payment-intents/pay`** — 没有 source，因此我们只返回一个 `web+stellar:pay?destination=...` URI（由钱包选择源资产/路径）。

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

每个端点都在 OpenAPI 规范中记录了带示例 payload 的类型化响应（`TxPaymentIntentEntity`、`PayPaymentIntentEntity`、`ValidationOutcomeEntity`），因此 Swagger 显示的是具体的示例响应，而不是空的响应体。

响应：

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

网络/Horizon/手续费/超时通过 `STELLAR_*` 环境变量配置（见 `.env.example`）。出于安全考虑，默认使用 **testnet**——设置 `STELLAR_NETWORK=public` 以使用主网（真实资金）。

## 共享公共 API key

钱包是开源的，并内置了一个所有人都持有的 API key，因此用户无需注册即可进行 swap、添加流动性或创建支付链接。他们需要支付 `community` 套餐的佣金——150 bps，是所有套餐中最高的费率——而注册才能换来更低的费率。网关按消费者注入费率的方式与私有 key 完全相同（见 `resolvePlanCommissionBps`），因此这里没有针对定价的任何特殊处理。

*真正*特殊的是租户隔离。网络上的每个匿名调用方都以同一个 APISIX 消费者的身份到达，而读取端点恰恰是按这个消费者来过滤行的：

```ts
// swaps.service.ts
where: { id, consumer: { apisixUsername: consumer.username } }
```

因此，在公共 key 下调用 `GET /v1/swaps` 会把整个匿名群体的 swap 历史交给每一个匿名用户。scope 无法解决这个问题——scope 是 key 的属性，而他们持有的是同一个 key——而且这种重叠并非假设：`POST /v1/swaps/quote` 需要 `swaps:read`，而列出历史记录用的正是同一个 scope。

**因此 `PublicKeyGuard` 是白名单，而不是黑名单。** 公共消费者在所有未标注 `@AllowPublicKey()` 的路由上都会被拒绝，所以明年新增的路由，在有人于同一个 diff 中明确声明之前，公共 key 都无法访问。忘记加装饰器只会带来一张支持工单；忘记加黑名单条目则会造成数据泄露。

目前公共 key 可以访问的路由：

| 路由 | 为什么安全 |
| --- | --- |
| `POST /v1/swaps/quote` | 通过 Horizon 为路径定价；结果完全由请求决定 |
| `POST /v1/swaps` | 构建一个由调用方签名的未签名信封 |
| `POST /v1/swaps/:id/submit` | 广播调用方签名的信封——需要该 swap 的 UUID *以及*其源账户的签名 |
| `POST /v1/liquidity-pools/deposit` \| `withdraw` | 构建未签名信封 |
| `POST /v1/liquidity-pools/operations/:id/submit` | 广播调用方签名的信封 |
| `GET /v1/liquidity-pools` \| `/:poolId` \| `/positions` | 从 Horizon 读取的公开链上数据 |
| `POST /v1/payment-intents/tx` \| `pay` | 根据请求构建 SEP-7 意图 |
| `POST /v1/activity/events` | 遥测数据接收——见下文 |
| `GET /v1/assets` | 公开的资产目录 |
| `GET /v1/aliases/resolve/:name` \| `availability/:name` \| `by-address/:address` | 解析标识的付款方正是这个 key 所服务的匿名调用方；答案完全由请求决定，且从不包含所有者的邮箱 |

有意拒绝的路由：`GET /v1/swaps`、`GET /v1/swaps/:id`、`GET /v1/liquidity-pools/operations{,/:id}`、`GET /v1/activity/events`、`GET /v1/activity/summary`、所有支付意图读取、所有别名所有者路由（认领、列出、添加或移除地址、释放、恢复），以及 `/v1/kyc`、`/v1/onramp`、`/v1/offramp` 和 `/v1/webhooks` 下的所有路由。没有账户的钱包改为从 Horizon 构建自己的历史记录，而 Horizon 本来就是链上活动的权威来源。

**遥测是特意列入白名单的。** 没有 CosmosPay 账户的钱包同样会崩溃，拒绝它的错误报告会让我们对恰恰最容易遇到首次运行故障的群体一无所知——接收路由会返回 `403`，报告会被丢弃。通过这个 key 到达的事件在构造上就是匿名的（一个共享消费者），因此不得携带任何能识别账户的信息；钱包在发送之前会去除地址、目标、金额和 txHash。

guard 通过**以下任一**信号识别公共消费者：转发的角色（`X-Consumer-Role: public`）**或**配置的 `APISIX_PUBLIC_CONSUMER` 用户名。之所以使用两个信号，是因为单独依赖其中任何一个，都会以牺牲用户数据为代价在失效时放行：网关一旦停止转发角色，就会把每个匿名调用方提升为普通租户；而从未设置该环境变量的部署，则会依赖一个它无法控制的请求头。两个都要设置。

## Stellar 原生 swap（路径支付）

Stellar 没有专门的“swap”操作。资产兑换通过 **`PathPaymentStrictSend`** 完成，Horizon 会自动在 **Stellar DEX 订单簿**和 **AMM 流动性池**的可用组合中选择最优路由。Cosmos Pay 将其封装为一个 swap 流程，与支付意图一样，**完全非托管**——资金从不经过本服务。它只做三件事：

1. **报价**：查询 Horizon 的 strict-send 路径搜索。
2. **构建**未签名交易（一笔可选的平台手续费支付 + 路径支付），并返回其 `xdr` + SEP-7 `tx` URI + 二维码。
3. **转发**客户在自己钱包中签名的交易。

```
quote → build XDR → customer signs in wallet → POST /submit → Stellar executes
```

网络由 API key 类型决定（prod → public，dev → testnet），与支付意图相同；每个 swap 都会被**持久化**（`swap` 表），并限定在发起调用的消费者范围内（`PENDING → SUBMITTED → SUCCEEDED/FAILED`）。

**手续费（按组织计，在服务端强制执行）。** 佣金是**发起调用的组织所属套餐的费率**，由网关以受信任请求头（`X-Plan-Swap-Fee-Bps`）的形式注入，开发者平台根据组织的套餐推导出该值。它**从不是请求参数**，而且 APISIX 会覆盖客户端提供的任何副本，因此费率无法被绕过或压低。手续费从**源资产**中扣除，作为第一个支付操作支付到平台钱包（`STELLAR_SWAP_FEE_WALLET`）；**剩余部分**通过 swap 进行路由。如果适用套餐手续费但未配置平台钱包，swap 创建会以 `503` 失败（运维配置错误）。`STELLAR_SWAP_FEE_BPS` 只是没有网关的本地开发环境中的回退值（未设置钱包时它本身也会被禁用）。

**滑点。** 报价的估算值减去 `slippageBps`（默认为 `STELLAR_SWAP_SLIPPAGE_BPS`，上限为 `STELLAR_SWAP_MAX_SLIPPAGE_BPS`）后，成为路径支付在链上的 `destMin`——因此 swap 宁可**回滚**，也不会交付少于调用方同意接受的数额。

**Trustline。** 非原生的目标资产必须已被目标账户信任；构建步骤会检查这一点，否则返回明确的错误。（XLM 不需要 trustline。）

**`POST /v1/swaps/quote`** — 仅报价，不持久化任何内容（`swaps:read`）。

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

**`POST /v1/swaps`** — 构建可签名的交易（`swaps:write`）。接受相同的字段，外加 `source`（付款/签名账户）；`destination` 默认为 `source`（自兑换），可选的 `memo`（MEMO_ID）会原样写入链上。

可选的**幂等**（issue #17）：发送 `Idempotency-Key` 请求头（推荐），或在请求体中发送 `idempotencyKey`。使用相同 key **且相同请求**——网络、源账户、目标账户、两种资产、金额、滑点和 memo——的重试会返回**已有的** swap（`id` + `txHash`），而不会再构建一笔 Stellar 交易。相同的 key 搭配任何不同的请求会返回 `409 idempotency_conflict`，且该错误不会透露已存储 swap 的任何信息。流动性存入和取出遵循相同的规则，并且还会比较操作的类型。之所以要做这项比较，是因为共享公共 key：每个匿名钱包都是同一个消费者，因此别人先用过的 key 会把*他们的*未签名信封交给你——而这个信封可能会把你的资金转给他们。没有 key 时，唯一约束 `(network, txHash)` 仍会以 **409** 拒绝字节级完全相同的重复构建（序列号 / XDR 冲突）。当 `STELLAR_SWAP_SINGLE_INFLIGHT=true` 时，同一 `(consumer, source, network)` 的第二个未过期的 `PENDING` swap 也会返回 **409**，并指明已有的 id（默认**关闭**——仍允许同一账户并发发起不同的 swap）。

```jsonc
// response → { id, status: "PENDING", network, sendAmount, feeAmount, swapAmount,
//              destEstimated, destMin, path, xdr, uri: "web+stellar:tx?xdr=…", qr, txHash, … }
```

**`POST /v1/swaps/:id/submit`** — 转发已签名的信封（`swaps:write`）。

```jsonc
// request
{ "signedXdr": "AAAAAgAAA…(signed base64 XDR)…" }
// response
{ "submitted": true, "status": "SUCCEEDED", "txHash": "…", "swap": { … } }
// on a network rejection → { "submitted": false, "status": "FAILED", "reason": "…", "resultCodes": ["op_under_dest_min"], "swap": { … } }
```

在广播之前，已签名交易的哈希会与服务所构建交易的哈希进行比对，因此调用方永远无法让服务转发任意交易。swap 会通过同一个分发器触发 `SWAP_CREATED` / `SWAP_SUBMITTED` / `SWAP_SUCCEEDED` / `SWAP_FAILED` webhook 事件。

## 别名 — 可认领的支付标识

别名让付款方可以输入 `emanuel250`，而不是 `GA5ZSE…`。它也是付款方在授权转账之前最后读到的内容，因此下面的每条规则之所以存在，是因为一旦出错，产生的不是一行错误数据——而是一笔以付款方所信任的名称、打到错误账户的付款。

### 通过证明对密钥的控制来认领，而不是靠申请

```
wallet ──1. POST /v1/aliases/challenges {name, address, network} ──▶ nonce + the EXACT message to sign
wallet ──2. signs SHA-256(domain ‖ 0x00 ‖ uint32be(length) ‖ message) with that address's key
wallet ──3. POST /v1/aliases {name, email, nonce, signature} ────────▶ alias bound to the calling consumer
```

- **服务返回待签名的消息；客户端从不自行重建。** 根据文档自行拼装消息的客户端，只要字段顺序改变一次，签名就会被拒绝，而且双方都不会有任何提示说明原因。
- **签名覆盖的是带域标签的摘要，绝不是交易。** 该流程要求钱包签名的任何内容都无法提交到网络，而且域（`Cosmos Pay alias claim v1`）专属于本功能，因此诱骗用户签署任意消息的 dapp 无法借此获得有效的认领。
- **用途包含在被签名的字节中**（`CLAIM`、`ADD_ADDRESS`、`RECOVER`），因此为添加地址而收集的签名无法被重放来完成恢复。
- **地址来自 challenge，而不是认领请求体。** 认领请求没有地址字段，因此没有人能为一个地址签名、却注册另一个地址。
- **challenge 是一次性的，有效期五分钟。** 签名在 challenge 被消耗*之前*验证，因此无效签名无法烧掉竞争者正在进行中的 nonce；而消耗操作是一次 compare-and-swap，因此两个请求无法同时消耗同一个 challenge。
- **竞争由 `alias.name` 上的唯一索引裁决**，而不是靠预检查；落败的一方收到 `409 alias_taken`。

### 标识的命名规则

小写 `a-z`、`0-9` 和 `_`（不能位于首尾），3–32 个字符，在判定唯一性之前统一转为小写。不允许 Unicode：同形字符的集合是无界的，没有任何规范化能让西里尔字母 `а` 显示在金额旁边时变得安全。同样会被拒绝的还有：可能冒充产品或运营方的保留词（`admin`、`support`、`cosmospay`、`stellar`……），以及任何看起来像 Stellar 账户的名称（`g` 或 `m` 后跟 20 个或更多 base32 字符）。规则位于 `src/aliases/alias-name.ts`。

### 多个地址，一个名称

一个别名最多可以指向跨网络的 20 个地址——手机、桌面端、冷钱包、testnet——且每个网络恰好有一个主地址，由部分唯一索引强制保证。添加地址需要**两项**证明：调用方拥有该别名，并且新地址对它自己的 `ADD_ADDRESS` challenge 进行签名。最后一个剩余的地址无法被移除（请改为释放别名），且一个消费者最多可持有 25 个别名。

处于 `SUSPENDED` 状态的别名——即运营方冻结——不会解析到任何地址。一个仍然给出账户的冻结，对资金毫无作用。

### 恢复经由邮箱，并经由平台控制台

密钥会丢失，而丢失的密钥不能让一个名称永远无法访问，因此认领时会记录一个恢复邮箱。这使得恢复成为该模块中最危险的路径：

1. **平台控制台**调用 `POST /v1/aliases/:name/recovery {email}`。无论标识与邮箱是否匹配，响应都完全相同；匹配时，响应会携带一个一次性 token（30 分钟，仅以 SHA-256 形式存储），由控制台通过邮件发送。本服务不发送任何邮件。
2. 用户为新密钥获取一个 `RECOVER` challenge，并使用自己的 API key 调用 `POST /v1/aliases/:name/recovery/complete {token, address, network, nonce, signature}`。两项证明缺一不可：token 证明邮箱，签名证明密钥。
3. 所有权转移到发起调用的消费者，并且**之前的所有地址都会被删除**。恢复之所以存在，是因为旧密钥已经丢失；如果让它们继续可解析，持有这些密钥的人就会继续收到付款。

**为什么第 1 步属于控制台。** token *就是*邮箱控制权的证明，因此它只能到达负责投递邮件的一方。该路由过去接受任何持有 `payments:write` 的 key，并把 token 返回给任何请求者——因此任何知道某个标识及其所有者邮箱的人，都能夺走该别名以及发往它的每一笔付款。现在 `ConsoleOnlyGuard` 会在查找别名之前，就以 `403 admin_console_only` 拒绝所有 API key 调用方，并且该路由不会出现在发布的契约中。五次错误的 token 会作废一次恢复（所有者只需重新发起；攻击者无法通过故意失败来锁定一个名称），且被冻结的别名无法被恢复。

过期的 challenge 和恢复记录会在过期一天后由 `AliasChallengeSweeperService` 删除（每小时一次，每个周期只有一个副本执行）。

### 路由

| 方法 | 路径 | Scope | 说明 |
| ------ | ---- | ----- | ----------- |
| GET | `/v1/aliases/resolve/:name` | `payments:read` · 公共 key | 别名解析到的地址（可用 `?network=` 过滤） |
| GET | `/v1/aliases/availability/:name` | `payments:read` · 公共 key | 某个标识是否可认领，如不可认领则说明原因 |
| GET | `/v1/aliases/by-address/:address` | `payments:read` · 公共 key | 指向某个地址的别名 |
| POST | `/v1/aliases/challenges` | `payments:write` | 一个 nonce 以及需要签名的确切消息 |
| POST | `/v1/aliases` | `payments:write` | 通过签名认领别名 |
| GET | `/v1/aliases` | `payments:read` | 调用方的别名 |
| POST | `/v1/aliases/:name/addresses` | `payments:write` | 添加地址，由该地址签名 |
| DELETE | `/v1/aliases/:name/addresses/:addressId` | `payments:write` | 移除地址 |
| DELETE | `/v1/aliases/:name` | `payments:write` | 释放别名 |
| POST | `/v1/aliases/:name/recovery` | _仅限平台控制台_ | 发起恢复 → 一个供控制台通过邮件发送的 token |
| POST | `/v1/aliases/:name/recovery/complete` | `payments:write` | 使用 token 和新密钥的签名完成恢复 |

## BlindPay — onramp / offramp / KYC（法币 ⇄ 稳定币）

除了链上支付意图之外，本服务还集成了 [BlindPay](https://www.blindpay.com/docs)，用于在**法币与稳定币**之间转移资金：入金（**onramp / payin**）、出金（**offramp / payout**），以及两者背后必需的 **KYC**（BlindPay *receiver*）。我们运行**单个平台级 BlindPay 实例**（环境变量中的 `BLINDPAY_API_KEY` + `BLINDPAY_INSTANCE_ID`）；每个 receiver/钱包/银行账户/payin/payout 都会镜像到我们的 Postgres 中，并**限定在发起调用的 APISIX 消费者范围内**，因此每个集成方只能看到自己的记录。本服务**从不持有区块链密钥**——offramp 返回需要签名的内容（EVM `approve` 合约 / Stellar XDR），并接收签名后的交易，与支付意图完全一样。

状态变更通过 BlindPay 的 **Svix webhook** 同步（基于原始请求体验证），并通过现有的分发器以新的事件类型（`RECEIVER_UPDATED`、`PAYIN_*`、`PAYOUT_*`）**重新发送**到集成方自己的 webhook 端点。

| 方法 | 路径                                                  | Scope          | 说明 |
| ------ | ----------------------------------------------------- | -------------- | ----------- |
| POST   | `/v1/kyc/receivers`                                   | `kyc:write`    | 创建 receiver（开始 KYC/KYB） |
| GET    | `/v1/kyc/receivers` · `/:id`                          | `kyc:read`     | 列表 / 详情（获取详情时会刷新 KYC 状态） |
| PATCH  | `/v1/kyc/receivers/:id`                               | `kyc:write`    | 更新 receiver |
| DELETE | `/v1/kyc/receivers/:id`                               | `kyc:write`    | 删除 receiver |
| POST   | `/v1/kyc/upload`                                      | `kyc:write`    | 上传 KYC 文档 → `file_url` |
| GET    | `/v1/kyc/rails` · `/v1/kyc/bank-details?rail=`        | `kyc:read`     | 支付通道目录 / 必填字段 |
| POST   | `/v1/kyc/receivers/:id/wallets`                       | `kyc:write`    | 注册区块链钱包 |
| GET    | `/v1/kyc/receivers/:id/wallets/sign-message`          | `kyc:read`     | 待签名消息（安全 EOA 流程） |
| POST   | `/v1/kyc/receivers/:id/bank-accounts`                 | `kyc:write`    | 添加法币银行账户（任意支付通道） |
| POST   | `/v1/onramp/quotes`                                   | `onramp:write` | 为 payin 报价（约 5 分钟后过期） |
| POST   | `/v1/onramp/payins`                                   | `onramp:write` | 创建 payin → 入金指引 |
| GET    | `/v1/onramp/payins` · `/:id`                          | `onramp:read`  | 列表 / 详情（获取详情时会刷新状态） |
| POST   | `/v1/onramp/trustline`                                | `onramp:write` | 构建未签名的 Stellar trustline XDR |
| POST   | `/v1/onramp/receivers/:id/virtual-accounts`           | `onramp:write` | 创建虚拟账户 |
| POST   | `/v1/offramp/quotes`                                  | `offramp:write`| 为 payout 报价（EVM → `approve` 合约） |
| POST   | `/v1/offramp/payouts/authorize`                       | `offramp:write`| 构建未签名的 Stellar/Solana payout 交易 |
| POST   | `/v1/offramp/payouts`                                 | `offramp:write`| 根据报价创建 payout |
| GET    | `/v1/offramp/payouts` · `/:id`                        | `offramp:read` | 列表 / 详情（获取详情时会刷新状态） |
| POST   | `/v1/offramp/payouts/:id/documents`                   | `offramp:write`| 附加合规文件 |
| POST   | `/v1/blindpay/webhooks`                               | _公开_         | 入站 BlindPay（Svix）webhook |

金额是**以最小货币单位表示的整数**（例如 `$123.45` → `12345`）。请在 BlindPay 仪表盘中将 webhook 配置为 `<gateway>/v1/blindpay/webhooks`，并将 `BLINDPAY_WEBHOOK_SECRET` 设置为该端点的签名密钥。将 `BLINDPAY_*` 变量留空即可禁用该功能（相关路由返回 `503`）。见 `.env.example`。

### KYC 重定向 URL 按消费者设置白名单

服务条款流程会把用户引导到 BlindPay，再返回到集成方提供的 `redirect_url`。如果把它当作任意字符串接受，那就是一个披着平台名义的开放重定向：一个从受信任的 KYC 页面出发、却落到攻击者任意选择之处的链接。因此每个 `redirect_url` 都要经过两层检查：

| 层 | 规则 | 位置 |
| ----- | ---- | ----- |
| 格式 | 绝对 `https` URL，且不含内嵌凭证（`user:pass@`） | 所有携带该字段的 DTO 上的 `@IsRedirectUrl()` |
| 主机 | 位于**发起调用的消费者**的白名单中——完全相同的主机，或在标签边界上的子域名（`app.acme.com` 匹配 `acme.com`；`evilacme.com` 不匹配） | `KYC_REDIRECT_URL_WHITELIST`，在服务层强制执行 |

```
KYC_REDIRECT_URL_WHITELIST={"cosmos_acme":["acme.com","app.acme.com"]}
```

它**默认拒绝（fail closed）**：没有条目的消费者完全无法使用重定向，带末尾点号或 IDN 形式的主机会被拒绝，而不是被规范化。白名单按消费者划分，因为一个集成方担保的域名对另一个集成方毫无意义。每个接受 `redirect_url` 的入口都会检查它——发起、请求和批准服务条款，包括管理员批准，后者应用的是该 receiver 所属消费者的白名单。被拒绝的协议或主机返回 `400`。

## Pollar — 返回 Stellar 钱包的社交登录

[Pollar](https://docs.pollar.xyz/docs) 把 Google/GitHub 登录变成一个 Stellar 账户：它对用户进行身份验证、创建钱包、在 AWS KMS 中托管密钥、添加配置好的 trustline 并为储备金注资——用户永远不会看到助记词。本服务将其作为 **OAuth 桥接**对外提供，与游戏启动器或游戏主机在客户端本地完成 code 交换时所采用的形态相同。

### 为什么是桥接而不是透传

Pollar 的托管登录是为浏览器 SDK 设计的。它会把用户带到 `GET /auth/{provider}`，并附带 publishable key、客户端会话 id 和 `redirect_uri`——而这个重定向 URI 必须是**在 Pollar 注册过的**主机。钱包无法满足其中任何一项：监听临时端口的回环监听器或 `cosmospay://` 深度链接永远不可能是已注册的主机，而且组装这些参数需要钱包本不该经手的密钥和会话 id。

因此由桥接负责面向 Pollar 的那一半。钱包得到的是一份它早已熟悉的两步式约定——**发起授权，兑换 code**——除了这个 code 之外，它什么都不需要接收。

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

第 6 步正是这一切的意义所在：兑换响应还会携带 `publishable_key` 和 `api_base_url`，因此从那之后，钱包会直接针对虚拟钱包本身读取余额、构建并提交交易。**本服务从不代理这部分接口，也不持有任何能够这样做的密钥。**

### 获取 code 的两种方式

|                  | 重定向流程 | 轮询流程 |
| ---------------- | ------------------------------------------------ | ----------------------------------------------- |
| 钱包提供 | `redirect_uri`（必须在白名单中） | 无 |
| code 的到达方式 | 作为重定向上的 `?code=…&state=…` | 来自 `GET /v1/pollar/oauth/sessions/{state}` |
| 浏览器看到的 | 你自己的 URI | 一个简单的“可以关闭此窗口”页面——永远看不到 code |
| 适用场景 | 钱包有深度链接或回环监听器 | 两者都没有（自助终端、无界面环境、嵌入式视图） |

每次轮询都会签发一个新的 code 并让前一个作废，因此请兑换最近一次轮询得到的 code。这是从不存储有效凭证的自然结果：数据行只保存 code 的 SHA-256，而哈希无法被还原。

**优先使用轮询流程。** Pollar 不会把浏览器送回回调地址：无论用户拒绝还是同意授权，它的托管流程都会结束在自己的页面上——`www.pollar.xyz/auth/status`——而同意授权只会让客户端会话在 Pollar 一侧变为 `READY`。授权 URL 中携带的 `redirect_uri` 永远不会被访问，因此一个等待回调的握手会一直等到过期。

所以轮询路由会主动询问 Pollar，而不是等待通知：当握手处于 `pending` 时，它会检查客户端会话自身的状态，并在 Pollar 报告 `READY` 的那一刻推进握手——这正是兑换本就在等待的条件。钱包的约定没有变化；变化的是 `pending` 现在会自行结束。

由此引出两条运维注意事项：

- **回调路由依然存在，并且仍在 Pollar 注册。** 如果确实有重定向到达，它可以正常工作，而且重定向流程的握手依赖于它——否则那个流程没有地方存放 code。只是它不能成为发现登录的唯一途径。
- **每个握手最多每两秒向服务商询问一次**（`POLLAR_SESSION_PROBE_INTERVAL_MS`），这是一次对 `providerCheckedAt` 的 compare-and-swap，由所有副本共享。因此一个每秒轮询一次的钱包，每分钟只会向 Pollar 发出 30 个请求而不是 60 个，而该 key 的全部预算是 200。

如果某个握手的客户端会话已被 Pollar 否认（`INVALID_CLIENT_SESSION_ID`、`EXPIRED_CLIENT_ID`，或 `404`/`410`），它会立即以该错误码被关闭为 `failed`，而不是一直轮询到 TTL 耗尽。

### 一次登录，两个网络各一个钱包

Pollar 将主网和测试网作为两个独立的应用运行，使用两套独立的密钥对，因此一次托管登录只能在其 API key 所解析到的网络上生成钱包（`prod` → `public`，`dev` → `testnet`——见 `resolveNetwork`）。随后在不同环境之间切换的用户，在另一侧就没有钱包：他们在 testnet 上充值的地址并不是在主网上收款的地址，而第二个钱包最终会在他们第一次需要它的时刻才被创建，而那恰恰是最承受不起服务商故障的时刻。

因此，兑换还会通过 Server API 的 `POST /users/with-wallet` 在**另一个**网络上注册该用户，`POST /v1/pollar/oauth/token` 会同时报告两者：

```jsonc
"network_wallets": [
  { "network": "testnet", "status": "ready",   "address": "GA5Z…" },
  { "network": "public",  "status": "pending", "address": null    }
]
```

**`pending` 条目不是错误。** 登录已经成功；第二个钱包只是尚未落地的部分，而整个设计的要点就在于它不能连带让登录失败。请求路径上的尝试有五秒时间且只尝试一次，未完成的部分会由开通清扫器在后台重试——与握手清扫器使用相同的开关和节奏（`POLLAR_SWEEP_*`），采用指数退避，总预算为十次尝试，之后该行变为 `failed`。

出现 `pending` 的常见原因很平常：**另一个网络的密钥没有配置。** 在配置之前，每次登录都会留下一个待开通的对应钱包；一旦配置好，一次清扫就能开通全部积压，无需任何人重新登录。这就是为什么即使目前只服务一个网络，也值得同时设置两个网络的密钥。

两个值得了解的后果：

- **关联键是 OAuth 邮箱**，因为之后在另一个网络上的托管登录正是靠它来识别同一个人。未担保任何邮箱的服务商根本不会获得对应钱包——这好过一个花费了 XLM、却没有任何登录能访问到的孤儿钱包。
- **它会在两个网络上花费 XLM。** 现在，一次主网登录也会为一个 testnet 储备金注资，反之亦然。每个网络的状态保存在 `pollar_user_wallet` 中，每个（consumer、email、network）一行，这同时也是幂等机制：重复登录会通过它执行 upsert，而不是再次开通。

### 桥接存储了什么

一条握手记录，其中没有任何能花钱的东西：不可猜测的 `state`、Pollar 客户端会话 id、code 的**哈希**，以及最终得到的 Stellar 公开地址。**从不持久化任何 Pollar token**——`/auth/login` 交换在兑换请求内部执行，token 直接随其响应返回。无人完成的握手会由定时器（`POLLAR_SWEEP_*`）置为过期，因为 `AUTHORIZED` 状态的行在被清扫之前都是一个可兑换的 code。

每次状态转换都是对该行状态的 compare-and-swap，因此重放的回调不会生成第二个 code，两个钱包争抢同一个 code 也不可能都成功。

### 值得了解的加固措施

- **PKCE（RFC 7636，S256）** 是可选的，但推荐使用：在授权时传入 `code_challenge`，在兑换时传入 `code_verifier`，这样从浏览器或日志中泄露的 code 在没有 verifier 的情况下毫无用处。
- **`dpop_jwk`** 把 Pollar 签发的 token 绑定到钱包自己的 P-256 密钥（RFC 9449），因此被盗的 access token 在没有签名证明的情况下无法使用。这也意味着桥接无法再代表钱包行事——`/refresh` 和 `/logout` 服务于 bearer 会话，而绑定了 DPoP 的钱包会直接调用 Pollar。
- **`POLLAR_REDIRECT_URI_WHITELIST`** 按消费者划分，且默认拒绝。重定向 URI 是一次性 code 的落点，因此未经审核的 URI 就是一条数据外泄通道。它接受回环主机（任意端口，依据 RFC 8252）、私有 scheme 深度链接和 https 主机。
- **把持有 `pollar:*` 的 API key 保存在服务器上。** 轮询流程会把 code 交给同时持有握手 `state` *和*具有 `pollar:read` 的 key 的任何人。一个从分发给用户的应用中提取出这类 key 的攻击者，可以发起一次登录，把它的 `authorization_url` 发给受害者，在受害者于真实的 Google/GitHub 页面上同意授权后轮询获取 code，再用自己的 PKCE verifier 兑换——PKCE 和 `dpop_jwk` 都帮不上忙，因为这两者都由攻击者提供。这就是设备码钓鱼的形态，而防御手段就是让 key 永远不离开你所控制的后端。

### 路由

| 方法 | 路径                                                  | Scope          | 说明 |
| ------ | ----------------------------------------------------- | -------------- | ----------- |
| POST   | `/v1/pollar/oauth/authorize`                          | `pollar:write` | 发起登录 → `authorization_url` + `state` |
| GET    | `/v1/pollar/oauth/callback/:state`                    | _公开_         | Pollar 将浏览器送回的位置（一次页面导航——无法携带 key） |
| GET    | `/v1/pollar/oauth/callback?state=`                    | _公开_         | 同一个回调，供保留查询参数但不保留路径的重定向链使用 |
| GET    | `/v1/pollar/oauth/sessions/:state`                    | `pollar:read`  | 轮询握手，并获取其 code |
| POST   | `/v1/pollar/oauth/token`                              | `pollar:write` | 兑换 code → Pollar 会话 + 钱包 |
| POST   | `/v1/pollar/oauth/refresh`                            | `pollar:write` | 轮换 token 对（bearer 会话） |
| POST   | `/v1/pollar/oauth/logout`                             | `pollar:write` | 撤销会话（当前设备或全部） |
| POST   | `/v1/pollar/wallets/activate`                         | `pollar:write` | 为 XLM 储备金注资（Deferred 注资模式） |
| POST   | `/v1/pollar/wallets/:address/trustlines/default`      | `pollar:write` | 启用应用配置的资产 |
| POST   | `/v1/pollar/wallets/:address/trustlines`              | `pollar:write` | 启用指定资产 |
| DELETE | `/v1/pollar/wallets/:address/trustlines/:code/:issuer`| `pollar:write` | 移除 trustline（仅限零余额） |
| POST   | `/v1/pollar/users` · `/v1/pollar/users/with-wallet`   | `pollar:write` | 注册用户，可选同时创建钱包 |
| POST   | `/v1/pollar/tokens/verify`                            | `pollar:read`  | 验证钱包向你出示的 token |

最后六个路由需要 Pollar 的 **secret** key，这正是它们放在这里而不是钱包里的原因。所有路由的请求和响应 schema 都在生成的契约中——`/docs` 上的 Swagger UI，或 `openapi/openapi.{json,yaml}`。上表仅用于帮助了解全貌；契约才是事实来源。

### 速率限制：如何防止钱包生成被滥用

创建 Pollar 钱包并非免费。Pollar 会创建 Stellar 账户、为其基础储备金注资（1 XLM），并为每个配置的资产添加 trustline（每个 0.5 XLM）——**费用出自你的注资钱包**。因此，对登录流程的循环调用就是陌生人花你的钱的途径，而且另一端根本不需要真实用户。

所以限额设置在这里、在本服务中，而不仅仅在网关上：本进程知道某个请求即将创建账户，也能在 XLM 流出之前拒绝它。

**控制点是 `authorize`，而不是 `token`。** 一次握手最多产生一个钱包，因此限制一个地址可以发起多少次握手，就限制了它能导致创建多少个钱包。`token` 有意保持宽松，因为 409 路径会告诉调用方在 Pollar 开通账户期间重试完全相同的请求——在那里设置严格的预算会限制我们自己文档中说明的重试，而兑换并不会创建任何握手尚未允许的东西。

| 路由 | 预算（每 10 分钟） | 为什么是这个数字 |
| ----- | ------------------- | --------------- |
| `POST /v1/pollar/oauth/authorize` | 20 | 钱包生成的上限。远高于人在授权页面失败后的重试次数，远低于足以耗尽账户的速率 |
| `POST /v1/pollar/oauth/token` | 60 | 有意宽松——见上文 |
| `GET /v1/pollar/oauth/callback` | 60 | 唯一无需 API key 即可访问的路由，因此也是匿名洪泛唯一能触及的路由。用户刷新标签页是正常行为 |
| `POST /v1/pollar/users/with-wallet` | 10 | 创建钱包且没有授权页面来放慢节奏——这组中最严格的预算 |
| `POST /v1/pollar/wallets/activate` | 20 | 每次调用都花费 XLM，但无法创建任何新东西 |

超出预算会返回 **`429` 以及 `code: "rate_limited"`**、`Retry-After`，以及 `RateLimit-Limit` / `-Remaining` / `-Reset` 三件套。服务中的其他所有内容在这里都不受限；通用的流量整形是 APISIX 的职责，因为它比本进程更早看到请求。

**计数器在 Postgres 中，而不是在内存中。** 本服务运行在负载均衡器之后，因此进程级限流器会让每个副本都拿到完整的预算：实际限额变成 `limit × replicas`，并在部署扩缩容时悄无声息地改变。这对装饰性的节流来说没问题，但对守护真实余额的东西来说不行。它是固定窗口——每个请求执行一条原子的 `INSERT … ON CONFLICT … RETURNING`——这确实意味着客户端可以在窗口边界两侧各花光一次完整预算，因此请把上面的数字理解为“每个窗口最多为该值的两倍”。设定这些数字时已经考虑到了这一点。

**地址如何确定，以及为什么无法伪造。** `main.ts` 将 `trust proxy` 设置为 `1`，这让 Express 读取 `X-Forwarded-For` 中*最右侧*的条目——即 APISIX 追加的那一项，也就是网关所看到的对端。客户端可以在该请求头前面添加条目，但它写入的所有内容都位于 APISIX 那一项的左侧，会被忽略。

> **不要调高 `trust proxy`。** 设为 `2` 时，Express 会开始信任客户端提供的第一跳，这里的每一项限制都可以通过添加一个请求头来绕过。`src/common/client-ip.spec.ts` 固定了这两种行为，因此这种改动无法在评审中蒙混过关。

IPv6 调用方按 **/64** 分桶，而不是按单个地址：客户端通常会被分配整个 /64，并可以免费在其中轮换，因此在那里按地址限流等于没有限流。代价是位于同一个 /64 之后的两个用户共享一个桶，就像位于同一个 IPv4 NAT 之后的两个用户早已如此一样。桶还按消费者划分，因此一个集成方的流量不会挤占另一个集成方的额度。

如果计数器无法写入，限流器会**默认拒绝**（`503`）。在数据库故障期间悄悄停止限流的限流器还不如没有，因为没有任何东西会告诉你发生了这件事——而且它背后的每个路由本来就需要同一个数据库，所以拒绝请求不会损失任何原本尚未损失的可用性。

设置 `RATE_LIMIT_ENABLED=false` 作为事故开关。

### 配置

1. 在 [dashboard.pollar.xyz](https://dashboard.pollar.xyz) 创建一个应用，并获取你所在网络的两个 key（`pub_testnet_…` / `sec_testnet_…`）。请为**两个**网络都这样做：一次登录会在每个网络上各开通一个钱包，而没有 key 的网络会让每个用户的第二个钱包一直处于 `pending`，直到 key 被设置。两个仪表盘是相互独立的——请在每个仪表盘中都注册回调主机。
2. 在 **Build → Domains** 下注册 `POLLAR_BRIDGE_CALLBACK_URL` 的**网关主机**。这不仅关乎重定向：SDK API 会在*每次*调用时根据 `Origin` 请求头检查该列表，而桥接会把该主机的 origin 作为这个请求头发送（`POLLAR_SDK_ORIGIN` 可覆盖）。未注册的主机在 `POST /auth/session` 上会得到 `403 ORIGIN_NOT_ALLOWED`——这是每次登录的第一个调用，发生在用户看到授权页面之前。
3. 将 `POLLAR_BRIDGE_CALLBACK_URL` 设置为 `<gateway>/v1/pollar/oauth/callback`——桥接会自行追加 `/{state}`。
4. 将每个钱包的重定向 URI 添加到 `POLLAR_REDIRECT_URI_WHITELIST`，或者省略它并使用轮询流程。

key 按网络划分，且 Pollar 在前缀中编码了网络和 key 类型，因此不匹配会被直接拒绝——环境变量校验器会在启动时就捕获它，而不是等到用户登录时才暴露。将 key 留空即可禁用该功能（Pollar 路由随后返回 `503`）。见 `.env.example`。

## 升级 — 破坏性变更与部署说明

### 安全审查修复

对整个服务的一次审查发现了以下问题。每一项都已修复，并由一个在没有修复时会失败的测试固定下来。大多数修复对行为规范的调用方没有任何影响，但每一行都会被某些人注意到——部署前请阅读“谁会注意到”一列。

| 变更 | 谁会注意到 | 原因 |
| ------ | ----------- | --- |
| `POST /v1/aliases/:name/recovery` **仅限平台控制台**：API key 会得到 `403 admin_console_only`，且该路由已从发布的契约中移除 | 用 API key 发起过恢复的任何人 | 响应携带恢复 token，而它就是所有者邮箱的证明。仅靠 scope 保护时，任何知道某个标识及其所有者邮箱的人都能拿到 token，并夺走该别名以及发往它的每一笔付款 |
| 对 `SUSPENDED` 别名完成恢复会返回 `404` | 没有正当用户会注意到 | 冻结之前签发的 token 曾是逃脱运营方冻结的途径 |
| `@Public()` 路由（Pollar 回调、BlindPay webhook、健康检查）会忽略 `X-Consumer-Username` | 仪表盘：这些请求现在记录为匿名 | 这些路由不经过 key-auth，因此该请求头完全由客户端控制：每个请求换一个名字就能获得一份新的速率限制预算，而冒用受害者的名字则会把伪造的行写入对方的 API 日志视图 |
| `AdminGuard` 和 `ConsoleOnlyGuard` 的拒绝会以 `warn` 级别记录 | 运维人员 | guard 在访问日志之前运行，因此对 `/v1/admin` 的探测此前在任何地方都不会留下痕迹 |
| `POST /v1/pollar/wallets/activate` 以及三个 `/v1/pollar/wallets/:address/trustlines…` 路由，对于发起调用的消费者并非通过本服务在该网络上获得的钱包，返回 `404` | 对仅通过 `tokens/verify` 看到的钱包、某次登录的非主钱包，或已被其他租户注册的对应钱包执行操作的集成方 | 所有租户共用一套 Pollar secret key，因此没有这项检查，一个租户就能移除另一个租户的用户的 trustline，或把运营方的 XLM 花在他们的储备金上。他人的钱包和未知的钱包得到相同的 `404`，因此这个答复无法被用来探测所有权 |
| 两个 `POST …/trustlines` 路由共享一个 `429` 预算：每 10 分钟 20 次调用 | 批量添加 trustline 的脚本 | 每个 trustline 都会从运营方的注资钱包中锁定 0.5 XLM 储备金，而这两个路由曾是仅有的未设上限、会花费 XLM 的路由 |
| `GET /v1/offramp/payouts/:id` 不再返回 `raw`、`consumerId`、`receiverId`、`quoteId`、`bankAccountId` 或 `updatedAt`；创建虚拟账户的响应不再返回 `raw`、`receiverId`、`consumerId` 或 `updatedAt` | 读取这些字段的调用方 | `raw` 是存储下来的 BlindPay 对象，含有银行和受益人数据，任何持有 `offramp:read` 的 key 都能拿到——该读取路径忽略了其他所有 payout 读取都在使用的公开投影 |
| `POST /v1/kyc/upload` 在以下情况返回 `400`：文本字段超过 4 个、单个字段超过 1 KiB、出现第二个文件，或文件字节与声明的类型不符 | 发送格式正确的上传请求的调用方不受影响 | Multer 的默认设置对字段数量不设上限，每个字段在内存中可占 1 MB，而类型检查信任的是客户端的 `Content-Type` |
| `POST /v1/payment-intents/tx` 和 `/pay`：相同的 memo 搭配任何不同的条款会返回 `409 idempotency_conflict`。完全相同的重试仍会返回已存储的意图（`2` 和 `2.0` 视为相同金额） | 为不同付款复用同一个 memo 的调用方 | 在共享公共 key 下，每个匿名钱包都是同一个消费者，因此别人先创建的 memo 会返回*他们的*意图——附带一个付款给他们的二维码 |
| `POST /v1/payment-intents/:id/validate` 只有在失败交易确实是该意图自己的支付时才标记为 `FAILED`；其他任何失败交易都返回 `valid: false`，状态保持不变。关闭时间早于意图创建 60 s 以上的交易会被拒绝（"Transaction predates this payment intent"）——在 validate、`PATCH {status: SUCCEEDED}` 以及观察器中均如此 | 没有正当用户会注意到 | 网络上任意一笔失败交易的哈希都能让一个意图永久失败，而一笔条款相同的旧支付可能会结算一个新意图 |
| `PATCH /v1/payment-intents/:id` 在已处于终态的意图上修改 `txHash` 会返回 `400 invalid_state_transition`；与该写入竞争的状态变更返回 `409 operation_in_flight` | 没有正当用户会注意到 | 它会改写一个 `SUCCEEDED` 意图的结算证据 |
| 支付意图观察器每个周期对每个消费者最多对账 10 个意图，且从不扫描已过期的行 | 关注观察器吞吐量的运维人员 | 来自某一个消费者的大量不定金额意图会让其他所有租户的结算陷入饥饿，并耗尽共享的 Horizon 预算 |
| `POST /v1/swaps`、`/v1/liquidity-pools/deposit` 和 `/withdraw`：复用的 `Idempotency-Key` 搭配不同的请求——不同的 memo 或滑点、另一个网络，或把存入用的 key 复用于取出——会返回 `409 idempotency_conflict`。携带无效资产、滑点或 memo 的重放现在会得到正常的 `400` | 为不同操作复用同一个 key 的客户端 | 在共享公共 key 下，攻击者可以用一个可猜测的 key，预先创建一笔从受害者账户转到自己账户的 swap 或取出操作，而受害者重试时拿到的正是这个信封，并由受害者亲自签名 |
| `POST /v1/liquidity-pools/withdraw` 对于账户尚未使用其序列号的进行中取出操作（未签名或已放弃的信封），不再返回 `409 operation_in_flight` | 曾被阻塞的钱包用户 | 一笔为他人账户构建、每 300 s 重新发送一次的粉尘取出操作，会让所有公共 key 用户都无法取出该持仓。两个信封共享同一个序列号，因此最多只有一个能够结算 |
| 结算观察器每个周期对每个消费者、每张表最多处理 10 行，且 `GET /v1/liquidity-pools/positions` 通过一次分页列表读取 Horizon，而不是每个池发起一次请求 | 运维人员 | 某一个消费者的洪泛会让其他所有人的结算陷入饥饿，而持有大量池份额的账户会扇出无上限的 Horizon 调用 |
| `GET /v1/onramp/payins/:id` 不再返回 `receiverId` 或 `updatedAt`——与 `GET /v1/onramp/payins` 返回的结构一致 | 从单个 payin 读取中使用这两个字段的调用方 | 镜像行较新的 payin 会按存储原样返回，因此同一个 payin 会因镜像新旧而呈现两种结构，其中一种还带有内部 id |
| `POST /v1/kyc/upload` 上传超过 10 MiB 的文件时返回 `413`，`code: "payload_too_large"`；此前为 `internal_error` | 依据 `code` 分支处理的集成方 | 调用方本可以遵守的限制，看起来却像本服务的 bug |
| `POST /v1/liquidity-pools/deposit`、`/withdraw`、`GET /v1/liquidity-pools/operations`、`/operations/:id`、`POST /v1/liquidity-pools/operations/:id/submit` 以及 `LIQUIDITY_*` webhook 现在都带有 `memo`（调用方的 MEMO_ID，或 `null`）。在迁移 `20260915120000_liquidity_pool_operation_memo` 之前创建的操作返回 `null`，即使其信封中带有 memo | 无人受影响，除非客户端会拒绝未知字段 | memo 以前只记录在 XDR 中，因此每次 `Idempotency-Key` 重放都要解码信封来比较它 |
| `GET /v1/swaps` 和 `GET /v1/liquidity-pools/operations` 的已发布契约不再在列表项上声明 `qr` 或 `commissionMemo`。响应本身没有变化——这两个字段从未在列表中返回；需要时请读取单个条目 | 根据 OpenAPI 规范生成的客户端 | 契约把列表项声明为单条读取的结构，因此生成的客户端会为列表中从未出现的两个字段生成类型 |

随之而来的部署说明：

- **迁移 `20260910120000_aliases`** 会创建 `alias`、`alias_address`、`alias_challenge` 和 `alias_recovery`。请在新构建承接流量之前运行 `migrate deploy`。
- **新的咨询锁 id：`881_008`（`AliasChallengeSweeper`）。** 无需配置；列在这里是为了确保该编号永不被复用。
- **在生产环境中设置 `NODE_ENV=production`。** `.env.example` 中提供的是 `development`，而有两项保护依赖于它：缺少 `X-Plan-Swap-Fee-Bps` 的请求只有在生产环境中才会返回 `503`（在其他任何环境中，swap 会悄悄回退到 `STELLAR_SWAP_FEE_BPS`），而 `/docs`——不受任何 guard 保护——也只有在生产环境中才默认关闭。
- **结算观察器现在基于 `ScheduledJob` 运行。** `OBSERVER_ENABLED`、`OBSERVER_INTERVAL_MS` 及其咨询锁均未改变，但日志行改为共享的格式：`Settlement observer started (every Nms)`、`Settlement observer (OBSERVER_ENABLED=false) disabled`，以及 `error` 级别的 `SettlementObserverService cycle failed`。匹配旧文案的告警需要更新。
- **迁移 `20260915120000_liquidity_pool_operation_memo`** 添加可空列 `liquidity_pool_operation.memo`：不会重写表，只会短暂持有排他锁。没有回填——旧行的 memo 位于 base64 XDR 中，SQL 无法解码，服务会对这些行回退到信封。
- **迁移 `20260915120100_lookup_indexes`** 以 `CONCURRENTLY` 方式为 Pollar 钱包归属检查构建两个索引（`pollar_oauth_session(consumerId, network, walletAddress)` 和 `pollar_user_wallet(consumerId, network, address)`）。它不会阻塞写入，但构建失败会留下一个 `INVALID` 索引，而 `IF NOT EXISTS` 会把它视为已存在：用 `SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE NOT i.indisvalid;` 找到它，用 `DROP INDEX CONCURRENTLY` 删除，运行 `prisma migrate resolve --rolled-back 20260915120100_lookup_indexes`，然后重新部署。

### NestJS 12、TypeScript 6 与 Node 最低版本 24.9

整个 NestJS 系列升级到了 12，TypeScript 升级到了 6。**这将 Node 最低版本提高到 24.9**（`engines`，且两个工作流现在都固定为 `node-version: 24`）；更旧的版本根本无法运行测试套件。部署目标也必须随之升级。

原因在于测试运行器，而不是框架。NestJS 12 以纯 ESM（`"type": "module"`）发布，而在 CommonJS 下运行的 Jest 无法 `require()` 它——62 个测试套件全部加载失败。Jest 原生支持 `require(esm)`，但仅限于 Node >= 24.9 **并且**使用 `--experimental-vm-modules` 时，因为它所检查的能力（`vm.SourceTextModule.prototype.hasAsyncGraph`）在没有该标志时并不存在。因此测试脚本现在直接通过 Node 调用 Jest：

```
"test": "node --experimental-vm-modules node_modules/jest/bin/jest.js"
```

而不是使用 `NODE_OPTIONS=` 前缀：那种写法无法移植到 Windows shell，而 CI、发布任务和开发者的机器必须运行相同的命令。

两个值得了解的后果：

- **两份 Jest 配置中的 `transformIgnorePatterns` 都已删除。** 它列出了需要由 ts-jest 转译为 CommonJS 的 ESM 包（`@stellar`、`@noble`、`@exodus`、`uint8array-extras`）——这是无法加载 ESM 时的变通方案。既然 Jest 现在原生加载 ESM，这个变通方案反而会造成破坏：被编译为 CJS 的包会被当作 ESM 求值，并因 `exports is not defined` 而崩溃。如果将来某个依赖又需要转换，就去看那个文件。
- **`tsconfig.json` 新增了 `types` 和 `rootDir`。** TypeScript 6 不再自动包含所有 `@types` 包，因此显式列出了两个 ambient 类型包（`node`、`jest`）——否则每个 spec 都会失去 `describe`/`it`，却仍然在 ts-jest 下显示通过。另外，当一次编译只覆盖一个目录时，TS 6 拒绝推断 `rootDir`（TS5011），而 ts-node 脚本正是这种情况；`"./"` 与完整构建原本推断出的值一致，因此输出的目录结构保持不变。

主版本升级迫使的代码改动，都很小：

- `EventEmitter2` 从 `eventemitter2` 导入，而不是从 `@nestjs/event-emitter` 导入。运行时它是同一个类对象——DI token 没有变化——但 Nest 的重新导出是按该包的 CJS 形态标注类型的，在本仓库的 `node10` 模块解析下会解析为 `any`，这悄悄地把每个 `.emit()` 都变成了未经类型检查的调用。出于这个原因，`eventemitter2` 现在是直接依赖。
- `OperationObject` 从 `@nestjs/swagger` 导入，而不是从 `@nestjs/swagger/dist/interfaces/open-api-spec.interface` 导入。Swagger 12 发布了一个只暴露 `.` 和 `./plugin` 的 `exports` 映射，因此深层路径不再能被解析。
- `AccountLoaderService.load` 带有显式的 `Promise<Horizon.AccountResponse>` 返回类型；TS 6 不会推断一个它无法以可移植方式命名的类型。
- 两个测试 mock（`fetch`、`Reflector.getAllAndOverride`）现在与真实签名一致，而不再使用更窄的手写签名。

发布的 OpenAPI 有所扩充：`@nestjs/terminus@12` 会生成更丰富的健康检查 schema（状态枚举和 `responseTime` 属性）。纯属新增——没有任何业务路由或 schema 发生变化。

### 共享公共 API key，以及限制它的 guard

本版本新增：`PublicKeyGuard`（全局，位于 `PermissionsGuard` 之后）和 `@AllowPublicKey()` 装饰器。现有的 key 不受任何影响——该 guard 对共享公共消费者以外的消费者不作任何判断——但部署时需要做两件事：

- **设置 `APISIX_PUBLIC_CONSUMER`** 为开发者平台为公共 key 配置的用户名，每个发布了公共 key 的部署都要设置。没有它，guard 只能回退到仅依赖转发的 `X-Consumer-Role`。
- **公共 key 必须以 `role: public` 签发**，并且只授予白名单路由所需的 scope。授予它 `kyc:*` 或 `webhooks:*` 并不会开放那些路由——guard 无论如何都会拒绝——但这会是一个超出其职责范围、且人人持有的凭证。

它可以访问哪些路由以及原因，见上文“共享公共 API key”。

### 资产注册表：`GET /v1/assets`

一张精选的表，按网络记录本平台所担保的（code、issuer）对，并注明发行机构。它不需要任何 scope——目录中没有租户数据，对它设限只会让在该 scope 出现之前签发的每个 key 都读到一个空的代币选择器——但它确实需要一个已认证的消费者，包括共享公共 key。

`npm run assets:verify` 会对照实时的 Horizon 重新检查每一行：该资产对是否存在于它所归档的网络上、`contract` 是否与 Horizon 的 `contract_id` 一致，以及发行方标志是否与链上一致。编辑注册表时请运行它。它不是单元测试，因为它需要访问公网，而一个在 Horizon 变慢时就会失败的测试，是人们迟早会学着跳过的测试。

### 客户端活动：一个新模块、一张新表和两个新 scope

`POST /v1/activity/events` 接收来自钱包和开发者仪表盘的遥测数据；`GET /v1/activity/events` 和 `GET /v1/activity/summary` 用于读取。现有接口的结构没有任何变化，但部署时需要做三件事：

- **迁移 `20260906140000_activity_event`** 会创建 `activity_event`（仅追加、按 `consumerId` 隔离、在 `(consumerId, eventId)` 上唯一）。
- **scope `activity:write` 和 `activity:read` 是新增的。** 没有它们的 key 会得到 `insufficient_scope`，这是正确的答复——但这意味着现有的 key 不会因为升级而获得上报遥测的能力。开发者平台会把这两个 scope 授予为钱包配置的 key，并在轮换时重新应用这组权限；手动签发的 key 需要手动添加。
- **`ACTIVITY_RETENTION_DAYS`**（默认 30）加入保留期清理任务。它与访问日志一样属于个人数据；只有在深思熟虑后才设为 `0`。

### Pollar 轮询路由现在会自行发现已完成的登录

`GET /v1/pollar/oauth/sessions/{state}` 过去只报告桥接回调记录下的内容。Pollar 从不调用那个回调——它的托管流程结束于 `www.pollar.xyz/auth/status`，并让客户端会话保持 `READY`——因此轮询流程的握手会一直停留在 `pending` 直到过期，即便钱包的每一步都做对了。现在轮询会直接询问 Pollar，并在 `READY` 时推进握手。

API 结构没有变化，客户端也无需改动：过去卡在 `pending` 的登录，现在会在用户完成后的一次轮询之内到达 `authorized`。部署时需要注意两点：

- **迁移 `20260906120000_pollar_oauth_provider_probe`** 为 `pollar_oauth_session` 添加一个可为空的 `providerCheckedAt`。它是所有副本共享的、限制向 Pollar 询问频率的下限；不做任何回填。
- **轮询流量现在会到达 Pollar。** 请按每个进行中的登录每两秒一个服务商请求来做预算，使用的是该网络的 publishable key。

### Pollar 登录现在会在两个网络上各开通一个钱包

`POST /v1/pollar/oauth/token` 新增了一个 `network_wallets` 数组——每个 Stellar 网络一个条目，状态为 `ready`、`pending` 或 `failed`。这是新增内容，因此不会破坏任何东西，但有两条运维注意事项：

- **运行迁移。** `20260905120000_pollar_user_wallet` 添加了 `pollar_user_wallet` 和 `PollarWalletStatus` 枚举。没有它，每次兑换都会记录一次开通失败，对应钱包也不会被记录——登录本身仍然正常工作。
- **为两个网络都设置 key。** `POLLAR_*_MAINNET` 和 `POLLAR_*_TESTNET` 各自都是可选的，而没有 key 的网络现在会在每次登录时显示为一个 `pending` 钱包，而不是什么都不显示。配置第二组 key 后，清扫器会在下一个周期清空积压；如果有意不设置，这些行会保持 `pending`，直到十次尝试的预算将它们作废。无论哪种情况，登录都不会失败。

请为 XLM 做好预算：一次登录现在会在*两个*网络上都为储备金注资，因此每个新用户的主网花费不变，但 testnet 上会出现过去没有的花费。

### `429` 现在报告 `rate_limited`

过去，裸 `429` 会回退为 `code: "provider_unavailable"`，这表示某个上游出了问题，而实际上是本服务自己拒绝了请求——让集成方去排查一个完全健康的东西。现在它报告 `code: "rate_limited"`，并且 `ApiErrorCode.RateLimited` 是已发布枚举的一部分。如果你在被限流时重试，请基于它做分支判断。


### 发生变化的响应结构

审计加固版本中有三个已发布的结构发生了变化。三者都位于 `/v1` 下；不存在 `/v2`，因此必须在部署之前通知集成方。

| 端点 | 之前 | 现在 | 原因 |
| -------- | --- | --- | --- |
| `GET /v1/webhooks` | 裸数组，静默截断为 100 条 | `{ data, total, take, skip }` | 拥有 120 个端点的消费者只拿到 100 个，却没有任何提示，也没有可用于分页的 `total` |
| `GET /v1/products` | 裸数组，整张表 | `{ data, total, take, skip }` | 无上限的读取 |
| `GET /v1/webhooks/:id/deliveries` 以及重新投递的响应 | 包含 `payload` | 移除了 `payload` | `RECEIVER_UPDATED` 的内容是一份完整的 KYC 档案，而这些路由受 `webhooks:read` 而非 `kyc:read` 保护 |

执行 `for (const x of res)` 或读取 `delivery.payload` 的调用方会在部署后出错。迁移是机械性的：读取 `res.data`，并使用持有 `kyc:read` 的 key 从 KYC 端点获取 KYC 详情。

`RECEIVER_UPDATED` / `PAYIN_*` / `PAYOUT_*` 的 **webhook 内容**也收窄为只包含标识和状态——见 Webhooks 一节。

### 审计加固迁移

它以两个文件的形式发布，必须按顺序应用：

- `20260901120000_audit_hardening` — 正确性相关的工作：一个新列、对 `liquidity_pool_operation` 执行去重的 `DELETE`、两个 `UNIQUE` 索引、两张新表。该 DELETE 以及依赖它的唯一索引在一个显式事务中、在 `SHARE ROW EXCLUSIVE` 锁下运行，因此滚动部署无法在两者之间插入重复数据。对这一张表的写入会在此期间阻塞几毫秒。
- `20260901120100_audit_hardening_indexes` — 九个新增索引，以 `CONCURRENTLY` 方式构建，因此部署**不会**阻塞对 `payment_intent`、`swap`、`webhook_delivery` 或 `request_log` 的写入。无需维护窗口。

这种拆分并非出于风格：PostgreSQL 不允许在事务块中执行 `CREATE INDEX CONCURRENTLY`，而第一个文件需要事务块。两者都会在 CI 中针对真实的 PostgreSQL 进行验证，同时断言没有索引处于 `INVALID` 状态，并且迁移仍与 `schema.prisma` 一致。

如果第二个文件中途失败，`CONCURRENTLY` 构建会留下一个**无效**索引，而不是干净地失败，并且 `IF NOT EXISTS` 会认为它已存在。请先删除它，然后重新运行：

```sql
SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE NOT i.indisvalid;
```

### `ADMIN_API_CREDENTIALS` 已移除 — `/v1/admin` 归平台控制台所有

**删除该变量。** 它已不再被读取，开发者平台中对应的 `COSMOS_ADMIN_API_SECRET` / `COSMOS_ADMIN_API_SECRET_READ` 也随之移除。

它是第二个凭证，在本服务中决定谁是平台管理员——而开发者平台早已根据登录账户的角色做出了这个判断。一个问题有两个答案，而每个配置了网关却跳过了这个密钥的部署，都会以最令人困惑的形式遇到这种分歧：owner 可以在控制台中修改另一个账户的套餐和角色，而控制台从不要求这个密钥，但每个跨租户读取却都返回 `401 admin_credentials_required`。这个错误中没有任何信息指向缺失的部署密钥，反而会让人以为是账户本身的权限问题。

因此，guard 所问的问题从“调用方是否持有管理员密钥？”变成了“这个调用是否来自平台控制台？”，而这由请求上已有的两个事实决定：

1. `X-Gateway-Secret` 与 `APISIX_GATEWAY_SECRET` 匹配——由 `ApisixGuard` 检查，与其他所有路由一样。只有网关和控制台后端持有它。
2. 存在 `X-Cosmos-Internal`。APISIX 会从它代理的每个请求中剥离该请求头（`proxy-rewrite.headers.remove`），因此 API key 调用方无法携带它；只有持有网关密钥的后端发起的直接调用才能携带。

坦白说明其中的取舍：事实 2 依赖于位于开发者平台仓库中的网关路由配置，而不是本服务持有的密钥。换来的是两点好处。控制台现在是回答“谁是平台管理员”的唯一地方，因此两个答案不可能再出现分歧；而且归属变得更清晰而非更模糊——审计记录过去记录的是共享凭证（`owner`、`viewer`），现在记录的是执行操作的控制台账户（`cosmos_<userId>`）以及它声明的平台角色，每次变更**和**每次读取都会记录。

这对调用方意味着什么：

| 之前 | 现在 |
| --- | --- |
| 没有 Bearer 密钥时返回 `401` `admin_credentials_required` | 任何非控制台调用返回 `403` `admin_console_only` |
| `read` 凭证执行变更操作时返回 `403` `admin_role_required` | 已移除——控制台已经判定该账户可以执行操作 |
| 审计记录上的 `actorId` / `actorRole` 指的是凭证 | 它们指的是控制台账户及其平台角色 |

如果你直接访问 `/v1/admin`（例如运维脚本），请发送 `X-Gateway-Secret`、`X-Consumer-Username` 和 `X-Cosmos-Internal: 1`；再添加 `X-Cosmos-Admin-Role: owner`，以便为审计记录打上标签。请让服务远离公网——管理员密钥移除之后，挡在跨租户数据前面的就是网络隔离和网关密钥。

### `APISIX_GATEWAY_SECRET` 现在要求 32 个字符

低于该长度时服务拒绝启动。它过去接受单个字符，而现在它是外部世界与平台管理接口之间*唯一*的密钥（见上文），因此它承担的分量比以前更重。用 `openssl rand -hex 32` 生成一个，并同时在 APISIX 中轮换它。

### 本版本取代的 `v0.1.0`–`v0.1.5` 功能

`main` 与本分支在分离期间各自独立地解决了若干相同的问题。在两者都有方案的地方，发布的是本分支的设计，因此从 `v0.1.5` 升级的部署会失去以下内容。这些都不是意外——每一项都是经过考虑的取舍——但每一项集成方都能察觉，因此请围绕它们规划升级。

| `v0.1.5` 上的行为 | 现在 |
| --------------- | --- |
| `POST /v1/webhooks/:id/rotate-secret` 接受 `graceSeconds`，并在 `WEBHOOK_SECRET_GRACE_SECONDS` 期间让旧密钥继续通过验证 | 密钥被直接替换；旧密钥立即停止通过验证。请在调用轮换的同一时间窗口内更新接收方存储的密钥。 |
| 由基于租约的重试 worker 投递 webhook（`maxAttempts` / `nextAttemptAt` / `leaseUntil`，状态 `RETRYING`） | 改由投递清扫器负责，`WEBHOOK_MAX_ATTEMPTS` 恢复为每个进程内循环 `3` 次（跨多次清扫的实际上限为 9 次）。`WEBHOOK_MAX_BACKOFF_MS`、`WEBHOOK_WORKER_*`、`WEBHOOK_LEASE_MS`、`WEBHOOK_FANOUT_CONCURRENCY` 和 `WEBHOOK_PAUSE_AFTER_FAILURES` 已移除，且不会再有任何投递被写为 `RETRYING`。 |
| 会发出 `SWAP_EXPIRED` 和 `LIQUIDITY_EXPIRED` | 两者都不再发出。过期仍会记录在行上；请轮询它，或订阅 `*_FAILED` 事件。 |
| `GET /v1/products` 可按 `kind`、`active` 和 `reference` 过滤，`DELETE` 接受 `hard=true` | 两者都不存在了。删除是软删除（`active=false`）。 |
| `GET /v1/products` 和 `GET /v1/customers` 默认 `take=20` | 两者都默认 `take=100`（仍是最大值），因此不带参数的调用返回的行比以前多。 |
| `analytics.apiLogs` / `analytics.webhookLogs` 返回 `{ data, total }`，且只支持 `take` | 两者都像其他所有列表一样分页：传入 `take` + `skip`，返回 `{ data, total, take, skip, hasMore }`。概览的日期范围过滤已移除。 |
| `/v1/health` 除数据库外还报告一个 Stellar 就绪指标 | 它只报告数据库。 |
| `STELLAR_HTTP_TIMEOUT_MS`、`STELLAR_MAX_ATTEMPTS`、`STELLAR_RETRY_BASE_MS` 用于限制 Horizon 调用 | Horizon 调用的限制位于 `stellar/stellar.constants.ts`，无法通过环境变量配置。这三个变量不再被读取或校验。 |

**数据库中没有删除任何内容。** 这些功能添加的列、索引和枚举值（`webhook_delivery.maxAttempts` / `nextAttemptAt` / `leaseUntil`、`webhook_endpoint.previousSecret*`、`swap` 和 `liquidity_pool_operation` 的 `lastCheckedAt` / `notFoundStreak`、`horizon_account_cursor` 表、`RETRYING`、`SWAP_EXPIRED`、`LIQUIDITY_EXPIRED`）仍全部声明在 `schema.prisma` 中，并且在 `migrate deploy` 之后依然存在。只是永远不会再被写入。删除正在使用的列——以及枚举值，而 PostgreSQL 无法在不重建类型的情况下删除枚举值——将是一次毫无收益的破坏性迁移，而保留这些声明正是让 `prisma migrate diff` 保持干净的原因。

## 环境变量

`src/` 中从 `process.env` 读取的每个变量都会在启动时由 `src/config/env.validation.ts` 校验（快速失败）。复制 `.env.example`，并至少调整 `DATABASE_URL` 和 `APISIX_GATEWAY_SECRET`。

| 变量 | 必需 | 默认值 | 作用 |
| -------- | -------- | ------- | ------ |
| `NODE_ENV` | 否 | `development` | 必须为 `development`、`test` 或 `production`。**在生产环境中设置为 `production`**——默认拒绝的套餐手续费检查和默认关闭文档都依赖于它 |
| `PORT` | 否 | `3000` | HTTP 监听端口 |
| `DATABASE_URL` | **是** | — | Prisma 使用的 PostgreSQL 连接 |
| `APISIX_GATEWAY_SECRET` | **是** | — | 证明请求经由 APISIX 到达的共享密钥。**至少 32 个字符**——它是“经由网关到达”与“任何能访问该 pod 的人”之间的全部边界 |
| `APISIX_GATEWAY_SECRET_HEADER` | 否 | `x-gateway-secret` | 网关密钥的请求头名称 |
| `APISIX_CONSUMER_HEADER` | 否 | `x-consumer-username` | 已认证的消费者用户名 |
| `APISIX_CREDENTIAL_HEADER` | 否 | `x-credential-identifier` | 来自 key-auth 的凭证 id |
| `APISIX_ENVIRONMENT_HEADER` | 否 | `x-consumer-env` | key 的环境（`dev` / `prod`） |
| `APISIX_ROLE_HEADER` | 否 | `x-consumer-role` | 网关转发的消费者角色 |
| `APISIX_PERMISSIONS_HEADER` | 否 | `x-consumer-permissions` | 网关转发的权限列表 |
| `APISIX_ORGANIZATION_HEADER` | 否 | `x-consumer-org` | 组织 id |
| `APISIX_PLAN_HEADER` | 否 | `x-consumer-plan` | 组织套餐 |
| `APISIX_SWAP_FEE_BPS_HEADER` | 否 | `x-plan-swap-fee-bps` | 套餐 swap 手续费（bps） |
| `APISIX_PUBLIC_CONSUMER` | 否 | — | 共享公共消费者的用户名（见上文）。凡是发布了公共 key 的地方都要设置 |
| `STELLAR_NETWORK` | 否 | `testnet` | 回退使用的 Stellar 网络（`public` / `testnet`） |
| `STELLAR_HORIZON_URL_PUBLIC` | 否 | `https://horizon.stellar.org` | 主网 Horizon 基础 URL |
| `STELLAR_HORIZON_URL_TESTNET` | 否 | `https://horizon-testnet.stellar.org` | 测试网 Horizon 基础 URL |
| `STELLAR_BASE_FEE` | 否 | `100` | 构建交易时使用的 Stellar 基础手续费（stroops） |
| `STELLAR_TX_TIMEOUT` | 否 | `300` | 交易超时（秒） |
| `STELLAR_SWAP_FEE_WALLET` | 手续费 > 0 时 | — | 收取 swap 手续费的平台 G... 账户 |
| `STELLAR_SWAP_FEE_BPS` | 否 | `50` | swap 手续费，单位为基点 |
| `STELLAR_SWAP_SLIPPAGE_BPS` | 否 | `50` | 默认 swap 滑点容忍度（bps） |
| `STELLAR_SWAP_MAX_SLIPPAGE_BPS` | 否 | `500` | 调用方滑点的硬上限（bps） |
| `STELLAR_SWAP_SINGLE_INFLIGHT` | 否 | `false` | 为 `true` 时，如果同一 source 已存在未过期的 PENDING swap，则返回 409 |
| `OBSERVER_ENABLED` | 否 | `true` | `true` / `false` — 链上对账器 |
| `OBSERVER_INTERVAL_MS` | 否 | `15000` | 观察器轮询间隔（ms，最小 1000） |
| `OBSERVER_BATCH_SIZE` | 否 | `50` | 每个观察器周期处理的意图/swap 上限 |
| `PAYMENT_INTENT_TTL_SECONDS` | 否 | `3600` | 未支付意图变为 `EXPIRED` 之前的存活时间 |
| `WEBHOOK_TIMEOUT_MS` | 否 | `5000` | 旧版 webhook 超时回退值（ms） |
| `WEBHOOK_CONNECT_TIMEOUT_MS` | 否 | `3000` | 出站 webhook 连接时间预算（ms） |
| `WEBHOOK_READ_TIMEOUT_MS` | 否 | `5000` | 出站 webhook 读取时间预算（ms） |
| `WEBHOOK_MAX_RESPONSE_BYTES` | 否 | `65536` | 读取 webhook 响应体的字节上限 |
| `WEBHOOK_MAX_ATTEMPTS` | 否 | `3` | 投递重试次数 |
| `WEBHOOK_BACKOFF_MS` | 否 | `2000` | 重试之间的线性退避（ms） |
| `WEBHOOK_SIGNATURE_HEADER` | 否 | `x-cosmos-signature` | 发送给集成方的 HMAC 请求头 |
| `WEBHOOK_SWEEP_ENABLED` | 否 | `true` | 恢复因崩溃而滞留的投递。事故开关 |
| `WEBHOOK_SWEEP_INTERVAL_MS` | 否 | `60000` | 清扫器间隔（ms，最小 1000） |
| `WEBHOOK_PAYLOAD_RETENTION_DAYS` | 否 | `30` | 已结束投递的内容在脱敏前保留的天数。`0` 表示永久保留 |
| `REQUEST_LOG_RETENTION_DAYS` | 否 | `30` | `request_log` 行（付款方 IP / user-agent）的保留天数。`0` 表示禁用清理 |
| `ACTIVITY_RETENTION_DAYS` | 否 | `30` | `activity_event` 行（客户端 IP / user-agent / `props`）的保留天数。由同一个任务清理。`0` 表示永久保留事件 |
| `REQUEST_LOG_PRUNE_INTERVAL_MS` | 否 | `3600000` | 保留期定时器间隔（ms） |
| `REQUEST_LOG_PRUNE_BATCH_SIZE` | 否 | `1000` | 每个删除批次的行数（让每次加锁保持短暂） |
| `REQUEST_LOG_PRUNE_MAX_PER_CYCLE` | 否 | `50000` | 每个周期检查行数的硬上限 |
| `SWAGGER_ENABLED` | 否 | 在 `production` 中关闭 | 发布 `/docs`（Express 中间件，无 guard） |
| `OPENAPI_SERVER_URL` | 否 | — | 写入导出的 OpenAPI 的网关主机 |
| `BLINDPAY_API_KEY` | 否 | — | BlindPay 平台 API key |
| `BLINDPAY_INSTANCE_ID` | 设置了 API key 时 | — | BlindPay 实例 id（`in_...`） |
| `BLINDPAY_BASE_URL` | 否 | `https://api.blindpay.com/v1` | BlindPay API 基础 URL |
| `BLINDPAY_WEBHOOK_SECRET` | 设置了 API key 时 | — | 入站 BlindPay webhook 的 Svix 密钥 |
| `BLINDPAY_TIMEOUT_MS` | 否 | `15000` | BlindPay HTTP 客户端超时（ms） |
| `KYC_REDIRECT_URL_WHITELIST` | 否 | — | 按消费者划分的 KYC 重定向主机白名单 |
| `RATE_LIMIT_ENABLED` | 否 | `true` | 对花费 XLM 的路由按地址设置上限。事故开关 |
| `RATE_LIMIT_PRUNE_INTERVAL_MS` | 否 | `600000` | 计数器窗口清理间隔（ms，最小 1000） |
| `POLLAR_PUBLISHABLE_KEY_TESTNET` / `_MAINNET` | 否 | — | Pollar publishable key（`pub_<network>_…`），用于 OAuth 桥接 |
| `POLLAR_SECRET_KEY_TESTNET` / `_MAINNET` | 与 publishable key 同时设置 | — | Pollar secret key（`sec_<network>_…`），用于运营方路由 |
| `POLLAR_BRIDGE_CALLBACK_URL` | 设置了 Pollar key 时 | — | Pollar 将浏览器送回的公开 URL。必须是 `<gateway>/v1/pollar/oauth/callback`，**并且**是在 Pollar 的 Build → Domains 下注册过的主机 |
| `POLLAR_REDIRECT_URI_WHITELIST` | 否 | — | 按消费者划分的钱包重定向 URI 白名单。为空 ⇒ 该消费者只能使用轮询流程 |
| `POLLAR_SDK_ORIGIN` | 否 | `POLLAR_BRIDGE_CALLBACK_URL` 的 origin | 发送给 Pollar SDK API 的 `Origin`，后者会根据 Build → Domains 进行检查。仅当回调主机与注册主机不同时才设置 |
| `POLLAR_SDK_BASE_URL` | 否 | `https://sdk.api.pollar.xyz` | Pollar SDK API 基础 URL |
| `POLLAR_SERVER_BASE_URL` | 否 | `https://api.pollar.xyz` | Pollar Server API 基础 URL |
| `POLLAR_TIMEOUT_MS` | 否 | `15000` | Pollar HTTP 客户端超时（ms） |
| `POLLAR_AUTHORIZATION_TTL_MS` | 否 | `300000` | 登录握手保持开放的时长 |
| `POLLAR_CODE_TTL_MS` | 否 | `120000` | 已签发的桥接 code 保持可兑换的时长 |
| `POLLAR_LOGIN_WAIT_MS` | 否 | `20000` | 兑换时等待 Pollar 开通钱包的时长 |
| `POLLAR_SWEEP_ENABLED` | 否 | `true` | 使无人完成的握手过期，并重试登录遗留为 `pending` 的跨网络钱包 |
| `POLLAR_SWEEP_INTERVAL_MS` | 否 | `60000` | 握手清扫器间隔（ms，最小 1000） |

旧版的 `STELLAR_HORIZON_URL` 会在启动时被拒绝——请改用 `STELLAR_HORIZON_URL_PUBLIC` / `STELLAR_HORIZON_URL_TESTNET`。

## 快速开始

```bash
cp .env.example .env          # set DATABASE_URL and a strong APISIX_GATEWAY_SECRET
npm install
npm run db:generate           # prisma generate
npm run db:migrate            # create the schema (needs a running Postgres)
npm run start:dev
```

生成密钥：

```bash
openssl rand -hex 32
```

运行与 CI 相同的检查（无需数据库——Prisma 已被 mock）：

```bash
npm run lint
npm test                 # unit suites (src/**/*.spec.ts)
npm run test:e2e         # e2e suites (test/*.e2e-spec.ts)
npm run openapi:check    # the committed contract matches the controllers
npm run readme:check     # the seven READMEs match in structure and list every route
```

## APISIX 路由配置

开发者平台的路由辅助工具（`paydev/src/utils/apisix.ts`）已经会把 `Authorization: Bearer <token>` 转换为 `apikey` 请求头、校验 `key-auth`，并在代理之前剥离凭证。要把某个路由指向本服务，请在 `proxy-rewrite` 插件中添加**网关密钥注入**，使该请求头到达这里——并移除客户端提供的任何副本：

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

`key-auth` 在认证成功后会把 `X-Consumer-Username` / `X-Credential-Identifier` 转发给上游，并覆盖客户端提供的任何副本，guard 正是依赖这一点。

> **移除列表是承重结构，而且它是这个安全模型中唯一无法在本仓库内部验证的部分。** 上面代码块中的每个请求头都是本服务照单全收的授权输入；`X-Gateway-Secret` 只能证明请求经过了*某个*网关，而不能证明这些值是可信的。请把这个列表当作生产配置，采用与代码相同的评审标准：每当添加或复制路由时都要审计它，并让服务位于私有网络中，使唯一可达的路径是经由 APISIX。共享密钥是第二层防护，而不是唯一的一层。
>
> 对于过去“保持沉默反而有利可图”的那个输入，服务现在会默认拒绝：在生产配置中缺少 `X-Plan-Swap-Fee-Bps` 会返回 503，而不是悄悄回退到环境变量的默认值。
>
> `X-Cosmos-Internal` 承担的分量比以前更重：随着 `ADMIN_API_CREDENTIALS` 被移除，它就是告诉本服务请求来自平台控制台而非 API key 的依据，因此也是打开 `/v1/admin` 的钥匙。它仍然只能被已经出示网关密钥的调用方使用，因此暴露面受此以及网络隔离所限——但一个忘记剥离它的路由会把每个 API key 都变成平台管理员。

> 请让服务位于私有网络中，使唯一可达的路径是经由 APISIX；共享密钥是第二层防护，而不是唯一的一层。

## 让本文档保持准确

**README 是变更的一部分，而不是后续工作。** CI 中没有任何东西能发现它的偏差——构建保持绿色，而这些页面却悄悄地描述着一个已经不存在的服务——因此它与所描述的代码在同一个提交中更新。完整的约定，包括每类变更涉及哪个章节，见 [`CLAUDE.md`](../../CLAUDE.md)；简要版本如下：

| 当你…… | 需要更新 |
| --------- | ------ |
| 在 `src/` 下添加或删除模块 | [项目结构](#项目结构) |
| 添加、重命名或删除对 `process.env` 的读取 | [环境变量](#环境变量) **以及** `.env.example` |
| 集成服务商，或改变某个服务商的行为 | 该服务商自己的 `##` 章节 |
| 改变已发布的响应结构、状态码或 scope | [升级](#升级--破坏性变更与部署说明) |
| 添加、重命名、删除路由或更改其 scope | [路由索引](#路由索引)，以及该模块自己的章节 |
| 了解到运维人员或集成方绝不能错过的信息 | 它所属的章节 |

**本文档有七种语言版本**——English、Español、Português、Deutsch、Français、हिन्दी 和 简体中文——对其中一个的修改就是对全部七个的修改，并且在同一个提交中完成。英文是源文本，其他版本（位于 [`docs/i18n/`](./)）都是它的翻译：相同的标题、表格和代码块，标识符（路由、环境变量、请求头、错误码）保持原样。当某个语言文件缺失、其标题与英文不再一致，或 OpenAPI 契约中的某个路由在其路由索引中缺失时，`npm run readme:check` 会让 CI 失败。

有两类内容刻意**不**放在这里：**请求和响应 schema**，它们属于生成的 OpenAPI 契约（由 `npm run openapi:check` 保证其准确）；以及**代码已经表达的任何内容**——本文档讲的是一件事*为什么*是现在这个样子以及如何运维它，因为关于它*做什么*的第二份副本，只是又一份需要保持正确的副本。

