/**
 * codiq P27-7 — demo environment seed.
 *
 * WHAT THIS IS
 * The demo environment is a fourth Railway environment fed by the same `main`
 * branch as production, with its own Neon database branch. This script wipes that
 * database and rebuilds one realistic Iraqi store so every screen a prospect opens
 * — catalog, orders, analytics, finance, team, coupons — has meaningful content.
 * It is idempotent by construction: it truncates and rebuilds, so running it twice
 * leaves exactly the same dataset. It is scheduled nightly (see
 * docs/DEMO_ENVIRONMENT.md) so the demo returns clean every morning.
 *
 * DEMO LOGINS (documented for prospects; safe to publish — this database holds
 * nothing but fabricated data and is wiped every night):
 *   merchant : demo@codiq.iq        / CodiqDemo2026!
 *   staff    : staff.demo@codiq.iq  / CodiqDemoStaff2026!   (store: demo-store)
 *   customer : +9647701000001       / CodiqDemoCustomer2026!
 * One-click guest entry needs no credentials at all: POST /api/public/demo-login,
 * or the /demo page in the client.
 *
 * TWO REFUSALS BEFORE ANY WRITE (assertDemoSeedTarget):
 *   1. CODIQ_DEMO_MODE must be exactly "true";
 *   2. the resolved database URL must contain "demo".
 * Either missing and the script exits non-zero having touched nothing. This is the
 * only thing standing between a mistyped DATABASE_URL and a truncated production
 * database, so it runs first and unconditionally.
 *
 * Run: pnpm demo:seed
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPasswordHash } from "../src/auth/identity.js";
import { config, demoModeFromEnv } from "../src/config.js";
import { resolveCodiqDatabaseUrl } from "../src/db/database-url.js";
import { prisma } from "../src/db/prisma.js";
import {
  DEMO_MERCHANT_EMAIL,
  DEMO_MERCHANT_PASSWORD,
  DEMO_STAFF_EMAIL,
  DEMO_STAFF_PASSWORD,
  DEMO_STORE_SLUG,
} from "../src/demo/demo-mode.js";
import { createStoreFoundation } from "../src/services/store-bootstrap.service.js";

export const DEMO_CUSTOMER_PASSWORD = "CodiqDemoCustomer2026!";
const DEMO_STORE_NAME = "متجر رواء";
const DEMO_BUSINESS_NAME = "رواء للتجارة العامة";
const DEMO_PLAN_CODE = "growth";

/**
 * The two refusals. Exported so the integration suite can prove them directly
 * without pointing the destructive path at a non-demo database.
 */
export function assertDemoSeedTarget(environment: NodeJS.ProcessEnv = process.env): string {
  if (!demoModeFromEnv(environment)) {
    throw new Error(
      'Refusing to seed: CODIQ_DEMO_MODE must be "true". This script only ever runs in the demo environment.'
    );
  }
  const databaseUrl = resolveCodiqDatabaseUrl(environment);
  if (!databaseUrl.toLowerCase().includes("demo")) {
    throw new Error(
      'Refusing to seed: the database URL does not contain "demo". Point CODIQ_POSTGRES_URL at the demo Neon branch before seeding.'
    );
  }
  return databaseUrl;
}

/** Everything tenant-owned. `plans`, `plan_features` and `platform_settings` are migration-owned and survive. */
const TENANT_TABLES = [
  "storefront_rate_limits",
  "store_marketing_settings",
  "order_prescriptions",
  "coupon_redemptions",
  "coupons",
  "settlements",
  "ledger_entries",
  "notification_outbox",
  "staff_sessions",
  "staff_membership_permission_overrides",
  "store_staff_memberships",
  "staff",
  "inventory_reservations",
  "checkout_requests",
  "cart_items",
  "shopping_carts",
  "customer_addresses",
  "order_status_events",
  "order_items",
  "store_orders",
  "inventory_movements",
  "product_images",
  "product_variants",
  "products",
  "product_categories",
  "customer_sessions",
  "customers",
  "merchant_sessions",
  "stores",
  "plan_upgrade_requests",
  "merchant_subscriptions",
  "merchants",
  "platform_owner_sessions",
  "platform_owners",
].join(", ");

function daysAgo(days: number, hour = 11): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  date.setUTCHours(hour, 0, 0, 0);
  return date;
}

