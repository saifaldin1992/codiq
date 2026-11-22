/**
 * ق-246 — the parcel after it leaves the shelf: handover, manifest, cash.
 *
 * The platform is cash-on-delivery through courier companies, and until this
 * batch it recorded nothing about a parcel once it left: not who took it, not
 * its waybill, not when, not whether its cash came back. The merchant
 * reconciled with the courier from a paper notebook.
 *
 * WHAT IS ASSERTED:
 *   1. the «قيد التوصيل» transition records courier, tracking and the moment
 *   2. a later correction keeps the moment and bumps the version (two tabs)
 *   3. the courier list is the store's own spellings, most used first
 *   4. the manifest CSV: BOM, header, one row per parcel in the window, the
 *      cash to collect — and NEVER another store's parcel
 *   5. reconciliation arithmetic: delivered = collected, returned = nothing,
 *      marked-received moves outstanding to zero; per courier and in total
 *   6. marking is idempotent, refuses undelivered orders, and is tenant-bound
 *
 * Run: pnpm delivery:test
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const testId = `delivery-${Date.now()}`;
const suffix = String(Date.now()).slice(-8);
process.env.SESSION_JWT_SECRET = "delivery-test-secret-only-not-for-production";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

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
      ...(body ? { "content-type": "application/json" } : {}),
      origin: base,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // response.text() strips a leading UTF-8 BOM per the encoding spec, so the
  // CSV assertions read the raw bytes and decode by hand (as phase20b3 does).
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString("utf8");
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { status: response.status, payload, text, bytes, headers: response.headers };
}

const summary = {};
try {
  // ── two merchants, two stores: the second exists to prove the walls ──────
  const password = "DeliveryPass123!";
  const registerA = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    businessName: "متجر التوصيل ألف",
    phone: `+96475${suffix}`,
    email: `${testId}.a@codiq.test`,
    password,
  });
  const registerB = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    businessName: "متجر التوصيل باء",
    phone: `+96476${suffix}`,
    email: `${testId}.b@codiq.test`,
    password,
  });
  assert.equal(registerA.status, 201, JSON.stringify(registerA.payload));
  assert.equal(registerB.status, 201, JSON.stringify(registerB.payload));
  const storeA = await prisma.store.create({
    data: {
      merchantId: registerA.payload.account.id,
      name: "متجر التوصيل ألف",
      slug: `${testId}-a`,
      defaultSubdomain: `${testId}-a`,
    },
  });
  const storeB = await prisma.store.create({
    data: {
      merchantId: registerB.payload.account.id,
      name: "متجر التوصيل باء",
      slug: `${testId}-b`,
      defaultSubdomain: `${testId}-b`,
    },
  });
  const tokenA = (
    await request("/auth/merchant/login", {
      method: "POST",
      body: { identifier: `${testId}.a@codiq.test`, password },
    })
  ).payload.accessToken;
  const tokenB = (
    await request("/auth/merchant/login", {
      method: "POST",
      body: { identifier: `${testId}.b@codiq.test`, password },
    })
  ).payload.accessToken;
  assert.ok(tokenA && tokenB, "both merchants sign in");

  const ordersA = `/merchant/stores/${storeA.slug}/orders`;
  const ordersB = `/merchant/stores/${storeB.slug}/orders`;
  const order = (storeId, tag, extra = {}) =>
    prisma.storeOrder.create({
      data: {
        storeId,
        orderNumber: `DLV-${tag}`,
        status: "preparation",
        customerName: `زبون ${tag}`,
        recipientPhone: `+96477${tag.padStart(7, "0")}`,
        shippingGovernorate: "Baghdad",
        shippingAddressLine1: "شارع التوصيل",
        subtotalIqd: 40000,
        deliveryFeeIqd: 5000,
        totalIqd: 45000,
        paymentStatus: "pending",
        source: "storefront",
        ...extra,
      },
      select: { id: true, version: true },
    });
  const status = (token, path, orderId, toStatus, expectedVersion, extra = {}) =>
    request(`${path}/${orderId}/status`, {
      token,
      method: "POST",
      body: { toStatus, expectedVersion, ...extra },
    });

  // ============================================================
  // 1. The handover is recorded at the transition that IS the handover.
  // ============================================================
  const first = await order(storeA.id, "1001");
  const handed = await status(tokenA, ordersA, first.id, "out_for_delivery", first.version, {
    courierName: "  شركة الفهد  ",
    trackingNumber: "FHD-77",
  });
  assert.equal(handed.status, 200, JSON.stringify(handed.payload));
  assert.equal(handed.payload.order.status, "out_for_delivery");
  assert.equal(handed.payload.order.courierName, "شركة الفهد", "the courier is recorded, trimmed");
  assert.equal(handed.payload.order.trackingNumber, "FHD-77");
  assert.ok(handed.payload.order.handedOverAt, "…and the moment it left is stamped");
  assert.equal(handed.payload.order.codCollectedAt, null, "no cash has come back yet");
  const handedAt = handed.payload.order.handedOverAt;
  summary.handoverAtTransition =
    "out_for_delivery carries courierName + trackingNumber and stamps handedOverAt";

  // A transition that names no courier stamps nothing — the field records facts,
  // and «I do not know yet» is a fact too.
  const plain = await order(storeA.id, "1002");
  const plainHanded = await status(tokenA, ordersA, plain.id, "out_for_delivery", plain.version);
  assert.equal(plainHanded.status, 200);
  assert.equal(plainHanded.payload.order.courierName, null);
  assert.equal(
    plainHanded.payload.order.handedOverAt,
    null,
    "no courier named → no handover stamped"
  );

  // ============================================================
  // 2. A correction keeps the moment and guards against the other tab.
  // ============================================================
  const stale = await request(`${ordersA}/${first.id}/delivery`, {
    token: tokenA,
    method: "PATCH",
    body: { trackingNumber: "FHD-78", expectedVersion: first.version },
  });
  assert.equal(
    stale.status,
    409,
    "the transition bumped the version; a tab that did not see it is refused"
  );
  assert.equal(stale.payload.error.code, "ORDER_VERSION_CONFLICT");
  const corrected = await request(`${ordersA}/${first.id}/delivery`, {
    token: tokenA,
    method: "PATCH",
    body: { trackingNumber: "FHD-78", expectedVersion: handed.payload.order.version },
  });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.payload));
  assert.equal(corrected.payload.order.trackingNumber, "FHD-78");
  assert.equal(corrected.payload.order.courierName, "شركة الفهد", "an unnamed field is left alone");
  assert.equal(
    corrected.payload.order.handedOverAt,
    handedAt,
    "the original moment survives a correction"
  );
  // Naming a courier on the un-named parcel IS its handover.
  const named = await request(`${ordersA}/${plain.id}/delivery`, {
    token: tokenA,
    method: "PATCH",
    body: { courierName: "توصيل سريع", expectedVersion: plainHanded.payload.order.version },
  });
  assert.equal(named.status, 200, JSON.stringify(named.payload));
  assert.ok(named.payload.order.handedOverAt, "naming the courier afterwards stamps the handover");
  // Too early is refused: a courier on a `new` order is a plan, not a fact.
  const early = await order(storeA.id, "1003", { status: "new" });
  const tooEarly = await request(`${ordersA}/${early.id}/delivery`, {
    token: tokenA,
    method: "PATCH",
    body: { courierName: "شركة الفهد", expectedVersion: early.version },
  });
  assert.equal(tooEarly.status, 422);
  assert.equal(tooEarly.payload.error.code, "DELIVERY_NOT_APPLICABLE");
  // And never across the wall.
  const crossWall = await request(`${ordersB}/${first.id}/delivery`, {
    token: tokenB,
    method: "PATCH",
    body: { courierName: "x", expectedVersion: 1 },
  });
  assert.equal(
    crossWall.status,
    404,
    "store B cannot touch store A's parcel — a plain 404, not a hint"
  );
  summary.correction =
    "PATCH keeps handedOverAt, honours expectedVersion, refuses pre-handover statuses and other tenants";

  // ============================================================
  // 3. The courier list is the store's own spellings.
  // ============================================================
  const second = await order(storeA.id, "1004");
  await status(tokenA, ordersA, second.id, "out_for_delivery", second.version, {
    courierName: "شركة الفهد",
  });
  const couriers = await request(`${ordersA}/couriers`, { token: tokenA });
  assert.equal(couriers.status, 200, JSON.stringify(couriers.payload));
  assert.deepEqual(
    couriers.payload.couriers,
    ["شركة الفهد", "توصيل سريع"],
    "most used first, the store's own spelling, nothing from store B"
  );
  const couriersB = await request(`${ordersB}/couriers`, { token: tokenB });
  assert.deepEqual(
    couriersB.payload.couriers,
    [],
    "store B has handed nothing over and sees nothing of A"
  );
  summary.courierList = "own spellings, most used first, tenant-bound";

  // ============================================================
  // 4. The manifest — what the courier's system ingests.
  // ============================================================
  const parcelB = await order(storeB.id, "2001");
  await status(tokenB, ordersB, parcelB.id, "out_for_delivery", parcelB.version, {
    courierName: "شركة الفهد",
    trackingNumber: "B-1",
  });
  const manifest = await request(
    `${ordersA}/manifest.csv?courier=${encodeURIComponent("شركة الفهد")}`,
    { token: tokenA }
  );
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get("content-type") ?? "", /text\/csv/);
  assert.deepEqual(
    [...manifest.bytes.subarray(0, 3)],
    [0xef, 0xbb, 0xbf],
    "BOM first — Excel in Arabic Windows reads UTF-8 only with it"
  );
  const lines = manifest.text
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/);
  assert.equal(
    lines[0],
    "order_number,handed_over_at,courier_name,tracking_number,customer_name,recipient_phone,shipping_governorate,shipping_address_line1,shipping_address_line2,cod_amount_iqd,status,customer_note"
  );
  assert.equal(
    lines.length - 1,
    2,
    `two parcels went to this courier from this store (DLV-1001, DLV-1004): ${manifest.text}`
  );
  assert.ok(
    lines.some(
      (line) => line.includes("DLV-1001") && line.includes("FHD-78") && line.includes(",45000,")
    ),
    "the row carries the corrected waybill and the cash to collect"
  );
  assert.ok(
    !manifest.text.includes("DLV-2001"),
    "store B's parcel with the SAME courier is not in store A's manifest"
  );
  assert.ok(!manifest.text.includes("DLV-1002"), "the other courier's parcel is filtered out");
  const allCouriers = await request(`${ordersA}/manifest.csv`, { token: tokenA });
  assert.equal(
    allCouriers.text
      .replace(/^\uFEFF/, "")
      .trim()
      .split(/\r?\n/).length - 1,
    3,
    "without a courier filter: every parcel handed over in the window"
  );
  const badWindow = await request(
    `${ordersA}/manifest.csv?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z`,
    { token: tokenA }
  );
  assert.equal(badWindow.status, 422, "a year is a report nobody prints — the window is bounded");
  summary.manifest =
    "BOM + header + one row per parcel, courier-filtered, window-bounded, tenant-bound";

  // ============================================================
  // 5. Reconciliation arithmetic.
  // ============================================================
  // DLV-1001 delivered (45,000 collected by the courier), DLV-1004 returned
  // (nothing collected), DLV-1002 still in transit with the other courier.
  const delivered = await status(
    tokenA,
    ordersA,
    first.id,
    "completed",
    corrected.payload.order.version
  );
  assert.equal(delivered.status, 200, JSON.stringify(delivered.payload));
  const returned = await status(
    tokenA,
    ordersA,
    second.id,
    "returned",
    (
      await prisma.storeOrder.findUniqueOrThrow({
        where: { id: second.id },
        select: { version: true },
      })
    ).version
  );
  assert.equal(returned.status, 200, JSON.stringify(returned.payload));
  const before = await request(`${ordersA}/cod-reconciliation`, { token: tokenA });
  assert.equal(
    before.payload.outstandingTotal,
    before.payload.outstanding.length,
    "below the 200 cap the outstanding list is whole, and outstandingTotal says so"
  );
  assert.equal(before.status, 200, JSON.stringify(before.payload));
  const fahd = before.payload.couriers.find((row) => row.courierName === "شركة الفهد");
  assert.ok(fahd, "the courier appears");
  assert.deepEqual(
    {
      handedOver: fahd.handedOver,
      delivered: fahd.delivered,
      returned: fahd.returned,
      inTransit: fahd.inTransit,
      collectedIqd: fahd.collectedIqd,
      receivedIqd: fahd.receivedIqd,
      outstandingIqd: fahd.outstandingIqd,
    },
    {
      handedOver: 2,
      delivered: 1,
      returned: 1,
      inTransit: 0,
      collectedIqd: 45000,
      receivedIqd: 0,
      outstandingIqd: 45000,
    },
    "delivered counts its cash, returned counts nothing, and all of it is outstanding until the merchant says otherwise"
  );
  const quick = before.payload.couriers.find((row) => row.courierName === "توصيل سريع");
  assert.deepEqual(
    { inTransit: quick.inTransit, collectedIqd: quick.collectedIqd },
    { inTransit: 1, collectedIqd: 0 },
    "in transit is neither collected nor outstanding"
  );
  assert.equal(before.payload.totals.outstandingIqd, 45000);
  assert.deepEqual(
    before.payload.outstanding.map((row) => row.orderNumber),
    ["DLV-1001"],
    "the outstanding list names the delivered, unmarked parcel"
  );
  summary.reconciliation =
    "delivered → collected & outstanding; returned → 0; in transit → 0; totals and the outstanding list agree";

  // ============================================================
  // 6. Marking cash received: idempotent, delivered-only, tenant-bound.
  // ============================================================
  const marked = await request(`${ordersA}/cod-collected`, {
    token: tokenA,
    method: "POST",
    body: { orderIds: [first.id, second.id, plain.id] },
  });
  assert.equal(marked.status, 200, JSON.stringify(marked.payload));
  assert.deepEqual(
    marked.payload,
    { requested: 3, marked: 1 },
    "only the delivered parcel is marked — the returned and in-transit ones cannot have cash to receive"
  );
  const again = await request(`${ordersA}/cod-collected`, {
    token: tokenA,
    method: "POST",
    body: { orderIds: [first.id] },
  });
  assert.deepEqual(
    again.payload,
    { requested: 1, marked: 0 },
    "marking twice marks nothing the second time"
  );
  const fromB = await request(`${ordersB}/cod-collected`, {
    token: tokenB,
    method: "POST",
    body: { orderIds: [first.id] },
  });
  assert.deepEqual(
    fromB.payload,
    { requested: 1, marked: 0 },
    "store B cannot mark store A's cash — silently zero, no hint that the id exists"
  );
  const after = await request(`${ordersA}/cod-reconciliation`, { token: tokenA });
  const fahdAfter = after.payload.couriers.find((row) => row.courierName === "شركة الفهد");
  assert.deepEqual(
    { receivedIqd: fahdAfter.receivedIqd, outstandingIqd: fahdAfter.outstandingIqd },
    { receivedIqd: 45000, outstandingIqd: 0 },
    "the money moved from outstanding to received"
  );
  assert.deepEqual(after.payload.outstanding, [], "…and nothing is outstanding with this courier");
  const readOnly = await request(`${ordersA}/cod-collected`, {
    token: tokenA,
    method: "POST",
    body: { orderIds: [] },
  });
  assert.equal(readOnly.status, 422, "an empty batch is a 422, not a silent success");
  summary.markCollected = "idempotent, delivered-only, tenant-bound, empty batch refused";

  // ============================================================
  // Review batch 4, م-٢: the cash at the door is what is still owed, not the order total.
  // A card (or partner) order is paid before it leaves; an instalment plan pays the goods
  // and leaves only the delivery fee. The manifest told the courier to collect 45,000 from
  // both — the shopper who already paid was asked to pay again.
  // ============================================================
  const prepaidCourier = "ناقل الدفع المسبق";
  const handedOverAt = new Date();
  for (const [tag, paymentStatus] of [
    ["1101", "paid"],
    ["1102", "instalments"],
  ]) {
    await order(storeA.id, tag, {
      status: "completed",
      courierName: prepaidCourier,
      handedOverAt,
      paymentStatus,
    });
  }
  const prepaidManifest = await request(
    `${ordersA}/manifest.csv?courier=${encodeURIComponent(prepaidCourier)}`,
    { token: tokenA }
  );
  const cashFor = (orderNumber) =>
    prepaidManifest.text
      .split(/\r?\n/)
      .find((line) => line.startsWith(orderNumber))
      ?.split(",")[9];
  assert.deepEqual(
    { card: cashFor("DLV-1101"), instalments: cashFor("DLV-1102") },
    { card: "0", instalments: "5000" },
    "paid → nothing to collect; instalments → the delivery fee alone"
  );
  const prepaidReconciliation = await request(
    `${ordersA}/cod-reconciliation?courier=${encodeURIComponent(prepaidCourier)}`,
    { token: tokenA }
  );
  const prepaidRow = prepaidReconciliation.payload.couriers[0];
  assert.deepEqual(
    { delivered: prepaidRow.delivered, collectedIqd: prepaidRow.collectedIqd },
    { delivered: 2, collectedIqd: 5000 },
    "the courier owes the merchant the cash he collected — 5,000, not 90,000"
  );
  assert.deepEqual(
    prepaidReconciliation.payload.outstanding.map((row) => [row.orderNumber, row.codIqd]),
    [["DLV-1102", 5000]],
    "an order with nothing to collect is not outstanding"
  );
  summary.prepaidCash =
    "paid → 0, instalments → delivery fee, in the manifest and the reconciliation";

  console.log(JSON.stringify({ suite: "delivery-cod", status: "passed", summary }, null, 2));
} finally {
  server.close();
  await prisma.$disconnect();
}
