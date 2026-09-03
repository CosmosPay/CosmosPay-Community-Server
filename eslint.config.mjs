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
