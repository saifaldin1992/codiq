/**
 * codiq PG-6 (ق-74) «البحث العربي الذكي» — the acceptance proof.
 *
 * The gate the owner named by example: «احمد» must find «أحمد» and «فاطمه»
 * must find «فاطمة». Everything else here exists because a search that answers
 * those two and nothing else would still be broken in production.
 *
 *  1. THE FOLD, on every surface — palette, merchant catalog, order list,
 *     customer directory, storefront and till. Both keyboard forms of the hamza
 *     letters, tatweel, harakat, alef maksura, teh marbuta, Arabic-Indic digits
 *     and a pasted ZWNJ.
 *  2. THE THRESHOLD, IN BOTH DIRECTIONS — «احمر» finds «احمد» (one wrong
 *     letter) and «سعيد» does not. Failing the SECOND assertion is how a
 *     badly-tuned threshold announces itself; a test that only checks tolerance
 *     passes happily with the threshold set to zero.
 *  3. TENANCY — store B holds the same name, and store A's actor gets zero rows
 *     for it on all three targets; a cross-store token gets 403.
 *  4. PG-2 — a soft-deleted product is invisible on every search surface while
 *     its row is still in the bin, and comes back on restore. Asserted against
 *     `deleted_at` in the database at each step, not against the HTTP shape.
 *  5. THE PHONE GATE (owner decision 2) — `phone_normalized` only, four digits
 *     minimum, on EVERY surface, and masked to the last four in the palette.
 *  6. THE FLOOR (owner decision 6) — two characters on the public storefront,
 *     with the same Arabic sentence the palette uses.
 *  7. THE PLAN (owner decision 9, the HARD gate) — over the generated 20k-row
 *     corpus, `EXPLAIN (FORMAT JSON)` on the query the engine ACTUALLY runs
 *     contains a Bitmap Index Scan on the expected `*_trgm_idx` and NO Seq Scan
 *     on that table, for each of the nine indexed columns. The milliseconds are
 *     REPORTED, never failed on: a wall-clock gate on a shared GitHub runner
 *     becomes a flake people learn to re-run.
 *
 * Harness conventions carried over from md1: the real HTTP app over a real
 * PostgreSQL, a separate test database asserted safe, `storefront_rate_limits`
 * cleared before every non-GET, and every scenario asserting DB state rather
 * than only the response shape.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { Client } from "pg";

const testId = `pg6-${Date.now()}`;
process.env.SESSION_JWT_SECRET = process.env.SESSION_JWT_SECRET ?? "pg6-test-secret-only-not-for-production";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { explainSearch, EXPECTED_INDEX, TABLE_OF } = await import("../src/services/search/postgres-trigram.engine.ts");
const { generateSearchCorpus } = await import("../scripts/generate-search-corpus.ts");

/** Codepoints, never pasted glyphs — an invisible in a fixture is unreviewable. */
const at = (code) => String.fromCodePoint(code);
const TATWEEL = at(0x0640);
const ZWNJ = at(0x200c);
const FATHA = at(0x064e);
const DAMMA = at(0x064f);
const SHADDA = at(0x0651);

/**
 * How big the perf corpus is. 20k is the number the acceptance gate names, and
 * it is also the number that makes the plan assertion MEAN something — on a
 * forty-row table PostgreSQL is right to prefer a sequential scan, so a plan
 * gate over a toy fixture asserts nothing at all.
 */
const CORPUS_ROWS = Number(process.env.PG6_CORPUS_ROWS ?? 20_000);

const sql = new Client({ connectionString: process.env.DATABASE_URL });
await sql.connect();
const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, { method = "GET", body, token, headers = {} } = {}) {
  if (method !== "GET") await sql.query("DELETE FROM storefront_rate_limits");
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, payload };
}

const summary = {};

