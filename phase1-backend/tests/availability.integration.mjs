/**
 * المرحلة 29 (ق-249) — the control layer, end to end: the seeded catalogue,
 * the owner's switches, the merchant's view, the store's own status, and the
 * shopper's shell — across TWO merchants, so every switch is proven to stay
 * inside its target.
 *
 * WHAT IS ASSERTED:
 *   1. the catalogue is seeded: eight services, WhatsApp «coming soon» honestly
 *   2. an owner switch on a capability closes the gated route (423) for every
 *      merchant, and the merchant's view says the source is the platform
 *   3. a merchant-scope override closes it for ONE merchant only; a store-scope
 *      override for one store; revoking restores; the list pages by keyset
 *   4. precedence: a platform override beats a merchant AVAILABLE override
 *   5. a rollout flag holds a capability back for merchant B alone; it never
 *      opens what the owner closed
 *   6. store status: the merchant pauses / puts in maintenance / reopens; the
 *      public config carries it; maintenance closes browsing (423) and checkout
 *      while the shell config still loads; the cart survives; the merchant
 *      cannot set «suspended»; the platform can, and lifts it
 *   7. every switch leaves a platform audit row
 *
 * Run: pnpm availability:test
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const testId = `avail-${Date.now()}`;
const suffix = String(Date.now()).slice(-8);
process.env.SESSION_JWT_SECRET = "availability-test-secret-only-not-for-production";
process.env.CODIQ_ALLOW_OWNER_REGISTRATION = "true";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { resetExternalDependencyCache } = await import("../src/services/availability.service.ts");
await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits");

const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
process.on("exit", () => { try { server.close(); } catch { /* already closed */ } });

