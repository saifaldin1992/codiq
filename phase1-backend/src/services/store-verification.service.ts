/**
 * MD-6 «متجر موثّق» — the verification badge the platform owner grants.
 *
 * TWO THINGS ARE DELIBERATELY SEPARATE HERE.
 *
 * The EVIDENCE is computed from reality — order counts, completion rate, store
 * age, whether the catalogue is real — and never stored. A stored score drifts
 * the moment the merchant deletes the products it was counted from, and the
 * owner would then be shown a number the store no longer earns.
 *
 * The DECISION is manual and stays manual. The evidence is presented so the
 * owner decides on facts rather than impressions, but nothing here auto-grants:
 * a badge is a promise the platform makes to a shopper about a stranger's shop,
 * and no thresholds this file could invent are good enough to make that promise
 * unattended. `meetsAll` is therefore a suggestion, never an action.
 *
 * THE NOTE IS VISIBLE TO THE MERCHANT. It is written into store_audit_events,
 * which the store owner can read, so a merchant whose badge is revoked learns
 * why rather than watching it vanish. The owner's screen says this before he
 * types. Nothing private goes in it.
 *
 * Revocation clears the badge and records why. It is expected to be used —
 * a store that stops earning the promise must stop displaying it — so it is a
 * first-class operation, not an afterthought.
 */
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import { recordAuditEvent } from "./soft-delete/audit-log.service.js";

/**
 * What the owner is shown before granting. Thresholds are conservative and are
 * stated on the screen; they justify a badge, they do not confer one.
 */
export const VERIFICATION_CRITERIA = [
  { code: "age", label: "عمر المتجر 14 يوماً فأكثر", threshold: 14 },
  { code: "completed_orders", label: "10 طلبات مكتملة فأكثر", threshold: 10 },
  { code: "completion_rate", label: "نسبة إتمام 70% فأكثر", threshold: 70 },
  { code: "catalogue", label: "5 منتجات معروضة فأكثر", threshold: 5 },
  { code: "active", label: "المتجر نشط وغير معطّل", threshold: 1 },
] as const;

export interface VerificationEvidence {
  code: string;
  label: string;
  /**
   * The store's real figure today, so a refusal can be explained to a merchant.
   * Null when there is nothing to measure yet — a completion rate needs orders.
   */
  value: number | null;
  threshold: number;
  met: boolean;
}

export interface StoreVerification {
  storeSlug: string;
  storeName: string;
  verified: boolean;
  verifiedAt: Date | null;
  verifiedBy: { id: string; displayName: string } | null;
  note: string | null;
  evidence: VerificationEvidence[];
  /** All criteria are met. A SUGGESTION to the owner; it grants nothing. */
  meetsAll: boolean;
}

function verificationNote(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new HttpError(400, "INVALID_VERIFICATION_NOTE", "الملاحظة نص.");
  const note = raw.trim();
  if (!note) return null;
  if (note.length > 500) throw new HttpError(400, "INVALID_VERIFICATION_NOTE", "الملاحظة حتى 500 حرف.");
  return note;
}

