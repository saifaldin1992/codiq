/**
 * codiq CD-5 «نقاط الولاء» — earned on completion, spent as a discount.
 *
 * Points are money by another name, so the tests are the integrity rules:
 *
 *   1. THE BALANCE IS A SUM — never a stored column. Asserted by computing it a
 *      second way, straight from the entries, and requiring the two to agree;
 *   2. EARNING IS IDEMPOTENT BY INDEX — completing twice awards once, and the
 *      award is on the DISCOUNTED subtotal, not the pre-coupon figure;
 *   3. A RETURN REVERSES BOTH SIDES — the award is clawed back (or buy→return is
 *      a points printer) and points spent on that order come back (or the
 *      shopper is refunded in money for the cash half and nothing for the rest);
 *   4. SPENDING CANNOT EXCEED THE BALANCE, cannot exceed what is left to pay for
 *      goods after a coupon, and never touches the delivery fee;
 *   5. THE HISTORY IS APPEND-ONLY — the database refuses to rewrite it;
 *   6. OFF BY DEFAULT — a merchant never discovers he has been giving discounts
 *      away, and redeeming against a disabled programme is refused;
 *   7. A DIFFERENT REDEMPTION UNDER THE SAME IDEMPOTENCY KEY is a different
 *      request, not a silent replay of the first;
 *   8. THE REDEMPTION REACHES THE FINANCIAL LEDGER (19-د). Points reduce the
 *      cash a COD courier collects, so a ledger that does not carry them makes
 *      the platform pay the merchant money nobody ever paid in. This suite used
 *      to assert the order row and the points history and never once read
 *      `ledger_entries`, which is precisely how the defect survived;
 *   9. A POINT CARRIES THE VALUE IT WAS EARNED AT (LOY-1). A merchant who
 *      lowers `pointValueIqd` may change what he awards NEXT; he may not reach
 *      back and re-price what a customer is already holding. Asserted from the
 *      shopper's side — the money on his statement is the money the checkout
 *      then gives him, across two lots at two rates, to the dinar.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { Client } from "pg";

const testId = `cd5-${Date.now()}`;
process.env.SESSION_JWT_SECRET = process.env.SESSION_JWT_SECRET ?? "cd5-test-secret-only-not-for-production";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { pointsForSubtotal, LOYALTY_EARN_PER_1000_MAX, LOYALTY_POINT_VALUE_MAX, loyaltyHoldHooks } = await import("../src/services/loyalty.service.ts");
// LOY-2 holds fresh points for the return window. Section 1 proves the hold on
// the real 15 days; everything after it spends points minutes old, so the suite
// runs with no hold rather than waiting two weeks.
const LOYALTY_HOLD_DAYS = loyaltyHoldHooks.holdDays;
const { merchantWallet } = await import("../src/services/merchant-wallet.service.ts");

// The award is an EXACT integer floor, not a binary fraction. `(570 / 1000) * 100`
// is 56.99999999999999 and used to floor to 56. Swept against BigInt arithmetic
// so no rate × subtotal pair inside the programme bounds can drift again.
assert.equal(pointsForSubtotal(570, { enabled: true, earnPer1000: 100, pointValueIqd: 10 }), 57, "570 IQD at 100 per 1000 earns 57 points, not 56");
for (const earnPer1000 of [1, 5, 10, 25, 100, LOYALTY_EARN_PER_1000_MAX]) {
  for (let subtotal = 1; subtotal <= 50_000; subtotal += 1) {
    const exact = Number((BigInt(subtotal) * BigInt(earnPer1000)) / 1000n);
    if (pointsForSubtotal(subtotal, { enabled: true, earnPer1000, pointValueIqd: 1 }) !== exact) {
      assert.fail(`pointsForSubtotal(${subtotal}, ${earnPer1000}/1000) must be ${exact}`);
    }
  }
}

const sql = new Client({ connectionString: process.env.DATABASE_URL });
await sql.connect();
const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let keySeq = 0;
async function request(path, { method = "GET", body, token, headers = {} } = {}) {
  if (method !== "GET") await sql.query("DELETE FROM storefront_rate_limits");
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(method === "GET" ? {} : { origin: base }),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, payload };
}

/** The balance computed independently of the service, from the rows themselves. */
async function balanceFromEntries(storeId, customerId) {
  const rows = await prisma.loyaltyEntry.findMany({ where: { storeId, customerId }, select: { kind: true, points: true } });
  const sign = { earned: 1, refunded_spend: 1, spent: -1, reversed_earn: -1 };
  return rows.reduce((total, row) => total + sign[row.kind] * row.points, 0);
}

const summary = {};

