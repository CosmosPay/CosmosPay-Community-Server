# Cosmos Pay — 支付微服务

[English](../../README.md) · [Español](./README.es.md) · [Português](./README.pt.md) · [Deutsch](./README.de.md) · [Français](./README.fr.md) · [हिन्दी](./README.hi.md) · **简体中文**

基于 **NestJS 12** + **Prisma 7 (PostgreSQL)** 构建的支付微服务。

它是一个与 Cosmos 开发者平台（`paydev`）*相互独立*的应用。开发者平台只负责为下游服务**签发** APISIX 访问令牌（消费者 + `key-auth` 凭证）。本服务正是这些下游服务之一：它位于 **APISIX 之后**，APISIX 对每个请求进行负载均衡和身份验证，然后才将其转发到这里。因此本服务从不接触原始 API key——它只信任网关转发过来的内容。

## 如何强制“只经由 APISIX”

只有**同时**满足以下两个条件，请求才会被接受（见 `src/common/guards/apisix.guard.ts`）：

1. **网关共享密钥。** 请求携带 `X-Gateway-Secret`，并以恒定时间与 `APISIX_GATEWAY_SECRET` 进行比较。APISIX 会在每个代理的请求上*注入*该请求头，并*剥离*客户端自行提供的副本，因此正确的值只可能来自网关。（纵深防御——请配合网络隔离，确保服务无法被直接访问。）
2. **已认证的消费者。** APISIX 的 `key-auth` 插件在验证调用方的 API key 之后，会转发 `X-Consumer-Username`（以及 `X-Credential-Identifier`）。guard 要求消费者请求头必须存在，以此证明该 key 已在上游完成认证。

路由可以通过 `@Public()` 退出该检查（编排器直接访问的健康探针使用了它）。强制检查始终开启——不存在关闭它的开关。本地开发时，请在 APISIX 之后运行，或自行发送 `X-Gateway-Secret` + `X-Consumer-*` 请求头。

`/v1/admin` 是跨租户的，因此 `AdminGuard` 还要求请求携带 `X-Cosmos-Internal`。APISIX 会从它代理的所有请求中**移除**这个请求头，因此只有持有网关密钥、直接调用本服务的后端才能发送它——也就是开发者平台，由它判定当前登录的账户是否为 owner 或 admin。不存在单独的管理员凭证：保护跨租户数据的是网关密钥、网络隔离以及网关路由中的请求头移除列表。

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
                                  payment intents, swaps, liquidity pools, KYC, webhooks,
                                  Pollar
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

