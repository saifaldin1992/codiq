/**
 * Plans and entitlements — merchants. Split verbatim from
 * entitlement.service.ts (review batch 4, ت-٢);
 * entitlement.service.ts re-exports what it always exported.
 */
import { Prisma } from "@prisma/client";
import {
  parseListLimit,
  readListCursor,
  keysetWhere,
  pageOf,
  encodeListCursor,
} from "../list-page.js";
import { prisma } from "../../db/prisma.js";
import type { PlatformActor } from "../../auth/platform-permissions.js";
import { HttpError } from "../../auth/auth.errors.js";
import { recordPlatformAuditEvent, platformActorLabelFor } from "../platform-audit.service.js";
import { subscriptionSummary, merchantEntitlementsView } from "./subscribe.js";
import { activePlanForMerchant } from "./plans.js";

/** The cursor's list kinds. One per list, so a cursor cannot cross lists. */
const MERCHANTS_KIND = "platform.merchants";

const UPGRADE_REQUESTS_KIND = "platform.upgrade-requests";

/**
 * D-74: this took NO ARGUMENTS and returned every merchant on the platform, so
 * the owner's directory grew one row per signup forever and the query had no
 * ceiling at all. Newest first now, which is also the order the directory is
 * read in — the newest merchant is the one being looked for.
 */
export async function listMerchantsWithPlans(rawLimit?: unknown, rawCursor?: unknown) {
  const limit = parseListLimit(rawLimit);
  const cursor = await readListCursor(MERCHANTS_KIND, rawCursor);
  const rows = await prisma.merchant.findMany({
    where: { ...keysetWhere("createdAt", "desc", cursor) },
    select: {
      id: true,
      email: true,
      businessName: true,
      isActive: true,
      createdAt: true,
      // ق-167: written by every creation path, read by nothing until now.
      ownerName: true,
      phoneNormalized: true,
      subscriptions: {
        where: { status: "active" },
        orderBy: { startedAt: "desc" },
        take: 1,
        select: { plan: { select: { code: true, name: true } }, startedAt: true, endsAt: true },
      },
      _count: { select: { stores: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor(MERCHANTS_KIND, last.createdAt, last.id)
  );
  const merchants = page.map((merchant) => ({
    id: merchant.id,
    email: merchant.email,
    businessName: merchant.businessName,
    ownerName: merchant.ownerName,
    phone: merchant.phoneNormalized,
    isActive: merchant.isActive,
    storeCount: merchant._count.stores,
    plan: merchant.subscriptions[0]?.plan ?? null,
    subscribedAt: merchant.subscriptions[0]?.startedAt ?? null,
    // ق-181: the owner sees who is on a free month and when it ends.
    subscriptionEndsAt: merchant.subscriptions[0]?.endsAt ?? null,
    isTrial: subscriptionSummary(merchant.subscriptions[0] ?? null).isTrial,
  }));
  return { merchants, nextCursor };
}

/** The single write path for changing a merchant's active subscription; runs inside the caller's transaction. */
async function replaceActiveSubscription(
  tx: Prisma.TransactionClient,
  merchantId: string,
  planId: string
) {
  await tx.merchantSubscription.updateMany({
    where: { merchantId, status: "active" },
    data: { status: "cancelled", endsAt: new Date() },
  });
  await tx.merchantSubscription.create({ data: { merchantId, planId, status: "active" } });
}

/**
 * Owner-driven manual assignment (billing automation arrives in phase 25).
 * 19-ب: `actor` is OPTIONAL because internal callers (the trial-expiry sweep)
 * assign plans with no platform actor behind them; the HTTP routes always pass
 * one, and when one is present the audit row commits with the assignment.
 */
export async function assignMerchantSubscription(
  merchantId: string,
  body: Record<string, unknown>,
  actor?: PlatformActor
) {
  if (typeof body.planCode !== "string")
    throw new HttpError(422, "INVALID_INPUT", "planCode مطلوب.");
  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: { id: true, businessName: true, email: true },
  });
  if (!merchant) throw new HttpError(404, "RESOURCE_NOT_FOUND", "التاجر غير موجود.");
  const plan = await prisma.plan.findUnique({
    where: { code: body.planCode },
    select: { id: true, isActive: true, name: true },
  });
  if (!plan || !plan.isActive)
    throw new HttpError(404, "RESOURCE_NOT_FOUND", "الخطة المطلوبة غير متاحة.");
  await prisma.$transaction(async (tx) => {
    await replaceActiveSubscription(tx, merchantId, plan.id);
    if (actor) {
      await recordPlatformAuditEvent(tx, {
        entityType: "subscription",
        entityId: merchantId,
        entityLabel: merchant.businessName || merchant.email,
        action: "subscription_assigned",
        actor,
        metadata: { merchantId, planCode: body.planCode as string },
      });
    }
  });
  return merchantEntitlementsView(merchantId);
}

// ---------- plan upgrade requests (approved addition 2026-08-26) ----------

const upgradeRequestSelect = {
  id: true,
  status: true,
  note: true,
  createdAt: true,
  decidedAt: true,
  merchant: { select: { id: true, email: true, businessName: true } },
  requestedPlan: { select: { code: true, name: true, monthlyPriceIqd: true } },
} satisfies Prisma.PlanUpgradeRequestSelect;

/** Merchant-initiated upgrade (or downgrade) request; one pending request at a time. */
export async function createUpgradeRequest(merchantId: string, body: Record<string, unknown>) {
  if (typeof body.planCode !== "string")
    throw new HttpError(422, "INVALID_INPUT", "planCode مطلوب.");
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 500)) {
    throw new HttpError(422, "INVALID_INPUT", "الملاحظة يجب أن تكون نصاً لا يتجاوز 500 حرف.");
  }
  const plan = await prisma.plan.findUnique({
    where: { code: body.planCode },
    select: { id: true, isActive: true },
  });
  if (!plan || !plan.isActive)
    throw new HttpError(404, "RESOURCE_NOT_FOUND", "الخطة المطلوبة غير متاحة.");
  const currentPlan = await activePlanForMerchant(prisma, merchantId);
  if (currentPlan.id === plan.id)
    throw new HttpError(
      422,
      "SAME_PLAN_REQUESTED",
      "أنت مشتركة بهذه الخطة بالفعل — لا حاجة لطلب جديد."
    );
  const pending = await prisma.planUpgradeRequest.findFirst({
    where: { merchantId, status: "pending" },
    select: { id: true },
  });
  if (pending)
    throw new HttpError(
      409,
      "DUPLICATE_UPGRADE_REQUEST",
      "لديك طلب ترقية قيد المراجعة بالفعل — يُحسم أولاً ثم يمكن إرسال طلب جديد."
    );
  return prisma.planUpgradeRequest.create({
    data: {
      merchantId,
      requestedPlanId: plan.id,
      note: typeof body.note === "string" ? body.note.trim() || null : null,
    },
    select: upgradeRequestSelect,
  });
}

