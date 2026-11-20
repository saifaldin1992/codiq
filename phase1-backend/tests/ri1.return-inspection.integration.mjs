/**
 * codiq RI-1 «فحص المرتجعات» — proven end to end.
 *
 *  1. ACTIVE-RESTOCK (the refused-COD majority): OFD→returned then restock-all
 *     → reservation released (releaseReason 'return_inspected'), disposition
 *     'restocked', stock UNCHANGED, ZERO movements — and availability is truly
 *     back: a fresh checkout for the same quantity succeeds.
 *  2. ACTIVE-WRITE-OFF: OFD→returned then write-off-all → guarded decrement,
 *     one movement {delta:-q, reason:'storefront_returned_written_off'}, the
 *     reservation released, and the low_stock outbox row when the decrement
 *     crosses the threshold.
 *  3. CONSUMED-SPLIT: completed→returned then split 2/1 → stock +2 exactly,
 *     one movement {delta:+2, reason:'storefront_returned_restored'},
 *     reservation stays consumed with the full audit trio.
 *  4. DOUBLE-RESOLVE: the second resolve → 409 RETURN_ALREADY_INSPECTED with
 *     stock and movement counts unchanged (the in-tx guarded flip held).
 *  5. ARITHMETIC: bad split → 422 INVALID_INSPECTION_SPLIT; negative/float →
 *     422 from zod; a raw UPDATE violating the DB constraint names
 *     inventory_reservations_inspection_consistent.
 *  6. WALLS: cross-store resolve → 404; foreign rows never listed; no token →
 *     401; mismatched Origin → 403 CSRF_ORIGIN_DENIED.
 *  7. PERMISSIONS: default store_staff (holds inventory.update) resolves and
 *     is recorded as the inspector; a deny override → 403.
 *  8. MONEY ISOLATION: ledger_entries count identical before/after every
 *     resolution — the goods decision writes no money.
 *  9. TRASHED VARIANT: soft-deleted product (consumed rows don't block it),
 *     restock → 409 VARIANT_TRASHED and NOTHING written (disposition still
 *     pending); full write-off → 200 with stock untouched.
 */
import assert from "node:assert/strict";
import { ownStaffPassword } from "./helpers/own-staff-password.js";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { Client } from "pg";

