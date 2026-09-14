# Cosmos Pay — Microservice de paiements

[English](./README.md) · [Español](./README.es.md) · [Português](./README.pt.md) · [Deutsch](./README.de.md) · **Français** · [हिन्दी](./README.hi.md) · [简体中文](./README.zh.md)

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

Une surface exige davantage de ces deux mêmes conditions. `/v1/admin` est
inter-tenants, et `AdminGuard` n'y admet une requête que si elle porte aussi
`X-Cosmos-Internal` — un en-tête qu'APISIX **supprime** de tout ce qu'il relaie, de sorte que
seul un appel direct depuis un backend détenant le secret de la passerelle peut le présenter. Ce
backend est la plateforme développeur, qui a déjà décidé si le compte connecté est
owner/admin. Il n'y a pas d'identifiant d'administration distinct à déployer (voir la note
de mise à niveau sur `ADMIN_API_CREDENTIALS`), ce qui fait du secret de la passerelle et de
l'isolation réseau l'unique frontière devant les données inter-tenants — et rend la liste
de suppression de la route de la passerelle pertinente pour la sécurité, et non une simple
question d'hygiène.

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
  stellar/                        per-network Horizon servers (bounded timeout)
  payment-intents/                Stellar payment intents (controller, service, DTO) — emits events
  swaps/                          Stellar native swaps (path payments): quote, build XDR, submit
  liquidity-pools/                AMM deposit/withdraw, cost basis + commission on gain
  observer/                       background reconciler: swaps + LP ops against Horizon
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
Les chemins utilisent la forme OpenAPI `{param}`, et `npm run readme:check` fait échouer la CI
lorsqu'une route du contrat manque dans ce tableau.

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
`ApiErrorBodyEntity`, rattachée à chaque opération — ainsi un client généré obtient aussi
le type d'erreur, et vous n'avez pas besoin de lire ce dépôt pour découvrir les codes.
La source de vérité est `ApiErrorCode` dans `src/common/errors/api-error.ts`.
**Les codes ne sont jamais renommés une fois publiés** ; de nouveaux peuvent être ajoutés,
traitez donc un code inconnu selon son statut HTTP.

Quelques-uns, faciles à confondre :

