# CLAUDE.md

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

## Constants live in a `*.constants.ts` file, not inline in a service

Each module keeps its tunable values — timeouts, batch sizes, limits,
cooldowns, prefixes, policy lists, on-chain memo labels — in one file named
after the module, so they can be found and changed without reading the service:

```
src/analytics/analytics.constants.ts
src/blindpay/blindpay.constants.ts
src/config/config.constants.ts
src/kyc/kyc.constants.ts
src/liquidity-pools/liquidity-pools.constants.ts
src/payment-intents/payment-intents.constants.ts
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
