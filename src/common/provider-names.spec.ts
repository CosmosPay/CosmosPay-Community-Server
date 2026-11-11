import {
  neutralizeProviderNames,
  providerNamesIn,
  scrubUpstreamText,
} from '@/common/provider-names';

describe('neutralizeProviderNames', () => {
  it.each([
    [
      'NEAR Intents does not support asset "yXLM" on stellar.',
      'the cross-chain route does not support asset "yXLM" on stellar.',
    ],
    [
      'This BlindPay quote has expired. Request a new quote.',
      'This fiat partner quote has expired. Request a new quote.',
    ],
    [
      'Create a cross-chain swap: a NEAR Intents deposit address to pay',
      'Create a cross-chain swap: a cross-chain deposit address to pay',
    ],
    [
      'Trustless Work refused the request: amount must be a number',
      'the protected-payments service refused the request: amount must be a number',
    ],
    ['the OFT carries 6 decimals', 'the bridge contract carries 6 decimals'],
    ['outside an OFT limit', 'outside a bridge contract limit'],
    ["on your key's BlindPay instance", "on your key's fiat partner instance"],
    [
      'inbound BlindPay webhooks are verified',
      'inbound fiat partner webhooks are verified',
    ],
    ['Receivers and bank accounts (BlindPay).', 'Receivers and bank accounts.'],
    [
      'valued at NEAR Intents’ current reference price',
      'valued at the current market reference price',
    ],
    [
      "when NEAR Intents' quote is stale",
      "when the cross-chain route's quote is stale",
    ],
    ['Read a DeFindex vault', 'Read a yield vault'],
    [
      'swaps (Stellar path payments, Solana via Jupiter, Monad via Kuru Flow)',
      'swaps (Stellar path payments, Solana, Monad)',
    ],
    [
      'the assets that NEAR Intents lists',
      'the assets that the cross-chain route lists',
    ],
    ['a BlindPay-hosted page', 'a fiat partner-hosted page'],
    ['set NEAR_INTENTS_API_KEY.', 'set this deployment’s configuration.'],
    ['Quoted by El Dorado.', 'Quoted by the P2P marketplace.'],
  ])('%s', (input, expected) => {
    expect(neutralizeProviderNames(input, { startsSentence: false })).toBe(
      expected,
    );
  });

  it('starts a whole message with a capital', () => {
    expect(neutralizeProviderNames('Kuru Flow refused the request.')).toBe(
      'The Monad swap route refused the request.',
    );
    expect(neutralizeProviderNames('the OFT carries 6 decimals')).toBe(
      'The bridge contract carries 6 decimals',
    );
  });

  it('leaves text that names no provider untouched, the start of a sentence included', () => {
    const text = 'the asset code, as the ledger spells it.';
    expect(neutralizeProviderNames(text)).toBe(text);
  });

  it('leaves identifiers alone: field names, enum values, paths', () => {
    const text =
      '`blindpayId`, `transfers_bitso`, `jupiter` and /v1/defindex/submit';
    expect(neutralizeProviderNames(text)).toBe(text);
    expect(providerNamesIn(text)).toEqual([]);
  });

  it('is idempotent', () => {
    const once = neutralizeProviderNames(
      'BlindPay returned a payin quote without an id.',
    );
    expect(neutralizeProviderNames(once)).toBe(once);
  });
});

describe('providerNamesIn', () => {
  it('reports display names and env vars', () => {
    expect(
      providerNamesIn('Kuru Flow refused it; check KURU_MERCHANT_FEE_ROUTER.'),
    ).toEqual(
      expect.arrayContaining(['Kuru Flow', 'KURU_MERCHANT_FEE_ROUTER']),
    );
  });

  it('is empty once a text is neutralized', () => {
    const text =
      'DeFindex failures are 502; BlindPay (prod) is not configured: set BLINDPAY_INSTANCE_ID_PROD.';
    expect(providerNamesIn(neutralizeProviderNames(text))).toEqual([]);
  });
});

describe('scrubUpstreamText', () => {
  it('drops links and domains and replaces names in any case', () => {
    expect(
      scrubUpstreamText(
        'blindpay: quote expired, see https://docs.blindpay.com/errors#quote or api.blindpay.com',
      ),
    ).toBe('The fiat partner: quote expired, see or');
    expect(scrubUpstreamText('near_intents rejected the amount')).toBe(
      'The cross-chain route rejected the amount',
    );
  });

  it('leaves a reason that names nobody as it was, trimmed', () => {
    expect(scrubUpstreamText('  Amount is too low for bridge ')).toBe(
      'Amount is too low for bridge',
    );
  });
});
