/**
 * How long a client or shared cache may keep the served public key, in seconds.
 *
 * Short on purpose: the key is served rather than only compiled into the wallet
 * so that a rotation takes effect quickly, and an hour-long cache would keep
 * handing out a key that is on its way to being deleted.
 */
export const PUBLIC_KEY_MAX_AGE_S = 300;
