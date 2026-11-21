/**
 * codiq phase 17 — append-only financial ledger, reports, and settlements (ADR-006).
 * A completed order writes one ledger entry inside the SAME transaction as the
 * status transition, snapshotting the plan and commission at that moment. A return
 * within the approved window writes the reversal entry automatically; outside the
 * window only an owner-authored manual adjustment can reverse it. The database
 * refuses UPDATE/DELETE on ledger entries and settlements outright.
 */
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import { encodeListCursor, keysetWhere, pageOf, parseListLimit, readListCursor } from "./list-page.js";
import { activePlanForMerchant } from "./entitlement.service.js";
import type { PlatformActor } from "../auth/platform-permissions.js";
import { platformActorLabelFor, recordPlatformAuditEvent } from "./platform-audit.service.js";
import type { Prisma } from "@prisma/client";
import { domainEvents } from "../events/domain-events.js";

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
export async function recordOrderCompletion(tx: DbClient, input: { storeId: string; orderId: string; subtotalIqd: number; deliveryFeeIqd: number; loyaltyDiscountIqd: number; platformDiscountIqd?: number }) {
  const store = await tx.store.findUnique({ where: { id: input.storeId }, select: { merchantId: true } });
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

export async function recordOrderReturn(tx: DbClient, input: { storeId: string; orderId: string; now?: Date }): Promise<ReturnReversalOutcome> {
  const completion = await tx.ledgerEntry.findFirst({
    where: { storeId: input.storeId, orderId: input.orderId, entryType: "order_completed" },
    orderBy: { createdAt: "desc" },
  });
  if (!completion) return "no_completion_entry";
  const alreadyReversed = await tx.ledgerEntry.findFirst({ where: { orderId: input.orderId, entryType: "order_returned" }, select: { id: true } });
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
export async function createManualReturnAdjustment(actor: PlatformActor, input: { orderId: string; note: unknown }) {
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 500) : null;
  return prisma.$transaction(async (tx) => {
    const completion = await tx.ledgerEntry.findFirst({ where: { orderId: input.orderId, entryType: "order_completed" }, orderBy: { createdAt: "desc" } });
    if (!completion) throw new HttpError(404, "RESOURCE_NOT_FOUND", "لا يوجد قيد إتمام لهذا الطلب.");
    const reversed = await tx.ledgerEntry.findFirst({ where: { orderId: input.orderId, entryType: { in: ["order_returned", "manual_adjustment"] } }, select: { id: true } });
    if (reversed) throw new HttpError(409, "ALREADY_REVERSED", "هذا الطلب معكوس مالياً بالفعل.");
    const order = await tx.storeOrder.findUnique({ where: { id: input.orderId }, select: { status: true, orderNumber: true } });
    if (order?.status !== "returned") throw new HttpError(422, "ORDER_NOT_RETURNED", "التسوية اليدوية متاحة للطلبات المرتجعة فقط.");
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
      metadata: { orderId: input.orderId, subtotalIqd: completion.subtotalIqd, commissionIqd: completion.commissionIqd },
    });
    return entry;
  });
}

