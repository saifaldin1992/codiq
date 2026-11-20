import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createTypedSession } from "../src/auth/identity.js";
import { prisma } from "../src/db/prisma.js";
import { createApp } from "../src/http/app.js";
import { WEB_SESSION_COOKIE } from "../src/http/session-cookie.js";
import { createStoreFoundation } from "../src/services/store-bootstrap.service.js";
import { assertSafeTestDatabaseUrl } from "./helpers/test-database-guard.js";

const port = 3123;
const base = `http://127.0.0.1:${port}`;

type ApiResult = { status: number; body: any; cookie?: string };

async function request(path: string, init: RequestInit = {}): Promise<ApiResult> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const rawBody = await response.text();
  let body: any = rawBody;
  try {
    body = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    // Pre-implementation Express 404s are HTML. Assertions below still verify the intended API contract.
  }
  return {
    status: response.status,
    body,
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
}

function bearer(accessToken: string) {
  return { authorization: `Bearer ${accessToken}` };
}

// D-63: the name is `__Host-codiq_session` wherever `Secure` is set and the bare
// name in local http development, so the test reads the app's own constant
// rather than a literal that would be right in one environment and wrong in the
// other.
function tokenFromCookie(cookie: string | undefined): string {
  assert.ok(cookie?.startsWith(`${WEB_SESSION_COOKIE}=`), `the dashboard cookie is issued as «${WEB_SESSION_COOKIE}»`);
  return decodeURIComponent(cookie!.slice(WEB_SESSION_COOKIE.length + 1));
}

const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
if (process.env.DATABASE_URL !== testDatabaseUrl || process.env.CODIQ_POSTGRES_URL !== testDatabaseUrl) {
  throw new Error("Refusing TRUNCATE: runtime database variables must both equal CODIQ_TEST_DATABASE_URL.");
}

await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits, platform_owners, merchants CASCADE");
await prisma.storefrontRateLimit.deleteMany();

const server = createServer(createApp());
await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

