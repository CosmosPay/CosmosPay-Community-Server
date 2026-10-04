import { LUA_SAFE_RE } from '@/gateway-keys/gateway-keys.constants';

/**
 * What the gateway forwards for one credential. Short keys because the map is
 * baked into a Lua function body on every consumer write.
 */
export interface ForwardEntry {
  /** Scopes, as the JSON array `X-Consumer-Permissions` carries. */
  p: string;
  /** Role: always `user` for a wallet key. */
  r: 'user';
  /** `dev` → testnet, `prod` → public. */
  e: 'dev' | 'prod';
  /** Organization label, plan and plan swap commission (bps). */
  o: string;
  pl: string;
  f: number;
  /** The account's verified email, or "" — which fails any binding check closed. */
  em: string;
}

/** A value fit for the Lua long string, or "" when it is not. */
export function luaSafe(value: string): string {
  return LUA_SAFE_RE.test(value) ? value : '';
}

/**
 * The consumer-level `serverless-pre-function` that turns the key that
 * authenticated into the `X-Consumer-*` headers this service reads.
 *
 * The same plugin the developer platform bakes, byte for byte in behaviour, so
 * a consumer minted here and one minted there look identical upstream. It lives
 * on the CONSUMER because APISIX credentials accept only auth plugins, and it
 * switches on `ctx.consumer.credential_id`. Every header is SET, never appended,
 * so a client copy never survives — the swap commission in particular is the
 * plan's, and a request must not be able to undercut it.
 */
export function consumerForwardingPlugin(map: Record<string, ForwardEntry>) {
  const mapJson = JSON.stringify(map);
  return {
    phase: 'access',
    functions: [
      `
return function(conf, ctx)
  local cjson = require("cjson.safe")
  local map = cjson.decode([==[${mapJson}]==]) or {}
  local cid = ctx.consumer and ctx.consumer.credential_id
  local entry = cid and map[cid]
  if entry then
    ngx.req.set_header("X-Consumer-Permissions", entry.p or "[]")
    ngx.req.set_header("X-Consumer-Role", entry.r or "user")
    ngx.req.set_header("X-Consumer-Env", entry.e or "dev")
    ngx.req.set_header("X-Consumer-Org", entry.o or "")
    ngx.req.set_header("X-Consumer-Plan", entry.pl or "")
    ngx.req.set_header("X-Plan-Swap-Fee-Bps", (entry.f ~= nil) and tostring(entry.f) or "")
    ngx.req.set_header("X-Consumer-Email", entry.em or "")
  end
end
`,
    ],
  };
}