function parseReportRange(query: Record<string, unknown>) {
  const parse = (value: unknown, fallback: Date) => {
    if (value === undefined || value === "") return fallback;
    const parsed = new Date(String(value));
    if (Number.isNaN(parsed.valueOf())) throw new HttpError(400, "INVALID_DATE_FILTER", "from/to must be ISO dates.");
    return parsed;
  };
  const now = new Date();
  const from = parse(query.from, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const to = parse(query.to, now);
  if (to <= from) throw new HttpError(400, "INVALID_DATE_FILTER", "to must be after from.");
  return { from, to };
}

/**
 * 19-د — A SETTLEMENT PERIOD MAY NOT REACH INTO THE FUTURE.
 *
 * `parseReportRange` only checks `to > from`, which is right for a report: asking
 * for a range that runs past today is harmless there. On a settlement it is not.
 * `merchantWallet` opens the pending window at the LATEST `period_to` it can
 * find, so one row with `periodTo = 2030-01-01` — a typo, a wrong locale date —
 * makes «المستحق لك» read 0 for years while orders keep completing. And
 * `settlements_immutable` means the row cannot be edited or deleted afterwards:
 * there is no in-app repair, only a compensating settlement the code has no way
 * to express.
 *
 * It CLAMPS rather than refuses, and that is the deliberate choice: the settle
 * form sends «حتى اليوم» as `T23:59:59Z`, which is genuinely in the future for
 * most of the working day, so a strict refusal would reject the ordinary
 * operator far more often than the typo. `pos.service.ts` clamps a
 * device-claimed `soldAt` into the same window for the same reason. A period
 * that has not STARTED yet still collapses to `to <= from` and is refused
 * outright, because there is nothing honest to clamp it to.
 */
function settlementPeriod(body: Record<string, unknown>, now: Date) {
  const { from, to: requested } = parseReportRange({ from: body.periodFrom, to: body.periodTo });
  const to = requested > now ? now : requested;
  if (to <= from) throw new HttpError(400, "INVALID_DATE_FILTER", "لا يمكن تسوية فترة لم تبدأ بعد.");
  return { from, to };
}


/** Aggregated signed totals computed in the database, so they stay exact past any page size. */
function totalsFromGroups(groups: { entryType: string; _count: { _all: number }; _sum: { subtotalIqd: number | null; deliveryFeeIqd: number | null; loyaltyDiscountIqd: number | null; commissionIqd: number | null } }[]) {
  const totals = { completedOrders: 0, reversedOrders: 0, subtotalIqd: 0, deliveryFeeIqd: 0, loyaltyDiscountIqd: 0, commissionIqd: 0 };
  for (const group of groups) {
    const sign = group.entryType === "order_completed" ? 1 : -1;
    if (sign === 1) totals.completedOrders += group._count._all; else totals.reversedOrders += group._count._all;
    totals.subtotalIqd += sign * (group._sum.subtotalIqd ?? 0);
    totals.deliveryFeeIqd += sign * (group._sum.deliveryFeeIqd ?? 0);
    totals.loyaltyDiscountIqd += sign * (group._sum.loyaltyDiscountIqd ?? 0);
    totals.commissionIqd += sign * (group._sum.commissionIqd ?? 0);
  }
  return totals;
}

/**
 * 19-د — the delivery fee as a share of the goods it delivered, in basis points.
 *
 * `commissionFor` is fed the subtotal only and the delivery fee is remitted
 * whole (ADR-006), which is a deliberate split. Its abuse is not: a merchant
 * pricing goods at 1,000 and delivery at 99,000 books almost no commission and
 * is still paid everything, and this report showed delivery and commission side
 * by side without ever relating them. `MAX_DELIVERY_RATE_IQD` bounds the
 * absurd version; a 30/70 shift is legal and this number is how it becomes
 * legible to whoever settles him.
 *
 * Basis points rather than a float — a ratio is not money, but a rounded
 * integer is what the rest of this file speaks and what a screen can print. A
 * period with no sales has no ratio, and reports null rather than a number
 * invented from a division by zero.
 */
function deliveryShareBps(totals: { subtotalIqd: number; deliveryFeeIqd: number }): number | null {
  if (totals.subtotalIqd <= 0) return null;
  return Math.round((totals.deliveryFeeIqd * 10000) / totals.subtotalIqd);
}

export async function merchantFinanceReport(merchantId: string, query: Record<string, unknown>) {
  const { from, to } = parseReportRange(query);
  const where = { store: { merchantId }, createdAt: { gte: from, lte: to } };
  const [entries, groups] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 200,
      select: { id: true, storeId: true, orderId: true, entryType: true, subtotalIqd: true, deliveryFeeIqd: true, loyaltyDiscountIqd: true, commissionIqd: true, commissionBps: true, planCode: true, note: true, createdAt: true, store: { select: { slug: true, name: true } }, order: { select: { orderNumber: true } } },
    }),
    prisma.ledgerEntry.groupBy({
      by: ["entryType"],
      where,
      _count: { _all: true },
      _sum: { subtotalIqd: true, deliveryFeeIqd: true, loyaltyDiscountIqd: true, commissionIqd: true },
    }),
  ]);
  return { period: { from, to }, totals: totalsFromGroups(groups), entries };
}

