/**
 * codiq approved addition (2026-08-26) — plans management + upgrade requests
 * acceptance (phase16 harness style). Proves through the real HTTP API:
 *  1. the owner creates a plan and it appears immediately in the public list
 *     (with the public shape of active plans unchanged);
 *  2. archive removes it from the public list and refuses NEW subscriptions
 *     while the existing subscriber keeps working, and unarchive restores it;
 *  3. the default (free) plan cannot be archived — 409 DEFAULT_PLAN_PROTECTED
 *     on both the archive endpoint and the PATCH isActive bypass;
 *  4. the upgrade-request lifecycle: create, duplicate pending 409, same-plan
 *     422, approve assigns the plan atomically (entitlements change on the
 *     very next read), reject leaves the subscription untouched, and approving
 *     a request whose plan was archived meanwhile is refused;
 *  5. identity boundaries: merchants are locked out of every owner surface and
 *     an anonymous caller cannot file requests.
 */
import assert from "node:assert/strict";

process.env.SESSION_JWT_SECRET =
  process.env.SESSION_JWT_SECRET ?? "plans-mgmt-test-secret-only-not-for-production";
process.env.CODIQ_ALLOW_OWNER_REGISTRATION = "true";
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
  const free = await prisma.plan.findUniqueOrThrow({
    where: { code: "free" },
    select: { id: true },
  });
  await prisma.merchantSubscription.updateMany({
    where: { merchantId, status: "active" },
    data: { planId: free.id, endsAt: null },
  });
}

const { createTypedSession } = await import("../src/auth/identity.ts");

const TEST_PLAN_CODE = "plans-mgmt-new";

async function deleteTestPlans() {
  await prisma.planUpgradeRequest.deleteMany({});
  await prisma.merchantSubscription.deleteMany({ where: { plan: { code: TEST_PLAN_CODE } } });
  await prisma.plan.deleteMany({ where: { code: TEST_PLAN_CODE } });
}

await prisma.$executeRawUnsafe(
  "TRUNCATE TABLE plan_upgrade_requests, notification_outbox, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, product_variants, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, platform_owner_sessions, platform_owners, storefront_rate_limits CASCADE"
);
await deleteTestPlans();

const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const raw = await response.text();
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }
  return { status: response.status, body };
}

function bearer(accessToken) {
  return { authorization: `Bearer ${accessToken}` };
}

const summary = { task: "plans-management" };

