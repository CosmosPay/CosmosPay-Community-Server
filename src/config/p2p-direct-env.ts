/**
 * Boot-time rule for the P2P direct flow (native plugin `eldorado`): a payment
 * request paid from the payer's page through the marketplace's API.
 *
 * `P2P_DIRECT_SESSION_SECRET` seals the payer's marketplace session (their
 * bearer token) into the opaque `X-Payer-Session` the page holds. It is
 * optional (without it the flow is off), but a value that is set must carry at
 * least 32 random bytes, spelled in hex or base64: a short or placeholder
 * secret would be a forgeable session that still looked configured.
 *
 * Reads the RAW environment, like `identity-env.ts`.
 */

/** The fewest bytes a session secret decodes to. */
export const P2P_DIRECT_SESSION_SECRET_MIN_BYTES = 32;

const PLACEHOLDER =
  /replace[-_ ]?(with|me)|change[-_ ]?me|your[-_ ]?secret|placeholder/i;

/**
 * The bytes a session secret spells, or null when it is not hex or base64
 * (base64url too) of at least {@link P2P_DIRECT_SESSION_SECRET_MIN_BYTES}.
 * Hex is read first: an even run of hex digits is hex, not base64.
 */
export function parseP2pDirectSessionSecret(raw: string): Buffer | null {
  const value = raw.trim();
  let bytes: Buffer | null = null;
  if (/^(?:[0-9a-fA-F]{2})+$/.test(value)) {
    bytes = Buffer.from(value, 'hex');
  } else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    bytes = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }
  return bytes && bytes.length >= P2P_DIRECT_SESSION_SECRET_MIN_BYTES
    ? bytes
    : null;
}

/** Refuses a `P2P_DIRECT_SESSION_SECRET` that is set but malformed, short or a placeholder. */
export function assertP2pDirectConfigConsistent(
  env: Record<string, unknown>,
): void {
  const raw = env.P2P_DIRECT_SESSION_SECRET;
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return;
  if (PLACEHOLDER.test(value)) {
    throw new Error('P2P_DIRECT_SESSION_SECRET is still a placeholder.');
  }
  if (!parseP2pDirectSessionSecret(value)) {
    throw new Error(
      `P2P_DIRECT_SESSION_SECRET must be at least ${P2P_DIRECT_SESSION_SECRET_MIN_BYTES} bytes, in base64 or hex (openssl rand -base64 32).`,
    );
  }
}
