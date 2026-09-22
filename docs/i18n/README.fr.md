# Cosmos Pay — Microservice de paiements

[English](../../README.md) · [Español](./README.es.md) · [Português](./README.pt.md) · [Deutsch](./README.de.md) · **Français** · [हिन्दी](./README.hi.md) · [简体中文](./README.zh.md)

Microservice de paiements construit avec **NestJS 12** + **Prisma 7 (PostgreSQL)**.

Il s'agit d'une application *distincte* de la plateforme développeur Cosmos (`paydev`). La
plateforme développeur se contente d'**émettre** les jetons d'accès APISIX (consumers + identifiants
`key-auth`) destinés aux services en aval. Ce service est l'un de ces services en aval :
il se trouve **derrière APISIX**, qui répartit la charge et authentifie chaque
requête avant de la transmettre ici. Le service ne voit donc jamais les clés API brutes
— il se fie uniquement à ce que la passerelle transmet.

## Comment « uniquement APISIX » est garanti

Une requête n'est acceptée que lorsque les **deux** conditions sont réunies (voir
`src/common/guards/apisix.guard.ts`) :

1. **Secret partagé de la passerelle.** La requête porte `X-Gateway-Secret`, comparé en
   temps constant à `APISIX_GATEWAY_SECRET`. APISIX *injecte* cet en-tête dans
   chaque requête relayée et *supprime* toute copie fournie par le client, de sorte qu'une
   valeur correcte ne peut provenir que de la passerelle. (Défense en profondeur — associez-la
   à une isolation réseau pour que le service ne soit pas directement joignable.)
2. **Consumer authentifié.** Le plugin `key-auth` d'APISIX, après avoir validé la
   clé API de l'appelant, transmet `X-Consumer-Username` (et
   `X-Credential-Identifier`). Le guard exige la présence de l'en-tête du consumer,
   ce qui prouve que la clé a été authentifiée en amont.

Les routes peuvent s'y soustraire avec `@Public()` (utilisé par les sondes de santé que
l'orchestrateur interroge directement). Le contrôle est toujours actif — il n'existe aucun
indicateur pour le désactiver. Pour le développement local, placez le service derrière APISIX
ou envoyez vous-même `X-Gateway-Secret` + les en-têtes `X-Consumer-*`.

`/v1/admin` est inter-tenants, donc `AdminGuard` exige en plus `X-Cosmos-Internal`.
APISIX **supprime** cet en-tête de tout ce qu'il relaie, de sorte que seul un backend qui
appelle le service directement avec le secret de la passerelle peut l'envoyer — la plateforme
développeur, qui décide si le compte connecté est owner ou admin. Il n'y a pas d'identifiant
d'administration distinct : ce sont le secret de la passerelle, l'isolation réseau et la liste
de suppression d'en-têtes de la route de la passerelle qui protègent les données inter-tenants.

Le pipeline :

```
request → ApisixContextMiddleware  (reads consumer headers → req.gatewayConsumer)
        → ApisixGuard (APP_GUARD)  (verifies secret + consumer, or @Public bypass)
        → ValidationPipe           (DTO validation)
        → Controller / Service     (@CurrentConsumer() gives the consumer)
```

## Structure du projet

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

Toutes les routes sont versionnées sous `/v1` (versionnement par URI).

Chaque route figure dans l'[index des routes](#index-des-routes) ci-dessous, avec son scope.
**Les schémas de requête et de réponse se trouvent dans le contrat OpenAPI généré**, qui est
régénéré à partir des contrôleurs et des DTO à chaque exécution de la CI
(`npm run openapi:check` fait échouer le build en cas de dérive) :

- `openapi/openapi.json` / `openapi/openapi.yaml` — versionnés, relisibles dans un diff
- `/docs` — Swagger UI, lorsque `SWAGGER_ENABLED=true`
- `/docs/json`, `/docs/yaml` — la même spécification servie en direct

| Domaine                | Chemin de base           | Rôle                                                     |
| ---------------------- | ------------------------ | -------------------------------------------------------- |
| Intentions de paiement | `/v1/payment-intents`    | Intentions SEP-7 `tx` / `pay`, validation, observateur on-chain |
| Swaps                  | `/v1/swaps`              | Cotation path-payment, construction du XDR non signé, soumission du XDR signé |
| Pools de liquidité     | `/v1/liquidity-pools`    | Dépôt / retrait AMM, positions, commission sur le gain   |
| Webhooks               | `/v1/webhooks`           | CRUD des endpoints, rotation du secret, livraisons, relivraison |
| KYC                    | `/v1/kyc`                | Receivers (KYC/KYB), wallets, comptes bancaires, envoi de documents |
| Onramp                 | `/v1/onramp`             | Cotations de payin, payins, comptes virtuels             |
| Offramp                | `/v1/offramp`            | Cotations de payout, autorisation, payouts (signés par le client) |
| Produits               | `/v1/products`           | Catalogue marchand                                       |
| Clients                | `/v1/customers`          | Fiches payeurs dérivées des intentions                   |
| Alias                  | `/v1/aliases`            | Identifiants de paiement revendicables : revendiquer, résoudre, récupérer |
| Actifs                 | `/v1/assets`             | Registre d'actifs sélectionnés, par réseau               |
| Pollar                 | `/v1/pollar`             | Pont OAuth (connexion sociale → wallet) + routes opérateur |
| Analytique             | `/v1/summary`, `/v1/balances`, `/v1/logs` | Agrégats et journaux du tableau de bord  |
| Activité               | `/v1/activity`           | Événements rapportés par les clients : ingestion, flux, agrégation |
| Admin                  | `/v1/admin`              | Lectures/écritures inter-tenants — console de la plateforme uniquement, auditées |
| Santé                  | `/v1/health`             | Liveness / readiness (`@Public`)                         |

### Index des routes

