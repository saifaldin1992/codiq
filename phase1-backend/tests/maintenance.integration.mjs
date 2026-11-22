/**
 * ق-250 (المرحلة 29-2) — scheduled maintenance and incidents, end to end, across
 * two merchants so every window is proven to stay inside its target.
 *
 * WHAT IS ASSERTED:
 *   1. a platform window running NOW, narrowed to one capability, closes that
 *      capability (423, source maintenance_window, the window's own sentence)
 *      for every merchant and nothing else; the merchant's view and notices say
 *      so; every merchant gets ONE «scheduled» mail row; cancelling reopens
 *   2. a FUTURE window closes nothing but shows as «upcoming»
 *   3. the refusals: end before start, longer than a week, already over, an
 *      unknown code, a merchant window without a merchant, a merchant token
 *   4. a merchant-scope window closes merchant A alone
 *   5. the merchant's own store window: the shop closes to shoppers with his
 *      sentence (public config, 423 on browsing) and his status reads «window»;
 *      cancelling reopens; a window the platform placed on his store is not his
 *      to cancel
 *   6. the clock: a manual «maintenance until» that has passed reads active
 *   7. the worker: an ended window is stamped once and «ended» mail rows appear;
 *      a second pass finds nothing
 *   8. incidents: a blocking one closes what it names for everyone with its
 *      public message; updates move it forward; resolving reopens; a resolved
 *      incident refuses further updates; a non-blocking one is a notice only
 *   9. a platform-wide window shows in the shopper's config as a strip
 *  10. every platform act leaves an audit row
 *
 * Run: pnpm maintenance:test
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const testId = `maint-${Date.now()}`;
const suffix = String(Date.now()).slice(-8);
process.env.SESSION_JWT_SECRET = "maintenance-test-secret-only-not-for-production";
process.env.CODIQ_ALLOW_OWNER_REGISTRATION = "true";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { tickMaintenanceWindows, windowPhase, formatBaghdad } = await import("../src/services/maintenance.service.ts");
// A platform window mails EVERY active merchant — on a shared database that is every merchant every
// suite ever registered, and those rows would drain ahead of the next suite's batch. Taken out at both ends.
const sweepMaintenanceMail = () => prisma.notificationOutbox.deleteMany({ where: { eventType: { in: ["maintenance.scheduled", "maintenance.ended", "maintenance.cancelled"] }, status: "pending" } });
await sweepMaintenanceMail();
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

const minutes = (n) => new Date(Date.now() + n * 60_000).toISOString();
const summary = {};
try {
  // ── the owner ──────────────────────────────────────────────────────────────
  const ownerEmail = `${testId}.owner@codiq.test`;
  const ownerPassword = "OwnerPass123!Strong";
  const ownerRegister = await request("/auth/platform/register", { method: "POST", body: { email: ownerEmail, password: ownerPassword, displayName: "مالك الصيانة" } });
  assert.ok([200, 201].includes(ownerRegister.status), JSON.stringify(ownerRegister.payload));
  const ownerToken = (await request("/auth/platform/login", { method: "POST", body: { email: ownerEmail, password: ownerPassword } })).payload.accessToken;
  assert.ok(ownerToken, "the owner signs in");

  // ── two merchants, two stores ──────────────────────────────────────────────
  const password = "MaintPass123!";
  const registerA = await registerMerchantDirect({ ownerName: "صاحب المتجر", businessName: "متجر الصيانة ألف", phone: `+96477${suffix}`, email: `${testId}.a@codiq.test`, password, storeName: "متجر الصيانة ألف", storeSlug: `${testId}-a` });
  const registerB = await registerMerchantDirect({ ownerName: "صاحب المتجر", businessName: "متجر الصيانة باء", phone: `+96478${suffix}`, email: `${testId}.b@codiq.test`, password, storeName: "متجر الصيانة باء", storeSlug: `${testId}-b` });
  assert.equal(registerA.status, 201, JSON.stringify(registerA.payload));
  assert.equal(registerB.status, 201, JSON.stringify(registerB.payload));
  const storeA = await prisma.store.create({ data: { merchantId: registerA.payload.account.id, name: "متجر الصيانة ألف", slug: `${testId}-a`, defaultSubdomain: `${testId}-a` }, select: { id: true, slug: true, merchantId: true } });
  const storeB = await prisma.store.create({ data: { merchantId: registerB.payload.account.id, name: "متجر الصيانة باء", slug: `${testId}-b`, defaultSubdomain: `${testId}-b` }, select: { id: true, slug: true, merchantId: true } });
  const tokenA = (await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.a@codiq.test`, password } })).payload.accessToken;
  const tokenB = (await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.b@codiq.test`, password } })).payload.accessToken;
  assert.ok(tokenA && tokenB, "both merchants sign in");
  const merchantA = `/merchant/stores/${storeA.slug}`;
  const merchantB = `/merchant/stores/${storeB.slug}`;
  const manifestA = () => request(`${merchantA}/orders/manifest.csv`, { token: tokenA });
  const manifestB = () => request(`${merchantB}/orders/manifest.csv`, { token: tokenB });
  const couriersA = () => request(`${merchantA}/orders/couriers`, { token: tokenA });
  const couriersB = () => request(`${merchantB}/orders/couriers`, { token: tokenB });
  const noticesA = () => request(`${merchantA}/availability/notices`, { token: tokenA });
  const publicConfigA = () => request(`/store/${storeA.slug}/public-config`);

  // ── hygiene: a previous run on the SAME database may have left live windows or open incidents ──
  for (const window of (await request("/platform/maintenance-windows?live=true", { token: ownerToken })).payload.windows ?? []) {
    const gone = await request(`/platform/maintenance-windows/${window.id}`, { method: "DELETE", token: ownerToken });
    assert.ok([200, 409].includes(gone.status), JSON.stringify(gone.payload));
  }
  for (const incident of (await request("/platform/incidents?open=true", { token: ownerToken })).payload.incidents ?? []) {
    const closed = await request(`/platform/incidents/${incident.id}/updates`, { method: "POST", token: ownerToken, body: { status: "resolved", message: "hygiene — a previous run" } });
    assert.ok([200, 409].includes(closed.status), JSON.stringify(closed.payload));
  }
  // …and the availability suite leaves the manifest flag OFF with its rules deleted (its last section tests
  // rule removal). A flag that defaults to off holds everyone back; «flag on» resolves like «no flag».
  for (const flag of (await request("/platform/feature-flags", { token: ownerToken })).payload.flags ?? []) {
    for (const rule of flag.rules ?? []) assert.ok([200, 204].includes((await request(`/platform/feature-flags/${flag.code}/rules/${rule.id}`, { method: "DELETE", token: ownerToken })).status));
    assert.equal((await request(`/platform/feature-flags/${flag.code}`, { method: "PUT", token: ownerToken, body: { enabledDefault: true } })).status, 200);
  }
  for (const code of ["delivery.handover", "delivery.manifest"]) {
    assert.equal((await request(`/platform/capabilities/${code}`, { method: "PATCH", token: ownerToken, body: { state: "available" } })).status, 200);
  }
  for (const override of (await request("/platform/availability/overrides?limit=50", { token: ownerToken })).payload.overrides ?? []) {
    if (override.scope === "platform") assert.equal((await request(`/platform/availability/overrides/${override.id}`, { method: "DELETE", token: ownerToken })).status, 200);
  }
  const auditCount = () => prisma.platformAuditEvent.count({ where: { action: { in: ["maintenance_window_scheduled", "maintenance_window_cancelled", "incident_opened", "incident_updated", "incident_resolved"] } } });
  const auditBefore = await auditCount();
  assert.equal((await manifestA()).status, 200, "the gated route answers while nothing is scheduled");

  // ============================================================
  // 1. A platform window running NOW, narrowed to one capability.
  // ============================================================
  const nowWindow = await request("/platform/maintenance-windows", { method: "POST", token: ownerToken, body: { scope: "platform", startsAt: minutes(-1), endsAt: minutes(120), messageAr: "نرقّي خوادم بيان الشحنات — يعود خلال ساعتين", messageEn: "Manifest export is under maintenance", affects: ["delivery.manifest"] } });
  assert.equal(nowWindow.status, 201, JSON.stringify(nowWindow.payload));
  assert.equal(nowWindow.payload.window.phase, "active");
  assert.equal(nowWindow.payload.window.timezone, "Asia/Baghdad");
  assert.match(nowWindow.payload.window.startsAtLocal, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, "the local time is written out for Baghdad");
  const closedA = await manifestA();
  assert.equal(closedA.status, 423, JSON.stringify(closedA.payload));
  assert.equal(closedA.payload.error.code, "CAPABILITY_UNAVAILABLE");
  assert.equal(closedA.payload.error.state, "MAINTENANCE");
  assert.equal(closedA.payload.error.source, "maintenance_window");
  assert.equal(closedA.payload.error.message, "نرقّي خوادم بيان الشحنات — يعود خلال ساعتين", "the window's own sentence, not the generic one");
  assert.equal((await manifestB()).status, 423, "a platform window reaches every merchant");
  assert.equal((await couriersA()).status, 200, "a capability the window does not name stays open");
  const viewA = await request(`${merchantA}/services`, { token: tokenA });
  const manifestCap = viewA.payload.services.find((s) => s.code === "delivery").capabilities.find((c) => c.code === "delivery.manifest");
  assert.equal(manifestCap.state, "MAINTENANCE");
  assert.equal(manifestCap.source, "maintenance_window");
  assert.equal(manifestCap.label, "تحت الصيانة");
  const notices1 = await noticesA();
  assert.equal(notices1.status, 200, JSON.stringify(notices1.payload));
  assert.equal(notices1.payload.storeSlug, storeA.slug);
  const noticed = notices1.payload.maintenance.find((w) => w.id === nowWindow.payload.window.id);
  assert.ok(noticed, "the merchant's notices carry the running window");
  assert.equal(noticed.phase, "active");
  assert.deepEqual(noticed.affects, ["delivery.manifest"]);
  const scheduledMails = await prisma.notificationOutbox.findMany({ where: { eventType: "maintenance.scheduled", dedupeKey: { startsWith: `maintenance.scheduled:${nowWindow.payload.window.id}:` } }, select: { storeId: true, recipient: true, payload: true, dedupeKey: true } });
  const mailedTo = new Set(scheduledMails.map((row) => row.recipient));
  assert.ok(mailedTo.has(`${testId}.a@codiq.test`) && mailedTo.has(`${testId}.b@codiq.test`), "both merchants are mailed about a platform window");
  assert.ok(scheduledMails.every((row) => row.storeId === null), "the notice is about the platform, not a store — storeless rows");
  assert.equal(new Set(scheduledMails.map((row) => row.dedupeKey)).size, scheduledMails.length, "one row per merchant, never two");
  assert.equal(scheduledMails[0].payload.startsAtLocal, nowWindow.payload.window.startsAtLocal);
  const liveList = await request("/platform/maintenance-windows?live=true", { token: ownerToken });
  assert.equal(liveList.status, 200);
  assert.ok(liveList.payload.windows.some((w) => w.id === nowWindow.payload.window.id));
  assert.ok("nextCursor" in liveList.payload, "the list is a keyset page");
  const cancelled = await request(`/platform/maintenance-windows/${nowWindow.payload.window.id}`, { method: "DELETE", token: ownerToken });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.payload));
  assert.equal(cancelled.payload.window.phase, "cancelled");
  assert.equal((await manifestA()).status, 200, "cancelling reopens at once");
  assert.equal((await request(`/platform/maintenance-windows/${nowWindow.payload.window.id}`, { method: "DELETE", token: ownerToken })).status, 409, "cancelling twice is refused by name");
  const cancelMails = await prisma.notificationOutbox.count({ where: { eventType: "maintenance.cancelled", dedupeKey: { startsWith: `maintenance.cancelled:${nowWindow.payload.window.id}:` } } });
  assert.equal(cancelMails, scheduledMails.length, "every merchant told about the window is told it is off — once, however often cancel is pressed");
  summary.platformWindow = { closed: 423, others: 200, mails: scheduledMails.length, reopened: 200 };

  // ============================================================
  // 2. A FUTURE window closes nothing but is announced.
  // ============================================================
  const future = await request("/platform/maintenance-windows", { method: "POST", token: ownerToken, body: { scope: "capability", capabilityCode: "delivery.manifest", startsAt: minutes(60), endsAt: minutes(90), messageAr: "صيانة قصيرة لبيان الشحنات الليلة" } });
  assert.equal(future.status, 201, JSON.stringify(future.payload));
  assert.equal(future.payload.window.phase, "upcoming");
  assert.equal(future.payload.window.subject, "بيان الشحنات");
  assert.equal((await manifestA()).status, 200, "an upcoming window closes nothing");
  const notices2 = await noticesA();
  assert.equal(notices2.payload.maintenance.find((w) => w.id === future.payload.window.id)?.phase, "upcoming");
  assert.equal((await request(`/platform/maintenance-windows/${future.payload.window.id}`, { method: "DELETE", token: ownerToken })).status, 200);
  summary.futureWindow = "announced, not enforced";

  // ============================================================
  // 3. The refusals.
  // ============================================================
  const refusals = [
    ["end before start", { scope: "platform", startsAt: minutes(60), endsAt: minutes(30), messageAr: "خطأ" }, 422, "INVALID_MAINTENANCE_WINDOW"],
    ["longer than a week", { scope: "platform", startsAt: minutes(0), endsAt: minutes(8 * 24 * 60), messageAr: "طويلة جدّاً" }, 422, "INVALID_MAINTENANCE_WINDOW"],
    ["already over", { scope: "platform", startsAt: minutes(-120), endsAt: minutes(-60), messageAr: "انتهت" }, 422, "INVALID_MAINTENANCE_WINDOW"],
    ["unknown code", { scope: "platform", startsAt: minutes(0), endsAt: minutes(30), messageAr: "رمز مجهول", affects: ["pharmacy.sell"] }, 422, "INVALID_MAINTENANCE_WINDOW"],
    ["message too short", { scope: "platform", startsAt: minutes(0), endsAt: minutes(30), messageAr: "x" }, 422, "INVALID_MAINTENANCE_WINDOW"],
    ["merchant window without a merchant", { scope: "merchant", startsAt: minutes(0), endsAt: minutes(30), messageAr: "بلا تاجر" }, 422, "INVALID_MAINTENANCE_WINDOW"],
    ["unknown scope", { scope: "galaxy", startsAt: minutes(0), endsAt: minutes(30), messageAr: "نطاق مجهول" }, 422, "INVALID_MAINTENANCE_WINDOW"],
  ];
  for (const [name, body, status, code] of refusals) {
    const refused = await request("/platform/maintenance-windows", { method: "POST", token: ownerToken, body });
    assert.equal(refused.status, status, `${name}: ${JSON.stringify(refused.payload)}`);
    assert.equal(refused.payload.error.code, code, name);
  }
  assert.equal((await request("/platform/maintenance-windows", { method: "POST", token: tokenA, body: { scope: "platform", startsAt: minutes(0), endsAt: minutes(30), messageAr: "تاجر يحاول" } })).status, 403, "a merchant cannot schedule platform maintenance");
  assert.equal((await request("/platform/maintenance-windows", { token: tokenA })).status, 403);
  summary.refusals = refusals.length + 2;

  // ============================================================
  // 4. A merchant-scope window closes merchant A alone.
  // ============================================================
  const merchantWindow = await request("/platform/maintenance-windows", { method: "POST", token: ownerToken, body: { scope: "merchant", merchantEmail: `${testId}.a@codiq.test`, startsAt: minutes(-5), endsAt: minutes(30), messageAr: "نصلح بيانات هذا التاجر" } });
  assert.equal(merchantWindow.status, 201, JSON.stringify(merchantWindow.payload));
  const closedForA = await couriersA();
  assert.equal(closedForA.status, 423);
  assert.equal(closedForA.payload.error.source, "maintenance_window");
  assert.equal((await couriersB()).status, 200, "merchant B is untouched");
  const merchantMails = await prisma.notificationOutbox.findMany({ where: { dedupeKey: { startsWith: `maintenance.scheduled:${merchantWindow.payload.window.id}:` } }, select: { recipient: true } });
  assert.deepEqual(merchantMails.map((row) => row.recipient), [`${testId}.a@codiq.test`], "only the named merchant is mailed");
  assert.equal((await request(`/platform/maintenance-windows/${merchantWindow.payload.window.id}`, { method: "DELETE", token: ownerToken })).status, 200);
  assert.equal((await couriersA()).status, 200);
  summary.merchantWindow = "A closed, B open, one mail";

  // ============================================================
  // 5. The merchant's own store window.
  // ============================================================
  const storeWindowsUrl = `${merchantA}/maintenance-windows`;
  assert.equal((await request(storeWindowsUrl, { token: tokenA })).payload.windows.length, 0, "nothing scheduled yet");
  const ownWindow = await request(storeWindowsUrl, { method: "POST", token: tokenA, body: { startsAt: minutes(-1), endsAt: minutes(45), messageAr: "نرتّب المخزن — نعود بعد ساعة" } });
  assert.equal(ownWindow.status, 201, JSON.stringify(ownWindow.payload));
  assert.equal(ownWindow.payload.window.phase, "active");
  assert.equal(ownWindow.payload.window.createdByKind, "merchant");
  const configClosed = await publicConfigA();
  assert.equal(configClosed.status, 200, "the shell config still answers during maintenance");
  assert.equal(configClosed.payload.availability.store.status, "maintenance");
  assert.equal(configClosed.payload.availability.store.message, "نرتّب المخزن — نعود بعد ساعة", "the shopper reads the window's sentence");
  assert.equal(configClosed.payload.availability.store.until, ownWindow.payload.window.endsAt, "and when the shop returns");
  const browsing = await request(`/store/${storeA.slug}/products`);
  assert.equal(browsing.status, 423);
  assert.equal(browsing.payload.error.code, "STORE_IN_MAINTENANCE");
  const statusA = await request(`${merchantA}/status`, { token: tokenA });
  assert.equal(statusA.payload.status, "maintenance");
  assert.equal(statusA.payload.source, "window", "the merchant's status screen says the clock closed it");
  const viewDuring = await request(`${merchantA}/services`, { token: tokenA });
  assert.equal(viewDuring.payload.services.find((s) => s.code === "delivery").capabilities.find((c) => c.code === "delivery.handover").source, "store", "his capabilities read the store's state");
  assert.equal((await prisma.store.findUnique({ where: { id: storeA.id }, select: { status: true } })).status, "active", "the column is untouched — the clock decided, nothing wrote");
  const ownMails = await prisma.notificationOutbox.count({ where: { dedupeKey: { startsWith: `maintenance.scheduled:${ownWindow.payload.window.id}:` } } });
  assert.equal(ownMails, 0, "nobody is mailed about a window the merchant scheduled himself");
  assert.equal((await request(`${storeWindowsUrl}/${ownWindow.payload.window.id}`, { method: "DELETE", token: tokenA })).status, 200);
  assert.equal((await publicConfigA()).payload.availability.store.status, "active", "cancelling reopens the shop at once");
  assert.equal((await request(`/store/${storeA.slug}/products`)).status, 200);
  // a window the platform placed on his store is not his to cancel
  const placed = await request("/platform/maintenance-windows", { method: "POST", token: ownerToken, body: { scope: "store", storeSlug: storeA.slug, startsAt: minutes(-1), endsAt: minutes(30), messageAr: "المنصّة تصلح هذا المتجر" } });
  assert.equal(placed.status, 201, JSON.stringify(placed.payload));
  assert.equal((await publicConfigA()).payload.availability.store.message, "المنصّة تصلح هذا المتجر");
  const notHis = await request(`${storeWindowsUrl}/${placed.payload.window.id}`, { method: "DELETE", token: tokenA });
  assert.equal(notHis.status, 403);
  assert.equal(notHis.payload.error.code, "MAINTENANCE_WINDOW_PLATFORM_OWNED");
  assert.ok((await request(storeWindowsUrl, { token: tokenA })).payload.windows.some((w) => w.id === placed.payload.window.id), "but he sees it listed");
  assert.equal((await request(`${merchantB}/maintenance-windows/${placed.payload.window.id}`, { method: "DELETE", token: tokenB })).status, 404, "another store cannot even see it");
  assert.equal((await request(`/platform/maintenance-windows/${placed.payload.window.id}`, { method: "DELETE", token: ownerToken })).status, 200);
  assert.equal((await publicConfigA()).payload.availability.store.status, "active");
  const badOwn = await request(storeWindowsUrl, { method: "POST", token: tokenA, body: { startsAt: minutes(30), endsAt: minutes(10), messageAr: "خطأ" } });
  assert.equal(badOwn.status, 422);
  summary.storeWindow = { closed: 423, columnUntouched: true, platformOwned: 403 };

  // ============================================================
  // 6. The clock: a manual «until» that has passed reads active.
  // ============================================================
  await prisma.store.update({ where: { id: storeA.id }, data: { status: "maintenance", statusMessage: "نعود بعد قليل", maintenanceUntil: new Date(Date.now() - 60_000) } });
  const afterUntil = await request(`${merchantA}/status`, { token: tokenA });
  assert.equal(afterUntil.payload.status, "active");
  assert.equal(afterUntil.payload.source, "clock");
  assert.equal((await publicConfigA()).payload.availability.store.status, "active");
  assert.equal((await request(`/store/${storeA.slug}/products`)).status, 200, "the shop is open once «until» has passed");
  await prisma.store.update({ where: { id: storeA.id }, data: { status: "active", statusMessage: null, maintenanceUntil: null } });
  summary.clock = "until passed → active";

  // ============================================================
  // 7. The worker stamps ended windows once and mails «ended».
  // ============================================================
  const endedRow = await prisma.maintenanceWindow.create({
    data: { scope: "platform", startsAt: new Date(Date.now() - 3_600_000), endsAt: new Date(Date.now() - 60_000), messageAr: "صيانة انتهت للتوّ", affects: [], createdByKind: "platform_owner", createdById: ownerRegister.payload.account.id },
    select: { id: true },
  });
  const tick1 = await tickMaintenanceWindows();
  assert.ok(tick1.completed >= 1, JSON.stringify(tick1));
  const stamped = await prisma.maintenanceWindow.findUnique({ where: { id: endedRow.id }, select: { status: true, completedAt: true } });
  assert.equal(stamped.status, "completed");
  assert.ok(stamped.completedAt, "stamped with the moment");
  const endedMails = await prisma.notificationOutbox.findMany({ where: { eventType: "maintenance.ended", dedupeKey: { startsWith: `maintenance.ended:${endedRow.id}:` } }, select: { recipient: true } });
  assert.ok(endedMails.some((row) => row.recipient === `${testId}.a@codiq.test`) && endedMails.some((row) => row.recipient === `${testId}.b@codiq.test`), "both merchants hear it is over");
  const tick2 = await tickMaintenanceWindows();
  const stillOne = await prisma.notificationOutbox.count({ where: { dedupeKey: { startsWith: `maintenance.ended:${endedRow.id}:` } } });
  assert.equal(stillOne, endedMails.length, "a second pass mails nobody twice");
  assert.equal(windowPhase({ status: "completed", startsAt: new Date(0), endsAt: new Date(1) }), "ended");
  assert.match(formatBaghdad(new Date()), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, "the local time is written out for Baghdad");
  summary.worker = { firstPass: tick1, secondPass: tick2 };

  // ============================================================
  // 8. Incidents.
  // ============================================================
  const incident = await request("/platform/incidents", { method: "POST", token: ownerToken, body: { title: "تأخّر مزامنة الناقلين", severity: "major", publicMessage: "تسليم الطرود للناقل متوقّف مؤقّتاً — نعمل على الحلّ", affects: ["delivery.handover"], blocks: true } });
  assert.equal(incident.status, 201, JSON.stringify(incident.payload));
  assert.equal(incident.payload.incident.status, "investigating");
  assert.equal(incident.payload.incident.updates.length, 1, "opening writes the first update");
  const blockedA = await couriersA();
  assert.equal(blockedA.status, 423);
  assert.equal(blockedA.payload.error.state, "TEMPORARILY_UNAVAILABLE");
  assert.equal(blockedA.payload.error.source, "incident");
  assert.equal(blockedA.payload.error.message, "تسليم الطرود للناقل متوقّف مؤقّتاً — نعمل على الحلّ");
  assert.equal((await couriersB()).status, 423, "an incident is platform-wide");
  assert.equal((await manifestA()).status, 200, "what the incident does not name stays open");
  const notice = await request("/platform/incidents", { method: "POST", token: ownerToken, body: { title: "بطء في التقارير", publicMessage: "التقارير أبطأ من المعتاد", affects: ["data.analytics"] } });
  assert.equal(notice.status, 201, JSON.stringify(notice.payload));
  assert.equal(notice.payload.incident.blocks, false);
  assert.equal((await request(`${merchantA}/marketing/analytics/summary`, { token: tokenA })).status, 200, "a non-blocking incident closes nothing");
  const notices3 = await noticesA();
  assert.ok(notices3.payload.incidents.some((i) => i.id === incident.payload.incident.id && i.blocks === true));
  assert.ok(notices3.payload.incidents.some((i) => i.id === notice.payload.incident.id && i.blocks === false));
  const identified = await request(`/platform/incidents/${incident.payload.incident.id}/updates`, { method: "POST", token: ownerToken, body: { status: "identified", message: "السبب مفتاح API منتهٍ عند الناقل" } });
  assert.equal(identified.status, 200, JSON.stringify(identified.payload));
  assert.equal(identified.payload.incident.updates.length, 2);
  assert.equal((await couriersA()).status, 423, "still blocking while open");
  const resolved = await request(`/platform/incidents/${incident.payload.incident.id}/updates`, { method: "POST", token: ownerToken, body: { status: "resolved", message: "جُدّد المفتاح وعادت المزامنة" } });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.payload.incident.status, "resolved");
  assert.ok(resolved.payload.incident.resolvedAt);
  assert.equal((await couriersA()).status, 200, "resolving reopens");
  assert.equal((await request(`/platform/incidents/${incident.payload.incident.id}/updates`, { method: "POST", token: ownerToken, body: { status: "monitoring", message: "بعد الحلّ" } })).status, 409, "a resolved incident refuses updates");
  assert.equal((await request("/platform/incidents", { method: "POST", token: ownerToken, body: { title: "x", publicMessage: "قصير" } })).status, 422);
  assert.equal((await request("/platform/incidents", { method: "POST", token: ownerToken, body: { title: "رموز مجهولة", publicMessage: "رسالة صالحة", affects: ["pharmacy"] } })).status, 422);
  assert.equal((await request(`/platform/incidents/${incident.payload.incident.id}/updates`, { method: "POST", token: tokenA, body: { status: "resolved", message: "تاجر يحاول" } })).status, 403);
  const all = await request("/platform/incidents?open=false", { token: ownerToken });
  assert.ok(all.payload.incidents.some((i) => i.id === incident.payload.incident.id && i.status === "resolved"));
  assert.equal((await request(`/platform/incidents/${notice.payload.incident.id}/updates`, { method: "POST", token: ownerToken, body: { status: "resolved", message: "عادت السرعة" } })).status, 200);
  summary.incidents = { blocking: 423, notice: 200, resolved: 200, afterResolve: 409 };

  // ============================================================
  // 9. A platform-wide window shows in the shopper's config.
  // ============================================================
  const wide = await request("/platform/maintenance-windows", { method: "POST", token: ownerToken, body: { scope: "platform", startsAt: minutes(-1), endsAt: minutes(20), messageAr: "صيانة عامّة قصيرة — قد تتأخّر بعض الصفحات" } });
  assert.equal(wide.status, 201, JSON.stringify(wide.payload));
  const configWide = await publicConfigA();
  assert.equal(configWide.status, 200, "the shell config answers — the shop itself is open");
  assert.equal(configWide.payload.availability.platform?.maintenance?.message, "صيانة عامّة قصيرة — قد تتأخّر بعض الصفحات");
  assert.equal(configWide.payload.availability.store.status, "active");
  assert.equal((await request(`/platform/maintenance-windows/${wide.payload.window.id}`, { method: "DELETE", token: ownerToken })).status, 200);
  assert.equal((await publicConfigA()).payload.availability.platform, undefined, "the strip leaves with the window");
  summary.platformStrip = "shown while live, gone after";

  // ============================================================
  // 10. Audit.
  // ============================================================
  const auditAfter = await auditCount();
  assert.ok(auditAfter - auditBefore >= 14, `platform acts leave audit rows: ${auditAfter - auditBefore}`);
  summary.audit = auditAfter - auditBefore;

  console.log(JSON.stringify({ status: "passed", ...summary }, null, 2));
} finally {
  await sweepMaintenanceMail();
  server.close();
  await prisma.$disconnect();
}
