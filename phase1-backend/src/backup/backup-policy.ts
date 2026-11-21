/**
 * 24-ج — the one place that decides how often CODIQ dumps its database, how
 * long it keeps the dumps, and how many it refuses to prune away.
 *
 * ============================================================================
 * WHY A MODULE AND NOT THREE NUMBERS IN A CRON LINE
 * ============================================================================
 *
 * `docs/DISASTER_RECOVERY.md` publishes an RPO to the owner. A published RPO is
 * a promise, and a promise that only lives in prose rots the first time somebody
 * edits the schedule and forgets the paragraph — or edits the paragraph to say
 * something braver than the schedule delivers. Either way the document keeps
 * reading well while the system stops matching it, which is the exact failure
 * the house rule names: a guard that lies is worse than no guard.
 *
 * So the numbers live here, once, and `pnpm backup:guard` reads BOTH this file
 * and the document and fails when they disagree. Change the cadence and CI tells
 * you which sentence you now owe.
 *
 * ============================================================================
 * WHY SIX HOURS, WHICH LOOKS ARBITRARY AND IS NOT
 * ============================================================================
 *
 * Neon's free plan retains 6 hours of history (`history_retention_seconds:
 * 21600`, measured 2026-09-05). Inside that window point-in-time restore is the
 * better tool by every measure: finer granularity, no dump to fetch, ~10s to a
 * usable branch. These dumps are not competing with it. They exist for the two
 * things PITR cannot do — reach back further than 6 hours, and survive the loss
 * of the Neon project itself.
 *
 * Setting the dump interval EQUAL to the history window makes the two mechanisms
 * tile the timeline with no hole between them: at any instant, either the damage
 * is younger than 6 hours and PITR covers it, or a dump exists that is at most
 * 6 hours older than the damage. Pick 24h instead and there is a daily 18-hour
 * band where PITR has expired and the newest dump predates the incident by up to
 * a day. That band is where "we have backups" quietly stops being true.
 *
 * One consequence worth stating plainly: this makes the published RPO a single
 * honest number (6 hours) instead of two numbers and a caveat.
 */

export const BACKUP_POLICY = {
  /**
   * Hours between dumps. Must equal Neon's history retention window — see the
   * tiling argument above. The Railway cron expression is derived from this, so
   * the two cannot drift.
   */
  intervalHours: 6,

  /**
   * Days a dump is kept before the pruner may delete it. Thirty days is chosen
   * against the failure mode that actually motivates off-site dumps: logical
   * corruption (a bad migration, a wrong `UPDATE`) discovered late. Discovery
   * lag for silent data damage is measured in weeks, not hours.
   */
  retentionDays: 30,

  /**
   * The pruner will never leave fewer than this many objects, whatever the dates
   * say. A wrong clock, a paused cron, or a `retentionDays` typo must not be
   * able to empty the bucket — deletion is the one step with no undo, so it gets
   * a floor that is independent of the arithmetic that decides it.
   */
  minimumKeptCopies: 14,

  /** Every object this tooling writes lives under exactly this prefix. */
  objectPrefix: "db-backups/",

  /**
   * Plaintext bytes per AEAD frame. 4 MiB keeps peak memory flat regardless of
   * database size (the dump is never held whole) while keeping per-frame
   * overhead — 12-byte IV, 16-byte tag, 4-byte length — at roughly 8 parts per
   * million.
   */
  chunkBytes: 4 * 1024 * 1024,

  /**
   * The PostgreSQL major version of the production server. `pg_dump` refuses to
   * dump a server NEWER than itself, so the image that runs the backup must ship
   * a client at least this new. Recorded here because the failure is invisible
   * until it happens: a Railway base image that quietly ships an older client
   * turns every scheduled run into an error nobody reads.
   */
  productionServerMajor: 18,
} as const;

/**
 * The Railway cron expression implied by `intervalHours`. Derived rather than
 * written down twice — the schedule and the published RPO are the same fact.
 */
export function backupCronExpression(): string {
  const hours = BACKUP_POLICY.intervalHours;
  if (hours <= 0 || hours >= 24 || 24 % hours !== 0) {
    throw new Error(
      `[backup-policy] intervalHours must divide 24 evenly to express as a cron; got ${hours}. ` +
        `Change it to 1, 2, 3, 4, 6, 8 or 12, or teach this function a new shape.`
    );
  }
  return `0 */${hours} * * *`;
}
