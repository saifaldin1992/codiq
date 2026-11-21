/**
 * codiq MD-1 «راحة اليوم» — merchant delight batch proof.
 * Phase-20B3-style harness: the real HTTP app over a real PostgreSQL.
 *
 *  1. البحث الشامل الواحد — min length, store-scoped hits (product name/SKU,
 *     order number, customer name/phone), cross-store leakage attempt returns
 *     nothing, per-kind cap of 5 that SAYS it truncated, cross-store token 403,
 *     LIKE metacharacters escaped, and the phone needle gated on phone shape.
 *  1b. PER-DOMAIN AUTHORIZATION — the search spans orders, customers and
 *     products, so each section is gated on its OWN permission. Asserts what a
 *     staff member may SEE, not merely whether she may search: a default
 *     store_staff (no customers.view) gets no customer rows and no customer
 *     section at all, a products-denied staff gets no product rows, and an
 *     actor holding none of the three is refused outright.
 *  2. نسخ منتج بنقرة — all variants copied with unique -COPY / -COPY-2 SKUs,
 *     every stock zeroed, the copy lands as an UNPUBLISHED draft, category
 *     preserved, images NOT copied, plan limit enforced with zero partial
 *     writes (and the shared free plan restored in a finally), cross-store 404.
 *  3. ملاحظات ووسوم داخلية — create/list, 2000/8/24 caps, dedupe/normalize,
 *     author names resolved, IDOR cross-store 404, and the load-bearing
 *     INTERNAL-ONLY proof: neither notes nor tags appear in ANY
 *     storefront/customer payload.
 *  3b. CONCURRENCY — 20 rounds of two simultaneous tag replaces on one order:
 *     never a 500, never more than 8 stored tags, never a blended set, and a
 *     conflict that names itself instead of claiming a duplicate account.
 *  3c. The internal-tag filter runs on the SERVER across the whole store.
 *  4. إجراءات جماعية — mixed success/failure with the right per-order codes,
 *     the prescription-gated order refused, >50 rejected, a malformed shared
 *     note refused ONCE up-front, and the explicit no-bypass assertions
 *     (versions, statuses and status events of the failed orders are untouched;
 *     every success wrote exactly one status event).
 *  5. وضع الإجازة — checkout 422 STORE_ON_VACATION while browsing/cart stay
 *     open, no order and no checkout_request written, and OFF restores.
 *
 * Established lessons applied: storefront_rate_limits cleared before every
 * non-GET request; a separate test database; every scenario asserts DB state,
 * not just the HTTP shape.
 */
import assert from "node:assert/strict";
import { applyPlanTermsNow } from "./helpers/plan-terms.js";
import { ownStaffPassword } from "./helpers/own-staff-password.js";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const testId = `md1-${Date.now()}`;
process.env.SESSION_JWT_SECRET = process.env.SESSION_JWT_SECRET ?? "md1-test-secret-only-not-for-production";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");

/**
 * ق-128: put ONE merchant on «free», because this suite tests that plan's caps.
 *
 * Scoped to a merchant on purpose. A blanket updateMany lowers the cap for every
 * merchant in the suite mid-run, which retroactively puts ones that already used
 * a higher plan's allowance over their limit — and the next unrelated assertion
 * fails with a 403 that has nothing to do with what it was testing.
 */
async function pinToFreePlan(merchantId) {
  const free = await prisma.plan.findUniqueOrThrow({ where: { code: "free" }, select: { id: true } });
  await prisma.merchantSubscription.updateMany({ where: { merchantId, status: "active" }, data: { planId: free.id, endsAt: null } });
}

const { ORDER_STATUSES, TERMINAL_ORDER_STATUSES } = await import("../src/services/order-lifecycle.service.ts");
const { classifyError } = await import("../src/http/errors.ts");
const { Prisma: PrismaNamespace } = await import("@prisma/client");
// The bulk confirmation lives in the client, so its agreement with the server's
// state machine is asserted against the source itself rather than assumed.
const workspaceSource = readFileSync(fileURLToPath(new URL("../../client/src/components/OrderWorkspace.tsx", import.meta.url)), "utf8");
const printSource = readFileSync(fileURLToPath(new URL("../../client/src/components/OrderPrintSheet.tsx", import.meta.url)), "utf8");

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

let phoneSuffix = 0;
async function registerCustomer(slug, fullName) {
  phoneSuffix += 1;
  const phone = `+96477055${String(phoneSuffix).padStart(5, "0")}`;
  const registered = await request(`/store/${slug}/account/register`, { method: "POST", body: { phone, password: "Md1CustomerPass!2026", fullName } });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const address = await request(`/store/${slug}/account/addresses`, { method: "POST", token: registered.payload.accessToken, body: { recipientName: fullName, fullAddress: "شارع المدى 1", city: "Baghdad", governorate: "Baghdad", phoneContact: phone, isDefault: true } });
  assert.equal(address.status, 201, JSON.stringify(address.payload));
  return { token: registered.payload.accessToken, id: registered.payload.account.id, phone, addressId: address.payload.address.id, fullName };
}

let checkoutKeySuffix = 0;
async function placeOrder(slug, customer, variantId, quantity = 1) {
  const added = await request(`/store/${slug}/cart/items`, { method: "POST", token: customer.token, body: { variantId, quantity } });
  assert.equal(added.status, 200, JSON.stringify(added.payload));
  checkoutKeySuffix += 1;
  const checkedOut = await request(`/store/${slug}/checkout`, {
    method: "POST", token: customer.token,
    headers: { "idempotency-key": `md1-idempotency-key-${String(checkoutKeySuffix).padStart(4, "0")}` },
    body: { cartVersion: added.payload.cart.version, addressId: customer.addressId, paymentMethodCode: "cod" },
  });
  return checkedOut;
}

const summary = {};