try {
  const merchantA = await prisma.merchant.create({
    data: { email: "merchant.a.phase13@codiq.test", passwordHash: "not-used-in-session-test", businessName: "تاجر المرحلة 13 A" },
  });
  const merchantB = await prisma.merchant.create({
    data: { email: "merchant.b.phase13@codiq.test", passwordHash: "not-used-in-session-test", businessName: "تاجر المرحلة 13 B" },
  });
  // Phase 16: store creation is plan-gated; directly-created test merchants need the free plan (3 stores).
  const freePlan = await prisma.plan.findUniqueOrThrow({ where: { code: "free" }, select: { id: true } });
  await prisma.merchantSubscription.createMany({ data: [merchantA, merchantB].map((merchant) => ({ merchantId: merchant.id, planId: freePlan.id, status: "active" })) });
  const storeA1 = await createStoreFoundation({ merchantId: merchantA.id, name: "متجر ألف أول", slug: "phase13-a-one", defaultSubdomain: "phase13-a-one" });
  const storeA2 = await createStoreFoundation({ merchantId: merchantA.id, name: "متجر ألف ثان", slug: "phase13-a-two", defaultSubdomain: "phase13-a-two" });
  const storeB1 = await createStoreFoundation({ merchantId: merchantB.id, name: "متجر باء", slug: "phase13-b-one", defaultSubdomain: "phase13-b-one" });
  const oldAToken = await createTypedSession("merchant", merchantA.id, storeA1.id);

  // S13-01: the list is bound to the authenticated merchant, not client input.
  const storeList = await request("/merchant/stores", { headers: bearer(oldAToken) });
  assert.equal(storeList.status, 200);
  assert.deepEqual(
    storeList.body.stores.map((store: { slug: string }) => store.slug).sort(),
    [storeA1.slug, storeA2.slug].sort(),
  );
  assert.ok(storeList.body.stores.every((store: { id: string; name: string; slug: string; isActive: boolean }) => typeof store.id === "string" && typeof store.name === "string" && typeof store.slug === "string" && typeof store.isActive === "boolean"));

  const unauthenticatedList = await request("/merchant/stores");
  assert.equal(unauthenticatedList.status, 401);

  // S13-02: the existing guard remains the source of truth before explicit switching.
  const oldAAgainstB = await request(`/merchant/stores/${storeA2.slug}/products`, { headers: bearer(oldAToken) });
  assert.equal(oldAAgainstB.status, 403);
  assert.equal(oldAAgainstB.body.error.code, "STORE_BOUNDARY_DENIED");

  // S13-03: switching issues a second, store-bound session and leaves the old session valid on A only.
  const switched = await request("/merchant/stores/switch", {
    method: "POST",
    headers: bearer(oldAToken),
    body: JSON.stringify({ storeSlug: storeA2.slug }),
  });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.store.slug, storeA2.slug);
  assert.ok(switched.cookie?.startsWith(`${WEB_SESSION_COOKIE}=`));
  const newBToken = tokenFromCookie(switched.cookie);
  assert.notEqual(newBToken, oldAToken);

  const newBOnB = await request(`/merchant/stores/${storeA2.slug}/products`, { headers: bearer(newBToken) });
  assert.equal(newBOnB.status, 200);
  const newBOnA = await request(`/merchant/stores/${storeA1.slug}/products`, { headers: bearer(newBToken) });
  assert.equal(newBOnA.status, 403);
  assert.equal(newBOnA.body.error.code, "STORE_BOUNDARY_DENIED");
  const oldAOnA = await request(`/merchant/stores/${storeA1.slug}/products`, { headers: bearer(oldAToken) });
  assert.equal(oldAOnA.status, 200);

  // S13-04: a foreign store is non-enumerable and cannot mint a session.
  const sessionsBeforeForeignSwitch = await prisma.merchantSession.count({ where: { merchantId: merchantA.id } });
  const foreignSwitch = await request("/merchant/stores/switch", {
    method: "POST",
    headers: bearer(oldAToken),
    body: JSON.stringify({ storeSlug: storeB1.slug }),
  });
  assert.equal(foreignSwitch.status, 404);
  assert.equal(foreignSwitch.body.error.code, "MERCHANT_STORE_CONTEXT_NOT_FOUND");
  assert.equal(await prisma.merchantSession.count({ where: { merchantId: merchantA.id } }), sessionsBeforeForeignSwitch);

  // S13-05 and S13-06: validation and uniqueness are server-authoritative.
  const invalidSlug = await request("/merchant/stores", {
    method: "POST",
    headers: bearer(oldAToken),
    body: JSON.stringify({ name: "متجر غير صالح", slug: "Invalid Slug" }),
  });
  assert.equal(invalidSlug.status, 422);
  assert.equal(invalidSlug.body.error.code, "INVALID_STORE_SLUG");

  const merchantStoresBeforeDuplicate = await prisma.store.count({ where: { merchantId: merchantA.id } });
  const duplicateSlug = await request("/merchant/stores", {
    method: "POST",
    headers: bearer(oldAToken),
    body: JSON.stringify({ name: "متجر slug مكرر", slug: storeB1.slug }),
  });
  assert.equal(duplicateSlug.status, 409);
  assert.equal(duplicateSlug.body.error.code, "DUPLICATE_STORE_SLUG");
  assert.equal(await prisma.store.count({ where: { merchantId: merchantA.id } }), merchantStoresBeforeDuplicate);

  // S13-07: store #3 is allowed and store #4 is rejected by the server.
  const createdThird = await request("/merchant/stores", {
    method: "POST",
    headers: bearer(oldAToken),
    body: JSON.stringify({ name: "متجر ألف ثالث", slug: "phase13-a-three" }),
  });
  assert.equal(createdThird.status, 201);
  assert.equal(createdThird.body.store.slug, "phase13-a-three");
  assert.equal(await prisma.store.count({ where: { merchantId: merchantA.id } }), 3);

  const overLimit = await request("/merchant/stores", {
    method: "POST",
    headers: bearer(oldAToken),
    body: JSON.stringify({ name: "متجر ألف رابع", slug: "phase13-a-four" }),
  });
  assert.equal(overLimit.status, 403);
  // Phase 16 replaced the temporary fixed cap with plan entitlements (free plan keeps 3 stores).
  assert.equal(overLimit.body.error.code, "PLAN_LIMIT_EXCEEDED");
  assert.equal(await prisma.store.count({ where: { merchantId: merchantA.id } }), 3);

  // S13-08: a foundation failure rolls the entire transaction back.
  const atomicSlug = "phase13-atomic-candidate";
  await assert.rejects(
    () => prisma.$transaction(async (transaction) => {
      await createStoreFoundation({ merchantId: merchantB.id, name: "متجر ذري مرشح", slug: atomicSlug, defaultSubdomain: storeB1.defaultSubdomain }, transaction);
    }),
  );
  assert.equal(await prisma.store.count({ where: { merchantId: merchantB.id, slug: atomicSlug } }), 0);
  assert.equal(await prisma.deliveryRate.count({ where: { store: { merchantId: merchantB.id, slug: atomicSlug } } }), 0);

  console.log(JSON.stringify({
    phase: 13,
    storeList: storeList.body.stores.map((store: { slug: string }) => store.slug),
    switch: { newStore: switched.body.store.slug, oldSessionStillScoped: oldAOnA.status, newSessionIsolated: newBOnA.status },
    foreignSwitch: { status: foreignSwitch.status, code: foreignSwitch.body.error.code },
    validation: { invalidSlug: invalidSlug.status, duplicateSlug: duplicateSlug.status, overLimit: overLimit.status },
    atomicRollback: true,
  }, null, 2));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
}
