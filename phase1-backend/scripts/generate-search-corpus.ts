/**
 * PG-6 (ق-74) — the realistic-data generator.
 *
 * 20-3 cannot measure anything without it, and neither can 20-1's own plan
 * gate: on a table of forty rows PostgreSQL is RIGHT to prefer a sequential
 * scan, so a plan assertion over a toy fixture asserts nothing at all. This
 * fills a store with twenty thousand products, twenty thousand customers and
 * twenty thousand orders, and a second store with a quarter of that so the
 * tenant filter has something real to exclude.
 *
 * THREE PROPERTIES IT MUST HAVE, and each is a decision:
 *
 *  1. DETERMINISTIC. A seeded mulberry32, never `Math.random`. A perf number or
 *     a query plan that changes between two runs of the same commit is a number
 *     nobody can act on, and «it passed on my machine» becomes unanswerable.
 *  2. NO NETWORK. Every name, product word and governorate is in this file. A
 *     generator that downloads a corpus fails in CI on the day the host moves,
 *     and the failure looks like a search bug.
 *  3. HONESTLY MIXED SPELLINGS. The rows are not clean. Roughly a third of the
 *     Arabic names carry the OTHER keyboard form — «احمد» beside «أحمد»,
 *     «فاطمه» beside «فاطمة», «مصطفي» beside «مصطفى», ک beside ك — plus
 *     tatweel runs, harakat, an occasional pasted ZWNJ, and Arabic-Indic digits
 *     inside SKUs. A corpus in one canonical spelling would let a NORMALIZER
 *     THAT DOES NOTHING pass every test in the suite.
 *
 * Run standalone:  pnpm pg6:seed
 * Or import `generateSearchCorpus` — which is what the integration suite does,
 * so the data the plan is asserted over is the data this script produces.
 */
import { prisma } from "../src/db/prisma.js";

// ── deterministic randomness ────────────────────────────────────────────────
/** mulberry32 — small, fast, and identical on every machine and Node version. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── the corpus. Every string is a literal here; nothing is fetched. ─────────
const GIVEN_NAMES = [
  "أحمد", "محمد", "علي", "حسين", "فاطمة", "زينب", "مصطفى", "إبراهيم", "يوسف", "عمر",
  "سعيد", "كريم", "نور", "هدى", "مريم", "زهراء", "رقية", "عباس", "جعفر", "حيدر",
  "سجاد", "منتظر", "أمير", "رسول", "كاظم", "صادق", "باقر", "آمنة", "سكينة", "بتول",
];

/** Family names carrying the definite article, as they are actually written on an invoice. */
const FAMILY_NAMES = [
  "الجبوري", "العبيدي", "التميمي", "الكاظمي", "البغدادي", "الموسوي", "الحسيني", "الربيعي",
  "الشمري", "الدليمي", "الزبيدي", "العزاوي", "الخفاجي", "السوداني", "المالكي", "الجنابي",
];

const PRODUCT_HEADS = [
  "قميص", "بنطال", "حذاء", "عباءة", "جاكيت", "فستان", "حقيبة", "ساعة", "نظارة", "عطر",
  "زيت زيتون", "تمر", "عسل", "شاي", "قهوة", "سكر", "طحين", "رز عنبر", "معجون أسنان", "شامبو",
  "مصباح", "مروحة", "سخان", "خلاط", "مكواة", "بطانية", "وسادة", "سجادة", "مرآة", "كرسي",
];

const PRODUCT_QUALIFIERS = [
  "قطني", "صيفي", "شتوي", "فاخر", "منزلي", "عراقي", "مستورد", "أصلي", "خفيف", "كبير",
  "صغير", "مزدوج", "ذهبي", "فضي", "أزرق", "أحمر", "أخضر", "أسود", "أبيض", "بنفسجي",
];

const GOVERNORATES = ["Baghdad", "Basra", "Erbil", "Najaf", "Karbala", "Mosul", "Kirkuk", "Diyala"];

const ORDER_STATUSES = ["new", "processing", "preparation", "out_for_delivery", "completed", "cancelled"];

const TATWEEL = String.fromCodePoint(0x0640);
const ZWNJ = String.fromCodePoint(0x200c);
const FATHA = String.fromCodePoint(0x064e);
const DAMMA = String.fromCodePoint(0x064f);
const SHADDA = String.fromCodePoint(0x0651);
const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";