try {
  // ---------- setup: owner + two merchants (auto-assigned to the free plan) ----------
  const ownerRegister = await request("/auth/platform/register", {
    method: "POST",
    body: JSON.stringify({
      email: "owner.plans@codiq.test",
      password: "owner-plans-password",
      displayName: "مالك إدارة الخطط",
    }),
  });
  assert.equal(ownerRegister.status, 201, JSON.stringify(ownerRegister.body));
  const ownerLogin = await request("/auth/platform/login", {
    method: "POST",
    body: JSON.stringify({ email: "owner.plans@codiq.test", password: "owner-plans-password" }),
  });
  assert.equal(ownerLogin.status, 200);
  const tokenOwner = ownerLogin.body.accessToken;

  const merchantA = await request("/platform/merchants/manual", {
    method: "POST",
    headers: bearer(tokenOwner),
    body: JSON.stringify({
      ownerName: "صاحب المتجر",
      phone: "+9647100152401",
      email: "merchant.a.plans@codiq.test",
      temporaryPassword: "plans-merchant-a-pass",
      businessName: "تاجر الخطط أ",
      firstStoreName: "متجر الخطط أ",
    }),
  });
  assert.equal(merchantA.status, 201, JSON.stringify(merchantA.body));
  const merchantB = await request("/platform/merchants/manual", {
    method: "POST",
    headers: bearer(tokenOwner),
    body: JSON.stringify({
      ownerName: "صاحب المتجر",
      phone: "+9647100152402",
      email: "merchant.b.plans@codiq.test",
      temporaryPassword: "plans-merchant-b-pass",
      businessName: "تاجر الخطط ب",
      firstStoreName: "متجر الخطط ب",
    }),
  });
  assert.equal(merchantB.status, 201, JSON.stringify(merchantB.body));
  // ق-218: both were provisioned by hand, so both are refused every merchant
  // surface until they replace the password the owner typed (proven end to end
  // in `phase6:test`). This suite is about PLAN MANAGEMENT, so it starts where
  // each merchant starts after his first login.
  await prisma.merchant.updateMany({
    where: { id: { in: [merchantA.body.merchant.id, merchantB.body.merchant.id] } },
    data: { passwordSetByProvisionerAt: null },
  });
  const tokenMerchantA = await createTypedSession(
    "merchant",
    merchantA.body.merchant.id,
    merchantA.body.store.id
  );
  const tokenMerchantB = await createTypedSession(
    "merchant",
    merchantB.body.merchant.id,
    merchantB.body.store.id
  );

  // ---------- create a plan through the API; it appears in the public list ----------
  const createBody = {
    code: TEST_PLAN_CODE,
    name: "خطة الإدارة",
    monthlyPriceIqd: 40000,
    commissionBps: 150,
    sortOrder: 90,
    limits: {
      max_stores: 4,
      max_products: 500,
      max_staff: 5,
      max_monthly_orders: 2000,
      max_image_storage_mb: 1024,
    },
  };
  const created = await request("/platform/plans", {
    method: "POST",
    headers: bearer(tokenOwner),
    body: JSON.stringify(createBody),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.plan.code, TEST_PLAN_CODE);
  assert.equal(created.body.plan.isActive, true);
  assert.equal(created.body.plan.limits.max_products, 500);
  const createdPlanId = created.body.plan.id;

  const publicWithNew = await request("/public/plans");
  assert.equal(publicWithNew.status, 200);
  const publicNewPlan = publicWithNew.body.plans.find((plan) => plan.code === TEST_PLAN_CODE);
  assert.ok(publicNewPlan, "the created plan must appear in the public pricing list");
  // The public shape of active plans is a frozen contract (phase 17 landing page).
  // `isRecommended` and `isDefault` joined it on 2026-08-27 (ق-32/ق-34): the landing
  // page must read the owner's recommendation and the real default plan from the
  // server instead of guessing either one from array position. Both are booleans
  // the owner already publishes — no secret joins the payload.
  assert.deepEqual(Object.keys(publicNewPlan).sort(), [
    "code",
    "commissionPercent",
    "isDefault",
    "isRecommended",
    "limits",
    "monthlyPriceIqd",
    "name",
  ]);
  assert.equal(publicNewPlan.commissionPercent, 1.5);
  assert.equal(publicNewPlan.monthlyPriceIqd, 40000);
  assert.equal(publicNewPlan.isRecommended, false, "a freshly created plan is never recommended");
  assert.equal(publicNewPlan.isDefault, false, "only DEFAULT_PLAN_CODE is the default plan");
  const publicFreePlan = publicWithNew.body.plans.find((plan) => plan.code === "free");
  assert.equal(
    publicFreePlan?.isDefault,
    true,
    "the free plan is the one registration really assigns"
  );

  // Only one plan may carry «توصية المنصة»: recommending a second clears the first
  // inside the same transaction, and the partial unique index backs it up.
  const recommendNew = await request(`/platform/plans/${createdPlanId}`, {
    method: "PATCH",
    headers: bearer(tokenOwner),
    body: JSON.stringify({ isRecommended: true }),
  });
  assert.equal(recommendNew.status, 200);
  assert.equal(recommendNew.body.plan.isRecommended, true);
  const freePlanForBadge = (
    await request("/platform/plans", { headers: bearer(tokenOwner) })
  ).body.plans.find((plan) => plan.code === "free");
  const recommendFree = await request(`/platform/plans/${freePlanForBadge.id}`, {
    method: "PATCH",
    headers: bearer(tokenOwner),
    body: JSON.stringify({ isRecommended: true }),
  });
  assert.equal(recommendFree.status, 200);
  const afterSwap = (await request("/public/plans")).body.plans.filter(
    (plan) => plan.isRecommended
  );
  assert.equal(afterSwap.length, 1, "exactly one plan may be recommended at a time");
  assert.equal(afterSwap[0].code, "free");
  // Clearing it leaves no recommendation at all — and therefore no badge.
  const clearFree = await request(`/platform/plans/${freePlanForBadge.id}`, {
    method: "PATCH",
    headers: bearer(tokenOwner),
    body: JSON.stringify({ isRecommended: false }),
  });
  assert.equal(clearFree.status, 200);
  assert.equal(
    (await request("/public/plans")).body.plans.filter((plan) => plan.isRecommended).length,
    0
  );

  const duplicate = await request("/platform/plans", {
    method: "POST",
    headers: bearer(tokenOwner),
    body: JSON.stringify(createBody),
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, "DUPLICATE_PLAN_CODE");
  const badCode = await request("/platform/plans", {
    method: "POST",
    headers: bearer(tokenOwner),
    body: JSON.stringify({ ...createBody, code: "Bad Code!" }),
  });
  assert.equal(badCode.status, 422);
  const badLimit = await request("/platform/plans", {
    method: "POST",
    headers: bearer(tokenOwner),
    body: JSON.stringify({
      ...createBody,
      code: "plans-mgmt-other",
      limits: { unknown_feature: 3 },
    }),
  });
  assert.equal(badLimit.status, 422);
  const merchantCreates = await request("/platform/plans", {
    method: "POST",
    headers: bearer(tokenMerchantA),
    body: JSON.stringify(createBody),
  });
  assert.equal(merchantCreates.status, 403, "a merchant session must not create plans");
  summary.createPlan = {
    created: 201,
    publicListed: true,
    duplicate: 409,
    badCode: 422,
    badLimit: 422,
    merchantDenied: 403,
  };

  // ---------- archive: public list + new assignments refuse it; existing subscriber unaffected ----------
  const assignA = await request(`/platform/merchants/${merchantA.body.merchant.id}/subscription`, {
    method: "PUT",
    headers: bearer(tokenOwner),
    body: JSON.stringify({ planCode: TEST_PLAN_CODE }),
  });
  assert.equal(assignA.status, 200, JSON.stringify(assignA.body));
  assert.equal(assignA.body.plan.code, TEST_PLAN_CODE);

  const archived = await request(`/platform/plans/${createdPlanId}/archive`, {
    method: "POST",
    headers: bearer(tokenOwner),
  });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.equal(archived.body.plan.isActive, false);
  const publicAfterArchive = await request("/public/plans");
  assert.ok(
    !publicAfterArchive.body.plans.some((plan) => plan.code === TEST_PLAN_CODE),
    "an archived plan must vanish from the public list"
  );
  const ownerListAfterArchive = await request("/platform/plans", { headers: bearer(tokenOwner) });
  assert.ok(
    ownerListAfterArchive.body.plans.some(
      (plan) => plan.code === TEST_PLAN_CODE && plan.isActive === false
    ),
    "the owner still sees the archived plan"
  );

  const assignArchived = await request(
    `/platform/merchants/${merchantB.body.merchant.id}/subscription`,
    {
      method: "PUT",
      headers: bearer(tokenOwner),
      body: JSON.stringify({ planCode: TEST_PLAN_CODE }),
    }
  );
  assert.equal(assignArchived.status, 404, "an archived plan must refuse NEW subscriptions");

  const merchantAView = await request("/merchant/subscription", {
    headers: bearer(tokenMerchantA),
  });
  assert.equal(merchantAView.status, 200);
  assert.equal(
    merchantAView.body.plan.code,
    TEST_PLAN_CODE,
    "the existing subscriber keeps the archived plan"
  );
  const merchantAWrite = await request("/merchant/stores", {
    method: "POST",
    headers: bearer(tokenMerchantA),
    body: JSON.stringify({ name: "متجر ثانٍ للخطط", slug: "plans-mgmt-second-store" }),
  });
  assert.equal(
    merchantAWrite.status,
    201,
    "entitlement-gated writes keep working for the existing subscriber"
  );

  const unarchived = await request(`/platform/plans/${createdPlanId}/unarchive`, {
    method: "POST",
    headers: bearer(tokenOwner),
  });
  assert.equal(unarchived.status, 200);
  assert.equal(unarchived.body.plan.isActive, true);
  const publicAfterUnarchive = await request("/public/plans");
  assert.ok(
    publicAfterUnarchive.body.plans.some((plan) => plan.code === TEST_PLAN_CODE),
    "unarchive restores the plan to the public list"
  );
  summary.archive = {
    archived: 200,
    publicHidden: true,
    newAssignmentDenied: 404,
    existingSubscriberKept: 200,
    gatedWriteKept: 201,
    unarchived: 200,
  };

  // ---------- the default plan is protected against archiving (both paths) ----------
  const freePlanRow = ownerListAfterArchive.body.plans.find((plan) => plan.code === "free");
  const freeArchive = await request(`/platform/plans/${freePlanRow.id}/archive`, {
    method: "POST",
    headers: bearer(tokenOwner),
  });
  assert.equal(freeArchive.status, 409);
  assert.equal(freeArchive.body.error.code, "DEFAULT_PLAN_PROTECTED");
  const freePatch = await request(`/platform/plans/${freePlanRow.id}`, {
    method: "PATCH",
    headers: bearer(tokenOwner),
    body: JSON.stringify({ isActive: false }),
  });
  assert.equal(freePatch.status, 409, "the PATCH isActive bypass must hit the same guard");
  assert.equal(freePatch.body.error.code, "DEFAULT_PLAN_PROTECTED");
  summary.defaultPlanProtected = { archive: 409, patchBypass: 409 };

  // ---------- upgrade-request lifecycle (merchant B is on the free plan) ----------
  // …and ق-128 now grants «growth» at registration, so «on the free plan» has
  // to be made true rather than assumed.
  await pinToFreePlan(merchantB.body.merchant.id);
  const anonymousRequest = await request("/merchant/subscription/upgrade-request", {
    method: "POST",
    body: JSON.stringify({ planCode: "growth" }),
  });
  assert.equal(anonymousRequest.status, 401);
  const samePlan = await request("/merchant/subscription/upgrade-request", {
    method: "POST",
    headers: bearer(tokenMerchantB),
    body: JSON.stringify({ planCode: "free" }),
  });
  assert.equal(samePlan.status, 422);
  assert.equal(samePlan.body.error.code, "SAME_PLAN_REQUESTED");
  const unknownPlan = await request("/merchant/subscription/upgrade-request", {
    method: "POST",
    headers: bearer(tokenMerchantB),
    body: JSON.stringify({ planCode: "no-such-plan" }),
  });
  assert.equal(unknownPlan.status, 404);

  const upgradeCreated = await request("/merchant/subscription/upgrade-request", {
    method: "POST",
    headers: bearer(tokenMerchantB),
    body: JSON.stringify({ planCode: "growth", note: "نحتاج حدوداً أعلى للموسم" }),
  });
  assert.equal(upgradeCreated.status, 201, JSON.stringify(upgradeCreated.body));
  assert.equal(upgradeCreated.body.request.status, "pending");
  assert.equal(upgradeCreated.body.request.requestedPlan.code, "growth");
  const upgradeId = upgradeCreated.body.request.id;
  const duplicatePending = await request("/merchant/subscription/upgrade-request", {
    method: "POST",
    headers: bearer(tokenMerchantB),
    body: JSON.stringify({ planCode: "pro" }),
  });
  assert.equal(duplicatePending.status, 409);
  assert.equal(duplicatePending.body.error.code, "DUPLICATE_UPGRADE_REQUEST");

  // Identity boundaries: merchants cannot read or decide the owner queue.
  const merchantReadsQueue = await request("/platform/upgrade-requests", {
    headers: bearer(tokenMerchantA),
  });
  assert.equal(merchantReadsQueue.status, 403);
  const merchantApproves = await request(`/platform/upgrade-requests/${upgradeId}/approve`, {
    method: "POST",
    headers: bearer(tokenMerchantA),
  });
  assert.equal(merchantApproves.status, 403, "merchant A must not approve merchant B's request");

  const queue = await request("/platform/upgrade-requests", { headers: bearer(tokenOwner) });
  assert.equal(queue.status, 200);
  assert.equal(queue.body.requests[0].id, upgradeId, "pending requests come first");
  assert.equal(queue.body.requests[0].merchant.email, "merchant.b.plans@codiq.test");

  const approved = await request(`/platform/upgrade-requests/${upgradeId}/approve`, {
    method: "POST",
    headers: bearer(tokenOwner),
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.request.status, "approved");
  assert.ok(approved.body.request.decidedAt, "approval must stamp decidedAt");
  const merchantBAfterApprove = await request("/merchant/subscription", {
    headers: bearer(tokenMerchantB),
  });
  assert.equal(
    merchantBAfterApprove.body.plan.code,
    "growth",
    "entitlements must change immediately after approval"
  );
  const reApprove = await request(`/platform/upgrade-requests/${upgradeId}/approve`, {
    method: "POST",
    headers: bearer(tokenOwner),
  });
  assert.equal(reApprove.status, 409);
  assert.equal(reApprove.body.error.code, "ALREADY_DECIDED");

  const downgrade = await request("/merchant/subscription/upgrade-request", {
    method: "POST",
    headers: bearer(tokenMerchantB),
    body: JSON.stringify({ planCode: "free" }),
  });
  assert.equal(downgrade.status, 201, "a downgrade request rides the same flow");
  const rejected = await request(`/platform/upgrade-requests/${downgrade.body.request.id}/reject`, {
    method: "POST",
    headers: bearer(tokenOwner),
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.request.status, "rejected");
  const merchantBAfterReject = await request("/merchant/subscription", {
    headers: bearer(tokenMerchantB),
  });
  assert.equal(
    merchantBAfterReject.body.plan.code,
    "growth",
    "rejection must leave the subscription untouched"
  );

  // A plan archived after the request was filed cannot be approved anymore.
  const staleRequest = await request("/merchant/subscription/upgrade-request", {
    method: "POST",
    headers: bearer(tokenMerchantB),
    body: JSON.stringify({ planCode: TEST_PLAN_CODE }),
  });
  assert.equal(staleRequest.status, 201);
  await request(`/platform/plans/${createdPlanId}/archive`, {
    method: "POST",
    headers: bearer(tokenOwner),
  });
  const approveStale = await request(
    `/platform/upgrade-requests/${staleRequest.body.request.id}/approve`,
    { method: "POST", headers: bearer(tokenOwner) }
  );
  assert.equal(approveStale.status, 409);
  assert.equal(approveStale.body.error.code, "PLAN_NOT_AVAILABLE");
  const rejectStale = await request(
    `/platform/upgrade-requests/${staleRequest.body.request.id}/reject`,
    { method: "POST", headers: bearer(tokenOwner) }
  );
  assert.equal(rejectStale.status, 200);
  summary.upgradeRequests = {
    anonymous: 401,
    samePlan: 422,
    unknownPlan: 404,
    created: 201,
    duplicatePending: 409,
    merchantReadsQueue: 403,
    merchantApproves: 403,
    approved: 200,
    entitlementsAfterApprove: "growth",
    reApprove: 409,
    rejected: 200,
    planAfterReject: "growth",
    approveArchivedPlan: 409,
  };

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await deleteTestPlans();
  await new Promise((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
}
