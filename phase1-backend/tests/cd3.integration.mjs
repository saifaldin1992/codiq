/**
 * codiq CD-3 «بوابة إرجاع ذاتية» — the shopper asks, the merchant answers.
 *
 * The portal touches money, so the tests are about the seam between a request
 * and a reversal:
 *
 *   1. ASKING IS NOT RETURNING — an open request leaves the order `completed`
 *      and the ledger untouched. A shopper cannot reverse a merchant's money by
 *      filling in a form;
 *   2. APPROVING GOES THROUGH THE ONE PATH — the order becomes `returned` AND a
 *      single `order_returned` ledger entry appears, mirroring the completion
 *      exactly. Not a second reversal written by this feature;
 *   3. REJECTING CHANGES NOTHING FINANCIAL, and needs a written reason the
 *      shopper can read;
 *   4. THE WINDOW IS THE FINANCE WINDOW — a request cannot be opened once
 *      automatic reversal is no longer possible, so «approved» can never mean
 *      «and the money silently stayed with the merchant»;
 *   5. ONLY A RECEIVED ORDER can be returned, only its OWNER may ask, only ONE
 *      request may be open, and a decided request cannot be withdrawn or
 *      re-decided;
 *   6. the answer is recorded in the store's audit log with its reason.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { Client } from "pg";

const testId = `cd3-${Date.now()}`;
process.env.SESSION_JWT_SECRET = process.env.SESSION_JWT_SECRET ?? "cd3-test-secret-only-not-for-production";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { RETURN_REVERSAL_WINDOW_DAYS } = await import("../src/services/finance.service.ts");

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

  const merchant = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: `+9647${String(Date.now()).slice(-9)}`, email: `${testId}@codiq.test`, password: "cd3-merchant-pass", businessName: "تجارة الإرجاع" });
  assert.equal(merchant.status, 201, JSON.stringify(merchant.payload));
  const store = await prisma.store.create({ data: { merchantId: merchant.payload.account.id, name: "متجر الإرجاع", slug: `${testId}-a`, defaultSubdomain: `${testId}-a` } });
  const token = (await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}@codiq.test`, password: "cd3-merchant-pass" } })).payload.accessToken;

  const product = await prisma.product.create({ data: { storeId: store.id, sku: `${testId}-P`, name: "منتج", priceIqd: 20000, isActive: true } });
  const variant = await prisma.productVariant.update({
    where: { id: (await prisma.productVariant.findFirstOrThrow({ where: { productId: product.id, isDefault: true } })).id },
    data: { sku: `${testId}-P-D`, stockQuantity: 50, priceIqd: 20000 },
  });

  let shopperSeq = 0;
  async function makeCustomer(tag) {
    shopperSeq += 1;
    const email = `${testId}.${tag}@codiq.test`;
    const created = await request(`/store/${store.slug}/account/register`, {
      method: "POST",
      body: { phone: `+9647${String(Date.now() + shopperSeq * 11).slice(-9)}`, email, password: "Cd3ShopperPass2026!", fullName: `زبون ${tag}` },
    });
    assert.equal(created.status, 201, JSON.stringify(created.payload));
    const customer = await prisma.customer.findFirstOrThrow({ where: { storeId: store.id, email }, select: { id: true } });
    return { id: customer.id, token: created.payload.accessToken };
  }
  const buyer = await makeCustomer("buyer");
  const stranger = await makeCustomer("stranger");

  let orderSeq = 0;
  async function makeOrder(customerId, status = "new") {
    orderSeq += 1;
    return prisma.storeOrder.create({
      data: {
        storeId: store.id, customerId, orderNumber: `CD3-${String(orderSeq).padStart(4, "0")}`, status,
        customerName: "زبون", customerEmail: `${testId}.buyer@codiq.test`, recipientPhone: "+9647100000004",
        shippingGovernorate: "بغداد", shippingAddressLine1: "شارع 1",
        subtotalIqd: 20000, deliveryFeeIqd: 3000, totalIqd: 23000,
        items: { create: [{ productId: product.id, variantId: variant.id, sku: variant.sku, productName: "منتج", quantity: 1, unitPriceIqd: 20000, lineTotalIqd: 20000 }] },
      },
    });
  }
  /** Drive an order to `completed` through the real state machine, so a real ledger entry exists. */
  async function complete(order) {
    let version = 1;
    for (const toStatus of ["processing", "preparation", "out_for_delivery", "completed"]) {
      const moved = await request(`/merchant/stores/${store.slug}/orders/${order.id}/status`, { method: "POST", token, body: { toStatus, expectedVersion: version } });
      assert.equal(moved.status, 200, `${toStatus}: ${JSON.stringify(moved.payload)}`);
      version = moved.body?.order?.version ?? moved.payload.order.version;
    }
    return prisma.storeOrder.findUniqueOrThrow({ where: { id: order.id } });
  }

  const returnsPath = (orderId) => `/store/${store.slug}/account/orders/${orderId}/returns`;

  // ============================================================
  // 5. Only a received order, only its owner.
  // ============================================================
  const pending = await makeOrder(buyer.id, "new");
  const tooEarly = await request(returnsPath(pending.id), { method: "POST", token: buyer.token, body: { reason: "غيّرت رأيي" } });
  assert.equal(tooEarly.status, 422, JSON.stringify(tooEarly.payload));
  assert.equal(tooEarly.payload.error.code, "ORDER_NOT_RETURNABLE", "CD-3: you cannot return what you have not received");

  const order = await complete(await makeOrder(buyer.id));
  assert.equal(order.status, "completed");

  const foreign = await request(returnsPath(order.id), { method: "POST", token: stranger.token, body: { reason: "تسلل" } });
  assert.equal(foreign.status, 404, "CD-3: another shopper's order is a 404, not a 403 — this endpoint does not confirm an order exists");
  assert.equal((await request(returnsPath(order.id), { method: "POST", body: { reason: "بلا جلسة" } })).status, 401);
  assert.equal((await request(returnsPath(order.id), { method: "POST", token: buyer.token, body: {} })).payload.error.code, "RETURN_REASON_REQUIRED", "CD-3: a return with no stated reason gives the merchant nothing to act on");

  // ============================================================
  // 1. Asking is not returning.
  // ============================================================
  const ledgerBefore = await prisma.ledgerEntry.findMany({ where: { storeId: store.id, orderId: order.id }, select: { entryType: true } });
  assert.deepEqual(ledgerBefore.map((row) => row.entryType), ["order_completed"], "the completion entry exists before anything else happens");

  const asked = await request(returnsPath(order.id), { method: "POST", token: buyer.token, body: { reason: "المقاس غير مناسب" } });
  assert.equal(asked.status, 201, JSON.stringify(asked.payload));
  const requestId = asked.payload.request.id;
  assert.equal(asked.payload.request.status, "requested");

  assert.equal((await prisma.storeOrder.findUniqueOrThrow({ where: { id: order.id } })).status, "completed", "CD-3: an open request leaves the order completed — a shopper cannot return an order by filling a form");
  assert.equal(await prisma.ledgerEntry.count({ where: { storeId: store.id, orderId: order.id } }), 1, "CD-3: …and writes nothing to the ledger");

  // The deadline travels with the request, measured from the completion entry.
  const completionEntry = await prisma.ledgerEntry.findFirstOrThrow({ where: { orderId: order.id, entryType: "order_completed" } });
  const storedRequest = await prisma.returnRequest.findUniqueOrThrow({ where: { id: requestId } });
  assert.equal(
    storedRequest.reversalDeadline.valueOf(),
    completionEntry.createdAt.valueOf() + RETURN_REVERSAL_WINDOW_DAYS * 86_400_000,
    "CD-3: the deadline is measured from the SAME entry the reversal measures from, so the merchant is not told one date while the money uses another",
  );

  // One open request per order.
  assert.equal((await request(returnsPath(order.id), { method: "POST", token: buyer.token, body: { reason: "مرة أخرى" } })).payload.error.code, "RETURN_ALREADY_REQUESTED");

  // ============================================================
  // 3. Rejecting: a reason is required, and nothing financial moves.
  // ============================================================
  const decisionPath = (id) => `/merchant/stores/${store.slug}/returns/${id}/decision`;
  assert.equal((await request(decisionPath(requestId), { method: "POST", token, body: { approve: false } })).payload.error.code, "RETURN_REJECTION_NOTE_REQUIRED", "CD-3: refusing a shopper needs to be explainable");
  const rejected = await request(decisionPath(requestId), { method: "POST", token, body: { approve: false, note: "المنتج مستعمل ولا يقبل الإرجاع" } });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.payload));
  assert.equal((await prisma.storeOrder.findUniqueOrThrow({ where: { id: order.id } })).status, "completed", "CD-3: a rejection moves no order");
  assert.equal(await prisma.ledgerEntry.count({ where: { storeId: store.id, orderId: order.id } }), 1, "CD-3: …and no money");
  // The shopper can read why.
  const mine = await request(`/store/${store.slug}/account/returns`, { token: buyer.token });
  assert.equal(mine.payload.requests[0].status, "rejected");
  assert.equal(mine.payload.requests[0].decisionNote, "المنتج مستعمل ولا يقبل الإرجاع", "CD-3: the shopper reads the reason he was refused");

  assert.equal((await request(decisionPath(requestId), { method: "POST", token, body: { approve: true } })).payload.error.code, "RETURN_ALREADY_DECIDED", "CD-3: an answered request cannot be answered twice");
  assert.equal((await request(`/store/${store.slug}/account/returns/${requestId}/withdraw`, { method: "POST", token: buyer.token })).payload.error.code, "RETURN_ALREADY_DECIDED", "CD-3: …nor withdrawn after the answer");

  // A rejected request does not bar a second attempt — the partial unique index.
  const second = await request(returnsPath(order.id), { method: "POST", token: buyer.token, body: { reason: "أرفقت صور العيب" } });
  assert.equal(second.status, 201, "CD-3: after a rejection he may ask again");

  // ============================================================
  // 2. Approving goes through the one path that moves money.
  // ============================================================
  const approved = await request(decisionPath(second.payload.request.id), { method: "POST", token, body: { approve: true } });
  assert.equal(approved.status, 200, JSON.stringify(approved.payload));
  assert.equal(approved.payload.request.status, "approved");

  const afterOrder = await prisma.storeOrder.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(afterOrder.status, "returned", "CD-3: approving moves the order through the state machine");
  const entries = await prisma.ledgerEntry.findMany({ where: { storeId: store.id, orderId: order.id }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(entries.map((row) => row.entryType), ["order_completed", "order_returned"], "CD-3: exactly ONE reversal, written by the finance service — not a second one by this feature");
  const [completion, reversal] = entries;
  assert.equal(reversal.subtotalIqd, completion.subtotalIqd, "CD-3: the reversal mirrors the completion exactly");
  assert.equal(reversal.deliveryFeeIqd, completion.deliveryFeeIqd);
  assert.equal(reversal.commissionIqd, completion.commissionIqd);
  assert.equal(reversal.note, "automatic_return_reversal", "CD-3: …and it is the finance service's own entry");

  // The status event names the merchant, through the same machine as any other move.
  const events = await prisma.orderStatusEvent.findMany({ where: { storeId: store.id, orderId: order.id }, orderBy: { createdAt: "asc" } });
  const last = events[events.length - 1];
  assert.equal(last.toStatus, "returned");
  assert.match(last.note ?? "", /طلب الزبون/, "CD-3: the order's own history says this return came from a shopper's request");

  // ============================================================
  // 4. The window is the finance window.
  // ============================================================
  // The completion entry is INSERTED already aged rather than updated afterwards:
  // `ledger_entries_immutable` fires BEFORE UPDATE OR DELETE, so the ledger
  // refuses to be rewritten — which is the guarantee the whole finance domain
  // rests on, and a test that worked around it would be testing a database this
  // platform does not have.
  const stale = await makeOrder(buyer.id, "completed");
  await sql.query(
    `INSERT INTO ledger_entries (store_id, order_id, entry_type, subtotal_iqd, delivery_fee_iqd, commission_iqd, commission_bps, plan_code, note, created_at)
     VALUES ($1, $2, 'order_completed', 20000, 3000, 600, 300, 'free', 'aged fixture', now() - ($3 || ' days')::interval)`,
    [store.id, stale.id, RETURN_REVERSAL_WINDOW_DAYS + 1],
  );
  const late = await request(returnsPath(stale.id), { method: "POST", token: buyer.token, body: { reason: "متأخر" } });
  assert.equal(late.status, 422, JSON.stringify(late.payload));
  assert.equal(late.payload.error.code, "RETURN_WINDOW_CLOSED", "CD-3: no request may be opened once automatic reversal is impossible — otherwise «approved» could mean the money quietly stayed with the merchant");
  assert.equal(await prisma.returnRequest.count({ where: { orderId: stale.id } }), 0);

  // ============================================================
  // 6. Boundaries and the trail.
  // ============================================================
  assert.equal((await request(`/merchant/stores/${store.slug}/returns`, { token: buyer.token })).status, 403, "CD-3: a customer session is not a merchant session");
  assert.equal((await request(decisionPath(second.payload.request.id), { method: "POST", body: { approve: true } })).status, 401);
  const queue = await request(`/merchant/stores/${store.slug}/returns`, { token });
  assert.equal(queue.status, 200);
  assert.ok(queue.payload.requests.length >= 2, "CD-3: the merchant sees his store's requests");

  const audit = await prisma.storeAuditEvent.findMany({ where: { storeId: store.id, entityType: "return_request" }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(audit.map((row) => row.action), ["return.rejected", "return.approved"], "CD-3: both answers are recorded");
  assert.equal(audit[0].metadata.reason ?? audit[0].metadata.note, "المنتج مستعمل ولا يقبل الإرجاع");
  assert.ok(audit.every((row) => row.actorKind === "merchant"));

  // ============================================================
  // 7. The decision and the order it moves commit TOGETHER.
  //
  // They used to be two transactions: the order went to `returned` (ledger
  // reversal, points, stock queue) and only then was the request marked. A
  // failure between the two left a returned order beside a request that stayed
  // «open» forever — `returned → returned` is not an edge, so no later approval
  // could ever clear it. The failure is injected at the LAST write of the
  // decision (its audit row), the furthest point from the order's own write.
  // ============================================================
  const atomicOrder = await complete(await makeOrder(buyer.id));
  const atomicAsk = await request(returnsPath(atomicOrder.id), { method: "POST", token: buyer.token, body: { reason: "عيب مصنعي" } });
  assert.equal(atomicAsk.status, 201, JSON.stringify(atomicAsk.payload));
  const atomicId = atomicAsk.payload.request.id;
  await sql.query(`CREATE OR REPLACE FUNCTION cd3_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.entity_id = '${atomicId}'::uuid THEN RAISE EXCEPTION 'cd3 injected audit failure'; END IF; RETURN NEW; END $$`);
  await sql.query("CREATE TRIGGER cd3_fail_audit BEFORE INSERT ON store_audit_events FOR EACH ROW EXECUTE FUNCTION cd3_fail_audit()");
  let failedDecision;
  try {
    failedDecision = await request(decisionPath(atomicId), { method: "POST", token, body: { approve: true } });
  } finally {
    await sql.query("DROP TRIGGER cd3_fail_audit ON store_audit_events");
    await sql.query("DROP FUNCTION cd3_fail_audit()");
  }
  assert.ok(failedDecision.status >= 500, `the injected failure must fail the decision · ${failedDecision.status}`);
  assert.equal((await prisma.storeOrder.findUniqueOrThrow({ where: { id: atomicOrder.id } })).status, "completed", "a decision that failed must not have returned the order");
  assert.equal(await prisma.ledgerEntry.count({ where: { orderId: atomicOrder.id, entryType: "order_returned" } }), 0, "…nor reversed its money");
  assert.equal((await prisma.returnRequest.findUniqueOrThrow({ where: { id: atomicId } })).status, "requested", "…and the request is still open, so it can be answered again");
  const retried = await request(decisionPath(atomicId), { method: "POST", token, body: { approve: true } });
  assert.equal(retried.status, 200, `the same approval succeeds once the fault is gone · ${JSON.stringify(retried.payload)}`);
  assert.equal((await prisma.storeOrder.findUniqueOrThrow({ where: { id: atomicOrder.id } })).status, "returned");

  // Two answers racing on one request: exactly one wins, and the order agrees with it.
  const racedOrder = await complete(await makeOrder(buyer.id));
  const racedAsk = await request(returnsPath(racedOrder.id), { method: "POST", token: buyer.token, body: { reason: "مقاس خطأ" } });
  const racedId = racedAsk.payload.request.id;
  const answers = await Promise.all([
    request(decisionPath(racedId), { method: "POST", token, body: { approve: true } }),
    request(decisionPath(racedId), { method: "POST", token, body: { approve: false, note: "خارج الشروط" } }),
  ]);
  assert.equal(answers.filter((answer) => answer.status === 200).length, 1, `exactly one of two racing answers may stand · ${answers.map((answer) => answer.status)}`);
  const racedFinal = await prisma.returnRequest.findUniqueOrThrow({ where: { id: racedId } });
  const racedOrderFinal = await prisma.storeOrder.findUniqueOrThrow({ where: { id: racedOrder.id } });
  assert.equal(racedOrderFinal.status === "returned", racedFinal.status === "approved", `the order is returned exactly when the request was approved · ${racedFinal.status}/${racedOrderFinal.status}`);
  summary.cd3Atomic = { failedDecision: failedDecision.status, retried: retried.status, raced: answers.map((answer) => answer.status), racedFinal: racedFinal.status };

  summary.cd3 = {
    openRequestLeavesOrder: "completed",
    ledgerEntriesAfterApproval: entries.map((row) => row.entryType),
    reversalMirrorsCompletion: reversal.commissionIqd === completion.commissionIqd,
    windowDays: RETURN_REVERSAL_WINDOW_DAYS,
    lateRequest: late.payload.error.code,
    auditActions: audit.map((row) => row.action),
  };

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await sql.end();
  await prisma.$disconnect();
}
