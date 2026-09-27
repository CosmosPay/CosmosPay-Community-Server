import type { CallbackOutcome } from '@/wallet-auth/wallet-auth.service';

/** Heading and body for each way a callback can end. */
const COPY: Record<CallbackOutcome['reason'], [string, string]> = {
  ok: [
    'You can go back to your wallet',
    'Your wallet is finishing the sign-in now. You can close this window.',
  ],
  expired: [
    'This window is already done',
    'This sign-in has expired or was already handled. Start again from your wallet.',
  ],
  denied: [
    'Sign-in cancelled',
    'The provider did not grant access. Go back to your wallet and try again.',
  ],
  email_unverified: [
    'That account has no verified email',
    'Verify your email with the provider, or sign in with an email code instead.',
  ],
  profile_invalid: [
    'Sign-in failed',
    'The provider did not return enough to identify you. Try another sign-in method.',
  ],
  failed: [
    'Sign-in failed',
    'The provider did not answer. Go back to your wallet and try again.',
  ],
};

/**
 * The page the person lands on when the provider returns their browser.
 *
 * It is the end of the browser's involvement. The wallet is already polling and
 * collects the identity over its own channel, by presenting the PKCE verifier
 * this browser never had.
 *
 * Deliberately inert: no identity, no token, no script, no external asset.
 * Rendering anything a sign-in is worth into a page in a browser this service
 * does not control would undo the reason the poll flow exists at all.
 *
 * English only, and that is a real limitation rather than an oversight: this
 * page is served to a browser mid-redirect, with no wallet in reach to say what
 * language the person chose. The wallet shows the outcome itself, translated,
 * the moment its poll comes back — this page is the thing in between.
 */
export function callbackPage(outcome: CallbackOutcome): string {
  const [heading, body] = COPY[outcome.reason] ?? COPY.failed;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${heading}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #f5f6f8; color: #16181d;
  }
  main { max-width: 26rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0; color: #55596a; }
  @media (prefers-color-scheme: dark) {
    body { background: #101216; color: #e9eaef; }
    p { color: #9aa0b0; }
  }
</style>
</head>
<body>
  <main>
    <h1>${heading}</h1>
    <p>${body}</p>
  </main>
</body>
</html>`;
}