type SeededVariant = {
  sku: string;
  name: string;
  priceIqd: number;
  stockQuantity: number;
  options: Record<string, string>;
};
type SeededProduct = {
  sku: string;
  name: string;
  description: string;
  priceIqd: number;
  stockQuantity: number;
  lowStockThreshold: number;
  category: string;
  variants?: SeededVariant[];
};

/** Nested tree: three roots, five children — enough to show the hierarchy in the picker. */
const CATEGORY_TREE: { name: string; children: string[] }[] = [
  { name: "إلكترونيات", children: ["هواتف وأجهزة لوحية", "سماعات وصوتيات"] },
  { name: "المنزل والمطبخ", children: ["أجهزة صغيرة"] },
  { name: "أزياء", children: ["رجالي", "نسائي"] },
];

const PRODUCTS: SeededProduct[] = [
  {
    sku: "PHN-NOVA12",
    name: "هاتف نوفا 12",
    description: "هاتف ذكي بشاشة AMOLED مقاس 6.7 بوصة وبطارية 5000 ملي أمبير.",
    priceIqd: 420_000,
    stockQuantity: 14,
    lowStockThreshold: 4,
    category: "هواتف وأجهزة لوحية",
    variants: [
      {
        sku: "PHN-NOVA12-128",
        name: "سعة 128 غيغابايت",
        priceIqd: 420_000,
        stockQuantity: 9,
        options: { السعة: "128GB" },
      },
      {
        sku: "PHN-NOVA12-256",
        name: "سعة 256 غيغابايت",
        priceIqd: 495_000,
        stockQuantity: 5,
        options: { السعة: "256GB" },
      },
    ],
  },
  {
    sku: "TAB-S9LITE",
    name: "جهاز لوحي تاب إس لايت",
    description: "جهاز لوحي بشاشة 10.4 بوصة مع قلم رقمي.",
    priceIqd: 310_000,
    stockQuantity: 8,
    lowStockThreshold: 3,
    category: "هواتف وأجهزة لوحية",
  },
  {
    sku: "AUD-AIRPRO",
    name: "سماعة أذن لاسلكية إير برو",
    description: "عزل ضوضاء نشط وعمر بطارية 28 ساعة مع علبة الشحن.",
    priceIqd: 95_000,
    stockQuantity: 26,
    lowStockThreshold: 6,
    category: "سماعات وصوتيات",
    variants: [
      {
        sku: "AUD-AIRPRO-WHT",
        name: "أبيض لؤلؤي",
        priceIqd: 95_000,
        stockQuantity: 15,
        options: { اللون: "أبيض" },
      },
      {
        sku: "AUD-AIRPRO-BLK",
        name: "أسود مطفي",
        priceIqd: 95_000,
        stockQuantity: 11,
        options: { اللون: "أسود" },
      },
    ],
  },
  {
    sku: "AUD-STUDIO",
    name: "سماعة رأس ستوديو",
    description: "سماعة رأس سلكية للاستوديو بمشبك أذن مريح.",
    priceIqd: 145_000,
    stockQuantity: 7,
    lowStockThreshold: 3,
    category: "سماعات وصوتيات",
  },
  {
    sku: "ACC-CHG65",
    name: "شاحن سريع 65 واط",
    description: "شاحن جداري بثلاثة منافذ يدعم الشحن السريع للحواسيب المحمولة.",
    priceIqd: 32_000,
    stockQuantity: 40,
    lowStockThreshold: 10,
    category: "إلكترونيات",
  },
  {
    sku: "WCH-FIT3",
    name: "ساعة ذكية فيت 3",
    description: "تتبع النوم ومعدل النبض ومقاومة الماء حتى 50 متراً.",
    priceIqd: 175_000,
    stockQuantity: 12,
    lowStockThreshold: 4,
    category: "إلكترونيات",
    variants: [
      {
        sku: "WCH-FIT3-SIL",
        name: "حزام سيليكون",
        priceIqd: 175_000,
        stockQuantity: 8,
        options: { الحزام: "سيليكون" },
      },
      {
        sku: "WCH-FIT3-LTH",
        name: "حزام جلد طبيعي",
        priceIqd: 198_000,
        stockQuantity: 4,
        options: { الحزام: "جلد" },
      },
    ],
  },
  {
    sku: "HOM-KETTLE",
    name: "غلاية كهربائية 1.7 لتر",
    description: "غلاية ستانلس ستيل بإيقاف تلقائي عند الغليان.",
    priceIqd: 48_000,
    stockQuantity: 22,
    lowStockThreshold: 5,
    category: "أجهزة صغيرة",
  },
  {
    sku: "HOM-BLEND",
    name: "خلاط متعدد السرعات",
    description: "خلاط 800 واط بوعاء زجاجي سعة 1.5 لتر.",
    priceIqd: 87_000,
    stockQuantity: 9,
    lowStockThreshold: 3,
    category: "أجهزة صغيرة",
  },
  {
    sku: "HOM-PREP12",
    name: "طقم أواني تحضير 12 قطعة",
    description: "طقم أوعية تحضير بأغطية محكمة، آمن في غسالة الصحون.",
    priceIqd: 65_000,
    stockQuantity: 16,
    lowStockThreshold: 4,
    category: "المنزل والمطبخ",
  },
  {
    sku: "APP-SHIRT",
    name: "قميص قطني كلاسيكي",
    description: "قطن مصري 100% بقصة مريحة تناسب العمل والمناسبات.",
    priceIqd: 28_000,
    stockQuantity: 44,
    lowStockThreshold: 8,
    category: "رجالي",
    variants: [
      {
        sku: "APP-SHIRT-S",
        name: "مقاس S",
        priceIqd: 28_000,
        stockQuantity: 9,
        options: { المقاس: "S" },
      },
      {
        sku: "APP-SHIRT-M",
        name: "مقاس M",
        priceIqd: 28_000,
        stockQuantity: 16,
        options: { المقاس: "M" },
      },
      {
        sku: "APP-SHIRT-L",
        name: "مقاس L",
        priceIqd: 28_000,
        stockQuantity: 13,
        options: { المقاس: "L" },
      },
      {
        sku: "APP-SHIRT-XL",
        name: "مقاس XL",
        priceIqd: 30_000,
        stockQuantity: 6,
        options: { المقاس: "XL" },
      },
    ],
  },
  // Deliberately below its threshold so the low-stock badge and the low-stock
  // notification preference have something real to point at.
  {
    sku: "APP-JACKET",
    name: "جاكيت شتوي مبطن",
    description: "جاكيت مقاوم للماء ببطانة حرارية خفيفة.",
    priceIqd: 96_000,
    stockQuantity: 2,
    lowStockThreshold: 5,
    category: "رجالي",
  },
  {
    sku: "APP-ABAYA",
    name: "عباءة كتان مطرزة",
    description: "كتان طبيعي بتطريز يدوي على الأكمام.",
    priceIqd: 72_000,
    stockQuantity: 18,
    lowStockThreshold: 4,
    category: "نسائي",
    variants: [
      {
        sku: "APP-ABAYA-38",
        name: "مقاس 38",
        priceIqd: 72_000,
        stockQuantity: 7,
        options: { المقاس: "38" },
      },
      {
        sku: "APP-ABAYA-40",
        name: "مقاس 40",
        priceIqd: 72_000,
        stockQuantity: 6,
        options: { المقاس: "40" },
      },
      {
        sku: "APP-ABAYA-42",
        name: "مقاس 42",
        priceIqd: 75_000,
        stockQuantity: 5,
        options: { المقاس: "42" },
      },
    ],
  },
];

