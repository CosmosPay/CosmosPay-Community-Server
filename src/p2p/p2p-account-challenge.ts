/**
 * The text a wallet signs (EIP-191 `personal_sign`) to register with the P2P
 * market. It names everything the signature authorises: the address, the API
 * consumer and tier it registers under, a single-use nonce and an expiry. Its
 * first line is plain text, and `personal_sign`'s prefix already makes it
 * impossible to replay as a transaction; nothing else in the service asks a
 * wallet to sign this first line, so it cannot be replayed as another consent.
 */

export const P2P_CHALLENGE_TITLE = 'Cosmos Pay P2P market';

export interface P2pChallengeFields {
  address: string;
  consumer: string;
  tier: string;
  nonce: string;
  expiresAt: Date;
}

export function registrationMessage(fields: P2pChallengeFields): string {
  return [
    P2P_CHALLENGE_TITLE,
    `Register wallet: ${fields.address}`,
    `For: ${fields.consumer}`,
    `Tier: ${fields.tier}`,
    `Nonce: ${fields.nonce}`,
    `Expires: ${fields.expiresAt.toISOString()}`,
  ].join('\n');
}
