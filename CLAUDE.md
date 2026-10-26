# CLAUDE.md

Conventions for this repo. They are enforced by `npm run lint`, which CI gates on.

## Commands

| Command | What it does, and the trap in it |
| --- | --- |
| `npm run dev` | `prisma migrate deploy`, then `nest start --watch` — one instance on `.env` |
| `npm run dev:local` | several instances from ONE `.env`, overrides in `dev-instances.json` (git-ignored, created from `dev-instances.example.json` on first run — keep it, it holds the recovery servers' keys). Default profile is `api` + `replica`; `-- recovery` runs `api` + `recovery-a` + `recovery-b`, `-- all` all four (`scripts/dev-local.mts`) |
| `npm test` | jest under `node --experimental-vm-modules`. **Never `npx jest`:** without the flag most suites fail to load at `@stellar/stellar-sdk`'s ESM dependencies, which looks like real breakage and is not |
| `npm run test:e2e` | the suites in `test/` (`test/jest-e2e.json`), which `npm test` never sees |
| `npm run lint` | eslint over `src`, `scripts`, `test` and `plugins`, zero warnings |
| `npm run openapi:generate` | regenerates `openapi/openapi.json` + `.yaml`. A new or changed controller means running it and committing the spec — `openapi:check` fails CI on any diff |
| `npm run readme:check` | the seven READMEs exist, share a skeleton, and index every route |
| `npx tsc --noEmit -p tsconfig.json` | the only typecheck that covers the spec files; CI does not run it (see the gate in **Tests ship with the change**) |
| `npm run db:migrate` | `prisma migrate dev`. A schema change ships its migration: CI applies every migration to a real Postgres and runs `prisma migrate diff --exit-code` against `schema.prisma` |
| `npm run backups:reencrypt` | re-seals stored wallet backups under the current `WALLET_BACKUP_ENCRYPTION_KEY` — run it after turning the seal on and after every rotation, then drop the old key from `WALLET_BACKUP_ENCRYPTION_PREVIOUS_KEYS` (`-- --dry-run` only counts) |
| `npm run plugins -- <cmd>` | third-party plugin folders: `new`, `check`, `sign`, `verify`, `keygen`, `publish`, `install` (`scripts/plugins.ts`) |
| `npm run zk:deploy-testnet` | deploys the private payments token, auditor registry and fee account on TESTNET (Friendbot, no real funds). `-- --env-file .env --secrets-file .zk-secrets/testnet.json` writes the values instead of printing secrets; run again it only verifies; `-- --redeploy` strands every payment on the old token |
| `npm run zk:e2e-testnet` | the real-chain check of private payments on testnet: registers, proves, transfers and confirms through the module's own services. Slow (UltraHonk proofs in Node), needs the deployed set in `.env` |

## Imports: always use the path aliases, never relative paths

Every import inside `src/` and `scripts/` uses an alias. `./` and `../` are
banned by the `no-restricted-imports` rule in `eslint.config.mjs`.

| Alias           | Resolves to   | Use for                                   |
| --------------- | ------------- | ----------------------------------------- |
| `@/*`           | `src/*`       | everything in the application             |
| `@generated/*`  | `generated/*` | the Prisma client (`@generated/prisma/client`) |

```ts
// yes
import { PrismaService } from '@/prisma/prisma.service';
import { toStroops } from '@/swaps/swap-math';
import type { Prisma } from '@generated/prisma/client';

// no — lint error
import { PrismaService } from '../prisma/prisma.service';
import { toStroops } from './swap-math';
```

This holds for same-directory imports too: write `@/swaps/swap-math`, not
`./swap-math`. A relative path breaks the moment a file moves and reads
differently from each directory; the alias is stable and greppable.

The one exception is `test/` (the e2e suites). Its helpers live outside `src`,
so no alias can address them — the rule is turned off for that directory.

**The alias is wired in four places.** If you add another, update all of them:

1. `tsconfig.json` → `compilerOptions.paths` (typecheck + editor)
2. `package.json` → `jest.moduleNameMapper` (unit tests)
3. `test/jest-e2e.json` → `moduleNameMapper` (e2e tests)
4. `nest build` → its own tsconfig-paths hook rewrites the aliases in `dist/`

Point 4 matters: plain `tsc` emits `require("@/...")` verbatim and Node cannot
resolve it. The Nest CLI's tsc compiler rewrites every alias to a real relative
path as it emits, so `dist/src/**/*.js` is clean with no extra step — and the
build then runs `scripts/check-dist-aliases.mjs`, which fails it if any
`require` of an alias survives. Keep that check: switching the Nest compiler
(to swc, say) can turn the hook off, and the result builds and dies on boot.

`tsc-alias` used to run after `nest build` and is gone. Diffing its output
against the bare build showed it changed no runtime file: only `.d.ts`,
`dist/scripts/` (never run from `dist`) and a code TEMPLATE string in
`scripts/plugins.ts`, which it corrupted. It also carried the only path to
`braces`, whose advisory has no patched release. Do not bring it back.
The `ts-node` scripts pass `-r tsconfig-paths/register` because they never go
through `nest build`.

**There is no `baseUrl`.** TypeScript 6 deprecates it and 7 removes it, so the
`paths` entries are written as explicit `"./src/*"` / `"./generated/*"` and
resolve relative to `tsconfig.json` itself. All four consumers above were checked
against that: `tsc --noEmit` is clean, `nest build` still rewrites every alias out
of `dist/src` (`check-dist-aliases.mjs` asserts it), and every `ts-node` script in
`package.json` (each passes `-r tsconfig-paths/register`) still resolves. Do not
reintroduce it.

`types` IS set, to `["node", "jest"]`, and that is a different thing: TypeScript 6
stopped auto-including every `@types` package, so the two AMBIENT ones — the ones
that declare globals rather than exporting anything — have to be named. Packages
reached through an import (`express`, `pg`, `qrcode`, `supertest`) resolve on their
own and must not be added.

Do not add `typeRoots` either. It looks like the natural companion to dropping
`baseUrl` and it is the opposite: TypeScript already discovers every
`node_modules/@types` package on its own, and naming one root NARROWS that to the
list you wrote. Adding `["./node_modules/@types"]` here silently dropped the
ambient jest globals, so every spec file failed `tsc --noEmit` while still
running green under ts-jest — a split where the compiler and the runner disagree
about the same file.

## Constants live in a `*.constants.ts` file, not inline in a service

Each module keeps its tunable values — timeouts, batch sizes, limits,
cooldowns, prefixes, policy lists, on-chain memo labels — in one file named
after the module, so they can be found and changed without reading the service:
`src/<module>/<module>.constants.ts` (a sub-module or a `common/` concern gets its
own, e.g. `src/native-plugins/blindpay/kyc/kyc.constants.ts`,
`src/common/rate-limit.constants.ts`). `git ls-files 'src/**/*.constants.ts'` is
the list — there is no hand-kept copy here, because the last one had drifted ten
files behind. The ones a security review reads first are
`src/wallet-auth/wallet-auth.constants.ts` (backup cost floors, slot ceiling),
`src/recovery/recovery.constants.ts` (SEP-10/SEP-30 lifetimes, per-route
budgets) and `src/stellar/stellar.constants.ts` (the precision every amount goes through).

Rules of thumb:

- **A new magic number goes in the module's `*.constants.ts`**, exported and
  named, with the comment explaining *why that value*. Those comments are the
  point of the file — carry them along when you move a constant.
- **Cross-module values are not duplicated.** Stellar's precision
  (`STELLAR_DECIMALS`, `STROOP_SCALE`, `MAX_STROOPS`, `STELLAR_AMOUNT_RE`) lives
  only in `@/stellar/stellar.constants` and is imported by `swap-math`,
  `lp-math` and `common/money`. It used to be three separate copies of one
  protocol rule.
- **Name constants for where they are read, not where they were written.** In a
  shared file, `LOCAL_PREFIX` becomes `LOCAL_RECEIVER_PREFIX`.

What stays put:

- State machines already in their own files (`*-transitions.ts`,
  `receiver-state.ts`).
- Prisma `*_PUBLIC_SELECT` projections — they are the shape of a service's
  query, not a knob, and they belong next to the query.
- Decorator metadata keys — they belong with the decorator that reads them.
- Anything read from the environment. That is `src/config/configuration.ts`;
  `config.constants.ts` holds only the *defaults* applied when a var is unset.

## The README ships with the change, not after it

`README.md` — with its six translations, see the next section — is the only
prose an integrator or a new operator reads. A change that lands without it is a
change nobody outside this repo can use, and the drift is never noticed by the
compiler — the build stays green while the docs quietly describe a service that
no longer exists. So updating the README is part of the change, in the same
commit, not a follow-up.

Six places go stale on their own, and each has a specific trigger:

| When you… | Update |
| --------- | ------ |
| add or remove a file under `src/` that is a module, not a leaf | the **Project layout** tree |
| add, rename, remove or re-scope a route | the **Route index**, and the module's own `##` section if it has one |
| add, rename or delete a `process.env` read | the **Environment variables** table *and* `.env.example` |
| integrate a provider, or change how an existing one behaves | that provider's own `##` section (see the BlindPay one for the shape) |
| change a published response shape, a status code, or a scope | **Upgrading — breaking changes and deploy notes** |
| learn something an operator or integrator must not miss — a security caveat, a deploy step, a limit, a failure mode | the section it belongs to, as a note in the same commit |

**Every route is in the README.** Each route a controller serves has a row in the
**Route index** (method, path, scope, whether the shared public key may call it),
and a module with its own `##` section also lists its routes there with a
one-line purpose. A hand-maintained table once drifted to 22 of ~80 endpoints, so
this one is checked: `npm run readme:check` (run in CI) fails when a route in
`openapi/openapi.json` is missing from the index of any of the seven READMEs.
Routes kept out of the contract (`@ApiExcludeController` /
`@ApiExcludeEndpoint`, e.g. `/v1/admin`) are not checked, but still get a row when
an operator has to know they exist.

Two things that do **not** belong there:

- **Request and response schemas.** Those are the generated OpenAPI contract's
  (`npm run openapi:generate`, gated by `openapi:check`). The README says which
  routes exist and why; the contract says what they accept and return.
- **Anything the code already says.** The README explains *why* a thing is the
  way it is and how to operate it. What it does is the docblock's job, and
  duplicating that just gives you two copies to keep honest.

The same rule covers `.env.example`: a new variable with no entry there is a
variable the next person deploying will not know to set. Give it the comment
explaining what breaks without it, not just its name.

## Seven READMEs, one document

The README is published in seven languages, and they are one document, not seven.
English stays at the root, because that is the file GitHub renders; the six
translations live together in `docs/i18n/`:

| File | Language |
| ---- | -------- |
| `README.md` | English — the source the others are translated from |
| `docs/i18n/README.es.md` | Español |
| `docs/i18n/README.pt.md` | Português |
| `docs/i18n/README.de.md` | Deutsch |
| `docs/i18n/README.fr.md` | Français |
| `docs/i18n/README.hi.md` | हिन्दी (Hindi) |
| `docs/i18n/README.zh.md` | 简体中文 (Simplified Chinese) |

Links inside a translation are relative to `docs/i18n/`: the English file is
`../../README.md`, `CLAUDE.md` is `../../CLAUDE.md`, and a sibling translation is
`./README.pt.md`. A new translation goes in the same folder, in the check's file
list, and in every selector line.

- **A change to one is a change to all seven, in the same commit.** New or
  changed routes, a behaviour change, an environment variable, an upgrade note, a
  security caveat — anything an operator or integrator acts on. A warning that
  exists only in English is a warning most of the people deploying this never
  read, and a translation "to follow" describes last quarter's service.
- **Write the English first, then translate it; never edit a translation alone.**
  If a translation reads wrong because the English was ambiguous, fix the English
  and carry the fix to all seven.
- **The same skeleton in every language:** the same headings in the same order,
  the same tables with the same rows, the same code blocks. Only prose is
  translated. Identifiers never are — routes, env vars, headers, error `code`s,
  scopes, enum values, file paths, JSON keys and command lines stay byte for byte
  identical, so a reader can search for them in any language.
- **Anchors follow the translated heading.** GitHub derives an anchor from the
  heading text, so `#environment-variables` does not exist in the German file.
  Re-check in-page links after translating.
- **Each file opens with the same language selector line**, with that file's own
  language in bold and the other six as links.
- `npm run readme:check` verifies that all seven exist, that they have the same
  number of `##` and `###` headings as `README.md`, and that each route index is
  complete. It cannot read prose — confirming the seven say the same thing is part
  of review.

## SOLID, the way it applies here

NestJS provides the mechanics — providers, constructor injection, modules — and
none of it stops a service from doing four jobs or writing to another module's
table. These are the rules that did not hold on their own:

- **S — one reason to change per class.** A service owns one resource or one
  flow. When a file grows a second job (reading pools from Horizon *and* building
  transactions *and* cost basis), extract the new job into its own provider
  instead of adding a section divider. Length is not the signal —
  `wallet-auth.service.ts` is long and does one thing; a second vocabulary is.
- **O — dispatch with a table, not a chain.** When code branches on a type,
  provider, network or chain, the second branch on the same value is the signal to
  make it a `Record` (see `EVENT_MAP` in `blindpay-sync.service.ts`), so a new
  variant is one entry rather than an edit in every branch.
- **L — subclasses keep the base's contract.** Background timers extend
  `ScheduledJob` and supply only `schedule`, `lockKey` and `run` — no hand-rolled
  `setInterval`, running latch or advisory lock, because the base gets `unref`,
  the `finally` release and error swallowing right once. `SettlementRepository<T>`
  behaves the same for every `T`.
- **I — depend on what you use.** Inject the one service a class needs, not a
  facade over a module. Pure rules (`swap-math`, `alias-name`,
  `payment-intent-transitions`) are plain exported functions a spec can call
  without a Nest container.
- **D — depend on injected collaborators, never construct them.**
  - Never `new` a collaborator, and never default a constructor parameter to one:
    a default turns a missing provider into a silent real network call instead of
    a boot failure. Horizon, BlindPay and outbound HTTP go through their
    injected clients.
  - A service writes only its own module's tables. To change another module's
    row, inject that module's service or emit an event it handles.
  - Feature services never build provider URLs; the provider module exposes a
    named method.
  - Controllers stay thin: no Prisma and no business rules — validate, authorize
    by decorator, call one service method.
  - `process.env` is read only in `src/config/configuration.ts`.
- **Look before writing a helper.** Grep `src/stellar/` and `src/common/` for a
  Stellar, pricing or tenancy helper first: `resolveAsset`,
  `StellarAccountLoader` (including `assertCanAfford`, `assertCanReceive` and
  `assertCanAddTrustline`), `resolveNetwork`,
  `resolvePlanCommissionBps`, `ConsumerResolverService`, `resolveMemoId`,
  `resolveSlippage` / `resolveIdempotencyKey`, the SEP-7 builders in
  `stellar/sep7.ts` and `SignedTransactionRelay` exist because private copies
  drifted apart.
- **A missing trustline goes into the envelope only for the account that signs
  it.** A `changeTrust` must be signed by its own account. When the source of a
  Stellar transaction this service builds receives an issued asset it does not
  trust yet (a self-swap), the build adds `changeTrust` as the first operation and
  prices the extra 0.5 XLM reserve first (`assertCanAddTrustline`: subentries,
  sponsorships and open offers, as the network counts them). Any other account
  that lacks one (a swap's third-party `destination`, a `tx` intent's merchant, a
  cross-chain `recipient`) is refused with `assertCanReceive`, whose message
  says only that account can add it. A response that reports the added
  trustline reads it from the stored XDR (`addedTrustline`), never from a
  column, so a replay answers as the first call did.

## Chains and native plugins

- **Stellar, Solana and Monad are one `Chain` union** (`@/chains/chains.constants`).
  Anything per chain — address rules, transaction-id shapes, payment verifiers,
  message signatures, analytics labels — is a `Record<Chain, …>`, so a new chain
  does not compile until every table has its entry. A request that names no chain
  means Stellar, and must keep behaving byte for byte as it did: the Stellar
  signing challenges have no `chain:` line, alias resolution defaults to Stellar.
  A field that names no chain but takes any (a customer's `account`) reads the
  chain from the shape: `@IsAnyChainAddress()` to validate, `normalizeAnyChainAddress`
  to store (EIP-55 on Monad, the spelling payment intents record a payer in).
- **Solana and Monad are reached only through `SolanaRpcClient` / `EvmRpcClient`**,
  which check the node's genesis hash / `eth_chainId` before trusting it. Never
  call a node URL directly. Stellar mainnet's Soroban RPC is the same rule:
  `SorobanRpcClient` (`src/stellar/soroban-rpc.client.ts`, `STELLAR_RPC_URL_MAINNET`)
  checks the passphrase first (private payments keep their own per-tier RPC in
  `ConfidentialSdk`).
- **Integrations that are not the chain itself are native plugins** under
  `src/native-plugins/<slug>/` (BlindPay, DeFindex), switched on by
  `PLUGINS_ENABLED`. The core never imports one — lint enforces it — and a plugin
  never imports another. When the core needs a plugin's data, add an extension
  point in the core (see `AdminExtensions`) and have the plugin register into it.
  A new native plugin needs its slug in `NATIVE_PLUGIN_SLUGS`, its module in
  `NATIVE_PLUGIN_MODULES` and its own lint entry in `eslint.config.mjs`.
- **Third-party plugins are a different thing:** signed folders under `plugins/`
  (scaffolded, checked, signed and installed with `npm run plugins`), run only in
  a V8 isolate with no Node in it (`src/plugins/plugin-sandbox.ts`). Their own
  lint block lets them import `@/plugins/sdk` and nothing else; the isolate, not
  the lint rule, is the enforcement.
- **Swap venues are the exception, by decision: they are core.** A same-chain
  swap is `/v1/swaps` on the chain's own venue — the Stellar DEX, Jupiter on
  Solana, Kuru Flow on Monad (`src/jupiter/`, `src/kuru/`). The Stellar DEX stays
  in `swaps.service.ts`; every OTHER chain is one `ChainSwapVenue` in
  `src/swaps/venues/`, held as `Record<OtherChain, ChainSwapVenue>` in
  `chain-swaps.service.ts` (`OtherChain = Exclude<Chain, 'stellar'>`), so a new
  chain does not compile until it has a venue. A swap between chains is
  `/v1/cross-chain-swaps` on NEAR Intents (`src/near-intents/`), which refuses
  a same-chain pair on Stellar, Solana and Monad (they have a venue above) and
  allows it on every other network. All of them are always compiled in, not
  plugins. Each aggregator only prices and builds: the wallet signs, and this
  service checks the signed transaction is the one it built before broadcasting
  it through its own RPC. Anything per chain is a `Record<Chain, …>`
  (`NEAR_INTENTS_BLOCKCHAINS`, `DEPOSIT_LINK_BUILDERS`, `CHAIN_SWAP_PROVIDERS`),
  deposit links use this service's own SEP-7 / Solana Pay / EIP-681 builders, and
  third-party HTTP goes through `requestUpstreamJson` (`src/common/upstream-http.ts`).
- **Cross-chain swaps reach more networks than `Chain`.** Every network NEAR
  Intents lists and this service can validate (35: the three chains, 15 EVM
  networks, the UTXO coins, XRP Ledger, Tron, TON, NEAR, Sui, Aptos, Movement,
  Starknet, Cardano, Aleo, Fogo) is one entry of `CROSS_CHAIN_NETWORKS`
  (`src/cross-chain-swaps/cross-chain-networks.ts`), a
  `Record<CrossChainNetworkId, …>` holding its address rule, transaction-id rule
  and deposit-link builder (null where the chain has no wallet-link standard, so
  `depositUri` is nullable). The three settled chains keep their ids and reuse
  `CHAIN_ADDRESS_RULES` and `DEPOSIT_LINK_BUILDERS`; the others use 1Click's
  `blockchain` code. An EIP-681 link names a chain id from
  `CROSS_CHAIN_EVM_CHAIN_IDS` only after it was checked against chainlist and the
  chain's own `eth_chainId`: a wrong id sends the deposit to another chain. A
  1Click blockchain with no entry (`qtc`, `adi`) is never offered: an address this
  service cannot validate is a refund it cannot promise.
- **Monad swaps with a merchant fee go through `contracts/MerchantFeeSwapRouter.sol`**
  (`KURU_MERCHANT_FEE_ROUTER`), one deployment per Kuru Flow router, with no owner. It
  is not a deposit address: wallets approve it and send it value, so the venue checks
  the deployed code against the artifact (`eth_getCode` must equal the runtime a
  creation `eth_call` of `routerInitCode(aggregator())` answers) before handing the
  address out, and refuses a Kuru quote routed through another aggregator. The router
  calls nothing but its immutable `aggregator` and the two tokens, pulls only from
  the caller and leaves no allowance; keep all three when changing it, and a changed
  router is a new deployment the operator points the variable at.
- **Monad deposit addresses are `CREATE2` addresses of
  `contracts/PaymentForwarder.sol`**, or, for an intent with a merchant fee, of
  `contracts/PaymentSplitForwarder.sol` (two more constructor arguments: the
  fee's wallet and amount; the row's `feeWallet` / `merchantFee` say which), so
  every one of them depends on the exact bytecode in its artifact
  (`src/evm/payment-forwarder.artifact.ts`, `payment-split-forwarder.artifact.ts`).
  A changed contract is a NEW contract with an artifact of its own, never a
  recompile of one whose addresses may hold money. Regenerate it only with
  `npm run contracts:compile` (the spec fails if source and artifact disagree),
  and never while a deposit address built from the old bytecode may still hold
  or receive money: the forwarder rebuilds each address from the CURRENT
  artifact, finds it no longer matches the stored one, and refuses to deploy — the
  money stays safe but stuck until the old artifact is restored. The relayer key
  signs only forwarder deployments and
  flushes; it must never gain another use, because "it holds gas money only" is
  the whole security argument.

## Security invariants a change must keep

Each of these was a real finding in this codebase, not a hypothetical:

- **The shared public key is ONE consumer for every anonymous caller.** Anything
  keyed by consumer — a memo, an `Idempotency-Key`, an in-flight guard, a list — is
  shared by all of them. A replay that returns a stored row checks first that the
  request matches it (otherwise `409 idempotency_conflict`), and a new route is
  unreachable with that key until it carries `@AllowPublicKey()`. Anyone can fetch
  that key (`GET /v1/public-key`), so an id is not a secret: the only reads it may
  make of what it wrote are ONE row by its id AND its record token
  (`PublicRecordTokens`, `src/common/public-record-token.ts`): the create answers
  `publicToken` = `base64url(HMAC-SHA256(HKDF(APISIX_GATEWAY_SECRET,
  "public-record-token v1"), "<kind>:<id>"))`, and the row's routes take it in
  `X-Record-Token`. A wrong token is the 404 of a missing row everywhere, checked in
  constant time before the table is read; a missing one is that 404 too on
  `GET /v1/swaps/{id}`, `/v1/cross-chain-swaps/{id}`, `/v1/usdt0/transfers/{id}` and
  the USDT0 submit. The two routes the wallet called with the public key before
  tokens existed (`LEGACY_RECORD_TOKEN_ROUTES`: swap submit, cross-chain deposit)
  still accept a missing token, logged as a deprecation (`noteLegacyAccess`), until
  `PUBLIC_RECORD_TOKEN_REQUIRED_ON_LEGACY=true`; flip it once the wallet sends the
  token, and never add a route to that list. Real keys are untouched. A new
  public-key create whose row can be read back issues a token (`attach`) and its
  by-id routes check it (`admits`), with a new kind in `PUBLIC_RECORD_KINDS`. A list
  never takes the public key.
- **A `@Public()` route has no consumer.** It is served without key-auth, so
  `ApisixGuard` drops whatever `X-Consumer-Username` the client sent. Never read
  `@CurrentConsumer()` there.
- **A secret that proves something never goes back to a caller who could not
  already prove it.** A recovery token proves a mailbox, so this service emails
  it to that mailbox and never puts it in a response — which is what lets any
  caller start an alias recovery, and why its answer is identical either way
  (`@UniformAnswer`).
- **Reads return a `*_PUBLIC_SELECT` projection**, never the full row — the full
  row carries `raw` provider payloads and internal ids.
- **Every tenant query filters by the calling consumer**, and a miss on someone
  else's row is a 404, not a 403: "exists but not yours" is an ownership oracle.
  **Every list also filters by the key's network** (`resolveNetwork`): a production key
  listed test-network payment intents until every `findAll` carried it.
- **A route whose cost an error cannot refund — XLM spent, an account created
  on-chain — carries `@RateLimit`.**
- **A guard that refuses logs the refusal.** Interceptors run after guards, so
  the access log never sees a request a guard turned away.
- **A plan commission with nowhere to be paid is a misconfiguration, not a free
  swap.** `commissionWithRecipient` (`src/common/plan-commission.ts`) answers
  `503 misconfigured` when `NEAR_INTENTS_FEE_RECIPIENT`, `SOLANA_SWAP_FEE_WALLET`
  or `MONAD_SWAP_FEE_WALLET` is missing. `SWAP_COMMISSION_DEV_WAIVER=true` waives
  (and logs) it for a local service only; `env.validation.ts` refuses it when
  `NODE_ENV=production`, and that refusal must stay.

## Wallet sign-in, backups and the recovery servers

**One codebase, three deployments.** The main deployment serves the wallet's
sign-in and backups (`/v1/wallet/*`, `src/wallet-auth/`). `RECOVERY_ROLE=a` or `=b`
makes a deployment a SEP-10/SEP-30 recovery server (`src/recovery/`); with no role,
every recovery route answers 404 (`RecoveryService.rules`), so the main host never
invites a wallet to register where it was not meant to. `src/config/identity-env.ts`
refuses to boot a recovery server holding `WALLET_RECOVERY_SPONSOR_SECRET` or
`APISIX_ADMIN_KEY`, and any deployment where two boundary secrets
(`APISIX_GATEWAY_SECRET`, `WALLET_AUTH_SESSION_SECRET`, `APISIX_ADMIN_KEY`,
`WALLET_BACKUP_ENCRYPTION_KEY`, `RECOVERY_JWT_SECRET`) share a value. Do not relax
either: the two servers' independence IS the design, and a shared value is one leak
that breaks two boundaries.

- **Recovery routes are `@Public()`, budgeted per client address**
  (`recovery.constants.ts`), and answer SEP's `{ "error": "…" }` through
  `SepExceptionFilter` — never an `ApiErrorCode` envelope, which a SEP-30 client
  reads as "the server said nothing".
- **One server, every ledger.** `RECOVERY_NETWORKS` lists them; a request names one
  as a path segment INSIDE the prefix (`/v1/sep10/testnet/auth`,
  `/v1/sep30/testnet/accounts/G…`, `stellar.toml?network=testnet`), stripped by
  `recovery-network.ts`. Never in front of `/v1`: the gateway route and `sepCors`
  cover only `/v1/sep10/*` and `/v1/sep30/*`. An unserved ledger is a 404, never
  the default one.
- **`isBackupBox` decides what is kept** (`wallet-auth-core.ts`): `v: 2`/`v: 3`
  password doors are PBKDF2 within `BACKUP_MIN_ITERATIONS`..`BACKUP_MAX_ITERATIONS`;
  `v: 4` doors are Argon2id within `BACKUP_ARGON2_MIN_*`..`BACKUP_ARGON2_MAX_*`, and a
  v4 box may not carry a PBKDF2 door; at most one recovery slot (v4 only), never the
  only door. Whoever reads the table guesses offline, so the floor is the security.
  Stored boxes are sealed again at rest (`backup-cipher.ts`,
  `WALLET_BACKUP_ENCRYPTION_KEY`; rotate with `npm run backups:reencrypt`).
- **Recovery shares (`/v1/sep30/shares`) recover the SEED; SEP-30 recovers the
  ACCOUNT.** Only a SEP-10 token of that account writes or deletes a half; that, or
  this server's identity token for the filed email, reads it; absent and not-yours
  are the same 404; listing by inbox takes an email identity token and refuses a
  SEP-10 one (`recovery-shares.service.ts`).
- **Each server proves the inbox itself** — an Authentik ID token verified against
  the provider's keys and accepted once per server, or its own emailed code. No
  secret is shared with the sign-in server: the HMAC identity this replaced was one
  leaked value from a recovery identity for every account.
- **Sponsored setup runs only on the main deployment**
  (`POST /v1/wallet/recovery/setup`, `recovery-setup.ts`). On a recovered account
  (`sponsorableDeviceKey` returns a key that is not the account) the last
  `setOptions` omits `masterWeight`: raising the retired master hands the account
  back to the lost device.
- **`finishMessage`, `backupMessage` and `recoverySetupMessage` are a cross-repo
  contract**, pinned as literals in `src/wallet-auth/wallet-auth-core.spec.ts` and
  in the wallet's `tests/unit/signIn.test.ts` / `tests/unit/recovery.test.ts`.
  Change one side and no sign-in or setup can finish.

## Private payments (`zk-payments`): Cosmos Pay's confidential token, and how confirm decides

**Private payments wherever a person reads, ZK only in identifiers.** Merchants and
payers do not know what "ZK" means, so Swagger summaries and descriptions, error
messages and the seven READMEs say "private payment" ("pago privado", ...). `zk`/`ZK`
stays in what code and operators read: the routes (`/v1/zk-payments`,
`/v1/zk-checkout`), `ZK_PAYMENTS_*`, the `zk_payment` table, the error codes and
`ZK_PAYMENT_SUCCEEDED`. Never rename those for wording: they are a contract.

`src/zk-payments/` serves payments whose amount is hidden on-chain, on Cosmos Pay's
OWN instance of OpenZeppelin's Confidential Token (`stellar-confidential` 0.8.0),
for a 0.01% commission (`ZK_PAYMENT_FEE_BPS = 1`, a constant: the price of the
product, never an env var). Testnet only; mainnet is off until `ZK_PAYMENTS_MAINNET_*`
is set.

**The model.** `scripts/zk/deploy-testnet.ts` deploys, from wasm already on testnet
(read from the demo's instances, no Rust build), a NEW auditor registry whose key id 0
is `K_aud = k·H` for a scalar only Cosmos Pay holds, and a NEW vanilla token over
native XLM that points at it and at the demo's verifier (`CAN45PFA…`, its v0.8.0 VKs
registered). So every account on our token is under OUR auditor key, and the server
can read every amount. A fee account is registered on the token by the same script
(a register proof generated in Node). Run again, the script verifies the configured
set on-chain and stops; `--redeploy` strands every payment on the old token.
`scripts/zk/e2e-testnet.ts` is the real-chain check (Friendbot accounts, proofs in
Node, the module's own services over an in-memory Prisma).

**The environment.** One set per tier, `ZK_PAYMENTS_TESTNET_*` and
`ZK_PAYMENTS_MAINNET_*` (`TOKEN`, `AUDITOR_REGISTRY`, `VERIFIER`, `AUDITOR_SECRET`,
`FEE_ACCOUNT`, `DEPLOYED_LEDGER`, `RPC_URL`). A set is all or nothing:
`src/config/zk-payments-env.ts` refuses half of one at boot, and the boot never needs
any of it. `ZkNetworksService` is the module's one reader of `zkPayments`, and its
`configFor(network)` is the ONE builder behind both `GET /v1/zk-payments/config` and
the keyless `GET /v1/zk-checkout/config`: never build that shape twice. The auditor
secret is in no response, no log and no tracked file; the deployer's and the fee
account's keys are operator secrets the server never needs (`.zk-secrets/`, git-ignored).

**Two prefixes, on purpose.** The merchant's routes are `/v1/zk-payments` (API key);
the payer's are `/v1/zk-checkout` (`@Public()`, per-address budgets, `Cache-Control:
no-store`, no CORS headers written here). APISIX serves a keyless read as a PREFIX
route, which works only when nothing under the prefix needs a key, so a new keyless
route goes under `/v1/zk-checkout` and a keyed one never does.

**How confirm decides** (`zk-payment-verification.ts`, pure, and its spec pins the
order). The route is public and decrypts whatever hashes it is given with the
auditor key, so the ORDER of the checks is security, not style:

1. neither hash settled another private payment (DB, before any RPC call; `409`);
2. both transactions exist and succeeded;
3. each is ONE operation calling `confidential_transfer` on the payment's token, with
   exactly one `transfer` event from that contract;
4. both closed inside `[createdAt - 60 s, expiresAt]` (ledger close time);
5. both come from the same payer;
6. the right recipients (merchant, fee account);
7. only then the amounts: the recipient-auditor channel decrypts to exactly
   `netAmount` / `feeAmount`, the sender channel agrees (`channelsAgree`), and
   `commit(amount, r_transfer)` equals the `C_transfer` of the invocation.

A payment with a merchant fee has a third leg: `merchantFeeTxHash`, a transfer of
`merchantFee.amount` to `merchantFee.wallet` (registered on the token, like the
recipient, checked at create). It runs through every step beside the other two, each
step over all legs before the next; confirm refuses the hash on a payment without a
merchant fee, and its absence on one with it, before reading the database or the chain.

Steps 4 and 5 before 7 are what keep confirm from being an amount oracle on someone
else's transfer (a payment created after it closed fails on time; a stranger's
transfer fails on payer). No message may ever contain a decrypted amount. A refusal
leaves the row `PENDING`; settling is a compare-and-swap on `PENDING`, and the hashes
are `@unique` across the table. A same-hash replay on a settled row emits
`ZK_PAYMENT_SUCCEEDED` again on purpose: the emitter's dedup claim absorbs it, and it
is what heals a settle that died between the compare-and-swap and the emit. `EXPIRED` is never stored: a `PENDING` row past
`expiresAt` READS as `EXPIRED` (`zk-payment-status.ts`, list filter included) and can
still settle with transfers that closed in time.

**The SDK boundary.** `stellar-confidential-token-sdk` is pinned to a GitHub commit
and imported ONLY by `src/zk-payments/confidential-sdk.ts`, which hands the rest of
the module plain data (strings, bigints, dates). Every spec mocks `ConfidentialSdk`;
jest cannot load the SDK's ESM graph. Proving (`bb.js`) is for `scripts/zk/` only.

Gotchas hit while building it:

- **The SDK is ESM-only and this build is CommonJS**, where TypeScript turns
  `import()` into `require()`, which the SDK's `exports` map (no `require` condition)
  refuses. The adapter imports through `new Function('url', 'return import(url)')`.
  And such an `import()` resolves a BARE specifier against the process's cwd, not the
  module: it worked from the repo root and failed elsewhere. So `sdkEntryUrl` finds
  the package on `require.resolve.paths` and imports its `exports` target as a
  `file://` URL. Keep both halves.
- **The SDK nests its own `@stellar/stellar-sdk` v14**; this repo has v17. Never pass
  an `xdr` object, `Transaction` or `Contract` across the boundary: the classes are
  different. The deploy script builds and submits with v17 itself and lets the SDK
  submit only its own operations.
- **v17's XDR is a new object model**: union arms and struct fields are properties
  (`func.invokeContract.args`), not methods (`.contractData()` throws). Prefer
  `scValToNative` / `humanizeEvents`, `Address.fromScAddress`, and
  `getContractWasmByContractId` + SHA-256 for a contract's wasm hash.
- **`C_transfer` is not in the `transfer` event.** It travels only in the invocation's
  `data` argument (`ScVal` XDR bytes of `{ payload: { c_transfer, … }, proof }`), so
  the adapter reads it from the envelope (a fee bump's inner transaction included).
- **The SDK does not export its RPC event parser**, so the adapter feeds
  `buildConfidentialEvent` an accessor over `humanizeEvents` output: the field mapping
  stays the SDK's.
- **The RPC keeps transactions about seven days** on SDF's testnet RPC
  (`ledgerRetentionWindow` 120960); past it, confirm is `transaction_not_found`.
  `expiresInMinutes` is capped at seven days for that reason.
- **Testnet is reset** every few months, and the demo's verifier with it: redeploy
  after a reset. The registry's manager (the throwaway deployer) can `rotate_key` id
  0; if it ever does, every confirm fails until `_AUDITOR_SECRET` follows.
- **The Soroban RPC is checked before it is trusted**: its `getNetwork` passphrase must
  be the configured one (`ConfidentialSdk.assertNetwork`), like the Solana genesis
  check. It is documented as the `Soroban RPC` upstream (503 only, like Horizon).
- **`ZkPaymentsModule` is registered at the end of `AppModule`** (only `Usdt0Module`,
  added later for the same reason, comes after it). The spec lists paths in module
  order, and registering it mid-list moved other modules' paths and turned an
  additive change into a 400-line spec diff. A new module goes last.
- **`test/setup-env.ts` pins a fixture ZK set**: the developer `.env` carries the real
  testnet one, and dotenv never overwrites a set value.

## USDT0 (`src/usdt0/`): LayerZero's OFT from Stellar, and what was verified on mainnet

`/v1/usdt0` sends Tether's USDT0 from Stellar to EVM networks: the holder signs ONE
Soroban transaction, `send` on the OFT (`CBOWOLFS...`), which burns it and LayerZero
delivers it (native USDT on Ethereum, USDT0 elsewhere). Mainnet only; a dev key gets
`available: false` on the routes and `network_unsupported` elsewhere. Every address,
endpoint id and route in `usdt0.constants.ts` was read from mainnet by simulation
(`peer(eid)` set for exactly the 21 routes). No observer: a read of one transfer
refreshes it (ledger first, then LayerZero Scan), throttled per row by `lastCheckedAt`.

- **Pure where it can be:** `usdt0-oft.ts` (ScVal codec, dust, fee buffer),
  `usdt0-ledger.ts` (envelope check, result codes, ledger outcome), `usdt0-scan.ts`
  (Scan status table), `usdt0-funds.ts` (USDT0 and XLM refusals). The RPC is
  `SorobanRpcClient`, Scan is `LayerZeroScanClient`; specs mock both.
- **A struct is an `ScMap` with its keys sorted**, or the host refuses it; `to` is 12
  zero bytes + the 20-byte EVM address. `functionName` of an invocation is an
  `XdrString` in v17: read it with `String(...)`.
- **The SAC has 7 decimals, the OFT shares 6**: the 7th is dust left in the account.
  The transaction sends the dust-free amount with `min_amount_ld` = `quote_oft`'s
  `amount_received_ld`.
- **`native_fee` gets a 20% buffer** (`USDT0_NATIVE_FEE_BUFFER_BPS`): the endpoint
  refunds the excess to `refund_address` (the source) in the same transaction, which a
  mainnet simulation showed. The balance check prices the whole limit plus the
  network fee (about 1.45 XLM of Soroban resources) and the reserve.
- **Simulation needs no existing account and no sequence** (`new Account(g, '0')`).
  Only source-account auth entries are accepted from the `send` simulation.
- **The XDR is about 7,000 characters**, too big for a QR: `qr` is null then.
- **LayerZero Scan indexes a Stellar message by guid first** and fills in the source
  hash minutes later, so ask `/messages/guid/{guid}` when the guid is known (it is
  `send`'s return value) and `/messages/tx/{hash}` (64 lowercase hex, no `0x`) only
  when it is not. A 404 is "not yet". Delivery took 1,612 to 1,661 s on every route
  on 2026-10-25.
- **No commission** on this route yet: one operation per Soroban transaction leaves
  no room for a fee payment. It is the product owner's decision.
- **A merchant fee goes through `contracts/soroban/merchant-fee-oft`**
  (`USDT0_MERCHANT_FEE_WRAPPER`): the operation calls the wrapper's `send`, which
  transfers the fee in USDT0 and calls the OFT's `send` with the same arguments, all
  under the holder's one source-account authorization (checked on testnet: one entry,
  the token transfer and the OFT's send as sub-invocations). The wrapper's wasm is
  committed and pinned (`USDT0_MERCHANT_FEE_WRAPPER_WASM_SHA256`, its spec reads the
  file); the service checks the deployed wasm and the OFT and token it is bound to
  before handing a holder the transaction. `cargo test` in the crate runs its tests;
  rebuilding it is a new wasm, a new hash and a new deployment.

## Dashboard analytics read other modules' tables, in Postgres

`src/analytics/` serves the dashboard (`GET /v1/summary`, `/v1/summary/series`,
`/v1/balances`, the logs). It only reads, and it reads tables other modules own.

- **Aggregate in SQL, never in JS.** Every figure is a `$queryRaw` with `COUNT(*)` /
  `SUM(...) FILTER (WHERE ...)`, bounded by the consumer's index and a date window.
  `summary` once loaded every payment intent and reduced it in Node, and one merchant's
  history blocked every other request. A spec asserts no `findMany` runs.
- **USD figures are the one thing priced in TypeScript** (`usd-prices.ts`, `UsdPricesService`).
  The settled payments are still summed in SQL, per chain, asset AND issuer
  (`settledAssetsSql`); each row is then multiplied by NEAR Intents' cached reference price.
  A mainnet token is matched only by its contract (on Stellar its code and issuer), never by
  its name; a test-network one takes its mainnet namesake's price, and none when two listed
  tokens share the symbol. Prices never fail a summary: the service waits
  `USD_PRICES_WAIT_MS` and answers null, which is why every USD field is nullable. That wait
  is paid only with no list at all: `NearIntentsClient.tokens` fetches the list at boot
  (`NEAR_INTENTS_TOKENS_PREFETCH`) and, past its TTL, serves the one on hand while a single
  background fetch replaces it (stale-while-revalidate, up to `NEAR_INTENTS_TOKENS_STALE_MS`).
- **The summary, the series and the balances are cached in the process** (`ReadThroughCache`,
  `src/common/read-through-cache.ts`): reused per consumer, network and figure for
  `ANALYTICS_CACHE_TTL_MS` (10 s; `0` off, as `test/setup-env.ts` sets it), concurrent identical
  calls sharing one computation, at most `ANALYTICS_CACHE_MAX_ENTRIES` keys. The key starts with
  the local consumer id, so no tenant is served another's figures; a figure lags a new payment by
  up to the TTL and each replica has its own cache. The consumer's id comes from
  `ConsumerResolverService.resolveId` (cached a minute per username and credential) instead of an
  upsert per read. The logs are pages a person reads: never cached.
- **`GET /v1/summary/series` covers payments, every kind of swap (USDT0 transfers are the
  `usdt0` kind), liquidity operations, webhook deliveries and private payments**, each with
  `buckets` on the buckets of `seriesWindow` (UTC, weeks from Monday, the same as Postgres'
  `date_trunc`), pre-seeded by `fillBuckets` so a quiet bucket is a zero, plus the window's
  totals and the window before. Private payments are the `zkPayments` part (XLM, valued at XLM's
  price; their `expired` is derived with `zkExpiredSql`, the SQL twin of `effectiveZkStatus`,
  since nothing stores EXPIRED). Payments, swaps, liquidity and private payments are scoped by
  consumer AND `resolveNetwork`; `chain_swap`, `cross_chain_swap` and `usdt0_transfer` rows are
  always `public`, so a sandbox key counts none. Webhook deliveries are scoped by consumer only: an endpoint has
  no network. The list routes of those modules are scoped the same way (consumer and
  `resolveNetwork`), so a production key never lists a test-network row.
- **Succeeded / failed / in progress is a table per model** (`SWAP_OUTCOMES`,
  `CHAIN_SWAP_OUTCOMES`, `CROSS_CHAIN_SWAP_OUTCOMES`, `USDT0_TRANSFER_OUTCOMES`,
  `LIQUIDITY_OPERATION_OUTCOMES` in `analytics.constants.ts`), turned into SQL by
  `series-outcomes.ts`. Never guess from a status name: a new `SwapStatus`,
  `CrossChainSwapStatus` or `Usdt0TransferStatus` value fails `tsc` until it is mapped, and
  `series-outcomes.spec.ts` pins each decision. A new swap table is one entry
  in `SWAP_SOURCES` (`analytics.service.ts`) and one kind in `SERIES_SWAP_KINDS`.

## The OpenAPI contract ships with the route — review Swagger every time

`openapi/openapi.json` is what Swagger UI renders at `/docs` and what an
integrator imports into Postman or a client generator. It is generated from the
decorators, so a route whose decorators are wrong publishes a wrong contract and
nothing fails. It used to: every error of every route showed the same
`409 idempotency_conflict` example, a 401 was documented on the health probes,
and the two gateway headers were published as "either one" so a Postman import
was refused on every call.

**Every time you add or change an endpoint, open the regenerated spec and read
that operation** — `npm run openapi:generate`, then the diff of
`openapi/openapi.json`, or `/docs` with `SWAGGER_ENABLED=true`. Check, for that
operation:

- it has a `summary`, and every success status has a body (`@ApiOkResponse` /
  `@ApiCreatedResponse` with a `type`). Declaring any failure yourself drops
  Nest's implicit success response, so declare that too;
- the failures listed are the ones it can really return, and each example is
  one it would really send;
- the extensions say what the route is: `x-cosmos-rate-limit`,
  `x-cosmos-upstream`, `x-cosmos-public`, `x-cosmos-public-key`.

How failures get documented — use these, never a hand-written
`@ApiResponse({ status: 4xx, ... })`:

| The route… | Declare | Published as |
| --- | --- | --- |
| validates input, is gated, takes a `{param}`, or can throw at all | nothing | 400 / 401 + 403 / 404 / 500, attached by `swagger.ts` |
| is `@Public()` | nothing — the decorator does it | `security: []`, no 401/403 |
| is `@RateLimit(...)` | nothing — the decorator does it | 429 + `Retry-After`, `ratelimit-*` on 2xx |
| calls a third party while serving — any `UpstreamProvider`: BlindPay, Horizon, Solana, Monad, NEAR Intents, Jupiter, Kuru Flow | `@ApiUpstream('BlindPay', …)` on **that handler**, naming each one it reaches | 502/503/504 per provider (Horizon: 503 only — `UPSTREAM_FAILURES` in `src/swagger.ts`) |
| throws a code of its own (409, a domain 400, a kill-switch 403) | `@ApiErrorResponse({ status, codes })` | that status with one real example per code |

- **A new `ApiErrorCode` needs an entry in `API_ERROR_CASES`**
  (`src/common/errors/api-error.responses.ts`): its statuses, a one-line summary,
  and the real message from the throw site. The table is a
  `Record<ApiErrorCode, …>`, so `tsc --noEmit` fails until it has one.
- **`@ApiUpstream` goes on the handler, not the controller**, unless every route
  in the controller really calls the provider. A list route that reads only our
  own mirror cannot fail on BlindPay, and documenting that it can is the same
  noise this section exists to remove.
- **Never document a status a route cannot return.** 409 is never attached
  centrally, because a conflict is always specific to what the route writes.
- `npm run openapi:generate` refuses to write a spec with a missing summary, a
  failure with no body or example, an example whose `statusCode` disagrees with
  its status, or a 429 on a route with no budget (`findOpenApiIssues` in
  `src/swagger.ts`). `openapi:check` runs it in CI. It cannot tell whether the
  codes you listed are the ones the service throws — reading the operation is
  part of review.

## Tests ship with the change

A change is not done until its tests are, in the same commit:

- A new service, guard, interceptor or pure rule gets a `*.spec.ts` beside it.
- A new route gets e2e coverage of its wiring in `test/` — at minimum that the
  guards in front of it refuse the callers they must refuse.
- A security fix gets a test that fails without the fix.
- The gate (each command is in **Commands** above) is `npm run lint`,
  `npm test`, `npm run test:e2e`, `npm run openapi:check` and
  `npm run readme:check`, which CI runs, plus
  `npx tsc --noEmit -p tsconfig.json`, which it does not — run that one yourself:
  the build compiles `tsconfig.build.json`, which leaves the spec files out, and
  ts-jest will run a spec green that the compiler rejects.
