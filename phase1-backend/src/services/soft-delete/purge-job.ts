/**
 * PG-2 — the 30-day purge sweep (plan §1.د).
 *
 * The database decides, not a `NOT EXISTS` checklist in the code. The job tries
 * a `DELETE` for every expired row IN ITS OWN TRANSACTION and treats
 * 23503 / P2003 as a NAMED OUTCOME (`purge_blocked`), never as an error. Every
 * financial or auditable reference is a `Restrict` foreign key, so Postgres
 * refuses those rows by itself — and a restricting key added two years from now
 * is protected without its author knowing this job exists.
 *
 * The pass ORDER is mandatory: products → categories → coupons → memberships,
 * then ONE retry of everything blocked during THIS pass before stamping it.
 * Without the retry an empty category would be stamped `purge_blocked` forever
 * because the product about to be purged still pointed at it
 * (`products.category_id` is Restrict).
 *
 * Blocked rows are retried on every later pass — the sweep order
 * (`purge_blocked_at NULLS FIRST`) keeps them from starving fresh rows — so a
 * block is a curable state, not a life sentence.
 *
 * Runs as a THIRD interval inside the standalone worker process, never in an
 * HTTP path (ADR-004).
 */
import { prisma } from "../../db/prisma.js";
import {
  deleteProductImageObjects,
  productImageObjectKeys,
} from "../product-image-storage.service.js";
import { recordAuditEvent } from "./audit-log.service.js";
import { TRASH_RETENTION_MS } from "./constants.js";
import { isForeignKeyViolation, purgeBlockReason } from "./fk-violations.js";
import { runJobPass } from "../../logging/context.js";
import { logger } from "../../logging/logger.js";

export const TRASH_PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PURGE_BATCH_SIZE = 200;

const SYSTEM_ACTOR = { kind: "system" } as const;

export interface PurgeResult {
  purged: number;
  blocked: number;
  /** Rows the merchant restored between `candidates()` and the delete (ح-4). */
  skipped: number;
  byEntity: Record<string, { purged: number; blocked: number }>;
}

type Candidate = {
  entityType: "product" | "product_category" | "coupon" | "staff_membership";
  id: string;
  storeId: string;
  label: string;
  secondary: string | null;
  purgeBlockedAt: Date | null;
  purgeBlockReason: string | null;
};

/** `purge_blocked_at NULLS FIRST, deleted_at` — blocked rows never starve the new ones. */
const sweepOrder = [
  { purgeBlockedAt: { sort: "asc" as const, nulls: "first" as const } },
  { deletedAt: "asc" as const },
];

async function candidates(cutoff: Date, batchSize: number): Promise<Candidate[]> {
  const expired = { deletedAt: { not: null, lte: cutoff } } as const;
  const [products, categories, coupons, memberships] = await Promise.all([
    prisma.product.findMany({
      where: expired,
      select: {
        id: true,
        storeId: true,
        name: true,
        sku: true,
        purgeBlockedAt: true,
        purgeBlockReason: true,
      },
      orderBy: sweepOrder,
      take: batchSize,
    }),
    prisma.productCategory.findMany({
      where: expired,
      select: { id: true, storeId: true, name: true, purgeBlockedAt: true, purgeBlockReason: true },
      orderBy: sweepOrder,
      take: batchSize,
    }),
    prisma.coupon.findMany({
      where: expired,
      select: { id: true, storeId: true, code: true, purgeBlockedAt: true, purgeBlockReason: true },
      orderBy: sweepOrder,
      take: batchSize,
    }),
    prisma.storeStaffMembership.findMany({
      where: expired,
      select: {
        id: true,
        storeId: true,
        purgeBlockedAt: true,
        purgeBlockReason: true,
        staff: { select: { displayName: true, email: true } },
      },
      orderBy: sweepOrder,
      take: batchSize,
    }),
  ]);
  return [
    ...products.map(
      (row): Candidate => ({
        entityType: "product",
        id: row.id,
        storeId: row.storeId,
        label: row.name,
        secondary: row.sku,
        purgeBlockedAt: row.purgeBlockedAt,
        purgeBlockReason: row.purgeBlockReason,
      })
    ),
    ...categories.map(
      (row): Candidate => ({
        entityType: "product_category",
        id: row.id,
        storeId: row.storeId,
        label: row.name,
        secondary: null,
        purgeBlockedAt: row.purgeBlockedAt,
        purgeBlockReason: row.purgeBlockReason,
      })
    ),
    ...coupons.map(
      (row): Candidate => ({
        entityType: "coupon",
        id: row.id,
        storeId: row.storeId,
        label: row.code,
        secondary: null,
        purgeBlockedAt: row.purgeBlockedAt,
        purgeBlockReason: row.purgeBlockReason,
      })
    ),
    ...memberships.map(
      (row): Candidate => ({
        entityType: "staff_membership",
        id: row.id,
        storeId: row.storeId,
        label: row.staff.displayName,
        secondary: row.staff.email,
        purgeBlockedAt: row.purgeBlockedAt,
        purgeBlockReason: row.purgeBlockReason,
      })
    ),
  ];
}

