import configuration, { nativePluginEnabled } from '@/config/configuration';

describe('PLUGINS_ENABLED', () => {
  const saved = process.env.PLUGINS_ENABLED;
  afterEach(() => {
    process.env.PLUGINS_ENABLED = saved;
  });

  it('splits native plugins from the sandboxed ones in plugins/', () => {
    process.env.PLUGINS_ENABLED = ' example , blindpay,defindex,acme-sync ';
    const { plugins } = configuration();
    expect(plugins.enabled).toEqual(['example', 'acme-sync']);
    expect(plugins.native).toEqual(['blindpay', 'defindex']);
  });

  it('serves no native plugin by default', () => {
    delete process.env.PLUGINS_ENABLED;
    expect(configuration().plugins.native).toEqual([]);
    expect(nativePluginEnabled('blindpay')({})).toBe(false);
  });

  it('decides a native plugin’s module from the list alone', () => {
    expect(
      nativePluginEnabled('blindpay')({ PLUGINS_ENABLED: 'blindpay' }),
    ).toBe(true);
    expect(
      nativePluginEnabled('defindex')({ PLUGINS_ENABLED: 'blindpay' }),
    ).toBe(false);
    // A slug that merely contains the name is not the name.
    expect(
      nativePluginEnabled('blindpay')({ PLUGINS_ENABLED: 'blindpay-extra' }),
    ).toBe(false);
  });
});
