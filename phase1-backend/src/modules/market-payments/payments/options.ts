/**
 * Market payments — options. Split verbatim from payments.service.ts (review batch 2, ت-٨);
 * payments.service.ts re-exports what it always exported.
 */
import { logger } from "../../../logging/logger.js";
import { paymentsMode, cardGateway, lenders, monthlyFor } from "../providers.js";
import { prisma } from "../../../db/prisma.js";
import { expireStalePayments } from "./card.js";
import type { Shopper } from "./events.js";

// ── what the checkout may offer ─────────────────────────────────────────────

/**
 * Review 2026-11-21: the expiry sweep ran only when a payment page was opened, so with no
 * scheduler an unpaid order could hold its stock for hours. Every checkout page now nudges it —
 * at most once a minute per process, off the request — besides `pnpm market:payments:expire`.
 */
let lastSweep = 0;

export function sweepSoon(now = Date.now()) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  setImmediate(() => {
    void expireStalePayments().catch((error: Error) =>
      logger.warn("payments.sweep_failed", { reason: error.message })
    );
  });
}

/** Which online methods this order could use, and — for instalments — each lender's answer. */
export async function onlineOptions(shopper: Shopper, storeId: string, goodsIqd: number) {
  if (paymentsMode() === "off") return { card: null, instalments: null };
  sweepSoon();
  const card = cardGateway();
  const lines = await prisma.marketCartItem.findMany({
    where: { cart: { shopperId: shopper.id }, storeId },
    select: { productId: true },
  });
  const products = await prisma.product.findMany({
    where: { id: { in: lines.map((line) => line.productId) }, storeId, deletedAt: null },
    select: { instalmentsEligible: true, instalmentsCashPrice: true },
  });
  const eligible = products.length > 0 && products.every((row) => row.instalmentsEligible);
  const cashPrice = products.length > 0 && products.every((row) => row.instalmentsCashPrice);
  const offers = await Promise.all(
    lenders().map(async (entry) => {
      const account = await entry.account(shopper.phoneNormalized);
      const minMonths = entry.minMonths(goodsIqd);
      const terms = entry.terms
        .filter((term) => term.months >= minMonths)
        .map((term) => monthlyFor(goodsIqd, term, cashPrice));
      const reason = !eligible
        ? "بعض منتجات هذا الطلب غير متاحة بالتقسيط."
        : goodsIqd < entry.minimumIqd
          ? `أقلّ مبلغ للتقسيط لدى هذه الجهة ${entry.minimumIqd.toLocaleString("ar-IQ")} د.ع.`
          : !account.hasAccount
            ? account.reason
            : goodsIqd > account.capacityIqd
              ? `سعتك المتاحة ${account.capacityIqd.toLocaleString("ar-IQ")} د.ع — أقلّ من قيمة الطلب.`
              : null;
      return {
        id: entry.id,
        name: entry.name,
        available: reason === null,
        reason,
        capacityIqd: account.hasAccount ? account.capacityIqd : null,
        minMonths,
        terms,
      };
    })
  );
  return {
    card: card ? { id: card.id, name: card.name } : null,
    instalments: { goodsIqd, cashPrice, deliveryPaidInCash: true, lenders: offers },
  };
}
