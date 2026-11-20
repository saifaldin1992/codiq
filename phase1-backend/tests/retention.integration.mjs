/**
 * codiq D-39 «تنظيف الجداول التشغيلية» + D-46 «حجوزات تنتهي صلاحيتها» — proven
 * end to end against a real PostgreSQL through the real HTTP app.
 *
 * D-46 (the reservation TTL — owner decision 8):
 *  1. THE CLOCK IS THE DATABASE'S: a reservation minted by a real checkout
 *     comes back with `expires_at - created_at` equal to RESERVATION_TTL_HOURS,
 *     so the column DEFAULT and the TypeScript constant cannot drift apart
 *     without this line failing.
 *  2. THE BOUNDARY: a 73 h reservation on a `new` order is released — status
 *     'released', releaseReason 'expired' — WITH its own inventory_movement
 *     row; a 71 h one beside it is untouched. One sweep, both assertions.
 *  3. NO PHANTOM STOCK (the ق-140 fork): stockQuantity is UNCHANGED by the
 *     release, because these units never left it. What changes is
 *     availability — the storefront variant flips isAvailable false → true.
 *     The movement row carries delta 0, which is the true number.
 *  4. OUT OF SCOPE MEANS OUT OF SCOPE: a reservation on a `processing` order,
 *     aged 100 days, is not touched — not released, no movement.
 *  5. IDEMPOTENT: the second sweep releases 0, writes no second movement, and
 *     leaves releasedAt exactly as the first left it.
 *  6. THE RACE: a merchant cancelling the order in the same instant as the
 *     sweep leaves EXACTLY ONE release — one releasedAt, one reason, and a
 *     movement row if and only if the job was the winner.
 *
 * D-39 (operational retention — owner decision 7):
 *  7. EVERY WINDOW, BOTH SIDES OF ITS EDGE: for each of the six windows a row
 *     just past the cutoff dies and a row just inside it lives — 7 d rate
 *     limits, 30 d dead sessions across ALL FIVE session tables, 90 d
 *     sent/skipped outbox, 365 d dead_letter outbox, 30 d guest carts, 90 d
 *     checkout_requests.
 *  8. AND NOTHING ELSE: a live session, a `pending` outbox row aged 400 days,
 *     a customer cart, a merged cart, a converted cart and a guest cart that
 *     another cart still points at all survive.
 *  9. BATCHING: eight expired rate-limit rows swept with batchSize 3 — all
 *     eight go, which cannot happen in a single batch.
 * 10. THE AUDIT AND LEDGER TABLES ARE NEVER SWEPT: ledger_entries,
 *     platform_audit_events, store_audit_events, order_status_events and
 *     inventory_movements are seeded with rows aged 400 days — past EVERY
 *     window — and their counts are identical before and after the sweep.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { Client } from "pg";

const testId = `ret-${Date.now()}`;
process.env.SESSION_JWT_SECRET = process.env.SESSION_JWT_SECRET ?? "retention-test-secret-only-not-for-production";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { RETENTION_DAYS, RESERVATION_TTL_HOURS, NEVER_AUTO_DELETED } = await import("../src/services/retention.ts");
const { sweepOperationalRetention } = await import("../src/services/retention-job.ts");
const { releaseExpiredReservations, RESERVATION_EXPIRY_MOVEMENT_REASON, RESERVATION_EXPIRY_RELEASE_REASON } =
  await import("../src/services/reservation-expiry-job.ts");

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

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(Date.now() - ms);
const ahead = (ms) => new Date(Date.now() + ms);

const summary = {};

try {
  await prisma.$executeRawUnsafe(
    "TRUNCATE TABLE order_whatsapp_sends, order_notes, order_tags, storefront_rate_limits, order_prescriptions, settlements, ledger_entries, notification_outbox, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, product_variants, products, product_categories, store_audit_events, customer_sessions, customers, merchant_sessions, stores, merchants, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, platform_staff_sessions, platform_staff_permission_overrides, platform_staff, platform_audit_events, platform_owner_sessions, platform_owners CASCADE",
  );

  // ─────────────────────────── fixtures ───────────────────────────
  const merchant = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100519401", email: `${testId}.m@codiq.test`, password: "RetMerchantPass!2026", businessName: "متجر التنظيف" });
  assert.equal(merchant.status, 201, JSON.stringify(merchant.payload));
  const store = await prisma.store.create({
    data: { merchantId: merchant.payload.account.id, name: "متجر التنظيف", slug: `${testId}-s`, defaultSubdomain: `${testId}-s`, notificationSettings: { create: { provider: null, apiKey: null, senderId: null, isEnabled: true } } },
  });
  await prisma.deliveryRate.create({ data: { storeId: store.id, governorate: "Baghdad", amountIqd: 2500, isEnabled: true } });
  const token = (await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.m@codiq.test`, password: "RetMerchantPass!2026" } })).payload.accessToken;
  const catalog = `/merchant/stores/${store.slug}/catalog`;
  const orders = `/merchant/stores/${store.slug}/orders`;

  const productCreated = await request(`${catalog}/products`, {
    method: "POST", token,
    body: { sku: "RET-BOX", name: "صندوق الاختبار", priceIqd: 10000, stockQuantity: 0, lowStockThreshold: 0 },
  });
  assert.equal(productCreated.status, 201, JSON.stringify(productCreated.payload));
  const productId = productCreated.payload.product.id;

  /**
   * One variant per scenario. `inventory_movements` carries no order_id, so a
   * shared variant would make «did THIS release write a movement?»
   * unanswerable — the variant is the only grain that separates them.
   * stockQuantity 2 with a 2-unit order drives availability to exactly zero,
   * which is what makes the isAvailable flip in scenario 3 meaningful.
   */
  async function makeVariant(suffix, name) {
    const created = await request(`${catalog}/products/${productId}/variants`, {
      method: "POST", token,
      body: { sku: `RET-BOX-${suffix}`, name, priceIqd: 10000, stockQuantity: 2, lowStockThreshold: 0 },
    });
    assert.equal(created.status, 201, JSON.stringify(created.payload));
    return created.payload.variant.id;
  }
  const vExpired = await makeVariant("EXP", "المنتهي");
  const vFresh = await makeVariant("FRESH", "الطازج");
  const vProcessing = await makeVariant("PROC", "قيد التجهيز");
  const vRace = await makeVariant("RACE", "السباق");
  const vWeekend = await makeVariant("WKND", "طلب نهاية الأسبوع");

  const phone = "+96477067" + String(Date.now()).slice(-5);
  const registered = await request(`/store/${store.slug}/account/register`, { method: "POST", body: { phone, password: "RetCustomerPass!2026", fullName: "زبون التنظيف" } });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const customerToken = registered.payload.accessToken;
  const customerId = registered.payload.account.id;
  const address = await request(`/store/${store.slug}/account/addresses`, {
    method: "POST", token: customerToken,
    body: { recipientName: "زبون التنظيف", fullAddress: "شارع 2", city: "Baghdad", governorate: "Baghdad", phoneContact: phone, isDefault: true },
  });
  const addressId = address.payload.address.id;

  let checkoutKey = 0;
  async function placeOrder(variantId, quantity) {
    const added = await request(`/store/${store.slug}/cart/items`, { method: "POST", token: customerToken, body: { variantId, quantity } });
    assert.equal(added.status, 200, JSON.stringify(added.payload));
    checkoutKey += 1;
    const checkedOut = await request(`/store/${store.slug}/checkout`, {
      method: "POST", token: customerToken,
      headers: { "idempotency-key": `retention-idempotency-key-${String(checkoutKey).padStart(6, "0")}` },
      body: { cartVersion: added.payload.cart.version, addressId, paymentMethodCode: "cod" },
    });
    assert.equal(checkedOut.status, 201, JSON.stringify(checkedOut.payload));
    return checkedOut.payload.order.id;
  }

  const reservationFor = (orderId) => prisma.inventoryReservation.findFirstOrThrow({ where: { orderId } });
  const stockOf = async (variantId) => (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId }, select: { stockQuantity: true } })).stockQuantity;
  const expiryMovements = (variantId) => prisma.inventoryMovement.count({ where: { variantId, reason: RESERVATION_EXPIRY_MOVEMENT_REASON } });
  /** Drive the reservation's clock directly — the job reads `expires_at`, nothing else. */
  const setExpiry = (orderId, interval) =>
    sql.query(`UPDATE inventory_reservations SET expires_at = now() + interval '${interval}' WHERE order_id = $1`, [orderId]);
  const variantIsAvailable = async (variantId) => {
    const page = await request(`/store/${store.slug}/products/${productId}`);
    assert.equal(page.status, 200, JSON.stringify(page.payload));
    return page.payload.product.variants.find((variant) => variant.id === variantId)?.isAvailable;
  };

  // ═══════════════ 1. the clock belongs to the database ═══════════════
  const orderExpired = await placeOrder(vExpired, 2);
  {
    const minted = await reservationFor(orderExpired);
    const hours = (minted.expiresAt.valueOf() - minted.createdAt.valueOf()) / HOUR;
    assert.ok(
      Math.abs(hours - RESERVATION_TTL_HOURS) < 0.02,
      `the column DEFAULT and RESERVATION_TTL_HOURS disagree: the database stamped ${hours} h, the constant says ${RESERVATION_TTL_HOURS} h`,
    );
    assert.equal(minted.status, "active");
    assert.equal(minted.releaseReason, null);
    summary.ttlHoursFromDatabase = hours;
  }

  // ═══════════════ 2 + 3. the boundary, and no phantom stock ═══════════════
  const orderFresh = await placeOrder(vFresh, 2);
  await setExpiry(orderExpired, "-1 hour");  // 73 h old — past the TTL
  await setExpiry(orderFresh, "1 hour");     // 71 h old — one hour short

  assert.equal(await variantIsAvailable(vExpired), false, "2 units reserved out of 2 leaves nothing sellable");
  const stockBefore = await stockOf(vExpired);

  const firstSweep = await releaseExpiredReservations({ now: new Date() });
  assert.equal(firstSweep.released, 1, "exactly the 73 h reservation");
  assert.equal(firstSweep.skipped, 0);

  const releasedRow = await reservationFor(orderExpired);
  assert.equal(releasedRow.status, "released");
  assert.equal(releasedRow.releaseReason, RESERVATION_EXPIRY_RELEASE_REASON);
  assert.ok(releasedRow.releasedAt, "releasedAt is stamped");
  const untouchedRow = await reservationFor(orderFresh);
  assert.equal(untouchedRow.status, "active", "71 h is inside the window — the sweep must not touch it");
  assert.equal(untouchedRow.releaseReason, null);
  assert.equal(untouchedRow.releasedAt, null);

  assert.equal(await expiryMovements(vExpired), 1, "the release writes its own movement row");
  assert.equal(await expiryMovements(vFresh), 0);
  const movement = await prisma.inventoryMovement.findFirstOrThrow({ where: { variantId: vExpired, reason: RESERVATION_EXPIRY_MOVEMENT_REASON } });
  assert.equal(movement.delta, 0, "ق-140: these units never left stockQuantity, so the honest delta is 0");
  assert.equal(await stockOf(vExpired), stockBefore, "releasing a never-deducted reservation must NOT increment stock");
  assert.equal(await variantIsAvailable(vExpired), true, "what the release restores is AVAILABILITY");
  assert.equal(await variantIsAvailable(vFresh), false, "the 71 h reservation still hides its units");
  summary.boundary = { released: firstSweep.released, stockUnchanged: true, movementDelta: movement.delta };

  // ═══════════════ 4. a non-`new` order is out of scope at any age ═══════════════
  const orderProcessing = await placeOrder(vProcessing, 2);
  {
    const current = await request(`${orders}/${orderProcessing}`, { token });
    const moved = await request(`${orders}/${orderProcessing}/status`, { method: "POST", token, body: { toStatus: "processing", expectedVersion: current.payload.order.version } });
    assert.equal(moved.status, 200, JSON.stringify(moved.payload));
  }
  await setExpiry(orderProcessing, "-100 days");
  const processingSweep = await releaseExpiredReservations({ now: new Date() });
  assert.equal(processingSweep.released, 0, "a `processing` order keeps its stock reserved however old the row is");
  const processingRow = await reservationFor(orderProcessing);
  assert.equal(processingRow.status, "active");
  assert.equal(processingRow.releasedAt, null);
  assert.equal(await expiryMovements(vProcessing), 0);
  summary.nonNewUntouched = true;

  // ═══════════════ 5. running the job twice releases exactly once ═══════════════
  {
    const releasedAtAfterFirst = (await reservationFor(orderExpired)).releasedAt.valueOf();
    const secondSweep = await releaseExpiredReservations({ now: new Date() });
    assert.equal(secondSweep.released, 0, "nothing left to release");
    assert.equal(await expiryMovements(vExpired), 1, "no second movement row");
    assert.equal((await reservationFor(orderExpired)).releasedAt.valueOf(), releasedAtAfterFirst, "releasedAt is not restamped");
    summary.twiceReleasesOnce = true;
  }

  // ═══════════════ 5-ب (ق-193). THE WEEKEND ORDER: swept, then completed ═══════════════
  //
  // D-46's sweep is right to release an order still `new` after 72 h. What was
  // wrong is what happened NEXT: `settleStorefrontReservations` only ever looked
  // at `status === "active"`, so the merchant walked the order to `completed` on
  // Monday, the courier collected the cash — and stock was never decremented. No
  // error, no movement row. Phantom stock, one order per slow weekend, compounding
  // until a physical count.
  //
  // Three days is ordinary fulfilment for cash-on-delivery in Iraq, not neglect,
  // which is what made this the most expensive gap in the stock path.
  {
    const orderWeekend = await placeOrder(vWeekend, 2);
    const stockBefore = await stockOf(vWeekend);
    await setExpiry(orderWeekend, "-1 hour");
    const swept = await releaseExpiredReservations({ now: new Date() });
    assert.ok(swept.released >= 1, "the sweep must really have released it, or this proves nothing");
    assert.equal((await reservationFor(orderWeekend)).status, "released", "…and the order is now carrying a lapsed reservation");
    assert.equal(await stockOf(vWeekend), stockBefore, "ق-193: releasing must not touch stock — the units were never deducted");

    let version = (await request(`${orders}/${orderWeekend}`, { token })).payload.order.version;
    for (const toStatus of ["processing", "preparation", "out_for_delivery", "completed"]) {
      const moved = await request(`${orders}/${orderWeekend}/status`, { method: "POST", token, body: { toStatus, expectedVersion: version } });
      assert.equal(moved.status, 200, `ق-193: the merchant must be able to work a swept order — ${toStatus}: ${JSON.stringify(moved.payload)}`);
      version = moved.payload.order.version;
    }

    assert.equal(await stockOf(vWeekend), stockBefore - 2, "ق-193: the goods left the shop, so the stock leaves the books — a lapsed reservation is still a sale");
    const movement = await prisma.inventoryMovement.findFirst({ where: { variantId: vWeekend, reason: "storefront_cod_completed" }, select: { delta: true } });
    assert.equal(movement?.delta, -2, "ق-193: …and the merchant's inventory log explains where they went");
    assert.equal((await reservationFor(orderWeekend)).status, "consumed", "ق-193: the reservation is consumed, so a second completion cannot decrement twice");
    summary.sweptThenCompletedStillCostsStock = { released: true, decremented: 2 };
  }

  // ═══════════════ 6. a human cancel racing the sweep ═══════════════
  {
    const orderRace = await placeOrder(vRace, 2);
    await setExpiry(orderRace, "-1 hour");
    const current = await request(`${orders}/${orderRace}`, { token });
    // Fired together on purpose: both writers contend for the same order row and
    // then the same reservation row. Whoever loses the guarded updateMany must
    // write nothing at all.
    const [cancelled, raced] = await Promise.all([
      request(`${orders}/${orderRace}/status`, { method: "POST", token, body: { toStatus: "cancelled", expectedVersion: current.payload.order.version } }),
      releaseExpiredReservations({ now: new Date() }),
    ]);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.payload));
    const row = await reservationFor(orderRace);
    assert.equal(row.status, "released", "the reservation is released exactly once, by exactly one of them");
    assert.ok(
      row.releaseReason === RESERVATION_EXPIRY_RELEASE_REASON || row.releaseReason === "cancelled",
      `unexpected releaseReason ${row.releaseReason}`,
    );
    const wonByJob = row.releaseReason === RESERVATION_EXPIRY_RELEASE_REASON;
    assert.equal(raced.released, wonByJob ? 1 : 0, "the job's own count agrees with who won");
    assert.equal(
      await expiryMovements(vRace),
      wonByJob ? 1 : 0,
      "a movement row exists if and only if the JOB performed the release — the loser wrote nothing",
    );
    const order = await prisma.storeOrder.findUniqueOrThrow({ where: { id: orderRace }, select: { status: true } });
    assert.equal(order.status, "cancelled");
    assert.equal(await stockOf(vRace), 2, "neither writer touched stock");
    summary.race = { winner: wonByJob ? "job" : "merchant", releases: 1 };
  }

  // ═══════════════════════════════════════════════════════════════════════
  //                    D-39 — the operational retention sweep
  // From here on there is NO HTTP traffic: `request()` clears
  // storefront_rate_limits before every non-GET, which would erase the very
  // rows scenario 9 seeds. Everything below is seeded through Prisma and aged
  // with raw SQL.
  // ═══════════════════════════════════════════════════════════════════════
  assert.deepEqual(
    [...NEVER_AUTO_DELETED],
    ["ledger_entries", "platform_audit_events", "store_audit_events", "order_status_events", "inventory_movements"],
    "the never-swept list is a contract, not a comment",
  );

  // ── identities, so all five session tables have a parent to hang from ──
  const platformOwner = await prisma.platformOwner.create({ data: { email: `${testId}.o@codiq.test`, passwordHash: "x", displayName: "مالك المنصة" } });
  const staff = await prisma.staff.create({ data: { email: `${testId}.st@codiq.test`, passwordHash: "x", displayName: "موظف المتجر" } });
  const membership = await prisma.storeStaffMembership.create({ data: { staffId: staff.id, storeId: store.id, roleCode: "store_staff" } });
  const platformStaff = await prisma.platformStaff.create({ data: { email: `${testId}.ps@codiq.test`, passwordHash: "x", displayName: "موظف المنصة", roleCode: "accountant" } });

  /**
   * Three rows per table: one revoked long ago, one simply expired long ago
   * (the OR's other branch), and one live. The window is 30 days, so the first
   * two die at 40 and the third — expiring a month from now — must not.
   */
  const DEAD = ago(40 * DAY);
  const ALIVE = ahead(30 * DAY);
  // `*_sessions_expiry` CHECKs `expires_at > created_at`, so a session that
  // expired 40 days ago has to have been opened before that — which is what a
  // real one looks like anyway.
  const OPENED = ago(41 * DAY);
  const sessionSeeds = [
    ["platformOwnerSession", { platformOwnerId: platformOwner.id }],
    ["merchantSession", { merchantId: merchant.payload.account.id, storeId: store.id }],
    ["customerSession", { customerId }],
    ["staffSession", { staffId: staff.id, membershipId: membership.id, storeId: store.id }],
    ["platformStaffSession", { platformStaffId: platformStaff.id }],
  ];
  const sessionTableFor = {
    platformOwnerSession: "platform_owner_sessions",
    merchantSession: "merchant_sessions",
    customerSession: "customer_sessions",
    staffSession: "staff_sessions",
    platformStaffSession: "platform_staff_sessions",
  };
  const liveSessionIds = {};
  for (const [model, parent] of sessionSeeds) {
    await prisma[model].create({ data: { ...parent, tokenHash: `${testId}-${model}-revoked`, createdAt: OPENED, expiresAt: ALIVE, revokedAt: DEAD } });
    await prisma[model].create({ data: { ...parent, tokenHash: `${testId}-${model}-expired`, createdAt: OPENED, expiresAt: DEAD, revokedAt: null } });
    const live = await prisma[model].create({ data: { ...parent, tokenHash: `${testId}-${model}-live`, expiresAt: ALIVE, revokedAt: null } });
    liveSessionIds[model] = live.id;
  }
  // The customer's own login session from the fixtures is live too and must survive.

  // ── notification_outbox: both windows, both edges, plus an unsettled row ──
  const eventKind = await prisma.notificationEventKind.findFirstOrThrow({ select: { eventType: true } });
  async function seedOutbox(label, status, updatedAgoMs) {
    const row = await prisma.notificationOutbox.create({
      data: { storeId: store.id, eventType: eventKind.eventType, recipientKind: "customer", channel: "sms", recipient: phone, status },
    });
    // `updated_at` is @updatedAt — Prisma stamps now() on create, so the age has
    // to be written behind its back.
    await sql.query("UPDATE notification_outbox SET updated_at = $1 WHERE id = $2", [ago(updatedAgoMs), row.id]);
    return { label, id: row.id };
  }
  const outboxDeadSent = await seedOutbox("sent@91d", "sent", 91 * DAY);
  const outboxLiveSent = await seedOutbox("sent@89d", "sent", 89 * DAY);
  const outboxDeadSkipped = await seedOutbox("skipped@91d", "skipped", 91 * DAY);
  const outboxLiveDead = await seedOutbox("dead_letter@100d", "dead_letter", 100 * DAY);
  const outboxDeadDead = await seedOutbox("dead_letter@400d", "dead_letter", 400 * DAY);
  const outboxPending = await seedOutbox("pending@400d", "pending", 400 * DAY);

  // ── shopping carts: guest windows, and the three shapes that must survive ──
  const cartCustomer = await prisma.shoppingCart.create({ data: { storeId: store.id, ownerKind: "customer", customerId, status: "active" } });
  const cartGuestDead = await prisma.shoppingCart.create({ data: { storeId: store.id, ownerKind: "guest", status: "expired", expiresAt: ago(31 * DAY), sessionTokenHash: `${testId}-g1` } });
  const cartGuestLive = await prisma.shoppingCart.create({ data: { storeId: store.id, ownerKind: "guest", status: "expired", expiresAt: ago(29 * DAY), sessionTokenHash: `${testId}-g2` } });
  const cartGuestAbandoned = await prisma.shoppingCart.create({ data: { storeId: store.id, ownerKind: "guest", status: "active", expiresAt: ago(40 * DAY), sessionTokenHash: `${testId}-g3` } });
  // The merge pair: the TARGET is an old expired guest cart that would otherwise
  // qualify, and the NOT EXISTS clause is the only thing keeping it — and with
  // it, the whole table's sweep, since `merged_into_cart_id` is RESTRICT.
  const cartMergeTarget = await prisma.shoppingCart.create({ data: { storeId: store.id, ownerKind: "guest", status: "expired", expiresAt: ago(40 * DAY), sessionTokenHash: `${testId}-g4` } });
  const cartMergeSource = await prisma.shoppingCart.create({ data: { storeId: store.id, ownerKind: "guest", status: "merged", expiresAt: ago(60 * DAY), sessionTokenHash: `${testId}-g5`, mergedIntoCartId: cartMergeTarget.id } });
  const convertedCarts = await prisma.shoppingCart.count({ where: { storeId: store.id, status: "converted" } });
  assert.ok(convertedCarts > 0, "the checkouts above left converted carts, which must also survive");

  // ── checkout_requests: both edges ──
  async function seedCheckoutRequest(suffix, createdAgoMs) {
    const row = await prisma.checkoutRequest.create({
      data: { storeId: store.id, customerId, keyHash: `${testId}-${suffix}`, requestFingerprint: `${testId}-${suffix}-fp`, status: "succeeded" },
    });
    await sql.query("UPDATE checkout_requests SET created_at = $1 WHERE id = $2", [ago(createdAgoMs), row.id]);
    return row.id;
  }
  const checkoutDead = await seedCheckoutRequest("old", 91 * DAY);
  const checkoutLive = await seedCheckoutRequest("new", 89 * DAY);

  // ── the five never-swept tables, every row aged past EVERY window ──
  const ancient = ago(400 * DAY);
  // Three of these five are append-only IN THE DATABASE
  // (`ledger_entries_immutable`, `platform_audit_events_immutable`,
  // `order_status_events_immutable`), so their age is set by the INSERT — the
  // only write Postgres still allows on them. That is itself worth asserting:
  // it is the structural half of «never auto-deleted».
  await prisma.ledgerEntry.create({
    data: { storeId: store.id, orderId: orderFresh, entryType: "order_completed", subtotalIqd: 10000, deliveryFeeIqd: 2500, commissionIqd: 500, commissionBps: 500, planCode: "free", createdAt: ancient },
  });
  const ledgerImmutable = await sql
    .query("UPDATE ledger_entries SET commission_iqd = 0")
    .then(() => false)
    .catch((error) => error.detail === "Ledger entries are append-only");
  assert.equal(ledgerImmutable, true, "ledger_entries refuses an UPDATE — the money is append-only before it is un-sweepable");

  await prisma.storeAuditEvent.create({
    data: { storeId: store.id, entityType: "product", entityId: productId, entityLabel: "صندوق الاختبار", action: "soft_deleted", actorKind: "system", actorId: null, actorLabel: "النظام", createdAt: ancient },
  });
  await prisma.platformAuditEvent.create({
    data: { entityType: "platform_staff", entityId: platformStaff.id, entityLabel: "موظف المنصة", action: "staff_created", actorKind: "platform_owner", actorId: platformOwner.id, actorLabel: "مالك المنصة", createdAt: ancient },
  });
  await prisma.orderStatusEvent.create({
    data: { storeId: store.id, orderId: orderFresh, fromStatus: null, toStatus: "new", actorKind: "customer", actorId: customerId, note: null, createdAt: ancient },
  });
  // inventory_movements carries no immutability trigger, so every movement the
  // scenarios above wrote — the release's own row included — is aged wholesale.
  await sql.query("UPDATE inventory_movements SET created_at = $1", [ancient]);

  const neverSweptBefore = {
    ledger_entries: await prisma.ledgerEntry.count(),
    platform_audit_events: await prisma.platformAuditEvent.count(),
    store_audit_events: await prisma.storeAuditEvent.count(),
    order_status_events: await prisma.orderStatusEvent.count(),
    inventory_movements: await prisma.inventoryMovement.count(),
  };
  for (const [table, count] of Object.entries(neverSweptBefore)) {
    assert.ok(count > 0, `${table} must hold rows for this assertion to mean anything`);
  }

  // ── storefront_rate_limits: eight past the edge, one inside it ──
  // Seeded LAST, and nothing below issues a non-GET request.
  for (let index = 0; index < 8; index += 1) {
    await sql.query(
      "INSERT INTO storefront_rate_limits (scope, key_hash, window_started_at, attempt_count, updated_at) VALUES ($1, $2, $3, 1, $3)",
      [`${testId}-scope`, `${testId}-old-${index}`, ago(8 * DAY)],
    );
  }
  await sql.query(
    "INSERT INTO storefront_rate_limits (scope, key_hash, window_started_at, attempt_count, updated_at) VALUES ($1, $2, now(), 1, now())",
    [`${testId}-scope`, `${testId}-fresh`],
  );

  // ═══════════════ 7 + 8 + 9. one sweep, batched past a single batch ═══════════════
  // batchSize 3 against 8 expired rate-limit rows: three full batches and a
  // short one. A single unbounded DELETE would be indistinguishable from a
  // correct sweep here — the batch size is what makes the loop observable.
  const swept = await sweepOperationalRetention({ now: new Date(), batchSize: 3 });
  assert.deepEqual(swept.failed, [], `no table may fail: ${JSON.stringify(swept.failed)}`);
  assert.equal(swept.byTable["storefront_rate_limits"], 8, "all eight expired counters went, which takes more than one batch of 3");
  assert.equal(await prisma.storefrontRateLimit.count(), 1, "the fresh counter survives");

  for (const [model, table] of Object.entries(sessionTableFor)) {
    const remaining = await prisma[model].findMany({ select: { id: true, tokenHash: true } });
    const stale = remaining.filter((row) => row.tokenHash.startsWith(`${testId}-${model}-`) && !row.tokenHash.endsWith("-live"));
    assert.equal(stale.length, 0, `${table}: revoked and expired rows must be gone`);
    assert.ok(remaining.some((row) => row.id === liveSessionIds[model]), `${table}: the live session must survive`);
    assert.equal(swept.byTable[table], 2, `${table}: exactly the two dead rows`);
  }
  // The customer's fixture login session is live and untouched.
  assert.ok((await prisma.customerSession.count({ where: { customerId, revokedAt: null } })) >= 2);

  const outboxAlive = async (row) => (await prisma.notificationOutbox.count({ where: { id: row.id } })) === 1;
  assert.equal(await outboxAlive(outboxDeadSent), false, "sent at 91 days is past the 90-day window");
  assert.equal(await outboxAlive(outboxDeadSkipped), false, "skipped at 91 days likewise");
  assert.equal(await outboxAlive(outboxLiveSent), true, "sent at 89 days is inside it");
  assert.equal(await outboxAlive(outboxDeadDead), false, "dead_letter at 400 days is past the 365-day window");
  assert.equal(await outboxAlive(outboxLiveDead), true, "dead_letter at 100 days is nowhere near it");
  assert.equal(await outboxAlive(outboxPending), true, "a `pending` row is not settled and is never swept, at any age");
  assert.equal(swept.byTable["notification_outbox (sent/skipped)"], 2);
  assert.equal(swept.byTable["notification_outbox (dead_letter)"], 1);

  const cartAlive = async (cart) => (await prisma.shoppingCart.count({ where: { id: cart.id } })) === 1;
  assert.equal(await cartAlive(cartGuestDead), false, "a guest cart 31 days past its expiry goes");
  assert.equal(await cartAlive(cartGuestAbandoned), false, "so does one abandoned 40 days ago while still `active`");
  assert.equal(await cartAlive(cartGuestLive), true, "29 days is inside the window");
  assert.equal(await cartAlive(cartCustomer), true, "a customer's saved basket is never swept");
  assert.equal(await cartAlive(cartMergeSource), true, "a `merged` cart is the trail of a guest who signed in");
  assert.equal(await cartAlive(cartMergeTarget), true, "the NOT EXISTS clause protects a merge target — and the sweep from a RESTRICT 23503");
  assert.equal(await prisma.shoppingCart.count({ where: { storeId: store.id, status: "converted" } }), convertedCarts, "an order's provenance cart survives");
  assert.equal(swept.byTable["shopping_carts (guest)"], 2);

  assert.equal(await prisma.checkoutRequest.count({ where: { id: checkoutDead } }), 0, "an idempotency key 91 days old is spent");
  assert.equal(await prisma.checkoutRequest.count({ where: { id: checkoutLive } }), 1, "89 days old is still honoured");
  assert.equal(swept.byTable["checkout_requests"], 1);

  // ═══════════════ 10. the five that are never swept ═══════════════
  const neverSweptAfter = {
    ledger_entries: await prisma.ledgerEntry.count(),
    platform_audit_events: await prisma.platformAuditEvent.count(),
    store_audit_events: await prisma.storeAuditEvent.count(),
    order_status_events: await prisma.orderStatusEvent.count(),
    inventory_movements: await prisma.inventoryMovement.count(),
  };
  assert.deepEqual(
    neverSweptAfter,
    neverSweptBefore,
    "the money, the audit trails and the stock history are ARCHIVED, never swept — every row here is 400 days old and every one of them must still be there",
  );
  for (const table of NEVER_AUTO_DELETED) {
    assert.equal(swept.byTable[table], undefined, `${table} must never appear in a sweep result`);
  }

  summary.retention = { windows: RETENTION_DAYS, byTable: swept.byTable, deleted: swept.deleted, neverSwept: neverSweptAfter };

  // ============================================================
  // 11. (19-د, ATTACK-SURFACE) A SWEPT MESSAGE MUST NOT UN-SEND ITSELF.
  //
  // Item 7 above proves settled outbox rows die at 90 days, and item 8 proves a
  // customer cart survives the sweep. Both are correct, and TOGETHER they were a
  // defect: the abandoned-cart scanner's only two dedupe mechanisms were that
  // outbox row — the `notificationOutbox: { none: … }` candidate filter and the
  // UNIQUE(store_id, dedupe_key) — while a customer-owned cart is never swept
  // and never expires. So the shopper was mailed on day 0, the record of it was
  // deleted on day 90, and the next fifteen-minute pass mailed him again. Every
  // 90 days, for as long as the cart sat there — under a module header that
  // calls «one message per cart, forever» structural.
  //
  // phase20b2 asserts the guarantee within one run and cannot see this; the
  // sweep is what breaks it, so the proof belongs here, where the sweep is.
  // ============================================================
  const { scanAbandonedCarts } = await import("../src/notifications/abandoned-cart-scanner.ts");
  await prisma.customer.update({ where: { id: customerId }, data: { email: `${testId}.abandoned@codiq.test` } });
  await prisma.notificationSettings.update({
    where: { storeId: store.id },
    data: { isEnabled: true, configuration: { abandonedCart: { enabled: true, windowHours: 12, recoveryCouponId: null } } },
  });
  // The suite's own surviving customer cart, reused: a partial unique index
  // allows one ACTIVE customer cart per store, and item 8 above has just proved
  // this exact row outlives the sweep — which is half of what makes the defect.
  const abandonedCart = await prisma.shoppingCart.update({ where: { id: cartCustomer.id }, data: { lastActivityAt: ago(2 * DAY) } });
  await prisma.cartItem.create({ data: { storeId: store.id, cartId: abandonedCart.id, productId, variantId: vFresh, quantity: 1, priceSnapshotIqd: 1000 } });

  const firstScan = await scanAbandonedCarts();
  assert.equal(firstScan.enqueued, 1, `19-د: the fixture must actually produce one message — ${JSON.stringify(firstScan)}`);
  const abandonedRow = await prisma.notificationOutbox.findFirstOrThrow({ where: { cartId: abandonedCart.id, eventType: "cart.abandoned" }, select: { id: true } });
  assert.equal((await scanAbandonedCarts()).enqueued, 0, "19-د: a second pass in the same run adds nothing — the guarantee inside one run still holds");

  // Now age that message past the settled-outbox window and sweep it, which is
  // exactly what six hours of production does ninety days later.
  await sql.query("UPDATE notification_outbox SET status = 'sent', sent_at = $1, updated_at = $1 WHERE id = $2", [ago(91 * DAY), abandonedRow.id]);
  await sweepOperationalRetention();
  assert.equal(await prisma.notificationOutbox.count({ where: { id: abandonedRow.id } }), 0, "the settled message is swept, as retention intends");
  assert.equal(await prisma.shoppingCart.count({ where: { id: abandonedCart.id, status: "active" } }), 1, "…and the customer cart survives it, as item 8 requires");

  // THE ASSERTION. Before the fix this scan enqueued a second message to the
  // same shopper about the same cart, and would do so again every 90 days.
  const afterSweepScan = await scanAbandonedCarts();
  assert.equal(afterSweepScan.enqueued, 0, `19-د: the cart was messaged again after its outbox row was swept — «one message per cart, forever» is only «every 90 days» while the guarantee lives on a row with a retention clock (${JSON.stringify(afterSweepScan)})`);
  assert.equal(await prisma.notificationOutbox.count({ where: { cartId: abandonedCart.id, eventType: "cart.abandoned" } }), 0, "and no new row was written");
  // The stamp is what survived, and it is on the cart itself.
  const stamped = await prisma.shoppingCart.findUniqueOrThrow({ where: { id: abandonedCart.id }, select: { abandonedNotifiedAt: true } });
  assert.ok(stamped.abandonedNotifiedAt instanceof Date, "19-د: the guarantee lives on the cart now, so it outlives any retention number");
  summary.abandonedCartDedupe = { firstScan: firstScan.enqueued, secondScanSameRun: 0, sweptOutboxRows: 1, scanAfterSweep: afterSweepScan.enqueued, stampSurvives: true };

  console.log(JSON.stringify({ suite: "retention.d39-d46", summary }, null, 2));
} finally {
  await sql.end();
  server.close();
  await prisma.$disconnect();
}
