/**
 * Fails the build if any emitted runtime file still requires a path alias.
 *
 * `nest build` rewrites `@/…` and `@generated/…` to relative paths through its
 * own tsconfig-paths hook, which is what lets `npm run start:prod` resolve
 * them. Nothing else does that any more (tsc-alias was dropped: it only touched
 * `.d.ts` files and `dist/scripts/`, and pulled in an unpatchable `braces`
 * advisory). Switching the Nest compiler — to swc, say — can silently turn the
 * hook off, and the result builds cleanly and dies on boot. This is the check
 * that turns that into a build failure.
 *
 * Only `dist/src` and `dist/generated` are scanned: `dist/scripts` is never run
 * from `dist` (the scripts go through ts-node), and string literals that merely
 * look like an alias are not `require` calls.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['dist/src', 'dist/generated'];
const ALIAS_REQUIRE = /require\(\s*["'](@\/|@generated\/)[^"']*["']\s*\)/g;

const offenders = [];
for (const root of ROOTS) {
  for (const rel of readdirSync(root, { recursive: true })) {
    const file = join(root, rel);
    if (!file.endsWith('.js')) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(ALIAS_REQUIRE)) {
      offenders.push(`${file}: ${match[0]}`);
    }
  }
}

if (offenders.length > 0) {
  console.error('Unresolved path aliases in emitted JS (start:prod would fail):');
  for (const line of offenders) console.error(`  ${line}`);
  process.exit(1);
}
