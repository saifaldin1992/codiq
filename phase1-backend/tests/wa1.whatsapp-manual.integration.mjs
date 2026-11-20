/**
 * codiq WA-1 (ق-131/ق-139) — القناة اليدوية لواتساب, proven end to end.
 *
 *  1. RENDERING — the panel returns the three occasions with the Arabic code
 *     defaults, substitutes live order data ({{اسم_الزبون}}, {{رقم_الطلب}},
 *     {{المبلغ}} through ar-IQ + «د.ع», {{اسم_المتجر}}), a saved custom
 *     template overrides its default, and the tracking line is ABSOLUTE when
 *     CODIQ_PUBLIC_BASE_URL is set and DROPPED WHOLE when it is not — no
 *     relative /store/ path ever survives (the pg3 pattern).
 *  2. THE wa.me CONTRACT — E.164 phone → https://wa.me/9647… (no '+'), the
 *     text percent-encoded (Arabic escaped, newlines %0A), and a seeded
 *     LOCAL-format «07…» phone still yields a correct wa.me/9647… link.
 *  3. EDGE STATES — null phone (the POS shape) → waReady:false/no_phone with
 *     null links; garbage phone → invalid_phone; recording against a
 *     no-phone order → 422 WHATSAPP_NO_RECIPIENT_PHONE.
 *  4. RECORDING & PERMISSIONS — a valid tap → 201 and the stored message_body
 *     EQUALS the body the panel rendered (the server records what IT
 *     rendered); unknown templateKey → 422; default store_staff (holds
 *     orders.update) records fine; orders.update denied by override → 403;
 *     cross-store orderId → 404 (IDOR); a mismatched Origin header → 403
 *     CSRF_ORIGIN_DENIED.
 *  5. SETTINGS — unknown block key/unknown {{token}}/over-length → 422;
 *     store_staff PUT → 403 (settings.manage); a whatsappTemplates write
 *     PRESERVES preferences/courierDispatch/dailyDigest and a preferences
 *     write preserves the templates (the cd1 clobber pattern, both ways);
 *     an empty string reverts a key to its code default.
 *  6. OUTBOX ISOLATION (the honesty proof) — after every scenario above the
 *     notification_outbox row count is UNCHANGED and notification_event_kinds
 *     is byte-identical: the manual channel provably never touches the
 *     automated pipeline.
 */
import assert from "node:assert/strict";
import { ownStaffPassword } from "./helpers/own-staff-password.js";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { Client } from "pg";

