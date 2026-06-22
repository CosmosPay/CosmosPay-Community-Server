/**
 * Identity forwarded by APISIX after a successful `key-auth` validation.
 * Attached to the request by ApisixContextMiddleware and enforced by ApisixGuard.
 */
export interface GatewayConsumer {
  /** APISIX consumer username, e.g. `cosmos_<userId>` (X-Consumer-Username). */
  username: string;
  /** Credential id that authenticated, e.g. `cosmos_<uuid>` (X-Credential-Identifier). */
  credentialId: string | null;
  /**
   * API key environment forwarded by the gateway (derived from the key prefix:
   * `dv_` → 'dev', `prod_` → 'prod'). Determines the Stellar network the intent
   * targets. Null when not forwarded (local dev without the gateway).
   */
  environment: 'dev' | 'prod' | null;
}

declare module 'express' {
  // Augment Express' Request so the rest of the app can read req.gatewayConsumer.
  interface Request {
    gatewayConsumer?: GatewayConsumer;
  }
}
