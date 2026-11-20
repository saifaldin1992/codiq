/**
 * codiq phase 16 acceptance — plans, subscriptions, and server-enforced
 * entitlements. Gate coverage per the official plan:
 * every limit is tested at its exact boundary through the real API (bypassing
 * the UI), an upgrade lifts the limit immediately, the free MONTH (ق-128) is
 * auto-assigned on both merchant-creation paths, owner plan management works,
 * and a merchant without an active subscription is refused outright.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { createServer } from "node:http";
import { createTypedSession } from "../src/auth/identity.js";
import { prisma } from "../src/db/prisma.js";
import { createApp } from "../src/http/app.js";
import { createStoreFoundation } from "../src/services/store-bootstrap.service.js";
import { assertSafeTestDatabaseUrl } from "./helpers/test-database-guard.js";
import { activePlanForMerchant } from "../src/services/entitlement.service.js";

const port = 3161;
const base = `http://127.0.0.1:${port}`;

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const raw = await response.text();
  let body: any = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  return { status: response.status, body };
}

function bearer(accessToken: string) { return { authorization: `Bearer ${accessToken}` }; }

const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
if (process.env.DATABASE_URL !== testDatabaseUrl || process.env.CODIQ_POSTGRES_URL !== testDatabaseUrl) {
  throw new Error("Refusing TRUNCATE: runtime database variables must both equal CODIQ_TEST_DATABASE_URL.");
}

// Plans and plan_features are seeded by the migration and intentionally survive.
await prisma.$executeRawUnsafe("TRUNCATE TABLE notification_outbox, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, platform_owner_sessions, platform_owners, storefront_rate_limits CASCADE");
await prisma.merchantSubscription.deleteMany({ where: { plan: { code: "micro-test" } } });
await prisma.plan.deleteMany({ where: { code: "micro-test" } });

const server = createServer(createApp());
await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

const summary: Record<string, unknown> = { phase: 16 };

try {
  // ---------- default plan auto-assignment on both creation paths ----------
  const ownerRegister = await request("/auth/platform/register", { method: "POST", body: JSON.stringify({ email: "owner.phase16@codiq.test", password: "owner-phase16-password", displayName: "مالك المرحلة 16" }) });
  assert.equal(ownerRegister.status, 201);
  const ownerLogin = await request("/auth/platform/login", { method: "POST", body: JSON.stringify({ email: "owner.phase16@codiq.test", password: "owner-phase16-password" }) });
  const tokenOwner: string = ownerLogin.body.accessToken;

  const selfRegister = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100539801", email: "merchant.self.phase16@codiq.test", password: "merchant-phase16-pass", businessName: "تاجر التسجيل الذاتي" });
  assert.equal(selfRegister.status, 201);
  const selfMerchantId: string = selfRegister.body.account.id;
  const selfSubscription = await prisma.merchantSubscription.findFirst({ where: { merchantId: selfMerchantId, status: "active" }, select: { endsAt: true, plan: { select: { code: true } } } });
  assert.equal(selfSubscription?.plan.code, "growth", "ق-128: self-registration grants the free MONTH (growth), not the free plan");
  assert.ok(selfSubscription?.endsAt, "ق-128: …and it ends — a trial with no end date is just a plan");

  const provisioned = await request("/platform/merchants/manual", { method: "POST", headers: bearer(tokenOwner), body: JSON.stringify({ ownerName: "صاحب المتجر", phone: "+9647100539802", email: "merchant.manual.phase16@codiq.test", temporaryPassword: "manual-phase16-pass", businessName: "تاجر الإضافة اليدوية", firstStoreName: "متجر المرحلة 16" }) });
  assert.equal(provisioned.status, 201);
  const merchantId: string = provisioned.body.merchant.id;
  const firstStoreSlug: string = provisioned.body.store.slug;
  // ق-218: a hand-provisioned merchant is refused every merchant surface until he
  // replaces the password the provisioner typed — proven end to end in
  // `phase6:test` and through the UI in `phase6:browser`. This suite is about
  // PLAN LIMITS, so it starts where that merchant starts after his first login.
  await prisma.merchant.update({ where: { id: merchantId }, data: { passwordSetByProvisionerAt: null } });
  const manualSubscription = await prisma.merchantSubscription.findFirst({ where: { merchantId, status: "active" }, select: { plan: { select: { code: true } } } });
  assert.equal(manualSubscription?.plan.code, "growth", "ق-128: manual provisioning grants the same free month — one code path, both doors");
  summary.defaultPlan = { selfRegistration: "free", manualProvisioning: "free" };

  // ---------- owner plan management ----------
  const plansList = await request("/platform/plans", { headers: bearer(tokenOwner) });
  assert.equal(plansList.status, 200);
  assert.deepEqual(plansList.body.plans.map((plan: any) => plan.code), ["free", "growth", "pro"]);
  const growth = plansList.body.plans.find((plan: any) => plan.code === "growth");
  const priceUpdate = await request(`/platform/plans/${growth.id}`, { method: "PATCH", headers: bearer(tokenOwner), body: JSON.stringify({ monthlyPriceIqd: 30000, limits: { max_stores: 6 } }) });
  assert.equal(priceUpdate.status, 200);
  assert.equal(priceUpdate.body.plan.monthlyPriceIqd, 30000);
  assert.equal(priceUpdate.body.plan.limits.max_stores, 6);
  const badLimit = await request(`/platform/plans/${growth.id}`, { method: "PATCH", headers: bearer(tokenOwner), body: JSON.stringify({ limits: { unknown_feature: 5 } }) });
  assert.equal(badLimit.status, 422);
  summary.planManagement = { list: 3, priceUpdated: 30000, storesLimitUpdated: 6, unknownFeatureRejected: 422 };

  // ---------- boundary testing plan (all limits = 1) ----------
  const microPlan = await prisma.plan.create({ data: { code: "micro-test", name: "خطة الحدود الدنيا", monthlyPriceIqd: 0, sortOrder: 99, features: { createMany: { data: [
    { featureCode: "max_stores", limitValue: 1 },
    { featureCode: "max_products", limitValue: 1 },
    { featureCode: "max_staff", limitValue: 1 },
    { featureCode: "max_monthly_orders", limitValue: 1 },
    // ق-238: صفرٌ لا واحد. صار الرفع يُصيَّر قبل أن يُسأل العدّاد — فما يُحاسَب
    // عليه هو البايتات المخزَّنة، وصورةُ اختبارٍ حقيقيّة تُصيَّر إلى كيلوبايتات
    // لا تبلغ ميغابايتاً. وخطّةٌ لا تمنح مساحةَ صورٍ أصلاً تُثبت الحدّ نفسه
    // بحتميّةٍ كاملة، وبصورةٍ يستطيع تاجرٌ حقيقيّ رفعها.
    { featureCode: "max_image_storage_mb", limitValue: 0 },
  ] } } } });

  async function assignPlan(planCode: string) {
    const result = await request(`/platform/merchants/${merchantId}/subscription`, { method: "PUT", headers: bearer(tokenOwner), body: JSON.stringify({ planCode }) });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  }

  const tokenMerchant = await createTypedSession("merchant", merchantId, provisioned.body.store.id);

  // max_stores: at limit 1 the second store is refused; upgrade lifts immediately.
  await assignPlan("micro-test");
  const storeDenied = await request("/merchant/stores", { method: "POST", headers: bearer(tokenMerchant), body: JSON.stringify({ name: "متجر ثانٍ", slug: "phase16-second-store" }) });
  assert.equal(storeDenied.status, 403, JSON.stringify(storeDenied.body));
  assert.equal(storeDenied.body.error.code, "PLAN_LIMIT_EXCEEDED");
  await assignPlan("growth");
  const storeAllowed = await request("/merchant/stores", { method: "POST", headers: bearer(tokenMerchant), body: JSON.stringify({ name: "متجر ثانٍ", slug: "phase16-second-store" }) });
  assert.equal(storeAllowed.status, 201, JSON.stringify(storeAllowed.body));

  // max_products: product #1 under growth, then micro refuses #2, growth allows it.
  const catalogBase = `/merchant/stores/${firstStoreSlug}/catalog`;
  const productOne = await request(`${catalogBase}/products`, { method: "POST", headers: bearer(tokenMerchant), body: JSON.stringify({ sku: "P16-ONE", name: "منتج 16-1", priceIqd: 1000, stockQuantity: 10 }) });
  assert.equal(productOne.status, 201);
  await assignPlan("micro-test");
  const productDenied = await request(`${catalogBase}/products`, { method: "POST", headers: bearer(tokenMerchant), body: JSON.stringify({ sku: "P16-TWO", name: "منتج 16-2", priceIqd: 1000 }) });
  assert.equal(productDenied.status, 403);
  assert.equal(productDenied.body.error.code, "PLAN_LIMIT_EXCEEDED");
  await assignPlan("growth");
  const productAllowed = await request(`${catalogBase}/products`, { method: "POST", headers: bearer(tokenMerchant), body: JSON.stringify({ sku: "P16-TWO", name: "منتج 16-2", priceIqd: 1000 }) });
  assert.equal(productAllowed.status, 201);

  // max_staff: member #1 under growth, micro refuses #2, growth allows.
  const teamBase = `/merchant/stores/${firstStoreSlug}/team`;
  const staffOne = await request(teamBase, { method: "POST", headers: bearer(tokenMerchant), body: JSON.stringify({ email: "staff.one.phase16@codiq.test", displayName: "موظفة 16-1", temporaryPassword: "phase16-staff-pass-1", roleCode: "store_staff" }) });
  assert.equal(staffOne.status, 201, JSON.stringify(staffOne.body));
  await assignPlan("micro-test");
  const staffDenied = await request(teamBase, { method: "POST", headers: bearer(tokenMerchant), body: JSON.stringify({ email: "staff.two.phase16@codiq.test", displayName: "موظفة 16-2", temporaryPassword: "phase16-staff-pass-2", roleCode: "store_staff" }) });
  assert.equal(staffDenied.status, 403);
  assert.equal(staffDenied.body.error.code, "PLAN_LIMIT_EXCEEDED");
  await assignPlan("growth");
  const staffAllowed = await request(teamBase, { method: "POST", headers: bearer(tokenMerchant), body: JSON.stringify({ email: "staff.two.phase16@codiq.test", displayName: "موظفة 16-2", temporaryPassword: "phase16-staff-pass-2", roleCode: "store_staff" }) });
  assert.equal(staffAllowed.status, 201);

  // max_monthly_orders: first checkout allowed at limit 1, the second refused, upgrade lifts.
  await prisma.deliveryRate.update({ where: { storeId_governorate: { storeId: provisioned.body.store.id, governorate: "Baghdad" } }, data: { amountIqd: 2000, isEnabled: true } });
  async function checkoutOnce(tag: string) {
    const register = await request(`/store/${firstStoreSlug}/account/register`, { method: "POST", body: JSON.stringify({ phone: `+96477016${tag}`, password: "Phase16CustomerPass!", fullName: `زبون ${tag}` }) });
    assert.equal(register.status, 201, JSON.stringify(register.body));
    const token: string = register.body.accessToken;
    const item = await request(`/store/${firstStoreSlug}/cart/items`, { method: "POST", headers: bearer(token), body: JSON.stringify({ productId: productOne.body.product.id, quantity: 1 }) });
    assert.equal(item.status, 200);
    const address = await request(`/store/${firstStoreSlug}/account/addresses`, { method: "POST", headers: bearer(token), body: JSON.stringify({ recipientName: `زبون ${tag}`, fullAddress: "شارع 16", city: "Baghdad", governorate: "Baghdad", phoneContact: `+96477016${tag}`, isDefault: true }) });
    assert.equal(address.status, 201);
    return request(`/store/${firstStoreSlug}/checkout`, { method: "POST", headers: { ...bearer(token), "idempotency-key": `phase16-checkout-${tag}` }, body: JSON.stringify({ cartVersion: item.body.cart.version, addressId: address.body.address.id, paymentMethodCode: "cod" }) });
  }
  await assignPlan("micro-test");
  const firstOrder = await checkoutOnce("0001");
  assert.equal(firstOrder.status, 201, JSON.stringify(firstOrder.body));
  const secondOrder = await checkoutOnce("0002");
  // ق-216 — THE SHOPPER IS NOT HANDED THE MERCHANT'S INVOICE.
  //
  // The refusal used to reach the checkout screen as 403 PLAN_LIMIT_EXCEEDED
  // with the merchant's own sentence: a stranger was told to upgrade a
  // subscription he does not have, and given no way forward. It fires on the
  // 201st order of a good month — the first merchant who succeeds, and the one
  // the platform can least afford to lose. The ceiling still holds; only the
  // audience of the sentence changed.
  assert.equal(secondOrder.status, 409, JSON.stringify(secondOrder.body));
  assert.equal(secondOrder.body.error.code, "STORE_NOT_ACCEPTING_ORDERS");
  assert.match(secondOrder.body.error.message, /تواصل مع المتجر/, "the shopper is told what he can actually do");
  assert.ok(!/اشتراك|خطة|ترقية/.test(secondOrder.body.error.message), "…and never a word about a subscription he does not have");

  // ق-243 — A REJECTED ORDER GIVES ITS SLOT BACK.
  //
  // The meter used to count every non-POS row created this month whatever its
  // fate, so the merchant's own act of refusing a fake COD order was what closed
  // his shop: one phone with a script, inside the deliberately loose per-address
  // checkout wall, filled a free shop's month in under an hour and every honest
  // shopper after that was turned away until the 1st. A rejected order carried
  // no money through the platform, and ق-135 defines the quota as exactly that.
  //
  // Asserted at the limit rather than by reading the counter: the shop was
  // closed at 1/1, the merchant rejects the one order in it, and the next
  // shopper's checkout MUST succeed. That is the thing a merchant would notice.
  const rejected = await request(`/merchant/stores/${firstStoreSlug}/orders/${firstOrder.body.order.id}/status`, {
    method: "POST",
    headers: bearer(tokenMerchant),
    body: JSON.stringify({ toStatus: "rejected", expectedVersion: firstOrder.body.order.version ?? 1 }),
  });
  assert.equal(rejected.status, 200, `the merchant refuses the junk order: ${JSON.stringify(rejected.body)}`);
  // Tags 0093/0094: each tag registers a shopper phone and an idempotency key,
  // and 0003 is already taken by the post-upgrade checkout further down.
  const afterRejection = await checkoutOnce("0093");
  assert.equal(afterRejection.status, 201, `ق-243: a rejected order no longer spends the quota — the shop reopened: ${JSON.stringify(afterRejection.body)}`);
  const stillAtLimit = await checkoutOnce("0094");
  assert.equal(stillAtLimit.status, 409, "…and the ceiling itself still holds: the freed slot was ONE slot, now spent by a real order");
  // The merchant's OWN surface still reads the true reason — the entitlement is
  // unchanged, and only the storefront's audience is different.
  const merchantSeesTheCap = await request("/merchant/stores", { method: "POST", headers: bearer(tokenMerchant), body: JSON.stringify({ name: "متجر ثالث", slug: "phase16-third-store" }) });
  assert.equal(merchantSeesTheCap.status, 403);
  assert.equal(merchantSeesTheCap.body.error.code, "PLAN_LIMIT_EXCEEDED", "ق-216: the merchant's own screens keep the entitlement's own words");
  await assignPlan("growth");
  const thirdOrder = await checkoutOnce("0003");
  assert.equal(thirdOrder.status, 201);

  // max_image_storage_mb: a REAL image against a zero allowance is refused
  // before any byte reaches storage (ق-238 — the meter is charged for what will
  // be stored, so the fixture must be something that can actually be rendered).
  await assignPlan("micro-test");
  const validPng = Buffer.from("89504e470d0a1a0a0000000d494844520000000200000002080600000072b60d240000000970485973000003e8000003e801b57b526b000000114944415408d763e0d10bfb0fc20c300600322c063d26facb460000000049454e44ae426082", "hex");
  const form = new FormData();
  form.append("images", new Blob([validPng], { type: "image/png" }), "boundary.png");
  const uploadResponse = await fetch(`${base}${catalogBase}/products/${productOne.body.product.id}/images`, { method: "POST", headers: bearer(tokenMerchant), body: form });
  const uploadBody = await uploadResponse.json();
  assert.equal(uploadResponse.status, 403, JSON.stringify(uploadBody));
  assert.equal(uploadBody.error.code, "PLAN_LIMIT_EXCEEDED");
  await assignPlan("growth");
  summary.boundaries = {
    stores: { denied: storeDenied.status, allowedAfterUpgrade: storeAllowed.status },
    products: { denied: productDenied.status, allowedAfterUpgrade: productAllowed.status },
    staff: { denied: staffDenied.status, allowedAfterUpgrade: staffAllowed.status },
    monthlyOrders: { first: firstOrder.status, secondDenied: secondOrder.status, afterUpgrade: thirdOrder.status },
    imageStorage: { deniedBeforeUpload: uploadResponse.status },
  };

  // ---------- merchant-facing entitlements view ----------
  const merchantView = await request("/merchant/subscription", { headers: bearer(tokenMerchant) });
  assert.equal(merchantView.status, 200);
  assert.equal(merchantView.body.plan.code, "growth");
  const usageByFeature = Object.fromEntries(merchantView.body.entitlements.map((row: any) => [row.feature, row]));
  assert.equal(usageByFeature.max_stores.used, 2);
  assert.equal(usageByFeature.max_products.used, 2);
  assert.equal(usageByFeature.max_staff.used, 2);
  assert.equal(usageByFeature.max_monthly_orders.used, 2);
  assert.equal(usageByFeature.max_stores.limit, 6, "the owner's earlier limit edit must be live");
  summary.merchantView = { plan: merchantView.body.plan.code, usage: { stores: 2, products: 2, staff: 2, monthlyOrders: 2 } };

  // ---------- no active subscription is refused outright ----------
  const bareMerchant = await prisma.merchant.create({ data: { email: "merchant.bare.phase16@codiq.test", passwordHash: "unused", businessName: "تاجر بلا اشتراك" } });
  await prisma.merchantSubscription.updateMany({ where: { merchantId: bareMerchant.id }, data: { status: "cancelled", endsAt: new Date() } });
  const bareStore = await createStoreFoundation({ merchantId: bareMerchant.id, name: "متجر بلا اشتراك", slug: "phase16-bare", defaultSubdomain: "phase16-bare" });
  const tokenBare = await createTypedSession("merchant", bareMerchant.id, bareStore.id);
  const bareDenied = await request("/merchant/stores", { method: "POST", headers: bearer(tokenBare), body: JSON.stringify({ name: "ممنوع", slug: "phase16-bare-two" }) });
  assert.equal(bareDenied.status, 403);
  assert.equal(bareDenied.body.error.code, "NO_ACTIVE_SUBSCRIPTION");
  summary.noSubscription = { denied: bareDenied.status, code: bareDenied.body.error.code };

  // ---------- identity boundaries on the new surfaces ----------
  const merchantOnPlans = await request("/platform/plans", { headers: bearer(tokenMerchant) });
  assert.equal(merchantOnPlans.status, 403);
  const ownerOnMerchantView = await request(`/platform/merchants/${merchantId}/subscription`, { headers: bearer(tokenOwner) });
  assert.equal(ownerOnMerchantView.status, 200);
  assert.equal(ownerOnMerchantView.body.plan.code, "growth");
  summary.identityBoundaries = { merchantOnPlans: merchantOnPlans.status, ownerReadsMerchant: ownerOnMerchantView.status };

  // ═══════════════════════════════════════════════════════════════════════
  // ق-239 — A LAPSED TRIAL IS NOT A DEAD PLATFORM.
  // ═══════════════════════════════════════════════════════════════════════
  // `activePlanForMerchant` refuses a subscription whose `endsAt` has passed, so
  // until ق-239 the only thing between a merchant and NO_ACTIVE_SUBSCRIPTION on
  // EVERY call — a dead dashboard and a dead storefront checkout — was how
  // recently `trial-expiry` had swept. Putting the periodic jobs on one
  // half-hourly tick would have widened that window from ten minutes to thirty,
  // so the answer stopped depending on the sweeper instead.
  //
  // Simulated the way it actually happens: the row is still `active`, its
  // `endsAt` is in the past, and no job has run.
  await assignPlan("growth");
  const lapsedAt = new Date(Date.now() - 60_000);
  const { count: lapsedRows } = await prisma.merchantSubscription.updateMany({
    where: { merchantId, status: "active" },
    data: { endsAt: lapsedAt },
  });
  assert.ok(lapsedRows > 0, "the fixture must actually have lapsed a row");

  const lapsedPlan = await activePlanForMerchant(prisma, merchantId);
  assert.equal(lapsedPlan.code, "free", "a lapsed trial must resolve to the free plan without waiting for a sweeper");

  // And the part that matters to a person: the dashboard still answers.
  const dashboardAfterLapse = await request(`${catalogBase}/products`, { headers: bearer(tokenMerchant) });
  assert.equal(dashboardAfterLapse.status, 200, JSON.stringify(dashboardAfterLapse.body));

  // NARROWNESS. A subscription the owner deliberately took out of `active` is
  // NOT a lapsed trial, and must keep refusing — handing it the free plan would
  // silently undo a deliberate act by the one person entitled to make it.
  await prisma.merchantSubscription.updateMany({ where: { merchantId }, data: { status: "cancelled" } });
  await assert.rejects(
    () => activePlanForMerchant(prisma, merchantId),
    (error: { status?: number; code?: string }) => error.status === 403 && error.code === "NO_ACTIVE_SUBSCRIPTION",
    "a deactivated subscription must still refuse — the fallback is for lapsed trials only",
  );
  summary.lapsedTrial = { resolvesTo: lapsedPlan.code, dashboard: dashboardAfterLapse.status, cancelledStillRefused: true };

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await prisma.merchantSubscription.deleteMany({ where: { plan: { code: "micro-test" } } });
  await prisma.plan.deleteMany({ where: { code: "micro-test" } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
}
