/**
 * ق-251 (المرحلة 29-3) — the configuration hierarchy, end to end.
 *
 * WHAT IS ASSERTED:
 *   1. the owner reads the closed registry with defaults; sets a platform value;
 *      an unknown code and a wrong type are refused by name; a merchant cannot
 *   2. the merchant reads every setting with the value that applies to his store,
 *      who decided it and the chain — the platform's ceiling tightens his store's
 *      own column; his own level tightens further; loosening above the ceiling
 *      is refused (SETTING_ABOVE_CEILING); clearing his level restores the chain
 *   3. the readers ask the one function: the marketing cap the worker uses and
 *      the guest-checkout gate follow the hierarchy, and so does the shopper's
 *      public config
 *   4. allow: the platform closes guest checkout → the merchant cannot open it
 *      (SETTING_NOT_ALLOWED); the store column alone closes it too
 *   5. the plan speaks through entitlement: the merchant's plan limit shows as
 *      the plan level when the plan names one
 *   6. the customer's word: an unsubscribe row turns marketing opt-in off for him
 *      alone, source «customer»
 *   7. the platform's settings leave audit rows
 *
 * Run: pnpm config:test
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const testId = `config-${Date.now()}`;
const suffix = String(Date.now()).slice(-8);
process.env.SESSION_JWT_SECRET = "config-test-secret-only-not-for-production";
process.env.CODIQ_ALLOW_OWNER_REGISTRATION = "true";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { SETTINGS, customerPreferencesView, resolveSetting } = await import(
  "../src/services/config.service.ts"
);
const { marketingDailyCap } = await import("../src/notifications/messaging-compliance.service.ts");
const { guestCheckoutAllowed } = await import("../src/services/storefront-config.service.ts");
const { activePlanForMerchant } = await import("../src/services/entitlement.service.ts");
await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits");

const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
process.on("exit", () => {
  try {
    server.close();
  } catch {
    /* already closed */
  }
});

