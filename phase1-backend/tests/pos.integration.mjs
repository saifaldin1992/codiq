/**
 * codiq ق-132 / ق-135 — الكاشير: the counter sale on the same order book.
 *
 * What this suite must hold down, claim by claim:
 *
 *   1. A SALE IS A REAL ORDER — source «pos», born completed, born paid, cash;
 *      it appears in the same order book the storefront writes to;
 *   2. STOCK MOVES ONCE, on the shared balance — the whole premise of ق-132;
 *   3. NO LEDGER ENTRY AND NO COMMISSION (ق-135) — asserted directly, because
 *      both ledger readers subtract any type that is not order_completed, and
 *      the wallet must NOT claim the platform owes cash it never held;
 *   4. THE REPLAY SELLS ONCE — same ticket twice returns the same order and
 *      decrements nothing the second time. A count is a claim; the stock
 *      number and order count are the fact;
 *   5. A REUSED TICKET ID WITH DIFFERENT CONTENTS IS REFUSED — that is not a
 *      retry, it is a bug or an attempt;
 *   6. OVERSELL CLAMPS AND RECORDS — the sale is accepted, stock lands at 0
 *      (never negative), and the gap is written where the merchant will see it;
 *   7. ARITHMETIC IS ENFORCED — a ticket that disagrees with itself is 422;
 *   8. THE STORE WALL HOLDS — store B's actor cannot sell on store A's device,
 *      and the answer is 404, not a hint the device exists;
 *   9. A REVOKED DEVICE CANNOT SELL;
 *  10. THE RETURNS MACHINERY ACCEPTS a POS sale — completed → returned is the
 *      existing edge — and books NOTHING in the ledger (there was no
 *      completion entry to reverse). STOREFRONT returns are consumed by
 *      «فحص المرتجعات» (RI-1): the storefront marks reservations
 *      pending_inspection and the merchant resolves them (restock/write-off)
 *      from the inventory screen. POS sales create NO reservation rows, so a
 *      POS return stays the manual-adjustment path (inventory.update) — this
 *      suite's assertions encode exactly that split. Updated 2026-09-02.
 *
 * POS OFFLINE v1 extends the ledger of claims (added 2026-09-02):
 *
 *  11. SALE TIME IS WRITTEN, BOUNDED — sold_at gets the till's ring-up time
 *      clamped into [now − 30d, now], while pos_tickets.device_reported_at
 *      keeps the RAW claim as evidence;
 *  12. THE TAKINGS KEY ON sold_at — an offline sale flushed today with a
 *      yesterday ring-up lands in YESTERDAY'S stats, completed and returned
 *      alike; and the migration's backfill restores sold_at for orders born
 *      before the column;
 *  13. THE CONTRACT THE OFFLINE QUEUE STANDS ON, pinned — the fingerprint is
 *      line-ORDER-sensitive (reordered resend = 409), deviceReportedAt and
 *      customerName are EXCLUDED from it (safe to vary on retry), a committed
 *      sale replays 200 from a revoked device (replay-before-revocation) with
 *      its persisted shortfalls, and a FRESH ticket on that device is 403;
 *  14. ARRIVAL ORDER DECIDES SHORTFALL ATTRIBUTION — of two sequential tickets
 *      over the same scarce variant, the first decrements cleanly and the
 *      SECOND carries the shortfall row — why the client flush must stay
 *      sequential FIFO.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const testId = `pos-${Date.now()}`;
process.env.SESSION_JWT_SECRET = process.env.SESSION_JWT_SECRET ?? "pos-test-secret-only-not-for-production";
process.env.CODIQ_ALLOW_OWNER_REGISTRATION = "true";
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

async function request(path, { method = "GET", body, token } = {}) {
  if (method !== "GET") await sql.query("DELETE FROM storefront_rate_limits");
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(method === "GET" ? {} : { origin: base }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, payload };
}

const summary = {};

try {
  await sql.query("DELETE FROM storefront_rate_limits");

  // ---------------------------------------------------------------- fixtures
  const phone = `+9647${String(Date.now()).slice(-9)}`;
  const merchantA = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone, email: `${testId}.a@codiq.test`, password: "PosMerchantPass2026!", businessName: "متجر الكاشير" });
  assert.equal(merchantA.status, 201, JSON.stringify(merchantA.payload));
  const storeA = await prisma.store.create({ data: { merchantId: merchantA.payload.account.id, name: "متجر الكاشير", slug: `${testId}-a`, defaultSubdomain: `${testId}-a` } });
  const merchantB = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: `+9647${String(Date.now() + 7).slice(-9)}`, email: `${testId}.b@codiq.test`, password: "PosMerchantPass2026!", businessName: "متجر آخر" });
  assert.equal(merchantB.status, 201, JSON.stringify(merchantB.payload));
  const storeB = await prisma.store.create({ data: { merchantId: merchantB.payload.account.id, name: "متجر آخر", slug: `${testId}-b`, defaultSubdomain: `${testId}-b` } });

  const tokenA = (await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.a@codiq.test`, password: "PosMerchantPass2026!" } })).payload.accessToken;
  const tokenB = (await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.b@codiq.test`, password: "PosMerchantPass2026!" } })).payload.accessToken;

  const product = await prisma.product.create({ data: { storeId: storeA.id, sku: "POS-SHIRT", name: "قميص المحل", priceIqd: 10000, isActive: true } });
  const variant = await prisma.productVariant.findFirstOrThrow({ where: { productId: product.id, isDefault: true } });
  await prisma.productVariant.update({ where: { id: variant.id }, data: { stockQuantity: 10, lowStockThreshold: 2 } });

  const posBase = `/merchant/stores/${storeA.slug}/pos`;

  // ---------------------------------------------------------------- devices
  const paired = await request(`${posBase}/devices`, { method: "POST", token: tokenA, body: { label: "كاشير ١" } });
  assert.equal(paired.status, 201, JSON.stringify(paired.payload));
  const device = paired.payload.device;
  assert.match(device.deviceShort, /^[A-HJ-NP-Z2-9]{4}$/, "ق-132: a short code readable off a receipt, no lookalike characters");

  // ---------------------------------------------------------------- 1+2+3: the sale
  const ticketId = randomUUID();
  const ticket = {
    deviceId: device.id,
    ticketId,
    lines: [{ variantId: variant.id, quantity: 3, unitPriceIqd: 10000 }],
    discountIqd: 1000,
    totalIqd: 29000,
    customerName: "زبون الكاونتر",
    deviceReportedAt: new Date().toISOString(),
  };
  const sale = await request(`${posBase}/tickets`, { method: "POST", token: tokenA, body: ticket });
  assert.equal(sale.status, 201, JSON.stringify(sale.payload));
  const order = sale.payload.order;
  assert.equal(sale.payload.replayed, false);
  assert.equal(order.source, "pos", "ق-132: a POS sale is a real StoreOrder with source pos");
  assert.equal(order.status, "completed", "ق-132: born completed — the customer left with the goods");
  assert.equal(order.paymentStatus, "paid", "ق-132: born paid — the cash is in the drawer");
  assert.equal(order.paymentMethodCode, "cash", "ق-135: cash, NOT cod — the no-commission rule hangs off this");
  assert.equal(order.totalIqd, 29000);
  assert.equal(order.deliveryFeeIqd, 0, "no courier exists in this sale");
  assert.ok(order.orderNumber.startsWith(`POS-${device.deviceShort}-`), "ق-132: the receipt names WHICH till sold it");

  // Stock moved once, on the shared balance.
  const stockAfterSale = (await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id }, select: { stockQuantity: true } })).stockQuantity;
  assert.equal(stockAfterSale, 7, "ق-132: one stock balance — the sale decremented it");
  const movement = await prisma.inventoryMovement.findFirst({ where: { storeId: storeA.id, variantId: variant.id, reason: "pos_sale" } });
  assert.ok(movement && movement.delta === -3, "ق-132: the movement trail records the counter sale");

  // ---- ق-135: THE ASSERTION THIS SUITE EXISTS FOR ----
  const ledgerRows = await prisma.ledgerEntry.count({ where: { storeId: storeA.id, orderId: order.id } });
  assert.equal(ledgerRows, 0, "ق-135: NO ledger entry — the platform never touched this cash");
  const anyLedger = await prisma.ledgerEntry.count({ where: { storeId: storeA.id } });
  assert.equal(anyLedger, 0, "ق-135: …and none anywhere in the store from this sale");
  // The order book still shows it — the reports' POS line reads from here.
  const inOrderBook = await request(`/merchant/stores/${storeA.slug}/orders`, { token: tokenA });
  assert.equal(inOrderBook.status, 200);
  const found = (inOrderBook.payload.orders ?? inOrderBook.payload.items ?? []).find((row) => row.id === order.id);
  assert.ok(found, "ق-132: the counter sale sits in the SAME order book the storefront writes to");

  // ---------------------------------------------------------------- 4: replay
  const replay = await request(`${posBase}/tickets`, { method: "POST", token: tokenA, body: ticket });
  assert.equal(replay.status, 200, "a replay answers 200, a fresh sale 201 — the till can tell them apart");
  assert.equal(replay.payload.replayed, true);
  assert.equal(replay.payload.order.id, order.id, "ق-132: the SAME order comes back, not a second one");
  const stockAfterReplay = (await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id }, select: { stockQuantity: true } })).stockQuantity;
  assert.equal(stockAfterReplay, 7, "ق-132: the replay sold NOTHING — stock untouched");
  assert.equal(await prisma.storeOrder.count({ where: { storeId: storeA.id, source: "pos" } }), 1, "one ticket, one order, however many retries");

  // ---------------------------------------------------------------- 5: reuse
  const reused = await request(`${posBase}/tickets`, {
    method: "POST", token: tokenA,
    body: { ...ticket, lines: [{ variantId: variant.id, quantity: 1, unitPriceIqd: 10000 }], discountIqd: 0, totalIqd: 10000 },
  });
  assert.equal(reused.status, 409, JSON.stringify(reused.payload));
  assert.equal(reused.payload.error.code, "TICKET_REUSED", "same id + different contents is not a retry");

  // ---------------------------------------------------------------- 7: arithmetic
  const wrong = await request(`${posBase}/tickets`, {
    method: "POST", token: tokenA,
    body: { ...ticket, ticketId: randomUUID(), totalIqd: 25000 },
  });
  assert.equal(wrong.payload.error.code, "TICKET_TOTALS_MISMATCH", "a ticket that disagrees with itself is refused");

  // A consistent ticket that would overflow INT4 must be a 422 the till can
  // show — not a 500 it replays forever (the poison-ticket finding).
  const overflow = await request(`${posBase}/tickets`, {
    method: "POST", token: tokenA,
    body: { deviceId: device.id, ticketId: randomUUID(), lines: [{ variantId: variant.id, quantity: 10000, unitPriceIqd: 250000 }], discountIqd: 0, totalIqd: 2500000000, deviceReportedAt: new Date().toISOString() },
  });
  assert.equal(overflow.status, 422, JSON.stringify(overflow.payload));
  assert.equal(overflow.payload.error.code, "INVALID_TICKET_LINE", "an INT4-overflowing sale is refused loudly, never a poison 500");

  // ---------------------------------------------------------------- 6: oversell
  const oversell = await request(`${posBase}/tickets`, {
    method: "POST", token: tokenA,
    body: {
      deviceId: device.id, ticketId: randomUUID(),
      lines: [{ variantId: variant.id, quantity: 20, unitPriceIqd: 10000 }],
      discountIqd: 0, totalIqd: 200000,
      deviceReportedAt: new Date().toISOString(),
    },
  });
  assert.equal(oversell.status, 201, "ق-132: the sale HAPPENED — refusing it deletes a truth, so it is accepted");
  assert.equal(oversell.payload.shortfalls.length, 1, "…and the gap is reported to the till");
  assert.equal(oversell.payload.shortfalls[0].shortfallQty, 13, "sold 20, had 7 — the gap is 13");
  const stockAfterOversell = (await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id }, select: { stockQuantity: true } })).stockQuantity;
  assert.equal(stockAfterOversell, 0, "clamped at zero — the CHECK constraint means negative is impossible, and we do not pretend otherwise");
  const shortfallList = await request(`${posBase}/shortfalls`, { token: tokenA });
  assert.equal(shortfallList.status, 200);
  assert.equal(shortfallList.payload.shortfalls.length, 1, "the merchant's reconciliation queue holds the gap");
  assert.equal(shortfallList.payload.shortfalls[0].shortfallQty, 13);

  // review drains the queue but deletes nothing
  const reviewId = shortfallList.payload.shortfalls[0].id;
  assert.equal((await request(`${posBase}/shortfalls/${reviewId}/review`, { method: "POST", token: tokenA })).status, 204);
  assert.equal((await request(`${posBase}/shortfalls`, { token: tokenA })).payload.shortfalls.length, 0, "reviewed leaves the open queue");
  assert.equal(await prisma.posTicketShortfall.count({ where: { storeId: storeA.id } }), 1, "…but the row stays — the discrepancy remains a fact");

  // ---------------------------------------------------------------- 8: the wall
  const crossSale = await request(`/merchant/stores/${storeB.slug}/pos/tickets`, {
    method: "POST", token: tokenB,
    body: { deviceId: device.id, ticketId: randomUUID(), lines: [{ variantId: variant.id, quantity: 1, unitPriceIqd: 10000 }], discountIqd: 0, totalIqd: 10000, deviceReportedAt: new Date().toISOString() },
  });
  assert.equal(crossSale.status, 404, "store B cannot use store A's device — and 404, not 403: whether it EXISTS elsewhere is not B's to learn");
  const crossList = await request(`/merchant/stores/${storeA.slug}/pos/devices`, { token: tokenB });
  assert.equal(crossList.status, 403, "store B's session cannot even list store A's tills");

  // ---------------------------------------------------------------- 9: revocation
  assert.equal((await request(`${posBase}/devices/${device.id}/revoke`, { method: "POST", token: tokenA })).status, 204);
  const revokedSale = await request(`${posBase}/tickets`, {
    method: "POST", token: tokenA,
    body: { deviceId: device.id, ticketId: randomUUID(), lines: [{ variantId: variant.id, quantity: 1, unitPriceIqd: 10000 }], discountIqd: 0, totalIqd: 10000, deviceReportedAt: new Date().toISOString() },
  });
  assert.equal(revokedSale.payload.error.code, "DEVICE_REVOKED", "a revoked till cannot write sales");
  // …and revocation is idempotent with a stable timestamp
  const firstRevokedAt = (await prisma.posDevice.findUniqueOrThrow({ where: { id: device.id }, select: { revokedAt: true } })).revokedAt;
  await request(`${posBase}/devices/${device.id}/revoke`, { method: "POST", token: tokenA });
  const secondRevokedAt = (await prisma.posDevice.findUniqueOrThrow({ where: { id: device.id }, select: { revokedAt: true } })).revokedAt;
  assert.equal(firstRevokedAt.valueOf(), secondRevokedAt.valueOf(), "«متى فقد الثقة» must not move on a double-click");

  // ---------------------------------------------------------------- 10: returns
  // completed → returned is the EXISTING lifecycle edge; a POS sale must ride it.
  const returned = await request(`/merchant/stores/${storeA.slug}/orders/${order.id}/status`, {
    method: "POST", token: tokenA,
    body: { toStatus: "returned", expectedVersion: 1 },
  });
  assert.equal(returned.status, 200, `ق-132: the return machinery accepts a POS sale untouched — ${JSON.stringify(returned.payload)}`);
  // Ledger stays empty even after the return: there was no completion entry to
  // reverse, and a reversal row here would subtract from revenue the ledger
  // never added (the exact trap the sign guard documents).
  assert.equal(await prisma.ledgerEntry.count({ where: { storeId: storeA.id } }), 0, "ق-135: the return of a cash sale books nothing either");

  // ------------------------------------------------------------ plan quota
  // ق-135 extends to the monthly-order cap: a counter sale is not
  // platform-carried volume, so it must not spend the quota — otherwise a
  // busy till would block the merchant's own ONLINE shoppers at checkout.
  // Two POS sales exist by this point; the usage counter must see zero.
  const { merchantUsage } = await import("../src/services/entitlement.service.ts");
  const usage = await merchantUsage(prisma, merchantA.payload.account.id);
  const nonPosOrders = await prisma.storeOrder.count({ where: { storeId: storeA.id, source: { not: "pos" } } });
  assert.equal(usage.max_monthly_orders, nonPosOrders, "ق-135: POS sales do not spend the monthly-order quota");
  const posOrders = await prisma.storeOrder.count({ where: { storeId: storeA.id, source: "pos" } });
  assert.ok(posOrders >= 2, "…and the premise holds: POS orders exist to be excluded");

  const device2 = (await request(`${posBase}/devices`, { method: "POST", token: tokenA, body: { label: "كاشير ٢" } })).payload.device;
  // ------------------------------------------------------------ reservations
  // THE CRITICAL FINDING from the adversarial panel, pinned forever. The
  // storefront does not decrement at checkout — it holds ACTIVE reservations
  // and decrements at completion, throwing if the stock is gone. A till that
  // spends raw stockQuantity sells the very units a shopper's courier is
  // already carrying, and the delivered order can then NEVER be completed:
  // frozen order, frozen wallet credit. The till may only spend
  // stockQuantity − active reservations.
  const resvProduct = await prisma.product.create({ data: { storeId: storeA.id, sku: "POS-RESV", name: "صنف محجوز", priceIqd: 8000, isActive: true } });
  const resvVariant = await prisma.productVariant.findFirstOrThrow({ where: { productId: resvProduct.id, isDefault: true } });
  await prisma.productVariant.update({ where: { id: resvVariant.id }, data: { stockQuantity: 5, lowStockThreshold: 0 } });
  // A shopper's checkout holds 3 of the 5 — exactly what the storefront writes.
  const heldOrder = await prisma.storeOrder.create({ data: { storeId: storeA.id, orderNumber: `SF-HELD-${Date.now()}`, status: "new", customerName: "زبون متجر", subtotalIqd: 24000, totalIqd: 24000, paymentStatus: "unpaid", paymentMethodCode: "cod", source: "storefront", updatedByKind: "customer" } });
  await prisma.inventoryReservation.create({ data: { storeId: storeA.id, orderId: heldOrder.id, productId: resvProduct.id, variantId: resvVariant.id, quantity: 3, status: "active" } });

  // The till tries to sell 4. Only 2 are truly free (5 − 3 reserved).
  const greedy = await request(`${posBase}/tickets`, {
    method: "POST", token: tokenA,
    body: { deviceId: device2.id, ticketId: randomUUID(), lines: [{ variantId: resvVariant.id, quantity: 4, unitPriceIqd: 8000 }], discountIqd: 0, totalIqd: 32000, deviceReportedAt: new Date().toISOString() },
  });
  assert.equal(greedy.status, 201, JSON.stringify(greedy.payload));
  assert.equal(greedy.payload.shortfalls.length, 1, "the till is told it oversold the FREE slice");
  assert.equal(greedy.payload.shortfalls[0].shortfallQty, 2, "wanted 4, free 2 — the gap is 2");
  const afterGreedy = (await prisma.productVariant.findUniqueOrThrow({ where: { id: resvVariant.id }, select: { stockQuantity: true } })).stockQuantity;
  assert.equal(afterGreedy, 3, "stock lands at exactly the reserved amount — the shopper's 3 units are untouchable");

  // And the assertion that MATTERS: the shopper's delivered order completes.
  let heldVersion = 1;
  for (const step of ["processing", "preparation", "out_for_delivery", "completed"]) {
    const moved = await request(`/merchant/stores/${storeA.slug}/orders/${heldOrder.id}/status`, {
      method: "POST", token: tokenA,
      body: { toStatus: step, expectedVersion: heldVersion },
    });
    heldVersion += 1;
    assert.equal(moved.status, 200, `the shopper's order must reach ${step}: ${JSON.stringify(moved.payload)}`);
  }
  const afterCompletion = (await prisma.productVariant.findUniqueOrThrow({ where: { id: resvVariant.id }, select: { stockQuantity: true } })).stockQuantity;
  assert.equal(afterCompletion, 0, "completion consumed the reserved 3 — nobody's units were sold twice");
  summary.reservationsRespected = { free: 2, reserved: 3, completionSucceeded: true };

  // ------------------------------------------------------------ isolated stats
  // The owner asked for this in as many words: a monthly cashier statistic
  // and the plan quota, «كل واحدة معزولة عن الثانية». Three isolations:
  //   revenue (ledger)  — untouched by POS: the platform carried none of it;
  //   pos.takingsIqd    — from ORDERS, minus returned sales (drawer refunds);
  //   plan quota        — counts platform-carried orders only.
  const { analyticsSummary } = await import("../src/services/analytics.service.ts");
  const stats = await analyticsSummary(storeA.id, {});
  // BOTH sides of the isolation, in one store, at once: a completed
  // storefront order (24,000, via the reservation scenario) and three POS
  // tickets. Each number must contain ONLY its own channel.
  assert.equal(stats.revenue.revenueIqd, 24000, "the LEDGER holds exactly the storefront completion — no counter cash");
  assert.equal(stats.pos.completedSales, 2, "two live POS sales (oversell + reserved-slice) — the first was returned");
  assert.equal(stats.pos.returnedSales, 1, "…and the returned one is counted as returned");
  assert.equal(stats.pos.takingsIqd, 200000 + 32000 - 29000, "takings = live POS sales − drawer refunds, from orders alone");
  assert.equal(stats.pos.countsTowardPlanQuota, false, "stated in the payload so the UI never has to guess");
  assert.equal(stats.ordersCount, 1, "the platform-carried count holds exactly the storefront order");
  summary.isolatedStats = { ledgerRevenue: 0, posTakings: stats.pos.takingsIqd, quotaCounts: "platform-only" };

  summary.sale = { source: "pos", bornCompleted: true, bornPaid: true, method: "cash" };
  summary.ledgerEntries = 0;
  summary.replaySellsOnce = true;
  summary.oversell = { accepted: true, clampedTo: 0, shortfall: 13 };
  summary.storeWall = { crossSale: 404, crossList: 403 };
  summary.returnsWork = true;
  summary.quotaExcludesPos = true;

  // ---------------------------------------------------------------- 11: soldAt
  // POS offline v1: sold_at is when the cash changed hands per the till's
  // clock, clamped server-side into [now − 30d, now]. The clamp bounds a lying
  // clock WITHOUT rewriting the evidence — device_reported_at stays as-sent.
  const DAY = 24 * 60 * 60 * 1000;
  const clockProduct = await prisma.product.create({ data: { storeId: storeA.id, sku: "POS-CLOCK", name: "صنف الساعة", priceIqd: 5000, isActive: true } });
  const clockVariant = await prisma.productVariant.findFirstOrThrow({ where: { productId: clockProduct.id, isDefault: true } });
  await prisma.productVariant.update({ where: { id: clockVariant.id }, data: { stockQuantity: 100, lowStockThreshold: 0 } });

  async function sellAt(deviceReportedAt, { quantity = 1 } = {}) {
    const tid = randomUUID();
    const response = await request(`${posBase}/tickets`, {
      method: "POST", token: tokenA,
      body: { deviceId: device2.id, ticketId: tid, lines: [{ variantId: clockVariant.id, quantity, unitPriceIqd: 5000 }], discountIqd: 0, totalIqd: quantity * 5000, deviceReportedAt },
    });
    assert.equal(response.status, 201, JSON.stringify(response.payload));
    const dbOrder = await prisma.storeOrder.findUniqueOrThrow({ where: { id: response.payload.order.id }, select: { id: true, soldAt: true, createdAt: true } });
    const dbTicket = await prisma.posTicket.findFirstOrThrow({ where: { storeId: storeA.id, deviceId: device2.id, ticketId: tid }, select: { deviceReportedAt: true } });
    return { order: dbOrder, ticket: dbTicket };
  }

  const threeDaysAgo = new Date(Date.now() - 3 * DAY);
  const honest = await sellAt(threeDaysAgo.toISOString());
  assert.equal(honest.order.soldAt.valueOf(), threeDaysAgo.valueOf(), "a plausible ring-up time is written to sold_at EXACTLY — offline days are normal, not suspicious");
  assert.equal(honest.ticket.deviceReportedAt.valueOf(), threeDaysAgo.valueOf(), "…and the raw claim is untouched");

  const fortyDaysAgo = new Date(Date.now() - 40 * DAY);
  const tooOld = await sellAt(fortyDaysAgo.toISOString());
  assert.ok(Math.abs(tooOld.order.soldAt.valueOf() - (Date.now() - 30 * DAY)) < 60_000, "a 40-day-old claim is clamped to now − 30d — a lying clock cannot backdate the stats arbitrarily");
  assert.equal(tooOld.ticket.deviceReportedAt.valueOf(), fortyDaysAgo.valueOf(), "…while device_reported_at keeps the 40-day-old claim as evidence");

  const inTwoDays = new Date(Date.now() + 2 * DAY);
  const fromTheFuture = await sellAt(inTwoDays.toISOString());
  assert.ok(fromTheFuture.order.soldAt.valueOf() <= Date.now() + 1_000 && fromTheFuture.order.soldAt.valueOf() > Date.now() - 60_000, "a future claim is clamped to now — nothing is sold tomorrow");
  assert.equal(fromTheFuture.ticket.deviceReportedAt.valueOf(), inTwoDays.valueOf(), "…and the future claim too stays raw in the evidence");
  summary.soldAtClamp = { exactWithin30d: true, floor: "now-30d", ceiling: "now", rawEvidencePreserved: true };

  // ------------------------------------------------------ 12: stats on sold_at
  // The reason sold_at exists: a Monday outage flushed on Tuesday must land in
  // MONDAY's takings. Both POS aggregates — completed AND returned — moved to
  // the sold_at axis together.
  const todayRange = { from: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() };
  const todayBefore = await analyticsSummary(storeA.id, todayRange);
  const yesterday = new Date(Date.now() - 1 * DAY);
  const flushedLate = await sellAt(yesterday.toISOString(), { quantity: 2 });
  const flushedLateReturn = await sellAt(yesterday.toISOString(), { quantity: 1 });
  const lateReturn = await request(`/merchant/stores/${storeA.slug}/orders/${flushedLateReturn.order.id}/status`, {
    method: "POST", token: tokenA,
    body: { toStatus: "returned", expectedVersion: 1 },
  });
  assert.equal(lateReturn.status, 200, JSON.stringify(lateReturn.payload));

  const yesterdayRange = { from: new Date(yesterday.valueOf() - 6 * 60 * 60 * 1000).toISOString(), to: new Date(yesterday.valueOf() + 6 * 60 * 60 * 1000).toISOString() };
  const yesterdayStats = await analyticsSummary(storeA.id, yesterdayRange);
  assert.equal(yesterdayStats.pos.completedSales, 1, "the sale flushed TODAY lands in YESTERDAY — takings key on sold_at, not sync time");
  assert.equal(yesterdayStats.pos.returnedSales, 1, "…and the returned aggregate rides the SAME axis");
  assert.equal(yesterdayStats.pos.takingsIqd, 10000 - 5000, "yesterday's net takings = its sale − its drawer refund");

  const todayAfter = await analyticsSummary(storeA.id, todayRange);
  assert.equal(todayAfter.pos.completedSales, todayBefore.pos.completedSales, "the yesterday-rung sale is ABSENT from today's completed block");
  assert.equal(todayAfter.pos.returnedSales, todayBefore.pos.returnedSales, "…and absent from today's returned block");
  assert.equal(todayAfter.pos.takingsIqd, todayBefore.pos.takingsIqd, "today's takings are untouched by a flush that merely ARRIVED today");

  // Backfill pin: the migration's own UPDATE statements must restore sold_at
  // for POS orders born before the column existed — from the ticket's
  // device_reported_at where a ticket exists, from created_at otherwise.
  const { readFile } = await import("node:fs/promises");
  const migrationSql = await readFile(new URL("../../prisma/migrations/20260902200000_pos_offline_sold_at/migration.sql", import.meta.url), "utf8");
  const backfills = migrationSql
    .split(";")
    .map((chunk) => chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter((statement) => statement.toUpperCase().startsWith("UPDATE"));
  assert.equal(backfills.length, 2, "the migration carries exactly the two backfill UPDATEs");
  await sql.query("UPDATE store_orders SET sold_at = NULL WHERE id = $1", [flushedLate.order.id]);
  const ticketlessHusk = await prisma.storeOrder.create({ data: { storeId: storeA.id, orderNumber: `POS-HUSK-${Date.now()}`, status: "completed", customerName: "زبون قديم", subtotalIqd: 1000, totalIqd: 1000, paymentStatus: "paid", paymentMethodCode: "cash", source: "pos", updatedByKind: "merchant" } });
  for (const statement of backfills) await sql.query(statement);
  const refilled = await prisma.storeOrder.findUniqueOrThrow({ where: { id: flushedLate.order.id }, select: { soldAt: true } });
  assert.equal(refilled.soldAt.valueOf(), yesterday.valueOf(), "backfill: sold_at = the ticket's device_reported_at for pre-existing POS orders");
  const huskRow = await prisma.storeOrder.findUniqueOrThrow({ where: { id: ticketlessHusk.id }, select: { soldAt: true, createdAt: true } });
  assert.equal(huskRow.soldAt.valueOf(), huskRow.createdAt.valueOf(), "backfill fallback: a ticketless POS order gets sold_at = created_at");
  summary.soldAtStats = { keyedOnSoldAt: true, bothAggregates: true, backfill: "ticket-join then created_at" };

  // ----------------------------------------------------- 13: the queue's contract
  // The offline queue's whole design leans on FOUR server facts. Pin each, so
  // a future «tidier» fingerprint or guard cannot silently brick every queued
  // replay in the country.
  const pinProduct = await prisma.product.create({ data: { storeId: storeA.id, sku: "POS-PIN", name: "صنف التثبيت", priceIqd: 7000, isActive: true } });
  const pinVariant = await prisma.productVariant.findFirstOrThrow({ where: { productId: pinProduct.id, isDefault: true } });
  await prisma.productVariant.update({ where: { id: pinVariant.id }, data: { stockQuantity: 50, lowStockThreshold: 0 } });

  const pinLines = [
    { variantId: clockVariant.id, quantity: 1, unitPriceIqd: 5000 },
    { variantId: pinVariant.id, quantity: 1, unitPriceIqd: 7000 },
  ];
  const pinBody = { deviceId: device2.id, ticketId: randomUUID(), lines: pinLines, discountIqd: 0, totalIqd: 12000, customerName: "زبون الطابور", deviceReportedAt: new Date().toISOString() };
  const pinSale = await request(`${posBase}/tickets`, { method: "POST", token: tokenA, body: pinBody });
  assert.equal(pinSale.status, 201, JSON.stringify(pinSale.payload));

  // (a) the fingerprint hashes lines IN ARRAY ORDER: a reordered resend is not
  // a retry — the queue must persist the payload at enqueue and resend it
  // verbatim, never rebuild it.
  const reordered = await request(`${posBase}/tickets`, { method: "POST", token: tokenA, body: { ...pinBody, lines: [pinLines[1], pinLines[0]] } });
  assert.equal(reordered.status, 409, JSON.stringify(reordered.payload));
  assert.equal(reordered.payload.error.code, "TICKET_REUSED", "line ORDER is part of the fingerprint — reordering turns an honest retry into a refusal");

  // (b) deviceReportedAt and customerName are EXCLUDED from the fingerprint —
  // the only fields a retry may safely vary.
  const shiftedClock = await request(`${posBase}/tickets`, { method: "POST", token: tokenA, body: { ...pinBody, deviceReportedAt: new Date(Date.now() + 1_000).toISOString() } });
  assert.equal(shiftedClock.status, 200, JSON.stringify(shiftedClock.payload));
  assert.equal(shiftedClock.payload.replayed, true, "deviceReportedAt is outside the fingerprint — a retry that re-reports time still replays");
  const renamedCustomer = await request(`${posBase}/tickets`, { method: "POST", token: tokenA, body: { ...pinBody, customerName: "زبون آخر" } });
  assert.equal(renamedCustomer.status, 200, JSON.stringify(renamedCustomer.payload));
  assert.equal(renamedCustomer.payload.replayed, true, "customerName is outside the fingerprint too");

  // (c) replay-before-revocation, WITH the persisted shortfalls riding back:
  // a sale commits, its response is lost, the device is revoked — the queued
  // ack must still land, clamp warning included.
  const device3 = (await request(`${posBase}/devices`, { method: "POST", token: tokenA, body: { label: "كاشير ٣" } })).payload.device;
  const scarceProduct = await prisma.product.create({ data: { storeId: storeA.id, sku: "POS-SCARCE", name: "صنف شحيح", priceIqd: 3000, isActive: true } });
  const scarceVariant = await prisma.productVariant.findFirstOrThrow({ where: { productId: scarceProduct.id, isDefault: true } });
  await prisma.productVariant.update({ where: { id: scarceVariant.id }, data: { stockQuantity: 2, lowStockThreshold: 0 } });
  const committedBody = { deviceId: device3.id, ticketId: randomUUID(), lines: [{ variantId: scarceVariant.id, quantity: 5, unitPriceIqd: 3000 }], discountIqd: 0, totalIqd: 15000, deviceReportedAt: new Date().toISOString() };
  const committed = await request(`${posBase}/tickets`, { method: "POST", token: tokenA, body: committedBody });
  assert.equal(committed.status, 201, JSON.stringify(committed.payload));
  assert.equal(committed.payload.shortfalls.length, 1, "the committed sale oversold — the clamp recorded a gap");
  assert.equal((await request(`${posBase}/devices/${device3.id}/revoke`, { method: "POST", token: tokenA })).status, 204);
  const ackAfterRevoke = await request(`${posBase}/tickets`, { method: "POST", token: tokenA, body: committedBody });
  assert.equal(ackAfterRevoke.status, 200, JSON.stringify(ackAfterRevoke.payload));
  assert.equal(ackAfterRevoke.payload.replayed, true, "replay-before-revocation: acknowledging an EXISTING sale is not the act revocation guards");
  assert.deepEqual(ackAfterRevoke.payload.shortfalls, [{ variantId: scarceVariant.id, shortfallQty: 3 }], "…and the PERSISTED shortfalls ride the replay — the lost clamp warning is re-delivered");

  // (d) a FRESH ticket on the revoked device is refused — the flush must halt
  // at the first fresh 403 and keep the remainder pending.
  const freshOnRevoked = await request(`${posBase}/tickets`, {
    method: "POST", token: tokenA,
    body: { deviceId: device3.id, ticketId: randomUUID(), lines: [{ variantId: clockVariant.id, quantity: 1, unitPriceIqd: 5000 }], discountIqd: 0, totalIqd: 5000, deviceReportedAt: new Date().toISOString() },
  });
  assert.equal(freshOnRevoked.status, 403, JSON.stringify(freshOnRevoked.payload));
  assert.equal(freshOnRevoked.payload.error.code, "DEVICE_REVOKED", "fresh sales from a revoked device are refused — replays pass, new work does not");
  summary.queueContract = { reorderedLines: 409, timeOnlyRetry: 200, replayAfterRevoke: 200, freshAfterRevoke: 403 };

  // ------------------------------------------------- 14: arrival order attributes
  // Two tickets over the same scarce variant, sent SEQUENTIALLY: the first to
  // arrive decrements cleanly, the second eats the shortfall. Arrival order is
  // the server's attribution rule — which is exactly why the client flush must
  // stay sequential FIFO and never parallelise.
  const queueProduct = await prisma.product.create({ data: { storeId: storeA.id, sku: "POS-QUEUE", name: "صنف الدور", priceIqd: 2000, isActive: true } });
  const queueVariant = await prisma.productVariant.findFirstOrThrow({ where: { productId: queueProduct.id, isDefault: true } });
  await prisma.productVariant.update({ where: { id: queueVariant.id }, data: { stockQuantity: 5, lowStockThreshold: 0 } });
  const firstArrivalId = randomUUID();
  const secondArrivalId = randomUUID();
  const firstArrival = await request(`${posBase}/tickets`, {
    method: "POST", token: tokenA,
    body: { deviceId: device2.id, ticketId: firstArrivalId, lines: [{ variantId: queueVariant.id, quantity: 3, unitPriceIqd: 2000 }], discountIqd: 0, totalIqd: 6000, deviceReportedAt: new Date().toISOString() },
  });
  assert.equal(firstArrival.status, 201, JSON.stringify(firstArrival.payload));
  assert.equal(firstArrival.payload.shortfalls.length, 0, "first arrival: 3 of 5 — clean decrement, no shortfall");
  const secondArrival = await request(`${posBase}/tickets`, {
    method: "POST", token: tokenA,
    body: { deviceId: device2.id, ticketId: secondArrivalId, lines: [{ variantId: queueVariant.id, quantity: 4, unitPriceIqd: 2000 }], discountIqd: 0, totalIqd: 8000, deviceReportedAt: new Date().toISOString() },
  });
  assert.equal(secondArrival.status, 201, JSON.stringify(secondArrival.payload));
  assert.equal(secondArrival.payload.shortfalls.length, 1, "second arrival: wanted 4, found 2 — the gap is his");
  assert.equal(secondArrival.payload.shortfalls[0].shortfallQty, 2);
  const firstDbTicket = await prisma.posTicket.findFirstOrThrow({ where: { storeId: storeA.id, deviceId: device2.id, ticketId: firstArrivalId }, select: { id: true } });
  const secondDbTicket = await prisma.posTicket.findFirstOrThrow({ where: { storeId: storeA.id, deviceId: device2.id, ticketId: secondArrivalId }, select: { id: true } });
  assert.equal(await prisma.posTicketShortfall.count({ where: { posTicketId: firstDbTicket.id } }), 0, "no shortfall row hangs off the FIRST arrival");
  const attributed = await prisma.posTicketShortfall.findMany({ where: { posTicketId: secondDbTicket.id }, select: { shortfallQty: true, soldQty: true, availableQty: true } });
  assert.equal(attributed.length, 1, "the shortfall row hangs off the SECOND arrival — arrival order attributes");
  assert.deepEqual(attributed[0], { shortfallQty: 2, soldQty: 4, availableQty: 2 });
  const queueStockAfter = (await prisma.productVariant.findUniqueOrThrow({ where: { id: queueVariant.id }, select: { stockQuantity: true } })).stockQuantity;
  assert.equal(queueStockAfter, 0, "clamped at zero — both sales accepted, the truth recorded");
  summary.arrivalOrder = { firstShortfalls: 0, secondShortfalls: 1, rule: "FIFO attribution" };

  console.log(JSON.stringify({ pos: summary }, null, 2));
  console.log("pos OK");
} finally {
  await sql.end().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  server.close();
}
