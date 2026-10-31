import {
  AUTHENTIK_SOURCE_LABEL_MAX,
  AUTHENTIK_SOURCE_SLUG,
} from '@/wallet-auth/wallet-auth.constants';

/** One Authentik source a wallet lists as its own sign-in button. */
export interface OidcSource {
  /**
   * Names the button's flow, `wallet-source-{slug}`: a source's slug in Authentik
   * (`/source/oauth/login/{slug}/`), or `email` for the emailed sign-in link, which is
   * a flow of its own rather than a source.
   */
  slug: string;
  /** What the button says: the provider's own name, e.g. `Google`. */
  name: string;
}

/**
 * `WALLET_AUTH_OIDC_SOURCES`: the Authentik sources a wallet shows as buttons of their
 * own, as comma-separated `slug:Label` pairs — `google:Google,github:GitHub,email:Email`
 * (`email`: Authentik's emailed sign-in link, see `AUTHENTIK_INBOX_PROVEN_CLAIM`).
 *
 * Listed by the operator rather than read from Authentik's API: that would need an
 * admin token on this service for one list that changes when the operator adds a
 * source anyway — and adding one also means adding its `wallet-source-{slug}` flow.
 */
export function parseOidcSources(raw: string | undefined): OidcSource[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const colon = entry.indexOf(':');
      return colon < 0
        ? { slug: entry, name: '' }
        : {
            slug: entry.slice(0, colon).trim(),
            name: entry.slice(colon + 1).trim(),
          };
    });
}

/** Why an entry cannot be offered, or null when it can. Checked at boot. */
export function oidcSourceProblem(source: OidcSource): string | null {
  if (!AUTHENTIK_SOURCE_SLUG.test(source.slug)) {
    return 'has a slug that is not lowercase letters, digits and dashes';
  }
  if (!source.name) return 'has no label (write it as slug:Label)';
  if (source.name.length > AUTHENTIK_SOURCE_LABEL_MAX) {
    return `has a label longer than ${AUTHENTIK_SOURCE_LABEL_MAX} characters`;
  }
  return null;
}
