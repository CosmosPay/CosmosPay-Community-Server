import {
  generateSigningKey,
  parseTrustedKeys,
  signPlugin,
  verifyPluginSignature,
} from '@/plugins/plugin-signature';

describe('plugin signatures', () => {
  const registry = generateSigningKey();
  const other = generateSigningKey();
  const trusted = parseTrustedKeys(`registry:${registry.publicX}`);
  const files = {
    manifest: '{ "slug": "acme", "version": "1.0.0", "capabilities": [] }',
    source: 'export default {};\n',
  };
  const meta = { slug: 'acme', version: '1.0.0', keyId: 'registry' };
  const expected = { slug: 'acme', version: '1.0.0' };

  it('verifies the files a trusted key signed', () => {
    const sig = signPlugin(files, meta, registry.privatePem);
    expect(verifyPluginSignature(files, sig, trusted, expected)).toBeNull();
  });

  it('names the file that changed', () => {
    const sig = signPlugin(files, meta, registry.privatePem);
    expect(
      verifyPluginSignature(
        { ...files, source: 'export default { evil: 1 };\n' },
        sig,
        trusted,
        expected,
      ),
    ).toBe('index.ts changed after signing');
    expect(
      verifyPluginSignature(
        {
          ...files,
          manifest:
            '{ "slug": "acme", "version": "1.0.0", "capabilities": ["customers:write"] }',
        },
        sig,
        trusted,
        expected,
      ),
    ).toBe('plugin.json changed after signing');
  });

  it('ignores what does not change the plugin: JSON formatting and CRLF', () => {
    const sig = signPlugin(files, meta, registry.privatePem);
    expect(
      verifyPluginSignature(
        {
          manifest:
            '{\n  "capabilities": [],\n  "version": "1.0.0",\n  "slug": "acme"\n}\n',
          source: 'export default {};\r\n',
        },
        sig,
        trusted,
        expected,
      ),
    ).toBeNull();
  });

  it('refuses a key it does not trust, even under a trusted key id', () => {
    const sig = signPlugin(files, meta, other.privatePem);
    expect(verifyPluginSignature(files, sig, trusted, expected)).toMatch(
      /does not verify/,
    );
  });

  it('refuses a signer nobody listed', () => {
    const sig = signPlugin(
      files,
      { ...meta, keyId: 'stranger' },
      other.privatePem,
    );
    expect(verifyPluginSignature(files, sig, trusted, expected)).toMatch(
      /neither a support key nor in PLUGINS_TRUSTED_KEYS/,
    );
  });

  it('refuses a signature moved to another slug or version', () => {
    const sig = signPlugin(files, meta, registry.privatePem);
    expect(
      verifyPluginSignature(files, sig, trusted, { ...expected, slug: 'b' }),
    ).toMatch(/not b@1\.0\.0/);
    expect(
      verifyPluginSignature(files, sig, trusted, {
        ...expected,
        version: '2.0.0',
      }),
    ).toMatch(/not acme@2\.0\.0/);
    // Editing the version inside the signature file breaks the signature.
    expect(
      verifyPluginSignature(files, { ...sig, version: '2.0.0' }, trusted, {
        ...expected,
        version: '2.0.0',
      }),
    ).toMatch(/does not verify/);
  });

  it('refuses a malformed signature file', () => {
    expect(
      verifyPluginSignature(files, { format: 'x' }, trusted, expected),
    ).toMatch(/malformed/);
    expect(verifyPluginSignature(files, null, trusted, expected)).toMatch(
      /malformed/,
    );
  });

  it('parses PLUGINS_TRUSTED_KEYS strictly', () => {
    expect(parseTrustedKeys('')).toEqual([]);
    expect(() => parseTrustedKeys('no-colon')).toThrow(/keyId/);
    expect(() => parseTrustedKeys('k:dG9vc2hvcnQ')).toThrow(/32-byte/);
    expect(() =>
      parseTrustedKeys(`a:${registry.publicX},a:${other.publicX}`),
    ).toThrow(/twice/);
  });
});
