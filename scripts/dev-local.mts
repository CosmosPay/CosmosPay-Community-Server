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
 * `npm run dev` over `dist/`), and each instance runs from there; this script restarts them
 * itself after each compile without errors. Not `node --watch`: its watcher kept a core busy per
 * instance while nothing changed, on Windows under OneDrive. Migrations run once first. Ctrl+C
 * stops them all.
 *
 * Only one run per checkout: a run records its pid in `dist-local/.dev-local.pid`, and a new run
 * (or `npm run dev:local:stop`) first ends an earlier one with everything it started, and any
 * build or instance of this checkout left running without it. On Windows ending a process leaves
 * its children running, so a terminal closed without Ctrl+C used to leave a build and its
 * instances behind for good, one set more per restart.
 *
 * `dev-instances.json` is git-ignored: recovery servers keep real keys in it. The first
 * run creates it from `dev-instances.example.json`, generating each `<generate:…>` value
 * once — never again, because a recovery server's signer master derives signers that are on
 * the ledger, and a new one would strand every account registered with the old.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const CONFIG = join(ROOT, 'dev-instances.json');
const EXAMPLE = join(ROOT, 'dev-instances.example.json');
const OUT_DIR = 'dist-local';
const MAIN = join(ROOT, OUT_DIR, 'src', 'main.js');
const NEST = join(ROOT, 'node_modules', '@nestjs', 'cli', 'bin', 'nest.js');
const PRISMA = join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
const PID_FILE = join(ROOT, OUT_DIR, '.dev-local.pid');
// Loaded into the build and each instance: they end when this script does, however it ends.
const WITH_PARENT = pathToFileURL(join(ROOT, 'scripts', 'exit-with-parent.mjs')).href;
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

/** A process and everything it started, ended. On Windows a plain kill leaves the children. */
function killTree(pid: number): void {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

/** Every running node process: its pid and command line. */
function nodeProcesses(): { pid: number; cmd: string }[] {
  if (process.platform === 'win32') {
    const query = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
    const ps = spawnSync('powershell', ['-NoProfile', '-Command', query], { encoding: 'utf8' });
    const parsed: unknown = JSON.parse(ps.stdout?.trim() || '[]');
    const rows = (Array.isArray(parsed) ? parsed : [parsed]) as { ProcessId: number; CommandLine: string | null }[];
    return rows.map((r) => ({ pid: r.ProcessId, cmd: r.CommandLine ?? '' }));
  }
  const ps = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return (ps.stdout ?? '').split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    return m && /\bnode\b/.test(m[2]) ? [{ pid: Number(m[1]), cmd: m[2] }] : [];
  });
}

/**
 * An earlier run of this checkout, ended with everything it started: the one its pid file names,
 * and any build or instance of this checkout still running without it (left by a run whose
 * terminal was closed, or by a run of an older version of this script). Returns their pids;
 * `dryRun` only finds them.
 */
export function stopEarlier(dryRun = false): number[] {
  // Windows paths compare without case (a command line may spell the checkout's path either way).
  const norm = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const has = (cmd: string, part: string) => norm(cmd).includes(norm(part));
  const ours = (cmd: string) => has(cmd, MAIN) || has(cmd, join(ROOT, OUT_DIR)) || (has(cmd, NEST) && cmd.includes('tsconfig.local.json'));
  const pids = new Set<number>();
  if (existsSync(PID_FILE)) {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
    if (!dryRun) rmSync(PID_FILE, { force: true });
    if (pid && pid !== process.pid) pids.add(pid);
  }
  const running = nodeProcesses();
  for (const p of running) if (p.pid !== process.pid && ours(p.cmd)) pids.add(p.pid);
  // The pid file's process counts only while it is still this script (a pid can be reused).
  const alive = [...pids].filter((pid) => running.some((p) => p.pid === pid && (ours(p.cmd) || p.cmd.includes('dev-local'))));
  if (!dryRun) for (const pid of alive) killTree(pid);
  return alive;
}

function main(): void {
  if (process.argv.includes('--stop')) {
    const dryRun = process.argv.includes('--dry-run');
    const pids = stopEarlier(dryRun);
    if (!pids.length) console.log('no dev:local running for this checkout');
    else console.log(`${dryRun ? 'would stop' : 'stopped'} ${pids.length} process tree(s) of dev:local: ${pids.join(', ')}`);
    return;
  }
  const config = loadConfig();
  const names = resolveInstances(config, process.argv.slice(2));
  const ended = stopEarlier();
  if (ended.length) console.log(`ended ${ended.length} process tree(s) left by an earlier dev:local`);
  mkdirSync(join(ROOT, OUT_DIR), { recursive: true });
  writeFileSync(PID_FILE, String(process.pid));

  let build: ChildProcess | null = null;
  const instances = new Map<string, ChildProcess>();
  const stop = () => {
    for (const c of [build, ...instances.values()]) if (c?.pid) killTree(c.pid);
    rmSync(PID_FILE, { force: true });
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const migrate = spawnSync(process.execPath, [PRISMA, 'migrate', 'deploy'], { stdio: 'inherit', cwd: ROOT });
  if (migrate.status !== 0) process.exit(migrate.status ?? 1);

  // The children watch this process and end with it, however it ends (a closed terminal too).
  const withParent = ['--import', WITH_PARENT];
  const childEnv = { ...process.env, DEV_LOCAL_PID: String(process.pid) };
  build = spawn(process.execPath, [...withParent, NEST, 'build', '--watch', '-p', 'tsconfig.local.json'], { cwd: ROOT, env: childEnv });
  pipe(build, 'build', 90);

  const start = () => {
    names.forEach((name, i) => {
      const env = { ...childEnv, ...flatten(config.instances[name]) };
      const child = spawn(process.execPath, ['--no-node-snapshot', ...withParent, MAIN], { cwd: ROOT, env });
      instances.set(name, child);
      pipe(child, name, COLORS[i % COLORS.length]);
      child.on('exit', (code) => {
        if (instances.get(name) === child && code) console.log(`${name} exited (${code}); it starts again after the next build`);
      });
    });
  };
  // Every instance ended (its port freed) before they start again.
  const restart = async () => {
    const running = [...instances.values()].filter((c) => c.exitCode === null);
    instances.clear();
    await Promise.all(running.map((c) => new Promise<void>((done) => { c.once('exit', () => done()); c.kill(); })));
    start();
  };

  // tsc prints "Found N errors. Watching for file changes." after every compile. The instances
  // start on the first one without errors and restart on each next one; after a compile with
  // errors they keep running the last good build.
  let started = false;
  let rest = '';
  build.stdout?.on('data', (chunk: Buffer) => {
    const lines = (rest + chunk.toString()).split(/\r?\n/);
    rest = lines.pop() ?? '';
    if (!lines.some((line) => /Found 0 errors/.test(line)) || !existsSync(MAIN)) return;
    if (!started) {
      started = true;
      start();
      console.log(`started: ${names.map((n) => `${n} :${flatten(config.instances[n]).PORT ?? process.env.PORT ?? '3000'}`).join(', ')}`);
    } else {
      console.log('rebuilt: restarting the instances');
      void restart();
    }
  });
}

if (process.argv[1]?.endsWith('dev-local.mts')) main();