/**
 * Rewrites a clean Arabic string the way a real keyboard, a real paste and a
 * real hurry do. This is the part that makes the corpus worth generating: a
 * normalizer that returns its input unchanged still finds every row of a corpus
 * written in one canonical spelling.
 */
function roughen(value: string, random: () => number): string {
  const roll = random();
  if (roll < 0.30) {
    // The other keyboard form of the same name.
    return value
      .replace(/[أإآ]/g, "ا")
      .replace(/ة/g, "ه")
      .replace(/ى/g, "ي")
      .replace(/ك/g, String.fromCodePoint(0x06a9));
  }
  if (roll < 0.40) {
    // A tatweel run, as typed to stretch a name across a form field.
    const cut = 1 + Math.floor(random() * Math.max(1, value.length - 1));
    return `${value.slice(0, cut)}${TATWEEL.repeat(2 + Math.floor(random() * 3))}${value.slice(cut)}`;
  }
  if (roll < 0.47) {
    // Harakat, as they arrive from a copied document.
    return value.replace(/([ب-ي])/, (letter) => `${letter}${[FATHA, DAMMA, SHADDA][Math.floor(random() * 3)]}`);
  }
  if (roll < 0.52) {
    // The invisible that arrives from a WhatsApp paste and breaks matching
    // with no visible cause.
    const cut = 1 + Math.floor(random() * Math.max(1, value.length - 1));
    return `${value.slice(0, cut)}${ZWNJ}${value.slice(cut)}`;
  }
  return value;
}

function arabicIndicDigits(value: number, width: number): string {
  return String(value).padStart(width, "0").replace(/[0-9]/g, (digit) => ARABIC_INDIC[Number(digit)]!);
}

const pick = <T,>(list: readonly T[], random: () => number): T => list[Math.floor(random() * list.length)]!;

export interface CorpusVolume {
  products: number;
  customers: number;
  orders: number;
}

export interface CorpusOptions {
  storeId: string;
  /** A distinct prefix per store keeps SKUs and order numbers unique across the whole fixture. */
  prefix: string;
  seed: number;
  volume: CorpusVolume;
  /** Rows per INSERT. Four statements for twenty thousand rows, not twenty thousand round trips. */
  batchSize?: number;
}

/** `passwordHash` is NOT NULL on `customers`; a fixed bcrypt-shaped literal keeps the generator offline and instant. */
const FIXTURE_PASSWORD_HASH = "$2a$10$pg6fixturepg6fixturepg6fixturepg6fixturepg6fixtureuO";

