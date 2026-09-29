import { PluginRegistryService } from '@/plugins/plugin-registry.service';
import { definePlugin, type PluginDefinition } from '@/plugins/sdk';

const plain = definePlugin({
  slug: 'plain-one',
  name: 'Plain',
  version: '1.0.0',
  description: 'd',
  author: 'a',
  capabilities: [],
});

const withSecret = definePlugin({
  ...plain,
  slug: 'with-secret',
  config: { token: { type: 'string', description: 't', secret: true } },
});

function build(
  catalog: readonly PluginDefinition[],
  plugins: { enabled: string[]; secret: string },
) {
  const config = { get: () => plugins } as any;
  return new PluginRegistryService(catalog, config);
}

describe('PluginRegistryService', () => {
  it('serves only the plugins PLUGINS_ENABLED lists', () => {
    const registry = build([plain, withSecret], {
      enabled: ['plain-one'],
      secret: '',
    });
    expect(registry.list().map((p) => p.slug)).toEqual(['plain-one']);
    expect(registry.get('with-secret')).toBeUndefined();
  });

  it('refuses to boot on an enabled slug that is not in the catalog', () => {
    expect(() => build([plain], { enabled: ['ghost'], secret: '' })).toThrow(
      /PLUGINS_ENABLED lists "ghost"/,
    );
  });

  it('refuses to boot on an invalid manifest even when it is not enabled', () => {
    const broken = { ...plain, slug: 'Broken!' };
    expect(() => build([plain, broken], { enabled: [], secret: '' })).toThrow(
      /slug must match/,
    );
  });

  it('refuses to boot on a duplicated slug', () => {
    expect(() => build([plain, plain], { enabled: [], secret: '' })).toThrow(
      /in the catalog twice/,
    );
  });

  it('refuses to enable a plugin with secret settings without PLUGINS_SECRET', () => {
    expect(() =>
      build([withSecret], { enabled: ['with-secret'], secret: 'short' }),
    ).toThrow(/PLUGINS_SECRET must be set/);
    expect(() =>
      build([withSecret], {
        enabled: ['with-secret'],
        secret: 'x'.repeat(32),
      }),
    ).not.toThrow();
  });
});
