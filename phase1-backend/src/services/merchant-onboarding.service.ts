/**
 * PG-8 (ق-76) — the new merchant's first path.
 *
 * FIVE STEPS, AND FOUR OF THEM ARE READ FROM REALITY. «أضف أول منتج» is complete
 * because a product exists, not because a flag says so. That is the acceptance
 * criterion, and the reason behind it is worth keeping visible: a manual flag
 * drifts the first time a merchant deletes the very product it claims he added,
 * and then the path lies to him about his own store.
 *
 * ⚠️ THE FOURTH STEP CREATES NOTHING.
 *
 * The plan calls it «طلب تجريبي», and its own criterion warns that such an order
 * must never reach the ledger or the analytics — «وإلا لوّث أرقام التاجر من يومه
 * الأول». Honouring that with a real row would mean excluding it at eleven
 * aggregate sites across five services today, and at every aggregate anyone
 * writes afterwards. The first one missed silently corrupts a merchant's own
 * numbers, and he would have no way to know.
 *
 * So the step RENDERS what an arriving order looks like, built from his own
 * product, and stores only the fact that he looked. He learns the same thing —
 * what happens when a customer buys — and the constraint holds by construction
 * instead of by everyone remembering forever.
 */
import { prisma } from "../db/prisma.js";

export type OnboardingStepKey =
  | "first_product"
  | "product_image"
  | "delivery_enabled"
  | "order_preview"
  | "store_published";

export interface OnboardingStep {
  key: OnboardingStepKey;
  done: boolean;
  /** Where the merchant goes to finish it. */
  href: string | null;
}

export interface MerchantOnboarding {
  visible: boolean;
  completedCount: number;
  totalCount: number;
  steps: OnboardingStep[];
  /** A live example built from HIS product — never inserted anywhere. */
  preview: {
    productName: string;
    unitPriceIqd: number;
    quantity: number;
    deliveryFeeIqd: number;
    totalIqd: number;
  } | null;
}

export async function merchantOnboarding(
  storeSlug: string,
  storeId: string
): Promise<MerchantOnboarding> {
  const base = `/merchant/stores/${encodeURIComponent(storeSlug)}/dashboard`;
  const [store, product, image, deliveryRate] = await Promise.all([
    prisma.store.findUniqueOrThrow({
      where: { id: storeId },
      select: { isActive: true, onboardingPreviewSeenAt: true, onboardingDismissedAt: true },
    }),
    prisma.product.findFirst({
      where: { storeId, deletedAt: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { name: true, priceIqd: true },
    }),
    prisma.productImage.findFirst({ where: { storeId }, select: { id: true } }),
    prisma.deliveryRate.findFirst({
      where: { storeId, isEnabled: true },
      select: { amountIqd: true },
    }),
  ]);

  const steps: OnboardingStep[] = [
    { key: "first_product", done: Boolean(product), href: `${base}/products` },
    { key: "product_image", done: Boolean(image), href: `${base}/products` },
    { key: "delivery_enabled", done: Boolean(deliveryRate), href: `${base}/settings/shipping` },
    { key: "order_preview", done: Boolean(store.onboardingPreviewSeenAt), href: null },
    { key: "store_published", done: store.isActive, href: `${base}/settings/store` },
  ];
  const completedCount = steps.filter((step) => step.done).length;

  // The preview is only meaningful once he has a product to see in it.
  const unitPriceIqd = product?.priceIqd ?? 0;
  const deliveryFeeIqd = deliveryRate?.amountIqd ?? 0;

  return {
    // Hidden once dismissed, and once finished — «يختفي نهائياً عند اكتماله».
    // Deleting his only product months later must not bring a welcome mat back.
    visible: !store.onboardingDismissedAt && completedCount < steps.length,
    completedCount,
    totalCount: steps.length,
    steps,
    preview: product
      ? {
          productName: product.name,
          unitPriceIqd,
          quantity: 1,
          deliveryFeeIqd,
          totalIqd: unitPriceIqd + deliveryFeeIqd,
        }
      : null,
  };
}

/** He looked at the example order. The only step whose state is not derivable. */
export async function markOnboardingPreviewSeen(storeId: string, now = new Date()): Promise<void> {
  await prisma.store.updateMany({
    where: { id: storeId, onboardingPreviewSeenAt: null },
    data: { onboardingPreviewSeenAt: now },
  });
}

/**
 * Skipped, or finished. Either way the path is over for good — the criterion
 * says it must never block the dashboard, and a path that returns is a block
 * spread over time.
 */
export async function dismissOnboarding(storeId: string, now = new Date()): Promise<void> {
  await prisma.store.updateMany({
    where: { id: storeId, onboardingDismissedAt: null },
    data: { onboardingDismissedAt: now },
  });
}
