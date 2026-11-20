/**
 * POS-offline v1 — till service-worker registration.
 *
 * Imported ONLY by TillPage, NEVER by main.tsx: registration must live in the
 * till's lazy chunk so the entry chunk stays byte-identical and perf:guard
 * holds by construction — «/» never even registers the SW. The PROD gate also
 * keeps the SW out of Vite dev/HMR, where client/public is served at root too.
 *
 * Registration or update rejection degrades silently: offline BOOT is a
 * convenience, and the browser-suite console tripwire allows no logging.
 */

export function registerTillServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}

/** A long-lived till discovers deploys: called on TillPage mount and on every 'online'. */
export function updateTillServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker
    .getRegistration()
    .then((registration) => registration?.update())
    .catch(() => undefined);
}
