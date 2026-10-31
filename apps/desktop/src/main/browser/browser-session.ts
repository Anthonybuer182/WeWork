/**
 * Keep the embedded browser signed in across app restarts.
 *
 * Chromium deliberately does not write session cookies (cookies without an
 * expiration) to disk. Many webmail/admin sites — Aliyun Mail, for one — keep
 * their *auth* cookies in that form and rely on a longer-lived SSO token to
 * recreate them. When the app quits, the auth cookie is gone; if the SSO token
 * has also aged out, the user has to scan a QR code again.
 *
 * This module reads the browser partition's session cookies and re-sets each
 * one WITH an expiration, which turns it into a persistent cookie Chromium
 * writes to its cookie store. The server-side session lifetime is unchanged —
 * this only removes the client-side "lost on app exit" cliff.
 *
 * Scope is deliberately narrow: only `persist:pi-browser`, only cookies the
 * browser already holds, no values are ever logged.
 */

import { session } from 'electron';

/** Must match BrowserManager's ENGINE_WEB_PREFS.partition. */
export const BROWSER_PARTITION = 'persist:pi-browser';

/**
 * How long a session cookie is kept locally. The platform's own server-side
 * TTL still wins; 30 days only means "we do not drop it just because Electron
 * restarted".
 */
const PERSIST_DAYS = 30;

/** One persistence run at a time; navigation can schedule several. */
let inFlight: Promise<number> | null = null;
let scheduled: ReturnType<typeof setTimeout> | null = null;
let watching = false;

function cookieUrl(domain: string, path: string): string {
  // Always HTTPS: setting a non-secure cookie over HTTPS is valid, and many
  // auth cookies are Secure/SameSite=None. The original `secure` flag is
  // preserved in the set details.
  const host = domain.replace(/^\./, '');
  return `https://${host}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Re-write every session cookie in the browser partition with an expiration.
 * Returns the number converted. Errors are logged without values; a single
 * unsettable cookie must not abort the rest.
 */
export function persistBrowserSessionCookies(): Promise<number> {
  if (inFlight) return inFlight;

  const run = (async (): Promise<number> => {
    const ses = session.fromPartition(BROWSER_PARTITION);
    const cookies = await ses.cookies.get({});
    const expirationDate = Math.floor(Date.now() / 1000) + PERSIST_DAYS * 24 * 60 * 60;
    let converted = 0;
    let failed = 0;

    for (const cookie of cookies) {
      if (!cookie.session || !cookie.domain) continue;
      const path = cookie.path?.startsWith('/') ? cookie.path : '/';
      const details: Electron.CookiesSetDetails = {
        url: cookieUrl(cookie.domain, path),
        name: cookie.name,
        value: cookie.value,
        path,
        secure: cookie.secure ?? false,
        httpOnly: cookie.httpOnly ?? false,
        sameSite: cookie.sameSite,
        expirationDate,
        // A host-only cookie must stay host-only; adding a domain would widen
        // its scope and change what the site sees.
        ...(cookie.hostOnly === true ? {} : { domain: cookie.domain }),
      };

      try {
        await ses.cookies.set(details);
        converted++;
      } catch {
        // SameSite=None requires Secure. Older sites sometimes set a
        // non-Secure SameSite=None cookie; fall back to `unspecified` so the
        // login survives instead of being silently dropped.
        if (cookie.sameSite === 'no_restriction') {
          try {
            await ses.cookies.set({ ...details, sameSite: 'unspecified' });
            converted++;
            continue;
          } catch {
            /* fall through */
          }
        }
        failed++;
      }
    }

    await ses.cookies.flushStore();
    if (converted > 0 || failed > 0) {
      console.info(
        `[browser-session] persisted ${converted} session cookie(s)` +
          (failed > 0 ? `, ${failed} failed` : ''),
      );
    }
    return converted;
  })().finally(() => {
    inFlight = null;
  });

  inFlight = run;
  return run;
}

/**
 * Persist a session cookie as soon as the site sets it.
 *
 * Navigation hooks cover the common login redirect, but sites also refresh
 * session/CSRF cookies from XHR or a heartbeat without navigating. The cookie
 * `changed` event is the authoritative signal; our own persistence re-set
 * makes the cookie non-session, so this does not loop.
 */
export function ensureBrowserSessionCookieWatcher(): void {
  if (watching) return;
  try {
    const ses = session.fromPartition(BROWSER_PARTITION);
    ses.cookies.on('changed', (_event, cookie, _cause, removed) => {
      if (!removed && cookie.session) scheduleBrowserSessionCookiePersist(1_000);
    });
    watching = true;
  } catch (err) {
    console.warn(
      '[browser-session] cookie watcher failed:',
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Debounced persist after navigation/login. Logging in can take a few seconds
 * after `did-finish-load` (redirects, XHR), so the delay is intentional.
 */
export function scheduleBrowserSessionCookiePersist(delayMs = 2_500): void {
  if (scheduled) return;
  scheduled = setTimeout(() => {
    scheduled = null;
    void persistBrowserSessionCookies().catch((err) => {
      console.warn('[browser-session] persist failed:', err instanceof Error ? err.message : err);
    });
  }, delayMs);
  scheduled.unref?.();
}