/** Enabled for a handful of governorates only — an unconfigured one must still refuse delivery. */
const ENABLED_DELIVERY_RATES: { governorate: string; amountIqd: number }[] = [
  { governorate: "Baghdad", amountIqd: 5_000 },
  { governorate: "Basra", amountIqd: 8_000 },
  { governorate: "Erbil", amountIqd: 7_000 },
  { governorate: "Najaf", amountIqd: 6_000 },
  { governorate: "Karbala", amountIqd: 6_000 },
];

type SeededOrderLine = { sku: string; quantity: number };
type SeededOrder = {
  number: string;
  status: string;
  daysAgo: number;
  customer: 0 | 1 | null;
  customerName: string;
  governorate: string;
  addressLine1: string;
  lines: SeededOrderLine[];
  coupon?: "WELCOME10";
  /** completed → a ledger entry; returned → completion plus its reversal. */
  paymentStatus?: "paid" | "unpaid";
};

/**
 * Fifteen orders spread across 45 days and every status the lifecycle allows, so
 * the sales series, the status funnel and the finance ledger all render curves
 * instead of empty states.
 */
const ORDERS: SeededOrder[] = [
  {
    number: "DMO-1001",
    status: "completed",
    daysAgo: 42,
    customer: 0,
    customerName: "زينب الجبوري",
    governorate: "Baghdad",
    addressLine1: "الكرادة، شارع 62",
    lines: [
      { sku: "PHN-NOVA12-128", quantity: 1 },
      { sku: "ACC-CHG65", quantity: 1 },
    ],
    paymentStatus: "paid",
  },
  {
    number: "DMO-1002",
    status: "completed",
    daysAgo: 36,
    customer: 1,
    customerName: "أحمد الربيعي",
    governorate: "Basra",
    addressLine1: "العشار، قرب ساحة أم البروم",
    lines: [{ sku: "AUD-AIRPRO-BLK", quantity: 2 }],
    paymentStatus: "paid",
  },
  {
    number: "DMO-1003",
    status: "completed",
    daysAgo: 29,
    customer: 0,
    customerName: "زينب الجبوري",
    governorate: "Baghdad",
    addressLine1: "الكرادة، شارع 62",
    lines: [{ sku: "APP-SHIRT-M", quantity: 3 }],
    coupon: "WELCOME10",
    paymentStatus: "paid",
  },
  {
    number: "DMO-1004",
    status: "completed",
    daysAgo: 24,
    customer: 1,
    customerName: "أحمد الربيعي",
    governorate: "Basra",
    addressLine1: "العشار، قرب ساحة أم البروم",
    lines: [{ sku: "WCH-FIT3-LTH", quantity: 1 }],
    paymentStatus: "paid",
  },
  {
    number: "DMO-1005",
    status: "completed",
    daysAgo: 21,
    customer: null,
    customerName: "مصطفى الحسن",
    governorate: "Erbil",
    addressLine1: "عنكاوا، شارع الكنائس",
    lines: [
      { sku: "HOM-BLEND", quantity: 1 },
      { sku: "HOM-KETTLE", quantity: 1 },
    ],
    paymentStatus: "paid",
  },
  {
    number: "DMO-1006",
    status: "cancelled",
    daysAgo: 18,
    customer: null,
    customerName: "هدى الساعدي",
    governorate: "Najaf",
    addressLine1: "حي السلام، محلة 204",
    lines: [{ sku: "TAB-S9LITE", quantity: 1 }],
  },
  {
    number: "DMO-1007",
    status: "completed",
    daysAgo: 15,
    customer: 0,
    customerName: "زينب الجبوري",
    governorate: "Baghdad",
    addressLine1: "الكرادة، شارع 62",
    lines: [
      { sku: "APP-ABAYA-40", quantity: 1 },
      { sku: "APP-SHIRT-L", quantity: 1 },
    ],
    paymentStatus: "paid",
  },
  {
    number: "DMO-1008",
    status: "rejected",
    daysAgo: 13,
    customer: null,
    customerName: "علي الدليمي",
    governorate: "Karbala",
    addressLine1: "حي الحسين، شارع 14",
    lines: [{ sku: "AUD-STUDIO", quantity: 1 }],
  },
  // Returned within the 15-day reversal window (ADR-006), so the ledger shows the
  // automatic reversal exactly as the live lifecycle would have written it.
  {
    number: "DMO-1009",
    status: "returned",
    daysAgo: 10,
    customer: 1,
    customerName: "أحمد الربيعي",
    governorate: "Basra",
    addressLine1: "العشار، قرب ساحة أم البروم",
    lines: [{ sku: "HOM-PREP12", quantity: 2 }],
    paymentStatus: "paid",
  },
  {
    number: "DMO-1010",
    status: "out_for_delivery",
    daysAgo: 4,
    customer: 0,
    customerName: "زينب الجبوري",
    governorate: "Baghdad",
    addressLine1: "الكرادة، شارع 62",
    lines: [{ sku: "PHN-NOVA12-256", quantity: 1 }],
  },
  {
    number: "DMO-1011",
    status: "preparation",
    daysAgo: 3,
    customer: null,
    customerName: "نور العبيدي",
    governorate: "Erbil",
    addressLine1: "شقلاوة، الشارع العام",
    lines: [{ sku: "APP-JACKET", quantity: 1 }],
  },
  {
    number: "DMO-1012",
    status: "processing",
    daysAgo: 2,
    customer: 1,
    customerName: "أحمد الربيعي",
    governorate: "Basra",
    addressLine1: "العشار، قرب ساحة أم البروم",
    lines: [
      { sku: "AUD-AIRPRO-WHT", quantity: 1 },
      { sku: "ACC-CHG65", quantity: 2 },
    ],
  },
  {
    number: "DMO-1013",
    status: "processing",
    daysAgo: 1,
    customer: null,
    customerName: "سجى الطائي",
    governorate: "Najaf",
    addressLine1: "حي الأمير، محلة 308",
    lines: [{ sku: "HOM-KETTLE", quantity: 1 }],
  },
  {
    number: "DMO-1014",
    status: "new",
    daysAgo: 1,
    customer: 0,
    customerName: "زينب الجبوري",
    governorate: "Baghdad",
    addressLine1: "الكرادة، شارع 62",
    lines: [{ sku: "APP-SHIRT-XL", quantity: 2 }],
  },
  {
    number: "DMO-1015",
    status: "new",
    daysAgo: 0,
    customer: null,
    customerName: "كرار الموسوي",
    governorate: "Karbala",
    addressLine1: "حي المعلمين، شارع 3",
    lines: [{ sku: "WCH-FIT3-SIL", quantity: 1 }],
  },
];