try {
  await prisma.$executeRawUnsafe("TRUNCATE TABLE order_notes, order_tags, storefront_rate_limits, store_marketing_settings, order_prescriptions, coupon_redemptions, coupons, settlements, ledger_entries, notification_outbox, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, product_variants, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, platform_owner_sessions, platform_owners CASCADE");

  // ---------- fixtures ----------
  const merchantA = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100318201", email: `${testId}.a@codiq.test`, password: "Md1MerchantPass!2026", businessName: "متجر MD1 ألف" });
  const merchantB = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100318202", email: `${testId}.b@codiq.test`, password: "Md1MerchantPass!2026", businessName: "متجر MD1 باء" });
  // ق-128 gives every new merchant a free MONTH on «growth», whose caps are far
  // higher than «free»'s. This suite is about the CAPS, so it pins the plan
  // rather than inheriting whatever registration happens to grant — otherwise a
  // trial-plan change silently stops it testing anything.
  await pinToFreePlan(merchantA.payload.account.id);
  await pinToFreePlan(merchantB.payload.account.id);
  assert.equal(merchantA.status, 201); assert.equal(merchantB.status, 201);
  const storeA = await prisma.store.create({ data: { merchantId: merchantA.payload.account.id, name: "متجر MD1 ألف", slug: `${testId}-a`, defaultSubdomain: `${testId}-a` } });
  const storeB = await prisma.store.create({ data: { merchantId: merchantB.payload.account.id, name: "متجر MD1 باء", slug: `${testId}-b`, defaultSubdomain: `${testId}-b` } });
  await prisma.deliveryRate.create({ data: { storeId: storeA.id, governorate: "Baghdad", amountIqd: 2500, isEnabled: true } });
  await prisma.deliveryRate.create({ data: { storeId: storeB.id, governorate: "Baghdad", amountIqd: 2500, isEnabled: true } });
  const loginA = await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.a@codiq.test`, password: "Md1MerchantPass!2026" } });
  const loginB = await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.b@codiq.test`, password: "Md1MerchantPass!2026" } });
  assert.equal(loginA.status, 200); assert.equal(loginB.status, 200);
  const tokenA = loginA.payload.accessToken;
  const tokenB = loginB.payload.accessToken;
  const catalogA = `/merchant/stores/${storeA.slug}/catalog`;
  const catalogB = `/merchant/stores/${storeB.slug}/catalog`;
  const ordersA = `/merchant/stores/${storeA.slug}/orders`;

  // Staff member in store A whose orders.view is explicitly DENIED — the
  // permission-denial probe for the search endpoint.
  const staffCreated = await request(`/merchant/stores/${storeA.slug}/team`, { method: "POST", token: tokenA, body: { email: `${testId}.staff@codiq.test`, displayName: "موظفة MD1", temporaryPassword: "md1-staff-temp-password", roleCode: "store_staff" } });
  assert.equal(staffCreated.status, 201, JSON.stringify(staffCreated.payload));
  await ownStaffPassword(base, storeA.slug, `${testId}.staff@codiq.test`, "md1-staff-temp-password"); // audit 14-ب
  const staffMembershipId = staffCreated.payload.membership.id;
  const staffLogin = await request(`/auth/staff/stores/${storeA.slug}/login`, { method: "POST", body: { email: `${testId}.staff@codiq.test`, password: "md1-staff-temp-password" } });
  assert.equal(staffLogin.status, 200, JSON.stringify(staffLogin.payload));
  let tokenStaff = staffLogin.payload.accessToken;

  const category = await request(`${catalogA}/categories`, { method: "POST", token: tokenA, body: { name: "ملابس MD1" } });
  assert.equal(category.status, 201, JSON.stringify(category.payload));
  const shirtCreated = await request(`${catalogA}/products`, { method: "POST", token: tokenA, body: { sku: "MD1-SHIRT", name: "قميص المرح", priceIqd: 10000, stockQuantity: 8, lowStockThreshold: 1, categoryId: category.payload.category.id } });
  assert.equal(shirtCreated.status, 201, JSON.stringify(shirtCreated.payload));
  const shirtId = shirtCreated.payload.product.id;
  for (const variant of [{ sku: "MD1-SHIRT-M", name: "وسط", priceIqd: 12000, stockQuantity: 6 }, { sku: "MD1-SHIRT-L", name: "كبير", priceIqd: 15000, stockQuantity: 5 }]) {
    const added = await request(`${catalogA}/products/${shirtId}/variants`, { method: "POST", token: tokenA, body: { ...variant, lowStockThreshold: 1 } });
    assert.equal(added.status, 201, JSON.stringify(added.payload));
  }
  const rxCreated = await request(`${catalogA}/products`, { method: "POST", token: tokenA, body: { sku: "MD1-RX", name: "دواء بوصفة", priceIqd: 4000, stockQuantity: 9, requiresPrescription: true } });
  assert.equal(rxCreated.status, 201, JSON.stringify(rxCreated.payload));
  const bShirt = await request(`${catalogB}/products`, { method: "POST", token: tokenB, body: { sku: "MD1-B-SECRET", name: "قميص باء السري", priceIqd: 9000, stockQuantity: 3 } });
  assert.equal(bShirt.status, 201, JSON.stringify(bShirt.payload));

  const shirtFull = await prisma.product.findFirstOrThrow({ where: { storeId: storeA.id, sku: "MD1-SHIRT" }, include: { variants: { orderBy: [{ isDefault: "desc" }, { position: "asc" }] } } });
  const shirtDefaultVariant = shirtFull.variants.find((variant) => variant.isDefault);
  const rxProduct = await prisma.product.findFirstOrThrow({ where: { storeId: storeA.id, sku: "MD1-RX" }, include: { variants: true } });
  const bProduct = await prisma.product.findFirstOrThrow({ where: { storeId: storeB.id, sku: "MD1-B-SECRET" }, include: { variants: true } });

  const shopper = await registerCustomer(storeA.slug, "زينب الوفية");
  const otherShopper = await registerCustomer(storeA.slug, "سارة الجديدة");
  const bShopper = await registerCustomer(storeB.slug, "زبونة باء");

  const orderOne = await placeOrder(storeA.slug, shopper, shirtDefaultVariant.id, 2);
  assert.equal(orderOne.status, 201, JSON.stringify(orderOne.payload));
  const orderTwo = await placeOrder(storeA.slug, otherShopper, shirtFull.variants.find((variant) => variant.sku === "MD1-SHIRT-L").id, 1);
  assert.equal(orderTwo.status, 201, JSON.stringify(orderTwo.payload));
  const orderRx = await placeOrder(storeA.slug, shopper, rxProduct.variants[0].id, 1);
  assert.equal(orderRx.status, 201, JSON.stringify(orderRx.payload));
  assert.equal(orderRx.payload.order.prescriptionStatus, "pending_upload", "the prescription product stamps the gate at creation");
  const orderBStore = await placeOrder(storeB.slug, bShopper, bProduct.variants[0].id, 1);
  assert.equal(orderBStore.status, 201, JSON.stringify(orderBStore.payload));

  // ============================================================
  // 1. البحث الشامل الواحد
  // ============================================================
  const searchA = (query, token = tokenA, slug = storeA.slug) => request(`/merchant/stores/${slug}/search?q=${encodeURIComponent(query)}`, { token });

  const tooShort = await searchA("ق");
  assert.equal(tooShort.status, 422, JSON.stringify(tooShort.payload));
  assert.equal(tooShort.payload.error.code, "INVALID_SEARCH_QUERY", "a one-character query never reaches the database");
  assert.equal((await searchA("")).status, 422, "an empty query is refused too, with the 422 every other MD-1 validator uses");

  const byName = await searchA("قميص المرح");
  assert.equal(byName.status, 200, JSON.stringify(byName.payload));
  assert.deepEqual(byName.payload.scopes, ["products", "orders", "customers"], "the owning merchant holds all three domains, and the payload says so");
  assert.equal(byName.payload.products.length, 1);
  assert.equal(byName.payload.products[0].sku, "MD1-SHIRT");
  assert.ok(byName.payload.products[0].href.includes(`/merchant/stores/${storeA.slug}/dashboard/products`), "each hit carries a link target");
  assert.ok(byName.payload.products[0].href.includes(encodeURIComponent("MD1-SHIRT")), "the product link is DEEP — it carries the match, not just the list page");

  const bySku = await searchA("md1-shirt");
  assert.equal(bySku.payload.products.length, 1, "SKU search is case-insensitive");
  assert.equal(bySku.payload.products[0].id, shirtId);

  const orderNumberFragment = orderOne.payload.order.orderNumber.slice(-8);
  const byOrderNumber = await searchA(orderNumberFragment);
  assert.equal(byOrderNumber.payload.orders.length, 1, "order number fragment resolves exactly one order");
  assert.equal(byOrderNumber.payload.orders[0].orderNumber, orderOne.payload.order.orderNumber);
  assert.ok(byOrderNumber.payload.orders[0].href.endsWith(`/orders/${orderOne.payload.order.id}`));

  const byCustomerName = await searchA("زينب");
  assert.equal(byCustomerName.payload.customers.length, 1);
  assert.equal(byCustomerName.payload.customers[0].id, shopper.id);
  assert.ok(byCustomerName.payload.customers[0].href.includes("q="), "the customer link is DEEP — it lands on the match, not on an unfiltered directory");

  const byPhone = await searchA(shopper.phone);
  assert.equal(byPhone.payload.customers.length, 1, "phone search finds the customer");
  // PG-6 / owner decision 2: the palette MASKS the number to its last four
  // digits. This assertion used to compare the full number, and it was right to
  // until the decision changed: the palette answers on every keystroke, to
  // anyone holding customers.view, and four digits are what a merchant needs to
  // recognise the courier's caller ID — the whole number belongs on the
  // customer's own record page. Asserted as an EXACT string plus a
  // whole-payload sweep, so a future edit that quietly restores the full number
  // anywhere in the response (a field, an href) fails here.
  assert.equal(byPhone.payload.customers[0].phone, `••••${shopper.phone.slice(-4)}`, "the palette shows only the last four digits of the phone");
  // The sweep is over the CUSTOMER section, not the whole payload: `query`
  // echoes back what the merchant himself typed, and refusing to repeat his own
  // input would be theatre rather than privacy.
  assert.ok(!JSON.stringify(byPhone.payload.customers).includes(shopper.phone.replace(/[^0-9]/g, "")), "and the full number appears nowhere in the customer rows — not in a field, not in an href");
  assert.ok(byPhone.payload.orders.some((order) => order.id === orderOne.payload.order.id), "the same phone also finds the orders shipped to it");

  // ---- digits inside a NON-phone query must not drive phone matching. ----
  // `AB-0001` used to return زينب, because the old needle stripped every
  // non-digit from ANY query and `0001` happens to sit inside her phone.
  const phoneTail = shopper.phone.slice(-4);
  const alphanumericQuery = await searchA(`AB-${phoneTail}`);
  assert.equal(alphanumericQuery.status, 200, JSON.stringify(alphanumericQuery.payload));
  assert.deepEqual(alphanumericQuery.payload.customers, [], "a query carrying letters is not a phone probe, whatever digits it contains");
  assert.deepEqual(alphanumericQuery.payload.orders, [], "and it does not sweep orders by recipient phone either");
  assert.equal((await searchA(phoneTail)).payload.customers.length, 1, "a genuinely phone-shaped query still matches the phone");

  // ---- LIKE metacharacters are ESCAPED, not honoured. ----
  const wildcardProduct = await request(`${catalogA}/products`, { method: "POST", token: tokenA, body: { sku: "MD1-DISCOUNT", name: "خصم 50%", priceIqd: 5000, stockQuantity: 1 } });
  assert.equal(wildcardProduct.status, 201, JSON.stringify(wildcardProduct.payload));
  const bareWildcard = await searchA("%%");
  assert.deepEqual(bareWildcard.payload.products, [], "`%%` is a literal, not a wildcard that matches every product in the store");
  assert.deepEqual(bareWildcard.payload.orders, []);
  assert.deepEqual(bareWildcard.payload.customers, []);
  assert.deepEqual((await searchA("__")).payload.products, [], "`__` matches literal underscores, not any two characters");
  const literalPercent = await searchA("50%");
  assert.equal(literalPercent.payload.products.length, 1, "a real `%` inside the merchant's own text still finds its product");
  assert.equal(literalPercent.payload.products[0].sku, "MD1-DISCOUNT");

  // Cross-store leakage attempt: store A's own search must never surface store B.
  const leak = await searchA("MD1-B-SECRET");
  assert.deepEqual(leak.payload.products, [], "store B's product is invisible from store A");
  assert.deepEqual(leak.payload.orders, []);
  assert.deepEqual(leak.payload.customers, []);
  const leakByName = await searchA("قميص باء");
  assert.deepEqual(leakByName.payload.products, [], "store B's product NAME is invisible too");
  const leakOrder = await searchA(orderBStore.payload.order.orderNumber);
  assert.deepEqual(leakOrder.payload.orders, [], "store B's order number is invisible from store A");
  const leakCustomer = await searchA("زبونة باء");
  assert.deepEqual(leakCustomer.payload.customers, [], "store B's customer is invisible from store A");

  // The per-kind cap is 5 even when more rows match.
  for (let index = 0; index < 7; index += 1) {
    const created = await request(`${catalogA}/products`, { method: "POST", token: tokenA, body: { sku: `MD1-CAP-${index}`, name: `منتج السقف ${index}`, priceIqd: 1000 } });
    assert.equal(created.status, 201, JSON.stringify(created.payload));
  }
  const capped = await searchA("MD1-CAP");
  assert.equal(capped.payload.products.length, 5, "at most five products are returned per kind");
  assert.deepEqual(capped.payload.truncated, ["products"], "and the payload SAYS the cap hid matches, instead of implying five is all there is");
  assert.deepEqual(byName.payload.truncated, [], "a result set inside the cap reports nothing truncated");

  const crossStoreToken = await searchA("قميص", tokenB);
  assert.equal(crossStoreToken.status, 403, "a merchant token from another store is refused at the boundary");

  // ============================================================
  // 1b. PER-DOMAIN AUTHORIZATION — what a staff member is allowed to SEE,
  //     not merely whether she is allowed to search.
  //
  //     The unified search returns orders, customers AND products from one
  //     route. Guarding all three behind `orders.view` alone handed every
  //     default `store_staff` — a role that does NOT hold `customers.view` —
  //     the customer directory (name + phone) through the search box. These
  //     cases assert the payload, not the status code.
  // ============================================================
  const setOverrides = async (overrides) => {
    const applied = await request(`/merchant/stores/${storeA.slug}/team/${staffMembershipId}/overrides`, { method: "PUT", token: tokenA, body: { overrides } });
    assert.equal(applied.status, 200, JSON.stringify(applied.payload));
    const relogin = await request(`/auth/staff/stores/${storeA.slug}/login`, { method: "POST", body: { email: `${testId}.staff@codiq.test`, password: "md1-staff-temp-password" } });
    assert.equal(relogin.status, 200, JSON.stringify(relogin.payload));
    tokenStaff = relogin.payload.accessToken;
  };

  // (a) The DEFAULT store_staff role: products + orders, and NO customers.
  await setOverrides([]);
  const staffDirectory = await request(`/merchant/stores/${storeA.slug}/customers`, { token: tokenStaff });
  assert.equal(staffDirectory.status, 403, JSON.stringify(staffDirectory.payload));
  assert.equal(staffDirectory.payload.error.code, "STAFF_PERMISSION_DENIED", "the default store_staff role holds no customers.view");
  const staffDefaultSearch = await searchA("زينب", tokenStaff);
  assert.equal(staffDefaultSearch.status, 200, JSON.stringify(staffDefaultSearch.payload));
  assert.deepEqual(staffDefaultSearch.payload.scopes, ["products", "orders"], "the payload DECLARES which sections this actor may see");
  assert.equal(staffDefaultSearch.payload.customers, undefined, "no empty customers array — the section is absent, so 'forbidden' can never read as 'no results'");
  assert.ok(!JSON.stringify(staffDefaultSearch.payload).includes(shopper.phone), "the customer's PHONE — a customers.view field — never rides the order rows");
  const staffPhoneProbe = await searchA(shopper.phone, tokenStaff);
  assert.equal(staffPhoneProbe.payload.customers, undefined, "not even a direct phone query opens the customer directory");
  // The sharpest proof: a customer with NO orders is entirely invisible to a
  // staff member who lacks customers.view, and plainly visible to the merchant.
  // (An order row legitimately carries its own recipient name under
  // `orders.view`; the customer RECORD is what `customers.view` guards.)
  const orderlessCustomer = await registerCustomer(storeA.slug, "هدى بلا طلبات");
  assert.deepEqual((await searchA("هدى", tokenStaff)).payload.orders, [], "she has no orders, so the order domain shows nothing");
  assert.equal((await searchA("هدى", tokenStaff)).payload.customers, undefined, "and the customer directory is closed to this staff member");
  const merchantSeesOrderless = await searchA("هدى");
  assert.equal(merchantSeesOrderless.payload.customers.length, 1, "the merchant, who holds customers.view, does see her");
  assert.equal(merchantSeesOrderless.payload.customers[0].id, orderlessCustomer.id);

  // (b) customers.view granted → the customer section appears, and only then.
  await setOverrides([{ permissionCode: "customers.view", effect: "allow" }]);
  const staffWithCustomers = await searchA("هدى", tokenStaff);
  assert.deepEqual(staffWithCustomers.payload.scopes, ["products", "orders", "customers"]);
  assert.equal(staffWithCustomers.payload.customers.length, 1, "with customers.view the same staff member does see the customer");
  assert.equal(staffWithCustomers.payload.customers[0].id, orderlessCustomer.id);

  // (c) catalog.products.view denied → no product rows, even by exact SKU.
  await setOverrides([{ permissionCode: "catalog.products.view", effect: "deny" }]);
  const staffNoProducts = await searchA("MD1-SHIRT", tokenStaff);
  assert.equal(staffNoProducts.status, 200, JSON.stringify(staffNoProducts.payload));
  assert.deepEqual(staffNoProducts.payload.scopes, ["orders"], "products AND customers are both out of scope for this actor");
  assert.equal(staffNoProducts.payload.products, undefined, "an exact SKU returns no product section without catalog.products.view");
  assert.ok(!JSON.stringify(staffNoProducts.payload).includes("قميص المرح"), "and no product name leaks through the order rows either");
  assert.equal((await request(`/merchant/stores/${storeA.slug}/products`, { token: tokenStaff })).status, 403, "the products endpoint agrees with the search payload");

  // (d) all three denied → the route itself is refused; there is nothing to serve.
  await setOverrides([{ permissionCode: "orders.view", effect: "deny" }, { permissionCode: "catalog.products.view", effect: "deny" }, { permissionCode: "customers.view", effect: "deny" }]);
  const staffDenied = await searchA("قميص", tokenStaff);
  assert.equal(staffDenied.status, 403, JSON.stringify(staffDenied.payload));
  assert.equal(staffDenied.payload.error.code, "STAFF_PERMISSION_DENIED", "an actor holding none of the three domains cannot search at all");

  // (e) orders.view alone still searches — orders only.
  await setOverrides([{ permissionCode: "catalog.products.view", effect: "deny" }, { permissionCode: "inventory.update", effect: "deny" }]);
  const staffOrdersOnly = await searchA(orderNumberFragment, tokenStaff);
  assert.deepEqual(staffOrdersOnly.payload.scopes, ["orders"]);
  assert.equal(staffOrdersOnly.payload.orders.length, 1, "the order domain is unaffected by the other two denials");

  // Leave the membership denied on orders.update so the later bulk probe isolates it.
  await setOverrides([{ permissionCode: "orders.update", effect: "deny" }]);
  assert.equal((await searchA("قميص", tokenStaff)).status, 200, "with the operational role restored the same staff can search again");

  summary.search = { minLength: 422, byName: 1, bySku: 1, byOrderNumber: 1, byPhone: 1, crossStoreHits: 0, perKindCap: 5, crossStoreToken: 403, staffAllDenied: "STAFF_PERMISSION_DENIED", defaultStaffScopes: ["products", "orders"], likeWildcardsEscaped: true, phoneNeedleGated: true };

  // ============================================================
  // 2. نسخ منتج بنقرة
  // ============================================================
  const imageCountBefore = await prisma.productImage.count({ where: { storeId: storeA.id, productId: shirtId } });
  const firstCopy = await request(`${catalogA}/products/${shirtId}/duplicate`, { method: "POST", token: tokenA });
  assert.equal(firstCopy.status, 201, JSON.stringify(firstCopy.payload));
  assert.equal(firstCopy.payload.product.sku, "MD1-SHIRT-COPY");
  assert.equal(firstCopy.payload.product.name, "قميص المرح (نسخة)");
  // A one-click copy lands as a DRAFT. Inheriting the source's published flag
  // put «X (نسخة)» — zero stock, unbuyable — in front of shoppers instantly.
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: shirtId } })).isActive, true, "the SOURCE product is published");
  assert.equal(firstCopy.payload.product.isActive, false, "the copy is an unpublished draft regardless of the source's state");
  const publicAfterCopy = await request(`/store/${storeA.slug}/products`);
  assert.equal(publicAfterCopy.status, 200);
  assert.ok(publicAfterCopy.payload.products.some((product) => product.sku === "MD1-SHIRT"), "the source is still on the storefront");
  assert.ok(!publicAfterCopy.payload.products.some((product) => product.sku === "MD1-SHIRT-COPY"), "the zero-stock copy never reaches the storefront");
  assert.equal(firstCopy.payload.product.category.id, category.payload.category.id, "the category link is copied");
  assert.deepEqual(firstCopy.payload.product.images, [], "images are NOT copied in v1");
  assert.equal(firstCopy.payload.product.variants.length, 3, "ALL variants are copied");
  assert.deepEqual(firstCopy.payload.product.variants.map((variant) => variant.sku).sort(), ["MD1-SHIRT-COPY", "MD1-SHIRT-L-COPY", "MD1-SHIRT-M-COPY"]);
  assert.deepEqual(firstCopy.payload.product.variants.map((variant) => variant.name).sort(), ["قميص المرح", "كبير", "وسط"], "variant names survive the copy");
  assert.deepEqual(firstCopy.payload.product.variants.map((variant) => variant.priceIqd).sort((a, b) => a - b), [10000, 12000, 15000], "variant prices survive the copy");
  assert.ok(firstCopy.payload.product.variants.every((variant) => variant.stockQuantity === 0), "every copied variant starts at ZERO stock");
  assert.equal(firstCopy.payload.product.stockQuantity, 0, "the copy owns no inventory at all");
  assert.equal(await prisma.productImage.count({ where: { storeId: storeA.id, productId: firstCopy.payload.product.id } }), 0);
  assert.equal(imageCountBefore, await prisma.productImage.count({ where: { storeId: storeA.id, productId: shirtId } }), "the source product is untouched");
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: shirtId } })).stockQuantity, 8, "the source stock is untouched");
  assert.equal(await prisma.inventoryMovement.count({ where: { storeId: storeA.id, productId: firstCopy.payload.product.id } }), 0, "a zero-stock copy records no inventory movement");

  const secondCopy = await request(`${catalogA}/products/${shirtId}/duplicate`, { method: "POST", token: tokenA });
  assert.equal(secondCopy.status, 201, JSON.stringify(secondCopy.payload));
  assert.equal(secondCopy.payload.product.sku, "MD1-SHIRT-COPY-2", "a second duplicate walks the suffix forward");
  assert.deepEqual(secondCopy.payload.product.variants.map((variant) => variant.sku).sort(), ["MD1-SHIRT-COPY-2", "MD1-SHIRT-L-COPY-2", "MD1-SHIRT-M-COPY-2"]);
  const allProductSkus = (await prisma.product.findMany({ where: { storeId: storeA.id }, select: { sku: true } })).map((row) => row.sku);
  const allVariantSkus = (await prisma.productVariant.findMany({ where: { storeId: storeA.id }, select: { sku: true } })).map((row) => row.sku);
  assert.equal(new Set(allProductSkus).size, allProductSkus.length, "every product SKU in the store is unique");
  assert.equal(new Set(allVariantSkus).size, allVariantSkus.length, "every variant SKU in the store is unique");

  const crossStoreDuplicate = await request(`${catalogA}/products/${bProduct.id}/duplicate`, { method: "POST", token: tokenA });
  assert.equal(crossStoreDuplicate.status, 404, "a foreign product id is indistinguishable from a missing one");
  assert.equal(crossStoreDuplicate.payload.error.code, "RESOURCE_NOT_FOUND");
  assert.equal(await prisma.product.count({ where: { storeId: storeA.id, sku: { startsWith: "MD1-B-SECRET" } } }), 0, "nothing was created from the refused cross-store duplicate");

  const freePlan = await prisma.plan.findUniqueOrThrow({ where: { code: "free" }, select: { id: true } });
  const originalLimit = (await prisma.planFeature.findUniqueOrThrow({ where: { planId_featureCode: { planId: freePlan.id, featureCode: "max_products" } } })).limitValue;
  const merchantAProducts = await prisma.product.count({ where: { store: { merchantId: merchantA.payload.account.id } } });
  const variantsBeforeLimit = await prisma.productVariant.count({ where: { storeId: storeA.id } });
  // `plan_features` is GLOBAL and shared by every suite on this database, and it
  // is NOT in the TRUNCATE above. Restoring it outside a finally meant one failed
  // assertion here left the free plan permanently clamped and poisoned every
  // suite that ran afterwards — so the clamp lives inside try/finally.
  await prisma.planFeature.update({ where: { planId_featureCode: { planId: freePlan.id, featureCode: "max_products" } }, data: { limitValue: merchantAProducts } });
  await applyPlanTermsNow(prisma, freePlan.id); // phase 30: publish + renew so the clamp applies
  try {
    const limited = await request(`${catalogA}/products/${shirtId}/duplicate`, { method: "POST", token: tokenA });
    assert.equal(limited.status, 403, JSON.stringify(limited.payload));
    assert.equal(limited.payload.error.code, "PLAN_LIMIT_EXCEEDED", "the duplicate is charged against max_products inside the transaction");
    assert.equal(await prisma.product.count({ where: { store: { merchantId: merchantA.payload.account.id } } }), merchantAProducts, "zero partial product writes under the plan refusal");
    assert.equal(await prisma.productVariant.count({ where: { storeId: storeA.id } }), variantsBeforeLimit, "zero partial variant writes under the plan refusal");
  } finally {
    await prisma.planFeature.update({ where: { planId_featureCode: { planId: freePlan.id, featureCode: "max_products" } }, data: { limitValue: originalLimit } });
    await applyPlanTermsNow(prisma, freePlan.id); // phase 30: publish + renew so the clamp applies
  }
  assert.equal((await prisma.planFeature.findUniqueOrThrow({ where: { planId_featureCode: { planId: freePlan.id, featureCode: "max_products" } } })).limitValue, originalLimit, "the shared free plan is left exactly as it was found");

  summary.duplicate = { firstSku: "MD1-SHIRT-COPY", secondSku: "MD1-SHIRT-COPY-2", variantsCopied: 3, stockZeroed: true, landsAsDraft: true, imagesCopied: 0, crossStore: 404, planLimit: "PLAN_LIMIT_EXCEEDED", partialWrites: 0, globalPlanRestored: true };

  // ============================================================
  // 3. ملاحظات ووسوم داخلية على الطلب
  // ============================================================
  const orderOneId = orderOne.payload.order.id;
  const notesPath = `${ordersA}/${orderOneId}/notes`;
  const tagsPath = `${ordersA}/${orderOneId}/tags`;

  assert.deepEqual((await request(notesPath, { token: tokenA })).payload.notes, [], "a fresh order carries no notes");
  const firstNote = await request(notesPath, { method: "POST", token: tokenA, body: { body: "الزبونة طلبت التغليف كهدية." } });
  assert.equal(firstNote.status, 201, JSON.stringify(firstNote.payload));
  assert.equal(firstNote.payload.note.authorKind, "merchant");
  assert.equal(firstNote.payload.note.authorId, merchantA.payload.account.id);
  const secondNote = await request(notesPath, { method: "POST", token: tokenA, body: { body: "اتصلنا لتأكيد العنوان." } });
  assert.equal(secondNote.status, 201);
  const listedNotes = await request(notesPath, { token: tokenA });
  assert.equal(listedNotes.payload.notes.length, 2);
  assert.deepEqual(listedNotes.payload.notes.map((note) => note.body), ["الزبونة طلبت التغليف كهدية.", "اتصلنا لتأكيد العنوان."], "notes read back oldest-first");

  const emptyNote = await request(notesPath, { method: "POST", token: tokenA, body: { body: "   " } });
  assert.equal(emptyNote.status, 422);
  assert.equal(emptyNote.payload.error.code, "INVALID_ORDER_NOTE");
  const oversizedNote = await request(notesPath, { method: "POST", token: tokenA, body: { body: "ن".repeat(2001) } });
  assert.equal(oversizedNote.status, 422, "the 2000-character cap is enforced");
  assert.equal(oversizedNote.payload.error.code, "INVALID_ORDER_NOTE");
  const maxNote = await request(notesPath, { method: "POST", token: tokenA, body: { body: "ن".repeat(2000) } });
  assert.equal(maxNote.status, 201, "exactly 2000 characters is accepted");
  assert.equal(await prisma.orderNote.count({ where: { storeId: storeA.id, orderId: orderOneId } }), 3, "only the accepted notes were written");

  const tagsSaved = await request(tagsPath, { method: "PUT", token: tokenA, body: { tags: ["عاجل", " هدية ", "عاجل", "VIP"] } });
  assert.equal(tagsSaved.status, 200, JSON.stringify(tagsSaved.payload));
  assert.deepEqual(tagsSaved.payload.tags, ["عاجل", "هدية", "VIP"], "tags are trimmed and de-duplicated");
  assert.deepEqual((await request(tagsPath, { token: tokenA })).payload.tags, ["عاجل", "هدية", "VIP"]);
  const tooManyTags = await request(tagsPath, { method: "PUT", token: tokenA, body: { tags: Array.from({ length: 9 }, (_value, index) => `وسم-${index}`) } });
  assert.equal(tooManyTags.status, 422);
  assert.equal(tooManyTags.payload.error.code, "INVALID_ORDER_TAGS", "the 8-tag cap is enforced");
  const eightTags = await request(tagsPath, { method: "PUT", token: tokenA, body: { tags: Array.from({ length: 8 }, (_value, index) => `وسم-${index}`) } });
  assert.equal(eightTags.status, 200, "exactly eight tags is accepted");
  const longTag = await request(tagsPath, { method: "PUT", token: tokenA, body: { tags: ["ط".repeat(25)] } });
  assert.equal(longTag.status, 422, "the 24-character tag cap is enforced");
  assert.equal(longTag.payload.error.code, "INVALID_ORDER_TAGS");
  assert.equal((await request(tagsPath, { method: "PUT", token: tokenA, body: { tags: ["ط".repeat(24)] } })).status, 200, "exactly 24 characters is accepted");
  const restoredTags = await request(tagsPath, { method: "PUT", token: tokenA, body: { tags: ["عاجل", "هدية"] } });
  assert.deepEqual(restoredTags.payload.tags, ["عاجل", "هدية"]);
  // The tag write is metadata: it must not disturb the order state machine.
  const orderAfterTags = await prisma.storeOrder.findUniqueOrThrow({ where: { id: orderOneId } });
  assert.equal(orderAfterTags.version, 1, "tagging never bumps the order version");
  assert.equal(orderAfterTags.status, "new", "tagging never touches the order status");

  // IDOR: the other store's merchant cannot read or write this order's internals.
  const idorRead = await request(`/merchant/stores/${storeB.slug}/orders/${orderOneId}/notes`, { token: tokenB });
  assert.equal(idorRead.status, 404, "store B cannot read store A's order notes");
  const idorWrite = await request(`/merchant/stores/${storeB.slug}/orders/${orderOneId}/notes`, { method: "POST", token: tokenB, body: { body: "تسلل" } });
  assert.equal(idorWrite.status, 404);
  const idorTags = await request(`/merchant/stores/${storeB.slug}/orders/${orderOneId}/tags`, { method: "PUT", token: tokenB, body: { tags: ["تسلل"] } });
  assert.equal(idorTags.status, 404);
  assert.equal((await request(`${ordersA}/${orderOneId}/notes`, { token: tokenB })).status, 403, "and the store-A path refuses the store-B token at the boundary");
  assert.deepEqual((await request(tagsPath, { token: tokenA })).payload.tags, ["عاجل", "هدية"], "no cross-store write landed");

  // ---- INTERNAL-ONLY proof: no storefront/customer payload carries either. ----
  const publicProducts = await request(`/store/${storeA.slug}/products`);
  const publicProduct = await request(`/store/${storeA.slug}/products/${shirtId}`);
  const customerOrders = await request(`/store/${storeA.slug}/account/orders`, { token: shopper.token });
  const customerOrder = await request(`/store/${storeA.slug}/account/orders/${orderOneId}`, { token: shopper.token });
  const customerHistory = await request(`/store/${storeA.slug}/account/orders/${orderOneId}/history`, { token: shopper.token });
  const publicConfig = await request(`/store/${storeA.slug}/public-config`);
  for (const [label, response] of [["products", publicProducts], ["product", publicProduct], ["orders", customerOrders], ["order", customerOrder], ["history", customerHistory], ["public-config", publicConfig]]) {
    assert.equal(response.status, 200, `${label} must still serve normally`);
    const serialized = JSON.stringify(response.payload);
    assert.ok(!serialized.includes("internalTags"), `${label} must not carry the internalTags key`);
    assert.ok(!serialized.includes("internal_tags"), `${label} must not carry the internal_tags column`);
    assert.ok(!serialized.includes("عاجل"), `${label} must not leak an internal TAG value`);
    assert.ok(!serialized.includes("هدية"), `${label} must not leak an internal TAG value`);
    assert.ok(!serialized.includes("الزبونة طلبت التغليف كهدية."), `${label} must not leak an internal NOTE body`);
    assert.ok(!serialized.includes("اتصلنا لتأكيد العنوان."), `${label} must not leak an internal NOTE body`);
  }
  assert.equal(customerOrder.payload.order.internalTags, undefined, "the customer order payload has no internalTags field at all");
  assert.equal(customerOrder.payload.order.notes, undefined, "the customer order payload has no notes field at all");
  // No public route exposes the notes path either.
  assert.equal((await request(`/store/${storeA.slug}/account/orders/${orderOneId}/notes`, { token: shopper.token })).status, 404, "there is NO storefront notes route");
  // The merchant list row, by contrast, DOES carry the tags (that is the point).
  const merchantList = await request(`${ordersA}?limit=25`, { token: tokenA });
  const listedOrder = merchantList.payload.orders.find((order) => order.id === orderOneId);
  assert.deepEqual(listedOrder.internalTags, ["عاجل", "هدية"], "the merchant order list row carries the internal tags");

  // An internal thread nobody can attribute is not a thread: each note resolves
  // its author id to a real name.
  const namedNotes = await request(notesPath, { token: tokenA });
  assert.equal(namedNotes.payload.notes[0].authorName, "متجر MD1 ألف", "the note carries WHO wrote it, not just an opaque uuid");

  // ============================================================
  // 3b. CONCURRENT TAG REPLACE — the delete-then-insert race.
  //
  //     Two simultaneous replaces on the SAME order used to interleave: under
  //     READ COMMITTED neither transaction's DELETE blocks the other, so both
  //     inserted. Measured before the fix, 20 rounds of two disjoint 8-tag sets
  //     produced 500 INTERNAL_ERROR responses and SIXTEEN stored tags — twice
  //     the cap the migration's own comment calls impossible to exceed — while
  //     identical sets produced 409 DUPLICATE_IDENTITY («حساب بهذه الهوية
  //     موجود»), a message about accounts, on an order-tag write.
  // ============================================================
  const RACE_ROUNDS = 20;
  const disjointA = Array.from({ length: 8 }, (_value, index) => `سباق-أ-${index}`);
  const disjointB = Array.from({ length: 8 }, (_value, index) => `سباق-ب-${index}`);
  const identical = ["مكرر-1", "مكرر-2", "مكرر-3"];
  const raceStatuses = { ok: 0, conflict: 0, other: 0 };
  let maxStoredTags = 0;
  for (let round = 0; round < RACE_ROUNDS; round += 1) {
    const pair = round % 2 === 0 ? [disjointA, disjointB] : [identical, identical];
    // Each round starts from an EMPTY tag set on purpose: that is precisely the
    // window row locking has to close. Two DELETEs that remove the same existing
    // rows already block each other; two DELETEs that remove NOTHING do not, so
    // without the FOR UPDATE both writers sail past and insert together.
    assert.equal((await request(tagsPath, { method: "PUT", token: tokenA, body: { tags: [] } })).status, 200);
    const responses = await Promise.all(pair.map((tags) => request(tagsPath, { method: "PUT", token: tokenA, body: { tags } })));
    for (const response of responses) {
      assert.notEqual(response.status, 500, `a concurrent tag replace must never be a server error: ${JSON.stringify(response.payload)}`);
      if (response.status === 200) raceStatuses.ok += 1;
      else if (response.status === 409) { raceStatuses.conflict += 1; assert.equal(response.payload.error.code, "ORDER_TAGS_CONFLICT", "a tag conflict says so — it is NOT a duplicate account identity"); }
      else { raceStatuses.other += 1; assert.fail(`unexpected status ${response.status}: ${JSON.stringify(response.payload)}`); }
    }
    const stored = await prisma.orderTag.count({ where: { storeId: storeA.id, orderId: orderOneId } });
    maxStoredTags = Math.max(maxStoredTags, stored);
    assert.ok(stored <= 8, `the 8-tag cap held under concurrency, saw ${stored}`);
    // The winner's set landed whole — the loser did not leave half of its own.
    const storedTags = (await prisma.orderTag.findMany({ where: { storeId: storeA.id, orderId: orderOneId }, select: { tag: true }, orderBy: { position: "asc" } })).map((row) => row.tag);
    const matchesOne = pair.some((tags) => tags.length === storedTags.length && tags.every((tag) => storedTags.includes(tag)));
    assert.ok(matchesOne, `the stored set is exactly one writer's set, not a blend: ${JSON.stringify(storedTags)}`);
  }
  assert.equal(raceStatuses.other, 0);
  assert.equal(maxStoredTags <= 8, true);
  await request(tagsPath, { method: "PUT", token: tokenA, body: { tags: ["عاجل", "هدية"] } });

  // The 409 mapping is defence in depth BEHIND the lock — with the lock in place
  // it should never fire, so it is asserted directly instead. What it must never
  // do again is answer «حساب بهذه الهوية موجود» (an account message, on an
  // order-tag write) or fall through to a bare 500.
  // D-41 split `errorHandler` into a PURE `classifyError` (status + body) and a
  // thin handler that also logs and stamps the correlation header. This test
  // measures the CLASSIFICATION, so it calls the pure half — the old hand-rolled
  // response stub had no `getHeader` and only ever worked by accident.
  const mapError = (error) => {
    const outcome = classifyError(error, { path: `${ordersA}/${orderOneId}/tags` });
    return { status: outcome.status, body: { error: outcome.error } };
  };
  const duplicateTagError = mapError(new PrismaNamespace.PrismaClientKnownRequestError("unique violation", { code: "P2002", clientVersion: "test", meta: { target: "order_tags_order_unique" } }));
  assert.equal(duplicateTagError.status, 409);
  assert.equal(duplicateTagError.body.error.code, "ORDER_TAGS_CONFLICT", "a duplicate order tag is NOT a duplicate account identity");
  assert.ok(/الطلب/.test(duplicateTagError.body.error.message), "and it says so in Arabic, about the order");
  const overCapError = mapError(new Error("an order may carry at most 8 internal tags"));
  assert.equal(overCapError.status, 409, "the count trigger's check_violation is a conflict, never a 500 INTERNAL_ERROR");
  assert.equal(overCapError.body.error.code, "ORDER_TAGS_CONFLICT");

  // ============================================================
  // 3c. THE TAG FILTER IS A SERVER FILTER.
  //
  //     Filtering the loaded page in the browser answered a different question
  //     than the merchant asked — and the bulk action then ran on that
  //     misleading subset. `هدية` sits on the OLDEST order, which never appears
  //     on an unfiltered first page.
  // ============================================================
  const rxTagged = await request(`${ordersA}/${orderRx.payload.order.id}/tags`, { method: "PUT", token: tokenA, body: { tags: ["عاجل"] } });
  assert.equal(rxTagged.status, 200, JSON.stringify(rxTagged.payload));
  const unfilteredFirstPage = await request(`${ordersA}?limit=1`, { token: tokenA });
  assert.equal(unfilteredFirstPage.payload.orders.length, 1);
  assert.notEqual(unfilteredFirstPage.payload.orders[0].id, orderOneId, "the oldest order is NOT on the first unfiltered page");
  const giftPage = await request(`${ordersA}?limit=1&tag=${encodeURIComponent("هدية")}`, { token: tokenA });
  assert.equal(giftPage.payload.orders.length, 1);
  assert.equal(giftPage.payload.orders[0].id, orderOneId, "the tag filter searches the WHOLE store, so a tagged order outside the first page is still found");
  const urgentPage = await request(`${ordersA}?tag=${encodeURIComponent("عاجل")}`, { token: tokenA });
  assert.equal(urgentPage.payload.orders.length, 2, "both tagged orders are returned, whatever page they would land on");
  assert.deepEqual((await request(`${ordersA}?tag=${encodeURIComponent("وسم-غير-موجود")}`, { token: tokenA })).payload.orders, [], "an unused tag returns nothing");
  assert.deepEqual((await request(`${ordersA}?tag=${encodeURIComponent(" عاجل ")}`, { token: tokenA })).payload.orders.length, 2, "the filter normalises exactly like the writer does");
  // The chips offer every tag the STORE uses, not only the ones on this page.
  const facets = giftPage.payload.availableTags;
  assert.ok(Array.isArray(facets), "the list payload carries the store's tag facets");
  assert.ok(facets.includes("عاجل") && facets.includes("هدية"), `the facet list is store-wide: ${JSON.stringify(facets)}`);
  assert.equal(giftPage.payload.appliedTag, "هدية", "the payload states which tag it filtered by");
  // Untag the prescription order again so section 4 starts from its old fixture.
  assert.equal((await request(`${ordersA}/${orderRx.payload.order.id}/tags`, { method: "PUT", token: tokenA, body: { tags: [] } })).status, 200);

  summary.notesAndTags = { created: 3, noteCap: 2000, tagCountCap: 8, tagLengthCap: 24, deduped: true, idor: 404, storefrontLeak: false, merchantListCarriesTags: true, authorNamed: true, raceRounds: RACE_ROUNDS, raceStatuses, maxStoredTagsUnderRace: maxStoredTags, serverSideTagFilter: true };

  // ============================================================
  // 4. إجراءات جماعية على الطلبات
  // ============================================================
  const bulkPath = `${ordersA}/bulk-status`;
  // Order two is deliberately moved to a terminal state first, so the batch has
  // a guaranteed INVALID_ORDER_TRANSITION member.
  const cancelTwo = await request(`${ordersA}/${orderTwo.payload.order.id}/status`, { method: "POST", token: tokenA, body: { toStatus: "cancelled", expectedVersion: 1 } });
  assert.equal(cancelTwo.status, 200, JSON.stringify(cancelTwo.payload));
  const cancelledId = orderTwo.payload.order.id;
  const rxId = orderRx.payload.order.id;
  const missingId = "00000000-0000-4000-8000-000000000000";

  const beforeCancelled = await prisma.storeOrder.findUniqueOrThrow({ where: { id: cancelledId } });
  const beforeRx = await prisma.storeOrder.findUniqueOrThrow({ where: { id: rxId } });
  const cancelledEventsBefore = await prisma.orderStatusEvent.count({ where: { storeId: storeA.id, orderId: cancelledId } });
  const rxEventsBefore = await prisma.orderStatusEvent.count({ where: { storeId: storeA.id, orderId: rxId } });

  const bulk = await request(bulkPath, { method: "POST", token: tokenA, body: { toStatus: "processing", orders: [{ orderId: orderOneId }, { orderId: cancelledId }, { orderId: rxId }, { orderId: missingId }, { orderId: orderBStore.payload.order.id }] } });
  assert.equal(bulk.status, 200, JSON.stringify(bulk.payload));
  assert.equal(bulk.payload.requested, 5);
  assert.equal(bulk.payload.succeeded, 1);
  assert.equal(bulk.payload.failed, 4);
  const byOrder = Object.fromEntries(bulk.payload.results.map((result) => [result.orderId, result]));
  assert.deepEqual({ ok: byOrder[orderOneId].ok, code: byOrder[orderOneId].code }, { ok: true, code: "OK" });
  assert.equal(byOrder[orderOneId].status, "processing");
  assert.deepEqual({ ok: byOrder[cancelledId].ok, code: byOrder[cancelledId].code }, { ok: false, code: "INVALID_ORDER_TRANSITION" }, "a terminal order is refused by the state machine, not by the bulk path");
  assert.deepEqual({ ok: byOrder[rxId].ok, code: byOrder[rxId].code }, { ok: false, code: "PRESCRIPTION_NOT_APPROVED" }, "the 20B-1 prescription gate still fires inside a bulk move");
  assert.deepEqual({ ok: byOrder[missingId].ok, code: byOrder[missingId].code }, { ok: false, code: "RESOURCE_NOT_FOUND" });
  assert.deepEqual({ ok: byOrder[orderBStore.payload.order.id].ok, code: byOrder[orderBStore.payload.order.id].code }, { ok: false, code: "RESOURCE_NOT_FOUND" }, "a cross-store order id in the batch is a plain not-found");

  // ---- no-bypass proof: the failures changed absolutely nothing. ----
  const afterCancelled = await prisma.storeOrder.findUniqueOrThrow({ where: { id: cancelledId } });
  const afterRx = await prisma.storeOrder.findUniqueOrThrow({ where: { id: rxId } });
  assert.deepEqual({ status: afterCancelled.status, version: afterCancelled.version }, { status: beforeCancelled.status, version: beforeCancelled.version }, "the refused terminal order is byte-identical");
  assert.deepEqual({ status: afterRx.status, version: afterRx.version, prescriptionStatus: afterRx.prescriptionStatus }, { status: beforeRx.status, version: beforeRx.version, prescriptionStatus: beforeRx.prescriptionStatus }, "the prescription-gated order is byte-identical");
  assert.equal(await prisma.orderStatusEvent.count({ where: { storeId: storeA.id, orderId: cancelledId } }), cancelledEventsBefore, "a refused bulk item writes no status event");
  assert.equal(await prisma.orderStatusEvent.count({ where: { storeId: storeA.id, orderId: rxId } }), rxEventsBefore);
  assert.equal((await prisma.storeOrder.findUniqueOrThrow({ where: { id: orderBStore.payload.order.id } })).status, "new", "store B's order was never touched");
  // ...and the one success went through the SAME single-order path.
  const movedOrder = await prisma.storeOrder.findUniqueOrThrow({ where: { id: orderOneId } });
  assert.equal(movedOrder.status, "processing");
  assert.equal(movedOrder.version, 2, "the successful item incremented the version exactly once");
  assert.equal(movedOrder.updatedByKind, "merchant");
  const movedEvents = await prisma.orderStatusEvent.findMany({ where: { storeId: storeA.id, orderId: orderOneId }, orderBy: { createdAt: "asc" } });
  assert.equal(movedEvents.at(-1).fromStatus, "new");
  assert.equal(movedEvents.at(-1).toStatus, "processing");
  assert.equal(movedEvents.at(-1).actorKind, "merchant", "the bulk transition is auditable exactly like a single-order move");

  // ---- ق-219: fifty If-Match requests, not fifty fresh reads. ----
  //
  // The single-order path sends `order.version` and the server compare-and-swaps
  // on it. The bulk path used to re-read the version on the server immediately
  // before each transition — a guard against a race in the microseconds between
  // its own read and write, and NO guard against the case that matters: a board
  // open and stale for ten minutes while a colleague moved the same orders. The
  // order board is worked in bulk at the end of every day, on the same screen as
  // two staff over a mobile connection, so this was the one path with optimistic
  // concurrency switched off exactly where it was needed. Each item may now carry
  // the version the screen SAW; a stale one is refused per order, in the summary.
  const staleBoard = await request(bulkPath, { method: "POST", token: tokenA, body: { toStatus: "preparation", orders: [{ orderId: orderOneId, expectedVersion: 1 }] } });
  assert.equal(staleBoard.status, 200, JSON.stringify(staleBoard.payload));
  assert.equal(staleBoard.payload.failed, 1, "ق-219: the version the board saw is stale, so the move is refused");
  assert.equal(staleBoard.payload.results[0].code, "ORDER_VERSION_CONFLICT", "…with the same code the single-order path answers");
  const afterStale = await prisma.storeOrder.findUniqueOrThrow({ where: { id: orderOneId }, select: { status: true, version: true } });
  assert.deepEqual(afterStale, { status: "processing", version: 2 }, "…and the order is byte-identical: nothing moved on a stale token");
  const malformedVersion = await request(bulkPath, { method: "POST", token: tokenA, body: { toStatus: "preparation", orders: [{ orderId: orderOneId, expectedVersion: "two" }] } });
  assert.equal(malformedVersion.status, 422);
  assert.equal(malformedVersion.payload.error.code, "INVALID_BULK_SELECTION", "a version that is not a positive integer is a request error, refused up-front");

  const overCap = await request(bulkPath, { method: "POST", token: tokenA, body: { toStatus: "cancelled", orders: Array.from({ length: 51 }, () => ({ orderId: rxId })) } });
  assert.equal(overCap.status, 422, JSON.stringify(overCap.payload));
  assert.equal(overCap.payload.error.code, "BULK_LIMIT_EXCEEDED", "more than 50 orders per call is refused outright");
  assert.equal((await prisma.storeOrder.findUniqueOrThrow({ where: { id: rxId } })).status, "new", "the over-cap call moved nothing");
  const emptySelection = await request(bulkPath, { method: "POST", token: tokenA, body: { toStatus: "cancelled", orders: [] } });
  assert.equal(emptySelection.status, 422);
  assert.equal(emptySelection.payload.error.code, "INVALID_BULK_SELECTION");
  const badStatus = await request(bulkPath, { method: "POST", token: tokenA, body: { toStatus: "teleported", orders: [{ orderId: rxId }] } });
  assert.equal(badStatus.status, 422);
  assert.equal(badStatus.payload.error.code, "INVALID_ORDER_STATUS");

  // ---- a malformed shared `note` is ONE request error, not N failures. ----
  // It used to be handed to every order in turn: 50 orders meant 50 database
  // round trips answering HTTP 200 with succeeded=0 / failed=50.
  const eventsBeforeBadNote = await prisma.orderStatusEvent.count({ where: { storeId: storeA.id } });
  const badNote = await request(bulkPath, { method: "POST", token: tokenA, body: { toStatus: "cancelled", note: 12345, orders: [{ orderId: rxId }, { orderId: orderOneId }] } });
  assert.equal(badNote.status, 400, JSON.stringify(badNote.payload));
  assert.equal(badNote.payload.error.code, "INVALID_ORDER_NOTE", "the note is validated ONCE, up-front, exactly like toStatus");
  assert.equal(badNote.payload.results, undefined, "there is no per-order result list — the request itself was refused");
  const longNote = await request(bulkPath, { method: "POST", token: tokenA, body: { toStatus: "cancelled", note: "ن".repeat(1001), orders: [{ orderId: rxId }] } });
  assert.equal(longNote.status, 400);
  assert.equal(longNote.payload.error.code, "INVALID_ORDER_NOTE", "the 1000-character cap is the state machine's own, applied up-front");
  assert.equal(await prisma.orderStatusEvent.count({ where: { storeId: storeA.id } }), eventsBeforeBadNote, "a malformed note touches NO order at all");
  assert.equal((await prisma.storeOrder.findUniqueOrThrow({ where: { id: rxId } })).status, "new");
  // ق-219: …and the version the board saw, when it IS current, goes through — the
  // positive half of the If-Match, on the same call the note proof uses.
  const goodNote = await request(bulkPath, { method: "POST", token: tokenA, body: { toStatus: "preparation", note: "دفعة مساء الخميس", orders: [{ orderId: orderOneId, expectedVersion: 2 }] } });
  assert.equal(goodNote.status, 200, JSON.stringify(goodNote.payload));
  assert.equal(goodNote.payload.succeeded, 1, "a well-formed note still rides the batch");
  assert.equal((await prisma.orderStatusEvent.findFirstOrThrow({ where: { storeId: storeA.id, orderId: orderOneId }, orderBy: { createdAt: "desc" } })).note, "دفعة مساء الخميس");
  const bulkCrossStore = await request(bulkPath, { method: "POST", token: tokenB, body: { toStatus: "cancelled", orders: [{ orderId: orderOneId }] } });
  assert.equal(bulkCrossStore.status, 403, "the store boundary holds on the bulk endpoint");
  const bulkStaffDenied = await request(bulkPath, { method: "POST", token: tokenStaff, body: { toStatus: "cancelled", orders: [{ orderId: rxId }] } });
  assert.equal(bulkStaffDenied.status, 403, JSON.stringify(bulkStaffDenied.payload));
  assert.equal(bulkStaffDenied.payload.error.code, "STAFF_PERMISSION_DENIED", "bulk rides orders.update");
  assert.equal((await prisma.storeOrder.findUniqueOrThrow({ where: { id: rxId } })).status, "new", "nothing moved under the refused guards");

  // ---- the irreversible-action confirmation is DERIVED, never hand-listed. ----
  // A terminal status is one with no outgoing edge. The bulk bar demands an
  // explicit confirmation for exactly these targets (and for no others, so the
  // everyday batch stays one click), and both sides derive the set from the same
  // transition table rather than from a list somebody has to remember to update.
  assert.deepEqual([...TERMINAL_ORDER_STATUSES], ["cancelled", "rejected", "returned"], "the server derives its terminal set from the transition table");
  for (const status of ORDER_STATUSES) {
    const terminal = TERMINAL_ORDER_STATUSES.includes(status);
    assert.equal(terminal, new RegExp(`${status}: \\[\\]`).test(workspaceSource), `the client's transition mirror agrees about ${status}`);
  }
  assert.ok(workspaceSource.includes("transitions[status].length === 0"), "the client DERIVES its terminal set from its transition table, it does not hard-code one");
  assert.ok(workspaceSource.includes("orders-bulk-confirm"), "the bulk bar carries the irreversible-action confirmation");
  assert.ok(/TERMINAL_STATUSES\.includes\(bulkStatus\)/.test(workspaceSource), "…and it is gated on the derived terminal set, so non-terminal batches stay one click");

  summary.bulk = { requested: 5, succeeded: 1, failed: 4, codes: ["INVALID_ORDER_TRANSITION", "PRESCRIPTION_NOT_APPROVED", "RESOURCE_NOT_FOUND"], cap: "BULK_LIMIT_EXCEEDED", stateMachineBypass: false, boundary: 403, staffGuard: "STAFF_PERMISSION_DENIED", malformedNote: "INVALID_ORDER_NOTE", terminalStatuses: [...TERMINAL_ORDER_STATUSES] };

  // ============================================================
  // 5. وضع «إجازة» للمتجر
  // ============================================================
  // ق-249: the MD-1 switch became the store STATUS — `paused` is the vacation, and the
  // public `vacation` key and 422 STORE_ON_VACATION are kept word for word.
  const vacationPath = `/merchant/stores/${storeA.slug}/status`;
  assert.equal((await request(vacationPath, { token: tokenA })).payload.status, "active", "the store starts active — vacation is OFF by default");
  assert.equal((await request(`/store/${storeA.slug}/public-config`)).payload.vacation, undefined, "the public config has no vacation key while it is off");

  const vacationOn = await request(vacationPath, { method: "PUT", token: tokenA, body: { status: "paused", message: "نعود في الخامس من أيلول." } });
  assert.equal(vacationOn.status, 200, JSON.stringify(vacationOn.payload));
  assert.equal(vacationOn.payload.status, "paused");
  assert.equal(vacationOn.payload.message, "نعود في الخامس من أيلول.");
  assert.equal((await prisma.store.findUniqueOrThrow({ where: { id: storeA.id } })).vacationMode, true, "the legacy mirror follows the status (stores_status_sync)");
  assert.deepEqual((await request(`/store/${storeA.slug}/public-config`)).payload.vacation, { message: "نعود في الخامس من أيلول." }, "the storefront banner text comes from the merchant");
  assert.equal((await request(`/store/${storeB.slug}/public-config`)).payload.vacation, undefined, "store B is unaffected");

  // Browsing and the cart stay fully open while on vacation.
  const browseOnVacation = await request(`/store/${storeA.slug}/products`);
  assert.equal(browseOnVacation.status, 200);
  assert.ok(browseOnVacation.payload.products.some((product) => product.id === shirtId), "the catalog still lists products on vacation");
  assert.equal((await request(`/store/${storeA.slug}/products/${shirtId}`)).status, 200, "the product page still opens on vacation");
  assert.equal((await request(`/store/${storeA.slug}/categories`)).status, 200);
  const cartOnVacation = await request(`/store/${storeA.slug}/cart/items`, { method: "POST", token: shopper.token, body: { variantId: shirtDefaultVariant.id, quantity: 1 } });
  assert.equal(cartOnVacation.status, 200, "adding to the cart still works on vacation");

  const ordersBeforeVacationCheckout = await prisma.storeOrder.count({ where: { storeId: storeA.id } });
  const checkoutRequestsBefore = await prisma.checkoutRequest.count({ where: { storeId: storeA.id } });
  checkoutKeySuffix += 1;
  const refusedCheckout = await request(`/store/${storeA.slug}/checkout`, {
    method: "POST", token: shopper.token,
    headers: { "idempotency-key": `md1-idempotency-key-${String(checkoutKeySuffix).padStart(4, "0")}` },
    body: { cartVersion: cartOnVacation.payload.cart.version, addressId: shopper.addressId, paymentMethodCode: "cod" },
  });
  assert.equal(refusedCheckout.status, 422, JSON.stringify(refusedCheckout.payload));
  assert.equal(refusedCheckout.payload.error.code, "STORE_ON_VACATION");
  assert.equal(await prisma.storeOrder.count({ where: { storeId: storeA.id } }), ordersBeforeVacationCheckout, "no order is created while on vacation");
  assert.equal(await prisma.checkoutRequest.count({ where: { storeId: storeA.id } }), checkoutRequestsBefore, "not even a checkout_request row is written");

  // Store B checks out normally while store A is on vacation.
  const bStillOpen = await placeOrder(storeB.slug, bShopper, bProduct.variants[0].id, 1);
  assert.equal(bStillOpen.status, 201, "another store is unaffected by store A's vacation");

  const vacationOff = await request(vacationPath, { method: "PUT", token: tokenA, body: { status: "active" } });
  assert.equal(vacationOff.status, 200);
  assert.equal(vacationOff.payload.status, "active");
  assert.equal(vacationOff.payload.message, "نعود في الخامس من أيلول.", "the message is kept for the next time");
  assert.equal((await request(`/store/${storeA.slug}/public-config`)).payload.vacation, undefined, "turning it off removes the banner again");
  checkoutKeySuffix += 1;
  const restoredCheckout = await request(`/store/${storeA.slug}/checkout`, {
    method: "POST", token: shopper.token,
    headers: { "idempotency-key": `md1-idempotency-key-${String(checkoutKeySuffix).padStart(4, "0")}` },
    body: { cartVersion: cartOnVacation.payload.cart.version, addressId: shopper.addressId, paymentMethodCode: "cod" },
  });
  assert.equal(restoredCheckout.status, 201, JSON.stringify(restoredCheckout.payload));
  assert.equal(await prisma.storeOrder.count({ where: { storeId: storeA.id } }), ordersBeforeVacationCheckout + 1, "checkout works again after the vacation ends");

  const vacationBoundary = await request(vacationPath, { method: "PUT", token: tokenB, body: { status: "paused" } });
  assert.equal(vacationBoundary.status, 403, "the settings.manage boundary holds on the status endpoint");
  const longMessage = await request(vacationPath, { method: "PUT", token: tokenA, body: { status: "active", message: "ر".repeat(501) } });
  assert.equal(longMessage.status, 422);
  assert.equal(longMessage.payload.error.code, "INVALID_STORE_STATUS");
  assert.equal((await prisma.store.findUniqueOrThrow({ where: { id: storeA.id } })).vacationMode, false, "the refused writes left the store open");

  summary.vacation = { defaultOff: true, checkoutRefused: "STORE_ON_VACATION", browsingOpen: true, ordersWritten: 0, otherStoreUnaffected: true, restored: 201, boundary: 403 };


  // ============================================================
  // 6. MD-2 «الطباعة بنقرة» — بوليصة، فاتورة، قائمة تجهيز
  //
  // The load-bearing property is NOT the layout — it is that a print run never
  // silently omits an order. A merchant who selects ten and gets nine labels
  // ships nine parcels believing he shipped ten, and nothing on the paper tells
  // him otherwise. So a foreign id is a refusal, never a shorter sheet.
  // ============================================================
  const printPath = (ids, slug = storeA.slug) => `/merchant/stores/${slug}/orders/print/sheet?ids=${encodeURIComponent(ids.join(","))}`;
  const orderTwoId = orderTwo.payload.order.id;

  const sheet = await request(printPath([orderOneId, orderTwoId]), { token: tokenA });
  assert.equal(sheet.status, 200, JSON.stringify(sheet.payload));
  assert.deepEqual(sheet.payload.orders.map((order) => order.id), [orderOneId, orderTwoId], "MD-2: the paper comes out in the sequence the merchant selected");
  assert.equal(sheet.payload.store.name, storeA.name);
  // P27-12 made the merchant's phone mandatory precisely so a label can carry a
  // number a courier can call; this is where that requirement pays off.
  assert.ok(sheet.payload.store.contactPhone, "MD-2: the label carries a number the courier can call");

  // Every figure on the invoice comes from the order, not from the sheet's own
  // arithmetic: a print total that disagrees with the order total is a dispute
  // on a doorstep.
  const printedOne = sheet.payload.orders.find((order) => order.id === orderOneId);
  const storedOne = await prisma.storeOrder.findUniqueOrThrow({ where: { id: orderOneId }, include: { items: true } });
  assert.equal(printedOne.totalIqd, storedOne.totalIqd, "MD-2: the amount to collect is the order's own total");
  assert.equal(printedOne.items.length, storedOne.items.length);
  assert.equal(printedOne.items.reduce((sum, item) => sum + item.lineTotalIqd, 0), storedOne.items.reduce((sum, item) => sum + item.lineTotalIqd, 0));

  // The picking list is the reason batching exists: one line per article across
  // the whole selection, totalling exactly the units in it.
  const expectedUnits = sheet.payload.orders.reduce((sum, order) => sum + order.items.reduce((count, item) => count + item.quantity, 0), 0);
  assert.equal(sheet.payload.totals.units, expectedUnits, "MD-2: the picking list totals every unit in the run");
  assert.equal(sheet.payload.picking.reduce((sum, line) => sum + line.quantity, 0), expectedUnits, "MD-2: aggregating by article loses nothing");
  assert.equal(new Set(sheet.payload.picking.map((line) => line.key)).size, sheet.payload.picking.length, "MD-2: one line per article, not one per order");
  assert.equal(sheet.payload.totals.collectIqd, sheet.payload.orders.reduce((sum, order) => sum + order.totalIqd, 0));

  // D-33 / PG-5: a note stored and never printed is a note the courier never
  // reads. This is the only surface where "اتصل قبل الوصول" can actually change what happens.
  await prisma.storeOrder.update({ where: { id: orderOneId }, data: { customerNote: "اتصل قبل الوصول" } });
  const withNote = await request(printPath([orderOneId]), { token: tokenA });
  assert.equal(withNote.payload.orders[0].customerNote, "اتصل قبل الوصول", "MD-2: the customer's note reaches the paper");
  assert.ok(printSource.includes("customerNote"), "MD-2: …and the template actually renders it");

  // A foreign order is a REFUSAL. This is the assertion that protects the
  // merchant from a short sheet he cannot detect.
  const foreign = await request(printPath([orderOneId, orderBStore.payload.order.id]), { token: tokenA });
  assert.equal(foreign.status, 404, JSON.stringify(foreign.payload));
  assert.equal(foreign.payload.error.code, "RESOURCE_NOT_FOUND");
  assert.match(foreign.payload.error.message, /1 of 2/, "MD-2: the refusal says how many were missing rather than printing the rest");

  // …and the same holds in the other direction: store B cannot print A's order.
  assert.equal((await request(printPath([orderOneId], storeB.slug), { token: tokenB })).status, 404, "MD-2: an order is printable only from its own store");
  assert.equal((await request(printPath([orderOneId]), { token: tokenB })).status, 403, "MD-2: a foreign merchant token cannot reach this store's printer");

  // Selecting the same order twice is a slip of the hand: one label is meant.
  const deduped = await request(printPath([orderOneId, orderOneId]), { token: tokenA });
  assert.equal(deduped.status, 200, JSON.stringify(deduped.payload));
  assert.equal(deduped.payload.orders.length, 1, "MD-2: a duplicated selection prints one label, not two");

  const empty = await request(printPath([]), { token: tokenA });
  assert.equal(empty.status, 400, JSON.stringify(empty.payload));
  assert.equal(empty.payload.error.code, "INVALID_PRINT_SELECTION");
  const oversized = await request(printPath(Array.from({ length: 51 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`)), { token: tokenA });
  assert.equal(oversized.status, 400, JSON.stringify(oversized.payload));
  assert.equal(oversized.payload.error.code, "PRINT_BATCH_TOO_LARGE");

  // Printing is READING, gated on `orders.view` and nothing stronger: the person
  // who packs the parcels is usually not the person allowed to change an order.
  // At this point in the suite the staff member holds orders.view (only
  // orders.update is denied), so he must be able to print --
  const packer = await request(printPath([orderOneId]), { token: tokenStaff });
  assert.equal(packer.status, 200, `MD-2: a packer who may READ orders may print them - ${JSON.stringify(packer.payload)}`);
  // -- and the moment that read right is withdrawn, so is the paper.
  await setOverrides([{ permissionCode: "orders.view", effect: "deny" }]);
  const staffPrint = await request(printPath([orderOneId]), { token: tokenStaff });
  assert.equal(staffPrint.status, 403, "MD-2: the printer is gated on orders.view like every other order read");
  await setOverrides([{ permissionCode: "orders.update", effect: "deny" }]);
  assert.equal((await request(printPath([orderOneId]))).status, 401, "MD-2: no session, no paper");

  summary.print = {
    ordersInSheet: sheet.payload.orders.length,
    pickingLines: sheet.payload.picking.length,
    units: sheet.payload.totals.units,
    foreignOrderRefused: "404 RESOURCE_NOT_FOUND",
    duplicateCollapsed: true,
    packerWithOrdersView: 200,
    staffWithoutOrdersView: 403,
  };


  // ============================================================
  // 7. MD-7 «شهرك في CODIQ» — one month, framed against the month before it.
  //
  // Two things can go wrong here and both are silent. A month boundary that is
  // off by a millisecond counts one order in two months, so the merchant's own
  // report disagrees with itself across a year. And a comparison against an
  // empty month invites a fabricated «+100٪» — a number the data does not hold,
  // printed on a page he may show to a supplier.
  // ============================================================
  const reportPath = (month) => `/merchant/stores/${storeA.slug}/reports/monthly${month ? `?month=${month}` : ""}`;

  // Two orders placed in a known month, and one in the month before, written
  // straight to the database so the boundary is not a guess.
  // The month is BAGHDAD's (UTC+3): July begins at 2026-06-30T21:00Z. On a UTC
  // calendar an order at 01:00 on 1 July in Baghdad was counted in June.
  const lastMonth = new Date(Date.UTC(2026, 5, 15));  // 2026-06-15
  const thisMonthStart = new Date(Date.UTC(2026, 5, 30, 21, 0, 0, 0)); // 2026-07-01 00:00:00.000 Baghdad
  const thisMonthEnd = new Date(Date.UTC(2026, 6, 31, 20, 59, 59, 999)); // 2026-07-31 23:59:59.999 Baghdad
  const nextMonthStart = new Date(Date.UTC(2026, 6, 31, 21, 0, 0, 0)); // 2026-08-01 00:00:00.000 Baghdad
  let md7Counter = 0;
  const md7Order = async (createdAt, totalIqd) => {
    md7Counter += 1;
    return prisma.storeOrder.create({
      data: {
        storeId: storeA.id, orderNumber: `MD7-${String(md7Counter).padStart(4, "0")}`, status: "completed", createdAt,
        customerName: "زبون التقرير", customerEmail: `md7.${md7Counter}@codiq.test`, recipientPhone: "+9647100000001",
        shippingGovernorate: "بغداد", shippingAddressLine1: "شارع التقرير",
        subtotalIqd: totalIqd, deliveryFeeIqd: 0, totalIqd,
      },
    });
  };
  await md7Order(lastMonth, 10_000);
  // The exact first and last instants of July, and the first instant of August.
  await md7Order(thisMonthStart, 20_000);
  await md7Order(thisMonthEnd, 30_000);
  await md7Order(nextMonthStart, 90_000);

  const july = await request(reportPath("2026-07"), { token: tokenA });
  assert.equal(july.status, 200, JSON.stringify(july.payload));
  const julyReport = july.payload.report;
  assert.equal(julyReport.month.key, "2026-07");
  assert.equal(julyReport.previous.key, "2026-06", "the comparison month is the one before, not «30 days ago»");
  // The boundary assertion: both edge orders are IN, and August's is OUT.
  assert.equal(julyReport.bestDay.orders, 1);
  const julyDayTotals = await prisma.storeOrder.aggregate({
    where: { storeId: storeA.id, orderNumber: { startsWith: "MD7-" }, createdAt: { gte: thisMonthStart, lte: thisMonthEnd } },
    _count: { _all: true }, _sum: { totalIqd: true },
  });
  assert.equal(julyDayTotals._count._all, 2, "MD-7: the first and last instants of the month both belong to it");
  assert.equal(julyDayTotals._sum.totalIqd, 50_000, "MD-7: …and August's order is not among them");
  // The headline reads the same Baghdad month: both July orders, not August's.
  assert.equal(julyReport.headline.revenueIqd.value >= 0, true);
  assert.equal(julyReport.month.from, thisMonthStart.toISOString(), "MD-7: July starts at Baghdad midnight, 21:00 UTC the day before");
  assert.equal(julyReport.bestDay.date.slice(0, 7), "2026-07", "MD-7: the best day is a Baghdad date inside the month — the 1 July order is not dated 30 June");

  // A month with no predecessor states no ratio rather than inventing one.
  const june = (await request(reportPath("2026-06"), { token: tokenA })).payload.report;
  assert.equal(june.headline.completedOrders.previous, 0, "May holds nothing for this store");
  assert.equal(june.headline.completedOrders.changePercent, null, "MD-7: growth from zero has no percentage — the page says the figure, not a fabricated +100٪");
  assert.ok(!june.achievements.some((item) => item.code === "revenue_up"), "MD-7: …and no growth is celebrated on the strength of it");

  // A month with nothing in it says so, and claims no achievements.
  const emptyMonth = (await request(reportPath("2026-01"), { token: tokenA })).payload.report;
  assert.equal(emptyMonth.empty, true, "MD-7: an empty month is reported as empty");
  assert.deepEqual(emptyMonth.achievements, [], "MD-7: nothing to congratulate means nothing is congratulated");
  assert.equal(emptyMonth.bestDay, null);
  assert.deepEqual(emptyMonth.topProducts, []);

  // Every achievement must be a fact in the same payload — this is the guard
  // against a warm sentence that the figures do not support.
  for (const item of julyReport.achievements) {
    if (item.code === "new_customers") assert.ok(julyReport.headline.newCustomers.value > 0, "MD-7: a claim about new customers requires new customers");
    if (item.code === "revenue_up") assert.ok(julyReport.headline.revenueIqd.value > julyReport.headline.revenueIqd.previous, "MD-7: a claim of growth requires growth");
    if (item.code === "best_day") assert.ok(julyReport.bestDay && julyReport.bestDay.orders > 1, "MD-7: a best day is only named when there was one");
  }

  // A malformed month is refused rather than silently answered for today.
  assert.equal((await request(reportPath("2026-13"), { token: tokenA })).payload.error.code, "INVALID_MONTH");
  assert.equal((await request(reportPath("july"), { token: tokenA })).payload.error.code, "INVALID_MONTH");
  assert.equal((await request(reportPath("2026-07"), { token: tokenB })).status, 403, "MD-7: another merchant cannot read this store's month");
  assert.equal((await request(reportPath("2026-07"))).status, 401);

  summary.monthlyReport = {
    month: julyReport.month.key,
    previous: julyReport.previous.key,
    boundaryOrders: julyDayTotals._count._all,
    boundaryRevenue: julyDayTotals._sum.totalIqd,
    growthFromZero: june.headline.completedOrders.changePercent,
    emptyMonthAchievements: emptyMonth.achievements.length,
  };

  // A good month for a large shop passes 2.1 billion dinars. SUM(int) is bigint
  // in Postgres, and the series and best-sellers used to cast it back to int —
  // «integer out of range», a 500, on exactly the month worth looking at.
  const bigMonthStart = new Date(Date.UTC(2027, 0, 10, 12));
  await md7Order(bigMonthStart, 1_500_000_000);
  await md7Order(new Date(bigMonthStart.valueOf() + 60_000), 1_500_000_000);
  const bigSeries = await request(`/merchant/stores/${storeA.slug}/marketing/analytics/sales-series?from=2027-01-01T00:00:00Z&to=2027-02-01T00:00:00Z&interval=month`, { token: tokenA });
  assert.equal(bigSeries.status, 200, `a month past the int range still answers · ${JSON.stringify(bigSeries.payload)}`);
  assert.equal(bigSeries.payload.series.reduce((sum, bucket) => sum + bucket.totalIqd, 0), 3_000_000_000, "…with the exact total");
  summary.bigMonthTotal = 3_000_000_000;

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await sql.end();
  await prisma.$disconnect();
}