| Code | Statut | Signification |
| ---- | ------ | ------------- |
| `insufficient_scope` | 403 | La clé API ne possède pas le scope. Reprovisionnez la clé |
| `account_disabled` | 403 | Un opérateur a désactivé ce compte fiat. Ce n'est pas un problème de clé |
| `gateway_required` | 403 | La requête n'est pas passée par APISIX |
| `admin_console_only` | 403 | La route appartient à la console de la plateforme (`/v1/admin`, le lancement d'une récupération d'alias). Aucune clé API ne peut l'appeler |
| `idempotency_conflict` | 409 | Cette `Idempotency-Key` (ou le mémo d'une intention de paiement) a déjà produit une ressource pour une requête *différente*. Répétez la requête d'origine, ou utilisez une nouvelle clé |
| `kyc_state_invalid` | 409 | Une transition d'état KYC illégale — pas une requête en double |
| `operation_in_flight` | 409 | Une opération concurrente est encore en cours de règlement |
| `payload_expired` | 409 | Le corps de la livraison a dépassé la durée de rétention et ne peut pas être renvoyé |
| `provider_unavailable` | 503/504 | BlindPay ou Horizon est injoignable. Réessayez |
| `misconfigured` | 503 | Une erreur de configuration côté serveur. Réessayer n'y changera rien |

Chaque intention est **persistée** (table `payment_intent`) et rattachée au consumer
APISIX authentifié, de sorte que les lectures, mises à jour et suppressions ne touchent
jamais que les enregistrements de ce consumer — traçabilité complète du cycle de vie de
chaque intention (`PENDING → SUBMITTED → SUCCEEDED/FAILED/CANCELLED/EXPIRED`).

### Exécuter plusieurs réplicas

APISIX répartit la charge entre les instances, donc chaque `setInterval` de ce service
s'exécute une fois par réplica. La correction n'a jamais été le problème — chaque changement
de statut passe par un compare-and-swap `updateMany` protégé, si bien qu'un seul écrivain
l'emporte — mais trois réplicas signifiaient trois fois plus d'allers-retours vers Horizon
pour un travail identique, auprès d'une API soumise à un rate limit, et des réplicas en
concurrence pour supprimer les mêmes tuples de `request_log`.

Chaque tâche de fond prend désormais un **verrou consultatif (advisory lock) de niveau
transaction** PostgreSQL (`AdvisoryLockService`, `src/common/services/advisory-lock.service.ts`)
et saute son cycle lorsqu'un autre réplica le détient :

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

`pg_try_advisory_xact_lock` est utilisé plutôt que la variante de niveau session pour
trois raisons : il ne bloque jamais (un réplica qui perd saute simplement son tour, ce
que souhaite un poller), il est libéré à la fin de la transaction — y compris en cas de
crash ou de connexion perdue, de sorte qu'un pod tué ne peut pas bloquer le verrou — et il
reste donc correct derrière PgBouncer en mode transaction pooling, où les verrous de
niveau session sont dangereux parce que les connexions ne sont pas persistantes.

Les identifiants de verrou se trouvent dans l'enum `AdvisoryLockKey` et constituent
l'identité de la tâche : renommer un membre en lui donnant un nouveau numéro désactive
silencieusement l'exclusion, c'est pourquoi les numéros retirés ne sont jamais réutilisés.

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
  échouée ou non, est une non-correspondance qui laisse le statut inchangé, afin qu'une tx
  correcte puisse encore être soumise ; sinon, le hash de n'importe quelle transaction
  échouée du réseau ferait échouer une intention définitivement.
- **Automatique (observateur permanent) :** `StellarObserverService` interroge Horizon
  toutes les `OBSERVER_INTERVAL_MS` à la recherche d'intentions `PENDING` — par le
  `txHash` déclaré, ou en parcourant les paiements vers la destination — et finalise les
  correspondances de la même manière, de sorte que les statuts changent et que les
  événements sont émis **sans que personne n'appelle l'API**. Un cycle traite au plus
  `OBSERVER_MAX_INTENTS_PER_CONSUMER` (10) intentions par consumer et ne parcourt jamais
  une intention expirée, de sorte qu'un afflux provenant d'un seul consumer — clé publique
  partagée comprise — ne peut pas bloquer le règlement de tous les autres. Désactivez-le
  pour le développement local avec `OBSERVER_ENABLED=false`.

### Rétention des journaux de requêtes API

Chaque requête entrante, à l'exception de `/v1/health` et `/docs`, est ajoutée à
`request_log` par `LoggingInterceptor` et alimente la vue **API logs** du tableau de bord
(`GET /v1/logs`). Les lignes incluent le chemin, le statut, la durée et — lorsqu'ils sont
présents — l'`ip` / `userAgent` du payeur.

Le trafic du tableau de bord (`X-Cosmos-Internal`) est **enregistré et marqué**
(`request_log.internal`), et non ignoré, et la vue des journaux API filtre sur cette
colonne. Une version antérieure s'arrêtait prématurément en présence de cet en-tête, ce qui
signifiait que quiconque pouvait le définir tenait ses requêtes entièrement à l'écart du
journal d'audit — un en-tête de requête ne doit jamais pouvoir rendre du trafic invisible.

Ces lignes ne sont **pas conservées indéfiniment**. `RequestLogRetentionService` supprime
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

`request_log` enregistre ce qui a atteint ce service. Il ne peut pas enregistrer ce qu'un
client *a fait* : un wallet qui a planté sur son écran d'envoi, une signature annulée par
l'utilisateur, une page du tableau de bord qui a levé une exception avant qu'aucune requête
ne quitte le navigateur. Aucun de ces cas ne produit d'appel HTTP ici, et ce sont précisément
les événements utiles quand quelque chose ne va pas — les clients rapportent donc les leurs,
vers `POST
/v1/activity/events`.

- **Un lot, pas un appel par événement.** Les clients mettent en file d'attente puis
  envoient la file, de sorte qu'un wallet hors ligne conserve ses événements et les envoie
  au lancement suivant. Jusqu'à `ACTIVITY_MAX_BATCH` (100) par requête, écrits en une seule
  instruction.
- **Réessayer un envoi est sans risque.** Un événement peut porter le propre `eventId` du
  client ; `(consumerId, eventId)` est unique et l'insertion ignore les doublons, de sorte
  qu'un lot écrit mais dont l'accusé de réception n'est jamais arrivé peut être renvoyé
  sans dupliquer chaque ligne. La réponse indique `accepted` et `duplicates`.
- **L'attribution vient de la passerelle, jamais du corps.** Les lignes sont écrites au nom
  du consumer authentifié par APISIX. Un client ne peut pas enregistrer d'événements au nom
  d'un autre compte, et aucun champ ne lui permettrait d'essayer.
- **L'ingestion n'échoue pas à cause de la forme d'un payload.** Un `message` trop long est
  tronqué et des `props` trop volumineuses sont remplacées par `{"_dropped":
  "props_too_large"}` ; un 400 coûterait le lot entier, et le lot compte le plus lorsque le
  client se trouve dans un état que personne n'avait anticipé.
- **Une horloge d'appareil erronée ne peut pas réordonner le flux.** `occurredAt` est ramené
  à l'heure de réception lorsqu'il est en avance de plus de cinq minutes ou en retard de plus
  de sept jours, de sorte qu'un téléphone qui avance d'une heure ne peut pas épingler ses
  événements en tête d'une liste triée du plus récent au plus ancien. Les deux horodatages
  sont conservés : `at` (celui du client) et `receivedAt`.

Pour les relire :

| Route                   | Scope             | Renvoie                                                              |
| ----------------------- | ----------------- | -------------------------------------------------------------------- |
| `GET /v1/activity/events` | `activity:read` | Le flux, du plus récent au plus ancien. Filtres : `source`, `level`, `category`, `type` (préfixe), `network`, `since`/`until` |
| `GET /v1/activity/summary` | `activity:read` | Comptages par level/source/category, principaux types d'événements, principales erreurs, sessions, appareils, une série quotidienne |

`level` sur le flux est un **plancher**, pas une correspondance exacte : `level=warn`
renvoie les avertissements *et* les erreurs. Un filtre qui ne renverrait que les lignes que
quelqu'un a étiquetées `error` masquerait les avertissements qui y ont conduit.

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

**Ce que contient un corps issu de BlindPay.** `RECEIVER_UPDATED` / `PAYIN_*` /
`PAYOUT_*` ne transportent que l'identité et l'état — identifiants, statut, montants,
rails — jamais de données personnelles. L'objet du fournisseur n'est *pas* transmis tel
quel : un payload de receiver est un dossier KYC complet (numéro d'identification fiscale,
date de naissance, adresse, liens vers les documents), et s'abonner à un événement ne
requiert que `webhooks:write`, ce qui ferait du webhook un moyen de se faire livrer ce
dossier sur n'importe quel hôte. Récupérez les détails via l'API avec une clé qui détient
`kyc:read` / `onramp:read` / `offramp:read`. Voir
`src/blindpay/blindpay-event-redaction.ts` pour la liste d'autorisation exacte des champs.

La livraison est découplée via `EventEmitter2` de NestJS (`webhook.event`), de sorte
qu'émettre une notification ne bloque jamais la requête API qui l'a déclenchée.

**Politique de destination sortante (SSRF) :** les endpoints doivent utiliser `https` et
ne se résoudre qu'en adresses publiques. L'enregistrement rejette le loopback, les plages
privées RFC1918, le link-local (`169.254.0.0/16`, y compris les métadonnées cloud
`169.254.169.254`) et les noms d'hôte de métadonnées connus. La même vérification est
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

**Le vrai plafond de tentatives est 9, pas 3.** `WEBHOOK_MAX_ATTEMPTS` borne une boucle de
réessai en processus. Le sweeper reprend ensuite les livraisons qui restent dans la limite de
`WEBHOOK_MAX_ATTEMPTS × 3` tentatives au total, de sorte qu'une livraison peut être tentée
jusqu'à neuf fois, réparties sur plusieurs heures. C'est délibéré — un pod tué en plein
backoff laissait autrefois une livraison PENDING bloquée pour toujours, c'est-à-dire un
paiement réglé dont personne n'avait été notifié.

**La relivraison est assurée au mieux, dans la fenêtre de rétention.** Après
`WEBHOOK_PAYLOAD_RETENTION_DAYS`, le corps stocké est effacé (un corps `RECEIVER_UPDATED`
est un dossier KYC, et le journal des livraisons est conservé). Le sweeper ignore ces lignes
et `POST /v1/webhooks/:id/deliveries/:id/redeliver` renvoie `409 payload_expired` plutôt que
d'envoyer un corps caviardé sous un vrai type d'événement avec une signature valide.

**Contrat du récepteur.** Tout `2xx` vaut accusé de réception. Répondez dans le délai de
`WEBHOOK_READ_TIMEOUT_MS` (5s par défaut). L'ordre n'est pas garanti : traitez les
événements comme un ensemble et réconciliez avec l'API. Dédupliquez sur l'`id` de
l'événement — notez qu'une relivraison réutilise l'`id` d'origine, de sorte qu'un récepteur
qui déduplique strictement l'ignorera ; c'est le compromis voulu (livraison au moins une
fois, effet exactement une fois).

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

### OpenAPI / Swagger

**Note de sécurité :** `GET /docs`, `/docs/json` et `/docs/yaml` sont montés par
`SwaggerModule.setup` en tant que **middleware Express**, et non comme contrôleurs Nest. Ils
ne passent **pas** par `ApisixGuard` ni par `PermissionsGuard` — quiconque peut atteindre le
port du service peut récupérer la spécification complète de l'API, sauf si la documentation
est désactivée. En production, la documentation est **désactivée par défaut**
(`NODE_ENV=production` et pas de `SWAGGER_ENABLED`). Définissez `SWAGGER_ENABLED=true`
uniquement lorsque vous souhaitez délibérément publier la spécification sur un réseau de
confiance.

Documentation en direct (lorsqu'elle est activée) :

- `GET /docs` — Swagger UI
- `GET /docs/json` — spécification OpenAPI 3.0 (JSON)
- `GET /docs/yaml` — spécification OpenAPI 3.0 (YAML)

Exportez la spécification vers des fichiers (pour qu'un autre serveur puisse l'héberger ou la
consommer) — ni connexion à la base de données ni vrai secret de passerelle ne sont requis ;
l'export s'exécute en mode preview de Nest, avec des valeurs locales de substitution lorsque
ces variables d'environnement sont absentes :

```bash
npm run openapi:generate
# writes openapi/openapi.json and openapi/openapi.yaml
```

La CI et le contrôle de release régénèrent les deux fichiers versionnés et rejettent toute
dérive. Exécutez la même vérification avant de committer une modification de contrôleur ou
de DTO :

```bash
npm run openapi:check
```

Les chemins de la spécification incluent déjà la version (`/v1/...`). Pour inscrire un hôte
de passerelle concret dans les `servers` de la spécification, définissez `OPENAPI_SERVER_URL`
avant la génération :

```bash
OPENAPI_SERVER_URL=https://gateway.example.com npm run openapi:generate
```

La configuration Swagger (`src/swagger.ts`) est partagée par le serveur en cours d'exécution
et par le générateur, de sorte que les deux restent synchronisés. Les deux en-têtes APISIX
(`X-Gateway-Secret`, `X-Consumer-Username`) sont documentés comme schémas de sécurité dans
la spécification.

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
appels Horizon (construction, validation, observateur) le ciblent.

**Le mémo est un `MEMO_ID` obligatoire** — il identifie le paiement on-chain et confère à
l'intention son **idempotence** : `(consumer, memo)` est unique, donc recréer une intention
avec le même mémo **et les mêmes conditions** renvoie l'intention d'origine. Le même mémo
avec n'importe quelle condition différente — le type, le réseau, la destination, le montant,
l'actif, `msg`, `callback`, ou `source` pour `tx` — donne `409 idempotency_conflict`, et
l'erreur ne dit rien de l'intention stockée. Cette comparaison existe à cause de la clé
publique partagée : chaque wallet anonyme est un seul et même consumer, donc sans elle, un
mémo utilisé en premier par quelqu'un d'autre vous remettait *son* intention, avec un QR qui
le payait, lui. Si vous ne passez pas `memo`, un uint64 aléatoire est généré.

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

Chaque endpoint documente une réponse typée avec des exemples de payloads dans la
spécification OpenAPI (`TxPaymentIntentEntity`, `PayPaymentIntentEntity`,
`ValidationOutcomeEntity`), de sorte que Swagger affiche un exemple concret de réponse, et
non un corps vide.

Réponse :

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

Le wallet est open source et embarque une clé API que tout le monde détient, de sorte
qu'une personne peut effectuer un swap, ajouter de la liquidité ou créer un lien de paiement
sans s'inscrire. Elle paie la commission du plan `community` — 150 bps, le taux le plus élevé
de la grille — et c'est l'inscription qui donne accès à un taux plus bas. La passerelle
injecte le taux par consumer exactement comme pour une clé privée (voir
`resolvePlanCommissionBps`), si bien que rien dans la tarification n'est traité comme un
cas particulier ici.

Ce qui *est* particulier, c'est l'isolation entre tenants. Chaque appelant anonyme du réseau
arrive sous le même consumer APISIX, et les endpoints de lecture filtrent les lignes
précisément par ce consumer :

```ts
// swaps.service.ts
where: { id, consumer: { apisixUsername: consumer.username } }
```

Ainsi, `GET /v1/swaps` sous la clé publique remettrait à chaque utilisateur anonyme
l'historique des swaps de toute la population anonyme. Les scopes ne peuvent pas corriger
cela — un scope est une propriété de la clé, et tous détiennent la même clé — et le
chevauchement n'a rien d'hypothétique : `POST /v1/swaps/quote` requiert `swaps:read`, qui
est le scope même qui liste l'historique.

**`PublicKeyGuard` est donc une liste d'autorisation, pas une liste de refus.** Un consumer
public est refusé sur toute route qui ne porte pas `@AllowPublicKey()`, de sorte qu'une route
ajoutée l'an prochain reste inaccessible à la clé publique jusqu'à ce que quelqu'un en décide
autrement dans le même diff. Oublier le décorateur produit un ticket de support ; oublier une
entrée d'une liste de refus produit une fuite de données.

Accessibles avec la clé publique aujourd'hui :

| Route | Pourquoi c'est sûr |
| --- | --- |
| `POST /v1/swaps/quote` | Calcule le prix d'un chemin depuis Horizon ; une fonction pure de la requête |
| `POST /v1/swaps` | Construit une enveloppe non signée que l'appelant signe |
| `POST /v1/swaps/:id/submit` | Diffuse une enveloppe signée par l'appelant — nécessite l'UUID du swap *et* une signature de son compte source |
| `POST /v1/liquidity-pools/deposit` \| `withdraw` | Construisent des enveloppes non signées |
| `POST /v1/liquidity-pools/operations/:id/submit` | Diffuse une enveloppe signée par l'appelant |
| `GET /v1/liquidity-pools` \| `/:poolId` \| `/positions` | Données on-chain publiques lues depuis Horizon |
| `POST /v1/payment-intents/tx` \| `pay` | Construisent une intention SEP-7 à partir de la requête |
| `POST /v1/activity/events` | Ingestion de télémétrie — voir ci-dessous |
| `GET /v1/assets` | Le catalogue public d'actifs |
| `GET /v1/aliases/resolve/:name` \| `availability/:name` \| `by-address/:address` | Un payeur qui résout un identifiant est précisément l'appelant anonyme pour lequel cette clé existe ; la réponse est une fonction pure de la requête et n'inclut jamais la boîte mail du propriétaire |

Refusées, et délibérément : `GET /v1/swaps`, `GET /v1/swaps/:id`,
`GET /v1/liquidity-pools/operations{,/:id}`, `GET /v1/activity/events`,
`GET /v1/activity/summary`, toutes les lectures d'intentions de paiement, toutes les routes
de propriétaire d'alias (revendiquer, lister, ajouter ou retirer une adresse, libérer,
récupérer), et tout ce qui se trouve sous `/v1/kyc`, `/v1/onramp`, `/v1/offramp` et
`/v1/webhooks`. Un wallet sans compte construit plutôt son historique à partir d'Horizon,
qui est de toute façon la source de référence pour l'activité on-chain.

**La télémétrie figure sur la liste à dessein.** Un wallet sans compte CosmosPay plante
quand même, et refuser ses rapports d'erreur nous rendrait aveugles précisément à la
population qui rencontre les échecs au premier lancement — la route d'ingestion répondrait
`403` et les rapports seraient perdus. Les événements arrivant avec cette clé sont anonymes
par construction (un seul consumer partagé), donc rien qui identifie un compte ne peut les
accompagner ; le wallet retire l'adresse, la destination, le montant et le txHash avant
l'envoi.

Le guard identifie le consumer public **soit** par le rôle transmis
(`X-Consumer-Role: public`), **soit** par le nom d'utilisateur configuré dans
`APISIX_PUBLIC_CONSUMER`. Deux signaux, parce que chacun, pris seul, échoue en mode ouvert
d'une manière qui coûte des données utilisateur : une passerelle qui cesserait de transmettre
les rôles ferait de chaque appelant anonyme un tenant ordinaire, et un déploiement qui n'a
jamais défini la variable d'environnement dépendrait d'un en-tête qu'il ne contrôle pas.
Définissez les deux.

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

**Idempotence** optionnelle (issue #17) : envoyez un en-tête `Idempotency-Key` (recommandé)
ou `idempotencyKey` dans le corps. Une nouvelle tentative avec la même clé **et la même
requête** — réseau, source, destination, les deux actifs, montant, slippage et mémo — renvoie
le swap **existant** (`id` + `txHash`) au lieu de construire une autre transaction Stellar. La
même clé avec n'importe quelle requête différente donne `409 idempotency_conflict`, et l'erreur
ne révèle rien du swap stocké. Les dépôts et retraits de liquidité suivent la même règle, le
type d'opération étant lui aussi comparé. Cette comparaison existe à cause de la clé publique
partagée : chaque wallet anonyme est un seul et même consumer, donc une clé utilisée en premier
par quelqu'un d'autre vous remettait *son* enveloppe non signée — une enveloppe capable de lui
transférer vos fonds. Sans clé, la contrainte unique `(network, txHash)` rejette tout de même
une reconstruction identique octet pour octet avec **409** (collision de séquence / XDR).
Lorsque `STELLAR_SWAP_SINGLE_INFLIGHT=true`, un second swap `PENDING` non expiré pour le
même `(consumer, source, network)` renvoie aussi **409** en indiquant l'identifiant
existant (**désactivé** par défaut — les swaps distincts simultanés depuis un même compte
restent autorisés).

```jsonc
// response → { id, status: "PENDING", network, sendAmount, feeAmount, swapAmount,
//              destEstimated, destMin, path, xdr, uri: "web+stellar:tx?xdr=…", qr, txHash, … }
```

**`POST /v1/swaps/:id/submit`** — relaie l'enveloppe signée (`swaps:write`).

```jsonc
// request
{ "signedXdr": "AAAAAgAAA…(signed base64 XDR)…" }
// response
{ "submitted": true, "status": "SUCCEEDED", "txHash": "…", "swap": { … } }
// on a network rejection → { "submitted": false, "status": "FAILED", "reason": "…", "resultCodes": ["op_under_dest_min"], "swap": { … } }
```

Le hash de la transaction signée est comparé à celui de la transaction construite par le
service avant toute diffusion, de sorte qu'un appelant ne peut jamais faire relayer par le
service une transaction arbitraire. Un swap émet les événements webhook `SWAP_CREATED` /
`SWAP_SUBMITTED` / `SWAP_SUCCEEDED` / `SWAP_FAILED` via le même dispatcher.

## Alias — identifiants de paiement revendicables

Un alias permet à un payeur de saisir `emanuel250` au lieu de `GA5ZSE…`. C'est aussi ce
qu'un payeur lit juste avant d'autoriser un virement ; chaque règle ci-dessous existe donc
parce qu'une erreur ne produit pas une mauvaise ligne en base — elle produit un paiement
vers le mauvais compte, sous un nom auquel le payeur faisait confiance.

### Revendiqué en prouvant le contrôle d'une clé, pas en le demandant

```
wallet ──1. POST /v1/aliases/challenges {name, address, network} ──▶ nonce + the EXACT message to sign
wallet ──2. signs SHA-256(domain ‖ 0x00 ‖ uint32be(length) ‖ message) with that address's key
wallet ──3. POST /v1/aliases {name, email, nonce, signature} ────────▶ alias bound to the calling consumer
```

- **Le service renvoie le message ; le client ne le reconstruit jamais.** Un client qui
  l'assemble d'après la documentation n'est qu'à un changement d'ordre des champs de
  signatures refusées sans que rien, d'un côté comme de l'autre, n'explique pourquoi.
- **La signature porte sur un condensé étiqueté par un domaine, jamais sur une transaction.**
  Rien de ce que ce flux demande à un wallet de signer ne peut être soumis au réseau, et le
  domaine (`Cosmos Pay alias claim v1`) appartient à cette seule fonctionnalité, de sorte
  qu'une dapp qui convainc un utilisateur de signer un message arbitraire ne peut pas en
  tirer une revendication valide.
- **La finalité fait partie des octets signés** (`CLAIM`, `ADD_ADDRESS`, `RECOVER`), de
  sorte qu'une signature recueillie pour ajouter une adresse ne peut pas être rejouée pour
  terminer une récupération.
- **L'adresse provient du challenge, pas du corps de la revendication.** La revendication
  n'a pas de champ d'adresse, donc personne ne peut signer pour une adresse et en
  enregistrer une autre.
- **Les challenges sont à usage unique et durent cinq minutes.** La signature est vérifiée
  *avant* que le challenge ne soit consommé, de sorte qu'une signature bidon ne peut pas
  griller le nonce en cours d'un concurrent, et la consommation est un compare-and-swap, de
  sorte que deux requêtes ne peuvent pas consommer le même challenge.
- **Une concurrence est tranchée par l'index unique sur `alias.name`**, et non par une
  vérification préalable ; le perdant reçoit `409 alias_taken`.

### Ce qu'un identifiant peut être

`a-z` en minuscules, `0-9` et `_` (jamais à l'une ou l'autre extrémité), 3–32 caractères,
ramenés en minuscules avant que l'unicité ne soit évaluée. Pas d'Unicode : l'ensemble des
homoglyphes est illimité, et aucune normalisation ne rend un `а` cyrillique sûr à afficher à
côté d'un montant. Sont également refusés : les mots réservés qui usurperaient l'identité du
produit ou d'un opérateur (`admin`, `support`, `cosmospay`, `stellar`, …) et tout ce qui
ressemble à un compte Stellar (`g` ou `m` suivi d'au moins 20 caractères base32). La règle se
trouve dans `src/aliases/alias-name.ts`.

### Plusieurs adresses, un seul nom

Un alias pointe vers jusqu'à 20 adresses réparties sur plusieurs réseaux — un téléphone, un
ordinateur, un cold wallet, le testnet — avec exactement une adresse principale par réseau,
garantie par un index unique partiel. Ajouter une adresse requiert **deux** preuves :
l'appelant possède l'alias, et la nouvelle adresse signe son propre challenge `ADD_ADDRESS`.
La dernière adresse restante ne peut pas être retirée (libérez plutôt l'alias), et un
consumer peut détenir au plus 25 alias.

Un alias `SUSPENDED` — suspendu par un opérateur — ne se résout vers rien. Une suspension
qui continuerait de fournir un compte ne protégerait en rien l'argent.

### La récupération passe par l'e-mail et par la console de la plateforme

Les clés se perdent, et une clé perdue ne doit pas rendre un nom injoignable pour toujours ;
une revendication enregistre donc une boîte mail de récupération. Cela fait de la
récupération le chemin le plus dangereux du module :

1. La **console de la plateforme** appelle `POST /v1/aliases/:name/recovery {email}`. La
   réponse est identique, que l'identifiant et la boîte mail correspondent ou non ; en cas de
   correspondance, elle porte un jeton à usage unique (30 minutes, stocké uniquement sous
   forme de SHA-256), que la console envoie par e-mail. Ce service n'envoie aucun e-mail.
2. L'utilisateur obtient un challenge `RECOVER` pour la nouvelle clé et appelle
   `POST /v1/aliases/:name/recovery/complete {token, address, network, nonce, signature}`
   avec sa propre clé API. Les deux preuves sont requises : le jeton prouve la boîte mail,
   la signature prouve la clé.
3. La propriété passe au consumer appelant et **toutes les adresses précédentes sont
   supprimées**. La récupération existe parce que les anciennes clés sont perdues, et les
   laisser résolubles permettrait à quiconque les détient de continuer à recevoir les
   paiements.

**Pourquoi l'étape 1 appartient à la console.** Le jeton *est* la preuve du contrôle de la
boîte mail ; il ne peut donc parvenir qu'à la partie qui envoie l'e-mail. La route acceptait
auparavant n'importe quelle clé détenant `payments:write` et renvoyait le jeton à quiconque
le demandait — si bien que toute personne connaissant un identifiant et l'e-mail de son
propriétaire pouvait s'approprier l'alias, ainsi que chaque paiement qui lui était envoyé.
`ConsoleOnlyGuard` refuse désormais tout appelant muni d'une clé API avec
`403 admin_console_only` avant même que l'alias ne soit recherché, et la route est tenue à
l'écart du contrat publié. Cinq jetons erronés invalident une récupération (le propriétaire
en lance simplement une autre ; un attaquant ne peut pas bloquer un nom en échouant), et un
alias suspendu ne peut pas être récupéré.

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
une **instance BlindPay unique pour la plateforme** (`BLINDPAY_API_KEY` +
`BLINDPAY_INSTANCE_ID` dans l'environnement) ; chaque receiver, wallet, compte bancaire,
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
| PATCH  | `/v1/kyc/receivers/:id`                               | `kyc:write`    | Mettre à jour un receiver |
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
définissez `BLINDPAY_WEBHOOK_SECRET` avec le secret de signature de cet endpoint. Laissez les
variables `BLINDPAY_*` vides pour désactiver la fonctionnalité (ces routes renvoient alors
`503`). Voir `.env.example`.

### Les URL de redirection KYC sont soumises à une liste d'autorisation par consumer

Le flux des conditions d'utilisation envoie l'utilisateur vers BlindPay puis le ramène vers
une `redirect_url` fournie par l'intégrateur. Acceptée comme chaîne libre, ce serait une
redirection ouverte portant le nom de la plateforme : un lien qui commence sur une page KYC
de confiance et aboutit là où l'a décidé un attaquant. Chaque `redirect_url` franchit donc
deux couches :

| Couche | Règle | Où |
| ------ | ----- | -- |
| Forme | une URL `https` absolue sans identifiants intégrés (`user:pass@`) | `@IsRedirectUrl()` sur chaque DTO qui en porte une |
| Hôte | présent dans la liste d'autorisation **du consumer appelant** — l'hôte exact, ou un sous-domaine à une frontière de label (`app.acme.com` correspond à `acme.com` ; `evilacme.com` non) | `KYC_REDIRECT_URL_WHITELIST`, appliquée dans la couche service |

```
KYC_REDIRECT_URL_WHITELIST={"cosmos_acme":["acme.com","app.acme.com"]}
```

Elle **échoue en mode fermé** : un consumer sans entrée ne peut utiliser aucune redirection,
et un hôte avec un point final ou sous forme IDN est refusé plutôt que normalisé. La liste est
définie par consumer, car un domaine dont un intégrateur se porte garant ne dit rien d'un
autre. Chaque point d'entrée qui accepte une `redirect_url` la vérifie — le lancement, la
demande et l'approbation des conditions d'utilisation, y compris l'approbation par l'admin,
qui applique la liste du consumer auquel appartient le receiver. Un schéma ou un hôte refusé
donne un `400`.

## Pollar — connexion sociale qui renvoie un wallet Stellar

[Pollar](https://docs.pollar.xyz/docs) transforme une connexion Google/GitHub en compte
Stellar : il authentifie l'utilisateur, crée un wallet, conserve la clé sous sa garde dans
AWS KMS, ajoute les trustlines configurées et finance la réserve — l'utilisateur ne voit
jamais de phrase de récupération. Ce service l'expose sous la forme d'un **pont OAuth**, le
même schéma qu'utilise un lanceur de jeux ou une console lorsque le client termine l'échange
du code localement.

### Pourquoi un pont et pas un simple relais

La connexion hébergée de Pollar est conçue pour un SDK navigateur. Elle envoie l'utilisateur
vers `GET /auth/{provider}` avec une clé publiable, un identifiant de session client et une
`redirect_uri` — et cette URI de redirection doit être un hôte **enregistré auprès de
Pollar**. Un wallet ne peut satisfaire aucune de ces exigences : un listener loopback sur un
port éphémère ou un deep link `cosmospay://` ne peut jamais être un hôte enregistré, et
l'assemblage requiert des clés et des identifiants de session que le wallet ne devrait pas
manipuler.

Le pont prend donc en charge la moitié tournée vers Pollar. Le wallet obtient un contrat en
deux étapes qu'il connaît déjà — **ouvrir une autorisation, échanger un code** — et ne
récupère rien d'autre que ce code.

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

L'étape 6 est la raison d'être de l'ensemble : la réponse de l'échange contient aussi la
`publishable_key` et l'`api_base_url`, de sorte qu'à partir de là le wallet lit les soldes,
construit et soumet des transactions directement auprès du wallet virtuel. **Ce service ne
relaie jamais cette surface et ne détient aucune clé qui le permettrait.**

### Deux façons de récupérer le code

|                  | Flux par redirection                             | Flux par polling                                |
| ---------------- | ------------------------------------------------ | ----------------------------------------------- |
| Le wallet fournit | `redirect_uri` (doit figurer dans la liste d'autorisation) | rien                                  |
| Le code arrive   | sous forme de `?code=…&state=…` sur la redirection | depuis `GET /v1/pollar/oauth/sessions/{state}` |
| Le navigateur voit | votre propre URI                               | une simple page « vous pouvez fermer cette fenêtre » — jamais le code |
| À utiliser quand | le wallet dispose d'un deep link ou d'un listener loopback | il n'a ni l'un ni l'autre (borne, headless, vue intégrée) |

Chaque polling émet un nouveau code et retire le précédent ; échangez donc le code issu de
votre polling le plus récent. Cela découle du fait de ne jamais stocker d'identifiant
utilisable : la ligne conserve un SHA-256 du code, et un hash ne peut pas être inversé.

**Préférez le flux par polling.** Pollar ne renvoie pas le navigateur vers le callback : son
flux hébergé se termine sur sa propre page — `www.pollar.xyz/auth/status` — que le
consentement ait été refusé ou accordé, et un consentement accordé laisse simplement la
session client `READY` côté Pollar. La `redirect_uri` que porte l'URL d'autorisation n'est
jamais visitée, de sorte qu'un handshake qui attend d'être rappelé attend jusqu'à son
expiration.

La route de polling interroge donc Pollar au lieu d'attendre d'être prévenue : tant qu'un
handshake est `pending`, elle vérifie le statut de la session client elle-même, et promeut
le handshake dès que Pollar signale `READY` — la condition même que l'échange attend déjà.
Le contrat du wallet ne change pas ; ce qui a changé, c'est que `pending` se termine
désormais de lui-même.

Il en découle deux notes opérationnelles :

- **La route de callback existe toujours et reste enregistrée auprès de Pollar.** Elle
  fonctionne si une redirection arrive effectivement, et c'est d'elle que dépend un handshake
  du flux par redirection — ce flux n'a nulle part ailleurs où déposer un code. Elle ne peut
  simplement pas être le seul moyen de détecter une connexion.
- **Le fournisseur est interrogé au plus une fois toutes les deux secondes par handshake**
  (`POLLAR_SESSION_PROBE_INTERVAL_MS`), grâce à un compare-and-swap sur `providerCheckedAt`
  partagé par tous les réplicas. Un wallet qui interroge chaque seconde coûte donc à Pollar
  30 requêtes par minute, et non 60, sur une clé dont le budget total est de 200.

Un handshake dont Pollar a désavoué la session client (`INVALID_CLIENT_SESSION_ID`,
`EXPIRED_CLIENT_ID`, ou un `404`/`410`) est immédiatement clos comme `failed` avec ce code,
plutôt que d'être interrogé jusqu'à l'expiration du TTL.

### Une connexion, un wallet sur les deux réseaux

Pollar exploite le mainnet et le testnet comme deux applications distinctes, avec deux paires
de clés distinctes ; une connexion hébergée ne peut donc produire un wallet que sur le réseau
vers lequel sa clé API se résout (`prod` → `public`, `dev` → `testnet` — voir
`resolveNetwork`). Un utilisateur qui passe ensuite d'un environnement à l'autre n'a pas de
wallet de l'autre côté : l'adresse qu'il a financée sur le testnet n'est pas celle qui reçoit
sur le mainnet, et le second wallet finit par être créé au moment où il en a besoin pour la
première fois, c'est-à-dire au moment le moins à même d'absorber une défaillance du
fournisseur.

Un échange enregistre donc aussi l'utilisateur sur l'**autre** réseau, via
`POST /users/with-wallet` de la Server API, et `POST /v1/pollar/oauth/token` rapporte les
deux :

```jsonc
"network_wallets": [
  { "network": "testnet", "status": "ready",   "address": "GA5Z…" },
  { "network": "public",  "status": "pending", "address": null    }
]
```

**Une entrée `pending` n'est pas une erreur.** La connexion a réussi ; le second wallet est la
partie qui n'a pas encore abouti, et tout l'intérêt de la conception est qu'il ne peut pas
entraîner la connexion dans son échec. La tentative sur le chemin de la requête dispose de
cinq secondes et d'un seul essai, et ce qu'elle ne termine pas est réessayé en arrière-plan
par le sweeper de provisionnement — même interrupteur et même cadence que le sweeper de
handshakes (`POLLAR_SWEEP_*`), avec un backoff exponentiel et un budget total de dix
tentatives avant que la ligne ne passe à `failed`.

La raison la plus courante d'un `pending` est prosaïque : **les clés de l'autre réseau ne
sont pas configurées.** Tant qu'elles ne le sont pas, chaque connexion laisse une contrepartie
en attente ; dès qu'elles sont en place, un seul balayage provisionne tout l'arriéré sans que
personne n'ait à se reconnecter. C'est pourquoi il vaut la peine de définir les clés des deux
réseaux, même si vous n'en servez qu'un aujourd'hui.

Deux conséquences à connaître :

- **La clé de jointure est l'e-mail OAuth**, car c'est par lui qu'une connexion hébergée
  ultérieure sur l'autre réseau identifie la même personne. Un fournisseur qui ne garantit
  aucun e-mail n'obtient aucun wallet de contrepartie — mieux vaut cela qu'un wallet orphelin
  qui a coûté des XLM et qu'aucune connexion n'atteint jamais.
- **Cela dépense des XLM sur les deux réseaux.** Une connexion mainnet finance désormais aussi
  une réserve sur le testnet, et inversement. L'état par réseau se trouve dans
  `pollar_user_wallet`, une ligne par (consumer, email, network), ce qui assure aussi
  l'idempotence : une connexion répétée effectue un upsert sur cette table au lieu de
  provisionner à nouveau.

### Ce que le pont stocke

Une ligne de handshake, et rien de ce qu'elle contient ne permet de dépenser de l'argent : le
`state` impossible à deviner, l'identifiant de session client Pollar, un **hash** du code et
l'adresse Stellar publique obtenue. **Aucun jeton Pollar n'est jamais persisté** — l'échange
`/auth/login` s'exécute à l'intérieur de la requête d'échange du code, et les jetons repartent
directement dans sa réponse. Les handshakes que personne n'a terminés sont expirés par un timer
(`POLLAR_SWEEP_*`), car une ligne `AUTHORIZED` reste un code échangeable tant qu'elle n'a pas
été balayée.

Chaque transition est un compare-and-swap sur le statut de la ligne, de sorte qu'un callback
rejoué n'émet pas de second code, et que deux wallets en concurrence pour un même code ne
peuvent pas l'emporter tous les deux.

### Durcissements à connaître

- **PKCE (RFC 7636, S256)** est optionnel mais recommandé : passez `code_challenge` lors de
  l'autorisation et `code_verifier` lors de l'échange, et un code qui fuit depuis un navigateur
  ou un journal devient inutilisable sans le verifier.
- **`dpop_jwk`** lie les jetons émis par Pollar à la propre clé P-256 du wallet (RFC 9449), de
  sorte qu'un jeton d'accès volé est inerte sans preuve signée. Cela signifie aussi que le pont
  ne peut plus agir au nom du wallet — `/refresh` et `/logout` servent les sessions bearer, et
  un wallet lié par DPoP appelle Pollar directement.
- **`POLLAR_REDIRECT_URI_WHITELIST`** est définie par consumer et échoue en mode fermé. Une
  URI de redirection est l'endroit où atterrit un code à usage unique ; une URI non vérifiée
  est donc un canal d'exfiltration. Elle accepte les hôtes loopback (n'importe quel port, selon
  la RFC 8252), les deep links à schéma privé et les hôtes https.
- **Gardez sur un serveur les clés API qui détiennent `pollar:*`.** Le flux par polling remet
  le code à quiconque détient le `state` du handshake *et* une clé munie de `pollar:read`. Un
  attaquant qui extrait une telle clé d'une application distribuée aux utilisateurs peut ouvrir
  une connexion, envoyer son `authorization_url` à une victime, interroger la route pour obtenir
  le code une fois que la victime a donné son consentement sur la vraie page Google/GitHub, puis
  l'échanger avec un verifier PKCE de son choix — PKCE et `dpop_jwk` n'y changent rien, car
  c'est l'attaquant qui fournit les deux. C'est le schéma de phishing par device code, et la
  défense consiste à ce que la clé ne quitte jamais un backend que vous contrôlez.

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
| POST   | `/v1/pollar/users` · `/v1/pollar/users/with-wallet`   | `pollar:write` | Enregistrer un utilisateur, éventuellement avec un wallet |
| POST   | `/v1/pollar/tokens/verify`                            | `pollar:read`  | Valider un jeton qu'un wallet vous a présenté |

Les six dernières nécessitent la clé **secrète** de Pollar, et c'est précisément pour cela
qu'elles se trouvent ici plutôt que dans le wallet. Les schémas de requête et de réponse de
toutes ces routes figurent dans le contrat généré — Swagger UI sur `/docs`, ou
`openapi/openapi.{json,yaml}`. Le tableau ci-dessus sert à s'orienter ; le contrat est la
source de vérité.

### Rate limiting : ce qui empêche le spam de la génération de wallets

Créer un wallet Pollar n'est pas gratuit. Pollar crée le compte Stellar, finance sa réserve de
base (1 XLM) et ajoute une trustline par actif configuré (0.5 XLM chacune) — **depuis votre
wallet de financement**. Une boucle sur le flux de connexion est donc un moyen pour un inconnu
de dépenser votre argent, et elle n'a pas besoin d'un vrai utilisateur à l'autre bout pour
y parvenir.

Les plafonds se trouvent donc ici, dans ce service, et pas seulement dans la passerelle : c'est
ce processus qui sait qu'une requête est sur le point de créer un compte, et c'est lui qui peut
refuser avant que les XLM ne partent.

**Le point de contrôle est `authorize`, pas `token`.** Un handshake produit au plus un wallet ;
borner le nombre de handshakes qu'une adresse peut ouvrir borne donc le nombre de wallets
qu'elle peut faire créer. `token` reste délibérément plus souple, car le chemin 409 indique à
l'appelant de réessayer exactement cette requête pendant que Pollar provisionne le compte — un
budget serré à cet endroit bridait notre propre réessai documenté, et l'échange ne crée rien
que le handshake n'ait déjà autorisé.

| Route | Budget (par 10 min) | Pourquoi ce nombre |
| ----- | ------------------- | ------------------ |
| `POST /v1/pollar/oauth/authorize` | 20 | Le plafond de génération de wallets. Bien au-dessus d'un humain qui réessaie après un écran de consentement en échec, bien en dessous d'un rythme qui vide un compte |
| `POST /v1/pollar/oauth/token` | 60 | Souple à dessein — voir ci-dessus |
| `GET /v1/pollar/oauth/callback` | 60 | La seule route accessible sans clé API, donc la seule qu'un flot anonyme peut atteindre. Un utilisateur qui actualise l'onglet, c'est normal |
| `POST /v1/pollar/users/with-wallet` | 10 | Crée un wallet sans écran de consentement pour en limiter le rythme — le budget le plus serré de l'ensemble |
| `POST /v1/pollar/wallets/activate` | 20 | Dépense des XLM à chaque appel, mais ne peut rien créer de nouveau |

Dépasser l'un d'eux renvoie **`429` avec `code: "rate_limited"`**, un `Retry-After` et le
triplet `RateLimit-Limit` / `-Remaining` / `-Reset`. Tout le reste du service n'est pas limité
ici ; la régulation générale du trafic relève d'APISIX, qui voit la requête avant ce processus.

**Le compteur est dans Postgres, pas en mémoire.** Le service tourne derrière un répartiteur de
charge ; un limiteur par processus accorderait donc à chaque réplica le budget complet : la
limite effective deviendrait `limit × replicas` et changerait silencieusement à chaque mise à
l'échelle du déploiement. C'est acceptable pour une limitation cosmétique, pas pour un mécanisme
qui protège un vrai solde. Il s'agit d'une fenêtre fixe — un `INSERT … ON CONFLICT … RETURNING`
atomique par requête — ce qui signifie qu'un client peut dépenser un budget complet de chaque
côté d'une frontière de fenêtre ; considérez donc les nombres ci-dessus comme « au plus le
double par fenêtre ». Ils ont été fixés en connaissance de cause.

**Comment l'adresse est déterminée, et pourquoi elle ne peut pas être usurpée.** `main.ts`
règle `trust proxy` sur `1`, ce qui fait lire à Express l'entrée *la plus à droite* de
`X-Forwarded-For` — celle qu'APISIX a ajoutée, c'est-à-dire le pair tel que la passerelle l'a
vu. Un client peut ajouter des entrées au début de cet en-tête, mais tout ce qu'il écrit se
retrouve à gauche de l'entrée d'APISIX et est ignoré.

> **N'augmentez pas `trust proxy`.** À `2`, Express commence à prendre en compte le premier
> saut fourni par le client, et chaque limite de cette section devient contournable par l'ajout
> d'un seul en-tête. `src/common/client-ip.spec.ts` fige les deux comportements, afin que ce
> changement ne puisse pas passer la revue inaperçu.

Un appelant IPv6 est regroupé par **/64**, et non par adresse : un client se voit couramment
attribuer un /64 entier et peut en parcourir les adresses gratuitement, donc limiter par
adresse ne limiterait rien. En contrepartie, deux utilisateurs derrière un même /64 partagent
un compartiment, exactement comme deux utilisateurs derrière un même NAT IPv4 le font déjà. Les
compartiments sont aussi indexés par consumer, de sorte que le trafic d'un intégrateur ne peut
pas consommer celui d'un autre.

Si le compteur ne peut pas être écrit, le limiteur **échoue en mode fermé** (`503`). Un
limiteur qui cesse discrètement de limiter pendant un incident de base de données vaut moins que
pas de limiteur du tout, car rien ne vous signale que c'est arrivé — et chaque route qu'il
protège a de toute façon besoin de la même base de données, donc refuser ne coûte aucune
disponibilité qui ne soit déjà perdue.

Définissez `RATE_LIMIT_ENABLED=false` comme interrupteur d'incident.

### Configuration

1. Créez une application sur [dashboard.pollar.xyz](https://dashboard.pollar.xyz) et récupérez
   les deux clés de votre réseau (`pub_testnet_…` / `sec_testnet_…`). Faites-le pour **les
   deux** réseaux : une connexion provisionne un wallet sur chacun, et un réseau sans clés
   laisse le second wallet de chaque utilisateur en `pending` jusqu'à ce qu'elles soient
   définies. Les deux tableaux de bord sont distincts — enregistrez l'hôte du callback dans
   chacun d'eux.
2. Enregistrez l'**hôte de la passerelle** de `POLLAR_BRIDGE_CALLBACK_URL` sous
   **Build → Domains**. Il ne s'agit pas seulement de la redirection : la SDK API vérifie cette
   liste à *chaque* appel, en la comparant à l'en-tête `Origin`, et le pont envoie l'origine de
   cet hôte dans cet en-tête (`POLLAR_SDK_ORIGIN` permet de la remplacer). Un hôte non
   enregistré donne `403 ORIGIN_NOT_ALLOWED` sur `POST /auth/session` — le premier appel de
   chaque connexion, avant même que l'utilisateur ne voie un écran de consentement.
3. Définissez `POLLAR_BRIDGE_CALLBACK_URL` sur `<gateway>/v1/pollar/oauth/callback` — le pont
   ajoute lui-même `/{state}`.
4. Ajoutez l'URI de redirection de chaque wallet à `POLLAR_REDIRECT_URI_WHITELIST`, ou omettez-la
   et utilisez le flux par polling.

Les clés sont propres à chaque réseau, et Pollar encode le réseau et le type de clé dans le
préfixe ; une incohérence entraîne donc un rejet ferme — le validateur d'environnement la
détecte au démarrage plutôt que lors d'une connexion face à un utilisateur. Laissez les clés
vides pour désactiver la fonctionnalité (les routes Pollar renvoient alors `503`). Voir
`.env.example`.

## Mise à niveau — changements incompatibles et notes de déploiement

### Correctifs issus de la revue de sécurité

Une revue de l'ensemble du service a relevé les problèmes ci-dessous. Chacun est corrigé et
verrouillé par un test qui échoue sans le correctif. La plupart ne changent rien pour un
appelant qui se comporte correctement, mais chaque ligne est visible pour quelqu'un — lisez
la colonne « Qui le remarque » avant de déployer.

| Changement | Qui le remarque | Pourquoi |
| ---------- | --------------- | -------- |
| `POST /v1/aliases/:name/recovery` est **réservée à la console de la plateforme** : une clé API reçoit `403 admin_console_only`, et la route a quitté le contrat publié | Quiconque lançait des récupérations avec une clé API | La réponse contient le jeton de récupération, qui est la preuve de la boîte mail du propriétaire. Derrière un simple scope, quiconque connaissait un identifiant et l'e-mail de son propriétaire recevait le jeton et pouvait s'approprier l'alias ainsi que chaque paiement qui lui était envoyé |
| Terminer une récupération sur un alias `SUSPENDED` donne un `404` | Personne de légitime | Un jeton émis avant une suspension permettait d'échapper à la suspension décidée par l'opérateur |
| Les routes `@Public()` (callback Pollar, webhook BlindPay, santé) ignorent `X-Consumer-Username` | Tableaux de bord : ces requêtes sont désormais journalisées comme anonymes | Ces routes s'exécutent sans key-auth, donc l'en-tête était celui du client : un nouveau nom par requête offrait un nouveau budget de rate limit, et nommer une victime insérait des lignes falsifiées dans sa vue des journaux API |
| Les refus d'`AdminGuard` et de `ConsoleOnlyGuard` sont journalisés au niveau `warn` | Opérateurs | Les guards s'exécutent avant le journal d'accès, donc une sonde de `/v1/admin` ne laissait aucune trace nulle part |
| `POST /v1/pollar/wallets/activate` et les trois routes `/v1/pollar/wallets/:address/trustlines…` renvoient `404` pour un wallet que le consumer appelant n'a pas obtenu via ce service sur ce réseau | Les intégrateurs qui agissent sur des wallets qu'ils n'ont vus que via `tokens/verify`, sur des wallets non principaux d'une connexion, ou sur un wallet de contrepartie qu'un autre tenant a déjà enregistré | Tous les tenants partagent un même jeu de clés secrètes Pollar ; sans cette vérification, un tenant pouvait donc retirer les trustlines des utilisateurs d'un autre tenant ou dépenser les XLM de l'opérateur pour leurs réserves. Un wallet étranger et un wallet inconnu reçoivent le même `404`, de sorte que la réponse ne constitue pas un oracle de propriété |
| Les deux routes `POST …/trustlines` partagent un budget `429` de 20 appels par 10 minutes | Les scripts qui ajoutent des trustlines en masse | Chaque trustline immobilise 0.5 XLM de réserve sur le wallet de financement de l'opérateur, et c'étaient les seules routes dépensant des XLM sans plafond |
| `GET /v1/offramp/payouts/:id` ne renvoie plus `raw`, `consumerId`, `receiverId`, `quoteId`, `bankAccountId` ni `updatedAt` ; la réponse de création de compte virtuel ne renvoie plus `raw`, `receiverId`, `consumerId` ni `updatedAt` | Les appelants qui lisent ces champs | `raw` est l'objet BlindPay stocké, avec les données bancaires et celles du bénéficiaire, et il parvenait à toute clé détenant `offramp:read` — ce chemin de lecture ignorait la projection publique qu'utilisent toutes les autres lectures de payout |
| `POST /v1/kyc/upload` renvoie `400` pour plus de 4 champs texte, un champ de plus de 1 KiB, un second fichier, ou des octets de fichier qui ne correspondent pas au type déclaré | Personne qui envoie un upload bien formé | Les valeurs par défaut de Multer laissaient le nombre de champs illimité, avec 1 MB chacun en mémoire, et la vérification du type se fiait au `Content-Type` du client |
| `POST /v1/payment-intents/tx` et `/pay` : le même mémo avec n'importe quelle condition différente donne `409 idempotency_conflict`. Une nouvelle tentative identique renvoie toujours l'intention stockée (`2` et `2.0` sont le même montant) | Les appelants qui réutilisent un même mémo pour des paiements différents | Sous la clé publique partagée, chaque wallet anonyme est un seul et même consumer, donc un mémo créé en premier par quelqu'un d'autre renvoyait *son* intention — avec un QR qui le payait, lui |
| `POST /v1/payment-intents/:id/validate` ne marque `FAILED` que pour une tx échouée qui est le propre paiement de cette intention ; toute autre tx échouée donne `valid: false` avec le statut inchangé. Une tx clôturée plus de 60 s avant la création de l'intention est refusée ("Transaction predates this payment intent") — lors de validate, lors d'un `PATCH {status: SUCCEEDED}` et dans l'observateur | Personne de légitime | Le hash de n'importe quelle transaction échouée du réseau faisait échouer une intention définitivement, et un ancien paiement aux mêmes conditions pouvait régler une nouvelle intention |
| `PATCH /v1/payment-intents/:id` qui modifie `txHash` sur une intention dans un état terminal donne `400 invalid_state_transition` ; un changement de statut en concurrence avec l'écriture donne `409 operation_in_flight` | Personne de légitime | Cela réécrivait la preuve de règlement d'une intention `SUCCEEDED` |
| L'observateur des intentions de paiement réconcilie au plus 10 intentions par consumer par cycle et ne parcourt jamais les lignes expirées | Les opérateurs qui surveillent le débit de l'observateur | Un afflux d'intentions à montant ouvert provenant d'un seul consumer bloquait le règlement de tous les autres tenants et consommait le budget Horizon partagé |
| `POST /v1/swaps`, `/v1/liquidity-pools/deposit` et `/withdraw` : une `Idempotency-Key` réutilisée avec une requête différente — un autre mémo ou un autre slippage, l'autre réseau, ou une clé de dépôt réutilisée pour un retrait — donne `409 idempotency_conflict`. Un rejeu portant un actif, un slippage ou un mémo invalide reçoit désormais le `400` habituel | Les clients qui réutilisent une même clé pour des opérations différentes | Sous la clé publique partagée, un attaquant pouvait pré-créer, sous une clé devinable, un swap ou un retrait depuis le compte d'une victime vers son propre compte, et la nouvelle tentative de la victime lui renvoyait cette enveloppe à signer |
| `POST /v1/liquidity-pools/withdraw` ne répond plus `409 operation_in_flight` pour un retrait en cours dont le compte n'a pas encore utilisé le numéro de séquence (une enveloppe non signée ou abandonnée) | Les utilisateurs de wallet qui étaient bloqués | Un retrait de montant infime construit pour le compte de quelqu'un d'autre et renvoyé toutes les 300 s empêchait tous les utilisateurs de la clé publique de retirer cette position. Les deux enveloppes partagent un numéro de séquence, donc une seule au plus peut jamais être réglée |
| L'observateur de règlement prend au plus 10 lignes par consumer, par table et par cycle, et `GET /v1/liquidity-pools/positions` lit Horizon via une seule liste paginée au lieu d'une requête par pool | Opérateurs | Un afflux provenant d'un seul consumer bloquait le règlement de tous les autres, et un compte détenant des parts de nombreux pools déclenchait un nombre non borné d'appels Horizon |

Notes de déploiement associées :

- **La migration `20260910120000_aliases`** crée `alias`, `alias_address`,
  `alias_challenge` et `alias_recovery`. Exécutez `migrate deploy` avant que le nouveau
  build ne serve du trafic.
- **Un nouvel identifiant de verrou consultatif, `881_008` (`AliasChallengeSweeper`).** Rien
  à configurer ; il est mentionné pour que ce numéro ne soit jamais réutilisé.
- **Définissez `NODE_ENV=production` en production.** `.env.example` est livré avec
  `development`, et deux protections en dépendent : une requête sans
  `X-Plan-Swap-Fee-Bps` donne un `503` uniquement en production (partout ailleurs, les swaps
  se rabattent silencieusement sur `STELLAR_SWAP_FEE_BPS`), et `/docs` — hors de tout guard
  — n'est désactivé par défaut qu'en production.

### NestJS 12, TypeScript 6 et Node 24.9 au minimum

Toute la gamme NestJS est passée en version 12 et TypeScript en version 6. **Cela relève la
version minimale de Node à 24.9** (`engines`, et les deux workflows fixent désormais
`node-version: 24`) ; aucune version antérieure ne peut exécuter la suite de tests. Les cibles
de déploiement doivent suivre.

La raison est le lanceur de tests, pas le framework. NestJS 12 est publié en ESM pur
(`"type": "module"`), et Jest exécuté sous CommonJS ne peut pas le charger avec `require()` —
chacune des 62 suites échouait au chargement. Jest prend en charge `require(esm)` nativement,
mais uniquement sur Node >= 24.9 **et** avec `--experimental-vm-modules`, car la capacité dont
il vérifie la présence (`vm.SourceTextModule.prototype.hasAsyncGraph`) n'existe pas sans ce
flag. Les scripts de test invoquent donc désormais Jest directement via Node :

```
"test": "node --experimental-vm-modules node_modules/jest/bin/jest.js"
```

Pas de préfixe `NODE_OPTIONS=` : il n'est pas portable vers les shells Windows, et la CI, le
job de release et la machine d'un développeur doivent exécuter la même commande.

Deux conséquences à connaître :

- **`transformIgnorePatterns` a disparu des deux configurations Jest.** Il listait les
  paquets ESM (`@stellar`, `@noble`, `@exodus`, `uint8array-extras`) que ts-jest devait
  transpiler en CommonJS — un contournement de l'impossibilité de charger de l'ESM. Maintenant
  que Jest charge l'ESM nativement, ce contournement casse activement les choses : un paquet
  compilé en CJS est évalué comme ESM et plante sur `exports is not defined`. Si une dépendance
  a de nouveau besoin d'être transformée un jour, c'est ce fichier qu'il faut examiner.
- **`tsconfig.json` a gagné `types` et `rootDir`.** TypeScript 6 n'inclut plus
  automatiquement tous les paquets `@types`, donc les deux paquets ambiants (`node`, `jest`)
  sont nommés explicitement — sans cela, chaque spec perdait `describe`/`it` tout en
  continuant de passer au vert sous ts-jest. Et TS 6 refuse d'inférer `rootDir` lorsqu'une
  compilation couvre un seul répertoire (TS5011), ce que font les scripts ts-node ; `"./"`
  est ce que le build complet inférait déjà, donc la structure émise est inchangée.

Modifications de code imposées par ces versions majeures, toutes mineures :

- `EventEmitter2` est importé depuis `eventemitter2`, et non depuis `@nestjs/event-emitter`.
  C'est le même objet de classe à l'exécution — le token DI est inchangé — mais la
  réexportation de Nest est typée pour la forme CJS du paquet et se résout en `any` avec la
  résolution de modules `node10` de ce dépôt, ce qui transformait silencieusement chaque
  `.emit()` en appel non vérifié. `eventemitter2` est désormais une dépendance directe pour
  cette raison.
- `OperationObject` provient de `@nestjs/swagger` plutôt que de
  `@nestjs/swagger/dist/interfaces/open-api-spec.interface`. Swagger 12 publie une map
  `exports` qui n'expose que `.` et `./plugin`, donc les chemins profonds ne se résolvent plus.
- `AccountLoaderService.load` porte un type de retour explicite
  `Promise<Horizon.AccountResponse>` ; TS 6 n'infère pas un type qu'il ne peut pas nommer de
  manière portable.
- Deux mocks de test (`fetch`, `Reflector.getAllAndOverride`) correspondent désormais aux
  vraies signatures, au lieu de versions plus étroites écrites à la main.

L'OpenAPI publiée s'est enrichie : `@nestjs/terminus@12` émet des schémas de santé plus riches
(enums de statut et une propriété `responseTime`). Purement additif — aucune route métier ni
aucun schéma n'a changé.

### Une clé API publique partagée, et le guard qui la restreint

Nouveau dans cette version : `PublicKeyGuard` (global, après `PermissionsGuard`) et le
décorateur `@AllowPublicKey()`. Rien ne change pour les clés existantes — le guard ne se
prononce pas sur un consumer qui n'est pas le consumer public partagé — mais deux choses
doivent être faites au moment du déploiement :

- **Définissez `APISIX_PUBLIC_CONSUMER`** avec le nom d'utilisateur que la plateforme
  développeur provisionne pour la clé publique, sur chaque déploiement qui en publie une. Sans
  cela, le guard se rabat sur le seul `X-Consumer-Role` transmis.
- **La clé publique doit être émise avec `role: public`** et uniquement les scopes dont les
  routes de la liste d'autorisation ont besoin. Lui accorder `kyc:*` ou `webhooks:*`
  n'ouvrirait pas ces routes — le guard les refuse quoi qu'il arrive — mais ce serait un
  identifiant plus large que sa fonction, détenu par tout le monde.

Voir « La clé API publique partagée » ci-dessus pour ce qu'elle peut atteindre et pourquoi.

### Le registre d'actifs : `GET /v1/assets`

Une table sélectionnée des paires (code, issuer) dont cette plateforme se porte garante, par
réseau, avec le nom de l'organisation émettrice. Elle ne requiert aucun scope — le catalogue
ne contient aucune donnée de tenant, et le restreindre signifierait seulement que chaque clé
émise avant l'existence du scope afficherait un sélecteur de jetons vide — mais elle requiert
un consumer authentifié, clé publique partagée comprise.

`npm run assets:verify` revérifie chaque ligne auprès d'Horizon en direct : que la paire existe
sur le réseau sous lequel elle est classée, que `contract` correspond au `contract_id`
d'Horizon, et que les flags de l'émetteur correspondent à ceux de la chaîne. Exécutez-le
lorsque vous modifiez le registre. Ce n'est pas un test unitaire, car il a besoin de l'internet
public, et un test qui échoue quand Horizon est lent est un test que l'on apprend à ignorer.

### Activité client : un nouveau module, une nouvelle table et deux nouveaux scopes

`POST /v1/activity/events` accepte la télémétrie du wallet et du tableau de bord développeur ;
`GET /v1/activity/events` et `GET /v1/activity/summary` permettent de la relire. Aucun format
existant n'a changé, mais trois choses doivent être faites au moment du déploiement :

- **La migration `20260906140000_activity_event`** crée `activity_event` (en ajout seul,
  rattachée à `consumerId`, unique sur `(consumerId, eventId)`).
- **Les scopes `activity:write` et `activity:read` sont nouveaux.** Une clé qui ne les possède
  pas reçoit `insufficient_scope`, ce qui est la bonne réponse — mais cela signifie qu'une clé
  existante n'acquiert pas la capacité de rapporter de la télémétrie du seul fait de la mise à
  niveau. La plateforme développeur accorde les deux aux clés provisionnées pour le wallet et
  réapplique l'ensemble lors d'une rotation ; les clés émises à la main doivent les recevoir.
- **`ACTIVITY_RETENTION_DAYS`** (30 par défaut) rejoint la tâche de rétention. Il s'agit de
  données personnelles au même titre que le journal d'accès ; ne la définissez à `0` que
  délibérément.

### La route de polling Pollar détecte désormais elle-même une connexion terminée

`GET /v1/pollar/oauth/sessions/{state}` rapportait auparavant ce que le callback du pont avait
enregistré. Pollar n'appelle jamais ce callback — son flux hébergé se termine sur
`www.pollar.xyz/auth/status` et laisse la session client `READY` — si bien qu'un handshake du
flux par polling restait `pending` jusqu'à son expiration, alors que le wallet faisait tout
correctement. Le polling interroge désormais Pollar directement et promeut le handshake dès
`READY`.

Aucun format d'API n'a changé et aucune modification côté client n'est nécessaire : une
connexion qui restait bloquée sur `pending` atteint désormais `authorized` dès le polling qui
suit la fin de la procédure par l'utilisateur. Deux points à garder à l'esprit lors du
déploiement :

- **La migration `20260906120000_pollar_oauth_provider_probe`** ajoute une colonne nullable
  `providerCheckedAt` à `pollar_oauth_session`. C'est le plancher partagé qui limite la
  fréquence à laquelle la question parvient à Pollar ; aucune donnée n'est rétro-remplie.
- **Le trafic de polling atteint désormais Pollar.** Prévoyez une requête au fournisseur par
  connexion en cours toutes les deux secondes, sur la clé publiable du réseau concerné.

### Les connexions Pollar provisionnent désormais un wallet sur les deux réseaux

`POST /v1/pollar/oauth/token` a gagné un tableau `network_wallets` — une entrée par réseau
Stellar, chacune `ready`, `pending` ou `failed`. C'est additif, donc rien ne casse, mais voici
deux notes opérationnelles :

- **Exécutez la migration.** `20260905120000_pollar_user_wallet` ajoute `pollar_user_wallet`
  et l'enum `PollarWalletStatus`. Sans elle, chaque échange de code journalise un
  provisionnement en échec et le wallet de contrepartie n'est pas enregistré — la connexion
  elle-même continue de fonctionner.
- **Définissez les clés des deux réseaux.** `POLLAR_*_MAINNET` et `POLLAR_*_TESTNET` sont
  chacune optionnelles prises isolément, et un réseau sans clés apparaît désormais comme un
  wallet `pending` à chaque connexion plutôt que de ne pas apparaître du tout. Configurez la
  seconde paire et le sweeper résorbe l'arriéré à son prochain cycle ; laissez-la
  délibérément non définie et les lignes restent `pending` jusqu'à ce que le budget de dix
  tentatives les retire. Dans les deux cas, aucune connexion n'échoue.

Prévoyez les XLM : une connexion finance désormais une réserve sur *les deux* réseaux ; la
dépense mainnet par nouvel utilisateur est donc inchangée, mais une dépense testnet apparaît là
où il n'y en avait pas.

### `429` renvoie désormais `rate_limited`

Un `429` nu se rabattait auparavant sur `code: "provider_unavailable"`, ce qui laissait
entendre qu'un service en amont avait des problèmes, alors qu'en réalité ce service avait
lui-même refusé la requête — envoyant les intégrateurs enquêter sur quelque chose de
parfaitement sain. Il renvoie désormais `code: "rate_limited"`, et `ApiErrorCode.RateLimited`
fait partie de l'enum publiée. Basez-vous sur ce code si vous réessayez en cas de limitation.


### Formats de réponse modifiés

Trois formats publiés ont changé dans la version audit-hardening. Tous trois se trouvent sous
`/v1` ; il n'y a pas de `/v2`, donc les intégrateurs doivent être prévenus avant que vous ne
déployiez.

| Endpoint | Avant | Maintenant | Pourquoi |
| -------- | ----- | ---------- | -------- |
| `GET /v1/webhooks` | tableau nu, silencieusement tronqué à 100 éléments | `{ data, total, take, skip }` | Un consumer avec 120 endpoints en recevait 100 sans que rien ne le signale, et sans `total` pour paginer |
| `GET /v1/products` | tableau nu, table entière | `{ data, total, take, skip }` | Lecture non bornée |
| `GET /v1/webhooks/:id/deliveries` et la réponse de relivraison | incluaient `payload` | `payload` supprimé | Un corps `RECEIVER_UPDATED` est un dossier KYC complet, et ces routes sont protégées par `webhooks:read`, pas par `kyc:read` |

Un appelant qui fait `for (const x of res)` ou lit `delivery.payload` cassera au déploiement.
La migration est mécanique : lisez `res.data`, et récupérez les détails KYC via les endpoints
KYC avec une clé qui détient `kyc:read`.

Les **corps de webhook** `RECEIVER_UPDATED` / `PAYIN_*` / `PAYOUT_*` ont eux aussi été réduits
à l'identité et à l'état — voir la section Webhooks.

### La migration audit-hardening

Elle est livrée sous la forme de deux fichiers qui doivent être appliqués dans l'ordre :

- `20260901120000_audit_hardening` — le travail de correction : une nouvelle colonne, un
  `DELETE` de dédoublonnage sur `liquidity_pool_operation`, deux index `UNIQUE`, deux
  nouvelles tables. Le DELETE et l'index unique qu'il prépare s'exécutent dans une transaction
  explicite sous un verrou `SHARE ROW EXCLUSIVE`, de sorte qu'un déploiement progressif ne peut
  pas glisser un doublon entre les deux. Les écritures sur cette seule table sont bloquées
  pendant les quelques millisecondes que cela dure.
- `20260901120100_audit_hardening_indexes` — neuf index additifs, construits
  `CONCURRENTLY`, de sorte que le déploiement ne bloque **pas** les écritures sur
  `payment_intent`, `swap`, `webhook_delivery` ou `request_log`. Aucune fenêtre de maintenance
  n'est nécessaire.

Cette séparation n'est pas une question de style : PostgreSQL refuse `CREATE INDEX
CONCURRENTLY` à l'intérieur d'un bloc de transaction, et le premier fichier en a besoin d'un.
Les deux sont vérifiés en CI sur un vrai PostgreSQL, qui s'assure aussi qu'aucun index n'est
resté `INVALID` et que les migrations correspondent toujours à `schema.prisma`.

Si le second fichier échoue en cours de route, une construction `CONCURRENTLY` laisse un index
**invalide** au lieu d'échouer proprement, et `IF NOT EXISTS` le considère comme présent.
Supprimez-le, puis relancez :

```sql
SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE NOT i.indisvalid;
```

### `ADMIN_API_CREDENTIALS` disparaît — `/v1/admin` appartient à la console de la plateforme

**Supprimez la variable.** Elle n'est plus lue, et les `COSMOS_ADMIN_API_SECRET` /
`COSMOS_ADMIN_API_SECRET_READ` correspondants de la plateforme développeur disparaissent avec
elle.

C'était un second identifiant qui décidait, dans ce service, qui est administrateur de la
plateforme — alors que la plateforme développeur l'avait déjà décidé d'après le rôle du compte
connecté. Deux réponses à une même question, et chaque déploiement qui avait configuré la
passerelle mais omis ce secret subissait la divergence sous sa forme la plus déroutante : un
owner pouvait changer le plan et le rôle d'un autre compte dans la console, qui ne demande
jamais ce secret, et pourtant chaque lecture inter-tenants répondait `401
admin_credentials_required`. Rien dans cette erreur n'oriente vers un secret de déploiement
manquant plutôt que vers les droits du compte lui-même.

La question que pose le guard est donc passée de « l'appelant détient-il le secret
d'administration ? » à « cet appel provient-il de la console de la plateforme ? », ce que
tranchent deux faits déjà présents dans la requête :

1. `X-Gateway-Secret` correspond à `APISIX_GATEWAY_SECRET` — vérifié par `ApisixGuard`
   comme sur toutes les autres routes. Seuls la passerelle et le backend de la console le
   détiennent.
2. `X-Cosmos-Internal` est présent. APISIX le supprime de chaque requête qu'il relaie
   (`proxy-rewrite.headers.remove`), de sorte qu'un appelant muni d'une clé API ne peut pas le
   porter ; seul un appel direct depuis un backend détenant le secret de la passerelle le peut.

Nommons clairement le compromis : le fait 2 repose sur une configuration de routage de la
passerelle qui se trouve dans le dépôt de la plateforme développeur, et non sur un secret que
détient ce service. Deux gains le justifient. La console est désormais le seul endroit qui
répond à la question « qui est administrateur de la plateforme », de sorte que les deux
réponses ne peuvent plus diverger ; et l'attribution est devenue plus précise, et non moins
précise — une ligne d'audit nommait auparavant un identifiant partagé (`owner`, `viewer`), et
nomme désormais le compte de la console qui a agi (`cosmos_<userId>`) ainsi que le rôle de
plateforme qu'il a déclaré, pour chaque mutation **et** chaque lecture.

Ce que cela change pour un appelant :

| Avant | Maintenant |
| ----- | ---------- |
| `401` `admin_credentials_required` sans secret Bearer | `403` `admin_console_only` pour tout ce qui n'est pas un appel de la console |
| `403` `admin_role_required` pour un identifiant `read` sur une mutation | supprimé — la console a déjà décidé que le compte peut agir |
| `actorId` / `actorRole` sur une ligne d'audit nommaient l'identifiant | ils nomment le compte de la console et son rôle de plateforme |

Si vous appelez `/v1/admin` directement (depuis un script d'exploitation, par exemple),
envoyez `X-Gateway-Secret`, `X-Consumer-Username` et `X-Cosmos-Internal: 1` ; ajoutez
`X-Cosmos-Admin-Role: owner` pour que la ligne d'audit soit étiquetée. Gardez le service hors
de l'internet public — le secret d'administration ayant disparu, ce sont l'isolation réseau et
le secret de la passerelle qui protègent les données inter-tenants.

### `APISIX_GATEWAY_SECRET` exige désormais 32 caractères

Le service refuse de démarrer en dessous. Il acceptait auparavant un seul caractère, et c'est
désormais le *seul* secret qui sépare le monde extérieur de la surface d'administration de la
plateforme (voir ci-dessus) ; il a donc plus de poids qu'auparavant. Générez-en un avec
`openssl rand -hex 32` et effectuez la rotation dans APISIX au même moment.

### Fonctionnalités de `v0.1.0`–`v0.1.5` remplacées par cette version

`main` et cette branche ont résolu plusieurs des mêmes problèmes indépendamment pendant
qu'elles étaient séparées. Là où les deux avaient une réponse, c'est la conception de cette
branche qui est livrée ; un déploiement venant de `v0.1.5` perd donc ce qui suit. Rien de cela
n'est accidentel — chaque point est une résolution délibérée — mais chaque élément est visible
par un intégrateur, planifiez donc la mise à niveau en conséquence.

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
`horizon_account_cursor`, `RETRYING`, `SWAP_EXPIRED`, `LIQUIDITY_EXPIRED`) sont tous encore
déclarés dans `schema.prisma` et toujours présents après `migrate deploy`. Ils ne sont
simplement jamais écrits. Supprimer des colonnes en service — et une valeur d'enum, que
PostgreSQL ne peut pas retirer sans recréer le type — serait une migration destructrice qui
n'apporterait rien, et c'est parce qu'ils restent déclarés que `prisma migrate diff` reste
propre.

## Variables d'environnement

Chaque variable lue depuis `process.env` dans `src/` est validée au démarrage par
`src/config/env.validation.ts` (fail-fast). Copiez `.env.example` et ajustez au moins
`DATABASE_URL` et `APISIX_GATEWAY_SECRET`.

| Variable | Requise | Défaut | Effet |
| -------- | ------- | ------ | ----- |
| `NODE_ENV` | non | `development` | Doit valoir `development`, `test` ou `production`. **Définissez `production` en production** — la vérification fail-closed des frais de plan et la désactivation par défaut de la documentation en dépendent toutes deux |
| `PORT` | non | `3000` | Port d'écoute HTTP |
| `DATABASE_URL` | **oui** | — | Connexion PostgreSQL pour Prisma |
| `APISIX_GATEWAY_SECRET` | **oui** | — | Secret partagé prouvant que la requête est passée par APISIX. **32 caractères minimum** — c'est toute la frontière entre « arrivé par la passerelle » et « quiconque peut atteindre le pod » |
| `APISIX_GATEWAY_SECRET_HEADER` | non | `x-gateway-secret` | Nom de l'en-tête portant le secret de la passerelle |
| `APISIX_CONSUMER_HEADER` | non | `x-consumer-username` | Nom d'utilisateur du consumer authentifié |
| `APISIX_CREDENTIAL_HEADER` | non | `x-credential-identifier` | Identifiant du credential issu de key-auth |
| `APISIX_ENVIRONMENT_HEADER` | non | `x-consumer-env` | Environnement de la clé (`dev` / `prod`) |
| `APISIX_ROLE_HEADER` | non | `x-consumer-role` | Rôle du consumer transmis par la passerelle |
| `APISIX_PERMISSIONS_HEADER` | non | `x-consumer-permissions` | Liste des permissions transmise par la passerelle |
| `APISIX_ORGANIZATION_HEADER` | non | `x-consumer-org` | Identifiant de l'organisation |
| `APISIX_PLAN_HEADER` | non | `x-consumer-plan` | Plan de l'organisation |
| `APISIX_SWAP_FEE_BPS_HEADER` | non | `x-plan-swap-fee-bps` | Frais de swap du plan (bps) |
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
| `BLINDPAY_API_KEY` | non | — | Clé API de plateforme BlindPay |
| `BLINDPAY_INSTANCE_ID` | si la clé API est définie | — | Identifiant d'instance BlindPay (`in_...`) |
| `BLINDPAY_BASE_URL` | non | `https://api.blindpay.com/v1` | URL de base de l'API BlindPay |
| `BLINDPAY_WEBHOOK_SECRET` | si la clé API est définie | — | Secret Svix des webhooks BlindPay entrants |
| `BLINDPAY_TIMEOUT_MS` | non | `15000` | Timeout du client HTTP BlindPay (ms) |
| `KYC_REDIRECT_URL_WHITELIST` | non | — | Liste d'autorisation, par consumer, des hôtes de redirection KYC |
| `RATE_LIMIT_ENABLED` | non | `true` | Plafonds par adresse sur les routes qui dépensent des XLM. Interrupteur d'incident |
| `RATE_LIMIT_PRUNE_INTERVAL_MS` | non | `600000` | Intervalle de purge des fenêtres de compteur (ms, min 1000) |
| `POLLAR_PUBLISHABLE_KEY_TESTNET` / `_MAINNET` | non | — | Clé publiable Pollar (`pub_<network>_…`), pour le pont OAuth |
| `POLLAR_SECRET_KEY_TESTNET` / `_MAINNET` | avec la clé publiable | — | Clé secrète Pollar (`sec_<network>_…`), pour les routes opérateur |
| `POLLAR_BRIDGE_CALLBACK_URL` | si une clé Pollar est définie | — | URL publique vers laquelle Pollar renvoie le navigateur. Doit être `<gateway>/v1/pollar/oauth/callback` **et** un hôte enregistré sous Build → Domains chez Pollar |
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

`key-auth` transmet `X-Consumer-Username` / `X-Credential-Identifier` à l'upstream après une
authentification réussie, en écrasant toute copie fournie par le client, et le guard s'appuie
sur ce comportement.

> **La liste de suppression est un élément porteur, et c'est la seule partie de ce modèle de
> sécurité qui ne peut pas être vérifiée depuis l'intérieur de ce dépôt.** Chaque en-tête du
> bloc ci-dessus est une entrée d'autorisation que le service accepte telle quelle ;
> `X-Gateway-Secret` prouve seulement que la requête est passée par *une* passerelle, pas que
> les valeurs sont honnêtes. Traitez cette liste comme une configuration de production soumise
> au même niveau d'exigence en revue que le code : auditez-la chaque fois qu'une route est
> ajoutée ou copiée, et gardez le service sur un réseau privé afin que le seul chemin
> accessible passe par APISIX. Le secret partagé est la seconde couche, pas la seule.
>
> Le service échoue désormais en mode fermé sur la seule entrée où le silence était autrefois
> profitable : un `X-Plan-Swap-Fee-Bps` absent dans une configuration de production donne un
> 503 plutôt qu'un repli silencieux sur la valeur par défaut de l'environnement.
>
> `X-Cosmos-Internal` a plus de poids qu'auparavant : depuis la suppression de
> `ADMIN_API_CREDENTIALS`, c'est lui qui indique à ce service qu'une requête provient de la
> console de la plateforme plutôt que d'une clé API, et donc lui qui ouvre `/v1/admin`. Il
> n'est toujours accessible qu'à un appelant ayant déjà présenté le secret de la passerelle, de
> sorte que l'exposition est bornée par ce secret et par l'isolation réseau — mais une route
> qui oublie de le supprimer transforme chaque clé API en administrateur de la plateforme.

> Gardez le service sur un réseau privé afin que le seul chemin accessible passe par APISIX ;
> le secret partagé est la seconde couche, pas la seule.

## Garder ce document fidèle

**Le README fait partie du changement, ce n'est pas une tâche ultérieure.** Rien dans la CI ne
détecte sa dérive — le build reste vert pendant que ces pages décrivent discrètement un service
qui n'existe plus — il est donc mis à jour dans le même commit que le code qu'il décrit. La
convention complète, y compris la section que touche chaque type de changement, se trouve dans
[`CLAUDE.md`](./CLAUDE.md) ; en version courte :

| Quand vous… | Mettez à jour |
| ----------- | ------------- |
| ajoutez ou retirez un module sous `src/` | [Structure du projet](#structure-du-projet) |
| ajoutez, renommez ou supprimez une lecture de `process.env` | [Variables d'environnement](#variables-denvironnement) **et** `.env.example` |
| intégrez un fournisseur, ou modifiez le comportement de l'un d'eux | la section `##` propre à ce fournisseur |
| modifiez un format de réponse publié, un code de statut ou un scope | [Mise à niveau](#mise-à-niveau--changements-incompatibles-et-notes-de-déploiement) |
| ajoutez, renommez, supprimez ou changez le scope d'une route | [Index des routes](#index-des-routes), et la section propre au module |
| apprenez quelque chose qu'un opérateur ou un intégrateur ne doit pas manquer | la section à laquelle cela appartient |

**Ce document existe en sept langues** — English, Español, Português, Deutsch, Français,
हिन्दी et 简体中文 — et un changement dans l'une est un changement dans les sept, dans le même
commit. L'anglais est la source et les autres en sont des traductions : les mêmes titres,
tableaux et blocs de code, avec les identifiants (routes, variables d'environnement, en-têtes,
codes d'erreur) laissés exactement tels quels. `npm run readme:check` fait échouer la CI
lorsqu'un fichier de langue manque, lorsque ses titres ne correspondent plus à ceux de
l'anglais, ou lorsqu'une route du contrat OpenAPI manque dans son index des routes.

Deux choses ne se trouvent délibérément **pas** ici : **les schémas de requête et de réponse**,
qui appartiennent au contrat OpenAPI généré (`npm run openapi:check` le garde fidèle), et
**tout ce que le code énonce déjà** — ce document sert à expliquer *pourquoi* une chose est
ainsi et comment l'exploiter, car une seconde copie de *ce qu'elle* fait n'est qu'une seconde
copie à maintenir exacte.
