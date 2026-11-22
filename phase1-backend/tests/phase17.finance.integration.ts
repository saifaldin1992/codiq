/**
 * codiq phase 17 acceptance — financial ledger, settlements, registration
 * approval, and domain resolution. Gate coverage per the official plan:
 * mathematically exact ledger entries on completion, automatic reversal inside
 * the 15-day return window and refusal outside it with the owner's manual
 * adjustment path, database-enforced immutability of ledger and settlements,
 * settlement snapshots, the full self-registration flow in both approval modes,
 * and host→store resolution for subdomains and custom domains.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "pg";
import { createTypedSession } from "../src/auth/identity.js";
import { config } from "../src/config.js";
import { MAX_DELIVERY_RATE_IQD } from "../src/services/delivery-rates.service.js";
import { prisma } from "../src/db/prisma.js";
import { createApp } from "../src/http/app.js";
import { assignMerchantSubscription } from "../src/services/entitlement.service.js";
import { recordOrderReturn, RETURN_REVERSAL_WINDOW_DAYS } from "../src/services/finance.service.js";
import { createStoreFoundation } from "../src/services/store-bootstrap.service.js";
import { assertSafeTestDatabaseUrl } from "./helpers/test-database-guard.js";

const port = 3171;
const base = `http://127.0.0.1:${port}`;

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const raw = await response.text();
  let body: any = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }
  return { status: response.status, body };
}

function bearer(accessToken: string) {
  return { authorization: `Bearer ${accessToken}` };
}

const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
if (
  process.env.DATABASE_URL !== testDatabaseUrl ||
  process.env.CODIQ_POSTGRES_URL !== testDatabaseUrl
) {
  throw new Error(
    "Refusing TRUNCATE: runtime database variables must both equal CODIQ_TEST_DATABASE_URL."
  );
}

await prisma.$executeRawUnsafe(
  "TRUNCATE TABLE settlements, ledger_entries, notification_outbox, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, platform_owner_sessions, platform_owners, storefront_rate_limits CASCADE"
);
await prisma.platformSetting.upsert({
  where: { key: "merchant_self_registration_mode" },
  create: { key: "merchant_self_registration_mode", value: "auto" },
  update: { value: "auto" },
});

const server = createServer(createApp());
await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

const summary: Record<string, unknown> = { phase: 17 };
let orderCounter = 0;

try {
  // ---------- fixtures ----------
  const ownerRegister = await request("/auth/platform/register", {
    method: "POST",
    body: JSON.stringify({
      email: "owner.phase17@codiq.test",
      password: "owner-phase17-password",
      displayName: "مالك المرحلة 17",
    }),
  });
  assert.equal(ownerRegister.status, 201);
  const ownerLogin = await request("/auth/platform/login", {
    method: "POST",
    body: JSON.stringify({ email: "owner.phase17@codiq.test", password: "owner-phase17-password" }),
  });
  const tokenOwner: string = ownerLogin.body.accessToken;
  const ownerId: string = ownerRegister.body.account.id;

  const provisioned = await request("/platform/merchants/manual", {
    method: "POST",
    headers: bearer(tokenOwner),
    body: JSON.stringify({
      ownerName: "صاحب المتجر",
      phone: "+9647100576401",
      email: "merchant.phase17@codiq.test",
      temporaryPassword: "merchant-phase17-pass",
      businessName: "تاجر المرحلة 17",
      firstStoreName: "متجر المرحلة 17",
    }),
  });
  assert.equal(provisioned.status, 201);
  const merchantId: string = provisioned.body.merchant.id;
  const storeId: string = provisioned.body.store.id;
  const storeSlug: string = provisioned.body.store.slug;
  // ق-218: the hand-provisioned merchant is gated until he replaces the
  // provisioner's password (proven in `phase6:test`). This suite is about the
  // FINANCE LEDGER, so it starts where he starts after his first login.
  await prisma.merchant.update({
    where: { id: merchantId },
    data: { passwordSetByProvisionerAt: null },
  });
  const tokenMerchant = await createTypedSession("merchant", merchantId, storeId);

  async function makeOrder(subtotalIqd: number, deliveryFeeIqd: number) {
    orderCounter += 1;
    return prisma.storeOrder.create({
      data: {
        storeId,
        orderNumber: `P17-${String(orderCounter).padStart(4, "0")}`,
        status: "new",
        customerName: "زبون 17",
        subtotalIqd,
        deliveryFeeIqd,
        totalIqd: subtotalIqd + deliveryFeeIqd,
      },
    });
  }
  async function transition(orderId: string, toStatus: string, expectedVersion: number) {
    const result = await request(`/merchant/stores/${storeSlug}/orders/${orderId}/status`, {
      method: "POST",
      headers: bearer(tokenMerchant),
      body: JSON.stringify({ toStatus, expectedVersion }),
    });
    assert.equal(result.status, 200, `${toStatus}: ${JSON.stringify(result.body)}`);
    return result.body.order;
  }
  async function completeOrder(orderId: string) {
    await transition(orderId, "processing", 1);
    await transition(orderId, "preparation", 2);
    await transition(orderId, "out_for_delivery", 3);
    return transition(orderId, "completed", 4);
  }

  // ---------- ledger math on completion (free plan = 300 bps) ----------
  // ق-128 grants every new merchant a free MONTH on growth (200 bps), so the
  // plan is pinned here instead of inherited. This suite is about the ledger
  // arithmetic, and re-baselining its numbers to whatever the trial happens to
  // grant would silently move the thing under test.
  await assignMerchantSubscription(merchantId, { planCode: "free" });
  const orderA = await makeOrder(4000, 2500);
  await completeOrder(orderA.id);
  const entryA = await prisma.ledgerEntry.findFirst({
    where: { orderId: orderA.id, entryType: "order_completed" },
  });
  assert.ok(entryA, "completion must book a ledger entry in the same transaction");
  assert.equal(entryA!.subtotalIqd, 4000);
  assert.equal(entryA!.deliveryFeeIqd, 2500);
  assert.equal(entryA!.commissionBps, 300);
  assert.equal(entryA!.commissionIqd, 120, "3% of 4000 = 120");
  assert.equal(entryA!.planCode, "free");
  summary.completionEntry = {
    subtotal: 4000,
    commissionBps: 300,
    commission: entryA!.commissionIqd,
  };

  // Phase 30: a commission edit PUBLISHES a new plan version. A merchant already
  // subscribed keeps the version he subscribed under — his next completion is
  // still booked at 300 — and moves to the new terms on renewal (here: the owner
  // re-assigns the plan), after which completions are booked at 500.
  const plansList = await request("/platform/plans", { headers: bearer(tokenOwner) });
  const freePlan = plansList.body.plans.find((plan: any) => plan.code === "free");
  const bpsUpdate = await request(`/platform/plans/${freePlan.id}`, {
    method: "PATCH",
    headers: bearer(tokenOwner),
    body: JSON.stringify({ commissionBps: 500 }),
  });
  assert.equal(bpsUpdate.status, 200);
  assert.ok(
    bpsUpdate.body.plan.publishedVersion >= 2,
    "phase 30: a term change publishes a new version"
  );
  const { activePlanForMerchant } = await import("../src/services/entitlement.service.js");
  assert.equal(
    (await activePlanForMerchant(prisma, merchantId)).commissionBps,
    300,
    "phase 30: editing the plan does not change an existing subscription's terms"
  );
  const renewed = await request(`/platform/merchants/${merchantId}/subscription`, {
    method: "PUT",
    headers: bearer(tokenOwner),
    body: JSON.stringify({ planCode: "free" }),
  });
  assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
  const orderB = await makeOrder(10000, 3000);
  await completeOrder(orderB.id);
  const entryB = await prisma.ledgerEntry.findFirst({
    where: { orderId: orderB.id, entryType: "order_completed" },
  });
  assert.equal(entryB!.commissionBps, 500);
  assert.equal(entryB!.commissionIqd, 500, "5% of 10000 = 500");
  await request(`/platform/plans/${freePlan.id}`, {
    method: "PATCH",
    headers: bearer(tokenOwner),
    body: JSON.stringify({ commissionBps: 300 }),
  });
  // …and back onto the 300 terms the rest of this suite was written against.
  assert.equal(
    (
      await request(`/platform/merchants/${merchantId}/subscription`, {
        method: "PUT",
        headers: bearer(tokenOwner),
        body: JSON.stringify({ planCode: "free" }),
      })
    ).status,
    200
  );

  // ---------- return inside the window reverses automatically ----------
  const returned = await transition(orderB.id, "returned", 5);
  assert.equal(returned.status, "returned");
  const reversalB = await prisma.ledgerEntry.findFirst({
    where: { orderId: orderB.id, entryType: "order_returned" },
  });
  assert.ok(reversalB, "an in-window return must book the reversal automatically");
  assert.equal(reversalB!.commissionIqd, entryB!.commissionIqd);
  assert.equal(await prisma.ledgerEntry.count({ where: { orderId: orderB.id } }), 2);

  // ---------- outside the window: no automatic reversal; owner manual path ----------
  const futureNow = new Date(Date.now() + (RETURN_REVERSAL_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000);
  const windowCheck = await prisma.$transaction((tx) =>
    recordOrderReturn(tx, { storeId, orderId: orderA.id, now: futureNow })
  );
  assert.equal(windowCheck, "outside_window");
  assert.equal(
    await prisma.ledgerEntry.count({ where: { orderId: orderA.id } }),
    1,
    "outside-window check must not add entries"
  );

  // Manufacture a genuinely late return: completion entry backdated 16 days.
  const backdatedOrder = async (orderNumber: string, status: string) => {
    const order = await prisma.storeOrder.create({
      data: {
        storeId,
        orderNumber,
        status,
        customerName: "زبون متأخر",
        subtotalIqd: 6000,
        deliveryFeeIqd: 2000,
        totalIqd: 8000,
        version: 1,
      },
    });
    await prisma.ledgerEntry.create({
      data: {
        storeId,
        orderId: order.id,
        entryType: "order_completed",
        subtotalIqd: 6000,
        deliveryFeeIqd: 2000,
        commissionIqd: 180,
        commissionBps: 300,
        planCode: "free",
        createdAt: new Date(Date.now() - 16 * 24 * 60 * 60 * 1000),
      },
    });
    return order;
  };
  const lateOrder = await backdatedOrder("P17-LATE-0001", "completed");
  await transition(lateOrder.id, "returned", 1);
  assert.equal(
    await prisma.ledgerEntry.count({
      where: { orderId: lateOrder.id, entryType: "order_returned" },
    }),
    0,
    "a late return must NOT auto-reverse"
  );
  const manualAdjustment = await request("/platform/finance/adjustments", {
    method: "POST",
    headers: bearer(tokenOwner),
    body: JSON.stringify({ orderId: lateOrder.id, note: "إرجاع متأخر موثق" }),
  });
  assert.equal(manualAdjustment.status, 201, JSON.stringify(manualAdjustment.body));
  assert.equal(manualAdjustment.body.entry.entryType, "manual_adjustment");
  const duplicateAdjustment = await request("/platform/finance/adjustments", {
    method: "POST",
    headers: bearer(tokenOwner),
    body: JSON.stringify({ orderId: lateOrder.id }),
  });
  assert.equal(duplicateAdjustment.status, 409);
  // Review batch 2, م-١٠: the same reversal sent twice AT ONCE (a double click) — both used to
  // pass the «already reversed?» read and the merchant was charged back twice.
  const twinOrder = await backdatedOrder("P17-LATE-0002", "returned");
  const twins = await Promise.all(
    [1, 2, 3].map(() =>
      request("/platform/finance/adjustments", {
        method: "POST",
        headers: bearer(tokenOwner),
        body: JSON.stringify({ orderId: twinOrder.id }),
      })
    )
  );
  assert.deepEqual(
    twins.map((reply) => reply.status).sort(),
    [201, 409, 409],
    `one reversal, however many at once · ${JSON.stringify(twins.map((reply) => reply.body))}`
  );
  assert.equal(
    await prisma.ledgerEntry.count({
      where: { orderId: twinOrder.id, entryType: "manual_adjustment" },
    }),
    1
  );
  summary.returnWindow = {
    outsideWindowCheck: windowCheck,
    lateAutoReversal: 0,
    manualAdjustment: manualAdjustment.status,
    duplicateRefused: duplicateAdjustment.status,
  };

  // ---------- database-enforced immutability ----------
  const sql = new Client({ connectionString: config.databaseUrl });
  await sql.connect();
  let ledgerUpdateCode: string | null = null;
  let ledgerDeleteCode: string | null = null;
  try {
    try {
      await sql.query("UPDATE ledger_entries SET commission_iqd = 0 WHERE order_id = $1", [
        orderA.id,
      ]);
    } catch (error: any) {
      ledgerUpdateCode = error.code;
      assert.match(error.message, /CODIQ_LEDGER_ENTRY_IMMUTABLE/);
    }
    try {
      await sql.query("DELETE FROM ledger_entries WHERE order_id = $1", [orderA.id]);
    } catch (error: any) {
      ledgerDeleteCode = error.code;
    }
  } finally {
    /* settlement immutability checked below with the same client */
  }
  assert.equal(ledgerUpdateCode, "23514");
  assert.equal(ledgerDeleteCode, "23514");

  // ---------- reports and settlement snapshot ----------
  const fromIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const toIso = new Date(Date.now() + 60 * 1000).toISOString();
  const merchantReport = await request(`/merchant/finance/report?from=${fromIso}&to=${toIso}`, {
    headers: bearer(tokenMerchant),
  });
  assert.equal(merchantReport.status, 200);
  // Entries in range: A (+120), B (+500 / −500), late backdated completion (+180) and its manual
  // reversal (−180), and the twin-click order's completion (+180) and its ONE reversal (−180).
  assert.equal(merchantReport.body.totals.commissionIqd, 120);
  assert.equal(merchantReport.body.totals.completedOrders, 4);
  assert.equal(merchantReport.body.totals.reversedOrders, 3);

  const platformReport = await request(`/platform/finance/report?from=${fromIso}&to=${toIso}`, {
    headers: bearer(tokenOwner),
  });
  assert.equal(platformReport.status, 200);
  assert.equal(platformReport.body.merchants.length, 1);
  assert.equal(
    platformReport.body.merchants[0].totals.commissionIqd,
    merchantReport.body.totals.commissionIqd
  );

  // =========================================================================
  // MD-5 «محفظتي» (ق-70) — what the merchant is owed right now.
  //
  // The property worth protecting is not «the number is right» but «the number
  // and the payment AGREE». A wallet computed one way and a settlement computed
  // another would differ about the same money, and the merchant would find out
  // on payday. So the wallet is read HERE, before the settlement below exists,
  // where there is real money pending — then that settlement is required to pay
  // exactly the figure the merchant was shown.
  // =========================================================================
  const walletUrl = "/merchant/finance/wallet";
  const walletNow = async () =>
    (await request(walletUrl, { headers: bearer(tokenMerchant) })).body.wallet;

  const walletBefore = await walletNow();
  assert.equal(
    walletBefore.period.from,
    null,
    "MD-5: with nothing settled yet the window runs from the beginning, and says so rather than implying it"
  );
  assert.equal(walletBefore.lifetime.settledCount, 0);
  assert.equal(
    walletBefore.pending.netPayoutIqd,
    walletBefore.pending.subtotalIqd +
      walletBefore.pending.deliveryFeeIqd -
      walletBefore.pending.commissionIqd,
    "MD-5: the net is sales plus delivery less the platform's commission — computed from its parts, because Settlement stores no total"
  );
  // The same entries the report just counted, seen through a different service.
  assert.equal(
    walletBefore.pending.completedOrders,
    merchantReport.body.totals.completedOrders,
    "MD-5: the wallet and the report count the same completions"
  );
  assert.equal(walletBefore.pending.reversedOrders, merchantReport.body.totals.reversedOrders);
  assert.equal(walletBefore.pending.commissionIqd, merchantReport.body.totals.commissionIqd);
  assert.ok(
    walletBefore.pending.netPayoutIqd > 0,
    `MD-5: this fixture owes the merchant real money, so the agreement below is not 0 === 0 · ${walletBefore.pending.netPayoutIqd}`
  );

  const settlement = await request("/platform/finance/settlements", {
    method: "POST",
    headers: bearer(tokenOwner),
    body: JSON.stringify({
      merchantId,
      periodFrom: fromIso,
      periodTo: toIso,
      note: "تسوية اختبارية",
    }),
  });
  assert.equal(settlement.status, 201, JSON.stringify(settlement.body));
  assert.equal(
    settlement.body.settlement.commissionIqd,
    merchantReport.body.totals.commissionIqd,
    "the settlement snapshot must match the report"
  );
  assert.equal(settlement.body.settlement.platformOwnerId, ownerId);
  const merchantSettlementsView = await request("/merchant/finance/settlements", {
    headers: bearer(tokenMerchant),
  });
  assert.equal(merchantSettlementsView.body.settlements.length, 1);
  // The settlement pays EXACTLY what the wallet showed: one formula, two screens.
  const walletSettled = settlement.body.settlement;
  const walletSettledNet =
    walletSettled.subtotalIqd + walletSettled.deliveryFeeIqd - walletSettled.commissionIqd;
  assert.equal(
    walletSettledNet,
    walletBefore.pending.netPayoutIqd,
    "MD-5: the settlement pays exactly what the wallet said was pending"
  );

  const walletAfter = await walletNow();
  assert.equal(
    new Date(walletAfter.period.from).toISOString(),
    new Date(walletSettled.periodTo).toISOString(),
    "MD-5: the next window opens where the settled one closed"
  );
  assert.equal(
    walletAfter.pending.netPayoutIqd,
    0,
    "MD-5: nothing pending straight after settling — the same order cannot be paid twice"
  );
  assert.equal(walletAfter.lastSettlement.netPayoutIqd, walletSettledNet);
  assert.equal(walletAfter.lifetime.settledCount, 1);
  assert.equal(
    walletAfter.lifetime.settledNetIqd,
    walletSettledNet,
    "MD-5: lifetime is the sum of what was actually paid, not of what was earned"
  );

  // ============================================================
  // 19-د (عدسة المال) — A PERIOD IS SETTLED ONCE, AND NEVER INTO THE FUTURE.
  //
  // createSettlement used to read the ledger and write a row without ever
  // looking at the settlements already there, and settlements are immutable, so
  // the duplicate could not be voided afterwards. The suite reached here having
  // settled exactly once and never tried a second time, which is why it passed.
  // ============================================================
  const settledAgain = await request("/platform/finance/settlements", {
    method: "POST",
    headers: bearer(tokenOwner),
    body: JSON.stringify({ merchantId, periodFrom: fromIso, periodTo: toIso, note: "تسوية مكررة" }),
  });
  assert.equal(
    settledAgain.status,
    409,
    `19-د: the SAME period may not be settled twice · ${JSON.stringify(settledAgain.body)}`
  );
  assert.equal(settledAgain.body.error.code, "SETTLEMENT_PERIOD_OVERLAP");
  // An OVERLAPPING range is the same defect wearing different dates.
  const overlapping = await request("/platform/finance/settlements", {
    method: "POST",
    headers: bearer(tokenOwner),
    body: JSON.stringify({
      merchantId,
      periodFrom: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      periodTo: toIso,
    }),
  });
  assert.equal(
    overlapping.body.error?.code,
    "SETTLEMENT_PERIOD_OVERLAP",
    `19-د: a wider range that swallows a settled period pays those entries twice · ${JSON.stringify(overlapping.body)}`
  );
  // A settlement with no period at all used to fall through to the report
  // defaults and settle month-to-date — real money over a range nobody chose.
  const noPeriod = await request("/platform/finance/settlements", {
    method: "POST",
    headers: bearer(tokenOwner),
    body: JSON.stringify({ merchantId }),
  });
  assert.equal(
    noPeriod.body.error?.code,
    "VALIDATION_FAILED",
    `19-د: a settlement must say what it pays for · ${JSON.stringify(noPeriod.body)}`
  );
  const walletAfterRefusals = await walletNow();
  assert.equal(
    walletAfterRefusals.lifetime.settledCount,
    1,
    "19-د: every refusal above wrote nothing"
  );
  assert.equal(
    walletAfterRefusals.lifetime.settledNetIqd,
    walletSettledNet,
    "19-د: …so the merchant's lifetime settled total did not double"
  );

  // The service guard reads inside its own transaction, so it cannot see a
  // request racing beside it. The database is what settles that race.
  let overlapCode: string | null = null;
  try {
    await sql.query(
      "INSERT INTO settlements (merchant_id, platform_owner_id, period_from, period_to, orders_count, subtotal_iqd, delivery_fee_iqd, commission_iqd) VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz, 0, 0, 0, 0)",
      [merchantId, ownerId, fromIso, walletSettled.periodTo]
    );
  } catch (error: any) {
    overlapCode = error.code;
  }
  assert.equal(
    overlapCode,
    "23P01",
    "19-د: the exclusion constraint refuses an overlapping period even when no service code is involved"
  );

  // An unbounded future periodTo used to poison the wallet permanently: the
  // pending window opens at the LATEST period_to, so one 2030 row made
  // «المستحق لك» read 0 for years with no API able to correct it.
  const futureTo = await request("/platform/finance/settlements", {
    method: "POST",
    headers: bearer(tokenOwner),
    body: JSON.stringify({
      merchantId,
      periodFrom: walletSettled.periodTo,
      periodTo: "2030-01-01T00:00:00Z",
    }),
  });
  assert.equal(futureTo.status, 201, JSON.stringify(futureTo.body));
  assert.ok(
    new Date(futureTo.body.settlement.periodTo).valueOf() <= Date.now(),
    `19-د: the period is clamped to now, exactly as pos.service.ts clamps a device-claimed soldAt · ${futureTo.body.settlement.periodTo}`
  );
  const walletAfterFuture = await walletNow();
  assert.ok(
    new Date(walletAfterFuture.period.from).valueOf() <= Date.now(),
    "19-د: …so the merchant's window still opens in the present"
  );
  // A period that has not STARTED yet has nothing honest to clamp to.
  const futureFrom = await request("/platform/finance/settlements", {
    method: "POST",
    headers: bearer(tokenOwner),
    body: JSON.stringify({
      merchantId,
      periodFrom: "2030-01-01T00:00:00Z",
      periodTo: "2031-01-01T00:00:00Z",
    }),
  });
  assert.equal(
    futureFrom.body.error?.code,
    "INVALID_DATE_FILTER",
    `19-د: a period that has not begun is refused outright · ${JSON.stringify(futureFrom.body)}`
  );

  // ============================================================
  // ق-233 — AND NEVER SETTLED ZERO TIMES EITHER.
  //
  // 19-د proved no instant is paid twice. Nothing proved the other half — that
  // no instant is paid NEVER — and the money that fell between two settlements
  // left all three screens at once: not in the earlier settlement (created after
  // its end), not in the later one (created before its start), and not in
  // «المستحق» either, because `merchantWallet` opens its window at the LATEST
  // `period_to`, which is later than both.
  //
  // It was the default, not an edge case: `settlementPeriod` clamps the end to
  // NOW, so an afternoon settlement ends at 14:03 — and the settle screen then
  // sent the REPORT's date range for the next one, which starts at a midnight.
  // Every cycle left a hole, and settlements are immutable, so no hole could be
  // repaired afterwards.
  // ============================================================
  // The anchor is read HERE rather than reused from the first settlement: the
  // assertions above added more settlements, and «where the last period ended»
  // is a fact about the table now, not about the row this suite happened to
  // start with. Hard-coding it would test the fixture instead of the rule.
  const lastEnd = new Date((await walletNow()).lastSettlement.periodTo);
  // ONE MILLISECOND after it. `settlementPeriod` clamps the END to now, so a gap
  // measured in minutes would have no valid end to pair it with — and a
  // millisecond is the better proof regardless: the rule is that the periods
  // TOUCH, not that they are roughly adjacent.
  const gapStart = new Date(lastEnd.getTime() + 1).toISOString();
  const gapped = await request("/platform/finance/settlements", {
    method: "POST",
    headers: bearer(tokenOwner),
    body: JSON.stringify({
      merchantId,
      periodFrom: gapStart,
      periodTo: new Date().toISOString(),
      note: "فترة تترك ثقباً",
    }),
  });
  assert.equal(
    gapped.status,
    409,
    `ق-233: a period that starts after the last one ended is refused · ${JSON.stringify(gapped.body)}`
  );
  assert.equal(gapped.body.error.code, "SETTLEMENT_PERIOD_GAP");
  // The refusal must name the exact INSTANT, not a date. The old overlap message
  // said only `YYYY-MM-DD`, so an operator who obeyed it literally picked that
  // day's midnight — which is BEFORE 14:03 — and was refused all over again.
  assert.match(
    gapped.body.error.message,
    new RegExp(lastEnd.toISOString()),
    "ق-233: …and names the instant to start from, to the millisecond"
  );

  // The database holds the same line, so a second writer cannot argue with it.
  let triggerRefused = false;
  try {
    await prisma.settlement.create({
      data: {
        merchantId,
        platformOwnerId: ownerId,
        periodFrom: new Date(gapStart),
        periodTo: new Date(),
        ordersCount: 0,
        subtotalIqd: 0,
        deliveryFeeIqd: 0,
        loyaltyDiscountIqd: 0,
        commissionIqd: 0,
      },
    });
  } catch {
    triggerRefused = true;
  }
  assert.equal(
    triggerRefused,
    true,
    "ق-233: the trigger refuses a gap written straight to the table, past every service check"
  );

  // …while the period that CONTINUES where the last one stopped is accepted, and
  // pays exactly what was pending — so the two halves together account for every
  // ledger entry the merchant has, with nothing counted twice and nothing lost.
  // Review batch 2, م-١١: an entry stamped at EXACTLY the last period's end belongs to that
  // period (it is summed `≤ periodTo`). The next settlement starts at that instant and used to
  // sum it again (`≥ periodFrom`): paid twice, while the wallet (`> periodTo`) never showed it.
  await prisma.ledgerEntry.create({
    data: {
      storeId,
      orderId: lateOrder.id,
      entryType: "order_completed",
      subtotalIqd: 10_000,
      deliveryFeeIqd: 0,
      commissionIqd: 0,
      commissionBps: 0,
      planCode: "boundary",
      note: "review batch 2: on the boundary",
      createdAt: lastEnd,
    },
  });
  const walletBeforeSecond = await walletNow();
  const pendingBeforeSecond = walletBeforeSecond.pending.netPayoutIqd;
  const settledCountBefore = walletBeforeSecond.lifetime.settledCount;
  const settledNetBefore = walletBeforeSecond.lifetime.settledNetIqd;
  const contiguous = await request("/platform/finance/settlements", {
    method: "POST",
    headers: bearer(tokenOwner),
    body: JSON.stringify({
      merchantId,
      periodFrom: lastEnd.toISOString(),
      periodTo: new Date().toISOString(),
      note: "تسوية متلاصقة",
    }),
  });
  assert.equal(
    contiguous.status,
    201,
    `ق-233: a period that continues the previous one is accepted · ${JSON.stringify(contiguous.body)}`
  );
  const secondNet =
    contiguous.body.settlement.subtotalIqd +
    contiguous.body.settlement.deliveryFeeIqd -
    (contiguous.body.settlement.loyaltyDiscountIqd ?? 0) -
    contiguous.body.settlement.commissionIqd;
  assert.equal(
    secondNet,
    pendingBeforeSecond,
    "ق-233: it pays exactly what «المستحق» said — the gap it would have left is worth nothing now"
  );
  const walletFinal = await walletNow();
  assert.equal(
    walletFinal.lifetime.settledCount,
    settledCountBefore + 1,
    "ق-233: exactly one new settlement — every refusal above wrote nothing"
  );
  assert.equal(
    walletFinal.lifetime.settledNetIqd,
    settledNetBefore + secondNet,
    "ق-233: lifetime is both periods, and both periods are the whole ledger"
  );
  assert.equal(walletFinal.pending.netPayoutIqd, 0, "ق-233: …with nothing left over in between");

  let settlementUpdateCode: string | null = null;
  try {
    await sql.query("UPDATE settlements SET commission_iqd = 0 WHERE id = $1", [
      settlement.body.settlement.id,
    ]);
  } catch (error: any) {
    settlementUpdateCode = error.code;
  }
  await sql.end();
  assert.equal(settlementUpdateCode, "23514");
  summary.finance = {
    merchantCommissionNet: merchantReport.body.totals.commissionIqd,
    settlementSnapshotMatches: true,
    immutability: "23514",
  };

  // ---------- self-registration: auto mode ----------
  const autoRegister = await request("/public/merchants/register", {
    method: "POST",
    body: JSON.stringify({
      ownerName: "صاحب المتجر",
      phone: "+9647100576402",
      businessName: "تاجر ذاتي تلقائي",
      storeName: "متجر تلقائي",
      storeSlug: "phase17-auto-store",
      email: "auto.phase17@codiq.test",
      password: "auto-phase17-password",
    }),
  });
  assert.equal(autoRegister.status, 201, JSON.stringify(autoRegister.body));
  assert.equal(autoRegister.body.approvalStatus, "approved");
  const autoLogin = await request("/auth/merchant/login", {
    method: "POST",
    body: JSON.stringify({
      identifier: "auto.phase17@codiq.test",
      password: "auto-phase17-password",
    }),
  });
  assert.equal(autoLogin.status, 200, "auto mode must allow immediate login");
  const autoSubscription = await prisma.merchantSubscription.findFirst({
    where: { merchant: { email: "auto.phase17@codiq.test" }, status: "active" },
    select: { plan: { select: { code: true } } },
  });
  // ق-128: registration now grants the free MONTH on growth, not the free plan.
  assert.equal(autoSubscription?.plan.code, "growth");

  // ---------- self-registration: manual mode gate ----------
  const modeToManual = await request("/platform/settings/registration", {
    method: "PUT",
    headers: bearer(tokenOwner),
    body: JSON.stringify({ mode: "manual" }),
  });
  assert.equal(modeToManual.status, 200);
  try {
    const pendingRegister = await request("/public/merchants/register", {
      method: "POST",
      body: JSON.stringify({
        ownerName: "صاحب المتجر",
        phone: "+9647100576403",
        businessName: "تاجر بانتظار",
        storeName: "متجر معلق",
        storeSlug: "phase17-pending-store",
        email: "pending.phase17@codiq.test",
        password: "pending-phase17-pass",
      }),
    });
    assert.equal(pendingRegister.status, 201);
    assert.equal(pendingRegister.body.approvalStatus, "pending");
    const pendingStore = await prisma.store.findUnique({
      where: { slug: "phase17-pending-store" },
      select: { isActive: true },
    });
    assert.equal(pendingStore?.isActive, false, "a pending merchant's store must stay inactive");
    const pendingLogin = await request("/auth/merchant/login", {
      method: "POST",
      body: JSON.stringify({
        identifier: "pending.phase17@codiq.test",
        password: "pending-phase17-pass",
      }),
    });
    assert.equal(pendingLogin.status, 403);
    assert.equal(pendingLogin.body.error.code, "MERCHANT_PENDING_APPROVAL");

    const requests = await request("/platform/merchants/registration-requests", {
      headers: bearer(tokenOwner),
    });
    assert.equal(requests.body.requests.length, 1);
    const pendingId = requests.body.requests[0].id;
    const approve = await request(`/platform/merchants/${pendingId}/approval`, {
      method: "POST",
      headers: bearer(tokenOwner),
      body: JSON.stringify({ action: "approve" }),
    });
    assert.equal(approve.status, 200);
    const approvedLogin = await request("/auth/merchant/login", {
      method: "POST",
      body: JSON.stringify({
        identifier: "pending.phase17@codiq.test",
        password: "pending-phase17-pass",
      }),
    });
    assert.equal(approvedLogin.status, 200, "approval must unlock login");
    assert.equal(
      (
        await prisma.store.findUnique({
          where: { slug: "phase17-pending-store" },
          select: { isActive: true },
        })
      )?.isActive,
      true
    );

    const rejectedRegister = await request("/public/merchants/register", {
      method: "POST",
      body: JSON.stringify({
        ownerName: "صاحب المتجر",
        phone: "+9647100576404",
        businessName: "تاجر مرفوض",
        storeName: "متجر مرفوض",
        storeSlug: "phase17-rejected-store",
        email: "rejected.phase17@codiq.test",
        password: "rejected-phase17-pass",
      }),
    });
    assert.equal(rejectedRegister.status, 201);
    const rejectId = (
      await request("/platform/merchants/registration-requests", { headers: bearer(tokenOwner) })
    ).body.requests[0].id;
    await request(`/platform/merchants/${rejectId}/approval`, {
      method: "POST",
      headers: bearer(tokenOwner),
      body: JSON.stringify({ action: "reject" }),
    });
    const rejectedLogin = await request("/auth/merchant/login", {
      method: "POST",
      body: JSON.stringify({
        identifier: "rejected.phase17@codiq.test",
        password: "rejected-phase17-pass",
      }),
    });
    assert.equal(rejectedLogin.status, 401, "a rejected merchant cannot sign in");
    summary.registration = {
      auto: autoLogin.status,
      pendingBlocked: pendingLogin.status,
      approvedUnlocked: approvedLogin.status,
      rejectedBlocked: rejectedLogin.status,
    };
  } finally {
    await request("/platform/settings/registration", {
      method: "PUT",
      headers: bearer(tokenOwner),
      body: JSON.stringify({ mode: "auto" }),
    });
  }

  // ---------- host → store resolution ----------
  await prisma.store.update({
    where: { id: storeId },
    data: { customDomain: "shop.phase17.example" },
  });
  const byCustom = await request("/public/store-for-host?host=shop.phase17.example");
  assert.equal(byCustom.status, 200);
  assert.equal(byCustom.body.slug, storeSlug);
  assert.equal(byCustom.body.matchedBy, "custom_domain");
  const subdomain = (await prisma.store.findUnique({
    where: { id: storeId },
    select: { defaultSubdomain: true },
  }))!.defaultSubdomain;
  const bySubdomain = await request(`/public/store-for-host?host=${subdomain}.codiq.iq`);
  assert.equal(bySubdomain.status, 200);
  assert.equal(bySubdomain.body.matchedBy, "default_subdomain");
  const unknownHost = await request("/public/store-for-host?host=nothing.example.com");
  assert.equal(unknownHost.status, 404);

  // =====================================================================
  // 19-د (ATTACK-SURFACE) — platform hostname takeover by slug squatting.
  //
  // Everything above this line passed while a stranger could POST
  // `storeSlug: "www"` at the open registration endpoint and own
  // `www.codiq.iq`: the wildcard CNAME delivers every label to the app, the SPA
  // redirects a non-app host's root to `/store/<slug>`, and `storeForHost`
  // matched the first label with no notion of a platform-owned name. The
  // visitor landed in the attacker's storefront wearing CODIQ's chrome, at a
  // cash-on-delivery form asking for his real name, phone and home address.
  // The slug was also burned permanently, since it is unique.
  //
  // Four assertions, because the fix has four independent layers and any one of
  // them silently reverting would leave the hole open through a different door.
  // =====================================================================
  const { RESERVED_STORE_SLUGS } = await import("../src/services/reserved-slugs.js");

  // (1) The unauthenticated door — the one the attack actually came through.
  const squat = await request("/public/merchants/register", {
    method: "POST",
    body: JSON.stringify({
      ownerName: "منتحل النطاق",
      phone: "+9647100576499",
      businessName: "منتحل",
      storeName: "CODIQ الرسمي",
      storeSlug: "www",
      email: "squat.phase17@codiq.test",
      password: "squat-phase17-pass",
    }),
  });
  assert.equal(
    squat.status,
    422,
    `19-د: registering the slug «www» must be refused — ${JSON.stringify(squat.body)}`
  );
  assert.equal(squat.body.error.code, "RESERVED_STORE_SLUG");
  assert.equal(
    await prisma.store.count({ where: { slug: "www" } }),
    0,
    "19-د: …and the name must not be burned by the attempt"
  );
  // The apex is takeable through its own first label, so it is on the list too.
  const apexSquat = await request("/public/merchants/register", {
    method: "POST",
    body: JSON.stringify({
      ownerName: "منتحل الجذر",
      phone: "+9647100576498",
      businessName: "منتحل",
      storeName: "CODIQ",
      storeSlug: "codiq",
      email: "squat.apex.phase17@codiq.test",
      password: "squat-phase17-pass",
    }),
  });
  assert.equal(apexSquat.status, 422);
  assert.equal(apexSquat.body.error.code, "RESERVED_STORE_SLUG");

  // (2) The merchant's own «add a store» door.
  const merchantSquat = await request("/merchant/stores", {
    method: "POST",
    headers: bearer(tokenMerchant),
    body: JSON.stringify({ name: "متجر إضافي", slug: "admin" }),
  });
  assert.equal(
    merchantSquat.status,
    422,
    `19-د: an authenticated merchant must be refused too — ${JSON.stringify(merchantSquat.body)}`
  );
  assert.equal(merchantSquat.body.error.code, "RESERVED_STORE_SLUG");

  // (3) THE RENAME. No application path changes a slug today, so this goes
  // straight at the database — which is exactly the layer that has to hold when
  // one appears. The trigger refuses the change; the row keeps its old name.
  let renameCode: string | null = null;
  try {
    await prisma.$executeRaw`UPDATE stores SET slug = 'api' WHERE id = ${storeId}::uuid`;
  } catch (error) {
    renameCode = (error as { meta?: { code?: string } })?.meta?.code ?? null;
  }
  assert.equal(
    renameCode,
    "23514",
    "19-د: renaming a store onto a reserved slug must be refused by the database"
  );
  assert.equal(
    (await prisma.store.findUnique({ where: { id: storeId }, select: { slug: true } }))!.slug,
    storeSlug
  );
  // …and the same for the column the host lookup actually matches.
  let subdomainRenameCode: string | null = null;
  try {
    await prisma.$executeRaw`UPDATE stores SET default_subdomain = 'cdn' WHERE id = ${storeId}::uuid`;
  } catch (error) {
    subdomainRenameCode = (error as { meta?: { code?: string } })?.meta?.code ?? null;
  }
  assert.equal(
    subdomainRenameCode,
    "23514",
    "19-د: default_subdomain is the column storeForHost reads — it is guarded too"
  );

  // (4) THE HOST LOOKUP refuses a reserved label outright. This is the half
  // that protects a database where a squat was planted BEFORE the rule shipped:
  // the trigger grandfathers such a row deliberately rather than renaming a
  // merchant's public address behind his back, so the lookup has to be the one
  // that says no. The fixture forces exactly that state — a pre-existing squat,
  // written with the trigger disabled the way an older deploy would have.
  await prisma.$executeRawUnsafe(
    "ALTER TABLE stores DISABLE TRIGGER codiq_guard_reserved_store_slug"
  );
  const grandfathered = await createStoreFoundation({
    merchantId,
    name: "متجر قديم على رابط محجوز",
    slug: "legacy-squat-phase17",
    defaultSubdomain: "legacy-squat-phase17",
  });
  await prisma.$executeRaw`UPDATE stores SET default_subdomain = 'www' WHERE id = ${grandfathered.id}::uuid`;
  await prisma.$executeRawUnsafe(
    "ALTER TABLE stores ENABLE TRIGGER codiq_guard_reserved_store_slug"
  );
  const squattedHost = await request("/public/store-for-host?host=www.codiq.iq");
  assert.equal(
    squattedHost.status,
    404,
    "19-د: a reserved label must not resolve to a store even when one already holds it"
  );
  const apexHost = await request("/public/store-for-host?host=codiq.iq");
  assert.equal(apexHost.status, 404);
  // The grandfathered row is left ALONE — not renamed, not deactivated.
  assert.equal(
    (await prisma.store.findUnique({
      where: { id: grandfathered.id },
      select: { defaultSubdomain: true },
    }))!.defaultSubdomain,
    "www"
  );

  // The mirror guard: the module the application refuses from and the table the
  // database refuses from must say the same thing. A mirror nobody checks is a
  // copy that rots, and the two halves rotting apart means one door reopens.
  const reservedRows = await prisma.reservedStoreSlug.findMany({ select: { slug: true } });
  assert.deepEqual(
    reservedRows.map((row) => row.slug).sort(),
    [...RESERVED_STORE_SLUGS].sort(),
    "19-د: services/reserved-slugs.ts and the reserved_store_slugs table have drifted apart"
  );

  summary.hostResolution = {
    customDomain: byCustom.status,
    subdomain: bySubdomain.status,
    unknown: unknownHost.status,
  };
  summary.reservedSlugs = {
    publicRegister: squat.status,
    apexRegister: apexSquat.status,
    merchantCreate: merchantSquat.status,
    databaseRename: renameCode,
    databaseSubdomainRename: subdomainRenameCode,
    grandfatheredHostResolves: squattedHost.status,
    apexHostResolves: apexHost.status,
    listSize: RESERVED_STORE_SLUGS.size,
  };

  // ---------- public plans are complete and secret-free ----------
  const openPlans = await request("/public/plans");
  assert.equal(openPlans.status, 200);
  assert.equal(openPlans.body.plans.length, 3);
  assert.ok(
    openPlans.body.plans.every(
      (plan: any) => typeof plan.commissionPercent === "number" && plan.limits.max_stores > 0
    )
  );

  // ---------- identity boundaries on the new surfaces ----------
  const merchantOnPlatformFinance = await request(
    `/platform/finance/report?from=${fromIso}&to=${toIso}`,
    { headers: bearer(tokenMerchant) }
  );
  assert.equal(merchantOnPlatformFinance.status, 403);
  summary.identityBoundaries = { merchantOnPlatformFinance: merchantOnPlatformFinance.status };

  // ---------- merchant delivery-rate management closes the commercial loop ----------
  // Bootstrap seeds all 18 governorates disabled; the API below is the only
  // write path that lets a store actually accept checkout orders.
  const ratesList = await request(`/merchant/stores/${storeSlug}/delivery-rates`, {
    headers: bearer(tokenMerchant),
  });
  assert.equal(ratesList.status, 200);
  assert.equal(ratesList.body.rates.length, 18, "store bootstrap must seed all 18 governorates");
  assert.ok(
    ratesList.body.rates.every((rate: any) => rate.isEnabled === false && rate.amountIqd === 0),
    "seeded rates start disabled at 0 IQD"
  );

  const deliveryProduct = await request(`/merchant/stores/${storeSlug}/catalog/products`, {
    method: "POST",
    headers: bearer(tokenMerchant),
    body: JSON.stringify({
      sku: "P17-DLV-1",
      name: "منتج توصيل بغداد",
      priceIqd: 15000,
      stockQuantity: 5,
    }),
  });
  assert.equal(deliveryProduct.status, 201);
  const customerRegister = await request(`/store/${storeSlug}/account/register`, {
    method: "POST",
    body: JSON.stringify({
      phone: "+9647811110017",
      password: "phase17-customer-pass",
      fullName: "زبونة توصيل 17",
    }),
  });
  assert.equal(customerRegister.status, 201);
  const tokenCustomer: string = customerRegister.body.accessToken;
  const customerAddress = await request(`/store/${storeSlug}/account/addresses`, {
    method: "POST",
    headers: bearer(tokenCustomer),
    body: JSON.stringify({
      recipientName: "زبونة توصيل 17",
      fullAddress: "حي المنصور، شارع 14",
      city: "Baghdad",
      governorate: "Baghdad",
      phoneContact: "+9647811110017",
      isDefault: true,
    }),
  });
  assert.equal(customerAddress.status, 201);
  const quoteBeforeEnable = await request(
    `/store/${storeSlug}/account/addresses/${customerAddress.body.address.id}/delivery-quote`,
    { headers: bearer(tokenCustomer) }
  );
  assert.equal(quoteBeforeEnable.status, 422);
  assert.equal(quoteBeforeEnable.body.error.code, "DELIVERY_UNAVAILABLE_FOR_GOVERNORATE");

  const enableBaghdad = await request(`/merchant/stores/${storeSlug}/delivery-rates/Baghdad`, {
    method: "PUT",
    headers: bearer(tokenMerchant),
    body: JSON.stringify({ amountIqd: 4000, isEnabled: true }),
  });
  assert.equal(enableBaghdad.status, 200);
  assert.equal(enableBaghdad.body.rate.amountIqd, 4000);
  assert.equal(enableBaghdad.body.rate.isEnabled, true);

  const quoteAfterEnable = await request(
    `/store/${storeSlug}/account/addresses/${customerAddress.body.address.id}/delivery-quote`,
    { headers: bearer(tokenCustomer) }
  );
  assert.equal(quoteAfterEnable.status, 200);
  assert.equal(quoteAfterEnable.body.delivery.amountIqd, 4000);
  const cartAdd = await request(`/store/${storeSlug}/cart/items`, {
    method: "POST",
    headers: bearer(tokenCustomer),
    body: JSON.stringify({ productId: deliveryProduct.body.product.id, quantity: 1 }),
  });
  assert.equal(cartAdd.status, 200);
  const deliveryCheckout = await request(`/store/${storeSlug}/checkout`, {
    method: "POST",
    headers: { ...bearer(tokenCustomer), "idempotency-key": "phase17-delivery-rates-checkout-1" },
    body: JSON.stringify({
      cartVersion: cartAdd.body.cart.version,
      addressId: customerAddress.body.address.id,
      paymentMethodCode: "cod",
    }),
  });
  assert.equal(deliveryCheckout.status, 201, JSON.stringify(deliveryCheckout.body));
  assert.equal(
    deliveryCheckout.body.order.deliveryFeeIqd,
    4000,
    "checkout must charge the API-managed rate"
  );

  const unknownGovernorate = await request(
    `/merchant/stores/${storeSlug}/delivery-rates/Atlantis`,
    { method: "PUT", headers: bearer(tokenMerchant), body: JSON.stringify({ isEnabled: true }) }
  );
  assert.equal(unknownGovernorate.status, 404);
  const negativeAmount = await request(`/merchant/stores/${storeSlug}/delivery-rates/Baghdad`, {
    method: "PUT",
    headers: bearer(tokenMerchant),
    body: JSON.stringify({ amountIqd: -5 }),
  });
  assert.equal(negativeAmount.status, 422);
  const emptyRateUpdate = await request(`/merchant/stores/${storeSlug}/delivery-rates/Baghdad`, {
    method: "PUT",
    headers: bearer(tokenMerchant),
    body: JSON.stringify({}),
  });
  assert.equal(emptyRateUpdate.status, 422);
  const customerOnRates = await request(`/merchant/stores/${storeSlug}/delivery-rates`, {
    headers: bearer(tokenCustomer),
  });
  assert.ok(
    customerOnRates.status === 401 || customerOnRates.status === 403,
    "customer token must not manage delivery rates"
  );

  // 19-د (عدسة المال): the delivery fee is OUTSIDE the commission base by
  // deliberate decision (ADR-006), and it had no upper bound at any layer —
  // service, schema and CHECK all stopped at `>= 0`, leaving int4's
  // 2,147,483,647 as the real ceiling. A merchant pricing goods at 1,000 and
  // delivery at 99,000 on all eighteen governorates books almost no commission
  // and is still remitted everything.
  const absurdRate = await request(`/merchant/stores/${storeSlug}/delivery-rates/Baghdad`, {
    method: "PUT",
    headers: bearer(tokenMerchant),
    body: JSON.stringify({ amountIqd: 99_000 }),
  });
  assert.equal(absurdRate.status, 422, JSON.stringify(absurdRate.body));
  assert.equal(
    absurdRate.body.error.code,
    "DELIVERY_RATE_TOO_HIGH",
    "19-د: a courier's fee has a ceiling"
  );
  assert.equal(
    (
      await request(`/merchant/stores/${storeSlug}/delivery-rates`, {
        headers: bearer(tokenMerchant),
      })
    ).body.rates.find((rate: any) => rate.governorate === "Baghdad").amountIqd,
    4000,
    "19-د: …and the refusal changed nothing"
  );
  // The bound is set far above any genuine Iraqi courier fee on purpose: one
  // that refused a rate an honest merchant might set would be worse than none.
  const highButReal = await request(`/merchant/stores/${storeSlug}/delivery-rates/Basra`, {
    method: "PUT",
    headers: bearer(tokenMerchant),
    body: JSON.stringify({ amountIqd: MAX_DELIVERY_RATE_IQD }),
  });
  assert.equal(
    highButReal.status,
    200,
    `19-د: the ceiling itself is allowed — the boundary is not off by one · ${JSON.stringify(highButReal.body)}`
  );
  await request(`/merchant/stores/${storeSlug}/delivery-rates/Basra`, {
    method: "PUT",
    headers: bearer(tokenMerchant),
    body: JSON.stringify({ amountIqd: 0, isEnabled: false }),
  });

  // A ceiling cannot stop a RATIO shift — a 30/70 goods-to-delivery split stays
  // legal — so the other half of the answer is visibility: the platform report
  // showed delivery and commission side by side and never related them.
  const ratioReport = await request(`/platform/finance/report?from=${fromIso}&to=${toIso}`, {
    headers: bearer(tokenOwner),
  });
  const ratioRow = ratioReport.body.merchants.find((row: any) => row.merchantId === merchantId);
  assert.ok(ratioRow, "19-د: the merchant appears in the platform report");
  assert.equal(
    ratioRow.deliveryToSubtotalBps,
    Math.round((ratioRow.totals.deliveryFeeIqd * 10000) / ratioRow.totals.subtotalIqd),
    "19-د: whoever settles him can see delivery as a share of the goods it delivered"
  );
  summary.deliveryRates = {
    seeded: ratesList.body.rates.length,
    quoteBeforeEnable: quoteBeforeEnable.status,
    checkoutFee: deliveryCheckout.body.order.deliveryFeeIqd,
    unknownGovernorate: unknownGovernorate.status,
    invalidAmount: negativeAmount.status,
    customerBlocked: customerOnRates.status,
    ceilingRefusal: absurdRate.body.error.code,
    deliveryToSubtotalBps: ratioRow.deliveryToSubtotalBps,
  };

  // MD-5: it is HIS wallet. The figures above are checked where the money is;
  // what is left to check is who may see them.
  assert.equal((await request(walletUrl)).status, 401, "MD-5: the wallet needs a merchant session");
  // An owner token must not read a merchant's wallet. The exact code is whatever
  // `verifyTypedSession` answers for a wrong identity kind; what matters is that
  // it is a refusal, and the message reports which one so a future change to that
  // guard is visible here rather than silent.
  const ownerOnWallet = await request(walletUrl, { headers: bearer(tokenOwner) });
  assert.ok(
    ownerOnWallet.status === 401 || ownerOnWallet.status === 403,
    `MD-5: an owner session is not a merchant session here — got ${ownerOnWallet.status}`
  );
  summary.merchantWallet = {
    pendingMatchedSettlement: walletSettledNet,
    pendingAfterSettlement: walletAfter.pending.netPayoutIqd,
    windowStartsAtLastSettlement: true,
  };

  // =====================================================================
  // 19-د (ATTACK-SURFACE) — the keyset `cursor`, on EVERY list that takes one.
  //
  // Two defects with one shape. Several lists took `request.query.cursor` with a
  // bare `typeof === "string"` check and handed it to Prisma:
  //
  //   · a non-uuid raised P2023 on a `@db.Uuid` column, which the error handler
  //     matched nothing for — it fell through to the bare 500 INTERNAL_ERROR.
  //     `?cursor=abc` was an unhandled server error any signed-in merchant,
  //     staff member or ORDINARY SHOPPER could produce at will;
  //   · Prisma resolves a cursor row by id ALONE — the emitted subselect carries
  //     no `store_id` — so a cursor from another store positioned the page. The
  //     outer `where` keeps the tenant so nothing foreign is returned; what
  //     leaks is an existence-and-ordering oracle. Low, and the fix is the same
  //     one the sibling lists already used: resolve it store-scoped first.
  //
  // This suite is where all five doors can be knocked on at once — it holds an
  // owner, a merchant and a customer session against one store. The platform
  // directory is validated for SHAPE only, on purpose: it is the owner's view of
  // every store, so there is no tenant to scope its cursor to.
  // =====================================================================
  const cursorProbes = {
    catalogProducts: await request(`/merchant/stores/${storeSlug}/catalog/products?cursor=abc`, {
      headers: bearer(tokenMerchant),
    }),
    customerDirectory: await request(`/merchant/stores/${storeSlug}/customers?cursor=abc`, {
      headers: bearer(tokenMerchant),
    }),
    notificationLog: await request(`/merchant/stores/${storeSlug}/notifications/log?cursor=abc`, {
      headers: bearer(tokenMerchant),
    }),
    storefrontOrders: await request(`/store/${storeSlug}/account/orders?cursor=abc`, {
      headers: bearer(tokenCustomer),
    }),
    platformStores: await request("/platform/stores?cursor=abc", { headers: bearer(tokenOwner) }),
    publicProducts: await request(`/store/${storeSlug}/products?cursor=abc`),
  };
  for (const [name, probe] of Object.entries(cursorProbes)) {
    assert.ok(
      probe.status >= 400 && probe.status < 500,
      `19-د: ${name} answered ${probe.status} to ?cursor=abc — a malformed id is the caller's mistake, not a server fault`
    );
    assert.ok(
      typeof probe.body?.error?.code === "string",
      `19-د: ${name} must answer a NAMED error, not a bare failure`
    );
  }
  // An empty cursor is the FIRST PAGE, not an error — it is what an unset
  // client-side variable serialises to, and answering 400 would break paging on
  // its first request.
  const emptyCursor = await request(`/merchant/stores/${storeSlug}/catalog/products?cursor=`, {
    headers: bearer(tokenMerchant),
  });
  assert.equal(emptyCursor.status, 200, "an empty cursor is the first page");

  // A well-formed uuid from ANOTHER store must not position this store's page.
  // The oracle is closed by resolving the cursor inside the caller's own scope.
  const foreignCustomer = await prisma.customer.create({
    data: {
      storeId: grandfathered.id,
      fullName: "زبونة متجر آخر",
      phoneNormalized: "+9647811110099",
      passwordHash: "unused",
    },
  });
  const foreignCursor = await request(
    `/merchant/stores/${storeSlug}/customers?cursor=${foreignCustomer.id}`,
    { headers: bearer(tokenMerchant) }
  );
  assert.equal(
    foreignCursor.status,
    404,
    "19-د: a cursor naming another store's row must be a plain 404, not a page positioned against it"
  );
  summary.keysetCursor = {
    ...Object.fromEntries(
      Object.entries(cursorProbes).map(([name, probe]) => [name, probe.status])
    ),
    emptyCursor: emptyCursor.status,
    foreignCursor: foreignCursor.status,
  };

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
}