/**
 * One row, one transaction. Returns the S3 object keys that must be dropped
 * AFTER the commit — a storage outage must never roll back a committed purge —
 * or `null` when the row stopped being an expired trash row, which means the
 * merchant restored it after `candidates()` read this batch.
 *
 * ح-4 — every delete below RE-STATES `deleted_at IS NOT NULL AND <= cutoff` in
 * its own WHERE instead of trusting the id it was handed, and the audit event is
 * written only after a row actually went. Postgres re-evaluates that predicate
 * after taking the row lock, so a restore committing inside the window makes the
 * delete match zero rows instead of destroying a product — variants, images, S3
 * bytes and all — that the merchant was just told he had recovered. `restore()`
 * takes the matching `FOR UPDATE` on its side, so the two writers serialize.
 */
async function purgeOne(candidate: Candidate, cutoff: Date): Promise<string[] | null> {
  const stillExpired = { deletedAt: { not: null, lte: cutoff } } as const;
  return prisma.$transaction(async (tx) => {
    let objectKeys: string[] = [];
    let removed = 0;
    if (candidate.entityType === "product") {
      // ق-238: one row now names THREE objects. Expanding here rather than at
      // the delete call is deliberate — the expansion needs `variantSet`, which
      // only this read has, and a legacy row still expands to its single key.
      const images = await tx.productImage.findMany({
        where: { productId: candidate.id },
        select: { objectKey: true, variantSet: true },
      });
      objectKeys = images.flatMap((image) => productImageObjectKeys(image));
      // Variants, images and notification_outbox rows cascade; inventory
      // movements are SET NULL and survive with their stamped snapshot — D-48.
      ({ count: removed } = await tx.product.deleteMany({
        where: { id: candidate.id, ...stillExpired },
      }));
    } else if (candidate.entityType === "product_category") {
      ({ count: removed } = await tx.productCategory.deleteMany({
        where: { id: candidate.id, ...stillExpired },
      }));
    } else if (candidate.entityType === "coupon") {
      ({ count: removed } = await tx.coupon.deleteMany({
        where: { id: candidate.id, ...stillExpired },
      }));
    } else {
      // staff_sessions is Restrict, so the membership's already-revoked sessions
      // go first. The Staff row itself is NEVER touched: it is an identity that
      // crosses stores, and order_status_events.actor_id still points at it. The
      // relation filter carries the same guard, so a restored membership does not
      // lose the sessions it is about to stop having.
      await tx.staffSession.deleteMany({
        where: { membershipId: candidate.id, membership: stillExpired },
      });
      ({ count: removed } = await tx.storeStaffMembership.deleteMany({
        where: { id: candidate.id, ...stillExpired },
      }));
    }
    if (removed === 0) return null;
    await recordAuditEvent(tx, {
      storeId: candidate.storeId,
      entityType: candidate.entityType,
      entityId: candidate.id,
      entityLabel: candidate.label,
      entitySecondary: candidate.secondary,
      action: "purged",
      actor: SYSTEM_ACTOR,
      metadata: { retentionDays: TRASH_RETENTION_MS / (24 * 60 * 60 * 1000) },
    });
    return objectKeys;
  });
}

/**
 * ح-4, second face: `purge_block_requires_deleted` is a CHECK constraint, so
 * stamping a row the merchant restored a second earlier raised 23514 — and since
 * nothing caught it, the rest of the blocked tail was abandoned unstamped and the
 * sweep died mid-pass. `updateMany` with the same predicate turns that row into a
 * no-op instead of a bomb.
 */
