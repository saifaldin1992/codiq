/**
 * ق-225 — the platform can stop a merchant it has already approved.
 *
 * ============================================================================
 * WHAT WAS MISSING
 * ============================================================================
 *
 * The owner could APPROVE a pending registration and REJECT a pending
 * registration, and that was the whole of his leverage. Once a merchant was
 * approved there was no way — from any screen, through any route — to stop him:
 * `merchant.isActive` was written by `decideMerchantApproval` and by nothing
 * else. The merchants directory said so out loud («إيقاف تاجر مُفعّل يصل ضمن
 * أدوات التحصين في الدفعة القادمة»), which is this file.
 *
 * In a cash-on-delivery market that gap is the whole trust-and-safety response.
 * A shop that takes orders and never delivers, a merchant whose account is
 * stolen, a store selling something the platform must not carry — every one of
 * them is answered by the same lever, and until now the only way to pull it was
 * a hand-written UPDATE against production.
 *
 * ============================================================================
 * WHAT SUSPENSION MEANS, EXACTLY
 * ============================================================================
 *
 *  · the merchant's account goes inactive, so `loginMerchant` refuses him with
 *    the same 401 a wrong password gets — a suspended merchant is not told his
 *    account exists and was stopped, because a stolen account's holder must not
 *    learn the platform noticed;
 *  · every store he owns goes inactive, so `resolveStorefrontStore` answers 404
 *    and the storefront, its products, its cart and its checkout vanish together
 *    rather than one screen at a time;
 *  · every live session goes with them — HIS, and every STAFF session inside his
 *    stores. ق-192's lesson applies with more force here: a decision that takes
 *    effect on the next login is not a decision, it is a delay of up to eight
 *    hours during which the thing you stopped keeps happening. His staff are
 *    revoked too because a suspended shop must not keep selling through the
 *    people he hired.
 *
 * What it deliberately does NOT do: touch a single order, ledger entry,
 * settlement or product. Suspension is a gate on ACTING, never on the record.
 * The money history is append-only by design and a suspended merchant's numbers
 * must still reconcile — including the wallet balance the platform still owes
 * him for orders already delivered.
 *
 * ============================================================================
 * WHY `merchants.manage` AND NOT OWNER-ONLY
 * ============================================================================
 *
 * The audit report proposed owner-only. On reading the permission matrix I chose
 * `merchants.manage`, and the argument is the platform's own: a
 * `registrations_admin` already holds `registrations.approve`, and REJECTING a
 * registration sets exactly these columns on exactly these rows. A platform that
 * lets a role stop a merchant at the door and not the day after is not protecting
 * anything — it is making the person who spotted the fraud wait for the owner.
 * The three genuinely non-delegable powers (commission rates, plan archival, the
 * platform team itself) are untouched: they still carry no permission code at
 * all, which is what makes them the owner's.
 */
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import type { PlatformActor } from "../auth/platform-permissions.js";
import { recordPlatformAuditEvent } from "./platform-audit.service.js";

/** Long enough to be a reason and not a shrug; short enough to be one line in the log. */
export const SUSPENSION_REASON_MIN = 3;
export const SUSPENSION_REASON_MAX = 300;

export interface MerchantSuspensionResult {
  merchantId: string;
  suspended: boolean;
  /** false when the merchant was already in the requested state — no rows written, no audit noise. */
  changed: boolean;
  storesAffected: number;
  sessionsRevoked: { merchant: number; staff: number };
}

export async function setMerchantSuspension(
  merchantId: string,
  actor: PlatformActor,
  input: { suspended: unknown; reason?: unknown },
): Promise<MerchantSuspensionResult> {
  if (typeof input.suspended !== "boolean") {
    throw new HttpError(422, "INVALID_INPUT", "suspended يجب أن يكون true أو false.");
  }
  const suspended = input.suspended;
  const rawReason = typeof input.reason === "string" ? input.reason.trim() : "";
  // A reason is required to STOP a shop and not to restart one: the log exists to
  // answer «لماذا أُوقف هذا التاجر» months later, and «rejected» with no sentence
  // beside it is the answer nobody can act on.
  if (suspended && rawReason.length < SUSPENSION_REASON_MIN) {
    throw new HttpError(422, "SUSPENSION_REASON_REQUIRED", "اكتب سبب الإيقاف — يُقرأ لاحقاً في سجلّ التدقيق وعند رفع الإيقاف.");
  }
  if (rawReason.length > SUSPENSION_REASON_MAX) {
    throw new HttpError(422, "INVALID_INPUT", `سبب الإيقاف يجب ألا يتجاوز ${SUSPENSION_REASON_MAX} حرفاً.`);
  }
  const reason = rawReason || null;

  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: { id: true, isActive: true, approvalStatus: true, businessName: true, email: true },
  });
  if (!merchant) throw new HttpError(404, "RESOURCE_NOT_FOUND", "التاجر غير موجود.");
  // A pending or rejected registration is the approval queue's business, and it
  // writes the same two columns. Two doors onto one decision is how the two
  // disagree.
  if (merchant.approvalStatus !== "approved") {
    throw new HttpError(409, "REGISTRATION_NOT_DECIDED", "هذا التاجر لم يُعتمد بعد — قرار طلبه يُتّخذ من طابور التسجيل.");
  }
  if (merchant.isActive === !suspended) {
    return { merchantId, suspended, changed: false, storesAffected: 0, sessionsRevoked: { merchant: 0, staff: 0 } };
  }

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    await tx.merchant.update({ where: { id: merchantId }, data: { isActive: !suspended } });
    const stores = await tx.store.updateMany({ where: { merchantId }, data: { isActive: !suspended } });

    let merchantSessions = 0;
    let staffSessions = 0;
    if (suspended) {
      // ق-192 again, from the other side: the guards read `merchant.isActive` on
      // every request, so this is belt AND braces — but a revoked session is what
      // makes the merchant's own browser show him the door immediately instead of
      // rendering a dashboard whose every card answers «تعذر التحميل».
      merchantSessions = (await tx.merchantSession.updateMany({ where: { merchantId, revokedAt: null }, data: { revokedAt: now } })).count;
      const storeIds = (await tx.store.findMany({ where: { merchantId }, select: { id: true } })).map((store) => store.id);
      if (storeIds.length) {
        staffSessions = (await tx.staffSession.updateMany({ where: { storeId: { in: storeIds }, revokedAt: null }, data: { revokedAt: now } })).count;
      }
    }

    // 19-ب: the decision and its record commit together, exactly as the approval
    // decision does — and the reason rides the record, because it is the only
    // place anyone will ever look for it.
    await recordPlatformAuditEvent(tx, {
      entityType: "merchant",
      entityId: merchantId,
      entityLabel: merchant.businessName || merchant.email,
      action: suspended ? "merchant_suspended" : "merchant_resumed",
      actor,
      metadata: { reason, storesAffected: stores.count },
    });

    return {
      merchantId,
      suspended,
      changed: true,
      storesAffected: stores.count,
      sessionsRevoked: { merchant: merchantSessions, staff: staffSessions },
    };
  });
}
