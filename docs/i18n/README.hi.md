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

एक surface इन्हीं दो शर्तों से कुछ और भी निकालता है। `/v1/admin` cross-tenant है, और
`AdminGuard` वहाँ किसी request को तभी आने देता है जब उसमें
`X-Cosmos-Internal` भी हो — एक ऐसा header जिसे APISIX अपने proxy किए हर request से **हटा** देता है, इसलिए
केवल gateway secret रखने वाले backend की सीधी कॉल ही इसे भेज सकती है। वह
backend developer platform है, जो पहले ही तय कर चुका है कि
signed-in account owner/admin है या नहीं। deploy करने के लिए कोई अलग admin credential
नहीं है (`ADMIN_API_CREDENTIALS` पर upgrade नोट देखें), जिससे gateway
secret और network isolation ही cross-tenant डेटा के सामने की पूरी सुरक्षा-सीमा बन जाते हैं —
और gateway रूट की strip list सिर्फ़ साफ़-सफ़ाई का मामला नहीं, बल्कि सुरक्षा के लिए अहम बन जाती है।

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
                                  payment intents, KYC, webhooks, Pollar
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
Paths OpenAPI के `{param}` रूप में लिखे गए हैं, और जब contract का कोई रूट इस टेबल से
गायब हो तो `npm run readme:check` CI को fail कर देता है।

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

envelope और पूरा `code` enum OpenAPI spec में
`ApiErrorBodyEntity` के रूप में प्रकाशित है, जो हर operation से जुड़ा है — इसलिए जनरेट किए गए client को
एरर का type भी मिल जाता है, और codes जानने के लिए आपको यह repo पढ़ने की ज़रूरत नहीं पड़ती।
सत्य का स्रोत `src/common/errors/api-error.ts` में मौजूद `ApiErrorCode` है।
**एक बार प्रकाशित होने के बाद codes का नाम कभी नहीं बदला जाता**; नए codes जोड़े जा सकते हैं, इसलिए किसी
अनजान code को उसके HTTP status के रूप में ही समझें।

कुछ codes जिनमें आसानी से भ्रम हो जाता है:

| Code | Status | अर्थ |
| ---- | ------ | ----- |
| `insufficient_scope` | 403 | API key के पास वह scope नहीं है। key को दोबारा provision करें |
| `account_disabled` | 403 | किसी operator ने यह fiat खाता बंद कर दिया है। यह key की समस्या नहीं है |
| `gateway_required` | 403 | request APISIX से होकर नहीं आई |
| `admin_console_only` | 403 | यह रूट प्लेटफ़ॉर्म कंसोल का है (`/v1/admin`, alias recovery शुरू करना)। कोई भी API key इसे कॉल नहीं कर सकती |
| `idempotency_conflict` | 409 | यह `Idempotency-Key` (या payment-intent memo) किसी *दूसरी* request के लिए पहले ही एक resource बना चुकी है। मूल request दोहराएँ, या नई key का उपयोग करें |
| `kyc_state_invalid` | 409 | KYC state का अवैध transition — यह duplicate request नहीं है |
| `operation_in_flight` | 409 | एक टकराने वाला operation अभी भी settle हो रहा है |
| `payload_expired` | 409 | delivery body retention अवधि पार कर चुकी है और दोबारा नहीं भेजी जा सकती |
| `provider_unavailable` | 503/504 | BlindPay या Horizon तक पहुँचा नहीं जा सकता। दोबारा कोशिश करें |
| `misconfigured` | 503 | सर्वर-साइड कॉन्फ़िगरेशन की गलती। दोबारा कोशिश करने से कोई फ़ायदा नहीं होगा |

हर intent **persist** किया जाता है (`payment_intent` टेबल) और authenticated APISIX
consumer तक सीमित रहता है, इसलिए reads/updates/deletes केवल उसी
consumer के अपने रिकॉर्ड को छूते हैं — हर intent के lifecycle की पूरी traceability
(`PENDING → SUBMITTED → SUCCEEDED/FAILED/CANCELLED/EXPIRED`)।

### एक से अधिक replica चलाना

APISIX कई instances के बीच load-balance करता है, इसलिए इस सर्विस का हर `setInterval`
प्रति replica एक बार चलता है। correctness कभी समस्या नहीं थी — status का हर बदलाव
एक guarded `updateMany` compare-and-swap से होकर जाता है, इसलिए केवल एक writer जीतता है —
लेकिन तीन replicas का मतलब था rate-limit करने वाली API के सामने एक जैसे काम के लिए
तीन गुना Horizon round-trips, और replicas का एक ही
`request_log` tuples को delete करने की होड़ में लगना।

अब हर background timer एक PostgreSQL **transaction-level advisory lock**
(`AdvisoryLockService`, `src/common/services/advisory-lock.service.ts`) लेता है और
जब कोई दूसरा replica उसे पकड़े हो तो अपना tick छोड़ देता है:

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

session-level variant की बजाय `pg_try_advisory_xact_lock` का उपयोग तीन कारणों से
किया जाता है: यह कभी block नहीं करता (हारने वाला replica बस छोड़ देता है, जो
poller को चाहिए), transaction खत्म होते ही यह release हो जाता है — crash या
टूटे हुए connection पर भी, इसलिए मारा गया pod lock को अटका नहीं सकता — और इसी वजह से
यह transaction-pooling mode में PgBouncer के पीछे भी सही रहता है, जहाँ session-level
locks असुरक्षित हैं क्योंकि connections sticky नहीं होते।

Lock ids `AdvisoryLockKey` enum में रहते हैं और वे task की पहचान हैं:
किसी member को नए नंबर के साथ rename करने से exclusion चुपचाप बंद हो जाता है, इसलिए
रिटायर किए गए नंबर कभी दोबारा इस्तेमाल नहीं किए जाते।

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
  status को नहीं बदलता, ताकि सही tx अब भी submit किया जा सके; वरना
  नेटवर्क के किसी भी विफल ट्रांज़ैक्शन का hash किसी intent को हमेशा के लिए fail कर देता।
- **स्वचालित (स्थायी observer):** `StellarObserverService` हर
  `OBSERVER_INTERVAL_MS` पर `PENDING` intents के लिए Horizon को poll करता है — रिपोर्ट किए गए `txHash` से, या
  destination पर आए पेमेंट scan करके — और मेल खाने वालों को उसी तरह finalize करता है, इसलिए
  status बदलते हैं और events **बिना किसी के API कॉल किए** भेजे जाते हैं। एक tick
  प्रति consumer अधिकतम `OBSERVER_MAX_INTENTS_PER_CONSUMER` (10) intents लेता है और
  expired intent को कभी scan नहीं करता, इसलिए किसी एक consumer की बाढ़ — साझा public key
  सहित — बाकी सबके settlement को भूखा नहीं रख सकती। local dev के लिए
  `OBSERVER_ENABLED=false` से बंद करें।

### API request logs का retention

`/v1/health` और `/docs` को छोड़कर हर आने वाली request `LoggingInterceptor` द्वारा
`request_log` में जोड़ी जाती है, और यही डैशबोर्ड के **API logs**
view (`GET /v1/logs`) को चलाती है। rows में path, status, duration, और — जब मौजूद हों —
payer का `ip` / `userAgent` शामिल होते हैं।

डैशबोर्ड का traffic (`X-Cosmos-Internal`) छोड़ा नहीं जाता, बल्कि **रिकॉर्ड और चिह्नित** किया जाता है
(`request_log.internal`), और API-log view उसी
कॉलम पर filter करता है। पहले के एक version में इस header पर जल्दी return हो जाता था, जिसका अर्थ था कि जो भी
इसे सेट कर सकता था, वह अपनी requests को audit log से पूरी तरह बाहर रख लेता था — कोई request header
कभी भी traffic को अदृश्य नहीं बना पाना चाहिए।

ये rows **हमेशा के लिए नहीं रखी जातीं**। `RequestLogRetentionService` एक timer पर
`REQUEST_LOG_RETENTION_DAYS` (डिफ़ॉल्ट **30**) से पुरानी rows delete करता है
(`REQUEST_LOG_PRUNE_INTERVAL_MS`, डिफ़ॉल्ट **1h**)। हर cycle छोटे
`REQUEST_LOG_PRUNE_BATCH_SIZE` हिस्सों (डिफ़ॉल्ट **1000**) में delete करता है और तब तक loop करता रहता है जब तक
backlog खत्म न हो जाए या `REQUEST_LOG_PRUNE_MAX_PER_CYCLE` (डिफ़ॉल्ट **50000**) तक न
पहुँच जाए, ताकि बड़ा इतिहास भी एक लंबा table lock पकड़े बिना बराबरी पर आ सके। prune को पूरी तरह
बंद करने के लिए `REQUEST_LOG_RETENTION_DAYS=0` सेट करें (सर्विस boot पर इसे
log करती है)। `(consumer, createdAt)` पर composite index डेटा बढ़ने पर भी
डैशबोर्ड query को तेज़ रखता है।

### क्लाइंट एक्टिविटी (वॉलेट और डैशबोर्ड क्या रिपोर्ट करते हैं)

`request_log` वह रिकॉर्ड करता है जो इस सर्विस तक पहुँचा। वह यह रिकॉर्ड नहीं कर सकता कि किसी client
ने *क्या किया*: send स्क्रीन पर crash हुआ वॉलेट, user द्वारा रद्द किया गया signature,
डैशबोर्ड का कोई पेज जो browser से कोई request निकलने से पहले ही throw कर गया। इनमें से कोई भी
यहाँ HTTP कॉल पैदा नहीं करता, और कुछ गलत होने पर ठीक यही events काम के होते हैं
— इसलिए clients अपने events खुद `POST
/v1/activity/events` पर रिपोर्ट करते हैं।

- **हर event के लिए एक कॉल नहीं, एक batch।** Clients queue करके flush करते हैं, इसलिए offline
  वॉलेट अपने events रखे रहता है और अगली बार खुलने पर उन्हें भेज देता है। प्रति request अधिकतम
  `ACTIVITY_MAX_BATCH` (100), जो एक ही statement में लिखे जाते हैं।
- **flush दोबारा करना सुरक्षित है।** किसी event में client का अपना `eventId` हो सकता है;
  `(consumerId, eventId)` unique है और insert duplicates को छोड़ देता है, इसलिए ऐसा batch
  जो लिखा जा चुका था लेकिन जिसकी acknowledgement कभी नहीं पहुँची, हर row को दोगुना किए बिना
  दोबारा भेजा जा सकता है। response `accepted` और `duplicates` रिपोर्ट करता है।
- **Attribution gateway का होता है, body का कभी नहीं।** rows उसी consumer के नाम पर
  लिखी जाती हैं जिसे APISIX ने authenticate किया। कोई client किसी दूसरे account के नाम पर
  events दर्ज नहीं कर सकता, और ऐसा कोई field ही नहीं है जिससे वह कोशिश भी कर सके।
- **payload की बनावट के कारण ingest विफल नहीं होता।** बहुत लंबा `message`
  काट दिया जाता है और बहुत बड़ा `props` `{"_dropped":
  "props_too_large"}` से बदल दिया जाता है; 400 लौटाने पर पूरा batch खो जाता, और batch सबसे
  ज़्यादा तब मायने रखता है जब client ऐसी स्थिति में हो जिसकी किसी ने कल्पना नहीं की थी।
- **डिवाइस की गलत घड़ी feed का क्रम नहीं बिगाड़ सकती।** जब `occurredAt` पाँच मिनट से
  ज़्यादा आगे या सात दिन से ज़्यादा पीछे हो, तो उसे प्राप्ति के समय पर clamp कर दिया जाता है, इसलिए
  एक घंटा आगे चल रहा फ़ोन अपने events को newest-first सूची में सबसे ऊपर
  नहीं टिका सकता। दोनों समय रखे जाते हैं: `at` (client का) और `receivedAt`।

इसे वापस पढ़ना:

| रूट                     | Scope             | क्या लौटाता है                                                       |
| ----------------------- | ----------------- | -------------------------------------------------------------------- |
| `GET /v1/activity/events` | `activity:read` | feed, सबसे नया पहले। Filters: `source`, `level`, `category`, `type` (prefix), `network`, `since`/`until` |
| `GET /v1/activity/summary` | `activity:read` | level/source/category के अनुसार गिनती, शीर्ष event types, शीर्ष errors, sessions, devices, एक दैनिक series |

feed पर `level` एक **न्यूनतम सीमा** है, सटीक मिलान नहीं: `level=warn`
warnings *और* errors दोनों लौटाता है। ऐसा filter जो केवल वही rows लौटाए जिन्हें किसी ने
`error` लेबल किया हो, उन warnings को छिपा देता जो उन errors तक ले गईं।

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

