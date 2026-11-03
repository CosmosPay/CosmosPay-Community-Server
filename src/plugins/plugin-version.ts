import { PLUGIN_VERSION_RE } from '@/plugins/plugins.constants';

/**
 * Semver precedence of two plugin versions (`PLUGIN_VERSION_RE`): negative when
 * `a` is older, positive when newer, 0 when equal. A pre-release sorts before
 * its release, and pre-release identifiers compare as SemVer 2.0.0 §11 says
 * (numeric ones as numbers and below alphanumeric ones).
 *
 * `npm run plugins -- install` uses it to refuse a downgrade: a registry is not
 * trusted, and one that answers `latest` with an OLDER signed version, one with
 * a known flaw, is attacking without forging anything.
 */
export function compareVersions(a: string, b: string): number {
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i];
  }
  if (left.pre.length === 0 || right.pre.length === 0) {
    return right.pre.length - left.pre.length;
  }
  const length = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < length; i++) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) - Number(y);
    if (xNumeric) return -1;
    if (yNumeric) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function parse(version: string): { core: number[]; pre: string[] } {
  if (!PLUGIN_VERSION_RE.test(version)) {
    throw new Error(`"${version}" is not a plugin version (semver)`);
  }
  const [core, pre] = splitOnce(version, '-');
  return {
    core: core.split('.').map(Number),
    pre: pre === undefined ? [] : pre.split('.'),
  };
}

function splitOnce(text: string, separator: string): [string, string?] {
  const at = text.indexOf(separator);
  return at === -1 ? [text] : [text.slice(0, at), text.slice(at + 1)];
}
