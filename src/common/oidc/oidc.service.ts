import { Injectable, Logger } from '@nestjs/common';
import {
  discoveryUrl,
  parseDiscovery,
  parseJwks,
  peekHeader,
  verifyIdToken,
  type IdTokenExpectations,
  type IdTokenResult,
  type Jwk,
  type OidcDiscovery,
} from '@/common/oidc/oidc-core';
import {
  OIDC_DISCOVERY_TTL_MS,
  OIDC_JWKS_REFRESH_MIN_MS,
  OIDC_JWKS_TTL_MS,
} from '@/common/oidc/oidc.constants';

interface Cached<T> {
  value: T;
  fetchedAt: number;
}

/**
 * The network half of OIDC: discovery and key sets, cached per issuer.
 *
 * Per-process caches, which is correct across replicas behind a load balancer:
 * every replica reads the same provider and converges on the same keys, and
 * nothing here is state a request depends on another replica having seen.
 *
 * Key rotation is handled the way providers expect: a token naming a `kid` this
 * process has not seen triggers ONE refetch of the key set, at most once per
 * `OIDC_JWKS_REFRESH_MIN_MS` — so a burst of tokens with a made-up `kid` costs
 * the provider one request, not one per token.
 */
@Injectable()
export class OidcService {
  private readonly logger = new Logger(OidcService.name);
  private readonly discoveries = new Map<string, Cached<OidcDiscovery>>();
  private readonly keySets = new Map<string, Cached<Jwk[]>>();

  /** The provider's endpoints. Throws when the provider cannot be reached or described. */
  async discover(issuer: string, timeoutMs: number): Promise<OidcDiscovery> {
    const hit = this.discoveries.get(issuer);
    if (hit && Date.now() - hit.fetchedAt < OIDC_DISCOVERY_TTL_MS)
      return hit.value;

    const doc = await this.getJson(discoveryUrl(issuer), timeoutMs);
    const parsed = parseDiscovery(doc, issuer);
    if (!parsed) {
      throw new Error(
        `OIDC discovery for ${issuer} is unusable (issuer mismatch or a non-https endpoint)`,
      );
    }
    this.discoveries.set(issuer, { value: parsed, fetchedAt: Date.now() });
    return parsed;
  }

  /**
   * Verify an ID token from `expect.issuer`.
   *
   * Transport failures THROW — the caller answers 503, because "we could not ask"
   * and "the token is bad" are different sentences. A token that is simply wrong
   * comes back as `{ ok: false }`.
   */
  async verify(
    token: string,
    expect: IdTokenExpectations,
    timeoutMs: number,
  ): Promise<IdTokenResult> {
    const discovery = await this.discover(expect.issuer, timeoutMs);
    let keys = await this.keys(discovery, timeoutMs, false);
    let result = verifyIdToken(token, keys, expect);

    if (!result.ok && result.error === 'unknown_key') {
      const kid = peekHeader(token)?.kid ?? null;
      const cached = this.keySets.get(discovery.jwksUri);
      const stale =
        !cached || Date.now() - cached.fetchedAt >= OIDC_JWKS_REFRESH_MIN_MS;
      // Only refetch for a kid we do not hold; a token with no kid that matched
      // nothing will not match anything newer either.
      if (kid && stale && !keys.some((k) => k.kid === kid)) {
        keys = await this.keys(discovery, timeoutMs, true);
        result = verifyIdToken(token, keys, expect);
      }
    }
    return result;
  }

  private async keys(
    discovery: OidcDiscovery,
    timeoutMs: number,
    force: boolean,
  ): Promise<Jwk[]> {
    const hit = this.keySets.get(discovery.jwksUri);
    if (!force && hit && Date.now() - hit.fetchedAt < OIDC_JWKS_TTL_MS)
      return hit.value;
    const keys = parseJwks(await this.getJson(discovery.jwksUri, timeoutMs));
    if (!keys.length)
      this.logger.warn(
        `OIDC key set at ${discovery.jwksUri} holds no usable key`,
      );
    this.keySets.set(discovery.jwksUri, { value: keys, fetchedAt: Date.now() });
    return keys;
  }

  private async getJson(url: string, timeoutMs: number): Promise<unknown> {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      // A provider that redirects its discovery document somewhere else is a
      // provider whose answer this service did not ask for.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res.json();
  }
}
