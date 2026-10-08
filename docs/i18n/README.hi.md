# Cosmos Pay — पेमेंट्स माइक्रोसर्विस

[English](../../README.md) · [Español](./README.es.md) · [Português](./README.pt.md) · [Deutsch](./README.de.md) · [Français](./README.fr.md) · **हिन्दी** · [简体中文](./README.zh.md)

**NestJS 12** + **Prisma 7 (PostgreSQL)** से बनी पेमेंट्स माइक्रोसर्विस।

यह Cosmos developer platform (`paydev`) से एक *अलग* एप्लिकेशन है। dev platform
एक dashboard है: यह developers के लिए API keys **जारी** करता है और उनका data
**दिखाता** है। यह किसी client की किसी भी request के रास्ते में नहीं है — हर कॉल
client → APISIX → यह सर्विस जाती है, इसलिए platform down हो सकता है और किसी wallet
या integration को पता भी नहीं चलता (देखें
[कोई भी request developer platform पर निर्भर नहीं है](#कोई-भी-request-developer-platform-पर-निर्भर-नहीं-है))।
यह सर्विस **APISIX के पीछे** रहती है, जो हर request को यहाँ भेजने से पहले
load-balance और authenticate करता है। यह कभी raw API keys नहीं देखती — यह केवल
उसी पर भरोसा करती है जो gateway आगे भेजता है।

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

`/v1/admin` cross-tenant है, इसलिए `AdminGuard` यह भी माँगता है कि `X-Cosmos-Internal`
में gateway secret से बना एक ताज़ा MAC हो (`src/admin/console-marker.ts`)। API-key callers
के पास यह secret कभी नहीं होता, इसलिए इसे केवल वही backend बना सकता है जो सर्विस को सीधे
कॉल करता है — यानी developer platform, जो तय करता है कि signed-in account owner है या
admin। कोई अलग admin credential नहीं है। APISIX अपने proxy किए हर request से यह header
हटाता भी है, लेकिन वह defence in depth है: जो रूट इसे हटाना भूल जाए, वह ऐसा मान आगे
भेजता है जिसे कोई client जाली नहीं बना सकता।

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
| Payment intents   | `/v1/payment-intents`    | Stellar (SEP-7), Solana (Solana Pay) और Monad (EIP-681) पर `pay` intents, SEP-7 `tx`, validation, on-chain observer |
| Swaps             | `/v1/swaps`              | Path-payment quote, unsigned XDR बनाना, signed XDR submit करना · Solana: Jupiter, Monad: Kuru Flow |
| क्रॉस-चेन swaps | `/v1/cross-chain-swaps` | NEAR Intents के ज़रिए Stellar ⇄ Solana ⇄ Monad: quote, deposit address, status |
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
| पब्लिक key         | `/v1/public-key`         | साझा public API key, बिना key के दी जाती है (`@Public`) |
| Analytics         | `/v1/summary`, `/v1/balances`, `/v1/logs` | डैशबोर्ड के aggregates और लॉग           |
| एक्टिविटी         | `/v1/activity`           | client द्वारा रिपोर्ट किए गए events: ingest, feed, rollup |
| Plugins           | `/v1/plugins`            | एक slug के तहत compile किए गए extensions, हर tenant के लिए install |
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
| GET | `/v1/admin/chain-swaps` | प्लेटफ़ॉर्म कंसोल |  |
| GET | `/v1/admin/consumers` | प्लेटफ़ॉर्म कंसोल |  |
| GET | `/v1/admin/cross-chain-swaps` | प्लेटफ़ॉर्म कंसोल |  |
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
| POST | `/v1/aliases/{name}/recovery` | `payments:write` | ✓ |
| POST | `/v1/aliases/{name}/recovery/complete` | `payments:write` |  |
| GET | `/v1/assets` | — | ✓ |
| GET | `/v1/balances` | `payments:read` |  |
| POST | `/v1/blindpay/webhooks` | कोई नहीं — `@Public()`, Svix signature |  |
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
| GET | `/v1/defindex/vaults` | इनमें से कोई एक `liquidity:read`, `swaps:read` | ✓ |
| GET | `/v1/defindex/vaults/{vault}` | इनमें से कोई एक `liquidity:read`, `swaps:read` | ✓ |
| GET | `/v1/defindex/vaults/{vault}/balance` | इनमें से कोई एक `liquidity:read`, `swaps:read` | ✓ |
| POST | `/v1/defindex/vaults/{vault}/deposit` | इनमें से कोई एक `liquidity:write`, `swaps:write` | ✓ |
| POST | `/v1/defindex/vaults/{vault}/withdraw` | इनमें से कोई एक `liquidity:write`, `swaps:write` | ✓ |
| POST | `/v1/defindex/submit` | इनमें से कोई एक `liquidity:write`, `swaps:write` | ✓ |
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
| `admin_console_only` | 403 | यह रूट प्लेटफ़ॉर्म कंसोल का है (`/v1/admin`)। कोई भी API key इसे कॉल नहीं कर सकती |
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
| `PaymentIntentObserverService`       | `PaymentIntentObserver`  |
| `RequestLogRetentionService`   | `RequestLogRetention`    |
| Webhook delivery sweeper       | `WebhookDeliverySweeper` |
| `RateLimitPruneService`        | `RateLimitPrune`         |
| `AliasChallengeSweeperService` | `AliasChallengeSweeper`  |

`pg_try_advisory_xact_lock` कभी block नहीं करता, और transaction खत्म होते ही release
हो जाता है, crash या टूटे हुए connection पर भी। session-level lock के उलट, यह
transaction-pooling mode में PgBouncer के पीछे भी काम करता है।

Lock ids `AdvisoryLockKey` enum में रहते हैं। किसी मौजूदा id का नंबर न बदलें —
rolling deploy के दौरान पुराने और नए replicas अलग-अलग locks लेंगे — और रिटायर किया
गया id दोबारा इस्तेमाल न करें।

**एक ही checkout से कई instances, local में।** `npm run dev:local` एक ही `.env` से api और
एक दूसरी replica चलाता है; `npm run dev:local -- recovery` api और दोनों रिकवरी सर्वर (A
`:3002` पर, B `:3003` पर, testnet) चलाता है, और `-- all` चारों। हर instance में जो अलग है,
केवल वही `dev-instances.json` में रहता है (git इसे ignore करता है; पहली बार चलाने पर यह
`dev-instances.example.json` से बनती है और हर रिकवरी सर्वर की keys एक ही बार बनाई जाती
हैं — इसे संभालकर रखें, ये keys ledger पर मौजूद signers derive करती हैं): वहाँ की कोई key
`.env` वाली को बदल देती है, `""` उसे हटा देती है, और nested object एक prefix है
(`{ "RECOVERY": { "ROLE": "a" } }` यानी `RECOVERY_ROLE=a`)। एक ही watch build `dist-local/`
में compile करता है, इसलिए यह `dist/` पर `npm run dev` से कभी नहीं टकराता — पर यह api भी
चलाता है, इसलिए दोनों में से एक ही चलाएँ। replicas `DATABASE_URL` और secrets साझा करती हैं:
कुछ भी per-process state नहीं है। दोनों को APISIX के upstream में जोड़ें (developer platform
का `COSMOS_API_URL`, comma से अलग, फिर वहाँ `npm run sync:route`)।

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
- **स्वचालित (स्थायी observer):** `PaymentIntentObserverService` हर
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

डैशबोर्ड का traffic (सत्यापित `X-Cosmos-Internal` marker) छोड़ा नहीं जाता, बल्कि **रिकॉर्ड और चिह्नित** किया जाता है
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
`LIQUIDITY_FAILED`, `CROSS_CHAIN_SWAP_CREATED`, `CROSS_CHAIN_SWAP_UPDATED`, `CROSS_CHAIN_SWAP_SUCCEEDED`, `CROSS_CHAIN_SWAP_REFUNDED`, `CROSS_CHAIN_SWAP_FAILED`, `CROSS_CHAIN_SWAP_EXPIRED`, और साथ में BlindPay से आने वाले `RECEIVER_UPDATED`, `PAYIN_CREATED`,
`PAYIN_UPDATED`, `PAYIN_COMPLETED`, `PAYOUT_CREATED`, `PAYOUT_UPDATED` और
`PAYOUT_COMPLETED`। आधिकारिक सूची `prisma/schema.prisma` में मौजूद
`WebhookEventType` enum है।

**BlindPay से आई bodies।** `RECEIVER_UPDATED` / `PAYIN_*` / `PAYOUT_*` में केवल पहचान
और state होती है — ids, status, राशियाँ, rails — कभी भी व्यक्तिगत डेटा नहीं। provider का
object आगे नहीं भेजा जाता, क्योंकि receiver का payload एक पूरा KYC dossier होता है और
subscribe करने के लिए केवल `webhooks:write` चाहिए। विवरण API से ऐसी key के साथ लें जिसके
पास `kyc:read` / `onramp:read` / `offramp:read` हो। field allowlist
`src/native-plugins/blindpay/blindpay-event-redaction.ts` में है।

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

### Solana और Monad पर payment intents

`POST /v1/payment-intents/pay` एक वैकल्पिक `chain` लेता है: `stellar` (डिफ़ॉल्ट),
`solana` या `monad`। इसके बिना अनुरोध ठीक ऊपर वाला Stellar अनुरोध है। नेटवर्क स्तर
अब भी API कुंजी का होता है — `prod` कुंजी Solana mainnet-beta और Monad mainnet
(chain id 143) तक, `dev` कुंजी Solana devnet और Monad testnet (10143) तक पहुँचती है —
और हर chain पर `network` को `public` / `testnet` के रूप में सहेजा जाता है।
`POST /v1/payment-intents/tx` केवल Stellar रहता है: SEP-7 `tx` एक Stellar envelope है।

| | Stellar | Solana | Monad |
| --- | --- | --- | --- |
| लिंक (`uri`) | SEP-7 `web+stellar:pay` | Solana Pay `solana:<recipient>?…` | EIP-681 `ethereum:<payee>@143?…` |
| सिक्का (`assetCode` के बिना) | XLM | SOL | MON |
| टोकन (`assetCode` + `assetIssuer`) | issuer खाता | SPL mint | ERC-20 contract |
| भुगतान कैसे खोजा जाता है | `MEMO_ID` | हर intent के लिए नई `reference` कुंजी (`chainReference`) | intent का अपना deposit address (relayer के साथ); अन्यथा destination + सटीक राशि |
| Observer | destination को भुगतान | reference कुंजी के signatures | deposit address का balance, native MON सहित (relayer के साथ); अन्यथा टोकन के `Transfer` logs |
| `amount` | वैकल्पिक | वैकल्पिक | relayer के साथ वैकल्पिक, बिना relayer अनिवार्य |
| `msg` / `callback` | दोनों | `msg` (Solana Pay `message`) | कोई नहीं |
| `validate` / `PATCH` के लिए `txHash` | 64 hex | base58 signature | `0x` + 64 hex |

- **Memo अब भी idempotency कुंजी है**, और `chain` उन शर्तों में से एक है जिनसे
  दोहराया गया अनुरोध मेल खाना चाहिए: Stellar पर memo `42` और Solana पर memo `42` अलग
  भुगतान हैं (`409 idempotency_conflict`)। Solana पर SPL Memo program memo को on-chain
  भी लिखता है।
- **Intent सहेजने से पहले टोकन को chain से resolve किया जाता है** — SPL mint के
  decimals (Token या Token-2022 program), ERC-20 का `decimals()`। जो पता टोकन नहीं है
  वह `400 validation_failed` देता है; टोकन से अधिक decimals वाली राशि
  `400 invalid_amount` देती है।
- **Monad भुगतान में memo नहीं होता।** EIP-681 में कोई ऐसा field नहीं है जिसे wallet
  intent id से भरे, इसलिए Monad intent को उसके भुगतान से पहचाना जाता है: destination,
  टोकन और सटीक राशि, बनने वाले block में या उसके बाद। एक ही destination के समवर्ती
  intents को **अलग-अलग राशियाँ** दें। **Native MON** भुगतान कोई log नहीं छोड़ता,
  इसलिए observer उसे नहीं खोज सकता: उसे `POST /v1/payment-intents/{id}/validate` और
  transaction hash से settle करें। ERC-20 भुगतान observer खोजता है — हर कॉल में
  `MONAD_LOG_BLOCK_RANGE` blocks और हर tick में हर intent के लिए पाँच कॉल, और जहाँ रुका
  था वहीं से आगे बढ़ता है (`chainCursor`)।
- **Deposit addresses (`MONAD_RELAYER_PRIVATE_KEY` के साथ)।** हर Monad intent को अपना
  पता मिलता है, और link merchant के बजाय उसी को भुगतान करता है: deterministic
  deployment proxy (`0x4e59…956c`, Monad mainnet और testnet पर मौजूद) के ज़रिए
  `contracts/PaymentForwarder.sol` का एक `CREATE2` पता, जिसका init code merchant,
  asset, relayer और relayer की fee को तय कर देता है। पता ही प्रतिबद्धता है — कोई भी,
  यह सेवा भी, वहाँ ऐसा code deploy नहीं कर सकता जो किसी और को भुगतान करे — इसलिए सेवा
  के पास पैसे की कोई कुंजी नहीं होती। Deposit forwarder पते के balance पर नज़र रखता है
  (native MON सहित, logs की ज़रूरत नहीं); जब यह intent को पूरा कर देता है (open intent
  के लिए fee से ऊपर कोई भी राशि), relayer forwarder को deploy करता है, जिसका
  constructor relayer को उसकी fee और बाकी merchant को देता है, और intent उसी
  transaction पर settle होता है। Fee intent बनते समय तय होती है और `networkFee` के रूप
  में दिखती है: MON के लिए, मौजूदा कीमत पर forward का gas budget और 25%; टोकन के लिए,
  operator की `MONAD_DEPOSIT_TOKEN_FEES` प्रविष्टि, या कुछ नहीं (gas relayer उठाता है)।
  जिस राशि को fee निगल जाए वह `400 invalid_amount` है। Intent के expire या cancel होने के
  बाद जो आता है वह भी merchant को forward होता है, और payer `validate` और अपने hash से
  पहले settle कर सकता है। Relayer कुंजी में केवल gas का पैसा होता है: उसे सीमित रूप से
  fund करें और balance पर alert रखें। Bytecode commit किया गया है
  (`src/evm/payment-forwarder.artifact.ts`) और एक spec source को फिर से compile करके
  उससे मिलाता है; हर deposit address उस पर निर्भर है, इसलिए जब तक पुराने पतों पर पैसा आ
  सकता है, उसे कभी न बदलें।
- **RPC node पर भरोसा करने से पहले उसकी जाँच होती है**: किसी स्तर को पहली बार पढ़ने से
  पहले सेवा node के genesis hash (Solana) या `eth_chainId` (Monad) की तुलना chain से
  करती है, और mainnet URL के test network की ओर इशारा करने पर `503 misconfigured`
  लौटाती है। सार्वजनिक RPC डिफ़ॉल्ट हैं और कड़ाई से rate-limited हैं — production में
  `SOLANA_RPC_URL_MAINNET` और `MONAD_RPC_URL_MAINNET` को किसी प्रदाता के endpoints पर
  सेट करें।
- **Swaps, liquidity pools और DeFindex केवल Stellar पर रहते हैं।**

```jsonc
// POST /v1/payment-intents/pay — Solana पर USDC
{ "chain": "solana", "destination": "<base58>", "amount": "25.5",
  "assetCode": "USDC", "assetIssuer": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }
// response → { chain: "solana", uri: "solana:<base58>?amount=25.5&spl-token=…&reference=…&memo=…", chainReference, qr, … }
```

### Solana और Monad पर wallet sign-in

`POST /v1/wallet/auth/finish` और `PUT /v1/wallet/backup` एक वैकल्पिक `chain` और खाता
`address` के रूप में लेते हैं; Stellar के लिए `stellarAddress` अब भी स्वीकार होता है,
और `chain` व `address` के साथ अब भी लौटाया जाता है। Solana या Monad खाता जिस challenge
पर हस्ताक्षर करता है उसमें पहली पंक्ति के बाद एक `chain: <chain>` पंक्ति होती है — एक
ही ed25519 कुंजी Stellar और Solana दोनों का पता है, और यह पंक्ति एक के लिए बने
हस्ताक्षर को दूसरे को खोलने से रोकती है — जबकि Stellar challenges byte-दर-byte नहीं
बदलते। Solana UTF-8 bytes पर ed25519 से हस्ताक्षर करता है (`signMessage`; base64 या
base58); Monad EIP-191 `personal_sign` से (0x-hex; high-s हस्ताक्षर अस्वीकार होते हैं)।
Monad पता अपनी EIP-55 वर्तनी में सहेजा जाता है। Recovery setup
(`POST /v1/wallet/recovery/setup`) केवल Stellar रहता है। खाते की
keys हर chain पर एक ही तरह जारी होती हैं (देखें
[कोई भी request developer platform पर निर्भर नहीं है](#कोई-भी-request-developer-platform-पर-निर्भर-नहीं-है))।

## साझा सार्वजनिक API key

open-source वॉलेट एक ऐसी API key के साथ आता है जो सब साझा करते हैं, ताकि कोई भी
रजिस्टर किए बिना swap कर सके, liquidity जोड़ सके या pay link बना सके। इन कॉल पर
`community` plan का कमीशन लगता है (50 bps, सबसे ऊँची दर); रजिस्टर करने पर कम दर
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
| `GET /v1/cross-chain-swaps/assets` \| `POST /v1/cross-chain-swaps/quote` | NEAR Intents की token list और एक dry quote; request के शुद्ध functions |
| `POST /v1/cross-chain-swaps` | Caller के अपने funds के लिए एक deposit address; दोहराया गया `Idempotency-Key` तभी जवाब पाता है जब request मेल खाए |
| `POST /v1/cross-chain-swaps/:id/deposit` | NEAR Intents को एक transaction दिखाता है जिसे वह खुद on-chain verify करता है; rate limited |
| `POST /v1/liquidity-pools/deposit` \| `withdraw` | unsigned envelopes बनाते हैं |
| `POST /v1/liquidity-pools/operations/:id/submit` | caller द्वारा signed envelope broadcast करता है, swap submit जैसी ही जाँच के तहत; rate limited |
| `GET /v1/liquidity-pools` \| `/:poolId` \| `/positions` | Horizon से पढ़ा गया सार्वजनिक on-chain डेटा |
| `POST /v1/payment-intents/tx` \| `pay` | request से एक SEP-7 intent बनाते हैं |
| `POST /v1/activity/events` | Telemetry ingest — नीचे देखें |
| `GET /v1/assets` | सार्वजनिक asset catalog |
| `GET /v1/aliases/resolve/:name` \| `availability/:name` \| `by-address/:address` | हैंडल resolve करने वाला payer ठीक वही anonymous caller है जिसके लिए यह key बनी है; जवाब request का शुद्ध function है और उसमें मालिक का mailbox कभी शामिल नहीं होता |

मना किए गए: `GET /v1/swaps`, `GET /v1/swaps/:id`, `GET /v1/cross-chain-swaps`, `GET /v1/cross-chain-swaps/:id`,
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

**Wallet इसे कहाँ से पाता है।** `GET /v1/public-key?env=dev|prod` बिना key और
बिना gateway secret के (`@Public()`) `{ env, apiKey }` लौटाता है, जो
`PUBLIC_API_KEY_DEV` / `PUBLIC_API_KEY_PROD` से आता है; जिस environment की key नहीं
है वह `503 misconfigured` लौटाता है। Key rotate करना इन variables को बदलना है — हर
wallet 5 मिनट के cache के भीतर नई key ले लेता है। इस path का APISIX route `key-auth`
नहीं चलाना चाहिए (कॉल करने वाले के पास अभी key नहीं है): इसे keyless route से serve
करें, जैसे `/v1/wallet/auth/oauth/callback/*`।

## कोई भी request developer platform पर निर्भर नहीं है

Developer platform developers के लिए API keys बनाता है और data दिखाता है। Client
जो कुछ भी करता है वह इससे होकर नहीं जाता: wallet और हर integration APISIX से बात
करते हैं, और APISIX इस सर्विस से। पहले ऐसा नहीं था, और platform — जो हिस्सा सबसे
ज़्यादा down होता है — हर sign-in को अपने साथ गिरा देता था:

| पहले platform से होकर जाता था | अब |
| --- | --- |
| Wallet का sign-in code भेजना | यह सर्विस भेजती है (`MAIL_FROM` + `MAIL_RESEND_API_KEY` / `MAIL_SMTP_*`) |
| Sign-in के अंत में wallet खाते की API keys जारी करना | यह सर्विस उन्हें APISIX में जारी करती है (`APISIX_ADMIN_URL`, `APISIX_ADMIN_KEY`) |
| किसी recovery server का email से भेजा code | हर recovery server अपना code खुद भेजता है (`RECOVERY_EMAIL_CODES=true` + अपना `MAIL_*`) |
| साझा public key (`/api/public-key`) | `GET /v1/public-key` |
| Asset catalog और anonymous telemetry (`/api/assets`, `/api/telemetry`) | Wallet public key के साथ `GET /v1/assets` और `POST /v1/activity/events` को कॉल करता है |

Platform जो अब भी करता है वह उसका अपना काम है: developers की keys, dashboard, और
`/v1/admin`, जिसे वह कॉल करता है — कभी उल्टा नहीं। अगर वह down है तो कोई developer
key नहीं बना सकता और dashboard नहीं खुलता; wallets हमेशा की तरह sign in, भुगतान और
swap करते हैं।

**Wallet keys.** पूरा हुआ sign-in consumer `cosmos_wallet_<accountId>` के तहत एक
`dev` और एक `prod` key पाता है, उन्हीं scopes, labels और consumer forwarder के साथ
जो पहले platform बनाता था (plan `community`, swap commission
`WALLET_KEY_SWAP_FEE_BPS`, डिफ़ॉल्ट 50 bps)। हर boot उन wallet consumers को फिर से बनाता है जिनमें अभी भी
कोई और दर है, इसलिए `WALLET_KEY_SWAP_FEE_BPS` का बदलाव अगले sign-in का इंतज़ार किए
बिना हर खाते तक तुरंत पहुँचता है। दूसरा sign-in नई जोड़ी जारी करने के
बजाय खाते के पास पहले से मौजूद keys लौटाता है। Response में `organizationId` खाते का
id है।

**Admin key सुरक्षा की कीमत है।** APISIX के पास अपनी admin key से छोटी कोई अनुमति
नहीं है, और वह हर route को दोबारा लिख सकती है। यहाँ का client केवल `cosmos_wallet_`
के तहत consumers लिखता है और request बनाने से पहले कोई भी दूसरा नाम अस्वीकार कर देता
है, लेकिन यह इस code का वादा है, APISIX का नहीं: `APISIX_ADMIN_KEY` को
`APISIX_GATEWAY_SECRET` की तरह रखें, इस सर्विस के pods को admin API तक network पहुँच
दें और उसके अलावा कुछ नहीं, और इसे कभी recovery server पर सेट न करें (boot मना कर
देता है)।

**इस बदलाव से पहले platform द्वारा provision किए गए खाते** अपनी मौजूदा keys के साथ
काम करते रहते हैं। अगले sign-in पर उन्हें `cosmos_wallet_<accountId>` के तहत नई keys
मिलती हैं, यानी नया consumer, इसलिए पुराने consumer (`cosmos_<platformUserId>`) के
तहत दर्ज history नई key से नहीं दिखती।

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
// rejected, outcome not on the ledger yet → { "submitted": false, "status": "SUBMITTED", "reason": "…", "resultCodes": ["tx_bad_seq"], "swap": { … } }
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

### Solana और Monad पर swaps (Jupiter, Kuru Flow)

`/v1/swaps` एक वैकल्पिक `chain` लेता है। इसके बिना — या `stellar` के साथ — हर
request का जवाब ठीक पहले जैसा ही मिलता है। `solana` [Jupiter](https://jup.ag) से
और `monad` [Kuru Flow](https://kuru.io) से होकर जाता है: ऐसे aggregators जो अपनी
chain के हर liquidity source को खोजते हैं, ताकि swap को किसी एक pool की कीमत के
बजाय उस chain की सबसे अच्छी दर मिले। Flow Stellar वाला ही है, शुरू से अंत तक
non-custodial:

```
POST /v1/swaps/quote {chain} → POST /v1/swaps {chain, source} → wallet signs `transaction`
  → POST /v1/swaps/{id}/submit {signedTransaction} → observer → SUCCEEDED / FAILED
```

- **Assets** native ticker (`SOL`, `MON`), `native`, या SPL mint / ERC-20 address
  होते हैं। Issuers, `memo` और अलग `destination` सिर्फ़ Stellar के लिए हैं और बाकी
  chains पर मना किए जाते हैं: output `source` को जाता है।
- **`transaction`** वह है जिस पर wallet sign करता है। Solana: एक unsigned
  VersionedTransaction (base64), लगभग एक मिनट तक valid, जब तक उसका blockhash
  expire न हो। Monad: `{ to, data, value, chainId }`, EIP-1559 transaction के रूप
  में signed, दो मिनट तक valid। Monad पर कम allowance के साथ ERC-20 बेचने पर
  `approval` भी मिलता है: वह सटीक `approve` call जिसे पहले भेजकर confirm करना है।
- **Submit** जाँचता है कि signed transaction वही है जो बनाई गई थी — Solana पर वही
  message bytes, Monad पर वही call — और `source` ने sign की है, फिर उसे इस service
  के अपने RPC से broadcast करता है। Node के मना करने पर `400 transaction_rejected`
  मिलता है और swap `PENDING` रहता है; सिर्फ़ chain का अपना फ़ैसला, जिसे observer
  पढ़ता है, उसे `SUCCEEDED` या `FAILED` बनाता है। बिना submit हुए या न दिखे swaps
  `EXPIRED` हो जाते हैं। Webhooks वही `SWAP_*` events हैं।
- **Commission:** plan की दर, Stellar की तरह, लेकिन aggregator इसे **output** से
  लेता है। Jupiter अपना `platformFeeBps` output mint के लिए `SOLANA_SWAP_FEE_WALLET`
  के token account में जमा करता है, जिसका होना ज़रूरी है — न होने पर
  `503 misconfigured` मिलता है, जिसमें बनाने वाले account का नाम होता है। Kuru Flow
  अपना `referrerFeeBps` `MONAD_SWAP_FEE_WALLET` को देता है।
- **सिर्फ़ mainnet**; `dev` key पर `400 network_unsupported`।
  `GET /v1/swaps?chain=solana` उस chain की list देता है; ids सभी chains में unique
  हैं, इसलिए `GET /v1/swaps/{id}` और submit किसी भी swap को ढूँढ लेते हैं।
- **Keys.** `KURU_API_KEY` के बिना Kuru Flow हर address के लिए एक token देता है जो
  प्रति सेकंड एक request तक सीमित है — आज़माने के लिए काफ़ी, production के लिए नहीं।
  Jupiter का बिना key वाला tier default है; `JUPITER_API_KEY` के साथ
  `JUPITER_BASE_URL` को `https://api.jup.ag/swap/v1` पर सेट करें।

## क्रॉस-चेन swaps (NEAR Intents)

Stellar, Solana और Monad **के बीच** swaps को
[NEAR Intents](https://intents.near.org/) अपनी 1Click API के ज़रिए settle करता है।
ऊपर के Stellar swaps की तरह ये भी **non-custodial** हैं: payer इनपुट को एक deposit
address पर भेजता है जिसे 1Click सिर्फ़ उसी एक quote के लिए derive करता है, और NEAR
Intents के solvers दूसरी chain पर recipient को आउटपुट चुकाते हैं — या payer को refund
करते हैं। दोनों में से कोई भी हिस्सा Cosmos Pay से होकर नहीं गुज़रता।

```
quote → create (deposit address + wallet link + QR) → payer sends the deposit
      → POST /deposit (optional) → observer polls 1Click → SUCCEEDED / REFUNDED / FAILED + webhook
```

**कौन-सा swap कहाँ जाता है।**

| जोड़ी | Settle करता है | क्यों |
| --- | --- | --- |
| Stellar → Stellar | `/v1/swaps` (Stellar DEX) | प्रोटोकॉल खुद native swap करता है; `/v1/cross-chain-swaps` `400` लौटाता है और वहीं भेजता है |
| Stellar ⇄ Solana ⇄ Monad | NEAR Intents | एक bridge चाहिए, और NEAR Intents वही bridge है |
| Solana → Solana, Monad → Monad | `chain` के साथ `/v1/swaps` (Jupiter, Kuru Flow) | हर aggregator सबसे अच्छी दर के लिए अपनी chain के हर liquidity source से route करता है; `/v1/cross-chain-swaps` `400` लौटाता है और वहीं भेजता है |

यह service हर chain पर खुद क्या करती है: 1Click की token list
(`GET /v1/cross-chain-swaps/assets`) के सामने assets resolve करती है, हर address को
उसकी अपनी chain के सामने validate करती है, उस chain के wallet standard — SEP-7 `pay`,
Solana Pay, EIP-681 — में deposit request बनाती है, Horizon पर जाँचती है कि Stellar
recipient उस asset पर trust रखता है जो उसे मिलने वाला है, और status को अपनी table
में mirror करती है।

**Commission.** Organization के plan की दर — Stellar swaps वाला वही भरोसेमंद
`X-Plan-Swap-Fee-Bps`, कभी request parameter नहीं — 1Click को एक `appFees` entry के
रूप में भेजी जाती है, जो `NEAR_INTENTS_FEE_RECIPIENT` (एक NEAR account) को चुकाई जाती
है। NEAR Intents इसे इनपुट से काटता है, quote किया गया आउटपुट पहले से इसके बाद का होता
है, और यह NEAR Intents के अंदर उसी account में जमा होती है, जहाँ से operator इसे
निकालता है। दर वाला plan जिसमें recipient configure न हो, मुफ़्त swap करने के बजाय
`503 misconfigured` लौटाता है।

**`NEAR_INTENTS_API_KEY` सेट करें।** 1Click बिना partner key के भी चलता है, लेकिन उसी
कीमत पर नहीं: इसके बिना (2026-09-30 को जाँचा गया) हर quote पर 1Click की अपनी 0.2% fee
लगती है, और `appFees` में माँगे गए commission का आधा हिस्सा
`NEAR_INTENTS_FEE_RECIPIENT` के बजाय 1Click को जाता है।

**सिर्फ़ mainnet.** NEAR Intents का कोई test network नहीं है। `dev` key assets list
कर सकती है और quote ले सकती है — कीमत वैसे भी mainnet की ही है — लेकिन
`POST /v1/cross-chain-swaps` `400 network_unsupported` लौटाता है: एक deposit address
असली पैसा ले लेता।

**Stellar deposits के साथ memo होता है।** 1Click हर Stellar deposit एक ही account पर
लेता है और उन्हें memo से अलग पहचानता है, इसलिए वहाँ `depositMemo` अनिवार्य है और
SEP-7 link इसे **`MEMO_TEXT`** के रूप में जोड़ता है — वही type जो उस account पर आने
वाले deposits में होता है। इसके बिना, या `MEMO_ID` के साथ भेजा गया deposit swap में
credit नहीं होता।

**Statuses.** `AWAITING_DEPOSIT` → `DEPOSIT_DETECTED` / `INCOMPLETE_DEPOSIT` →
`PROCESSING` → `SUCCEEDED`, `REFUNDED` या `FAILED`, जो अंतिम हैं। 1Click का अपना शब्द
`providerStatus` में रखा जाता है। जो swap अपनी deadline
(`CROSS_CHAIN_SWAP_DEADLINE_SECONDS`, default 30 मिनट) निकलने पर भी इंतज़ार कर रहा हो,
वह `EXPIRED` हो जाता है; बाद में आने वाला deposit NEAR Intents refund करता है, इसलिए
`EXPIRED` swap को एक दिन तक और poll किया जाता है और वह `REFUNDED` तक उसका पीछा करता
है। Observer settlement observer के साथ चलता है (`OBSERVER_ENABLED`,
`OBSERVER_INTERVAL_MS`); swap settle होने के लिए किसी wallet को वापस आने की ज़रूरत नहीं।
हर बदलाव `CROSS_CHAIN_SWAP_UPDATED`, `_EXPIRED`, `_SUCCEEDED`, `_REFUNDED` या `_FAILED`
emit करता है; आख़िरी तीन payment intents वालों की तरह durable और deduplicated हैं।

**`quoteSignature` संभालकर रखें।** यह quote और उसके deposit address पर 1Click का
signature है — NEAR Intents के साथ विवाद इसी से सुलझता है। पूरा signed quote server की
तरफ़ भी store किया जाता है।

**Limits.** Quote: प्रति मिनट 60 calls; create और deposit: 20-20, प्रति consumer और
client address (`429 rate_limited`)।

### क्रॉस-चेन swap routes

| Route | Scope | उद्देश्य |
| --- | --- | --- |
| `GET /v1/cross-chain-swaps/assets` | `swaps:read` | वे tokens जिन्हें NEAR Intents Stellar, Solana और Monad पर swap कर सकता है |
| `POST /v1/cross-chain-swaps/quote` | `swaps:read` | एक dry quote: आउटपुट, minimum, commission; कुछ भी persist नहीं करता |
| `POST /v1/cross-chain-swaps` | `swaps:write` | एक live quote: deposit address, memo, wallet link और QR; `Idempotency-Key` समर्थित |
| `GET /v1/cross-chain-swaps` | `swaps:read` | Consumer के क्रॉस-चेन swaps |
| `GET /v1/cross-chain-swaps/{id}` | `swaps:read` | एक swap, जैसा observer ने उसे आख़िरी बार देखा |
| `POST /v1/cross-chain-swaps/{id}/deposit` | `swaps:write` | Deposit transaction की सूचना दें ताकि NEAR Intents अपने indexer का इंतज़ार किए बिना शुरू करे |
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

### Recovery ईमेल से होकर जाती है, जिसे यही सर्विस भेजती है

Claim एक recovery ईमेल दर्ज करता है ताकि key खोने का मतलब नाम खोना न हो। Recovery
इस तरह काम करती है:

1. Wallet (`payments:write` वाली कोई भी key, साझा public key भी) `POST /v1/aliases/:name/recovery {email}`
   कॉल करता है। जवाब हमेशा `{ accepted: true }` होता है, चाहे handle और mailbox मेल खाएँ
   या नहीं; मेल खाने पर यह सर्विस दर्ज mailbox पर एक single-use token (30 मिनट, केवल
   SHA-256 के रूप में सहेजा गया) **ईमेल करती है**। Token कभी किसी जवाब में नहीं आता।
2. उपयोगकर्ता नई key के लिए एक `RECOVER` challenge लेता है और अपनी API key से
   `POST /v1/aliases/:name/recovery/complete {token, address, network, nonce, signature}`
   कॉल करता है। दोनों प्रमाण ज़रूरी हैं: token mailbox साबित करता है, signature key।
3. स्वामित्व कॉल करने वाले consumer के पास चला जाता है और **पिछले सभी पते हटा दिए
   जाते हैं**, ताकि पुरानी keys रखने वाले को भुगतान मिलना बंद हो जाए।

Recovery शुरू करना हर किसी के लिए खुला है क्योंकि token केवल mailbox तक पहुँचता है:
कोई अजनबी बस इतना कर सकता है कि मालिक को एक ईमेल मिले। इसकी दो सीमाएँ हैं — प्रति पता
हर 10 मिनट में 5 शुरुआत (`429 rate_limited`), और प्रति alias प्रति मिनट अधिकतम एक ईमेल,
चाहे कोई भी माँगे (उस मिनट के भीतर दोहराने पर जवाब वही रहता है और कुछ नहीं भेजा जाता)।
बिना mail sender वाला deployment `503 misconfigured` लौटाता है। निलंबित alias को recover
नहीं किया जा सकता।

एक recovery token **पाँच** बार प्रस्तुत किया जा सकता है। जिस प्रस्तुति में challenge या
signature विफल हो, वह भी एक प्रयास गिनी जाती है, और छठी बार मना कर दिया जाता है; मालिक
दूसरी recovery शुरू कर सकता है। जो token उस alias की किसी चालू recovery से मेल न खाए, उसे
वही `400 alias_recovery_invalid` मिलता है और कुछ नहीं बदलता, ताकि कोई भी junk भेजकर मालिक
की recovery न जला सके। `POST /v1/aliases/:name/recovery/complete` प्रति 10 मिनट 10 कॉल
और `POST /v1/aliases/challenges` 30 कॉल की अनुमति देता है, प्रति consumer और client
address (`429 rate_limited`)।

Expired challenges और recoveries को expire होने के एक दिन बाद
`AliasChallengeSweeperService` delete करता है (हर घंटे, प्रति tick एक replica)।

### Solana और Monad पर पते

एक alias Stellar खातों के साथ Solana और Monad खातों की ओर भी इशारा कर सकता है।
`POST /v1/aliases/challenges`, `POST /v1/aliases/{name}/addresses` और
`POST /v1/aliases/{name}/recovery/complete` एक वैकल्पिक `chain` लेते हैं; तब challenge
संदेश में एक `chain:` पंक्ति होती है, जो हस्ताक्षर को उस chain से बाँधती है। Stellar
अब भी framed digest पर हस्ताक्षर करता है; Solana challenge text पर ed25519 से, Monad
EIP-191 `personal_sign` से। डिफ़ॉल्ट पता हर chain और network के लिए अलग है, इसलिए
Solana पता जोड़ने से Stellar पता कभी नीचे नहीं होता। `GET /v1/aliases/resolve/{name}`
Stellar पर resolve करता है जब तक `?chain=` कोई दूसरी chain न बताए — जो wallet कोई chain
नहीं माँगता उसे कभी ऐसा पता नहीं मिलता जिस पर वह भुगतान न कर सके — और
`GET /v1/aliases/by-address/{address}` chain को पते के अपने रूप से पढ़ता है। Monad पता
अपनी EIP-55 वर्तनी में सहेजा और मिलाया जाता है।

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
| POST | `/v1/aliases/:name/recovery` | `payments:write` | recovery शुरू करना → token मालिक को ईमेल किया जाता है |
| POST | `/v1/aliases/:name/recovery/complete` | `payments:write` | token और नई key के signature के साथ recovery पूरी करना |

## BlindPay — onramp / offramp / KYC (fiat ⇄ stablecoin)

> **एक native plugin.** इस अनुभाग की हर चीज़ `blindpay` plugin
> (`src/native-plugins/blindpay/`) है, जो केवल तब दिया जाता है जब `PLUGINS_ENABLED`
> में `blindpay` हो — देखें *Native plugins: BlindPay और DeFindex*। BlindPay Stellar,
> Solana, EVM chains (Ethereum, Base, Arbitrum, Polygon) और Tron पर settle करता है;
> **Monad BlindPay का network नहीं है**, इसलिए उस पर कोई fiat on/off-ramp नहीं है।

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

**BlindPay से payin या payout बनवाने से पहले ही उसकी row दर्ज कर ली जाती है।**
`POST /v1/onramp/payins` और `POST /v1/offramp/payouts` पहले `pending_provider` में
एक row लिखते हैं जिसमें quote और उसकी execution key होती है, फिर उसी key को
`Idempotency-Key` बनाकर BlindPay को call करते हैं, और उसके बाद provider id भरते हैं।
इसलिए timeout, या call के बाद write का fail होना, एक row छोड़ता है — ऐसा भुगतान
नहीं जिसके बारे में यहाँ किसी को पता न हो: उसी quote के साथ वही create दोबारा करने
पर वही row इस्तेमाल होती है और key दोहराई जाती है, और BlindPay का webhook
`quote_id` से row भर देता है। Tenant reads ऐसी rows को तब तक नहीं दिखाते जब तक उनके
पास provider id न हो। एक घंटे बाद भी बिना id वाली row `provider_unconfirmed` बन
जाती है और operator के लिए log होती है — create दोबारा कुछ नहीं भेजता, क्योंकि
caller ने इस बीच किसी दूसरे quote से भुगतान कर दिया हो सकता है। BlindPay का इनकार
(408 और 409 को छोड़कर कोई भी 4xx) row को हटा देता है।

**जिस webhook से कोई row मेल नहीं खाती, उसे छोड़ा नहीं जाता।** Payin या payout
event को उस quote के ज़रिए attribute किया जाता है जिसे उसने execute किया — उस
consumer को जिसने वह quote बनाया था — और mirror वहीं बनाया या ठीक किया जाता है।
जो event फिर भी attribute नहीं हो पाता उसे acknowledge किया जाता है पर खुला रखा
जाता है, और BlindPay reconciler (`OBSERVER_ENABLED` के साथ चालू, हर मिनट, एक समय
में एक ही replica पर) उसे सात दिनों तक BlindPay से दोबारा पढ़ता है, और हर असफल
प्रयास पर उसका `svix-id` log करता है ताकि delivery को Svix dashboard से फिर से
भेजा जा सके। यही reconciler उन खुले payins और payouts को भी दोबारा पढ़ता है जिनके
webhooks आने बंद हो गए, और उनका status ठीक करता है। `PAYIN_COMPLETED` और
`PAYOUT_COMPLETED` हर payin या payout के लिए एक ही बार भेजे जाते हैं, चाहे completion
पहले कोई भी रास्ता देखे — webhook, नए `svix-id` के साथ दोबारा भेजा गया event, या
reconciler।

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

## Plugins — एक slug के तहत extensions

दूसरी टीमें अपनी technology को इस service में एक **plugin** के रूप में जोड़ती हैं:
`plugins/` में एक folder, जो `/v1/plugins/<slug>/…` पर serve होता है और किसी tenant के
customers, products और payment intents के साथ काम करता है — core को कभी सीधे छुए बिना।
लक्ष्य यह है कि plugin गलत हो सकता है — bugs वाला, धीमा, लालची — बिना core के उसके साथ
गलत हुए।

### Plugin एक folder है

सभी plugins **एक ही folder** में रहते हैं, repository की root में `plugins/` — वे जो
Cosmos Pay support देता है और वे जो कोई operator install करता है। एक plugin तीन पढ़ने
योग्य files है, और कोई भी तब तक नहीं चलता जब तक उसका slug `PLUGINS_ENABLED` में न हो:

```
plugins/
  README.md
  example/
    plugin.json       what the plugin is, and what it may touch
    index.ts          what it does — plain TypeScript, no build step
    signature.json    who vouches for the two files above
```

`plugin.json` बताता है कि plugin क्या है और क्या छू सकता है — reviewer और tenant सबसे पहले यही पढ़ते हैं:

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

`index.ts` code है: सामान्य TypeScript, service शुरू होने पर transpile होता है। इसका एकमात्र import SDK है (`@/plugins/sdk`):

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

`example` preinstalled और disabled है: एक reference plugin जो एक query, एक command, एक
event और एक tenant setting इस्तेमाल करता है। वहीं से शुरू करें।

### एक लिखना

```sh
npm run plugins -- new my-plugin          # plugins/my-plugin/ from a template
npm run plugins -- check my-plugin        # compile, load and validate it
PLUGINS_ENABLED=my-plugin PLUGINS_ALLOW_UNSIGNED=true npm run start:dev
npm run plugins -- sign my-plugin --key support.pem --key-id cosmos-support
```

`check` plugin को compile करता है और हर वह validation चलाता है जो server boot पर चलाता
है। `PLUGINS_ALLOW_UNSIGNED=true` local काम के दौरान इसे बिना signature चलने देता है, और
`NODE_ENV=production` में मना होता है। Folder के साथ pull request खोलें; review के बाद
support उसे sign करता है और वह preinstalled भेजा जाता है।

Sign करना कभी plugin का code नहीं चलाता — केवल `check` चलाता है, और CI उसे हर pull
request पर चलाता है — इसलिए कोई pull request अपना code उस machine पर नहीं चलवा सकता
जिस पर support key है। वही sign करें जो review और CI पहले ही पास कर चुके हैं।

### Plugin क्या पहुँच सकता है और क्या नहीं

Plugin के handlers को एक `PluginContext` मिलता है और कुछ नहीं — न Prisma, न Nest provider,
न `process.env`, न socket:

| `ctx.` | पहुँचता है | सीमा |
| ------ | ---------- | ---- |
| `storage` | plugin के अपने records (`plugin_record`), केवल इसी installation के | प्रति value 16 KiB, प्रति installation 10 000 records |
| `core.customers`, `core.products` | list / get / create / update, core की अपनी services और DTOs के ज़रिए | दी गई capability (`customers:read`, `customers:write`, …); delete है ही नहीं |
| `core.paymentIntents` | list / get, केवल पढ़ना | `payment_intents:read`; sign करने या पैसा हिलाने वाला कुछ नहीं |
| `http` | port 443 पर HTTPS, `egress` के hosts तक | केवल public addresses (webhook के SSRF नियम), socket जाँचे गए address पर pinned, कोई redirect नहीं, 1 MiB responses |
| `installation.config` | tenant की settings; secret वाली केवल इसी call के लिए decrypt | — |

हर invocation के आसपास runtime क्या guarantee करता है:

- **Tenant isolation.** Context को call करने वाले consumer और उसकी installation से बनाया
  जाता है; कोई method consumer या installation id नहीं लेता।
- **Projections, rows नहीं.** Core reads एक fixed projection के रूप में आते हैं — न
  `consumerId`, न `xdr`/`uri`, न provider payloads — copy और frozen।
- **Core का validation लागू रहता है.** Writes उन्हीं DTOs से गुज़रते हैं जिनसे HTTP routes
  validate करते हैं; अज्ञात fields refuse होते हैं।
- **Queries write नहीं कर सकतीं.** एक query `plugins:read` से call हो सकती है, इसलिए उसके
  अंदर हर storage और core write refuse होता है।
- **Budgets.** प्रति invocation 10 s, 200 context calls, 64 KiB input, 256 KiB output।
  समय खत्म होने पर caller को `504 plugin_failed` मिलता है और context revoke हो जाता है,
  ताकि चलता छोड़ा गया काम बाद में write न कर सके।
- **Failures सीमित रहते हैं.** `PluginError` उसके message के साथ `400 plugin_rejected`
  बनता है; बाकी सब `502 plugin_failed`, log होता है और कभी लौटाया नहीं जाता। किसी event
  पर fail होने वाला plugin न उस event के webhook को बिगाड़ता है, न दूसरे plugins को।
- **Isolation.** Plugin का code कभी इस process में नहीं चलता। हर invocation को एक नया
  V8 isolate (`isolated-vm`) मिलता है जिसमें Node का कुछ नहीं — न `process`, न `require`,
  न network, न file system, न timers — 32 MB heap और अपना thread। बाहर निकलने का इसका
  एकमात्र रास्ता एक bridge है जो ऊपर के context method names स्वीकार करता है, आने-जाने
  में JSON copies के साथ; इस process का कोई object कभी उस तक नहीं पहुँचता, इसलिए बचने के
  लिए लिखे गए code को चढ़ने के लिए कुछ नहीं मिलता। Budget खत्म होने पर isolate dispose हो
  जाता है, जो plugin को जहाँ भी हो रोक देता है — synchronous loop समेत — और memory में
  रखा कुछ भी अगली call तक नहीं बचता, किसी दूसरे tenant की call तक भी नहीं। इसके अलावा
  ESLint `plugins/**/*.ts` को केवल SDK import करने देता है।

### Plugin की ज़िम्मेदारी कौन लेता है

Plugin तभी चलता है जब किसी भरोसेमंद key ने ठीक उसका `plugin.json` और `index.ts`, उसके
slug और version के साथ sign किया हो (`signature.json`)। Code का एक अक्षर या एक capability
बदलें और signature fail होता है — boot रुक जाता है। `plugin.json` की formatting और line
endings बदलाव नहीं गिने जाते।

- **Support द्वारा preinstalled.** Support की public keys code में हैं
  (`PLUGIN_SUPPORT_KEYS`), इसलिए support द्वारा sign किया और `plugins/` में commit किया
  गया plugin किसी भी deployment पर बिना configuration load होता है। `plugins/`
  `.github/CODEOWNERS` में है, और CI जाँचता है कि उसका हर folder signed और valid है।
- **हाथ से install किया गया.** बाकी सब एक registry — कोई भी static HTTPS host — से install
  होता है और support या `PLUGINS_TRUSTED_KEYS` की किसी key से signed होना चाहिए:

```sh
npm run plugins -- install acme@1.0.0 --registry https://plugins.example.com
# then add "acme" to PLUGINS_ENABLED and restart
```

Registry पर भरोसा नहीं किया जाता: `install` कुछ भी लिखने से पहले signature जाँचता है,
और server हर boot पर फिर जाँचता है।

### Install करना सहमति है

कोई plugin किसी tenant के लिए तभी चलता है जब वह tenant उसे
`PUT /v1/plugins/{slug}/installation` से install करे, और `grantCapabilities` ठीक
`plugin.json` की list के बराबर भेजे — न subset, न superset (`400 plugin_consent_mismatch`)।
अगर बाद का version ज़्यादा declare करता है, तो installation अपनी पुरानी सहमति रखती है और हर
action `409 plugin_not_installed` लौटाता है जब तक tenant फिर से install न करे
(`installation.pendingCapabilities` अंतर दिखाता है)। Uninstall करने पर उस tenant के लिए
plugin के सभी records delete हो जाते हैं। `secret` चिह्नित settings `PLUGINS_SECRET` से
seal होती हैं और कभी लौटाई नहीं जातीं।

### Plugin routes

| Method | Path | उद्देश्य |
| ------ | ---- | -------- |
| GET | `/v1/plugins` | यह deployment जो plugins serve करता है, caller की installations के साथ |
| GET | `/v1/plugins/{slug}` | एक plugin: capabilities, egress, settings, actions, installation |
| PUT | `/v1/plugins/{slug}/installation` | Install, फिर से सहमति या reconfigure |
| DELETE | `/v1/plugins/{slug}/installation` | Uninstall, plugin के records delete करते हुए |
| POST | `/v1/plugins/{slug}/queries/{action}` | केवल पढ़ने वाला action चलाएँ (`plugins:read`) |
| POST | `/v1/plugins/{slug}/commands/{action}` | Write करने वाला action चलाएँ (`plugins:write`) |

कोई plugin route साझा public API key स्वीकार नहीं करता: plugin एक ही tenant के data पर
काम करता है। दोनों action routes प्रति consumer प्रति मिनट 120 requests का budget साझा
करते हैं।

### Native plugins: BlindPay और DeFindex

कुछ integrations स्वयं chain नहीं हैं — एक fiat प्रदाता, एक DeFi protocol — और उन्हें
वह चाहिए जो sandbox जानबूझकर नहीं देता: अपनी tables, आने वाले webhooks, पूरे deployment
के credentials। ये **native plugins** हैं: `src/native-plugins/<slug>/` के अंतर्गत सेवा
में compile किए गए Nest modules, जिन्हें sandboxed plugins वाली उसी `PLUGINS_ENABLED`
सूची से चालू किया जाता है।

| Slug | क्या देता है |
| ---- | ------------ |
| `blindpay` | KYC, onramp, offramp, BlindPay webhook, उसके `/v1/admin` routes (`receivers`, `payins`, `payouts`) और admin summary का `fiat` अनुभाग |
| `defindex` | `/v1/defindex` — Stellar पर DeFindex vaults |

- **सूची में नहीं, तो मौजूद नहीं।** जिस native plugin का नाम `PLUGINS_ENABLED` में नहीं
  है वह कभी instantiate नहीं होता: उसके routes 404 लौटाते हैं, उसके jobs कभी शुरू नहीं
  होते और उसके variables validate नहीं होते। जब उसकी कुंजियाँ सेट हों पर slug नहीं, तो
  boot चेतावनी देता है।
- **Core कभी plugin import नहीं करता।** Lint `src/` में कहीं भी `@/native-plugins/*`
  अस्वीकार करता है, सिवाय `src/native-plugins/native-plugins.module.ts` के, और एक plugin
  को दूसरे को import करने से रोकता है। जहाँ core को plugin का डेटा चाहिए — admin overview
  — वहाँ वह एक extension point (`AdminExtensions`) देता है जिसमें plugin register होता है।
- **न sandboxed, न प्रति tenant।** Native plugin core के अधिकारों वाला reviewed code है;
  वह प्रति tenant install नहीं होता, और उसके routes अपने scopes रखते हैं (`kyc:*`,
  `onramp:*`, `offramp:*`, `liquidity:*`)। कोई sandboxed plugin native slug नहीं ले सकता।
- **OpenAPI contract हर native plugin के routes का दस्तावेज़ रखता है**, चालू हो या नहीं:
  `openapi:generate` सभी को चालू करता है।

## अपग्रेड — breaking changes और deploy नोट्स

### `X-Cosmos-Internal` में gateway secret का MAC होना ज़रूरी है

- **केवल `X-Cosmos-Internal: 1` अस्वीकार किया जाता है।** `/v1/admin` इसका जवाब `403 admin_console_only` से देता है, और caller को अब कहीं भी internal नहीं माना जाता: उस पर per-consumer rate limits लागू होते हैं, और request log में उसकी rows चिह्नित नहीं होतीं। header में अब `v1.<unix seconds>.<hex>` होता है — `APISIX_GATEWAY_SECRET` से keyed एक HMAC-SHA256, जो सर्वर की घड़ी से पाँच मिनट के भीतर स्वीकार होता है (`src/admin/console-marker.ts`)।
- **जो ops scripts `/v1/admin` को सीधे कॉल करती हैं, उन्हें हर कॉल पर marker बनाना होगा।** नीचे `ADMIN_API_CREDENTIALS` वाली entry के अंत में दिया `openssl` + `curl` snippet यही करता है।
- **सर्विस और developer platform को एक साथ deploy करें।** marker अब कंसोल बनाता है। इस सर्विस के सामने पुराना कंसोल हर admin कॉल पर `403` पाता है; पुरानी सर्विस के सामने नया कंसोल काम करता रहता है, क्योंकि पुरानी सर्विस `0`, `false`, `no` और `off` के अलावा कोई भी मान स्वीकार करती है। अगर दोनों एक साथ नहीं जा सकते, तो पहले developer platform deploy करें।
- **कोई नया environment variable नहीं।** MAC `APISIX_GATEWAY_SECRET` से keyed है, जिसे सर्विस और कंसोल पहले से साझा करते हैं।

### Receiver फ़ील्ड और admin सूची queries अब अधिक सख़्त

- **`POST /v1/kyc/receivers` और `PUT /v1/kyc/receivers/{id}` ग़लत रूप वाले पहचान फ़ील्ड को `400` से अस्वीकार करते हैं।** `country` और `id_doc_country` (शीर्ष स्तर पर और `owners[]` में) बड़े अक्षरों में ISO 3166-1 alpha-2 कोड होने चाहिए (`US`, `us` या `USA` नहीं); `date_of_birth` (शीर्ष स्तर पर और `owners[]` में) और `formation_date` offset वाले ISO 8601 date-time होने चाहिए (`1985-04-12T00:00:00.000Z`, `1985-04-12` नहीं); `owners[].ownership_percentage` 0 से 100 के बीच की संख्या होनी चाहिए; `website` credentials के बिना एक absolute `http`/`https` URL होना चाहिए। पहले इनमें से हर एक जैसा लिखा गया वैसा ही सहेजा जाता था और समीक्षा के बाद, receiver को enable करते समय ही BlindPay पर विफल होता था।
- **`/v1/admin` सूची queries अब validate होती हैं।** उस सूची के लिए अज्ञात `status`, 1–200 से बाहर `take`, ऋणात्मक `skip` या ऐसा parameter जिसे route स्वीकार नहीं करता, अब `400` है; पहले अमान्य `status` database तक पहुँचकर `500` के रूप में लौटता था। Defaults नहीं बदले (`take=50`, `skip=0`)।
- **Receivers, payins और payouts के admin reads अब फ़ील्ड की एक स्पष्ट सूची लौटाते हैं।** फ़ील्ड वही हैं जो पहले लौटते थे; इन tables में बाद में जोड़ा गया column तब तक नहीं लौटेगा जब तक उसे सूची में न जोड़ा जाए।

### BlindPay: provider call से पहले rows, और हर भुगतान के लिए एक ही completion

- **Migration `20261006120000_blindpay_pending_rows`** `payin.blindpayId` और
  `payout.blindpayId` को nullable बनाता है, दोनों में `executionKey` (unique) और
  `lastCheckedAt` जोड़ता है, और `blindpay_webhook_event` में `environment`,
  `blindpayId`, `appliedAt` और `lastAttemptAt` जोड़ता है। मौजूदा delivery rows को
  applied चिह्नित किया जाता है।
- **किसी response का आकार नहीं बदलता।** जो rows अभी provider id का इंतज़ार कर रही
  हैं (`pending_provider`, `provider_unconfirmed`) उन्हें tenant routes नहीं लौटाते;
  admin lists `/v1/admin/payins` और `/v1/admin/payouts` उन्हें `blindpayId: null` के
  साथ दिखाती हैं।
- **`PAYIN_COMPLETED` और `PAYOUT_COMPLETED` deduplicate होते हैं**, बाकी terminal
  events की तरह: नए `svix-id` के साथ दूसरी completion अब नए `evt_` वाला दूसरा event
  नहीं बनाती। BlindPay के बाकी events तभी दोबारा भेजे जाते हैं जब row सच में बदली हो।
- **BlindPay reconciler settlement observer के साथ चलता है** (`OBSERVER_ENABLED`);
  observer बंद करने से यह भी बंद हो जाता है।

### Payment intents: एक transaction सभी tenants में केवल एक intent को settle करता है

- **Migration `20261006130000_payment_settlement`** `payment_settlement` जोड़ता है और हर SUCCEEDED intent से उसे backfill करता है। जहाँ एक hash पहले ही कई intents को settle कर चुका है, वहाँ सबसे पुराना intent claim रखता है; migration फ़ाइल में वह query है जो बाकी intents को समीक्षा के लिए सूचीबद्ध करती है।
- **जो transaction पहले ही किसी payment intent को — किसी भी consumer के — settle कर चुका है, वह अब दूसरे को settle नहीं करता।** `POST /v1/payment-intents/{id}/validate` और `status: SUCCEEDED` के साथ `PATCH /v1/payment-intents/{id}` `409 transaction_already_settled` लौटाते हैं और intent को जैसा था वैसा छोड़ देते हैं। Destination किसी consumer से बंधा नहीं है और memo caller चुनता है, इसलिए कोई दूसरा tenant — या shared public key के तहत कोई भी caller — किसी intent की हूबहू नकल कर सकता था और उसके payer के transaction से settle हो सकता था। Observer ऐसे match को भुगतान नहीं मानता: intent PENDING रहता है और बिना भुगतान के expire होता है।
- **भुगतान उस सबसे पुराने intent को जाता है जिसे वह pay करता है।** जब transaction किसी दूसरे consumer के पुराने intent को भी pay करता है, तो intent को वही `409 transaction_already_settled` मिलता है, इसलिए original के बाद बनी copy हार जाती है, भले ही उसका settlement पहले चले, और original अपने अगले pass पर settle होता है। Original से *पहले* बनी copy जीतती है, लेकिन केवल तब तक जब तक वह खुली है: EXPIRED intent किसी से ऊपर नहीं होता, इसलिए copy के expire होते ही original settle हो जाता है। ऐसी copy बनाने के लिए original का memo पहले से पता होना चाहिए, इसलिए order numbers जैसे अनुमान लगाने योग्य memo भेजने के बजाय memo इस सेवा को बनाने दें (`memo` छोड़ दें)। इस नियम का दूसरा पहलू: original के expire होने के बाद आया भुगतान किसी नई copy को जा सकता है जो expire नहीं हुई है। Monad पर यह उस copy को भी कवर करता है जिसका भुगतान किसी दूसरे intent के deposit address पर हुआ, जिसे relayer के forward ने अलग hash से settle किया। Settlement को केवल वही rival मना करता है जिसके भुगतान की पुष्टि chain करती है, rivals की गिनती कभी नहीं, और rival को वही भुगतान बताना चाहिए (Stellar पर memo, destination, asset और amount)। **Relayer के बिना Monad अपवाद है:** direct भुगतान में intent का अपना कुछ नहीं होता — destination, token और amount सार्वजनिक हैं — इसलिए एक ही address और amount वाले दो direct-mode intents में भेद नहीं किया जा सकता और उन्हें उम्र से क्रम नहीं दिया जाता; जो पहले settle होता है वही भुगतान लेता है। Monad पर relayer के deposit addresses और Stellar पर सेवा द्वारा बनाए गए memos का उपयोग करें।
- **`DELETE /v1/payment-intents/{id}` `409 operation_in_flight` लौटाता है** जब intent का status उसे पढ़ने और delete करने के बीच बदल जाता है, आमतौर पर इसलिए कि उसका अभी भुगतान हुआ है। पहले वह फिर भी delete हो जाता था।

### Wallet साइन-इन: रिकवर किए गए wallet के signers अब `STELLAR_NETWORK` का पालन करते हैं

- **`WALLET_AUTH_SIGNERS_HORIZON_URL` अब डिफ़ॉल्ट रूप से `STELLAR_NETWORK` के Horizon का उपयोग करता है** (`STELLAR_HORIZON_URL_PUBLIC` / `STELLAR_HORIZON_URL_TESTNET`, वरना SDF का), हमेशा पब्लिक नेटवर्क का नहीं। इसे तब पढ़ा जाता है जब SEP-30 से रिकवर किया गया wallet `POST /v1/wallet/auth/finish` को उस key से साइन करता है जिसने उसकी master key की जगह ली। testnet deployment पर यह lookup mainnet पर जाता था, खाता नहीं मिलता था, और हर रिकवर किए गए wallet का साइन-इन `400 wallet_signature_invalid` लौटाता था।
- **`WALLET_RECOVERY_SPONSOR_NETWORK_PASSPHRASE` और `WALLET_RECOVERY_SPONSOR_HORIZON_URL` भी इसका पालन करते हैं**, ताकि sponsor उसी ledger पर खाता पढ़े।
- **Deploy चरण:** `STELLAR_NETWORK` का डिफ़ॉल्ट `testnet` है। जो deployment mainnet wallets को सर्व करता है और इसे सेट नहीं करता (API keys हर request पर नेटवर्क चुनती हैं), उसे अब `STELLAR_NETWORK=public`, या ये तीनों वेरिएबल, स्पष्ट रूप से सेट करने होंगे। वरना रिकवर किए गए mainnet wallets साइन-इन नहीं कर पाएँगे, और कॉन्फ़िगर किया गया sponsor testnet transactions बनाएगा।
- **हमेशा सिर्फ़ एक ledger पढ़ा जाता है।** दोनों को जाँचने से दूसरे नेटवर्क पर उसी address में जोड़ी गई key इस नेटवर्क के लिए साइन कर सकती।

### वॉलेट बैकअप: ईमेल से रिकवरी का दरवाज़ा, दोनों रिकवरी सर्वरों के पास

- **माइग्रेशन `20261004120000_recovery_backup_shares`** `recovery_backup_share` जोड़ता है। इसे केवल
  रिकवरी सर्वर (`RECOVERY_ROLE`) लिखता है; माइग्रेशन दोनों पर चलाएँ।
- **रिकवरी सर्वरों पर नए रूट:** `PUT`, `GET` और `DELETE /v1/sep30/shares/{address}`, बाकी SEP-30 की
  तरह `@Public()`, और उसी बिना-key वाले रूट से परोसे जाते हैं। वॉलेट एक रैंडम key को दो हिस्सों में
  बाँटता है, खाते के SEP-10 टोकन से हर सर्वर को एक हिस्सा देता है, और बैकअप की डेटा key को पूरी key
  के नीचे `recovery` दरवाज़े के रूप में सील करता है। दोनों सर्वरों के सामने ईमेल साबित करने पर
  (Authentik का ID टोकन, या हर सर्वर का अपना ईमेल कोड) दोनों हिस्से वापस मिलते हैं: बैकअप खुल जाता है
  और व्यक्ति नया पासवर्ड रखता है। सीड — और हर चेन का पता — बचा रहता है, SEP-30 के विपरीत, जो केवल
  Stellar खाता वापस लाता है।
- **इससे जुड़ने वाला भरोसा:** अकेले एक सर्वर के पास केवल रैंडम शोर है। दोनों सर्वर मिलकर, या जो
  इनबॉक्स पर नियंत्रण रखता है और दोनों सर्वरों से उसे स्वीकार करवा लेता है, इस दरवाज़े वाला बैकअप खोल
  सकते हैं। दोनों को अलग इंफ्रास्ट्रक्चर पर और अलग `MAIL_*` प्रेषकों के साथ चलाएँ, जैसा SEP-30 पहले से
  माँगता है।
- **`GET /v1/sep30/shares` (बिना पते के) सिद्ध इनबॉक्स के अंतर्गत दर्ज हर आधा हिस्सा सूचीबद्ध करता है**,
  `GET /v1/sep30/accounts` की तरह `after` से पेज किया हुआ। जिसने एक ही ईमेल से कई वॉलेट का बैकअप लिया है,
  वह सबका पासवर्ड एक साथ भूलता है; अब हर सर्वर पर एक प्रमाण सिर्फ़ सबसे नए नहीं, बल्कि हर बैकअप को वापस लाता है।
  केवल पहचान टोकन से: किसी खाते का SEP-10 टोकन `403` पाता है, क्योंकि वह अपना एक हिस्सा पहले से पते से पा लेता है।
- **`isBackupBox` एक `v: 4` बॉक्स में एक `recovery` स्लॉट स्वीकार करता है**, कम से कम एक पासवर्ड या
  passkey स्लॉट के साथ। ऐसा बॉक्स अस्वीकार होता है जिसका एकमात्र दरवाज़ा `recovery` हो।
- **रिकवरी सर्वर का ईमेल कोड** अब उस इनबॉक्स को भी जाता है जिसके पास वहाँ केवल एक बैकअप हिस्सा है।

### Solana और Monad पर swaps: `/v1/swaps` पर `chain`, और एक नई table

- **Migration `20261003120000_chain_swaps`** `chain_swap` table जोड़ता है। मौजूदा कुछ
  नहीं बदलता: `chain` के बिना `/v1/swaps` byte-दर-byte पहले जैसा ही जवाब देता है।
- **`/v1/swaps` `chain` लेता है** (`stellar` | `solana` | `monad`) quote और create
  bodies में, और list में query parameter के रूप में। Solana और Monad के लिए create,
  एकल read और submit एक `ChainSwapEntity` लौटाते हैं (contract में `oneOf`)।
- **`POST /v1/swaps/{id}/submit`:** `signedTransaction` भेजने पर `signedXdr` अब
  अनिवार्य नहीं है। Stellar swap को इसकी अब भी ज़रूरत है, उसी message के साथ।
- **`/v1/cross-chain-swaps` अब एक ही chain वाली हर जोड़ी मना करता है** — पहले यह
  Solana → Solana और Monad → Monad को NEAR Intents से quote करता था — और `/v1/swaps`
  की ओर भेजता है।
- **Solana या Monad node का broadcast मना करना अब `400 transaction_rejected` है**,
  `502 provider_error` नहीं। इसमें Monad deposit forwarder का relayer भी शामिल है,
  जो पहले की तरह log करके दोबारा कोशिश करता है।
- **चालू करने से पहले:** `SOLANA_SWAP_FEE_WALLET` सेट करें और हर अपेक्षित output mint
  के लिए उसका token account बनाएँ, `MONAD_SWAP_FEE_WALLET` सेट करें, और production
  volume के लिए `KURU_API_KEY` लें।

### क्रॉस-चेन swaps: एक नया module, एक नई table और छह webhook events

- **Migration `20261002120000_cross_chain_swaps`** `cross_chain_swap` table जोड़ता है
  और `WebhookEventType` में छह values जोड़ता है: `CROSS_CHAIN_SWAP_CREATED`,
  `_UPDATED`, `_SUCCEEDED`, `_REFUNDED`, `_FAILED`, `_EXPIRED`। मौजूदा कुछ भी दोबारा
  नहीं लिखा जाता।
- **`/v1/cross-chain-swaps` के तहत नए routes**, जो `swaps:read` / `swaps:write`
  scopes दोबारा इस्तेमाल करते हैं; साझा public key assets, quote, create और deposit तक
  पहुँचती है, दोनों reads तक कभी नहीं।
- **चालू करने से पहले:** `NEAR_INTENTS_FEE_RECIPIENT` (एक NEAR account) सेट करें,
  वरना commission वाला हर plan `503 misconfigured` लौटाएगा, और `NEAR_INTENTS_API_KEY`
  सेट करें, वरना 1Click अपनी fee जोड़ता है और commission का आधा रख लेता है।
- **`provider_error` अब `400` भी है**: NEAR Intents का quote ठुकराना ("amount is too
  low for bridge") ऐसी चीज़ है जिसे caller बदल सकता है, इसलिए यह 1Click के कारण के साथ
  `400 provider_error` के रूप में आता है, जैसा BlindPay के 4xx के साथ पहले से होता था।
### Wallet backups: Argon2id और at-rest encryption

- **Deploy से पहले `WALLET_BACKUP_ENCRYPTION_KEY` सेट करें** (`openssl rand -base64 32`);
  इसके बिना sign-in door होने पर boot मना कर देता है। हर सहेजा गया box इससे दोबारा
  एन्क्रिप्ट होता है (AES-256-GCM, अपने `chain:address` से बंधा), इसलिए database का dump,
  replica या backup किसी के backup की कॉपी नहीं है। फिर एक बार **`npm run backups:reencrypt`**
  चलाएँ: यह पहले लिखी गई rows को एन्क्रिप्ट करता है। Rotation: पुरानी key को
  `WALLET_BACKUP_ENCRYPTION_PREVIOUS_KEYS` में ले जाएँ, नई सेट करें, script चलाएँ, पुरानी हटाएँ।
- **`v: 4` boxes स्वीकार होते हैं**: v3 का slot आकार, Argon2id password door के साथ
  (`kdf: "argon2id"`, `m` ≥ 19 MiB, `t` ≥ 2)। Wallet हर नया backup v4 (64 MiB, 2 passes) में
  सील करता है और restore करते समय केवल-password v2/v3 box को v4 में दोबारा सील करता है।
  v2 और v3 अब भी स्वीकार और दिए जाते हैं।
- **Wallet 12 अक्षरों का password माँगता है** जो आम न हो; मौजूदा passwords बदले जाने तक
  काम करते रहते हैं।
- **Database को खुद** storage स्तर पर encryption (disk / volume), एन्क्रिप्टेड backups और
  केवल इस सर्विस तक सीमित पहुँच चाहिए: at-rest key backup column की रक्षा करती है, बाकी
  rows की नहीं।

### Wallet backups: हर wallet का एक, login पर सभी restore

- **Migration `20261001120000_wallet_backups_per_wallet`** प्रति खाता एक backup के नियम को
  खाते के भीतर प्रति `(chain, address)` एक backup में बदलता है। मौजूदा rows जैसी हैं वैसी
  रहती हैं।
- **`POST /v1/wallet/auth/oauth/claim` और `email/verify` अब `backups` लौटाते हैं**, खाते के
  सभी boxes, सबसे नया पहले। `backup` उनमें से सबसे नया बना रहता है और deprecated है।
- **किसी दूसरे wallet के `backup` के साथ `POST /v1/wallet/auth/finish` उसे जोड़ देता है**; अब
  `backup_conflict` नहीं लौटाता। उसी wallet का box अपना box बदल देता है। `replaceBackup`
  स्वीकार किया जाता है और अनदेखा होता है। प्रति खाता अधिकतम 20 wallets; 21वाँ
  `400 wallet_backup_limit` है।

### Developer platform request path से बाहर

- **हटाए गए variables:** `WALLET_AUTH_CONSOLE_URL`, `WALLET_AUTH_CONSOLE_SECRET`,
  `RECOVERY_EMAIL_DELIVERY_URL`, `RECOVERY_EMAIL_DELIVERY_SECRET`। इन्हें अनदेखा किया
  जाता है।
- **Email door को अब चाहिए** `MAIL_FROM` + `MAIL_RESEND_API_KEY` / `MAIL_SMTP_*` (Resend पर verified
  sender) **और** `APISIX_ADMIN_URL` + `APISIX_ADMIN_KEY`। दोनों के बिना
  `GET /v1/wallet/auth/providers` `email: false` बताता है; provider से sign-in फिर भी
  callback पूरा करता है, लेकिन admin जोड़ी सेट होने तक `POST /v1/wallet/auth/finish`
  `503 misconfigured` लौटाता है। हर जोड़ी साथ में सेट होती है, वरना boot मना कर देता
  है।
- **जो recovery server email से codes भेजता था** वह `RECOVERY_EMAIL_CODES=true` और
  अपना `MAIL_*` सेट करता है। Recovery server पर `APISIX_ADMIN_KEY` boot रोक देता है।
- **नया route `GET /v1/public-key`** (`@Public()`), `PUBLIC_API_KEY_DEV` /
  `PUBLIC_API_KEY_PROD` से: public key के लिए platform ने जो values जारी कीं उन्हें
  कॉपी करें। Path को APISIX के keyless route में जोड़ें (बिना `key-auth`), वरना wallets
  को `401` मिलेगा।
- **Wallet keys अब `cosmos_wallet_<accountId>` के तहत रहती हैं**; platform द्वारा
  provision किए गए खातों के लिए ऊपर का section देखें। Response shapes नहीं बदले।
- **`backup` के बिना `POST /v1/wallet/auth/finish`** sign करने वाले wallet को खाते से जोड़ता है और उसकी keys लौटाता है: खाता किसी दूसरे wallet का backup रखता हो तब भी अब `backup_conflict` नहीं लौटाता, और खाते का `address` नहीं बदलता। `backup` के साथ कुछ नहीं बदला। Seed से import किया गया wallet अब इसी तरह Cosmos Pay से जुड़ता है।
- **`POST /v1/aliases/{name}/recovery` अब `payments:write` keys के लिए खुला है, साझा public key भी**, और केवल `{ accepted: true }` लौटाता है: यह सर्विस token खुद ईमेल करती है, इसलिए जवाब से `token`, `email` और `expiresAt` हट गए हैं और प्लेटफ़ॉर्म कंसोल अब इसमें शामिल नहीं है (यह रूट अब `403 admin_console_only` नहीं लौटाता)। `MAIL_*` चाहिए; उसके बिना रूट `503 misconfigured` लौटाता है।
- **कोई migration नहीं।**

### Solana और Monad; BlindPay और DeFindex native plugins बने

- **Migration `20260930120000_multichain`** `payment_intent`, `alias_address`,
  `alias_challenge`, `wallet_account` और `wallet_backup` में `chain` (डिफ़ॉल्ट
  `stellar`) जोड़ता है, साथ ही `payment_intent` में `assetDecimals`, `chainReference` और
  `chainCursor`, और alias address के unique index को
  `(aliasId, chain, network, address)` तक चौड़ा करता है। हर मौजूदा row Stellar रहती है;
  कुछ भी दोबारा नहीं लिखा जाता।
- **BlindPay (KYC, onramp, offramp) और DeFindex केवल तब दिए जाते हैं जब
  `PLUGINS_ENABLED` में `blindpay` / `defindex` हो।** जिस deployment में उनकी कुंजियाँ
  सेट थीं और वह slugs नहीं जोड़ता, वह `/v1/kyc`, `/v1/onramp`, `/v1/offramp`,
  `/v1/blindpay/webhooks`, `/v1/defindex` और `/v1/admin` के BlindPay routes खो देता है
  (404), और boot slug का नाम लेकर चेतावनी log करता है। deploy से पहले उदाहरण के लिए
  `PLUGINS_ENABLED=blindpay,defindex` सेट करें। इसके अलावा routes, scopes, tables और
  responses नहीं बदलते।
- **BlindPay के variables plugin के boot पर जाँचे जाते हैं**, env validation में नहीं:
  आधा-सेट instance अब भी boot रोकता है, पर केवल वहाँ जहाँ `blindpay` चालू है।
- **`GET /v1/admin/summary` में `fiat` केवल `blindpay` चालू होने पर होता है**, और
  `GET /v1/admin/consumers` तभी `blindpayReceivers`, `payins` और `payouts` गिनता है।
  Summary का `volume` Solana या Monad row को `<chain>:<asset>` लेबल देता है।
- **नए response fields** (जोड़े गए): payment intents पर `chain` और `chainReference`;
  alias addresses, resolutions और by-address rows पर `chain`; wallet backups पर
  `stellarAddress` के साथ `chain` और `address`; dashboard की `volume`, `recent` और
  balance rows पर `chain`, जो अब chain के अनुसार समूहित हैं — SOL और MON अब XLM में नहीं
  मिलते।
- **`txHash` हर chain का रूप स्वीकार करता है** `validate` और `PATCH` पर, और intent की
  chain से जाँचा जाता है (अन्यथा `400 validation_failed`)। केवल hex lowercase होता है;
  Solana signature जैसा आता है वैसा ही सहेजा जाता है।
- **`?chain=` के बिना alias resolution केवल Stellar पते लौटाता है।**
- **नए variables**, सभी वैकल्पिक (डिफ़ॉल्ट रूप से सार्वजनिक RPC):
  `SOLANA_RPC_URL_MAINNET`, `SOLANA_RPC_URL_DEVNET`, `SOLANA_RPC_TIMEOUT_MS`,
  `MONAD_RPC_URL_MAINNET`, `MONAD_RPC_URL_TESTNET`, `MONAD_RPC_TIMEOUT_MS`,
  `MONAD_LOG_BLOCK_RANGE`। Observer अब उन chains पर लंबित intents के लिए Solana और Monad
  से भी पूछता है।
- **Developer platform का `/wallet/console/provision`** अब `chain` और `address` पाता
  है, और Solana या Monad sign-in पर `stellarAddress: null`; wallets के इन chains को
  देने से पहले उसे यह स्वीकार करना होगा।
- **Monad deposit addresses** केवल `MONAD_RELAYER_PRIVATE_KEY` के साथ चालू होते हैं;
  migration `evm_deposit_address` भी बनाता है, और intents को `networkFee` मिलता है।
  कुंजी के बिना Monad intents पहले जैसे चलते हैं (merchant को सीधे भुगतान)।
- **APISIX में कोई बदलाव नहीं।**

### Plugins: एक नया module, दो नई tables और दो नए scopes

`/v1/plugins` नया है; कोई मौजूदा route या response नहीं बदला। Deploy के समय:

- **Migration `20260929120000_plugins`** `plugin_installation` और `plugin_record` बनाता
  है। कोई core table नहीं बदलती।
- **Scopes `plugins:read` और `plugins:write` नए हैं।** मौजूदा keys को ये नहीं मिलते और
  उन्हें `insufficient_scope` मिलता है; इन्हें developer platform से दें।
- **जब तक `PLUGINS_ENABLED` में कोई plugin न हो, कुछ नहीं चलता**, और तब भी केवल उन tenants
  के लिए जिन्होंने उसे install किया। `plugins/example` preinstalled और disabled है।
- **`typescript` अब runtime dependency है**: plugins का `index.ts` boot पर transpile होता
  है। इसे production installs से न हटाएँ।
- **Secret settings वाला plugin enable करने से पहले `PLUGINS_SECRET` set करें** — वरना
  boot मना कर देता है। `PLUGINS_TRUSTED_KEYS` support के अलावा signers जोड़ता है।
- **Build के साथ `plugins/` folder भी deploy करें।** Boot पर इसे working directory
  से पढ़ा जाता है, `dist/` के बगल में; जो deployment केवल `dist/` और `node_modules/`
  copy करता है वह कोई plugin serve नहीं करता, और enabled plugin boot रोक देता है।
- **Plugin enabled होने पर Node को `--no-node-snapshot` के साथ चलना चाहिए** — sandbox
  (`isolated-vm`, एक native module) को इसकी ज़रूरत है, वरना boot मना कर देता है। सभी npm
  scripts इसे देते हैं (`start`, `start:prod`, `test`, …); किसी और तरह शुरू किए गए
  process को इसे command में या `NODE_OPTIONS` में देना होगा।
- **APISIX में कोई बदलाव नहीं:** catch-all route पहले से `/v1/plugins` forward करता है।
- **नए error codes:** `plugin_not_installed`, `plugin_consent_mismatch`,
  `plugin_rejected`, `plugin_quota_exceeded`, `plugin_failed`।

### Pollar हटा दिया गया

`/v1/pollar` के नीचे सब कुछ हटा दिया गया है — OAuth bridge (`/v1/pollar/oauth/*`), wallet और
trustline provisioning (`/v1/pollar/wallets/*`) और `/v1/pollar/users` — साथ ही error codes
`pollar_identity_required`, `pollar_identity_mismatch` और `elevated_key_required`, और सभी
`POLLAR_*` variables। ये routes अब `404` लौटाते हैं।

- **Migration `20260927120000_remove_pollar`** `pollar_oauth_session` और
  `pollar_user_wallet` को हटाता है। इसे पलटा नहीं जा सकता: अगर आपको उनका इतिहास चाहिए, तो
  पहले दोनों tables का backup लें।
- **`/v1/pollar/*` के लिए APISIX routes हटाएँ**, खास तौर पर key-auth के बिना वाला callback
  route, और `POLLAR_*` variables हटा दें — उन्हें अनदेखा किया जाता है।
- **Keys पर अब भी `pollar:*` scopes हो सकते हैं।** अब कुछ भी उनकी जाँच नहीं करता।
- **Advisory lock ids `881_005` और `881_007` retire कर दिए गए हैं** और कभी दोबारा इस्तेमाल
  नहीं होते।
- **Wallets:** Cosmos Wallet अगली बार शुरू होने पर डिवाइस से कोई भी Pollar wallet हटा देता है।
  फंड Pollar के पास, उसी पते पर रहते हैं।

### सुरक्षा समीक्षा के सुधार

इनमें से अधिकांश किसी सही ढंग से व्यवहार करने वाले caller के लिए कुछ नहीं बदलते; deploy करने
से पहले "किसे पता चलेगा" कॉलम देखें।

| बदलाव | किसे पता चलेगा | क्यों |
| ------ | ----------- | --- |
| `POST /v1/aliases/:name/recovery` **केवल प्लेटफ़ॉर्म कंसोल** के लिए है: API key को `403 admin_console_only` मिलता है, और यह रूट प्रकाशित contract से हटा दिया गया | जिसने भी API key से recoveries शुरू की थीं | response में recovery token होता है, जो मालिक के mailbox पर नियंत्रण साबित करता है |
| `SUSPENDED` alias पर recovery पूरी करना `404` है | कोई वैध caller नहीं | suspension से पहले जारी हुआ token operator के hold को bypass कर सकता था |
| `@Public()` रूट (BlindPay webhook, health) `X-Consumer-Username` को अनदेखा करते हैं | डैशबोर्ड: वे requests अब anonymous के रूप में log होती हैं | उन रूट्स पर key-auth नहीं है, इसलिए header client से ही आता था |
| `AdminGuard` और `ConsoleOnlyGuard` द्वारा मना करना `warn` स्तर पर log होता है | Operators | Guards access log से पहले चलते हैं, इसलिए मना की गई requests का कोई निशान नहीं रहता था |
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
| `POST /v1/swaps/:id/submit` और `POST /v1/liquidity-pools/operations/:id/submit` सबसे पहले envelope जाँचते हैं: ऐसा body जो parse न हो, row का envelope न हो, या जिस पर कोई signature न हो, row की status चाहे जो हो, `400 validation_failed` है। कोई मनमाना `signedXdr` अब `SUCCEEDED` row नहीं लौटाता, और एक `EXPIRED` row मेल न खाने वाले body को `invalid_state_transition` की बजाय `validation_failed` से जवाब देता है | जिन clients ने unsigned `xdr` submit किया और `tx_bad_auth` रिजेक्शन पर भरोसा किया | signatures किसी ट्रांज़ैक्शन का hash नहीं बदलतीं, इसलिए unsigned envelope को loop में relay और reject किया जा सकता था, और साझा public key के तहत सिर्फ row id से settled row पढ़ी जा सकती थी |
| दोनों submit रूट time bounds पार कर चुके envelope को मना करते हैं (`400 invalid_state_transition`, broadcast नहीं होता; अगर वह network तक पहुँच चुका था तो observer उसे अब भी settle कर देता है) और उस `FAILED` row को भी जो पहले ही 3 बार दोबारा submit हो चुकी हो (`400 invalid_state_transition`: नई बनाएँ)। `503 provider_unavailable` के बाद की retry नहीं गिनती | जो clients submit को loop में retry करते हैं: `invalid_state_transition` पर रुक जाएँ | हर rejected resubmit एक Horizon submission और एक नया terminal webhook event था, बिना किसी सीमा के |
| अस्वीकृत submit को दर्ज करने से पहले ledger से मिलाया जाता है। जो transaction पहले से on-chain और सफल है (wallet ने उसे खुद broadcast किया और दोबारा submit `tx_bad_seq` के साथ लौटा) वह `SUCCEEDED` लौटाता है और `*_SUCCEEDED` भेजता है; जिसके बारे में ledger अभी जवाब नहीं दे सकता वह `submitted: false` और `status: "SUBMITTED"` लौटाता है और observer के लिए in flight रहता है। observer पिछले 24 घंटों में बनी `FAILED` rows को भी दोबारा जाँचता है और जिसका transaction settle हो चुका हो उसे promote करता है, पहले के `*_FAILED` के बाद `*_SUCCEEDED` भेजते हुए | जो clients `submitted: false` को अंतिम मानते हैं: `status` जाँचें, और उसी resource के लिए `*_FAILED` के बाद आए `*_SUCCEEDED` को एक correction मानें | settle हो चुका swap या deposit हमेशा के लिए `FAILED` दर्ज हो सकता था, बिना success webhook के और deposit के मामले में बिना cost basis के |
| दोनों submit रूट प्रति consumer और client address प्रति मिनट 20 कॉल की अनुमति देते हैं, अलग-अलग buckets में (`429 rate_limited`) | एक ही NAT के पीछे public key साझा करने वाले वॉलेट | ये रूट साझा public key लेते हैं, और हर कॉल Horizon पर broadcast कर सकती है |
| `GET /v1/webhooks`, `GET /v1/webhooks/:id` और `PATCH /v1/webhooks/:id` अब केवल दस्तावेज़ीकृत endpoint fields लौटाते हैं; `POST /v1/webhooks` और `POST /v1/webhooks/:id/rotate-secret` इनके साथ `secret` भी लौटाते हैं। `consumerId`, `previousSecret` और `previousSecretExpiresAt` इन सभी पाँचों से हटा दिए गए | उन fields को पढ़ने वाले callers | `previousSecret` एक signing secret है जिसे integrator अब भी स्वीकार कर सकता है, और सिर्फ़ `webhooks:read` वाली key भी उसे पढ़ सकती थी |
| जो recovery token alias की किसी चालू recovery से मेल न खाए, वह अब उसके खिलाफ़ नहीं गिना जाता। एक चालू token हर प्रस्तुति पर एक प्रयास इस्तेमाल करता है, यहाँ तक कि वह भी जिसका challenge या signature बाद में विफल हो जाए; पाँच के बाद यह `400 alias_recovery_invalid` है | कोई वैध caller नहीं | alias के नाम सार्वजनिक हैं, इसलिए किसी भी key से भेजे गए पाँच junk tokens कंसोल द्वारा शुरू की गई हर recovery जला देते थे |
| `POST /v1/aliases/:name/recovery/complete` (प्रति 10 मिनट 10), `POST /v1/aliases/challenges` (30), `POST /v1/webhooks/:id/ping` (20) और `POST /v1/webhooks/:id/deliveries/:deliveryId/redeliver` (30) budget से ऊपर जाने पर `429 rate_limited` हैं, प्रति consumer और client address | इन रूट्स को loop में चलाने वाली scripts | हर कॉल एक row सहेजती है, एक recovery token आज़माती है, या caller के चुने गए URL पर requests भेजती है |
| `PATCH /v1/payment-intents/:id` को अब `txHash` का 64-अक्षर का hex Stellar transaction hash होना ज़रूरी है (कुछ भी और `400` है) और इसे lowercase में सहेजता है; `POST /v1/payment-intents/:id/validate` अपना hash खुद lowercase करता है। hash अब सभी tenants में नहीं बल्कि एक consumer के intents में unique है, और जो hash आपके किसी दूसरे intent पर पहले से हो वह `409 idempotency_conflict` है (पहले यह `500` था) | placeholder या कटे हुए hashes भेजने वाले callers | कोई भी tenant किसी दूसरे tenant का transaction hash अपने ही किसी intent पर रख सकता था; फिर उस दूसरे tenant का settlement global index से टकराता, `500` का जवाब देता, और paid intent बिना `PAYMENT_INTENT_SUCCEEDED` के expire हो जाता |
| `EXPIRED` intent `SUCCEEDED` पर चला जाता है जब उसका पेमेंट on-chain verify हो जाए: observer से, जो अब expire करने से पहले चेन जाँचता है, या `POST /v1/payment-intents/:id/validate` और `PATCH {status: SUCCEEDED}` से, जो अब `400 invalid_state_transition` की बजाय `200` का जवाब देते हैं। `EXPIRED` भेजे गए update के बाद `PAYMENT_INTENT_SUCCEEDED` आ सकता है | `EXPIRED` को final मानने वाले webhook consumers | expiry कभी चेन नहीं देखती थी, और verifier destination के केवल 50 सबसे नए पेमेंट्स पढ़ता था, इसलिए देर से आया या दबा हुआ पेमेंट किसी paid intent को हमेशा के लिए `EXPIRED` छोड़ देता था |
| swaps, liquidity-pool operations, payment intents और customers के responses अब केवल अपने documented fields लौटाते हैं, साथ में swaps और payment intents पर `expiresAt`, जो अब documented है। `consumerId` और settlement की bookkeeping (`settlementEpoch`, `lastCheckedAt`, `notFoundStreak`, `sharesReceived`, `settledAmountA`/`B`, `horizonCursor`) अब नहीं भेजे जाते | वे callers जो ये fields पढ़ते थे | ये internal हैं, और इनमें से कई routes साझा public key से पहुँचे जा सकते हैं |
| BlindPay पर पहले से मौजूद receiver पर `PATCH /v1/kyc/receivers/:id` `external_id` और `image_url` को छोड़कर किसी भी field के लिए `403 kyc_review_required` है, जब तक key elevated (`X-Consumer-Role: admin`) न हो | tenant key से किसी live receiver की पहचान सुधारने वाले integrators: इसे reviewer से होकर भेजें | `PUT` कभी review न हुआ identity data सीधे एक regulated provider को भेज देता था, जबकि enable होने से पहले वही edit फिर से review में जाता है |
| BlindPay routes caller की key के environment वाला instance इस्तेमाल करते हैं: `prod` keys बिना suffix वाले `BLINDPAY_*` का, `dev` keys `BLINDPAY_*_DEV` का, और development instance कॉन्फ़िगर न होने पर `dev` key को `503 misconfigured` मिलता है। receivers, wallets, bank accounts, virtual accounts, quotes, payins और payouts केवल उसी instance पर पढ़े और execute किए जाते हैं | `dev` keys के साथ BlindPay इस्तेमाल करने वाले सभी | एक `dev` key production instance चलाती थी: वह असली KYC identities list और delete कर सकती थी और असली payouts बना सकती थी |
| testnet लॉगिन अब अपने user के लिए mainnet वॉलेट provision नहीं करता: testnet redemption के `network_wallets` में केवल testnet वॉलेट होता है। mainnet लॉगिन अब भी testnet provision करता है | testnet लॉगिन से mainnet entry पढ़ने वाले | जिस `dev` key को कोई भी बना सकता है, वह हर लॉगिन पर mainnet reserve के लिए operator का असली XLM खर्च करती थी |
| `POST /v1/kyc/receivers/:id/approve` अब `expected_version` लेता है (वही `dossierVersion` जो आपने पढ़ा) और KYC data उसके बाद बदल जाने पर `409 kyc_state_invalid` देता है। `POST /v1/kyc/receivers/:id/enable` ऐसे dossier को मना कर देता है जो approve किया हुआ नहीं है, और receiver पढ़ने पर `dossierVersion` तथा `reviewedVersion` आते हैं | reviewers, जब वे `expected_version` भेजना शुरू करें; और कोई नहीं — field वैकल्पिक है | review का मतलब है कोई व्यक्ति data पढ़े और फिर approve करे, और बीच में हुआ edit status को `pending_review` पर ही छोड़ता है — यानी approval ऐसे dossier पर लगती थी जिसे किसी ने देखा नहीं था, और `enable` उसे एक regulated provider को भेज देता था |
| `POST /v1/kyc/upload`, `/v1/kyc/terms-of-service`, onramp तथा offramp की writes, `POST /v1/payment-intents/tx` और `/pay`, `POST /v1/swaps/quote` और `/v1/swaps`, तथा `POST /v1/liquidity-pools/deposit` और `/withdraw` अब budget से ऊपर `429 rate_limited` देते हैं, प्रति consumer और client address। BlindPay पर टिका हर रूट प्रति मिनट 60 provider requests की प्रति-consumer सीमा में भी गिना जाता है | इन रूट्स पर loop चलाने वाले scripts; सीमा से ऊपर चलने वाले bulk importer की अपनी key होनी चाहिए | इन पर कोई सीमा थी ही नहीं: हर एक या तो provider के पास कुछ छोड़ जाती है जिसे कोई error वापस नहीं करता, या वह प्रति-IP Horizon budget खर्च करती है जिसे यहाँ के सभी रूट साझा करते हैं। सीमित केवल submits थे |
| `POST /v1/swaps` अब ऐसे `PENDING` swap के लिए `409 operation_in_flight` नहीं देता जिसका sequence number account ने अभी इस्तेमाल नहीं किया (unsigned या छोड़ा हुआ envelope)। यह केवल `STELLAR_SWAP_SINGLE_INFLIGHT=true` पर लागू है | वे वॉलेट users जो ब्लॉक हो जाते थे | कोई भी कोई भी `source` बता सकता है, इसलिए एक dust swap किसी और के account को एक के बाद एक timeout window तक जमा देता था — ऊपर वाले liquidity-pool सुधार का जुड़वाँ |
| host की वजह से अस्वीकृत webhook destination — resolve न होना, private, link-local, metadata — अब एक ही संदेश वाला एक `400` है; कारण सेवा के log में रहता है। malformed URL, https से अलग scheme, credentials या host का न होना अब भी बताते हैं कि क्या गलत है | वे integrators जो कारण response से पढ़ते थे | endpoint रजिस्टर करना ऐसा नाम resolve करता है जहाँ यह सेवा पहुँच सकती है, इसलिए कारण-दर-कारण जवाब से internal network का नक्शा एक-एक URL करके बनाया जा सकता था |
| `redirect_url` तब अस्वीकार होती है जब उसमें fragment, backslash, whitespace या control character हो; embedded credentials के बिना https पहले से अनिवार्य था | सामान्य URL भेजने वाला कोई नहीं | `https://app.acme.com\@evil.test` इस बात पर अलग-अलग host बताता है कि उसे कौन parse कर रहा है, और वह मान BlindPay तथा एक browser दोबारा पढ़ते हैं |
| `POST /v1/wallet/auth/oauth/claim`: ऐसा Authentik साइन-इन जिसका ईमेल प्रदाता ने पुष्टि नहीं किया है (`email_verified` `true` नहीं है) अब `email_unverified` के साथ विफल होने के बजाय callback पूरा करता है और `verify_email` लौटाता है, उस इनबॉक्स में एक कोड भेजकर — खाता हो या न हो। इसके लिए कोई ID token जारी नहीं होता, इसलिए इससे SEP-30 रिकवरी शुरू नहीं हो सकती, और यह `POST /v1/wallet/auth/email/start` का प्रति-पता cooldown साझा करता है (`400 wallet_login_code_cooldown`)। पहले माइग्रेशन `20260926120000_wallet_auth_unverified_email` चलाएँ | Wallets: नए खाते पर भी `verify_email` संभालें | व्यक्ति एक बंद पेज पर अटक जाता था; कोड वह पता साबित करता है जिसकी पुष्टि प्रदाता ने नहीं की |
| `POST /v1/wallet/auth/finish` और `POST /v1/wallet/recovery/setup` सेशन टोकन `X-Wallet-Session: {sessionToken}` से पढ़ते हैं। `Authorization: Bearer` अब भी पढ़ा जाता है, पर सेवा तक केवल सीधी कॉल में पहुँचता है | Wallets: API key के साथ `X-Wallet-Session` भेजें | गेटवे प्रॉक्सी करने से पहले `Authorization` (और `apikey`) हटा देता है, इसलिए APISIX से होकर टोकन कभी नहीं पहुँचता था और दोनों रूट `401 wallet_session_invalid` लौटाते थे |
| Authentik से wallet साइन-इन अब `prompt=login` की जगह `max_age=300` माँगता है, और ID token का `auth_time` इन 5 मिनटों के भीतर होना चाहिए (वरना callback `profile_invalid` के साथ विफल होता है)। Google / GitHub को Authentik sources के रूप में रखने पर `default-source-authentication` को *Authentication: No requirement* पर सेट करें | Social sources के साथ Authentik चलाने वाले ऑपरेटर | `prompt=login` में Authentik बिना सेशन वाले ब्राउज़र से दो बार लॉगिन करवाता था, और source से दूसरा लॉगिन "Flow does not apply to current user" के साथ अस्वीकार होता था |
| `POST /v1/wallet/auth/finish` और `PUT /v1/wallet/backup` अब `v: 3` बैकअप बॉक्स भी स्वीकार करते हैं: seed एक यादृच्छिक डेटा key के नीचे, और वह key `slots` में हर दरवाज़े के लिए एक बार सील (`kind: "password"` या `kind: "passkey"`, अधिकतम 8)। हर password दरवाज़े पर वही PBKDF2 न्यूनतम लागू है जो `v: 2` बॉक्स पर; passkey दरवाज़े की कोई लागत नहीं, क्योंकि उसकी key authenticator का WebAuthn PRF आउटपुट है। `v: 2` बॉक्स नहीं बदलते | Wallets: केवल-passkey बैकअप मान्य है, और जिस wallet ने ऐसा लिखा उसे यह सर्वर चाहिए | मूल password टाइप करने के बजाय passkey से पुनर्स्थापना संभव करता है, बिना इस सेवा के कभी बॉक्स खोलने वाली key रखे |
| `POST /v1/wallet/auth/oauth/authorize` अब एक वैकल्पिक `returnTo` स्वीकार करता है। अगर वह `WALLET_AUTH_RETURN_URLS` में है, तो `GET /v1/wallet/auth/oauth/callback/{provider}` पेज दिखाने के बजाय उस पर `?state=…` (विफलता पर `&error=<reason>` भी) के साथ `302` देता है; सूची से बाहर वाला `400 wallet_return_url_not_allowed` है। केवल `state` जाता है — handshake अब भी PKCE verifier से ही redeem होता है। पहले migration `20260927180000_wallet_auth_return_to` चलाएँ | Native wallets (desktop और mobile): `returnTo` भेजें और वह URL OS में register करें | प्लेटफ़ॉर्म का auth session (`ASWebAuthenticationSession`, Custom Tab, desktop deep link या loopback listener) तभी बंद होता है जब browser ऐप के अपने URL पर पहुँचे, इसलिए व्यक्ति पेज पर अटका रहता था और उसे हाथ से बंद करना पड़ता था |
| `GET /v1/wallet/auth/providers` अब `mfaSettingsUrl` भी लौटाता है: Authentik खाते का वह पेज जहाँ व्यक्ति दूसरा factor (security key या passkey, authenticator app, recovery codes) जोड़ता या हटाता है, session न हो तो Authentik login से होकर; Authentik न होने पर `null`। Wallet साइन-इन पर दूसरा factor वैकल्पिक है — `deploy/authentik/wallet-sign-in.yaml` MFA stage को फिर से *skip* पर रखता है, जिसके पास factor है उससे पासवर्ड के बाद वह माँगता है, passkey को username स्क्रीन से ही साइन-इन करने देता है, और जिसके पास कोई नहीं है उसे पासवर्ड के बाद विकल्प देता है (अभी नहीं, security key, authenticator app)। यह sign-up पेज पर फ़ॉर्म के ऊपर Google / GitHub भी जोड़ता है। पासवर्ड से साइन-इन और sign-up नहीं बदलते | Authentik चलाने वाले operators: blueprint import करें। Wallets: URL को एक setting के रूप में दिखाएँ | दूसरा factor या तो सबके लिए अनिवार्य था या पहुँच से बाहर: wallet users कभी Authentik की settings नहीं खोलते, setup flows बिना Authentik session वाले browser को अस्वीकार करते हैं, और identification stage का passwordless बटन उसी flow की ओर था, इसलिए वह सिर्फ़ पेज reload करता था |
| `/v1/admin` माँगता है कि `X-Cosmos-Internal` में `APISIX_GATEWAY_SECRET` से keyed ताज़ा MAC हो (`v1.<unix seconds>.<hex>`, पाँच मिनट के भीतर); केवल `1` पर `403 admin_console_only` मिलता है, और केवल verified marker ही caller को per-consumer rate limits से छूट देता है या उसकी request-log rows चिह्नित करता है | `/v1/admin` को सीधे कॉल करने वाली ops scripts, और इस बदलाव के बिना deploy किया गया developer platform | `0`, `false`, `no` या `off` के अलावा कोई भी मान चल जाता था, इसलिए header हटाना भूला एक अकेला APISIX रूट हर API key को cross-tenant admin surface, rate-limit छूट और tenant के request log से अपनी कॉल छिपाने का तरीका दे देता था |

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
- **Migration `20260915200000_receiver_dossier_version`** `blindpay_receiver` में
  `dossierVersion` (डिफ़ॉल्ट `1`) और `reviewedVersion` जोड़ता है — केवल catalog, कोई table
  rewrite नहीं — और हर उस receiver के लिए `reviewedVersion` भर देता है जो review gate पार
  कर चुका है, ताकि उसका `enable` चलता रहे। जो receivers अब भी `inactive` या
  `pending_review` में हैं, उनके लिए `NULL` रहता है, जो उनके बारे में सच है।
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
किसी भी non-2xx पर retry करता है, इसलिए webhook delivery नहीं बदलती।

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
2. `X-Cosmos-Internal` एक कंसोल marker है: `v1.<unix seconds>.<hex>`, जहाँ hex
   `HMAC-SHA256(APISIX_GATEWAY_SECRET, "cosmos-admin-console:v1:" +
   seconds)` है और timestamp सर्वर की घड़ी से पाँच मिनट के भीतर है। API-key caller के
   पास gateway secret नहीं होता, इसलिए वह इसे नहीं बना सकता — उस रूट से भी नहीं जो
   header हटाना भूल गया हो (`proxy-rewrite.headers.remove`)। यही verified flag कंसोल
   को per-consumer rate limits से छूट देता है और request log में उसकी rows को चिह्नित
   करता है।

केवल `X-Cosmos-Internal: 1` — जो कंसोल पहले भेजता था — किसी भी दूसरी जालसाज़ी की तरह
अस्वीकार किया जाता है, इसलिए सर्विस और developer platform एक साथ deploy होते हैं। दोनों
repositories marker के लिए एक ही test vector pin करती हैं। कंसोल ही वह अकेली जगह है जो
तय करती है कि platform admin कौन है, और audit rows काम करने वाले कंसोल account
(`cosmos_<userId>`) और उसकी platform role का नाम देती हैं, हर mutation **और** हर read पर।

caller के लिए इससे क्या बदलता है:

| पहले | अब |
| --- | --- |
| Bearer secret के बिना `401` `admin_credentials_required` | जो भी कंसोल कॉल नहीं है, उसके लिए `403` `admin_console_only` |
| mutation पर `read` credential के लिए `403` `admin_role_required` | हटा दिया गया — कंसोल पहले ही तय कर चुका है कि account कार्रवाई कर सकता है |
| audit row पर `actorId` / `actorRole` credential का नाम देते थे | वे कंसोल account और उसकी platform role का नाम देते हैं |

`/v1/admin` को सीधे कॉल करने के लिए (जैसे किसी ops script से), `X-Gateway-Secret`,
`X-Consumer-Username` और ताज़ा बनाया गया `X-Cosmos-Internal` भेजें; audit row पर label
लगाने के लिए `X-Cosmos-Admin-Role: owner` जोड़ें। सर्विस को सार्वजनिक internet से दूर रखें।

```sh
TS=$(date +%s)
MAC=$(printf 'cosmos-admin-console:v1:%s' "$TS" | openssl dgst -sha256 -hmac "$APISIX_GATEWAY_SECRET" -r | cut -d' ' -f1)
curl -H "X-Gateway-Secret: $APISIX_GATEWAY_SECRET" -H "X-Consumer-Username: ops" -H "X-Cosmos-Internal: v1.$TS.$MAC" http://localhost:3000/v1/admin/summary
```

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
| `ENV_FILE` | नहीं | `.env` | यह process जो dotenv फ़ाइल पढ़ता है (Nest और Prisma)। local instances इसे साझा करते हैं — हर instance में जो अलग है वह `dev-instances.json` में है (`npm run dev:local`); environment में पहले से मौजूद values ही मान्य रहती हैं |
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
| `APISIX_EMAIL_HEADER` | नहीं | `x-consumer-email` | key के account का verified email, जिसे gateway आगे भेजता है। अभी इस सेवा में कुछ भी इस पर निर्भर नहीं है |
| `APISIX_PUBLIC_CONSUMER` | नहीं | — | साझा public consumer का username (ऊपर देखें)। जहाँ भी public key प्रकाशित हो, इसे सेट करें |
| `PUBLIC_API_KEY_DEV` | नहीं | — | Testnet की साझा public key, `GET /v1/public-key?env=dev` द्वारा दी जाती है। सेट न हो तो `503 misconfigured` |
| `PUBLIC_API_KEY_PROD` | नहीं | — | Mainnet के लिए वही (`env=prod`) |
| `APISIX_ADMIN_URL` | admin key के साथ | — | APISIX Admin API का base, जैसे `http://apisix:9180/apisix/admin`। केवल wallet खातों की keys जारी करने के लिए |
| `APISIX_ADMIN_KEY` | wallet sign-in के लिए | — | APISIX admin key। पूरे gateway पर लागू — देखें [कोई भी request developer platform पर निर्भर नहीं है](#कोई-भी-request-developer-platform-पर-निर्भर-नहीं-है)। Recovery server पर अस्वीकार |
| `APISIX_ADMIN_TIMEOUT_MS` | नहीं | `10000` | एक Admin API कॉल का बजट (ms) |
| `WALLET_KEY_SWAP_FEE_BPS` | नहीं | `50` | Wallet खातों की keys में शामिल swap commission (`community` plan की दर) |
| `MAIL_RESEND_API_KEY` | email door के लिए | — | Resend API key जिससे यह सर्विस sign-in और recovery codes भेजती है |
| `MAIL_FROM` | Resend / SMTP key के साथ | — | Verified sender, जैसे `Cosmos Pay <no-reply@example.com>` |
| `MAIL_SMTP_HOST` | नहीं | — | SMTP server, जब `MAIL_RESEND_API_KEY` सेट न हो तब उपयोग होता है |
| `MAIL_SMTP_PORT` | नहीं | `587` | SMTP port |
| `MAIL_SMTP_SECURE` | नहीं | `false` | implicit TLS (465) के लिए `true`, STARTTLS (587) के लिए `false` |
| `MAIL_SMTP_USER` | नहीं | — | SMTP user |
| `MAIL_SMTP_PASS` | नहीं | — | SMTP password |
| `MAIL_TIMEOUT_MS` | नहीं | `15000` | एक भेजने का बजट (ms) |
| `RECOVERY_EMAIL_CODES` | नहीं | `false` | Recovery server पर: अपने `MAIL_*` से अपने codes भेजता है |
| `WALLET_BACKUP_ENCRYPTION_KEY` | किसी भी sign-in door के साथ | — | हर सहेजे गए wallet backup को at rest एन्क्रिप्ट करती है (AES-256-GCM, 32 bytes base64/hex)। केवल environment में रहती है: database की कॉपी में device के ciphertext का ciphertext होता है। इसे खोने पर सहेजे गए backups फिर से नहीं दिए जा सकते |
| `WALLET_BACKUP_ENCRYPTION_PREVIOUS_KEYS` | नहीं | — | rotation के लिए comma से अलग पुरानी keys, केवल पढ़ने के लिए; `npm run backups:reencrypt` के बाद हटाएँ |
| `STELLAR_NETWORK` | नहीं | `testnet` | fallback Stellar नेटवर्क (`public` / `testnet`) |
| `STELLAR_HORIZON_URL_PUBLIC` | नहीं | `https://horizon.stellar.org` | Mainnet Horizon का base URL |
| `STELLAR_HORIZON_URL_TESTNET` | नहीं | `https://horizon-testnet.stellar.org` | Testnet Horizon का base URL |
| `SOLANA_RPC_URL_MAINNET` | नहीं | `https://api.mainnet-beta.solana.com` | `prod` कुंजियों के लिए Solana RPC (mainnet-beta; उपयोग से पहले genesis hash जाँचा जाता है)। सार्वजनिक endpoint rate-limited है: production में किसी प्रदाता का उपयोग करें |
| `SOLANA_RPC_URL_DEVNET` | नहीं | `https://api.devnet.solana.com` | `dev` कुंजियों के लिए Solana RPC (devnet) |
| `SOLANA_RPC_TIMEOUT_MS` | नहीं | `10000` | एक Solana RPC कॉल का बजट (ms) |
| `MONAD_RPC_URL_MAINNET` | नहीं | `https://rpc.monad.xyz` | `prod` कुंजियों के लिए Monad RPC (chain id 143, उपयोग से पहले जाँचा जाता है) |
| `MONAD_RPC_URL_TESTNET` | नहीं | `https://testnet-rpc.monad.xyz` | `dev` कुंजियों के लिए Monad RPC (chain id 10143) |
| `MONAD_RPC_TIMEOUT_MS` | नहीं | `10000` | एक Monad RPC कॉल का बजट (ms) |
| `MONAD_LOG_BLOCK_RANGE` | नहीं | `100` | एक `eth_getLogs` कितने blocks तक फैल सकता है — RPC प्रदाता की सीमा (सार्वजनिक RPC 100 की अनुमति देता है) |
| `MONAD_RELAYER_PRIVATE_KEY` | नहीं | — | Relayer कुंजी (32-byte hex)। सेट होने पर हर Monad intent को अपना deposit address मिलता है और relayer deposits को fee घटाकर merchant तक forward करता है। इसमें केवल gas का पैसा होता है: इसके deploy किए forwarders किसी और को भुगतान नहीं कर सकते |
| `MONAD_DEPOSIT_TOKEN_FEES` | नहीं | — | हर ERC-20 deposit पर relayer fee, JSON `{"0xToken": "0.05"}` टोकन इकाइयों में। जिस टोकन की प्रविष्टि नहीं वह मुफ़्त forward होता है (gas relayer देता है) |
| `STELLAR_BASE_FEE` | नहीं | `100` | tx builds के लिए Stellar base fee (stroops) |
| `STELLAR_TX_TIMEOUT` | नहीं | `300` | ट्रांज़ैक्शन timeout (सेकंड) |
| `STELLAR_SWAP_FEE_WALLET` | जब fee > 0 हो | — | swap fees के लिए प्लेटफ़ॉर्म का G... account |
| `STELLAR_SWAP_FEE_BPS` | नहीं | `50` | basis points में swap fee |
| `STELLAR_SWAP_SLIPPAGE_BPS` | नहीं | `50` | swap slippage की डिफ़ॉल्ट सहनशीलता (bps) |
| `STELLAR_SWAP_MAX_SLIPPAGE_BPS` | नहीं | `500` | caller के slippage की सख्त ऊपरी सीमा (bps) |
| `STELLAR_SWAP_SINGLE_INFLIGHT` | नहीं | `false` | `true` होने पर, उसी source के लिए non-expired PENDING swap पहले से हो तो 409 |
| `NEAR_INTENTS_BASE_URL` | नहीं | `https://1click.chaindefuser.com` | NEAR Intents की 1Click API, क्रॉस-चेन swaps के लिए |
| `NEAR_INTENTS_API_KEY` | अनुशंसित | — | 1Click partner key (`X-API-Key`)। इसके बिना 1Click अपनी 0.2% fee जोड़ता है और commission का आधा रख लेता है |
| `NEAR_INTENTS_FEE_RECIPIENT` | plan commission होने पर | — | वह NEAR account जिसे क्रॉस-चेन commission मिलता है (`appFees`)। Plan दर के साथ unset: `503 misconfigured` |
| `NEAR_INTENTS_TIMEOUT_MS` | नहीं | `20000` | एक 1Click call का budget (ms) |
| `CROSS_CHAIN_SWAP_SLIPPAGE_BPS` | नहीं | `100` | क्रॉस-चेन default slippage (bps); minimum से नीचे NEAR Intents refund करता है |
| `CROSS_CHAIN_SWAP_MAX_SLIPPAGE_BPS` | नहीं | `500` | Caller जितनी अधिकतम slippage माँग सकता है |
| `CROSS_CHAIN_SWAP_DEADLINE_SECONDS` | नहीं | `1800` | Deposit address कितनी देर deposit स्वीकार करता है; बाद वाले refund होते हैं |
| `SOLANA_SWAP_FEE_WALLET` | plan commission होने पर | — | उन token accounts का owner जिनमें Solana swap commission जमा होता है (Jupiter `feeAccount`, हर output mint के लिए एक — पहले बनाएँ)। Plan दर के साथ unset: `503 misconfigured` |
| `MONAD_SWAP_FEE_WALLET` | plan commission होने पर | — | वह address जिसे Monad swap commission मिलता है (Kuru Flow `referrerAddress`) |
| `JUPITER_BASE_URL` | नहीं | `https://lite-api.jup.ag/swap/v1` | Jupiter Swap API; key के साथ `https://api.jup.ag/swap/v1` |
| `JUPITER_API_KEY` | नहीं | — | Jupiter API key (`x-api-key`), ऊँची limits के लिए |
| `JUPITER_TIMEOUT_MS` | नहीं | `15000` | एक Jupiter call का budget (ms) |
| `KURU_BASE_URL` | नहीं | `https://ws.kuru.io` | Kuru Flow API (Monad) |
| `KURU_API_KEY` | production के लिए | — | Kuru Flow API key (`X-API-Key`)। इसके बिना हर address को प्रति सेकंड एक request तक सीमित token मिलता है |
| `KURU_TIMEOUT_MS` | नहीं | `15000` | एक Kuru Flow call का budget (ms) |
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
| `DEFINDEX_API_KEY` | नहीं | — | DeFindex की सर्वर API कुंजी। routes केवल `PLUGINS_ENABLED` में `defindex` होने पर मौजूद हैं; कुंजी के बिना वे `503 misconfigured` लौटाते हैं |
| `DEFINDEX_BASE_URL` | नहीं | `https://api.defindex.io` | DeFindex API base URL |
| `DEFINDEX_TIMEOUT_MS` | नहीं | `30000` | DeFindex HTTP timeout (ms) |
| `PLUGINS_ENABLED` | नहीं | — | इस deployment द्वारा दिए जाने वाले plugins के slugs, अल्पविराम से अलग: `plugins/` के sandboxed plugins, और native `blindpay` व `defindex`। खाली होने पर कोई नहीं; जो plugin सूचीबद्ध नहीं है वह कभी load नहीं होता |
| `PLUGINS_SECRET` | जब किसी enabled plugin में secret settings हों | — | Plugin installations की secret settings को seal करता है (कम से कम 32 अक्षर)। इसे बदलने पर सभी stored plugin secrets पढ़े नहीं जा सकते |
| `PLUGINS_TRUSTED_KEYS` | नहीं | — | Cosmos Pay support के अलावा वे signers जिनके plugins यहाँ चलते हैं: comma से अलग `<keyId>:<base64url Ed25519 public key>`। किसी और का sign किया, या sign के बाद बदला गया plugin boot रोक देता है |
| `PLUGINS_ALLOW_UNSIGNED` | नहीं | `false` | बिना `signature.json` के plugins चलाएँ, local में एक लिखने के लिए। `NODE_ENV=production` में मना |
| `KYC_REDIRECT_URL_WHITELIST` | नहीं | — | प्रति consumer KYC redirect hosts की allow-list |
| `WALLET_AUTH_RETURN_URLS` | नहीं | — | ऐप के URL, कॉमा से अलग, जिन पर wallet साइन-इन का callback redirect कर सकता है (`POST /v1/wallet/auth/oauth/authorize` पर `returnTo`): एक custom scheme, एक universal/app link, या `http://127.0.0.1/…` (कोई भी port)। सटीक मिलान; loopback के बाहर plain http, query वाली, या `javascript:`/`data:`/`file:` वाली entry boot पर अस्वीकार होती है। सेट न होने पर हर callback पेज दिखाता है और `returnTo` पर `400 wallet_return_url_not_allowed` मिलता है |
| `WALLET_AUTH_SIGNERS_HORIZON_URL` | नहीं | `STELLAR_NETWORK` का Horizon | बताता है कि किसी खाते के लिए कौन साइन कर सकता है; तब पढ़ा जाता है जब रिकवर किया गया wallet उस key से साइन करता है जिसने उसकी master की जगह ली। यह वही ledger होना चाहिए जिस पर wallets हैं: दूसरा 404 देता है और साइन-इन `400 wallet_signature_invalid` होता है |
| `WALLET_RECOVERY_SPONSOR_NETWORK_PASSPHRASE` | नहीं | `STELLAR_NETWORK` की passphrase | वह नेटवर्क जिसके लिए sponsored recovery setup (`POST /v1/wallet/recovery/setup`) बनाया जाता है |
| `WALLET_RECOVERY_SPONSOR_HORIZON_URL` | नहीं | `STELLAR_NETWORK` का Horizon | वह Horizon जिससे sponsored recovery setup खाता पढ़ता है |
| `RATE_LIMIT_ENABLED` | नहीं | `true` | XLM खर्च करने वाले रूट्स पर प्रति पता सीमाएँ। incident switch |
| `RATE_LIMIT_PRUNE_INTERVAL_MS` | नहीं | `600000` | counter-window prune interval (ms, न्यूनतम 1000) |

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
> कि वे मान ईमानदार हैं। जब भी कोई रूट जोड़ा या कॉपी किया जाए, इस सूची का review करें।
> `X-Cosmos-Internal` अब इस पर निर्भर नहीं है — सर्विस gateway secret से बना MAC verify
> करती है — लेकिन हर `X-Consumer-*` header अब भी निर्भर है, और जो रूट client की भेजी
> copy आगे भेज देता है, वह उसे किसी भी consumer का नाम लेने देता है। सर्विस को private
> network पर रखें ताकि अंदर आने का एकमात्र रास्ता APISIX हो; साझा secret दूसरी परत है,
> अकेली परत नहीं।
>
> production में `X-Plan-Swap-Fee-Bps` न होने पर environment default पर लौटने की बजाय
> `503` लौटता है।