/** Owner queue: pending requests first (oldest first), then decided ones (newest decision first). */
/**
 * D-18: this read EVERY upgrade request ever made — decided ones are never
 * removed — and then re-sorted them in JavaScript into «pending first, then
 * decided newest-first».
 *
 * That arrangement cannot survive pagination and is not worth saving: a
 * partition computed over one page reorders rows differently on every page,
 * which is worse than one honest order. So the queue is newest-first, like
 * every other queue on the platform, and `pendingCount` travels with it so the
 * owner still sees at a glance how many are waiting — a number that used to be
 * derivable only by loading the entire history. `?status=pending` narrows to
 * exactly the ones needing a decision.
 */
export async function listUpgradeRequests(
  rawLimit?: unknown,
  rawCursor?: unknown,
  rawStatus?: unknown
) {
  const limit = parseListLimit(rawLimit);
  const cursor = await readListCursor(UPGRADE_REQUESTS_KIND, rawCursor);
  const status = typeof rawStatus === "string" && rawStatus ? rawStatus : undefined;
  const [rows, pendingCount] = await Promise.all([
    prisma.planUpgradeRequest.findMany({
      where: { ...(status ? { status } : {}), ...keysetWhere("createdAt", "desc", cursor) },
      select: upgradeRequestSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    }),
    prisma.planUpgradeRequest.count({ where: { status: "pending" } }),
  ]);
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor(UPGRADE_REQUESTS_KIND, last.createdAt, last.id)
  );
  return { requests: page, nextCursor, pendingCount };
}

/**
 * Approval assigns the plan through the same subscription write path,
 * atomically with the decision. 19-ب: the deciding actor is recorded HONESTLY —
 * a staff decision fills decided_by_staff_id and the label snapshot, never the
 * owner's column.
 */
/** An approved request's effect: the plan, if it is still offered, becomes his subscription. */
async function applyApprovedPlan(tx: Prisma.TransactionClient, merchantId: string, planId: string) {
  // Re-checked inside the transaction: an archive racing this approval must
  // not assign a just-archived plan.
  const plan = await tx.plan.findUnique({
    where: { id: planId },
    select: { isActive: true },
  });
  if (!plan?.isActive) {
    throw new HttpError(
      409,
      "PLAN_NOT_AVAILABLE",
      "الخطة المطلوبة لم تعد متاحة — أُرشفت بعد إرسال الطلب."
    );
  }
  await replaceActiveSubscription(tx, merchantId, planId);
}

export async function decideUpgradeRequest(
  requestId: string,
  actor: PlatformActor,
  action: "approve" | "reject"
) {
  const request = await prisma.planUpgradeRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      status: true,
      merchantId: true,
      merchant: { select: { businessName: true, email: true } },
      requestedPlan: { select: { id: true, isActive: true, code: true } },
    },
  });
  if (!request) throw new HttpError(404, "RESOURCE_NOT_FOUND", "طلب الترقية غير موجود.");
  if (request.status !== "pending")
    throw new HttpError(409, "ALREADY_DECIDED", "هذا الطلب محسوم بالفعل.");
  return prisma.$transaction(async (tx) => {
    // Claimed first, in one conditional write: an approval and a rejection at the same moment
    // both passed the «pending» read above, and the request could end «rejected» over a changed
    // subscription (review batch 4, ت-٣). The loser is told it is already decided.
    const claimed = await tx.planUpgradeRequest.updateMany({
      where: { id: requestId, status: "pending" },
      data: { status: action === "approve" ? "approved" : "rejected" },
    });
    if (claimed.count !== 1) throw new HttpError(409, "ALREADY_DECIDED", "هذا الطلب محسوم بالفعل.");
    if (action === "approve")
      await applyApprovedPlan(tx, request.merchantId, request.requestedPlan.id);
    const decided = await tx.planUpgradeRequest.update({
      where: { id: requestId },
      data: {
        status: action === "approve" ? "approved" : "rejected",
        decidedAt: new Date(),
        ...(actor.kind === "platform_owner"
          ? { decidedById: actor.id }
          : { decidedByStaffId: actor.id, decidedByLabel: await platformActorLabelFor(tx, actor) }),
      },
      select: upgradeRequestSelect,
    });
    await recordPlatformAuditEvent(tx, {
      entityType: "upgrade_request",
      entityId: requestId,
      entityLabel: request.merchant.businessName || request.merchant.email,
      action: "upgrade_request_decided",
      actor,
      metadata: { decision: action, planCode: request.requestedPlan.code },
    });
    return decided;
  });
}
