# Cosmos Pay — पेमेंट्स माइक्रोसर्विस

[English](../../README.md) · [Español](./README.es.md) · [Português](./README.pt.md) · [Deutsch](./README.de.md) · [Français](./README.fr.md) · **हिन्दी** · [简体中文](./README.zh.md)

**NestJS 12** + **Prisma 7 (PostgreSQL)** से बनी पेमेंट्स माइक्रोसर्विस।

यह Cosmos developer platform (`paydev`) से एक *अलग* एप्लिकेशन है। dev platform
downstream सर्विसों के लिए केवल APISIX access tokens (consumers + `key-auth`
credentials) **जारी** करता है। यह सर्विस उन्हीं downstream सर्विसों में से एक है: यह
**APISIX के पीछे** रहती है, जो हर request को यहाँ भेजने से पहले load-balance और
authenticate करता है। इसलिए यह सर्विस कभी raw API keys नहीं देखती
— यह केवल उसी पर भरोसा करती है जो gateway आगे भेजता है।

## "केवल APISIX" कैसे लागू किया जाता है

कोई request तभी स्वीकार की जाती है जब **दोनों** शर्तें पूरी हों (देखें
`src/common/guards/apisix.guard.ts`):

1. **Gateway का shared secret।** request में `X-Gateway-Secret` होता है, जिसकी तुलना
   constant time में `APISIX_GATEWAY_SECRET` से की जाती है। APISIX हर proxied request पर
   यह header *inject* करता है और client की भेजी हुई किसी भी कॉपी को *हटा* देता है, इसलिए
   सही मान केवल gateway से ही आ सकता है। (Defense in depth — इसे
   network isolation के साथ इस्तेमाल करें ताकि सर्विस तक सीधे न पहुँचा जा सके।)
2. **Authenticated consumer।** APISIX का `key-auth` plugin, caller की API key
   validate करने के बाद, `X-Consumer-Username` (और
   `X-Credential-Identifier`) आगे भेजता है। guard के लिए consumer header का
   मौजूद होना ज़रूरी है, जो साबित करता है कि key upstream में authenticate हो चुकी है।

रूट `@Public()` लगाकर इस जाँच से बाहर रह सकते हैं (orchestrator जिन health probes को
सीधे कॉल करता है, वे यही करते हैं)। यह जाँच हमेशा चालू रहती है — इसे बंद करने का कोई flag नहीं है। local
development के लिए, APISIX के पीछे चलाएँ या `X-Gateway-Secret` + `X-Consumer-*`
headers खुद भेजें।

`/v1/admin` cross-tenant है, इसलिए `AdminGuard` को `X-Cosmos-Internal` भी चाहिए।
APISIX अपने proxy किए हर request से यह header **हटा** देता है, इसलिए इसे केवल वही
backend भेज सकता है जो gateway secret के साथ सर्विस को सीधे कॉल करता है — यानी developer
platform, जो तय करता है कि signed-in account owner है या admin। कोई अलग admin
credential नहीं है: gateway secret, network isolation और gateway रूट की header remove
list ही cross-tenant डेटा की रक्षा करते हैं।

पाइपलाइन:

```
request → ApisixContextMiddleware  (reads consumer headers → req.gatewayConsumer)
        → ApisixGuard (APP_GUARD)  (verifies secret + consumer, or @Public bypass)
        → ValidationPipe           (DTO validation)
        → Controller / Service     (@CurrentConsumer() gives the consumer)
```

## प्रोजेक्ट संरचना

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

सभी रूट `/v1` के अंतर्गत versioned हैं (URI versioning)।

