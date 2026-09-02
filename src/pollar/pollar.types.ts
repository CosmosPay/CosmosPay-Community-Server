/**
 * The slices of Pollar's API we actually read, transcribed from its published
 * OpenAPI schema. Only the fields this service consumes are declared — a
 * narrower type than the wire format, so a Pollar release that adds a field
 * cannot break the build, while one that removes a field we read does.
 */

/** `POST /auth/session` — opens a client session for a login flow. */
export interface PollarClientSession {
  clientSessionId: string;
}

/** `GET /auth/session/status/{id}/poll` — has the provider come back yet? */
export interface PollarSessionStatus {
  status: string;
  user?: { ready?: boolean };
}

/** One wallet on a Pollar session. */
export interface PollarWallet {
  type: 'internal' | 'smart' | 'external';
  provider?: string;
  publicKey?: string | null;
  address?: string | null;
  chain?: 'STELLAR' | 'POLYGON' | 'SOLANA';
  existsOnStellar?: boolean;
  fundingMode?: 'IMMEDIATE' | 'DEFERRED';
  network?: string;
}

export interface PollarTokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** `POST /auth/login` — the ready client session traded for a real session. */
export interface PollarLoginContent {
  clientSessionId: string;
  userId: string | null;
  status: string;
  token: PollarTokenSet;
  user?: { id?: string; ready?: boolean };
  wallet: PollarWallet;
  wallets?: PollarWallet[];
  data?: {
    mail?: string;
    first_name?: string;
    last_name?: string;
    avatar?: string;
  };
}

/** `POST /auth/refresh`. */
export interface PollarRefreshContent {
  token: PollarTokenSet;
}

/** `POST /auth/logout`. */
export interface PollarLogoutContent {
  revoked: number;
}

/** `POST /v1/wallets/activate` — the XLM reserve funded on-chain. */
export interface PollarActivationContent {
  publicKey: string;
  /** XLM funded: 1 base + 0.5 per configured asset. */
  amount: string;
}

/** `POST /v1/tokens/verify` — an SDK access token checked server-side. */
export interface PollarTokenVerifyContent {
  userId: string;
  applicationId: string;
  expiresAt: number;
  network?: string;
  wallet?: PollarWallet;
  profile?: Record<string, unknown>;
  authProvider?: string;
}