export async function generateSearchCorpus(options: CorpusOptions): Promise<{ products: number; customers: number; orders: number }> {
  const batchSize = options.batchSize ?? 2_000;
  const random = seededRandom(options.seed);
  const { storeId, prefix } = options;

  // ── products ─────────────────────────────────────────────────────────────
  let productRows: Array<Record<string, unknown>> = [];
  for (let index = 0; index < options.volume.products; index += 1) {
    const head = pick(PRODUCT_HEADS, random);
    const qualifier = pick(PRODUCT_QUALIFIERS, random);
    const name = roughen(`${head} ${qualifier}`, random);
    // Every twelfth SKU carries Arabic-Indic digits — the shape a merchant
    // types on an Arabic keyboard, and the one that used to be unfindable.
    const serial = index % 12 === 0 ? arabicIndicDigits(index, 5) : String(index).padStart(5, "0");
    productRows.push({
      storeId,
      sku: `${prefix}-${serial}`,
      name,
      description: `${name} — ${roughen(pick(PRODUCT_QUALIFIERS, random), random)} ${pick(PRODUCT_HEADS, random)}`,
      priceIqd: 1_000 + Math.floor(random() * 250) * 250,
      stockQuantity: Math.floor(random() * 40),
      lowStockThreshold: 3,
      isActive: random() > 0.08,
    });
    if (productRows.length >= batchSize) { await prisma.product.createMany({ data: productRows as never }); productRows = []; }
  }
  if (productRows.length) await prisma.product.createMany({ data: productRows as never });

  // ── customers ────────────────────────────────────────────────────────────
  let customerRows: Array<Record<string, unknown>> = [];
  for (let index = 0; index < options.volume.customers; index += 1) {
    const fullName = `${roughen(pick(GIVEN_NAMES, random), random)} ${roughen(pick(FAMILY_NAMES, random), random)}`;
    // A deterministic, non-colliding Iraqi mobile number per row.
    const phone = `+9647${String(700_000_000 + index).slice(0, 9)}`;
    customerRows.push({
      storeId,
      fullName,
      email: index % 3 === 0 ? `${prefix.toLowerCase()}.${index}@codiq.test` : null,
      phone,
      phoneNormalized: phone,
      passwordHash: FIXTURE_PASSWORD_HASH,
      isActive: true,
    });
    if (customerRows.length >= batchSize) { await prisma.customer.createMany({ data: customerRows as never }); customerRows = []; }
  }
  if (customerRows.length) await prisma.customer.createMany({ data: customerRows as never });

  // ── orders ───────────────────────────────────────────────────────────────
  // Deliberately NOT linked to the customer rows: `customer_id` carries a
  // composite FK and a per-row lookup would turn four statements into twenty
  // thousand. `customer_name` and `recipient_phone` are what search reads, and
  // both are written here exactly as checkout writes them.
  let orderRows: Array<Record<string, unknown>> = [];
  const now = Date.now();
  for (let index = 0; index < options.volume.orders; index += 1) {
    const customerName = `${roughen(pick(GIVEN_NAMES, random), random)} ${roughen(pick(FAMILY_NAMES, random), random)}`;
    const total = 5_000 + Math.floor(random() * 400) * 250;
    orderRows.push({
      storeId,
      orderNumber: `${prefix}-ORD-${String(index).padStart(6, "0")}`,
      status: pick(ORDER_STATUSES, random),
      customerName,
      recipientPhone: `+9647${String(710_000_000 + index).slice(0, 9)}`,
      shippingGovernorate: pick(GOVERNORATES, random),
      shippingAddressLine1: `شارع ${pick(PRODUCT_QUALIFIERS, random)} ${index % 400}`,
      subtotalIqd: total,
      deliveryFeeIqd: 0,
      discountIqd: 0,
      totalIqd: total,
      paymentMethodCode: "cod",
      source: "storefront",
      // Spread across a year so a date filter has something to do, and stable
      // because the offset is derived from the index, not from the clock.
      createdAt: new Date(now - index * 60_000),
    });
    if (orderRows.length >= batchSize) { await prisma.storeOrder.createMany({ data: orderRows as never }); orderRows = []; }
  }
  if (orderRows.length) await prisma.storeOrder.createMany({ data: orderRows as never });

  // GIN keeps new entries in a PENDING LIST, so a freshly bulk-loaded table
  // looks slow and can plan differently until VACUUM flushes it — stated
  // verbatim in the md1 migration header, and the reason a plan assertion run
  // straight after a seed fails for the wrong reason.
  await prisma.$executeRawUnsafe("VACUUM ANALYZE products");
  await prisma.$executeRawUnsafe("VACUUM ANALYZE customers");
  await prisma.$executeRawUnsafe("VACUUM ANALYZE store_orders");

  return { products: options.volume.products, customers: options.volume.customers, orders: options.volume.orders };
}

/**
 * Standalone entry. Seeds the LARGEST store the platform holds, so `pnpm
 * pg6:seed` on a development database is a one-liner that makes the search
 * behave the way it will at scale.
 */
async function main() {
  const store = await prisma.store.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true, slug: true } });
  if (!store) throw new Error("pg6:seed — there is no store to seed. Run the demo seed first.");
  const started = Date.now();
  const counts = await generateSearchCorpus({
    storeId: store.id,
    prefix: "PG6",
    seed: 20260904,
    volume: { products: 20_000, customers: 20_000, orders: 20_000 },
  });
  console.log(JSON.stringify({ pg6Seed: { store: store.slug, ...counts, seconds: Math.round((Date.now() - started) / 1000) } }, null, 2));
}

// Only when run directly, never when the integration suite imports it.
if (process.argv[1] && process.argv[1].includes("generate-search-corpus")) {
  await main();
  await prisma.$disconnect();
}