async function stampBlocked(candidate: Candidate, reason: string) {
  const data = { purgeBlockedAt: new Date(), purgeBlockReason: reason };
  const stillTrashed = { deletedAt: { not: null } } as const;
  let stamped = 0;
  if (candidate.entityType === "product")
    ({ count: stamped } = await prisma.product.updateMany({
      where: { id: candidate.id, ...stillTrashed },
      data,
    }));
  else if (candidate.entityType === "product_category")
    ({ count: stamped } = await prisma.productCategory.updateMany({
      where: { id: candidate.id, ...stillTrashed },
      data,
    }));
  else if (candidate.entityType === "coupon")
    ({ count: stamped } = await prisma.coupon.updateMany({
      where: { id: candidate.id, ...stillTrashed },
      data,
    }));
  else
    ({ count: stamped } = await prisma.storeStaffMembership.updateMany({
      where: { id: candidate.id, ...stillTrashed },
      data,
    }));
  if (stamped === 0) return;
  // Log the block ONCE per reason, not every six hours forever.
  if (candidate.purgeBlockedAt && candidate.purgeBlockReason === reason) return;
  await prisma.$transaction(async (tx) => {
    await recordAuditEvent(tx, {
      storeId: candidate.storeId,
      entityType: candidate.entityType,
      entityId: candidate.id,
      entityLabel: candidate.label,
      entitySecondary: candidate.secondary,
      action: "purge_blocked",
      actor: SYSTEM_ACTOR,
      metadata: { reason },
    });
  });
}

/**
 * One sweep. `now` is injected so tests drive the job directly (`now: +31d`)
 * exactly as they drive `scanAbandonedCarts`.
 */
export async function purgeExpiredSoftDeletes(
  options: { now?: Date; batchSize?: number } = {}
): Promise<PurgeResult> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? PURGE_BATCH_SIZE;
  const cutoff = new Date(now.valueOf() - TRASH_RETENTION_MS);
  const outcome: PurgeResult = { purged: 0, blocked: 0, skipped: 0, byEntity: {} };
  const bump = (entityType: string, key: "purged" | "blocked") => {
    outcome.byEntity[entityType] ??= { purged: 0, blocked: 0 };
    outcome.byEntity[entityType]![key] += 1;
    outcome[key] += 1;
  };

  const pending = await candidates(cutoff, batchSize);
  if (!pending.length) return outcome;

  const orphanedObjectKeys: string[] = [];
  const blockedThisPass: Array<{ candidate: Candidate; reason: string }> = [];

  for (const candidate of pending) {
    try {
      const keys = await purgeOne(candidate, cutoff);
      if (keys === null) {
        outcome.skipped += 1;
        continue;
      }
      orphanedObjectKeys.push(...keys);
      bump(candidate.entityType, "purged");
    } catch (error) {
      if (!isForeignKeyViolation(error)) throw error;
      blockedThisPass.push({ candidate, reason: purgeBlockReason(error) });
    }
  }

  // The mandatory single retry: a category blocked only because its own product
  // was still standing earlier in THIS pass now succeeds. ح-4: one row that fails
  // for an unforeseen reason must not cost the sweep the whole rest of its tail,
  // so the retry contains its own errors instead of unwinding the pass.
  for (const { candidate, reason } of blockedThisPass) {
    try {
      const keys = await purgeOne(candidate, cutoff);
      if (keys === null) {
        outcome.skipped += 1;
        continue;
      }
      orphanedObjectKeys.push(...keys);
      bump(candidate.entityType, "purged");
    } catch (error) {
      if (!isForeignKeyViolation(error)) {
        logger.error("job.row_failed", {
          job: "trash-purger",
          entityType: candidate.entityType,
          entityId: candidate.id,
          err: error,
        });
        continue;
      }
      try {
        await stampBlocked(candidate, purgeBlockReason(error) || reason);
        bump(candidate.entityType, "blocked");
      } catch (stampError) {
        logger.error("job.stamp_failed", {
          job: "trash-purger",
          entityType: candidate.entityType,
          entityId: candidate.id,
          err: stampError,
        });
      }
    }
  }

  // After the commits: the bytes. A storage failure is logged, never fatal —
  // the rows are already gone and re-running must stay safe.
  if (orphanedObjectKeys.length) await deleteProductImageObjects(orphanedObjectKeys);
  return outcome;
}