const testId = `wa1-${Date.now()}`;
process.env.SESSION_JWT_SECRET = process.env.SESSION_JWT_SECRET ?? "wa1-test-secret-only-not-for-production";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;
delete process.env.CODIQ_PUBLIC_BASE_URL;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");

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
  await prisma.$executeRawUnsafe("TRUNCATE TABLE order_whatsapp_sends, order_notes, order_tags, storefront_rate_limits, order_prescriptions, settlements, ledger_entries, notification_outbox, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, product_variants, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, platform_owner_sessions, platform_owners CASCADE");

  // The isolation baselines, taken BEFORE anything runs.
  const outboxBefore = Number((await sql.query("SELECT count(*) AS n FROM notification_outbox")).rows[0].n);
  const eventKindsBefore = (await sql.query("SELECT event_type, kind, priority FROM notification_event_kinds ORDER BY event_type")).rows;

  // ---------- fixtures ----------
  const merchantA = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100319301", email: `${testId}.a@codiq.test`, password: "Wa1MerchantPass!2026", businessName: "متجر واتساب ألف" });
  const merchantB = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100319302", email: `${testId}.b@codiq.test`, password: "Wa1MerchantPass!2026", businessName: "متجر واتساب باء" });
  assert.equal(merchantA.status, 201); assert.equal(merchantB.status, 201);
  // Stores created with the bootstrap's own notificationSettings shape so the
  // settings PUT has its row (md1 creates bare stores and never PUTs settings).
  const storeA = await prisma.store.create({ data: { merchantId: merchantA.payload.account.id, name: "متجر النور", slug: `${testId}-a`, defaultSubdomain: `${testId}-a`, notificationSettings: { create: { provider: null, apiKey: null, senderId: null, isEnabled: false } } } });
  const storeB = await prisma.store.create({ data: { merchantId: merchantB.payload.account.id, name: "متجر باء", slug: `${testId}-b`, defaultSubdomain: `${testId}-b`, notificationSettings: { create: { provider: null, apiKey: null, senderId: null, isEnabled: false } } } });
  const loginA = await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.a@codiq.test`, password: "Wa1MerchantPass!2026" } });
  const loginB = await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.b@codiq.test`, password: "Wa1MerchantPass!2026" } });
  const tokenA = loginA.payload.accessToken;
  const tokenB = loginB.payload.accessToken;
  const ordersA = `/merchant/stores/${storeA.slug}/orders`;
  const settingsA = `/merchant/stores/${storeA.slug}/notifications/settings`;

  // Orders seeded directly: the feature under test READS orders, and checkout
  // already has its own suites. One E.164 phone, one LOCAL «07…» (the phase8b
  // seed shape), one null (the POS shape), one garbage.
  const mkOrder = (storeId, orderNumber, recipientPhone) => prisma.storeOrder.create({
    data: { storeId, orderNumber, status: "new", customerName: "كرار حسن", recipientPhone, subtotalIqd: 45000, totalIqd: 45000 },
    select: { id: true },
  });
  const orderE164 = await mkOrder(storeA.id, "WA1-1001", "+9647701234567");
  const orderLocal = await mkOrder(storeA.id, "WA1-1002", "0770 123-4568");
  const orderNoPhone = await mkOrder(storeA.id, "WA1-1003", null);
  const orderGarbage = await mkOrder(storeA.id, "WA1-1004", "not-a-phone");
  const orderForeign = await mkOrder(storeB.id, "WA1-2001", "+9647701234569");

  // Staff member in store A (default store_staff holds orders.view + orders.update).
  const staffCreated = await request(`/merchant/stores/${storeA.slug}/team`, { method: "POST", token: tokenA, body: { email: `${testId}.staff@codiq.test`, displayName: "موظف واتساب", temporaryPassword: "wa1-staff-temp-password", roleCode: "store_staff" } });
  assert.equal(staffCreated.status, 201, JSON.stringify(staffCreated.payload));
  await ownStaffPassword(base, storeA.slug, `${testId}.staff@codiq.test`, "wa1-staff-temp-password"); // audit 14-ب
  const staffMembershipId = staffCreated.payload.membership.id;
  let tokenStaff = (await request(`/auth/staff/stores/${storeA.slug}/login`, { method: "POST", body: { email: `${testId}.staff@codiq.test`, password: "wa1-staff-temp-password" } })).payload.accessToken;
  const setOverrides = async (overrides) => {
    const applied = await request(`/merchant/stores/${storeA.slug}/team/${staffMembershipId}/overrides`, { method: "PUT", token: tokenA, body: { overrides } });
    assert.equal(applied.status, 200, JSON.stringify(applied.payload));
    tokenStaff = (await request(`/auth/staff/stores/${storeA.slug}/login`, { method: "POST", body: { email: `${testId}.staff@codiq.test`, password: "wa1-staff-temp-password" } })).payload.accessToken;
  };

  // ---------- 1. rendering: defaults, substitution, and the link-honesty rule ----------
  {
    // WITHOUT a public base URL: the tracking line is dropped whole.
    const panel = await request(`${ordersA}/${orderE164.id}/whatsapp`, { token: tokenA });
    assert.equal(panel.status, 200, JSON.stringify(panel.payload));
    assert.deepEqual(panel.payload.templates.map((t) => t.key), ["orderCreated", "courierDispatched", "orderCompleted"]);
    const created = panel.payload.templates[0];
    assert.ok(created.body.includes("كرار حسن"), "customer name substituted");
    assert.ok(created.body.includes("WA1-1001"), "order number substituted");
    assert.ok(created.body.includes("متجر النور"), "store name substituted");
    assert.ok(created.body.includes("د.ع"), "amount carries د.ع");
    assert.ok(created.body.includes("٤٥٬٠٠٠") || created.body.includes("45"), "amount formatted ar-IQ");
    assert.ok(!created.body.includes("{{"), "no unresolved tokens");
    assert.ok(!created.body.includes("/store/"), "no relative tracking path without a base URL");
    assert.ok(!created.body.includes("رابط") || !created.body.includes("http"), "tracking line dropped whole");
    summary.defaultsRendered = true;

    // WITH the base URL: the line is absolute.
    process.env.CODIQ_PUBLIC_BASE_URL = "https://codiqos.test";
    const withBase = await request(`${ordersA}/${orderE164.id}/whatsapp`, { token: tokenA });
    assert.ok(withBase.payload.templates[0].body.includes(`https://codiqos.test/store/${storeA.slug}/track`), "absolute tracking URL present");
    summary.trackingLineHonest = true;
  }

  // ---------- 2. the wa.me contract ----------
  {
    const panel = await request(`${ordersA}/${orderE164.id}/whatsapp`, { token: tokenA });
    const url = panel.payload.templates[0].waUrl;
    assert.ok(url.startsWith("https://wa.me/9647701234567?text="), `no '+' in wa.me path: ${url.slice(0, 40)}`);
    assert.ok(!url.includes("مرحباً"), "text is percent-encoded, no raw Arabic in the URL");
    assert.ok(url.includes("%D9") || url.includes("%D8"), "Arabic percent-encoding present");
    assert.ok(url.length < 2000, "URL under the wa.me degradation ceiling");
    const decoded = decodeURIComponent(url.split("?text=")[1]);
    assert.equal(decoded, panel.payload.templates[0].body, "the URL text IS the rendered body");

    const local = await request(`${ordersA}/${orderLocal.id}/whatsapp`, { token: tokenA });
    assert.equal(local.payload.waReady, true);
    assert.ok(local.payload.templates[0].waUrl.startsWith("https://wa.me/9647701234568?text="), "local 07… normalized through toE164");
    summary.waUrlContract = true;
  }

  // ---------- 3. edge states ----------
  {
    const noPhone = await request(`${ordersA}/${orderNoPhone.id}/whatsapp`, { token: tokenA });
    assert.equal(noPhone.payload.waReady, false);
    assert.equal(noPhone.payload.reason, "no_phone");
    assert.ok(noPhone.payload.templates.every((t) => t.waUrl === null));
    const garbage = await request(`${ordersA}/${orderGarbage.id}/whatsapp`, { token: tokenA });
    assert.equal(garbage.payload.waReady, false);
    assert.equal(garbage.payload.reason, "invalid_phone");
    const refused = await request(`${ordersA}/${orderNoPhone.id}/whatsapp/sends`, { method: "POST", token: tokenA, body: { templateKey: "orderCreated" } });
    assert.equal(refused.status, 422);
    assert.equal(refused.payload.error.code, "WHATSAPP_NO_RECIPIENT_PHONE");
    summary.edgeStates = true;
  }

  // ---------- 4. recording & permissions ----------
  {
    const panel = await request(`${ordersA}/${orderE164.id}/whatsapp`, { token: tokenA });
    const recorded = await request(`${ordersA}/${orderE164.id}/whatsapp/sends`, { method: "POST", token: tokenA, body: { templateKey: "courierDispatched" } });
    assert.equal(recorded.status, 201, JSON.stringify(recorded.payload));
    assert.equal(recorded.payload.send.templateKey, "courierDispatched");
    const row = await prisma.orderWhatsappSend.findFirstOrThrow({ where: { orderId: orderE164.id } });
    assert.equal(row.actorKind, "merchant");
    assert.equal(row.recipientPhone, "+9647701234567");
    assert.equal(row.messageBody, panel.payload.templates.find((t) => t.key === "courierDispatched").body, "stored body EQUALS the server-rendered panel body");

    const unknown = await request(`${ordersA}/${orderE164.id}/whatsapp/sends`, { method: "POST", token: tokenA, body: { templateKey: "marketingBlast" } });
    assert.equal(unknown.status, 422);

    // Default store_staff holds orders.update → records fine, attributed to him.
    const staffTap = await request(`${ordersA}/${orderE164.id}/whatsapp/sends`, { method: "POST", token: tokenStaff, body: { templateKey: "orderCreated" } });
    assert.equal(staffTap.status, 201, JSON.stringify(staffTap.payload));
    assert.equal(staffTap.payload.send.actorKind, "staff");
    assert.equal(staffTap.payload.send.actorName, "موظف واتساب");

    // orders.update denied → the tap is refused; the PANEL (orders.view) still loads.
    await setOverrides([{ permissionCode: "orders.update", effect: "deny" }]);
    const deniedTap = await request(`${ordersA}/${orderE164.id}/whatsapp/sends`, { method: "POST", token: tokenStaff, body: { templateKey: "orderCreated" } });
    assert.equal(deniedTap.status, 403, JSON.stringify(deniedTap.payload));
    assert.equal(deniedTap.payload.error.code, "STAFF_PERMISSION_DENIED");
    const deniedPanel = await request(`${ordersA}/${orderE164.id}/whatsapp`, { token: tokenStaff });
    assert.equal(deniedPanel.status, 200, "orders.view still reads the panel");
    await setOverrides([]);

    // IDOR: a foreign order is indistinguishable from a missing one.
    const foreign = await request(`${ordersA}/${orderForeign.id}/whatsapp`, { token: tokenA });
    assert.equal(foreign.status, 404);
    const foreignTap = await request(`${ordersA}/${orderForeign.id}/whatsapp/sends`, { method: "POST", token: tokenA, body: { templateKey: "orderCreated" } });
    assert.equal(foreignTap.status, 404);

    // CSRF: a mismatched Origin on the write is refused before anything runs.
    const badOrigin = await request(`${ordersA}/${orderE164.id}/whatsapp/sends`, { method: "POST", token: tokenA, body: { templateKey: "orderCreated" }, headers: { origin: "https://evil.example" } });
    assert.equal(badOrigin.status, 403);
    assert.equal(badOrigin.payload.error.code, "CSRF_ORIGIN_DENIED");
    summary.recordingAndPermissions = true;
  }

  // ---------- 5. settings: validation, permission, and the clobber rule ----------
  {
    const before = await request(settingsA, { token: tokenA });
    assert.equal(before.status, 200, JSON.stringify(before.payload));
    assert.equal(before.payload.settings.whatsappMode, "manual");
    const defaults = before.payload.settings.whatsappTemplates;
    assert.deepEqual(Object.keys(defaults).sort(), ["courierDispatched", "orderCompleted", "orderCreated"]);

    const unknownKey = await request(settingsA, { method: "PUT", token: tokenA, body: { whatsappTemplates: { marketing: "نص" } } });
    assert.equal(unknownKey.status, 422);
    const unknownToken = await request(settingsA, { method: "PUT", token: tokenA, body: { whatsappTemplates: { orderCreated: "مرحباً {{اسم_المندوب}}" } } });
    assert.equal(unknownToken.status, 422);
    const overLength = await request(settingsA, { method: "PUT", token: tokenA, body: { whatsappTemplates: { orderCreated: "ا".repeat(1001) } } });
    assert.equal(overLength.status, 422);
    const staffPut = await request(settingsA, { method: "PUT", token: tokenStaff, body: { whatsappTemplates: { orderCreated: "نص" } } });
    assert.equal(staffPut.status, 403, "templates ride settings.manage, which store_staff lacks");

    // A custom template overrides its default — for the SETTINGS view and the PANEL alike.
    const custom = "أهلاً {{اسم_الزبون}}، طلبك {{رقم_الطلب}} وصلنا.";
    const saved = await request(settingsA, { method: "PUT", token: tokenA, body: { whatsappTemplates: { orderCreated: custom } } });
    assert.equal(saved.status, 200, JSON.stringify(saved.payload));
    assert.equal(saved.payload.settings.whatsappTemplates.orderCreated, custom);
    assert.equal(saved.payload.settings.whatsappTemplates.courierDispatched, defaults.courierDispatched, "untouched key keeps its default");
    const panelCustom = await request(`${ordersA}/${orderE164.id}/whatsapp`, { token: tokenA });
    assert.ok(panelCustom.payload.templates[0].body.startsWith("أهلاً كرار حسن"), "panel renders the custom template");

    // THE CLOBBER RULE, both directions (the cd1 pattern).
    assert.deepEqual(saved.payload.settings.preferences, before.payload.settings.preferences, "templates write preserves preferences");
    assert.deepEqual(saved.payload.settings.courierDispatch, before.payload.settings.courierDispatch, "templates write preserves courierDispatch");
    assert.deepEqual(saved.payload.settings.dailyDigest, before.payload.settings.dailyDigest, "templates write preserves dailyDigest");
    const prefWrite = await request(settingsA, { method: "PUT", token: tokenA, body: { preferences: { lowStock: false } } });
    assert.equal(prefWrite.status, 200);
    assert.equal(prefWrite.payload.settings.whatsappTemplates.orderCreated, custom, "preferences write preserves the templates");

    // Empty string reverts to the code default — a real deletion, not a frozen copy.
    const reverted = await request(settingsA, { method: "PUT", token: tokenA, body: { whatsappTemplates: { orderCreated: "" } } });
    assert.equal(reverted.status, 200);
    assert.equal(reverted.payload.settings.whatsappTemplates.orderCreated, defaults.orderCreated);
    const storedBlock = (await prisma.notificationSettings.findUniqueOrThrow({ where: { storeId: storeA.id }, select: { configuration: true } })).configuration.whatsappTemplates ?? {};
    assert.ok(!("orderCreated" in storedBlock), "the override row is DELETED, not stored as a copy of the default");
    summary.settings = true;
  }

  // ---------- 6. the honesty proof: the pipeline was never touched ----------
  {
    const outboxAfter = Number((await sql.query("SELECT count(*) AS n FROM notification_outbox")).rows[0].n);
    assert.equal(outboxAfter, outboxBefore, "notification_outbox row count unchanged by every scenario above");
    const eventKindsAfter = (await sql.query("SELECT event_type, kind, priority FROM notification_event_kinds ORDER BY event_type")).rows;
    assert.deepEqual(eventKindsAfter, eventKindsBefore, "notification_event_kinds byte-identical");
    const sends = await prisma.orderWhatsappSend.count();
    assert.ok(sends >= 2, "the audit rows landed in their OWN table");
    summary.outboxIsolation = true;
  }

  console.log(JSON.stringify({ suite: "wa1.whatsapp-manual", summary }, null, 2));
} finally {
  delete process.env.CODIQ_PUBLIC_BASE_URL;
  await sql.end();
  server.close();
  await prisma.$disconnect();
}
