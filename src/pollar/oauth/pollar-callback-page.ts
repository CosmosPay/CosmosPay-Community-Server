import type { PollarCallbackOutcome } from '@/pollar/oauth/pollar-oauth.service';

/**
 * The page a user lands on when their wallet opened the login in a browser and
 * registered no redirect URI — the poll flow. It is the end of the browser's
 * involvement: the wallet is already asking the bridge whether the user came
 * back, and collects its code over its own authenticated channel.
 *
 * Deliberately inert: no code, no token, no script, no external asset. Rendering
 * a single-use credential into a page in a browser this service does not control
 * would undo the reason the poll flow exists.
 */
export function renderCallbackPage(outcome: PollarCallbackOutcome): string {
  const heading =
    outcome.outcome === 'authorized'
      ? 'You are signed in'
      : 'This window is already done';
  const body =
    outcome.outcome === 'authorized'
      ? 'Return to your wallet — it is finishing the sign-in now. You can close this window.'
      : 'This sign-in has already been handled. You can close this window.';

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
