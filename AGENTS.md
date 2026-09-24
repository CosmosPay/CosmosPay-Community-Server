# AGENTS.md

Conventions for this repo. They are enforced by `npm run lint`, which CI gates on.

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
4. `package.json` → `build` runs `tsc-alias -p tsconfig.build.json`

Point 4 matters: `tsc` emits `require("@/...")` verbatim and Node cannot resolve
it, so `tsc-alias` rewrites the aliases back to real relative paths after
`nest build`. Never drop it from the build script or `npm start:prod` breaks.
The `ts-node` scripts pass `-r tsconfig-paths/register` for the same reason.

**There is no `baseUrl`.** TypeScript 6 deprecates it and 7 removes it, so the
`paths` entries are written as explicit `"./src/*"` / `"./generated/*"` and
resolve relative to `tsconfig.json` itself. All four consumers above were checked
against that: `tsc --noEmit` is clean, `tsc-alias` still rewrites every alias out
of `dist/` (grep it for `@/` — there are none), and both `ts-node` scripts
(`openapi:generate`, `assets:verify`) still resolve. Do not reintroduce it.

`types` IS set, to `["node", "jest"]`, and that is a different thing: TypeScript 6
stopped auto-including every `@types` package, so the two AMBIENT ones — the ones
that declare globals rather than exporting anything — have to be named. Packages
reached through an import (`express`, `pg`, `qrcode`, `supertest`) resolve on their
own and must not be added.

Do not add `typeRoots` either. It looks like the natural companion to dropping
`baseUrl` and it is the opposite: TypeScript already discovers every
`node_modules/@types` package on its own, and naming one root NARROWS that to the
list you wrote. Adding `["./node_modules/@types"]` here silently dropped the
ambient jest globals, so all 62 spec files failed `tsc --noEmit` while still
running green under ts-jest — a split where the compiler and the runner disagree
about the same file.

## Constants live in a `*.constants.ts` file, not inline in a service

Each module keeps its tunable values — timeouts, batch sizes, limits,
cooldowns, prefixes, policy lists, on-chain memo labels — in one file named
after the module, so they can be found and changed without reading the service:

```
src/activity/activity.constants.ts
src/admin/admin.constants.ts
src/aliases/aliases.constants.ts
src/analytics/analytics.constants.ts
src/assets/assets.constants.ts
src/blindpay/blindpay.constants.ts
src/common/rate-limit.constants.ts
src/config/config.constants.ts
src/kyc/kyc.constants.ts
src/liquidity-pools/liquidity-pools.constants.ts
src/observer/observer.constants.ts
src/payment-intents/payment-intents.constants.ts
src/pollar/pollar.constants.ts
src/prisma/prisma.constants.ts
src/stellar/stellar.constants.ts
src/swaps/swaps.constants.ts
src/webhooks/webhooks.constants.ts
```

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
| integrate a provider, or change how an existing one behaves | that provider's own `##` section (see the BlindPay and Pollar ones for the shape) |
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
`../../README.md`, `AGENTS.md` is `../../AGENTS.md`, and a sibling translation is
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
  `pollar-oauth.service.ts` is long and does one thing; a second vocabulary is.
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
    a boot failure. Horizon, BlindPay, Pollar and outbound HTTP go through their
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
  `StellarAccountLoader` (including `assertCanAfford`), `resolveNetwork`,
  `resolvePlanCommissionBps`, `ConsumerResolverService`, `resolveMemoId`,
  `resolveSlippage` / `resolveIdempotencyKey`, the SEP-7 builders in
  `stellar/sep7.ts` and `SignedTransactionRelay` exist because private copies
  drifted apart.

## Security invariants a change must keep

Each of these was a real finding in this codebase, not a hypothetical:

- **The shared public key is ONE consumer for every anonymous caller.** Anything
  keyed by consumer — a memo, an `Idempotency-Key`, an in-flight guard, a list — is
  shared by all of them. A replay that returns a stored row checks first that the
  request matches it (otherwise `409 idempotency_conflict`), and a new route is
  unreachable with that key until it carries `@AllowPublicKey()`.
- **A `@Public()` route has no consumer.** It is served without key-auth, so
  `ApisixGuard` drops whatever `X-Consumer-Username` the client sent. Never read
  `@CurrentConsumer()` there.
- **A secret that proves something never goes back to a caller who could not
  already prove it.** A recovery token proves a mailbox, so only the platform
  console receives it (`ConsoleOnlyGuard`), and the console emails it.
- **Reads return a `*_PUBLIC_SELECT` projection**, never the full row — the full
  row carries `raw` provider payloads and internal ids.
- **Every tenant query filters by the calling consumer**, and a miss on someone
  else's row is a 404, not a 403: "exists but not yours" is an ownership oracle.
- **A route whose cost an error cannot refund — XLM spent, an account created
  on-chain — carries `@RateLimit`.**
- **A guard that refuses logs the refusal.** Interceptors run after guards, so
  the access log never sees a request a guard turned away.

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
| calls BlindPay, Pollar or Horizon while serving | `@ApiUpstream('BlindPay')` on **that handler** | 502/503/504 (Horizon: 503 only) |
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
- The gate is `npm run lint`, `npm test`, `npm run test:e2e`,
  `npm run openapi:check` and `npm run readme:check`, which CI runs, plus
  `npx tsc --noEmit -p tsconfig.json`, which it does not — run that one yourself:
  the build compiles `tsconfig.build.json`, which leaves the spec files out, and
  ts-jest will run a spec green that the compiler rejects.
