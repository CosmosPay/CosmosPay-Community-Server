import { createHmac, hkdfSync } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import {
  PublicRecordTokens,
  recordToken,
  recordTokenKey,
  recordTokenMatches,
} from '@/common/public-record-token';
import {
  LEGACY_RECORD_TOKEN_ROUTES,
  PUBLIC_RECORD_KINDS,
} from '@/common/public-record-token.constants';

const SECRET = 'spec-gateway-secret-spec-gateway-secret';
const ID = 'cm1x2y3z4a5b6c7d8e9f0g1h2';

const consumer = (
  overrides: Partial<GatewayConsumer> = {},
): GatewayConsumer => ({
  username: 'cosmos_u1',
  credentialId: null,
  environment: 'prod',
  role: 'user',
  permissions: [],
  organizationId: null,
  plan: null,
  planSwapFeeBps: null,
  ...overrides,
});

describe('record tokens', () => {
  const key = recordTokenKey(SECRET);

  it('is HMAC-SHA256 of "<kind>:<id>" under an HKDF key labelled for this use, in base64url', () => {
    const expectedKey = Buffer.from(
      hkdfSync(
        'sha256',
        SECRET,
        'cosmos-public-record-token',
        'public-record-token v1',
        32,
      ),
    );
    expect(key.equals(expectedKey)).toBe(true);
    expect(recordToken(key, 'swap', ID)).toBe(
      createHmac('sha256', expectedKey)
        .update(`swap:${ID}`)
        .digest('base64url'),
    );
    expect(recordToken(key, 'swap', ID)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('is deterministic: the same record always gets the same token', () => {
    expect(recordToken(recordTokenKey(SECRET), 'usdt0-transfer', ID)).toBe(
      recordToken(key, 'usdt0-transfer', ID),
    );
  });

  it('separates kinds, ids and secrets', () => {
    const tokens = PUBLIC_RECORD_KINDS.map((kind) =>
      recordToken(key, kind, ID),
    );
    expect(new Set(tokens).size).toBe(PUBLIC_RECORD_KINDS.length);
    expect(recordToken(key, 'swap', `${ID}x`)).not.toBe(
      recordToken(key, 'swap', ID),
    );
    expect(recordToken(recordTokenKey(`${SECRET}!`), 'swap', ID)).not.toBe(
      recordToken(key, 'swap', ID),
    );
  });

  it('matches only the record’s own token', () => {
    const token = recordToken(key, 'cross-chain-swap', ID);
    expect(recordTokenMatches(key, 'cross-chain-swap', ID, token)).toBe(true);
    for (const presented of [
      undefined,
      '',
      token.slice(1),
      `${token}A`,
      recordToken(key, 'swap', ID),
      recordToken(key, 'cross-chain-swap', 'another-id'),
      token.toLowerCase() === token ? token.toUpperCase() : token.toLowerCase(),
    ]) {
      expect(recordTokenMatches(key, 'cross-chain-swap', ID, presented)).toBe(
        false,
      );
    }
  });

  it('refuses to derive a key from an empty secret', () => {
    expect(() => recordTokenKey('')).toThrow(/non-empty secret/);
  });
});

describe('PublicRecordTokens', () => {
  const tokens = new PublicRecordTokens({
    get: () => ({ publicConsumer: 'cosmos_public', gatewaySecret: SECRET }),
  } as never);
  const byRole = consumer({ username: 'cosmos_wallet', role: 'public' });
  const byName = consumer({ username: 'cosmos_public', role: null });
  const real = consumer();

  it('recognises the shared public key by the forwarded role or by its name, like PublicKeyGuard', () => {
    expect(tokens.isSharedPublicKey(byRole)).toBe(true);
    expect(tokens.isSharedPublicKey(byName)).toBe(true);
    expect(tokens.isSharedPublicKey(real)).toBe(false);
  });

  it('issues a token to the shared public key only', () => {
    expect(tokens.issueFor(byRole, 'swap', ID)).toBe(
      recordToken(recordTokenKey(SECRET), 'swap', ID),
    );
    expect(tokens.issueFor(real, 'swap', ID)).toBeUndefined();
    expect(tokens.attach(byName, 'chain-swap', { id: ID })).toEqual({
      id: ID,
      publicToken: recordToken(recordTokenKey(SECRET), 'chain-swap', ID),
    });
    expect(tokens.attach(real, 'chain-swap', { id: ID })).toEqual({ id: ID });
  });

  it('admits the shared public key only with the record’s token, and a real key always', () => {
    const token = tokens.issueFor(byRole, 'usdt0-transfer', ID);
    expect(tokens.admits(byRole, 'usdt0-transfer', ID, token)).toBe(true);
    expect(tokens.admits(byRole, 'usdt0-transfer', ID, undefined)).toBe(false);
    expect(tokens.admits(byRole, 'swap', ID, token)).toBe(false);
    expect(tokens.admits(byRole, 'usdt0-transfer', 'other', token)).toBe(false);
    expect(tokens.admits(real, 'usdt0-transfer', ID, undefined)).toBe(true);
  });
});

describe('PublicRecordTokens on the legacy routes (swap submit, cross-chain deposit)', () => {
  const ROUTE = LEGACY_RECORD_TOKEN_ROUTES.crossChainDeposit;
  const withSwitch = (requiredOnLegacy: boolean) =>
    new PublicRecordTokens({
      get: (key: string) =>
        key === 'publicRecordTokens'
          ? { requiredOnLegacy }
          : { publicConsumer: 'cosmos_public', gatewaySecret: SECRET },
    } as never);
  const shared = consumer({ username: 'cosmos_wallet', role: 'public' });
  const real = consumer();
  const token = recordToken(recordTokenKey(SECRET), 'cross-chain-swap', ID);

  afterEach(() => jest.restoreAllMocks());

  it('still admits a missing token while the switch is off, and never a wrong one', () => {
    const tokens = withSwitch(false);
    expect(
      tokens.admits(shared, 'cross-chain-swap', ID, undefined, ROUTE),
    ).toBe(true);
    expect(tokens.admits(shared, 'cross-chain-swap', ID, '', ROUTE)).toBe(true);
    expect(tokens.admits(shared, 'cross-chain-swap', ID, token, ROUTE)).toBe(
      true,
    );
    expect(
      tokens.admits(shared, 'cross-chain-swap', ID, 'x'.repeat(43), ROUTE),
    ).toBe(false);
    expect(
      tokens.admits(
        shared,
        'cross-chain-swap',
        ID,
        recordToken(recordTokenKey(SECRET), 'swap', ID),
        ROUTE,
      ),
    ).toBe(false);
    // Off a legacy route, a missing token is refused as before.
    expect(tokens.admits(shared, 'cross-chain-swap', ID, undefined)).toBe(
      false,
    );
  });

  it('refuses a missing token there too once PUBLIC_RECORD_TOKEN_REQUIRED_ON_LEGACY is on', () => {
    const tokens = withSwitch(true);
    expect(
      tokens.admits(shared, 'cross-chain-swap', ID, undefined, ROUTE),
    ).toBe(false);
    expect(tokens.admits(shared, 'cross-chain-swap', ID, token, ROUTE)).toBe(
      true,
    );
    expect(tokens.admits(real, 'cross-chain-swap', ID, undefined, ROUTE)).toBe(
      true,
    );
  });

  it('logs a structured deprecation warning for a missing token, naming the route and the record and no secret', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const tokens = withSwitch(false);

    tokens.noteLegacyAccess(shared, 'cross-chain-swap', ID, undefined, ROUTE);

    expect(warn).toHaveBeenCalledTimes(1);
    const [entry] = warn.mock.calls[0] as [Record<string, unknown>];
    expect(entry).toMatchObject({
      event: 'public_record_token_missing',
      deprecated: true,
      route: 'POST /v1/cross-chain-swaps/{id}/deposit',
      recordKind: 'cross-chain-swap',
      recordId: ID,
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(SECRET);
  });

  it('says nothing when the token was sent, or for a real key', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const tokens = withSwitch(false);
    tokens.noteLegacyAccess(shared, 'cross-chain-swap', ID, token, ROUTE);
    tokens.noteLegacyAccess(real, 'cross-chain-swap', ID, undefined, ROUTE);
    expect(warn).not.toHaveBeenCalled();
  });
});
