/**
 * D-39 — every operational retention window the platform has, in ONE module.
 *
 * The register's complaint was not «no cleanup job», it was «no NUMBER anyone
 * can find»: six background timers run in the worker and not one of them
 * purges an operational table, so `storefront_rate_limits`, five session
 * tables, `notification_outbox`, abandoned guest carts and `checkout_requests`
 * grow forever on Neon — unbounded storage, bloated indexes, a gradual
 * slowdown nobody can point at a cause for.
 *
 * So the windows live here and NOWHERE else. `retention-job.ts` reads them;
 * the tests read them; changing «90 days» to «120 days» is one edit on one
 * line, and it is the edit a reviewer can see. A number copied into a job file
 * is a number that drifts from the one in the plan.
 *
 * Owner decision 7 (phase-20 blueprint, 2026-09-03) set the opening numbers.
 * They are deliberately generous — the cost of keeping an operational row a
 * month too long is disk; the cost of deleting it a day too early is a
 * merchant asking «where did my notification log go».
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Every window, in days. The key names the ROW STATE being retired, not the
 * table, because two of these tables have two windows.
 */
export const RETENTION_DAYS = {
  /** `storefront_rate_limits`, counted from `updated_at` — the window is minutes long; a week is already a hundredfold safety margin. */
  storefrontRateLimits: 7,
  /** Marketplace M4: one-time sign-in codes, counted from `created_at`. A code lives five minutes; a week keeps the rate-limit history readable. */
  shopperOtpChallenges: 7,
  /** Revoked or expired rows in ALL SIX session tables, counted from whichever of `revoked_at` / `expires_at` came due. */
  sessions: 30,
  /** `notification_outbox` rows that reached `sent` or `skipped`, counted from `updated_at`. */
  notificationOutboxSettled: 90,
  /** `notification_outbox` rows that reached `dead_letter`. A failure is evidence, so it is kept four times longer than a success. */
  notificationOutboxDeadLetter: 365,
  /** Guest carts, counted from the moment they EXPIRED (`expires_at`), not from creation. */
  guestCarts: 30,
  /** `checkout_requests` — the idempotency ledger, counted from `created_at`. A replayed key older than this mints a second order, which is why the window is not short. */
  checkoutRequests: 90,
} as const;

export type RetentionWindow = keyof typeof RETENTION_DAYS;

/** The instant a row of `window` age becomes eligible, given the sweep's `now`. */
export function retentionCutoff(now: Date, days: number): Date {
  return new Date(now.valueOf() - days * DAY_MS);
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TABLES THIS JOB MUST NEVER TOUCH — read this before adding a sweep.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * If you are here to add a window for one of these, the answer is no, and it is
 * not a tuning decision you can make in this file:
 *
 *   ledger_entries        — the money. Every commission, settlement and payout
 *                           balance is derived by replaying these rows; a
 *                           deleted entry is a wrong wallet, silently and
 *                           forever. `pnpm ledger:sign` exists because even the
 *                           SIGN of a new entry type is too dangerous to guess.
 *   platform_audit_events — «who did what on the platform». Append-only in the
 *                           database (`platform_audit_events_immutable`), and
 *                           its own model comment says «NO purge ever».
 *   store_audit_events    — the merchant's trash-bin trail. PG-2's restore path
 *                           is «revive ONLY what died in the SAME event», and
 *                           the soft-delete rows carry a RESTRICT foreign key
 *                           to these events precisely so they cannot be lost.
 *   order_status_events   — the order's history. It is what a merchant shows a
 *                           customer, and a courier dispute, when they disagree.
 *   inventory_movements   — the stock trail. D-48 went to the trouble of making
 *                           it survive a PURGED product (SET NULL + stamped
 *                           name/SKU snapshots) rather than let history die
 *                           with its subject; deleting it on a timer undoes
 *                           that work deliberately.
 *
 * These five are ARCHIVED, never auto-deleted (owner decision 7). Archival is a
 * separate, exportable, reversible operation with a merchant-visible artefact —
 * not a DELETE on a six-hour timer. Growth here is a cold-storage question, and
 * the honest answer to «the audit table is big» is a partition or an export,
 * both of which keep the rows readable.
 */
export const NEVER_AUTO_DELETED = [
  "ledger_entries",
  "platform_audit_events",
  "store_audit_events",
  "order_status_events",
  "inventory_movements",
] as const;

/**
 * D-46 — how long an inventory reservation may pin stock while its order sits
 * untouched in `new` (owner decision 8).
 *
 * THE DATABASE HOLDS THE AUTHORITATIVE COPY. `inventory_reservations.expires_at`
 * is `NOT NULL DEFAULT now() + interval '72 hours'` (migration
 * 20260904100000_d46_reservation_expiry), stamped by Postgres for every writer
 * including raw SQL, and never named in a `data:` object — the same device the
 * schema already uses for `is_low_stock` and the `inventory_movements`
 * snapshots. A writer therefore CANNOT forget the clock, which is the whole
 * point: a reservation minted without one is D-46 quietly returning.
 *
 * This constant is the readable copy and the one the tests assert the column
 * default against, so the two cannot drift without CI saying so. Changing the
 * TTL means a new migration that alters the column default AND this line.
 */
export const RESERVATION_TTL_HOURS = 72;