try {
  await sql.query("DELETE FROM storefront_rate_limits");

  const merchant = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: `+9647${String(Date.now()).slice(-9)}`, email: `${testId}@codiq.test`, password: "cd5-merchant-pass", businessName: "تجارة الولاء" });
  assert.equal(merchant.status, 201, JSON.stringify(merchant.payload));
  const store = await prisma.store.create({ data: { merchantId: merchant.payload.account.id, name: "متجر الولاء", slug: `${testId}-a`, defaultSubdomain: `${testId}-a` } });
  const token = (await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}@codiq.test`, password: "cd5-merchant-pass" } })).payload.accessToken;

  const product = await prisma.product.create({ data: { storeId: store.id, sku: `${testId}-P`, name: "منتج الولاء", priceIqd: 10000, isActive: true } });
  const variant = await prisma.productVariant.update({
    where: { id: (await prisma.productVariant.findFirstOrThrow({ where: { productId: product.id, isDefault: true } })).id },
    data: { sku: `${testId}-P-D`, stockQuantity: 500, priceIqd: 10000 },
  });
  await prisma.deliveryRate.create({ data: { storeId: store.id, governorate: "Baghdad", amountIqd: 3000, isEnabled: true } });

  const email = `${testId}.buyer@codiq.test`;
  const registered = await request(`/store/${store.slug}/account/register`, {
    method: "POST",
    body: { phone: `+9647${String(Date.now() + 3).slice(-9)}`, email, password: "Cd5ShopperPass2026!", fullName: "زبون الولاء" },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const shopper = registered.payload.accessToken;
  const customer = await prisma.customer.findFirstOrThrow({ where: { storeId: store.id, email }, select: { id: true } });
  const addressCreated = await request(`/store/${store.slug}/account/addresses`, {
    method: "POST", token: shopper,
    body: { recipientName: "زبون الولاء", fullAddress: "شارع الولاء 1", city: "Baghdad", governorate: "Baghdad", phoneContact: `+9647${String(Date.now() + 3).slice(-9)}`, isDefault: true },
  });
  assert.equal(addressCreated.status, 201, JSON.stringify(addressCreated.payload));
  const addressId = addressCreated.payload.address.id;

  /** Buy `quantity` units, optionally redeeming points. Returns the created order. */
  async function buy({ quantity = 1, loyaltyPoints, expect = 201 } = {}) {
    keySeq += 1;
    await request(`/store/${store.slug}/cart/items`, { method: "POST", token: shopper, body: { productId: product.id, variantId: variant.id, quantity } });
    const cart = await request(`/store/${store.slug}/cart`, { token: shopper });
    const checkout = await request(`/store/${store.slug}/checkout`, {
      method: "POST", token: shopper,
      headers: { "idempotency-key": `${testId}-key-${String(keySeq).padStart(4, "0")}` },
      body: { cartVersion: cart.payload.cart.version, addressId, paymentMethodCode: "cod", ...(loyaltyPoints === undefined ? {} : { loyaltyPoints }) },
    });
    assert.equal(checkout.status, expect, JSON.stringify(checkout.payload));
    return checkout;
  }
  async function completeOrder(orderId) {
    let version = 1;
    for (const toStatus of ["processing", "preparation", "out_for_delivery", "completed"]) {
      const moved = await request(`/merchant/stores/${store.slug}/orders/${orderId}/status`, { method: "POST", token, body: { toStatus, expectedVersion: version } });
      assert.equal(moved.status, 200, `${toStatus}: ${JSON.stringify(moved.payload)}`);
      version = moved.payload.order.version;
    }
  }

  // ============================================================
  // 6. Off by default.
  // ============================================================
  const defaults = await request(`/merchant/stores/${store.slug}/loyalty`, { token });
  assert.equal(defaults.status, 200, JSON.stringify(defaults.payload));
  assert.equal(defaults.payload.loyalty.enabled, false, "CD-5: no merchant discovers he has been giving discounts because an update defaulted a programme on");

  const noProgramme = await buy();
  await completeOrder(noProgramme.payload.order.id);
  assert.equal(await prisma.loyaltyEntry.count({ where: { storeId: store.id } }), 0, "CD-5: a disabled programme awards nothing");

  const enabled = await request(`/merchant/stores/${store.slug}/loyalty`, { method: "PUT", token, body: { enabled: true, earnPer1000: 10, pointValueIqd: 10 } });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.payload));
  assert.deepEqual(enabled.payload.loyalty, { enabled: true, earnPer1000: 10, pointValueIqd: 10 });
  // Phase 19-ج: one code, and the field that failed — the bounds themselves are
  // imported by the schema from the service, so the edge cannot disagree with
  // the domain about what a legal rate is.
  const badRate = await request(`/merchant/stores/${store.slug}/loyalty`, { method: "PUT", token, body: { earnPer1000: 5000 } });
  assert.equal(badRate.payload.error.code, "VALIDATION_FAILED", JSON.stringify(badRate.payload));
  assert.equal(badRate.payload.error.fields[0].path, "earnPer1000");
  const badValue = await request(`/merchant/stores/${store.slug}/loyalty`, { method: "PUT", token, body: { pointValueIqd: 0 } });
  assert.equal(badValue.payload.error.code, "VALIDATION_FAILED");
  assert.equal(badValue.payload.error.fields[0].path, "pointValueIqd");
  // An empty body asks for nothing; answering 200 would tell him something saved.
  assert.equal((await request(`/merchant/stores/${store.slug}/loyalty`, { method: "PUT", token, body: {} })).payload.error.code, "VALIDATION_FAILED", "19-ج: a request that changes nothing is refused, not silently accepted");

  // 19-د: the two rates are legal apart and lethal together. 1000 points per
  // 1,000 IQD at 10,000 IQD each passes both single-field bounds and mints
  // 10,000,000 IQD of redemption capacity per 1,000 IQD of goods.
  const mintingPair = await request(`/merchant/stores/${store.slug}/loyalty`, { method: "PUT", token, body: { earnPer1000: LOYALTY_EARN_PER_1000_MAX, pointValueIqd: LOYALTY_POINT_VALUE_MAX } });
  assert.equal(mintingPair.status, 422, JSON.stringify(mintingPair.payload));
  assert.equal(mintingPair.payload.error.code, "INVALID_LOYALTY_RATES", "19-د: a sale may not award points worth more than the sale");
  // …and the pair cannot be assembled one request at a time either.
  const halfWay = await request(`/merchant/stores/${store.slug}/loyalty`, { method: "PUT", token, body: { pointValueIqd: LOYALTY_POINT_VALUE_MAX } });
  assert.equal(halfWay.payload.error?.code, "INVALID_LOYALTY_RATES", `19-د: the rule is checked on the pair that would RESULT, not on the field that was sent · ${JSON.stringify(halfWay.payload)}`);
  // The database is still the authority, and it refuses the same pair directly.
  let solvencyCode = null;
  try { await sql.query("UPDATE stores SET loyalty_earn_per_1000 = 1000, loyalty_point_value_iqd = 10000 WHERE id = $1", [store.id]); }
  catch (error) { solvencyCode = error.code; }
  assert.equal(solvencyCode, "23514", "19-د: …and raw SQL is refused too — the service message exists for readability, not for enforcement");
  assert.deepEqual((await request(`/merchant/stores/${store.slug}/loyalty`, { token })).payload.loyalty, { enabled: true, earnPer1000: 10, pointValueIqd: 10 }, "19-د: every refusal above left the programme exactly as it was");
  // A generous but solvent programme still passes, so the bound refuses abuse rather than ambition.
  const generous = await request(`/merchant/stores/${store.slug}/loyalty`, { method: "PUT", token, body: { earnPer1000: 100, pointValueIqd: 10 } });
  assert.equal(generous.status, 200, `19-د: a 100% programme is solvent and must still be allowed · ${JSON.stringify(generous.payload)}`);
  assert.equal((await request(`/merchant/stores/${store.slug}/loyalty`, { method: "PUT", token, body: { earnPer1000: 10 } })).status, 200, "…and back to the fixture's rate");

  // ============================================================
  // 2. Earning: idempotent, and on the discounted subtotal.
  // ============================================================
  const first = await buy({ quantity: 3 });          // 30,000 IQD of goods
  const firstOrderId = first.payload.order.id;
  await completeOrder(firstOrderId);

  const expectedPoints = pointsForSubtotal(30_000, { enabled: true, earnPer1000: 10, pointValueIqd: 10 });
  assert.equal(expectedPoints, 300, "10 points per 1,000 over 30,000 is 300");
  const earned = await prisma.loyaltyEntry.findFirstOrThrow({ where: { orderId: firstOrderId, kind: "earned" } });
  assert.equal(earned.points, 300, "CD-5: awarded on completion, at the store's rate");
  assert.equal(earned.valueIqd, null, "CD-5: `valueIqd` is the money a SPEND gave; an award has no such figure, because it gave no discount");
  // LOY-1: …but it does know what ONE of its points is worth, stamped at the
  // moment it was earned. That is the whole feature in one column.
  assert.equal(earned.pointValueIqd, 10, "LOY-1: the award carries the rate it was earned at");

  // Completing again must not mint a second award. The transition itself is
  // refused by the state machine, so the award is driven directly to prove the
  // INDEX is what protects us, not the caller.
  await prisma.$transaction(async (tx) => {
    const { awardLoyaltyPoints } = await import("../src/services/loyalty.service.ts");
    await awardLoyaltyPoints(tx, { storeId: store.id, orderId: firstOrderId, customerId: customer.id, subtotalIqd: 30_000 });
  });
  assert.equal(await prisma.loyaltyEntry.count({ where: { orderId: firstOrderId, kind: "earned" } }), 1, "CD-5: earning is idempotent BY INDEX — a retry collides instead of minting again");

  // ============================================================
  // 1. The balance is a sum, computed here a different way.
  // ============================================================
  const statement = await request(`/store/${store.slug}/account/loyalty`, { token: shopper });
  assert.equal(statement.status, 200, JSON.stringify(statement.payload));
  assert.equal(statement.payload.balance, 300);
  assert.equal(statement.payload.balance, await balanceFromEntries(store.id, customer.id), "CD-5: the service's balance equals the entries summed independently");
  assert.equal(statement.payload.balanceValueIqd, 3000, "CD-5: stated in money too — «300 نقطة» means nothing until it is «3000 دينار»");

  // LOY-2: those 300 points come from an order that can still be returned.
  assert.equal(LOYALTY_HOLD_DAYS, 15, "LOY-2: the hold is the return window");
  assert.deepEqual(
    { spendable: statement.payload.spendable, pending: statement.payload.pending, holdDays: statement.payload.holdDays },
    { spendable: 0, pending: 300, holdDays: 15 },
    "LOY-2: points from an order still inside its return window are held, not spendable",
  );
  assert.ok(statement.payload.pendingReleaseAt, "LOY-2: …and the statement says when they are released");
  const held = await buy({ loyaltyPoints: 100, expect: 422 });
  assert.equal(held.payload.error.code, "INSUFFICIENT_LOYALTY_POINTS", "LOY-2: buy, spend the points, return the order — refused at the till");
  assert.equal(held.payload.error.pending, 300);
  // A refused checkout leaves its line in the cart; this probe is not part of
  // the purchases the sections below count, so it takes its line back out.
  await prisma.cartItem.deleteMany({ where: { storeId: store.id, cart: { customerId: customer.id } } });
  loyaltyHoldHooks.holdDays = 0;
  const released = await request(`/store/${store.slug}/account/loyalty`, { token: shopper });
  assert.deepEqual({ spendable: released.payload.spendable, pending: released.payload.pending }, { spendable: 300, pending: 0 }, "LOY-2: once the window has passed they are his to spend");

  // ============================================================
  // 5. The history is append-only.
  // ============================================================
  let immutable = null;
  try { await sql.query("UPDATE loyalty_entries SET points = 99999 WHERE id = $1", [earned.id]); }
  catch (error) { immutable = error.code; }
  assert.equal(immutable, "23514", "CD-5: the database refuses to rewrite a points history, exactly as it refuses the finance ledger");

  // ============================================================
  // 4. Spending: bounded by balance, by the goods total, never the delivery fee.
  // ============================================================
  const tooMany = await buy({ loyaltyPoints: 5000, expect: 422 });
  assert.equal(tooMany.payload.error.code, "INSUFFICIENT_LOYALTY_POINTS", "CD-5: nobody spends points he does not have");
  assert.equal(await balanceFromEntries(store.id, customer.id), 300, "CD-5: …and the refusal spent nothing");

  // One unit costs 10,000; offering the whole 300-point balance (3,000 IQD) is
  // affordable and should simply apply.
  const spent = await buy({ loyaltyPoints: 300 });
  const spentOrder = await prisma.storeOrder.findUniqueOrThrow({ where: { id: spent.payload.order.id } });
  assert.equal(spentOrder.loyaltyPointsSpent, 300);
  assert.equal(spentOrder.loyaltyDiscountIqd, 3000, "CD-5: 300 points at 10 IQD each");
  // Asserted as the RELATIONSHIP, not a hard-coded total: a refused checkout
  // leaves its items in the cart, so the quantity here is whatever survived the
  // rejection above — and the invariant is what matters anyway.
  assert.equal(
    spentOrder.totalIqd,
    spentOrder.subtotalIqd - spentOrder.discountIqd - spentOrder.loyaltyDiscountIqd + spentOrder.deliveryFeeIqd,
    "CD-5: goods, less any coupon, less the redemption, PLUS the untouched delivery fee",
  );
  assert.equal(spentOrder.deliveryFeeIqd, 3000, "CD-5: a courier is paid in money whatever the shopper redeems");
  assert.ok(spentOrder.totalIqd > spentOrder.deliveryFeeIqd, "CD-5: …so the total can never fall below what the courier is owed");
  assert.equal(await balanceFromEntries(store.id, customer.id), 0, "CD-5: the balance is spent");

  const spendRow = await prisma.loyaltyEntry.findFirstOrThrow({ where: { orderId: spentOrder.id, kind: "spent" } });
  assert.equal(spendRow.valueIqd, 3000, "CD-5: the spend snapshots what the points were worth, so the order still explains itself after a rate change");

  // ============================================================
  // 3. A return reverses BOTH sides.
  // ============================================================
  await completeOrder(spentOrder.id);

  // ============================================================
  // 8. 19-د (عدسة المال) — THE LEDGER MUST BOOK WHAT THE COURIER COLLECTED.
  //
  // The redemption reduces `total_iqd`, which is the cash a COD courier hands
  // back. The ledger used to book `subtotal − coupon` and stop, so the wallet
  // paid the merchant `loyaltyDiscountIqd − commission` MORE than anyone paid
  // in — 22,600 against 20,000 collected on this very order.
  //
  // The redemption is now carried on the entry as its OWN deduction, and the
  // commissionable net is deliberately untouched. That asymmetry is an OWNER
  // DECISION of 2026-09-04, asked and answered «لا»: a coupon reduces the
  // commission base (20B-1 §8.4), redeemed points do not, because points are a
  // debt the merchant sold himself on an earlier order. The assertions below
  // pin BOTH halves, so folding loyalty into the base — a one-line change that
  // produces a correct-looking payout — fails here rather than in production.
  // ============================================================
  assert.equal(spentOrder.subtotalIqd, 20_000, "19-د: the reproduced case — 20,000 IQD of goods");
  assert.equal(spentOrder.loyaltyDiscountIqd, 3_000, "19-د: …3,000 of it paid in points");
  assert.equal(spentOrder.deliveryFeeIqd, 3_000, "19-د: …and 3,000 of delivery");
  assert.equal(spentOrder.totalIqd, 20_000, "19-د: so the courier collects exactly 20,000");

  const spentLedger = await prisma.ledgerEntry.findFirstOrThrow({ where: { orderId: spentOrder.id, entryType: "order_completed" } });
  assert.equal(spentLedger.loyaltyDiscountIqd, 3_000, "19-د: the redemption REACHES the ledger — it used to stop at the order row");
  assert.equal(spentLedger.subtotalIqd, 20_000, "19-د: …while the commissionable net stays where the owner put it");
  assert.equal(
    spentLedger.commissionIqd,
    Math.round((spentLedger.subtotalIqd * spentLedger.commissionBps) / 10_000),
    "19-د: the commission is charged on the sale after the COUPON only — the 3,000 of points is NOT in the base (owner, 2026-09-04)",
  );
  assert.equal(spentLedger.deliveryFeeIqd, 3_000, "19-د: …and delivery still passes through whole (ADR-006)");
  assert.equal(
    spentLedger.subtotalIqd + spentLedger.deliveryFeeIqd - spentLedger.loyaltyDiscountIqd,
    spentOrder.totalIqd,
    "19-د: the entry describes the cash that was collected, not 3,000 IQD more",
  );

  // The same rule seen through the service that actually pays: what the platform
  // owes can never exceed what the couriers handed back, less its own commission.
  const walletAtRedemption = await merchantWallet(merchant.payload.account.id);
  const collectedByCouriers = await prisma.storeOrder.aggregate({ where: { storeId: store.id, status: "completed" }, _sum: { totalIqd: true } });
  assert.equal(walletAtRedemption.pending.loyaltyDiscountIqd, 3_000, "19-د: the wallet sees the redemption as its own line");
  assert.equal(
    walletAtRedemption.pending.netPayoutIqd,
    (collectedByCouriers._sum.totalIqd ?? 0) - walletAtRedemption.pending.commissionIqd,
    "19-د: the platform never owes more than the couriers collected, less its commission",
  );
  assert.ok(walletAtRedemption.pending.netPayoutIqd > 0, `19-د: …and this fixture owes real money, so that is not 0 === 0 · ${walletAtRedemption.pending.netPayoutIqd}`);
  summary.loyaltyReachesTheLedger = {
    collectedIqd: spentOrder.totalIqd,
    ledgerSubtotalIqd: spentLedger.subtotalIqd,
    ledgerLoyaltyDiscountIqd: spentLedger.loyaltyDiscountIqd,
    ledgerDeliveryFeeIqd: spentLedger.deliveryFeeIqd,
    orderNetPayoutIqd: spentLedger.subtotalIqd + spentLedger.deliveryFeeIqd - spentLedger.loyaltyDiscountIqd - spentLedger.commissionIqd,
  };

  const afterEarnOnSpentOrder = await balanceFromEntries(store.id, customer.id);
  // He earns on what he actually paid for goods: subtotal less every discount,
  // the redemption included. Awarding on the pre-redemption figure would pay him
  // points for money the points themselves covered.
  const paidForGoods = spentOrder.subtotalIqd - spentOrder.discountIqd - spentOrder.loyaltyDiscountIqd;
  assert.equal(
    afterEarnOnSpentOrder,
    pointsForSubtotal(paidForGoods, { enabled: true, earnPer1000: 10, pointValueIqd: 10 }),
    `CD-5: earning is on what he actually paid for goods (${paidForGoods}), after the redemption`,
  );

  const returned = await request(`/merchant/stores/${store.slug}/orders/${spentOrder.id}/status`, {
    method: "POST", token, body: { toStatus: "returned", expectedVersion: (await prisma.storeOrder.findUniqueOrThrow({ where: { id: spentOrder.id } })).version },
  });
  assert.equal(returned.status, 200, JSON.stringify(returned.payload));

  const kinds = (await prisma.loyaltyEntry.findMany({ where: { orderId: spentOrder.id }, select: { kind: true, points: true } }));
  const byKind = Object.fromEntries(kinds.map((row) => [row.kind, row.points]));
  assert.ok(byKind.reversed_earn > 0, "CD-5: the award is clawed back — without this, buy then return is a points printer");
  assert.equal(byKind.refunded_spend, 300, "CD-5: …and the points he spent come back, or he is refunded in money for the cash half and nothing for the rest");
  assert.equal(await balanceFromEntries(store.id, customer.id), 300, "CD-5: he is back where he started: the 300 he spent, and no award for a sale that unwound");

  // Returning twice must not refund twice.
  await prisma.$transaction(async (tx) => {
    const { reverseLoyaltyForReturn } = await import("../src/services/loyalty.service.ts");
    await reverseLoyaltyForReturn(tx, { storeId: store.id, orderId: spentOrder.id });
  });
  assert.equal(await balanceFromEntries(store.id, customer.id), 300, "CD-5: reversing twice changes nothing — the index refuses the second");

  // ============================================================
  // ق-191 — THE ORDER DIES BEFORE IT IS PAID, AND THE POINTS COME BACK
  //
  // This suite covered earn → spend → complete → RETURN and stopped there, so
  // for as long as it was green a shopper whose order was CANCELLED lost every
  // point he had redeemed on it: the spend row is written at checkout on a
  // `new` order, and the only refund writer hung off the `returned` branch. He
  // paid nothing, received nothing, and the points were gone — the platform
  // kept value it never delivered against. Cancelling is not an exotic path:
  // the merchant does it, a bulk action does it, and the shopper does it from
  // his own order page.
  // ============================================================
  const balanceBeforeCancel = await balanceFromEntries(store.id, customer.id);
  const cancelBuy = await buy({ loyaltyPoints: 300 });
  const cancelledOrder = await prisma.storeOrder.findUniqueOrThrow({ where: { id: cancelBuy.payload.order.id } });
  assert.equal(cancelledOrder.loyaltyPointsSpent, 300, "the fixture must really carry a redemption, or the assertion below proves nothing");
  assert.equal(
    await balanceFromEntries(store.id, customer.id),
    balanceBeforeCancel - 300,
    "ق-191: the spend is booked at CHECKOUT, while the order is still `new` — which is exactly why cancelling has to give it back",
  );

  const cancelled = await request(`/merchant/stores/${store.slug}/orders/${cancelledOrder.id}/status`, {
    method: "POST", token, body: { toStatus: "cancelled", expectedVersion: (await prisma.storeOrder.findUniqueOrThrow({ where: { id: cancelledOrder.id } })).version },
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.payload));

  const cancelKinds = await prisma.loyaltyEntry.findMany({ where: { orderId: cancelledOrder.id }, select: { kind: true, points: true } });
  const cancelByKind = Object.fromEntries(cancelKinds.map((row) => [row.kind, row.points]));
  assert.equal(cancelByKind.refunded_spend, 300, "ق-191: a cancelled order returns every point it consumed");
  assert.equal(cancelByKind.reversed_earn, undefined, "ق-191: …and claws back nothing, because a cancelled order never earned — the award only fires on `completed`");
  assert.equal(
    await balanceFromEntries(store.id, customer.id),
    balanceBeforeCancel,
    "ق-191: he is exactly where he was before an order that never happened",
  );

  // Cancelling is idempotent for the same reason returning is: the unique index,
  // not a guard anyone has to remember.
  await prisma.$transaction(async (tx) => {
    const { reverseLoyaltyForReturn } = await import("../src/services/loyalty.service.ts");
    await reverseLoyaltyForReturn(tx, { storeId: store.id, orderId: cancelledOrder.id });
  });
  assert.equal(await balanceFromEntries(store.id, customer.id), balanceBeforeCancel, "ق-191: refunding twice changes nothing");
  summary.cancelReturnsPoints = { refunded: 300, clawedBack: 0 };

  // ============================================================
  // 7. A different redemption under the same key is a different request.
  // ============================================================
  await request(`/store/${store.slug}/cart/items`, { method: "POST", token: shopper, body: { productId: product.id, variantId: variant.id, quantity: 1 } });
  const cart = await request(`/store/${store.slug}/cart`, { token: shopper });
  const sharedKey = `${testId}-shared-key`;
  const firstTry = await request(`/store/${store.slug}/checkout`, {
    method: "POST", token: shopper, headers: { "idempotency-key": sharedKey },
    body: { cartVersion: cart.payload.cart.version, addressId, paymentMethodCode: "cod", loyaltyPoints: 100 },
  });
  assert.equal(firstTry.status, 201, JSON.stringify(firstTry.payload));
  const replay = await request(`/store/${store.slug}/checkout`, {
    method: "POST", token: shopper, headers: { "idempotency-key": sharedKey },
    body: { cartVersion: cart.payload.cart.version, addressId, paymentMethodCode: "cod", loyaltyPoints: 200 },
  });
  assert.equal(replay.payload.error?.code, "IDEMPOTENCY_KEY_REUSED", `CD-5: a retry redeeming a DIFFERENT number of points is a different request — silently replaying the first would spend points he did not agree to spend this time · ${JSON.stringify(replay.payload)}`);

  // ============================================================
  // 9. LOY-1 — A POINT CARRIES THE VALUE IT WAS EARNED AT.
  //
  // The defect: a balance was stored in POINTS and priced at redemption from the
  // store's CURRENT rate. So lowering that rate did not change future
  // generosity — it reached back and confiscated value a customer had already
  // been promised. Points he was told were worth 10,000 IQD became worth 1,000
  // while he slept, from a settings field, with nothing recorded anywhere saying
  // something had been taken from him.
  //
  // The rule: a rate change applies to points earned from that moment ON. Every
  // assertion below is written so that the OLD behaviour fails it, not so that
  // the new code agrees with itself.
  //
  // A fresh shopper, because the arithmetic has to be readable: the one above is
  // mid-way through a return.
  // ============================================================
  const loyEmail = `${testId}.loy@codiq.test`;
  const loyRegistered = await request(`/store/${store.slug}/account/register`, {
    method: "POST",
    body: { phone: `+9647${String(Date.now() + 11).slice(-9)}`, email: loyEmail, password: "Loy1ShopperPass2026!", fullName: "زبون القيمة المحفوظة" },
  });
  assert.equal(loyRegistered.status, 201, JSON.stringify(loyRegistered.payload));
  const loyShopper = loyRegistered.payload.accessToken;
  const loyCustomer = await prisma.customer.findFirstOrThrow({ where: { storeId: store.id, email: loyEmail }, select: { id: true } });
  const loyAddress = await request(`/store/${store.slug}/account/addresses`, {
    method: "POST", token: loyShopper,
    body: { recipientName: "زبون القيمة المحفوظة", fullAddress: "شارع الولاء 2", city: "Baghdad", governorate: "Baghdad", phoneContact: `+9647${String(Date.now() + 12).slice(-9)}`, isDefault: true },
  });
  assert.equal(loyAddress.status, 201, JSON.stringify(loyAddress.payload));
  const loyAddressId = loyAddress.payload.address.id;

  async function loyBuy({ quantity = 1, loyaltyPoints, expect = 201 } = {}) {
    keySeq += 1;
    await request(`/store/${store.slug}/cart/items`, { method: "POST", token: loyShopper, body: { productId: product.id, variantId: variant.id, quantity } });
    const loyCart = await request(`/store/${store.slug}/cart`, { token: loyShopper });
    const checkout = await request(`/store/${store.slug}/checkout`, {
      method: "POST", token: loyShopper,
      headers: { "idempotency-key": `${testId}-loy-${String(keySeq).padStart(4, "0")}` },
      body: { cartVersion: loyCart.payload.cart.version, addressId: loyAddressId, paymentMethodCode: "cod", ...(loyaltyPoints === undefined ? {} : { loyaltyPoints }) },
    });
    assert.equal(checkout.status, expect, JSON.stringify(checkout.payload));
    return checkout;
  }
  const loyStatement = async () => (await request(`/store/${store.slug}/account/loyalty`, { token: loyShopper })).payload;
  const setRates = async (body) => {
    const put = await request(`/merchant/stores/${store.slug}/loyalty`, { method: "PUT", token, body });
    assert.equal(put.status, 200, JSON.stringify(put.payload));
  };

  // --- Rate A: 10 points per 1,000 IQD, each worth 100 IQD. ---
  await setRates({ earnPer1000: 10, pointValueIqd: 100 });
  const loyFirst = await loyBuy({ quantity: 1 });                    // 10,000 IQD of goods
  await completeOrder(loyFirst.payload.order.id);

  const atRateA = await loyStatement();
  assert.equal(atRateA.balance, 100, "LOY-1: 10 points per 1,000 over 10,000 is 100 points");
  assert.equal(atRateA.balanceValueIqd, 10_000, "LOY-1: …worth 100 IQD each, so 10,000 IQD");
  assert.deepEqual(atRateA.lots.map((lot) => [lot.points, lot.pointValueIqd]), [[100, 100]], "LOY-1: one lot, priced at the rate it was earned at");

  // --- The merchant now CUTS the point value by ten. ---
  await setRates({ pointValueIqd: 10 });

  const afterTheCut = await loyStatement();
  assert.equal(afterTheCut.pointValueIqd, 10, "LOY-1: the store's rate really did change");
  assert.equal(afterTheCut.balance, 100, "LOY-1: he still holds the same points");
  assert.equal(
    afterTheCut.balanceValueIqd,
    10_000,
    "LOY-1: …and they are still worth what he earned them at. Under the old rule this was 100 × the CURRENT rate = 1,000 IQD — 9,000 IQD confiscated from a settings screen",
  );
  assert.deepEqual(afterTheCut.lots.map((lot) => [lot.points, lot.pointValueIqd]), [[100, 100]], "LOY-1: the lot kept its own price");

  // --- Rate B applies to what he earns NEXT, and only to that. ---
  const loySecond = await loyBuy({ quantity: 1 });                   // another 10,000 IQD
  await completeOrder(loySecond.payload.order.id);
  const twoLots = await loyStatement();
  assert.equal(twoLots.balance, 200, "LOY-1: 100 old points and 100 new ones");
  assert.deepEqual(
    twoLots.lots.map((lot) => [lot.points, lot.pointValueIqd]),
    [[100, 100], [100, 10]],
    "LOY-1: two lots at two rates, OLDEST FIRST — the order redemption will spend them in",
  );
  assert.equal(twoLots.balanceValueIqd, 11_000, "LOY-1: 100×100 + 100×10 — the new rate priced only the new points");
  assert.equal(twoLots.balance, await balanceFromEntries(store.id, loyCustomer.id), "LOY-1: the fold and the signed sum are still the same number");

  // --- Redemption across two lots at two different rates. ---
  // 150 points, oldest first: all 100 of the old lot (10,000) and 50 of the new
  // one (500). Under the old rule this was 150 × 10 = 1,500 IQD.
  const crossLot = await loyBuy({ quantity: 2, loyaltyPoints: 150 });  // 20,000 IQD of goods
  const crossLotOrder = await prisma.storeOrder.findUniqueOrThrow({ where: { id: crossLot.payload.order.id } });
  assert.equal(crossLotOrder.loyaltyPointsSpent, 150);
  assert.equal(crossLotOrder.loyaltyDiscountIqd, 10_500, "LOY-1: 100 points at 100 plus 50 at 10 — each lot priced at what it was earned at");
  assert.equal(
    crossLotOrder.totalIqd,
    crossLotOrder.subtotalIqd - crossLotOrder.discountIqd - crossLotOrder.loyaltyDiscountIqd + crossLotOrder.deliveryFeeIqd,
    "LOY-1: and the order still adds up the way CD-5 says it does",
  );
  await completeOrder(crossLotOrder.id);

  // The rule cuts both ways: what he earns AFTER the cut is priced at the cut
  // rate. «Points already earned keep their value» is not «points never change
  // value» — it is «the merchant may change what he awards NEXT».
  const earnedAfterTheCut = await prisma.loyaltyEntry.findFirstOrThrow({ where: { orderId: crossLotOrder.id, kind: "earned" } });
  assert.equal(earnedAfterTheCut.pointValueIqd, 10, "LOY-1: an award made after the cut is a lot at the NEW rate");
  assert.equal(earnedAfterTheCut.points, 95, "CD-5: still earned on what he actually paid for goods — 20,000 less the 10,500 of points");

  const crossLotLedger = await prisma.ledgerEntry.findFirstOrThrow({ where: { orderId: crossLotOrder.id, entryType: "order_completed" } });
  assert.equal(crossLotLedger.loyaltyDiscountIqd, 10_500, "19-د: the bigger, lot-priced redemption reaches the ledger too");
  assert.equal(
    crossLotLedger.subtotalIqd + crossLotLedger.deliveryFeeIqd - crossLotLedger.loyaltyDiscountIqd,
    crossLotOrder.totalIqd,
    "19-د: …so the platform still books exactly what the courier collected",
  );

  // --- THE FIGURE HE IS SHOWN IS THE FIGURE HE GETS. ---
  // The whole remaining balance, on an order big enough to absorb it: the
  // discount must equal `balanceValueIqd` to the dinar. This is the assertion
  // that makes the number on the checkout panel a promise rather than an
  // estimate — the old code showed `balance × today's rate` and then charged
  // something else.
  const beforeSpendingItAll = await loyStatement();
  assert.equal(beforeSpendingItAll.balance, 145, "LOY-1: 50 left of the rate-B lot, plus the 95 the last order awarded");
  assert.deepEqual(
    beforeSpendingItAll.lots.map((lot) => [lot.points, lot.pointValueIqd]),
    [[50, 10], [95, 10]],
    "LOY-1: spending is OLDEST FIRST, so the 100-IQD lot went first and is gone — nothing of his best-priced points was stranded behind the newer ones",
  );
  assert.equal(beforeSpendingItAll.balanceValueIqd, 1_450);
  assert.equal(beforeSpendingItAll.balance, await balanceFromEntries(store.id, loyCustomer.id));
  const spendItAll = await loyBuy({ quantity: 2, loyaltyPoints: beforeSpendingItAll.balance });
  const spendItAllOrder = await prisma.storeOrder.findUniqueOrThrow({ where: { id: spendItAll.payload.order.id } });
  assert.equal(
    spendItAllOrder.loyaltyDiscountIqd,
    beforeSpendingItAll.balanceValueIqd,
    "LOY-1: the money he was shown is the money he was given — exactly, not approximately",
  );
  const emptied = await loyStatement();
  assert.equal(emptied.balance, 0);
  assert.equal(emptied.balanceValueIqd, 0, "LOY-1: no points, no value — and no rate left to guess with");
  assert.deepEqual(emptied.lots, []);
  assert.equal(emptied.balance, await balanceFromEntries(store.id, loyCustomer.id));

  // --- The database refuses an award that does not know what it is worth. ---
  // The service message exists for readability; this is the enforcement.
  let unpricedAward = null;
  try {
    await sql.query(
      "INSERT INTO loyalty_entries (store_id, customer_id, order_id, kind, points) VALUES ($1, $2, $3, 'earned', 5)",
      [store.id, loyCustomer.id, spendItAllOrder.id],
    );
  } catch (error) { unpricedAward = error.code; }
  assert.equal(unpricedAward, "23514", "LOY-1: a point that does not know what it was worth is a point nobody can honour");

  summary.loyaltyValueAtEarn = {
    earnedAtRateA: { points: atRateA.balance, valueIqd: atRateA.balanceValueIqd },
    afterMerchantCutTheRate: { points: afterTheCut.balance, valueIqd: afterTheCut.balanceValueIqd, storeRateNow: afterTheCut.pointValueIqd },
    twoLots: twoLots.lots.map((lot) => [lot.points, lot.pointValueIqd]),
    crossLotRedemptionIqd: crossLotOrder.loyaltyDiscountIqd,
    shownEqualsGiven: spendItAllOrder.loyaltyDiscountIqd === beforeSpendingItAll.balanceValueIqd,
  };

  summary.loyalty = {
    defaultEnabled: false,
    earnedOnDiscountedSubtotal: 300,
    idempotentEarn: true,
    spentDiscountIqd: spentOrder.loyaltyDiscountIqd,
    deliveryFeeUntouched: spentOrder.deliveryFeeIqd,
    balanceAfterReturn: await balanceFromEntries(store.id, customer.id),
    historyImmutable: immutable,
    differentRedemptionSameKey: replay.payload.error?.code,
  };

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await sql.end();
  await prisma.$disconnect();
}
