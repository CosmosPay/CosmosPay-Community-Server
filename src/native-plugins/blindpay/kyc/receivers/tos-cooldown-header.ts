/**
 * PARSE the dev platform's ToS email-resend cooldown headers — `X-Cosmos-Internal: 1`
 * marks the call as dashboard-internal and `X-Cosmos-Tos-Cooldown-Ms` carries the
 * role-derived value (owner → 0, admin → 60000). Returns undefined for a missing or
 * invalid pair, which means "use the 24h default".
 *
 * It lives beside the receivers service rather than inside it because two controllers
 * read these headers — the tenant `ReceiversController` and the platform
 * `AdminController` — and a controller importing a header parser out of a service file
 * dragged the whole service (Prisma, BlindPay, the sync service) into the admin
 * controller's import graph for one pure function.
 *
 * This function authorizes NOTHING. It used to document the headers as unforgeable
 * because APISIX strips them, but that is gateway configuration this repository cannot
 * verify — and a header that shortens a rate limit protecting a KYC subject's inbox must
 * not be the thing granting the privilege. Callers establish privilege first and only
 * then parse: `ReceiversService.requestTos` discards the parsed value unless
 * `isElevatedConsumer` holds for the gateway consumer, and `AdminController` runs
 * behind `AdminGuard`.
 *
 * On that admin path the two are now the same fact — `AdminGuard` reads the same internal
 * marker (plus the gateway secret `ApisixGuard` verified) — so the separation this
 * function relies on holds for tenant keys, not for the console. That is why the console
 * is the narrower of the two doors: a tenant key reaches `requestTos`, only a caller
 * holding the gateway secret reaches `AdminController` at all, and everything it does
 * there lands in the admin audit trail under the console account that did it.
 */
export function resolveTosCooldownMs(
  internalHeader?: string | string[],
  cooldownHeader?: string | string[],
): number | undefined {
  const internal =
    (Array.isArray(internalHeader) ? internalHeader[0] : internalHeader) ===
    '1';
  if (!internal) return undefined;
  const raw = Array.isArray(cooldownHeader)
    ? cooldownHeader[0]
    : cooldownHeader;
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