/** The cursor's list kind. One per list, so a cursor cannot cross lists. */
const SETTLEMENTS_KIND = "finance.settlements";

/**
 * D-18: capped at 100 with no page 2. A settlement is written every payout
 * cycle and nothing ever removes one, so a merchant in his third year could no
 * longer reach his first year's payouts — on the screen that exists to prove
 * what he was paid.
 */
export async function merchantSettlements(merchantId: string, rawLimit?: unknown, rawCursor?: unknown) {
  const limit = parseListLimit(rawLimit);
  const cursor = await readListCursor(SETTLEMENTS_KIND, rawCursor);
  const rows = await prisma.settlement.findMany({
    where: { merchantId, ...keysetWhere("createdAt", "desc", cursor) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(SETTLEMENTS_KIND, last.createdAt, last.id));
  return { settlements: page, nextCursor };
}

export async function platformFinanceReport(query: Record<string, unknown>) {
  const { from, to } = parseReportRange(query);
  const groups = await prisma.ledgerEntry.groupBy({
    by: ["storeId", "entryType"],
    where: { createdAt: { gte: from, lte: to } },
    _count: { _all: true },
    _sum: { subtotalIqd: true, deliveryFeeIqd: true, loyaltyDiscountIqd: true, commissionIqd: true },
  });
  const stores = await prisma.store.findMany({
    where: { id: { in: Array.from(new Set(groups.map((group) => group.storeId))) } },
    select: { id: true, merchantId: true, merchant: { select: { email: true, businessName: true } } },
  });
  const storeById = new Map(stores.map((store) => [store.id, store]));
  const byMerchant = new Map<string, { merchantId: string; email: string; businessName: string; groups: typeof groups }>();
  for (const group of groups) {
    const store = storeById.get(group.storeId);
    if (!store) continue;
    if (!byMerchant.has(store.merchantId)) byMerchant.set(store.merchantId, { merchantId: store.merchantId, email: store.merchant.email, businessName: store.merchant.businessName, groups: [] });
    byMerchant.get(store.merchantId)!.groups.push(group);
  }
  return {
    period: { from, to },
    totals: totalsFromGroups(groups),
    merchants: Array.from(byMerchant.values()).map((row) => {
      const totals = totalsFromGroups(row.groups);
      return { merchantId: row.merchantId, email: row.email, businessName: row.businessName, totals, deliveryToSubtotalBps: deliveryShareBps(totals) };
    }).sort((a, b) => b.totals.commissionIqd - a.totals.commissionIqd),
  };
}

/**
 * 19-ب: the settling actor is recorded HONESTLY — the owner in
 * platform_owner_id exactly as before, a staff member in settled_by_staff_id
 * plus a TEXT label snapshot, never laundered through the owner's column. The
 * one-of CHECK in the database refuses a settlement with neither.
 */
/**
 * Audit 17-ب — ONE computation of «what this settlement pays», shared by the
 * preview the operator reads and the write he confirms, so the number on the
 * screen and the number recorded cannot come from two different code paths.
 * It also carries every refusal (overlap, gap) so a preview fails exactly where
 * the write would.
 */
async function draftSettlement(tx: Prisma.TransactionClient, merchant: { id: string }, from: Date, to: Date) {
  // 19-د — A PERIOD IS SETTLED ONCE.
  //
  // This function used to read the ledger and write a Settlement without ever
  // looking at the settlements already there. Nothing else stopped it: the
  // ledger carries no settled marker (it is append-only, so it cannot be
  // stamped after the fact) and the table had no unique or exclusion
  // constraint. Two clicks, two operators, a retry after a timeout that
  // actually succeeded, or one overlapping range settled every entry inside
  // it twice — and `settlements_immutable` then made the duplicate permanent.
  //
  // The rule is CONTIGUITY, not mere non-equality: a new period must start at
  // or after the end of the last one settled. `>=` rather than `>` so
  // back-to-back periods still work, matching the `[from, to)` semantics of
  // the `settlements_no_overlap` exclusion constraint that backs this check
  // against two requests racing inside their own transactions.
  const previous = await tx.settlement.findFirst({
    where: { merchantId: merchant.id },
    orderBy: [{ periodTo: "desc" }, { createdAt: "desc" }],
    select: { id: true, periodFrom: true, periodTo: true },
  });
  if (previous && from < previous.periodTo) {
    throw new HttpError(409, "SETTLEMENT_PERIOD_OVERLAP", `هذه الفترة تتداخل مع تسوية سابقة تنتهي في ${previous.periodTo.toISOString()}. ابدأ الفترة الجديدة من تلك اللحظة بالضبط.`);
  }
  /**
   * ق-233 — CONTIGUITY IS TWO-SIDED, AND ONLY ONE SIDE WAS BUILT.
   *
   * The comment above says «the rule is CONTIGUITY», and `settlements_no_overlap`
   * enforces half of it: no instant is paid twice. Nothing enforced the other
   * half — that no instant is paid ZERO times — so money fell between two
   * settlements and disappeared from every screen at once:
   *
   *   · not in the earlier settlement — its entries were created after that
   *     period's end;
   *   · not in the later one — created before that period's start;
   *   · not in «المستحق لك» — `merchantWallet` opens its pending window at the
   *     LATEST `period_to`, which is later still (merchant-wallet.service.ts:91).
   *
   * And it was not an unlikely slip, it was the DEFAULT. `settlementPeriod`
   * clamps `to` to `now`, so an afternoon settlement ends at 14:03; the settle
   * form then sends the REPORT's date range for the next one, which begins at
   * some midnight — hours or weeks after 14:03. Every cycle left a hole, and
   * `settlements_immutable` means no hole can ever be widened away afterwards.
   * The old refusal message made it worse by naming only the DATE, so an
   * operator who obeyed it literally picked midnight and was refused again.
   *
   * The first settlement has the same hole at its other end: entries older than
   * its `period_from` belong to no period and are excluded from pending the
   * moment it exists. So both ends are anchored here — a merchant's settled
   * time is ONE unbroken interval from his first ledger entry to his last
   * `period_to`, and the trigger `codiq_guard_settlement_contiguous` holds the
   * same line in the database, where a second writer cannot argue with it.
   */
  const anchor = previous
    ? previous.periodTo
    : (await tx.ledgerEntry.findFirst({
        where: { store: { merchantId: merchant.id } },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }))?.createdAt ?? null;
  if (anchor && from > anchor) {
    const instant = anchor.toISOString();
    throw new HttpError(409, "SETTLEMENT_PERIOD_GAP", previous
      ? `تبدأ هذه الفترة بعد نهاية التسوية السابقة، فيسقط ما بينهما من كل الشاشات: لا يدخل تسويةً ولا يبقى في «المستحق للتاجر». ابدأها من ${instant} بالضبط.`
      : `للتاجر قيودٌ أقدم من بداية هذه الفترة، ولن تدخل أيّ تسوية بعدها. ابدأ أول تسوية من ${instant} بالضبط.`);
  }
  // Summed in the database rather than read row by row: a busy merchant's
  // month is thousands of entries, and the preview runs on every form open.
  // The one-type-adds rule, as two filters: completions add, every other type subtracts.
  const period = { store: { merchantId: merchant.id }, createdAt: { gte: from, lte: to } };
  const sum = { subtotalIqd: true, deliveryFeeIqd: true, loyaltyDiscountIqd: true, commissionIqd: true } as const;
  const [added, subtracted] = await Promise.all([
    tx.ledgerEntry.aggregate({ where: { ...period, entryType: "order_completed" }, _count: { _all: true }, _sum: sum }),
    tx.ledgerEntry.aggregate({ where: { ...period, entryType: { not: "order_completed" } }, _count: { _all: true }, _sum: sum }),
  ]);
  const totals = {
    completedOrders: added._count._all,
    reversedOrders: subtracted._count._all,
    subtotalIqd: (added._sum.subtotalIqd ?? 0) - (subtracted._sum.subtotalIqd ?? 0),
    deliveryFeeIqd: (added._sum.deliveryFeeIqd ?? 0) - (subtracted._sum.deliveryFeeIqd ?? 0),
    loyaltyDiscountIqd: (added._sum.loyaltyDiscountIqd ?? 0) - (subtracted._sum.loyaltyDiscountIqd ?? 0),
    commissionIqd: (added._sum.commissionIqd ?? 0) - (subtracted._sum.commissionIqd ?? 0),
  };
  const netPayoutIqd = totals.subtotalIqd + totals.deliveryFeeIqd - totals.loyaltyDiscountIqd - totals.commissionIqd;
  return { totals, netPayoutIqd };
}

/** Audit 17-ب: what confirming this settlement would record and transfer — read only. */
export async function previewSettlement(body: Record<string, unknown>) {
  if (typeof body.merchantId !== "string") throw new HttpError(422, "INVALID_INPUT", "merchantId مطلوب.");
  const { from, to } = settlementPeriod(body, new Date());
  const merchant = await prisma.merchant.findUnique({ where: { id: body.merchantId }, select: { id: true } });
  if (!merchant) throw new HttpError(404, "RESOURCE_NOT_FOUND", "التاجر غير موجود.");
  const { totals, netPayoutIqd } = await prisma.$transaction((tx) => draftSettlement(tx, merchant, from, to));
  return {
    // `periodTo` is the CLAMPED instant: the confirm must send this exact value
    // back, so the write settles the same period the operator was shown.
    periodFrom: from.toISOString(),
    periodTo: to.toISOString(),
    ordersCount: totals.completedOrders - totals.reversedOrders,
    subtotalIqd: totals.subtotalIqd,
    deliveryFeeIqd: totals.deliveryFeeIqd,
    loyaltyDiscountIqd: totals.loyaltyDiscountIqd,
    commissionIqd: totals.commissionIqd,
    netPayoutIqd,
  };
}

export async function createSettlement(actor: PlatformActor, body: Record<string, unknown>) {
  if (typeof body.merchantId !== "string") throw new HttpError(422, "INVALID_INPUT", "merchantId مطلوب.");
  const { from, to } = settlementPeriod(body, new Date());
  const merchant = await prisma.merchant.findUnique({ where: { id: body.merchantId }, select: { id: true, businessName: true, email: true } });
  if (!merchant) throw new HttpError(404, "RESOURCE_NOT_FOUND", "التاجر غير موجود.");
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : null;
  const settlement = await prisma.$transaction(async (tx) => {
    const { totals, netPayoutIqd } = await draftSettlement(tx, merchant, from, to);
    // Audit 17-ب: the operator confirms an AMOUNT, not a date range. If the
    // ledger moved between the preview he read and this write (a completion or
    // a return landed in the period), the recorded payout would differ from
    // the money he transferred — so it is refused and he previews again.
    if (typeof body.expectedNetPayoutIqd === "number" && body.expectedNetPayoutIqd !== netPayoutIqd) {
      throw new HttpError(409, "SETTLEMENT_AMOUNT_CHANGED", `تغيّر المبلغ المستحق منذ عرضه: صار ${netPayoutIqd} د.ع بدل ${body.expectedNetPayoutIqd} د.ع. راجع المبلغ الجديد ثم أكّد.`);
    }
    const settlement = await tx.settlement.create({
      data: {
        merchantId: merchant.id,
        ...(actor.kind === "platform_owner"
          ? { platformOwnerId: actor.id }
          : { settledByStaffId: actor.id, settledByLabel: await platformActorLabelFor(tx, actor) }),
        periodFrom: from,
        periodTo: to,
        ordersCount: totals.completedOrders - totals.reversedOrders,
        subtotalIqd: totals.subtotalIqd,
        deliveryFeeIqd: totals.deliveryFeeIqd,
        loyaltyDiscountIqd: totals.loyaltyDiscountIqd,
        commissionIqd: totals.commissionIqd,
        note,
      },
    });
    await recordPlatformAuditEvent(tx, {
      entityType: "settlement",
      entityId: settlement.id,
      entityLabel: merchant.businessName || merchant.email,
      action: "settlement_created",
      actor,
      metadata: { merchantId: merchant.id, commissionIqd: totals.commissionIqd, subtotalIqd: totals.subtotalIqd, netPayoutIqd: settlement.netPayoutIqd },
    });
    return settlement;
  });
  domainEvents.emit("settlement.created", { merchantId: merchant.id, settlementId: settlement.id, netPayoutIqd: settlement.netPayoutIqd ?? 0 });
  return settlement;
}