async function request(path, { method = "GET", body, token, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  return { status: response.status, payload, headers: response.headers };
}

const summary = {};
try {
  // ── the owner ──────────────────────────────────────────────────────────────
  const ownerEmail = `${testId}.owner@codiq.test`;
  const ownerPassword = "OwnerPass123!Strong";
  const ownerRegister = await request("/auth/platform/register", { method: "POST", body: { email: ownerEmail, password: ownerPassword, displayName: "مالك التمرين" } });
  assert.ok([200, 201].includes(ownerRegister.status), JSON.stringify(ownerRegister.payload));
  const ownerToken = (await request("/auth/platform/login", { method: "POST", body: { email: ownerEmail, password: ownerPassword } })).payload.accessToken;
  assert.ok(ownerToken, "the owner signs in");

  // ── two merchants, two stores ──────────────────────────────────────────────
  const password = "AvailPass123!";
  const registerA = await registerMerchantDirect({ ownerName: "صاحب المتجر", businessName: "متجر الإتاحة ألف", phone: `+96475${suffix}`, email: `${testId}.a@codiq.test`, password, storeName: "متجر الإتاحة ألف", storeSlug: `${testId}-a` });
  const registerB = await registerMerchantDirect({ ownerName: "صاحب المتجر", businessName: "متجر الإتاحة باء", phone: `+96476${suffix}`, email: `${testId}.b@codiq.test`, password, storeName: "متجر الإتاحة باء", storeSlug: `${testId}-b` });
  assert.equal(registerA.status, 201, JSON.stringify(registerA.payload));
  assert.equal(registerB.status, 201, JSON.stringify(registerB.payload));
  const storeA = await prisma.store.create({ data: { merchantId: registerA.payload.account.id, name: "متجر الإتاحة ألف", slug: `${testId}-a`, defaultSubdomain: `${testId}-a` }, select: { id: true, slug: true, merchantId: true } });
  const storeB = await prisma.store.create({ data: { merchantId: registerB.payload.account.id, name: "متجر الإتاحة باء", slug: `${testId}-b`, defaultSubdomain: `${testId}-b` }, select: { id: true, slug: true, merchantId: true } });
  const tokenA = (await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.a@codiq.test`, password } })).payload.accessToken;
  const tokenB = (await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.b@codiq.test`, password } })).payload.accessToken;
  assert.ok(tokenA && tokenB, "both merchants sign in");
  const merchantA = `/merchant/stores/${storeA.slug}`;
  const merchantB = `/merchant/stores/${storeB.slug}`;
  const couriersA = () => request(`${merchantA}/orders/couriers`, { token: tokenA });
  const couriersB = () => request(`${merchantB}/orders/couriers`, { token: tokenB });
  const auditCount = () => prisma.platformAuditEvent.count({ where: { action: { in: ["service_state_changed", "capability_state_changed", "availability_override_set", "availability_override_revoked", "feature_flag_changed", "store_status_changed"] } } });
  // ── hygiene: a previous run on the SAME database leaves platform-wide state
  // behind (the global rule on the manifest flag, a platform override that a
  // crash skipped revoking) and that state would open what section 5 expects
  // closed. CI's database is fresh; the local one is not. Sweep first.
  for (const flag of (await request("/platform/feature-flags", { token: ownerToken })).payload.flags ?? []) {
    for (const rule of flag.rules ?? []) {
      const gone = await request(`/platform/feature-flags/${flag.code}/rules/${rule.id}`, { method: "DELETE", token: ownerToken });
      assert.ok([200, 204].includes(gone.status), JSON.stringify(gone.payload));
    }
    // A flag that defaults to off with no rules holds everyone back — the fresh
    // database has no flag at all, and «flag on» resolves the same way as «no flag».
    const reset = await request(`/platform/feature-flags/${flag.code}`, { method: "PUT", token: ownerToken, body: { enabledDefault: true } });
    assert.equal(reset.status, 200, JSON.stringify(reset.payload));
  }
  for (const code of ["delivery.handover", "delivery.manifest"]) {
    const reset = await request(`/platform/capabilities/${code}`, { method: "PATCH", token: ownerToken, body: { state: "available" } });
    assert.equal(reset.status, 200, JSON.stringify(reset.payload));
  }
  const liveOverrides = (await request("/platform/availability/overrides?limit=50", { token: ownerToken })).payload.overrides ?? [];
  for (const override of liveOverrides.filter((row) => row.scope === "platform")) {
    const gone = await request(`/platform/availability/overrides/${override.id}`, { method: "DELETE", token: ownerToken });
    assert.ok([200, 204].includes(gone.status), JSON.stringify(gone.payload));
  }
  const auditBefore = await auditCount();

  // ============================================================
  // 1. The catalogue is seeded, and honest about what is not there yet.
  // ============================================================
  const catalogue = await request("/platform/services", { token: ownerToken });
  assert.equal(catalogue.status, 200, JSON.stringify(catalogue.payload));
  assert.deepEqual(catalogue.payload.services.map((s) => s.code), ["pos", "delivery", "offers", "customer_experience", "communication", "marketing", "data", "team"], "the eight services, in the owner's order");
  const whatsapp = catalogue.payload.services.find((s) => s.code === "communication").capabilities.find((c) => c.code === "communication.whatsapp");
  assert.equal(whatsapp.state, "coming_soon", "WhatsApp is «coming soon» because phase 31 has not begun — not «available» by default");
  const merchantView = await request(`${merchantA}/services`, { token: tokenA });
  assert.equal(merchantView.status, 200, JSON.stringify(merchantView.payload));
  assert.equal(merchantView.payload.services.find((s) => s.code === "communication").capabilities.find((c) => c.code === "communication.whatsapp").label, "قريباً");
  assert.equal(merchantView.payload.services.find((s) => s.code === "delivery").state, "AVAILABLE");
  assert.equal((await couriersA()).status, 200, "the gated route answers while its capability is available");
  summary.catalogue = { services: 8, whatsapp: "coming_soon" };

  // ============================================================
  // 2. An owner switch closes the door for everyone — and says so.
  // ============================================================
  const off = await request("/platform/capabilities/delivery.handover", { method: "PATCH", token: ownerToken, body: { state: "disabled" } });
  assert.equal(off.status, 200, JSON.stringify(off.payload));
  for (const [who, call] of [["A", couriersA], ["B", couriersB]]) {
    const refused = await call();
    assert.equal(refused.status, 423, `merchant ${who}: ${JSON.stringify(refused.payload)}`);
    assert.equal(refused.payload.error.code, "CAPABILITY_UNAVAILABLE");
    assert.equal(refused.payload.error.capability, "delivery.handover");
    assert.equal(refused.payload.error.source, "capability");
  }
  const viewOff = await request(`${merchantA}/services`, { token: tokenA });
  const handoverOff = viewOff.payload.services.find((s) => s.code === "delivery").capabilities.find((c) => c.code === "delivery.handover");
  assert.equal(handoverOff.state, "DISABLED");
  assert.equal(handoverOff.label, "معطّلة");
  assert.equal((await request("/platform/capabilities/delivery.handover", { method: "PATCH", token: ownerToken, body: { state: "available" } })).status, 200);
  assert.equal((await couriersA()).status, 200, "…and reopens for everyone");
  const badState = await request("/platform/capabilities/delivery.handover", { method: "PATCH", token: ownerToken, body: { state: "on" } });
  assert.equal(badState.payload.error.code, "INVALID_SERVICE_STATE");
  assert.equal((await request("/platform/capabilities/delivery.handover", { method: "PATCH", token: tokenA, body: { state: "disabled" } })).status, 403, "a merchant cannot throw the owner's switch");
  summary.ownerSwitch = { closes: 423, reopens: 200, merchantForbidden: 403 };

  // ============================================================
  // 3. Overrides stay inside their target; revoking restores; the list pages.
  // ============================================================
  const overrideB = await request("/platform/availability/overrides", { method: "POST", token: ownerToken, body: { scope: "merchant", merchantEmail: `${testId}.b@codiq.test`, capabilityCode: "delivery.handover", state: "TEMPORARILY_UNAVAILABLE", reason: "شكوى من الناقل — إلى حين التحقّق" } });
  assert.equal(overrideB.status, 201, JSON.stringify(overrideB.payload));
  assert.equal(overrideB.payload.override.subject.code, "delivery.handover");
  assert.equal((await couriersA()).status, 200, "merchant A is untouched by B's override");
  const refusedB = await couriersB();
  assert.equal(refusedB.status, 423);
  assert.equal(refusedB.payload.error.state, "TEMPORARILY_UNAVAILABLE");
  assert.equal(refusedB.payload.error.source, "merchant_override");
  const noReason = await request("/platform/availability/overrides", { method: "POST", token: ownerToken, body: { scope: "merchant", merchantEmail: `${testId}.b@codiq.test`, capabilityCode: "delivery.handover", state: "DISABLED", reason: "" } });
  assert.equal(noReason.payload.error.code, "INVALID_OVERRIDE_REASON", "an override without a written reason is refused");
  const storeOverride = await request("/platform/availability/overrides", { method: "POST", token: ownerToken, body: { scope: "store", storeSlug: storeA.slug, serviceCode: "data", state: "DISABLED", reason: "تصدير ضخم يضرب القاعدة — مؤقّتاً" } });
  assert.equal(storeOverride.status, 201, JSON.stringify(storeOverride.payload));
  const csvA = await request(`${merchantA}/orders/export.csv`, { token: tokenA });
  assert.equal(csvA.status, 423, "a service-wide store override closes every capability of the service for that store");
  assert.equal(csvA.payload.error.source, "store_override");
  assert.equal((await request(`${merchantB}/orders/export.csv`, { token: tokenB })).status, 200, "store B exports as before");
  const list = await request("/platform/availability/overrides?limit=1", { token: ownerToken });
  assert.equal(list.status, 200);
  assert.equal(list.payload.overrides.length, 1);
  assert.ok(list.payload.nextCursor, "the list pages by keyset");
  const page2 = await request(`/platform/availability/overrides?limit=1&cursor=${encodeURIComponent(list.payload.nextCursor)}`, { token: ownerToken });
  assert.equal(page2.status, 200);
  assert.notEqual(page2.payload.overrides[0].id, list.payload.overrides[0].id);
  const revoked = await request(`/platform/availability/overrides/${storeOverride.payload.override.id}`, { method: "DELETE", token: ownerToken });
  assert.equal(revoked.status, 200);
  assert.ok(revoked.payload.override.revokedAt, "revoking stamps, never deletes");
  assert.equal((await request(`${merchantA}/orders/export.csv`, { token: tokenA })).status, 200, "…and the door reopens");
  assert.equal((await request(`/platform/availability/overrides/${storeOverride.payload.override.id}`, { method: "DELETE", token: ownerToken })).status, 200, "revoking twice is idempotent");
  summary.overrides = { merchantScoped: true, storeScoped: true, listed: true, revoked: true };

  // ============================================================
  // 4. Precedence: the platform's word beats a merchant AVAILABLE override.
  // ============================================================
  const platformOff = await request("/platform/availability/overrides", { method: "POST", token: ownerToken, body: { scope: "platform", capabilityCode: "delivery.handover", state: "MAINTENANCE", reason: "ترقية جدول الناقلين" } });
  assert.equal(platformOff.status, 201, JSON.stringify(platformOff.payload));
  const merchantOn = await request("/platform/availability/overrides", { method: "POST", token: ownerToken, body: { scope: "merchant", merchantEmail: `${testId}.a@codiq.test`, capabilityCode: "delivery.handover", state: "AVAILABLE", reason: "تاجر تجريبيّ" } });
  assert.equal(merchantOn.status, 201);
  const stillOff = await couriersA();
  assert.equal(stillOff.status, 423);
  assert.equal(stillOff.payload.error.state, "MAINTENANCE");
  assert.equal(stillOff.payload.error.source, "platform_override", "the platform override wins over the merchant AVAILABLE override");
  assert.equal(stillOff.payload.error.message, "الخدمة تحت الصيانة.", "the customer sentence is the owner's, verbatim");
  assert.equal((await request(`/platform/availability/overrides/${platformOff.payload.override.id}`, { method: "DELETE", token: ownerToken })).status, 200);
  assert.equal((await couriersA()).status, 200, "with the platform override gone, A's AVAILABLE override re-enables it");
  assert.equal((await couriersB()).status, 423, "B is still under its own TEMPORARILY_UNAVAILABLE override");
  assert.equal((await request(`/platform/availability/overrides/${overrideB.payload.override.id}`, { method: "DELETE", token: ownerToken })).status, 200);
  assert.equal((await couriersB()).status, 200);
  summary.precedence = "platform > merchant > store, and AVAILABLE re-enables";

  // ============================================================
  // 5. A rollout flag holds back; it never opens what the owner closed.
  // ============================================================
  const flag = await request("/platform/feature-flags/delivery.manifest", { method: "PUT", token: ownerToken, body: { description: "طرح تدريجيّ لبيان الشحنات", enabledDefault: false } });
  assert.equal(flag.status, 200, JSON.stringify(flag.payload));
  const manifestA = () => request(`${merchantA}/orders/manifest.csv`, { token: tokenA });
  const manifestB = () => request(`${merchantB}/orders/manifest.csv`, { token: tokenB });
  assert.equal((await manifestA()).status, 423, "a flag that defaults to off holds every merchant back…");
  assert.equal((await manifestA()).payload.error.state, "COMING_SOON");
  const ruleA = await request("/platform/feature-flags/delivery.manifest/rules", { method: "POST", token: ownerToken, body: { scope: "merchant", merchantEmail: `${testId}.a@codiq.test`, enabled: true } });
  assert.equal(ruleA.status, 201, JSON.stringify(ruleA.payload));
  assert.equal((await manifestA()).status, 200, "…except the merchant it was rolled out to");
  assert.equal((await manifestB()).status, 423, "B waits");
  assert.equal((await request("/platform/capabilities/delivery.manifest", { method: "PATCH", token: ownerToken, body: { state: "disabled" } })).status, 200);
  const closedDespiteFlag = await manifestA();
  assert.equal(closedDespiteFlag.status, 423);
  assert.equal(closedDespiteFlag.payload.error.source, "capability", "the flag cannot open what the owner closed");
  assert.equal((await request("/platform/capabilities/delivery.manifest", { method: "PATCH", token: ownerToken, body: { state: "available" } })).status, 200);
  const global = await request("/platform/feature-flags/delivery.manifest/rules", { method: "POST", token: ownerToken, body: { scope: "global", enabled: true } });
  assert.equal(global.status, 201);
  assert.equal((await manifestB()).status, 200, "a global rule opens it for B too");
  const flags = await request("/platform/feature-flags", { token: ownerToken });
  assert.equal(flags.payload.flags.find((f) => f.code === "delivery.manifest").rules.length, 2);
  summary.flags = { holdsBack: "COMING_SOON", perMerchant: true, cannotOverrideOwner: true };

  // ============================================================
  // 6. Store status — the merchant's own switch, and the platform's.
  // ============================================================
  const statusA = `${merchantA}/status`;
  assert.equal((await request(statusA, { token: tokenA })).payload.status, "active");
  const config = await request(`/store/${storeA.slug}/public-config`);
  assert.deepEqual(config.payload.availability, { store: { status: "active" } }, "the shopper's shell always knows the status");
  const paused = await request(statusA, { method: "PUT", token: tokenA, body: { status: "paused", message: "نعود بعد العيد" } });
  assert.equal(paused.status, 200, JSON.stringify(paused.payload));
  assert.equal((await request(`/store/${storeA.slug}/public-config`)).payload.vacation.message, "نعود بعد العيد", "paused IS the MD-1 vacation: the banner key is kept");
  assert.equal((await request(`/store/${storeA.slug}/products`)).status, 200, "browsing stays open while paused");
  const maintenance = await request(statusA, { method: "PUT", token: tokenA, body: { status: "maintenance", message: "نرتّب المخزن", maintenanceUntil: new Date(Date.now() + 3_600_000).toISOString() } });
  assert.equal(maintenance.status, 200, JSON.stringify(maintenance.payload));
  const shell = await request(`/store/${storeA.slug}/public-config`);
  assert.equal(shell.status, 200, "the shell config still loads during maintenance — it carries the message");
  assert.equal(shell.payload.availability.store.status, "maintenance");
  assert.equal(shell.payload.availability.store.message, "نرتّب المخزن");
  assert.ok(shell.payload.availability.store.until);
  const closedBrowse = await request(`/store/${storeA.slug}/products`);
  assert.equal(closedBrowse.status, 423, "browsing is closed during maintenance");
  assert.equal(closedBrowse.payload.error.code, "STORE_IN_MAINTENANCE");
  assert.equal(closedBrowse.payload.error.message, "نرتّب المخزن");
  assert.equal((await request(`/store/${storeB.slug}/products`)).status, 200, "store B is open");
  assert.equal((await request(`${merchantA}/services`, { token: tokenA })).status, 200, "the merchant's dashboard stays reachable");
  assert.equal((await request(`${merchantA}/services`, { token: tokenA })).payload.services[0].state, "MAINTENANCE", "…and shows every service as under maintenance");
  const merchantSuspend = await request(statusA, { method: "PUT", token: tokenA, body: { status: "suspended" } });
  assert.equal(merchantSuspend.payload.error.code, "INVALID_STORE_STATUS", "suspended is the platform's word");
  const badUntil = await request(statusA, { method: "PUT", token: tokenA, body: { status: "active", maintenanceUntil: new Date(Date.now() + 3_600_000).toISOString() } });
  assert.equal(badUntil.payload.error.code, "INVALID_STORE_STATUS", "an end time belongs to maintenance only");
  assert.equal((await request(statusA, { method: "PUT", token: tokenA, body: { status: "active" } })).status, 200);
  assert.equal((await request(`/store/${storeA.slug}/products`)).status, 200, "reopened");
  const platformSuspend = await request(`/platform/stores/${storeA.slug}/status`, { method: "PATCH", token: ownerToken, body: { status: "suspended", message: "مخالفة" } });
  assert.equal(platformSuspend.status, 200, JSON.stringify(platformSuspend.payload));
  assert.equal((await request(`/store/${storeA.slug}/public-config`)).status, 404, "a suspended store vanishes from shoppers");
  const cannotLift = await request(statusA, { method: "PUT", token: tokenA, body: { status: "active" } });
  assert.equal(cannotLift.payload.error.code, "STORE_SUSPENDED", "the merchant cannot talk his way out of a platform suspension");
  assert.equal((await request(`/platform/stores/${storeA.slug}/status`, { method: "PATCH", token: ownerToken, body: { status: "active" } })).status, 200);
  assert.equal((await request(`/store/${storeA.slug}/public-config`)).status, 200, "lifted");
  const mirror = await prisma.store.findUniqueOrThrow({ where: { id: storeA.id }, select: { status: true, isActive: true, vacationMode: true } });
  assert.deepEqual(mirror, { status: "active", isActive: true, vacationMode: false }, "the legacy mirror follows the status");
  summary.storeStatus = { paused: "banner", maintenance: 423, suspendedByMerchant: 422, suspendedByPlatform: 404, lifted: 200 };

  // ============================================================
  // 7. Every switch left an audit row.
  // ============================================================
  const auditAfter = await auditCount();
  assert.ok(auditAfter - auditBefore >= 14, `audit rows written: ${auditAfter - auditBefore}`);
  summary.audit = auditAfter - auditBefore;

  resetExternalDependencyCache();
  console.log(JSON.stringify({ suite: "availability", status: "passed", summary }, null, 2));
} finally {
  // Review 2026-11-21: the flag this suite rolls out must not outlive it. Left behind (off by
  // default) it closed «بيان الشحنات» for every later suite on the same database.
  const flag = await prisma.featureFlag.findUnique({ where: { code: "delivery.manifest" }, select: { id: true } }).catch(() => null);
  if (flag) {
    await prisma.featureFlagRule.deleteMany({ where: { flagId: flag.id } }).catch(() => undefined);
    await prisma.featureFlag.delete({ where: { id: flag.id } }).catch(() => undefined);
  }
  server.close();
  await prisma.$disconnect();
}
