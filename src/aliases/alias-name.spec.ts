import {
  ALIAS_MAX_LENGTH,
  ALIAS_MIN_LENGTH,
  looksLikeStellarAddress,
  normalizeAliasEmail,
  normalizeAliasName,
  validateAliasName,
} from '@/aliases/alias-name';

/**
 * An alias is read by a human immediately before they authorise a payment, so the
 * rules under test are not formatting — they are what stops two names a person
 * cannot tell apart from both being claimable.
 */
describe('alias names', () => {
  it('folds case, so one name cannot be claimed twice', () => {
    // `Emanuel250` and `emanuel250` are indistinguishable in a confirmation
    // dialog. If both were claimable, the second is a trap for the first's payers.
    expect(normalizeAliasName('Emanuel250')).toBe('emanuel250');
    expect(normalizeAliasName('  EMANUEL250  ')).toBe('emanuel250');
    expect(normalizeAliasName('emanuel250')).toBe(
      normalizeAliasName('EmAnUeL250'),
    );
  });

  it('accepts the shapes people actually want', () => {
    for (const name of [
      'emanuel250',
      'ada',
      'a_b',
      'user_1',
      'x'.repeat(ALIAS_MAX_LENGTH),
    ]) {
      expect(validateAliasName(name)).toBeNull();
    }
  });

  it('bounds the length at both ends', () => {
    expect(validateAliasName('x'.repeat(ALIAS_MIN_LENGTH - 1))).toBe(
      'too_short',
    );
    expect(validateAliasName('x'.repeat(ALIAS_MAX_LENGTH + 1))).toBe(
      'too_long',
    );
  });

  it('refuses everything outside a-z 0-9 _', () => {
    // No Unicode, deliberately: the homoglyph set (Cyrillic а, Greek ο, a
    // zero-width joiner) is unbounded, and no normalization makes it safe to
    // render beside an amount.
    for (const name of [
      'emanuel-250',
      'ema nuel',
      'emanuél',
      'емануел',
      'e​manuel',
      'UPPER',
    ]) {
      expect(validateAliasName(name)).toBe('bad_characters');
    }
    // Underscores may not sit at either end, where they read as padding.
    expect(validateAliasName('_ada')).toBe('bad_characters');
    expect(validateAliasName('ada_')).toBe('bad_characters');
  });

  it('reserves the words that would impersonate us inside our own UI', () => {
    // "sending to @support" gives a payer no way to know it is a stranger.
    for (const name of [
      'support',
      'admin',
      'cosmospay',
      'official',
      'wallet',
    ]) {
      expect(validateAliasName(name)).toBe('reserved');
    }
  });

  it('refuses handles that would read as a Stellar address', () => {
    // The harm is visual, not cryptographic: it need not be a VALID address to be
    // mistaken for one in the dialog where the alias replaces the address.
    // A FULL address is refused by the length bound long before this rule, so the
    // rule is written for the case that is actually reachable: a handle short
    // enough to claim that still reads as an account id.
    const truncated = 'ga5zsejyb37jrc5avcia5m';
    expect(truncated.length).toBeLessThanOrEqual(ALIAS_MAX_LENGTH);
    expect(looksLikeStellarAddress(truncated)).toBe(true);
    expect(validateAliasName(truncated)).toBe('address_like');
    // The full one is still refused, just by the earlier rule.
    expect(
      validateAliasName(
        'ga5zsejyb37jrc5avcia5mop4rhtm335x2kgx3ihojapp5re34k4kzvn',
      ),
    ).toBe('too_long');
    // ...while an ordinary name starting with g is fine.
    expect(validateAliasName('grace')).toBeNull();
    expect(looksLikeStellarAddress('grace')).toBe(false);
  });

  it('normalizes an email without inventing provider rules', () => {
    expect(normalizeAliasEmail('  Someone@Example.COM ')).toBe(
      'someone@example.com',
    );
    // Dots and +tags are NOT stripped: that is a Gmail rule, wrong for most
    // providers, and merging two mailboxes here would merge two recovery paths.
    expect(normalizeAliasEmail('a.b+tag@example.com')).toBe(
      'a.b+tag@example.com',
    );
  });
});
