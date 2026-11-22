/**
 * Marketplace M7b — support tickets, over HTTP, with real orders and a real
 * bucket (moto) for the pictures.
 *
 *   1. Opening: only from a delivered order, only within 24 hours of delivery,
 *      one live ticket per order, a description of ten letters at least.
 *   2. The conversation: the shopper cannot reply before support has; the
 *      store answers (→ «بانتظار ردّك», «ردود جديدة»), he replies
 *      (→ «قيد المعالجة»); the inbox carries «ردّ جديد من الدعم».
 *   3. «هل حُلّت مشكلتك؟»: «ليس بعد» reopens, «نعم» closes; no reply on a
 *      closed ticket; a new ticket may then be opened.
 *   4. Pictures: three per side, readable by the shopper, his store and the
 *      owner — not by another shopper or another store.
 *   5. The owner: every store's tickets, escalation, answering, closing; a
 *      merchant sees only his own store's tickets.
 *   6. The shopper's tabs and summary.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { killTree } from "./helpers/child-process.mjs";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

process.env.CODIQ_ALLOW_OWNER_REGISTRATION ??= "true";
const testId = `m7t${Date.now().toString(36)}`;
const digits = String(Date.now()).slice(-7);
const s3Port = 4594;
const bucket = `codiq-${testId}`;
const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000200000002080600000072b60d240000000970485973000003e8000003e801b57b526b000000114944415408d763e0d10bfb0fc20c300600322c063d26facb460000000049454e44ae426082", "hex");
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL ?? process.env.DATABASE_URL);
Object.assign(process.env, { PRODUCT_S3_ENDPOINT: `http://127.0.0.1:${s3Port}`, PRODUCT_S3_BUCKET: bucket, PRODUCT_S3_ACCESS_KEY_ID: "S3RVER", PRODUCT_S3_SECRET_ACCESS_KEY: "S3RVER", PRODUCT_S3_REGION: "us-east-1", PRODUCT_S3_FORCE_PATH_STYLE: "true" });
const moto = spawn("moto_server", ["-H", "127.0.0.1", "-p", String(s3Port)], { stdio: "ignore" });
for (let attempt = 0; attempt < 40; attempt += 1) {
  try { await fetch(`http://127.0.0.1:${s3Port}`); break; } catch { await new Promise((resolve) => setTimeout(resolve, 150)); }
  if (attempt === 39) throw new Error("Moto S3-compatible test server did not start.");
}
await new S3Client({ endpoint: process.env.PRODUCT_S3_ENDPOINT, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" } }).send(new CreateBucketCommand({ Bucket: bucket }));

const { prisma } = await import("../src/db/prisma.ts");
const { createApp } = await import("../src/http/app.ts");
const { setOtpProviderForTests } = await import("../src/modules/market-account/otp.service.ts");
const { transitionOrderStatus } = await import("../src/services/order-lifecycle.service.ts");
await prisma.storefrontRateLimit.deleteMany({ where: { OR: [{ scope: { startsWith: "market_otp" } }, { scope: { startsWith: "market_ticket" } }, { scope: { startsWith: "ticket_upload" } }] } });

const sent = [];
setOtpProviderForTests({ name: "capture", async send(phone, code) { sent.push({ phone, code }); } });
const server = createApp().listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const summary = {};

function client(bearer) {
  const jar = new Map();
  return {
    async request(path, { method = "GET", body, form, headers = {} } = {}) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), origin: base, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(jar.size ? { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ") } : {}), ...headers },
        body: form ?? (body ? JSON.stringify(body) : undefined),
      });
      for (const line of response.headers.getSetCookie?.() ?? []) { const [pair] = line.split(";"); const eq = pair.indexOf("="); jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1)); }
      const type = response.headers.get("content-type") ?? "";
      return { status: response.status, type, payload: type.includes("json") ? await response.json().catch(() => null) : Buffer.from(await response.arrayBuffer()) };
    },
  };
}
async function signIn(phone) {
  const shopper = client();
  const asked = await shopper.request("/market/auth/code", { method: "POST", body: { phone } });
  assert.equal(asked.status, 200, JSON.stringify(asked.payload));
  const verified = await shopper.request("/market/auth/verify", { method: "POST", body: { challengeId: asked.payload.challengeId, code: sent.at(-1).code } });
  assert.equal(verified.status, 200, JSON.stringify(verified.payload));
  return { shopper, id: verified.payload.shopper.id };
}
const image = () => { const form = new FormData(); form.append("image", new Blob([png], { type: "image/png" }), "p.png"); return form; };

const created = { stores: [] };
try {
  // ── fixtures ─────────────────────────────────────────────────────────────
  const ownerEmail = `${testId}.owner@codiq.test`;
  assert.ok([200, 201].includes((await client().request("/auth/platform/register", { method: "POST", body: { email: ownerEmail, password: "OwnerPass123!Strong", displayName: "مالك" } })).status));
  const owner = client((await client().request("/auth/platform/login", { method: "POST", body: { email: ownerEmail, password: "OwnerPass123!Strong" } })).payload.accessToken);
  const listed = { marketStatus: "listed", marketStatusAt: new Date(), marketListedAt: new Date() };
  async function merchantWithStore(label, n) {
    const email = `${testId}.${label}@codiq.test`;
    const reg = await registerMerchantDirect({ ownerName: "تاجر", businessName: "متجر", phone: `+9647${n}${digits}6`.slice(0, 14), email, password: "MarketSupport!2026" });
    assert.equal(reg.status, 201, JSON.stringify(reg.payload));
    const store = await prisma.store.create({ data: { merchantId: reg.payload.account.id, name: `متجر ${testId} ${label}`, slug: `${testId}-${label}`, defaultSubdomain: `${testId}-${label}`, ...listed } });
    created.stores.push(store.id);
    await prisma.deliveryRate.create({ data: { storeId: store.id, governorate: "Baghdad", amountIqd: 3000, isEnabled: true } });
    const product = await prisma.product.create({ data: { storeId: store.id, sku: `${testId}-${label}`, name: `منتج ${label}`, priceIqd: 10000, stockQuantity: 50 } });
    const token = (await client().request("/auth/merchant/login", { method: "POST", body: { identifier: email, password: "MarketSupport!2026" } })).payload.accessToken;
    return { store, product, merchantId: reg.payload.account.id, api: client(token) };
  }
  const A = await merchantWithStore("a", 5);
  const B = await merchantWithStore("b", 8);

  const phone = `+96477${digits}4`.slice(0, 14);
  const { shopper } = await signIn(phone);
  const district = await prisma.district.findFirstOrThrow({ where: { governorateKey: "Baghdad", nameAr: "الكاظمية" } });
  const home = (await shopper.request("/market/me/addresses", { method: "POST", body: { label: "البيت", recipientName: "علي", phone, altPhone: null, governorateKey: "Baghdad", districtId: district.id, addressLine: "شارع ٢٠", latitude: null, longitude: null } })).payload.address;
  let seq = 0;
  async function buy(m) {
    await shopper.request("/market/cart/items", { method: "POST", body: { productId: m.product.id, quantity: 1 } });
    const placed = await shopper.request(`/market/checkout/${m.store.slug}`, { method: "POST", body: { addressId: home.id }, headers: { "idempotency-key": `${testId}-order-${++seq}-idempotency` } });
    assert.equal(placed.status, 201, JSON.stringify(placed.payload));
    return placed.payload.order.id;
  }
  async function deliver(m, orderId) {
    for (const toStatus of ["processing", "preparation", "out_for_delivery", "completed"]) {
      const { version } = await prisma.storeOrder.findUniqueOrThrow({ where: { id: orderId } });
      await transitionOrderStatus(m.store.id, { kind: "merchant", id: m.merchantId }, orderId, { toStatus, expectedVersion: version });
    }
  }
  const t = (path) => `/market/tickets${path}`;
  const ms = (m, path = "") => `/merchant/stores/${m.store.slug}/support-tickets${path}`;

  // ── 1. opening ───────────────────────────────────────────────────────────
  const undelivered = await buy(A);
  const notYet = await shopper.request(t(""), { method: "POST", body: { orderId: undelivered, type: "damaged", description: "المنتج وصل مكسوراً تماماً" } });
  assert.deepEqual([notYet.status, notYet.payload.error.code], [422, "TICKET_NOT_ALLOWED"]);
  assert.match(notYet.payload.error.message, /لم يصلك/);
  const old = await buy(A);
  await deliver(A, old);
  await prisma.storeOrder.update({ where: { id: old }, data: { statusUpdatedAt: new Date(Date.now() - 25 * 3_600_000) } });
  assert.match((await shopper.request(`/market/orders/${old}/ticket-eligibility`)).payload.reason, /24 ساعة/, "after a day, no ticket");
  const orderA = await buy(A);
  await deliver(A, orderA);
  assert.equal((await shopper.request(`/market/orders/${orderA}/ticket-eligibility`)).payload.allowed, true);
  assert.equal((await shopper.request(t(""), { method: "POST", body: { orderId: orderA, type: "damaged", description: "قصير" } })).status, 422, "ten letters at least");
  assert.equal((await shopper.request(t(""), { method: "POST", body: { orderId: orderA, type: "bogus", description: "المنتج وصل مكسوراً تماماً" } })).status, 422);
  const opened = await shopper.request(t(""), { method: "POST", body: { orderId: orderA, type: "damaged", subject: "زجاجة مكسورة", description: "المنتج وصل مكسوراً تماماً والعلبة ممزّقة." } });
  assert.equal(opened.status, 201, JSON.stringify(opened.payload));
  const ticketId = opened.payload.ticket.id;
  assert.deepEqual([opened.payload.ticket.status, opened.payload.ticket.statusLabel], ["open", "فُتحت"]);
  assert.equal((await shopper.request(t(""), { method: "POST", body: { orderId: orderA, type: "other", description: "مشكلة أخرى في نفس الطلب" } })).payload.error.code, "TICKET_ALREADY_OPEN");
  summary.opening = true;

  // ── 2. the conversation ──────────────────────────────────────────────────
  assert.equal((await shopper.request(t(`/${ticketId}/replies`), { method: "POST", body: { body: "أين الردّ؟" } })).payload.error.code, "TICKET_AWAITING_SUPPORT");
  let mine = (await shopper.request(t(`/${ticketId}`))).payload;
  assert.deepEqual([mine.canReply, typeof mine.replyHint], [false, "string"]);
  assert.equal((await B.api.request(ms(B, `/${ticketId}`))).status, 404, "another store cannot see it");
  const storeView = (await A.api.request(ms(A, `/${ticketId}`))).payload;
  assert.equal(storeView.ticket.description, "المنتج وصل مكسوراً تماماً والعلبة ممزّقة.");
  assert.equal(storeView.order.items[0].productName, "منتج a");
  const answered = await A.api.request(ms(A, `/${ticketId}/replies`), { method: "POST", body: { body: "نعتذر، أرسل لنا صورة المنتج من فضلك." } });
  assert.equal(answered.status, 200, JSON.stringify(answered.payload));
  assert.equal(answered.payload.ticket.status, "awaiting_customer");
  const list = (await shopper.request(t(""))).payload;
  assert.deepEqual([list.tickets[0].statusLabel, list.tickets[0].newReplies, list.summary.awaitingYou], ["بانتظار ردّك", true, 1]);
  const inbox = (await shopper.request("/market/inbox")).payload.items;
  assert.equal(inbox[0].title, "ردّ جديد من الدعم");
  assert.equal(inbox[0].link, `/tickets/${ticketId}`);
  assert.match(inbox[0].body, /أرسل لنا صورة/);
  mine = (await shopper.request(t(`/${ticketId}`))).payload;
  assert.deepEqual(mine.ticket.comments.map((comment) => comment.side), ["support"]);
  assert.equal((await shopper.request(t(""))).payload.tickets[0].newReplies, false, "opened: read");
  const replied = await shopper.request(t(`/${ticketId}/replies`), { method: "POST", body: { body: "أرفقت الصورة." } });
  assert.equal(replied.payload.ticket.status, "in_progress");
  summary.conversation = true;

  // ── 4. pictures ──────────────────────────────────────────────────────────
  const up = await shopper.request(t(`/${ticketId}/attachments`), { method: "POST", form: image() });
  assert.equal(up.status, 201, JSON.stringify(up.payload));
  const attachmentId = up.payload.attachment.id;
  for (let i = 0; i < 2; i += 1) assert.equal((await shopper.request(t(`/${ticketId}/attachments`), { method: "POST", form: image() })).status, 201);
  assert.equal((await shopper.request(t(`/${ticketId}/attachments`), { method: "POST", form: image() })).payload.error.code, "TICKET_ATTACHMENTS_FULL");
  assert.equal((await A.api.request(ms(A, `/${ticketId}/attachments`), { method: "POST", form: image() })).status, 201, "the store has its own three");
  const asShopper = await shopper.request(t(`/${ticketId}/attachments/${attachmentId}`));
  // Stored re-encoded without metadata (proven in image-variants.unit.mjs): still a PNG.
  assert.deepEqual([asShopper.status, asShopper.type, asShopper.payload.subarray(0, 8).equals(png.subarray(0, 8))], [200, "image/png", true]);
  assert.equal((await A.api.request(ms(A, `/${ticketId}/attachments/${attachmentId}`))).status, 200);
  assert.equal((await owner.request(`/platform/market/support-tickets/${ticketId}/attachments/${attachmentId}`)).status, 200);
  assert.equal((await B.api.request(ms(B, `/${ticketId}/attachments/${attachmentId}`))).status, 404);
  const stranger = await signIn(`+96479${digits}8`.slice(0, 14));
  assert.equal((await stranger.shopper.request(t(`/${ticketId}/attachments/${attachmentId}`))).status, 404);
  assert.equal((await stranger.shopper.request(t(`/${ticketId}`))).status, 404);
  summary.pictures = true;

  // ── 3. resolved? ─────────────────────────────────────────────────────────
  const resolved = await A.api.request(ms(A, `/${ticketId}/replies`), { method: "POST", body: { body: "سنرسل بديلاً غداً.", resolve: true } });
  assert.equal(resolved.payload.ticket.status, "resolved");
  mine = (await shopper.request(t(`/${ticketId}`))).payload;
  assert.deepEqual([mine.askResolved, mine.canReply], [true, false]);
  assert.equal((await shopper.request(t(`/${ticketId}/confirm`), { method: "POST", body: { resolved: false } })).payload.ticket.status, "in_progress", "«ليس بعد» reopens it");
  await A.api.request(ms(A, `/${ticketId}/status`), { method: "PUT", body: { status: "resolved" } });
  assert.equal((await shopper.request(t(`/${ticketId}/confirm`), { method: "POST", body: { resolved: true } })).payload.ticket.status, "closed");
  assert.equal((await shopper.request(t(`/${ticketId}/replies`), { method: "POST", body: { body: "شكراً" } })).payload.error.code, "TICKET_CLOSED");
  assert.equal((await A.api.request(ms(A, `/${ticketId}/replies`), { method: "POST", body: { body: "عفواً" } })).payload.error.code, "TICKET_CLOSED");
  assert.equal((await shopper.request(`/market/orders/${orderA}/ticket-eligibility`)).payload.allowed, true, "closed: a new one may be opened");
  summary.resolution = true;

  // ── 5. the owner ─────────────────────────────────────────────────────────
  const orderB = await buy(B);
  await deliver(B, orderB);
  const second = (await shopper.request(t(""), { method: "POST", body: { orderId: orderB, type: "missing_item", description: "ينقص الطلب قطعة واحدة على الأقلّ." } })).payload.ticket;
  assert.ok([401, 403].includes((await A.api.request("/platform/market/support-tickets")).status), "a merchant is not the owner");
  assert.deepEqual((await A.api.request(ms(A))).payload.tickets.map((row) => row.id), [ticketId], "a store sees only its own");
  const all = (await owner.request("/platform/market/support-tickets?status=active")).payload.tickets.map((row) => row.id);
  assert.ok(all.includes(second.id) && !all.includes(ticketId), "the owner's active queue");
  assert.equal((await owner.request(`/platform/market/support-tickets/${second.id}/escalate`, { method: "POST" })).payload.ticket.escalated, true);
  assert.ok((await owner.request("/platform/market/support-tickets?escalated=1")).payload.tickets.some((row) => row.id === second.id));
  assert.equal((await owner.request(`/platform/market/support-tickets/${second.id}/replies`, { method: "POST", body: { body: "تولّينا طلبك وسنتابع مع المتجر." } })).payload.ticket.comments[0].authorKind, "platform");
  assert.equal((await owner.request(`/platform/market/support-tickets/${second.id}/close`, { method: "POST" })).payload.ticket.status, "closed");
  // Every hand the owner puts on a ticket is in the platform audit log, with who did it.
  const ticketAudit = await prisma.platformAuditEvent.findMany({ where: { entityType: "support_ticket", entityId: second.id }, orderBy: { createdAt: "asc" } });
  assert.ok(ticketAudit.some((row) => row.action === "support_ticket_escalated"), "the escalation is audited");
  assert.ok(ticketAudit.some((row) => row.action === "support_ticket_replied"), "…the owner's reply");
  assert.ok(ticketAudit.some((row) => row.action === "support_ticket_closed" && row.actorKind === "platform_owner"), "…and the close, with its actor");
  assert.equal((await owner.request(`/platform/market/support-tickets/${second.id}/close`, { method: "POST" })).status, 409, "a closed ticket is not closed twice");
  assert.equal(await prisma.platformAuditEvent.count({ where: { entityType: "support_ticket", entityId: second.id, action: "support_ticket_closed" } }), 1, "…nor audited twice");
  summary.owner = true;

  // ── 6. tabs ──────────────────────────────────────────────────────────────
  const openTab = (await shopper.request(t("?tab=open"))).payload;
  const closedTab = (await shopper.request(t("?tab=closed&limit=1"))).payload;
  assert.deepEqual([openTab.tickets.length, openTab.summary.closed, closedTab.tickets.length, Boolean(closedTab.nextCursor)], [0, 2, 1, true]);
  summary.tabs = true;

  // ── a long ticket still shows its latest message ──────────────────────────
  // Two hundred and five comments: the page carries the NEWEST two hundred.
  const long = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticketId } });
  const base = Date.now() + 60_000; // after every comment the ticket already has
  await prisma.supportTicketComment.createMany({ data: Array.from({ length: 205 }, (_, i) => ({ ticketId: long.id, authorKind: i % 2 ? "shopper" : "merchant", body: `رسالة ${i + 1}`, createdAt: new Date(base + i * 60_000) })) });
  const longView = (await shopper.request(t(`/${ticketId}`))).payload.ticket;
  assert.equal(longView.comments.at(-1).body, "رسالة 205", "the newest message is on the page");
  assert.equal(longView.comments.length, 200);
  assert.equal(longView.earlierComments, true, "…and the page says older ones exist");
  assert.ok(new Date(longView.comments[0].createdAt) < new Date(longView.comments.at(-1).createdAt), "still read oldest to newest");
  summary.longTicket = true;

  console.log(JSON.stringify({ suite: "market-support", ok: true, summary }, null, 2));
} finally {
  setOtpProviderForTests(null);
  await prisma.store.updateMany({ where: { id: { in: created.stores } }, data: { marketStatus: "unlisted", marketStatusAt: new Date() } }).catch(() => undefined);
  server.close();
  await prisma.$disconnect();
  await killTree(moto);
}
