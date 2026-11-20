/**
 * codiq ق-132 — the race the constraint exists for.
 *
 * The sequential replay test proves a retry AFTER the first sale returns the
 * original order. This suite proves the harder thing: TEN copies of the same
 * ticket arriving CONCURRENTLY — the till's sync worker and the cashier's
 * second tap and a flaky proxy's replay, all in flight at once — produce
 * exactly ONE order and ONE stock decrement.
 *
 * Application-level checks cannot win this race; only the UNIQUE constraint
 * can, which is why the design put it there. This suite is the proof that it
 * actually does — under Serializable isolation, with the retry loop absorbing
 * the losers' P2002s and returning them the winner's order.
 *
 * And a second race with DIFFERENT tickets on the same LAST UNITS: two tills
 * genuinely selling the tail of the stock concurrently. Both sales must be
 * accepted (both customers left with goods), stock must land at exactly zero
 * — never negative, never resurrected — and the loser's gap must be recorded
 * as a shortfall.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const testId = `posrace-${Date.now()}`;
process.env.SESSION_JWT_SECRET = process.env.SESSION_JWT_SECRET ?? "posrace-test-secret-only-not-for-production";
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

  const registered = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: `+9647${String(Date.now()).slice(-9)}`, email: `${testId}@codiq.test`, password: "PosRacePass2026!", businessName: "متجر السباق" });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const store = await prisma.store.create({ data: { merchantId: registered.payload.account.id, name: "متجر السباق", slug: testId, defaultSubdomain: testId } });
  await sql.query("DELETE FROM storefront_rate_limits");
  const token = (await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}@codiq.test`, password: "PosRacePass2026!" } })).payload.accessToken;

  const product = await prisma.product.create({ data: { storeId: store.id, sku: "RACE-ITEM", name: "صنف السباق", priceIqd: 5000, isActive: true } });
  const variant = await prisma.productVariant.findFirstOrThrow({ where: { productId: product.id, isDefault: true } });
  await prisma.productVariant.update({ where: { id: variant.id }, data: { stockQuantity: 50, lowStockThreshold: 0 } });

  const posBase = `/merchant/stores/${store.slug}/pos`;
  const device = (await request(`${posBase}/devices`, { method: "POST", token, body: { label: "كاشير السباق" } })).payload.device;
  // The rate-limit table is cleared ONCE here, not per request: the requests
  // below must fly together, and a serialised cleaner would unrace the race.
  await sql.query("DELETE FROM storefront_rate_limits");

  // ============================================================
  // Race 1 — the same ticket, ten concurrent copies, one sale.
  // ============================================================
  const ticketId = randomUUID();
  const ticket = {
    deviceId: device.id, ticketId,
    lines: [{ variantId: variant.id, quantity: 2, unitPriceIqd: 5000 }],
    discountIqd: 0, totalIqd: 10000,
    deviceReportedAt: new Date().toISOString(),
  };
  const volley = await Promise.all(Array.from({ length: 10 }, () => request(`${posBase}/tickets`, { method: "POST", token, body: ticket })));

  const fresh = volley.filter((r) => r.status === 201);
  const replays = volley.filter((r) => r.status === 200 && r.payload?.replayed);
  const failed = volley.filter((r) => ![200, 201].includes(r.status));
  assert.equal(failed.length, 0, `no copy may fail outright: ${JSON.stringify(failed.map((f) => f.payload))}`);
  assert.equal(fresh.length, 1, `exactly ONE copy creates the sale (got ${fresh.length})`);
  assert.equal(replays.length, 9, "…and the other nine get the winner's order back");
  const orderIds = new Set(volley.map((r) => r.payload.order.id));
  assert.equal(orderIds.size, 1, "all ten callers hold the SAME order");

  const stockAfter = (await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id }, select: { stockQuantity: true } })).stockQuantity;
  assert.equal(stockAfter, 48, "ten concurrent copies decremented the stock ONCE (50 − 2)");
  assert.equal(await prisma.storeOrder.count({ where: { storeId: store.id, source: "pos" } }), 1, "one order in the book");
  assert.equal(await prisma.inventoryMovement.count({ where: { storeId: store.id, reason: "pos_sale" } }), 1, "one movement row");
  assert.equal(await prisma.ledgerEntry.count({ where: { storeId: store.id } }), 0, "ق-135 holds under concurrency too");

  summary.sameTicketRace = { copies: 10, created: fresh.length, replayed: replays.length, stockDelta: 2 };

  // ============================================================
  // Race 2 — different tickets fighting over the last units.
  // ============================================================
  await prisma.productVariant.update({ where: { id: variant.id }, data: { stockQuantity: 3 } });
  const mkTicket = () => ({
    deviceId: device.id, ticketId: randomUUID(),
    lines: [{ variantId: variant.id, quantity: 2, unitPriceIqd: 5000 }],
    discountIqd: 0, totalIqd: 10000,
    deviceReportedAt: new Date().toISOString(),
  });
  const [saleA, saleB] = await Promise.all([
    request(`${posBase}/tickets`, { method: "POST", token, body: mkTicket() }),
    request(`${posBase}/tickets`, { method: "POST", token, body: mkTicket() }),
  ]);
  assert.equal(saleA.status, 201, JSON.stringify(saleA.payload));
  assert.equal(saleB.status, 201, JSON.stringify(saleB.payload));

  const finalStock = (await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id }, select: { stockQuantity: true } })).stockQuantity;
  assert.equal(finalStock, 0, "3 on the shelf, 4 sold: the balance lands at ZERO — never negative, never resurrected");
  const shortfalls = await prisma.posTicketShortfall.findMany({ where: { storeId: store.id }, select: { shortfallQty: true } });
  const totalShort = shortfalls.reduce((sum, row) => sum + row.shortfallQty, 0);
  assert.equal(totalShort, 1, "…and the missing unit is recorded as a shortfall, not swallowed");
  // The movement trail must sum to exactly the stock that actually left.
  const movements = await prisma.inventoryMovement.aggregate({ where: { storeId: store.id, reason: "pos_sale" }, _sum: { delta: true } });
  assert.equal(movements._sum.delta, -(2 + 3), "movements account for every unit that left: 2 in race 1, 3 in race 2");

  summary.lastUnitsRace = { shelf: 3, sold: 4, finalStock: 0, shortfall: totalShort };

  console.log(JSON.stringify({ posRace: summary }, null, 2));
  console.log("pos-race OK");
} finally {
  await sql.end().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  server.close();
}
