/**
 * What a claimable handle may be, and what it normalizes to.
 *
 * Pure and separate from the service because this is the security boundary of the
 * whole feature, not a formatting nicety. An alias is read by a human immediately
 * before they authorise a payment, so two names that a person cannot tell apart
 * must not both be claimable — otherwise the attack is trivial: register the
 * lookalike, wait for someone to type it from memory, receive their money.
 *
 * Three rules, each closing a specific confusion:
 *
 *  1. **Case folds.** `Emanuel250` and `emanuel250` are one name. Uniqueness is
 *     decided on the folded form, and the typed form is kept only for display.
 *  2. **A closed alphabet.** `a-z`, `0-9`, and `_` between characters. No Unicode:
 *     a homoglyph set (Cyrillic `а`, Greek `ο`, a zero-width joiner) is unbounded
 *     and no amount of normalization makes it safe to render next to an amount.
 *  3. **Nothing that looks like an address or a system word.** A handle starting
 *     with `G` and 55 more base32 characters would be indistinguishable from the
 *     account it is meant to replace — see {@link looksLikeStellarAddress}.
 */

/** Shortest claimable handle. Below this the namespace is a landgrab, not a name. */
export const ALIAS_MIN_LENGTH = 3;

/** Longest. Bounded so it always renders whole in a payment confirmation. */
export const ALIAS_MAX_LENGTH = 32;

/**
 * Handles nobody may claim.
 *
 * Not a moderation list — these are strings that would let an alias impersonate
 * the product, the protocol or an operator inside our own UI. A user seeing
 * "sending to @support" has no way to know it is a stranger.
 */
export const ALIAS_RESERVED = new Set([
  'admin',
  'administrator',
  'cosmos',
  'cosmospay',
  'cosmos_pay',
  'help',
  'info',
  'moderator',
  'null',
  'undefined',
  'official',
  'operator',
  'owner',
  'root',
  'security',
  'stellar',
  'support',
  'system',
  'team',
  'undefined',
  'wallet',
  'xlm',
]);

/** Lowercase letters, digits and underscores; must start and end alphanumeric. */
const SHAPE = /^[a-z0-9](?:[a-z0-9_]*[a-z0-9])?$/;

/**
 * Why a handle was refused. Returned rather than thrown so the caller decides the
 * status code, and so a test can assert WHICH rule fired instead of that some
 * rule did.
 */
export type AliasNameError =
  'too_short' | 'too_long' | 'bad_characters' | 'reserved' | 'address_like';

/**
 * The form uniqueness is decided on.
 *
 * Trim, then lowercase. Deliberately NOT `toLocaleLowerCase`: under a Turkish
 * locale that maps `I` to `ı`, so the same input would normalize differently
 * depending on the server's locale — and a uniqueness key that depends on an
 * environment variable is not a uniqueness key.
 */
export function normalizeAliasName(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Would this handle be mistaken for a Stellar account?
 *
 * The check is deliberately loose — any long run of base32 opening with an
 * account-ish letter — because the harm is visual, not cryptographic. It does not
 * need to be a VALID address to be read as one in a confirmation dialog.
 */
export function looksLikeStellarAddress(normalized: string): boolean {
  return /^[gm][a-z2-7]{20,}$/.test(normalized);
}

/** Validate a normalized handle. `null` means it is claimable. */
export function validateAliasName(normalized: string): AliasNameError | null {
  if (normalized.length < ALIAS_MIN_LENGTH) return 'too_short';
  if (normalized.length > ALIAS_MAX_LENGTH) return 'too_long';
  if (!SHAPE.test(normalized)) return 'bad_characters';
  if (ALIAS_RESERVED.has(normalized)) return 'reserved';
  if (looksLikeStellarAddress(normalized)) return 'address_like';
  return null;
}

/** Human sentence for each refusal. The `code` on the error is the contract. */
export function aliasNameErrorMessage(err: AliasNameError): string {
  switch (err) {
    case 'too_short':
      return `An alias must be at least ${ALIAS_MIN_LENGTH} characters.`;
    case 'too_long':
      return `An alias may be at most ${ALIAS_MAX_LENGTH} characters.`;
    case 'bad_characters':
      return 'An alias may use a-z, 0-9 and underscores, and must start and end with a letter or digit.';
    case 'reserved':
      return 'That alias is reserved.';
    case 'address_like':
      return 'That alias would read as a Stellar address.';
  }
}

/**
 * Normalize an email to the form uniqueness and recovery are decided on.
 *
 * Lowercased and trimmed, and nothing cleverer: stripping dots or `+tags` is a
 * provider-specific rule that is wrong for most providers, and getting it wrong
 * here would silently merge two different people's recovery paths.
 */
export function normalizeAliasEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
