import "dotenv/config";

import { resolveCodiqDatabaseUrl } from "./db/database-url.js";
// ق-231: one definition of «long enough», read by the boot warning here and by
// the preflight that refuses — never two numbers to keep in step.
import { SESSION_SECRET_MIN_BYTES } from "./config/environment-report.js";

/**
 * ق-231 — D-62's open half: the secret exists, but nothing said how long.
 *
 * `SESSION_JWT_SECRET` signs the sessions of all five identities. The check
 * asked only whether it was set, so an eight-character value passed — and an
 * eight-character HMAC key is brute-forceable offline from a single captured
 * token, which yields the ability to MINT a session for any merchant, any
 * platform owner, any shopper on the platform. ASVS 2.10 puts the floor at 32
 * bytes for a signing key of this kind.
 *
 * WARNED here, REFUSED by the preflight — and deliberately not the other way
 * round. This platform is already live. A boot-time `throw` would mean that the
 * first deploy after this commit refuses to start on a running platform whose
 * secret happens to be short: an outage caused by the fix, on the day of the
 * fix, with every merchant locked out until someone rotates a value under
 * pressure. `pnpm env:check` and `/ready` report it as an unfinished
 * configuration instead — loudly, before a deploy rather than during one — and
 * this line makes sure nobody can run the server without having been told.
 */
function requiredEnvironment(name: "SESSION_JWT_SECRET"): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < SESSION_SECRET_MIN_BYTES) {
    // Structured, so the logging guard's own rule covers it and it cannot be
    // lost in a wall of output.
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "config.weak_session_secret",
        bytes,
        minimum: SESSION_SECRET_MIN_BYTES,
        message: `${name} is ${bytes} bytes; a key that signs the sessions of all five identities must be at least ${SESSION_SECRET_MIN_BYTES} (ASVS 2.10). Rotate with SESSION_JWT_SECRET_PREVIOUS so nobody is signed out: openssl rand -base64 48`,
      })
    );
  }
  return value;
}

/**
 * P27-7: the demo environment flag. Default OFF everywhere; only the dedicated
 * Railway `demo` environment sets it. Exported as a function so the notification
 * provider — which is deliberately env-injectable and must stay usable from the
 * standalone worker process — reads the same rule instead of its own comparison.
 */
export function demoModeFromEnv(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.CODIQ_DEMO_MODE === "true";
}

/**
 * Whether cookies carry `Secure`.
 *
 * THIS WAS A LIVE DEFECT. Every cookie in the platform read
 * `NODE_ENV === "production"`, but `production` is set only by the `start`
 * script — staging runs `NODE_ENV=staging` (DEPLOYMENT.md). So staging, which is
 * served over https, has been issuing session cookies WITHOUT `Secure`: any
 * plain-http request to that host would carry the session token in the clear.
 *
 * Inverted deliberately. The old rule had to NAME every environment that
 * deserves protection, and forgetting one fails OPEN and silently. This one has
 * to name the single environment that cannot have it — local http development —
 * and forgetting that fails CLOSED and loudly, with a cookie the browser
 * refuses to store rather than a token on the wire.
 *
 * `CODIQ_COOKIE_SECURE` exists for the case this rule gets wrong: an https local
 * setup, or an http staging box. It is an escape hatch, not the mechanism.
 */
export function cookieSecureFromEnv(environment: NodeJS.ProcessEnv = process.env): boolean {
  const override = environment.CODIQ_COOKIE_SECURE?.trim();
  if (override) return override !== "false";
  return environment.NODE_ENV !== "development";
}

export const config = {
  databaseUrl: resolveCodiqDatabaseUrl(),
  sessionJwtSecret: requiredEnvironment("SESSION_JWT_SECRET"),
  /**
   * D-62: the key being retired, kept for VERIFICATION ONLY during a rotation.
   *
   * Without it, rotating the root secret signs every merchant, staff member and
   * customer out at the instant of deployment — which makes rotation an outage,
   * which means it never happens, which means a leaked secret stays live. Set it
   * to the old value, deploy, and remove it after one session lifetime.
   *
   * Optional by design: absent is the normal state, and absent is safe.
   */
  sessionJwtSecretPrevious: process.env.SESSION_JWT_SECRET_PREVIOUS?.trim() || null,
  port: Number(process.env.PHASE1_PORT ?? 3001),
  sessionLifetimeSeconds: 60 * 60 * 8,
  // Read exactly once, at import: the flag can never drift mid-process.
  demoMode: demoModeFromEnv(),
  // Read once at import, like the flag above: it cannot drift mid-process.
  cookieSecure: cookieSecureFromEnv(),
  /**
   * PG-6 (ق-74): which search engine answers. The key exists from day one so
   * that adding a second engine is one new file plus one value here — never an
   * edit to a caller. `services/search/index.ts` is the only reader.
   */
  searchEngine: process.env.CODIQ_SEARCH_ENGINE?.trim() || "pg-trgm",
} as const;