export async function storeVerification(storeSlug: string): Promise<StoreVerification> {
  const store = await prisma.store.findUnique({
    where: { slug: storeSlug },
    select: {
      id: true, slug: true, name: true, isActive: true, createdAt: true,
      verifiedAt: true, verificationNote: true,
      verifiedByOwner: { select: { id: true, displayName: true } },
    },
  });
  if (!store) throw new HttpError(404, "RESOURCE_NOT_FOUND", "المتجر غير موجود.");

  const [completed, total, products] = await Promise.all([
    prisma.storeOrder.count({ where: { storeId: store.id, status: "completed" } }),
    prisma.storeOrder.count({ where: { storeId: store.id } }),
    // Only live, active products count: a catalogue in the trash, or switched
    // off, is not a catalogue a shopper can buy from.
    prisma.product.count({ where: { storeId: store.id, isActive: true, deletedAt: null } }),
  ]);
  const ageDays = Math.floor((Date.now() - store.createdAt.getTime()) / 86_400_000);
  // A store with no orders has no completion rate: 100% would be a fabrication
  // and 0% reads as a failure it has not had the chance to earn. It is reported
  // as null, and the criterion below is then "not met" for the honest reason —
  // there is nothing to measure yet — rather than because it scored zero.
  const completionRate = total === 0 ? null : Math.round((completed / total) * 100);

  const values: Record<string, number | null> = {
    age: ageDays,
    completed_orders: completed,
    completion_rate: completionRate,
    catalogue: products,
    active: store.isActive ? 1 : 0,
  };
  const evidence = VERIFICATION_CRITERIA.map((criterion) => {
    const value = values[criterion.code] ?? null;
    return {
      code: criterion.code,
      label: criterion.label,
      value,
      threshold: criterion.threshold,
      // A criterion with nothing to measure is not met — but it is not met at
      // `null`, which the screen renders as «لا توجد بيانات بعد» rather than as
      // a score of zero.
      met: value !== null && value >= criterion.threshold,
    };
  });

  return {
    storeSlug: store.slug,
    storeName: store.name,
    verified: store.verifiedAt !== null,
    verifiedAt: store.verifiedAt,
    verifiedBy: store.verifiedByOwner,
    note: store.verificationNote,
    evidence,
    meetsAll: evidence.every((item) => item.met),
  };
}

export async function setStoreVerification(
  storeSlug: string,
  ownerId: string,
  input: { verified: unknown; note?: unknown },
): Promise<StoreVerification> {
  if (typeof input.verified !== "boolean") throw new HttpError(400, "INVALID_VERIFICATION", "`verified` must be true or false.");
  const note = verificationNote(input.note);
  // The owner is looked up rather than trusted from the caller: the badge names
  // whoever the database says acted, and `recordAuditEvent` resolves the display
  // label the same way, so an attribution the route could have invented is one
  // nothing here will store.
  const [store, owner] = await Promise.all([
    prisma.store.findUnique({ where: { slug: storeSlug }, select: { id: true, name: true, verifiedAt: true } }),
    prisma.platformOwner.findUnique({ where: { id: ownerId }, select: { id: true } }),
  ]);
  if (!store) throw new HttpError(404, "RESOURCE_NOT_FOUND", "المتجر غير موجود.");
  if (!owner) throw new HttpError(401, "INVALID_SESSION", "حساب المالك لم يعد موجوداً.");

  await prisma.$transaction(async (tx) => {
    await tx.store.update({
      where: { id: store.id },
      // Revoking clears the attribution with the badge: the CHECK constraint
      // refuses a half-cleared row, and so should this code.
      data: input.verified
        ? { verifiedAt: new Date(), verifiedByOwnerId: owner.id, verificationNote: note }
        : { verifiedAt: null, verifiedByOwnerId: null, verificationNote: null },
    });
    // The badge itself keeps no history — this is the history. A revocation with
    // no record of who revoked it and why is how a merchant loses a badge and
    // nobody can say when.
    //
    // Through `recordAuditEvent` rather than a direct create: it types the entity
    // and action against AUDIT_ENTITY_TYPES/AUDIT_ACTIONS, so a typo'd action is
    // a compile error here instead of a CHECK violation at runtime, and it
    // resolves the actor label from the database itself.
    await recordAuditEvent(tx, {
      storeId: store.id,
      entityType: "store_verification",
      entityId: store.id,
      entityLabel: store.name,
      action: input.verified ? "verification.granted" : "verification.revoked",
      actor: { kind: "platform_owner", id: owner.id },
      metadata: note ? { note } : {},
    });
  });

  return storeVerification(storeSlug);
}

/** What a storefront may say about itself — the badge and nothing behind it. */
export async function publicStoreVerification(storeId: string): Promise<{ verifiedAt: Date } | null> {
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { verifiedAt: true } });
  // The note and the granting owner stay off the STOREFRONT: a shopper needs to
  // know the platform vouched for this shop, not who signed off or on what
  // evidence. (The merchant does see the note — see the header.)
  return store?.verifiedAt ? { verifiedAt: store.verifiedAt } : null;
}
