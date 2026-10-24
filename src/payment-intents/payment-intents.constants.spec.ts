import {
  CHECKOUT_THEMES,
  DEFAULT_CHECKOUT_THEME,
  effectiveCheckoutTheme,
  isCheckoutTheme,
} from '@/payment-intents/payment-intents.constants';

describe('checkout themes', () => {
  it('are the four designs the hosted checkout page draws', () => {
    expect(CHECKOUT_THEMES).toEqual(['classic', 'split', 'ticket', 'card']);
    expect(DEFAULT_CHECKOUT_THEME).toBe('classic');
  });

  it.each(CHECKOUT_THEMES)('reads a stored %s as itself', (theme) => {
    expect(isCheckoutTheme(theme)).toBe(true);
    expect(effectiveCheckoutTheme(theme)).toBe(theme);
  });

  it('reads an intent stored with none (null) as the default', () => {
    expect(effectiveCheckoutTheme(null)).toBe('classic');
  });

  it.each(['retired-design', 'Ticket', ''])(
    'reads a stored %j it does not draw as the default',
    (stored) => {
      // A design removed from the list must not leave its intents without a
      // page: the column is free text, so the read side is the safety net.
      expect(isCheckoutTheme(stored)).toBe(false);
      expect(effectiveCheckoutTheme(stored)).toBe('classic');
    },
  );
});
