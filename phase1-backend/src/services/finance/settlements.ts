/**
 * Finance — settlements. Split verbatim from finance.service.ts (review batch 2, ت-١٠);
 * finance.service.ts re-exports what it always exported.
 */
import type { Prisma } from "@prisma/client";
import { HttpError } from "../../auth/auth.errors.js";
import { prisma } from "../../db/prisma.js";
import type { PlatformActor } from "../../auth/platform-permissions.js";
import { platformActorLabelFor, recordPlatformAuditEvent } from "../platform-audit.service.js";
import { domainEvents } from "../../events/domain-events.js";
import { parseReportRange } from "./reports.js";

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
  if (to <= from)
    throw new HttpError(400, "INVALID_DATE_FILTER", "لا يمكن تسوية فترة لم تبدأ بعد.");
  return { from, to };
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
async function draftSettlement(
  tx: Prisma.TransactionClient,
  merchant: { id: string },
  from: Date,
  to: Date
) {
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
    throw new HttpError(
      409,
      "SETTLEMENT_PERIOD_OVERLAP",
      `هذه الفترة تتداخل مع تسوية سابقة تنتهي في ${previous.periodTo.toISOString()}. ابدأ الفترة الجديدة من تلك اللحظة بالضبط.`
    );
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
    : ((
        await tx.ledgerEntry.findFirst({
          where: { store: { merchantId: merchant.id } },
          orderBy: { createdAt: "asc" },
          select: { createdAt: true },
        })
      )?.createdAt ?? null);
  if (anchor && from > anchor) {
    const instant = anchor.toISOString();
    throw new HttpError(
      409,
      "SETTLEMENT_PERIOD_GAP",
      previous
        ? `تبدأ هذه الفترة بعد نهاية التسوية السابقة، فيسقط ما بينهما من كل الشاشات: لا يدخل تسويةً ولا يبقى في «المستحق للتاجر». ابدأها من ${instant} بالضبط.`
        : `للتاجر قيودٌ أقدم من بداية هذه الفترة، ولن تدخل أيّ تسوية بعدها. ابدأ أول تسوية من ${instant} بالضبط.`
    );
  }
  // Summed in the database rather than read row by row: a busy merchant's
  // month is thousands of entries, and the preview runs on every form open.
  // The one-type-adds rule, as two filters: completions add, every other type subtracts.
  // After the first, a period starts at the last one's end — an entry AT that instant was summed
  // there (`lte`), so here it opens after it, as the wallet does (review batch 2, م-١١).
  const createdAt = previous ? { gt: from, lte: to } : { gte: from, lte: to };
  const period = { store: { merchantId: merchant.id }, createdAt };
  const sum = {
    subtotalIqd: true,
    deliveryFeeIqd: true,
    loyaltyDiscountIqd: true,
    commissionIqd: true,
  } as const;
  const [added, subtracted] = await Promise.all([
    tx.ledgerEntry.aggregate({
      where: { ...period, entryType: "order_completed" },
      _count: { _all: true },
      _sum: sum,
    }),
    tx.ledgerEntry.aggregate({
      where: { ...period, entryType: { not: "order_completed" } },
      _count: { _all: true },
      _sum: sum,
    }),
  ]);
  const totals = {
    completedOrders: added._count._all,
    reversedOrders: subtracted._count._all,
    subtotalIqd: (added._sum.subtotalIqd ?? 0) - (subtracted._sum.subtotalIqd ?? 0),
    deliveryFeeIqd: (added._sum.deliveryFeeIqd ?? 0) - (subtracted._sum.deliveryFeeIqd ?? 0),
    loyaltyDiscountIqd:
      (added._sum.loyaltyDiscountIqd ?? 0) - (subtracted._sum.loyaltyDiscountIqd ?? 0),
    commissionIqd: (added._sum.commissionIqd ?? 0) - (subtracted._sum.commissionIqd ?? 0),
  };
  const netPayoutIqd =
    totals.subtotalIqd + totals.deliveryFeeIqd - totals.loyaltyDiscountIqd - totals.commissionIqd;
  return { totals, netPayoutIqd };
}

/** Audit 17-ب: what confirming this settlement would record and transfer — read only. */
export async function previewSettlement(body: Record<string, unknown>) {
  if (typeof body.merchantId !== "string")
    throw new HttpError(422, "INVALID_INPUT", "merchantId مطلوب.");
  const { from, to } = settlementPeriod(body, new Date());
  const merchant = await prisma.merchant.findUnique({
    where: { id: body.merchantId },
    select: { id: true },
  });
  if (!merchant) throw new HttpError(404, "RESOURCE_NOT_FOUND", "التاجر غير موجود.");
  const { totals, netPayoutIqd } = await prisma.$transaction((tx) =>
    draftSettlement(tx, merchant, from, to)
  );
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
  if (typeof body.merchantId !== "string")
    throw new HttpError(422, "INVALID_INPUT", "merchantId مطلوب.");
  const { from, to } = settlementPeriod(body, new Date());
  const merchant = await prisma.merchant.findUnique({
    where: { id: body.merchantId },
    select: { id: true, businessName: true, email: true },
  });
  if (!merchant) throw new HttpError(404, "RESOURCE_NOT_FOUND", "التاجر غير موجود.");
  const note =
    typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : null;
  const settlement = await prisma.$transaction(async (tx) => {
    const { totals, netPayoutIqd } = await draftSettlement(tx, merchant, from, to);
    // Audit 17-ب: the operator confirms an AMOUNT, not a date range. If the
    // ledger moved between the preview he read and this write (a completion or
    // a return landed in the period), the recorded payout would differ from
    // the money he transferred — so it is refused and he previews again.
    if (
      typeof body.expectedNetPayoutIqd === "number" &&
      body.expectedNetPayoutIqd !== netPayoutIqd
    ) {
      throw new HttpError(
        409,
        "SETTLEMENT_AMOUNT_CHANGED",
        `تغيّر المبلغ المستحق منذ عرضه: صار ${netPayoutIqd} د.ع بدل ${body.expectedNetPayoutIqd} د.ع. راجع المبلغ الجديد ثم أكّد.`
      );
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
      metadata: {
        merchantId: merchant.id,
        commissionIqd: totals.commissionIqd,
        subtotalIqd: totals.subtotalIqd,
        netPayoutIqd: settlement.netPayoutIqd,
      },
    });
    return settlement;
  });
  domainEvents.emit("settlement.created", {
    merchantId: merchant.id,
    settlementId: settlement.id,
    netPayoutIqd: settlement.netPayoutIqd ?? 0,
  });
  return settlement;
}