**BlindPay से आई body में क्या होता है।** `RECEIVER_UPDATED` / `PAYIN_*` /
`PAYOUT_*` में केवल पहचान और state होती है — ids, status, राशियाँ, rails — कभी भी
व्यक्तिगत डेटा नहीं। provider का object ज्यों का त्यों आगे *नहीं* भेजा जाता: receiver का
payload एक पूरा KYC dossier होता है (tax id, जन्मतिथि, पता, दस्तावेज़ों के links)
और किसी event को subscribe करने के लिए केवल `webhooks:write` चाहिए, जिससे
webhook उस dossier को किसी भी host तक पहुँचाने का ज़रिया बन जाता। विवरण
API से ऐसी key के साथ लें जिसके पास `kyc:read` / `onramp:read` / `offramp:read` हो। सटीक field allowlist के लिए
`src/blindpay/blindpay-event-redaction.ts` देखें।

Delivery NestJS `EventEmitter2` (`webhook.event`) के ज़रिए अलग की गई है, इसलिए
notification भेजना उस API request को कभी block नहीं करता जिसने उसे trigger किया।

**Outbound destination policy (SSRF):** endpoints को `https` का उपयोग करना होगा और वे
केवल public addresses पर resolve होने चाहिए। रजिस्ट्रेशन loopback, RFC1918 private ranges,
link-local (`169.254.0.0/16`, जिसमें cloud metadata `169.254.169.254` शामिल है), और
ज्ञात metadata hostnames को अस्वीकार करता है। यही जाँच हर
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

**प्रयासों की असली सीमा 3 नहीं, 9 है।** `WEBHOOK_MAX_ATTEMPTS` एक
in-process retry loop को सीमित करता है। इसके बाद sweeper उन deliveries को उठाता है जो अभी भी
कुल `WEBHOOK_MAX_ATTEMPTS × 3` प्रयासों के भीतर हैं, इसलिए किसी delivery के लिए
घंटों में फैले नौ प्रयास तक हो सकते हैं। यह जानबूझकर है — backoff के बीच मारा गया pod
पहले एक PENDING delivery को हमेशा के लिए अटका देता था, यानी एक settle हुआ पेमेंट जिसकी
सूचना किसी को नहीं गई।

**Redelivery retention window के भीतर best-effort है।**
`WEBHOOK_PAYLOAD_RETENTION_DAYS` के बाद सहेजी गई body साफ़ कर दी जाती है (एक
`RECEIVER_UPDATED` body KYC dossier होती है, और delivery log रखा जाता है)।
sweeper उन rows को छोड़ देता है और `POST /v1/webhooks/:id/deliveries/:id/redeliver`
किसी असली event type और वैध signature के साथ redacted body भेजने की बजाय
`409 payload_expired` लौटाता है।

**Receiver contract।** कोई भी `2xx` acknowledgement माना जाता है।
`WEBHOOK_READ_TIMEOUT_MS` (डिफ़ॉल्ट 5s) के भीतर जवाब दें। क्रम की कोई गारंटी नहीं है, इसलिए
events को एक set की तरह लें और API से मिलान करें। event `id` पर deduplicate करें
— ध्यान दें कि redelivery मूल `id` को ही दोबारा इस्तेमाल करती है, इसलिए सख्ती से dedupe करने वाला
receiver उसे अनदेखा कर देगा; यही सोचा-समझा समझौता है (at-least-once delivery,
exactly-once effect)।

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

### OpenAPI / Swagger

**सुरक्षा नोट:** `GET /docs`, `/docs/json`, और `/docs/yaml` को
`SwaggerModule.setup` Nest controllers के रूप में नहीं, बल्कि **Express middleware** के रूप में mount करता है। ये
`ApisixGuard` या `PermissionsGuard` से होकर **नहीं** गुज़रते — जो भी
सर्विस के port तक पहुँच सकता है, वह पूरी API spec ले सकता है, जब तक docs बंद न हों।
production में docs **डिफ़ॉल्ट रूप से बंद** हैं (`NODE_ENV=production` और कोई
`SWAGGER_ENABLED` नहीं)। `SWAGGER_ENABLED=true` केवल तभी सेट करें जब आप जानबूझकर
किसी भरोसेमंद नेटवर्क पर spec प्रकाशित करना चाहते हों।

Live docs (जब enabled हों):

- `GET /docs` — Swagger UI
- `GET /docs/json` — OpenAPI 3.0 spec (JSON)
- `GET /docs/yaml` — OpenAPI 3.0 spec (YAML)

spec को फ़ाइलों में export करें (ताकि कोई दूसरा सर्वर उसे host/consume कर सके) — कोई database
connection या असली gateway secret ज़रूरी नहीं है; जब वे environment variables मौजूद न हों तो यह
local placeholders के साथ Nest preview mode में चलता है:

```bash
npm run openapi:generate
# writes openapi/openapi.json and openapi/openapi.yaml
```

CI और release gate commit की गई दोनों फ़ाइलों को दोबारा जनरेट करते हैं और कोई भी अंतर अस्वीकार करते हैं। किसी
controller या DTO बदलाव को commit करने से पहले यही जाँच चलाएँ:

```bash
npm run openapi:check
```

spec के paths में version पहले से शामिल है (`/v1/...`)। spec के `servers` में
कोई ठोस gateway host डालने के लिए, generate करने से पहले `OPENAPI_SERVER_URL`
सेट करें:

```bash
OPENAPI_SERVER_URL=https://gateway.example.com npm run openapi:generate
```

Swagger config (`src/swagger.ts`) चल रहे सर्वर और
generator दोनों साझा करते हैं, इसलिए दोनों तालमेल में रहते हैं। दोनों APISIX headers (`X-Gateway-Secret`,
`X-Consumer-Username`) spec में security schemes के रूप में दर्ज हैं।

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
कॉल (build, वैलिडेशन, observer) उसी को target करती हैं।

**memo एक अनिवार्य `MEMO_ID` है** — यह on-chain पेमेंट की पहचान करता है और
intent को **idempotency** देता है: `(consumer, memo)` unique है, इसलिए उसी memo
**और उन्हीं शर्तों** के साथ दोबारा बनाने पर मूल intent लौटता है। वही
memo किसी भी अलग शर्त के साथ — kind, network, destination, amount, asset, `msg`,
`callback`, या `tx` के लिए `source` — `409 idempotency_conflict` है, और error
सहेजे गए intent के बारे में कुछ नहीं बताता। यह तुलना साझा public key की वजह से
मौजूद है: हर anonymous वॉलेट एक ही consumer है, इसलिए इसके बिना, किसी और के पहले इस्तेमाल किए
memo से आपको *उनका* intent मिल जाता, एक ऐसे QR के साथ जो उन्हें भुगतान करता। अगर
आप `memo` नहीं देते, तो एक random uint64 जनरेट किया जाता है।

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

हर endpoint OpenAPI spec में उदाहरण payloads के साथ एक typed response
दर्ज करता है (`TxPaymentIntentEntity`,
`PayPaymentIntentEntity`, `ValidationOutcomeEntity`), इसलिए Swagger खाली body नहीं, बल्कि एक ठोस
नमूना response दिखाता है।

Response:

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

वॉलेट open source है और एक ऐसी API key के साथ आता है जो सबके पास है, ताकि कोई भी व्यक्ति
रजिस्टर किए बिना swap कर सके, liquidity जोड़ सके या pay link बना सके। वे
`community` plan का कमीशन देते हैं — 150 bps, बोर्ड पर सबसे ऊँची दर — और
रजिस्टर करने से ही कम दर मिलती है। gateway प्रति consumer दर ठीक उसी तरह inject करता है
जैसे private key के लिए करता है (देखें `resolvePlanCommissionBps`), इसलिए
pricing के मामले में यहाँ कुछ भी विशेष रूप से संभाला नहीं जाता।

जो *विशेष* है, वह tenancy है। नेटवर्क पर हर anonymous caller
एक ही APISIX consumer के रूप में आता है, और read endpoints ठीक उसी
consumer के आधार पर rows filter करते हैं:

```ts
// swaps.service.ts
where: { id, consumer: { apisixUsername: consumer.username } }
```

इसलिए public key के तहत `GET /v1/swaps` हर anonymous user को पूरी
anonymous आबादी का swap इतिहास सौंप देता। Scopes इसे ठीक नहीं कर सकते — scope
key की एक property है और सबके पास एक ही key है — और यह overlap काल्पनिक
नहीं है: `POST /v1/swaps/quote` को `swaps:read` चाहिए, जो वही
scope है जो इतिहास की सूची देता है।

**इसलिए `PublicKeyGuard` एक allowlist है, denylist नहीं।** public consumer को
हर उस रूट पर मना कर दिया जाता है जिस पर `@AllowPublicKey()` नहीं लगा है, इसलिए अगले साल
जोड़ा गया रूट public key के लिए तब तक पहुँच से बाहर रहता है जब तक कोई उसी diff में
अलग न कहे। decorator भूल जाने से एक support ticket बनता है; denylist की कोई
entry भूल जाने से data leak होता है।

आज public key से इन तक पहुँचा जा सकता है:

| रूट | यह सुरक्षित क्यों है |
| --- | --- |
| `POST /v1/swaps/quote` | Horizon से path की कीमत निकालता है; यह request का शुद्ध function है |
| `POST /v1/swaps` | एक unsigned envelope बनाता है जिसे caller sign करता है |
| `POST /v1/swaps/:id/submit` | caller द्वारा signed envelope broadcast करता है — इसके लिए swap का UUID *और* उसके source account का signature चाहिए |
| `POST /v1/liquidity-pools/deposit` \| `withdraw` | unsigned envelopes बनाते हैं |
| `POST /v1/liquidity-pools/operations/:id/submit` | caller द्वारा signed envelope broadcast करता है |
| `GET /v1/liquidity-pools` \| `/:poolId` \| `/positions` | Horizon से पढ़ा गया सार्वजनिक on-chain डेटा |
| `POST /v1/payment-intents/tx` \| `pay` | request से एक SEP-7 intent बनाते हैं |
| `POST /v1/activity/events` | Telemetry ingest — नीचे देखें |
| `GET /v1/assets` | सार्वजनिक asset catalog |
| `GET /v1/aliases/resolve/:name` \| `availability/:name` \| `by-address/:address` | हैंडल resolve करने वाला payer ठीक वही anonymous caller है जिसके लिए यह key बनी है; जवाब request का शुद्ध function है और उसमें मालिक का mailbox कभी शामिल नहीं होता |

जानबूझकर मना किए गए: `GET /v1/swaps`, `GET /v1/swaps/:id`,
`GET /v1/liquidity-pools/operations{,/:id}`, `GET /v1/activity/events`,
`GET /v1/activity/summary`, हर payment-intent read, alias मालिक का हर रूट
(claim, list, पता जोड़ना या हटाना, release, recovery), और
`/v1/kyc`, `/v1/onramp`, `/v1/offramp` और `/v1/webhooks` के अंतर्गत सब कुछ। बिना
account वाला वॉलेट अपना इतिहास इसके बजाय Horizon से बनाता है, जो वैसे भी on-chain गतिविधि का
आधिकारिक स्रोत है।

**Telemetry जानबूझकर सूची में है।** जिस वॉलेट का कोई CosmosPay account नहीं है, वह भी
crash होता है, और उसकी error reports को मना करने से हम ठीक उसी आबादी के प्रति अंधे हो जाते
जो पहली बार चलाने पर विफलताओं का सामना करती है — ingest रूट `403` जवाब देता और
reports गिर जातीं। इस key पर आने वाले events अपनी बनावट से ही anonymous होते हैं
(एक साझा consumer), इसलिए account की पहचान कराने वाली कोई भी चीज़ उनके साथ नहीं जा सकती;
वॉलेट भेजने से पहले address, destination, amount और txHash हटा देता है।

guard public consumer की पहचान forwarded role
(`X-Consumer-Role: public`) **या** कॉन्फ़िगर किए गए `APISIX_PUBLIC_CONSUMER`
username — **इनमें से किसी से भी** करता है। दो संकेत इसलिए, क्योंकि अकेले हर एक ऐसे तरीके से fail open होता है जिसकी कीमत user
डेटा से चुकानी पड़ती है: roles forward करना बंद कर देने वाला gateway हर anonymous caller को
एक सामान्य tenant बना देता, और जिस deployment ने env var कभी सेट ही नहीं किया, वह
ऐसे header पर निर्भर रहता जिस पर उसका नियंत्रण नहीं है। दोनों सेट करें।

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

