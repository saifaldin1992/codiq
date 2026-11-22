/**
 * Plans and entitlements — usage. Split verbatim from
 * entitlement.service.ts (review batch 4, ت-٢);
 * entitlement.service.ts re-exports what it always exported.
 */
import { LIVE } from "../soft-delete/constants.js";
import { HttpError } from "../../auth/auth.errors.js";
import {
  type DbClient,
  type PlanFeatureCode,
  QUOTA_EXEMPT_STATUSES,
  activePlanForMerchant,
  FEATURE_LABELS,
} from "./plans.js";

function monthStartUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function merchantUsage(
  client: DbClient,
  merchantId: string
): Promise<Record<PlanFeatureCode, number>> {
  const [
    stores,
    products,
    staff,
    monthlyOrders,
    storage,
    prescriptionStorage,
    bannerStorage,
    logoStorage,
  ] = await Promise.all([
    client.store.count({ where: { merchantId } }),
    // PG-2: a product in the trash bin does NOT spend the plan quota — otherwise a
    // merchant at his limit could not replace a product for thirty days. Staff is
    // already isActive-filtered, and the image aggregate below deliberately stays
    // unfiltered: those bytes really are still stored until the purge (plan §6.6).
    client.product.count({ where: { store: { merchantId }, ...LIVE } }),
    client.storeStaffMembership.count({
      where: { isActive: true, store: { merchantId }, deletedAt: null },
    }),
    // ق-135: a COUNTER sale does not spend the monthly-order quota. The cap is
    // B-08's upgrade trigger for platform-carried volume; a POS sale never
    // passes through the platform's money path — counting it would let a busy
    // till silently block the merchant's own online shoppers at checkout.
    //
    // ق-243: NEITHER DOES AN ORDER THAT CARRIED NO MONEY. `cancelled` and
    // `rejected` are the two terminal states a row reaches WITHOUT a delivery —
    // the shopper changed his mind, or the merchant refused a fake COD order.
    // They used to spend the quota exactly like a sale, which turned the
    // merchant's own act of rejecting junk into the thing that closed his shop:
    // one phone with a script, inside the deliberately loose 40-per-address
    // checkout wall, filled a free shop's whole month in under an hour, and
    // every honest shopper after that read «المتجر لا يستقبل طلبات جديدة
    // حالياً» until the 1st. The merchant's bar said 200/200 and never that
    // sixty of those were the ones he refused.
    //
    // `returned` STAYS COUNTED, on purpose: a returned order was a real
    // delivery that passed through the platform's money path and was booked —
    // ق-135's definition of what the quota measures. The line is «did the
    // platform carry it», not «did the merchant keep the money».
    client.storeOrder.count({
      where: {
        store: { merchantId },
        createdAt: { gte: monthStartUtc() },
        source: { not: "pos" },
        status: { notIn: [...QUOTA_EXEMPT_STATUSES] },
      },
    }),
    client.productImage.aggregate({ where: { store: { merchantId } }, _sum: { byteSize: true } }),
    // 19-د: prescriptions ride the same bucket and the same 5 MB ceiling as
    // product images, and until now they were charged to NOBODY — a shopper on
    // a pharmacy store could push megabytes into the merchant's bucket for
    // free, and no plan ever noticed. Counting them here is what makes the
    // `assertWithinPlanLimit` call in the upload path a real limit rather than
    // a check against a number that never moves.
    client.orderPrescription.aggregate({
      where: { store: { merchantId } },
      _sum: { byteSize: true },
    }),
    // ق-198/ق-199: the storefront's own images — the front-page slides and the
    // logo — ride the same bucket and are charged at upload time against THIS
    // meter. Until they were summed here the charge was against a number that
    // never moved: a merchant could fill his plan with slides and the meter
    // would still read the product images alone.
    client.storeBanner.aggregate({ where: { store: { merchantId } }, _sum: { byteSize: true } }),
    client.store.aggregate({ where: { merchantId }, _sum: { logoByteSize: true } }),
  ]);
  return {
    max_stores: stores,
    max_products: products,
    max_staff: staff,
    max_monthly_orders: monthlyOrders,
    max_image_storage_mb: Math.ceil(
      ((storage._sum.byteSize ?? 0) +
        (prescriptionStorage._sum.byteSize ?? 0) +
        (bannerStorage._sum.byteSize ?? 0) +
        (logoStorage._sum.logoByteSize ?? 0)) /
        (1024 * 1024)
    ),
  };
}

/**
 * Rejects the write when current usage + increment would exceed the plan limit.
 * Runs inside the caller's transaction when one is provided so the check and the
 * write see the same snapshot.
 */
export async function assertWithinPlanLimit(
  client: DbClient,
  merchantId: string,
  feature: PlanFeatureCode,
  increment = 1,
  action = "لمتابعة الإضافة"
): Promise<void> {
  const plan = await activePlanForMerchant(client, merchantId);
  const limit = plan.limits[feature];
  const usage = await merchantUsage(client, merchantId);
  if (usage[feature] + increment > limit) {
    throw new HttpError(
      403,
      "PLAN_LIMIT_EXCEEDED",
      `وصلت إلى حد «${FEATURE_LABELS[feature]}» في خطة «${plan.name}» (${limit}). قم بالترقية ${action}.`
    );
  }
}