try {
  await prisma.$executeRawUnsafe("TRUNCATE TABLE order_notes, order_tags, storefront_rate_limits, store_marketing_settings, order_prescriptions, coupon_redemptions, coupons, settlements, ledger_entries, notification_outbox, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, product_variants, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, platform_owner_sessions, platform_owners CASCADE");

  // ── fixtures ──────────────────────────────────────────────────────────────
  const password = "Pg6MerchantPass!2026";
  const merchantA = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100319201", email: `${testId}.a@codiq.test`, password, businessName: "متجر PG6 ألف" });
  const merchantB = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100319202", email: `${testId}.b@codiq.test`, password, businessName: "متجر PG6 باء" });
  assert.equal(merchantA.status, 201, JSON.stringify(merchantA.payload));
  assert.equal(merchantB.status, 201, JSON.stringify(merchantB.payload));

  const storeA = await prisma.store.create({ data: { merchantId: merchantA.payload.account.id, name: "متجر PG6 ألف", slug: `${testId}-a`, defaultSubdomain: `${testId}-a` } });
  const storeB = await prisma.store.create({ data: { merchantId: merchantB.payload.account.id, name: "متجر PG6 باء", slug: `${testId}-b`, defaultSubdomain: `${testId}-b` } });

  const loginA = await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.a@codiq.test`, password } });
  const loginB = await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.b@codiq.test`, password } });
  assert.equal(loginA.status, 200, JSON.stringify(loginA.payload));
  assert.equal(loginB.status, 200, JSON.stringify(loginB.payload));
  const tokenA = loginA.payload.accessToken;
  const tokenB = loginB.payload.accessToken;

  const dashboardA = `/merchant/stores/${storeA.slug}`;
  const searchA = (q, token = tokenA, slug = storeA.slug) => request(`/merchant/stores/${slug}/search?q=${encodeURIComponent(q)}`, { token });
  const catalogSearch = (q, token = tokenA) => request(`${dashboardA}/catalog/products?q=${encodeURIComponent(q)}`, { token });
  const orderSearch = (q, token = tokenA) => request(`${dashboardA}/orders?q=${encodeURIComponent(q)}`, { token });
  const customerSearch = (q, token = tokenA) => request(`${dashboardA}/customers?q=${encodeURIComponent(q)}`, { token });
  const tillSearch = (q, token = tokenA) => request(`${dashboardA}/pos/products?q=${encodeURIComponent(q)}`, { token });
  const storefrontSearch = (q, slug = storeA.slug) => request(`/store/${slug}/products?q=${encodeURIComponent(q)}`);

  const passwordHash = "$2a$10$pg6fixturepg6fixturepg6fixturepg6fixturepg6fixtureuO";
  const customer = async (storeId, fullName, phone) =>
    prisma.customer.create({ data: { storeId, fullName, passwordHash, phone, phoneNormalized: phone, email: null }, select: { id: true, fullName: true } });

  // Every name below is a DIFFERENT spelling from the needle that must find it.
  const ahmad = await customer(storeA.id, "أحمد الجبوري", "+9647701110001");
  const fatima = await customer(storeA.id, "فاطمة الزهراء", "+9647701110002");
  const mustafa = await customer(storeA.id, "مصطفى الكاظمي", "+9647701110003");
  const muhammad = await customer(storeA.id, `م${DAMMA}ح${FATHA}م${SHADDA}${FATHA}د الساعدي`, "+9647701110004");
  const ibrahim = await customer(storeA.id, "إبراهيم النجار", "+9647701110005");
  const pasted = await customer(storeA.id, `سج${ZWNJ}اد التميمي`, "+9647701110006");
  // Store B holds the SAME name — the tenancy proof needs a row that would
  // match if the store predicate were ever dropped.
  const ahmadB = await customer(storeB.id, "أحمد الجبوري", "+9647709990001");

  const product = async (storeId, sku, name, description = null, isActive = true) =>
    prisma.product.create({ data: { storeId, sku, name, description, priceIqd: 12_000, stockQuantity: 7, lowStockThreshold: 2, isActive }, select: { id: true, sku: true, name: true } });

  const shirt = await product(storeA.id, "PG6-SHIRT", `قميص أح${TATWEEL}${TATWEEL}${TATWEEL}مد الصيفي`, "قميص قطني بأكمام قصيرة");
  const perfume = await product(storeA.id, "PG6-٠٠٧", "عطر الياسمين", "عطر شرقي فاخر للمناسبات");
  const abaya = await product(storeA.id, "PG6-ABAYA", "عباءة فاطمة الأنيقة", "عباءة سوداء بتطريز يدوي");
  const inactive = await product(storeA.id, "PG6-HIDDEN", "منتج غير معروض", "لا يظهر في الواجهة", false);
  const wildcard = await product(storeA.id, "PG6-DISCOUNT", "خصم 50% على العطور", "عرض محدود");
  const secretB = await product(storeB.id, "PG6-B-SECRET", "عطر الياسمين", "عطر متجر باء");

  const order = async (storeId, orderNumber, customerName, recipientPhone) =>
    prisma.storeOrder.create({ data: { storeId, orderNumber, status: "new", customerName, recipientPhone, subtotalIqd: 10_000, totalIqd: 10_000, paymentMethodCode: "cod", source: "storefront" }, select: { id: true, orderNumber: true } });

  const orderAhmad = await order(storeA.id, "PG6-ORD-001", "أحمد الجبوري", "+9647701110001");
  const orderFatima = await order(storeA.id, "PG6-ORD-002", "فاطمة الزهراء", "+9647701110002");
  const orderB = await order(storeB.id, "PG6-B-ORD-001", "أحمد الجبوري", "+9647709990001");

  // ══════════════════════════════════════════════════════════════════════════
  // 1. THE GATE — «احمد» finds «أحمد», «فاطمه» finds «فاطمة».
  // ══════════════════════════════════════════════════════════════════════════
  const gateAhmad = await searchA("احمد");
  assert.equal(gateAhmad.status, 200, JSON.stringify(gateAhmad.payload));
  assert.ok(gateAhmad.payload.customers.some((row) => row.id === ahmad.id), "GATE: «احمد» must find «أحمد» in the palette");
  assert.ok(gateAhmad.payload.orders.some((row) => row.id === orderAhmad.id), "GATE: «احمد» must find his order through the NEW search_customer_name column");
  assert.ok(gateAhmad.payload.products.some((row) => row.id === shirt.id), "GATE: «احمد» must find the product whose name carries a tatweel run");

  const gateAhmadDirectory = await customerSearch("احمد");
  assert.equal(gateAhmadDirectory.status, 200, JSON.stringify(gateAhmadDirectory.payload));
  assert.ok(gateAhmadDirectory.payload.customers.some((row) => row.id === ahmad.id), "GATE: the customer directory folds the alef too");

  const gateAhmadOrders = await orderSearch("احمد");
  assert.ok(gateAhmadOrders.payload.orders.some((row) => row.id === orderAhmad.id), "GATE: the order list finds an order by the CUSTOMER's name — a capability that did not exist before PG-6");

  const gateFatima = await searchA("فاطمه");
  assert.ok(gateFatima.payload.customers.some((row) => row.id === fatima.id), "GATE: «فاطمه» must find «فاطمة»");
  assert.ok(gateFatima.payload.products.some((row) => row.id === abaya.id), "GATE: the teh-marbuta fold reaches product names too");
  assert.ok((await customerSearch("فاطمه")).payload.customers.some((row) => row.id === fatima.id), "GATE: and the directory agrees");
  assert.ok((await orderSearch("فاطمه")).payload.orders.some((row) => row.id === orderFatima.id), "GATE: and the order list agrees");

  // ══════════════════════════════════════════════════════════════════════════
  // 2. THE THRESHOLD, IN BOTH DIRECTIONS.
  // ══════════════════════════════════════════════════════════════════════════
  const wrongLetter = await searchA("احمر");
  assert.ok(wrongLetter.payload.customers.some((row) => row.id === ahmad.id), "one wrong letter still finds «أحمد» — this is the typo tolerance the threshold buys");
  const unrelated = await searchA("سعيد");
  assert.ok(!unrelated.payload.customers.some((row) => row.id === ahmad.id), "«سعيد» must NOT find «أحمد» — the threshold is tolerance, not a wildcard, and a test that only checks the first direction passes with the threshold at zero");

  const threshold = (await sql.query("SHOW pg_trgm.word_similarity_threshold")).rows[0]["pg_trgm.word_similarity_threshold"];
  assert.equal(threshold, "0.4", "the migration's ALTER DATABASE must have reached this session — at the 0.6 default the fold is silently narrower");

  // ══════════════════════════════════════════════════════════════════════════
  // 3. THE REST OF THE FOLD TABLE.
  // ══════════════════════════════════════════════════════════════════════════
  const folds = [
    ["مصطفي", mustafa.id, "alef maksura ى folds to ي"],
    ["محمد", muhammad.id, "the harakat are deleted, so «محمد» finds «مُحَمَّد»"],
    ["ابراهيم", ibrahim.id, "«ابراهيم» finds «إبراهيم»"],
    ["سجاد", pasted.id, "a name pasted with an embedded ZWNJ is still findable"],
  ];
  for (const [needle, expectedId, why] of folds) {
    const found = await searchA(needle);
    assert.ok(found.payload.customers.some((row) => row.id === expectedId), `FOLD: ${why}`);
  }
  // Arabic-Indic digits: the SKU is typed on an Arabic keyboard, the needle in
  // ASCII — and the other way round.
  assert.ok((await catalogSearch("007")).payload.products.some((row) => row.id === perfume.id), "FOLD: an ASCII needle finds a SKU typed in Arabic-Indic digits");
  assert.ok((await catalogSearch("٠٠٧")).payload.products.some((row) => row.id === perfume.id), "FOLD: and an Arabic-Indic needle finds it too");
  assert.ok((await searchA("٠٠١")).payload.orders.some((row) => row.id === orderAhmad.id), "FOLD: «٠٠١» finds order PG6-ORD-001");
  // The tatweel run is inside the STORED value, not the needle.
  assert.ok((await catalogSearch("قميص احمد")).payload.products.some((row) => row.id === shirt.id), "FOLD: tatweel inside the stored name does not hide it");

  // LIKE metacharacters stay literal — `codiq_like_escape` runs inside the
  // database, after normalization, where it cannot be forgotten.
  assert.deepEqual((await searchA("%%")).payload.products, [], "«%%» is a literal, not a wildcard that matches the whole store");
  assert.ok((await searchA("50%")).payload.products.some((row) => row.id === wildcard.id), "a real «%» in the merchant's own text still finds its product");

  // ══════════════════════════════════════════════════════════════════════════
  // 4. TENANCY — zero rows across the wall, and 403 at it.
  // ══════════════════════════════════════════════════════════════════════════
  const crossStore = await searchA("احمد");
  assert.ok(!crossStore.payload.customers.some((row) => row.id === ahmadB.id), "store B's customer of the SAME name is invisible from store A");
  assert.ok(!crossStore.payload.orders.some((row) => row.id === orderB.id), "…and so is his order");
  assert.ok(!(await catalogSearch("عطر")).payload.products.some((row) => row.id === secretB.id), "store B's product of the same name is invisible in store A's catalog");
  assert.ok(!(await tillSearch("عطر")).payload.products.some((row) => row.id === secretB.id), "…and at store A's till");
  assert.ok(!(await storefrontSearch("عطر")).payload.products.some((row) => row.id === secretB.id), "…and on store A's storefront");
  assert.equal((await searchA("احمد", tokenB)).status, 403, "a merchant token from another store is refused at the boundary, not answered with an empty list");
  assert.equal((await catalogSearch("عطر", tokenB)).status, 403, "the catalog search enforces the same boundary");
  assert.equal((await tillSearch("عطر", tokenB)).status, 403, "and so does the till search");

  // ══════════════════════════════════════════════════════════════════════════
  // 5. PG-2 — LIVE only, everywhere, and back after restore (owner decision 3).
  // ══════════════════════════════════════════════════════════════════════════
  const visibleBefore = {
    palette: (await searchA("ياسمين")).payload.products.some((row) => row.id === perfume.id),
    catalog: (await catalogSearch("ياسمين")).payload.products.some((row) => row.id === perfume.id),
    till: (await tillSearch("ياسمين")).payload.products.some((row) => row.id === perfume.id),
    storefront: (await storefrontSearch("ياسمين")).payload.products.some((row) => row.id === perfume.id),
  };
  assert.deepEqual(visibleBefore, { palette: true, catalog: true, till: true, storefront: true }, "the product is findable on all four surfaces before it is deleted");

  const deleted = await request(`${dashboardA}/catalog/products/${perfume.id}`, { method: "DELETE", token: tokenA });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.payload));
  const deletedRow = await prisma.product.findUniqueOrThrow({ where: { id: perfume.id }, select: { deletedAt: true, isActive: true } });
  assert.notEqual(deletedRow.deletedAt, null, "the row carries deleted_at in the DATABASE — the assertion is on state, not on the response");
  assert.equal(deletedRow.isActive, false, "and the deleted ⇒ inactive CHECK holds");

  const visibleAfter = {
    palette: (await searchA("ياسمين")).payload.products.some((row) => row.id === perfume.id),
    catalog: (await catalogSearch("ياسمين")).payload.products.some((row) => row.id === perfume.id),
    till: (await tillSearch("ياسمين")).payload.products.some((row) => row.id === perfume.id),
    storefront: (await storefrontSearch("ياسمين")).payload.products.some((row) => row.id === perfume.id),
  };
  assert.deepEqual(visibleAfter, { palette: false, catalog: false, till: false, storefront: false }, "a trashed product is invisible to EVERY search surface — the trash bin is not searchable (owner decision 3)");
  const trash = await request(`${dashboardA}/trash?entityType=product`, { token: tokenA });
  assert.equal(trash.status, 200, JSON.stringify(trash.payload));
  assert.ok(trash.payload.items.some((item) => item.id === perfume.id), "…while the row is still in the bin and still restorable");

  const restored = await request(`${dashboardA}/trash/product/${perfume.id}/restore`, { method: "POST", token: tokenA });
  assert.equal(restored.status, 200, JSON.stringify(restored.payload));
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: perfume.id }, select: { deletedAt: true } })).deletedAt, null, "restore clears deleted_at");
  assert.ok((await catalogSearch("ياسمين")).payload.products.some((row) => row.id === perfume.id), "and the product is findable again");

  // The storefront's own invariant: an inactive product never surfaces publicly.
  assert.ok(!(await storefrontSearch("منتج غير معروض")).payload.products.some((row) => row.id === inactive.id), "an isActive:false product never appears in the public search");

  // ══════════════════════════════════════════════════════════════════════════
  // 6. THE PHONE GATE (owner decision 2) — on EVERY surface.
  // ══════════════════════════════════════════════════════════════════════════
  const byPhone = await searchA("1110001");
  assert.ok(byPhone.payload.customers.some((row) => row.id === ahmad.id), "a phone-shaped needle finds the customer through phone_normalized");
  const maskedRow = byPhone.payload.customers.find((row) => row.id === ahmad.id);
  assert.equal(maskedRow.phone, "••••0001", "the palette masks the number to its last four digits");
  assert.ok(!JSON.stringify(byPhone.payload).includes("9647701110001"), "the full number appears nowhere in the palette payload — not in a field, not in an href");
  assert.ok(maskedRow.href.includes("q=0001"), "the deep link carries the same four digits, which the directory's 4-digit probe accepts");
  assert.ok((await customerSearch("0001")).payload.customers.some((row) => row.id === ahmad.id), "…and following it lands on the match");

  // ق-213 — THE FULL NUMBER, IN THE SHAPE AN IRAQI ACTUALLY WRITES IT.
  //
  // Every column the needle is compared against holds E.164 (`+9647701110001`),
  // and the needle was the raw digits of what the merchant typed. So the most
  // natural query of all — the whole number off the courier sheet, `07701110001`
  // — was compared against `9647701110001` and matched NOTHING: the leading zero
  // is not in the stored string. Partial needles worked, which is exactly why it
  // survived; and a silent miss is indistinguishable from «this customer is not
  // in our system», which is how the duplicate rows get made.
  const localForm = "07701110001";
  assert.ok((await searchA(localForm)).payload.customers.some((row) => row.id === ahmad.id), "ق-213: the palette finds him by the full 07… number");
  assert.ok((await customerSearch(localForm)).payload.customers.some((row) => row.id === ahmad.id), "ق-213: …and so does the customer directory");
  assert.ok((await orderSearch(localForm)).payload.orders.some((row) => row.id === orderAhmad.id), "ق-213: …and the order list, whose recipient_phone is E.164 too");
  assert.ok((await searchA("+9647701110001")).payload.customers.some((row) => row.id === ahmad.id), "the international form keeps working");
  assert.ok((await searchA("0770 111 0001")).payload.customers.some((row) => row.id === ahmad.id), "…and so does the spaced form a person pastes from his contacts");

  // The gate itself: a query carrying LETTERS is not a phone probe, whatever
  // digits it contains. `AB-0001` once surfaced the customer whose phone merely
  // contains `0001`, and the customer directory never had the gate at all.
  assert.ok(!(await searchA("AB-0001")).payload.customers.some((row) => row.id === ahmad.id), "an alphanumeric needle is not a phone probe in the palette");
  assert.ok(!(await customerSearch("AB-0001")).payload.customers.some((row) => row.id === ahmad.id), "…nor in the customer directory, which had no gate before PG-6");
  assert.ok(!(await orderSearch("AB-0001")).payload.orders.some((row) => row.id === orderAhmad.id), "…nor in the order list");
  // Fewer than four digits is not a probe either.
  assert.ok(!(await customerSearch("001")).payload.customers.some((row) => row.id === ahmad.id), "three digits are below PHONE_MIN_DIGITS and sweep nothing");

  // ══════════════════════════════════════════════════════════════════════════
  // 7. THE FLOOR (owner decision 6) — two characters on the public storefront.
  // ══════════════════════════════════════════════════════════════════════════
  const tooShortPublic = await storefrontSearch("ع");
  assert.equal(tooShortPublic.status, 422, JSON.stringify(tooShortPublic.payload));
  assert.equal(tooShortPublic.payload.error.message, "أدخل حرفين على الأقل للبحث.", "the shopper sees the SAME sentence the merchant sees in the palette");
  assert.equal((await searchA("ع")).status, 422, "the palette's own floor is unchanged");
  assert.equal((await customerSearch("ع")).status, 422, "the customer directory gained the floor it never had");
  assert.equal((await orderSearch("ع")).status, 422, "and so did the order list");
  assert.equal((await catalogSearch("ع")).status, 422, "and the catalog's new q");
  assert.equal((await tillSearch("ع")).status, 422, "and the till's new route");
  // An ABSENT or empty `q` still means «no search», not «a bad search».
  assert.equal((await request(`${dashboardA}/catalog/products`, { token: tokenA })).status, 200, "an absent q is the unfiltered list, not a validation failure");
  assert.equal((await request(`${dashboardA}/catalog/products?q=`, { token: tokenA })).status, 200, "and so is an empty one");

  // ══════════════════════════════════════════════════════════════════════════
  // 8. STABLE ORDER — the property 20-2's keyset will depend on.
  // ══════════════════════════════════════════════════════════════════════════
  const firstPass = (await catalogSearch("عطر")).payload.products.map((row) => row.id);
  const secondPass = (await catalogSearch("عطر")).payload.products.map((row) => row.id);
  assert.deepEqual(secondPass, firstPass, "two identical requests return the identical order — `exact DESC, rank DESC, id DESC` is a TOTAL order");

  // ══════════════════════════════════════════════════════════════════════════
  // 9. THE CORPUS, AND THE PLAN GATE.
  // ══════════════════════════════════════════════════════════════════════════
  const perfStore = await prisma.store.create({ data: { merchantId: merchantA.payload.account.id, name: "متجر PG6 القياس", slug: `${testId}-perf`, defaultSubdomain: `${testId}-perf` } });
  const smallStore = await prisma.store.create({ data: { merchantId: merchantB.payload.account.id, name: "متجر PG6 الصغير", slug: `${testId}-small`, defaultSubdomain: `${testId}-small` } });

  // A merchant session is bound to ONE store, so the perf store needs its own
  // token — the same switch a merchant with two stores makes in the UI.
  const switched = await request("/merchant/stores/switch", { method: "POST", token: tokenA, body: { storeSlug: perfStore.slug } });
  assert.equal(switched.status, 200, JSON.stringify(switched.payload));
  const tokenPerf = switched.payload.accessToken;

  const seedStarted = Date.now();
  await generateSearchCorpus({ storeId: perfStore.id, prefix: "PG6", seed: 20260904, volume: { products: CORPUS_ROWS, customers: CORPUS_ROWS, orders: CORPUS_ROWS } });
  // A second store with a quarter of the rows, so the tenant filter has
  // something real to exclude rather than being the only store in the table.
  await generateSearchCorpus({ storeId: smallStore.id, prefix: "SML", seed: 777, volume: { products: Math.round(CORPUS_ROWS / 4), customers: Math.round(CORPUS_ROWS / 4), orders: Math.round(CORPUS_ROWS / 4) } });
  const seedSeconds = Math.round((Date.now() - seedStarted) / 1000);

  const counts = {
    products: await prisma.product.count({ where: { storeId: perfStore.id } }),
    customers: await prisma.customer.count({ where: { storeId: perfStore.id } }),
    orders: await prisma.storeOrder.count({ where: { storeId: perfStore.id } }),
  };
  assert.equal(counts.products, CORPUS_ROWS, "the corpus actually landed");
  assert.equal(counts.customers, CORPUS_ROWS);
  assert.equal(counts.orders, CORPUS_ROWS);

  // The fold still holds at scale, not only on a five-row fixture.
  const atScale = await request(`/merchant/stores/${perfStore.slug}/customers?q=${encodeURIComponent("الجبوري")}`, { token: tokenPerf });
  assert.equal(atScale.status, 200, JSON.stringify(atScale.payload));
  assert.ok(atScale.payload.customers.length > 0, "the directory still answers over twenty thousand rows");

  /**
   * Needles chosen to be SELECTIVE. A needle matching a third of the table is
   * one the planner is right to answer with a sequential scan, and asserting
   * against that would be asserting that PostgreSQL is wrong.
   */
  const planCases = [
    ["products.name", "قميص قطني"],
    ["products.sku", "pg6-10002"],
    ["products.description", "زيت زيتون"],
    ["customers.fullName", "الجبوري"],
    ["customers.email", "pg6.10002"],
    ["customers.phone", "700010002"],
    ["orders.orderNumber", "ord-010002"],
    ["orders.customerName", "الكاظمي"],
    ["orders.recipientPhone", "710010002"],
  ];

  const planVerdicts = {};
  for (const [target, needle] of planCases) {
    const plan = await explainSearch(target, { storeId: perfStore.id, needle, limit: 25 });
    const text = JSON.stringify(plan);
    const table = TABLE_OF[target];
    const index = EXPECTED_INDEX[target];
    const usesIndex = text.includes('"Node Type":"Bitmap Index Scan"') && text.includes(`"Index Name":"${index}"`);
    const seqScans = text.includes(`"Node Type":"Seq Scan","Parallel Aware":false,"Async Capable":false,"Relation Name":"${table}"`) || new RegExp(`"Node Type":"Seq Scan"[^}]*"Relation Name":"${table}"`).test(text);
    planVerdicts[target] = { index, bitmapIndexScan: usesIndex, seqScanOnTable: seqScans };
    // HARD gate, owner decision 9: a Seq Scan on a searched table is a bug on
    // any machine, so this fails the build — unlike the milliseconds below.
    assert.ok(usesIndex, `PLAN: ${target} must ride a Bitmap Index Scan on ${index}. Got:\n${text}`);
    assert.ok(!seqScans, `PLAN: ${target} must not sequentially scan ${table}. Got:\n${text}`);
  }

  // ── the milliseconds: REPORTED, never failed on (owner decision 9) ────────
  const timed = [
    ["merchant palette", () => request(`/merchant/stores/${perfStore.slug}/search?q=${encodeURIComponent("الجبوري")}`, { token: tokenPerf })],
    ["merchant catalog", () => request(`/merchant/stores/${perfStore.slug}/catalog/products?q=${encodeURIComponent("قميص قطني")}`, { token: tokenPerf })],
    ["merchant orders", () => request(`/merchant/stores/${perfStore.slug}/orders?q=${encodeURIComponent("الكاظمي")}`, { token: tokenPerf })],
    ["customer directory", () => request(`/merchant/stores/${perfStore.slug}/customers?q=${encodeURIComponent("الجبوري")}`, { token: tokenPerf })],
    ["till search", () => request(`/merchant/stores/${perfStore.slug}/pos/products?q=${encodeURIComponent("عطر")}`, { token: tokenPerf })],
  ];
  const RUNS = Number(process.env.PG6_PERF_RUNS ?? 20);
  const millis = {};
  for (const [label, run] of timed) {
    const samples = [];
    for (let index = 0; index < RUNS; index += 1) {
      const started = process.hrtime.bigint();
      const response = await run();
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
      assert.equal(response.status, 200, `${label} answered ${response.status}: ${JSON.stringify(response.payload)}`);
    }
    samples.sort((left, right) => left - right);
    millis[label] = { p50: Math.round(samples[Math.floor(samples.length * 0.5)]), p95: Math.round(samples[Math.floor(samples.length * 0.95)] ?? samples.at(-1)), budgetMs: 300, gate: "reported-only" };
  }

  summary.pg6 = {
    threshold,
    corpusRows: CORPUS_ROWS,
    seedSeconds,
    perfStoreCounts: counts,
    plan: planVerdicts,
    milliseconds: millis,
  };

  console.log(JSON.stringify({ suite: "pg6.arabic-search", status: "passed", summary }, null, 2));
  console.log("pg6:test OK");
} finally {
  await sql.end();
  await prisma.$disconnect();
  server.close();
}
