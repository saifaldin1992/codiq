/**
 * ق-243 — a stale screen must not overwrite a sale.
 *
 * THE DEFECT (16-20-24 / 16-20-25). The product editor resent the stock it had
 * LOADED on every save, and `updateProduct` wrote that number over the default
 * variant's live stock with no compare-and-swap, computing the movement delta
 * from a value read BEFORE the transaction. Stock 10 on screen; the till sells 3
 * an hour later; the merchant fixes a typo in the description and presses «حفظ»
 * → stock is 10 again, three phantom units are sellable everywhere, and the
 * trail carries a «manual_adjustment» nobody performed. With a stale mobile tab
 * this is the everyday case, not a race.
 *
 * FOUR THINGS ARE ASSERTED, and each is a distinct way of getting this wrong:
 *
 *   1. the catalog PATCH REFUSES a stock field, out loud — an object schema
 *      strips unknown keys silently, and a client that kept sending it would
 *      believe it had set the stock while nothing happened
 *   2. the inventory door honours `expectedStockQuantity`: a stale expectation is
 *      a 409, the stock is untouched, no movement is written
 *   3. an absolute set with no expectation (a physical count) computes its delta
 *      from the TRUE current value, read under a row lock — so Σ(movements)
 *      still sums to the stock after a decrement landed in between
 *   4. the variant PATCH refuses stock the same way
 *
 * The «decrement that landed in between» is written the way the till writes it
 * (`updateMany … decrement`, pos.service.ts), through Prisma, no service — so
 * the suite is testing the service's behaviour against a real concurrent
 * writer's footprint rather than a mocked one.
 *
 * Run: pnpm inventory:cas
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const testId = `invcas-${Date.now()}`;
const suffix = String(Date.now()).slice(-8);
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
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

async function request(path, { method = "GET", body, token } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: base,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
  return { status: response.status, payload };
}

const summary = {};
try {
  const password = "InvCasPass123!";
  const registered = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    businessName: "متجر القفل",
    phone: `+96473${suffix}`,
    email: `${testId}@codiq.test`,
    password,
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const store = await prisma.store.create({
    data: {
      merchantId: registered.payload.account.id,
      name: "متجر القفل",
      slug: testId,
      defaultSubdomain: testId,
    },
  });
  const login = await request("/auth/merchant/login", {
    method: "POST",
    body: { identifier: `${testId}@codiq.test`, password },
  });
  assert.equal(login.status, 200, JSON.stringify(login.payload));
  const token = login.payload.accessToken;

  // Created through Prisma so the movement log starts EMPTY; the default variant
  // is minted by the Phase 20A mirror, exactly as it is for every real product.
  const product = await prisma.product.create({
    data: {
      storeId: store.id,
      sku: "CAS-1",
      name: "عطر القفل",
      priceIqd: 45000,
      stockQuantity: 10,
      lowStockThreshold: 0,
    },
  });
  const variant = await prisma.productVariant.findFirstOrThrow({
    where: { productId: product.id, isDefault: true },
    select: { id: true, stockQuantity: true },
  });
  assert.equal(variant.stockQuantity, 10, "the fixture starts at 10 on the default variant");

  const productPath = `/merchant/stores/${store.slug}/catalog/products/${product.id}`;
  const stockNow = async () =>
    (
      await prisma.productVariant.findUniqueOrThrow({
        where: { id: variant.id },
        select: { stockQuantity: true },
      })
    ).stockQuantity;
  const movements = async () => {
    const answer = await request(
      `/merchant/stores/${store.slug}/inventory/movements?productId=${product.id}`,
      { token }
    );
    assert.equal(answer.status, 200, JSON.stringify(answer.payload));
    return answer.payload.movements;
  };
  // The till's footprint, verbatim: a guarded atomic decrement, no service.
  const tillSells = (quantity) =>
    prisma.productVariant.updateMany({
      where: { id: variant.id, stockQuantity: { gte: quantity } },
      data: { stockQuantity: { decrement: quantity } },
    });

  // ============================================================
  // 1. The catalog PATCH refuses stock — loudly, naming the door.
  // ============================================================
  const patched = await request(productPath, {
    method: "PATCH",
    token,
    body: { description: "وصفٌ جديد", stockQuantity: 10 },
  });
  assert.equal(
    patched.status,
    422,
    `ق-243: stock on a catalog PATCH is refused, not stripped: ${JSON.stringify(patched.payload)}`
  );
  assert.equal(patched.payload.error.code, "VALIDATION_FAILED");
  assert.match(
    patched.payload.error.message,
    /الجرد/,
    "…and the refusal names the inventory door, because this field used to work"
  );
  assert.equal(await stockNow(), 10, "the stock is untouched");
  assert.deepEqual(await movements(), [], "…and no phantom manual_adjustment was written");
  const patchedWithout = await request(productPath, {
    method: "PATCH",
    token,
    body: { description: "وصفٌ جديد" },
  });
  assert.equal(
    patchedWithout.status,
    200,
    `the same PATCH without stock still works: ${JSON.stringify(patchedWithout.payload)}`
  );
  summary.patchRefusesStock =
    "PATCH with stockQuantity → 422 VALIDATION_FAILED naming الجرد; without it → 200";

  // ============================================================
  // 2. A stale expectation is a 409, and nothing moves.
  // ============================================================
  // The everyday case, with no race at all: the merchant's tab was opened when
  // the stock read 10. The till has since sold 3. He saves «12» — meaning two
  // more than the 10 he saw.
  assert.equal((await tillSells(3)).count, 1, "the till sold 3 through its own atomic decrement");
  assert.equal(await stockNow(), 7);
  const stale = await request(`${productPath}/inventory`, {
    method: "POST",
    token,
    body: { stockQuantity: 12, expectedStockQuantity: 10, reason: "تعديل من شاشة المنتج" },
  });
  assert.equal(
    stale.status,
    409,
    `ق-243: the screen said 10, the row says 7 — refused: ${JSON.stringify(stale.payload)}`
  );
  assert.equal(stale.payload.error.code, "STOCK_CHANGED");
  assert.match(stale.payload.error.message, /10/, "the message names what he saw…");
  assert.match(
    stale.payload.error.message,
    /7/,
    "…and what is true now, so his next decision is an informed one"
  );
  assert.equal(await stockNow(), 7, "the sale was NOT undone");
  assert.deepEqual(
    await movements(),
    [],
    "and no movement was written for a write that did not happen"
  );
  summary.staleExpectationRefused =
    "expectedStockQuantity 10 against a true 7 → 409 STOCK_CHANGED, stock still 7, trail empty";

  // ============================================================
  // 3. A fresh expectation goes through, and the delta is true.
  // ============================================================
  const fresh = await request(`${productPath}/inventory`, {
    method: "POST",
    token,
    body: { stockQuantity: 12, expectedStockQuantity: 7, reason: "وصلت شحنة" },
  });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.payload));
  assert.equal(await stockNow(), 12);
  let trail = await movements();
  assert.equal(trail.length, 1);
  assert.equal(
    trail[0].delta,
    5,
    "the movement records +5 — from the true 7, not from the 10 the merchant remembered"
  );

  // ============================================================
  // 4. An absolute count — no expectation — still computes from the TRUTH.
  // ============================================================
  // A physical count is legitimately absolute («it is 9 now, whatever it was»).
  // What must hold is the trail: a decrement lands AFTER the service's
  // pre-transaction read of the variant and BEFORE its write, and the delta must
  // describe the value that was actually overwritten.
  //
  // THE RACE IS LANDED ON PURPOSE, NOT BY TIMING. A first version of this case
  // sold the 4 units before the request and passed with the stale-read code
  // still in place — of course it did: by the time the service read the
  // variant, the sale was already in it. The seam `inventoryWriteHooks.beforeLock`
  // fires inside the transaction, after the caller's read and before the row
  // lock, which is precisely the gap the defect lives in. With the delta
  // computed from the locked row this reads +1; from the stale variant it reads
  // 9 − 12 = −3, and the trail lies by four units.
  const { inventoryWriteHooks } = await import("../src/services/product-catalog.service.ts");
  let soldInTheGap = 0;
  inventoryWriteHooks.beforeLock = async () => {
    soldInTheGap = (await tillSells(4)).count;
  };
  let counted;
  try {
    counted = await request(`${productPath}/inventory`, {
      method: "POST",
      token,
      body: { stockQuantity: 9, reason: "جرد فعليّ" },
    });
  } finally {
    inventoryWriteHooks.beforeLock = null;
  }
  assert.equal(
    soldInTheGap,
    1,
    "the till's decrement landed inside the gap, after the service read 12"
  );
  assert.equal(counted.status, 200, JSON.stringify(counted.payload));
  assert.equal(await stockNow(), 9);
  trail = await movements();
  const newest = trail[0];
  assert.equal(
    newest.delta,
    1,
    `ق-243: the delta is 9 − 8 = +1 (from the row, read under lock) — not 9 − 12 = −3 from the stale variant: got ${newest.delta}`
  );
  // The invariant the whole thing exists for: the trail sums to the stock. The
  // till's own decrements are not in the movement log here (written through
  // Prisma, no service), so the sum is over what the SERVICE wrote against
  // what the service saw — start 10, till −3 −4, adjustments +5 +1 = 9.
  const serviceDelta = trail.reduce((sum, row) => sum + row.delta, 0);
  assert.equal(
    10 - 3 - 4 + serviceDelta,
    await stockNow(),
    "Σ(service movements) + the till's sales reconciles to the stock — the trail no longer lies"
  );
  summary.absoluteCountIsHonest =
    "a count with no expectation writes delta = requested − locked current; the trail reconciles";

  // ============================================================
  // 5. The variant PATCH refuses stock the same way.
  // ============================================================
  const variantPatched = await request(`${productPath}/variants/${variant.id}`, {
    method: "PATCH",
    token,
    body: { name: "العبوة الكبيرة", stockQuantity: 50 },
  });
  assert.equal(
    variantPatched.status,
    422,
    `ق-243: the variant PATCH is the same door, refused the same way: ${JSON.stringify(variantPatched.payload)}`
  );
  assert.equal(variantPatched.payload.error.code, "VALIDATION_FAILED");
  assert.equal(await stockNow(), 9, "…and the variant's stock is untouched");
  summary.variantPatchRefusesStock = "PATCH variant with stockQuantity → 422, stock untouched";

  console.log(JSON.stringify({ suite: "inventory-cas", status: "passed", summary }, null, 2));
} finally {
  server.close();
  await prisma.$disconnect();
}