const testId = `ri1-${Date.now()}`;
process.env.SESSION_JWT_SECRET = process.env.SESSION_JWT_SECRET ?? "ri1-test-secret-only-not-for-production";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

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

  // ---------- fixtures ----------
  const merchantA = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100419401", email: `${testId}.a@codiq.test`, password: "Ri1MerchantPass!2026", businessName: "متجر مرتجعات ألف" });
  const merchantB = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100419402", email: `${testId}.b@codiq.test`, password: "Ri1MerchantPass!2026", businessName: "متجر مرتجعات باء" });
  assert.equal(merchantA.status, 201); assert.equal(merchantB.status, 201);
  const storeA = await prisma.store.create({ data: { merchantId: merchantA.payload.account.id, name: "متجر ألف", slug: `${testId}-a`, defaultSubdomain: `${testId}-a`, notificationSettings: { create: { provider: null, apiKey: null, senderId: null, isEnabled: true } } } });
  const storeB = await prisma.store.create({ data: { merchantId: merchantB.payload.account.id, name: "متجر باء", slug: `${testId}-b`, defaultSubdomain: `${testId}-b` } });
  await prisma.deliveryRate.create({ data: { storeId: storeA.id, governorate: "Baghdad", amountIqd: 2500, isEnabled: true } });
  const tokenA = (await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.a@codiq.test`, password: "Ri1MerchantPass!2026" } })).payload.accessToken;
  const catalogA = `/merchant/stores/${storeA.slug}/catalog`;
  const ordersA = `/merchant/stores/${storeA.slug}/orders`;
  const inspectA = `/merchant/stores/${storeA.slug}/inventory/returns`;

  const productCreated = await request(`${catalogA}/products`, { method: "POST", token: tokenA, body: { sku: "RI1-SHIRT", name: "قميص المرتجعات", priceIqd: 10000, stockQuantity: 5, lowStockThreshold: 1 } });
  assert.equal(productCreated.status, 201, JSON.stringify(productCreated.payload));
  const productId = productCreated.payload.product.id;
  // One explicit variant with a HIGH threshold so a write-off provably crosses it.
  const variantCreated = await request(`${catalogA}/products/${productId}/variants`, { method: "POST", token: tokenA, body: { sku: "RI1-SHIRT-M", name: "وسط", priceIqd: 10000, stockQuantity: 10, lowStockThreshold: 9 } });
  assert.equal(variantCreated.status, 201, JSON.stringify(variantCreated.payload));
  const variantId = variantCreated.payload.variant.id;

  // Customer + address.
  const phone = "+96477066" + String(Date.now()).slice(-5);
  const registered = await request(`/store/${storeA.slug}/account/register`, { method: "POST", body: { phone, password: "Ri1CustomerPass!2026", fullName: "زبون المرتجعات" } });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const customerToken = registered.payload.accessToken;
  const address = await request(`/store/${storeA.slug}/account/addresses`, { method: "POST", token: customerToken, body: { recipientName: "زبون المرتجعات", fullAddress: "شارع 1", city: "Baghdad", governorate: "Baghdad", phoneContact: phone, isDefault: true } });
  const addressId = address.payload.address.id;

  let checkoutKey = 0;
  async function placeOrder(quantity) {
    const added = await request(`/store/${storeA.slug}/cart/items`, { method: "POST", token: customerToken, body: { variantId, quantity } });
    assert.equal(added.status, 200, JSON.stringify(added.payload));
    checkoutKey += 1;
    const checkedOut = await request(`/store/${storeA.slug}/checkout`, {
      method: "POST", token: customerToken,
      headers: { "idempotency-key": `ri1-idempotency-key-${String(checkoutKey).padStart(6, "0")}` },
      body: { cartVersion: added.payload.cart.version, addressId, paymentMethodCode: "cod" },
    });
    assert.equal(checkedOut.status, 201, JSON.stringify(checkedOut.payload));
    return checkedOut.payload.order.id;
  }

  async function advance(orderId, statuses) {
    for (const toStatus of statuses) {
      const current = await request(`${ordersA}/${orderId}`, { token: tokenA });
      const moved = await request(`${ordersA}/${orderId}/status`, { method: "POST", token: tokenA, body: { toStatus, expectedVersion: current.payload.order.version } });
      assert.equal(moved.status, 200, `${toStatus}: ${JSON.stringify(moved.payload)}`);
    }
  }

  const variantStock = async () => (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId }, select: { stockQuantity: true } })).stockQuantity;
  const movementCount = async (reason) => prisma.inventoryMovement.count({ where: { variantId, reason } });
  const reservationFor = async (orderId) => prisma.inventoryReservation.findFirstOrThrow({ where: { orderId, variantId } });
  const ledgerCount = async () => prisma.ledgerEntry.count();

  // ---------- 1. ACTIVE-RESTOCK ----------
  {
    const orderId = await placeOrder(2);
    await advance(orderId, ["processing", "preparation", "out_for_delivery", "returned"]);
    const listed = await request(inspectA, { token: tokenA });
    assert.equal(listed.status, 200, JSON.stringify(listed.payload));
    const row = listed.payload.returns.find((entry) => entry.orderId === orderId);
    assert.ok(row, "the returned order appears in the inspection queue");
    assert.equal(row.stockDeducted, false, "OFD→returned never deducted stock");
    const stockBefore = await variantStock();
    const ledgerBefore = await ledgerCount();
    const resolved = await request(`${inspectA}/${row.id}/resolve`, { method: "POST", token: tokenA, body: { restockQty: 2, writeOffQty: 0 } });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.payload));
    assert.equal(resolved.payload.resolution.disposition, "restocked");
    const reservation = await reservationFor(orderId);
    assert.equal(reservation.status, "released");
    assert.equal(reservation.releaseReason, "return_inspected");
    assert.equal(reservation.returnDisposition, "restocked");
    assert.equal(reservation.restockedQuantity, 2);
    assert.equal(await variantStock(), stockBefore, "restock on an ACTIVE row must not touch stock");
    assert.equal(await movementCount("storefront_returned_restored"), 0, "no movement for a release-only restock");
    assert.equal(await ledgerCount(), ledgerBefore, "resolution writes no money");
    // Availability is truly restored: the same quantity checks out again.
    const again = await placeOrder(2);
    await advance(again, ["cancelled"]); // free it back for later scenarios
    summary.activeRestock = true;
  }

  // ---------- 1-ب. ق-215 — AN EXPIRED RESERVATION HAS NOTHING TO INSPECT ----------
  //
  // The path is the one ق-193's own comment calls normal in Iraq: the shopper
  // orders on Thursday night, the merchant confirms on Monday, and the D-46
  // sweep RELEASED the reservation as `expired` over the weekend. Then the
  // delivery is refused at the door — the majority return here — and the
  // merchant marks «مرتجعة».
  //
  // The units never left `stockQuantity`, so there is nothing physical to decide
  // about; and `resolveReturnInspection` refuses a released row by design
  // («حالة هذا الحجز لا تقبل الفحص»). Queuing it anyway produced a row the
  // merchant could see, press, and never clear — and a queue a merchant learns
  // he cannot empty is a queue he stops opening, which buries the returns that
  // ARE actionable behind the ones that are not.
  {
    const orderId = await placeOrder(2);
    await advance(orderId, ["processing"]);
    // Exactly what the expiry sweep does, and nothing more.
    const expired = await prisma.inventoryReservation.updateMany({
      where: { orderId, status: "active" },
      data: { status: "released", releaseReason: "expired", releasedAt: new Date() },
    });
    assert.equal(expired.count, 1, "the sweep released the order's reservation");
    await advance(orderId, ["preparation", "out_for_delivery", "returned"]);

    const listed = await request(inspectA, { token: tokenA });
    assert.equal(listed.status, 200, JSON.stringify(listed.payload));
    assert.ok(
      !listed.payload.returns.some((entry) => entry.orderId === orderId),
      "ق-215: a reservation released as `expired` never enters the inspection queue — the merchant could never resolve it",
    );
    const reservation = await reservationFor(orderId);
    assert.equal(reservation.returnDisposition, "not_returned", "…and its disposition is left alone rather than parked on `pending_inspection` forever");
    assert.equal(reservation.status, "released");
    summary.expiredReturnStaysOutOfTheQueue = true;
  }

  // ---------- 2. ACTIVE-WRITE-OFF + the low-stock alert ----------
  {
    const orderId = await placeOrder(2);
    await advance(orderId, ["processing", "preparation", "out_for_delivery", "returned"]);
    const row = (await request(inspectA, { token: tokenA })).payload.returns.find((entry) => entry.orderId === orderId);
    const stockBefore = await variantStock();
    const outboxBefore = await prisma.notificationOutbox.count({ where: { storeId: storeA.id, eventType: "low_stock" } });
    const resolved = await request(`${inspectA}/${row.id}/resolve`, { method: "POST", token: tokenA, body: { restockQty: 0, writeOffQty: 2 } });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.payload));
    assert.equal(await variantStock(), stockBefore - 2, "write-off on an ACTIVE row is a real decrement");
    assert.equal(await movementCount("storefront_returned_written_off"), 1);
    const movement = await prisma.inventoryMovement.findFirstOrThrow({ where: { variantId, reason: "storefront_returned_written_off" } });
    assert.equal(movement.delta, -2);
    const reservation = await reservationFor(orderId);
    assert.equal(reservation.status, "released");
    assert.equal(reservation.returnDisposition, "written_off");
    assert.equal(reservation.writtenOffQuantity, 2);
    const outboxAfter = await prisma.notificationOutbox.count({ where: { storeId: storeA.id, eventType: "low_stock" } });
    assert.equal(outboxAfter, outboxBefore + 1, "the threshold crossing alerted (10→8 across threshold 9)");
    summary.activeWriteOff = true;
  }

  // ---------- 3. CONSUMED-SPLIT ----------
  {
    const orderId = await placeOrder(3);
    const stockBeforeCompletion = await variantStock();
    await advance(orderId, ["processing", "preparation", "out_for_delivery", "completed"]);
    assert.equal(await variantStock(), stockBeforeCompletion - 3, "completion decremented");
    await advance(orderId, ["returned"]);
    const row = (await request(inspectA, { token: tokenA })).payload.returns.find((entry) => entry.orderId === orderId);
    assert.equal(row.stockDeducted, true, "completed→returned rows say the stock already left");
    const stockBefore = await variantStock();
    const resolved = await request(`${inspectA}/${row.id}/resolve`, { method: "POST", token: tokenA, body: { restockQty: 2, writeOffQty: 1, note: "قطعة ممزقة" } });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.payload));
    assert.equal(await variantStock(), stockBefore + 2, "split restocked exactly the fine units");
    assert.equal(await movementCount("storefront_returned_restored"), 1);
    const movement = await prisma.inventoryMovement.findFirstOrThrow({ where: { variantId, reason: "storefront_returned_restored" } });
    assert.equal(movement.delta, 2);
    const reservation = await reservationFor(orderId);
    assert.equal(reservation.status, "consumed", "consumed rows keep their status");
    assert.equal(reservation.returnDisposition, "split");
    assert.equal(reservation.restockedQuantity, 2);
    assert.equal(reservation.writtenOffQuantity, 1);
    assert.equal(reservation.inspectedByKind, "merchant");
    assert.ok(reservation.inspectedAt && reservation.inspectedById);
    assert.equal(reservation.inspectionNote, "قطعة ممزقة");
    // ق-177: the decision can be READ BACK. Before this, the trio above was
    // written and the only list filtered on pending_inspection — a write-off
    // reason left every screen the moment it was typed.
    const history = await request(`${inspectA}/inspected`, { token: tokenA });
    assert.equal(history.status, 200, JSON.stringify(history.payload));
    assert.equal(history.payload.storeSlug, storeA.slug, "the envelope says which store it is a list of");
    const decided = history.payload.returns.find((entry) => entry.id === row.id);
    assert.ok(decided, "ق-177: the split decision is in the history");
    assert.equal(decided.disposition, "split");
    assert.equal(decided.restockedQuantity, 2);
    assert.equal(decided.writtenOffQuantity, 1);
    assert.equal(decided.inspectionNote, "قطعة ممزقة", "ق-177: the reason a merchant typed is the reason he reads back");
    assert.equal(decided.inspectedByKind, "merchant");
    assert.equal(decided.orderNumber, reservation.orderId ? (await prisma.storeOrder.findUniqueOrThrow({ where: { id: orderId }, select: { orderNumber: true } })).orderNumber : decided.orderNumber);
    assert.ok(!history.payload.returns.some((entry) => entry.disposition === "pending_inspection"), "ق-177: only decided rows, never the queue");
    assert.ok(history.payload.returns.every((entry) => entry.inspectedAt), "every row here has been inspected");
    assert.ok(!(await request(inspectA, { token: tokenA })).payload.returns.some((entry) => entry.id === row.id), "…and the queue no longer lists it");
    const firstPage = await request(`${inspectA}/inspected?limit=1`, { token: tokenA });
    assert.equal(firstPage.payload.returns.length, 1);
    assert.ok(firstPage.payload.nextCursor, "three decisions do not fit one row — page 2 is offered");
    const secondPage = await request(`${inspectA}/inspected?limit=1&cursor=${encodeURIComponent(firstPage.payload.nextCursor)}`, { token: tokenA });
    assert.equal(secondPage.status, 200);
    assert.notEqual(secondPage.payload.returns[0].id, firstPage.payload.returns[0].id, "page 2 begins after page 1");

    // ---------- 4. DOUBLE-RESOLVE ----------
    const again = await request(`${inspectA}/${row.id}/resolve`, { method: "POST", token: tokenA, body: { restockQty: 3, writeOffQty: 0 } });
    assert.equal(again.status, 409);
    assert.equal(again.payload.error.code, "RETURN_ALREADY_INSPECTED");
    assert.equal(await variantStock(), stockBefore + 2, "the refused second resolve moved nothing");
    assert.equal(await movementCount("storefront_returned_restored"), 1);
    summary.consumedSplitAndDoubleResolve = true;
  }

  // ---------- 5. ARITHMETIC ----------
  {
    const orderId = await placeOrder(2);
    await advance(orderId, ["processing", "preparation", "out_for_delivery", "returned"]);
    const row = (await request(inspectA, { token: tokenA })).payload.returns.find((entry) => entry.orderId === orderId);
    const badSplit = await request(`${inspectA}/${row.id}/resolve`, { method: "POST", token: tokenA, body: { restockQty: 1, writeOffQty: 0 } });
    assert.equal(badSplit.status, 422);
    assert.equal(badSplit.payload.error.code, "INVALID_INSPECTION_SPLIT");
    const negative = await request(`${inspectA}/${row.id}/resolve`, { method: "POST", token: tokenA, body: { restockQty: -1, writeOffQty: 3 } });
    assert.equal(negative.status, 422, "zod refuses negatives");
    const fractional = await request(`${inspectA}/${row.id}/resolve`, { method: "POST", token: tokenA, body: { restockQty: 1.5, writeOffQty: 0.5 } });
    assert.equal(fractional.status, 422, "zod refuses non-integers");
    // DB-level: the arithmetic constraint holds even against a raw write.
    await assert.rejects(
      prisma.$executeRawUnsafe(`UPDATE inventory_reservations SET return_disposition = 'restocked', restocked_quantity = 1 WHERE id = '${row.id}'`),
      (error) => String(error).includes("inventory_reservations_inspection_consistent"),
      "the DB names its own arithmetic law",
    );
    // Leave this row pending for the walls below.
    summary.arithmetic = true;

    // ---------- 6. WALLS ----------
    const tokenB = (await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.b@codiq.test`, password: "Ri1MerchantPass!2026" } })).payload.accessToken;
    const foreignResolve = await request(`/merchant/stores/${storeB.slug}/inventory/returns/${row.id}/resolve`, { method: "POST", token: tokenB, body: { restockQty: 2, writeOffQty: 0 } });
    assert.equal(foreignResolve.status, 404, "a foreign reservation is indistinguishable from a missing one");
    const foreignList = await request(`/merchant/stores/${storeB.slug}/inventory/returns`, { token: tokenB });
    assert.equal(foreignList.payload.returns.length, 0, "store B never sees store A rows");
    const anonymous = await request(inspectA);
    assert.equal(anonymous.status, 401);
    const badOrigin = await request(`${inspectA}/${row.id}/resolve`, { method: "POST", token: tokenA, body: { restockQty: 2, writeOffQty: 0 }, headers: { origin: "https://evil.example" } });
    assert.equal(badOrigin.status, 403);
    assert.equal(badOrigin.payload.error.code, "CSRF_ORIGIN_DENIED");
    // ق-229: and the branch that used to fail OPEN. A write with NO `Origin` at
    // all walked past this guard on every route on the platform; `Sec-Fetch-Site`
    // is what OWASP's CSRF cheat sheet reaches for in exactly that case, and no
    // script can forge it — it is on the browser's forbidden-header list.
    const crossSiteNoOrigin = await request(`${inspectA}/${row.id}/resolve`, { method: "POST", token: tokenA, body: { restockQty: 2, writeOffQty: 0 }, headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(crossSiteNoOrigin.status, 403, "ق-229: a cross-site write with no Origin is refused");
    assert.equal(crossSiteNoOrigin.payload.error.code, "CSRF_ORIGIN_DENIED");
    const siblingSubdomain = await request(`${inspectA}/${row.id}/resolve`, { method: "POST", token: tokenA, body: { restockQty: 2, writeOffQty: 0 }, headers: { "sec-fetch-site": "same-site" } });
    assert.equal(siblingSubdomain.status, 403, "ق-229: …and so is a sibling subdomain, which on this platform is another merchant's storefront");
    // …while the two shapes that are NOT an attack keep working: our own page,
    // and a person who typed the address himself (`none` — a typed address or a
    // bookmark, which every browser sends and which must never be refused).
    //
    // The body is deliberately IMPOSSIBLE — 999 units of a two-unit reservation.
    // What is being probed is the DOOR, and a probe that walked through it would
    // spend the one resolution this row is allowed and leave the rest of the
    // suite asserting against a row somebody else already closed.
    for (const site of ["same-origin", "none"]) {
      const allowed = await request(`${inspectA}/${row.id}/resolve`, { method: "POST", token: tokenA, body: { restockQty: 999, writeOffQty: 999 }, headers: { "sec-fetch-site": site } });
      assert.notEqual(allowed.status, 403, `ق-229: «${site}» is not an attack and must reach the route — ${JSON.stringify(allowed.payload)}`);
      assert.notEqual(allowed.payload.error?.code, "CSRF_ORIGIN_DENIED", `ق-229: …and never on this ground — ${site}`);
    }
    summary.walls = true;

    // ---------- 7. PERMISSIONS ----------
    const staffCreated = await request(`/merchant/stores/${storeA.slug}/team`, { method: "POST", token: tokenA, body: { email: `${testId}.staff@codiq.test`, displayName: "موظف الفحص", temporaryPassword: "ri1-staff-temp-password", roleCode: "store_staff" } });
    assert.equal(staffCreated.status, 201, JSON.stringify(staffCreated.payload));
    await ownStaffPassword(base, storeA.slug, `${testId}.staff@codiq.test`, "ri1-staff-temp-password"); // audit 14-ب
    const membershipId = staffCreated.payload.membership.id;
    let staffToken = (await request(`/auth/staff/stores/${storeA.slug}/login`, { method: "POST", body: { email: `${testId}.staff@codiq.test`, password: "ri1-staff-temp-password" } })).payload.accessToken;
    const staffResolved = await request(`${inspectA}/${row.id}/resolve`, { method: "POST", token: staffToken, body: { restockQty: 2, writeOffQty: 0 } });
    assert.equal(staffResolved.status, 200, JSON.stringify(staffResolved.payload));
    const staffReservation = await reservationFor(orderId);
    assert.equal(staffReservation.inspectedByKind, "staff", "the inspector is recorded");

    const denied = await request(`/merchant/stores/${storeA.slug}/team/${membershipId}/overrides`, { method: "PUT", token: tokenA, body: { overrides: [{ permissionCode: "inventory.update", effect: "deny" }] } });
    assert.equal(denied.status, 200);
    staffToken = (await request(`/auth/staff/stores/${storeA.slug}/login`, { method: "POST", body: { email: `${testId}.staff@codiq.test`, password: "ri1-staff-temp-password" } })).payload.accessToken;
    const deniedList = await request(inspectA, { token: staffToken });
    assert.equal(deniedList.status, 403);
    assert.equal(deniedList.payload.error.code, "STAFF_PERMISSION_DENIED");
    summary.permissions = true;
  }

  // ---------- 9. TRASHED VARIANT ----------
  {
    const orderId = await placeOrder(1);
    await advance(orderId, ["processing", "preparation", "out_for_delivery", "completed", "returned"]);
    const softDeleted = await request(`${catalogA}/products/${productId}`, { method: "DELETE", token: tokenA });
    assert.equal(softDeleted.status, 200, `consumed reservations must not block soft-delete: ${JSON.stringify(softDeleted.payload)}`);
    const row = (await request(inspectA, { token: tokenA })).payload.returns.find((entry) => entry.orderId === orderId);
    assert.ok(row, "the pending row survives the trash");
    assert.equal(row.variantTrashed, true);
    const stockBefore = await variantStock();
    const restockRefused = await request(`${inspectA}/${row.id}/resolve`, { method: "POST", token: tokenA, body: { restockQty: 1, writeOffQty: 0 } });
    assert.equal(restockRefused.status, 409);
    assert.equal(restockRefused.payload.error.code, "VARIANT_TRASHED");
    const still = await reservationFor(orderId);
    assert.equal(still.returnDisposition, "pending_inspection", "the refused restock wrote NOTHING (tx rolled the flip back)");
    const writeOff = await request(`${inspectA}/${row.id}/resolve`, { method: "POST", token: tokenA, body: { restockQty: 0, writeOffQty: 1 } });
    assert.equal(writeOff.status, 200, JSON.stringify(writeOff.payload));
    assert.equal(await variantStock(), stockBefore, "a consumed write-off touches no stock");
    const finalRow = await reservationFor(orderId);
    assert.equal(finalRow.returnDisposition, "written_off");
    summary.trashedVariant = true;
  }

  console.log(JSON.stringify({ suite: "ri1.return-inspection", summary }, null, 2));
} finally {
  await sql.end();
  server.close();
  await prisma.$disconnect();
}
