import {
  ASSET_REGISTRY,
  ASSET_REGISTRY_VERSION,
  type RegistryNetwork,
} from '@/assets/assets.constants';
import { AssetsService } from '@/assets/assets.service';

const NETWORKS = Object.keys(ASSET_REGISTRY) as RegistryNetwork[];
const ACCOUNT_ID = /^G[A-Z2-7]{55}$/;
const CONTRACT_ID = /^C[A-Z2-7]{55}$/;
const ASSET_CODE = /^[A-Za-z0-9]{1,12}$/;

/**
 * Verified rows whose identity does not rest on a home_domain. Each one is a
 * deliberate exception explained next to the row — adding to this list must be
 * a conscious decision, not something a new entry slips into by accident.
 */
const VERIFIED_WITHOUT_DOMAIN = ['public:USDT0', 'testnet:USDB'];

describe('ASSET_REGISTRY', () => {
  it('has a positive integer version', () => {
    expect(Number.isInteger(ASSET_REGISTRY_VERSION)).toBe(true);
    expect(ASSET_REGISTRY_VERSION).toBeGreaterThan(0);
  });

  describe.each(NETWORKS)('%s', (network) => {
    const assets = ASSET_REGISTRY[network];

    it('starts with native XLM, the only entry without an issuer', () => {
      expect(assets[0]).toMatchObject({ code: 'XLM', issuer: null });
      expect(assets.slice(1).every((a) => a.issuer !== null)).toBe(true);
    });

    it('lists each (code, issuer) pair once', () => {
      const keys = assets.map((a) => `${a.code}:${a.issuer ?? 'native'}`);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('uses well-formed codes, issuers and contract ids', () => {
      for (const asset of assets.slice(1)) {
        expect(asset.code).toMatch(ASSET_CODE);
        expect(asset.issuer).toMatch(ACCOUNT_ID);
        if (asset.contract !== null)
          expect(asset.contract).toMatch(CONTRACT_ID);
        expect(asset.name.length).toBeGreaterThan(0);
        expect(asset.issuerName.length).toBeGreaterThan(0);
      }
    });

    it('backs every verified issuer with a domain unless explicitly excepted', () => {
      const exceptions = assets
        .filter((a) => a.verified && a.issuer !== null && !a.issuerDomain)
        .map((a) => `${network}:${a.code}`);
      expect(
        exceptions.every((key) => VERIFIED_WITHOUT_DOMAIN.includes(key)),
      ).toBe(true);
    });
  });
});

describe('AssetsService', () => {
  const service = new AssetsService();

  it('puts verified entries first and keeps registry order within each group', () => {
    const rows = service.list('public');
    const firstUnverified = rows.findIndex((a) => !a.verified);
    expect(firstUnverified).toBeGreaterThan(0);
    expect(rows.slice(firstUnverified).every((a) => !a.verified)).toBe(true);
    expect(rows[0].code).toBe('XLM');
    expect(rows[1].code).toBe('USDC');
  });

  it('filters to verified entries on request', () => {
    const rows = service.list('public', true);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((a) => a.verified)).toBe(true);
  });

  it('exposes the registry version', () => {
    expect(service.version).toBe(ASSET_REGISTRY_VERSION);
  });
});
