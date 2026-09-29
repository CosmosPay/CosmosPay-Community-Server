import {
  effectiveGrant,
  parsePluginConfig,
  validatePluginDefinition,
} from '@/plugins/plugin-manifest';
import { definePlugin, type PluginDefinition } from '@/plugins/sdk';

const valid = definePlugin({
  slug: 'acme-sync',
  name: 'Acme sync',
  version: '1.2.0',
  description: 'Syncs customers to Acme.',
  author: 'Acme Inc.',
  capabilities: ['customers:read', 'payment_intents:read'],
  egress: ['api.acme.example'],
  config: {
    apiKey: {
      type: 'string',
      description: 'Acme key',
      required: true,
      secret: true,
    },
    region: { type: 'string', description: 'Region' },
    batch: { type: 'number', description: 'Batch size' },
  },
  queries: { status: () => ({ ok: true }) },
  commands: { sync: () => null },
  events: { PAYMENT_INTENT_SUCCEEDED: () => undefined },
});

describe('validatePluginDefinition', () => {
  it('accepts a well-formed manifest', () => {
    expect(validatePluginDefinition(valid)).toEqual([]);
  });

  it.each<[string, Partial<PluginDefinition>, RegExp]>([
    ['a slug that is not URL-safe', { slug: 'Acme Sync' }, /slug must match/],
    ['a non-semver version', { version: 'latest' }, /semver/],
    [
      'an unknown capability',
      { capabilities: ['customers:delete' as never] },
      /unknown capability "customers:delete"/,
    ],
    [
      'a wildcard egress host',
      { egress: ['*.acme.example'] },
      /egress host "\*\.acme\.example"/,
    ],
    [
      'an IP egress host',
      { egress: ['10.0.0.1'] },
      /egress host "10\.0\.0\.1"/,
    ],
    [
      'an egress URL instead of a host',
      { egress: ['https://api.acme.example'] },
      /egress host/,
    ],
    [
      'a secret that is not a string',
      { config: { pin: { type: 'number', description: 'x', secret: true } } },
      /is secret, so it must be a string/,
    ],
    [
      'an action that is both a query and a command',
      { queries: { sync: () => null }, commands: { sync: () => null } },
      /both a query and a command/,
    ],
    [
      'an event it may not subscribe to',
      { events: { SWAP_SUCCEEDED: () => undefined } as never },
      /cannot subscribe to "SWAP_SUCCEEDED"/,
    ],
    [
      'an event without the capability to read it',
      { capabilities: ['customers:read'] },
      /needs the "payment_intents:read" capability/,
    ],
  ])('refuses %s', (_label, patch, message) => {
    const errors = validatePluginDefinition({ ...valid, ...patch });
    expect(errors.join('\n')).toMatch(message);
  });
});

describe('parsePluginConfig', () => {
  it('splits plain settings from secret ones', () => {
    const parsed = parsePluginConfig(valid, {
      apiKey: 'sk_live_1',
      region: 'eu',
      batch: 10,
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        plain: { region: 'eu', batch: 10 },
        secret: { apiKey: 'sk_live_1' },
      },
    });
  });

  it('refuses a missing required field, a wrong type and an unknown field', () => {
    const parsed = parsePluginConfig(valid, { batch: '10', regoin: 'eu' });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.errors).toEqual(
      expect.arrayContaining([
        'config.regoin is not a setting of this plugin',
        'config.apiKey is required',
        'config.batch must be a number',
      ]),
    );
  });
});

describe('effectiveGrant', () => {
  it('reports what a newer version asks for that was never granted', () => {
    expect(effectiveGrant(valid, ['customers:read', 'products:write'])).toEqual(
      {
        capabilities: ['customers:read'],
        missing: ['payment_intents:read'],
      },
    );
  });
});
