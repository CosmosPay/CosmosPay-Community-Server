import { isInternalCall, resolveAdminPrincipal } from '@/admin/admin-auth';
import {
  DEFAULT_ADMIN_ACTOR_ID,
  DEFAULT_ADMIN_ACTOR_ROLE,
} from '@/admin/admin.constants';
import { signConsoleMarker } from '@/admin/console-marker';

const SECRET = 'topsecret-topsecret-topsecret-topsecret';
const NOW = 1_790_000_000_000;
const MARKER = signConsoleMarker(SECRET, NOW);

/** The context the guard builds for a console call, minus what a case varies. */
function consoleCall(extra: Record<string, unknown> = {}) {
  return { internal: MARKER, gatewaySecret: SECRET, nowMs: NOW, ...extra };
}

/**
 * The admin surface is gated on "did this come from the platform console?",
 * not on a per-service admin secret. These cases pin what that question means.
 */
describe('resolveAdminPrincipal', () => {
  it('returns null without the internal marker — an API-key call is not admin', () => {
    expect(
      resolveAdminPrincipal({
        consumer: 'cosmos_u1',
        gatewaySecret: SECRET,
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it('returns null for the old bare marker a misrouted request could carry', () => {
    // The literal `1` was the whole proof once; a route that forgot to strip the
    // header handed admin to any API key. It must stay a no-op.
    expect(
      resolveAdminPrincipal(
        consoleCall({ internal: '1', consumer: 'cosmos_u1' }),
      ),
    ).toBeNull();
  });

  it('returns null for the legacy plaintext X-Cosmos-Admin marker', () => {
    // It was never read here, and reviving it must stay a no-op.
    expect(
      resolveAdminPrincipal({
        consumer: 'cosmos_u1',
        actorRole: 'owner',
        gatewaySecret: SECRET,
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it('accepts a console call and attributes it to the console account', () => {
    expect(
      resolveAdminPrincipal(
        consoleCall({ actorRole: 'owner', consumer: 'cosmos_u1' }),
      ),
    ).toEqual({ id: 'cosmos_u1', role: 'owner' });
  });

  it('accepts a header array (Express may hand back either shape)', () => {
    expect(
      resolveAdminPrincipal(
        consoleCall({
          internal: [MARKER],
          actorRole: ['admin'],
          consumer: 'cosmos_u2',
        }),
      ),
    ).toEqual({ id: 'cosmos_u2', role: 'admin' });
  });

  it('normalizes the asserted role case-insensitively', () => {
    expect(
      resolveAdminPrincipal(
        consoleCall({ actorRole: 'OWNER', consumer: 'cosmos_u1' }),
      )?.role,
    ).toBe('owner');
  });

  it('falls back to the default label for an unknown role, without denying', () => {
    // The role is audit metadata, not a gate: the console already decided.
    expect(
      resolveAdminPrincipal(
        consoleCall({ actorRole: 'wizard', consumer: 'cosmos_u1' }),
      ),
    ).toEqual({ id: 'cosmos_u1', role: DEFAULT_ADMIN_ACTOR_ROLE });
  });

  it('falls back to the default actor id when no consumer was forwarded', () => {
    expect(resolveAdminPrincipal(consoleCall())).toEqual({
      id: DEFAULT_ADMIN_ACTOR_ID,
      role: DEFAULT_ADMIN_ACTOR_ROLE,
    });
  });
});

describe('isInternalCall', () => {
  it('accepts a fresh marker keyed by the gateway secret', () => {
    expect(isInternalCall(MARKER, SECRET, NOW)).toBe(true);
  });

  it.each(['1', 'true', 'yes', 'internal', '0', 'false', '', '   ', undefined])(
    'rejects %p',
    (value) => {
      expect(isInternalCall(value, SECRET, NOW)).toBe(false);
    },
  );

  it('rejects a valid marker when the service holds a different secret', () => {
    expect(isInternalCall(MARKER, 'another-gateway-secret-entirely', NOW)).toBe(
      false,
    );
  });

  it('trims the header like every other forwarded value', () => {
    expect(isInternalCall(`  ${MARKER}  `, SECRET, NOW)).toBe(true);
  });
});