本服务提供的全部路由。**Scope** 是 API key 必须持有的权限——*之一* 表示持有所列 scope 中的任意一个即可，`—` 表示任何已认证的 key 均可。**公共 key** 标记了共享公共 key 可以调用的路由（见[共享公共 API key](#共享公共-api-key)）。标记为*平台控制台*的路由完全不接受 API key；只有控制台后端能够访问它们。路径使用 OpenAPI 的 `{param}` 形式。

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

该响应结构及完整的 `code` 枚举以 `ApiErrorBodyEntity` 的形式发布在 OpenAPI 规范中（来源：`src/common/errors/api-error.ts` 中的 `ApiErrorCode`）。每个操作只记录它实际可能返回的状态码，每个状态码为其可能携带的每个 `code` 各提供一个示例——真实的消息，以及与之匹配的 `statusCode` 和 `error`——因此 Swagger UI 和 Postman 导入显示的就是你真正会收到的响应体。**错误码一经发布便永不重命名**；可能会新增错误码，因此请把无法识别的错误码按其 HTTP 状态码处理。

几个容易混淆的错误码：

| 错误码 | 状态码 | 含义 |
| ---- | ------ | ----- |
| `insufficient_scope` | 403 | API key 缺少所需的 scope。请重新配置该 key |
| `account_disabled` | 403 | 运营人员停用了该法币账户。与 key 无关 |
| `gateway_required` | 403 | 请求并非经由 APISIX 到达 |
| `admin_console_only` | 403 | 该路由属于平台控制台（`/v1/admin`、发起别名恢复）。任何 API key 都无法调用 |
| `elevated_key_required` | 403 | 该路由会写入所有租户共享的资源（Pollar 用户目录）。只有提升权限的（admin）key 才能调用；增加 scope 也无济于事 |
| `pollar_identity_required` | 403 | 网关没有为该 key 转发账户邮箱，因此无法把 Pollar 登录绑定到它 |
| `pollar_identity_mismatch` | 403 | 该 Pollar 登录由 key 所属账户之外的另一个账户完成。会话已被吊销，不会返回 |
| `idempotency_conflict` | 409 | 该 `Idempotency-Key`（或支付意图的 memo）已经为一个*不同的*请求创建过资源。请重复原始请求，或改用新的 key |
| `kyc_state_invalid` | 409 | 非法的 KYC 状态转换——并非重复请求 |
| `operation_in_flight` | 409 | 一个与之冲突的操作仍在结算中 |
| `payload_expired` | 409 | 投递内容已超出保留期，无法重新发送 |
| `provider_unavailable` | 502/503/504 | BlindPay 或 Horizon 无法访问。请重试 |
| `misconfigured` | 503 | 服务端配置错误。重试无济于事 |

### 运行多个副本

APISIX 会在多个实例之间进行负载均衡，因此每个后台定时器都会在每个副本上运行。状态变更本身已经是安全的——每次变更都是一次带条件的 `updateMany` compare-and-swap——但重复执行会让对一个有速率限制的 API 的 Horizon 调用成倍增加。因此每个定时器都会获取一个 PostgreSQL **事务级咨询锁（advisory lock）**（`AdvisoryLockService`），当另一个副本持有该锁时就跳过本轮执行：

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

`pg_try_advisory_xact_lock` 从不阻塞，并且在事务结束时释放，即使发生崩溃或连接断开也是如此。与会话级锁不同，它在事务池模式的 PgBouncer 之后也能正常工作。

锁 id 定义在 `AdvisoryLockKey` 枚举中。不要给已有的 id 重新编号——滚动部署期间，新旧副本会拿到不同的锁——也不要复用已退役的 id。

### 支付验证与链上观察器

支付只在一个地方（`StellarVerifierService`）根据 Stellar 网络进行确认：交易必须**成功**；必须包含一笔发往意图 `destination` 的**原生（XLM）支付**且**金额完全一致**；当意图带有 memo 时，必须带有**匹配的 memo**（`memo_type: id`）；并且其关闭时间**不得早于意图创建前一分钟**（`TX_CREATED_AT_SKEW_MS`）。正是这个时间下限，阻止了一笔条款相同的旧链上支付去结算一个新的意图。

有两条路径使用这同一条规则：

- **手动：** `POST /v1/payment-intents/:id/validate`，请求体为 `{ "txHash": "<64-hex>" }`。匹配时，意图被置为 `SUCCEEDED`（并保存 `txHash`），同时触发 `PAYMENT_INTENT_SUCCEEDED` webhook。链上失败的交易**只有在它确实是该意图自己的支付时**——memo、目标地址和资产均相同——才会把意图标记为 `FAILED`。其他任何交易，无论失败与否，都属于不匹配，状态保持不变，以便仍可提交正确的交易。通过 `PATCH /v1/payment-intents/:id` 上报的 `txHash` 永远不会单凭自己结算一个意图：它必须是一个 64 字符的十六进制哈希，会以小写形式存储，并且只在发起调用的消费者自己的意图范围内保持唯一（与该消费者另一个意图冲突时返回 `409 idempotency_conflict`）。
- **自动（常驻观察器）：** `StellarObserverService` 每隔 `OBSERVER_INTERVAL_MS` 轮询一次 Horizon，查找 `PENDING` 状态的意图——按上报的 `txHash`，或扫描发往目标地址的支付——并以同样的方式终结匹配的意图，因此状态会变化、事件会触发，**无需任何人调用 API**。每个周期对每个消费者最多处理 `OBSERVER_MAX_INTENTS_PER_CONSUMER`（10）个意图，且从不扫描已过期的意图，因此单个消费者无法拖慢其他所有人的结算。本地开发时可用 `OBSERVER_ENABLED=false` 关闭。

**过期检查会先查链。** 一个已超过生命周期的意图在被标记为 `EXPIRED` 之前会再验证一次：如果它的支付已经上链，就改为结算为 `SUCCEEDED`；如果无法连接 Horizon，就留给下一个周期处理。当该笔支付的哈希已经存在于同一个消费者的另一个意图上时，该意图会被置为过期，而不是无休止地重试。在过期*之后*才被验证的支付——无论是被观察器还是被 `validate`——仍会把一个 `EXPIRED` 的意图变为 `SUCCEEDED` 并触发 `PAYMENT_INTENT_SUCCEEDED`，因此请不要把 `EXPIRED` 当作最终状态。该扫描会回溯读取目标地址自意图创建以来的所有支付，最多 1,000 条（5 页，每页 200 条）；如果某个目标地址在一个意图的生命周期内收到的支付超过这个数量，请改用 `validate` 并携带哈希。

### API 请求日志的保留期

除 `/v1/health` 和 `/docs` 之外，每个入站请求都会由 `LoggingInterceptor` 追加到 `request_log`，并为仪表盘的 **API 日志**视图（`GET /v1/logs`）提供数据。每行包含路径、状态码、耗时，以及——如果存在——付款方的 `ip` / `userAgent`。

仪表盘流量（`X-Cosmos-Internal`）会被**记录并打上标记**（`request_log.internal`），而不是被跳过，API 日志视图基于该列进行过滤，因此任何请求头都无法让流量不进入日志。

日志行**不会永久保留**。`RequestLogRetentionService` 通过定时器（`REQUEST_LOG_PRUNE_INTERVAL_MS`，默认 **1h**）删除早于 `REQUEST_LOG_RETENTION_DAYS`（默认 **30**）的行。每个周期以较小的 `REQUEST_LOG_PRUNE_BATCH_SIZE` 分块删除（默认 **1000**），并持续循环，直到积压清空或达到 `REQUEST_LOG_PRUNE_MAX_PER_CYCLE`（默认 **50000**），这样大量历史数据可以逐步清理完毕，而无需长时间持有表锁。设置 `REQUEST_LOG_RETENTION_DAYS=0` 可完全禁用清理（服务会在启动时记录这一点）。`(consumer, createdAt)` 上的复合索引可在数据量增长时保持仪表盘查询的速度。

### 客户端活动（钱包和仪表盘上报的内容）

`request_log` 只记录到达本服务的请求。它看不到在发送页面崩溃的钱包、被用户取消的签名，或在发出任何请求之前就出错的仪表盘页面，因此客户端会自行把这些事件上报到 `POST /v1/activity/events`。

- **批量发送。** 客户端先把事件排队再批量刷新，因此离线的钱包会在下次启动时发送它们。每个请求最多 `ACTIVITY_MAX_BATCH`（100）条。
- **可以安全重试。** 事件可以携带客户端自己的 `eventId`；`(consumerId, eventId)` 是唯一的，重复项会被跳过。响应会报告 `accepted` 和 `duplicates`。
- **归属由网关决定。** 行会写在 APISIX 认证过的消费者名下；请求体中没有对应的字段。
- **容忍有问题的 payload。** 过长的 `message` 会被截断，过大的 `props` 会被替换为 `{"_dropped": "props_too_large"}`，而不是拒绝整个批次。
- **时间戳会被钳制。** 当 `occurredAt` 比接收时间快五分钟以上或慢七天以上时，会被替换为接收时间。两个时间都会保留：`at`（客户端的时间）和 `receivedAt`。

读取这些数据：

| 路由 | Scope | 返回 |
| ----------------------- | ----------------- | -------------------------------------------------------------------- |
| `GET /v1/activity/events` | `activity:read` | 事件流，最新的在前。过滤条件：`source`、`level`、`category`、`type`（前缀）、`network`、`since`/`until` |
| `GET /v1/activity/summary` | `activity:read` | 按 level/source/category 的计数、最常见的事件类型、最常见的错误、会话、设备、按日序列 |

事件流上的 `level` 是一个**最低级别**，而不是精确匹配：`level=warn` 会返回警告*和*错误。

`activity_event` 保存 IP、user agent 以及客户端附加的任何内容，因此它由同一个任务、以与 `request_log` 相同的有界批次进行清理——`ACTIVITY_RETENTION_DAYS`，默认 **30**，设为 `0` 则永久保留事件。

### Webhooks（通知集成方）

每个集成方（APISIX 消费者）可以注册一个或多个 webhook 端点。当支付意图发生变化时，平台会触发一个领域事件；**分发器（dispatcher）**会将其扇出到该消费者所有已启用、且订阅了该事件类型的端点（订阅为空 = 全部），记录每次尝试以便追溯，并按线性退避进行重试（`WEBHOOK_*` 环境变量）。

事件类型：`PAYMENT_INTENT_CREATED`、`PAYMENT_INTENT_UPDATED`、`PAYMENT_INTENT_SUCCEEDED`、`PAYMENT_INTENT_FAILED`、`PAYMENT_INTENT_CANCELLED`、`PAYMENT_INTENT_DELETED`、`SWAP_CREATED`、`SWAP_SUBMITTED`、`SWAP_SUCCEEDED`、`SWAP_FAILED`、`LIQUIDITY_CREATED`、`LIQUIDITY_SUBMITTED`、`LIQUIDITY_SUCCEEDED`、`LIQUIDITY_FAILED`，以及来自 BlindPay 的 `RECEIVER_UPDATED`、`PAYIN_CREATED`、`PAYIN_UPDATED`、`PAYIN_COMPLETED`、`PAYOUT_CREATED`、`PAYOUT_UPDATED` 和 `PAYOUT_COMPLETED`。权威列表是 `prisma/schema.prisma` 中的 `WebhookEventType` 枚举。

**来自 BlindPay 的事件体。** `RECEIVER_UPDATED` / `PAYIN_*` / `PAYOUT_*` 只携带标识和状态——id、状态、金额、支付通道——绝不包含个人数据。服务商对象不会被转发，因为 receiver 的 payload 是一份完整的 KYC 档案，而订阅事件只需要 `webhooks:write`。请使用持有 `kyc:read` / `onramp:read` / `offramp:read` 的 key 通过 API 获取详细信息。字段白名单见 `src/blindpay/blindpay-event-redaction.ts`。

投递通过 NestJS `EventEmitter2`（`webhook.event`）解耦，因此发出通知永远不会阻塞触发它的 API 请求。

**出站目标策略（SSRF）：** 端点必须使用 `https`，且只能解析到公网地址。注册时会拒绝回环地址、RFC1918 私有地址段、链路本地地址（`169.254.0.0/16`，包括云元数据地址 `169.254.169.254`）以及已知的元数据主机名。**所有取决于主机的拒绝都给出同一个答复**——「该主机不是允许的目标」——原因只写进日志：如果能区分「这里解析不到」「解析到 `10.0.4.7`」和「解析到元数据服务」，任何能注册端点的人就能一个 URL 一个 URL 地把本服务所在的网络摸清楚。格式错误的 URL、非 https 协议、内嵌凭证或缺少主机仍会准确说明问题所在：它们描述的是发来的字符串，而不是这张网络。每次投递之前会立即再次执行同样的检查（注册之后 DNS 可能发生变化）。HTTP 客户端使用 `redirect: manual`（从不跟随 `3xx`）、来自环境变量的连接/读取超时，以及响应体大小上限。

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

**一次投递最多可被尝试 9 次，而不是 3 次。** `WEBHOOK_MAX_ATTEMPTS` 限制的是一次进程内重试循环。随后清扫器会接手总尝试次数仍低于 `WEBHOOK_MAX_ATTEMPTS × 3` 的投递，这些尝试分散在数小时内，因此因 pod 重启而中断的投递不会丢失。

**重新投递只在保留期内有效。** 超过 `WEBHOOK_PAYLOAD_RETENTION_DAYS` 后，存储的内容会被清除（投递日志会保留）。清扫器会跳过这些行，`POST /v1/webhooks/:id/deliveries/:id/redeliver` 会返回 `409 payload_expired`。

**接收 webhook。** 任何 `2xx` 都视为确认。请在 `WEBHOOK_READ_TIMEOUT_MS`（默认 5s）内响应。不保证顺序，因此请通过 API 进行对账。基于事件 `id` 去重；重新投递会复用原始 `id`（至少一次投递）。

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

列表、详情和更新只返回已发布的端点字段，创建和 `rotate-secret` 会额外带上 `secret`。除此之外的任何内容都不会离开本服务——包括 `consumerId`，以及此前一次宽限期轮换写入的 `previousSecret` / `previousSecretExpiresAt` 两列。

**`ping` 和 `redeliver` 都有速率限制**，按消费者和客户端地址计算：`POST /v1/webhooks/:id/ping` 每 10 分钟 20 次，`POST /v1/webhooks/:id/deliveries/:deliveryId/redeliver` 每 10 分钟 30 次（`429 rate_limited`）。两者都会让本服务向你选择的 URL 发送已签名的请求，而 `redeliver` 会在这一次请求内运行完整的重试循环。面对大量积压时，请让清扫器去重试，而不是逐条手动重新投递。

### OpenAPI / Swagger

**安全提示：** `GET /docs`、`/docs/json` 和 `/docs/yaml` 以 **Express 中间件**的形式挂载，而不是 Nest controller，因此它们**不会**经过 `ApisixGuard` 或 `PermissionsGuard`——任何能访问服务端口的人都可以获取规范。在生产环境中，文档**默认关闭**（`NODE_ENV=production` 且未设置 `SWAGGER_ENABLED`）。只在受信任的网络中设置 `SWAGGER_ENABLED=true`。

将规范导出为文件——不需要数据库，也不需要真实的网关密钥：

```bash
npm run openapi:generate
# writes openapi/openapi.json and openapi/openapi.yaml
```

CI 会重新生成这两个已提交的文件，并拒绝任何偏差。提交 controller 或 DTO 的变更之前，请运行同样的检查：

```bash
npm run openapi:check
```

规范中的路径已经包含版本（`/v1/...`）。若要在规范的 `servers` 中设置网关主机，请在生成之前设置 `OPENAPI_SERVER_URL`：

```bash
OPENAPI_SERVER_URL=https://gateway.example.com npm run openapi:generate
```

**在 Postman 中使用。** 导入 `openapi/openapi.json`，或从运行中的服务导入 `http://localhost:3000/docs/json`。规范提供两个服务器和两种安全要求；只选其一的工具会取各自列表中的第一项：

| 调用方式 | 服务器 | 认证 |
| -------- | ------ | ---- |
| 直接调用本服务（本地开发） | `http://localhost:{port}`（`port` 默认为 `3000`） | `X-Gateway-Secret` **和** `X-Consumer-Username`，同时提供 |
| 通过 APISIX 网关 | `OPENAPI_SERVER_URL`，设置后排在第一位 | `Authorization: Bearer <api key>` |

提交到仓库的规范是在未设置 `OPENAPI_SERVER_URL` 的情况下生成的，因此默认使用直连的请求头组合；设置该变量后生成，可得到默认走网关的集合。Postman 每个请求只保存一个 API key：如果导入后只配置了 `X-Gateway-Secret`，请把 `X-Consumer-Username` 添加为集合级请求头。健康探针以 `security: []` 发布。

每个操作都带有说明其性质的厂商扩展：`x-cosmos-rate-limit`（其配额——可能返回 `429`）、`x-cosmos-upstream`（它调用的提供方——可能返回 `502`/`503`/`504`）、`x-cosmos-public` 和 `x-cosmos-public-key`。

`npm run openapi:generate` 会拒绝写出以下规范：某个操作没有 summary、某个失败响应没有响应体或示例、某个示例的 `statusCode` 与其所记录的状态码不一致，或没有配额的路由上出现了 `429`。每次新增或修改路由时，请阅读其重新生成的操作——参见 `CLAUDE.md`。

### 创建支付意图 — 两种 SEP-7 操作，两个端点

根据 [SEP-7](https://stellar.org/protocol/sep-7)，`tx` 和 `pay` 操作接受**不同的参数**并产生**不同的响应**，因此各自拥有独立的端点、DTO 和响应 schema。本服务不持有任何密钥——它只为客户端的钱包组装请求（返回 `uri` + `qr`，`tx` 还会返回 `xdr`）。省略 `assetCode`（或其值为 `XLM`/`native`）时，资产默认为**原生 XLM**；其他任何资产都需要 `assetIssuer`。

**网络由网关转发的 API key 类型决定**：`prod` key → public（主网），`dev` key → testnet。`STELLAR_NETWORK` 只是没有网关的本地开发环境中的回退值。每个意图都会存储自己的网络，所有 Horizon 调用（构建、验证、观察器）都以该网络为目标。意图保存在 `payment_intent` 表中，并限定在发起调用的消费者范围内：`PENDING → SUBMITTED → SUCCEEDED/FAILED/CANCELLED/EXPIRED`。唯一能走出终态的路径是 `EXPIRED → SUCCEEDED`，当支付在链上得到验证时。

**memo 是必需的 `MEMO_ID`**——它在链上标识这笔支付，并让创建操作具备**幂等性**：`(consumer, memo)` 是唯一的，因此使用相同的 memo **且相同的条款**再次创建会返回原来的意图。相同的 memo 搭配任何不同的条款——类型（kind）、网络、目标地址、金额、资产、`msg`、`callback`，或 `tx` 的 `source`——都会返回 `409 idempotency_conflict`，且该错误不会透露已存储意图的任何信息。这一点在共享公共 key 下尤为重要，因为所有匿名钱包都是同一个消费者。两个构建路由共用按消费者和客户端地址计算的**每分钟 30 次调用**预算（`429 rate_limited`）：它们都要从 Horizon 读取付款人账户并写入一行记录，而在共享公共 key 下，地址是区分不同匿名钱包的唯一依据。如果不传 `memo`，会随机生成一个 uint64。

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

`tx` 响应示例：

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

开源钱包内置了一个所有人共用的 API key，因此任何人无需注册即可进行 swap、添加流动性或创建支付链接。这些调用需要支付 `community` 套餐的佣金（150 bps，最高的费率）；注册后可以获得更低的费率。网关注入费率的方式与私有 key 完全相同（见 `resolvePlanCommissionBps`）。

区别在于租户隔离。每个匿名调用方都以同一个 APISIX 消费者的身份到达，而读取端点按消费者过滤行：

```ts
// swaps.service.ts
where: { id, consumer: { apisixUsername: consumer.username } }
```

因此，在公共 key 下调用 `GET /v1/swaps` 会返回所有匿名用户的 swap 历史。scope 无法防止这种情况，因为所有人持有的是同一个 key——而且 `POST /v1/swaps/quote` 需要 `swaps:read`，也就是列出历史记录所用的同一个 scope。

**`PublicKeyGuard` 是白名单。** 公共消费者在所有未标注 `@AllowPublicKey()` 的路由上都会被拒绝，因此新路由默认对它关闭。

目前公共 key 可以访问的路由：

| 路由 | 为什么安全 |
| --- | --- |
| `POST /v1/swaps/quote` | 通过 Horizon 为路径定价；结果完全由请求决定 |
| `POST /v1/swaps` | 构建一个由调用方签名的未签名信封 |
| `POST /v1/swaps/:id/submit` | 广播调用方签名的信封——在请求体确实是该 swap 的信封、并携带签名之前，关于这笔 swap 的任何信息，包括它的状态，都不会被回答；带有速率限制 |
| `POST /v1/liquidity-pools/deposit` \| `withdraw` | 构建未签名信封 |
| `POST /v1/liquidity-pools/operations/:id/submit` | 广播调用方签名的信封，遵循与 swap submit 相同的检查；带有速率限制 |
| `GET /v1/liquidity-pools` \| `/:poolId` \| `/positions` | 从 Horizon 读取的公开链上数据 |
| `POST /v1/payment-intents/tx` \| `pay` | 根据请求构建 SEP-7 意图 |
| `POST /v1/activity/events` | 遥测数据接收——见下文 |
| `GET /v1/assets` | 公开的资产目录 |
| `GET /v1/aliases/resolve/:name` \| `availability/:name` \| `by-address/:address` | 解析标识的付款方正是这个 key 所服务的匿名调用方；答案完全由请求决定，且从不包含所有者的邮箱 |

被拒绝的路由：`GET /v1/swaps`、`GET /v1/swaps/:id`、`GET /v1/liquidity-pools/operations{,/:id}`、`GET /v1/activity/events`、`GET /v1/activity/summary`、所有支付意图读取、所有别名所有者路由（认领、列出、添加或移除地址、释放、恢复），以及 `/v1/kyc`、`/v1/onramp`、`/v1/offramp` 和 `/v1/webhooks` 下的所有路由。没有账户的钱包改为从 Horizon 读取自己的历史记录。

**允许遥测**，这样来自没有账户的钱包的崩溃报告仍然能够送达。通过这个 key 到达的事件是匿名的（一个共享消费者），因此钱包在发送之前会去除地址、目标、金额和 txHash。

guard 通过**以下任一**信号识别公共消费者：转发的角色（`X-Consumer-Role: public`）**或** `APISIX_PUBLIC_CONSUMER` 用户名。两个都要设置：如果网关停止转发角色，用户名仍然能够匹配；而没有用户名时，guard 只能依赖一个请求头。

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

可选的**幂等**：发送 `Idempotency-Key` 请求头（推荐），或在请求体中发送 `idempotencyKey`。使用相同 key **且相同请求**——网络、源账户、目标账户、两种资产、金额、滑点和 memo——的重试会返回**已有的** swap（`id` + `txHash`），而不会再构建一笔交易。相同的 key 搭配不同的请求会返回 `409 idempotency_conflict`，且该错误不会透露已存储 swap 的任何信息。流动性存入和取出遵循相同的规则，并且还会比较操作的类型。没有 key 时，唯一约束 `(network, txHash)` 仍会以 **409** 拒绝字节级完全相同的重复构建（序列号 / XDR 冲突）。当 `STELLAR_SWAP_SINGLE_INFLIGHT=true` 时，同一 `(consumer, source, network)` 的第二个未过期的 `PENDING` swap 也会返回 **409**，并指明已有的 id（默认**关闭**——仍允许同一账户并发发起不同的 swap）。只有**可能已经上链**的 swap 才会占住这道防护：账户尚未用掉其序列号的那一行不可能已经结算，而此刻正在构建的 swap 会取用同一个序列号，因此两者最多只有一个能结算。任何调用方都可以填写任意 `source`，所以在没有这项判断之前，一笔粉尘 swap 就能把别人账户的兑换冻结整整一个超时窗口——在共享公共 key 下，攻击者反复发起就能一直冻结下去。

```jsonc
// response → { id, status: "PENDING", network, sendAmount, feeAmount, swapAmount,
//              destEstimated, destMin, path, xdr, uri: "web+stellar:tx?xdr=…", qr, txHash, … }
```

**报价和构建同样有限流**，按消费者和客户端地址计算：**每分钟 60 次报价**和**每分钟 20 次构建**，各自独立于提交的额度。报价不持久化任何东西，却仍要花掉一次 strict-send 路径搜索——本服务向 Horizon 发出的最昂贵的调用——而那份按 IP 的预算由 swap、流动性池和支付意图共同分享，因此在循环里刷价格会同时拖慢这三者，对所有匿名调用方都是如此。

**`POST /v1/swaps/:id/submit`** — 转发已签名的信封（`swaps:write`）。

```jsonc
// request
{ "signedXdr": "AAAAAgAAA…(signed base64 XDR)…" }
// response
{ "submitted": true, "status": "SUCCEEDED", "txHash": "…", "swap": { … } }
// on a network rejection → { "submitted": false, "status": "FAILED", "reason": "…", "resultCodes": ["op_under_dest_min"], "swap": { … } }
```

在广播之前，服务会检查已签名交易的哈希是否与它构建的交易一致，因此它永远不会转发任意交易。swap 会通过同一个分发器触发 `SWAP_CREATED` / `SWAP_SUBMITTED` / `SWAP_SUCCEEDED` / `SWAP_FAILED` webhook 事件。

**提交对它转发的内容非常严格。** 在 `signedXdr` 能被解析、其哈希与该 swap 的 `txHash` 一致、且携带至少一个签名之前，关于这笔 swap 的任何信息——包括它的状态——都不会被回答，因此创建响应中未签名的 `xdr` 会得到 `400 validation_failed`。一笔已超出其时间边界（`STELLAR_TX_TIMEOUT`，默认 300 秒）的 swap 信封会返回 `400 invalid_state_transition` 且不会被广播；如果它已经在时限内到达网络，观察器仍会将其结算。在遭到网络拒绝之后，同一个信封最多可以重新提交 **3** 次，之后请构建一笔新的 swap——在 `503 provider_unavailable` 之后的重试不计入次数。该路由允许每个消费者和客户端地址每分钟调用 **20** 次（`429 rate_limited`）；在共享公共 key 下，每个匿名钱包都是同一个消费者，因此位于同一 NAT 之后的钱包会共用这份预算。`POST /v1/liquidity-pools/operations/:id/submit` 遵循相同的规则，并拥有自己独立的额度；`POST /v1/liquidity-pools/deposit` · `/withdraw` 共用**每分钟 20 次构建**的一份预算——它们是同一条流程的两个方向，额度分开只会让循环在两者之间交替、把两份都吃掉。

## 别名 — 可认领的支付标识

别名让付款方可以输入 `emanuel250`，而不是 `GA5ZSE…`。付款方在转账前一刻信任的正是这个名称，因此下面的规则很严格：一旦出错，就是一笔打到错误账户的付款。

### 通过证明对密钥的控制来认领，而不是靠申请

```
wallet ──1. POST /v1/aliases/challenges {name, address, network} ──▶ nonce + the EXACT message to sign
wallet ──2. signs SHA-256(domain ‖ 0x00 ‖ uint32be(length) ‖ message) with that address's key
wallet ──3. POST /v1/aliases {name, email, nonce, signature} ────────▶ alias bound to the calling consumer
```

- **对服务返回的消息原样签名。** 不要在客户端自行重建。
- **签名覆盖的是带域标签的摘要，绝不是交易。** 该流程中签名的任何内容都无法提交到网络，而且域（`Cosmos Pay alias claim v1`）专属于本功能，因此从其他 dapp 获得的签名无法用作认领。
- **用途包含在被签名的字节中**（`CLAIM`、`ADD_ADDRESS`、`RECOVER`），因此为添加地址而收集的签名无法被重放来完成恢复。
- **地址来自 challenge，而不是认领请求体。** 认领请求没有地址字段，因此没有人能为一个地址签名、却注册另一个地址。
- **challenge 是一次性的，有效期五分钟。** 签名在 challenge 被消耗*之前*验证，因此无效签名无法消耗别人的 nonce；而消耗操作是一次 compare-and-swap。
- **竞争由 `alias.name` 上的唯一索引裁决**，而不是靠预检查；落败的一方收到 `409 alias_taken`。

### 标识的命名规则

小写 `a-z`、`0-9` 和 `_`（不能位于首尾），3–32 个字符，在判定唯一性之前统一转为小写。不允许 Unicode：同形字符的集合是无界的，没有任何规范化能让西里尔字母 `а` 显示在金额旁边时变得安全。同样会被拒绝的还有：保留词（`admin`、`support`、`cosmospay`、`stellar`……），以及任何看起来像 Stellar 账户的名称（`g` 或 `m` 后跟 20 个或更多 base32 字符）。规则位于 `src/aliases/alias-name.ts`。

### 多个地址，一个名称

一个别名最多可以指向跨网络的 20 个地址——手机、桌面端、冷钱包、testnet——且每个网络恰好有一个主地址，由部分唯一索引强制保证。添加地址需要**两项**证明：调用方拥有该别名，并且新地址对它自己的 `ADD_ADDRESS` challenge 进行签名。最后一个剩余的地址无法被移除（请改为释放别名），且一个消费者最多可持有 25 个别名。

处于 `SUSPENDED` 状态的别名（运营方冻结）不会解析到任何地址。

### 恢复经由邮箱，并经由平台控制台

认领时会记录一个恢复邮箱，这样丢失密钥并不意味着失去这个名称。恢复流程如下：

1. **平台控制台**调用 `POST /v1/aliases/:name/recovery {email}`。无论标识与邮箱是否匹配，响应都完全相同；匹配时，响应会携带一个一次性 token（30 分钟，仅以 SHA-256 形式存储），由控制台通过邮件发送。本服务不发送任何邮件。
2. 用户为新密钥获取一个 `RECOVER` challenge，并使用自己的 API key 调用 `POST /v1/aliases/:name/recovery/complete {token, address, network, nonce, signature}`。两项证明缺一不可：token 证明邮箱，签名证明密钥。
3. 所有权转移到发起调用的消费者，并且**之前的所有地址都会被移除**，因此持有旧密钥的人不会再收到付款。

第 1 步仅限控制台，因为 token 证明的是对邮箱的控制权，所以它只能到达负责发送邮件的一方。`ConsoleOnlyGuard` 会在查找别名之前，就以 `403 admin_console_only` 拒绝所有 API key 调用方，并且该路由不在发布的契约中。被冻结的别名无法被恢复。

一个恢复 token 最多可以被提交**五**次。即使某次提交的 challenge 或签名验证失败，也会算作一次用量，第六次会被拒绝；此时所有者可以重新发起一次恢复。一个与该别名任何一次有效恢复都不匹配的 token 会得到同样的 `400 alias_recovery_invalid`，且不会改变任何状态，因此没有人能靠发送垃圾 token 来耗尽所有者发起的恢复次数。`POST /v1/aliases/:name/recovery/complete` 每 10 分钟允许 10 次调用，`POST /v1/aliases/challenges` 每 10 分钟允许 30 次调用，均按消费者和客户端地址计算（`429 rate_limited`）。

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

除了链上支付意图之外，本服务还集成了 [BlindPay](https://www.blindpay.com/docs)，用于在**法币与稳定币**之间转移资金：入金（**onramp / payin**）、出金（**offramp / payout**），以及两者背后必需的 **KYC**（BlindPay *receiver*）。我们**为每个 API key 环境运行一个平台级 BlindPay 实例**——`prod` key 使用生产实例（`BLINDPAY_API_KEY` + `BLINDPAY_INSTANCE_ID`），`dev` key 使用开发实例（`_DEV` 变量）；每个 receiver/钱包/银行账户/payin/payout 都会镜像到我们的 Postgres 中，并**限定在发起调用的 APISIX 消费者范围内**，因此每个集成方只能看到自己的记录。本服务**从不持有区块链密钥**——offramp 返回需要签名的内容（EVM `approve` 合约 / Stellar XDR），并接收签名后的交易，与支付意图完全一样。

状态变更通过 BlindPay 的 **Svix webhook** 同步（基于原始请求体验证），并通过现有的分发器以新的事件类型（`RECEIVER_UPDATED`、`PAYIN_*`、`PAYOUT_*`）**重新发送**到集成方自己的 webhook 端点。

| 方法 | 路径                                                  | Scope          | 说明 |
| ------ | ----------------------------------------------------- | -------------- | ----------- |
| POST   | `/v1/kyc/receivers`                                   | `kyc:write`    | 创建 receiver（开始 KYC/KYB） |
| GET    | `/v1/kyc/receivers` · `/:id`                          | `kyc:read`     | 列表 / 详情（获取详情时会刷新 KYC 状态） |
| PATCH  | `/v1/kyc/receivers/:id`                               | `kyc:write`    | 更新 receiver（进入 BlindPay 后，身份字段需要提升权限的 key） |
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

金额是**以最小货币单位表示的整数**（例如 `$123.45` → `12345`）。请在 BlindPay 仪表盘中将 webhook 配置为 `<gateway>/v1/blindpay/webhooks`，并将 `BLINDPAY_WEBHOOK_SECRET` 设置为该端点的签名密钥——完整的 `whsec_…` 值。当它的 key 解码后不足 24 字节时服务会拒绝启动，且无论如何验证器都会拒绝这样的 key：无效的 base64 会解码成一个空 key，任何人都能用它来伪造签名。将 `BLINDPAY_*` 变量留空即可禁用该功能：相关路由随后返回 `503` `misconfigured`；在 `BLINDPAY_WEBHOOK_SECRET` 未设置期间，入站 webhook 也同样如此。见 `.env.example`。

**`dev` key 永远不会访问生产实例。** key 的环境决定使用哪个 BlindPay 实例，就像它决定 Stellar 网络一样；每一条镜像行都会记录它来自哪个实例，因此同一租户的 `dev` 和 `prod` key——同一个消费者——看到的是相互独立的 receiver、钱包、银行账户、报价、payin 和 payout。未配置开发实例时，BlindPay 路由会对 `dev` key 返回 `503` `misconfigured`。请把两个实例的仪表盘 webhook 都指向同一个 `<gateway>/v1/blindpay/webhooks`，并为开发实例设置 `BLINDPAY_WEBHOOK_SECRET_DEV`：一次投递用哪个密钥验证通过，就说明它来自哪个实例。

**身份信息在到达 BlindPay 之前会经过审核，修改也不例外。** receiver 启用之前，任何触及 KYC 数据的 `PATCH` 都会让它回到 `pending_review`。一旦它已存在于 BlindPay，租户 key 只能修改 `external_id` 和 `image_url`；其他任何字段都会返回 `403` `kyc_review_required`，除非该 key 是提升权限的 key（`X-Consumer-Role: admin`），因为这个 `PUT` 会直接在服务商那里改写身份信息。

**一次批准被钉在被审核的那份材料上。** 读取 receiver 时会带上 `dossierVersion`，它统计提交的 KYC 数据被修改过多少次。批准时把它作为 `expected_version` 回传，如果材料在你读取之后发生过变化，就会返回 `409 kyc_state_invalid`，而不是批准一份没人看过的数据——修改只会让状态停留在 `pending_review`，因此批准本身察觉不到。被签字确认的版本记在 `reviewedVersion` 中，只要两者不一致，`POST /v1/kyc/receivers/:id/enable` 就拒绝在 BlindPay 创建该 receiver。

**法币路由都有预算。** 服务商会保留下来的每一次写入都按消费者和客户端地址限流，并且每个由 BlindPay 支撑的路由还会计入**每分钟 60 次服务商请求**的按消费者上限：同一个实例服务该 key 下的所有租户，因此一个租户在报价上打循环就会让其他租户的 payin 失败。超出预算会返回带 `Retry-After` 的 `429 rate_limited`。

| 路由 | 预算（按消费者 + 客户端地址） |
| ---- | ----------------------------- |
| `POST /v1/kyc/upload` | 每 10 分钟 20 次 |
| `POST /v1/kyc/terms-of-service` | 每 10 分钟 10 次 |
| `POST /v1/onramp/quotes` · `POST /v1/offramp/quotes` | 各每分钟 30 次，额度分开 |
| `POST /v1/onramp/payins` | 每分钟 10 次 |
| `POST /v1/offramp/payouts/authorize` · `POST /v1/offramp/payouts` | 每分钟 10 次，共用 |
| `POST /v1/offramp/payouts/:id/documents` | 每 10 分钟 20 次 |
| `POST /v1/onramp/trustline` | 每分钟 20 次 |

### KYC 重定向 URL 按消费者设置白名单

服务条款流程会把用户引导到 BlindPay，再返回到集成方提供的 `redirect_url`。为避免开放重定向，每个 `redirect_url` 都要经过两项检查：

| 层 | 规则 | 位置 |
| ----- | ---- | ----- |
| 格式 | 绝对 `https` URL，且不含内嵌凭证（`user:pass@`）、不含片段（`#…`），也不含反斜杠、空白字符或控制字符 | 所有携带该字段的 DTO 上的 `@IsRedirectUrl()`，以及服务层的再次检查 |
| 主机 | 位于**发起调用的消费者**的白名单中——完全相同的主机，或在标签边界上的子域名（`app.acme.com` 匹配 `acme.com`；`evilacme.com` 不匹配） | `KYC_REDIRECT_URL_WHITELIST`，在服务层强制执行 |

```
KYC_REDIRECT_URL_WHITELIST={"cosmos_acme":["acme.com","app.acme.com"]}
```

这些格式规则决定了主机检查值多少钱。WHATWG 解析器把权限部分中的反斜杠读作 `/`，另一些解析器则把它当作 userinfo 的一部分，于是 `https://app.acme.com\@evil.test` 有两种同样成立的读法——而本服务并不是最后一个读它的人：这个值会发给 BlindPay，在托管页面上回来，最后落到浏览器里。空白字符和控制字符属于同一类问题，片段会吞掉服务商追加的 `?tos_id=`，而凭证会把主机挪到 `@` 的另一侧。

它**默认拒绝（fail closed）**：没有条目的消费者完全无法使用重定向，带末尾点号或 IDN 形式的主机会被拒绝，而不是被规范化。每个接受 `redirect_url` 的路由都会检查它，包括管理员批准，后者使用的是该 receiver 所属消费者的白名单。被拒绝的协议或主机返回 `400`。

## Pollar — 返回 Stellar 钱包的社交登录

[Pollar](https://docs.pollar.xyz/docs) 把 Google/GitHub 登录变成一个 Stellar 账户：它对用户进行身份验证、创建钱包、在 AWS KMS 中托管密钥、添加配置好的 trustline 并为储备金注资——用户永远不会看到助记词。本服务将其作为 **OAuth 桥接**对外提供。

### 为什么是桥接而不是透传

Pollar 的托管登录是为浏览器 SDK 设计的。它会把用户带到 `GET /auth/{provider}`，并附带 publishable key、客户端会话 id 和 `redirect_uri`——而这个重定向 URI 必须是**在 Pollar 注册过的**主机。钱包无法满足这些要求：回环监听器或 `cosmospay://` 深度链接永远不会是已注册的主机，而且钱包不应该经手这些密钥和会话 id。因此由桥接处理 Pollar 这一侧，钱包只需要两步：**发起授权，兑换 code**。

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

第 6 步之后，钱包直接与 Pollar 通信：兑换响应中包含 `publishable_key` 和 `api_base_url`，钱包用它们读取余额、构建并提交交易。**本服务不代理这些调用。**

### 获取 code 的两种方式

|                  | 重定向流程 | 轮询流程 |
| ---------------- | ------------------------------------------------ | ----------------------------------------------- |
| 钱包提供 | `redirect_uri`（必须在白名单中）和 PKCE `code_challenge` | 无（PKCE 可选） |
| code 的到达方式 | 作为重定向上的 `?code=…&state=…` | 来自 `GET /v1/pollar/oauth/sessions/{state}` |
| 浏览器看到的 | 你自己的 URI | 一个简单的“可以关闭此窗口”页面——永远看不到 code |
| 适用场景 | 钱包有深度链接或回环监听器 | 两者都没有（自助终端、无界面环境、嵌入式视图） |

每次轮询都会签发一个新的 code 并让前一个作废，因此请兑换最近一次轮询得到的 code。只存储 code 的 SHA-256。

**优先使用轮询流程。** Pollar 的托管流程不会把浏览器送回回调地址：它结束在自己的页面上（`www.pollar.xyz/auth/status`），并在 Pollar 一侧把客户端会话标记为 `READY`。因此当握手处于 `pending` 时，轮询路由会向 Pollar 检查客户端会话，并在 Pollar 报告 `READY` 后立即推进握手。

- **保持回调路由在 Pollar 中的注册。** 重定向流程依赖于它。
- **每个握手最多每两秒向 Pollar 检查一次**（`POLLAR_SESSION_PROBE_INTERVAL_MS`），通过 `providerCheckedAt` 在所有副本之间共享。一个每秒轮询一次的钱包每分钟会产生 30 个 Pollar 请求，而该 key 的预算是 200。

如果某个握手的客户端会话被 Pollar 拒绝（`INVALID_CLIENT_SESSION_ID`、`EXPIRED_CLIENT_ID`，或 `404`/`410`），它会立即以该错误码被关闭为 `failed`。

### 一次登录，两个网络各一个钱包

Pollar 将主网和测试网作为独立的应用运行，使用独立的密钥对，因此一次托管登录只会在其 API key 所解析到的网络上创建钱包（`prod` → `public`，`dev` → `testnet`——见 `resolveNetwork`）。为了让用户在两个网络上都有钱包，**主网**兑换还会通过 Server API 的 `POST /users/with-wallet` 在 **testnet** 上注册该用户，`POST /v1/pollar/oauth/token` 会同时报告两者。testnet 兑换不会开通主网：`dev` key 落在 testnet 上，而任何人都能创建的 key 不应在每次登录时为主网储备金花费真实 XLM。该用户的主网钱包来自其首次主网登录。

```jsonc
"network_wallets": [
  { "network": "public",  "status": "ready",   "address": "GA5Z…" },
  { "network": "testnet", "status": "pending", "address": null    }
]
```

**`pending` 条目不是错误。** 登录已经成功；只是第二个钱包尚未就绪，而它永远不会导致登录失败。请求期间只进行一次五秒的尝试；未完成的部分会由开通清扫器在后台重试（`POLLAR_SWEEP_*`），采用指数退避，最多尝试十次，之后该行变为 `failed`。

出现 `pending` 的通常原因是**另一个网络的密钥没有配置**。配置好之后，下一次清扫就会开通全部积压，用户无需重新登录，因此即使目前只服务一个网络，也请为两个网络都设置密钥。

- **用户通过 OAuth 邮箱进行匹配**，这也是另一个网络上的托管登录所使用的键。不返回邮箱的服务商不会获得第二个钱包。
- **主网登录会在两个网络上花费 XLM**——自身的储备金和一份 testnet 储备金。testnet 登录只花费 testnet XLM。状态保存在 `pollar_user_wallet` 中，每个（consumer、email、network）一行，因此重复登录不会再次开通。

### 桥接存储了什么

一条握手记录，其中没有任何能花钱的东西：不可猜测的 `state`、Pollar 客户端会话 id、code 的**哈希**，以及最终得到的 Stellar 公开地址。**从不持久化任何 Pollar token**——`/auth/login` 交换在兑换请求内部执行，token 直接随其响应返回。无人完成的握手会由定时器（`POLLAR_SWEEP_*`）置为过期，因为 `AUTHORIZED` 状态的行在被清扫之前都是一个可兑换的 code。

每次状态转换都是对该行状态的 compare-and-swap，因此重放的回调不会生成第二个 code，两个钱包争抢同一个 code 也不可能都成功。

### 加固措施

- **PKCE（RFC 7636，S256）** 在**重定向流程中是必需的**，在轮询流程中是可选的：在授权时传入 `code_challenge`，在兑换时传入 `code_verifier`，这样从浏览器或日志中泄露的 code 在没有 verifier 的情况下毫无用处。重定向流程的 code 会经过浏览器，而公开的回调会把它交给任何出示 `state` 的人——`state` 就在 `authorization_url` 里——因此带 `redirect_uri` 但没有 `code_challenge` 的 `authorize` 会返回 `400 validation_failed`。
- **`dpop_jwk`** 把 Pollar 签发的 token 绑定到钱包自己的 P-256 密钥（RFC 9449），因此被盗的 access token 在没有签名证明的情况下无法使用。这也意味着桥接无法再代表钱包行事——`/refresh` 和 `/logout` 服务于 bearer 会话，而绑定了 DPoP 的钱包会直接调用 Pollar。
- **`POLLAR_REDIRECT_URI_WHITELIST`** 按消费者划分，且默认拒绝，因为 code 会被送到重定向 URI。它接受回环主机（任意端口，依据 RFC 8252）、私有 scheme 深度链接和 https 主机。
- **会话只会返回给给出同意的账户。** 所有租户共享同一个 Pollar 应用，而登录链接在任何人的浏览器里都能用：一个 key 可以把自己的 `authorization_url` 发给别人，等对方同意后兑换对方的钱包——PKCE 和 `dpop_jwk` 帮不上忙，因为握手正是这个 key 发起的。因此 `POST /v1/pollar/oauth/token` 会把 Pollar 为该登录报告的邮箱与网关为该 key 转发的账户邮箱（`X-Consumer-Email`，见 `APISIX_EMAIL_HEADER`）进行比较。不一致时会在 Pollar 吊销会话、把握手标记为 `failed` 并返回 `403 pollar_identity_mismatch`；没有转发邮箱的 key 会在 `authorize` 时被 `403 pollar_identity_required` 拒绝。唯一的例外是开发者平台的代理式注册流程（`X-Cosmos-Internal`）：它为还没有 key 的人登录，并在交出任何东西之前自行验证邮箱。
- **`POST /v1/pollar/users` 和 `/users/with-wallet` 需要提升权限的 key**（`X-Consumer-Role: admin`，否则返回 `403 elevated_key_required`）。在那里注册的用户，就是之后社交登录按邮箱解析到的同一个用户；否则租户 key 可以抢注陌生人的邮箱，并被记录为其所获钱包的所有者。

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
| POST   | `/v1/pollar/users` · `/v1/pollar/users/with-wallet`   | `pollar:write` | 注册用户，可选同时创建钱包（仅限提升权限的 key） |
| POST   | `/v1/pollar/tokens/verify`                            | `pollar:read`  | 验证钱包向你出示的 token |

最后六个路由使用 Pollar 的 **secret** key，这就是它们在这里运行、而不是在钱包中运行的原因。

### 速率限制

创建 Pollar 钱包是要花钱的：Pollar 会创建 Stellar 账户、为其基础储备金注资（1 XLM），并为每个配置的资产添加 trustline（每个 0.5 XLM），**费用出自你的注资钱包**。一个循环调用登录流程的脚本无需任何真实用户就能花掉这些钱，因此本服务在花费任何 XLM 之前自行实施限额。

**限额加在 `authorize` 上，而不是 `token` 上。** 一次握手最多产生一个钱包，因此限制每个地址的握手次数就限制了钱包数量。`token` 更宽松，因为客户端会被告知在 Pollar 开通账户期间重试它，而且兑换不会创建任何新东西。

| 路由 | 预算（每 10 分钟） | 原因 |
| ----- | ------------------- | --- |
| `POST /v1/pollar/oauth/authorize` | 20 | 限制钱包创建数量 |
| `POST /v1/pollar/oauth/token` | 60 | 客户端会在账户开通期间重试它 |
| `GET /v1/pollar/oauth/callback` | 60 | 唯一无需 API key 即可访问的路由 |
| `GET /v1/pollar/oauth/sessions/{state}` | 400 | 钱包每隔几秒轮询一次；每次轮询都可能请求 Pollar |
| `POST /v1/pollar/oauth/refresh` · `/logout` | 60，共享 | 每次一个 Pollar 请求 |
| `POST /v1/pollar/users` · `/users/with-wallet` | 10，共享 | 写入所有租户共享的用户目录；`with-wallet` 还会在没有授权页面的情况下创建钱包 |
| `POST /v1/pollar/wallets/activate` | 20 | 每次调用都花费 XLM |
| `POST /v1/pollar/wallets/:address/trustlines` · `/default` | 20，共享 | 每个资产都会锁定注资钱包的储备金 |
| `DELETE /v1/pollar/wallets/:address/trustlines/:code/:issuer` | 20 | 每次一个 Pollar 请求 |
| `POST /v1/pollar/tokens/verify` | 120 | 每次一个 Pollar 请求 |

**有两个上限按消费者而不是按地址计算**，所以轮换地址也无法成倍放大它们：一个消费者能引发的 Pollar 请求（每分钟 100 个，覆盖上面除轮询和回调之外的所有路由——Pollar 为该 key 的预算是每分钟 200 个，且所有租户共享），以及它能引发的钱包数量（`authorize` 和 `users/with-wallet`，每天 50 个）。控制台调用（`X-Cosmos-Internal`）不受这两个上限约束：开发者平台通过同一个消费者代理所有没有 key 的钱包，并自行为这部分流量设定预算。

超出预算会返回 **`429` 以及 `code: "rate_limited"`**、`Retry-After`，以及 `RateLimit-Limit` / `-Remaining` / `-Reset` 响应头。同一个限流器还守护着 Pollar 之外那些「出错也退不回成本」的路由——swap 与流动性池的构建及其提交、支付意图的构建、KYC 上传与服务条款、onramp 和 offramp 的写入（其上还叠加 BlindPay 的按消费者上限）、webhook 的 `ping` 与 `redeliver`、别名 challenge 和恢复、活动数据接收——各自的预算在对应小节中说明。通用的速率限制应由 APISIX 负责。

**计数器在 Postgres 中，而不是在内存中**，因此限额在多个副本之间依然有效。它是固定窗口（每个请求执行一条原子的 `INSERT … ON CONFLICT … RETURNING`），因此客户端可以在窗口边界两侧各用满一次预算。

**客户端地址。** `main.ts` 将 `trust proxy` 设置为 `1`，因此 Express 读取 `X-Forwarded-For` 中*最右侧*的条目——即 APISIX 追加的那一项。客户端添加的条目位于它的左侧，会被忽略。

> **不要调高 `trust proxy`。** 设为 `2` 时，Express 会信任一个由客户端提供的跳点，任何客户端都能通过一个请求头绕过这些限制。

IPv6 调用方按 **/64** 分组，因为客户端通常控制着整个 /64；共用同一个 /64 的用户共享一个限额，就像位于同一个 IPv4 NAT 之后一样。限额还按消费者划分，因此一个集成方的流量不会影响另一个集成方。

如果计数器无法写入，限流器会**默认拒绝**（`503`）；这些路由本来就依赖数据库。在事故期间，设置 `RATE_LIMIT_ENABLED=false` 可关闭限制。

### 配置

1. 在 [dashboard.pollar.xyz](https://dashboard.pollar.xyz) 创建一个应用，并获取你所在网络的两个 key（`pub_testnet_…` / `sec_testnet_…`）。请为**两个**网络都这样做：一次主网登录还会开通一个 testnet 钱包，而缺少 testnet key 会让这第二个钱包一直处于 `pending`，直到 key 被设置。两个仪表盘是相互独立的——请在每个仪表盘中都注册回调主机。
2. 在 **Build → Domains** 下注册 `POLLAR_BRIDGE_CALLBACK_URL` 的**网关主机**。SDK API 会在*每次*调用时根据 `Origin` 请求头检查该列表，而桥接会把这个请求头设为该主机（`POLLAR_SDK_ORIGIN` 可覆盖）。未注册的主机在 `POST /auth/session` 上会得到 `403 ORIGIN_NOT_ALLOWED`，这是每次登录的第一个调用。
3. 将 `POLLAR_BRIDGE_CALLBACK_URL` 设置为 `<gateway>/v1/pollar/oauth/callback`——桥接会自行追加 `/{state}`。
4. 将每个钱包的重定向 URI 添加到 `POLLAR_REDIRECT_URI_WHITELIST`，或者省略它并使用轮询流程。

Pollar 在 key 的前缀中编码了网络和 key 类型，环境变量校验器会在启动时拒绝不匹配的 key。将 key 留空即可禁用该功能（Pollar 路由随后返回 `503`）。见 `.env.example`。

## 升级 — 破坏性变更与部署说明

### 安全审查修复

其中大多数变更对行为规范的调用方没有任何影响；部署前请查看“谁会注意到”一列。

| 变更 | 谁会注意到 | 原因 |
| ------ | ----------- | --- |
| `POST /v1/aliases/:name/recovery` **仅限平台控制台**：API key 会得到 `403 admin_console_only`，且该路由已从发布的契约中移除 | 用 API key 发起过恢复的任何人 | 响应携带恢复 token，而它证明了对所有者邮箱的控制权 |
| 对 `SUSPENDED` 别名完成恢复会返回 `404` | 没有正当用户会注意到 | 冻结之前签发的 token 可以绕过运营方冻结 |
| `@Public()` 路由（Pollar 回调、BlindPay webhook、健康检查）会忽略 `X-Consumer-Username` | 仪表盘：这些请求现在记录为匿名 | 这些路由不经过 key-auth，因此该请求头来自客户端 |
| `AdminGuard` 和 `ConsoleOnlyGuard` 的拒绝会以 `warn` 级别记录 | 运维人员 | guard 在访问日志之前运行，因此被拒绝的请求此前不会留下任何痕迹 |
| `POST /v1/pollar/wallets/activate` 以及三个 `/v1/pollar/wallets/:address/trustlines…` 路由，对于发起调用的消费者并非通过本服务在该网络上获得的钱包，返回 `404` | 对仅通过 `tokens/verify` 看到的钱包、某次登录的非主钱包，或已被其他租户注册的对应钱包执行操作的集成方 | 所有租户共用一套 Pollar secret key。他人的钱包和未知的钱包都得到 `404`，因此响应不会泄露所有权 |
| 两个 `POST …/trustlines` 路由共享一个 `429` 预算：每 10 分钟 20 次调用 | 批量添加 trustline 的脚本 | 每个 trustline 都会从运营方的注资钱包中锁定 0.5 XLM |
| `GET /v1/offramp/payouts/:id` 不再返回 `raw`、`consumerId`、`receiverId`、`quoteId`、`bankAccountId` 或 `updatedAt`；创建虚拟账户的响应不再返回 `raw`、`receiverId`、`consumerId` 或 `updatedAt` | 读取这些字段的调用方 | `raw` 是存储下来的 BlindPay 对象，含有银行和受益人数据 |
| `POST /v1/kyc/upload` 在以下情况返回 `400`：文本字段超过 4 个、单个字段超过 1 KiB、出现第二个文件，或文件字节与声明的类型不符 | 发送格式正确的上传请求的调用方不受影响 | 字段此前不受限制，而类型检查信任的是客户端的 `Content-Type` |
| `POST /v1/payment-intents/tx` 和 `/pay`：相同的 memo 搭配任何不同的条款会返回 `409 idempotency_conflict`。完全相同的重试仍会返回已存储的意图（`2` 和 `2.0` 视为相同金额） | 为不同付款复用同一个 memo 的调用方 | 在共享公共 key 下，别人先创建的 memo 会返回他们的意图 |
| `POST /v1/payment-intents/:id/validate` 只有在失败交易确实是该意图自己的支付时才标记为 `FAILED`；其他任何失败交易都返回 `valid: false`，状态保持不变。关闭时间早于意图创建 60 s 以上的交易会被拒绝（"Transaction predates this payment intent"）——在 validate、`PATCH {status: SUCCEEDED}` 以及观察器中均如此 | 没有正当用户会注意到 | 任何一笔失败的交易都能让意图失败，而一笔条款相同的旧支付可能会结算一个新意图 |
| `PATCH /v1/payment-intents/:id` 在已处于终态的意图上修改 `txHash` 会返回 `400 invalid_state_transition`；与该写入竞争的状态变更返回 `409 operation_in_flight` | 没有正当用户会注意到 | 它可能改写一个 `SUCCEEDED` 意图的结算证据 |
| 支付意图观察器每个周期对每个消费者最多对账 10 个意图，且从不扫描已过期的行 | 关注观察器吞吐量的运维人员 | 单个消费者可能拖慢其他所有租户的结算 |
| `POST /v1/swaps`、`/v1/liquidity-pools/deposit` 和 `/withdraw`：复用的 `Idempotency-Key` 搭配不同的请求——不同的 memo 或滑点、另一个网络，或把存入用的 key 复用于取出——会返回 `409 idempotency_conflict`。携带无效资产、滑点或 memo 的重放现在会得到正常的 `400` | 为不同操作复用同一个 key 的客户端 | 在共享公共 key 下，有人可以用一个可猜测的 key 预先创建信封，让它在另一个用户重试时被返回 |
| `POST /v1/liquidity-pools/withdraw` 对于账户尚未使用其序列号的进行中取出操作（未签名或已放弃的信封），不再返回 `409 operation_in_flight` | 曾被阻塞的钱包用户 | 为他人账户构建的信封可能无限期地阻止该持仓的取出 |
| 结算观察器每个周期对每个消费者、每张表最多处理 10 行，且 `GET /v1/liquidity-pools/positions` 通过一次分页列表读取 Horizon，而不是每个池发起一次请求 | 运维人员 | 单个消费者可能拖慢其他所有人的结算，而持有大量池份额会导致无上限的 Horizon 调用 |
| `GET /v1/onramp/payins/:id` 不再返回 `receiverId` 或 `updatedAt`——与 `GET /v1/onramp/payins` 返回的结构一致 | 从单个 payin 读取中使用这两个字段的调用方 | 同一个 payin 可能以两种结构返回 |
| `POST /v1/kyc/upload` 上传超过 10 MiB 的文件时返回 `413`，`code: "payload_too_large"`；此前为 `internal_error` | 依据 `code` 分支处理的集成方 | 这是客户端侧的限制，而不是服务器错误 |
| `POST /v1/liquidity-pools/deposit`、`/withdraw`、`GET /v1/liquidity-pools/operations`、`/operations/:id`、`POST /v1/liquidity-pools/operations/:id/submit` 以及 `LIQUIDITY_*` webhook 现在都带有 `memo`（调用方的 MEMO_ID，或 `null`）。在迁移 `20260915120000_liquidity_pool_operation_memo` 之前创建的操作返回 `null`，即使其信封中带有 memo | 无人受影响，除非客户端会拒绝未知字段 | memo 以前只存储在 XDR 中 |
| `GET /v1/swaps` 和 `GET /v1/liquidity-pools/operations` 的已发布契约不再在列表项上声明 `qr` 或 `commissionMemo`。响应本身没有变化——这两个字段从未在列表中返回；需要时请读取单个条目 | 根据 OpenAPI 规范生成的客户端 | 契约把列表项声明为单条读取的结构 |
| 当 `APISIX_GATEWAY_SECRET` 是一个占位符时——`.env.example` 过去附带的那个值，或任何包含 `replace-with`、`change-me`、`your-secret` 或 `placeholder` 的值——服务拒绝启动，且 `.env.example` 现在把它留空 | 仍在使用从 `.env.example` 复制来的值的部署 | 那个值是公开的，且长度足以通过 32 字符的下限，因此任何能访问到本服务的人都可以冒充任意消费者并访问 `/v1/admin` |
| 当 `BLINDPAY_WEBHOOK_SECRET` 已设置但其 key（`whsec_` 之后的 base64 部分）格式错误或解码后不足 24 字节时，服务拒绝启动；在配置的 key 不可用期间，`POST /v1/blindpay/webhooks` 会拒绝所有投递 | 密钥被截断或拼写错误的部署，其 BlindPay webhook 此前就已经在失败 | Node 会把无效的 base64 静默解码成一个很短甚至为空的 HMAC key，而用空 key 签名的投递任何人都能伪造 |
| `GET /v1/health/readiness` 在检查失败时返回标准的错误响应结构（`error: "Service Unavailable"`）；此前它会把健康报告——包括数据库错误信息——放在 `error` 中 | 从响应体而不是状态码读取报告的探针 | 该路由是 `@Public()`，而 Prisma 的错误信息会带出数据库主机名和用户名 |
| 当 receiver、或拥有 `blockchain_wallet_id` 的 receiver 被停用时，`POST /v1/onramp/receivers/:id/virtual-accounts` 返回 `403 account_disabled` | 没有正当用户会注意到 | 这是熔断开关此前唯一没有覆盖到的法币操作：被停用的账户仍能开出一条新的入金通道 |
| `POST /v1/pollar/oauth/token` 不再兑换一个已被 `GET /v1/pollar/oauth/sessions/:state` 的更新一次轮询替换掉的 code，即使那次轮询恰好落在兑换过程中途 | 没有正当用户会注意到 | 此前的校验只匹配握手，不匹配 code，因此一个已作废的 code 仍能在这个窗口期内被使用 |
| `POST /v1/swaps/:id/submit` 和 `POST /v1/liquidity-pools/operations/:id/submit` 会最先检查信封：无法解析、不是该行自己的信封，或不携带任何签名的请求体，无论该行处于什么状态都返回 `400 validation_failed`。任意的 `signedXdr` 不会再返回一行 `SUCCEEDED`，而 `EXPIRED` 行面对不匹配的请求体会返回 `validation_failed`，而不是 `invalid_state_transition` | 提交未签名的 `xdr` 并依赖 `tx_bad_auth` 拒绝的客户端 | 签名不会改变交易的哈希，因此未签名的信封可能被循环转发并遭拒绝，而在共享公共 key 下，仅凭一个行 id 就能读到一笔已结算的记录 |
| 两个提交路由都会拒绝一个已超出时间边界的信封（`400 invalid_state_transition`，不会广播；如果它已经上链，观察器仍会将其结算），以及一行已经重新提交过 3 次的 `FAILED` 记录（`400 invalid_state_transition`：请构建一笔新的）。在 `503 provider_unavailable` 之后的重试不计入次数 | 在循环中重试提交的客户端：遇到 `invalid_state_transition` 就应停止 | 每一次被拒绝的重新提交都是一次 Horizon 提交和一个新的终态 webhook 事件，且此前没有任何上限 |
| 两个提交路由都允许每个消费者和客户端地址每分钟调用 20 次，各自使用独立的额度（`429 rate_limited`） | 位于同一 NAT 之后、共用公共 key 的钱包 | 这两个路由都接受共享公共 key，且每次调用都可能向 Horizon 广播 |
| `GET /v1/webhooks`、`GET /v1/webhooks/:id` 和 `PATCH /v1/webhooks/:id` 只返回已发布的端点字段；`POST /v1/webhooks` 和 `POST /v1/webhooks/:id/rotate-secret` 在此基础上额外返回 `secret`。`consumerId`、`previousSecret` 和 `previousSecretExpiresAt` 从这五个路由的响应中全部移除 | 读取这些字段的调用方 | `previousSecret` 是一个集成方可能仍在接受的签名密钥，而只持有 `webhooks:read` 的 key 就能读到它 |
| 一个与该别名任何一次有效恢复都不匹配的 token，不再计入该次恢复的尝试次数。一个有效的 token 在每次提交时都会消耗一次用量，包括之后 challenge 或签名验证失败的那次；第五次之后返回 `400 alias_recovery_invalid` | 没有正当用户会注意到 | 别名名称是公开的，因此任何一个 key 发送的五个垃圾 token 就能耗尽控制台发起的每一次恢复 |
| `POST /v1/aliases/:name/recovery/complete`（每 10 分钟 10 次）、`POST /v1/aliases/challenges`（30 次）、`POST /v1/webhooks/:id/ping`（20 次）和 `POST /v1/webhooks/:id/deliveries/:deliveryId/redeliver`（30 次）在超出预算时返回 `429 rate_limited`，按消费者和客户端地址计算 | 在循环中调用这些路由的脚本 | 每次调用都会存储一行记录、尝试一个恢复 token，或向调用方选择的 URL 发送请求 |
| `PATCH /v1/payment-intents/:id` 要求 `txHash` 必须是 64 字符的十六进制 Stellar 交易哈希（其他任何值都返回 `400`），并以小写形式存储；`POST /v1/payment-intents/:id/validate` 会将自己收到的哈希转为小写。哈希唯一性现在只在一个消费者自己的意图范围内校验，而不是跨所有租户；与你自己另一个意图上的哈希冲突会返回 `409 idempotency_conflict`（此前是 `500`） | 发送占位符或被截断哈希的调用方 | 此前任何租户都能把别的租户的交易哈希占用到自己的意图上；那个租户的结算随后命中全局索引、得到 `500`，而那笔已支付的意图则在没有触发 `PAYMENT_INTENT_SUCCEEDED` 的情况下过期 |
| 当一笔 `EXPIRED` 意图的支付在链上得到验证时，它会转为 `SUCCEEDED`：既可能是观察器验证的——它现在会在使意图过期之前先查链，也可能是 `POST /v1/payment-intents/:id/validate` 或 `PATCH {status: SUCCEEDED}` 验证的，这两者现在返回 `200`，而不是 `400 invalid_state_transition`。`PAYMENT_INTENT_SUCCEEDED` 可能紧跟在 `EXPIRED` 这次更新触发的事件之后到来 | 把 `EXPIRED` 当作最终状态的 webhook 消费方 | 过期检查此前从不查链，而验证器只读取发往目标地址的最新 50 笔支付，因此一笔延迟到达或排在靠后位置的支付会让一个已支付的意图永久停留在 `EXPIRED` |
| 带 `redirect_uri` 的 `POST /v1/pollar/oauth/authorize` 需要 `code_challenge`（PKCE，S256），兑换该握手需要 `code_verifier`；缺少时，在打开 Pollar 会话之前调用就会返回 `400 validation_failed`。轮询流程不变 | 不发送 PKCE 的重定向流程钱包 | 公开回调会把 code 交给任何出示 `state` 的人，而 `state` 就在 `authorization_url` 里；没有 PKCE 时，这个 code 可以被原样兑换 |
| swap、流动性池操作、支付意图和客户的响应现在只返回其文档化字段，另外 swap 和支付意图上的 `expiresAt` 现已写入文档。`consumerId` 以及结算记账字段（`settlementEpoch`、`lastCheckedAt`、`notFoundStreak`、`sharesReceived`、`settledAmountA`/`B`、`horizonCursor`）不再发送 | 读取这些字段的调用方 | 它们是内部字段，而且其中好几个路由可以用共享公共 key 访问 |
| 对已存在于 BlindPay 的 receiver 调用 `PATCH /v1/kyc/receivers/:id` 时，除 `external_id` 和 `image_url` 外的任何字段都会返回 `403 kyc_review_required`，除非该 key 是提升权限的 key（`X-Consumer-Role: admin`） | 用租户 key 修正已上线 receiver 身份信息的集成方：请交由审核者处理 | 该 `PUT` 会把从未审核过的身份数据直接发给受监管的服务商，而启用之前的同样修改会重新进入审核 |
| BlindPay 路由使用调用方 key 所属环境的实例：`prod` key 使用无后缀的 `BLINDPAY_*` 实例，`dev` key 使用 `BLINDPAY_*_DEV` 实例；未配置开发实例时，`dev` key 会得到 `503 misconfigured`。receiver、钱包、银行账户、虚拟账户、报价、payin 和 payout 只在该实例上读取和执行 | 使用 `dev` key 调用 BlindPay 的任何人 | 此前 `dev` key 操作的是生产实例：它可以列出和删除真实的 KYC 身份，并创建真实的 payout |
| 只有当 Pollar 为该登录报告的邮箱就是网关为该 key 转发的账户邮箱（`X-Consumer-Email`）时，`POST /v1/pollar/oauth/token` 才会返回会话。不一致时会吊销会话、使握手失败并返回 `403 pollar_identity_mismatch`；没有转发邮箱的 key 在 `authorize` 时会得到 `403 pollar_identity_required` | 通过共享的 Pollar 应用为自己的终端用户登录的租户，以及用与账户不同的邮箱登录的任何人 | 所有租户共享同一个 Pollar 应用，而登录链接在任何浏览器里都能用：一个 key 可以把自己的 `authorization_url` 发给某人，等待其同意，然后兑换那个人的托管钱包 |
| `POST /v1/pollar/users` 和 `/v1/pollar/users/with-wallet` 需要提升权限的 key；租户 key 会得到 `403 elevated_key_required` | 用租户 key 预注册用户的集成方 | 注册的用户就是之后社交登录按邮箱解析到的用户，因此租户 key 可以抢注陌生人的邮箱，并被记录为其钱包的所有者 |
| testnet 登录不再为其用户开通主网钱包：testnet 兑换的 `network_wallets` 只列出 testnet 钱包。主网登录仍会开通 testnet | 读取 testnet 登录的主网条目的任何人 | 任何人都能创建的 `dev` key 每次登录都会花费运营方的真实 XLM 为主网储备金注资 |
| 轮询、refresh、logout、token 校验、用户注册和删除 trustline 的 Pollar 路由都有了限流，并且在按地址的预算之上还叠加了按消费者的配额（每分钟 100 个 Pollar 请求）和钱包上限（每天 50 个）；超出返回 `429 rate_limited` | 频繁调用这些路由的客户端 | 它们之前没有限制，而每次调用都会消耗所有租户共享的 Pollar 请求预算——一个租户就能让所有其他租户的登录失败 |
| `POST /v1/kyc/receivers/:id/approve` 接受 `expected_version`（你读到的那个 `dossierVersion`），当 KYC 数据此后发生变化时返回 `409 kyc_state_invalid`。`POST /v1/kyc/receivers/:id/enable` 会拒绝并非被批准的那份材料，receiver 的读取结果也带上了 `dossierVersion` 和 `reviewedVersion` | 开始发送 `expected_version` 的审核方；其他人不受影响——该字段是可选的 | 审核就是有人先读数据、再予以批准，而中间的一次修改只会把状态留在 `pending_review`，于是批准落在了一份没人看过的材料上，`enable` 又把它送到了受监管的服务商 |
| `POST /v1/kyc/upload`、`/v1/kyc/terms-of-service`、onramp 和 offramp 的写入、`POST /v1/payment-intents/tx` 与 `/pay`、`POST /v1/swaps/quote` 与 `/v1/swaps`，以及 `POST /v1/liquidity-pools/deposit` 与 `/withdraw` 现在超出预算都会按消费者和客户端地址返回 `429 rate_limited`。每个由 BlindPay 支撑的路由还会计入每分钟 60 次服务商请求的按消费者上限 | 在这些路由上打循环的脚本；超过上限的批量导入方应当使用自己的 key | 它们此前完全没有限制：每一个要么在服务商那里留下任何错误都退不回的东西，要么消耗本服务所有路由共享的按 IP 的 Horizon 预算。此前只有提交路由受限 |
| 对于账户尚未用掉其序列号的 `PENDING` swap（未签名或已放弃的信封），`POST /v1/swaps` 不再返回 `409 operation_in_flight`。仅在 `STELLAR_SWAP_SINGLE_INFLIGHT=true` 时适用 | 此前被挡住的钱包用户 | 任何调用方都可以填写任意 `source`，因此一笔粉尘 swap 能把别人的账户一个超时窗口接一个超时窗口地冻住——与上面流动性池的修复是一对 |
| 因主机原因被拒绝的 webhook 目标——解析不到、私有地址、链路本地、元数据——统一为一个 `400` 和一条消息；原因留在服务日志里。格式错误的 URL、非 https 协议、内嵌凭证或缺少主机仍会说明问题所在 | 此前从响应里读取原因的集成方 | 注册端点会解析一个本服务能够到达的名称，因此逐条给出原因就等于让人一个 URL 一个 URL 地摸清内网 |
| 当 `redirect_url` 带有片段、反斜杠、空白字符或控制字符时会被拒绝；不含内嵌凭证的 https 此前就已是必需 | 发送普通 URL 的人不受影响 | `https://app.acme.com\@evil.test` 指向哪个主机取决于谁来解析，而这个值还会被 BlindPay 和浏览器再读一次 |
| 当 `POLLAR_BRIDGE_CALLBACK_URL` 是可路由主机上的纯 `http` 时，服务拒绝启动 | 在别处终止 TLS 并把回调配置成 `http` 的部署 | Pollar 会把浏览器连同查询字符串里的授权码一起送回该地址，而这个授权码可以换取用户的会话 |

随之而来的部署说明：

- **迁移 `20260910120000_aliases`** 会创建 `alias`、`alias_address`、`alias_challenge` 和 `alias_recovery`。请在新构建承接流量之前运行 `migrate deploy`。
- **新的咨询锁 id：`881_008`（`AliasChallengeSweeper`）。** 无需配置。
- **在生产环境中设置 `NODE_ENV=production`。** `.env.example` 中提供的是 `development`，而有两项保护依赖于它：缺少 `X-Plan-Swap-Fee-Bps` 的请求只有在生产环境中才会返回 `503`（在其他任何环境中，swap 会悄悄回退到 `STELLAR_SWAP_FEE_BPS`），而 `/docs`——不受任何 guard 保护——也只有在生产环境中才默认关闭。
- **结算观察器的日志行已更改**为 `Settlement observer started (every Nms)`、`Settlement observer (OBSERVER_ENABLED=false) disabled`，以及 `error` 级别的 `SettlementObserverService cycle failed`。请更新匹配旧文案的告警。`OBSERVER_ENABLED`、`OBSERVER_INTERVAL_MS` 和咨询锁均未改变。
- **迁移 `20260915120000_liquidity_pool_operation_memo`** 添加可空列 `liquidity_pool_operation.memo`：不会重写表，只会短暂持有排他锁。没有回填——旧行的 memo 位于 base64 XDR 中，SQL 无法解码，服务会对这些行回退到信封。
- **迁移 `20260915120100_lookup_indexes`** 以 `CONCURRENTLY` 方式为 Pollar 钱包归属检查构建两个索引（`pollar_oauth_session(consumerId, network, walletAddress)` 和 `pollar_user_wallet(consumerId, network, address)`）。它不会阻塞写入，但构建失败会留下一个 `INVALID` 索引，而 `IF NOT EXISTS` 会把它视为已存在：用 `SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE NOT i.indisvalid;` 找到它，用 `DROP INDEX CONCURRENTLY` 删除，运行 `prisma migrate resolve --rolled-back 20260915120100_lookup_indexes`，然后重新部署。
- **现在有两个变量会在启动时被检查。** 一个占位符形式的 `APISIX_GATEWAY_SECRET`，或一个 key 解码后不足 24 字节的 `BLINDPAY_WEBHOOK_SECRET`，都会让服务无法启动，并给出一条指名该变量的错误信息。请在同一次变更中，同时替换 APISIX 路由上和这里的占位符网关密钥（`openssl rand -hex 32`）；两边不一致会让每个请求都被判定为并非来自网关。
- **迁移 `20260915150000_payment_intent_tx_hash_per_consumer`** 把 `payment_intent."txHash"` 上的唯一索引替换为一个建在 `("consumerId", "txHash")` 上的索引。它不是 `CONCURRENTLY` 的：索引构建期间 `payment_intent` 会被加写锁。没有回填。
- **已存储的 `webhook_endpoint.previousSecret` 值不再被返回，但没有任何东西会清除它们。** 如果某次更早版本上的轮换留下了这样一个值，而你想把它从数据库中彻底清除，请自行把这两列置空。
- **迁移 `20260915160000_blindpay_environment`** 为七张 BlindPay 镜像表添加 `environment` 列（默认 `'prod'`）——只改动目录，不重写表——因此现有行都会被标记为生产。**如果你之前无后缀的 `BLINDPAY_*` 变量指向的是 BlindPay 开发实例**，请把它们移到 `_DEV` 变量，并重新标记这些行（在 `blindpay_receiver`、`blindpay_blockchain_wallet`、`blindpay_bank_account`、`blindpay_virtual_account`、`payin`、`payout` 和 `blindpay_quote` 上执行 `UPDATE … SET environment = 'dev'`），否则 `prod` key 会继续读到它们。
- **如果 `dev` key 要使用 BlindPay，请配置 BlindPay 开发实例**（`BLINDPAY_API_KEY_DEV`、`BLINDPAY_INSTANCE_ID_DEV`、`BLINDPAY_WEBHOOK_SECRET_DEV`），并把它的仪表盘 webhook 指向同一个 `/v1/blindpay/webhooks` URL。
- **先部署开发者平台的 forwarder 变更。** 网关没有为其转发 `X-Consumer-Email` 的 key，`authorize` 一律拒绝。forwarder 会在账户的 key 每次同步时按账户写入邮箱，因此请重新同步现有消费者（在仪表盘中列出某个用户的 key 就会为该用户完成同步）。在此之前，钱包会回退到开发者平台的代理式登录，它不需要该请求头；其他客户端会得到 `403 pollar_identity_required`。
- **通过共享 Pollar 应用为第三方终端用户提供的社交登录将停止工作。** 其应用为自有用户登录的租户，会对每个邮箱不是该 key 账户邮箱的用户得到 `403 pollar_identity_mismatch`。
- **迁移 `20260915180000_pollar_testnet_counterpart_mainnet`** 会关闭 testnet 登录遗留为 `pending` 的主网钱包（`FAILED`、`COUNTERPART_FROM_TESTNET_DISABLED`），让清扫器停止为它们注资。仅修改数据，不改变 schema。
- **迁移 `20260915200000_receiver_dossier_version`** 为 `blindpay_receiver` 增加 `dossierVersion`（默认 `1`）和 `reviewedVersion`——只改目录，不重写表——并为所有已经通过审核关卡的 receiver 回填 `reviewedVersion`，使它们的 `enable` 继续可用。仍处于 `inactive` 或 `pending_review` 的 receiver 保持 `NULL`，那正是它们的真实状态。
- **部署前请检查 `POLLAR_BRIDGE_CALLBACK_URL`。** 可路由主机上的纯 `http` 现在会让服务无法启动，错误信息中会点名该变量。回环地址（`http://127.0.0.1:…`）仍然接受，供本地开发使用。
- **此前从不返回 `429` 的路由现在会返回。** 上表中的预算自本版本起生效；在 KYC 上传、报价、payin、payout、意图构建、swap 报价或流动性池构建上打循环的客户端需要遵守 `Retry-After`。发生故障时可用 `RATE_LIMIT_ENABLED=false` 关闭限流器。

### OpenAPI 契约只列出每个路由实际返回的内容

线上的响应没有任何变化；变化的是发布的契约。请重新生成所有基于 `openapi/openapi.json` 生成的客户端：

- 每个操作只列出它可能返回的失败。`409` 只出现在路由自行记录了冲突的地方，`429` 只出现在有限流的路由上，`502`/`503`/`504` 只出现在会调用提供方的路由上，健康探针不再列出 `401`/`403`。共用的失败响应以 `$ref` 指向 `components.responses`。
- 每个失败示例都与其状态码相符。此前规范在每个路由的每个状态码下都显示同一个 `409 idempotency_conflict`。
- `X-Gateway-Secret` 与 `X-Consumer-Username` 构成同一个安全要求（两个请求头都要），并发布 `Authorization: Bearer` 作为经网关调用时的替代方案。此前它们是两个可选项，让工具以为任意一个请求头就足够。
- `GET /v1/health/readiness` 的 `503` 以错误响应结构记录。此前它被记录为 Terminus 报告，而异常过滤器从不返回该报告。

### NestJS 12、TypeScript 6 与 Node 最低版本 24.9

本服务现在运行在 NestJS 12 和 TypeScript 6 上，**要求 Node 24.9 或更高版本**（`engines`；CI 固定为 `node-version: 24`）。请相应更新部署目标。

NestJS 12 以 ESM 形式发布，而 Jest 只有在 Node >= 24.9 且使用 `--experimental-vm-modules` 时才能加载它，因此测试脚本直接通过 Node 运行 Jest：

```
"test": "node --experimental-vm-modules node_modules/jest/bin/jest.js"
```

发布的 OpenAPI 契约从 `@nestjs/terminus@12` 获得了更丰富的健康检查 schema（状态枚举和 `responseTime`）。没有任何业务路由或 schema 发生变化。

### 共享公共 API key，以及限制它的 guard

`PublicKeyGuard`（全局，位于 `PermissionsGuard` 之后）和 `@AllowPublicKey()` 装饰器是新增的。现有的 key 不受影响。部署时：

- **设置 `APISIX_PUBLIC_CONSUMER`** 为开发者平台为公共 key 配置的用户名，每个发布了公共 key 的部署都要设置。没有它，guard 只依赖转发的 `X-Consumer-Role`。
- **以 `role: public` 创建公共 key**，并且只授予白名单路由所需的 scope。`kyc:*` 之类的额外 scope 并不会开放那些路由，但一个人人持有的 key 不应该带有它们。

见上文“共享公共 API key”。

### 资产注册表：`GET /v1/assets`

一份精选列表，按网络记录本平台支持的（code、issuer）对，并注明发行机构。它不需要任何 scope，因为其中没有租户数据，但它确实需要一个已认证的消费者（共享公共 key 也可以）。

`npm run assets:verify` 会对照实时的 Horizon 检查每一行：该资产对是否存在于它所在的网络上、`contract` 是否与 Horizon 的 `contract_id` 一致，以及发行方标志是否与链上一致。编辑注册表时请运行它；它需要访问互联网，因此不属于单元测试。

### 客户端活动：一个新模块、一张新表和两个新 scope

`POST /v1/activity/events` 接收来自钱包和开发者仪表盘的遥测数据；`GET /v1/activity/events` 和 `GET /v1/activity/summary` 用于读取。现有的响应都没有变化。部署时：

- **迁移 `20260906140000_activity_event`** 会创建 `activity_event`（仅追加、按 `consumerId` 隔离、在 `(consumerId, eventId)` 上唯一）。
- **scope `activity:write` 和 `activity:read` 是新增的。** 现有的 key 不会自动获得它们，会收到 `insufficient_scope`。开发者平台会把这两个 scope 授予为钱包配置的 key，并在轮换时重新应用；手动创建的 key 需要手动添加。
- **`ACTIVITY_RETENTION_DAYS`**（默认 30）加入保留期清理任务。这些行与访问日志一样包含个人数据。

### Pollar 轮询路由现在会自行发现已完成的登录

`GET /v1/pollar/oauth/sessions/{state}` 过去会等待桥接回调，而 Pollar 从不调用该回调，因此轮询流程的登录会一直停留在 `pending` 直到过期。现在轮询会向 Pollar 检查，并在 `READY` 时推进握手。API 结构和客户端都无需改动。部署时：

- **迁移 `20260906120000_pollar_oauth_provider_probe`** 为 `pollar_oauth_session` 添加一个可为空的 `providerCheckedAt`。不做回填。
- **轮询流量现在会到达 Pollar。** 请按每个进行中的登录每两秒一个服务商请求来做预算，使用的是该网络的 publishable key。

### Pollar 登录现在会在两个网络上各开通一个钱包

`POST /v1/pollar/oauth/token` 新增了一个 `network_wallets` 数组——每个 Stellar 网络一个条目，状态为 `ready`、`pending` 或 `failed`。这是纯新增的变更。部署时：

- **运行迁移。** `20260905120000_pollar_user_wallet` 添加了 `pollar_user_wallet` 和 `PollarWalletStatus` 枚举。没有它，每次兑换都会记录一次开通失败，对应钱包也不会被记录——登录本身仍然正常工作。
- **为两个网络都设置 key。** `POLLAR_*_MAINNET` 和 `POLLAR_*_TESTNET` 各自都是可选的，而没有 key 的网络会在每次登录时显示为一个 `pending` 钱包。设置第二组 key 后，清扫器会在下一个周期开通积压的钱包；否则这些行会保持 `pending`，直到尝试次数用完。无论哪种情况，登录都不会失败。

主网登录会在*两个*网络上都为储备金注资。testnet 登录只为 testnet 注资——它过去也会为主网注资，上面的安全审查修复已将其移除。

### `429` 现在报告 `rate_limited`

过去 `429` 会报告 `code: "provider_unavailable"`。现在它报告 `code: "rate_limited"`（`ApiErrorCode.RateLimited`，属于已发布的枚举）。如果你在被限流时重试，请基于它做分支判断。

### 未配置的 BlindPay 现在报告 `misconfigured`

在 BlindPay 未配置时，有两个响应发生了变化：

| 请求 | 过去 | 现在 |
| ---- | ---- | ---- |
| 在 `BLINDPAY_API_KEY` 或 `BLINDPAY_INSTANCE_ID` 未设置时，调用 BlindPay 的路由（位于 `/v1/kyc`、`/v1/onramp` 或 `/v1/offramp` 下） | `503` `provider_unavailable` | `503` `misconfigured` |
| 在 `BLINDPAY_WEBHOOK_SECRET` 未设置时的 `POST /v1/blindpay/webhooks` | `400` `validation_failed` | `503` `misconfigured` |

这两者都是部署配置错误，重试无法修复。Svix 会对任何非 2xx 响应重试，因此 webhook 投递不受影响。Pollar 在同样的情况下早已返回 `misconfigured`。

### 发生变化的响应结构

`/v1` 下有三个已发布的响应结构发生了变化（不存在 `/v2`），因此请在部署之前通知集成方。

| 端点 | 之前 | 现在 | 原因 |
| -------- | --- | --- | --- |
| `GET /v1/webhooks` | 裸数组，静默截断为 100 条 | `{ data, total, take, skip }` | 结果被截断为 100 条，且没有可用于分页的 `total` |
| `GET /v1/products` | 裸数组，整张表 | `{ data, total, take, skip }` | 无上限的读取 |
| `GET /v1/webhooks/:id/deliveries` 以及重新投递的响应 | 包含 `payload` | 移除了 `payload` | `RECEIVER_UPDATED` 的内容是一份完整的 KYC 档案，而这些路由受 `webhooks:read` 而非 `kyc:read` 保护 |

遍历响应或读取 `delivery.payload` 的调用方会出错：请改为读取 `res.data`，并使用持有 `kyc:read` 的 key 从 KYC 端点获取 KYC 详情。

`RECEIVER_UPDATED` / `PAYIN_*` / `PAYOUT_*` 的 **webhook 内容**也收窄为只包含标识和状态——见 Webhooks 一节。

### 审计加固迁移

它以两个文件的形式发布，必须按顺序应用：

- `20260901120000_audit_hardening` — 正确性相关的工作：一个新列、对 `liquidity_pool_operation` 执行去重的 `DELETE`、两个 `UNIQUE` 索引、两张新表。该 DELETE 和唯一索引在同一个事务中、在 `SHARE ROW EXCLUSIVE` 锁下运行，因此对该表的写入会阻塞几毫秒。
- `20260901120100_audit_hardening_indexes` — 九个新增索引，以 `CONCURRENTLY` 方式构建，因此部署**不会**阻塞对 `payment_intent`、`swap`、`webhook_delivery` 或 `request_log` 的写入。无需维护窗口。

之所以拆成两个文件，是因为 PostgreSQL 不允许在事务中执行 `CREATE INDEX CONCURRENTLY`，而第一个文件需要事务。

如果第二个文件中途失败，它可能会留下一个**无效**索引，而 `IF NOT EXISTS` 会把它视为已存在。找到它，删除它，然后重新运行：

```sql
SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE NOT i.indisvalid;
```

### `ADMIN_API_CREDENTIALS` 已移除 — `/v1/admin` 归平台控制台所有

**删除该变量。** 它已不再被读取，开发者平台中对应的 `COSMOS_ADMIN_API_SECRET` / `COSMOS_ADMIN_API_SECRET_READ` 也随之移除。

它是叠加在开发者平台自身角色检查之上的第二道管理员检查，跳过它的部署在控制台发起跨租户读取时会得到 `401 admin_credentials_required`。现在 `/v1/admin` 只接受来自平台控制台的请求，这由请求上的两点来确认：

1. `X-Gateway-Secret` 与 `APISIX_GATEWAY_SECRET` 匹配——由 `ApisixGuard` 检查，与其他所有路由一样。只有网关和控制台后端持有它。
2. 存在 `X-Cosmos-Internal`。APISIX 会从它代理的每个请求中剥离该请求头（`proxy-rewrite.headers.remove`），因此 API key 调用方无法携带它；只有持有网关密钥的后端发起的直接调用才能携带。

第 2 点依赖于开发者平台仓库中的网关路由配置，而不是本服务持有的密钥。作为交换，控制台是唯一决定谁是平台管理员的地方，并且审计记录会记下执行操作的控制台账户（`cosmos_<userId>`）及其平台角色，每次变更**和**每次读取都会记录。

这对调用方意味着什么：

| 之前 | 现在 |
| --- | --- |
| 没有 Bearer 密钥时返回 `401` `admin_credentials_required` | 任何非控制台调用返回 `403` `admin_console_only` |
| `read` 凭证执行变更操作时返回 `403` `admin_role_required` | 已移除——控制台已经判定该账户可以执行操作 |
| 审计记录上的 `actorId` / `actorRole` 指的是凭证 | 它们指的是控制台账户及其平台角色 |

要直接调用 `/v1/admin`（例如从运维脚本），请发送 `X-Gateway-Secret`、`X-Consumer-Username` 和 `X-Cosmos-Internal: 1`；再添加 `X-Cosmos-Admin-Role: owner` 为审计记录打上标签。请让服务远离公网。

### `APISIX_GATEWAY_SECRET` 现在要求 32 个字符

密钥短于该长度时服务拒绝启动。它现在还保护着 `/v1/admin`（见上文）。用 `openssl rand -hex 32` 生成一个，并同时更新 APISIX。

### 本版本取代的 `v0.1.0`–`v0.1.5` 功能

从 `v0.1.5` 升级的部署会失去以下行为。每一项集成方都能察觉，因此请围绕它们规划升级。

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

**数据库中没有删除任何内容。** 这些功能添加的列、索引和枚举值（`webhook_delivery.maxAttempts` / `nextAttemptAt` / `leaseUntil`、`webhook_endpoint.previousSecret*`、`swap` 和 `liquidity_pool_operation` 的 `lastCheckedAt` / `notFoundStreak`、`horizon_account_cursor` 表、`RETRYING`、`SWAP_EXPIRED`、`LIQUIDITY_EXPIRED`）仍声明在 `schema.prisma` 中，并且在 `migrate deploy` 之后依然存在；只是不再被写入。删除它们需要一次破坏性迁移（PostgreSQL 无法在不重建类型的情况下删除枚举值）。

## 环境变量

`src/` 中从 `process.env` 读取的每个变量都会在启动时由 `src/config/env.validation.ts` 校验（快速失败）。复制 `.env.example`，并至少调整 `DATABASE_URL` 和 `APISIX_GATEWAY_SECRET`。

| 变量 | 必需 | 默认值 | 作用 |
| -------- | -------- | ------- | ------ |
| `NODE_ENV` | 否 | `development` | 必须为 `development`、`test` 或 `production`。**在生产环境中设置为 `production`**——默认拒绝的套餐手续费检查和默认关闭文档都依赖于它 |
| `PORT` | 否 | `3000` | HTTP 监听端口 |
| `DATABASE_URL` | **是** | — | Prisma 使用的 PostgreSQL 连接 |
| `APISIX_GATEWAY_SECRET` | **是** | — | 证明请求经由 APISIX 到达的共享密钥。**至少 32 个字符**；占位符值会在启动时被拒绝 |
| `APISIX_GATEWAY_SECRET_HEADER` | 否 | `x-gateway-secret` | 网关密钥的请求头名称 |
| `APISIX_CONSUMER_HEADER` | 否 | `x-consumer-username` | 已认证的消费者用户名 |
| `APISIX_CREDENTIAL_HEADER` | 否 | `x-credential-identifier` | 来自 key-auth 的凭证 id |
| `APISIX_ENVIRONMENT_HEADER` | 否 | `x-consumer-env` | key 的环境（`dev` / `prod`） |
| `APISIX_ROLE_HEADER` | 否 | `x-consumer-role` | 网关转发的消费者角色 |
| `APISIX_PERMISSIONS_HEADER` | 否 | `x-consumer-permissions` | 网关转发的权限列表 |
| `APISIX_ORGANIZATION_HEADER` | 否 | `x-consumer-org` | 组织 id |
| `APISIX_PLAN_HEADER` | 否 | `x-consumer-plan` | 组织套餐 |
| `APISIX_SWAP_FEE_BPS_HEADER` | 否 | `x-plan-swap-fee-bps` | 套餐 swap 手续费（bps） |
| `APISIX_EMAIL_HEADER` | 否 | `x-consumer-email` | key 所属账户的已验证邮箱。Pollar bridge 只会把登录的会话返回给该账户，并拒绝没有邮箱的 key |
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
| `BLINDPAY_API_KEY` | 否 | — | BlindPay 生产实例的 API key，供 `prod` key 使用 |
| `BLINDPAY_INSTANCE_ID` | 设置了 API key 时 | — | BlindPay 实例 id（`in_...`） |
| `BLINDPAY_BASE_URL` | 否 | `https://api.blindpay.com/v1` | BlindPay API 基础 URL |
| `BLINDPAY_WEBHOOK_SECRET` | 设置了 API key 时 | — | 入站 BlindPay webhook 的 Svix 密钥：完整的 `whsec_…` 值，其 key 必须解码为至少 24 字节（启动时会检查） |
| `BLINDPAY_API_KEY_DEV` | 否 | — | BlindPay 开发实例的 API key，供 `dev` key 使用。未设置时，BlindPay 路由对 `dev` key 返回 `503 misconfigured` |
| `BLINDPAY_INSTANCE_ID_DEV` | 设置了开发 API key 时 | — | 开发实例 id（`in_...`） |
| `BLINDPAY_WEBHOOK_SECRET_DEV` | 设置了开发 API key 时 | — | 开发实例 webhook 端点的 Svix 密钥；规则与 `BLINDPAY_WEBHOOK_SECRET` 相同 |
| `BLINDPAY_TIMEOUT_MS` | 否 | `15000` | BlindPay HTTP 客户端超时（ms） |
| `KYC_REDIRECT_URL_WHITELIST` | 否 | — | 按消费者划分的 KYC 重定向主机白名单 |
| `RATE_LIMIT_ENABLED` | 否 | `true` | 对花费 XLM 的路由按地址设置上限。事故开关 |
| `RATE_LIMIT_PRUNE_INTERVAL_MS` | 否 | `600000` | 计数器窗口清理间隔（ms，最小 1000） |
| `POLLAR_PUBLISHABLE_KEY_TESTNET` / `_MAINNET` | 否 | — | Pollar publishable key（`pub_<network>_…`），用于 OAuth 桥接 |
| `POLLAR_SECRET_KEY_TESTNET` / `_MAINNET` | 与 publishable key 同时设置 | — | Pollar secret key（`sec_<network>_…`），用于运营方路由 |
| `POLLAR_BRIDGE_CALLBACK_URL` | 设置了 Pollar key 时 | — | Pollar 将浏览器送回的公开 URL。必须是 `<gateway>/v1/pollar/oauth/callback`、**https**（只有回环主机才允许纯 `http`——否则启动失败：授权码就写在它的查询字符串里），**并且**是在 Pollar 的 Build → Domains 下注册过的主机 |
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

`key-auth` 在认证成功后会把 `X-Consumer-Username` / `X-Credential-Identifier` 转发给上游，并覆盖客户端提供的任何副本，guard 正是依赖这一点。

> **移除列表是一项安全控制，而且无法在本仓库中验证。** 本服务对列表中的每个请求头都照单全收；`X-Gateway-Secret` 只能证明请求经过了网关，而不能证明这些值是可信的。每当添加或复制路由时都要审查这个列表——一个没有剥离 `X-Cosmos-Internal` 的路由会让每个 API key 都能访问 `/v1/admin`。请让服务位于私有网络中，使 APISIX 成为唯一入口；共享密钥是第二层防护，而不是唯一的一层。
>
> 在生产环境中，缺少 `X-Plan-Swap-Fee-Bps` 会返回 `503`，而不是回退到环境变量的默认值。
