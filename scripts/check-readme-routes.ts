import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Keeps the seven READMEs honest about each other and about the routes this
 * service serves.
 *
 * A hand-maintained route table once listed 22 of ~80 endpoints and nothing
 * noticed: prose drifts while the build stays green. This fails CI instead, for
 * three reasons:
 *
 *   1. one of the seven language files is missing;
 *   2. a translation has a different number of `##` / `###` headings than
 *      README.md — the cheapest signal that a section was added or removed in one
 *      language and not carried to the others;
 *   3. a route in the generated OpenAPI contract has no row in a README's route
 *      index.
 *
 * It reads `openapi/openapi.json` as committed, so regenerate it first when a
 * controller changed (`openapi:check` runs before this in CI). Routes excluded
 * from the contract are not required, and prose is not compared — confirming the
 * seven say the same thing is review's job.
 */

const ROOT = join(__dirname, '..');

/** English at the root, where GitHub renders it; the translations beside each other. */
const README_FILES = [
  'README.md',
  'docs/i18n/README.es.md',
  'docs/i18n/README.pt.md',
  'docs/i18n/README.de.md',
  'docs/i18n/README.fr.md',
  'docs/i18n/README.hi.md',
  'docs/i18n/README.zh.md',
];

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

/** `/v1/aliases/:name` and `/v1/aliases/{name}` are the same route. */
function routeKey(method: string, path: string): string {
  const normalized = path
    .replace(/\{[^}]+\}|:[A-Za-z_]\w*/g, '{}')
    .replace(/\/+$/, '');
  return `${method.toUpperCase()} ${normalized}`;
}

/** Every `| GET | `/v1/…` |` row in a document, wherever the table sits. */
function routesInReadme(markdown: string): Set<string> {
  const found = new Set<string>();
  const row = /^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`/gm;
  for (const match of markdown.matchAll(row)) {
    found.add(routeKey(match[1], match[2]));
  }
  return found;
}

function routesInOpenApi(): string[] {
  const spec = JSON.parse(
    readFileSync(join(ROOT, 'openapi', 'openapi.json'), 'utf8'),
  ) as { paths: Record<string, Record<string, unknown>> };
  const routes: string[] = [];
  for (const [path, operations] of Object.entries(spec.paths)) {
    for (const method of Object.keys(operations)) {
      if (HTTP_METHODS.has(method)) routes.push(routeKey(method, path));
    }
  }
  return routes;
}

/**
 * `##` and `###` headings outside fenced code blocks. A `# comment` inside a
 * bash block is not a heading, and counting it would make every translation of
 * a code comment a false alarm.
 */
function headingCounts(markdown: string): { h2: number; h3: number } {
  let inFence = false;
  let h2 = 0;
  let h3 = 0;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^## /.test(line)) h2 += 1;
    else if (/^### /.test(line)) h3 += 1;
  }
  return { h2, h3 };
}

function main(): void {
  const problems: string[] = [];
  const contract = routesInOpenApi();

  const missingFiles = README_FILES.filter((f) => !existsSync(join(ROOT, f)));
  for (const file of missingFiles) {
    problems.push(
      `${file}: missing — every README change ships in all seven languages`,
    );
  }

  const english = headingCounts(readFileSync(join(ROOT, 'README.md'), 'utf8'));

  for (const file of README_FILES) {
    if (missingFiles.includes(file)) continue;
    const markdown = readFileSync(join(ROOT, file), 'utf8');

    const counts = headingCounts(markdown);
    if (counts.h2 !== english.h2 || counts.h3 !== english.h3) {
      problems.push(
        `${file}: ${counts.h2} "##" / ${counts.h3} "###" headings, README.md has ${english.h2} / ${english.h3}`,
      );
    }

    const listed = routesInReadme(markdown);
    const unlisted = contract.filter((route) => !listed.has(route));
    for (const route of unlisted) {
      problems.push(`${file}: route index is missing ${route}`);
    }
  }

  if (problems.length > 0) {
    console.error(`README check failed (${problems.length}):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log(
    `README check passed: ${README_FILES.length} languages, ${english.h2} sections, ${contract.length} routes indexed in each.`,
  );
}

main();