वैकल्पिक **idempotency** (issue #17): `Idempotency-Key` header (बेहतर)
या body में `idempotencyKey` भेजें। उसी key **और उसी request** के साथ retry
— network, source, destination, दोनों assets, amount, slippage और memo — एक और Stellar
ट्रांज़ैक्शन बनाने की बजाय **मौजूदा** swap (`id` + `txHash`) लौटाता है। वही key किसी
भी अलग request के साथ `409 idempotency_conflict` है,
और error सहेजे गए swap के बारे में कुछ नहीं बताता। Liquidity deposits और
withdrawals भी यही नियम मानते हैं, जिसमें operation का kind भी मिलाया जाता है। यह
तुलना साझा public key की वजह से मौजूद है: हर anonymous वॉलेट एक ही
consumer है, इसलिए किसी और के पहले इस्तेमाल की गई key से आपको *उनका* unsigned envelope मिल जाता —
ऐसा envelope जो आपका पैसा उनके पास ले जा सकता था। key के बिना भी, unique
`(network, txHash)` constraint
byte-identical rebuild को **409** (sequence / XDR collision) के साथ अस्वीकार करता है। जब
`STELLAR_SWAP_SINGLE_INFLIGHT=true` हो, तो उसी `(consumer, source, network)` के लिए
दूसरा non-expired `PENDING` swap भी मौजूदा id बताते हुए **409** लौटाता है
(डिफ़ॉल्ट **बंद** — एक ही account से एक साथ अलग-अलग swaps की अनुमति बनी रहती है)।

```jsonc
// response → { id, status: "PENDING", network, sendAmount, feeAmount, swapAmount,
//              destEstimated, destMin, path, xdr, uri: "web+stellar:tx?xdr=…", qr, txHash, … }
```

**`POST /v1/swaps/:id/submit`** — signed envelope को relay करता है (`swaps:write`)।

```jsonc
// request
{ "signedXdr": "AAAAAgAAA…(signed base64 XDR)…" }
// response
{ "submitted": true, "status": "SUCCEEDED", "txHash": "…", "swap": { … } }
// on a network rejection → { "submitted": false, "status": "FAILED", "reason": "…", "resultCodes": ["op_under_dest_min"], "swap": { … } }
```

broadcast से पहले signed ट्रांज़ैक्शन के hash का मिलान उस hash से किया जाता है जो सर्विस ने बनाया था,
इसलिए कोई caller कभी भी सर्विस से कोई मनमाना
ट्रांज़ैक्शन relay नहीं करवा सकता। swap उसी dispatcher से `SWAP_CREATED` / `SWAP_SUBMITTED` / `SWAP_SUCCEEDED` /
`SWAP_FAILED` webhook events भेजता है।

## Aliases — क्लेम किए जा सकने वाले पेमेंट हैंडल

alias की मदद से payer `GA5ZSE…` की जगह `emanuel250` टाइप कर सकता है। यही वह चीज़ भी है जिसे
payer transfer authorise करने से ठीक पहले पढ़ता है, इसलिए नीचे का हर नियम इसलिए मौजूद है
क्योंकि इसमें गलती होने पर कोई खराब row नहीं बनती — बल्कि payer के भरोसेमंद नाम के तहत
गलत account को पेमेंट चला जाता है।

### माँगकर नहीं, key पर नियंत्रण साबित करके क्लेम किया जाता है

```
wallet ──1. POST /v1/aliases/challenges {name, address, network} ──▶ nonce + the EXACT message to sign
wallet ──2. signs SHA-256(domain ‖ 0x00 ‖ uint32be(length) ‖ message) with that address's key
wallet ──3. POST /v1/aliases {name, email, nonce, signature} ────────▶ alias bound to the calling consumer
```

- **message सर्विस लौटाती है; client उसे कभी खुद दोबारा नहीं बनाता।** जो client
  इसे documentation से जोड़ता है, वह field का क्रम बदलते ही ऐसे signatures से एक कदम दूर है
  जिन्हें अस्वीकार कर दिया जाता है और किसी भी तरफ़ कुछ नहीं बताता कि क्यों।
- **signature एक domain-tagged digest को cover करता है, कभी किसी ट्रांज़ैक्शन को नहीं।** यह flow
  वॉलेट से जो कुछ भी sign करवाता है, उसे नेटवर्क पर submit नहीं किया जा सकता, और domain
  (`Cosmos Pay alias claim v1`) केवल इसी feature का है, इसलिए कोई dapp जो
  user को कोई मनमाना message sign करने के लिए मना ले, वह भी वैध claim लेकर नहीं जा सकता।
- **उद्देश्य signed bytes के अंदर होता है** (`CLAIM`, `ADD_ADDRESS`, `RECOVER`),
  इसलिए पता जोड़ने के लिए लिया गया signature recovery पूरी करने के लिए replay
  नहीं किया जा सकता।
- **पता challenge से आता है, claim body से नहीं।** claim में
  कोई address field नहीं है, इसलिए कोई भी एक पते के लिए sign करके दूसरा रजिस्टर नहीं कर सकता।
- **Challenges एक बार इस्तेमाल होते हैं और पाँच मिनट तक रहते हैं।** challenge खर्च होने से
  *पहले* signature verify किया जाता है, इसलिए कोई बेकार signature किसी प्रतिद्वंद्वी का
  चल रहा nonce बर्बाद नहीं कर सकता, और उसे खर्च करना एक compare-and-swap है, इसलिए दो requests
  दोनों एक ही challenge खर्च नहीं कर सकतीं।
- **होड़ का फ़ैसला `alias.name` पर unique index से होता है**, पहले की किसी जाँच से नहीं;
  हारने वाले को `409 alias_taken` मिलता है।

### हैंडल क्या हो सकता है

छोटे अक्षर `a-z`, `0-9` और `_` (कभी भी शुरुआत या अंत में नहीं), 3–32 अक्षर, uniqueness तय होने से पहले
lowercase में बदले जाते हैं। कोई Unicode नहीं: homoglyphs का समूह असीमित है,
और कोई भी normalization किसी Cyrillic `а` को राशि के बगल में दिखाने लायक सुरक्षित नहीं बनाता। यह भी
अस्वीकार हैं: आरक्षित शब्द जो प्रोडक्ट या किसी operator की नकल करें
(`admin`, `support`, `cosmospay`, `stellar`, …) और कुछ भी जो
Stellar account जैसा दिखे (`g` या `m` के बाद 20 या अधिक base32 अक्षर)। नियम
`src/aliases/alias-name.ts` में है।

### कई पते, एक नाम

एक alias नेटवर्कों में अधिकतम 20 पतों की ओर इशारा कर सकता है — फ़ोन, डेस्कटॉप, cold
वॉलेट, testnet — प्रति नेटवर्क ठीक एक primary के साथ, जिसे एक partial
unique index लागू करता है। पता जोड़ने के लिए **दो** प्रमाण चाहिए: caller alias का मालिक हो,
और नया पता अपना `ADD_ADDRESS` challenge खुद sign करे। आखिरी बचा हुआ
पता हटाया नहीं जा सकता (इसके बजाय alias release करें), और एक consumer
अधिकतम 25 aliases रख सकता है।

`SUSPENDED` alias — operator का hold — किसी भी चीज़ पर resolve नहीं होता। जो suspension
फिर भी एक account दे दे, वह पैसे के बारे में कुछ नहीं करता।

### Recovery ईमेल से होकर, और प्लेटफ़ॉर्म कंसोल से होकर जाती है

Keys खो जाती हैं, और खोई हुई key किसी नाम को हमेशा के लिए पहुँच से बाहर नहीं छोड़नी चाहिए, इसलिए claim
एक recovery mailbox रिकॉर्ड करता है। यही recovery को इस
मॉड्यूल का सबसे खतरनाक रास्ता बनाता है:

1. **प्लेटफ़ॉर्म कंसोल** `POST /v1/aliases/:name/recovery {email}` कॉल करता है।
   response एक जैसा रहता है, चाहे हैंडल और mailbox मेल खाए हों या नहीं; मेल खाने पर
   उसमें एक बार इस्तेमाल होने वाला token होता है (30 मिनट, केवल SHA-256 के रूप में सहेजा गया), जिसे
   कंसोल ईमेल करता है। यह सर्विस कोई मेल नहीं भेजती।
2. user नई key के लिए एक `RECOVER` challenge लेता है और अपनी API key से
   `POST /v1/aliases/:name/recovery/complete {token, address, network, nonce, signature}`
   कॉल करता है। दोनों प्रमाण ज़रूरी हैं: token mailbox साबित करता है,
   signature key साबित करता है।
3. स्वामित्व कॉल करने वाले consumer के पास चला जाता है और **पिछला हर पता
   हटा दिया जाता है**। Recovery इसलिए मौजूद है क्योंकि पुरानी keys जा चुकी हैं, और उन्हें
   resolve होने देना उन्हें रखने वाले को पेमेंट मिलते रहने देता।

**चरण 1 कंसोल का क्यों है।** token *ही* mailbox पर नियंत्रण का प्रमाण है,
इसलिए वह केवल उसी पक्ष तक पहुँच सकता है जो मेल पहुँचाता है। पहले यह रूट
`payments:write` वाली कोई भी key स्वीकार करता था और token माँगने वाले को ही लौटा देता था — इसलिए जो भी
किसी हैंडल और उसके मालिक का ईमेल जानता था, वह alias ले सकता था, और उस पर भेजा गया हर
पेमेंट भी। `ConsoleOnlyGuard` अब alias देखे जाने से पहले ही हर API-key caller को
`403 admin_console_only` के साथ मना कर देता है, और यह रूट
प्रकाशित contract से बाहर रखा गया है। पाँच गलत tokens एक recovery को खत्म कर देते हैं (मालिक बस
नई शुरू कर देता है; attacker असफल होकर किसी नाम को lock नहीं कर सकता), और suspended
alias को recover नहीं किया जा सकता।

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
दोनों के पीछे अनिवार्य **KYC** (BlindPay *receivers*)। हम एक **एकल
प्लेटफ़ॉर्म BlindPay instance** चलाते हैं (env में `BLINDPAY_API_KEY` + `BLINDPAY_INSTANCE_ID`);
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
| PATCH  | `/v1/kyc/receivers/:id`                               | `kyc:write`    | receiver अपडेट करना |
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
`BLINDPAY_WEBHOOK_SECRET` को उस endpoint के signing secret पर सेट करें। feature बंद करने के लिए
`BLINDPAY_*` vars खाली छोड़ दें (तब वे रूट `503` लौटाते हैं)।
`.env.example` देखें।

### KYC redirect URL प्रति consumer allow-list किए जाते हैं

terms-of-service flow user को BlindPay पर भेजता है और फिर integrator के दिए
`redirect_url` पर वापस लाता है। अगर इसे मुक्त string की तरह स्वीकार किया जाए, तो यह प्लेटफ़ॉर्म का नाम ओढ़े
एक open redirect है: ऐसा link जो भरोसेमंद KYC पेज से शुरू होकर वहाँ पहुँचता है
जहाँ attacker ने चुना हो। इसलिए हर `redirect_url` दो परतों से गुज़रता है:

| परत | नियम | कहाँ |
| ----- | ---- | ----- |
| आकार | embedded credentials (`user:pass@`) के बिना एक absolute `https` URL | इसे रखने वाले हर DTO पर `@IsRedirectUrl()` |
| Host | **कॉल करने वाले consumer की** allow-list में — सटीक host, या label की सीमा पर एक subdomain (`app.acme.com` `acme.com` से मेल खाता है; `evilacme.com` नहीं) | `KYC_REDIRECT_URL_WHITELIST`, service layer में लागू |

```
KYC_REDIRECT_URL_WHITELIST={"cosmos_acme":["acme.com","app.acme.com"]}
```

यह **fail closed** होता है: जिस consumer की कोई entry नहीं है, वह redirect बिल्कुल इस्तेमाल नहीं कर सकता, और
अंत में बिंदु वाला या IDN रूप वाला host normalize करने की बजाय अस्वीकार किया जाता है।
सूची प्रति consumer इसलिए है क्योंकि जिस domain की ज़मानत एक integrator देता है, वह
दूसरे के बारे में कुछ नहीं कहता। `redirect_url` लेने वाला हर entry point इसकी जाँच करता है —
terms of service शुरू करना, माँगना और approve करना, admin approval
सहित, जो receiver के अपने consumer की सूची लागू करता है। अस्वीकार किया गया scheme
या host `400` है।

## Pollar — सोशल लॉगिन जो बदले में Stellar वॉलेट देता है

[Pollar](https://docs.pollar.xyz/docs) Google/GitHub लॉगिन को एक Stellar
account में बदल देता है: यह user को authenticate करता है, वॉलेट बनाता है, key को AWS
KMS में custody में रखता है, कॉन्फ़िगर किए गए trustlines जोड़ता है और reserve fund करता है — user को कभी
seed phrase नहीं दिखता। यह सर्विस इसे एक **OAuth bridge** के रूप में उपलब्ध कराती है, उसी आकार में जैसा कोई game
launcher या console तब उपयोग करता है जब client code exchange को locally पूरा करता है।

### passthrough नहीं, bridge क्यों

Pollar का hosted लॉगिन browser SDK के लिए बनाया गया है। यह user को एक publishable key, एक client-session id और एक
`redirect_uri` के साथ `GET /auth/{provider}` पर भेजता है — और वह redirect URI **Pollar के साथ रजिस्टर** किया गया host होना चाहिए।
वॉलेट इनमें से कुछ भी पूरा नहीं कर सकता: किसी ephemeral port पर loopback listener या
`cosmospay://` deep link कभी रजिस्टर किया गया host नहीं हो सकता, और इस जोड़-तोड़ के लिए
ऐसी keys और session ids चाहिए जिन्हें वॉलेट को संभालना ही नहीं चाहिए।

इसलिए Pollar की ओर वाला आधा हिस्सा bridge संभालता है। वॉलेट को दो चरणों वाला ऐसा contract मिलता है जिसे वह
पहले से समझता है — **authorization खोलो, code redeem करो** — और वह उस code के सिवा
कुछ भी ग्रहण नहीं करता।

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

पूरी व्यवस्था का मकसद चरण 6 है: redemption response में
`publishable_key` और `api_base_url` भी होते हैं, इसलिए वहाँ से वॉलेट खुद virtual wallet पर balances पढ़ता है,
ट्रांज़ैक्शन बनाता और submit करता है। **यह सर्विस
उस surface को कभी proxy नहीं करती और ऐसी कोई key नहीं रखती जिससे वह ऐसा कर सके।**

### code ग्रहण करने के दो तरीके

|                  | Redirect flow                                    | Poll flow                                       |
| ---------------- | ------------------------------------------------ | ----------------------------------------------- |
| वॉलेट क्या देता है | `redirect_uri` (allow-list में होना चाहिए)     | कुछ नहीं                                        |
| code कैसे आता है | redirect पर `?code=…&state=…` के रूप में        | `GET /v1/pollar/oauth/sessions/{state}` से      |
| browser क्या देखता है | आपका अपना URI                               | एक साधारण "आप यह विंडो बंद कर सकते हैं" पेज — code कभी नहीं |
| कब उपयोग करें    | जब वॉलेट के पास deep link या loopback listener हो | जब इनमें से कुछ भी न हो (kiosk, headless, embedded view) |

हर poll एक नया code जारी करता है और पिछले को रिटायर कर देता है, इसलिए अपने सबसे हाल के poll से मिला
code redeem करें। यह कभी live credential सहेजकर न रखने का सीधा नतीजा है:
row code का SHA-256 रखती है, और hash को वापस मूल रूप में नहीं बदला जा सकता।

**Poll flow को प्राथमिकता दें।** Pollar browser को callback पर वापस नहीं भेजता: उसका
hosted flow उसके अपने पेज — `www.pollar.xyz/auth/status` — पर खत्म होता है, चाहे
consent अस्वीकार हुई हो या दी गई हो, और दी गई consent बस Pollar की तरफ़ client
session को `READY` छोड़ देती है। authorization URL में मौजूद `redirect_uri` पर
कभी navigate नहीं किया जाता, इसलिए callback का इंतज़ार करने वाला handshake
expire होने तक इंतज़ार ही करता रहता है।

इसलिए poll रूट बताए जाने का इंतज़ार करने की बजाय Pollar से पूछता है: जब तक कोई handshake
`pending` है, वह client session का अपना status जाँचता है, और जिस पल Pollar `READY` रिपोर्ट करता है
उसी पल handshake को आगे बढ़ा देता है — वही शर्त जिसका redemption पहले से
इंतज़ार करता है। वॉलेट का contract नहीं बदलता; बदला यह है कि `pending`
अब अपने आप खत्म हो जाता है।

इससे दो operational नोट निकलते हैं:

- **callback रूट अभी भी मौजूद है और अभी भी Pollar के साथ रजिस्टर है।** अगर
  redirect सच में आए तो यह काम करता है, और redirect-flow handshake इसी पर
  निर्भर है — उस flow के पास code रखने की कोई और जगह नहीं है। बस यह
  लॉगिन पहचानने का अकेला तरीका नहीं हो सकता।
- **provider से प्रति handshake हर दो सेकंड में अधिकतम एक बार पूछा जाता है**
  (`POLLAR_SESSION_PROBE_INTERVAL_MS`), जो `providerCheckedAt` पर एक compare-and-swap है
  जिसे हर replica साझा करता है। इसलिए हर सेकंड poll करने वाला वॉलेट
  Pollar पर प्रति मिनट 60 नहीं, 30 requests डालता है, उस key पर जिसका पूरा
  budget 200 है।

जिस handshake के client session को Pollar ने अस्वीकार कर दिया हो (`INVALID_CLIENT_SESSION_ID`,
`EXPIRED_CLIENT_ID`, या `404`/`410`), उसे TTL खत्म होने तक poll करने की बजाय उसी
समय उस code के साथ `failed` के रूप में बंद कर दिया जाता है।

### एक लॉगिन, दोनों नेटवर्क पर एक वॉलेट

Pollar mainnet और testnet को दो अलग applications के रूप में, दो अलग
key pairs के साथ चलाता है, इसलिए hosted लॉगिन केवल उसी नेटवर्क पर वॉलेट बना सकता है जिस पर उसकी
API key resolve हुई (`prod` → `public`, `dev` → `testnet` — देखें `resolveNetwork`)।
जो user फिर environments के बीच जाता है, उसके पास दूसरी तरफ़ कोई वॉलेट नहीं होता: जिस
पते को उसने testnet पर fund किया, वह mainnet पर पैसा पाने वाला पता नहीं है, और
दूसरा वॉलेट उस पल बनता है जब उसे पहली बार उसकी ज़रूरत पड़ती है,
और वही पल provider की विफलता झेलने के लिए सबसे कम तैयार होता है।

इसलिए redemption user को **दूसरे** नेटवर्क पर भी Server API के
`POST /users/with-wallet` के ज़रिए रजिस्टर करता है, और `POST /v1/pollar/oauth/token`
दोनों को रिपोर्ट करता है:

```jsonc
"network_wallets": [
  { "network": "testnet", "status": "ready",   "address": "GA5Z…" },
  { "network": "public",  "status": "pending", "address": null    }
]
```

**`pending` entry कोई error नहीं है।** लॉगिन सफल हुआ; दूसरा वॉलेट
वह हिस्सा है जो अभी तक नहीं बना, और डिज़ाइन का पूरा मकसद यही है कि वह
लॉगिन को अपने साथ नहीं गिरा सकता। request path पर प्रयास को पाँच
सेकंड और एक कोशिश मिलती है, और जो भी पूरा नहीं होता उसे background में
provisioning sweeper दोबारा आज़माता है — handshake sweeper वाला ही switch और cadence
(`POLLAR_SWEEP_*`), exponential backoff के साथ और row के `failed` होने से पहले
कुल दस प्रयासों के budget के साथ।

`pending` का आम कारण साधारण है: **दूसरे नेटवर्क की keys कॉन्फ़िगर
नहीं हैं।** जब तक वे नहीं होतीं, हर लॉगिन एक pending counterpart छोड़ता है; जिस
पल वे आ जाती हैं, एक sweep किसी के दोबारा लॉगिन किए बिना पूरा backlog provision कर देता है।
इसीलिए दोनों नेटवर्क की keys सेट करना फ़ायदेमंद है, भले ही आप आज
केवल एक को serve करते हों।

दो नतीजे जो जानने लायक हैं:

- **जोड़ने वाली key OAuth ईमेल है**, क्योंकि दूसरे नेटवर्क पर बाद का hosted लॉगिन
  उसी व्यक्ति को इसी से पहचानता है। जो provider किसी ईमेल की ज़मानत नहीं देता, उसे
  कोई counterpart वॉलेट नहीं मिलता — यह ऐसे अनाथ वॉलेट से बेहतर है जिस पर
  XLM खर्च हुआ और जिस तक कोई लॉगिन कभी नहीं पहुँचता।
- **यह दोनों नेटवर्क पर XLM खर्च करता है।** mainnet लॉगिन अब testnet
  reserve भी fund करता है और इसके उलट भी। प्रति-नेटवर्क state `pollar_user_wallet` में रहती है,
  प्रति (consumer, email, network) एक row, और यही idempotency भी है: दोहराया गया
  लॉगिन दोबारा provision करने की बजाय इसी के ज़रिए upsert करता है।

### bridge क्या स्टोर करता है

एक handshake row, और उसमें कुछ भी पैसा खर्च नहीं कर सकता: अनुमान न लगाया जा सकने वाला `state`,
Pollar client-session id, code का एक **hash**, और परिणामी सार्वजनिक Stellar
पता। **कोई भी Pollar token कभी persist नहीं किया जाता** — `/auth/login` exchange
redemption request के अंदर चलता है और tokens सीधे उसके response में बाहर चले जाते हैं।
जिन handshakes को किसी ने पूरा नहीं किया, वे एक timer पर expire किए जाते हैं (`POLLAR_SWEEP_*`), क्योंकि
`AUTHORIZED` row sweep होने तक एक redeem करने योग्य code है।

हर transition row के status पर एक compare-and-swap है, इसलिए replay किया गया
callback दूसरा code नहीं बनाता, और एक code के लिए होड़ करते दो वॉलेट दोनों नहीं जीत सकते।

### जानने लायक hardening

- **PKCE (RFC 7636, S256)** वैकल्पिक है लेकिन अनुशंसित है: authorize पर `code_challenge` और
  redemption पर `code_verifier` भेजें, और तब browser या log से लीक हुआ code
  verifier के बिना बेकार है।
- **`dpop_jwk`** Pollar के बनाए tokens को वॉलेट की अपनी P-256 key से बाँध देता है
  (RFC 9449), इसलिए चुराया गया access token signed proof के बिना निष्क्रिय है। इसका यह भी
  अर्थ है कि bridge अब वॉलेट की ओर से काम नहीं कर सकता — `/refresh` और `/logout`
  bearer sessions को serve करते हैं, और DPoP से बँधा वॉलेट सीधे Pollar को कॉल करता है।
- **`POLLAR_REDIRECT_URI_WHITELIST`** प्रति consumer है और fail closed होता है। redirect
  URI वह जगह है जहाँ एक बार इस्तेमाल होने वाला code पहुँचता है, इसलिए बिना जाँचा गया URI डेटा चुराने का
  रास्ता है। यह loopback hosts (कोई भी port, RFC 8252 के अनुसार), private-use scheme वाले
  deep links, और https hosts स्वीकार करता है।
- **`pollar:*` वाली API keys को सर्वर पर ही रखें।** poll flow code उसे सौंप देता है
  जिसके पास handshake का `state` *और* `pollar:read` वाली key हो। जो
  attacker users को भेजे गए किसी app से ऐसी key निकाल लेता है, वह लॉगिन खोल सकता है,
  उसका `authorization_url` किसी पीड़ित को भेज सकता है, पीड़ित के असली Google/GitHub पेज पर
  consent देते ही code के लिए poll कर सकता है, और अपने खुद के PKCE verifier से उसे
  redeem कर सकता है — PKCE और `dpop_jwk` मदद नहीं करते, क्योंकि दोनों attacker ही देता है।
  यह device-code phishing का ढाँचा है, और बचाव यही है कि key कभी
  आपके नियंत्रण वाले backend से बाहर न जाए।

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
| POST   | `/v1/pollar/users` · `/v1/pollar/users/with-wallet`   | `pollar:write` | user रजिस्टर करना, वैकल्पिक रूप से वॉलेट के साथ |
| POST   | `/v1/pollar/tokens/verify`                            | `pollar:read`  | किसी वॉलेट द्वारा आपको दिखाए गए token को validate करना |

आखिरी छह को Pollar की **secret** key चाहिए, और ठीक इसी वजह से वे वॉलेट में नहीं
बल्कि यहाँ रहते हैं। इन सभी के request और response schemas
जनरेट किए गए contract में हैं — `/docs` पर Swagger UI, या `openapi/openapi.{json,yaml}`।
ऊपर की टेबल केवल दिशा-निर्देश के लिए है; सत्य का स्रोत contract है।

### Rate limiting: वॉलेट बनाने की spamming को क्या रोकता है

Pollar वॉलेट बनाना मुफ़्त नहीं है। Pollar Stellar account बनाता है, उसका
base reserve (1 XLM) fund करता है और हर कॉन्फ़िगर किए गए asset के लिए एक trustline जोड़ता है (हर एक 0.5 XLM)
— **आपके funding वॉलेट से**। इसलिए लॉगिन flow के विरुद्ध चलाया गया loop
किसी अजनबी के लिए आपका पैसा खर्च करने का तरीका है, और इसके लिए दूसरी तरफ़ किसी असली
user की ज़रूरत भी नहीं है।

इसलिए सीमाएँ केवल gateway पर नहीं, बल्कि यहाँ, इसी सर्विस में रहती हैं: यही वह
process है जो जानता है कि कोई request account बनाने वाली है, और यही
XLM निकलने से पहले मना कर सकता है।

**नियंत्रण बिंदु `authorize` है, `token` नहीं।** एक handshake अधिकतम एक
वॉलेट देता है, इसलिए एक पता कितने handshakes खोल सकता है, इसे सीमित करने से यह भी सीमित हो जाता है कि वह कितने
वॉलेट बनवा सकता है। `token` जानबूझकर ढीला रखा गया है, क्योंकि 409 वाला रास्ता
caller को कहता है कि Pollar के account provision करने तक वही request दोहराए
— वहाँ सख्त budget हमारे ही documented retry को throttle कर देता, और redeem करने से
ऐसा कुछ नहीं बनता जिसकी अनुमति handshake पहले ही न दे चुका हो।

| रूट | Budget (प्रति 10 मिनट) | यही संख्या क्यों |
| ----- | ------------------- | --------------- |
| `POST /v1/pollar/oauth/authorize` | 20 | वॉलेट बनाने की सीमा। विफल consent स्क्रीन को दोबारा आज़माने वाले इंसान से बहुत ऊपर, account खाली करने वाली दर से बहुत नीचे |
| `POST /v1/pollar/oauth/token` | 60 | जानबूझकर ढीला — ऊपर देखें |
| `GET /v1/pollar/oauth/callback` | 60 | बिना API key के पहुँचा जा सकने वाला अकेला रूट, इसलिए anonymous बाढ़ केवल यहीं पहुँच सकती है। tab refresh करने वाला user सामान्य है |
| `POST /v1/pollar/users/with-wallet` | 10 | बिना consent स्क्रीन की रुकावट के वॉलेट बनाता है — इस सेट का सबसे सख्त budget |
| `POST /v1/pollar/wallets/activate` | 20 | हर कॉल पर XLM खर्च करता है, लेकिन कुछ नया नहीं बना सकता |

किसी सीमा को पार करने पर **`429` के साथ `code: "rate_limited"`**, एक `Retry-After`, और
`RateLimit-Limit` / `-Remaining` / `-Reset` की तिकड़ी लौटती है। सर्विस की बाकी हर चीज़
यहाँ असीमित है; सामान्य traffic shaping APISIX का काम है, क्योंकि वह
इस process से पहले request देखता है।

**काउंटर memory में नहीं, Postgres में है।** सर्विस load
balancer के पीछे चलती है, इसलिए प्रति-process limiter हर replica को पूरा budget दे देता:
प्रभावी सीमा `limit × replicas` बन जाती और जब भी
deployment scale होता, चुपचाप बदल जाती। दिखावटी throttle के लिए यह ठीक है, लेकिन
असली balance की रक्षा करने वाली चीज़ के लिए नहीं। यह एक fixed window है — प्रति request एक atomic
`INSERT … ON CONFLICT … RETURNING` — जिसका अर्थ यह है कि client
window की सीमा के दोनों ओर पूरा budget खर्च कर सकता है, इसलिए ऊपर की संख्याओं को
"प्रति window अधिकतम इसका दोगुना" समझें। वे यह जानते हुए ही तय की गई हैं।

**पता कैसे तय होता है, और उसे spoof क्यों नहीं किया जा सकता।** `main.ts`
`trust proxy` को `1` पर सेट करता है, जिससे Express `X-Forwarded-For` की *सबसे दाईं* entry पढ़ता है
— वह जो APISIX ने जोड़ी, यानी gateway को दिखा peer।
client उस header में शुरुआत में entries जोड़ सकता है, लेकिन वह जो भी लिखता है वह
APISIX की entry के बाईं ओर पड़ता है और अनदेखा कर दिया जाता है।

> **`trust proxy` न बढ़ाएँ।** `2` पर Express client द्वारा दिए गए पहले hop को
> मानने लगता है, और तब यहाँ की हर सीमा एक header जोड़कर bypass की जा सकती है।
> `src/common/client-ip.spec.ts` दोनों व्यवहारों को pin करता है ताकि यह बदलाव
> review में बिना ध्यान दिए पास न हो सके।

IPv6 caller को प्रति पता नहीं, बल्कि प्रति **/64** bucket में रखा जाता है: client को आमतौर पर
पूरा /64 मिलता है और वह उसमें मुफ़्त में घूम सकता है, इसलिए वहाँ प्रति-पता limiting
कोई limiting नहीं है। कीमत यह है कि एक /64 के पीछे के दो users एक bucket साझा करते हैं,
ठीक वैसे ही जैसे एक IPv4 NAT के पीछे के दो users पहले से करते हैं। Buckets consumer के आधार पर भी
key किए जाते हैं, इसलिए एक integrator का traffic दूसरे का हिस्सा नहीं खा सकता।

अगर काउंटर लिखा न जा सके तो limiter **fail closed** होता है (`503`)। जो limiter
database incident के दौरान चुपचाप limiting बंद कर दे, वह किसी limiter के न होने से भी बदतर है,
क्योंकि कुछ भी आपको नहीं बताता कि ऐसा हुआ — और उसके पीछे के हर रूट को वैसे भी वही
database चाहिए, इसलिए मना करने से ऐसी कोई availability नहीं जाती जो पहले ही न जा चुकी हो।

incident switch के रूप में `RATE_LIMIT_ENABLED=false` सेट करें।

### सेटअप

1. [dashboard.pollar.xyz](https://dashboard.pollar.xyz) पर एक app बनाएँ और
   अपने नेटवर्क की दोनों keys लें (`pub_testnet_…` / `sec_testnet_…`)। यह
   **दोनों** नेटवर्क के लिए करें: एक लॉगिन हर नेटवर्क पर एक वॉलेट provision करता है, और जिस नेटवर्क की
   keys नहीं हैं वह हर user का दूसरा वॉलेट उनके सेट होने तक `pending` छोड़ देता है। दोनों
   डैशबोर्ड अलग हैं — हर एक में callback host रजिस्टर करें।
2. `POLLAR_BRIDGE_CALLBACK_URL` के **gateway host** को
   **Build → Domains** के अंतर्गत रजिस्टर करें। यह केवल redirect के बारे में नहीं है: SDK API
   *हर* कॉल पर `Origin` header के सामने उस सूची की जाँच करता है, और bridge
   इसी host का origin उस header के रूप में भेजता है (`POLLAR_SDK_ORIGIN` इसे override करता है)।
   रजिस्टर न किया गया host `POST /auth/session` पर `403 ORIGIN_NOT_ALLOWED` है — जो
   हर लॉगिन की पहली कॉल है, user को consent स्क्रीन दिखने से भी पहले।
3. `POLLAR_BRIDGE_CALLBACK_URL` को `<gateway>/v1/pollar/oauth/callback` पर सेट करें —
   `/{state}` bridge खुद जोड़ता है।
4. हर वॉलेट का redirect URI `POLLAR_REDIRECT_URI_WHITELIST` में जोड़ें, या उसे छोड़ दें
   और poll flow का उपयोग करें।

Keys प्रति नेटवर्क होती हैं, और Pollar नेटवर्क और key का प्रकार prefix में encode करता है,
इसलिए mismatch सीधा अस्वीकार है — env validator इसे user के सामने होने वाले लॉगिन पर नहीं,
boot पर ही पकड़ लेता है। feature बंद करने के लिए keys खाली छोड़ दें (तब Pollar
रूट `503` लौटाते हैं)। `.env.example` देखें।

## अपग्रेड — breaking changes और deploy नोट्स

### सुरक्षा समीक्षा के सुधार

पूरी सर्विस की समीक्षा में नीचे दी गई समस्याएँ मिलीं। हर एक ठीक कर दी गई है और एक ऐसे
test से pin की गई है जो सुधार के बिना fail होता है। अधिकांश किसी सही ढंग से व्यवहार करने वाले caller के लिए कुछ नहीं बदलतीं, लेकिन
हर row किसी न किसी को दिखती है — deploy करने से पहले "किसे पता चलेगा" कॉलम पढ़ें।

| बदलाव | किसे पता चलेगा | क्यों |
| ------ | ----------- | --- |
| `POST /v1/aliases/:name/recovery` **केवल प्लेटफ़ॉर्म कंसोल** के लिए है: API key को `403 admin_console_only` मिलता है, और यह रूट प्रकाशित contract से हटा दिया गया | जिसने भी API key से recoveries शुरू की थीं | response में recovery token होता है, जो मालिक के mailbox का प्रमाण है। केवल scope के पीछे होने पर, जो भी किसी हैंडल और उसके मालिक का ईमेल जानता था उसे token मिल जाता था और वह alias तथा उस पर भेजा गया हर पेमेंट ले सकता था |
| `SUSPENDED` alias पर recovery पूरी करना `404` है | कोई वैध caller नहीं | suspension से पहले बना token operator के hold से निकलने का रास्ता था |
| `@Public()` रूट (Pollar callback, BlindPay webhook, health) `X-Consumer-Username` को अनदेखा करते हैं | डैशबोर्ड: वे requests अब anonymous के रूप में log होती हैं | वे रूट key-auth के बिना चलते हैं, इसलिए header client का अपना था: हर request पर नया नाम एक नया rate-limit budget था, और किसी पीड़ित का नाम देने से उसके API-log view में जाली rows दर्ज हो जाती थीं |
| `AdminGuard` और `ConsoleOnlyGuard` द्वारा मना करना `warn` स्तर पर log होता है | Operators | Guards access log से पहले चलते हैं, इसलिए `/v1/admin` की जाँच-पड़ताल कहीं कोई निशान नहीं छोड़ती थी |
| `POST /v1/pollar/wallets/activate` और तीनों `/v1/pollar/wallets/:address/trustlines…` रूट उस वॉलेट के लिए `404` लौटाते हैं जो कॉल करने वाले consumer ने उस नेटवर्क पर इस सर्विस के ज़रिए प्राप्त नहीं किया | ऐसे वॉलेट पर काम करने वाले integrators जिन्हें उन्होंने केवल `tokens/verify` से देखा, किसी लॉगिन के non-primary वॉलेट पर, या ऐसे counterpart वॉलेट पर जिसे किसी दूसरे tenant ने पहले ही रजिस्टर कर लिया | हर tenant Pollar secret keys का एक ही सेट साझा करता है, इसलिए इस जाँच के बिना एक tenant दूसरे tenant के users के trustlines हटा सकता था या उनके reserves पर operator का XLM खर्च कर सकता था। पराए और अनजान वॉलेट दोनों को एक ही `404` मिलता है, इसलिए जवाब ownership oracle नहीं बनता |
| दोनों `POST …/trustlines` रूट प्रति 10 मिनट 20 कॉल का एक `429` budget साझा करते हैं | थोक में trustlines जोड़ने वाली scripts | हर trustline operator के funding वॉलेट से 0.5 XLM reserve में lock करता है, और XLM खर्च करने वाले रूट्स में केवल इन्हीं पर कोई सीमा नहीं थी |
| `GET /v1/offramp/payouts/:id` अब `raw`, `consumerId`, `receiverId`, `quoteId`, `bankAccountId` या `updatedAt` नहीं लौटाता; virtual-account बनाने का response अब `raw`, `receiverId`, `consumerId` या `updatedAt` नहीं लौटाता | उन fields को पढ़ने वाले callers | `raw` BlindPay का सहेजा हुआ object है, जिसमें बैंक और लाभार्थी का डेटा है, और यह `offramp:read` रखने वाली किसी भी key तक पहुँच जाता था — यह read path उस public projection को अनदेखा करता था जिसे बाकी हर payout read उपयोग करता है |
| `POST /v1/kyc/upload` 4 से अधिक text fields, 1 KiB से बड़े field, दूसरी फ़ाइल, या घोषित type से मेल न खाने वाले file bytes पर `400` लौटाता है | सही ढंग से upload भेजने वाला कोई नहीं | Multer के डिफ़ॉल्ट fields को असीमित और memory में हर एक 1 MB तक छोड़ देते थे, और type जाँच client के `Content-Type` पर भरोसा करती थी |
| `POST /v1/payment-intents/tx` और `/pay`: वही memo किसी भी अलग शर्त के साथ `409 idempotency_conflict` है। हूबहू retry अब भी सहेजा गया intent लौटाता है (`2` और `2.0` एक ही राशि हैं) | एक ही memo को अलग-अलग पेमेंट के लिए दोबारा इस्तेमाल करने वाले callers | साझा public key के तहत हर anonymous वॉलेट एक ही consumer है, इसलिए किसी और के पहले बनाए memo से *उनका* intent लौटता था — एक ऐसे QR के साथ जो उन्हें भुगतान करता था |
| `POST /v1/payment-intents/:id/validate` केवल उसी विफल tx के लिए `FAILED` करता है जो इस intent का अपना पेमेंट हो; कोई भी दूसरा विफल tx `valid: false` है और status नहीं बदलता। intent बनने से 60 s से अधिक पहले close हुआ tx अस्वीकार किया जाता है ("Transaction predates this payment intent") — validate पर, `PATCH {status: SUCCEEDED}` पर, और observer में | कोई वैध caller नहीं | नेटवर्क के किसी भी विफल ट्रांज़ैक्शन का hash किसी intent को स्थायी रूप से fail कर देता था, और समान शर्तों वाला पुराना पेमेंट नए intent को settle कर सकता था |
| terminal intent पर `txHash` बदलने वाला `PATCH /v1/payment-intents/:id` `400 invalid_state_transition` है; write के साथ होड़ करने वाला status बदलाव `409 operation_in_flight` है | कोई वैध caller नहीं | यह `SUCCEEDED` intent के settlement के प्रमाण को दोबारा लिख देता था |
| payment-intent observer प्रति tick प्रति consumer अधिकतम 10 intents का मिलान करता है और expired rows को कभी scan नहीं करता | observer throughput पर नज़र रखने वाले operators | एक consumer के open-amount intents की बाढ़ बाकी हर tenant के settlement को भूखा रखती थी और साझा Horizon budget खर्च कर देती थी |
| `POST /v1/swaps`, `/v1/liquidity-pools/deposit` और `/withdraw`: अलग request के साथ दोबारा इस्तेमाल की गई `Idempotency-Key` — अलग memo या slippage, दूसरा नेटवर्क, या withdrawal के लिए दोबारा इस्तेमाल की गई deposit key — `409 idempotency_conflict` है। अवैध asset, slippage या memo वाला replay अब सामान्य `400` पाता है | एक ही key को अलग-अलग operations के लिए दोबारा इस्तेमाल करने वाले clients | साझा public key के तहत, attacker अनुमान लगाई जा सकने वाली key से किसी पीड़ित के account से अपने account तक swap या withdrawal पहले से बना सकता था, और पीड़ित के retry पर वही envelope उसे sign करने के लिए लौट आता था |
| `POST /v1/liquidity-pools/withdraw` अब ऐसे in-flight withdrawal के लिए `409 operation_in_flight` जवाब नहीं देता जिसका sequence number account ने अभी तक इस्तेमाल नहीं किया (unsigned या छोड़ा गया envelope) | जो वॉलेट users रोक दिए गए थे | किसी और के account के लिए बना और हर 300 s पर दोबारा भेजा गया dust withdrawal हर public-key user को उस position से withdraw करने से रोक देता था। दोनों envelopes एक ही sequence number साझा करते हैं, इसलिए अधिकतम एक ही कभी settle हो सकता है |
| settlement observer प्रति tick प्रति टेबल प्रति consumer अधिकतम 10 rows लेता है, और `GET /v1/liquidity-pools/positions` हर pool के लिए एक request की बजाय एक paged listing से Horizon पढ़ता है | Operators | एक consumer की बाढ़ बाकी सबके settlement को भूखा रखती थी, और कई pool shares रखने वाला account असीमित Horizon कॉल फैला देता था |
| `GET /v1/onramp/payins/:id` अब `receiverId` या `updatedAt` नहीं लौटाता — वही shape जो `GET /v1/onramp/payins` लौटाता है | एक payin की read से ये दो fields पढ़ने वाले callers | ताज़ा mirror row वाला payin जैसा stored था वैसा ही लौटा दिया जाता था, इसलिए एक ही payin अपने mirror की उम्र के हिसाब से दो shapes में आता था, जिनमें से एक में internal id होता था |
| 10 MiB से बड़ी फ़ाइल वाला `POST /v1/kyc/upload` अब `code: "payload_too_large"` के साथ `413` है; पहले यह `internal_error` था | `code` पर branch करने वाले integrators | जिस limit के भीतर caller रह सकता है, वह इस service का bug जैसी दिखती थी |
| `POST /v1/liquidity-pools/deposit`, `/withdraw`, `GET /v1/liquidity-pools/operations`, `/operations/:id`, `POST /v1/liquidity-pools/operations/:id/submit` और `LIQUIDITY_*` webhooks में अब `memo` आता है (caller का MEMO_ID, या `null`)। Migration `20260915120000_liquidity_pool_operation_memo` से पहले बने operations `null` लौटाते हैं, भले ही उनके envelope में memo हो | कोई नहीं, जब तक कोई client अनजान fields को reject न करे | memo केवल XDR के अंदर दर्ज था, इसलिए हर `Idempotency-Key` replay तुलना के लिए envelope decode करता था |
| `GET /v1/swaps` और `GET /v1/liquidity-pools/operations` का प्रकाशित contract अब list items पर `qr` या `commissionMemo` नहीं दिखाता। Responses नहीं बदले — ये दो fields वहाँ कभी भेजे ही नहीं गए; इनके लिए अकेला item पढ़ें | OpenAPI spec से generate किए गए clients | contract list items को single-item shape में बताता था, इसलिए generated client ऐसे दो fields type करता था जो list में कभी आते ही नहीं थे |

इसके साथ आने वाले deploy नोट:

- **Migration `20260910120000_aliases`** `alias`, `alias_address`,
  `alias_challenge` और `alias_recovery` बनाता है। नया
  build traffic serve करे, उससे पहले `migrate deploy` चलाएँ।
- **एक नया advisory lock id, `881_008` (`AliasChallengeSweeper`)।** कुछ भी
  कॉन्फ़िगर नहीं करना है; सूची में इसलिए है ताकि यह नंबर कभी दोबारा इस्तेमाल न हो।
- **production में `NODE_ENV=production` सेट करें।** `.env.example`
  `development` के साथ आता है, और दो सुरक्षाएँ इसी पर निर्भर हैं:
  `X-Plan-Swap-Fee-Bps` के बिना आई request केवल production में `503` है (बाकी हर जगह swaps
  चुपचाप `STELLAR_SWAP_FEE_BPS` पर लौट जाते हैं), और `/docs` — जो हर guard से बाहर है
  — केवल production में डिफ़ॉल्ट रूप से बंद है।
- **settlement observer अब `ScheduledJob` पर चलता है।** `OBSERVER_ENABLED`,
  `OBSERVER_INTERVAL_MS` और उसका advisory lock नहीं बदले, लेकिन log lines अब साझा
  वाली हैं: `Settlement observer started (every Nms)`,
  `Settlement observer (OBSERVER_ENABLED=false) disabled`, और `error` level पर
  `SettlementObserverService cycle failed`। पुराने शब्दों पर match करने वाले alert को
  अपडेट करना होगा।
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

### NestJS 12, TypeScript 6 और न्यूनतम Node 24.9

पूरी NestJS श्रृंखला 12 पर और TypeScript 6 पर चली गई है। **इससे Node का न्यूनतम
version 24.9 हो जाता है** (`engines`, और दोनों workflows अब `node-version: 24` pin करते हैं);
इससे पुराना कुछ भी test suite चला ही नहीं सकता। Deploy targets को भी इसके साथ
आगे बढ़ना होगा।

कारण framework नहीं, test runner है। NestJS 12 शुद्ध ESM के रूप में प्रकाशित होता है
(`"type": "module"`), और CommonJS के तहत चलने वाला Jest इसे `require()` नहीं कर सकता — 62 में से
हर suite load होने में विफल रहा। Jest `require(esm)` को natively समर्थन करता है, लेकिन केवल
Node >= 24.9 पर **और** `--experimental-vm-modules` के साथ, क्योंकि जिस क्षमता की वह
जाँच करता है (`vm.SourceTextModule.prototype.hasAsyncGraph`) वह उस flag के बिना
मौजूद ही नहीं है। इसलिए test scripts अब Jest को सीधे Node के ज़रिए चलाती हैं:

```
"test": "node --experimental-vm-modules node_modules/jest/bin/jest.js"
```

`NODE_OPTIONS=` prefix नहीं: वह Windows shells पर portable नहीं है, और CI,
release job और developer की मशीन को एक ही command चलानी चाहिए।

दो नतीजे जो जानने लायक हैं:

- **`transformIgnorePatterns` दोनों Jest configs से हटा दिया गया है।** इसमें ESM
  packages (`@stellar`, `@noble`, `@exodus`, `uint8array-extras`) सूचीबद्ध थे ताकि
  ts-jest उन्हें CommonJS में transpile करे — ESM load न कर पाने का एक workaround। अब जब
  Jest ESM natively load करता है तो यह workaround सक्रिय रूप से चीज़ें तोड़ता है:
  CJS में compile किया गया package ESM के रूप में evaluate होता है और `exports is not defined` पर मर जाता है। अगर किसी dependency को
  कभी फिर से transform करने की ज़रूरत पड़े, तो यही फ़ाइल देखनी है।
- **`tsconfig.json` में `types` और `rootDir` जोड़े गए।** TypeScript 6 अब
  हर `@types` package को अपने आप शामिल नहीं करता, इसलिए दोनों ambient packages (`node`, `jest`)
  स्पष्ट रूप से नाम से दिए गए हैं — इसके बिना, हर spec से `describe`/`it` गायब हो गए जबकि वे
  ts-jest के तहत फिर भी green चलते रहे। और TS 6 तब `rootDir` का अनुमान लगाने से मना करता है जब
  compilation एक directory को cover करता है (TS5011), जो ts-node scripts करती हैं;
  `"./"` वही है जो पूरे build ने पहले से अनुमान लगाया था, इसलिए emit किया गया layout
  नहीं बदला।

major versions की वजह से करने पड़े कोड बदलाव, सभी छोटे:

- `EventEmitter2` को `@nestjs/event-emitter` से नहीं, `eventemitter2` से import किया जाता है।
  runtime पर यह वही class object है — DI token नहीं बदला — लेकिन
  Nest का re-export package के CJS आकार के लिए typed है और इस repo के
  `node10` module resolution के तहत `any` पर resolve होता है, जिसने चुपचाप हर `.emit()`
  को बिना जाँच वाली कॉल बना दिया था। इसी कारण से `eventemitter2` अब सीधी dependency
  है।
- `OperationObject`
  `@nestjs/swagger/dist/interfaces/open-api-spec.interface` की बजाय `@nestjs/swagger` से आता है। Swagger 12
  एक `exports` map प्रकाशित करता है जो केवल `.` और `./plugin` को उजागर करता है, इसलिए गहरे paths अब
  resolve नहीं होते।
- `AccountLoaderService.load` में स्पष्ट `Promise<Horizon.AccountResponse>`
  return type है; TS 6 ऐसे type का अनुमान नहीं लगाएगा जिसे वह portable ढंग से नाम नहीं दे सकता।
- दो test mocks (`fetch`, `Reflector.getAllAndOverride`) अब हाथ से लिखे संकरे signatures की बजाय
  असली signatures से मेल खाते हैं।

प्रकाशित OpenAPI बड़ा हुआ: `@nestjs/terminus@12` ज़्यादा समृद्ध health schemas emit करता है
(status enums और एक `responseTime` property)। पूरी तरह additive — कोई business रूट
या schema नहीं बदला।

### एक साझा सार्वजनिक API key, और उसे सीमित करने वाला guard

इस release में नया: `PublicKeyGuard` (global, `PermissionsGuard` के बाद) और
`@AllowPublicKey()` decorator। मौजूदा keys के लिए कुछ नहीं बदलता — guard की
साझा public consumer के अलावा किसी consumer के बारे में कोई राय नहीं है — लेकिन deploy के समय दो काम
करने होंगे:

- **`APISIX_PUBLIC_CONSUMER` सेट करें**, उस username पर जिसे dev platform
  public key के लिए provision करता है, हर उस deployment पर जो ऐसी key प्रकाशित करता है। इसके बिना guard
  केवल forwarded `X-Consumer-Role` पर निर्भर रहता है।
- **public key `role: public` के साथ बनाई जानी चाहिए** और केवल उन्हीं scopes के साथ जिनकी
  allowlist वाले रूट्स को ज़रूरत है। उसे `kyc:*` या `webhooks:*` देने से वे
  रूट नहीं खुलेंगे — guard उन्हें हर हाल में मना करता है — लेकिन वह अपने काम से
  ज़्यादा व्यापक credential होगा, जो सबके पास है।

यह किन तक पहुँच सकती है और क्यों, इसके लिए ऊपर "साझा सार्वजनिक API key" देखें।

### एसेट रजिस्ट्री: `GET /v1/assets`

(code, issuer) जोड़ों की एक चुनी हुई टेबल जिनकी ज़मानत यह प्लेटफ़ॉर्म प्रति
नेटवर्क देता है, जारी करने वाले संगठन के नाम के साथ। इसके लिए किसी scope की ज़रूरत नहीं — catalog में
कोई tenant डेटा नहीं है, और इसे scope के पीछे रखने का अर्थ बस यही होता कि scope के
अस्तित्व में आने से पहले बनी हर key एक खाली token picker पढ़ती — लेकिन इसके लिए authenticated
consumer ज़रूरी है, साझा public key सहित।

`npm run assets:verify` हर row को live Horizon के सामने फिर से जाँचता है: कि जोड़ा
उस नेटवर्क पर मौजूद है जिसके अंतर्गत वह दर्ज है, कि `contract` Horizon के
`contract_id` से मेल खाता है, और कि issuer flags chain से मेल खाते हैं।
रजिस्ट्री संपादित करते समय इसे चलाएँ। यह unit test नहीं है क्योंकि इसे सार्वजनिक internet चाहिए, और जो test
Horizon धीमा होने पर fail हो, वह ऐसा test है जिसे लोग छोड़ना सीख जाते हैं।

### क्लाइंट एक्टिविटी: एक नया मॉड्यूल, एक नई टेबल और दो नए scopes

`POST /v1/activity/events` वॉलेट और developer
डैशबोर्ड से telemetry स्वीकार करता है; `GET /v1/activity/events` और `GET /v1/activity/summary` उसे वापस पढ़ते हैं।
किसी मौजूदा चीज़ का आकार नहीं बदला, लेकिन deploy के समय तीन काम करने होंगे:

- **Migration `20260906140000_activity_event`** `activity_event` बनाता है
  (append-only, `consumerId` तक सीमित, `(consumerId, eventId)` पर unique)।
- **scopes `activity:write` और `activity:read` नए हैं।** इनके बिना वाली key को
  `insufficient_scope` मिलता है, जो सही जवाब है — लेकिन इसका अर्थ है कि
  मौजूदा key upgrade करने से telemetry रिपोर्ट करने की क्षमता नहीं पाती।
  developer platform वॉलेट के लिए provision की गई keys को दोनों देता है और rotation पर
  यह सेट फिर से लागू करता है; हाथ से बनाई गई keys में इन्हें जोड़ना होगा।
- **`ACTIVITY_RETENTION_DAYS`** (डिफ़ॉल्ट 30) retention job में शामिल होता है। यह
  access log के बराबर का व्यक्तिगत डेटा है; इसे `0` पर केवल
  सोच-समझकर सेट करें।

### Pollar poll रूट अब पूरा हुआ लॉगिन खुद पहचान लेता है

`GET /v1/pollar/oauth/sessions/{state}` पहले वही रिपोर्ट करता था जो bridge
callback ने रिकॉर्ड किया था। Pollar वह callback कभी कॉल नहीं करता — उसका hosted flow
`www.pollar.xyz/auth/status` पर खत्म होता है और client session को `READY` छोड़ देता है — इसलिए
poll-flow handshake expire होने तक `pending` रहता था, ऐसे वॉलेट के तहत जो
सब कुछ सही कर रहा था। poll अब सीधे Pollar से पूछता है और `READY` पर
handshake को आगे बढ़ा देता है।

किसी API का आकार नहीं बदला और client में कोई बदलाव ज़रूरी नहीं: जो लॉगिन पहले
`pending` पर अटका रहता था, वह अब user के पूरा करने के एक poll के भीतर `authorized` तक पहुँच जाता है। deploy करते समय दो
बातों का ध्यान रखें:

- **Migration `20260906120000_pollar_oauth_provider_probe`** `pollar_oauth_session` में एक nullable
  `providerCheckedAt` जोड़ता है। यह साझा न्यूनतम सीमा है कि सवाल कितनी बार
  Pollar तक पहुँचता है; कुछ भी backfill नहीं होता।
- **Poll traffic अब Pollar तक पहुँचता है।** उस नेटवर्क की publishable key पर, हर
  in-flight लॉगिन के लिए हर दो सेकंड में एक provider request का budget रखें।

### Pollar लॉगिन अब दोनों नेटवर्क पर वॉलेट provision करते हैं

`POST /v1/pollar/oauth/token` में एक `network_wallets` array जुड़ा — प्रति
Stellar नेटवर्क एक entry, हर एक `ready`, `pending` या `failed`। Additive, इसलिए कुछ नहीं
टूटता, लेकिन दो operational नोट:

- **Migration चलाएँ।** `20260905120000_pollar_user_wallet`
  `pollar_user_wallet` और `PollarWalletStatus` enum जोड़ता है। इसके बिना हर
  redemption एक विफल provisioning log करता है और counterpart वॉलेट
  अरिकॉर्डेड रहता है — लॉगिन खुद काम करता रहता है।
- **दोनों नेटवर्क की keys सेट करें।** `POLLAR_*_MAINNET` और `POLLAR_*_TESTNET`
  अपने-आप में वैकल्पिक हैं, और जिस नेटवर्क की keys नहीं हैं वह अब हर लॉगिन पर
  कुछ न दिखने की बजाय `pending` वॉलेट के रूप में दिखता है। दूसरा pair कॉन्फ़िगर करें
  और sweeper अपने अगले tick पर backlog निपटा देता है; इसे जानबूझकर सेट न करें
  तो rows तब तक `pending` पड़ी रहती हैं जब तक दस प्रयासों का budget
  उन्हें रिटायर न कर दे। किसी भी तरह कोई लॉगिन विफल नहीं होता।

XLM का budget रखें: एक लॉगिन अब *दोनों* नेटवर्क पर reserve fund करता है, इसलिए प्रति नए user mainnet
खर्च नहीं बदला लेकिन testnet पर खर्च वहाँ दिखता है जहाँ पहले कोई नहीं था।

### `429` अब `rate_limited` रिपोर्ट करता है

एक साधारण `429` पहले `code: "provider_unavailable"` पर लौट जाता था, जो कहता था कि कोई
upstream मुश्किल में है जबकि असल में इस सर्विस ने खुद request
मना की थी — जिससे integrators ऐसी चीज़ की जाँच करने चले जाते थे जो बिल्कुल
ठीक थी। अब यह `code: "rate_limited"` रिपोर्ट करता है, और `ApiErrorCode.RateLimited`
प्रकाशित enum का हिस्सा है। अगर आप throttling पर retry करते हैं तो इसी पर branch करें।


### बदले हुए response shapes

audit-hardening release में तीन प्रकाशित shapes बदले। तीनों
`/v1` के अंतर्गत हैं; कोई `/v2` नहीं है, इसलिए deploy करने से पहले integrators को बताना ज़रूरी है।

| Endpoint | पहले | अब | क्यों |
| -------- | --- | --- | --- |
| `GET /v1/webhooks` | साधारण array, चुपचाप 100 पर सीमित | `{ data, total, take, skip }` | 120 endpoints वाले consumer को बिना किसी सूचना के 100 मिलते थे, और pagination के लिए कोई `total` नहीं था |
| `GET /v1/products` | साधारण array, पूरी टेबल | `{ data, total, take, skip }` | असीमित read |
| `GET /v1/webhooks/:id/deliveries` और redelivery response | `payload` शामिल था | `payload` हटाया गया | `RECEIVER_UPDATED` body एक पूरा KYC dossier है और ये रूट `kyc:read` पर नहीं, `webhooks:read` पर gated हैं |

`for (const x of res)` करने वाला या `delivery.payload` पढ़ने वाला caller deploy होते ही
टूट जाता है। Migration यांत्रिक है: `res.data` पढ़ें, और KYC विवरण
`kyc:read` रखने वाली key के साथ KYC endpoints से लें।

`RECEIVER_UPDATED` / `PAYIN_*` / `PAYOUT_*` **webhook bodies** भी सिकुड़कर
पहचान और state तक सीमित हो गईं — Webhooks सेक्शन देखें।

### audit-hardening migration

यह दो फ़ाइलों के रूप में आता है जिन्हें क्रम से लागू करना होगा:

- `20260901120000_audit_hardening` — correctness का काम: एक नया कॉलम,
  `liquidity_pool_operation` पर duplicates हटाने वाला `DELETE`, दो `UNIQUE` indexes,
  दो नई टेबलें। DELETE और जिस unique index को वह तैयार करता है, दोनों एक
  स्पष्ट transaction के अंदर `SHARE ROW EXCLUSIVE` lock के तहत चलते हैं, इसलिए rolling deploy
  उनके बीच कोई duplicate नहीं घुसा सकता। उस एक टेबल पर लिखने वाले
  उसके कुछ milliseconds तक block रहते हैं।
- `20260901120100_audit_hardening_indexes` — नौ additive indexes, जो
  `CONCURRENTLY` बनाए जाते हैं ताकि deploy `payment_intent`,
  `swap`, `webhook_delivery` या `request_log` पर writes को block **न** करे। किसी maintenance window की ज़रूरत नहीं।

यह बँटवारा शैली का मामला नहीं है: PostgreSQL transaction block के अंदर `CREATE INDEX CONCURRENTLY`
मना करता है, और पहली फ़ाइल को transaction चाहिए। दोनों
CI में असली PostgreSQL के सामने verify होती हैं, जो यह भी जाँचता है कि कोई index `INVALID` न छूटा हो और
migrations अब भी `schema.prisma` से मेल खाते हों।

अगर दूसरी फ़ाइल बीच में विफल हो जाए, तो `CONCURRENTLY` build साफ़ विफल होने की बजाय एक **invalid**
index छोड़ देता है, और `IF NOT EXISTS` उसे मौजूद मान लेता है। उसे drop
करें, फिर दोबारा चलाएँ:

```sql
SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE NOT i.indisvalid;
```

### `ADMIN_API_CREDENTIALS` हटा दिया गया — `/v1/admin` अब प्लेटफ़ॉर्म कंसोल का है

**variable delete करें।** इसे अब पढ़ा नहीं जाता, और developer
platform में इससे मेल खाने वाले `COSMOS_ADMIN_API_SECRET` / `COSMOS_ADMIN_API_SECRET_READ`
भी इसके साथ जाते हैं।

यह एक दूसरा credential था जो इस सर्विस में तय करता था कि platform
admin कौन है — जबकि developer platform यह पहले ही
signed-in account की role के आधार पर तय कर चुका था। एक सवाल के दो जवाब, और हर उस deployment को जिसने
gateway तो सेट किया लेकिन यह secret छोड़ दिया, यह बँटवारा अपने सबसे उलझाने वाले
रूप में मिला: owner कंसोल में किसी दूसरे account का plan और role बदल सकता था,
जो कभी यह secret नहीं माँगता, फिर भी हर cross-tenant read `401
admin_credentials_required` जवाब देता था। उस error में कुछ भी deployment के गायब secret की ओर
इशारा नहीं करता, बल्कि account के अपने अधिकारों की ओर करता है।

इसलिए guard का सवाल "क्या caller के पास admin
secret है?" से बदलकर "क्या यह कॉल प्लेटफ़ॉर्म कंसोल से आई?" हो गया, जिसका फ़ैसला
request पर पहले से मौजूद दो तथ्यों से होता है:

1. `X-Gateway-Secret` `APISIX_GATEWAY_SECRET` से मेल खाता है — जिसे `ApisixGuard`
   बाकी हर रूट की तरह जाँचता है। यह केवल gateway और कंसोल backend के पास है।
2. `X-Cosmos-Internal` मौजूद है। APISIX इसे अपने proxy किए हर request से हटा देता है
   (`proxy-rewrite.headers.remove`), इसलिए API-key caller इसे साथ नहीं ला सकता;
   केवल gateway secret रखने वाले backend की सीधी कॉल ही ला सकती है।

समझौते को साफ़ शब्दों में कहें: तथ्य 2 इस सर्विस के पास रखे किसी secret पर नहीं, बल्कि
developer-platform repo में मौजूद gateway routing configuration पर टिका है। दो चीज़ें
इसकी कीमत चुकाती हैं। कंसोल अब वह अकेली जगह है जो "platform
admin कौन है" का जवाब देती है, इसलिए दोनों जवाब असहमत नहीं हो सकते; और attribution कमज़ोर होने की बजाय
और सटीक हुआ — audit row पहले एक साझा credential (`owner`, `viewer`) का नाम देती थी,
और अब उस कंसोल account का नाम देती है जिसने काम किया (`cosmos_<userId>`), साथ में
उसके द्वारा बताई गई platform role, हर mutation **और** हर read पर।

caller के लिए इससे क्या बदलता है:

| पहले | अब |
| --- | --- |
| Bearer secret के बिना `401` `admin_credentials_required` | जो भी कंसोल कॉल नहीं है, उसके लिए `403` `admin_console_only` |
| mutation पर `read` credential के लिए `403` `admin_role_required` | हटा दिया गया — कंसोल पहले ही तय कर चुका है कि account कार्रवाई कर सकता है |
| audit row पर `actorId` / `actorRole` credential का नाम देते थे | वे कंसोल account और उसकी platform role का नाम देते हैं |

अगर आप `/v1/admin` तक सीधे पहुँचते हैं (जैसे कोई ops script), तो `X-Gateway-Secret`,
`X-Consumer-Username` और `X-Cosmos-Internal: 1` भेजें; और
`X-Cosmos-Admin-Role: owner` जोड़ें ताकि audit row पर label लगे। सर्विस को
सार्वजनिक internet से दूर रखें — admin secret हटने के बाद, network isolation और
gateway secret ही cross-tenant डेटा के सामने खड़े हैं।

### `APISIX_GATEWAY_SECRET` के लिए अब 32 अक्षर ज़रूरी हैं

इससे कम होने पर सर्विस boot होने से मना कर देती है। पहले यह एक अकेला
अक्षर भी स्वीकार कर लेती थी, और अब यह बाहरी दुनिया और
platform-admin surface के बीच खड़ा *अकेला* secret है (ऊपर देखें), इसलिए इसका वज़न
पहले से ज़्यादा है। `openssl rand -hex 32` से एक बनाएँ और उसी समय APISIX में
rotate करें।

### `v0.1.0`–`v0.1.5` की वे सुविधाएँ जिन्हें यह release बदल देती है

`main` और इस branch ने अलग रहते हुए कई एक जैसी समस्याएँ स्वतंत्र रूप से
हल कीं। जहाँ दोनों के पास जवाब था, वहाँ इसी branch का डिज़ाइन
ship होता है, इसलिए `v0.1.5` से आने वाला deployment नीचे दी गई चीज़ें खो देता है। इनमें से कुछ भी
दुर्घटना नहीं है — हर एक सोचा-समझा फ़ैसला है — लेकिन हर item किसी
integrator को दिखता है, इसलिए upgrade की योजना इन्हें ध्यान में रखकर बनाएँ।

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
सभी अब भी `schema.prisma` में declared हैं और
`migrate deploy` के बाद भी मौजूद हैं। बस उनमें कभी लिखा नहीं जाता। live कॉलम drop करना — और एक
enum value, जिसे PostgreSQL type दोबारा बनाए बिना हटा नहीं सकता — बिना किसी फ़ायदे के खरीदा गया
एक विनाशकारी migration होता, और उन्हें declared रखना ही
`prisma migrate diff` को साफ़ रहने देता है।

## एनवायरनमेंट वेरिएबल

`src/` में `process.env` से पढ़ा जाने वाला हर variable boot पर
`src/config/env.validation.ts` द्वारा validate किया जाता है (fail-fast)। `.env.example` कॉपी करें और
कम से कम `DATABASE_URL` और `APISIX_GATEWAY_SECRET` बदलें।

| Variable | ज़रूरी | डिफ़ॉल्ट | प्रभाव |
| -------- | -------- | ------- | ------ |
| `NODE_ENV` | नहीं | `development` | `development`, `test`, या `production` होना चाहिए। **production में `production` सेट करें** — fail-closed plan-fee जाँच और डिफ़ॉल्ट रूप से बंद docs, दोनों इसी पर निर्भर हैं |
| `PORT` | नहीं | `3000` | HTTP listen port |
| `DATABASE_URL` | **हाँ** | — | Prisma के लिए PostgreSQL connection |
| `APISIX_GATEWAY_SECRET` | **हाँ** | — | साझा secret जो साबित करता है कि request APISIX से होकर आई। **न्यूनतम 32 अक्षर** — "gateway से होकर आई" और "pod तक पहुँच सकने वाला कोई भी" के बीच की पूरी सीमा यही है |
| `APISIX_GATEWAY_SECRET_HEADER` | नहीं | `x-gateway-secret` | gateway secret वाले header का नाम |
| `APISIX_CONSUMER_HEADER` | नहीं | `x-consumer-username` | authenticated consumer का username |
| `APISIX_CREDENTIAL_HEADER` | नहीं | `x-credential-identifier` | key-auth से मिला credential id |
| `APISIX_ENVIRONMENT_HEADER` | नहीं | `x-consumer-env` | key का environment (`dev` / `prod`) |
| `APISIX_ROLE_HEADER` | नहीं | `x-consumer-role` | gateway द्वारा forward की गई consumer role |
| `APISIX_PERMISSIONS_HEADER` | नहीं | `x-consumer-permissions` | gateway द्वारा forward की गई permissions की सूची |
| `APISIX_ORGANIZATION_HEADER` | नहीं | `x-consumer-org` | संगठन id |
| `APISIX_PLAN_HEADER` | नहीं | `x-consumer-plan` | संगठन का plan |
| `APISIX_SWAP_FEE_BPS_HEADER` | नहीं | `x-plan-swap-fee-bps` | plan की swap fee (bps) |
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
| `BLINDPAY_API_KEY` | नहीं | — | BlindPay प्लेटफ़ॉर्म API key |
| `BLINDPAY_INSTANCE_ID` | जब API key सेट हो | — | BlindPay instance id (`in_...`) |
| `BLINDPAY_BASE_URL` | नहीं | `https://api.blindpay.com/v1` | BlindPay API का base URL |
| `BLINDPAY_WEBHOOK_SECRET` | जब API key सेट हो | — | आने वाले BlindPay webhooks के लिए Svix secret |
| `BLINDPAY_TIMEOUT_MS` | नहीं | `15000` | BlindPay HTTP client timeout (ms) |
| `KYC_REDIRECT_URL_WHITELIST` | नहीं | — | प्रति consumer KYC redirect hosts की allow-list |
| `RATE_LIMIT_ENABLED` | नहीं | `true` | XLM खर्च करने वाले रूट्स पर प्रति पता सीमाएँ। incident switch |
| `RATE_LIMIT_PRUNE_INTERVAL_MS` | नहीं | `600000` | counter-window prune interval (ms, न्यूनतम 1000) |
| `POLLAR_PUBLISHABLE_KEY_TESTNET` / `_MAINNET` | नहीं | — | OAuth bridge के लिए Pollar publishable key (`pub_<network>_…`) |
| `POLLAR_SECRET_KEY_TESTNET` / `_MAINNET` | publishable key के साथ | — | operator रूट्स के लिए Pollar secret key (`sec_<network>_…`) |
| `POLLAR_BRIDGE_CALLBACK_URL` | जब Pollar key सेट हो | — | सार्वजनिक URL जिस पर Pollar browser को लौटाता है। `<gateway>/v1/pollar/oauth/callback` होना चाहिए **और** Pollar के Build → Domains में रजिस्टर किया गया host |
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

सफल auth के बाद `key-auth` `X-Consumer-Username` / `X-Credential-Identifier` को
upstream तक forward करता है, client की भेजी हर कॉपी को overwrite करते हुए, और
guard इसी पर निर्भर है।

> **remove सूची पूरा भार उठाती है, और इस security model का यही एक हिस्सा है
> जिसे इस repository के अंदर से verify नहीं किया जा सकता।** ऊपर के block का हर
> header एक authorization input है जिसे सर्विस जैसा है वैसा ही मान लेती है;
> `X-Gateway-Secret` केवल यह साबित करता है कि request *किसी* gateway से होकर आई,
> यह नहीं कि मान ईमानदार हैं। उस सूची को कोड जितने ही सख्त review वाले production
> configuration की तरह लें: जब भी कोई रूट जोड़ा या कॉपी किया जाए तो उसका audit करें, और
> सर्विस को private network पर रखें ताकि पहुँचने का एकमात्र रास्ता APISIX से होकर हो।
> साझा secret दूसरी परत है, अकेली परत नहीं।
>
> सर्विस अब उस एक input पर fail closed होती है जहाँ पहले चुप रहना
> फ़ायदेमंद था: production configuration में `X-Plan-Swap-Fee-Bps` का न होना
> environment default पर चुपचाप लौटने की बजाय 503 है।
>
> `X-Cosmos-Internal` का वज़न अब पहले से ज़्यादा है:
> `ADMIN_API_CREDENTIALS` हटने के बाद, यही इस सर्विस को बताता है कि request API key से नहीं,
> बल्कि प्लेटफ़ॉर्म कंसोल से आई है, और इसलिए यही
> `/v1/admin` खोलता है। यह अब भी केवल उसी caller तक पहुँचता है जिसने पहले ही
> gateway secret दिखा दिया हो, इसलिए जोखिम उससे और network isolation से सीमित है —
> लेकिन जो रूट इसे हटाना भूल जाए, वह हर API key को platform
> admin बना देता है।

> सर्विस को private network पर रखें ताकि पहुँचने का एकमात्र रास्ता
> APISIX से होकर हो; साझा secret दूसरी परत है, अकेली परत नहीं।

## इस दस्तावेज़ को सच्चा बनाए रखना

**README बदलाव का हिस्सा है, बाद का काम नहीं।** CI में कुछ भी इसके
भटकाव को नहीं पकड़ता — build green रहता है जबकि ये पन्ने चुपचाप ऐसी सर्विस का वर्णन करते रहते हैं
जो अब मौजूद ही नहीं है — इसलिए इसे उसी commit में अपडेट किया जाता है जिसमें वह कोड है जिसका यह वर्णन करता है।
पूरी परंपरा, जिसमें यह भी शामिल है कि किस तरह का बदलाव किस सेक्शन को छूता है,
[`CLAUDE.md`](../../CLAUDE.md) में है; संक्षेप में:

| जब आप… | अपडेट करें |
| --------- | ------ |
| `src/` के अंतर्गत कोई मॉड्यूल जोड़ते या हटाते हैं | [प्रोजेक्ट संरचना](#प्रोजेक्ट-संरचना) |
| `process.env` का कोई read जोड़ते, rename या delete करते हैं | [एनवायरनमेंट वेरिएबल](#एनवायरनमेंट-वेरिएबल) **और** `.env.example` |
| कोई provider integrate करते हैं, या किसी provider का व्यवहार बदलते हैं | उस provider का अपना `##` सेक्शन |
| कोई प्रकाशित response shape, status code, या scope बदलते हैं | [अपग्रेड](#अपग्रेड--breaking-changes-और-deploy-नोट्स) |
| कोई रूट जोड़ते, rename करते, हटाते या उसका scope बदलते हैं | [रूट सूची](#रूट-सूची), और मॉड्यूल का अपना सेक्शन |
| ऐसा कुछ सीखते हैं जो किसी operator या integrator से छूटना नहीं चाहिए | वह सेक्शन जिसका वह हिस्सा है |

**यह दस्तावेज़ सात भाषाओं में मौजूद है** — English, Español, Português,
Deutsch, Français, हिन्दी और 简体中文 — और किसी एक में बदलाव सातों में बदलाव है,
उसी commit में। English स्रोत है और बाकी — [`docs/i18n/`](./) में — उसके अनुवाद हैं:
वही headings, टेबलें और code blocks, जिनमें identifiers (routes, env
vars, headers, error codes) ठीक वैसे ही छोड़े गए हैं जैसे वे हैं। `npm run readme:check`
CI को तब fail करता है जब कोई भाषा फ़ाइल गायब हो, जब उसकी headings English से मेल खाना बंद कर दें,
या जब OpenAPI contract का कोई रूट उसकी रूट सूची से गायब हो।

दो चीज़ें जानबूझकर यहाँ **नहीं** रहतीं: **request और response schemas**,
जो जनरेट किए गए OpenAPI contract के हैं (`npm run openapi:check` उसे
सच्चा रखता है), और **कोई भी चीज़ जो कोड पहले से कहता है** — यह दस्तावेज़ इस बारे में है कि कोई
चीज़ *क्यों* वैसी है और उसे कैसे चलाया जाए, क्योंकि वह *क्या* करती है उसकी दूसरी कॉपी
बस सच रखने के लिए एक और कॉपी है।