हर रूट नीचे [रूट सूची](#रूट-सूची) में उसके scope के साथ दिया गया है।
**Request और response schemas जनरेट किए गए OpenAPI contract में रहते हैं**, जो
हर CI run पर controllers और DTOs से दोबारा जनरेट होता है
(अगर वह कोड से अलग हो जाए तो `npm run openapi:check` build को fail कर देता है):

- `openapi/openapi.json` / `openapi/openapi.yaml` — commit किए हुए, diff में review किए जा सकते हैं
- `/docs` — Swagger UI, जब `SWAGGER_ENABLED=true` हो
- `/docs/json`, `/docs/yaml` — वही spec, live serve की गई

| क्षेत्र           | Base path                | यह क्या करता है                                          |
| ----------------- | ------------------------ | -------------------------------------------------------- |
| Payment intents   | `/v1/payment-intents`    | SEP-7 `tx` / `pay` intents, वैलिडेशन, on-chain observer |
| Swaps             | `/v1/swaps`              | Path-payment quote, unsigned XDR बनाना, signed XDR submit करना |
| Liquidity pools   | `/v1/liquidity-pools`    | AMM deposit / withdraw, positions, लाभ पर कमीशन        |
| Webhooks          | `/v1/webhooks`           | Endpoint CRUD, secret rotation, deliveries, redelivery    |
| KYC               | `/v1/kyc`                | Receivers (KYC/KYB), वॉलेट, बैंक खाते, दस्तावेज़ अपलोड |
| Onramp            | `/v1/onramp`             | Payin quotes, payins, virtual accounts                    |
| Offramp           | `/v1/offramp`            | Payout quotes, authorize, payouts (client द्वारा signed) |
| प्रोडक्ट्स        | `/v1/products`           | मर्चेंट कैटलॉग                                           |
| कस्टमर्स          | `/v1/customers`          | intents से बने payer रिकॉर्ड                            |
| Aliases           | `/v1/aliases`            | क्लेम किए जा सकने वाले पेमेंट हैंडल: claim, resolve, recover |
| Wallet sign-in    | `/v1/wallet`             | Google / GitHub / ईमेल कोड, और एन्क्रिप्टेड seed बैकअप |
| एसेट्स            | `/v1/assets`             | प्रति नेटवर्क चुनी हुई एसेट रजिस्ट्री                   |
| Pollar            | `/v1/pollar`             | OAuth bridge (सोशल लॉगिन → वॉलेट) + operator रूट       |
| Analytics         | `/v1/summary`, `/v1/balances`, `/v1/logs` | डैशबोर्ड के aggregates और लॉग           |
| एक्टिविटी         | `/v1/activity`           | client द्वारा रिपोर्ट किए गए events: ingest, feed, rollup |
| Admin             | `/v1/admin`              | Cross-tenant reads/writes — केवल प्लेटफ़ॉर्म कंसोल, audited |
| Health            | `/v1/health`             | Liveness / readiness (`@Public`)                          |

### रूट सूची

यह सर्विस जितने भी रूट serve करती है, सब यहाँ हैं। **Scope** वह है जो API key के पास होना चाहिए — *इनमें से
कोई एक* का अर्थ है कि सूचीबद्ध scopes में से कोई भी एक काफ़ी है, और `—` का अर्थ है कोई भी authenticated key।
**Public key** उन रूट्स को चिह्नित करता है जिन्हें साझा public key कॉल कर सकती है (देखें
[साझा सार्वजनिक API key](#साझा-सार्वजनिक-api-key))। *प्लेटफ़ॉर्म कंसोल* चिह्नित रूट
कोई API key नहीं लेता; वहाँ केवल कंसोल का backend पहुँचता है।
Paths OpenAPI के `{param}` रूप में लिखे गए हैं।

| मेथड | पाथ | Scope | Public key |
| ------ | ---- | ----- | ---------- |
| GET | `/v1/activity/events` | `activity:read` |  |
| POST | `/v1/activity/events` | `activity:write` | ✓ |
| GET | `/v1/activity/summary` | `activity:read` |  |
| GET | `/v1/admin/audit-logs` | प्लेटफ़ॉर्म कंसोल |  |
| GET | `/v1/admin/consumers` | प्लेटफ़ॉर्म कंसोल |  |
| GET | `/v1/admin/customers` | प्लेटफ़ॉर्म कंसोल |  |
| GET | `/v1/admin/payins` | प्लेटफ़ॉर्म कंसोल |  |
| GET | `/v1/admin/payment-intents` | प्लेटफ़ॉर्म कंसोल |  |
| GET | `/v1/admin/payouts` | प्लेटफ़ॉर्म कंसोल |  |
| GET | `/v1/admin/products` | प्लेटफ़ॉर्म कंसोल |  |
| GET | `/v1/admin/receivers` | प्लेटफ़ॉर्म कंसोल |  |
| PATCH | `/v1/admin/receivers/{id}/access` | प्लेटफ़ॉर्म कंसोल |  |
| POST | `/v1/admin/receivers/{id}/approve` | प्लेटफ़ॉर्म कंसोल |  |
| POST | `/v1/admin/receivers/{id}/enable` | प्लेटफ़ॉर्म कंसोल |  |
| POST | `/v1/admin/receivers/{id}/tos` | प्लेटफ़ॉर्म कंसोल |  |
| GET | `/v1/admin/summary` | प्लेटफ़ॉर्म कंसोल |  |
| GET | `/v1/admin/swaps` | प्लेटफ़ॉर्म कंसोल |  |
| GET | `/v1/aliases` | `payments:read` |  |
| POST | `/v1/aliases` | `payments:write` |  |
| GET | `/v1/aliases/availability/{name}` | `payments:read` | ✓ |
| GET | `/v1/aliases/by-address/{address}` | `payments:read` | ✓ |
| POST | `/v1/aliases/challenges` | `payments:write` |  |
| GET | `/v1/aliases/resolve/{name}` | `payments:read` | ✓ |
| DELETE | `/v1/aliases/{name}` | `payments:write` |  |
| POST | `/v1/aliases/{name}/addresses` | `payments:write` |  |
| DELETE | `/v1/aliases/{name}/addresses/{addressId}` | `payments:write` |  |
| POST | `/v1/aliases/{name}/recovery` | प्लेटफ़ॉर्म कंसोल |  |
| POST | `/v1/aliases/{name}/recovery/complete` | `payments:write` |  |
| GET | `/v1/assets` | — | ✓ |
| GET | `/v1/balances` | `payments:read` |  |
| POST | `/v1/blindpay/webhooks` | कोई नहीं — `@Public()`, Svix signature |  |
| GET | `/v1/customers` | `customers:read` |  |
| POST | `/v1/customers` | `customers:write` |  |
| GET | `/v1/customers/{id}` | `customers:read` |  |
| PATCH | `/v1/customers/{id}` | `customers:write` |  |
| DELETE | `/v1/customers/{id}` | `customers:write` |  |
| GET | `/v1/health/liveness` | कोई नहीं — `@Public()` |  |
| GET | `/v1/health/readiness` | कोई नहीं — `@Public()` |  |
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
| GET | `/v1/liquidity-pools` | इनमें से कोई एक `liquidity:read`, `swaps:read` | ✓ |
| POST | `/v1/liquidity-pools/deposit` | इनमें से कोई एक `liquidity:write`, `swaps:write` | ✓ |
| GET | `/v1/liquidity-pools/operations` | इनमें से कोई एक `liquidity:read`, `swaps:read` |  |
| GET | `/v1/liquidity-pools/operations/{id}` | इनमें से कोई एक `liquidity:read`, `swaps:read` |  |
| POST | `/v1/liquidity-pools/operations/{id}/submit` | इनमें से कोई एक `liquidity:write`, `swaps:write` | ✓ |
| GET | `/v1/liquidity-pools/positions` | इनमें से कोई एक `liquidity:read`, `swaps:read` | ✓ |
| POST | `/v1/liquidity-pools/withdraw` | इनमें से कोई एक `liquidity:write`, `swaps:write` | ✓ |
| GET | `/v1/liquidity-pools/{poolId}` | इनमें से कोई एक `liquidity:read`, `swaps:read` | ✓ |
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
| GET | `/v1/pollar/oauth/callback` | कोई नहीं — `@Public()` |  |
| GET | `/v1/pollar/oauth/callback/{state}` | कोई नहीं — `@Public()` |  |
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

### एरर रिस्पॉन्स

हर विफलता एक ही envelope लौटाती है, और `code` उसका स्थिर,
machine-readable हिस्सा है — branching उसी पर करें, `message` पर नहीं, क्योंकि वह सामान्य गद्य है और
उसके शब्द बदले जा सकते हैं:

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

envelope और पूरा `code` enum OpenAPI spec में `ApiErrorBodyEntity` के रूप में प्रकाशित
है (स्रोत: `src/common/errors/api-error.ts` में `ApiErrorCode`)। हर operation केवल वही
statuses दर्ज करता है जो वह सच में लौटा सकता है, और हर status में हर संभव `code` का एक
उदाहरण होता है — असली message, मेल खाते `statusCode` और `error` के साथ — ताकि Swagger UI
और Postman import वही body दिखाएँ जो आपको सच में मिलेगी। **एक बार प्रकाशित होने के बाद
codes का नाम कभी नहीं बदला जाता**; नए codes जोड़े जा सकते हैं, इसलिए किसी अनजान code को
उसके HTTP status के रूप में ही समझें।

कुछ codes जिनमें आसानी से भ्रम हो जाता है:

| Code | Status | अर्थ |
| ---- | ------ | ----- |
| `insufficient_scope` | 403 | API key के पास वह scope नहीं है। key को दोबारा provision करें |
| `account_disabled` | 403 | किसी operator ने यह fiat खाता बंद कर दिया है। यह key की समस्या नहीं है |
| `gateway_required` | 403 | request APISIX से होकर नहीं आई |
| `admin_console_only` | 403 | यह रूट प्लेटफ़ॉर्म कंसोल का है (`/v1/admin`, alias recovery शुरू करना)। कोई भी API key इसे कॉल नहीं कर सकती |
| `elevated_key_required` | 403 | यह रूट उस चीज़ में लिखता है जिसे सभी tenants साझा करते हैं (Pollar user directory)। केवल elevated (admin) key इसे कॉल कर सकती है; ज़्यादा scopes से मदद नहीं मिलेगी |
| `pollar_identity_required` | 403 | gateway ने इस key के account का कोई email forward नहीं किया, इसलिए Pollar लॉगिन को इससे जोड़ा नहीं जा सकता |
| `pollar_identity_mismatch` | 403 | Pollar लॉगिन key के account के बजाय किसी दूसरे account ने पूरा किया। session revoke कर दिया गया, लौटाया नहीं गया |
| `idempotency_conflict` | 409 | यह `Idempotency-Key` (या payment-intent memo) किसी *दूसरी* request के लिए पहले ही एक resource बना चुकी है। मूल request दोहराएँ, या नई key का उपयोग करें |
| `kyc_state_invalid` | 409 | KYC state का अवैध transition — यह duplicate request नहीं है |
| `operation_in_flight` | 409 | एक टकराने वाला operation अभी भी settle हो रहा है |
| `payload_expired` | 409 | delivery body retention अवधि पार कर चुकी है और दोबारा नहीं भेजी जा सकती |
| `provider_unavailable` | 502/503/504 | BlindPay या Horizon तक पहुँचा नहीं जा सकता। दोबारा कोशिश करें |
| `misconfigured` | 503 | सर्वर-साइड कॉन्फ़िगरेशन की गलती। दोबारा कोशिश करने से कोई फ़ायदा नहीं होगा |

### एक से अधिक replica चलाना

APISIX कई instances के बीच load-balance करता है, इसलिए हर background timer हर
replica पर चलता है। status के बदलाव पहले से सुरक्षित हैं — हर एक guarded `updateMany`
compare-and-swap है — लेकिन duplicate ticks rate-limit करने वाली API पर Horizon कॉल
कई गुना कर देते। इसलिए हर timer एक PostgreSQL **transaction-level advisory
lock** (`AdvisoryLockService`) लेता है और जब कोई दूसरा replica उसे पकड़े हो तो अपना tick छोड़ देता है:

| Timer                          | Lock key                 |
| ------------------------------ | ------------------------ |
| `SettlementObserverService`    | `SettlementObserver`     |
| `StellarObserverService`       | `PaymentIntentObserver`  |
| `RequestLogRetentionService`   | `RequestLogRetention`    |
| Webhook delivery sweeper       | `WebhookDeliverySweeper` |
| `PollarOauthSweeperService`    | `PollarOauthSweeper`     |
| `RateLimitPruneService`        | `RateLimitPrune`         |
| `PollarWalletProvisionSweeperService` | `PollarWalletProvisionSweeper` |
| `AliasChallengeSweeperService` | `AliasChallengeSweeper`  |

`pg_try_advisory_xact_lock` कभी block नहीं करता, और transaction खत्म होते ही release
हो जाता है, crash या टूटे हुए connection पर भी। session-level lock के उलट, यह
transaction-pooling mode में PgBouncer के पीछे भी काम करता है।

Lock ids `AdvisoryLockKey` enum में रहते हैं। किसी मौजूदा id का नंबर न बदलें —
rolling deploy के दौरान पुराने और नए replicas अलग-अलग locks लेंगे — और रिटायर किया
गया id दोबारा इस्तेमाल न करें।

### पेमेंट वैलिडेशन और on-chain observer

किसी पेमेंट की पुष्टि Stellar नेटवर्क के सामने एक ही जगह होती है
(`StellarVerifierService`): ट्रांज़ैक्शन **सफल** होना चाहिए, उसमें intent के `destination`
को **ठीक उतनी ही राशि** का **native (XLM) पेमेंट** होना चाहिए,
— जब intent में memo हो — तो उसमें **मेल खाता memo** (`memo_type: id`) होना चाहिए, और वह
**intent बनने से एक मिनट पहले से पहले नहीं** close हुआ होना चाहिए
(`TX_CREATED_AT_SKEW_MS`)। यही न्यूनतम आयु-सीमा समान शर्तों वाले किसी पुराने on-chain पेमेंट
को नए intent को settle करने से रोकती है।

दो रास्ते इसी एक नियम का उपयोग करते हैं:

- **मैनुअल:** `POST /v1/payment-intents/:id/validate` के साथ `{ "txHash": "<64-hex>" }`।
  मेल खाने पर intent `SUCCEEDED` पर सेट हो जाता है (और `txHash` सहेजा जाता है) और एक
  `PAYMENT_INTENT_SUCCEEDED` webhook भेजा जाता है। on-chain विफल हुआ tx intent को
  `FAILED` **केवल तभी** करता है **जब वह इसी intent का अपना पेमेंट हो** — वही memo,
  destination और asset। कोई भी दूसरा ट्रांज़ैक्शन, विफल हो या नहीं, एक mismatch है जो
  status को नहीं बदलता, ताकि सही tx अब भी submit किया जा सके। `PATCH
  /v1/payment-intents/:id` के साथ रिपोर्ट किया गया `txHash` अकेले किसी intent को settle नहीं
  करता: यह 64-अक्षर का hex hash होना चाहिए, lowercase में सहेजा जाता है, और यह सिर्फ़ कॉल
  करने वाले consumer के intents में unique होता है (उनमें से किसी दूसरे से टकराने पर `409
  idempotency_conflict`)।
- **स्वचालित (स्थायी observer):** `StellarObserverService` हर
  `OBSERVER_INTERVAL_MS` पर `PENDING` intents के लिए Horizon को poll करता है — रिपोर्ट किए गए `txHash` से, या
  destination पर आए पेमेंट scan करके — और मेल खाने वालों को उसी तरह finalize करता है, इसलिए
  status बदलते हैं और events **बिना किसी के API कॉल किए** भेजे जाते हैं। एक tick
  प्रति consumer अधिकतम `OBSERVER_MAX_INTENTS_PER_CONSUMER` (10) intents लेता है और
  expired intent को कभी scan नहीं करता, इसलिए कोई एक consumer बाकी सबके settlement में
  देरी नहीं कर सकता। local dev के लिए `OBSERVER_ENABLED=false` से बंद करें।

**Expiry पहले चेन जाँचता है।** अपनी lifetime पार कर चुके intent को `EXPIRED` चिह्नित करने
से पहले एक बार और verify किया जाता है: अगर उसका पेमेंट on-chain मिल जाता है तो वह इसके बजाय
`SUCCEEDED` पर settle होता है, और अगर Horizon तक नहीं पहुँचा जा सकता तो उसे अगले tick के लिए
छोड़ दिया जाता है। जब उस पेमेंट का hash उसी consumer के किसी दूसरे intent पर पहले से मौजूद
हो, तो intent को हमेशा के लिए दोबारा कोशिश करने के बजाय expire कर दिया जाता है। expiry के
बाद verify हुआ पेमेंट — चाहे observer से हो या `validate` से — फिर भी `EXPIRED` intent को
`SUCCEEDED` पर ले जाता है और `PAYMENT_INTENT_SUCCEEDED` भेजता है, इसलिए `EXPIRED` को final न
मानें। scan destination के पेमेंट्स को intent बनने तक वापस पढ़ता है, अधिकतम 1,000 (200 के 5
pages); अगर किसी destination को किसी intent की lifetime में इससे ज़्यादा पेमेंट मिलते हैं, तो
hash के साथ `validate` कॉल करें।

### API request logs का retention

`/v1/health` और `/docs` को छोड़कर हर आने वाली request `LoggingInterceptor` द्वारा
`request_log` में जोड़ी जाती है, और यही डैशबोर्ड के **API logs**
view (`GET /v1/logs`) को चलाती है। rows में path, status, duration, और — जब मौजूद हों —
payer का `ip` / `userAgent` शामिल होते हैं।

डैशबोर्ड का traffic (`X-Cosmos-Internal`) छोड़ा नहीं जाता, बल्कि **रिकॉर्ड और चिह्नित** किया जाता है
(`request_log.internal`), और API-log view उसी
कॉलम पर filter करता है, इसलिए कोई भी request header traffic को log से बाहर नहीं रख सकता।

rows **हमेशा के लिए नहीं रखी जातीं**। `RequestLogRetentionService` एक timer पर
`REQUEST_LOG_RETENTION_DAYS` (डिफ़ॉल्ट **30**) से पुरानी rows delete करता है
(`REQUEST_LOG_PRUNE_INTERVAL_MS`, डिफ़ॉल्ट **1h**)। हर cycle छोटे
`REQUEST_LOG_PRUNE_BATCH_SIZE` हिस्सों (डिफ़ॉल्ट **1000**) में delete करता है और तब तक loop करता रहता है जब तक
backlog खत्म न हो जाए या `REQUEST_LOG_PRUNE_MAX_PER_CYCLE` (डिफ़ॉल्ट **50000**) तक न
पहुँच जाए, ताकि बड़ा इतिहास भी एक लंबा table lock पकड़े बिना बराबरी पर आ सके। prune को पूरी तरह
बंद करने के लिए `REQUEST_LOG_RETENTION_DAYS=0` सेट करें (सर्विस boot पर इसे
log करती है)। `(consumer, createdAt)` पर composite index डेटा बढ़ने पर भी
डैशबोर्ड query को तेज़ रखता है।

### क्लाइंट एक्टिविटी (वॉलेट और डैशबोर्ड क्या रिपोर्ट करते हैं)

`request_log` केवल वे requests रिकॉर्ड करता है जो इस सर्विस तक पहुँचीं। वह send स्क्रीन पर
crash हुआ वॉलेट, user द्वारा रद्द किया गया signature, या कुछ भी भेजने से पहले विफल हुआ
डैशबोर्ड पेज नहीं देख सकता, इसलिए clients ऐसे events खुद `POST /v1/activity/events` पर
रिपोर्ट करते हैं।

- **Batch में।** Clients events को queue करके flush करते हैं, इसलिए offline वॉलेट उन्हें
  अगली बार खुलने पर भेज देता है। प्रति request अधिकतम `ACTIVITY_MAX_BATCH` (100)।
- **Retry सुरक्षित है।** किसी event में client का अपना `eventId` हो सकता है;
  `(consumerId, eventId)` unique है और duplicates छोड़ दिए जाते हैं। response
  `accepted` और `duplicates` रिपोर्ट करता है।
- **Attribution gateway से।** rows उसी consumer के नाम पर लिखी जाती हैं जिसे APISIX ने
  authenticate किया; body में इसके लिए कोई field नहीं है।
- **खराब payloads पर भी चलता है।** बहुत लंबा `message` काट दिया जाता है और बहुत बड़ा
  `props` पूरे batch को अस्वीकार करने की बजाय `{"_dropped": "props_too_large"}` से बदल
  दिया जाता है।
- **Timestamps clamp किए जाते हैं।** जब `occurredAt` पाँच मिनट से ज़्यादा आगे या सात दिन
  से ज़्यादा पीछे हो, तो उसे प्राप्ति के समय से बदल दिया जाता है। दोनों समय रखे जाते हैं:
  `at` (client का) और `receivedAt`।

इसे वापस पढ़ना:

| रूट                     | Scope             | क्या लौटाता है                                                       |
| ----------------------- | ----------------- | -------------------------------------------------------------------- |
| `GET /v1/activity/events` | `activity:read` | feed, सबसे नया पहले। Filters: `source`, `level`, `category`, `type` (prefix), `network`, `since`/`until` |
| `GET /v1/activity/summary` | `activity:read` | level/source/category के अनुसार गिनती, शीर्ष event types, शीर्ष errors, sessions, devices, एक दैनिक series |

feed पर `level` एक **न्यूनतम सीमा** है, सटीक मिलान नहीं: `level=warn`
warnings *और* errors दोनों लौटाता है।

`activity_event` में एक IP, एक user agent और client ने जो कुछ भी जोड़ा हो, वह रहता है, इसलिए
उसे `request_log` वाले ही job द्वारा और उन्हीं सीमित batches में prune किया जाता है —
`ACTIVITY_RETENTION_DAYS`, डिफ़ॉल्ट **30**, events को हमेशा रखने के लिए `0`।

### Webhooks (integrators को सूचित करना)

हर integrator (APISIX consumer) एक या अधिक webhook endpoints रजिस्टर करता है। जब कोई
payment intent बदलता है, तो प्लेटफ़ॉर्म एक domain event भेजता है; **dispatcher**
उसे उस consumer के हर सक्रिय endpoint तक पहुँचाता है जिसने उस event
type को subscribe किया है (खाली subscription = सभी), traceability के लिए हर प्रयास रिकॉर्ड करता है, और
linear backoff के साथ दोबारा कोशिश करता है (`WEBHOOK_*` env)।

Event types: `PAYMENT_INTENT_CREATED`, `PAYMENT_INTENT_UPDATED`,
`PAYMENT_INTENT_SUCCEEDED`, `PAYMENT_INTENT_FAILED`, `PAYMENT_INTENT_CANCELLED`,
`PAYMENT_INTENT_DELETED`, `SWAP_CREATED`, `SWAP_SUBMITTED`, `SWAP_SUCCEEDED`,
`SWAP_FAILED`, `LIQUIDITY_CREATED`, `LIQUIDITY_SUBMITTED`, `LIQUIDITY_SUCCEEDED`,
`LIQUIDITY_FAILED`, और साथ में BlindPay से आने वाले `RECEIVER_UPDATED`, `PAYIN_CREATED`,
`PAYIN_UPDATED`, `PAYIN_COMPLETED`, `PAYOUT_CREATED`, `PAYOUT_UPDATED` और
`PAYOUT_COMPLETED`। आधिकारिक सूची `prisma/schema.prisma` में मौजूद
`WebhookEventType` enum है।

**BlindPay से आई bodies।** `RECEIVER_UPDATED` / `PAYIN_*` / `PAYOUT_*` में केवल पहचान
और state होती है — ids, status, राशियाँ, rails — कभी भी व्यक्तिगत डेटा नहीं। provider का
object आगे नहीं भेजा जाता, क्योंकि receiver का payload एक पूरा KYC dossier होता है और
subscribe करने के लिए केवल `webhooks:write` चाहिए। विवरण API से ऐसी key के साथ लें जिसके
पास `kyc:read` / `onramp:read` / `offramp:read` हो। field allowlist
`src/blindpay/blindpay-event-redaction.ts` में है।

Delivery NestJS `EventEmitter2` (`webhook.event`) के ज़रिए अलग की गई है, इसलिए
notification भेजना उस API request को कभी block नहीं करता जिसने उसे trigger किया।

**Outbound destination policy (SSRF):** endpoints को `https` का उपयोग करना होगा और वे
केवल public addresses पर resolve होने चाहिए। रजिस्ट्रेशन loopback, RFC1918 private ranges,
link-local (`169.254.0.0/16`, जिसमें cloud metadata `169.254.169.254` शामिल है), और
ज्ञात metadata hostnames को अस्वीकार करता है। **host पर निर्भर हर अस्वीकृति एक ही जवाब देती
है** — «यह host अनुमत destination नहीं है» — और कारण log में जाता है: «यहाँ resolve नहीं
होता», «`10.0.4.7` पर resolve होता है» और «metadata service पर resolve होता है» में फ़र्क
बताना किसी को भी, जो endpoint रजिस्टर कर सकता है, एक-एक URL करके उस network का नक्शा बनाने
देता जिसमें यह सेवा चलती है। malformed URL, गलत scheme, credentials या host का न होना अब भी
ठीक-ठीक बताते हैं कि क्या गलत है: वे भेजी गई string का वर्णन करते हैं, network का नहीं। यही जाँच हर
delivery से ठीक पहले फिर से चलती है (रजिस्ट्रेशन के बाद DNS बदल सकता है)। HTTP client `redirect: manual`
(कभी `3xx` follow नहीं करता), env से connect/read timeouts, और response body के
अधिकतम आकार का उपयोग करता है।

| Variable | डिफ़ॉल्ट | अर्थ |
| -------- | ------- | ------- |
| `WEBHOOK_CONNECT_TIMEOUT_MS` | `3000` | Connect budget (AbortSignal timeout का हिस्सा) |
| `WEBHOOK_READ_TIMEOUT_MS` | `5000` | Read budget (AbortSignal timeout का हिस्सा) |
| `WEBHOOK_MAX_RESPONSE_BYTES` | `65536` | पढ़ी जाने वाली response body की सीमा |
| `WEBHOOK_TIMEOUT_MS` | `5000` | अलग-अलग timeouts सेट न होने पर पुराना fallback |
| `WEBHOOK_MAX_ATTEMPTS` / `WEBHOOK_BACKOFF_MS` | `3` / `2000` | In-process retry loop, प्रति delivery प्रयास |
| `WEBHOOK_SWEEP_ENABLED` | `true` | crash के कारण अटकी deliveries को recover करता है। incident switch — बुरी तरह विफल हो रहे integrator को redelivery रोकने के लिए `false` सेट करें |
| `WEBHOOK_SWEEP_INTERVAL_MS` | `60000` | कोई replica कितनी बार sweep की कोशिश करता है (प्रति tick केवल एक जीतता है) |
| `WEBHOOK_PAYLOAD_RETENTION_DAYS` | `30` | इसके बाद settle हुई delivery की सहेजी गई body को redaction marker से बदल दिया जाता है। `0` bodies को हमेशा रखता है |

**किसी delivery के लिए 3 नहीं, 9 प्रयास तक हो सकते हैं।** `WEBHOOK_MAX_ATTEMPTS` एक
in-process retry loop को सीमित करता है। इसके बाद sweeper उन deliveries को उठाता है जिनके
कुल प्रयास अभी `WEBHOOK_MAX_ATTEMPTS × 3` से कम हैं, और ये प्रयास घंटों में फैले होते हैं,
इसलिए pod restart से बीच में रुकी delivery खोती नहीं।

**Redelivery केवल retention window के भीतर काम करती है।**
`WEBHOOK_PAYLOAD_RETENTION_DAYS` के बाद सहेजी गई body साफ़ कर दी जाती है (delivery log
रखा जाता है)। sweeper उन rows को छोड़ देता है, और
`POST /v1/webhooks/:id/deliveries/:id/redeliver` `409 payload_expired` लौटाता है।

**Webhooks प्राप्त करना।** कोई भी `2xx` acknowledgement माना जाता है।
`WEBHOOK_READ_TIMEOUT_MS` (डिफ़ॉल्ट 5s) के भीतर जवाब दें। क्रम की गारंटी नहीं है, इसलिए
API से मिलान करें। event `id` पर deduplicate करें; redelivery मूल `id` ही दोबारा इस्तेमाल
करती है (at-least-once delivery)।

**मौजूदा endpoints को migrate करना:** deploy के बाद, चलाएँ

```bash
npm run webhooks:audit-destinations
```

असुरक्षित rows को `destinationBlocked=true` और `enabled=false` मिलता है। Integrators
`PATCH /v1/webhooks/:id` `{ "url": "https://…" }` से URL ठीक करते हैं (वैलिडेशन
फिर से चलता है और flag हटा देता है), या DNS public होने के बाद फिर से enable करते हैं।

**Payload** (integrator के URL पर भेजी जाने वाली POST body):

```jsonc
{
  "id": "evt_...",                 // stable event id (use for idempotency)
  "type": "PAYMENT_INTENT_SUCCEEDED",
  "createdAt": "2026-...",
  "data": { /* the payment intent */ }
}
```

**Headers**:

- `X-Cosmos-Signature: t=<unixSeconds>,v1=<hexHmacSha256>` — endpoint के `whsec_...` secret का
  उपयोग करके `${t}.${rawBody}` का HMAC-SHA256।
- `X-Cosmos-Event`, `X-Cosmos-Event-Id`, `X-Cosmos-Delivery`।

**Signature verify करना (integrator की ओर से):**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody: string, header: string, secret: string): boolean {
  const [t, v1] = header.split(',').map((p) => p.split('=')[1]);
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
```

signing secret `POST /webhooks` पर (और
`rotate-secret` पर) केवल **एक बार** लौटाया जाता है; list/get responses में यह कभी शामिल नहीं होता। हर प्रयास
status, attempts, response code और error के साथ (`webhook_delivery` में) सहेजा जाता है — इसे
`GET /webhooks/:id/deliveries` से query करें और `redeliver` रूट से दोबारा भेजें।

List, get और update ठीक वही दस्तावेज़ीकृत endpoint fields लौटाते हैं, और create और
`rotate-secret` इनमें `secret` जोड़ते हैं। row पर बाकी कुछ भी सर्विस से बाहर नहीं जाता — न
`consumerId`, और न वे `previousSecret` / `previousSecretExpiresAt` columns जिन्हें पहले के
किसी grace-window rotation ने लिखा था।

**`ping` और `redeliver` rate limited हैं**, प्रति consumer और client address:
`POST /v1/webhooks/:id/ping` 20 और
`POST /v1/webhooks/:id/deliveries/:deliveryId/redeliver` प्रति 10 मिनट 30
(`429 rate_limited`)। दोनों इस सर्विस से आपके चुने गए URL पर signed requests भेजने के लिए
कहते हैं, और `redeliver` पूरा retry loop उसी request के अंदर चलाता है। बड़े backlog के लिए,
एक-एक करके redeliver करने के बजाय sweeper को retry करने दें।

### OpenAPI / Swagger

**सुरक्षा नोट:** `GET /docs`, `/docs/json`, और `/docs/yaml` Nest controllers के रूप में
नहीं, बल्कि **Express middleware** के रूप में mount होते हैं, इसलिए ये `ApisixGuard` या
`PermissionsGuard` से होकर **नहीं** गुज़रते — जो भी सर्विस के port तक पहुँच सकता है, वह
spec ले सकता है। production में docs **डिफ़ॉल्ट रूप से बंद** हैं (`NODE_ENV=production` और
कोई `SWAGGER_ENABLED` नहीं)। `SWAGGER_ENABLED=true` केवल भरोसेमंद नेटवर्क पर सेट करें।

spec को फ़ाइलों में export करें — कोई database या असली gateway secret ज़रूरी नहीं है:

```bash
npm run openapi:generate
# writes openapi/openapi.json and openapi/openapi.yaml
```

CI commit की गई दोनों फ़ाइलों को दोबारा जनरेट करता है और कोई भी अंतर अस्वीकार करता है। किसी
controller या DTO बदलाव को commit करने से पहले यही जाँच चलाएँ:

```bash
npm run openapi:check
```

spec के paths में version पहले से शामिल है (`/v1/...`)। spec के `servers` में gateway
host सेट करने के लिए, generate करने से पहले `OPENAPI_SERVER_URL` सेट करें:

```bash
OPENAPI_SERVER_URL=https://gateway.example.com npm run openapi:generate
```

**Postman से इस्तेमाल।** `openapi/openapi.json` import करें, या चल रही सर्विस से
`http://localhost:3000/docs/json`। spec में दो servers और दो security requirements हैं;
जो tools एक ही चुनते हैं वे हर सूची का पहला लेते हैं:

| कॉल | Server | Auth |
| --- | ------ | ---- |
| सीधे इस सर्विस को (local development) | `http://localhost:{port}` (`port` का default `3000`) | `X-Gateway-Secret` **और** `X-Consumer-Username`, दोनों साथ |
| APISIX gateway के ज़रिए | `OPENAPI_SERVER_URL`, सेट होने पर सूची में पहला | `Authorization: Bearer <api key>` |

commit किया गया spec `OPENAPI_SERVER_URL` के बिना बनता है, इसलिए default सीधी header
जोड़ी है; variable सेट करके generate करने पर ऐसी collection मिलती है जो default रूप से
gateway इस्तेमाल करती है। Postman हर request पर एक ही API key रखता है: अगर import केवल
`X-Gateway-Secret` सेट करे, तो `X-Consumer-Username` को collection header के रूप में जोड़ें।
health probes `security: []` के साथ प्रकाशित होते हैं।

हर operation में vendor extensions होते हैं जो बताते हैं कि वह क्या है:
`x-cosmos-rate-limit` (उसके budgets — वह `429` लौटा सकता है), `x-cosmos-upstream` (जिस
provider को वह कॉल करता है — वह `502`/`503`/`504` लौटा सकता है), `x-cosmos-public` और
`x-cosmos-public-key`।

`npm run openapi:generate` ऐसा spec लिखने से मना कर देता है जिसमें किसी operation का summary
न हो, किसी failure का body या उदाहरण न हो, किसी उदाहरण का `statusCode` उसके status से मेल न
खाए, या बिना budget वाले route पर `429` हो। जब भी कोई route जोड़ें या बदलें, उसका दोबारा बना
operation पढ़ें — देखें `CLAUDE.md`।

### Intent बनाना — दो SEP-7 operations, दो endpoints

[SEP-7](https://stellar.org/protocol/sep-7) के अनुसार, `tx` और `pay` operations
**अलग-अलग parameters** लेते हैं और **अलग-अलग responses** देते हैं, इसलिए हर एक का
अपना endpoint, DTO और response schema है। सर्विस कोई keys नहीं रखती — वह केवल
client के वॉलेट के लिए request तैयार करती है (`uri` + `qr` लौटाती है, और `tx` के लिए
`xdr` भी)। जब `assetCode` न दिया जाए (या
`XLM`/`native` हो) तो asset डिफ़ॉल्ट रूप से **native XLM** होता है; किसी भी दूसरे asset के लिए `assetIssuer` ज़रूरी है।

**नेटवर्क API key के प्रकार से तय होता है** जिसे gateway आगे भेजता है: `prod` key →
public (mainnet), `dev` key → testnet। `STELLAR_NETWORK` केवल gateway के बिना
local dev के लिए fallback है। हर intent अपना नेटवर्क सहेजता है और सभी Horizon
कॉल (build, वैलिडेशन, observer) उसी को target करती हैं। हर intent सहेजा जाता है
(`payment_intent` टेबल) और कॉल करने वाले consumer तक सीमित रहता है:
`PENDING → SUBMITTED → SUCCEEDED/FAILED/CANCELLED/EXPIRED`। किसी final status से
बाहर निकलने का एकमात्र रास्ता `EXPIRED → SUCCEEDED` है, और वह भी केवल on-chain
सत्यापित payment पर।

**memo एक अनिवार्य `MEMO_ID` है** — यह on-chain पेमेंट की पहचान करता है और
intent बनाने को **idempotent** बनाता है: `(consumer, memo)` unique है, इसलिए उसी memo
**और उन्हीं शर्तों** के साथ दोबारा बनाने पर मूल intent लौटता है। वही
memo किसी भी अलग शर्त के साथ — kind, network, destination, amount, asset, `msg`,
`callback`, या `tx` के लिए `source` — `409 idempotency_conflict` है, और error
सहेजे गए intent के बारे में कुछ नहीं बताता। साझा public key के तहत यह अहम है, जहाँ हर
anonymous वॉलेट एक ही consumer है। दोनों builders प्रति consumer और client address **प्रति
मिनट 30 कॉल** का साझा budget रखते हैं (`429 rate_limited`): हर एक Horizon से payer का
account पढ़ता है और एक row लिखता है, और साझा public key के तहत address ही एकमात्र चीज़ है जो
एक anonymous वॉलेट को दूसरे से अलग करती है। अगर आप `memo` नहीं देते, तो एक random uint64
जनरेट किया जाता है।

**`POST /v1/payment-intents/tx`** — payer (`source`) ज्ञात है, इसलिए हम
unsigned `TransactionEnvelope` और एक `web+stellar:tx?xdr=...` URI बनाते हैं।

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

**`POST /v1/payment-intents/pay`** — कोई source नहीं, इसलिए हम केवल एक
`web+stellar:pay?destination=...` URI लौटाते हैं (source asset/path वॉलेट चुनता है)।

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

`tx` response का उदाहरण:

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

Network/Horizon/fee/timeout `STELLAR_*` env vars से कॉन्फ़िगर किए जाते हैं
(`.env.example` देखें)। सुरक्षा के लिए डिफ़ॉल्ट **testnet** है — mainnet (असली पैसे) के लिए
`STELLAR_NETWORK=public` सेट करें।

## साझा सार्वजनिक API key

open-source वॉलेट एक ऐसी API key के साथ आता है जो सब साझा करते हैं, ताकि कोई भी
रजिस्टर किए बिना swap कर सके, liquidity जोड़ सके या pay link बना सके। इन कॉल पर
`community` plan का कमीशन लगता है (150 bps, सबसे ऊँची दर); रजिस्टर करने पर कम दर
मिलती है। gateway यह दर ठीक उसी तरह inject करता है जैसे private key के लिए करता है
(देखें `resolvePlanCommissionBps`)।

फ़र्क tenancy का है। हर anonymous caller एक ही APISIX consumer के रूप में आता है,
और read endpoints consumer के आधार पर rows filter करते हैं:

```ts
// swaps.service.ts
where: { id, consumer: { apisixUsername: consumer.username } }
```

इसलिए public key के तहत `GET /v1/swaps` सभी anonymous users का swap इतिहास लौटा
देता। Scopes इसे रोक नहीं सकते, क्योंकि सबके पास एक ही key है — और
`POST /v1/swaps/quote` को `swaps:read` चाहिए, वही scope जो इतिहास की सूची देता है।

**`PublicKeyGuard` एक allowlist है।** public consumer को हर उस रूट पर मना कर दिया
जाता है जिस पर `@AllowPublicKey()` नहीं लगा है, इसलिए नए रूट डिफ़ॉल्ट रूप से उसके लिए
बंद रहते हैं।

आज public key से इन तक पहुँचा जा सकता है:

| रूट | यह सुरक्षित क्यों है |
| --- | --- |
| `POST /v1/swaps/quote` | Horizon से path की कीमत निकालता है; यह request का शुद्ध function है |
| `POST /v1/swaps` | एक unsigned envelope बनाता है जिसे caller sign करता है |
| `POST /v1/swaps/:id/submit` | caller द्वारा signed envelope broadcast करता है — swap के बारे में कुछ भी, यहाँ तक कि उसकी status भी, तब तक नहीं बताया जाता जब तक body उसी swap का envelope न हो जिस पर signature हो; rate limited |
| `POST /v1/liquidity-pools/deposit` \| `withdraw` | unsigned envelopes बनाते हैं |
| `POST /v1/liquidity-pools/operations/:id/submit` | caller द्वारा signed envelope broadcast करता है, swap submit जैसी ही जाँच के तहत; rate limited |
| `GET /v1/liquidity-pools` \| `/:poolId` \| `/positions` | Horizon से पढ़ा गया सार्वजनिक on-chain डेटा |
| `POST /v1/payment-intents/tx` \| `pay` | request से एक SEP-7 intent बनाते हैं |
| `POST /v1/activity/events` | Telemetry ingest — नीचे देखें |
| `GET /v1/assets` | सार्वजनिक asset catalog |
| `GET /v1/aliases/resolve/:name` \| `availability/:name` \| `by-address/:address` | हैंडल resolve करने वाला payer ठीक वही anonymous caller है जिसके लिए यह key बनी है; जवाब request का शुद्ध function है और उसमें मालिक का mailbox कभी शामिल नहीं होता |

मना किए गए: `GET /v1/swaps`, `GET /v1/swaps/:id`,
`GET /v1/liquidity-pools/operations{,/:id}`, `GET /v1/activity/events`,
`GET /v1/activity/summary`, हर payment-intent read, alias मालिक का हर रूट
(claim, list, पता जोड़ना या हटाना, release, recovery), और
`/v1/kyc`, `/v1/onramp`, `/v1/offramp` और `/v1/webhooks` के अंतर्गत सब कुछ। बिना
account वाला वॉलेट अपना इतिहास इसके बजाय Horizon से पढ़ता है।

**Telemetry की अनुमति है** ताकि बिना account वाले वॉलेट की crash reports भी पहुँचें।
इस key पर आने वाले events anonymous होते हैं (एक साझा consumer), इसलिए वॉलेट भेजने से
पहले address, destination, amount और txHash हटा देता है।

guard public consumer की पहचान forwarded role
(`X-Consumer-Role: public`) **या** `APISIX_PUBLIC_CONSUMER` username — **इनमें से
किसी से भी** करता है। दोनों सेट करें: अगर gateway roles forward करना बंद कर दे, तो
username फिर भी मेल खाता है, और username के बिना guard केवल एक header पर निर्भर रहता है।

## Stellar नेटिव swaps (path payments)

Stellar में "swap" का कोई अलग operation नहीं है। asset का आदान-प्रदान एक
**`PathPaymentStrictSend`** से होता है, जिसे Horizon अपने आप **Stellar DEX order books** और **AMM liquidity
pools** के सबसे अच्छे उपलब्ध संयोजन से होकर route करता है। Cosmos Pay इसे एक swap flow में लपेटता है जो, payment intents की तरह,
**पूरी तरह non-custodial** है — पैसा कभी सर्विस से होकर नहीं गुज़रता। यह केवल:

1. Horizon की strict-send path search को query करके **quote देता है**।
2. unsigned ट्रांज़ैक्शन **बनाता है** (एक वैकल्पिक platform-fee पेमेंट + 
   path payment) और उसका `xdr` + SEP-7 `tx` URI + QR लौटाता है।
3. ग्राहक द्वारा अपने वॉलेट में sign किया गया ट्रांज़ैक्शन **relay करता है**।

```
quote → build XDR → customer signs in wallet → POST /submit → Stellar executes
```

नेटवर्क API key के प्रकार से तय होता है (prod → public, dev → testnet),
payment intents की तरह ही, और हर swap **persist** किया जाता है (`swap` टेबल) और
कॉल करने वाले consumer तक सीमित रहता है (`PENDING → SUBMITTED → SUCCEEDED/FAILED`)।

**Fee (प्रति संगठन, सर्वर-साइड पर लागू)।** कमीशन **कॉल करने वाले संगठन के
plan की दर** है, जिसे gateway एक भरोसेमंद header
(`X-Plan-Swap-Fee-Bps`) के रूप में inject करता है, जो dev platform संगठन के plan से निकालता है। यह
**कभी भी request parameter नहीं होता**, और APISIX client की भेजी हर कॉपी को overwrite कर देता है, इसलिए
दर को न तो टाला जा सकता है न घटाया जा सकता है। fee **source asset** से ली जाती है
और पहले payment
operation के रूप में platform वॉलेट (`STELLAR_SWAP_FEE_WALLET`) को दी जाती है; **बाकी** राशि swap से होकर route होती है। अगर plan fee लागू हो लेकिन
कोई platform वॉलेट कॉन्फ़िगर न हो, तो swap बनाना `503` के साथ विफल होता है (operator की
misconfiguration)। `STELLAR_SWAP_FEE_BPS` केवल gateway के बिना local dev के लिए
fallback है (और वॉलेट सेट न होने पर वह खुद भी बंद रहता है)।

**Slippage।** quote का अनुमान, `slippageBps` से घटाकर (डिफ़ॉल्ट
`STELLAR_SWAP_SLIPPAGE_BPS`, जिसकी ऊपरी सीमा `STELLAR_SWAP_MAX_SLIPPAGE_BPS` है),
path payment का on-chain `destMin` बन जाता है — इसलिए caller ने जितना स्वीकार करना माना था उससे
कम देने की बजाय swap **revert** हो जाता है।

**Trustline।** non-native destination asset पर destination account का पहले से
trust होना चाहिए; build चरण इसकी जाँच करता है और वरना एक स्पष्ट error
लौटाता है। (XLM को trustline की ज़रूरत नहीं है।)

**`POST /v1/swaps/quote`** — केवल कीमत, कुछ भी persist नहीं होता (`swaps:read`)।

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

**`POST /v1/swaps`** — sign किया जा सकने वाला ट्रांज़ैक्शन बनाता है (`swaps:write`)। यह
वही fields और साथ में `source` (भुगतान/sign करने वाला account) लेता है; `destination` डिफ़ॉल्ट रूप से
`source` होता है (self-swap) और एक वैकल्पिक `memo` (MEMO_ID) on-chain दोहराया जाता है।

वैकल्पिक **idempotency**: `Idempotency-Key` header (बेहतर)
या body में `idempotencyKey` भेजें। उसी key **और उसी request** के साथ retry
— network, source, destination, दोनों assets, amount, slippage और memo — एक और
ट्रांज़ैक्शन बनाने की बजाय **मौजूदा** swap (`id` + `txHash`) लौटाता है। वही key अलग
request के साथ `409 idempotency_conflict` है, और error सहेजे गए swap के बारे में कुछ
नहीं बताता। Liquidity deposits और withdrawals भी यही नियम मानते हैं, और operation का
kind भी मिलाते हैं। key के बिना भी, unique `(network, txHash)` constraint
byte-identical rebuild को **409** (sequence / XDR collision) के साथ अस्वीकार करता है। जब
`STELLAR_SWAP_SINGLE_INFLIGHT=true` हो, तो उसी `(consumer, source, network)` के लिए
दूसरा non-expired `PENDING` swap भी मौजूदा id बताते हुए **409** लौटाता है
(डिफ़ॉल्ट **बंद** — एक ही account से एक साथ अलग-अलग swaps की अनुमति बनी रहती है)। वह
guard केवल ऐसा swap रोकता है जो **पहले से on-chain हो सकता है**: जिस row का sequence
number account ने अभी तक इस्तेमाल नहीं किया, वह settle हो ही नहीं सकती, और अभी बन रहा swap
वही number लेता है — यानी दोनों में से ज़्यादा से ज़्यादा एक ही कभी settle होगा। कोई भी
कोई भी `source` बता सकता है, इसलिए इस जाँच के बिना एक अकेला dust swap किसी और के account
के swaps को पूरी timeout window तक जमा देता था — और साझा public key के तहत तब तक, जब तक
हमलावर उसे दोहराता रहे।

```jsonc
// response → { id, status: "PENDING", network, sendAmount, feeAmount, swapAmount,
//              destEstimated, destMin, path, xdr, uri: "web+stellar:tx?xdr=…", qr, txHash, … }
```

**quote और build पर भी सीमा है**, प्रति consumer और client address: **प्रति मिनट 60
quotes** और **प्रति मिनट 20 builds**, submit से अलग buckets में। quote कुछ भी persist नहीं
करता, फिर भी उसकी लागत एक strict-send path search है — Horizon से यह सेवा जो सबसे महँगी कॉल
करती है — और वह प्रति-IP budget swaps, liquidity pools और payment intents सब साझा करते हैं,
इसलिए loop में पूछा गया price हर anonymous caller के लिए तीनों को एक साथ धीमा कर देता था।

**`POST /v1/swaps/:id/submit`** — signed envelope को relay करता है (`swaps:write`)।

```jsonc
// request
{ "signedXdr": "AAAAAgAAA…(signed base64 XDR)…" }
// response
{ "submitted": true, "status": "SUCCEEDED", "txHash": "…", "swap": { … } }
// on a network rejection → { "submitted": false, "status": "FAILED", "reason": "…", "resultCodes": ["op_under_dest_min"], "swap": { … } }
```

broadcast करने से पहले सर्विस जाँचती है कि signed ट्रांज़ैक्शन का hash उसके बनाए hash से
मेल खाता है, इसलिए वह कभी कोई मनमाना ट्रांज़ैक्शन relay नहीं करती। swap उसी dispatcher से `SWAP_CREATED` / `SWAP_SUBMITTED` / `SWAP_SUCCEEDED` /
`SWAP_FAILED` webhook events भेजता है।

**Submit इस बारे में सख्त है कि वह क्या relay करता है।** swap के बारे में कुछ भी — यहाँ तक कि
उसकी status भी — तब तक नहीं बताया जाता जब तक `signedXdr` parse न हो जाए, swap के `txHash`
से hash न मिल जाए और उस पर कम से कम एक signature न हो, इसलिए create response से मिला
unsigned `xdr` `400 validation_failed` है। जिस swap के envelope की time bounds
(`STELLAR_TX_TIMEOUT`, डिफ़ॉल्ट 300 s) निकल चुकी हों वह `400 invalid_state_transition` है
और broadcast नहीं होता; अगर वह समय रहते network तक पहुँच गया था, तो observer उसे अब भी
settle कर देता है। network रिजेक्शन के बाद वही envelope ज़्यादा से ज़्यादा **3** बार दोबारा
submit किया जा सकता है, फिर नया swap बनाएँ — `503 provider_unavailable` के बाद की retry
इसमें नहीं गिनती। यह रूट प्रति consumer और client address **प्रति मिनट 20 कॉल** की अनुमति
देता है (`429 rate_limited`); साझा public key के तहत हर anonymous वॉलेट एक consumer है,
इसलिए एक ही NAT के पीछे के वॉलेट यह budget साझा करते हैं।
`POST /v1/liquidity-pools/operations/:id/submit` भी यही नियम मानता है, अपने ही अलग bucket
के साथ, और `POST /v1/liquidity-pools/deposit` · `/withdraw` **प्रति मिनट 20 builds** का एक
साझा budget रखते हैं — एक ही flow की दो दिशाएँ, इसलिए अलग buckets से कोई loop बस दोनों के
बीच बदल-बदलकर दोनों budgets ले लेता।

## Aliases — क्लेम किए जा सकने वाले पेमेंट हैंडल

alias की मदद से payer `GA5ZSE…` की जगह `emanuel250` टाइप कर सकता है। पैसा भेजने से
ठीक पहले payer इसी नाम पर भरोसा करता है, इसलिए नीचे के नियम सख्त हैं: गलती का मतलब है
गलत account को पेमेंट।

### माँगकर नहीं, key पर नियंत्रण साबित करके क्लेम किया जाता है

```
wallet ──1. POST /v1/aliases/challenges {name, address, network} ──▶ nonce + the EXACT message to sign
wallet ──2. signs SHA-256(domain ‖ 0x00 ‖ uint32be(length) ‖ message) with that address's key
wallet ──3. POST /v1/aliases {name, email, nonce, signature} ────────▶ alias bound to the calling consumer
```

- **सर्विस जो message लौटाती है, ठीक वही sign करें।** उसे client पर दोबारा न बनाएँ।
- **signature एक domain-tagged digest को cover करता है, कभी किसी ट्रांज़ैक्शन को नहीं।** इस
  flow में sign की गई कोई भी चीज़ नेटवर्क पर submit नहीं की जा सकती, और domain
  (`Cosmos Pay alias claim v1`) केवल इसी feature का है, इसलिए किसी दूसरे dapp से लिया गया
  signature claim के रूप में इस्तेमाल नहीं किया जा सकता।
- **उद्देश्य signed bytes के अंदर होता है** (`CLAIM`, `ADD_ADDRESS`, `RECOVER`),
  इसलिए पता जोड़ने के लिए लिया गया signature recovery पूरी करने के लिए replay
  नहीं किया जा सकता।
- **पता challenge से आता है, claim body से नहीं।** claim में
  कोई address field नहीं है, इसलिए कोई भी एक पते के लिए sign करके दूसरा रजिस्टर नहीं कर सकता।
- **Challenges एक बार इस्तेमाल होते हैं और पाँच मिनट तक चलते हैं।** challenge खर्च होने से
  *पहले* signature verify किया जाता है, इसलिए अवैध signature किसी और का nonce खर्च नहीं
  कर सकता, और उसे खर्च करना एक compare-and-swap है।
- **होड़ का फ़ैसला `alias.name` पर unique index से होता है**, पहले की किसी जाँच से नहीं;
  हारने वाले को `409 alias_taken` मिलता है।

### हैंडल क्या हो सकता है

छोटे अक्षर `a-z`, `0-9` और `_` (कभी भी शुरुआत या अंत में नहीं), 3–32 अक्षर, uniqueness तय होने से पहले
lowercase में बदले जाते हैं। कोई Unicode नहीं: homoglyphs का समूह असीमित है,
और कोई भी normalization किसी Cyrillic `а` को राशि के बगल में दिखाने लायक सुरक्षित नहीं बनाता। यह भी
अस्वीकार हैं: आरक्षित शब्द (`admin`, `support`, `cosmospay`, `stellar`, …) और कुछ भी जो
Stellar account जैसा दिखे (`g` या `m` के बाद 20 या अधिक base32 अक्षर)। नियम
`src/aliases/alias-name.ts` में है।

### कई पते, एक नाम

एक alias नेटवर्कों में अधिकतम 20 पतों की ओर इशारा कर सकता है — फ़ोन, डेस्कटॉप, cold
वॉलेट, testnet — प्रति नेटवर्क ठीक एक primary के साथ, जिसे एक partial
unique index लागू करता है। पता जोड़ने के लिए **दो** प्रमाण चाहिए: caller alias का मालिक हो,
और नया पता अपना `ADD_ADDRESS` challenge खुद sign करे। आखिरी बचा हुआ
पता हटाया नहीं जा सकता (इसके बजाय alias release करें), और एक consumer
अधिकतम 25 aliases रख सकता है।

`SUSPENDED` alias (operator का hold) किसी भी चीज़ पर resolve नहीं होता।

### Recovery ईमेल से होकर, और प्लेटफ़ॉर्म कंसोल से होकर जाती है

claim एक recovery ईमेल रिकॉर्ड करता है ताकि key खोने का मतलब नाम खोना न हो। Recovery
ऐसे काम करती है:

1. **प्लेटफ़ॉर्म कंसोल** `POST /v1/aliases/:name/recovery {email}` कॉल करता है।
   response एक जैसा रहता है, चाहे हैंडल और mailbox मेल खाए हों या नहीं; मेल खाने पर
   उसमें एक बार इस्तेमाल होने वाला token होता है (30 मिनट, केवल SHA-256 के रूप में सहेजा गया), जिसे
   कंसोल ईमेल करता है। यह सर्विस कोई मेल नहीं भेजती।
2. user नई key के लिए एक `RECOVER` challenge लेता है और अपनी API key से
   `POST /v1/aliases/:name/recovery/complete {token, address, network, nonce, signature}`
   कॉल करता है। दोनों प्रमाण ज़रूरी हैं: token mailbox साबित करता है,
   signature key साबित करता है।
3. स्वामित्व कॉल करने वाले consumer के पास चला जाता है और **पिछला हर पता
   हटा दिया जाता है**, इसलिए पुरानी keys रखने वाले को पेमेंट मिलना बंद हो जाता है।

चरण 1 केवल कंसोल के लिए है क्योंकि token mailbox पर नियंत्रण साबित करता है, इसलिए वह
केवल ईमेल भेजने वाले तक ही पहुँचना चाहिए। `ConsoleOnlyGuard` alias देखे जाने से पहले ही
हर API-key caller को `403 admin_console_only` के साथ मना कर देता है, और यह रूट प्रकाशित
contract में नहीं है। suspended alias को recover नहीं किया जा सकता।

एक recovery token **पाँच** बार प्रस्तुत किया जा सकता है। जिस प्रस्तुति में challenge या
signature विफल हो, वह भी एक प्रयास गिनी जाती है, और छठी बार मना कर दिया जाता है; मालिक
दूसरी recovery शुरू कर सकता है। जो token उस alias की किसी चालू recovery से मेल न खाए, उसे
वही `400 alias_recovery_invalid` मिलता है और कुछ नहीं बदलता, ताकि कोई भी junk भेजकर मालिक
की recovery न जला सके। `POST /v1/aliases/:name/recovery/complete` प्रति 10 मिनट 10 कॉल
और `POST /v1/aliases/challenges` 30 कॉल की अनुमति देता है, प्रति consumer और client
address (`429 rate_limited`)।

Expired challenges और recoveries को expire होने के एक दिन बाद
`AliasChallengeSweeperService` delete करता है (हर घंटे, प्रति tick एक replica)।

### रूट्स

| मेथड | पाथ | Scope | विवरण |
| ------ | ---- | ----- | ----------- |
| GET | `/v1/aliases/resolve/:name` | `payments:read` · public key | वे पते जिन पर alias resolve होता है (`?network=` से filter) |
| GET | `/v1/aliases/availability/:name` | `payments:read` · public key | क्या कोई हैंडल क्लेम किया जा सकता है, और अगर नहीं तो क्यों |
| GET | `/v1/aliases/by-address/:address` | `payments:read` · public key | किसी पते की ओर इशारा करने वाले aliases |
| POST | `/v1/aliases/challenges` | `payments:write` | एक nonce और sign करने के लिए सटीक message |
| POST | `/v1/aliases` | `payments:write` | signature के साथ alias क्लेम करना |
| GET | `/v1/aliases` | `payments:read` | caller के aliases |
| POST | `/v1/aliases/:name/addresses` | `payments:write` | पता जोड़ना, उसी पते से signed |
| DELETE | `/v1/aliases/:name/addresses/:addressId` | `payments:write` | पता हटाना |
| DELETE | `/v1/aliases/:name` | `payments:write` | alias release करना |
| POST | `/v1/aliases/:name/recovery` | _केवल प्लेटफ़ॉर्म कंसोल_ | recovery शुरू करना → कंसोल के ईमेल करने के लिए एक token |
| POST | `/v1/aliases/:name/recovery/complete` | `payments:write` | token और नई key के signature के साथ recovery पूरी करना |

## BlindPay — onramp / offramp / KYC (fiat ⇄ stablecoin)

on-chain payment intents के अलावा, सर्विस
[BlindPay](https://www.blindpay.com/docs) को integrate करती है ताकि पैसा **fiat और
stablecoins** के बीच ले जाया जा सके: पैसा अंदर लाना (**onramp / payin**), पैसा बाहर निकालना (**offramp / payout**), और
दोनों के पीछे अनिवार्य **KYC** (BlindPay *receivers*)। हम **हर API-key environment के लिए
एक प्लेटफ़ॉर्म BlindPay instance** चलाते हैं — `prod` keys के लिए production
(`BLINDPAY_API_KEY` + `BLINDPAY_INSTANCE_ID`), `dev` keys के लिए development (`_DEV` variables);
हर receiver/wallet/bank-account/payin/payout हमारे Postgres में mirror किया जाता है और
**कॉल करने वाले APISIX consumer तक सीमित** रहता है, इसलिए हर integrator केवल अपने
रिकॉर्ड ही देखता है। सर्विस **कभी भी blockchain keys नहीं रखती** — offramp sign करने के लिए
artifact लौटाता है (EVM `approve` contract / Stellar XDR) और signed tx
वापस स्वीकार करता है, ठीक payment intents की तरह।

State के बदलाव BlindPay के **Svix webhooks** से sync होते हैं (raw
body पर verify किए जाते हैं) और मौजूदा dispatcher के ज़रिए integrator के अपने webhook endpoints पर नए event
types (`RECEIVER_UPDATED`, `PAYIN_*`, `PAYOUT_*`) के रूप में **फिर से भेजे जाते हैं**।

| मेथड   | पाथ                                                   | Scope          | विवरण |
| ------ | ----------------------------------------------------- | -------------- | ----------- |
| POST   | `/v1/kyc/receivers`                                   | `kyc:write`    | receiver बनाना (KYC/KYB शुरू करना) |
| GET    | `/v1/kyc/receivers` · `/:id`                          | `kyc:read`     | सूची / एक लेना (get KYC status refresh करता है) |
| PATCH  | `/v1/kyc/receivers/:id`                               | `kyc:write`    | receiver अपडेट करना (BlindPay पर होने के बाद identity fields के लिए elevated key चाहिए) |
| DELETE | `/v1/kyc/receivers/:id`                               | `kyc:write`    | receiver delete करना |
| POST   | `/v1/kyc/upload`                                      | `kyc:write`    | KYC दस्तावेज़ अपलोड करना → `file_url` |
| GET    | `/v1/kyc/rails` · `/v1/kyc/bank-details?rail=`        | `kyc:read`     | Rail catalog / ज़रूरी fields |
| POST   | `/v1/kyc/receivers/:id/wallets`                       | `kyc:write`    | blockchain वॉलेट रजिस्टर करना |
| GET    | `/v1/kyc/receivers/:id/wallets/sign-message`          | `kyc:read`     | sign करने के लिए message (सुरक्षित EOA flow) |
| POST   | `/v1/kyc/receivers/:id/bank-accounts`                 | `kyc:write`    | fiat बैंक खाता जोड़ना (कोई भी rail) |
| POST   | `/v1/onramp/quotes`                                   | `onramp:write` | payin की कीमत (~5 मिनट में expire) |
| POST   | `/v1/onramp/payins`                                   | `onramp:write` | payin बनाना → funding निर्देश |
| GET    | `/v1/onramp/payins` · `/:id`                          | `onramp:read`  | सूची / एक लेना (get status refresh करता है) |
| POST   | `/v1/onramp/trustline`                                | `onramp:write` | unsigned Stellar trustline XDR बनाना |
| POST   | `/v1/onramp/receivers/:id/virtual-accounts`           | `onramp:write` | virtual account बनाना |
| POST   | `/v1/offramp/quotes`                                  | `offramp:write`| payout की कीमत (EVM → `approve` contract) |
| POST   | `/v1/offramp/payouts/authorize`                       | `offramp:write`| unsigned Stellar/Solana payout tx बनाना |
| POST   | `/v1/offramp/payouts`                                 | `offramp:write`| quote से payout बनाना |
| GET    | `/v1/offramp/payouts` · `/:id`                        | `offramp:read` | सूची / एक लेना (get status refresh करता है) |
| POST   | `/v1/offramp/payouts/:id/documents`                   | `offramp:write`| compliance दस्तावेज़ जोड़ना |
| POST   | `/v1/blindpay/webhooks`                               | _public_       | आने वाला BlindPay (Svix) webhook |

राशियाँ **minor units में integers** होती हैं (जैसे `$123.45` → `12345`)। BlindPay डैशबोर्ड का webhook
`<gateway>/v1/blindpay/webhooks` पर कॉन्फ़िगर करें और
`BLINDPAY_WEBHOOK_SECRET` को उस endpoint के signing secret पर सेट करें — पूरा `whsec_…`
value। जब इसकी key 24 bytes से कम में decode होती है तो boot विफल हो जाता है, और verifier
भी ऐसी key को वैसे भी अस्वीकार करता है: अमान्य base64 एक खाली key में decode होता है, और
उससे कोई भी sign कर सकता है। feature बंद करने के लिए
`BLINDPAY_*` vars खाली छोड़ दें: तब वे रूट `503` `misconfigured` लौटाते हैं, और जब तक
`BLINDPAY_WEBHOOK_SECRET` सेट नहीं है, आने वाला webhook भी यही लौटाता है।
`.env.example` देखें।

**एक `dev` key कभी production instance तक नहीं पहुँचती।** key का environment BlindPay
instance उसी तरह चुनता है जैसे Stellar network चुनता है, और हर mirror की गई row दर्ज करती है कि
वह किस instance से आई, इसलिए किसी tenant की `dev` और `prod` keys — एक ही consumer — अलग-अलग
receivers, wallets, bank accounts, quotes, payins और payouts देखती हैं। development instance
कॉन्फ़िगर न होने पर BlindPay routes `dev` keys को `503` `misconfigured` लौटाते हैं। दोनों
instances के dashboard webhooks एक ही `<gateway>/v1/blindpay/webhooks` पर लगाएँ और development
वाले के लिए `BLINDPAY_WEBHOOK_SECRET_DEV` सेट करें: delivery जिस secret से verify होती है,
वही बताता है कि उसे किस instance ने भेजा।

**पहचान BlindPay तक पहुँचने से पहले review होती है, edits में भी।** जब तक receiver enable
नहीं होता, KYC data को छूने वाला `PATCH` उसे वापस `pending_review` में भेज देता है। BlindPay पर
मौजूद होने के बाद tenant key केवल `external_id` और `image_url` बदल सकती है; कोई भी दूसरा field
`403` `kyc_review_required` है, जब तक key elevated (`X-Consumer-Role: admin`) न हो, क्योंकि वह
`PUT` provider पर पहचान को सीधे फिर से लिख देता है।

**approval उसी dossier से बँधी होती है जिसकी review हुई थी।** receiver पढ़ने पर
`dossierVersion` आता है, जो भेजे गए KYC data के हर edit को गिनता है। approve करते समय उसे
`expected_version` के रूप में वापस भेजें, और पढ़ने के बाद बदला हुआ dossier
`409 kyc_state_invalid` देता है — उस data की approval की बजाय जिसे किसी ने देखा ही नहीं।
edit होने पर status `pending_review` ही रहता है, इसलिए approval अकेले यह भाँप नहीं सकती थी।
जिस version को मंज़ूरी मिली वह `reviewedVersion` में रहता है, और जब तक दोनों अलग हैं,
`POST /v1/kyc/receivers/:id/enable` receiver को BlindPay पर बनाने से मना कर देता है।

**fiat रूट्स के budgets हैं।** provider जिस भी write को रखता है वह प्रति consumer और client
address सीमित है, और BlindPay पर टिका हर रूट **प्रति मिनट 60 provider requests** की
प्रति-consumer सीमा में भी गिना जाता है: एक ही instance उस key के सभी tenants को सेवा देता
है, इसलिए quotes पर loop करने वाला एक tenant बाकियों के payins विफल कर देता है। budget से
ऊपर जाने पर `Retry-After` के साथ `429 rate_limited` मिलता है।

| रूट | Budget (प्रति consumer + client address) |
| --- | --------------------------------------- |
| `POST /v1/kyc/upload` | 10 मिनट में 20 |
| `POST /v1/kyc/terms-of-service` | 10 मिनट में 10 |
| `POST /v1/onramp/quotes` · `POST /v1/offramp/quotes` | प्रति मिनट 30, अलग-अलग buckets |
| `POST /v1/onramp/payins` | प्रति मिनट 10 |
| `POST /v1/offramp/payouts/authorize` · `POST /v1/offramp/payouts` | प्रति मिनट 10, साझा |
| `POST /v1/offramp/payouts/:id/documents` | 10 मिनट में 20 |
| `POST /v1/onramp/trustline` | प्रति मिनट 20 |

### KYC redirect URL प्रति consumer allow-list किए जाते हैं

terms-of-service flow user को BlindPay पर भेजता है और फिर integrator के दिए
`redirect_url` पर वापस लाता है। open redirect से बचने के लिए, हर `redirect_url` दो जाँचों से
गुज़रता है:

| परत | नियम | कहाँ |
| ----- | ---- | ----- |
| आकार | embedded credentials (`user:pass@`) के बिना एक absolute `https` URL, बिना fragment (`#…`), और बिना backslash, whitespace या control character | इसे रखने वाले हर DTO पर `@IsRedirectUrl()`, और फिर service layer में दोबारा |
| Host | **कॉल करने वाले consumer की** allow-list में — सटीक host, या label की सीमा पर एक subdomain (`app.acme.com` `acme.com` से मेल खाता है; `evilacme.com` नहीं) | `KYC_REDIRECT_URL_WHITELIST`, service layer में लागू |

```
KYC_REDIRECT_URL_WHITELIST={"cosmos_acme":["acme.com","app.acme.com"]}
```

host की जाँच का मूल्य इन्हीं आकार-नियमों से बनता है। WHATWG parser authority के भीतर
backslash को `/` पढ़ता है, जबकि कुछ दूसरे उसे userinfo का हिस्सा मानते हैं — यानी
`https://app.acme.com\@evil.test` के दो ईमानदार पाठ हैं, और इसे पढ़ने वाला अंतिम पक्ष यह
सेवा नहीं है: मान BlindPay तक जाता है, एक hosted page पर लौटता है और अंत में browser में
पहुँचता है। whitespace और control characters भी इसी श्रेणी के हैं, fragment provider द्वारा
जोड़े गए `?tos_id=` को निगल जाता है, और credentials host को `@` के दूसरी ओर ले जाते हैं।

यह **fail closed** होता है: जिस consumer की कोई entry नहीं है, वह redirect बिल्कुल इस्तेमाल नहीं कर सकता, और
अंत में बिंदु वाला या IDN रूप वाला host normalize करने की बजाय अस्वीकार किया जाता है।
`redirect_url` लेने वाला हर रूट इसकी जाँच करता है, admin approval सहित, जो receiver के
अपने consumer की सूची इस्तेमाल करता है। अस्वीकार किया गया scheme या host `400` है।

## Pollar — सोशल लॉगिन जो बदले में Stellar वॉलेट देता है

[Pollar](https://docs.pollar.xyz/docs) Google/GitHub लॉगिन को एक Stellar
account में बदल देता है: यह user को authenticate करता है, वॉलेट बनाता है, key को AWS
KMS में custody में रखता है, कॉन्फ़िगर किए गए trustlines जोड़ता है और reserve fund करता है — user को कभी
seed phrase नहीं दिखता। यह सर्विस इसे एक **OAuth bridge** के रूप में उपलब्ध कराती है।

### passthrough नहीं, bridge क्यों

Pollar का hosted लॉगिन browser SDK के लिए बनाया गया है। यह user को एक publishable key, एक client-session id और एक
`redirect_uri` के साथ `GET /auth/{provider}` पर भेजता है — और वह redirect URI **Pollar के साथ रजिस्टर** किया गया host होना चाहिए।
वॉलेट ये शर्तें पूरी नहीं कर सकता: loopback listener या `cosmospay://` deep link कभी
रजिस्टर किया गया host नहीं होता, और वॉलेट को वे keys और session ids संभालनी ही नहीं
चाहिए। इसलिए Pollar की ओर का काम bridge संभालता है, और वॉलेट केवल दो चरण करता है:
**authorization खोलो, code redeem करो**।

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

चरण 6 के बाद वॉलेट सीधे Pollar से बात करता है: redemption response में
`publishable_key` और `api_base_url` होते हैं, जिनसे वॉलेट balances पढ़ता है और
ट्रांज़ैक्शन बनाता और submit करता है। **यह सर्विस उन कॉल को proxy नहीं करती।**

### code ग्रहण करने के दो तरीके

|                  | Redirect flow                                    | Poll flow                                       |
| ---------------- | ------------------------------------------------ | ----------------------------------------------- |
| वॉलेट क्या देता है | `redirect_uri` (allow-list में होना चाहिए) और एक PKCE `code_challenge` | कुछ नहीं (PKCE वैकल्पिक) |
| code कैसे आता है | redirect पर `?code=…&state=…` के रूप में        | `GET /v1/pollar/oauth/sessions/{state}` से      |
| browser क्या देखता है | आपका अपना URI                               | एक साधारण "आप यह विंडो बंद कर सकते हैं" पेज — code कभी नहीं |
| कब उपयोग करें    | जब वॉलेट के पास deep link या loopback listener हो | जब इनमें से कुछ भी न हो (kiosk, headless, embedded view) |

हर poll एक नया code जारी करता है और पिछले को अमान्य कर देता है, इसलिए अपने सबसे हाल के
poll से मिला code redeem करें। code का केवल SHA-256 सहेजा जाता है।

**Poll flow को प्राथमिकता दें।** Pollar का hosted flow browser को callback पर वापस नहीं
भेजता: वह उसके अपने पेज (`www.pollar.xyz/auth/status`) पर खत्म होता है और Pollar की तरफ़
client session को `READY` कर देता है। इसलिए जब तक कोई handshake `pending` है, poll रूट
Pollar से client session जाँचता है और Pollar के `READY` रिपोर्ट करते ही handshake को आगे
बढ़ा देता है।

- **callback रूट को Pollar के साथ रजिस्टर रखें।** redirect flow इसी पर निर्भर है।
- **प्रति handshake Pollar की जाँच हर दो सेकंड में अधिकतम एक बार होती है**
  (`POLLAR_SESSION_PROBE_INTERVAL_MS`), जो `providerCheckedAt` के ज़रिए सभी replicas में
  साझा है। हर सेकंड poll करने वाला वॉलेट प्रति मिनट Pollar पर 30 requests डालता है, उस
  key पर जिसका budget 200 है।

जिस handshake के client session को Pollar अस्वीकार कर दे (`INVALID_CLIENT_SESSION_ID`,
`EXPIRED_CLIENT_ID`, या `404`/`410`), उसे तुरंत उस code के साथ `failed` के रूप में बंद कर
दिया जाता है।

### एक लॉगिन, दोनों नेटवर्क पर एक वॉलेट

Pollar mainnet और testnet को अलग key pairs वाले अलग applications के रूप में चलाता है,
इसलिए hosted लॉगिन केवल उसी नेटवर्क पर वॉलेट बनाता है जिस पर उसकी API key resolve होती है
(`prod` → `public`, `dev` → `testnet` — देखें `resolveNetwork`)। user को दोनों पर वॉलेट देने
के लिए, **mainnet** redemption उसे Server API के `POST /users/with-wallet` के ज़रिए **testnet**
पर भी रजिस्टर करता है, और `POST /v1/pollar/oauth/token` दोनों को रिपोर्ट करता है। testnet
redemption mainnet provision नहीं करता: testnet पर `dev` keys आती हैं, और जिस key को कोई भी
बना सकता है उसे हर लॉगिन पर mainnet reserve के लिए असली XLM खर्च नहीं करना चाहिए। उस user का
mainnet वॉलेट उसके पहले mainnet लॉगिन से आता है।

```jsonc
"network_wallets": [
  { "network": "public",  "status": "ready",   "address": "GA5Z…" },
  { "network": "testnet", "status": "pending", "address": null    }
]
```

**`pending` entry कोई error नहीं है।** लॉगिन सफल हुआ; बस दूसरा वॉलेट अभी तैयार नहीं है,
और उसकी वजह से लॉगिन कभी विफल नहीं होता। request पाँच सेकंड का एक प्रयास करती है; जो
पूरा नहीं होता उसे background में provisioning sweeper (`POLLAR_SWEEP_*`) दोबारा आज़माता है,
exponential backoff के साथ और row के `failed` होने से पहले अधिकतम दस प्रयासों तक।

`pending` का आम कारण यह है कि **दूसरे नेटवर्क की keys कॉन्फ़िगर नहीं हैं**। उनके सेट होते
ही अगला sweep users के दोबारा लॉगिन किए बिना backlog provision कर देता है, इसलिए दोनों
नेटवर्क की keys सेट करें, भले ही आप केवल एक को serve करते हों।

- **Users का मिलान उनके OAuth ईमेल से होता है**, वही key जिसे दूसरे नेटवर्क पर hosted लॉगिन
  इस्तेमाल करता है। जो provider कोई ईमेल नहीं लौटाता, उसे दूसरा वॉलेट नहीं मिलता।
- **mainnet लॉगिन दोनों नेटवर्क पर XLM खर्च करता है** — अपना reserve और एक testnet reserve।
  testnet लॉगिन केवल testnet XLM खर्च करता है। state `pollar_user_wallet` में रहती है, प्रति (consumer, email, network)
  एक row, इसलिए दोहराया गया लॉगिन दोबारा provision नहीं करता।

### bridge क्या स्टोर करता है

एक handshake row, जिसमें ऐसा कुछ नहीं जो पैसा खर्च कर सके: अनुमान न लगाया जा सकने वाला `state`,
Pollar client-session id, code का एक **hash**, और परिणामी सार्वजनिक Stellar
पता। **कोई भी Pollar token कभी persist नहीं किया जाता** — `/auth/login` exchange
redemption request के अंदर चलता है और tokens सीधे उसके response में बाहर चले जाते हैं।
जिन handshakes को किसी ने पूरा नहीं किया, वे एक timer पर expire किए जाते हैं (`POLLAR_SWEEP_*`), क्योंकि
`AUTHORIZED` row sweep होने तक एक redeem करने योग्य code है।

हर transition row के status पर एक compare-and-swap है, इसलिए replay किया गया
callback दूसरा code नहीं बनाता, और एक code के लिए होड़ करते दो वॉलेट दोनों नहीं जीत सकते।

### Hardening

- **PKCE (RFC 7636, S256)** **redirect flow में अनिवार्य** है और poll flow में वैकल्पिक:
  authorize पर `code_challenge` और redemption पर `code_verifier` भेजें, और तब browser
  या log से लीक हुआ code verifier के बिना बेकार है। redirect flow का code एक browser से
  होकर गुज़रता है, और public callback उसे `state` दिखाने वाले किसी को भी दे देता है — जो
  `authorization_url` के अंदर होता है — इसलिए `redirect_uri` के साथ और `code_challenge`
  के बिना `authorize` `400 validation_failed` है।
- **`dpop_jwk`** Pollar के बनाए tokens को वॉलेट की अपनी P-256 key से बाँध देता है
  (RFC 9449), इसलिए चुराया गया access token signed proof के बिना निष्क्रिय है। इसका यह भी
  अर्थ है कि bridge अब वॉलेट की ओर से काम नहीं कर सकता — `/refresh` और `/logout`
  bearer sessions को serve करते हैं, और DPoP से बँधा वॉलेट सीधे Pollar को कॉल करता है।
- **`POLLAR_REDIRECT_URI_WHITELIST`** प्रति consumer है और fail closed होता है, क्योंकि
  code redirect URI पर ही पहुँचता है। यह loopback hosts (कोई भी port, RFC 8252 के
  अनुसार), private-use scheme वाले deep links, और https hosts स्वीकार करता है।
- **session केवल उसी account को वापस जाता है जिसने consent दिया।** सभी tenants एक ही Pollar
  application साझा करते हैं, और लॉगिन link किसी के भी browser में काम करता है: कोई key अपना
  `authorization_url` किसी और को भेज सकती थी, उसके consent का इंतज़ार कर सकती थी और उसका
  वॉलेट redeem कर सकती थी — PKCE और `dpop_jwk` मदद नहीं करते, क्योंकि handshake उसी key ने
  खोला था। इसलिए `POST /v1/pollar/oauth/token` लॉगिन के लिए Pollar द्वारा रिपोर्ट किए गए email
  की तुलना उस account email से करता है जिसे gateway key के लिए forward करता है
  (`X-Consumer-Email`, देखें `APISIX_EMAIL_HEADER`)। mismatch होने पर Pollar पर session
  revoke होता है, handshake `failed` होता है और `403 pollar_identity_mismatch` लौटता है; जिस
  key का कोई email forward नहीं हुआ उसे `authorize` पर `403 pollar_identity_required` से मना
  किया जाता है। एकमात्र अपवाद dev platform का brokered onboarding (`X-Cosmos-Internal`) है:
  वह उन लोगों को लॉगिन कराता है जिनके पास अभी key नहीं है, और कुछ भी सौंपने से पहले email
  खुद साबित करता है।
- **`POST /v1/pollar/users` और `/users/with-wallet` के लिए elevated key चाहिए**
  (`X-Consumer-Role: admin`, वरना `403 elevated_key_required`)। वहाँ रजिस्टर हुआ user वही
  होता है जिसे बाद का social लॉगिन email से resolve करता है, इसलिए वरना कोई tenant key किसी
  अजनबी का email claim करके उसे मिलने वाले वॉलेट की मालिक के रूप में दर्ज हो सकती थी।

### रूट्स

| मेथड   | पाथ                                                   | Scope          | विवरण |
| ------ | ----------------------------------------------------- | -------------- | ----------- |
| POST   | `/v1/pollar/oauth/authorize`                          | `pollar:write` | लॉगिन खोलना → `authorization_url` + `state` |
| GET    | `/v1/pollar/oauth/callback/:state`                    | _public_       | जहाँ Pollar browser को लौटाता है (एक navigation — साथ ले जाने को कोई key नहीं) |
| GET    | `/v1/pollar/oauth/callback?state=`                    | _public_       | वही callback, ऐसी redirect chain के लिए जो query रखती है लेकिन path नहीं |
| GET    | `/v1/pollar/oauth/sessions/:state`                    | `pollar:read`  | handshake को poll करना, और उसका code लेना |
| POST   | `/v1/pollar/oauth/token`                              | `pollar:write` | code redeem करना → Pollar session + वॉलेट |
| POST   | `/v1/pollar/oauth/refresh`                            | `pollar:write` | token pair rotate करना (bearer sessions) |
| POST   | `/v1/pollar/oauth/logout`                             | `pollar:write` | session revoke करना (यह device, या सभी) |
| POST   | `/v1/pollar/wallets/activate`                         | `pollar:write` | XLM reserve fund करना (Deferred funding mode) |
| POST   | `/v1/pollar/wallets/:address/trustlines/default`      | `pollar:write` | app के कॉन्फ़िगर किए गए assets enable करना |
| POST   | `/v1/pollar/wallets/:address/trustlines`              | `pollar:write` | विशिष्ट assets enable करना |
| DELETE | `/v1/pollar/wallets/:address/trustlines/:code/:issuer`| `pollar:write` | trustline हटाना (केवल शून्य balance पर) |
| POST   | `/v1/pollar/users` · `/v1/pollar/users/with-wallet`   | `pollar:write` | user रजिस्टर करना, वैकल्पिक रूप से वॉलेट के साथ (केवल elevated keys) |
| POST   | `/v1/pollar/tokens/verify`                            | `pollar:read`  | किसी वॉलेट द्वारा आपको दिखाए गए token को validate करना |

आखिरी छह Pollar की **secret** key इस्तेमाल करते हैं, इसीलिए वे वॉलेट में नहीं, यहाँ
चलते हैं।

### Rate limiting

Pollar वॉलेट बनाने में पैसा लगता है: Pollar Stellar account बनाता है, उसका
base reserve (1 XLM) fund करता है और हर कॉन्फ़िगर किए गए asset के लिए एक trustline
जोड़ता है (हर एक 0.5 XLM) — **आपके funding वॉलेट से**। लॉगिन flow पर loop चलाने वाली
script बिना किसी असली user के यह पैसा खर्च करवा सकती है, इसलिए यह सर्विस XLM खर्च होने से
पहले खुद सीमाएँ लागू करती है।

**सीमा `authorize` पर है, `token` पर नहीं।** एक handshake अधिकतम एक वॉलेट देता है,
इसलिए प्रति पता handshakes सीमित करने से वॉलेट भी सीमित हो जाते हैं। `token` ढीला है
क्योंकि clients से कहा जाता है कि Pollar के account provision करने तक उसे retry करें, और
redeem करने से कुछ नया नहीं बनता।

| रूट | Budget (प्रति 10 मिनट) | क्यों |
| ----- | ------------------- | --- |
| `POST /v1/pollar/oauth/authorize` | 20 | वॉलेट बनाने की सीमा |
| `POST /v1/pollar/oauth/token` | 60 | account provision होने तक clients इसे retry करते हैं |
| `GET /v1/pollar/oauth/callback` | 60 | बिना API key के पहुँचा जा सकने वाला अकेला रूट |
| `GET /v1/pollar/oauth/sessions/{state}` | 400 | वॉलेट हर कुछ सेकंड में poll करता है; हर poll Pollar तक पहुँच सकता है |
| `POST /v1/pollar/oauth/refresh` · `/logout` | 60, साझा | हर एक Pollar request |
| `POST /v1/pollar/users` · `/users/with-wallet` | 10, साझा | उस user directory में लिखते हैं जिसे सभी tenants साझा करते हैं; `with-wallet` बिना consent स्क्रीन के वॉलेट भी बनाता है |
| `POST /v1/pollar/wallets/activate` | 20 | हर कॉल पर XLM खर्च करता है |
| `POST /v1/pollar/wallets/:address/trustlines` · `/default` | 20, साझा | हर asset funding वॉलेट का reserve lock करता है |
| `DELETE /v1/pollar/wallets/:address/trustlines/:code/:issuer` | 20 | हर एक Pollar request |
| `POST /v1/pollar/tokens/verify` | 120 | हर एक Pollar request |

**दो सीमाएँ address के बजाय प्रति consumer हैं**, इसलिए addresses बदलने से वे कई गुना नहीं
होतीं: एक consumer जितनी Pollar requests करा सकता है (प्रति मिनट 100, poll और callback को
छोड़कर ऊपर के सभी रूट्स पर — Pollar key का budget प्रति मिनट 200 है और सभी tenants उसे साझा
करते हैं), और वह जितने वॉलेट बनवा सकता है (`authorize` और `users/with-wallet`, प्रति दिन 50)।
कंसोल कॉल (`X-Cosmos-Internal`) दोनों से मुक्त हैं: dev platform हर बिना-key वॉलेट को एक ही
consumer से broker करता है और उस traffic का budget खुद तय करता है।

किसी सीमा को पार करने पर **`429` के साथ `code: "rate_limited"`**, एक `Retry-After`, और
`RateLimit-Limit` / `-Remaining` / `-Reset` headers लौटते हैं। यही limiter Pollar के बाहर
उन रूट्स की भी रक्षा करता है जिनकी लागत कोई error वापस नहीं करता — swap और liquidity-pool
builders और उनके submits, payment-intent builders, KYC upload और terms-of-service, onramp
तथा offramp की writes (उनके ऊपर BlindPay की प्रति-consumer सीमा के साथ), webhook `ping` और
`redeliver`, alias challenges और recovery, activity ingest — और हर सेक्शन अपना budget
बताता है। सामान्य rate limiting APISIX का काम है।

**काउंटर memory में नहीं, Postgres में है**, इसलिए सीमा सभी replicas पर एक साथ लागू रहती
है। यह एक fixed window है (प्रति request एक atomic `INSERT … ON CONFLICT … RETURNING`),
इसलिए client window की सीमा के दोनों ओर पूरा budget इस्तेमाल कर सकता है।

**Client का पता।** `main.ts` `trust proxy` को `1` पर सेट करता है, इसलिए Express
`X-Forwarded-For` की *सबसे दाईं* entry पढ़ता है — वह जो APISIX ने जोड़ी। client जो
entries जोड़ता है वे उसके बाईं ओर पड़ती हैं और अनदेखी कर दी जाती हैं।

> **`trust proxy` न बढ़ाएँ।** `2` पर Express client द्वारा दिए गए एक hop पर भरोसा करने
> लगता है, और कोई भी client एक header जोड़कर ये सीमाएँ bypass कर सकता है।

IPv6 callers को प्रति **/64** समूह में रखा जाता है, क्योंकि client के पास आमतौर पर पूरा
/64 होता है; एक /64 साझा करने वाले users एक ही सीमा साझा करते हैं, जैसे किसी IPv4 NAT के
पीछे होता है। सीमाएँ प्रति consumer भी हैं, इसलिए एक integrator का traffic दूसरे पर असर
नहीं डालता।

अगर काउंटर लिखा न जा सके, तो limiter **fail closed** होता है (`503`); इन रूट्स को वैसे भी
database चाहिए। incident के दौरान सीमाएँ बंद करने के लिए `RATE_LIMIT_ENABLED=false` सेट करें।

### सेटअप

1. [dashboard.pollar.xyz](https://dashboard.pollar.xyz) पर एक app बनाएँ और
   अपने नेटवर्क की दोनों keys लें (`pub_testnet_…` / `sec_testnet_…`)। यह
   **दोनों** नेटवर्क के लिए करें: mainnet लॉगिन एक testnet वॉलेट भी provision करता है, और
   testnet keys न होने पर वह दूसरा वॉलेट उनके सेट होने तक `pending` रहता है। दोनों
   डैशबोर्ड अलग हैं — हर एक में callback host रजिस्टर करें।
2. `POLLAR_BRIDGE_CALLBACK_URL` के **gateway host** को
   **Build → Domains** के अंतर्गत रजिस्टर करें। SDK API *हर* कॉल पर `Origin` header के
   सामने उस सूची की जाँच करता है, और bridge यह header इसी host पर सेट करता है
   (`POLLAR_SDK_ORIGIN` इसे override करता है)। रजिस्टर न किए गए host को
   `POST /auth/session` पर `403 ORIGIN_NOT_ALLOWED` मिलता है, जो हर लॉगिन की पहली कॉल है।
3. `POLLAR_BRIDGE_CALLBACK_URL` को `<gateway>/v1/pollar/oauth/callback` पर सेट करें —
   `/{state}` bridge खुद जोड़ता है।
4. हर वॉलेट का redirect URI `POLLAR_REDIRECT_URI_WHITELIST` में जोड़ें, या उसे छोड़ दें
   और poll flow का उपयोग करें।

Pollar नेटवर्क और key का प्रकार key के prefix में encode करता है, और env validator boot
पर ही mismatch को अस्वीकार कर देता है। feature बंद करने के लिए keys खाली छोड़ दें (तब Pollar
रूट `503` लौटाते हैं)। `.env.example` देखें।

## अपग्रेड — breaking changes और deploy नोट्स

### सुरक्षा समीक्षा के सुधार

इनमें से अधिकांश किसी सही ढंग से व्यवहार करने वाले caller के लिए कुछ नहीं बदलते; deploy करने
से पहले "किसे पता चलेगा" कॉलम देखें।

| बदलाव | किसे पता चलेगा | क्यों |
| ------ | ----------- | --- |
| `POST /v1/aliases/:name/recovery` **केवल प्लेटफ़ॉर्म कंसोल** के लिए है: API key को `403 admin_console_only` मिलता है, और यह रूट प्रकाशित contract से हटा दिया गया | जिसने भी API key से recoveries शुरू की थीं | response में recovery token होता है, जो मालिक के mailbox पर नियंत्रण साबित करता है |
| `SUSPENDED` alias पर recovery पूरी करना `404` है | कोई वैध caller नहीं | suspension से पहले जारी हुआ token operator के hold को bypass कर सकता था |
| `@Public()` रूट (Pollar callback, BlindPay webhook, health) `X-Consumer-Username` को अनदेखा करते हैं | डैशबोर्ड: वे requests अब anonymous के रूप में log होती हैं | उन रूट्स पर key-auth नहीं है, इसलिए header client से ही आता था |
| `AdminGuard` और `ConsoleOnlyGuard` द्वारा मना करना `warn` स्तर पर log होता है | Operators | Guards access log से पहले चलते हैं, इसलिए मना की गई requests का कोई निशान नहीं रहता था |
| `POST /v1/pollar/wallets/activate` और तीनों `/v1/pollar/wallets/:address/trustlines…` रूट उस वॉलेट के लिए `404` लौटाते हैं जो कॉल करने वाले consumer ने उस नेटवर्क पर इस सर्विस के ज़रिए प्राप्त नहीं किया | ऐसे वॉलेट पर काम करने वाले integrators जिन्हें उन्होंने केवल `tokens/verify` से देखा, किसी लॉगिन के non-primary वॉलेट पर, या ऐसे counterpart वॉलेट पर जिसे किसी दूसरे tenant ने पहले ही रजिस्टर कर लिया | सभी tenants Pollar secret keys का एक ही सेट साझा करते हैं। पराए और अनजान वॉलेट दोनों को `404` मिलता है, इसलिए जवाब से ownership का पता नहीं चलता |
| दोनों `POST …/trustlines` रूट प्रति 10 मिनट 20 कॉल का एक `429` budget साझा करते हैं | थोक में trustlines जोड़ने वाली scripts | हर trustline operator के funding वॉलेट के 0.5 XLM lock करता है |
| `GET /v1/offramp/payouts/:id` अब `raw`, `consumerId`, `receiverId`, `quoteId`, `bankAccountId` या `updatedAt` नहीं लौटाता; virtual-account बनाने का response अब `raw`, `receiverId`, `consumerId` या `updatedAt` नहीं लौटाता | उन fields को पढ़ने वाले callers | `raw` BlindPay का सहेजा हुआ object है, जिसमें बैंक और लाभार्थी का डेटा है |
| `POST /v1/kyc/upload` 4 से अधिक text fields, 1 KiB से बड़े field, दूसरी फ़ाइल, या घोषित type से मेल न खाने वाले file bytes पर `400` लौटाता है | सही ढंग से upload भेजने वाला कोई नहीं | fields असीमित थे और type जाँच client के `Content-Type` पर भरोसा करती थी |
| `POST /v1/payment-intents/tx` और `/pay`: वही memo किसी भी अलग शर्त के साथ `409 idempotency_conflict` है। हूबहू retry अब भी सहेजा गया intent लौटाता है (`2` और `2.0` एक ही राशि हैं) | एक ही memo को अलग-अलग पेमेंट के लिए दोबारा इस्तेमाल करने वाले callers | साझा public key के तहत, किसी और के पहले बनाए memo से उसका intent लौटता था |
| `POST /v1/payment-intents/:id/validate` केवल उसी विफल tx के लिए `FAILED` करता है जो इस intent का अपना पेमेंट हो; कोई भी दूसरा विफल tx `valid: false` है और status नहीं बदलता। intent बनने से 60 s से अधिक पहले close हुआ tx अस्वीकार किया जाता है ("Transaction predates this payment intent") — validate पर, `PATCH {status: SUCCEEDED}` पर, और observer में | कोई वैध caller नहीं | कोई भी विफल ट्रांज़ैक्शन किसी intent को fail कर सकता था, और समान शर्तों वाला पुराना पेमेंट नए intent को settle कर सकता था |
| terminal intent पर `txHash` बदलने वाला `PATCH /v1/payment-intents/:id` `400 invalid_state_transition` है; write के साथ होड़ करने वाला status बदलाव `409 operation_in_flight` है | कोई वैध caller नहीं | यह `SUCCEEDED` intent के settlement के प्रमाण को दोबारा लिख सकता था |
| payment-intent observer प्रति tick प्रति consumer अधिकतम 10 intents का मिलान करता है और expired rows को कभी scan नहीं करता | observer throughput पर नज़र रखने वाले operators | एक consumer बाकी हर tenant के settlement में देरी कर सकता था |
| `POST /v1/swaps`, `/v1/liquidity-pools/deposit` और `/withdraw`: अलग request के साथ दोबारा इस्तेमाल की गई `Idempotency-Key` — अलग memo या slippage, दूसरा नेटवर्क, या withdrawal के लिए दोबारा इस्तेमाल की गई deposit key — `409 idempotency_conflict` है। अवैध asset, slippage या memo वाला replay अब सामान्य `400` पाता है | एक ही key को अलग-अलग operations के लिए दोबारा इस्तेमाल करने वाले clients | साझा public key के तहत, कोई अनुमान लगाई जा सकने वाली key से पहले ही envelope बना सकता था, और वह किसी दूसरे user के retry पर लौट आता |
| `POST /v1/liquidity-pools/withdraw` अब ऐसे in-flight withdrawal के लिए `409 operation_in_flight` जवाब नहीं देता जिसका sequence number account ने अभी तक इस्तेमाल नहीं किया (unsigned या छोड़ा गया envelope) | जो वॉलेट users रोक दिए गए थे | किसी और के account के लिए बना envelope उस position से withdrawals को अनिश्चित समय तक रोक सकता था |
| settlement observer प्रति tick प्रति टेबल प्रति consumer अधिकतम 10 rows लेता है, और `GET /v1/liquidity-pools/positions` हर pool के लिए एक request की बजाय एक paged listing से Horizon पढ़ता है | Operators | एक consumer बाकी सबके settlement में देरी कर सकता था, और कई pool shares का मतलब असीमित Horizon कॉल था |
| `GET /v1/onramp/payins/:id` अब `receiverId` या `updatedAt` नहीं लौटाता — वही shape जो `GET /v1/onramp/payins` लौटाता है | एक payin की read से ये दो fields पढ़ने वाले callers | एक ही payin दो shapes में लौट सकता था |
| 10 MiB से बड़ी फ़ाइल वाला `POST /v1/kyc/upload` अब `code: "payload_too_large"` के साथ `413` है; पहले यह `internal_error` था | `code` पर branch करने वाले integrators | यह client की ओर की सीमा है, server error नहीं |
| `POST /v1/liquidity-pools/deposit`, `/withdraw`, `GET /v1/liquidity-pools/operations`, `/operations/:id`, `POST /v1/liquidity-pools/operations/:id/submit` और `LIQUIDITY_*` webhooks में अब `memo` आता है (caller का MEMO_ID, या `null`)। Migration `20260915120000_liquidity_pool_operation_memo` से पहले बने operations `null` लौटाते हैं, भले ही उनके envelope में memo हो | कोई नहीं, जब तक कोई client अनजान fields को reject न करे | memo केवल XDR के अंदर सहेजा जाता था |
| `GET /v1/swaps` और `GET /v1/liquidity-pools/operations` का प्रकाशित contract अब list items पर `qr` या `commissionMemo` नहीं दिखाता। Responses नहीं बदले — ये दो fields वहाँ कभी भेजे ही नहीं गए; इनके लिए अकेला item पढ़ें | OpenAPI spec से generate किए गए clients | contract list items को single-item shape के साथ बताता था |
| सर्विस boot होने से मना कर देती है जब `APISIX_GATEWAY_SECRET` कोई placeholder हो — वह value जो पहले `.env.example` में आता था, या `replace-with`, `change-me`, `your-secret` या `placeholder` वाला कोई भी value — और `.env.example` अब इसे खाली छोड़ता है | वे deployments जो अब भी `.env.example` से copy किया गया value इस्तेमाल कर रहे हैं | वह value सार्वजनिक है और 32-अक्षर की न्यूनतम सीमा पार करने लायक लंबा है, इसलिए जो भी सर्विस तक पहुँच सकता था वह किसी भी consumer का नाम लेकर `/v1/admin` तक पहुँच सकता था |
| सर्विस boot होने से मना कर देती है जब `BLINDPAY_WEBHOOK_SECRET` सेट हो लेकिन उसकी key (`whsec_` के बाद का base64) malformed हो या 24 bytes से कम में decode हो, और जब तक configured key इस्तेमाल के लायक नहीं है तब तक `POST /v1/blindpay/webhooks` हर delivery को reject करता है | कटे-फटे या ग़लत टाइप किए secret वाले deployments, जिनके BlindPay webhooks पहले से ही विफल हो रहे थे | Node अमान्य base64 को बिना किसी error के एक छोटी या खाली HMAC key में decode कर देता है, और खाली key से sign की गई delivery को कोई भी forge कर सकता है |
| `GET /v1/health/readiness` अब विफल check का जवाब standard error envelope से देता है (`error: "Service Unavailable"`); पहले यह health report, database error message सहित, `error` में रखता था | जो probes status code की बजाय body से report पढ़ते हैं | यह रूट `@Public()` है, और Prisma का message database host और user का नाम बताता है |
| `POST /v1/onramp/receivers/:id/virtual-accounts` अब `403 account_disabled` है जब receiver, या वह receiver जिसके पास `blockchain_wallet_id` है, disabled हो | कोई वैध caller नहीं | यह वह एक fiat operation थी जिसे kill switch cover नहीं करता था: एक disabled account अब भी नया deposit rail खोल सकता था |
| `POST /v1/pollar/oauth/token` अब ऐसा code redeem नहीं करता जिसे `GET /v1/pollar/oauth/sessions/:state` के किसी नए poll ने बदल दिया हो, भले ही वह poll redemption के बीच में ही क्यों न आए | कोई वैध caller नहीं | claim handshake से मेल खाता था पर code से नहीं, इसलिए retired code अब भी उस window में खर्च किया जा सकता था |
| `POST /v1/swaps/:id/submit` और `POST /v1/liquidity-pools/operations/:id/submit` सबसे पहले envelope जाँचते हैं: ऐसा body जो parse न हो, row का envelope न हो, या जिस पर कोई signature न हो, row की status चाहे जो हो, `400 validation_failed` है। कोई मनमाना `signedXdr` अब `SUCCEEDED` row नहीं लौटाता, और एक `EXPIRED` row मेल न खाने वाले body को `invalid_state_transition` की बजाय `validation_failed` से जवाब देता है | जिन clients ने unsigned `xdr` submit किया और `tx_bad_auth` रिजेक्शन पर भरोसा किया | signatures किसी ट्रांज़ैक्शन का hash नहीं बदलतीं, इसलिए unsigned envelope को loop में relay और reject किया जा सकता था, और साझा public key के तहत सिर्फ row id से settled row पढ़ी जा सकती थी |
| दोनों submit रूट time bounds पार कर चुके envelope को मना करते हैं (`400 invalid_state_transition`, broadcast नहीं होता; अगर वह network तक पहुँच चुका था तो observer उसे अब भी settle कर देता है) और उस `FAILED` row को भी जो पहले ही 3 बार दोबारा submit हो चुकी हो (`400 invalid_state_transition`: नई बनाएँ)। `503 provider_unavailable` के बाद की retry नहीं गिनती | जो clients submit को loop में retry करते हैं: `invalid_state_transition` पर रुक जाएँ | हर rejected resubmit एक Horizon submission और एक नया terminal webhook event था, बिना किसी सीमा के |
| दोनों submit रूट प्रति consumer और client address प्रति मिनट 20 कॉल की अनुमति देते हैं, अलग-अलग buckets में (`429 rate_limited`) | एक ही NAT के पीछे public key साझा करने वाले वॉलेट | ये रूट साझा public key लेते हैं, और हर कॉल Horizon पर broadcast कर सकती है |
| `GET /v1/webhooks`, `GET /v1/webhooks/:id` और `PATCH /v1/webhooks/:id` अब केवल दस्तावेज़ीकृत endpoint fields लौटाते हैं; `POST /v1/webhooks` और `POST /v1/webhooks/:id/rotate-secret` इनके साथ `secret` भी लौटाते हैं। `consumerId`, `previousSecret` और `previousSecretExpiresAt` इन सभी पाँचों से हटा दिए गए | उन fields को पढ़ने वाले callers | `previousSecret` एक signing secret है जिसे integrator अब भी स्वीकार कर सकता है, और सिर्फ़ `webhooks:read` वाली key भी उसे पढ़ सकती थी |
| जो recovery token alias की किसी चालू recovery से मेल न खाए, वह अब उसके खिलाफ़ नहीं गिना जाता। एक चालू token हर प्रस्तुति पर एक प्रयास इस्तेमाल करता है, यहाँ तक कि वह भी जिसका challenge या signature बाद में विफल हो जाए; पाँच के बाद यह `400 alias_recovery_invalid` है | कोई वैध caller नहीं | alias के नाम सार्वजनिक हैं, इसलिए किसी भी key से भेजे गए पाँच junk tokens कंसोल द्वारा शुरू की गई हर recovery जला देते थे |
| `POST /v1/aliases/:name/recovery/complete` (प्रति 10 मिनट 10), `POST /v1/aliases/challenges` (30), `POST /v1/webhooks/:id/ping` (20) और `POST /v1/webhooks/:id/deliveries/:deliveryId/redeliver` (30) budget से ऊपर जाने पर `429 rate_limited` हैं, प्रति consumer और client address | इन रूट्स को loop में चलाने वाली scripts | हर कॉल एक row सहेजती है, एक recovery token आज़माती है, या caller के चुने गए URL पर requests भेजती है |
| `PATCH /v1/payment-intents/:id` को अब `txHash` का 64-अक्षर का hex Stellar transaction hash होना ज़रूरी है (कुछ भी और `400` है) और इसे lowercase में सहेजता है; `POST /v1/payment-intents/:id/validate` अपना hash खुद lowercase करता है। hash अब सभी tenants में नहीं बल्कि एक consumer के intents में unique है, और जो hash आपके किसी दूसरे intent पर पहले से हो वह `409 idempotency_conflict` है (पहले यह `500` था) | placeholder या कटे हुए hashes भेजने वाले callers | कोई भी tenant किसी दूसरे tenant का transaction hash अपने ही किसी intent पर रख सकता था; फिर उस दूसरे tenant का settlement global index से टकराता, `500` का जवाब देता, और paid intent बिना `PAYMENT_INTENT_SUCCEEDED` के expire हो जाता |
| `EXPIRED` intent `SUCCEEDED` पर चला जाता है जब उसका पेमेंट on-chain verify हो जाए: observer से, जो अब expire करने से पहले चेन जाँचता है, या `POST /v1/payment-intents/:id/validate` और `PATCH {status: SUCCEEDED}` से, जो अब `400 invalid_state_transition` की बजाय `200` का जवाब देते हैं। `EXPIRED` भेजे गए update के बाद `PAYMENT_INTENT_SUCCEEDED` आ सकता है | `EXPIRED` को final मानने वाले webhook consumers | expiry कभी चेन नहीं देखती थी, और verifier destination के केवल 50 सबसे नए पेमेंट्स पढ़ता था, इसलिए देर से आया या दबा हुआ पेमेंट किसी paid intent को हमेशा के लिए `EXPIRED` छोड़ देता था |
| `redirect_uri` के साथ `POST /v1/pollar/oauth/authorize` को `code_challenge` (PKCE, S256) चाहिए, और उस handshake को redeem करने के लिए `code_verifier` चाहिए; इसके बिना Pollar session खुलने से पहले ही call `400 validation_failed` है। poll flow नहीं बदला | PKCE न भेजने वाले redirect-flow वॉलेट | public callback code को `state` दिखाने वाले किसी को भी दे देता है, जो `authorization_url` के अंदर है, और PKCE के बिना वह code जैसा का तैसा redeem हो जाता था |
| swaps, liquidity-pool operations, payment intents और customers के responses अब केवल अपने documented fields लौटाते हैं, साथ में swaps और payment intents पर `expiresAt`, जो अब documented है। `consumerId` और settlement की bookkeeping (`settlementEpoch`, `lastCheckedAt`, `notFoundStreak`, `sharesReceived`, `settledAmountA`/`B`, `horizonCursor`) अब नहीं भेजे जाते | वे callers जो ये fields पढ़ते थे | ये internal हैं, और इनमें से कई routes साझा public key से पहुँचे जा सकते हैं |
| BlindPay पर पहले से मौजूद receiver पर `PATCH /v1/kyc/receivers/:id` `external_id` और `image_url` को छोड़कर किसी भी field के लिए `403 kyc_review_required` है, जब तक key elevated (`X-Consumer-Role: admin`) न हो | tenant key से किसी live receiver की पहचान सुधारने वाले integrators: इसे reviewer से होकर भेजें | `PUT` कभी review न हुआ identity data सीधे एक regulated provider को भेज देता था, जबकि enable होने से पहले वही edit फिर से review में जाता है |
| BlindPay routes caller की key के environment वाला instance इस्तेमाल करते हैं: `prod` keys बिना suffix वाले `BLINDPAY_*` का, `dev` keys `BLINDPAY_*_DEV` का, और development instance कॉन्फ़िगर न होने पर `dev` key को `503 misconfigured` मिलता है। receivers, wallets, bank accounts, virtual accounts, quotes, payins और payouts केवल उसी instance पर पढ़े और execute किए जाते हैं | `dev` keys के साथ BlindPay इस्तेमाल करने वाले सभी | एक `dev` key production instance चलाती थी: वह असली KYC identities list और delete कर सकती थी और असली payouts बना सकती थी |
| `POST /v1/pollar/oauth/token` session तभी लौटाता है जब लॉगिन के लिए Pollar द्वारा रिपोर्ट किया गया email वही account email हो जिसे gateway key के लिए forward करता है (`X-Consumer-Email`)। mismatch session revoke करता है, handshake विफल करता है और `403 pollar_identity_mismatch` है; जिस key का email forward नहीं हुआ उसे `authorize` पर `403 pollar_identity_required` मिलता है | वे tenants जो साझा Pollar application से अपने end users को लॉगिन कराते हैं, और जो भी अपने account से अलग email से लॉगिन करता है | सभी tenants एक Pollar application साझा करते हैं और लॉगिन link किसी भी browser में काम करता है: कोई key अपना `authorization_url` किसी को भेजकर, consent का इंतज़ार करके, उस व्यक्ति का custodial वॉलेट redeem कर सकती थी |
| `POST /v1/pollar/users` और `/v1/pollar/users/with-wallet` के लिए elevated key चाहिए; tenant key को `403 elevated_key_required` मिलता है | tenant key से users को पहले से रजिस्टर करने वाले integrators | रजिस्टर हुआ user वही है जिसे बाद का social लॉगिन email से resolve करता है, इसलिए tenant key किसी अजनबी का email claim करके उसके वॉलेट की मालिक के रूप में दर्ज हो सकती थी |
| testnet लॉगिन अब अपने user के लिए mainnet वॉलेट provision नहीं करता: testnet redemption के `network_wallets` में केवल testnet वॉलेट होता है। mainnet लॉगिन अब भी testnet provision करता है | testnet लॉगिन से mainnet entry पढ़ने वाले | जिस `dev` key को कोई भी बना सकता है, वह हर लॉगिन पर mainnet reserve के लिए operator का असली XLM खर्च करती थी |
| poll, refresh, logout, token-verify, user-registration और trustline-removal वाले Pollar रूट्स पर सीमा है, और प्रति-address budgets के ऊपर प्रति-consumer quota (प्रति मिनट 100 Pollar requests) और वॉलेट सीमा (प्रति दिन 50) लागू होती है; अधिकता `429 rate_limited` है | इन रूट्स पर लगातार कॉल करने वाले clients | इन पर कोई सीमा नहीं थी, और हर कॉल वह Pollar request budget खर्च करती है जिसे सभी tenants साझा करते हैं — एक tenant बाकी सभी tenants के लॉगिन विफल कर सकता था |
| `POST /v1/kyc/receivers/:id/approve` अब `expected_version` लेता है (वही `dossierVersion` जो आपने पढ़ा) और KYC data उसके बाद बदल जाने पर `409 kyc_state_invalid` देता है। `POST /v1/kyc/receivers/:id/enable` ऐसे dossier को मना कर देता है जो approve किया हुआ नहीं है, और receiver पढ़ने पर `dossierVersion` तथा `reviewedVersion` आते हैं | reviewers, जब वे `expected_version` भेजना शुरू करें; और कोई नहीं — field वैकल्पिक है | review का मतलब है कोई व्यक्ति data पढ़े और फिर approve करे, और बीच में हुआ edit status को `pending_review` पर ही छोड़ता है — यानी approval ऐसे dossier पर लगती थी जिसे किसी ने देखा नहीं था, और `enable` उसे एक regulated provider को भेज देता था |
| `POST /v1/kyc/upload`, `/v1/kyc/terms-of-service`, onramp तथा offramp की writes, `POST /v1/payment-intents/tx` और `/pay`, `POST /v1/swaps/quote` और `/v1/swaps`, तथा `POST /v1/liquidity-pools/deposit` और `/withdraw` अब budget से ऊपर `429 rate_limited` देते हैं, प्रति consumer और client address। BlindPay पर टिका हर रूट प्रति मिनट 60 provider requests की प्रति-consumer सीमा में भी गिना जाता है | इन रूट्स पर loop चलाने वाले scripts; सीमा से ऊपर चलने वाले bulk importer की अपनी key होनी चाहिए | इन पर कोई सीमा थी ही नहीं: हर एक या तो provider के पास कुछ छोड़ जाती है जिसे कोई error वापस नहीं करता, या वह प्रति-IP Horizon budget खर्च करती है जिसे यहाँ के सभी रूट साझा करते हैं। सीमित केवल submits थे |
| `POST /v1/swaps` अब ऐसे `PENDING` swap के लिए `409 operation_in_flight` नहीं देता जिसका sequence number account ने अभी इस्तेमाल नहीं किया (unsigned या छोड़ा हुआ envelope)। यह केवल `STELLAR_SWAP_SINGLE_INFLIGHT=true` पर लागू है | वे वॉलेट users जो ब्लॉक हो जाते थे | कोई भी कोई भी `source` बता सकता है, इसलिए एक dust swap किसी और के account को एक के बाद एक timeout window तक जमा देता था — ऊपर वाले liquidity-pool सुधार का जुड़वाँ |
| host की वजह से अस्वीकृत webhook destination — resolve न होना, private, link-local, metadata — अब एक ही संदेश वाला एक `400` है; कारण सेवा के log में रहता है। malformed URL, https से अलग scheme, credentials या host का न होना अब भी बताते हैं कि क्या गलत है | वे integrators जो कारण response से पढ़ते थे | endpoint रजिस्टर करना ऐसा नाम resolve करता है जहाँ यह सेवा पहुँच सकती है, इसलिए कारण-दर-कारण जवाब से internal network का नक्शा एक-एक URL करके बनाया जा सकता था |
| `redirect_url` तब अस्वीकार होती है जब उसमें fragment, backslash, whitespace या control character हो; embedded credentials के बिना https पहले से अनिवार्य था | सामान्य URL भेजने वाला कोई नहीं | `https://app.acme.com\@evil.test` इस बात पर अलग-अलग host बताता है कि उसे कौन parse कर रहा है, और वह मान BlindPay तथा एक browser दोबारा पढ़ते हैं |
| जब `POLLAR_BRIDGE_CALLBACK_URL` किसी routable host पर सादा `http` हो, तो सेवा boot होने से मना कर देती है | वे deployments जो TLS कहीं और terminate करते हैं और callback को `http` रखते हैं | Pollar browser को उसी URL पर authorization code के साथ query string में लौटाता है, और वह code user के session से बदला जाता है |

इसके साथ आने वाले deploy नोट:

- **Migration `20260910120000_aliases`** `alias`, `alias_address`,
  `alias_challenge` और `alias_recovery` बनाता है। नया
  build traffic serve करे, उससे पहले `migrate deploy` चलाएँ।
- **एक नया advisory lock id, `881_008` (`AliasChallengeSweeper`)।** कुछ भी
  कॉन्फ़िगर नहीं करना है।
- **production में `NODE_ENV=production` सेट करें।** `.env.example`
  `development` के साथ आता है, और दो सुरक्षाएँ इसी पर निर्भर हैं:
  `X-Plan-Swap-Fee-Bps` के बिना आई request केवल production में `503` है (बाकी हर जगह swaps
  चुपचाप `STELLAR_SWAP_FEE_BPS` पर लौट जाते हैं), और `/docs` — जो हर guard से बाहर है
  — केवल production में डिफ़ॉल्ट रूप से बंद है।
- **settlement observer की log lines बदल गई हैं:**
  `Settlement observer started (every Nms)`,
  `Settlement observer (OBSERVER_ENABLED=false) disabled`, और `error` level पर
  `SettlementObserverService cycle failed`। पुराने शब्दों पर match करने वाले alerts
  अपडेट करें। `OBSERVER_ENABLED`, `OBSERVER_INTERVAL_MS` और advisory lock नहीं बदले।
- **Migration `20260915120000_liquidity_pool_operation_memo`** nullable column
  `liquidity_pool_operation.memo` जोड़ता है: table rewrite नहीं होता, केवल थोड़ी देर
  का exclusive lock। कोई backfill नहीं है — पुरानी rows का memo base64 XDR में है,
  जिसे SQL decode नहीं कर सकता, और उनके लिए service envelope पर लौट जाती है।
- **Migration `20260915120100_lookup_indexes`** Pollar wallet ownership check के लिए
  दो indexes `CONCURRENTLY` बनाता है
  (`pollar_oauth_session(consumerId, network, walletAddress)` और
  `pollar_user_wallet(consumerId, network, address)`)। यह writes को block नहीं करता,
  लेकिन असफल build एक `INVALID` index छोड़ देता है जिसे `IF NOT EXISTS` मौजूद मानता
  है: उसे
  `SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE NOT i.indisvalid;`
  से खोजें, `DROP INDEX CONCURRENTLY` से हटाएँ,
  `prisma migrate resolve --rolled-back 20260915120100_lookup_indexes` चलाएँ, और फिर
  से deploy करें।
- **अब boot पर दो variables जाँचे जाते हैं।** कोई placeholder `APISIX_GATEWAY_SECRET`,
  या ऐसा `BLINDPAY_WEBHOOK_SECRET` जिसकी key कम से कम 24 bytes में decode न हो, सर्विस
  को शुरू होने से रोक देता है और error उस variable का नाम बताती है। placeholder gateway
  secret को APISIX route पर और यहाँ, दोनों जगह एक ही बदलाव में बदलें
  (`openssl rand -hex 32`); mismatch होने पर हर request gateway से न आने के कारण विफल
  हो जाती है।
- **Migration `20260915150000_payment_intent_tx_hash_per_consumer`**
  `payment_intent."txHash"` पर मौजूद unique index को `("consumerId", "txHash")` वाले
  index से बदलता है। यह `CONCURRENTLY` नहीं है: index बनने के दौरान `payment_intent`
  write-locked रहता है। कोई backfill नहीं है।
- **सहेजे गए `webhook_endpoint.previousSecret` values अब नहीं लौटाए जाते, पर कुछ भी
  उन्हें साफ़ नहीं करता।** अगर किसी पुराने release पर हुई rotation ने एक पीछे छोड़ दिया है
  और आप उसे database से हटाना चाहते हैं, तो दोनों columns खुद null करें।
- **Migration `20260915160000_blindpay_environment`** सात BlindPay mirror tables में
  `environment` (डिफ़ॉल्ट `'prod'`) जोड़ता है — केवल catalog बदलाव, कोई table rewrite
  नहीं — इसलिए मौजूदा rows production के रूप में चिह्नित होती हैं। **अगर आपके बिना suffix
  वाले `BLINDPAY_*` variables किसी BlindPay development instance की ओर इशारा करते थे**, तो
  उन्हें `_DEV` variables में ले जाएँ और rows को फिर से label करें
  (`blindpay_receiver`, `blindpay_blockchain_wallet`, `blindpay_bank_account`,
  `blindpay_virtual_account`, `payin`, `payout` और `blindpay_quote` पर
  `UPDATE … SET environment = 'dev'`), वरना `prod` keys उन्हें पढ़ती रहेंगी।
- **BlindPay development instance कॉन्फ़िगर करें** (`BLINDPAY_API_KEY_DEV`,
  `BLINDPAY_INSTANCE_ID_DEV`, `BLINDPAY_WEBHOOK_SECRET_DEV`) अगर `dev` keys BlindPay
  इस्तेमाल करती हैं, और उसका dashboard webhook उसी `/v1/blindpay/webhooks` URL पर लगाएँ।
- **पहले dev platform का forwarder बदलाव deploy करें।** `authorize` हर उस key को मना करता है
  जिसके लिए gateway `X-Consumer-Email` forward नहीं करता। forwarder हर account का email तब दर्ज
  करता है जब उस account की keys sync होती हैं, इसलिए मौजूदा consumers को फिर से sync करें
  (dashboard में किसी user की keys list करने से उस user के लिए यह हो जाता है)। तब तक वॉलेट dev
  platform के brokered लॉगिन पर चला जाता है, जिसे header की ज़रूरत नहीं; बाकी clients को
  `403 pollar_identity_required` मिलता है।
- **साझा Pollar application से third-party end users का social लॉगिन बंद हो जाता है।** जिस
  tenant का app अपने users को लॉगिन कराता है, उसे हर उस user के लिए
  `403 pollar_identity_mismatch` मिलता है जिसका email key के account का email नहीं है।
- **Migration `20260915180000_pollar_testnet_counterpart_mainnet`** उन mainnet वॉलेट्स को बंद
  करता है जिन्हें testnet लॉगिन ने `pending` छोड़ा था (`FAILED`,
  `COUNTERPART_FROM_TESTNET_DISABLED`), ताकि sweeper उन्हें fund करना बंद कर दे। केवल data,
  कोई schema बदलाव नहीं।
- **Migration `20260915200000_receiver_dossier_version`** `blindpay_receiver` में
  `dossierVersion` (डिफ़ॉल्ट `1`) और `reviewedVersion` जोड़ता है — केवल catalog, कोई table
  rewrite नहीं — और हर उस receiver के लिए `reviewedVersion` भर देता है जो review gate पार
  कर चुका है, ताकि उसका `enable` चलता रहे। जो receivers अब भी `inactive` या
  `pending_review` में हैं, उनके लिए `NULL` रहता है, जो उनके बारे में सच है।
- **deploy से पहले `POLLAR_BRIDGE_CALLBACK_URL` जाँच लें।** किसी routable host पर सादा
  `http` अब सेवा को शुरू ही नहीं होने देता, और error में variable का नाम आता है। loopback
  (`http://127.0.0.1:…`) local development के लिए अब भी स्वीकार है।
- **उन रूट्स पर नए `429` जिन पर पहले कभी नहीं आते थे।** ऊपर की तालिका वाले budgets इसी
  रिलीज़ से लागू हैं; KYC uploads, quotes, payins, payouts, intent builds, swap quotes या
  pool builds पर loop चलाने वाले client को `Retry-After` मानना होगा। किसी incident के
  दौरान `RATE_LIMIT_ENABLED=false` limiter बंद कर देता है।

### OpenAPI contract अब केवल वही दिखाता है जो हर route लौटाता है

wire पर कुछ नहीं बदला; प्रकाशित contract बदला है। `openapi/openapi.json` से बना कोई भी client
दोबारा generate करें:

- हर operation केवल वे failures दिखाता है जो वह लौटा सकता है। `409` केवल वहीं है जहाँ route
  अपना conflict खुद दर्ज करता है, `429` केवल rate-limited routes पर, `502`/`503`/`504` केवल
  वहीं जहाँ route किसी provider को कॉल करता है, और health probes में `401`/`403` नहीं है। साझा
  failures `components.responses` के `$ref` हैं।
- हर failure उदाहरण अपने status के लिए असली है। पहले spec हर route के हर status के नीचे एक ही
  `409 idempotency_conflict` दिखाता था।
- `X-Gateway-Secret` और `X-Consumer-Username` एक ही security requirement हैं (दोनों headers),
  और gateway से होने वाली calls के लिए `Authorization: Bearer` विकल्प के रूप में प्रकाशित है।
  पहले ये दो विकल्प थे, जिससे tools को लगता था कि कोई एक header काफ़ी है।
- `GET /v1/health/readiness` का `503` error envelope के रूप में दर्ज है। पहले यह Terminus
  report के रूप में दर्ज था, जिसे exception filter कभी लौटाता ही नहीं।

### NestJS 12, TypeScript 6 और न्यूनतम Node 24.9

सर्विस अब NestJS 12 और TypeScript 6 पर चलती है और **इसे Node 24.9 या उससे नया
version चाहिए** (`engines`; CI `node-version: 24` pin करता है)। deploy targets को भी इसी
हिसाब से अपडेट करें।

NestJS 12 ESM के रूप में प्रकाशित होता है, और Jest इसे केवल Node >= 24.9 पर
`--experimental-vm-modules` के साथ load कर सकता है, इसलिए test scripts Jest को सीधे
Node के ज़रिए चलाती हैं:

```
"test": "node --experimental-vm-modules node_modules/jest/bin/jest.js"
```

प्रकाशित OpenAPI contract में `@nestjs/terminus@12` से ज़्यादा समृद्ध health schemas
जुड़े (status enums और `responseTime`)। कोई business रूट या schema नहीं बदला।

### एक साझा सार्वजनिक API key, और उसे सीमित करने वाला guard

`PublicKeyGuard` (global, `PermissionsGuard` के बाद) और `@AllowPublicKey()`
decorator नए हैं। मौजूदा keys पर कोई असर नहीं पड़ता। deploy के समय:

- **`APISIX_PUBLIC_CONSUMER` सेट करें**, उस username पर जिसे dev platform
  public key के लिए provision करता है, हर उस deployment पर जो ऐसी key प्रकाशित करता है। इसके बिना guard
  केवल forwarded `X-Consumer-Role` पर निर्भर रहता है।
- **public key `role: public` के साथ बनाएँ** और केवल उन्हीं scopes के साथ जिनकी
  allowlist वाले रूट्स को ज़रूरत है। `kyc:*` जैसे अतिरिक्त scopes वे रूट नहीं खोलेंगे,
  लेकिन जो key सबके पास है, उसमें वे नहीं होने चाहिए।

ऊपर "साझा सार्वजनिक API key" देखें।

### एसेट रजिस्ट्री: `GET /v1/assets`

(code, issuer) जोड़ों की एक चुनी हुई सूची जिन्हें यह प्लेटफ़ॉर्म प्रति नेटवर्क support करता
है, जारी करने वाले संगठन के साथ। इसके लिए किसी scope की ज़रूरत नहीं, क्योंकि इसमें कोई
tenant डेटा नहीं है, लेकिन authenticated consumer ज़रूरी है (साझा public key भी चलती है)।

`npm run assets:verify` हर row को live Horizon के सामने जाँचता है: कि जोड़ा अपने नेटवर्क पर
मौजूद है, कि `contract` Horizon के `contract_id` से मेल खाता है, और कि issuer flags chain से
मेल खाते हैं। रजिस्ट्री संपादित करते समय इसे चलाएँ; इसे internet access चाहिए, इसलिए यह unit
tests का हिस्सा नहीं है।

### क्लाइंट एक्टिविटी: एक नया मॉड्यूल, एक नई टेबल और दो नए scopes

`POST /v1/activity/events` वॉलेट और developer
डैशबोर्ड से telemetry स्वीकार करता है; `GET /v1/activity/events` और `GET /v1/activity/summary` उसे वापस पढ़ते हैं।
कोई मौजूदा response नहीं बदला। deploy के समय:

- **Migration `20260906140000_activity_event`** `activity_event` बनाता है
  (append-only, `consumerId` तक सीमित, `(consumerId, eventId)` पर unique)।
- **scopes `activity:write` और `activity:read` नए हैं।** मौजूदा keys को ये अपने आप नहीं
  मिलते और उन्हें `insufficient_scope` मिलता है। developer platform वॉलेट के लिए provision
  की गई keys को दोनों देता है और rotation पर इन्हें फिर से लागू करता है; हाथ से बनाई गई
  keys में इन्हें जोड़ें।
- **`ACTIVITY_RETENTION_DAYS`** (डिफ़ॉल्ट 30) retention job में शामिल होता है। access log
  की तरह, इन rows में व्यक्तिगत डेटा होता है।

### Pollar poll रूट अब पूरा हुआ लॉगिन खुद पहचान लेता है

`GET /v1/pollar/oauth/sessions/{state}` पहले bridge callback का इंतज़ार करता था, जिसे
Pollar कभी कॉल नहीं करता, इसलिए poll-flow लॉगिन expire होने तक `pending` रहते थे। poll
अब Pollar से जाँचता है और `READY` पर handshake को आगे बढ़ा देता है। API के आकार या client
में किसी बदलाव की ज़रूरत नहीं। deploy के समय:

- **Migration `20260906120000_pollar_oauth_provider_probe`** `pollar_oauth_session` में एक nullable
  `providerCheckedAt` जोड़ता है। कोई backfill नहीं।
- **Poll traffic अब Pollar तक पहुँचता है।** उस नेटवर्क की publishable key पर, हर
  in-flight लॉगिन के लिए हर दो सेकंड में एक provider request का budget रखें।

### Pollar लॉगिन अब दोनों नेटवर्क पर वॉलेट provision करते हैं

`POST /v1/pollar/oauth/token` में एक `network_wallets` array जुड़ा — प्रति
Stellar नेटवर्क एक entry, हर एक `ready`, `pending` या `failed`। यह बदलाव additive है।
deploy के समय:

- **Migration चलाएँ।** `20260905120000_pollar_user_wallet`
  `pollar_user_wallet` और `PollarWalletStatus` enum जोड़ता है। इसके बिना हर
  redemption एक विफल provisioning log करता है और counterpart वॉलेट
  अरिकॉर्डेड रहता है — लॉगिन खुद काम करता रहता है।
- **दोनों नेटवर्क की keys सेट करें।** `POLLAR_*_MAINNET` और `POLLAR_*_TESTNET`
  में से हर एक वैकल्पिक है, और जिस नेटवर्क की keys नहीं हैं वह हर लॉगिन पर `pending`
  वॉलेट के रूप में दिखता है। दूसरा pair सेट होते ही sweeper अपने अगले tick पर backlog
  provision कर देता है; वरना rows तब तक `pending` रहती हैं जब तक उनके प्रयास खत्म न हो
  जाएँ। दोनों ही स्थितियों में लॉगिन कभी विफल नहीं होते।

mainnet लॉगिन *दोनों* नेटवर्क पर reserve fund करता है। testnet लॉगिन केवल testnet fund करता
है — पहले वह mainnet भी fund करता था, जिसे ऊपर की security review fixes ने हटा दिया।

### `429` अब `rate_limited` रिपोर्ट करता है

`429` पहले `code: "provider_unavailable"` रिपोर्ट करता था। अब यह
`code: "rate_limited"` रिपोर्ट करता है (`ApiErrorCode.RateLimited`, प्रकाशित enum का
हिस्सा)। अगर आप throttling पर retry करते हैं तो इसी पर branch करें।

### बिना कॉन्फ़िगर किया BlindPay अब `misconfigured` रिपोर्ट करता है

BlindPay कॉन्फ़िगर न होने पर दो responses बदले हैं:

| Request | पहले | अब |
| ------- | ---- | -- |
| BlindPay को call करने वाला कोई रूट — `/v1/kyc`, `/v1/onramp` या `/v1/offramp` के अंतर्गत — जब `BLINDPAY_API_KEY` या `BLINDPAY_INSTANCE_ID` सेट नहीं है | `503` `provider_unavailable` | `503` `misconfigured` |
| `POST /v1/blindpay/webhooks` जब `BLINDPAY_WEBHOOK_SECRET` सेट नहीं है | `400` `validation_failed` | `503` `misconfigured` |

दोनों deployment के कॉन्फ़िगरेशन की गलतियाँ हैं, जिन्हें retry ठीक नहीं कर सकता। Svix
किसी भी non-2xx पर retry करता है, इसलिए webhook delivery नहीं बदलती। Pollar इसी स्थिति
में पहले से `misconfigured` लौटाता था।

### बदले हुए response shapes

`/v1` के अंतर्गत तीन प्रकाशित response shapes बदले (कोई `/v2` नहीं है), इसलिए deploy
करने से पहले integrators को बताएँ।

| Endpoint | पहले | अब | क्यों |
| -------- | --- | --- | --- |
| `GET /v1/webhooks` | साधारण array, चुपचाप 100 पर सीमित | `{ data, total, take, skip }` | नतीजे 100 पर सीमित थे और pagination के लिए कोई `total` नहीं था |
| `GET /v1/products` | साधारण array, पूरी टेबल | `{ data, total, take, skip }` | असीमित read |
| `GET /v1/webhooks/:id/deliveries` और redelivery response | `payload` शामिल था | `payload` हटाया गया | `RECEIVER_UPDATED` body एक पूरा KYC dossier है और ये रूट `kyc:read` पर नहीं, `webhooks:read` पर gated हैं |

response पर iterate करने वाले या `delivery.payload` पढ़ने वाले callers टूट जाएँगे: इसकी
बजाय `res.data` पढ़ें, और KYC विवरण `kyc:read` रखने वाली key के साथ KYC endpoints से लें।

`RECEIVER_UPDATED` / `PAYIN_*` / `PAYOUT_*` **webhook bodies** भी सिकुड़कर
पहचान और state तक सीमित हो गईं — Webhooks सेक्शन देखें।

### audit-hardening migration

यह दो फ़ाइलों के रूप में आता है जिन्हें क्रम से लागू करना होगा:

- `20260901120000_audit_hardening` — correctness का काम: एक नया कॉलम,
  `liquidity_pool_operation` पर duplicates हटाने वाला `DELETE`, दो `UNIQUE` indexes,
  दो नई टेबलें। DELETE और unique index एक ही transaction में `SHARE ROW EXCLUSIVE`
  lock के तहत चलते हैं, इसलिए उस टेबल पर लिखने वाले कुछ milliseconds तक block रहते हैं।
- `20260901120100_audit_hardening_indexes` — नौ additive indexes, जो
  `CONCURRENTLY` बनाए जाते हैं ताकि deploy `payment_intent`,
  `swap`, `webhook_delivery` या `request_log` पर writes को block **न** करे। किसी maintenance window की ज़रूरत नहीं।

ये अलग फ़ाइलें इसलिए हैं क्योंकि PostgreSQL transaction के अंदर
`CREATE INDEX CONCURRENTLY` की अनुमति नहीं देता, और पहली फ़ाइल को transaction चाहिए।

अगर दूसरी फ़ाइल बीच में विफल हो जाए, तो वह एक **invalid** index छोड़ सकती है जिसे
`IF NOT EXISTS` मौजूद मान लेता है। उसे खोजें, drop करें, और दोबारा चलाएँ:

```sql
SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE NOT i.indisvalid;
```

### `ADMIN_API_CREDENTIALS` हटा दिया गया — `/v1/admin` अब प्लेटफ़ॉर्म कंसोल का है

**variable delete करें।** इसे अब पढ़ा नहीं जाता, और developer
platform में इससे मेल खाने वाले `COSMOS_ADMIN_API_SECRET` / `COSMOS_ADMIN_API_SECRET_READ`
भी इसके साथ जाते हैं।

यह developer platform की अपनी role जाँच के ऊपर एक दूसरी admin जाँच थी, और जिन
deployments ने इसे छोड़ दिया, उन्हें कंसोल से cross-tenant reads पर
`401 admin_credentials_required` मिलता था। अब `/v1/admin` किसी request को तभी स्वीकार
करता है जब वह प्लेटफ़ॉर्म कंसोल से आई हो, जो request पर मौजूद दो चीज़ों से तय होता है:

1. `X-Gateway-Secret` `APISIX_GATEWAY_SECRET` से मेल खाता है — जिसे `ApisixGuard`
   बाकी हर रूट की तरह जाँचता है। यह केवल gateway और कंसोल backend के पास है।
2. `X-Cosmos-Internal` मौजूद है। APISIX इसे अपने proxy किए हर request से हटा देता है
   (`proxy-rewrite.headers.remove`), इसलिए API-key caller इसे साथ नहीं ला सकता;
   केवल gateway secret रखने वाले backend की सीधी कॉल ही ला सकती है।

बिंदु 2 इस सर्विस के पास रखे किसी secret पर नहीं, बल्कि developer-platform repo में
मौजूद gateway रूट configuration पर निर्भर है। बदले में, कंसोल ही वह अकेली जगह है जो तय
करती है कि platform admin कौन है, और audit rows काम करने वाले कंसोल account
(`cosmos_<userId>`) और उसकी platform role का नाम देती हैं, हर mutation **और** हर read पर।

caller के लिए इससे क्या बदलता है:

| पहले | अब |
| --- | --- |
| Bearer secret के बिना `401` `admin_credentials_required` | जो भी कंसोल कॉल नहीं है, उसके लिए `403` `admin_console_only` |
| mutation पर `read` credential के लिए `403` `admin_role_required` | हटा दिया गया — कंसोल पहले ही तय कर चुका है कि account कार्रवाई कर सकता है |
| audit row पर `actorId` / `actorRole` credential का नाम देते थे | वे कंसोल account और उसकी platform role का नाम देते हैं |

`/v1/admin` को सीधे कॉल करने के लिए (जैसे किसी ops script से), `X-Gateway-Secret`,
`X-Consumer-Username` और `X-Cosmos-Internal: 1` भेजें; audit row पर label लगाने के लिए
`X-Cosmos-Admin-Role: owner` जोड़ें। सर्विस को सार्वजनिक internet से दूर रखें।

### `APISIX_GATEWAY_SECRET` के लिए अब 32 अक्षर ज़रूरी हैं

इससे छोटे secret के साथ सर्विस boot होने से मना कर देती है। अब यह `/v1/admin` की भी
रक्षा करता है (ऊपर देखें)। `openssl rand -hex 32` से एक बनाएँ और उसी समय APISIX में
अपडेट करें।

### `v0.1.0`–`v0.1.5` की वे सुविधाएँ जिन्हें यह release बदल देती है

`v0.1.5` से upgrade करने वाला deployment नीचे दिया गया व्यवहार खो देता है। हर item
integrators को दिखता है, इसलिए upgrade की योजना इन्हें ध्यान में रखकर बनाएँ।

| `v0.1.5` में क्या था | अब |
| --------------- | --- |
| `POST /v1/webhooks/:id/rotate-secret` `graceSeconds` स्वीकार करता था और पुराने secret को `WEBHOOK_SECRET_GRACE_SECONDS` तक verify करता रहता था | secret सीधे बदल दिया जाता है; पिछला secret तुरंत verify होना बंद कर देता है। receiver का सहेजा गया secret rotate कॉल वाली उसी अवधि में अपडेट करें। |
| एक leased retry worker webhooks पहुँचाता था (`maxAttempts` / `nextAttemptAt` / `leaseUntil`, status `RETRYING`) | यह काम delivery sweeper करता है, `WEBHOOK_MAX_ATTEMPTS` फिर से प्रति in-process loop `3` पर (sweeps में असली सीमा 9)। `WEBHOOK_MAX_BACKOFF_MS`, `WEBHOOK_WORKER_*`, `WEBHOOK_LEASE_MS`, `WEBHOOK_FANOUT_CONCURRENCY` और `WEBHOOK_PAUSE_AFTER_FAILURES` हटा दिए गए हैं, और कोई delivery कभी `RETRYING` के रूप में नहीं लिखी जाती। |
| `SWAP_EXPIRED` और `LIQUIDITY_EXPIRED` भेजे जाते थे | दोनों में से कोई नहीं भेजा जाता। expiry अब भी row पर दर्ज होती है; उसे poll करें, या `*_FAILED` events को subscribe करें। |
| `GET /v1/products` `kind`, `active` और `reference` पर filter करता था, और `DELETE` `hard=true` लेता था | दोनों में से कुछ भी मौजूद नहीं। Deletes soft हैं (`active=false`)। |
| `GET /v1/products` और `GET /v1/customers` का डिफ़ॉल्ट `take=20` था | दोनों का डिफ़ॉल्ट `take=100` है (जो अब भी अधिकतम है), इसलिए बिना parameters वाली कॉल पहले से ज़्यादा rows लौटाती है। |
| `analytics.apiLogs` / `analytics.webhookLogs` `{ data, total }` लौटाते थे और केवल `take` मानते थे | दोनों बाकी हर सूची की तरह paginated हैं: अंदर `take` + `skip`, बाहर `{ data, total, take, skip, hasMore }`। overview के date-range filters हटा दिए गए हैं। |
| `/v1/health` database के साथ Stellar readiness indicator भी रिपोर्ट करता था | यह केवल database रिपोर्ट करता है। |
| `STELLAR_HTTP_TIMEOUT_MS`, `STELLAR_MAX_ATTEMPTS`, `STELLAR_RETRY_BASE_MS` Horizon कॉल को सीमित करते थे | Horizon की सीमाएँ `stellar/stellar.constants.ts` में रहती हैं और environment से कॉन्फ़िगर नहीं की जा सकतीं। वे तीनों variables अब न पढ़े जाते हैं न validate किए जाते हैं। |

**database से कुछ भी drop नहीं किया गया।** उन सुविधाओं द्वारा जोड़े गए कॉलम, indexes और enum values
(`webhook_delivery.maxAttempts` / `nextAttemptAt` /
`leaseUntil`, `webhook_endpoint.previousSecret*`, `swap` और
`liquidity_pool_operation` के `lastCheckedAt` / `notFoundStreak`,
`horizon_account_cursor` टेबल, `RETRYING`, `SWAP_EXPIRED`, `LIQUIDITY_EXPIRED`)
अब भी `schema.prisma` में declared हैं और `migrate deploy` के बाद भी मौजूद हैं; बस उनमें
अब लिखा नहीं जाता। उन्हें हटाने के लिए एक विनाशकारी migration चाहिए होगा (PostgreSQL
type दोबारा बनाए बिना enum value drop नहीं कर सकता)।

## एनवायरनमेंट वेरिएबल

`src/` में `process.env` से पढ़ा जाने वाला हर variable boot पर
`src/config/env.validation.ts` द्वारा validate किया जाता है (fail-fast)। `.env.example` कॉपी करें और
कम से कम `DATABASE_URL` और `APISIX_GATEWAY_SECRET` बदलें।

| Variable | ज़रूरी | डिफ़ॉल्ट | प्रभाव |
| -------- | -------- | ------- | ------ |
| `NODE_ENV` | नहीं | `development` | `development`, `test`, या `production` होना चाहिए। **production में `production` सेट करें** — fail-closed plan-fee जाँच और डिफ़ॉल्ट रूप से बंद docs, दोनों इसी पर निर्भर हैं |
| `PORT` | नहीं | `3000` | HTTP listen port |
| `DATABASE_URL` | **हाँ** | — | Prisma के लिए PostgreSQL connection |
| `APISIX_GATEWAY_SECRET` | **हाँ** | — | साझा secret जो साबित करता है कि request APISIX से होकर आई। **न्यूनतम 32 अक्षर**; कोई placeholder boot पर अस्वीकार कर दिया जाता है |
| `APISIX_GATEWAY_SECRET_HEADER` | नहीं | `x-gateway-secret` | gateway secret वाले header का नाम |
| `APISIX_CONSUMER_HEADER` | नहीं | `x-consumer-username` | authenticated consumer का username |
| `APISIX_CREDENTIAL_HEADER` | नहीं | `x-credential-identifier` | key-auth से मिला credential id |
| `APISIX_ENVIRONMENT_HEADER` | नहीं | `x-consumer-env` | key का environment (`dev` / `prod`) |
| `APISIX_ROLE_HEADER` | नहीं | `x-consumer-role` | gateway द्वारा forward की गई consumer role |
| `APISIX_PERMISSIONS_HEADER` | नहीं | `x-consumer-permissions` | gateway द्वारा forward की गई permissions की सूची |
| `APISIX_ORGANIZATION_HEADER` | नहीं | `x-consumer-org` | संगठन id |
| `APISIX_PLAN_HEADER` | नहीं | `x-consumer-plan` | संगठन का plan |
| `APISIX_SWAP_FEE_BPS_HEADER` | नहीं | `x-plan-swap-fee-bps` | plan की swap fee (bps) |
| `APISIX_EMAIL_HEADER` | नहीं | `x-consumer-email` | key के account का verified email। Pollar bridge लॉगिन का session केवल उसी account को लौटाता है, और बिना email वाली key को मना करता है |
| `APISIX_PUBLIC_CONSUMER` | नहीं | — | साझा public consumer का username (ऊपर देखें)। जहाँ भी public key प्रकाशित हो, इसे सेट करें |
| `STELLAR_NETWORK` | नहीं | `testnet` | fallback Stellar नेटवर्क (`public` / `testnet`) |
| `STELLAR_HORIZON_URL_PUBLIC` | नहीं | `https://horizon.stellar.org` | Mainnet Horizon का base URL |
| `STELLAR_HORIZON_URL_TESTNET` | नहीं | `https://horizon-testnet.stellar.org` | Testnet Horizon का base URL |
| `STELLAR_BASE_FEE` | नहीं | `100` | tx builds के लिए Stellar base fee (stroops) |
| `STELLAR_TX_TIMEOUT` | नहीं | `300` | ट्रांज़ैक्शन timeout (सेकंड) |
| `STELLAR_SWAP_FEE_WALLET` | जब fee > 0 हो | — | swap fees के लिए प्लेटफ़ॉर्म का G... account |
| `STELLAR_SWAP_FEE_BPS` | नहीं | `50` | basis points में swap fee |
| `STELLAR_SWAP_SLIPPAGE_BPS` | नहीं | `50` | swap slippage की डिफ़ॉल्ट सहनशीलता (bps) |
| `STELLAR_SWAP_MAX_SLIPPAGE_BPS` | नहीं | `500` | caller के slippage की सख्त ऊपरी सीमा (bps) |
| `STELLAR_SWAP_SINGLE_INFLIGHT` | नहीं | `false` | `true` होने पर, उसी source के लिए non-expired PENDING swap पहले से हो तो 409 |
| `OBSERVER_ENABLED` | नहीं | `true` | `true` / `false` — on-chain reconciler |
| `OBSERVER_INTERVAL_MS` | नहीं | `15000` | Observer poll interval (ms, न्यूनतम 1000) |
| `OBSERVER_BATCH_SIZE` | नहीं | `50` | प्रति observer tick अधिकतम intents/swaps |
| `PAYMENT_INTENT_TTL_SECONDS` | नहीं | `3600` | `EXPIRED` होने से पहले बिना भुगतान वाले intent की आयु |
| `WEBHOOK_TIMEOUT_MS` | नहीं | `5000` | पुराना webhook timeout fallback (ms) |
| `WEBHOOK_CONNECT_TIMEOUT_MS` | नहीं | `3000` | outbound webhook का connect budget (ms) |
| `WEBHOOK_READ_TIMEOUT_MS` | नहीं | `5000` | outbound webhook का read budget (ms) |
| `WEBHOOK_MAX_RESPONSE_BYTES` | नहीं | `65536` | पढ़ी जाने वाली webhook response body का अधिकतम आकार |
| `WEBHOOK_MAX_ATTEMPTS` | नहीं | `3` | delivery retry की संख्या |
| `WEBHOOK_BACKOFF_MS` | नहीं | `2000` | retries के बीच linear backoff (ms) |
| `WEBHOOK_SIGNATURE_HEADER` | नहीं | `x-cosmos-signature` | integrators को भेजा जाने वाला HMAC header |
| `WEBHOOK_SWEEP_ENABLED` | नहीं | `true` | crash से अटकी deliveries को recover करना। incident switch |
| `WEBHOOK_SWEEP_INTERVAL_MS` | नहीं | `60000` | Sweeper interval (ms, न्यूनतम 1000) |
| `WEBHOOK_PAYLOAD_RETENTION_DAYS` | नहीं | `30` | settle हुई delivery body को redact करने से पहले रखने के दिन। `0` उसे हमेशा रखता है |
| `REQUEST_LOG_RETENTION_DAYS` | नहीं | `30` | `request_log` rows (payer IP / user-agent) रखने के दिन। `0` prune बंद करता है |
| `ACTIVITY_RETENTION_DAYS` | नहीं | `30` | `activity_event` rows (client IP / user-agent / `props`) रखने के दिन। उसी job द्वारा prune। `0` events को हमेशा रखता है |
| `REQUEST_LOG_PRUNE_INTERVAL_MS` | नहीं | `3600000` | Retention timer interval (ms) |
| `REQUEST_LOG_PRUNE_BATCH_SIZE` | नहीं | `1000` | प्रति delete batch rows (हर lock को छोटा रखता है) |
| `REQUEST_LOG_PRUNE_MAX_PER_CYCLE` | नहीं | `50000` | प्रति tick जाँची जाने वाली rows की सख्त सीमा |
| `SWAGGER_ENABLED` | नहीं | `production` में बंद | `/docs` प्रकाशित करना (Express middleware, कोई guards नहीं) |
| `OPENAPI_SERVER_URL` | नहीं | — | export किए गए OpenAPI में डाला जाने वाला gateway host |
| `BLINDPAY_API_KEY` | नहीं | — | BlindPay production instance की API key, `prod` keys के लिए |
| `BLINDPAY_INSTANCE_ID` | जब API key सेट हो | — | BlindPay instance id (`in_...`) |
| `BLINDPAY_BASE_URL` | नहीं | `https://api.blindpay.com/v1` | BlindPay API का base URL |
| `BLINDPAY_WEBHOOK_SECRET` | जब API key सेट हो | — | आने वाले BlindPay webhooks के लिए Svix secret: पूरा `whsec_…` value, जिसकी key कम से कम 24 bytes में decode होनी चाहिए (boot पर जाँचा जाता है) |
| `BLINDPAY_API_KEY_DEV` | नहीं | — | BlindPay development instance की API key, `dev` keys के लिए। सेट न होने पर BlindPay routes `dev` keys को `503 misconfigured` लौटाते हैं |
| `BLINDPAY_INSTANCE_ID_DEV` | जब dev API key सेट हो | — | development instance id (`in_...`) |
| `BLINDPAY_WEBHOOK_SECRET_DEV` | जब dev API key सेट हो | — | development instance के webhook endpoint का Svix secret; `BLINDPAY_WEBHOOK_SECRET` जैसे ही नियम |
| `BLINDPAY_TIMEOUT_MS` | नहीं | `15000` | BlindPay HTTP client timeout (ms) |
| `KYC_REDIRECT_URL_WHITELIST` | नहीं | — | प्रति consumer KYC redirect hosts की allow-list |
| `RATE_LIMIT_ENABLED` | नहीं | `true` | XLM खर्च करने वाले रूट्स पर प्रति पता सीमाएँ। incident switch |
| `RATE_LIMIT_PRUNE_INTERVAL_MS` | नहीं | `600000` | counter-window prune interval (ms, न्यूनतम 1000) |
| `POLLAR_PUBLISHABLE_KEY_TESTNET` / `_MAINNET` | नहीं | — | OAuth bridge के लिए Pollar publishable key (`pub_<network>_…`) |
| `POLLAR_SECRET_KEY_TESTNET` / `_MAINNET` | publishable key के साथ | — | operator रूट्स के लिए Pollar secret key (`sec_<network>_…`) |
| `POLLAR_BRIDGE_CALLBACK_URL` | जब Pollar key सेट हो | — | सार्वजनिक URL जिस पर Pollar browser को लौटाता है। `<gateway>/v1/pollar/oauth/callback` होना चाहिए, **https** (सादा `http` केवल loopback host पर — वरना boot विफल होता है: authorization code उसकी query string में जाता है) **और** Pollar के Build → Domains में रजिस्टर किया गया host |
| `POLLAR_REDIRECT_URI_WHITELIST` | नहीं | — | प्रति consumer वॉलेट redirect URIs की allow-list। खाली ⇒ वह consumer केवल poll flow उपयोग कर सकता है |
| `POLLAR_SDK_ORIGIN` | नहीं | `POLLAR_BRIDGE_CALLBACK_URL` का origin | Pollar के SDK API को भेजा जाने वाला `Origin`, जिसे वह Build → Domains से मिलाता है। केवल तब सेट करें जब callback host और रजिस्टर किया गया host अलग हों |
| `POLLAR_SDK_BASE_URL` | नहीं | `https://sdk.api.pollar.xyz` | Pollar SDK API का base URL |
| `POLLAR_SERVER_BASE_URL` | नहीं | `https://api.pollar.xyz` | Pollar Server API का base URL |
| `POLLAR_TIMEOUT_MS` | नहीं | `15000` | Pollar HTTP client timeout (ms) |
| `POLLAR_AUTHORIZATION_TTL_MS` | नहीं | `300000` | लॉगिन handshake कितनी देर खुला रहता है |
| `POLLAR_CODE_TTL_MS` | नहीं | `120000` | बनाया गया bridge code कितनी देर redeem करने योग्य रहता है |
| `POLLAR_LOGIN_WAIT_MS` | नहीं | `20000` | redemption Pollar के वॉलेट provision करने का कितनी देर इंतज़ार करता है |
| `POLLAR_SWEEP_ENABLED` | नहीं | `true` | जिन handshakes को किसी ने पूरा नहीं किया उन्हें expire करना, और किसी लॉगिन द्वारा `pending` छोड़े गए cross-network वॉलेट को दोबारा आज़माना |
| `POLLAR_SWEEP_INTERVAL_MS` | नहीं | `60000` | Handshake sweeper interval (ms, न्यूनतम 1000) |

पुराना `STELLAR_HORIZON_URL` boot पर अस्वीकार कर दिया जाता है — इसके बजाय
`STELLAR_HORIZON_URL_PUBLIC` / `STELLAR_HORIZON_URL_TESTNET` का उपयोग करें।

## शुरुआत करें

```bash
cp .env.example .env          # set DATABASE_URL and a strong APISIX_GATEWAY_SECRET
npm install
npm run db:generate           # prisma generate
npm run db:migrate            # create the schema (needs a running Postgres)
npm run start:dev
```

एक secret बनाएँ:

```bash
openssl rand -hex 32
```

वही जाँचें चलाएँ जो CI चलाता है (database की ज़रूरत नहीं — Prisma mock किया गया है):

```bash
npm run lint
npm test                 # unit suites (src/**/*.spec.ts)
npm run test:e2e         # e2e suites (test/*.e2e-spec.ts)
npm run openapi:check    # the committed contract matches the controllers
npm run readme:check     # the seven READMEs match in structure and list every route
```

## APISIX रूट कॉन्फ़िगरेशन

dev platform का route helper (`paydev/src/utils/apisix.ts`) पहले से ही
`Authorization: Bearer <token>` को `apikey` header में बदलता है, `key-auth` validate करता है,
और proxy करने से पहले credentials हटा देता है। किसी रूट को इस सर्विस की ओर मोड़ने के लिए,
`proxy-rewrite` plugin में **gateway secret injection** जोड़ें ताकि header
यहाँ पहुँचे — और client की भेजी हर कॉपी हटा दें:

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

सफल auth के बाद `key-auth` `X-Consumer-Username` / `X-Credential-Identifier` को
upstream तक forward करता है, client की भेजी हर कॉपी को overwrite करते हुए, और
guard इसी पर निर्भर है।

> **remove सूची एक security control है, और इसे इस repository से verify नहीं किया जा
> सकता।** यह सर्विस इसमें दिए हर header को जैसा है वैसा ही मान लेती है;
> `X-Gateway-Secret` केवल यह साबित करता है कि request किसी gateway से होकर आई, यह नहीं
> कि वे मान ईमानदार हैं। जब भी कोई रूट जोड़ा या कॉपी किया जाए, इस सूची का review करें —
> जो रूट `X-Cosmos-Internal` नहीं हटाता, वह हर API key को `/v1/admin` तक पहुँच दे देता है।
> सर्विस को private network पर रखें ताकि अंदर आने का एकमात्र रास्ता APISIX हो; साझा
> secret दूसरी परत है, अकेली परत नहीं।
>
> production में `X-Plan-Swap-Fee-Bps` न होने पर environment default पर लौटने की बजाय
> `503` लौटता है।
