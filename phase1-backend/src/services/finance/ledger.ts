/**
 * Finance — ledger. Split verbatim from finance.service.ts (review batch 2, ت-١٠);
 * finance.service.ts re-exports what it always exported.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import { activePlanForMerchant } from "../entitlement.service.js";
import type { PlatformActor } from "../../auth/platform-permissions.js";
import { recordPlatformAuditEvent } from "../platform-audit.service.js";

type DbClient = Prisma.TransactionClient | typeof prisma;

/** ADR-006: completed→returned reverses financially inside this window only. */
export const RETURN_REVERSAL_WINDOW_DAYS = 15;

function commissionFor(subtotalIqd: number, commissionBps: number): number {
  return Math.round((subtotalIqd * commissionBps) / 10000);
}

/**
 * 19-د: `loyaltyDiscountIqd` is REQUIRED, not optional with a zero default.
 *
 * The defect this closes was exactly an omission — the caller had the number in
 * hand and simply did not pass it, and nothing downstream could tell. A required
 * field makes the next caller answer the question at compile time instead of
 * silently booking a payout larger than the cash the courier collected.
 *
 * ── THE COMMISSION BASE EXCLUDES THE LOYALTY DISCOUNT, BY DECISION ───────────
 * OWNER DECISION, 2026-09-04, asked and answered explicitly: «لا». Redeemed
 * points do NOT reduce the commission base. `commissionFor` is fed
 * `subtotal − coupon` and nothing else — the coupon reduces it (20B-1 §8.4),
 * loyalty does not. The reasoning is that points are a debt the merchant sold
 * himself on an earlier order; the platform does not carry its cost.
 *
 * SO THE ASYMMETRY BELOW IS THE FEATURE, NOT AN OVERSIGHT. `loyaltyDiscountIqd`
 * is stored beside the base and subtracted only in the PAYOUT readers
 * (`netPayout`, `draftSettlement`, `totalsFromGroups`, the analytics copy),
 * never inside `commissionFor`. Folding it into `input.subtotalIqd` here is a
 * one-line change that looks like tidying, produces a correct-looking payout,
 * and MOVES REAL MONEY out of the platform's commission on every redemption.
 * Do not make it without a new owner decision replacing the one above.
 */
export async function recordOrderCompletion(
  tx: DbClient,
  input: {
    storeId: string;
    orderId: string;
    subtotalIqd: number;
    deliveryFeeIqd: number;
    loyaltyDiscountIqd: number;
    platformDiscountIqd?: number;
  }
) {
  const store = await tx.store.findUnique({
    where: { id: input.storeId },
    select: { merchantId: true },
  });
  if (!store) throw new HttpError(404, "STORE_NOT_FOUND", "The requested store does not exist.");
  const plan = await activePlanForMerchant(tx, store.merchantId);
  const bps = plan.commissionBps;
  await tx.ledgerEntry.create({
    data: {
      storeId: input.storeId,
      orderId: input.orderId,
      entryType: "order_completed",
      subtotalIqd: input.subtotalIqd,
      deliveryFeeIqd: input.deliveryFeeIqd,
      loyaltyDiscountIqd: input.loyaltyDiscountIqd,
      // Marketplace M8b: recorded, never deducted — the platform pays it.
      platformDiscountIqd: input.platformDiscountIqd ?? 0,
      commissionIqd: commissionFor(input.subtotalIqd, bps),
      commissionBps: bps,
      planCode: plan.code,
    },
  });
}

export type ReturnReversalOutcome = "reversed" | "outside_window" | "no_completion_entry";

export async function recordOrderReturn(
  tx: DbClient,
  input: { storeId: string; orderId: string; now?: Date }
): Promise<ReturnReversalOutcome> {
  const completion = await tx.ledgerEntry.findFirst({
    where: { storeId: input.storeId, orderId: input.orderId, entryType: "order_completed" },
    orderBy: { createdAt: "desc" },
  });
  if (!completion) return "no_completion_entry";
  const alreadyReversed = await tx.ledgerEntry.findFirst({
    where: { orderId: input.orderId, entryType: "order_returned" },
    select: { id: true },
  });
  if (alreadyReversed) return "reversed";
  const now = input.now ?? new Date();
  const windowMs = RETURN_REVERSAL_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  if (now.valueOf() - completion.createdAt.valueOf() > windowMs) return "outside_window";
  await tx.ledgerEntry.create({
    data: {
      storeId: completion.storeId,
      orderId: completion.orderId,
      entryType: "order_returned",
      subtotalIqd: completion.subtotalIqd,
      deliveryFeeIqd: completion.deliveryFeeIqd,
      loyaltyDiscountIqd: completion.loyaltyDiscountIqd ?? 0,
      platformDiscountIqd: completion.platformDiscountIqd,
      commissionIqd: completion.commissionIqd,
      commissionBps: completion.commissionBps,
      planCode: completion.planCode,
      note: "automatic_return_reversal",
    },
  });
  return "reversed";
}

/** Owner-authored reversal for a return outside the automatic window (append-only). */
export async function createManualReturnAdjustment(
  actor: PlatformActor,
  input: { orderId: string; note: unknown }
) {
  const note =
    typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 500) : null;
  return prisma.$transaction(async (tx) => {
    const completion = await tx.ledgerEntry.findFirst({
      where: { orderId: input.orderId, entryType: "order_completed" },
      orderBy: { createdAt: "desc" },
    });
    if (!completion)
      throw new HttpError(404, "RESOURCE_NOT_FOUND", "لا يوجد قيد إتمام لهذا الطلب.");
    const reversed = await tx.ledgerEntry.findFirst({
      where: { orderId: input.orderId, entryType: { in: ["order_returned", "manual_adjustment"] } },
      select: { id: true },
    });
    if (reversed) throw new HttpError(409, "ALREADY_REVERSED", "هذا الطلب معكوس مالياً بالفعل.");
    const order = await tx.storeOrder.findUnique({
      where: { id: input.orderId },
      select: { status: true, orderNumber: true },
    });
    if (order?.status !== "returned")
      throw new HttpError(422, "ORDER_NOT_RETURNED", "التسوية اليدوية متاحة للطلبات المرتجعة فقط.");
    const entry = await tx.ledgerEntry.create({
      data: {
        storeId: completion.storeId,
        orderId: completion.orderId,
        entryType: "manual_adjustment",
        subtotalIqd: completion.subtotalIqd,
        deliveryFeeIqd: completion.deliveryFeeIqd,
        loyaltyDiscountIqd: completion.loyaltyDiscountIqd ?? 0,
        platformDiscountIqd: completion.platformDiscountIqd,
        commissionIqd: completion.commissionIqd,
        commissionBps: completion.commissionBps,
        planCode: completion.planCode,
        note: note ?? "manual_late_return_reversal",
      },
    });
    // 19-ب: a manual reversal of real money commits with its record or not at all.
    await recordPlatformAuditEvent(tx, {
      entityType: "ledger_adjustment",
      entityId: entry.id,
      entityLabel: order.orderNumber,
      action: "adjustment_created",
      actor,
      metadata: {
        orderId: input.orderId,
        subtotalIqd: completion.subtotalIqd,
        commissionIqd: completion.commissionIqd,
      },
    });
    return entry;
  });
}
