/**
 * Marketplace M7a — what the shopper keeps and asks. Over HTTP.
 *
 *   1. Favourites: save a product (an unlisted one refused), the hearts for a
 *      page of cards, the list paged newest first, remove; follow a store with
 *      its follower count, the list, an unlisted store refused; «اشتريت منها».
 *   2. The inbox, derived from real history: the store's steps on an order
 *      and its answer to a return appear; the shopper's own cancel does not;
 *      unread count, one read, paging, read-all, and a later step unread again.
 *   3. Help: seeded sections and quick answers; search by every word with
 *      Arabic normalization; the owner adds a section and an answer, an
 *      unpublished one stays hidden; support contacts; a merchant cannot edit.
 *   4. «تواصل معنا»: a visitor writes; bad phone and short text refused; the
 *      owner's queue and «handled»; the per-IP limit.
 *   5. «قيّم التطبيق»: once a week; the owner's average and distribution.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

process.env.CODIQ_ALLOW_OWNER_REGISTRATION ??= "true";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL ?? process.env.DATABASE_URL);
const { prisma } = await import("../src/db/prisma.ts");
const { createApp } = await import("../src/http/app.ts");
const { setOtpProviderForTests } = await import("../src/modules/market-account/otp.service.ts");
const { transitionOrderStatus } = await import("../src/services/order-lifecycle.service.ts");

const sent = [];
setOtpProviderForTests({ name: "capture", async send(phone, code) { sent.push({ phone, code }); } });
const testId = `m7${Date.now().toString(36)}`;
const digits = String(Date.now()).slice(-7);
const server = createApp().listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const summary = {};

function client(bearer) {
  const jar = new Map();
  return {
    async request(path, { method = "GET", body, headers = {} } = {}) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), origin: base, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(jar.size ? { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ") } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      for (const line of response.headers.getSetCookie?.() ?? []) { const [pair] = line.split(";"); const eq = pair.indexOf("="); jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1)); }
      return { status: response.status, payload: await response.json().catch(() => null) };
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

const created = { stores: [], sections: [] };
try {
  // ── fixtures ─────────────────────────────────────────────────────────────
  const ownerEmail = `${testId}.owner@codiq.test`;
  assert.ok([200, 201].includes((await client().request("/auth/platform/register", { method: "POST", body: { email: ownerEmail, password: "OwnerPass123!Strong", displayName: "مالك" } })).status));
  const owner = client((await client().request("/auth/platform/login", { method: "POST", body: { email: ownerEmail, password: "OwnerPass123!Strong" } })).payload.accessToken);
  const password = "MarketHelp!2026Strong";
  const reg = await registerMerchantDirect({ ownerName: "تاجر", businessName: "متجر", phone: `+96475${digits}6`.slice(0, 14), email: `${testId}@codiq.test`, password });
  assert.equal(reg.status, 201, JSON.stringify(reg.payload));
  const merchantId = reg.payload.account.id;
  const listed = { marketStatus: "listed", marketStatusAt: new Date(), marketListedAt: new Date() };
  const A = await prisma.store.create({ data: { merchantId, name: `متجر ${testId} أ`, slug: `${testId}-a`, defaultSubdomain: `${testId}-a`, ...listed } });
  const B = await prisma.store.create({ data: { merchantId, name: `متجر ${testId} ب`, slug: `${testId}-b`, defaultSubdomain: `${testId}-b`, ...listed } });
  const hidden = await prisma.store.create({ data: { merchantId, name: `مخفي ${testId}`, slug: `${testId}-h`, defaultSubdomain: `${testId}-h` } });
  created.stores.push(A.id, B.id, hidden.id);
  const merchant = client((await client().request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}@codiq.test`, password } })).payload.accessToken);
  await prisma.deliveryRate.create({ data: { storeId: A.id, governorate: "Baghdad", amountIqd: 3000, isEnabled: true } });
  const product = (store, name) => prisma.product.create({ data: { storeId: store.id, sku: `${testId}-${Math.random().toString(36).slice(2, 8)}`, name, priceIqd: 10000, stockQuantity: 20 } });
  const p1 = await product(A, "عطر"); const p2 = await product(A, "ساعة"); const p3 = await product(B, "حقيبة");
  const ph = await product(hidden, "مخفي");

  const phone = `+96477${digits}4`.slice(0, 14);
  const { shopper } = await signIn(phone);
  const district = await prisma.district.findFirstOrThrow({ where: { governorateKey: "Baghdad", nameAr: "الكاظمية" } });
  const home = (await shopper.request("/market/me/addresses", { method: "POST", body: { label: "البيت", recipientName: "علي", phone, altPhone: null, governorateKey: "Baghdad", districtId: district.id, addressLine: "شارع ٢٠", latitude: null, longitude: null } })).payload.address;

  // ── 1. favourites ────────────────────────────────────────────────────────
  assert.equal((await client().request(`/market/favourites/products/${p1.id}`, { method: "PUT" })).status, 401);
  assert.equal((await shopper.request(`/market/favourites/products/${ph.id}`, { method: "PUT" })).status, 404, "a product not in the market");
  for (const p of [p1, p2, p3]) assert.equal((await shopper.request(`/market/favourites/products/${p.id}`, { method: "PUT" })).status, 200);
  assert.equal((await shopper.request(`/market/favourites/products/${p1.id}`, { method: "PUT" })).status, 200, "saving twice is fine");
  const flags = (await shopper.request(`/market/favourites/flags?products=${p1.id},${ph.id}&stores=${A.slug}`)).payload;
  assert.deepEqual(flags, { products: [p1.id], stores: [] });
  assert.deepEqual((await client().request(`/market/favourites/flags?products=${p1.id}`)).payload, { products: [], stores: [] }, "a visitor has no hearts");
  const fav1 = (await shopper.request("/market/favourites/products?limit=2")).payload;
  assert.deepEqual(fav1.products.map((card) => card.id), [p3.id, p2.id], "newest first");
  const fav2 = (await shopper.request(`/market/favourites/products?limit=2&cursor=${encodeURIComponent(fav1.nextCursor)}`)).payload;
  assert.deepEqual(fav2.products.map((card) => card.id), [p1.id]);
  await shopper.request(`/market/favourites/products/${p2.id}`, { method: "DELETE" });
  assert.equal((await shopper.request("/market/favourites/products")).payload.products.length, 2);
  assert.equal((await shopper.request(`/market/stores/${hidden.slug}/follow`, { method: "PUT" })).status, 404, "an unlisted store");
  const followed = await shopper.request(`/market/stores/${A.slug}/follow`, { method: "PUT" });
  assert.deepEqual([followed.payload.following, followed.payload.followers], [true, 1]);
  await shopper.request(`/market/stores/${B.slug}/follow`, { method: "PUT" });
  assert.deepEqual((await shopper.request("/market/favourites/stores")).payload.stores.map((card) => card.slug), [B.slug, A.slug]);
  assert.equal((await shopper.request(`/market/stores/${B.slug}/follow`, { method: "DELETE" })).payload.followers, 0);
  assert.deepEqual((await shopper.request(`/market/favourites/flags?stores=${A.slug},${B.slug}`)).payload.stores, [A.slug]);
  summary.favourites = true;

  // ── 2. the inbox ─────────────────────────────────────────────────────────
  let seq = 0;
  async function buy(productId) {
    await shopper.request("/market/cart/items", { method: "POST", body: { productId, quantity: 1 } });
    const placed = await shopper.request(`/market/checkout/${A.slug}`, { method: "POST", body: { addressId: home.id }, headers: { "idempotency-key": `${testId}-order-${++seq}-idempotency` } });
    assert.equal(placed.status, 201, JSON.stringify(placed.payload));
    return placed.payload.order.id;
  }
  const actor = { kind: "merchant", id: merchantId };
  async function moveTo(orderId, ...statuses) {
    for (const toStatus of statuses) {
      const { version } = await prisma.storeOrder.findUniqueOrThrow({ where: { id: orderId } });
      await transitionOrderStatus(A.id, actor, orderId, { toStatus, expectedVersion: version });
    }
  }
  const mine = await buy(p1.id);
  assert.equal((await shopper.request("/market/inbox/unread")).payload.unread, 0, "placing an order is not a notice");
  const selfCancelled = await buy(p2.id);
  await shopper.request(`/market/orders/${selfCancelled}/cancel`, { method: "POST", body: { reasonCode: "changed_mind" } });
  assert.equal((await shopper.request("/market/inbox/unread")).payload.unread, 0, "his own cancel is not a notice to himself");
  await moveTo(mine, "processing", "preparation", "out_for_delivery", "completed");
  let inbox = (await shopper.request("/market/inbox")).payload;
  assert.deepEqual(inbox.items.map((item) => item.title), ["تمّ تسليم طلبك", "طلبك في الطريق إليك", "طلبك قيد التجهيز", "قبل المتجر طلبك"]);
  assert.equal(inbox.items[0].link, `/orders/${mine}`);
  assert.equal((await shopper.request("/market/inbox/unread")).payload.unread, 4);
  assert.equal((await shopper.request("/market/inbox/read", { method: "POST", body: { key: inbox.items[0].key } })).payload.unread, 3);
  assert.equal((await shopper.request("/market/inbox/read", { method: "POST", body: { key: "x:nope" } })).status, 422);
  inbox = (await shopper.request("/market/inbox?limit=2")).payload;
  assert.deepEqual(inbox.items.map((item) => item.read), [true, false]);
  const rest = (await shopper.request(`/market/inbox?limit=2&cursor=${encodeURIComponent(inbox.nextCursor)}`)).payload;
  assert.equal(rest.items.length, 2);
  assert.equal(rest.items[1].title, "قبل المتجر طلبك");
  assert.equal((await shopper.request("/market/inbox/read-all", { method: "POST" })).payload.unread, 0);
  assert.equal((await shopper.request("/market/inbox/unread")).payload.unread, 0);
  const asked = await shopper.request(`/market/orders/${mine}/return`, { method: "POST", body: { reasonCode: "damaged" } });
  assert.equal(asked.status, 201, JSON.stringify(asked.payload));
  const decision = await merchant.request(`/merchant/stores/${A.slug}/returns/${asked.payload.returnRequest.id}/decision`, { method: "POST", body: { approve: false, note: "المنتج سليم في الصور" } });
  assert.equal(decision.status, 200, JSON.stringify(decision.payload));
  inbox = (await shopper.request("/market/inbox")).payload;
  assert.deepEqual([inbox.items[0].title, inbox.items[0].read, inbox.items[0].kind], ["رفض المتجر طلب الإرجاع", false, "return"]);
  assert.match(inbox.items[0].body, /المنتج سليم/);
  assert.equal((await shopper.request("/market/inbox/unread")).payload.unread, 1, "a later notice is unread again");
  const stranger = await signIn(`+96479${digits}8`.slice(0, 14));
  assert.deepEqual((await stranger.shopper.request("/market/inbox")).payload.items, [], "another shopper sees none of it");
  assert.deepEqual((await shopper.request("/market/me/purchased-from")).payload.stores.map((card) => card.slug), [A.slug], "«اشتريت منها»");
  summary.inbox = true;

  // ── 3. help ──────────────────────────────────────────────────────────────
  const help = (await client().request("/market/help")).payload;
  assert.ok(help.sections.length >= 5 && help.quick.length >= 3, "seeded sections and quick answers");
  assert.ok((await client().request(`/market/help?q=${encodeURIComponent("رمز الاستلام")}`)).payload.results.some((row) => row.question === "ما هو رمز الاستلام؟"));
  assert.ok((await client().request(`/market/help?q=${encodeURIComponent("الغاء")}`)).payload.results.some((row) => /إلغاء/.test(row.question)), "normalized: الغاء finds إلغاء");
  assert.deepEqual((await client().request(`/market/help?q=${encodeURIComponent("رمز زرافة")}`)).payload.results, [], "every word must match");
  assert.ok([401, 403].includes((await merchant.request("/platform/market/help/sections", { method: "POST", body: { slug: "x", title: "x" } })).status), "a merchant cannot edit help");
  const section = await owner.request("/platform/market/help/sections", { method: "POST", body: { slug: `${testId}-s`, title: `قسم ${testId}`, position: 99 } });
  assert.equal(section.status, 201, JSON.stringify(section.payload));
  created.sections.push(section.payload.section.id);
  assert.equal((await owner.request("/platform/market/help/sections", { method: "POST", body: { slug: `${testId}-s`, title: "مكرّر" } })).status, 409);
  const visible = await owner.request("/platform/market/help/articles", { method: "POST", body: { sectionId: section.payload.section.id, question: `سؤال ${testId} الظاهر؟`, answer: "جواب واضح.", isQuick: true } });
  assert.equal(visible.status, 201);
  await owner.request("/platform/market/help/articles", { method: "POST", body: { sectionId: section.payload.section.id, question: `سؤال ${testId} المخفي؟`, answer: "مسودّة.", isPublished: false } });
  const after = (await client().request("/market/help")).payload;
  const mineSection = after.sections.find((row) => row.slug === `${testId}-s`);
  assert.deepEqual(mineSection.articles.map((row) => row.question), [`سؤال ${testId} الظاهر؟`], "the draft stays hidden");
  assert.ok(after.quick.some((row) => row.id === visible.payload.article.id));
  assert.equal((await owner.request(`/platform/market/help/sections/${section.payload.section.id}`, { method: "DELETE" })).status, 409, "not while it has answers");
  assert.equal((await owner.request("/platform/market/help/contacts", { method: "PUT", body: { whatsapp: "07701234567", phone: null, email: "help@codiq.test", hours: "يومياً ٩ص – ٩م" } })).payload.contacts.whatsapp, "+9647701234567");
  assert.equal((await client().request("/market/help")).payload.contacts.hours, "يومياً ٩ص – ٩م");
  summary.help = true;

  // ── 4. contact ───────────────────────────────────────────────────────────
  await prisma.storefrontRateLimit.deleteMany({ where: { scope: "market_contact_ip" } });
  const visitor = client();
  assert.equal((await visitor.request("/market/contact", { method: "POST", body: { kind: "problem", name: "زائر", phone: "123", body: "مشكلة في الدخول إلى الحساب" } })).status, 422);
  assert.equal((await visitor.request("/market/contact", { method: "POST", body: { kind: "problem", name: "زائر", phone: "07801234567", body: "قصير" } })).status, 422);
  const wrote = await visitor.request("/market/contact", { method: "POST", body: { kind: "suggestion", name: `زائر ${testId}`, phone: "07801234567", body: "أقترح إضافة فلتر حسب اللون." } });
  assert.equal(wrote.status, 201, JSON.stringify(wrote.payload));
  const queue = (await owner.request("/platform/market/contact-messages?status=new")).payload;
  const row = queue.messages.find((message) => message.id === wrote.payload.message.id);
  assert.deepEqual([row.phone, row.kind], ["+9647801234567", "suggestion"]);
  assert.equal((await owner.request(`/platform/market/contact-messages/${row.id}/handled`, { method: "POST", body: { note: "أُرسل للفريق" } })).status, 200);
  assert.equal((await owner.request(`/platform/market/contact-messages/${row.id}/handled`, { method: "POST", body: {} })).status, 409);
  for (let i = 0; i < 4; i += 1) await visitor.request("/market/contact", { method: "POST", body: { kind: "question", name: "زائر", phone: "07801234567", body: "سؤال رقم كذا عن التوصيل" } });
  assert.equal((await visitor.request("/market/contact", { method: "POST", body: { kind: "question", name: "زائر", phone: "07801234567", body: "سؤال رقم كذا عن التوصيل" } })).status, 429, "five an hour per address");
  await prisma.storefrontRateLimit.deleteMany({ where: { scope: "market_contact_ip" } });
  summary.contact = true;

  // ── 5. feedback ──────────────────────────────────────────────────────────
  await prisma.marketAppFeedback.deleteMany({});
  assert.equal((await client().request("/market/feedback", { method: "POST", body: { stars: 5 } })).status, 401);
  assert.equal((await shopper.request("/market/feedback", { method: "POST", body: { stars: 4, liked: ["variety", "delivery"], note: "جميل" } })).status, 201);
  assert.equal((await shopper.request("/market/feedback", { method: "POST", body: { stars: 5 } })).payload.error.code, "FEEDBACK_TOO_SOON");
  await stranger.shopper.request("/market/feedback", { method: "POST", body: { stars: 2 } });
  const report = (await owner.request("/platform/market/feedback")).payload;
  assert.deepEqual([report.average, report.count, report.distribution.find((d) => d.stars === 4).count], [3, 2, 1]);
  assert.ok(report.feedback.some((entry) => entry.likedLabels.includes("سرعة التوصيل")));
  summary.feedback = true;

  console.log(JSON.stringify({ suite: "market-help", ok: true, summary }, null, 2));
} finally {
  setOtpProviderForTests(null);
  await prisma.helpArticle.deleteMany({ where: { sectionId: { in: created.sections } } }).catch(() => undefined);
  await prisma.helpSection.deleteMany({ where: { id: { in: created.sections } } }).catch(() => undefined);
  await prisma.store.updateMany({ where: { id: { in: created.stores } }, data: { marketStatus: "unlisted", marketStatusAt: new Date() } }).catch(() => undefined);
  server.close();
  await prisma.$disconnect();
}