Chaque route servie par ce service. **Scope** indique ce que la clé API doit détenir — *l'un
de* signifie que n'importe lequel des scopes listés suffit, et `—` signifie toute clé
authentifiée. **Clé publique** marque les routes que la clé publique partagée peut appeler (voir
[La clé API publique partagée](#la-clé-api-publique-partagée)). Une route marquée
*console de la plateforme* n'accepte aucune clé API ; seul le backend de la console l'atteint.
Les chemins utilisent la forme OpenAPI `{param}`.

| Méthode | Chemin | Scope | Clé publique |
| ------- | ------ | ----- | ------------ |
| GET | `/v1/activity/events` | `activity:read` |  |
| POST | `/v1/activity/events` | `activity:write` | ✓ |
| GET | `/v1/activity/summary` | `activity:read` |  |
| GET | `/v1/admin/audit-logs` | console de la plateforme |  |
| GET | `/v1/admin/consumers` | console de la plateforme |  |
| GET | `/v1/admin/customers` | console de la plateforme |  |
| GET | `/v1/admin/payins` | console de la plateforme |  |
| GET | `/v1/admin/payment-intents` | console de la plateforme |  |
| GET | `/v1/admin/payouts` | console de la plateforme |  |
| GET | `/v1/admin/products` | console de la plateforme |  |
| GET | `/v1/admin/receivers` | console de la plateforme |  |
| PATCH | `/v1/admin/receivers/{id}/access` | console de la plateforme |  |
| POST | `/v1/admin/receivers/{id}/approve` | console de la plateforme |  |
| POST | `/v1/admin/receivers/{id}/enable` | console de la plateforme |  |
| POST | `/v1/admin/receivers/{id}/tos` | console de la plateforme |  |
| GET | `/v1/admin/summary` | console de la plateforme |  |
| GET | `/v1/admin/swaps` | console de la plateforme |  |
| GET | `/v1/aliases` | `payments:read` |  |
| POST | `/v1/aliases` | `payments:write` |  |
| GET | `/v1/aliases/availability/{name}` | `payments:read` | ✓ |
| GET | `/v1/aliases/by-address/{address}` | `payments:read` | ✓ |
| POST | `/v1/aliases/challenges` | `payments:write` |  |
| GET | `/v1/aliases/resolve/{name}` | `payments:read` | ✓ |
| DELETE | `/v1/aliases/{name}` | `payments:write` |  |
| POST | `/v1/aliases/{name}/addresses` | `payments:write` |  |
| DELETE | `/v1/aliases/{name}/addresses/{addressId}` | `payments:write` |  |
| POST | `/v1/aliases/{name}/recovery` | console de la plateforme |  |
| POST | `/v1/aliases/{name}/recovery/complete` | `payments:write` |  |
| GET | `/v1/assets` | — | ✓ |
| GET | `/v1/balances` | `payments:read` |  |
| POST | `/v1/blindpay/webhooks` | aucun — `@Public()`, signature Svix |  |
| GET | `/v1/customers` | `customers:read` |  |
| POST | `/v1/customers` | `customers:write` |  |
| GET | `/v1/customers/{id}` | `customers:read` |  |
| PATCH | `/v1/customers/{id}` | `customers:write` |  |
| DELETE | `/v1/customers/{id}` | `customers:write` |  |
| GET | `/v1/health/liveness` | aucun — `@Public()` |  |
| GET | `/v1/health/readiness` | aucun — `@Public()` |  |
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
| GET | `/v1/liquidity-pools` | l'un de `liquidity:read`, `swaps:read` | ✓ |
| POST | `/v1/liquidity-pools/deposit` | l'un de `liquidity:write`, `swaps:write` | ✓ |
| GET | `/v1/liquidity-pools/operations` | l'un de `liquidity:read`, `swaps:read` |  |
| GET | `/v1/liquidity-pools/operations/{id}` | l'un de `liquidity:read`, `swaps:read` |  |
| POST | `/v1/liquidity-pools/operations/{id}/submit` | l'un de `liquidity:write`, `swaps:write` | ✓ |
| GET | `/v1/liquidity-pools/positions` | l'un de `liquidity:read`, `swaps:read` | ✓ |
| POST | `/v1/liquidity-pools/withdraw` | l'un de `liquidity:write`, `swaps:write` | ✓ |
| GET | `/v1/liquidity-pools/{poolId}` | l'un de `liquidity:read`, `swaps:read` | ✓ |
| GET | `/v1/defindex/vaults` | l'un de `liquidity:read`, `swaps:read` | ✓ |
| GET | `/v1/defindex/vaults/{vault}` | l'un de `liquidity:read`, `swaps:read` | ✓ |
| GET | `/v1/defindex/vaults/{vault}/balance` | l'un de `liquidity:read`, `swaps:read` | ✓ |
| POST | `/v1/defindex/vaults/{vault}/deposit` | l'un de `liquidity:write`, `swaps:write` | ✓ |
| POST | `/v1/defindex/vaults/{vault}/withdraw` | l'un de `liquidity:write`, `swaps:write` | ✓ |
| POST | `/v1/defindex/submit` | l'un de `liquidity:write`, `swaps:write` | ✓ |
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
| GET | `/v1/pollar/oauth/callback` | aucun — `@Public()` |  |
| GET | `/v1/pollar/oauth/callback/{state}` | aucun — `@Public()` |  |
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

### Réponses d'erreur

Chaque échec renvoie la même enveloppe, et `code` en est la partie stable et lisible
par machine — basez vos branchements sur lui plutôt que sur `message`, qui est de la prose
et peut être reformulé :

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

L'enveloppe et l'enum `code` complète sont publiées dans la spécification OpenAPI sous le nom
`ApiErrorBodyEntity` sur chaque opération, de sorte que les clients générés obtiennent aussi le
type d'erreur (source : `ApiErrorCode` dans `src/common/errors/api-error.ts`). **Les codes ne
sont jamais renommés une fois publiés** ; de nouveaux peuvent être ajoutés, traitez donc un
code inconnu selon son statut HTTP.

Quelques-uns, faciles à confondre :

| Code | Statut | Signification |
| ---- | ------ | ------------- |
| `insufficient_scope` | 403 | La clé API ne possède pas le scope. Reprovisionnez la clé |
| `account_disabled` | 403 | Un opérateur a désactivé ce compte fiat. Ce n'est pas un problème de clé |
| `gateway_required` | 403 | La requête n'est pas passée par APISIX |
| `admin_console_only` | 403 | La route appartient à la console de la plateforme (`/v1/admin`, le lancement d'une récupération d'alias). Aucune clé API ne peut l'appeler |
| `elevated_key_required` | 403 | La route écrit dans quelque chose que tous les tenants partagent (l'annuaire des utilisateurs Pollar). Seule une clé élevée (admin) peut l'appeler ; plus de scopes n'y changent rien |
| `pollar_identity_required` | 403 | La passerelle n'a transmis aucun e-mail de compte pour cette clé, donc une connexion Pollar ne peut pas y être rattachée |
| `pollar_identity_mismatch` | 403 | La connexion Pollar a été terminée par un autre compte que celui de la clé. La session a été révoquée, pas renvoyée |
| `idempotency_conflict` | 409 | Cette `Idempotency-Key` (ou le mémo d'une intention de paiement) a déjà produit une ressource pour une requête *différente*. Répétez la requête d'origine, ou utilisez une nouvelle clé |
| `kyc_state_invalid` | 409 | Une transition d'état KYC illégale — pas une requête en double |
| `operation_in_flight` | 409 | Une opération concurrente est encore en cours de règlement |
| `payload_expired` | 409 | Le corps de la livraison a dépassé la durée de rétention et ne peut pas être renvoyé |
| `provider_unavailable` | 503/504 | BlindPay ou Horizon est injoignable. Réessayez |
| `misconfigured` | 503 | Une erreur de configuration côté serveur. Réessayer n'y changera rien |

### Exécuter plusieurs réplicas

APISIX répartit la charge entre les instances, donc chaque tâche de fond s'exécute sur chaque
réplica. Les changements de statut sont déjà sûrs — chacun est un compare-and-swap
`updateMany` protégé — mais des cycles en double multiplieraient les appels Horizon auprès
d'une API soumise à un rate limit. Chaque tâche prend donc un **verrou consultatif (advisory
lock) de niveau transaction** PostgreSQL (`AdvisoryLockService`) et saute son cycle lorsqu'un
autre réplica le détient :

| Tâche périodique               | Clé de verrou            |
| ------------------------------ | ------------------------ |
| `SettlementObserverService`    | `SettlementObserver`     |
| `StellarObserverService`       | `PaymentIntentObserver`  |
| `RequestLogRetentionService`   | `RequestLogRetention`    |
| Sweeper de livraison des webhooks | `WebhookDeliverySweeper` |
| `PollarOauthSweeperService`    | `PollarOauthSweeper`     |
| `RateLimitPruneService`        | `RateLimitPrune`         |
| `PollarWalletProvisionSweeperService` | `PollarWalletProvisionSweeper` |
| `AliasChallengeSweeperService` | `AliasChallengeSweeper`  |

`pg_try_advisory_xact_lock` ne bloque jamais, et il est libéré à la fin de la transaction,
même en cas de crash ou de connexion perdue. Contrairement à un verrou de niveau session, il
fonctionne aussi derrière PgBouncer en mode transaction pooling.

Les identifiants de verrou se trouvent dans l'enum `AdvisoryLockKey`. Ne renumérotez pas un
identifiant existant — pendant un déploiement progressif, les anciens et les nouveaux réplicas
prendraient des verrous différents — et ne réutilisez pas un identifiant retiré.

### Validation des paiements et observateur on-chain

Un paiement est confirmé auprès du réseau Stellar en un seul endroit
(`StellarVerifierService`) : la transaction doit être **réussie**, contenir un
**paiement natif (XLM)** vers la `destination` de l'intention pour le **montant exact**,
porter — lorsque l'intention a un mémo — un **mémo correspondant** (`memo_type: id`), et
avoir été clôturée **au plus tôt une minute avant la création de l'intention**
(`TX_CREATED_AT_SKEW_MS`). C'est ce plancher d'ancienneté qui empêche un ancien paiement
on-chain aux mêmes conditions de régler une nouvelle intention.

Deux chemins utilisent cette règle unique :

- **Manuel :** `POST /v1/payment-intents/:id/validate` avec `{ "txHash": "<64-hex>" }`.
  En cas de correspondance, l'intention passe à `SUCCEEDED` (et `txHash` est enregistré)
  et un webhook `PAYMENT_INTENT_SUCCEEDED` est émis. Une tx qui a échoué on-chain ne fait
  passer l'intention à `FAILED` **que s'il s'agissait du propre paiement de cette
  intention** — même mémo, même destination et même actif. Toute autre transaction,
  échouée ou non, est une non-correspondance qui laisse le statut inchangé, afin que la tx
  correcte puisse encore être soumise. Un `txHash` transmis via
  `PATCH /v1/payment-intents/:id` ne règle jamais une intention à lui seul : il doit être un
  hash hexadécimal de 64 caractères, il est stocké en minuscules, et il n'est unique que
  parmi les intentions du consumer appelant (`409 idempotency_conflict` en cas de collision
  avec une autre des siennes).
- **Automatique (observateur permanent) :** `StellarObserverService` interroge Horizon
  toutes les `OBSERVER_INTERVAL_MS` à la recherche d'intentions `PENDING` — par le
  `txHash` déclaré, ou en parcourant les paiements vers la destination — et finalise les
  correspondances de la même manière, de sorte que les statuts changent et que les
  événements sont émis **sans que personne n'appelle l'API**. Un cycle traite au plus
  `OBSERVER_MAX_INTENTS_PER_CONSUMER` (10) intentions par consumer et ne parcourt jamais
  une intention expirée, de sorte qu'un seul consumer ne peut pas retarder le règlement de
  tous les autres. Désactivez-le pour le développement local avec `OBSERVER_ENABLED=false`.

**L'expiration vérifie d'abord la chaîne.** Une intention passée sa durée de vie est vérifiée
une dernière fois avant d'être marquée `EXPIRED` : si son paiement est on-chain, elle passe à
`SUCCEEDED` à la place, et si Horizon est injoignable, elle est laissée pour le prochain
cycle. Lorsque le hash de ce paiement se trouve déjà sur une autre intention du même
consumer, l'intention est expirée plutôt que retentée indéfiniment. Un paiement vérifié après
l'expiration, par l'observateur ou par `validate`, fait tout de même passer une intention
`EXPIRED` à `SUCCEEDED` et émet `PAYMENT_INTENT_SUCCEEDED` ; ne traitez donc pas `EXPIRED`
comme un état final. Le balayage relit les paiements vers la destination jusqu'à la création
de l'intention, au maximum 1 000 (5 pages de 200) ; si une destination en reçoit davantage
pendant la durée de vie d'une intention, appelez `validate` avec le hash.

### Rétention des journaux de requêtes API

Chaque requête entrante, à l'exception de `/v1/health` et `/docs`, est ajoutée à
`request_log` par `LoggingInterceptor` et alimente la vue **API logs** du tableau de bord
(`GET /v1/logs`). Les lignes incluent le chemin, le statut, la durée et — lorsqu'ils sont
présents — l'`ip` / `userAgent` du payeur.

Le trafic du tableau de bord (`X-Cosmos-Internal`) est **enregistré et marqué**
(`request_log.internal`), et non ignoré, et la vue des journaux API filtre sur cette
colonne ; aucun en-tête de requête ne peut donc tenir du trafic à l'écart du journal.

Les lignes ne sont **pas conservées indéfiniment**. `RequestLogRetentionService` supprime
les lignes plus anciennes que `REQUEST_LOG_RETENTION_DAYS` (par défaut **30**) sur un timer
(`REQUEST_LOG_PRUNE_INTERVAL_MS`, par défaut **1h**). Chaque cycle supprime par petits lots de
`REQUEST_LOG_PRUNE_BATCH_SIZE` (par défaut **1000**) et continue de boucler jusqu'à ce que
l'arriéré soit résorbé ou que `REQUEST_LOG_PRUNE_MAX_PER_CYCLE` (par défaut **50000**) soit
atteint, de sorte qu'un historique volumineux peut rattraper son retard sans maintenir un long
verrou de table. Définissez `REQUEST_LOG_RETENTION_DAYS=0` pour désactiver entièrement la
purge (le service l'indique dans ses journaux au démarrage). L'index composite sur
`(consumer, createdAt)` garde la requête du tableau de bord rapide à mesure que le volume
augmente.

### Activité client (ce que rapportent le wallet et le tableau de bord)

`request_log` n'enregistre que les requêtes qui ont atteint ce service. Il ne voit pas un
wallet qui a planté sur son écran d'envoi, une signature annulée par l'utilisateur ou une page
du tableau de bord qui a échoué avant d'envoyer quoi que ce soit ; les clients rapportent donc
eux-mêmes ces événements à `POST /v1/activity/events`.

- **Par lots.** Les clients mettent les événements en file d'attente puis les envoient, de
  sorte qu'un wallet hors ligne les envoie au lancement suivant. Jusqu'à
  `ACTIVITY_MAX_BATCH` (100) par requête.
- **Réessai sans risque.** Un événement peut porter le propre `eventId` du client ;
  `(consumerId, eventId)` est unique et les doublons sont ignorés. La réponse indique
  `accepted` et `duplicates`.
- **Attribution par la passerelle.** Les lignes sont écrites au nom du consumer authentifié
  par APISIX ; aucun champ du corps ne sert à cela.
- **Tolérance aux payloads incorrects.** Un `message` trop long est tronqué et des `props`
  trop volumineuses sont remplacées par `{"_dropped": "props_too_large"}`, au lieu de rejeter
  le lot entier.
- **Horodatages bornés.** `occurredAt` est remplacé par l'heure de réception lorsqu'il est en
  avance de plus de cinq minutes ou en retard de plus de sept jours. Les deux horodatages sont
  conservés : `at` (celui du client) et `receivedAt`.

Pour les relire :

| Route                   | Scope             | Renvoie                                                              |
| ----------------------- | ----------------- | -------------------------------------------------------------------- |
| `GET /v1/activity/events` | `activity:read` | Le flux, du plus récent au plus ancien. Filtres : `source`, `level`, `category`, `type` (préfixe), `network`, `since`/`until` |
| `GET /v1/activity/summary` | `activity:read` | Comptages par level/source/category, principaux types d'événements, principales erreurs, sessions, appareils, une série quotidienne |

`level` sur le flux est un **minimum**, pas une correspondance exacte : `level=warn`
renvoie les avertissements *et* les erreurs.

`activity_event` contient une IP, un user agent et tout ce que le client y a joint ; la
table est donc purgée par la même tâche et par les mêmes lots bornés que `request_log` —
`ACTIVITY_RETENTION_DAYS`, par défaut **30**, `0` pour conserver les événements indéfiniment.

### Webhooks (notifier les intégrateurs)

Chaque intégrateur (consumer APISIX) enregistre un ou plusieurs endpoints de webhook.
Lorsqu'une intention de paiement change, la plateforme émet un événement de domaine ; le
**dispatcher** le diffuse vers chaque endpoint activé de ce consumer abonné au type
d'événement (abonnement vide = tous), enregistre chaque tentative à des fins de traçabilité,
et réessaie avec un backoff linéaire (variables d'environnement `WEBHOOK_*`).

Types d'événements : `PAYMENT_INTENT_CREATED`, `PAYMENT_INTENT_UPDATED`,
`PAYMENT_INTENT_SUCCEEDED`, `PAYMENT_INTENT_FAILED`, `PAYMENT_INTENT_CANCELLED`,
`PAYMENT_INTENT_DELETED`, `SWAP_CREATED`, `SWAP_SUBMITTED`, `SWAP_SUCCEEDED`,
`SWAP_FAILED`, `LIQUIDITY_CREATED`, `LIQUIDITY_SUBMITTED`, `LIQUIDITY_SUCCEEDED`,
`LIQUIDITY_FAILED`, plus ceux issus de BlindPay : `RECEIVER_UPDATED`, `PAYIN_CREATED`,
`PAYIN_UPDATED`, `PAYIN_COMPLETED`, `PAYOUT_CREATED`, `PAYOUT_UPDATED` et
`PAYOUT_COMPLETED`. La liste de référence est l'enum `WebhookEventType` dans
`prisma/schema.prisma`.

**Corps issus de BlindPay.** `RECEIVER_UPDATED` / `PAYIN_*` / `PAYOUT_*` ne transportent
que l'identité et l'état — identifiants, statut, montants, rails — jamais de données
personnelles. L'objet du fournisseur n'est pas transmis, car un payload de receiver est un
dossier KYC complet et s'abonner ne requiert que `webhooks:write`. Récupérez les détails via
l'API avec une clé qui détient `kyc:read` / `onramp:read` / `offramp:read`. La liste
d'autorisation des champs se trouve dans `src/blindpay/blindpay-event-redaction.ts`.

La livraison est découplée via `EventEmitter2` de NestJS (`webhook.event`), de sorte
qu'émettre une notification ne bloque jamais la requête API qui l'a déclenchée.

**Politique de destination sortante (SSRF) :** les endpoints doivent utiliser `https` et
ne se résoudre qu'en adresses publiques. L'enregistrement rejette le loopback, les plages
privées RFC1918, le link-local (`169.254.0.0/16`, y compris les métadonnées cloud
`169.254.169.254`) et les noms d'hôte de métadonnées connus. **Tout refus qui dépend de
l'hôte donne la même réponse** — « l'hôte n'est pas une destination autorisée » — et le
motif part dans le journal : distinguer « ne se résout pas ici » de « se résout en
`10.0.4.7` » et de « se résout vers le service de métadonnées » permettrait à quiconque
peut enregistrer un endpoint de cartographier le réseau où tourne ce service, une URL à
la fois. Une URL malformée, un schéma autre que https, des identifiants ou l'absence
d'hôte disent toujours exactement ce qui ne va pas : ils décrivent la chaîne envoyée, pas
le réseau. La même vérification est
exécutée à nouveau juste avant chaque livraison (le DNS peut changer après l'enregistrement).
Le client HTTP utilise `redirect: manual` (il ne suit jamais les `3xx`), des délais de
connexion et de lecture issus de l'environnement, et une taille maximale de corps de réponse.

| Variable | Défaut | Signification |
| -------- | ------ | ------------- |
| `WEBHOOK_CONNECT_TIMEOUT_MS` | `3000` | Budget de connexion (fait partie du timeout AbortSignal) |
| `WEBHOOK_READ_TIMEOUT_MS` | `5000` | Budget de lecture (fait partie du timeout AbortSignal) |
| `WEBHOOK_MAX_RESPONSE_BYTES` | `65536` | Plafond du corps de réponse lu |
| `WEBHOOK_TIMEOUT_MS` | `5000` | Repli historique si les timeouts séparés ne sont pas définis |
| `WEBHOOK_MAX_ATTEMPTS` / `WEBHOOK_BACKOFF_MS` | `3` / `2000` | Boucle de réessai en processus, par tentative de livraison |
| `WEBHOOK_SWEEP_ENABLED` | `true` | Récupère les livraisons bloquées par un crash. L'interrupteur d'incident — définissez `false` pour arrêter la relivraison vers un intégrateur en pleine défaillance |
| `WEBHOOK_SWEEP_INTERVAL_MS` | `60000` | Fréquence à laquelle un réplica tente un balayage (un seul l'emporte par cycle) |
| `WEBHOOK_PAYLOAD_RETENTION_DAYS` | `30` | Passé ce délai, le corps stocké d'une livraison réglée est remplacé par un marqueur de caviardage. `0` conserve les corps indéfiniment |

**Une livraison peut être tentée jusqu'à 9 fois, pas 3.** `WEBHOOK_MAX_ATTEMPTS` borne une
boucle de réessai en processus. Le sweeper reprend ensuite les livraisons qui restent sous
`WEBHOOK_MAX_ATTEMPTS × 3` tentatives au total, réparties sur plusieurs heures, de sorte
qu'une livraison interrompue par le redémarrage d'un pod n'est pas perdue.

**La relivraison ne fonctionne que dans la fenêtre de rétention.** Après
`WEBHOOK_PAYLOAD_RETENTION_DAYS`, le corps stocké est effacé (le journal des livraisons est
conservé). Le sweeper ignore ces lignes, et
`POST /v1/webhooks/:id/deliveries/:id/redeliver` renvoie `409 payload_expired`.

**Recevoir les webhooks.** Tout `2xx` vaut accusé de réception. Répondez dans le délai de
`WEBHOOK_READ_TIMEOUT_MS` (5s par défaut). L'ordre n'est pas garanti : réconciliez avec
l'API. Dédupliquez sur l'`id` de l'événement ; une relivraison réutilise l'`id` d'origine
(livraison au moins une fois).

**Migration des endpoints existants :** après le déploiement, exécutez

```bash
npm run webhooks:audit-destinations
```

Les lignes non sûres reçoivent `destinationBlocked=true` et `enabled=false`. Les intégrateurs
corrigent l'URL avec `PATCH /v1/webhooks/:id` `{ "url": "https://…" }` (la validation
s'exécute à nouveau et efface l'indicateur), ou réactivent l'endpoint une fois le DNS public.

**Payload** (corps POST envoyé à l'URL de l'intégrateur) :

```jsonc
{
  "id": "evt_...",                 // stable event id (use for idempotency)
  "type": "PAYMENT_INTENT_SUCCEEDED",
  "createdAt": "2026-...",
  "data": { /* the payment intent */ }
}
```

**En-têtes** :

- `X-Cosmos-Signature: t=<unixSeconds>,v1=<hexHmacSha256>` — HMAC-SHA256 de
  `${t}.${rawBody}` calculé avec le secret `whsec_...` de l'endpoint.
- `X-Cosmos-Event`, `X-Cosmos-Event-Id`, `X-Cosmos-Delivery`.

**Vérifier la signature (côté intégrateur) :**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody: string, header: string, secret: string): boolean {
  const [t, v1] = header.split(',').map((p) => p.split('=')[1]);
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
```

Le secret de signature est renvoyé **une seule fois**, sur `POST /webhooks` (et sur
`rotate-secret`) ; les réponses de liste et de lecture ne l'incluent jamais. Chaque tentative
est stockée (`webhook_delivery`) avec le statut, le nombre de tentatives, le code de réponse
et l'erreur — consultez-la via `GET /webhooks/:id/deliveries` et renvoyez-la avec la route
`redeliver`.

La liste, la lecture et la mise à jour renvoient exactement les champs documentés de
l'endpoint, et la création ainsi que `rotate-secret` y ajoutent `secret`. Rien d'autre sur la
ligne ne quitte le service — ni `consumerId`, ni les colonnes `previousSecret` /
`previousSecretExpiresAt` qu'une rotation antérieure avec fenêtre de grâce a écrites.

**`ping` et `redeliver` sont limitées en débit**, par consumer et adresse cliente :
`POST /v1/webhooks/:id/ping` 20 et
`POST /v1/webhooks/:id/deliveries/:deliveryId/redeliver` 30 par 10 minutes
(`429 rate_limited`). Les deux font envoyer par ce service des requêtes signées vers une URL
que vous avez choisie, et `redeliver` exécute toute la boucle de réessai à l'intérieur de la
requête. Pour un arriéré important, laissez le sweeper réessayer plutôt que de relivrer une
par une.

### OpenAPI / Swagger

**Note de sécurité :** `GET /docs`, `/docs/json` et `/docs/yaml` sont montés en tant que
**middleware Express**, et non comme contrôleurs Nest ; ils ne passent donc **pas** par
`ApisixGuard` ni par `PermissionsGuard` — quiconque peut atteindre le port du service peut
récupérer la spécification. En production, la documentation est **désactivée par défaut**
(`NODE_ENV=production` et pas de `SWAGGER_ENABLED`). Définissez `SWAGGER_ENABLED=true`
uniquement sur un réseau de confiance.

Exportez la spécification vers des fichiers — ni base de données ni vrai secret de passerelle
ne sont nécessaires :

```bash
npm run openapi:generate
# writes openapi/openapi.json and openapi/openapi.yaml
```

La CI régénère les deux fichiers versionnés et rejette toute dérive. Exécutez la même
vérification avant de committer une modification de contrôleur ou de DTO :

```bash
npm run openapi:check
```

Les chemins de la spécification incluent déjà la version (`/v1/...`). Pour indiquer un hôte
de passerelle dans les `servers` de la spécification, définissez `OPENAPI_SERVER_URL` avant
la génération :

```bash
OPENAPI_SERVER_URL=https://gateway.example.com npm run openapi:generate
```

Les deux en-têtes APISIX (`X-Gateway-Secret`, `X-Consumer-Username`) sont documentés comme
schémas de sécurité dans la spécification.

### Créer des intentions — deux opérations SEP-7, deux endpoints

Selon [SEP-7](https://stellar.org/protocol/sep-7), les opérations `tx` et `pay` prennent
des **paramètres différents** et produisent des **réponses différentes** ; chacune a donc
son propre endpoint, son propre DTO et son propre schéma de réponse. Le service ne détient
aucune clé — il se contente d'assembler la requête destinée au wallet du client (il renvoie
`uri` + `qr`, plus `xdr` pour `tx`). L'actif est par défaut le **XLM natif** lorsque
`assetCode` est omis (ou vaut `XLM`/`native`) ; tout autre actif requiert `assetIssuer`.

**Le réseau est dicté par le type de clé API** que transmet la passerelle : une clé `prod` →
public (mainnet), une clé `dev` → testnet. `STELLAR_NETWORK` n'est qu'un repli pour le
développement local sans passerelle. Chaque intention stocke son propre réseau, et tous les
appels Horizon (construction, validation, observateur) le ciblent. Chaque intention est
stockée (table `payment_intent`) et rattachée au consumer appelant :
`PENDING → SUBMITTED → SUCCEEDED/FAILED/CANCELLED/EXPIRED`. La seule façon de sortir d'un
statut final est `EXPIRED → SUCCEEDED`, sur un paiement vérifié on-chain.

**Le mémo est un `MEMO_ID` obligatoire** — il identifie le paiement on-chain et rend la
création **idempotente** : `(consumer, memo)` est unique, donc recréer une intention avec le
même mémo **et les mêmes conditions** renvoie l'intention d'origine. Le même mémo avec
n'importe quelle condition différente — le type, le réseau, la destination, le montant,
l'actif, `msg`, `callback`, ou `source` pour `tx` — donne `409 idempotency_conflict`, et
l'erreur ne dit rien de l'intention stockée. C'est important sous la clé publique partagée,
où chaque wallet anonyme est le même consumer. Les deux constructeurs partagent un budget
de **30 appels par minute** par consumer et adresse cliente (`429 rate_limited`) : chacun
lit le compte du payeur depuis Horizon et écrit une ligne, et sous la clé publique
partagée l'adresse est tout ce qui sépare un wallet anonyme du suivant. Si vous ne passez
pas `memo`, un uint64 aléatoire est généré.

**`POST /v1/payment-intents/tx`** — le payeur (`source`) est connu, nous construisons donc
la `TransactionEnvelope` non signée et une URI `web+stellar:tx?xdr=...`.

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

**`POST /v1/payment-intents/pay`** — pas de source, nous ne renvoyons donc qu'une URI
`web+stellar:pay?destination=...` (le wallet choisit l'actif et le chemin source).

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

Exemple de réponse `tx` :

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

Réseau, Horizon, frais et timeout se configurent via les variables d'environnement
`STELLAR_*` (voir `.env.example`). Le réseau par défaut est le **testnet**, par sécurité —
définissez `STELLAR_NETWORK=public` pour le mainnet (fonds réels).

## La clé API publique partagée

Le wallet open source embarque une clé API que tout le monde partage, de sorte que n'importe
qui peut effectuer un swap, ajouter de la liquidité ou créer un lien de paiement sans
s'inscrire. Ces appels paient la commission du plan `community` (150 bps, le taux le plus
élevé) ; l'inscription donne accès à un taux plus bas. La passerelle injecte le taux
exactement comme pour une clé privée (voir `resolvePlanCommissionBps`).

La différence tient à l'isolation entre tenants. Chaque appelant anonyme arrive sous le même
consumer APISIX, et les endpoints de lecture filtrent les lignes par consumer :

```ts
// swaps.service.ts
where: { id, consumer: { apisixUsername: consumer.username } }
```

Ainsi, `GET /v1/swaps` sous la clé publique renverrait l'historique des swaps de tous les
utilisateurs anonymes. Les scopes ne peuvent pas l'empêcher, puisque tout le monde détient la
même clé — et `POST /v1/swaps/quote` requiert `swaps:read`, le scope même qui liste
l'historique.

**`PublicKeyGuard` est une liste d'autorisation.** Le consumer public est refusé sur toute
route qui ne porte pas `@AllowPublicKey()`, de sorte que les nouvelles routes lui sont fermées
par défaut.

Accessibles avec la clé publique aujourd'hui :

| Route | Pourquoi c'est sûr |
| --- | --- |
| `POST /v1/swaps/quote` | Calcule le prix d'un chemin depuis Horizon ; une fonction pure de la requête |
| `POST /v1/swaps` | Construit une enveloppe non signée que l'appelant signe |
| `POST /v1/swaps/:id/submit` | Diffuse une enveloppe signée par l'appelant — rien sur le swap, pas même son statut, n'est répondu tant que le corps n'est pas l'enveloppe de ce swap porteuse d'une signature ; limité en débit |
| `POST /v1/liquidity-pools/deposit` \| `withdraw` | Construisent des enveloppes non signées |
| `POST /v1/liquidity-pools/operations/:id/submit` | Diffuse une enveloppe signée par l'appelant, sous les mêmes contrôles que le submit de swap ; limité en débit |
| `GET /v1/liquidity-pools` \| `/:poolId` \| `/positions` | Données on-chain publiques lues depuis Horizon |
| `POST /v1/payment-intents/tx` \| `pay` | Construisent une intention SEP-7 à partir de la requête |
| `POST /v1/activity/events` | Ingestion de télémétrie — voir ci-dessous |
| `GET /v1/assets` | Le catalogue public d'actifs |
| `GET /v1/aliases/resolve/:name` \| `availability/:name` \| `by-address/:address` | Un payeur qui résout un identifiant est précisément l'appelant anonyme pour lequel cette clé existe ; la réponse est une fonction pure de la requête et n'inclut jamais la boîte mail du propriétaire |

Refusées : `GET /v1/swaps`, `GET /v1/swaps/:id`,
`GET /v1/liquidity-pools/operations{,/:id}`, `GET /v1/activity/events`,
`GET /v1/activity/summary`, toutes les lectures d'intentions de paiement, toutes les routes
de propriétaire d'alias (revendiquer, lister, ajouter ou retirer une adresse, libérer,
récupérer), et tout ce qui se trouve sous `/v1/kyc`, `/v1/onramp`, `/v1/offramp` et
`/v1/webhooks`. Un wallet sans compte lit plutôt son historique depuis Horizon.

**La télémétrie est autorisée** pour que les rapports de plantage des wallets sans compte
arrivent quand même. Les événements reçus avec cette clé sont anonymes (un seul consumer
partagé) ; le wallet retire donc l'adresse, la destination, le montant et le txHash avant
l'envoi.

Le guard identifie le consumer public **soit** par le rôle transmis
(`X-Consumer-Role: public`), **soit** par le nom d'utilisateur `APISIX_PUBLIC_CONSUMER`.
Définissez les deux : si la passerelle cesse de transmettre les rôles, le nom d'utilisateur
correspond toujours, et sans le nom d'utilisateur le guard ne dépend que d'un en-tête.

## Swaps natifs Stellar (path payments)

Stellar n'a pas d'opération « swap » dédiée. L'échange d'actifs se fait avec un
**`PathPaymentStrictSend`**, qu'Horizon route automatiquement via la meilleure combinaison
disponible entre les **carnets d'ordres du DEX Stellar** et les **pools de liquidité AMM**.
Cosmos Pay l'encapsule dans un flux de swap qui, comme les intentions de paiement, est
**entièrement non custodial** — les fonds ne transitent jamais par le service. Celui-ci se
contente de :

1. **Coter** en interrogeant la recherche de chemins strict-send d'Horizon.
2. **Construire** la transaction non signée (un paiement optionnel des frais de plateforme +
   le path payment) et renvoyer son `xdr` + l'URI SEP-7 `tx` + le QR.
3. **Relayer** la transaction que le client signe dans son propre wallet.

```
quote → build XDR → customer signs in wallet → POST /submit → Stellar executes
```

Le réseau est dicté par le type de clé API (prod → public, dev → testnet), comme pour les
intentions de paiement, et chaque swap est **persisté** (table `swap`) et rattaché au
consumer appelant (`PENDING → SUBMITTED → SUCCEEDED/FAILED`).

**Frais (par organisation, appliqués côté serveur).** La commission correspond **au taux du
plan de l'organisation appelante**, injecté par la passerelle sous forme d'en-tête de
confiance (`X-Plan-Swap-Fee-Bps`) que la plateforme développeur dérive du plan de
l'organisation. Ce n'est **jamais un paramètre de requête**, et APISIX écrase toute copie
fournie par le client, de sorte que le taux ne peut être ni contourné ni réduit. Les frais
sont prélevés sur l'**actif source** et versés au wallet de la plateforme
(`STELLAR_SWAP_FEE_WALLET`) sous la forme d'une première opération de paiement ; le **reste**
est routé via le swap. Si des frais de plan s'appliquent mais qu'aucun wallet de plateforme
n'est configuré, la création du swap échoue avec `503` (mauvaise configuration de
l'opérateur). `STELLAR_SWAP_FEE_BPS` n'est qu'un repli pour le développement local sans
passerelle (et il est lui-même désactivé lorsqu'aucun wallet n'est défini).

**Slippage.** L'estimation de la cotation, réduite de `slippageBps` (par défaut
`STELLAR_SWAP_SLIPPAGE_BPS`, plafonné par `STELLAR_SWAP_MAX_SLIPPAGE_BPS`), devient le
`destMin` on-chain du path payment — de sorte que le swap **est annulé** plutôt que de
livrer moins que ce que l'appelant a accepté.

**Trustline.** Un actif de destination non natif doit déjà faire l'objet d'une trustline sur
le compte de destination ; l'étape de construction le vérifie et renvoie sinon une erreur
explicite. (Le XLM ne nécessite pas de trustline.)

**`POST /v1/swaps/quote`** — prix uniquement, rien n'est persisté (`swaps:read`).

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

**`POST /v1/swaps`** — construit la transaction à signer (`swaps:write`). Accepte les mêmes
champs plus `source` (le compte qui paie et signe) ; `destination` vaut par défaut `source`
(un swap vers soi-même) et un `memo` optionnel (MEMO_ID) est reporté on-chain.

**Idempotence** optionnelle : envoyez un en-tête `Idempotency-Key` (recommandé) ou
`idempotencyKey` dans le corps. Une nouvelle tentative avec la même clé **et la même
requête** — réseau, source, destination, les deux actifs, montant, slippage et mémo — renvoie
le swap **existant** (`id` + `txHash`) au lieu de construire une autre transaction. La même
clé avec une requête différente donne `409 idempotency_conflict`, et l'erreur ne dit rien du
swap stocké. Les dépôts et retraits de liquidité suivent la même règle, en comparant aussi le
type d'opération. Sans clé, la contrainte unique `(network, txHash)` rejette tout de même
une reconstruction identique octet pour octet avec **409** (collision de séquence / XDR).
Lorsque `STELLAR_SWAP_SINGLE_INFLIGHT=true`, un second swap `PENDING` non expiré pour le
même `(consumer, source, network)` renvoie aussi **409** en indiquant l'identifiant
existant (**désactivé** par défaut — les swaps distincts simultanés depuis un même compte
restent autorisés). Seul un swap qui **pourrait déjà être on-chain** retient ce garde-fou :
une ligne dont le compte n'a pas encore consommé le numéro de séquence ne peut pas avoir
été réglée, et le swap en cours de construction prend ce même numéro — au plus l'un des
deux pourra donc aboutir. N'importe qui peut indiquer n'importe quelle `source` : sans ce
test, un seul swap de poussière gelait les swaps du compte d'un tiers pendant toute une
fenêtre d'expiration — et, sous la clé publique partagée, aussi longtemps que l'attaquant
recommençait.

```jsonc
// response → { id, status: "PENDING", network, sendAmount, feeAmount, swapAmount,
//              destEstimated, destMin, path, xdr, uri: "web+stellar:tx?xdr=…", qr, txHash, … }
```

**Le devis et la construction sont eux aussi limités**, par consumer et adresse
cliente : **60 devis par minute** et **20 constructions par minute**, dans des
compartiments distincts de celui du submit. Un devis ne persiste rien et coûte tout de
même une recherche de chemin strict-send, l'appel le plus cher que ce service adresse à
Horizon — et ce budget par IP est partagé par les swaps, les pools de liquidité et les
intentions de paiement : un prix interrogé en boucle dégradait donc les trois à la fois
pour tous les appelants anonymes.

**`POST /v1/swaps/:id/submit`** — relaie l'enveloppe signée (`swaps:write`).

```jsonc
// request
{ "signedXdr": "AAAAAgAAA…(signed base64 XDR)…" }
// response
{ "submitted": true, "status": "SUCCEEDED", "txHash": "…", "swap": { … } }
// on a network rejection → { "submitted": false, "status": "FAILED", "reason": "…", "resultCodes": ["op_under_dest_min"], "swap": { … } }
```

Avant la diffusion, le service vérifie que le hash de la transaction signée correspond à
celui de la transaction qu'il a construite ; il ne relaie donc jamais une transaction
arbitraire. Un swap émet les événements webhook `SWAP_CREATED` / `SWAP_SUBMITTED` /
`SWAP_SUCCEEDED` / `SWAP_FAILED` via le même dispatcher.

**Le submit est strict sur ce qu'il relaie.** Rien sur le swap — pas même son statut — n'est
répondu tant que `signedXdr` n'est pas analysable, ne hash pas vers le `txHash` du swap et ne
porte pas au moins une signature ; le `xdr` non signé de la réponse de création donne donc
`400 validation_failed`. Un swap dont l'enveloppe a dépassé ses bornes temporelles
(`STELLAR_TX_TIMEOUT`, 300 s par défaut) donne `400 invalid_state_transition` et n'est pas
diffusé ; s'il a atteint le réseau à temps, l'observateur le règle tout de même. Après un rejet
réseau, la même enveloppe peut être resoumise au plus **3** fois, puis il faut construire un
nouveau swap — une nouvelle tentative après `503 provider_unavailable` ne compte pas. La route
autorise **20 appels par minute** par consumer et adresse cliente (`429 rate_limited`) ; sous la
clé publique partagée, chaque wallet anonyme est un même consumer, de sorte que des wallets
derrière un même NAT partagent ce budget.
`POST /v1/liquidity-pools/operations/:id/submit` suit les mêmes règles, avec son propre
compartiment, et `POST /v1/liquidity-pools/deposit` · `/withdraw` partagent un budget de
**20 constructions par minute** — les deux sens d'un même flux, des compartiments séparés
ne feraient que laisser une boucle alterner entre eux et prendre les deux.

## Alias — identifiants de paiement revendicables

Un alias permet à un payeur de saisir `emanuel250` au lieu de `GA5ZSE…`. Les payeurs font
confiance à ce nom juste avant d'envoyer de l'argent ; les règles ci-dessous sont donc
strictes : une erreur signifie un paiement vers le mauvais compte.

### Revendiqué en prouvant le contrôle d'une clé, pas en le demandant

```
wallet ──1. POST /v1/aliases/challenges {name, address, network} ──▶ nonce + the EXACT message to sign
wallet ──2. signs SHA-256(domain ‖ 0x00 ‖ uint32be(length) ‖ message) with that address's key
wallet ──3. POST /v1/aliases {name, email, nonce, signature} ────────▶ alias bound to the calling consumer
```

- **Signez le message exact renvoyé par le service.** Ne le reconstruisez pas côté client.
- **La signature porte sur un condensé étiqueté par un domaine, jamais sur une transaction.**
  Rien de ce qui est signé dans ce flux ne peut être soumis au réseau, et le domaine
  (`Cosmos Pay alias claim v1`) est propre à cette fonctionnalité, de sorte qu'une signature
  obtenue par une autre dapp ne peut pas servir de revendication.
- **La finalité fait partie des octets signés** (`CLAIM`, `ADD_ADDRESS`, `RECOVER`), de
  sorte qu'une signature recueillie pour ajouter une adresse ne peut pas être rejouée pour
  terminer une récupération.
- **L'adresse provient du challenge, pas du corps de la revendication.** La revendication
  n'a pas de champ d'adresse, donc personne ne peut signer pour une adresse et en
  enregistrer une autre.
- **Les challenges sont à usage unique et durent cinq minutes.** La signature est vérifiée
  *avant* que le challenge ne soit consommé, de sorte qu'une signature invalide ne peut pas
  consommer le nonce de quelqu'un d'autre, et la consommation est un compare-and-swap.
- **Une concurrence est tranchée par l'index unique sur `alias.name`**, et non par une
  vérification préalable ; le perdant reçoit `409 alias_taken`.

### Ce qu'un identifiant peut être

`a-z` en minuscules, `0-9` et `_` (jamais à l'une ou l'autre extrémité), 3–32 caractères,
ramenés en minuscules avant que l'unicité ne soit évaluée. Pas d'Unicode : l'ensemble des
homoglyphes est illimité, et aucune normalisation ne rend un `а` cyrillique sûr à afficher à
côté d'un montant. Sont également refusés : les mots réservés (`admin`, `support`,
`cosmospay`, `stellar`, …) et tout ce qui ressemble à un compte Stellar (`g` ou `m` suivi d'au
moins 20 caractères base32). La règle se trouve dans `src/aliases/alias-name.ts`.

### Plusieurs adresses, un seul nom

Un alias pointe vers jusqu'à 20 adresses réparties sur plusieurs réseaux — un téléphone, un
ordinateur, un cold wallet, le testnet — avec exactement une adresse principale par réseau,
garantie par un index unique partiel. Ajouter une adresse requiert **deux** preuves :
l'appelant possède l'alias, et la nouvelle adresse signe son propre challenge `ADD_ADDRESS`.
La dernière adresse restante ne peut pas être retirée (libérez plutôt l'alias), et un
consumer peut détenir au plus 25 alias.

Un alias `SUSPENDED` (suspendu par un opérateur) ne se résout vers rien.

### La récupération passe par l'e-mail et par la console de la plateforme

Une revendication enregistre un e-mail de récupération, afin que perdre une clé ne signifie
pas perdre le nom. La récupération se déroule ainsi :

1. La **console de la plateforme** appelle `POST /v1/aliases/:name/recovery {email}`. La
   réponse est identique, que l'identifiant et la boîte mail correspondent ou non ; en cas de
   correspondance, elle porte un jeton à usage unique (30 minutes, stocké uniquement sous
   forme de SHA-256), que la console envoie par e-mail. Ce service n'envoie aucun e-mail.
2. L'utilisateur obtient un challenge `RECOVER` pour la nouvelle clé et appelle
   `POST /v1/aliases/:name/recovery/complete {token, address, network, nonce, signature}`
   avec sa propre clé API. Les deux preuves sont requises : le jeton prouve la boîte mail,
   la signature prouve la clé.
3. La propriété passe au consumer appelant et **toutes les adresses précédentes sont
   supprimées**, de sorte que quiconque détient les anciennes clés cesse de recevoir les
   paiements.

L'étape 1 est réservée à la console parce que le jeton prouve le contrôle de la boîte mail ;
il ne doit donc parvenir qu'à celui qui envoie l'e-mail. `ConsoleOnlyGuard` refuse tout
appelant muni d'une clé API avec `403 admin_console_only` avant que l'alias ne soit
recherché, et la route ne figure pas dans le contrat publié. Un alias suspendu ne peut pas être
récupéré.

Un jeton de récupération peut être présenté **cinq** fois. Une présentation dont le challenge
ou la signature échoue en consomme tout de même une, et la sixième est refusée ; le
propriétaire peut lancer une autre récupération. Un jeton qui ne correspond à aucune
récupération active de cet alias reçoit le même `400 alias_recovery_invalid` et ne change
rien, de sorte que personne ne peut épuiser la récupération d'un propriétaire en envoyant
n'importe quoi. `POST /v1/aliases/:name/recovery/complete` autorise 10 appels et
`POST /v1/aliases/challenges` 30 appels par 10 minutes, par consumer et adresse cliente
(`429 rate_limited`).

Les challenges et récupérations expirés sont supprimés un jour après leur expiration par
`AliasChallengeSweeperService` (toutes les heures, un seul réplica par cycle).

### Routes

| Méthode | Chemin | Scope | Description |
| ------- | ------ | ----- | ----------- |
| GET | `/v1/aliases/resolve/:name` | `payments:read` · clé publique | Les adresses vers lesquelles un alias se résout (`?network=` filtre) |
| GET | `/v1/aliases/availability/:name` | `payments:read` · clé publique | Si un identifiant est revendicable, et sinon pourquoi |
| GET | `/v1/aliases/by-address/:address` | `payments:read` · clé publique | Les alias qui pointent vers une adresse |
| POST | `/v1/aliases/challenges` | `payments:write` | Un nonce et le message exact à signer |
| POST | `/v1/aliases` | `payments:write` | Revendiquer un alias avec une signature |
| GET | `/v1/aliases` | `payments:read` | Les alias de l'appelant |
| POST | `/v1/aliases/:name/addresses` | `payments:write` | Ajouter une adresse, signée par cette adresse |
| DELETE | `/v1/aliases/:name/addresses/:addressId` | `payments:write` | Retirer une adresse |
| DELETE | `/v1/aliases/:name` | `payments:write` | Libérer l'alias |
| POST | `/v1/aliases/:name/recovery` | _console de la plateforme uniquement_ | Lancer une récupération → un jeton que la console envoie par e-mail |
| POST | `/v1/aliases/:name/recovery/complete` | `payments:write` | Terminer une récupération avec le jeton et la signature de la nouvelle clé |

## BlindPay — onramp / offramp / KYC (fiat ⇄ stablecoin)

En plus des intentions de paiement on-chain, le service intègre
[BlindPay](https://www.blindpay.com/docs) pour faire circuler les fonds entre **fiat et
stablecoins** : entrée de fonds (**onramp / payin**), sortie de fonds (**offramp / payout**),
et le **KYC** obligatoire (les *receivers* BlindPay) qui conditionne les deux. Nous exploitons
**une instance BlindPay de plateforme par environnement de clé API** — production pour les
clés `prod` (`BLINDPAY_API_KEY` + `BLINDPAY_INSTANCE_ID`), développement pour les clés `dev`
(les variables `_DEV`) ; chaque receiver, wallet, compte bancaire,
payin et payout est répliqué dans notre Postgres et **rattaché au consumer APISIX appelant**,
de sorte que chaque intégrateur ne voit jamais que ses propres enregistrements. Le service
**ne détient jamais de clés blockchain** — l'offramp renvoie l'artefact à signer (contrat EVM
`approve` / XDR Stellar) et accepte en retour la tx signée, exactement comme les intentions de
paiement.

Les changements d'état sont synchronisés à partir des **webhooks Svix** de BlindPay (vérifiés
sur le corps brut) et **réémis** vers les propres endpoints de webhook de l'intégrateur sous
forme de nouveaux types d'événements (`RECEIVER_UPDATED`, `PAYIN_*`, `PAYOUT_*`) via le
dispatcher existant.

| Méthode | Chemin                                                | Scope          | Description |
| ------ | ----------------------------------------------------- | -------------- | ----------- |
| POST   | `/v1/kyc/receivers`                                   | `kyc:write`    | Créer un receiver (démarrer le KYC/KYB) |
| GET    | `/v1/kyc/receivers` · `/:id`                          | `kyc:read`     | Lister / lire (la lecture actualise le statut KYC) |
| PATCH  | `/v1/kyc/receivers/:id`                               | `kyc:write`    | Mettre à jour un receiver (une fois chez BlindPay, les champs d'identité exigent une clé élevée) |
| DELETE | `/v1/kyc/receivers/:id`                               | `kyc:write`    | Supprimer un receiver |
| POST   | `/v1/kyc/upload`                                      | `kyc:write`    | Envoyer un document KYC → `file_url` |
| GET    | `/v1/kyc/rails` · `/v1/kyc/bank-details?rail=`        | `kyc:read`     | Catalogue des rails / champs requis |
| POST   | `/v1/kyc/receivers/:id/wallets`                       | `kyc:write`    | Enregistrer un wallet blockchain |
| GET    | `/v1/kyc/receivers/:id/wallets/sign-message`          | `kyc:read`     | Message à signer (flux EOA sécurisé) |
| POST   | `/v1/kyc/receivers/:id/bank-accounts`                 | `kyc:write`    | Ajouter un compte bancaire fiat (tout rail) |
| POST   | `/v1/onramp/quotes`                                   | `onramp:write` | Coter un payin (expire au bout de ~5 min) |
| POST   | `/v1/onramp/payins`                                   | `onramp:write` | Créer un payin → instructions de financement |
| GET    | `/v1/onramp/payins` · `/:id`                          | `onramp:read`  | Lister / lire (la lecture actualise le statut) |
| POST   | `/v1/onramp/trustline`                                | `onramp:write` | Construire un XDR de trustline Stellar non signé |
| POST   | `/v1/onramp/receivers/:id/virtual-accounts`           | `onramp:write` | Créer un compte virtuel |
| POST   | `/v1/offramp/quotes`                                  | `offramp:write`| Coter un payout (EVM → contrat `approve`) |
| POST   | `/v1/offramp/payouts/authorize`                       | `offramp:write`| Construire la tx de payout Stellar/Solana non signée |
| POST   | `/v1/offramp/payouts`                                 | `offramp:write`| Créer un payout à partir d'une cotation |
| GET    | `/v1/offramp/payouts` · `/:id`                        | `offramp:read` | Lister / lire (la lecture actualise le statut) |
| POST   | `/v1/offramp/payouts/:id/documents`                   | `offramp:write`| Joindre un document de conformité |
| POST   | `/v1/blindpay/webhooks`                               | _public_       | Webhook BlindPay (Svix) entrant |

Les montants sont des **entiers en unités mineures** (p. ex. `$123.45` → `12345`).
Configurez le webhook du tableau de bord BlindPay vers `<gateway>/v1/blindpay/webhooks` et
définissez `BLINDPAY_WEBHOOK_SECRET` avec le secret de signature de cet endpoint — la valeur
`whsec_…` complète. Le démarrage échoue lorsque sa clé se décode en moins de 24 octets, et le
vérificateur refuse une telle clé dans tous les cas : un base64 invalide se décode en une clé
vide, avec laquelle n'importe qui peut signer. Laissez les
variables `BLINDPAY_*` vides pour désactiver la fonctionnalité : ces routes renvoient alors
`503` `misconfigured`, tout comme le webhook entrant tant que `BLINDPAY_WEBHOOK_SECRET`
n'est pas défini. Voir `.env.example`.

**Une clé `dev` n'atteint jamais l'instance de production.** L'environnement de la clé choisit
l'instance BlindPay comme il choisit le réseau Stellar, et chaque ligne répliquée enregistre
l'instance dont elle provient : les clés `dev` et `prod` d'un tenant — un seul consumer — voient
donc des receivers, wallets, comptes bancaires, cotations, payins et payouts distincts. Sans
instance de développement configurée, les routes BlindPay répondent `503` `misconfigured` aux
clés `dev`. Pointez les webhooks de tableau de bord des deux instances vers le même
`<gateway>/v1/blindpay/webhooks` et définissez `BLINDPAY_WEBHOOK_SECRET_DEV` pour celle de
développement : c'est le secret contre lequel une livraison se vérifie qui dit quelle instance
l'a envoyée.

**L'identité est relue avant d'atteindre BlindPay, y compris lors des modifications.** Tant
qu'un receiver n'est pas activé, un `PATCH` qui touche aux données KYC le renvoie en
`pending_review`. Une fois qu'il existe chez BlindPay, une clé de tenant ne peut modifier que
`external_id` et `image_url` ; tout autre champ renvoie `403` `kyc_review_required` sauf si la
clé est élevée (`X-Consumer-Role: admin`), car ce `PUT` réécrit l'identité directement chez le
fournisseur.

**Une approbation est arrimée au dossier qui a été relu.** La lecture d'un receiver
porte `dossierVersion`, qui compte chaque modification des données KYC soumises.
Renvoyez-la comme `expected_version` au moment d'approuver, et un dossier modifié depuis
votre lecture donne `409 kyc_state_invalid` au lieu de l'approbation de données que
personne n'a vues — une modification laisse le statut sur `pending_review`, l'approbation
seule ne pouvait donc pas s'en apercevoir. Ce qui a été validé est conservé dans
`reviewedVersion`, et `POST /v1/kyc/receivers/:id/enable` refuse de créer le receiver
chez BlindPay tant que les deux diffèrent.

**Les routes fiat ont des budgets.** Chaque écriture que le fournisseur conserve est
limitée par consumer et adresse cliente, et toute route adossée à BlindPay compte en
plus dans un plafond par consumer de **60 requêtes fournisseur par minute** : une seule
instance sert tous les tenants d'une clé, un tenant qui boucle sur les devis fait donc
échouer les payins des autres. Au-delà du budget, c'est `429 rate_limited` avec
`Retry-After`.

| Route | Budget (par consumer + adresse cliente) |
| ----- | --------------------------------------- |
| `POST /v1/kyc/upload` | 20 par 10 min |
| `POST /v1/kyc/terms-of-service` | 10 par 10 min |
| `POST /v1/onramp/quotes` · `POST /v1/offramp/quotes` | 30 par minute, compartiments séparés |
| `POST /v1/onramp/payins` | 10 par minute |
| `POST /v1/offramp/payouts/authorize` · `POST /v1/offramp/payouts` | 10 par minute, partagé |
| `POST /v1/offramp/payouts/:id/documents` | 20 par 10 min |
| `POST /v1/onramp/trustline` | 20 par minute |

### Les URL de redirection KYC sont soumises à une liste d'autorisation par consumer

Le flux des conditions d'utilisation envoie l'utilisateur vers BlindPay puis le ramène vers
une `redirect_url` fournie par l'intégrateur. Pour éviter une redirection ouverte, chaque
`redirect_url` passe deux contrôles :

| Couche | Règle | Où |
| ------ | ----- | -- |
| Forme | une URL `https` absolue sans identifiants intégrés (`user:pass@`), sans fragment (`#…`) et sans antislash, espace ni caractère de contrôle | `@IsRedirectUrl()` sur chaque DTO qui en porte une, et de nouveau dans la couche service |
| Hôte | présent dans la liste d'autorisation **du consumer appelant** — l'hôte exact, ou un sous-domaine à une frontière de label (`app.acme.com` correspond à `acme.com` ; `evilacme.com` non) | `KYC_REDIRECT_URL_WHITELIST`, appliquée dans la couche service |

```
KYC_REDIRECT_URL_WHITELIST={"cosmos_acme":["acme.com","app.acme.com"]}
```

Les règles de forme sont ce qui donne sa valeur à la vérification de l'hôte. Un
antislash est lu comme `/` à l'intérieur de l'autorité par un parseur WHATWG et comme
faisant partie du userinfo par d'autres : `https://app.acme.com\@evil.test` a donc deux
lectures honnêtes, et ce service n'est pas le dernier à la lire — la valeur part chez
BlindPay, revient sur une page hébergée et finit dans un navigateur. Les espaces et les
caractères de contrôle relèvent de la même catégorie, un fragment avale le `?tos_id=`
que le fournisseur ajoute, et des identifiants déplacent l'hôte de l'autre côté du `@`.

Elle **échoue en mode fermé** : un consumer sans entrée ne peut utiliser aucune redirection,
et un hôte avec un point final ou sous forme IDN est refusé plutôt que normalisé. Chaque
route qui accepte une `redirect_url` la vérifie, y compris l'approbation par l'admin, qui
utilise la liste du consumer auquel appartient le receiver. Un schéma ou un hôte refusé donne
un `400`.

## Pollar — connexion sociale qui renvoie un wallet Stellar

[Pollar](https://docs.pollar.xyz/docs) transforme une connexion Google/GitHub en compte
Stellar : il authentifie l'utilisateur, crée un wallet, conserve la clé sous sa garde dans
AWS KMS, ajoute les trustlines configurées et finance la réserve — l'utilisateur ne voit
jamais de phrase de récupération. Ce service l'expose sous la forme d'un **pont OAuth**.

### Pourquoi un pont et pas un simple relais

La connexion hébergée de Pollar est conçue pour un SDK navigateur. Elle envoie l'utilisateur
vers `GET /auth/{provider}` avec une clé publiable, un identifiant de session client et une
`redirect_uri` — et cette URI de redirection doit être un hôte **enregistré auprès de
Pollar**. Un wallet ne peut pas remplir ces conditions : un listener loopback ou un deep link
`cosmospay://` n'est jamais un hôte enregistré, et le wallet ne devrait pas manipuler ces
clés et identifiants de session. Le pont prend donc en charge le côté Pollar, et le wallet
n'a que deux étapes à faire : **ouvrir une autorisation, échanger un code**.

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

Après l'étape 6, le wallet communique directement avec Pollar : la réponse de l'échange
contient la `publishable_key` et l'`api_base_url`, que le wallet utilise pour lire les
soldes, construire et soumettre des transactions. **Ce service ne relaie pas ces appels.**

### Deux façons de récupérer le code

|                  | Flux par redirection                             | Flux par polling                                |
| ---------------- | ------------------------------------------------ | ----------------------------------------------- |
| Le wallet fournit | `redirect_uri` (doit figurer dans la liste d'autorisation) et un `code_challenge` PKCE | rien (PKCE optionnel) |
| Le code arrive   | sous forme de `?code=…&state=…` sur la redirection | depuis `GET /v1/pollar/oauth/sessions/{state}` |
| Le navigateur voit | votre propre URI                               | une simple page « vous pouvez fermer cette fenêtre » — jamais le code |
| À utiliser quand | le wallet dispose d'un deep link ou d'un listener loopback | il n'a ni l'un ni l'autre (borne, headless, vue intégrée) |

Chaque polling émet un nouveau code et invalide le précédent ; échangez donc le code issu de
votre dernier polling. Seul un SHA-256 du code est stocké.

**Préférez le flux par polling.** Le flux hébergé de Pollar ne renvoie pas le navigateur vers
le callback : il se termine sur sa propre page (`www.pollar.xyz/auth/status`) et marque la
session client `READY` côté Pollar. Tant qu'un handshake est `pending`, la route de polling
vérifie donc la session client auprès de Pollar et promeut le handshake dès que Pollar
signale `READY`.

- **Gardez la route de callback enregistrée auprès de Pollar.** Le flux par redirection en
  dépend.
- **Pollar est interrogé au plus une fois toutes les deux secondes par handshake**
  (`POLLAR_SESSION_PROBE_INTERVAL_MS`), une limite partagée entre les réplicas via
  `providerCheckedAt`. Un wallet qui interroge chaque seconde coûte 30 requêtes Pollar par
  minute, sur une clé dont le budget est de 200.

Un handshake dont Pollar rejette la session client (`INVALID_CLIENT_SESSION_ID`,
`EXPIRED_CLIENT_ID`, ou un `404`/`410`) est immédiatement clos comme `failed` avec ce code.

### Une connexion, un wallet sur les deux réseaux

Pollar exploite le mainnet et le testnet comme des applications distinctes, avec des paires de
clés distinctes ; une connexion hébergée ne crée donc un wallet que sur le réseau vers lequel
sa clé API se résout (`prod` → `public`, `dev` → `testnet` — voir `resolveNetwork`). Pour
donner à l'utilisateur un wallet sur les deux, un échange sur le **mainnet** l'enregistre
aussi sur le **testnet** via `POST /users/with-wallet` de la Server API, et
`POST /v1/pollar/oauth/token` rapporte les deux. Un échange sur le testnet ne provisionne
pas le mainnet : c'est sur le testnet qu'arrivent les clés `dev`, et une clé que n'importe
qui peut créer ne doit pas dépenser de vrais XLM pour une réserve mainnet à chaque
connexion. Le wallet mainnet de cet utilisateur vient de sa première connexion mainnet.

```jsonc
"network_wallets": [
  { "network": "public",  "status": "ready",   "address": "GA5Z…" },
  { "network": "testnet", "status": "pending", "address": null    }
]
```

**Une entrée `pending` n'est pas une erreur.** La connexion a réussi ; seul le second wallet
n'est pas encore prêt, et il ne fait jamais échouer la connexion. La requête fait une seule
tentative de cinq secondes ; ce qui n'est pas terminé est réessayé en arrière-plan par le
sweeper de provisionnement (`POLLAR_SWEEP_*`), avec un backoff exponentiel et jusqu'à dix
tentatives avant que la ligne ne passe à `failed`.

La cause habituelle d'un `pending` est que **les clés de l'autre réseau ne sont pas
configurées**. Dès qu'elles le sont, le balayage suivant provisionne l'arriéré sans que les
utilisateurs aient à se reconnecter ; définissez donc les clés des deux réseaux, même si vous
n'en servez qu'un.

- **Les utilisateurs sont rapprochés par leur e-mail OAuth**, la même clé qu'utilise une
  connexion hébergée sur l'autre réseau. Un fournisseur qui ne renvoie aucun e-mail n'obtient
  pas de second wallet.
- **Une connexion mainnet dépense des XLM sur les deux réseaux** — sa propre réserve et
  une sur le testnet. Une connexion testnet ne dépense que des XLM de testnet. L'état se trouve dans `pollar_user_wallet`, une
  ligne par (consumer, email, network), de sorte qu'une connexion répétée ne provisionne pas à
  nouveau.

### Ce que le pont stocke

Une seule ligne de handshake, sans rien qui permette de dépenser de l'argent : le
`state` impossible à deviner, l'identifiant de session client Pollar, un **hash** du code et
l'adresse Stellar publique obtenue. **Aucun jeton Pollar n'est jamais persisté** — l'échange
`/auth/login` s'exécute à l'intérieur de la requête d'échange du code, et les jetons repartent
directement dans sa réponse. Les handshakes que personne n'a terminés sont expirés par un timer
(`POLLAR_SWEEP_*`), car une ligne `AUTHORIZED` reste un code échangeable tant qu'elle n'a pas
été balayée.

Chaque transition est un compare-and-swap sur le statut de la ligne, de sorte qu'un callback
rejoué n'émet pas de second code, et que deux wallets en concurrence pour un même code ne
peuvent pas l'emporter tous les deux.

### Durcissement

- **PKCE (RFC 7636, S256)** est **obligatoire dans le flux par redirection** et optionnel dans
  le flux par polling : passez `code_challenge` lors de l'autorisation et `code_verifier` lors
  de l'échange, et un code qui fuit depuis un navigateur ou un journal devient inutilisable sans
  le verifier. Un code du flux par redirection traverse un navigateur, et le callback public le
  remet à quiconque présente le `state` — qui figure dans `authorization_url` —, donc
  `authorize` avec `redirect_uri` et sans `code_challenge` renvoie `400 validation_failed`.
- **`dpop_jwk`** lie les jetons émis par Pollar à la propre clé P-256 du wallet (RFC 9449), de
  sorte qu'un jeton d'accès volé est inerte sans preuve signée. Cela signifie aussi que le pont
  ne peut plus agir au nom du wallet — `/refresh` et `/logout` servent les sessions bearer, et
  un wallet lié par DPoP appelle Pollar directement.
- **`POLLAR_REDIRECT_URI_WHITELIST`** est définie par consumer et échoue en mode fermé,
  puisque l'URI de redirection reçoit le code. Elle accepte les hôtes loopback (n'importe quel
  port, selon la RFC 8252), les deep links à schéma privé et les hôtes https.
- **Une session ne revient qu'au compte qui a donné son consentement.** Tous les tenants
  partagent une application Pollar, et un lien de connexion fonctionne dans le navigateur de
  n'importe qui : une clé pourrait envoyer son `authorization_url` à quelqu'un, attendre son
  consentement et échanger son wallet — PKCE et `dpop_jwk` n'y changent rien, puisque c'est
  cette clé qui a ouvert le handshake. `POST /v1/pollar/oauth/token` compare donc l'e-mail
  que Pollar rapporte pour la connexion avec l'e-mail du compte que la passerelle transmet
  pour la clé (`X-Consumer-Email`, voir `APISIX_EMAIL_HEADER`). En cas de différence, la
  session est révoquée chez Pollar, le handshake passe à `failed` et la réponse est
  `403 pollar_identity_mismatch` ; une clé sans e-mail transmis est refusée dès `authorize`
  avec `403 pollar_identity_required`. La seule exception est l'onboarding intermédié de la
  dev platform (`X-Cosmos-Internal`) : il connecte des personnes qui n'ont pas encore de clé,
  et prouve lui-même l'e-mail avant de transmettre quoi que ce soit.
- **`POST /v1/pollar/users` et `/users/with-wallet` exigent une clé élevée**
  (`X-Consumer-Role: admin`, sinon `403 elevated_key_required`). Un utilisateur enregistré
  là est celui qu'une connexion sociale ultérieure résout par e-mail ; sans cela, une clé de
  tenant pourrait revendiquer l'e-mail d'un inconnu et être enregistrée comme propriétaire
  du wallet qu'il obtient.

### Routes

| Méthode | Chemin                                                | Scope          | Description |
| ------ | ----------------------------------------------------- | -------------- | ----------- |
| POST   | `/v1/pollar/oauth/authorize`                          | `pollar:write` | Ouvrir une connexion → `authorization_url` + `state` |
| GET    | `/v1/pollar/oauth/callback/:state`                    | _public_       | Là où Pollar renvoie le navigateur (une navigation — aucune clé à transporter) |
| GET    | `/v1/pollar/oauth/callback?state=`                    | _public_       | Même callback, pour une chaîne de redirections qui conserve la query string mais pas le chemin |
| GET    | `/v1/pollar/oauth/sessions/:state`                    | `pollar:read`  | Interroger un handshake et récupérer son code |
| POST   | `/v1/pollar/oauth/token`                              | `pollar:write` | Échanger le code → session Pollar + wallet |
| POST   | `/v1/pollar/oauth/refresh`                            | `pollar:write` | Renouveler une paire de jetons (sessions bearer) |
| POST   | `/v1/pollar/oauth/logout`                             | `pollar:write` | Révoquer une session (cet appareil, ou tous) |
| POST   | `/v1/pollar/wallets/activate`                         | `pollar:write` | Financer la réserve XLM (mode de financement Deferred) |
| POST   | `/v1/pollar/wallets/:address/trustlines/default`      | `pollar:write` | Activer les actifs configurés de l'application |
| POST   | `/v1/pollar/wallets/:address/trustlines`              | `pollar:write` | Activer des actifs spécifiques |
| DELETE | `/v1/pollar/wallets/:address/trustlines/:code/:issuer`| `pollar:write` | Retirer une trustline (solde nul uniquement) |
| POST   | `/v1/pollar/users` · `/v1/pollar/users/with-wallet`   | `pollar:write` | Enregistrer un utilisateur, éventuellement avec un wallet (clés élevées uniquement) |
| POST   | `/v1/pollar/tokens/verify`                            | `pollar:read`  | Valider un jeton qu'un wallet vous a présenté |

Les six dernières utilisent la clé **secrète** de Pollar, c'est pourquoi elles s'exécutent
ici et non dans le wallet.

### Rate limiting

Créer un wallet Pollar coûte de l'argent : Pollar crée le compte Stellar, finance sa réserve
de base (1 XLM) et ajoute une trustline par actif configuré (0.5 XLM chacune) **depuis votre
wallet de financement**. Un script qui boucle sur le flux de connexion pourrait dépenser ces
fonds sans aucun vrai utilisateur ; ce service applique donc lui-même des limites, avant que
le moindre XLM ne soit dépensé.

**La limite porte sur `authorize`, pas sur `token`.** Un handshake produit au plus un wallet ;
limiter les handshakes par adresse limite donc les wallets. `token` est plus souple parce que
les clients sont invités à le réessayer pendant que Pollar provisionne le compte, et
l'échange ne crée rien de nouveau.

| Route | Budget (par 10 min) | Pourquoi |
| ----- | ------------------- | -------- |
| `POST /v1/pollar/oauth/authorize` | 20 | Plafonne la création de wallets |
| `POST /v1/pollar/oauth/token` | 60 | Les clients la réessaient pendant le provisionnement du compte |
| `GET /v1/pollar/oauth/callback` | 60 | La seule accessible sans clé API |
| `GET /v1/pollar/oauth/sessions/{state}` | 400 | Un wallet l'interroge toutes les deux ou trois secondes ; chaque interrogation peut atteindre Pollar |
| `POST /v1/pollar/oauth/refresh` · `/logout` | 60, partagé | Une requête Pollar chacune |
| `POST /v1/pollar/users` · `/users/with-wallet` | 10, partagé | Écrivent dans l'annuaire des utilisateurs que partagent tous les tenants ; `with-wallet` crée en plus un wallet sans écran de consentement |
| `POST /v1/pollar/wallets/activate` | 20 | Dépense des XLM à chaque appel |
| `POST /v1/pollar/wallets/:address/trustlines` · `/default` | 20, partagé | Chaque asset immobilise de la réserve du wallet de financement |
| `DELETE /v1/pollar/wallets/:address/trustlines/:code/:issuer` | 20 | Une requête Pollar chacune |
| `POST /v1/pollar/tokens/verify` | 120 | Une requête Pollar chacune |

**Deux plafonds sont par consumer plutôt que par adresse**, de sorte que changer d'adresse
ne les multiplie pas : les requêtes Pollar qu'un consumer peut provoquer (100 par minute,
sur toutes les routes ci-dessus sauf l'interrogation et le callback — Pollar budgète la clé
à 200 par minute et tous les tenants la partagent) et les wallets qu'il peut provoquer
(`authorize` et `users/with-wallet`, 50 par jour). Les appels de la console
(`X-Cosmos-Internal`) sont exemptés des deux : la dev platform fait passer chaque wallet sans
clé par un seul consumer et budgète elle-même ce trafic.

Dépasser l'un d'eux renvoie **`429` avec `code: "rate_limited"`**, un `Retry-After` et les
en-têtes `RateLimit-Limit` / `-Remaining` / `-Reset`. Le même limiteur protège les routes
en dehors de Pollar dont une erreur ne rembourse pas le coût — les constructeurs de swaps
et de pools de liquidité et leurs submits, les constructeurs d'intentions de paiement,
l'upload KYC et les conditions d'utilisation, les écritures onramp et offramp (avec un
plafond BlindPay par consumer par-dessus), `ping` et `redeliver` des webhooks, les
challenges et récupérations d'alias, l'ingestion d'activité — et chaque section donne son
propre budget. La limitation générale du trafic relève d'APISIX.

**Le compteur est dans Postgres, pas en mémoire**, de sorte que la limite tient sur
l'ensemble des réplicas. Il s'agit d'une fenêtre fixe (un `INSERT … ON CONFLICT … RETURNING`
atomique par requête) ; un client peut donc utiliser un budget complet de chaque côté d'une
frontière de fenêtre.

**Adresse du client.** `main.ts` règle `trust proxy` sur `1`, si bien qu'Express lit l'entrée
*la plus à droite* de `X-Forwarded-For` — celle qu'APISIX a ajoutée. Les entrées ajoutées par
un client se retrouvent à sa gauche et sont ignorées.

> **N'augmentez pas `trust proxy`.** À `2`, Express fait confiance à un saut fourni par le
> client, et n'importe quel client peut contourner ces limites avec un en-tête.

Les appelants IPv6 sont regroupés par **/64**, car un client contrôle généralement un /64
entier ; des utilisateurs qui partagent un /64 partagent une limite, comme derrière un NAT
IPv4. Les limites sont aussi définies par consumer, de sorte que le trafic d'un intégrateur
n'affecte pas celui d'un autre.

Si le compteur ne peut pas être écrit, le limiteur **échoue en mode fermé** (`503`) ; ces
routes ont de toute façon besoin de la base de données. Définissez `RATE_LIMIT_ENABLED=false`
pour désactiver les limites pendant un incident.

### Configuration

1. Créez une application sur [dashboard.pollar.xyz](https://dashboard.pollar.xyz) et récupérez
   les deux clés de votre réseau (`pub_testnet_…` / `sec_testnet_…`). Faites-le pour **les
   deux** réseaux : une connexion mainnet provisionne aussi un wallet testnet, et sans clés
   testnet ce second wallet reste en `pending` jusqu'à ce qu'elles soient définies. Les deux
   tableaux de bord sont distincts — enregistrez l'hôte du callback dans
   chacun d'eux.
2. Enregistrez l'**hôte de la passerelle** de `POLLAR_BRIDGE_CALLBACK_URL` sous
   **Build → Domains**. La SDK API vérifie cette liste à *chaque* appel en la comparant à
   l'en-tête `Origin`, que le pont renseigne avec cet hôte (`POLLAR_SDK_ORIGIN` permet de le
   remplacer). Un hôte non enregistré reçoit `403 ORIGIN_NOT_ALLOWED` sur
   `POST /auth/session`, le premier appel de chaque connexion.
3. Définissez `POLLAR_BRIDGE_CALLBACK_URL` sur `<gateway>/v1/pollar/oauth/callback` — le pont
   ajoute lui-même `/{state}`.
4. Ajoutez l'URI de redirection de chaque wallet à `POLLAR_REDIRECT_URI_WHITELIST`, ou omettez-la
   et utilisez le flux par polling.

Pollar encode le réseau et le type de clé dans le préfixe de la clé, et le validateur
d'environnement rejette toute incohérence au démarrage. Laissez les clés vides pour
désactiver la fonctionnalité (les routes Pollar renvoient alors `503`). Voir `.env.example`.

## Mise à niveau — changements incompatibles et notes de déploiement

### Correctifs issus de la revue de sécurité

La plupart de ces changements ne modifient rien pour un appelant qui se comporte
correctement ; consultez la colonne « Qui le remarque » avant de déployer.

| Changement | Qui le remarque | Pourquoi |
| ---------- | --------------- | -------- |
| `POST /v1/aliases/:name/recovery` est **réservée à la console de la plateforme** : une clé API reçoit `403 admin_console_only`, et la route a quitté le contrat publié | Quiconque lançait des récupérations avec une clé API | La réponse contient le jeton de récupération, qui prouve le contrôle de la boîte mail du propriétaire |
| Terminer une récupération sur un alias `SUSPENDED` donne un `404` | Personne de légitime | Un jeton émis avant une suspension pouvait contourner la suspension décidée par l'opérateur |
| Les routes `@Public()` (callback Pollar, webhook BlindPay, santé) ignorent `X-Consumer-Username` | Tableaux de bord : ces requêtes sont désormais journalisées comme anonymes | Ces routes n'ont pas de key-auth, donc l'en-tête venait du client |
| Les refus d'`AdminGuard` et de `ConsoleOnlyGuard` sont journalisés au niveau `warn` | Opérateurs | Les guards s'exécutent avant le journal d'accès, donc les requêtes refusées ne laissaient aucune trace |
| `POST /v1/pollar/wallets/activate` et les trois routes `/v1/pollar/wallets/:address/trustlines…` renvoient `404` pour un wallet que le consumer appelant n'a pas obtenu via ce service sur ce réseau | Les intégrateurs qui agissent sur des wallets qu'ils n'ont vus que via `tokens/verify`, sur des wallets non principaux d'une connexion, ou sur un wallet de contrepartie qu'un autre tenant a déjà enregistré | Tous les tenants partagent un même jeu de clés secrètes Pollar. Les wallets étrangers et inconnus reçoivent tous deux `404`, de sorte que la réponse ne révèle pas la propriété |
| Les deux routes `POST …/trustlines` partagent un budget `429` de 20 appels par 10 minutes | Les scripts qui ajoutent des trustlines en masse | Chaque trustline immobilise 0.5 XLM du wallet de financement de l'opérateur |
| `GET /v1/offramp/payouts/:id` ne renvoie plus `raw`, `consumerId`, `receiverId`, `quoteId`, `bankAccountId` ni `updatedAt` ; la réponse de création de compte virtuel ne renvoie plus `raw`, `receiverId`, `consumerId` ni `updatedAt` | Les appelants qui lisent ces champs | `raw` est l'objet BlindPay stocké, avec les données bancaires et celles du bénéficiaire |
| `POST /v1/kyc/upload` renvoie `400` pour plus de 4 champs texte, un champ de plus de 1 KiB, un second fichier, ou des octets de fichier qui ne correspondent pas au type déclaré | Personne qui envoie un upload bien formé | Les champs n'étaient pas bornés et la vérification du type se fiait au `Content-Type` du client |
| `POST /v1/payment-intents/tx` et `/pay` : le même mémo avec n'importe quelle condition différente donne `409 idempotency_conflict`. Une nouvelle tentative identique renvoie toujours l'intention stockée (`2` et `2.0` sont le même montant) | Les appelants qui réutilisent un même mémo pour des paiements différents | Sous la clé publique partagée, un mémo créé en premier par quelqu'un d'autre renvoyait son intention |
| `POST /v1/payment-intents/:id/validate` ne marque `FAILED` que pour une tx échouée qui est le propre paiement de cette intention ; toute autre tx échouée donne `valid: false` avec le statut inchangé. Une tx clôturée plus de 60 s avant la création de l'intention est refusée ("Transaction predates this payment intent") — lors de validate, lors d'un `PATCH {status: SUCCEEDED}` et dans l'observateur | Personne de légitime | N'importe quelle transaction échouée pouvait faire échouer une intention, et un ancien paiement aux mêmes conditions pouvait en régler une nouvelle |
| `PATCH /v1/payment-intents/:id` qui modifie `txHash` sur une intention dans un état terminal donne `400 invalid_state_transition` ; un changement de statut en concurrence avec l'écriture donne `409 operation_in_flight` | Personne de légitime | Cela pouvait réécrire la preuve de règlement d'une intention `SUCCEEDED` |
| L'observateur des intentions de paiement réconcilie au plus 10 intentions par consumer par cycle et ne parcourt jamais les lignes expirées | Les opérateurs qui surveillent le débit de l'observateur | Un seul consumer pouvait retarder le règlement de tous les autres tenants |
| `POST /v1/swaps`, `/v1/liquidity-pools/deposit` et `/withdraw` : une `Idempotency-Key` réutilisée avec une requête différente — un autre mémo ou un autre slippage, l'autre réseau, ou une clé de dépôt réutilisée pour un retrait — donne `409 idempotency_conflict`. Un rejeu portant un actif, un slippage ou un mémo invalide reçoit désormais le `400` habituel | Les clients qui réutilisent une même clé pour des opérations différentes | Sous la clé publique partagée, quelqu'un pouvait pré-créer une enveloppe sous une clé devinable et la faire renvoyer à la nouvelle tentative d'un autre utilisateur |
| `POST /v1/liquidity-pools/withdraw` ne répond plus `409 operation_in_flight` pour un retrait en cours dont le compte n'a pas encore utilisé le numéro de séquence (une enveloppe non signée ou abandonnée) | Les utilisateurs de wallet qui étaient bloqués | Une enveloppe construite pour le compte de quelqu'un d'autre pouvait bloquer indéfiniment les retraits de cette position |
| L'observateur de règlement prend au plus 10 lignes par consumer, par table et par cycle, et `GET /v1/liquidity-pools/positions` lit Horizon via une seule liste paginée au lieu d'une requête par pool | Opérateurs | Un seul consumer pouvait retarder le règlement de tous les autres, et de nombreuses parts de pools entraînaient un nombre non borné d'appels Horizon |
| `GET /v1/onramp/payins/:id` ne renvoie plus `receiverId` ni `updatedAt` — la même forme que celle renvoyée par `GET /v1/onramp/payins` | Les appelants qui lisent ces deux champs dans la lecture d'un seul payin | Le même payin pouvait revenir sous deux formes |
| `POST /v1/kyc/upload` avec un fichier de plus de 10 Mio renvoie `413` avec `code: "payload_too_large"` ; c'était `internal_error` | Les intégrateurs qui s'appuient sur `code` | C'est une limite côté client, pas une erreur du serveur |
| `POST /v1/liquidity-pools/deposit`, `/withdraw`, `GET /v1/liquidity-pools/operations`, `/operations/:id`, `POST /v1/liquidity-pools/operations/:id/submit` et les webhooks `LIQUIDITY_*` portent désormais `memo` (le MEMO_ID de l'appelant, ou `null`). Les opérations créées avant la migration `20260915120000_liquidity_pool_operation_memo` renvoient `null` même si leur enveloppe en porte un | Personne, sauf un client qui rejette les champs inconnus | Le memo n'était stocké que dans le XDR |
| Le contrat publié de `GET /v1/swaps` et `GET /v1/liquidity-pools/operations` ne déclare plus `qr` ni `commissionMemo` sur les éléments de liste. Les réponses ne changent pas — ces deux champs n'y ont jamais été envoyés ; on les obtient en lisant l'élément seul | Les clients générés à partir de la spécification OpenAPI | Le contrat décrivait les éléments de liste avec la forme de la lecture unitaire |
| Le service refuse de démarrer lorsque `APISIX_GATEWAY_SECRET` est un placeholder — la valeur que `.env.example` fournissait auparavant, ou tout ce qui contient `replace-with`, `change-me`, `your-secret` ou `placeholder` — et `.env.example` la laisse désormais vide | Les déploiements qui utilisent encore la valeur copiée depuis `.env.example` | Cette valeur est publique et assez longue pour passer le plancher de 32 caractères, de sorte que quiconque pouvait atteindre le service pouvait se faire passer pour n'importe quel consumer et atteindre `/v1/admin` |
| Le service refuse de démarrer lorsque `BLINDPAY_WEBHOOK_SECRET` est défini mais que sa clé (le base64 après `whsec_`) est malformée ou se décode en moins de 24 octets, et `POST /v1/blindpay/webhooks` rejette toute livraison tant que la clé configurée est inutilisable | Les déploiements avec un secret tronqué ou mal saisi, dont les webhooks BlindPay échouaient déjà | Node décode un base64 invalide en une clé HMAC courte ou vide sans erreur, et une livraison signée avec une clé vide peut être forgée par n'importe qui |
| `GET /v1/health/readiness` répond à un contrôle en échec avec l'enveloppe d'erreur standard (`error: "Service Unavailable"`) ; auparavant, elle plaçait le rapport de santé, message d'erreur de la base de données inclus, dans `error` | Les sondes qui lisent le rapport dans le corps plutôt que dans le code de statut | La route est `@Public()`, et le message de Prisma nomme l'hôte et l'utilisateur de la base de données |
| `POST /v1/onramp/receivers/:id/virtual-accounts` donne `403 account_disabled` lorsque le receiver, ou le receiver propriétaire de `blockchain_wallet_id`, est désactivé | Personne de légitime | C'était la seule opération fiat que l'interrupteur d'arrêt ne couvrait pas : un compte désactivé pouvait encore ouvrir un nouveau rail de dépôt |
| `POST /v1/pollar/oauth/token` n'échange plus un code qu'un polling plus récent de `GET /v1/pollar/oauth/sessions/:state` a remplacé, même lorsque ce polling survient en plein échange du code | Personne de légitime | La revendication correspondait au handshake mais pas au code, de sorte qu'un code retiré pouvait encore être dépensé dans cette fenêtre |
| `POST /v1/swaps/:id/submit` et `POST /v1/liquidity-pools/operations/:id/submit` vérifient l'enveloppe avant toute autre chose : un corps qui ne s'analyse pas, qui n'est pas l'enveloppe de la ligne, ou qui ne porte aucune signature donne `400 validation_failed` quel que soit le statut de la ligne. Un `signedXdr` arbitraire ne renvoie plus une ligne `SUCCEEDED`, et une ligne `EXPIRED` répond à un corps qui ne correspond pas par `validation_failed` au lieu de `invalid_state_transition` | Les clients qui soumettaient le `xdr` non signé et comptaient sur le rejet `tx_bad_auth` | Les signatures ne changent pas le hash d'une transaction, de sorte que l'enveloppe non signée pouvait être relayée et rejetée en boucle, et sous la clé publique partagée, le seul identifiant de ligne permettait de lire une ligne déjà réglée |
| Les deux routes de submit refusent une enveloppe dont les bornes temporelles sont dépassées (`400 invalid_state_transition`, non diffusée ; l'observateur la règle tout de même si elle a atteint le réseau) ainsi qu'une ligne `FAILED` déjà resoumise 3 fois (`400 invalid_state_transition` : construisez-en une nouvelle). Une nouvelle tentative après `503 provider_unavailable` ne compte pas | Les clients qui resoumettent en boucle : arrêtez-vous sur `invalid_state_transition` | Chaque resoumission rejetée était une soumission Horizon et un nouvel événement webhook terminal, sans aucune limite |
| Les deux routes de submit autorisent 20 appels par minute par consumer et adresse cliente, dans des compartiments séparés (`429 rate_limited`) | Les wallets derrière un même NAT qui partagent la clé publique | Les routes acceptent la clé publique partagée, et chaque appel peut diffuser vers Horizon |
| `GET /v1/webhooks`, `GET /v1/webhooks/:id` et `PATCH /v1/webhooks/:id` ne renvoient que les champs documentés de l'endpoint ; `POST /v1/webhooks` et `POST /v1/webhooks/:id/rotate-secret` renvoient ceux-là plus `secret`. `consumerId`, `previousSecret` et `previousSecretExpiresAt` ont disparu des cinq | Les appelants qui lisent ces champs | `previousSecret` est un secret de signature qu'un intégrateur peut encore accepter, et une clé munie du seul `webhooks:read` pouvait le lire |
| Un jeton de récupération qui ne correspond à aucune récupération active de l'alias ne compte plus contre elle. Un jeton actif consomme une tentative à chaque présentation, y compris une dont le challenge ou la signature échoue ensuite ; après cinq, c'est `400 alias_recovery_invalid` | Personne de légitime | Les noms d'alias sont publics, donc cinq jetons invalides envoyés depuis n'importe quelle clé épuisaient toute récupération lancée par la console |
| `POST /v1/aliases/:name/recovery/complete` (10 par 10 min), `POST /v1/aliases/challenges` (30), `POST /v1/webhooks/:id/ping` (20) et `POST /v1/webhooks/:id/deliveries/:deliveryId/redeliver` (30) donnent `429 rate_limited` au-delà du budget, par consumer et adresse cliente | Les scripts qui bouclent sur ces routes | Chaque appel stocke une ligne, tente un jeton de récupération, ou envoie des requêtes vers une URL choisie par l'appelant |
| `PATCH /v1/payment-intents/:id` exige que `txHash` soit un hash de transaction Stellar hexadécimal de 64 caractères (tout le reste donne `400`) et le stocke en minuscules ; `POST /v1/payment-intents/:id/validate` met le sien en minuscules également. Un hash n'est unique que parmi les intentions d'un même consumer, et non plus à travers tous les tenants, et un hash déjà présent sur une autre de vos intentions donne `409 idempotency_conflict` (c'était `500`) | Les appelants qui envoient des hashs placeholder ou tronqués | N'importe quel tenant pouvait déposer le hash de transaction d'un autre tenant sur une intention à lui ; le règlement de l'autre tenant heurtait alors l'index global, répondait `500`, et l'intention payée expirait sans `PAYMENT_INTENT_SUCCEEDED` |
| Une intention `EXPIRED` passe à `SUCCEEDED` lorsque son paiement est vérifié on-chain : par l'observateur, qui vérifie désormais la chaîne avant d'expirer, ou par `POST /v1/payment-intents/:id/validate` et `PATCH {status: SUCCEEDED}`, qui répondent `200` au lieu de `400 invalid_state_transition`. `PAYMENT_INTENT_SUCCEEDED` peut suivre la mise à jour `EXPIRED` émise | Les consumers de webhooks qui traitent `EXPIRED` comme final | L'expiration ne regardait jamais la chaîne, et le vérificateur ne lisait que les 50 paiements les plus récents vers la destination, de sorte qu'un paiement tardif ou enterré laissait une intention payée `EXPIRED` pour de bon |
| `POST /v1/pollar/oauth/authorize` avec `redirect_uri` exige `code_challenge` (PKCE, S256), et l'échange de ce handshake exige `code_verifier` ; sans lui l'appel renvoie `400 validation_failed` avant l'ouverture d'une session Pollar. Le flux par polling ne change pas | Les wallets du flux par redirection qui n'envoient pas PKCE | Le callback public remet le code à quiconque présente le `state`, qui figure dans `authorization_url`, et sans PKCE ce code s'échangeait tel quel |
| Les réponses des swaps, opérations de liquidity pool, intentions de paiement et customers ne renvoient plus que leurs champs documentés, plus `expiresAt` sur les swaps et les intentions de paiement, désormais documenté. `consumerId` et la comptabilité de règlement (`settlementEpoch`, `lastCheckedAt`, `notFoundStreak`, `sharesReceived`, `settledAmountA`/`B`, `horizonCursor`) ne sont plus envoyés | Les appelants qui lisaient ces champs | Ils sont internes, et plusieurs de ces routes sont accessibles avec la clé publique partagée |
| `PATCH /v1/kyc/receivers/:id` sur un receiver qui existe déjà chez BlindPay renvoie `403 kyc_review_required` pour tout champ sauf `external_id` et `image_url`, sauf si la clé est élevée (`X-Consumer-Role: admin`) | Les intégrateurs qui corrigent l'identité d'un receiver actif avec une clé de tenant : passez par le relecteur | Le `PUT` envoyait des données d'identité jamais relues directement à un fournisseur régulé, alors que la même modification avant l'activation repasse en revue |
| Les routes BlindPay utilisent l'instance de l'environnement de la clé : les clés `prod` celle des variables `BLINDPAY_*` sans suffixe, les clés `dev` celle de `BLINDPAY_*_DEV`, et une clé `dev` sans instance de développement configurée reçoit `503 misconfigured`. Receivers, wallets, comptes bancaires, comptes virtuels, cotations, payins et payouts ne sont lus et exécutés que sur cette instance | Quiconque utilise BlindPay avec des clés `dev` | Une clé `dev` opérait l'instance de production : elle pouvait lister et supprimer de vraies identités KYC et créer de vrais payouts |
| `POST /v1/pollar/oauth/token` ne renvoie une session que si l'e-mail que Pollar rapporte pour la connexion est l'e-mail du compte que la passerelle transmet pour la clé (`X-Consumer-Email`). Une différence révoque la session, fait échouer le handshake et renvoie `403 pollar_identity_mismatch` ; une clé sans e-mail transmis reçoit `403 pollar_identity_required` dès `authorize` | Les tenants qui connectent leurs propres utilisateurs finaux via l'application Pollar partagée, et quiconque se connecte avec un autre e-mail que celui de son compte | Tous les tenants partagent une application Pollar et un lien de connexion fonctionne dans n'importe quel navigateur : une clé pouvait envoyer son `authorization_url` à quelqu'un, attendre le consentement et échanger le wallet sous garde de cette personne |
| `POST /v1/pollar/users` et `/v1/pollar/users/with-wallet` exigent une clé élevée ; une clé de tenant reçoit `403 elevated_key_required` | Les intégrateurs qui préenregistrent des utilisateurs avec une clé de tenant | Un utilisateur enregistré est celui qu'une connexion sociale ultérieure résout par e-mail, donc une clé de tenant pouvait revendiquer l'e-mail d'un inconnu et être enregistrée comme propriétaire de son wallet |
| Une connexion testnet ne provisionne plus de wallet mainnet pour son utilisateur : `network_wallets` d'un échange testnet ne liste que le wallet testnet. Une connexion mainnet provisionne toujours le testnet | Quiconque lit une entrée mainnet issue d'une connexion testnet | Une clé `dev` que n'importe qui peut créer dépensait de vrais XLM de l'opérateur pour une réserve mainnet à chaque connexion |
| Les routes Pollar d'interrogation, de refresh, de logout, de vérification de jeton, d'enregistrement d'utilisateurs et de suppression de trustline sont limitées, et un quota par consumer (100 requêtes Pollar par minute) ainsi qu'un plafond de wallets (50 par jour) s'ajoutent aux budgets par adresse ; le dépassement renvoie `429 rate_limited` | Les clients qui martèlent ces routes | Elles n'avaient aucune limite, et chaque appel consomme le budget de requêtes Pollar que partagent tous les tenants — un tenant pouvait faire échouer les connexions de tous les autres |
| `POST /v1/kyc/receivers/:id/approve` accepte `expected_version` (la `dossierVersion` que vous avez lue) et répond `409 kyc_state_invalid` lorsque les données KYC ont changé depuis. `POST /v1/kyc/receivers/:id/enable` refuse un dossier qui n'est pas celui approuvé, et les lectures de receiver portent `dossierVersion` et `reviewedVersion` | Les relecteurs, dès qu'ils envoient `expected_version` ; personne d'autre — le champ est optionnel | Une relecture, c'est une personne qui lit les données puis les approuve, et une modification entre les deux laisse le statut sur `pending_review` : l'approbation portait donc sur un dossier que personne n'avait vu, et `enable` l'envoyait à un fournisseur régulé |
| `POST /v1/kyc/upload`, `/v1/kyc/terms-of-service`, les écritures onramp et offramp, `POST /v1/payment-intents/tx` et `/pay`, `POST /v1/swaps/quote` et `/v1/swaps`, ainsi que `POST /v1/liquidity-pools/deposit` et `/withdraw` répondent désormais `429 rate_limited` au-delà du budget, par consumer et adresse cliente. Toute route adossée à BlindPay compte en plus dans un plafond par consumer de 60 requêtes fournisseur par minute | Les scripts qui bouclent sur ces routes ; un import massif au-dessus du plafond doit avoir sa propre clé | Elles n'avaient aucune limite : chacune laisse quelque chose chez le fournisseur qu'aucune erreur ne rembourse, ou consomme le budget Horizon par IP que partagent toutes les routes d'ici. Seuls les submits étaient plafonnés |
| `POST /v1/swaps` ne répond plus `409 operation_in_flight` pour un swap `PENDING` dont le compte n'a pas encore consommé le numéro de séquence (une enveloppe non signée ou abandonnée). Ne s'applique qu'avec `STELLAR_SWAP_SINGLE_INFLIGHT=true` | Les utilisateurs de wallet qui étaient bloqués | N'importe qui peut indiquer n'importe quelle `source` : un swap de poussière gelait le compte d'un tiers, fenêtre d'expiration après fenêtre d'expiration — le jumeau du correctif des pools de liquidité ci-dessus |
| Une destination de webhook refusée à cause de son hôte — non résolue, privée, link-local, métadonnées — donne un seul `400` avec un seul message ; le motif reste dans le journal du service. Une URL malformée, un schéma autre que https, des identifiants ou l'absence d'hôte disent toujours ce qui ne va pas | Les intégrateurs qui lisaient le motif dans la réponse | Enregistrer un endpoint résout un nom que ce service peut atteindre : une réponse par motif permettait de cartographier le réseau interne une URL à la fois |
| Une `redirect_url` est refusée lorsqu'elle porte un fragment, un antislash, un espace ou un caractère de contrôle ; https sans identifiants intégrés était déjà exigé | Personne qui envoie une URL ordinaire | `https://app.acme.com\@evil.test` désigne un hôte différent selon qui l'analyse, et la valeur est relue par BlindPay puis par un navigateur |
| Le service refuse de démarrer lorsque `POLLAR_BRIDGE_CALLBACK_URL` est en `http` simple sur un hôte routable | Les déploiements qui terminent TLS ailleurs et configurent le callback en `http` | Pollar y renvoie le navigateur avec le code d'autorisation dans la query string, et ce code s'échange contre la session de l'utilisateur |

Notes de déploiement associées :

- **La migration `20260910120000_aliases`** crée `alias`, `alias_address`,
  `alias_challenge` et `alias_recovery`. Exécutez `migrate deploy` avant que le nouveau
  build ne serve du trafic.
- **Un nouvel identifiant de verrou consultatif, `881_008` (`AliasChallengeSweeper`).** Rien
  à configurer.
- **Définissez `NODE_ENV=production` en production.** `.env.example` est livré avec
  `development`, et deux protections en dépendent : une requête sans
  `X-Plan-Swap-Fee-Bps` donne un `503` uniquement en production (partout ailleurs, les swaps
  se rabattent silencieusement sur `STELLAR_SWAP_FEE_BPS`), et `/docs` — hors de tout guard
  — n'est désactivé par défaut qu'en production.
- **Les lignes de log de l'observateur de règlement ont changé** :
  `Settlement observer started (every Nms)`,
  `Settlement observer (OBSERVER_ENABLED=false) disabled` et
  `SettlementObserverService cycle failed` au niveau `error`. Mettez à jour les alertes qui
  cherchent l'ancien libellé. `OBSERVER_ENABLED`, `OBSERVER_INTERVAL_MS` et le verrou
  consultatif ne changent pas.
- **La migration `20260915120000_liquidity_pool_operation_memo`** ajoute la colonne
  nullable `liquidity_pool_operation.memo` : pas de réécriture de la table, seulement
  un bref verrou exclusif. Pas de backfill — le memo des lignes plus anciennes se
  trouve dans du XDR base64, que SQL ne sait pas décoder, et le service se rabat sur
  l'enveloppe pour elles.
- **La migration `20260915120100_lookup_indexes`** construit deux index
  `CONCURRENTLY` pour la vérification de propriété des wallets Pollar
  (`pollar_oauth_session(consumerId, network, walletAddress)` et
  `pollar_user_wallet(consumerId, network, address)`). Elle ne bloque pas les
  écritures, mais une construction échouée laisse un index `INVALID` que
  `IF NOT EXISTS` considère comme présent : trouvez-le avec
  `SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE NOT i.indisvalid;`,
  supprimez-le avec `DROP INDEX CONCURRENTLY`, lancez
  `prisma migrate resolve --rolled-back 20260915120100_lookup_indexes` et
  redéployez.
- **Deux variables sont désormais vérifiées au démarrage.** Un
  `APISIX_GATEWAY_SECRET` placeholder, ou un `BLINDPAY_WEBHOOK_SECRET` dont la
  clé ne se décode pas en au moins 24 octets, empêche le service de démarrer avec
  une erreur qui nomme la variable. Remplacez un secret de passerelle placeholder
  sur la route APISIX et ici, dans le même changement (`openssl rand -hex 32`) ;
  un décalage entre les deux fait échouer chaque requête comme ne venant pas de
  la passerelle.
- **La migration `20260915150000_payment_intent_tx_hash_per_consumer`** remplace
  l'index unique sur `payment_intent."txHash"` par un index sur
  `("consumerId", "txHash")`. Elle n'est pas `CONCURRENTLY` : `payment_intent`
  est verrouillée en écriture pendant la construction de l'index. Il n'y a pas
  de backfill.
- **Les valeurs stockées de `webhook_endpoint.previousSecret` ne sont plus
  renvoyées, mais rien ne les efface.** Si une rotation d'une version antérieure
  en a laissé une et que vous voulez la faire disparaître de la base de données,
  videz vous-même les deux colonnes.
- **La migration `20260915160000_blindpay_environment`** ajoute `environment` (par
  défaut `'prod'`) aux sept tables miroir de BlindPay — un changement de catalogue
  uniquement, sans réécriture de table —, les lignes existantes sont donc marquées
  production. **Si vos variables `BLINDPAY_*` sans suffixe pointaient vers une
  instance de développement BlindPay**, déplacez-les vers les variables `_DEV` et
  réétiquetez les lignes (`UPDATE … SET environment = 'dev'` sur `blindpay_receiver`,
  `blindpay_blockchain_wallet`, `blindpay_bank_account`, `blindpay_virtual_account`,
  `payin`, `payout` et `blindpay_quote`), sinon les clés `prod` continueront de les lire.
- **Configurez l'instance de développement BlindPay** (`BLINDPAY_API_KEY_DEV`,
  `BLINDPAY_INSTANCE_ID_DEV`, `BLINDPAY_WEBHOOK_SECRET_DEV`) si des clés `dev` utilisent
  BlindPay, et pointez son webhook de tableau de bord vers la même URL `/v1/blindpay/webhooks`.
- **Déployez d'abord la modification du forwarder de la dev platform.** `authorize` refuse
  toute clé pour laquelle la passerelle ne transmet pas `X-Consumer-Email`. Le forwarder
  enregistre l'e-mail par compte chaque fois que les clés de ce compte sont synchronisées ;
  resynchronisez donc les consumers existants (lister les clés d'un utilisateur dans le
  tableau de bord le fait pour cet utilisateur). D'ici là, le wallet se rabat sur la
  connexion intermédiée de la dev platform, qui n'a pas besoin de l'en-tête ; les autres
  clients reçoivent `403 pollar_identity_required`.
- **La connexion sociale d'utilisateurs finaux tiers via l'application Pollar partagée
  s'arrête.** Un tenant dont l'application connecte ses propres utilisateurs reçoit
  `403 pollar_identity_mismatch` pour chaque utilisateur dont l'e-mail n'est pas celui du
  compte de la clé.
- **La migration `20260915180000_pollar_testnet_counterpart_mainnet`** ferme les wallets
  mainnet que des connexions testnet avaient laissés en `pending` (`FAILED`,
  `COUNTERPART_FROM_TESTNET_DISABLED`), afin que le sweeper cesse de les financer. Données
  uniquement, sans changement de schéma.
- **La migration `20260915200000_receiver_dossier_version`** ajoute `dossierVersion`
  (par défaut `1`) et `reviewedVersion` à `blindpay_receiver` — catalogue uniquement,
  sans réécriture de table — et remplit `reviewedVersion` pour tout receiver ayant déjà
  passé la relecture, afin que son `enable` continue de fonctionner. Les receivers encore
  en `inactive` ou `pending_review` gardent `NULL`, qui est la vérité à leur sujet.
- **Vérifiez `POLLAR_BRIDGE_CALLBACK_URL` avant de déployer.** Un `http` simple sur un
  hôte routable empêche désormais le service de démarrer, avec une erreur qui nomme la
  variable. Le loopback (`http://127.0.0.1:…`) reste accepté, pour le développement
  local.
- **De nouveaux `429` sur des routes qui n'en renvoyaient jamais.** Les budgets du
  tableau ci-dessus s'appliquent à partir de cette version ; un client qui boucle sur les
  uploads KYC, les devis, les payins, les payouts, la construction d'intentions, les
  devis de swap ou les constructions de pool doit respecter `Retry-After`.
  `RATE_LIMIT_ENABLED=false` coupe le limiteur pendant un incident.

### NestJS 12, TypeScript 6 et Node 24.9 au minimum

Le service tourne désormais sur NestJS 12 et TypeScript 6 et **requiert Node 24.9 ou
ultérieur** (`engines` ; la CI fixe `node-version: 24`). Mettez à jour les cibles de
déploiement en conséquence.

NestJS 12 est publié en ESM, et Jest ne peut le charger que sur Node >= 24.9 avec
`--experimental-vm-modules` ; les scripts de test lancent donc Jest directement via Node :

```
"test": "node --experimental-vm-modules node_modules/jest/bin/jest.js"
```

Le contrat OpenAPI publié a gagné des schémas de santé plus riches grâce à
`@nestjs/terminus@12` (enums de statut et `responseTime`). Aucune route métier ni aucun
schéma n'a changé.

### Une clé API publique partagée, et le guard qui la restreint

`PublicKeyGuard` (global, après `PermissionsGuard`) et le décorateur `@AllowPublicKey()` sont
nouveaux. Les clés existantes ne sont pas concernées. Au moment du déploiement :

- **Définissez `APISIX_PUBLIC_CONSUMER`** avec le nom d'utilisateur que la plateforme
  développeur provisionne pour la clé publique, sur chaque déploiement qui en publie une. Sans
  cela, le guard ne s'appuie que sur le `X-Consumer-Role` transmis.
- **Créez la clé publique avec `role: public`** et uniquement les scopes dont les routes de
  la liste d'autorisation ont besoin. Des scopes supplémentaires comme `kyc:*` n'ouvriraient
  pas ces routes, mais une clé que tout le monde détient ne devrait pas les porter.

Voir « La clé API publique partagée » ci-dessus.

### Le registre d'actifs : `GET /v1/assets`

Une liste sélectionnée des paires (code, issuer) que cette plateforme prend en charge, par
réseau, avec l'organisation émettrice. Elle ne requiert aucun scope, puisqu'elle ne contient
aucune donnée de tenant, mais elle requiert un consumer authentifié (la clé publique partagée
fonctionne).

`npm run assets:verify` vérifie chaque ligne auprès d'Horizon en direct : que la paire existe
sur son réseau, que `contract` correspond au `contract_id` d'Horizon, et que les flags de
l'émetteur correspondent à ceux de la chaîne. Exécutez-le lorsque vous modifiez le registre ;
il a besoin d'un accès à internet, il ne fait donc pas partie des tests unitaires.

### Activité client : un nouveau module, une nouvelle table et deux nouveaux scopes

`POST /v1/activity/events` accepte la télémétrie du wallet et du tableau de bord développeur ;
`GET /v1/activity/events` et `GET /v1/activity/summary` permettent de la relire. Aucune
réponse existante n'a changé. Au moment du déploiement :

- **La migration `20260906140000_activity_event`** crée `activity_event` (en ajout seul,
  rattachée à `consumerId`, unique sur `(consumerId, eventId)`).
- **Les scopes `activity:write` et `activity:read` sont nouveaux.** Les clés existantes ne
  les reçoivent pas automatiquement et obtiennent `insufficient_scope`. La plateforme
  développeur accorde les deux aux clés provisionnées pour le wallet et les réapplique lors
  d'une rotation ; ajoutez-les aux clés créées à la main.
- **`ACTIVITY_RETENTION_DAYS`** (30 par défaut) rejoint la tâche de rétention. Ces lignes
  contiennent des données personnelles, comme le journal d'accès.

### La route de polling Pollar détecte désormais elle-même une connexion terminée

`GET /v1/pollar/oauth/sessions/{state}` attendait auparavant le callback du pont, que Pollar
n'appelle jamais ; les connexions du flux par polling restaient donc `pending` jusqu'à leur
expiration. Le polling interroge désormais Pollar et promeut le handshake dès `READY`. Aucun
changement de format d'API ni côté client n'est nécessaire. Au moment du déploiement :

- **La migration `20260906120000_pollar_oauth_provider_probe`** ajoute une colonne nullable
  `providerCheckedAt` à `pollar_oauth_session`. Pas de backfill.
- **Le trafic de polling atteint désormais Pollar.** Prévoyez une requête au fournisseur par
  connexion en cours toutes les deux secondes, sur la clé publiable du réseau concerné.

### Les connexions Pollar provisionnent désormais un wallet sur les deux réseaux

`POST /v1/pollar/oauth/token` a gagné un tableau `network_wallets` — une entrée par réseau
Stellar, chacune `ready`, `pending` ou `failed`. Le changement est additif. Au moment du
déploiement :

- **Exécutez la migration.** `20260905120000_pollar_user_wallet` ajoute `pollar_user_wallet`
  et l'enum `PollarWalletStatus`. Sans elle, chaque échange de code journalise un
  provisionnement en échec et le wallet de contrepartie n'est pas enregistré — la connexion
  elle-même continue de fonctionner.
- **Définissez les clés des deux réseaux.** `POLLAR_*_MAINNET` et `POLLAR_*_TESTNET` sont
  chacune optionnelles, et un réseau sans clés apparaît comme un wallet `pending` à chaque
  connexion. Dès que la seconde paire est définie, le sweeper provisionne l'arriéré à son
  prochain cycle ; sinon, les lignes restent `pending` jusqu'à épuisement de leurs tentatives.
  Dans les deux cas, les connexions n'échouent jamais.

Une connexion mainnet finance une réserve sur *les deux* réseaux. Une connexion testnet ne
finance que le testnet — elle finançait aussi le mainnet, ce que les corrections de la revue
de sécurité ci-dessus ont supprimé.

### `429` renvoie désormais `rate_limited`

Un `429` renvoyait auparavant `code: "provider_unavailable"`. Il renvoie désormais
`code: "rate_limited"` (`ApiErrorCode.RateLimited`, qui fait partie de l'enum publiée).
Basez-vous sur ce code si vous réessayez en cas de limitation.

### Un BlindPay non configuré renvoie désormais `misconfigured`

Lorsque BlindPay n'est pas configuré, deux réponses ont changé :

| Requête | Avant | Désormais |
| ------- | ----- | --------- |
| Une route qui appelle BlindPay — sous `/v1/kyc`, `/v1/onramp` ou `/v1/offramp` — tant que `BLINDPAY_API_KEY` ou `BLINDPAY_INSTANCE_ID` n'est pas défini | `503` `provider_unavailable` | `503` `misconfigured` |
| `POST /v1/blindpay/webhooks` tant que `BLINDPAY_WEBHOOK_SECRET` n'est pas défini | `400` `validation_failed` | `503` `misconfigured` |

Il s'agit dans les deux cas d'erreurs de configuration du déploiement, qu'une nouvelle
tentative ne peut pas corriger. Svix réessaie toute réponse non 2xx, donc la livraison des
webhooks ne change pas. Pollar renvoyait déjà `misconfigured` dans la même situation.

### Formats de réponse modifiés

Trois formats de réponse publiés ont changé sous `/v1` (il n'y a pas de `/v2`) ; prévenez
donc les intégrateurs avant de déployer.

| Endpoint | Avant | Maintenant | Pourquoi |
| -------- | ----- | ---------- | -------- |
| `GET /v1/webhooks` | tableau nu, silencieusement tronqué à 100 éléments | `{ data, total, take, skip }` | Les résultats étaient plafonnés à 100, sans `total` pour paginer |
| `GET /v1/products` | tableau nu, table entière | `{ data, total, take, skip }` | Lecture non bornée |
| `GET /v1/webhooks/:id/deliveries` et la réponse de relivraison | incluaient `payload` | `payload` supprimé | Un corps `RECEIVER_UPDATED` est un dossier KYC complet, et ces routes sont protégées par `webhooks:read`, pas par `kyc:read` |

Les appelants qui parcourent la réponse ou lisent `delivery.payload` casseront : lisez
`res.data` à la place, et récupérez les détails KYC via les endpoints KYC avec une clé qui
détient `kyc:read`.

Les **corps de webhook** `RECEIVER_UPDATED` / `PAYIN_*` / `PAYOUT_*` ont eux aussi été réduits
à l'identité et à l'état — voir la section Webhooks.

### La migration audit-hardening

Elle est livrée sous la forme de deux fichiers qui doivent être appliqués dans l'ordre :

- `20260901120000_audit_hardening` — le travail de correction : une nouvelle colonne, un
  `DELETE` de dédoublonnage sur `liquidity_pool_operation`, deux index `UNIQUE`, deux
  nouvelles tables. Le DELETE et l'index unique s'exécutent dans une même transaction sous un
  verrou `SHARE ROW EXCLUSIVE`, de sorte que les écritures sur cette table sont bloquées
  quelques millisecondes.
- `20260901120100_audit_hardening_indexes` — neuf index additifs, construits
  `CONCURRENTLY`, de sorte que le déploiement ne bloque **pas** les écritures sur
  `payment_intent`, `swap`, `webhook_delivery` ou `request_log`. Aucune fenêtre de maintenance
  n'est nécessaire.

Ce sont deux fichiers séparés parce que PostgreSQL n'autorise pas
`CREATE INDEX CONCURRENTLY` à l'intérieur d'une transaction, et le premier fichier en a besoin
d'une.

Si le second fichier échoue en cours de route, il peut laisser un index **invalide** que
`IF NOT EXISTS` considère comme présent. Trouvez-le, supprimez-le, puis relancez :

```sql
SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE NOT i.indisvalid;
```

### `ADMIN_API_CREDENTIALS` disparaît — `/v1/admin` appartient à la console de la plateforme

**Supprimez la variable.** Elle n'est plus lue, et les `COSMOS_ADMIN_API_SECRET` /
`COSMOS_ADMIN_API_SECRET_READ` correspondants de la plateforme développeur disparaissent avec
elle.

C'était un second contrôle d'administration en plus de la vérification de rôle de la
plateforme développeur, et les déploiements qui l'omettaient recevaient
`401 admin_credentials_required` sur les lectures inter-tenants depuis la console. Désormais,
`/v1/admin` n'accepte une requête que si elle provient de la console de la plateforme, ce
qu'établissent deux éléments de la requête :

1. `X-Gateway-Secret` correspond à `APISIX_GATEWAY_SECRET` — vérifié par `ApisixGuard`
   comme sur toutes les autres routes. Seuls la passerelle et le backend de la console le
   détiennent.
2. `X-Cosmos-Internal` est présent. APISIX le supprime de chaque requête qu'il relaie
   (`proxy-rewrite.headers.remove`), de sorte qu'un appelant muni d'une clé API ne peut pas le
   porter ; seul un appel direct depuis un backend détenant le secret de la passerelle le peut.

Le point 2 dépend de la configuration de la route de la passerelle dans le dépôt de la
plateforme développeur, et non d'un secret détenu par ce service. En contrepartie, la console
est le seul endroit qui décide qui est administrateur de la plateforme, et les lignes d'audit
nomment le compte de la console qui a agi (`cosmos_<userId>`) et son rôle de plateforme, pour
chaque mutation **et** chaque lecture.

Ce que cela change pour un appelant :

| Avant | Maintenant |
| ----- | ---------- |
| `401` `admin_credentials_required` sans secret Bearer | `403` `admin_console_only` pour tout ce qui n'est pas un appel de la console |
| `403` `admin_role_required` pour un identifiant `read` sur une mutation | supprimé — la console a déjà décidé que le compte peut agir |
| `actorId` / `actorRole` sur une ligne d'audit nommaient l'identifiant | ils nomment le compte de la console et son rôle de plateforme |

Pour appeler `/v1/admin` directement (depuis un script d'exploitation, par exemple), envoyez
`X-Gateway-Secret`, `X-Consumer-Username` et `X-Cosmos-Internal: 1` ; ajoutez
`X-Cosmos-Admin-Role: owner` pour étiqueter la ligne d'audit. Gardez le service hors de
l'internet public.

### `APISIX_GATEWAY_SECRET` exige désormais 32 caractères

Le service refuse de démarrer avec un secret plus court. Ce secret protège désormais aussi
`/v1/admin` (voir ci-dessus). Générez-en un avec `openssl rand -hex 32` et mettez à jour
APISIX au même moment.

### Fonctionnalités de `v0.1.0`–`v0.1.5` remplacées par cette version

Un déploiement qui passe de `v0.1.5` à cette version perd les comportements suivants. Chaque
élément est visible par les intégrateurs ; planifiez donc la mise à niveau en conséquence.

| Présent dans `v0.1.5` | Maintenant |
| --------------------- | ---------- |
| `POST /v1/webhooks/:id/rotate-secret` acceptait `graceSeconds` et continuait de vérifier l'ancien secret pendant `WEBHOOK_SECRET_GRACE_SECONDS` | Le secret est remplacé d'un coup ; le précédent cesse immédiatement d'être vérifié. Mettez à jour le secret stocké du récepteur dans la même fenêtre que l'appel de rotation. |
| Un worker de réessai à bail livrait les webhooks (`maxAttempts` / `nextAttemptAt` / `leaseUntil`, statut `RETRYING`) | C'est le sweeper de livraison qui s'en charge, avec `WEBHOOK_MAX_ATTEMPTS` revenu à `3` par boucle en processus (un plafond réel de 9 sur l'ensemble des balayages). `WEBHOOK_MAX_BACKOFF_MS`, `WEBHOOK_WORKER_*`, `WEBHOOK_LEASE_MS`, `WEBHOOK_FANOUT_CONCURRENCY` et `WEBHOOK_PAUSE_AFTER_FAILURES` ont disparu, et aucune livraison n'est jamais écrite avec le statut `RETRYING`. |
| `SWAP_EXPIRED` et `LIQUIDITY_EXPIRED` étaient émis | Aucun des deux n'est émis. L'expiration reste enregistrée sur la ligne ; interrogez-la, ou abonnez-vous aux événements `*_FAILED`. |
| `GET /v1/products` filtrait sur `kind`, `active` et `reference`, et `DELETE` acceptait `hard=true` | Ni l'un ni l'autre n'existe. Les suppressions sont logiques (`active=false`). |
| `GET /v1/products` et `GET /v1/customers` utilisaient par défaut `take=20` | Les deux utilisent par défaut `take=100` (toujours le maximum), donc un appel sans paramètres renvoie plus de lignes qu'auparavant. |
| `analytics.apiLogs` / `analytics.webhookLogs` renvoyaient `{ data, total }` et ne tenaient compte que de `take` | Les deux sont paginés comme toutes les autres listes : `take` + `skip` en entrée, `{ data, total, take, skip, hasMore }` en sortie. Les filtres de plage de dates de la vue d'ensemble ont disparu. |
| `/v1/health` rapportait un indicateur de disponibilité Stellar en plus de la base de données | Il ne rapporte que la base de données. |
| `STELLAR_HTTP_TIMEOUT_MS`, `STELLAR_MAX_ATTEMPTS`, `STELLAR_RETRY_BASE_MS` bornaient les appels Horizon | Les bornes des appels Horizon se trouvent dans `stellar/stellar.constants.ts` et ne sont pas configurables par l'environnement. Ces trois variables ne sont plus ni lues ni validées. |

**Rien n'est supprimé de la base de données.** Les colonnes, index et valeurs d'enum ajoutés
par ces fonctionnalités (`webhook_delivery.maxAttempts` / `nextAttemptAt` /
`leaseUntil`, `webhook_endpoint.previousSecret*`, `swap` et
`liquidity_pool_operation` `lastCheckedAt` / `notFoundStreak`, la table
`horizon_account_cursor`, `RETRYING`, `SWAP_EXPIRED`, `LIQUIDITY_EXPIRED`) sont toujours
déclarés dans `schema.prisma` et présents après `migrate deploy` ; ils ne sont simplement plus
écrits. Les supprimer nécessiterait une migration destructrice (PostgreSQL ne peut pas retirer
une valeur d'enum sans recréer le type).

## Variables d'environnement

Chaque variable lue depuis `process.env` dans `src/` est validée au démarrage par
`src/config/env.validation.ts` (fail-fast). Copiez `.env.example` et ajustez au moins
`DATABASE_URL` et `APISIX_GATEWAY_SECRET`.

| Variable | Requise | Défaut | Effet |
| -------- | ------- | ------ | ----- |
| `NODE_ENV` | non | `development` | Doit valoir `development`, `test` ou `production`. **Définissez `production` en production** — la vérification fail-closed des frais de plan et la désactivation par défaut de la documentation en dépendent toutes deux |
| `PORT` | non | `3000` | Port d'écoute HTTP |
| `DATABASE_URL` | **oui** | — | Connexion PostgreSQL pour Prisma |
| `APISIX_GATEWAY_SECRET` | **oui** | — | Secret partagé prouvant que la requête est passée par APISIX. **32 caractères minimum** ; un placeholder est refusé au démarrage |
| `APISIX_GATEWAY_SECRET_HEADER` | non | `x-gateway-secret` | Nom de l'en-tête portant le secret de la passerelle |
| `APISIX_CONSUMER_HEADER` | non | `x-consumer-username` | Nom d'utilisateur du consumer authentifié |
| `APISIX_CREDENTIAL_HEADER` | non | `x-credential-identifier` | Identifiant du credential issu de key-auth |
| `APISIX_ENVIRONMENT_HEADER` | non | `x-consumer-env` | Environnement de la clé (`dev` / `prod`) |
| `APISIX_ROLE_HEADER` | non | `x-consumer-role` | Rôle du consumer transmis par la passerelle |
| `APISIX_PERMISSIONS_HEADER` | non | `x-consumer-permissions` | Liste des permissions transmise par la passerelle |
| `APISIX_ORGANIZATION_HEADER` | non | `x-consumer-org` | Identifiant de l'organisation |
| `APISIX_PLAN_HEADER` | non | `x-consumer-plan` | Plan de l'organisation |
| `APISIX_SWAP_FEE_BPS_HEADER` | non | `x-plan-swap-fee-bps` | Frais de swap du plan (bps) |
| `APISIX_EMAIL_HEADER` | non | `x-consumer-email` | E-mail vérifié du compte de la clé. La passerelle Pollar ne renvoie la session d'une connexion qu'à ce compte, et refuse une clé qui n'en a pas |
| `APISIX_PUBLIC_CONSUMER` | non | — | Nom d'utilisateur du consumer public partagé (voir ci-dessus). Définissez-la partout où une clé publique est publiée |
| `STELLAR_NETWORK` | non | `testnet` | Réseau Stellar de repli (`public` / `testnet`) |
| `STELLAR_HORIZON_URL_PUBLIC` | non | `https://horizon.stellar.org` | URL de base d'Horizon sur le mainnet |
| `STELLAR_HORIZON_URL_TESTNET` | non | `https://horizon-testnet.stellar.org` | URL de base d'Horizon sur le testnet |
| `STELLAR_BASE_FEE` | non | `100` | Frais de base Stellar (stroops) pour la construction des tx |
| `STELLAR_TX_TIMEOUT` | non | `300` | Timeout de transaction (secondes) |
| `STELLAR_SWAP_FEE_WALLET` | si frais > 0 | — | Compte G... de la plateforme qui reçoit les frais de swap |
| `STELLAR_SWAP_FEE_BPS` | non | `50` | Frais de swap en points de base |
| `STELLAR_SWAP_SLIPPAGE_BPS` | non | `50` | Tolérance de slippage par défaut des swaps (bps) |
| `STELLAR_SWAP_MAX_SLIPPAGE_BPS` | non | `500` | Plafond strict du slippage demandé par l'appelant (bps) |
| `STELLAR_SWAP_SINGLE_INFLIGHT` | non | `false` | Si `true`, 409 lorsqu'un swap PENDING non expiré existe déjà pour la même source |
| `OBSERVER_ENABLED` | non | `true` | `true` / `false` — réconciliateur on-chain |
| `OBSERVER_INTERVAL_MS` | non | `15000` | Intervalle de polling de l'observateur (ms, min 1000) |
| `OBSERVER_BATCH_SIZE` | non | `50` | Nombre max d'intentions/swaps par cycle de l'observateur |
| `PAYMENT_INTENT_TTL_SECONDS` | non | `3600` | Durée de vie d'une intention impayée avant `EXPIRED` |
| `WEBHOOK_TIMEOUT_MS` | non | `5000` | Timeout historique de repli des webhooks (ms) |
| `WEBHOOK_CONNECT_TIMEOUT_MS` | non | `3000` | Budget de connexion des webhooks sortants (ms) |
| `WEBHOOK_READ_TIMEOUT_MS` | non | `5000` | Budget de lecture des webhooks sortants (ms) |
| `WEBHOOK_MAX_RESPONSE_BYTES` | non | `65536` | Taille max du corps de réponse de webhook lu |
| `WEBHOOK_MAX_ATTEMPTS` | non | `3` | Nombre de tentatives de livraison |
| `WEBHOOK_BACKOFF_MS` | non | `2000` | Backoff linéaire entre les tentatives (ms) |
| `WEBHOOK_SIGNATURE_HEADER` | non | `x-cosmos-signature` | En-tête HMAC envoyé aux intégrateurs |
| `WEBHOOK_SWEEP_ENABLED` | non | `true` | Récupérer les livraisons bloquées par un crash. Interrupteur d'incident |
| `WEBHOOK_SWEEP_INTERVAL_MS` | non | `60000` | Intervalle du sweeper (ms, min 1000) |
| `WEBHOOK_PAYLOAD_RETENTION_DAYS` | non | `30` | Nombre de jours de conservation du corps d'une livraison réglée avant son caviardage. `0` le conserve indéfiniment |
| `REQUEST_LOG_RETENTION_DAYS` | non | `30` | Nombre de jours de conservation des lignes `request_log` (IP / user-agent du payeur). `0` désactive la purge |
| `ACTIVITY_RETENTION_DAYS` | non | `30` | Nombre de jours de conservation des lignes `activity_event` (IP / user-agent / `props` du client). Purgées par la même tâche. `0` conserve les événements indéfiniment |
| `REQUEST_LOG_PRUNE_INTERVAL_MS` | non | `3600000` | Intervalle du timer de rétention (ms) |
| `REQUEST_LOG_PRUNE_BATCH_SIZE` | non | `1000` | Lignes par lot de suppression (garde chaque verrou court) |
| `REQUEST_LOG_PRUNE_MAX_PER_CYCLE` | non | `50000` | Plafond strict du nombre de lignes examinées par cycle |
| `SWAGGER_ENABLED` | non | désactivé en `production` | Publier `/docs` (middleware Express, sans guards) |
| `OPENAPI_SERVER_URL` | non | — | Hôte de la passerelle inscrit dans l'OpenAPI exportée |
| `BLINDPAY_API_KEY` | non | — | Clé API de l'instance de production BlindPay, utilisée par les clés `prod` |
| `BLINDPAY_INSTANCE_ID` | si la clé API est définie | — | Identifiant d'instance BlindPay (`in_...`) |
| `BLINDPAY_BASE_URL` | non | `https://api.blindpay.com/v1` | URL de base de l'API BlindPay |
| `BLINDPAY_WEBHOOK_SECRET` | si la clé API est définie | — | Secret Svix des webhooks BlindPay entrants : la valeur `whsec_…` complète, dont la clé doit se décoder en au moins 24 octets (vérifié au démarrage) |
| `BLINDPAY_API_KEY_DEV` | non | — | Clé API de l'instance de développement BlindPay, utilisée par les clés `dev`. Non définie : les routes BlindPay répondent `503 misconfigured` aux clés `dev` |
| `BLINDPAY_INSTANCE_ID_DEV` | si la clé API de dev est définie | — | Identifiant de l'instance de développement (`in_...`) |
| `BLINDPAY_WEBHOOK_SECRET_DEV` | si la clé API de dev est définie | — | Secret Svix de l'endpoint de webhook de l'instance de développement ; mêmes règles que `BLINDPAY_WEBHOOK_SECRET` |
| `BLINDPAY_TIMEOUT_MS` | non | `15000` | Timeout du client HTTP BlindPay (ms) |
| `DEFINDEX_API_KEY` | non | — | Clé API serveur DeFindex ; vide, les routes sont désactivées |
| `DEFINDEX_BASE_URL` | non | `https://api.defindex.io` | URL de base de l’API DeFindex |
| `DEFINDEX_TIMEOUT_MS` | non | `30000` | Timeout HTTP DeFindex (ms) |
| `KYC_REDIRECT_URL_WHITELIST` | non | — | Liste d'autorisation, par consumer, des hôtes de redirection KYC |
| `RATE_LIMIT_ENABLED` | non | `true` | Plafonds par adresse sur les routes qui dépensent des XLM. Interrupteur d'incident |
| `RATE_LIMIT_PRUNE_INTERVAL_MS` | non | `600000` | Intervalle de purge des fenêtres de compteur (ms, min 1000) |
| `POLLAR_PUBLISHABLE_KEY_TESTNET` / `_MAINNET` | non | — | Clé publiable Pollar (`pub_<network>_…`), pour le pont OAuth |
| `POLLAR_SECRET_KEY_TESTNET` / `_MAINNET` | avec la clé publiable | — | Clé secrète Pollar (`sec_<network>_…`), pour les routes opérateur |
| `POLLAR_BRIDGE_CALLBACK_URL` | si une clé Pollar est définie | — | URL publique vers laquelle Pollar renvoie le navigateur. Doit être `<gateway>/v1/pollar/oauth/callback`, **https** (`http` simple uniquement sur un hôte loopback — sinon le démarrage échoue : le code d'autorisation voyage dans sa query string) **et** un hôte enregistré sous Build → Domains chez Pollar |
| `POLLAR_REDIRECT_URI_WHITELIST` | non | — | Liste d'autorisation, par consumer, des URI de redirection des wallets. Vide ⇒ ce consumer ne peut utiliser que le flux par polling |
| `POLLAR_SDK_ORIGIN` | non | origine de `POLLAR_BRIDGE_CALLBACK_URL` | `Origin` envoyé à la SDK API de Pollar, qui le compare à Build → Domains. À définir uniquement lorsque l'hôte du callback et l'hôte enregistré diffèrent |
| `POLLAR_SDK_BASE_URL` | non | `https://sdk.api.pollar.xyz` | URL de base de la SDK API Pollar |
| `POLLAR_SERVER_BASE_URL` | non | `https://api.pollar.xyz` | URL de base de la Server API Pollar |
| `POLLAR_TIMEOUT_MS` | non | `15000` | Timeout du client HTTP Pollar (ms) |
| `POLLAR_AUTHORIZATION_TTL_MS` | non | `300000` | Durée pendant laquelle un handshake de connexion reste ouvert |
| `POLLAR_CODE_TTL_MS` | non | `120000` | Durée pendant laquelle un code émis par le pont reste échangeable |
| `POLLAR_LOGIN_WAIT_MS` | non | `20000` | Durée pendant laquelle l'échange du code attend que Pollar provisionne le wallet |
| `POLLAR_SWEEP_ENABLED` | non | `true` | Expirer les handshakes que personne n'a terminés, et réessayer les wallets inter-réseaux qu'une connexion a laissés en `pending` |
| `POLLAR_SWEEP_INTERVAL_MS` | non | `60000` | Intervalle du sweeper de handshakes (ms, min 1000) |

La variable historique `STELLAR_HORIZON_URL` est rejetée au démarrage — utilisez
`STELLAR_HORIZON_URL_PUBLIC` / `STELLAR_HORIZON_URL_TESTNET` à la place.

## Démarrage

```bash
cp .env.example .env          # set DATABASE_URL and a strong APISIX_GATEWAY_SECRET
npm install
npm run db:generate           # prisma generate
npm run db:migrate            # create the schema (needs a running Postgres)
npm run start:dev
```

Générer un secret :

```bash
openssl rand -hex 32
```

Exécuter les mêmes vérifications que la CI (aucune base de données nécessaire — Prisma est
mocké) :

```bash
npm run lint
npm test                 # unit suites (src/**/*.spec.ts)
npm run test:e2e         # e2e suites (test/*.e2e-spec.ts)
npm run openapi:check    # the committed contract matches the controllers
npm run readme:check     # the seven READMEs match in structure and list every route
```

## Configuration des routes APISIX

L'utilitaire de routes de la plateforme développeur (`paydev/src/utils/apisix.ts`) convertit
déjà `Authorization: Bearer <token>` en en-tête `apikey`, valide `key-auth` et supprime les
identifiants avant de relayer la requête. Pour faire pointer une route vers ce service, ajoutez
l'**injection du secret de la passerelle** au plugin `proxy-rewrite` afin que l'en-tête arrive
ici — et supprimez toute copie fournie par le client :

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

`key-auth` transmet `X-Consumer-Username` / `X-Credential-Identifier` à l'upstream après une
authentification réussie, en écrasant toute copie fournie par le client, et le guard s'appuie
sur ce comportement.

> **La liste de suppression est un contrôle de sécurité, et elle ne peut pas être vérifiée
> depuis ce dépôt.** Ce service accepte tel quel chaque en-tête qu'elle contient ;
> `X-Gateway-Secret` prouve seulement que la requête est passée par une passerelle, pas que
> ces valeurs sont honnêtes. Relisez la liste chaque fois qu'une route est ajoutée ou copiée —
> une route qui ne supprime pas `X-Cosmos-Internal` donne à chaque clé API l'accès à
> `/v1/admin`. Gardez le service sur un réseau privé afin qu'APISIX soit le seul point
> d'entrée ; le secret partagé est une seconde couche, pas la seule.
>
> En production, un `X-Plan-Swap-Fee-Bps` absent renvoie `503` au lieu de se rabattre sur la
> valeur par défaut de l'environnement.
