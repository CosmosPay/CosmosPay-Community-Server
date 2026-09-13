import { isInternalCall, resolveAdminPrincipal } from '@/admin/admin-auth';
import {
  DEFAULT_ADMIN_ACTOR_ID,
  DEFAULT_ADMIN_ACTOR_ROLE,
} from '@/admin/admin.constants';

/**
 * The admin surface is gated on "did this come from the platform console?",
 * not on a per-service admin secret. These cases pin what that question means.
 */
describe('resolveAdminPrincipal', () => {
  it('returns null without the internal marker — an API-key call is not admin', () => {
    expect(resolveAdminPrincipal({ consumer: 'cosmos_u1' })).toBeNull();
  });

  it('returns null for the legacy plaintext X-Cosmos-Admin marker', () => {
    // It was never read here, and reviving it must stay a no-op.
    expect(
      resolveAdminPrincipal({
        consumer: 'cosmos_u1',
        actorRole: 'owner',
      }),
    ).toBeNull();
  });

  it('accepts a console call and attributes it to the console account', () => {
    expect(
      resolveAdminPrincipal({
        internal: '1',
        actorRole: 'owner',
        consumer: 'cosmos_u1',
      }),
    ).toEqual({ id: 'cosmos_u1', role: 'owner' });
  });

  it('accepts a header array (Express may hand back either shape)', () => {
    expect(
      resolveAdminPrincipal({
        internal: ['1'],
        actorRole: ['admin'],
        consumer: 'cosmos_u2',
      }),
    ).toEqual({ id: 'cosmos_u2', role: 'admin' });
  });

  it('normalizes the asserted role case-insensitively', () => {
    expect(
      resolveAdminPrincipal({
        internal: '1',
        actorRole: 'OWNER',
        consumer: 'cosmos_u1',
      })?.role,
    ).toBe('owner');
  });

  it('falls back to the default label for an unknown role, without denying', () => {
    // The role is audit metadata, not a gate: the console already decided.
    expect(
      resolveAdminPrincipal({
        internal: '1',
        actorRole: 'wizard',
        consumer: 'cosmos_u1',
      }),
    ).toEqual({ id: 'cosmos_u1', role: DEFAULT_ADMIN_ACTOR_ROLE });
  });

  it('falls back to the default actor id when no consumer was forwarded', () => {
    expect(resolveAdminPrincipal({ internal: '1' })).toEqual({
      id: DEFAULT_ADMIN_ACTOR_ID,
      role: DEFAULT_ADMIN_ACTOR_ROLE,
    });
  });
});

describe('isInternalCall', () => {
  it.each(['1', 'true', 'yes', 'internal'])('accepts %p', (value) => {
    expect(isInternalCall(value)).toBe(true);
  });

  it.each(['0', 'false', 'no', 'off', '', '   ', undefined])(
    'rejects %p',
    (value) => {
      expect(isInternalCall(value)).toBe(false);
    },
  );

  it('is case-insensitive about the negatives', () => {
    expect(isInternalCall('FALSE')).toBe(false);
  });
});
