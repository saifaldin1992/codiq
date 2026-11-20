/**
 * codiq — merchant-facing delivery-rate management.
 * Rates are seeded disabled for all 18 governorates at store creation; this
 * service is the only write path to price/enable them. The governorate set is
 * fixed by the bootstrap seed — rows are updated in place, never created here.
 */
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";

const rateSelect = { governorate: true, amountIqd: true, isEnabled: true, updatedAt: true } as const;

/**
 * 19-د — THE CEILING ON A DELIVERY FEE, and what it is and is not for.
 *
 * `commissionFor` is fed the goods subtotal only; the delivery fee is stored
 * beside it and paid back to the merchant in full (ADR-006: «رسوم التوصيل تمر
 * للتاجر كاملة» — delivery is an operating cost in the Iraqi COD model). That
 * split is a deliberate owner decision and it does NOT move here.
 *
 * What was missing is any bound at all. The service checked `>= 0`, the schema
 * checked `>= 0`, the database checks `>= 0` — so the real ceiling was int4's
 * 2,147,483,647, and a merchant with `settings.manage` could price goods at
 * 1,000 and delivery at 99,000 on all eighteen governorates, shifting his
 * takings almost entirely out of what the platform charges on. Nothing in the
 * product flagged the ratio and no platform route even displays a store's
 * delivery rates.
 *
 * 50,000 IQD is roughly $38 and five to fifteen times a real Iraqi courier fee,
 * inter-governorate rates included. It is chosen to be unarguably above any
 * genuine delivery price rather than to be tight — a bound that refuses a rate
 * an honest merchant might set would be worse than none, which is exactly what
 * the delivery-rate schema warned about when it declined to invent one.
 *
 * IT IS NOT A COMPLETE ANSWER, and must not be read as one. A ceiling cannot
 * stop a RATIO shift: a 30/70 goods-to-delivery split stays legal under it, and
 * only the absurd version is refused. The other half is visibility —
 * `platformFinanceReport` now reports each merchant's delivery-to-subtotal
 * ratio, so the shift is legible to whoever settles him. Whether delivery
 * should enter the commission base at all is the owner's call and is untouched.
 */
export const MAX_DELIVERY_RATE_IQD = 50_000;

export async function listDeliveryRates(storeId: string) {
  return prisma.deliveryRate.findMany({ where: { storeId }, orderBy: { governorate: "asc" }, select: rateSelect });
}

export async function updateDeliveryRate(storeId: string, rawGovernorate: unknown, body: Record<string, unknown>) {
  const governorate = typeof rawGovernorate === "string" ? rawGovernorate.trim() : "";
  if (!governorate) throw new HttpError(422, "INVALID_INPUT", "governorate is required.");
  if (body.amountIqd === undefined && body.isEnabled === undefined) {
    throw new HttpError(422, "INVALID_INPUT", "At least one of amountIqd or isEnabled is required.");
  }
  if (body.amountIqd !== undefined && (typeof body.amountIqd !== "number" || !Number.isInteger(body.amountIqd) || body.amountIqd < 0)) {
    throw new HttpError(422, "INVALID_INPUT", "amountIqd must be a non-negative integer.");
  }
  if (body.amountIqd !== undefined && (body.amountIqd as number) > MAX_DELIVERY_RATE_IQD) {
    throw new HttpError(422, "DELIVERY_RATE_TOO_HIGH", `أجرة التوصيل لا تتجاوز ${MAX_DELIVERY_RATE_IQD.toLocaleString("en-US")} دينار للمحافظة الواحدة.`);
  }
  if (body.isEnabled !== undefined && typeof body.isEnabled !== "boolean") {
    throw new HttpError(422, "INVALID_INPUT", "isEnabled must be boolean.");
  }
  const existing = await prisma.deliveryRate.findUnique({ where: { storeId_governorate: { storeId, governorate } }, select: { id: true } });
  if (!existing) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested delivery governorate was not found for this store.");
  return prisma.deliveryRate.update({
    where: { id: existing.id },
    data: {
      ...(body.amountIqd !== undefined ? { amountIqd: body.amountIqd } : {}),
      ...(body.isEnabled !== undefined ? { isEnabled: body.isEnabled } : {}),
    },
    select: rateSelect,
  });
}