async function request(path, { method = "GET", body, token, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      origin: base,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { status: response.status, payload, headers: response.headers };
}

const summary = {};
// Platform values are platform-wide; a previous run on the same database may have left some. Swept at both ends.
const sweepPlatform = async (ownerToken) => {
  for (const setting of SETTINGS)
    await request(`/platform/config/${setting.code}`, {
      method: "PUT",
      token: ownerToken,
      body: { value: null },
    });
};
let ownerToken = null;
try {
  const ownerEmail = `${testId}.owner@codiq.test`;
  const ownerPassword = "OwnerPass123!Strong";
  const ownerRegister = await request("/auth/platform/register", {
    method: "POST",
    body: { email: ownerEmail, password: ownerPassword, displayName: "مالك التهيئة" },
  });
  assert.ok([200, 201].includes(ownerRegister.status), JSON.stringify(ownerRegister.payload));
  ownerToken = (
    await request("/auth/platform/login", {
      method: "POST",
      body: { email: ownerEmail, password: ownerPassword },
    })
  ).payload.accessToken;
  assert.ok(ownerToken, "the owner signs in");
  await sweepPlatform(ownerToken);

  const password = "ConfigPass123!";
  const registerA = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    businessName: "متجر التهيئة",
    phone: `+96479${suffix}`,
    email: `${testId}.a@codiq.test`,
    password,
    storeName: "متجر التهيئة",
    storeSlug: `${testId}-a`,
  });
  assert.equal(registerA.status, 201, JSON.stringify(registerA.payload));
  const merchantId = registerA.payload.account.id;
  const storeA = await prisma.store.create({
    data: {
      merchantId,
      name: "متجر التهيئة",
      slug: `${testId}-a`,
      defaultSubdomain: `${testId}-a`,
    },
    select: { id: true, slug: true, merchantId: true },
  });
  const tokenA = (
    await request("/auth/merchant/login", {
      method: "POST",
      body: { identifier: `${testId}.a@codiq.test`, password },
    })
  ).payload.accessToken;
  assert.ok(tokenA, "the merchant signs in");
  const merchantA = `/merchant/stores/${storeA.slug}`;
  const merchantConfig = async () => {
    const res = await request(`${merchantA}/config`, { token: tokenA });
    assert.equal(res.status, 200, JSON.stringify(res.payload));
    return Object.fromEntries(res.payload.settings.map((s) => [s.code, s]));
  };
  const auditCount = () =>
    prisma.platformAuditEvent.count({ where: { action: "setting_changed" } });
  const auditBefore = await auditCount();

  // ============================================================
  // 1. The owner's registry.
  // ============================================================
  const registry = await request("/platform/config", { token: ownerToken });
  assert.equal(registry.status, 200, JSON.stringify(registry.payload));
  assert.equal(
    registry.payload.settings.length,
    SETTINGS.length,
    "every registry code, nothing else"
  );
  const capRow = registry.payload.settings.find((s) => s.code === "marketing.daily_cap");
  assert.equal(capRow.platformValue, null, "no platform value yet");
  assert.equal(capRow.default, 200);
  assert.equal(capRow.rule, "cap");
  const set = await request("/platform/config/marketing.daily_cap", {
    method: "PUT",
    token: ownerToken,
    body: { value: 100 },
  });
  assert.equal(set.status, 200, JSON.stringify(set.payload));
  assert.equal(set.payload.setting.platformValue, 100);
  assert.equal(
    (
      await request("/platform/config/config.free_key", {
        method: "PUT",
        token: ownerToken,
        body: { value: 1 },
      })
    ).payload.error?.code,
    "UNKNOWN_SETTING",
    "no free key/value"
  );
  assert.equal(
    (
      await request("/platform/config/marketing.daily_cap", {
        method: "PUT",
        token: ownerToken,
        body: { value: "many" },
      })
    ).payload.error?.code,
    "INVALID_SETTING_VALUE"
  );
  assert.equal(
    (
      await request("/platform/config/checkout.guest_allowed", {
        method: "PUT",
        token: ownerToken,
        body: { value: 1 },
      })
    ).payload.error?.code,
    "INVALID_SETTING_VALUE",
    "a boolean setting refuses a number"
  );
  assert.equal(
    (await request("/platform/config", { token: tokenA })).status,
    403,
    "a merchant cannot read the platform's level"
  );
  assert.equal(
    (
      await request("/platform/config/marketing.daily_cap", {
        method: "PUT",
        token: tokenA,
        body: { value: 5 },
      })
    ).status,
    403
  );
  summary.registry = {
    codes: registry.payload.settings.length,
    refusals: ["UNKNOWN_SETTING", "INVALID_SETTING_VALUE", 403],
  };

  // ============================================================
  // 2. The merchant reads the chain; his level tightens, never loosens.
  // ============================================================
  let view = await merchantConfig();
  assert.equal(
    view["marketing.daily_cap"].value,
    100,
    "the platform's ceiling applies to his store"
  );
  assert.equal(view["marketing.daily_cap"].source, "platform");
  assert.equal(view["marketing.daily_cap"].canOverride, true);
  assert.equal(
    view["stores.max"].canOverride,
    false,
    "a plan-governed cap is not the merchant's to touch"
  );
  assert.equal(
    (
      await request(`${merchantA}/config/marketing.daily_cap`, {
        method: "PUT",
        token: tokenA,
        body: { value: 150 },
      })
    ).payload.error?.code,
    "SETTING_ABOVE_CEILING",
    "he cannot loosen the platform's ceiling"
  );
  const tighten = await request(`${merchantA}/config/marketing.daily_cap`, {
    method: "PUT",
    token: tokenA,
    body: { value: 40 },
  });
  assert.equal(tighten.status, 200, JSON.stringify(tighten.payload));
  assert.equal(tighten.payload.setting.value, 40);
  assert.equal(tighten.payload.setting.source, "merchant");
  view = await merchantConfig();
  assert.equal(view["marketing.daily_cap"].merchantValue, 40);
  assert.deepEqual(
    view["marketing.daily_cap"].chain.map((entry) => [entry.level, entry.value]),
    [
      ["platform", 100],
      ["merchant", 40],
    ],
    "the chain names each level's word"
  );
  assert.equal(
    (
      await request(`${merchantA}/config/stores.max`, {
        method: "PUT",
        token: tokenA,
        body: { value: 1 },
      })
    ).payload.error?.code,
    "SETTING_LEVEL_NOT_ALLOWED"
  );
  assert.equal(
    (
      await request(`${merchantA}/config/nope.setting`, {
        method: "PUT",
        token: tokenA,
        body: { value: 1 },
      })
    ).payload.error?.code,
    "UNKNOWN_SETTING"
  );
  summary.merchantLevel = { aboveCeiling: "SETTING_ABOVE_CEILING", tightened: 40 };

  // ============================================================
  // 3. The readers ask the one function.
  // ============================================================
  assert.equal(
    await marketingDailyCap(storeA.id),
    40,
    "the worker's cap is the hierarchy's answer"
  );
  await prisma.notificationSettings.upsert({
    where: { storeId: storeA.id },
    create: { storeId: storeA.id, marketingDailyCap: 25 },
    update: { marketingDailyCap: 25 },
  });
  assert.equal(await marketingDailyCap(storeA.id), 25, "the store's own column tightens further");
  await prisma.notificationSettings.update({
    where: { storeId: storeA.id },
    data: { marketingDailyCap: 500 },
  });
  assert.equal(
    await marketingDailyCap(storeA.id),
    40,
    "…but cannot loosen above the merchant's word"
  );
  const cleared = await request(`${merchantA}/config/marketing.daily_cap`, {
    method: "PUT",
    token: tokenA,
    body: { value: null },
  });
  assert.equal(cleared.status, 200);
  assert.equal(
    cleared.payload.setting.source,
    "platform",
    "clearing his level restores the platform's ceiling"
  );
  assert.equal(await marketingDailyCap(storeA.id), 100);
  summary.readers = { workerCap: "hierarchy", storeColumn: "tightens only" };

  // ============================================================
  // 4. allow: closed above stays closed below.
  // ============================================================
  assert.equal(await guestCheckoutAllowed(storeA.id), true);
  assert.equal(
    (await request(`/store/${storeA.slug}/public-config`)).payload.guestCheckout,
    true,
    "the shopper sees guest checkout open"
  );
  assert.equal(
    (
      await request("/platform/config/checkout.guest_allowed", {
        method: "PUT",
        token: ownerToken,
        body: { value: false },
      })
    ).status,
    200
  );
  assert.equal(await guestCheckoutAllowed(storeA.id), false, "the platform closed it");
  assert.equal(
    (await request(`/store/${storeA.slug}/public-config`)).payload.guestCheckout,
    false,
    "…and the shopper's config says so"
  );
  assert.equal(
    (
      await request(`${merchantA}/config/checkout.guest_allowed`, {
        method: "PUT",
        token: tokenA,
        body: { value: true },
      })
    ).payload.error?.code,
    "SETTING_NOT_ALLOWED",
    "the merchant cannot open what the platform closed"
  );
  assert.equal(
    (
      await request(`${merchantA}/config/checkout.guest_allowed`, {
        method: "PUT",
        token: tokenA,
        body: { value: false },
      })
    ).status,
    200,
    "he may close it too"
  );
  assert.equal(
    (
      await request("/platform/config/checkout.guest_allowed", {
        method: "PUT",
        token: ownerToken,
        body: { value: null },
      })
    ).status,
    200
  );
  assert.equal(await guestCheckoutAllowed(storeA.id), false, "the merchant's no still holds");
  assert.equal(
    (
      await request(`${merchantA}/config/checkout.guest_allowed`, {
        method: "PUT",
        token: tokenA,
        body: { value: null },
      })
    ).status,
    200
  );
  assert.equal(await guestCheckoutAllowed(storeA.id), true);
  await prisma.store.update({ where: { id: storeA.id }, data: { guestCheckoutEnabled: false } });
  view = await merchantConfig();
  assert.equal(view["checkout.guest_allowed"].value, false);
  assert.equal(
    view["checkout.guest_allowed"].source,
    "store",
    "the store's own switch is the store level"
  );
  await prisma.store.update({ where: { id: storeA.id }, data: { guestCheckoutEnabled: true } });
  summary.allow = { platformClosed: false, merchantOpenRefused: "SETTING_NOT_ALLOWED" };

  // ============================================================
  // 5. The plan speaks through entitlement.
  // ============================================================
  const plan = await activePlanForMerchant(prisma, merchantId);
  view = await merchantConfig();
  if (plan.limits.max_products > 0) {
    assert.equal(view["catalog.products_max"].value, plan.limits.max_products);
    assert.equal(view["catalog.products_max"].source, "plan");
  } else {
    assert.equal(
      view["catalog.products_max"].source,
      "default",
      "a plan with no opinion leaves the default"
    );
  }
  assert.equal(
    (
      await request("/platform/config/catalog.products_max", {
        method: "PUT",
        token: ownerToken,
        body: { value: 1 },
      })
    ).status,
    200
  );
  view = await merchantConfig();
  assert.equal(
    view["catalog.products_max"].value,
    1,
    "the platform's hard maximum sits above the plan"
  );
  assert.equal(view["catalog.products_max"].source, "platform");
  assert.equal(
    (
      await request("/platform/config/catalog.products_max", {
        method: "PUT",
        token: ownerToken,
        body: { value: null },
      })
    ).status,
    200
  );
  summary.plan = { limit: plan.limits.max_products, planCode: plan.code };

  // ============================================================
  // 6. The customer's word.
  // ============================================================
  const email = `${testId}.shopper@codiq.test`;
  let prefs = await customerPreferencesView({ id: storeA.id, merchantId }, email);
  assert.equal(prefs.marketingOptIn.value, true);
  assert.equal(prefs.marketingOptIn.source, "default");
  await prisma.notificationUnsubscribe.create({
    data: { storeId: storeA.id, emailNormalized: email.toLowerCase(), source: "link" },
  });
  prefs = await customerPreferencesView({ id: storeA.id, merchantId }, email);
  assert.equal(prefs.marketingOptIn.value, false, "his unsubscribe is the last word");
  assert.equal(prefs.marketingOptIn.source, "customer");
  assert.equal(
    (await customerPreferencesView({ id: storeA.id, merchantId }, `${testId}.other@codiq.test`))
      .marketingOptIn.value,
    true,
    "for him alone"
  );
  assert.equal(
    (
      await resolveSetting("marketing.opt_in", {
        merchantId,
        storeId: storeA.id,
        customerEmail: email,
      })
    ).source,
    "customer"
  );
  assert.equal(
    (await request(`/store/${storeA.slug}/account/preferences`)).status,
    401,
    "the preferences route is the customer's own — a session is required"
  );
  summary.customer = { optIn: false, source: "customer" };

  // ============================================================
  // 7. Audit.
  // ============================================================
  const auditAfter = await auditCount();
  assert.ok(
    auditAfter - auditBefore >= 5,
    `platform settings leave audit rows: ${auditAfter - auditBefore}`
  );
  summary.audit = auditAfter - auditBefore;

  console.log(JSON.stringify({ status: "passed", ...summary }, null, 2));
} finally {
  if (ownerToken) await sweepPlatform(ownerToken);
  server.close();
  await prisma.$disconnect();
}
