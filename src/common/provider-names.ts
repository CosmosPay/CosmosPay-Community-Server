/**
 * Nothing a client receives names a provider (product owner, 2026-11-11: "it
 * must never name our providers, in errors or anything — not El Dorado, not
 * NEAR Intents"). Error messages, the published OpenAPI document and every
 * human-readable field say what a thing DOES ("the cross-chain route", "the
 * fiat partner", "the P2P marketplace"); the real name stays where only the
 * operator reads it: logs, env var names, code and comments.
 *
 * Machine identifiers that already carry a name (`blindpayId`, the `jupiter` /
 * `kuru` provider enum, the `/v1/defindex` paths, the `*_bitso` rails) are the
 * published contract and are NOT rewritten: renaming one breaks every
 * integrator branching on it. The README's upgrading notes list them.
 *
 * Two consumers:
 *   - `AllExceptionsFilter` passes every error message through
 *     {@link neutralizeProviderNames} as the last line of defence, so a message
 *     a throw site forgot, or a provider's own text relayed by
 *     `requestUpstreamJson`, still leaves without the name;
 *   - `findOpenApiIssues` refuses a document whose prose names one
 *     ({@link providerNamesIn}), so `openapi:generate` fails before a new
 *     decorator can publish it.
 */
import {
  PROVIDER_ATTRIBUTIVE_NOUNS,
  PROVIDER_DOMAIN,
  PROVIDER_ENV_VAR,
  PROVIDER_ENV_VAR_STANDIN,
  PROVIDER_PHRASES,
  PROVIDER_TERMS,
  type ProviderTerm,
} from '@/common/provider-names.constants';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * What may stand before a provider's name and turn it into an adjective: a
 * determiner ("the BlindPay quote", in both cases, spelled out rather than an
 * `i` flag, which would also match the NAME case-insensitively and rewrite an
 * identifier), or a possessive noun ("your key's BlindPay instance"). Not
 * "that", "which" or "one": those are pronouns as often ("the assets that NEAR
 * Intents lists").
 */
const DETERMINER = `(${[
  'a',
  'an',
  'the',
  'this',
  'these',
  'those',
  'each',
  'every',
  'its',
  'their',
  'our',
  'your',
  'any',
  'no',
  'another',
  'whose',
]
  .flatMap((w) => [w, capitalize(w)])
  .join(
    '|',
  )}|(?!(?:[Ii]t|[Tt]hat|[Ww]hat|[Tt]here|[Hh]ere|[Ww]ho)['’]s)[A-Za-z0-9]+['’]s)`;

const ATTRIBUTIVE = PROVIDER_ATTRIBUTIVE_NOUNS.join('|');

/** "a" or "an" as the word after it needs, keeping the determiner's case. */
function article(det: string, next: string): string {
  if (!/^an?$/i.test(det)) return det;
  const word = /^[aeiou]/i.test(next) ? 'an' : 'a';
  return det.charAt(0) === det.charAt(0).toUpperCase()
    ? capitalize(word)
    : word;
}

interface CompiledTerm {
  term: ProviderTerm;
  parenthetical: RegExp;
  withDeterminer: RegExp;
  attributive: RegExp;
  possessive: RegExp;
  compound: RegExp;
  bare: RegExp;
  find: RegExp;
  anyCase: RegExp;
}

const COMPILED: readonly CompiledTerm[] = PROVIDER_TERMS.map((term) => {
  const name = escapeRe(term.name).replace(/ /g, '\\s+');
  // A name ending in "s" takes a bare apostrophe ("NEAR Intents' prices").
  const possessiveTail = term.name.endsWith('s') ? `['’](?:s\\b)?` : `['’]s\\b`;
  return {
    term,
    // "bank accounts (BlindPay)": the aside says nothing once the name is gone.
    parenthetical: new RegExp(`\\s*\\(${name}\\)`, 'g'),
    // "the BlindPay quote" → "the fiat partner quote"; "an OFT" → "a bridge contract".
    withDeterminer: new RegExp(
      `\\b${DETERMINER}\\s+${name}(?:${possessiveTail})?(?![\\w-])`,
      'g',
    ),
    // "inbound BlindPay webhooks" → "inbound fiat partner webhooks".
    attributive: new RegExp(`\\b${name}(?=\\s+(?:${ATTRIBUTIVE})\\b)`, 'g'),
    possessive: new RegExp(`\\b${name}${possessiveTail}`, 'g'),
    // "BlindPay-hosted" → "fiat partner-hosted".
    compound: new RegExp(`\\b${name}-`, 'g'),
    bare: new RegExp(`\\b${name}\\b`, 'g'),
    find: new RegExp(`\\b${name}\\b`),
    // In a provider's own text: any case, any separator ("near_intents").
    anyCase: new RegExp(`\\b${name.replace(/\\s\+/g, '[\\s_-]*')}\\b`, 'gi'),
  };
});

/**
 * `text` with every provider's display name replaced by what it does, and every
 * env var named after one by "this deployment’s configuration". Idempotent, and
 * the identity on text that names none.
 *
 * `startsSentence` says whether `text` opens a sentence (a whole message
 * does; a fragment of a description split across string literals may not), so
 * a replacement there starts with a capital.
 */
export function neutralizeProviderNames(
  text: string,
  { startsSentence = true }: { startsSentence?: boolean } = {},
): string {
  if (providerNamesIn(text).length === 0) return text;
  let out = text;
  for (const [re, to] of PROVIDER_PHRASES) out = out.replace(re, to);
  for (const c of COMPILED) {
    const { noun, adjective } = c.term;
    out = out
      .replace(c.parenthetical, '')
      .replace(
        c.withDeterminer,
        (_m, det: string) => `${article(det, adjective)} ${adjective}`,
      )
      .replace(c.attributive, adjective)
      .replace(c.possessive, (m) => `${noun}${/’/.test(m) ? '’' : "'"}s`)
      .replace(c.compound, `${adjective}-`)
      .replace(c.bare, noun);
  }
  out = out.replace(PROVIDER_ENV_VAR, PROVIDER_ENV_VAR_STANDIN);
  // "BlindPay status of …" opened the text: "Fiat partner status of …" still does.
  if (startsSentence && /^[A-Z]/.test(text) && /^[a-z]/.test(out))
    out = capitalize(out);
  // A replacement that opens a sentence starts with a capital.
  const sentenceStart = startsSentence
    ? /(^|[.!?]\s+)(the|a|an|this) (?=\S)/g
    : /([.!?]\s+)(the|a|an|this) (?=\S)/g;
  return out.replace(
    sentenceStart,
    (_m, lead: string, word: string) => `${lead}${capitalize(word)} `,
  );
}

/**
 * A provider's OWN words (the reason it answered an error with), made fit to
 * relay: links and its domains dropped, its names matched in any case and
 * replaced. Unlike our prose, such text holds no identifier of our contract,
 * so a lowercase `blindpay` there is the name and goes too.
 */
export function scrubUpstreamText(text: string): string {
  let out = text
    .replace(/\bhttps?:\/\/\S+/gi, '')
    .replace(PROVIDER_DOMAIN, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  for (const c of COMPILED) out = out.replace(c.anyCase, c.term.name);
  return neutralizeProviderNames(out);
}

/** The provider names `text` carries, display names and env vars alike; empty when none. */
export function providerNamesIn(text: string): string[] {
  const names = COMPILED.filter((c) => c.find.test(text)).map(
    (c) => c.term.name,
  );
  const envVars = text.match(PROVIDER_ENV_VAR) ?? [];
  return [...new Set([...names, ...envVars])];
}
