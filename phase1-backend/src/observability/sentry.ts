/**
 * ق-235 — المراقب الذي لا يعتمد على شيءٍ ممّا يراقبه.
 *
 * WHY THIS EXISTS, in one measured event. On 2026-09-09 the Neon compute quota
 * ran out. Every route that touches the database answered 500 — the merchant
 * door, the storefront, `/api/public/plans` — and the platform said nothing for
 * TWO DAYS. Nothing was broken about the alerting; the alerting was structurally
 * incapable of firing:
 *
 *   · `/api/health` is a hardcoded 200 that touches nothing, and it is what the
 *     only automated probe watches — so it stayed green through the whole
 *     outage (this is a confirmed finding of the phases 11→15 audit);
 *   · ق-188's platform health alerts WRITE A ROW to the database and send it
 *     through the outbox. When the database is the thing that died, the alarm
 *     dies with it. A circular dependency: the smoke detector is wired to the
 *     mains it is watching.
 *
 * So the value here is not error grouping — the platform already logs one
 * structured line per failure with a correlation id (D-41). The value is that
 * this reporter lives OUTSIDE: it needs no database, no outbox, no SMTP. It is
 * the one thing that can still speak when everything else has gone quiet.
 *
 * THREE RULES, each of them load-bearing:
 *
 * 1. INERT UNLESS CONFIGURED. No `SENTRY_DSN`, no initialisation, no network
 *    call, no behaviour change. Every local run, every CI run and every test
 *    stays exactly as it was — and a deployment that has not been given a DSN
 *    is not silently half-instrumented.
 *
 * 2. NOTHING ABOUT A CUSTOMER LEAVES THIS SERVER. This is a cash-on-delivery
 *    platform: order payloads carry a shopper's name, home address and phone
 *    number, and Sentry captures request bodies, headers and cookies BY DEFAULT.
 *    `sendDefaultPii` is false, the body/cookie/header carriers are dropped
 *    outright, and every string that survives goes through `scrubText` — the
 *    SAME function the logger uses (JWTs, sealed secrets, bearer tokens, email
 *    addresses, Iraqi phone numbers). One redaction rule for the whole platform,
 *    not two that drift apart.
 *
 * 3. A STORM MUST NOT COST US THE QUOTA. The free plan allows 5,000 events a
 *    month. The 2026-09-09 outage produced a 500 on essentially every request —
 *    left unbounded it would have burned a month of quota in an afternoon and
 *    gone blind precisely when it mattered. The DSN carries a server-side cap of
 *    150 events/hour, and `beforeSend` drops the expected 4xx class entirely: a
 *    404 or a validation refusal is the platform WORKING, and reporting it is
 *    how a signal becomes noise nobody reads (ق-231's lesson, applied again).
 */
import * as Sentry from "@sentry/node";
import { scrubText } from "../logging/redact.js";

/** Set once at init so callers can ask without re-reading the environment. */
let active = false;

export function sentryEnabled(): boolean {
  return active;
}

/**
 * Deep-scrub every string in a captured event through the logger's own rules.
 *
 * Bounded on purpose: a runaway structure must not turn error reporting into a
 * CPU cost during the very incident it is reporting on.
 */
function scrubDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrubDeep(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      out[key] = scrubDeep(inner, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * The client-side half of rule 3: only the faults the SERVER owns are worth an
 * event. A 4xx is the platform refusing something correctly.
 */
function isExpectedRefusal(event: Sentry.ErrorEvent): boolean {
  const status = Number(event.tags?.["http.status"] ?? event.contexts?.response?.status_code ?? 0);
  return status >= 400 && status < 500;
}

export function initSentry(environment: NodeJS.ProcessEnv = process.env): boolean {
  const dsn = environment.SENTRY_DSN?.trim();
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment: environment.NODE_ENV ?? "unknown",
    // The commit is stamped by Railway; without it every incident has to be
    // matched to a deploy by hand from timestamps.
    release: environment.RAILWAY_GIT_COMMIT_SHA ?? undefined,
    // RULE 2. Off is the default in recent SDKs, but it is written out because
    // a future upgrade that flipped it would silently start shipping shoppers'
    // addresses to a third party.
    sendDefaultPii: false,
    // Errors only. Tracing samples healthy traffic, which on this platform means
    // sampling order payloads — cost and exposure for a question we are not
    // asking yet.
    tracesSampleRate: 0,
    maxBreadcrumbs: 20,
    beforeSend(event) {
      if (isExpectedRefusal(event)) return null;
      // Drop the carriers whose whole purpose is to hold what must not leave:
      // the request body, the cookies, and the headers (authorization, and the
      // session cookie ق-230 spent a decision protecting).
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.headers;
        if (event.request.url) event.request.url = scrubText(event.request.url);
        // A query string is user input too — an email in `?q=` is still an email.
        delete event.request.query_string;
      }
      delete event.user;
      return scrubDeep(event) as Sentry.ErrorEvent;
    },
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.data) breadcrumb.data = scrubDeep(breadcrumb.data) as Record<string, unknown>;
      if (breadcrumb.message) breadcrumb.message = scrubText(breadcrumb.message);
      return breadcrumb;
    },
  });
  active = true;
  return true;
}

/**
 * Report a fault the server owns. Called from ONE place — `errorHandler`'s
 * unmapped-500 branch — so that what reaches Sentry is exactly what the platform
 * already considers its own fault, and a mapped refusal never becomes an alert.
 *
 * Never throws: a reporter that can break a request is worse than no reporter.
 */
export function reportServerFault(
  error: unknown,
  context: { requestId: string; route?: string; status: number }
): void {
  if (!active) return;
  try {
    Sentry.withScope((scope) => {
      scope.setTag("http.status", String(context.status));
      // The same id the merchant reads back off his screen (D-41), so an alert
      // and a log line can be joined without guessing from timestamps.
      scope.setTag("request_id", context.requestId);
      if (context.route) scope.setTag("route", context.route);
      Sentry.captureException(error);
    });
  } catch {
    // Swallowed deliberately, and this is the one place a bare catch is right.
  }
}
