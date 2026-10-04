/**
 * `npm run dev:local [-- <profile | instance...>]` — several instances of this service on
 * one machine, from one checkout and one `.env`.
 *
 * What differs between instances is not a copy of `.env` per instance: it is the few keys
 * that change, in `dev-instances.json`. Every instance reads the same `.env` (Nest's
 * ConfigModule, as always) and starts with its overrides already in the environment, and a
 * value in the environment wins over the file. So:
 *
 *  - a key set here replaces the `.env` one for that instance;
 *  - `""` removes it — a recovery server must not inherit `APISIX_ADMIN_KEY`, and dotenv
 *    never overwrites a variable that is already set, even to nothing;
 *  - a nested object is a prefix: `{ "RECOVERY": { "ROLE": "a" } }` is `RECOVERY_ROLE=a`.
 *
 * One `nest build --watch` compiles into `dist-local/` (its own outDir, so it never fights
 * `npm run dev` over `dist/`), and each instance runs from there under `node --watch`,
 * restarting when the build changes. Migrations run once first. Ctrl+C stops them all.
 *
 * `dev-instances.json` is git-ignored: recovery servers keep real keys in it. The first
 * run creates it from `dev-instances.example.json`, generating each `<generate:…>` value
 * once — never again, because a recovery server's signer master derives signers that are on
 * the ledger, and a new one would strand every account registered with the old.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const ROOT = process.cwd();
const CONFIG = join(ROOT, 'dev-instances.json');
const EXAMPLE = join(ROOT, 'dev-instances.example.json');
const OUT_DIR = 'dist-local';
const MAIN = join(ROOT, OUT_DIR, 'src', 'main.js');
const NEST = join(ROOT, 'node_modules', '@nestjs', 'cli', 'bin', 'nest.js');
const PRISMA = join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
const COLORS = [36, 35, 33, 32, 34, 31];

type Value = string | number | boolean | null | { [key: string]: Value };
interface DevInstances {
  default: string;
  profiles: Record<string, string[]>;
  instances: Record<string, Record<string, Value>>;
}

/** `{ RECOVERY: { ROLE: 'a' } }` → `{ RECOVERY_ROLE: 'a' }`; scalars become strings. */
export function flatten(values: Record<string, Value>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith('$')) continue; // "$comment" and friends
    const name = prefix ? `${prefix}_${key}` : key;
    if (value !== null && typeof value === 'object') Object.assign(out, flatten(value, name));
    else out[name] = value === null ? '' : String(value);
  }
  return out;
}

/** The values the example marks `<generate:…>`, generated. */
function generated(kind: string): string {
  if (kind === 'hex32') return randomBytes(32).toString('hex');
  if (kind === 'stellar-secret') {
    const require = createRequire(join(ROOT, 'package.json'));
    const { Keypair } = require('@stellar/stellar-sdk') as { Keypair: { random(): { secret(): string } } };
    return Keypair.random().secret();
  }
  throw new Error(`unknown generator <generate:${kind}>`);
}

function loadConfig(): DevInstances {
  if (!existsSync(CONFIG)) {
    const text = readFileSync(EXAMPLE, 'utf8').replace(/<generate:([a-z0-9-]+)>/g, (_, kind: string) => generated(kind));
    writeFileSync(CONFIG, text);
    console.log(`created dev-instances.json from the example (git-ignored; keep it — it holds keys)`);
  }
  return JSON.parse(readFileSync(CONFIG, 'utf8')) as DevInstances;
}

/** The instances a command line names: a profile, instance names, or the default profile. */
export function resolveInstances(config: DevInstances, args: string[]): string[] {
  const picked = args.length ? args : [config.default];
  const names = picked.flatMap((arg) => config.profiles[arg] ?? [arg]);
  for (const name of names) {
    if (!config.instances[name]) {
      const known = [...Object.keys(config.profiles), ...Object.keys(config.instances)].join(', ');
      throw new Error(`"${name}" is neither a profile nor an instance in dev-instances.json (${known})`);
    }
  }
  return [...new Set(names)];
}

/** Each output line, prefixed with the instance name in its colour. */
function pipe(child: ChildProcess, label: string, color: number): void {
  const tag = `\x1b[${color}m[${label}]\x1b[0m `;
  for (const stream of [child.stdout, child.stderr]) {
    let rest = '';
    stream?.on('data', (chunk: Buffer) => {
      const lines = (rest + chunk.toString()).split(/\r?\n/);
      rest = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(tag + line + '\n');
    });
  }
}

function main(): void {
  const config = loadConfig();
  const names = resolveInstances(config, process.argv.slice(2));
  const children: ChildProcess[] = [];
  const stop = () => {
    for (const c of children) c.kill();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const migrate = spawnSync(process.execPath, [PRISMA, 'migrate', 'deploy'], { stdio: 'inherit', cwd: ROOT });
  if (migrate.status !== 0) process.exit(migrate.status ?? 1);

  const build = spawn(process.execPath, [NEST, 'build', '--watch', '-p', 'tsconfig.local.json'], { cwd: ROOT });
  children.push(build);
  pipe(build, 'build', 90);

  // The instances start on the first finished compile; `node --watch` restarts them on the next.
  let started = false;
  build.stdout?.on('data', (chunk: Buffer) => {
    if (started || !/Found 0 errors|Watching for file changes/.test(chunk.toString()) || !existsSync(MAIN)) return;
    started = true;
    names.forEach((name, i) => {
      const env = { ...process.env, ...flatten(config.instances[name]) };
      const child = spawn(process.execPath, ['--no-node-snapshot', `--watch-path=${join(ROOT, OUT_DIR)}`, MAIN], { cwd: ROOT, env });
      children.push(child);
      pipe(child, name, COLORS[i % COLORS.length]);
    });
    console.log(`started: ${names.map((n) => `${n} :${flatten(config.instances[n]).PORT ?? process.env.PORT ?? '3000'}`).join(', ')}`);
  });
}

if (process.argv[1]?.endsWith('dev-local.mts')) main();