/** The status trail an order of each status would really have walked. */
const STATUS_PATHS: Record<string, string[]> = {
  new: [],
  processing: ["processing"],
  preparation: ["processing", "preparation"],
  out_for_delivery: ["processing", "preparation", "out_for_delivery"],
  completed: ["processing", "preparation", "out_for_delivery", "completed"],
  returned: ["processing", "preparation", "out_for_delivery", "completed", "returned"],
  cancelled: ["cancelled"],
  rejected: ["rejected"],
};

export interface DemoSeedSummary {
  merchantId: string;
  storeId: string;
  storeSlug: string;
  categories: number;
  products: number;
  variants: number;
  orders: number;
  ledgerEntries: number;
  customers: number;
  coupons: number;
  deliveryRates: number;
}

export async function seedDemoData(): Promise<DemoSeedSummary> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TENANT_TABLES} CASCADE`);

  const plan = await prisma.plan.findUnique({
    where: { code: DEMO_PLAN_CODE },
    select: { id: true, code: true, commissionBps: true },
  });
  if (!plan)
    throw new Error(
      `Refusing to seed: plan "${DEMO_PLAN_CODE}" is missing — run pnpm phase1:db:migrate first.`
    );

  const merchant = await prisma.merchant.create({
    data: {
      email: DEMO_MERCHANT_EMAIL,
      passwordHash: await createPasswordHash(DEMO_MERCHANT_PASSWORD),
      businessName: DEMO_BUSINESS_NAME,
      isActive: true,
      approvalStatus: "approved",
    },
    select: { id: true },
  });
  // A paid plan, so commission, entitlement limits and the upgrade path are all
  // visible instead of sitting at the free-plan defaults.
  await prisma.merchantSubscription.create({
    data: { merchantId: merchant.id, planId: plan.id, status: "active", startedAt: daysAgo(60) },
  });

  const store = await createStoreFoundation({
    merchantId: merchant.id,
    name: DEMO_STORE_NAME,
    slug: DEMO_STORE_SLUG,
    defaultSubdomain: DEMO_STORE_SLUG,
  });
  for (const rate of ENABLED_DELIVERY_RATES) {
    await prisma.deliveryRate.update({
      where: { storeId_governorate: { storeId: store.id, governorate: rate.governorate } },
      data: { amountIqd: rate.amountIqd, isEnabled: true },
    });
  }
  await prisma.notificationSettings.update({
    where: { storeId: store.id },
    // Enabled so the outbox actually queues; the demo provider is forced to the
    // null/skip path in notification-provider.ts, so nothing ever leaves the box.
    data: {
      isEnabled: true,
      configuration: {
        preferences: { orderCreated: true, orderStatusChanged: true, lowStock: true },
      },
    },
  });

  const categoryIds = new Map<string, string>();
  for (const root of CATEGORY_TREE) {
    const created = await prisma.productCategory.create({
      data: {
        storeId: store.id,
        name: root.name,
        normalizedName: root.name.trim().toLocaleLowerCase("ar-IQ"),
      },
      select: { id: true },
    });
    categoryIds.set(root.name, created.id);
    for (const child of root.children) {
      const createdChild = await prisma.productCategory.create({
        data: {
          storeId: store.id,
          name: child,
          normalizedName: child.trim().toLocaleLowerCase("ar-IQ"),
          parentCategoryId: created.id,
        },
        select: { id: true },
      });
      categoryIds.set(child, createdChild.id);
    }
  }

  // sku → variantId, for the order lines below. Products without explicit variants
  // are reachable through their own sku (the trigger-created default variant).
  const variantBySku = new Map<
    string,
    {
      id: string;
      productId: string;
      productName: string;
      variantName: string | null;
      priceIqd: number;
    }
  >();
  let variantCount = 0;
  for (const definition of PRODUCTS) {
    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        categoryId: categoryIds.get(definition.category) ?? null,
        sku: definition.sku,
        name: definition.name,
        description: definition.description,
        priceIqd: definition.priceIqd,
        stockQuantity: definition.stockQuantity,
        lowStockThreshold: definition.lowStockThreshold,
        isActive: true,
      },
      select: { id: true, name: true },
    });
    // The products_create_default_variant trigger already materialized the default
    // variant from the product columns. For a product with real options the first
    // option BECOMES that default (renamed in place) so the picker shows exactly
    // the intended options with no phantom entry; the rest are appended.
    const [first, ...rest] = definition.variants ?? [];
    if (first) {
      // PG-2: UNIQUE(store_id, sku) on variants became a PARTIAL index, so the
      // composite findUnique key is gone — the default variant is addressed by
      // its product instead, which is the identity that actually matters here.
      const seededDefault = await prisma.productVariant.findFirstOrThrow({
        where: { productId: product.id, isDefault: true },
        select: { id: true },
      });
      const defaultVariant = await prisma.productVariant.update({
        where: { id: seededDefault.id },
        data: {
          sku: first.sku,
          name: first.name,
          priceIqd: first.priceIqd,
          stockQuantity: first.stockQuantity,
          options: first.options,
          position: 0,
        },
        select: { id: true, priceIqd: true },
      });
      variantBySku.set(first.sku, {
        id: defaultVariant.id,
        productId: product.id,
        productName: product.name,
        variantName: first.name,
        priceIqd: first.priceIqd,
      });
      variantCount += 1;
      let position = 1;
      for (const option of rest) {
        const variant = await prisma.productVariant.create({
          data: {
            storeId: store.id,
            productId: product.id,
            sku: option.sku,
            name: option.name,
            priceIqd: option.priceIqd,
            stockQuantity: option.stockQuantity,
            lowStockThreshold: definition.lowStockThreshold,
            isDefault: false,
            isActive: true,
            position,
            options: option.options,
          },
          select: { id: true },
        });
        variantBySku.set(option.sku, {
          id: variant.id,
          productId: product.id,
          productName: product.name,
          variantName: option.name,
          priceIqd: option.priceIqd,
        });
        variantCount += 1;
        position += 1;
      }
    } else {
      const defaultVariant = await prisma.productVariant.findFirstOrThrow({
        where: { productId: product.id, isDefault: true },
        select: { id: true },
      });
      variantBySku.set(definition.sku, {
        id: defaultVariant.id,
        productId: product.id,
        productName: product.name,
        variantName: null,
        priceIqd: definition.priceIqd,
      });
      variantCount += 1;
    }
    await prisma.inventoryMovement.create({
      data: {
        storeId: store.id,
        productId: product.id,
        delta: definition.stockQuantity,
        reason: "initial_stock",
        createdAt: daysAgo(50),
      },
    });
  }

  const coupons = await Promise.all([
    prisma.coupon.create({
      data: {
        storeId: store.id,
        code: "WELCOME10",
        codeNormalized: "WELCOME10",
        kind: "percent",
        percentOff: 10,
        minSubtotalIqd: 50_000,
        maxUsesTotal: 100,
        maxUsesPerCustomer: 1,
        isActive: true,
        startsAt: daysAgo(45),
      },
      select: { id: true, code: true },
    }),
    prisma.coupon.create({
      data: {
        storeId: store.id,
        code: "FREESHIP",
        codeNormalized: "FREESHIP",
        kind: "free_shipping",
        minSubtotalIqd: 100_000,
        maxUsesPerCustomer: 2,
        isActive: true,
        startsAt: daysAgo(20),
      },
      select: { id: true, code: true },
    }),
  ]);
  const welcomeCoupon = coupons[0];

  // store_staff already holds only the operational four codes; the two overrides
  // show both effects at work (grants customers.view, removes inventory.update).
  const staff = await prisma.staff.create({
    data: {
      email: DEMO_STAFF_EMAIL,
      passwordHash: await createPasswordHash(DEMO_STAFF_PASSWORD),
      displayName: "سارة — موظفة المتجر",
      isActive: true,
    },
    select: { id: true },
  });
  const membership = await prisma.storeStaffMembership.create({
    data: { staffId: staff.id, storeId: store.id, roleCode: "store_staff", isActive: true },
    select: { id: true },
  });
  await prisma.staffMembershipPermissionOverride.createMany({
    data: [
      { membershipId: membership.id, permissionCode: "customers.view", effect: "allow" },
      { membershipId: membership.id, permissionCode: "inventory.update", effect: "deny" },
    ],
  });

  const customerPassword = await createPasswordHash(DEMO_CUSTOMER_PASSWORD);
  const customerSeeds = [
    {
      fullName: "زينب الجبوري",
      phone: "+9647701000001",
      email: "zainab.demo@codiq.iq",
      governorate: "Baghdad",
      city: "بغداد",
      address: "الكرادة، شارع 62، بناية 14",
    },
    {
      fullName: "أحمد الربيعي",
      phone: "+9647701000002",
      email: "ahmed.demo@codiq.iq",
      governorate: "Basra",
      city: "البصرة",
      address: "العشار، قرب ساحة أم البروم",
    },
  ];
  const customers: { id: string }[] = [];
  for (const seed of customerSeeds) {
    const customer = await prisma.customer.create({
      data: {
        storeId: store.id,
        fullName: seed.fullName,
        email: seed.email,
        phone: seed.phone,
        phoneNormalized: seed.phone,
        passwordHash: customerPassword,
        isActive: true,
        createdAt: daysAgo(44),
      },
      select: { id: true },
    });
    await prisma.customerAddress.create({
      data: {
        storeId: store.id,
        customerId: customer.id,
        recipientName: seed.fullName,
        fullAddress: seed.address,
        city: seed.city,
        governorate: seed.governorate,
        phoneContactNormalized: seed.phone,
        isDefault: true,
        createdAt: daysAgo(44),
      },
    });
    customers.push(customer);
  }

  const deliveryByGovernorate = new Map(
    ENABLED_DELIVERY_RATES.map((rate) => [rate.governorate, rate.amountIqd])
  );
  let ledgerEntries = 0;
  for (const order of ORDERS) {
    const placedAt = daysAgo(order.daysAgo, 9 + (order.daysAgo % 8));
    const lines = order.lines.map((line) => {
      const variant = variantBySku.get(line.sku);
      if (!variant)
        throw new Error(`Demo order ${order.number} references unknown sku ${line.sku}`);
      return { line, variant };
    });
    const subtotalIqd = lines.reduce(
      (sum, entry) => sum + entry.variant.priceIqd * entry.line.quantity,
      0
    );
    const deliveryFeeIqd = deliveryByGovernorate.get(order.governorate) ?? 5_000;
    const discountIqd = order.coupon ? Math.floor((subtotalIqd * 10) / 100) : 0;
    const customerId = order.customer === null ? null : customers[order.customer].id;
    const statusUpdatedAt =
      order.status === "new" ? placedAt : daysAgo(Math.max(0, order.daysAgo - 1), 15);

    const created = await prisma.storeOrder.create({
      data: {
        storeId: store.id,
        customerId,
        orderNumber: order.number,
        status: order.status,
        customerName: order.customerName,
        customerEmail: null,
        recipientPhone:
          order.customer === null ? "+9647701000009" : customerSeeds[order.customer].phone,
        shippingGovernorate: order.governorate,
        shippingAddressLine1: order.addressLine1,
        subtotalIqd,
        deliveryFeeIqd,
        discountIqd,
        couponId: order.coupon ? welcomeCoupon.id : null,
        couponCode: order.coupon ?? null,
        totalIqd: subtotalIqd - discountIqd + deliveryFeeIqd,
        paymentStatus: order.paymentStatus ?? "unpaid",
        paymentMethodCode: "cod",
        source: customerId ? "storefront" : "legacy",
        version: 1 + (STATUS_PATHS[order.status]?.length ?? 0),
        statusUpdatedAt,
        updatedByKind: order.status === "new" ? null : "merchant",
        createdAt: placedAt,
        items: {
          create: lines.map((entry) => ({
            productId: entry.variant.productId,
            variantId: entry.variant.id,
            productName: entry.variant.productName,
            variantName: entry.variant.variantName,
            sku: entry.line.sku,
            quantity: entry.line.quantity,
            unitPriceIqd: entry.variant.priceIqd,
            lineTotalIqd: entry.variant.priceIqd * entry.line.quantity,
            createdAt: placedAt,
          })),
        },
      },
      select: { id: true },
    });

    const path = STATUS_PATHS[order.status] ?? [];
    let fromStatus = "new";
    let step = 0;
    await prisma.orderStatusEvent.create({
      data: {
        storeId: store.id,
        orderId: created.id,
        fromStatus: null,
        toStatus: "new",
        actorKind: customerId ? "customer" : "merchant",
        createdAt: placedAt,
      },
    });
    for (const toStatus of path) {
      step += 1;
      await prisma.orderStatusEvent.create({
        data: {
          storeId: store.id,
          orderId: created.id,
          fromStatus,
          toStatus,
          actorKind: "merchant",
          createdAt: new Date(placedAt.valueOf() + step * 6 * 60 * 60 * 1000),
        },
      });
      fromStatus = toStatus;
    }

    if (order.coupon && customerId) {
      await prisma.couponRedemption.create({
        data: {
          storeId: store.id,
          couponId: welcomeCoupon.id,
          orderId: created.id,
          customerId,
          discountIqd,
          waivedDeliveryFeeIqd: 0,
          createdAt: placedAt,
        },
      });
    }

    // Finance mirrors the real lifecycle: completion books the DISCOUNTED subtotal
    // with the plan's commission snapshot, and the return books its reversal.
    if (order.status === "completed" || order.status === "returned") {
      const bookedSubtotal = subtotalIqd - discountIqd;
      const commissionIqd = Math.round((bookedSubtotal * plan.commissionBps) / 10_000);
      const completedAt = new Date(
        placedAt.valueOf() + path.indexOf("completed") * 6 * 60 * 60 * 1000 + 6 * 60 * 60 * 1000
      );
      await prisma.ledgerEntry.create({
        data: {
          storeId: store.id,
          orderId: created.id,
          entryType: "order_completed",
          subtotalIqd: bookedSubtotal,
          deliveryFeeIqd,
          commissionIqd,
          commissionBps: plan.commissionBps,
          planCode: plan.code,
          createdAt: completedAt,
        },
      });
      ledgerEntries += 1;
      if (order.status === "returned") {
        await prisma.ledgerEntry.create({
          data: {
            storeId: store.id,
            orderId: created.id,
            entryType: "order_returned",
            subtotalIqd: bookedSubtotal,
            deliveryFeeIqd,
            commissionIqd,
            commissionBps: plan.commissionBps,
            planCode: plan.code,
            note: "automatic_return_reversal",
            createdAt: new Date(completedAt.valueOf() + 48 * 60 * 60 * 1000),
          },
        });
        ledgerEntries += 1;
      }
    }
  }

  return {
    merchantId: merchant.id,
    storeId: store.id,
    storeSlug: store.slug,
    categories: categoryIds.size,
    products: PRODUCTS.length,
    variants: variantCount,
    orders: ORDERS.length,
    ledgerEntries,
    customers: customers.length,
    coupons: coupons.length,
    deliveryRates: ENABLED_DELIVERY_RATES.length,
  };
}

/** CLI entry: both refusals first, then the rebuild. */
async function main() {
  assertDemoSeedTarget();
  const summary = await seedDemoData();
  console.log("[seed-demo] demo dataset rebuilt", JSON.stringify(summary, null, 2));
  console.log(
    `[seed-demo] merchant login: ${DEMO_MERCHANT_EMAIL} / ${DEMO_MERCHANT_PASSWORD} (store ${DEMO_STORE_SLUG})`
  );
  console.log(`[seed-demo] staff login:    ${DEMO_STAFF_EMAIL} / ${DEMO_STAFF_PASSWORD}`);
  console.log(
    `[seed-demo] database:       ${config.databaseUrl.replace(/:\/\/[^@]*@/, "://***@")}`
  );
}

// Only the direct `pnpm demo:seed` invocation runs the destructive path; importing
// this module (the integration suite does) is side-effect free.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main()
    .catch((error) => {
      console.error(`[seed-demo] ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
