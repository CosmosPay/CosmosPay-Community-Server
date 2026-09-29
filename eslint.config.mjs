// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'dist', 'node_modules'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // Allow the _-prefix convention for deliberately discarded bindings, e.g.
      // `const { secret: _secret, ...safe } = endpoint` in webhooks.service.ts.
      // Imports are written with the `@/*` (src) and `@generated/*` aliases,
      // never with `./` or `../`. A relative path breaks the moment a file
      // moves and makes the same module read differently from each directory;
      // the alias is stable and greppable. `tsc-alias` rewrites both back to
      // real relative paths at build time, so `dist` stays plain CommonJS.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['./*', '../*'],
              message:
                'Use the "@/..." alias (or "@generated/..." for the Prisma client) instead of a relative path.',
            },
          ],
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // Plugins (`plugins/<slug>/index.ts`) reach the core through
    // `@/plugins/sdk` and nothing else: no
    // Prisma, no Nest provider, no `node:*`, no npm package, no ambient escape
    // hatch (`process`, `require`, `fetch`, `globalThis`, …). The runtime hands
    // a plugin a capability-scoped context; these rules keep plugin code
    // honest about that where it is written and reviewed. The enforcement is
    // the sandbox (`src/plugins/plugin-sandbox.ts`): plugin code only ever runs
    // in a V8 isolate with none of those things in it. See the README, Plugins.
    files: ['plugins/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!@/plugins/sdk$)',
              message:
                'A plugin may import only "@/plugins/sdk". Reach the core through ctx.core, the network through ctx.http, and keep data in ctx.storage.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...[
          'process',
          'globalThis',
          'global',
          'require',
          'module',
          'exports',
          '__dirname',
          '__filename',
          'eval',
          'Function',
          'Reflect',
          'Proxy',
          'fetch',
          'XMLHttpRequest',
          'WebSocket',
          'setInterval',
          'setImmediate',
        ].map((name) => ({
          name,
          message: `"${name}" is outside what a plugin may touch; use the PluginContext.`,
        })),
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message: 'A plugin may not import dynamically.',
        },
        {
          selector: 'TSImportEqualsDeclaration',
          message: 'A plugin may not use import = require().',
        },
        {
          selector:
            'MemberExpression[property.name=/^(constructor|__proto__|prototype|__defineGetter__|__defineSetter__)$/]',
          message:
            'A plugin may not reach constructors or prototypes — that is the way out to Function and the globals.',
        },
        {
          selector:
            'MemberExpression[computed=true][property.value=/^(constructor|__proto__|prototype)$/]',
          message:
            'A plugin may not reach constructors or prototypes — that is the way out to Function and the globals.',
        },
        {
          selector:
            "MemberExpression[object.name='Object'][property.name=/^(defineProperty|defineProperties|setPrototypeOf|getPrototypeOf|getOwnPropertyDescriptors?)$/]",
          message: 'A plugin may not redefine or inspect object internals.',
        },
      ],
      'no-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    // Test doubles are untyped by nature: a hand-rolled Prisma fake or a mocked
    // Horizon chain is `any` all the way down, and 979 of the repo's ~1010
    // findings came from exactly that. Muting these here is what lets `npm run
    // lint` be a CI gate on production code instead of a wall of noise nobody
    // reads. Production code stays fully checked.
    files: ['**/*.spec.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    // `test/` holds e2e helpers that live outside `src`, so no alias can
    // address them — `./gateway-auth` has to stay relative there.
    files: ['test/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
);
