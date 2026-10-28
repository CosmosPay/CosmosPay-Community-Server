import { createHash } from 'node:crypto';
import { CALLBACK_CLOSE_SCRIPT } from '@/wallet-auth/wallet-auth.constants';
import {
  CALLBACK_PAGE_CSP,
  callbackPage,
} from '@/wallet-auth/wallet-auth-page';

describe('callbackPage', () => {
  it('closes the window the wallet opened, with the one script its CSP allows', () => {
    const html = callbackPage({ ok: true, reason: 'ok', redirectTo: null });
    expect(html).toContain(`<script>${CALLBACK_CLOSE_SCRIPT}</script>`);
    const hash = createHash('sha256')
      .update(CALLBACK_CLOSE_SCRIPT)
      .digest('base64');
    expect(CALLBACK_PAGE_CSP).toContain(`script-src 'sha256-${hash}'`);
    // Exactly one script, and nothing it could load.
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(CALLBACK_PAGE_CSP).toContain("default-src 'none'");
  });

  it('still says what happened where a browser refuses to close it', () => {
    expect(
      callbackPage({ ok: false, reason: 'denied', redirectTo: null }),
    ).toContain('Sign-in cancelled');
  });

  it('carries no identity or state into the page', () => {
    const html = callbackPage({ ok: true, reason: 'ok', redirectTo: null });
    // No `state`, no token, no email address (the CSS's `@media` is not one).
    expect(html).not.toMatch(/state=|token|[\w.]+@[\w-]+\.\w+/);
  });
});
