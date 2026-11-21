/**
 * codiq CD-2 «تقييمات ورغبات» — reviews, wishlist, back-in-stock —
 * and CD-4 «يُشترى معه عادة», which shares this suite's store and baskets.
 *
 * A rating is a claim the platform makes to a stranger about a shop it does not
 * own, so the tests are about the things that make that claim worth anything:
 *
 *   1. NO PURCHASE, NO REVIEW — and "purchase" means a COMPLETED order of this
 *      customer, in this store, containing this product. A pending order, a
 *      cancelled one, another customer's order and another store's order are
 *      each refused separately, because each is a different way to get it wrong;
 *   2. THE BADGE IS THE COLUMN — every stored review names the order that
 *      entitled it, and that order really contains the product. There is no flag
 *      to set, so there is no way to grant the badge wrongly;
 *   3. ONE REVIEW PER CUSTOMER PER PRODUCT, and a second submission edits the
 *      first rather than stacking;
 *   4. HIDING TAKES THE WORDS, NEVER THE SCORE — the load-bearing test of the
 *      whole feature. After a merchant hides a one-star review the average is
 *      unchanged, the count is unchanged, the storefront says one is hidden, and
 *      the audit log names who hid it and why;
 *   5. …and a merchant cannot reach another store's reviews, nor can a customer
 *      hide anything, nor can the review's own author un-hide it by editing;
 *   6. WISHLIST is variant-level, deduplicated, bounded, and cross-store blind;
 *   7. BACK-IN-STOCK pages once per ASK: the scanner enqueues, retires the flag
 *      in the same transaction, and a re-ask produces a second alert where a
 *      variant+customer key would have silenced him forever.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { Client } from "pg";

const testId = `cd2-${Date.now()}`;
const testPhone = `+9647${String(Date.now()).slice(-9)}`;
process.env.SESSION_JWT_SECRET =
  process.env.SESSION_JWT_SECRET ?? "cd2-test-secret-only-not-for-production";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { scanRestocks } = await import("../src/notifications/restock-scanner.ts");
const { WISHLIST_LIMIT } = await import("../src/services/wishlist.service.ts");

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
  const merchantA = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    phone: testPhone,
    email: `${testId}.a@codiq.test`,
    password: "cd2-merchant-pass",
    businessName: "تجارة ألف",
  });
  assert.equal(merchantA.status, 201, JSON.stringify(merchantA.payload));
  const merchantB = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    phone: `+9647${String(Date.now() + 1).slice(-9)}`,
    email: `${testId}.b@codiq.test`,
    password: "cd2-merchant-pass",
    businessName: "تجارة باء",
  });
  assert.equal(merchantB.status, 201, JSON.stringify(merchantB.payload));

  const storeA = await prisma.store.create({
    data: {
      merchantId: merchantA.payload.account.id,
      name: "متجر ألف",
      slug: `${testId}-a`,
      defaultSubdomain: `${testId}-a`,
    },
  });
  const storeB = await prisma.store.create({
    data: {
      merchantId: merchantB.payload.account.id,
      name: "متجر باء",
      slug: `${testId}-b`,
      defaultSubdomain: `${testId}-b`,
    },
  });
  const tokenA = (
    await request("/auth/merchant/login", {
      method: "POST",
      body: { identifier: `${testId}.a@codiq.test`, password: "cd2-merchant-pass" },
    })
  ).payload.accessToken;
  const tokenB = (
    await request("/auth/merchant/login", {
      method: "POST",
      body: { identifier: `${testId}.b@codiq.test`, password: "cd2-merchant-pass" },
    })
  ).payload.accessToken;

  async function makeProduct(store, sku, name, stock = 5) {
    const product = await prisma.product.create({
      data: { storeId: store.id, sku, name, priceIqd: 12000, isActive: true },
    });
    const variant = await prisma.productVariant.update({
      where: {
        id: (
          await prisma.productVariant.findFirstOrThrow({
            where: { productId: product.id, isDefault: true },
          })
        ).id,
      },
      data: { sku: `${sku}-D`, stockQuantity: stock, priceIqd: 12000 },
    });
    return { product, variant };
  }
  const shirt = await makeProduct(storeA, `${testId}-SHIRT`, "قميص");
  const shoes = await makeProduct(storeA, `${testId}-SHOES`, "حذاء");
  const foreign = await makeProduct(storeB, `${testId}-B-ITEM`, "سلعة باء");

  // A storefront customer is identified by PHONE; the email is optional and is
  // what the back-in-stock alert needs, which is why the "no email" case below
  // is a real scenario rather than a contrived one.
  let shopperSeq = 0;
  async function makeCustomer(store, tag) {
    shopperSeq += 1;
    const email = `${testId}.${tag}@codiq.test`;
    const phone = `+9647${String(Date.now() + shopperSeq * 7).slice(-9)}`;
    const created = await request(`/store/${store.slug}/account/register`, {
      method: "POST",
      body: { phone, email, password: "Cd2ShopperPass2026!", fullName: `زبون ${tag} الكامل` },
    });
    assert.equal(created.status, 201, JSON.stringify(created.payload));
    const customer = await prisma.customer.findFirstOrThrow({
      where: { storeId: store.id, email },
      select: { id: true },
    });
    return { id: customer.id, email, token: created.payload.accessToken };
  }
  const buyer = await makeCustomer(storeA, "buyer");
  const lurker = await makeCustomer(storeA, "lurker");

  let orderSeq = 0;
  async function makeOrder(store, customerId, productId, variantId, status) {
    orderSeq += 1;
    return prisma.storeOrder.create({
      data: {
        storeId: store.id,
        customerId,
        orderNumber: `CD2-${String(orderSeq).padStart(4, "0")}`,
        status,
        customerName: "زبون",
        customerEmail: `${testId}.buyer@codiq.test`,
        recipientPhone: "+9647100000003",
        shippingGovernorate: "بغداد",
        shippingAddressLine1: "شارع 1",
        subtotalIqd: 12000,
        deliveryFeeIqd: 0,
        totalIqd: 12000,
        items: {
          create: [
            {
              productId,
              variantId,
              sku: "X",
              productName: "منتج",
              quantity: 1,
              unitPriceIqd: 12000,
              lineTotalIqd: 12000,
            },
          ],
        },
      },
    });
  }

  const reviewPath = (store, productId) =>
    `/store/${store.slug}/products/${productId}/reviews/mine`;
  const publicPath = (store, productId) => `/store/${store.slug}/products/${productId}/reviews`;

  // ============================================================
  // 1. No purchase, no review — four distinct ways to lack one.
  // ============================================================
  const noOrder = await request(reviewPath(storeA, shirt.product.id), {
    method: "PUT",
    token: buyer.token,
    body: { rating: 5, body: "ممتاز" },
  });
  assert.equal(noOrder.status, 403, JSON.stringify(noOrder.payload));
  assert.equal(
    noOrder.payload.error.code,
    "REVIEW_REQUIRES_PURCHASE",
    "CD-2: a shopper who never bought it cannot rate it"
  );

  // A pending order is not a purchase: he has not received the thing yet.
  await makeOrder(storeA, buyer.id, shirt.product.id, shirt.variant.id, "new");
  assert.equal(
    (
      await request(reviewPath(storeA, shirt.product.id), {
        method: "PUT",
        token: buyer.token,
        body: { rating: 5 },
      })
    ).payload.error.code,
    "REVIEW_REQUIRES_PURCHASE",
    "CD-2: an order still in flight is not a purchase"
  );

  // A cancelled order is not a purchase either.
  await makeOrder(storeA, buyer.id, shirt.product.id, shirt.variant.id, "cancelled");
  assert.equal(
    (
      await request(reviewPath(storeA, shirt.product.id), {
        method: "PUT",
        token: buyer.token,
        body: { rating: 5 },
      })
    ).payload.error.code,
    "REVIEW_REQUIRES_PURCHASE"
  );

  // A completed order for a DIFFERENT product does not entitle a review of this one.
  await makeOrder(storeA, buyer.id, shoes.product.id, shoes.variant.id, "completed");
  assert.equal(
    (
      await request(reviewPath(storeA, shirt.product.id), {
        method: "PUT",
        token: buyer.token,
        body: { rating: 5 },
      })
    ).payload.error.code,
    "REVIEW_REQUIRES_PURCHASE",
    "CD-2: buying shoes does not entitle a review of the shirt"
  );
  assert.equal(
    await prisma.productReview.count({ where: { storeId: storeA.id } }),
    0,
    "CD-2: every refusal wrote nothing"
  );

  // ============================================================
  // 2. The badge is the column.
  // ============================================================
  const entitling = await makeOrder(
    storeA,
    buyer.id,
    shirt.product.id,
    shirt.variant.id,
    "completed"
  );
  const written = await request(reviewPath(storeA, shirt.product.id), {
    method: "PUT",
    token: buyer.token,
    body: { rating: 5, body: "قماش ممتاز ووصل بسرعة" },
  });
  assert.equal(written.status, 200, JSON.stringify(written.payload));
  const storedReview = await prisma.productReview.findFirstOrThrow({
    where: { storeId: storeA.id, productId: shirt.product.id },
  });
  assert.equal(
    storedReview.orderId,
    entitling.id,
    "CD-2: the review names the order that entitled it"
  );
  // …and that order really contains the product. Checked independently, because
  // "the column is set" and "the column is right" are different claims.
  assert.equal(
    await prisma.orderItem.count({
      where: { orderId: storedReview.orderId, productId: shirt.product.id },
    }),
    1,
    "CD-2: …and that order really contained this product"
  );
  assert.equal(storedReview.customerId, buyer.id);

  // ============================================================
  // 3. One per customer per product; a resubmission edits.
  // ============================================================
  const edited = await request(reviewPath(storeA, shirt.product.id), {
    method: "PUT",
    token: buyer.token,
    body: { rating: 4, body: "بعد أسبوع: جيد" },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.payload));
  assert.equal(
    await prisma.productReview.count({
      where: { storeId: storeA.id, productId: shirt.product.id, withdrawnAt: null },
    }),
    1,
    "CD-2: a second submission edits, it does not stack"
  );
  assert.equal(
    (await prisma.productReview.findFirstOrThrow({ where: { id: storedReview.id } })).rating,
    4
  );

  // Input the shopper can get wrong. Phase 19-ج: ONE code for every shape
  // failure, plus the FIELD that failed — which is what a form needs to point at
  // the box he must fix, and what a translator needs in order to enumerate them.
  for (const bad of [{ rating: 6 }, { rating: 0 }, { rating: 3.5 }]) {
    const refused = await request(reviewPath(storeA, shirt.product.id), {
      method: "PUT",
      token: buyer.token,
      body: bad,
    });
    assert.equal(refused.status, 422, JSON.stringify(refused.payload));
    assert.equal(
      refused.payload.error.code,
      "VALIDATION_FAILED",
      `CD-2/19-ج: ${JSON.stringify(bad)}`
    );
    assert.equal(
      refused.payload.error.fields[0].path,
      "rating",
      "19-ج: the refusal names the field, not just the request"
    );
  }
  const longBody = await request(reviewPath(storeA, shirt.product.id), {
    method: "PUT",
    token: buyer.token,
    body: { rating: 3, body: "ن".repeat(2001) },
  });
  assert.equal(longBody.payload.error.code, "VALIDATION_FAILED");
  assert.equal(longBody.payload.error.fields[0].path, "body");
  assert.ok(
    longBody.payload.error.fields[0].code,
    "19-ج: every field carries a code from zod's closed set, so it can be translated"
  );
  assert.equal(
    (await prisma.productReview.findFirstOrThrow({ where: { id: storedReview.id } })).rating,
    4,
    "CD-2: refused input left the review untouched"
  );

  // ============================================================
  // 4. Hiding takes the words, never the score.
  // ============================================================
  // A second buyer, so the average has something to move.
  const critic = await makeCustomer(storeA, "critic");
  await makeOrder(storeA, critic.id, shirt.product.id, shirt.variant.id, "completed");
  await request(reviewPath(storeA, shirt.product.id), {
    method: "PUT",
    token: critic.token,
    body: { rating: 1, body: "لم يعجبني إطلاقاً" },
  });

  const before = (await request(publicPath(storeA, shirt.product.id))).payload;
  assert.equal(before.summary.count, 2);
  assert.equal(before.summary.average, 2.5, "CD-2: 4 and 1 average to 2.5");
  assert.equal(before.summary.hiddenCount, 0);

  const oneStar = await prisma.productReview.findFirstOrThrow({
    where: { storeId: storeA.id, rating: 1 },
  });
  const noReason = await request(`/merchant/stores/${storeA.slug}/reviews/${oneStar.id}/hidden`, {
    method: "PUT",
    token: tokenA,
    body: { hidden: true },
  });
  assert.equal(
    noReason.payload.error.code,
    "VALIDATION_FAILED",
    "CD-2: hiding someone's words requires saying why"
  );
  assert.equal(
    noReason.payload.error.fields[0].path,
    "reason",
    "19-ج: …and the refusal points at the box he has to fill"
  );
  assert.equal(
    (await prisma.productReview.findFirstOrThrow({ where: { id: oneStar.id } })).hiddenAt,
    null,
    "CD-2: the refused hide changed nothing"
  );

  const hidden = await request(`/merchant/stores/${storeA.slug}/reviews/${oneStar.id}/hidden`, {
    method: "PUT",
    token: tokenA,
    body: { hidden: true, reason: "لغة مسيئة" },
  });
  assert.equal(hidden.status, 200, JSON.stringify(hidden.payload));

  const after = (await request(publicPath(storeA, shirt.product.id))).payload;
  // THE ASSERTION THE WHOLE FEATURE RESTS ON.
  assert.equal(
    after.summary.average,
    2.5,
    "CD-2: hiding the WORDS does not move the average — otherwise a merchant edits his own rating"
  );
  assert.equal(after.summary.count, 2, "CD-2: …nor the count");
  assert.equal(
    after.summary.hiddenCount,
    1,
    "CD-2: …and the storefront says one is hidden rather than pretending none is"
  );
  assert.deepEqual(
    after.summary.distribution,
    { 1: 1, 2: 0, 3: 0, 4: 1, 5: 0 },
    "CD-2: the one-star is still in the distribution a shopper can read"
  );
  const hiddenRow = after.reviews.find((review) => review.id === oneStar.id);
  assert.ok(
    hiddenRow,
    "CD-2: the row stays in the list — a vanished row makes the count disagree with what is on screen"
  );
  assert.equal(hiddenRow.body, null, "CD-2: …without its text");
  assert.equal(hiddenRow.hidden, true);
  assert.equal(hiddenRow.rating, 1, "CD-2: …and still showing its score");

  // The trail is what keeps the power honest.
  const audit = await prisma.storeAuditEvent.findMany({
    where: { storeId: storeA.id, entityType: "product_review" },
    orderBy: { createdAt: "asc" },
  });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "review.hidden");
  assert.equal(audit[0].actorKind, "merchant");
  assert.equal(
    audit[0].metadata.reason,
    "لغة مسيئة",
    "CD-2: the reason is recorded where the platform owner can read it"
  );
  assert.equal(
    audit[0].entitySecondary,
    "1★",
    "CD-2: …beside the score that was hidden, so a pattern is legible"
  );

  // The author cannot un-hide by editing.
  await request(reviewPath(storeA, shirt.product.id), {
    method: "PUT",
    token: critic.token,
    body: { rating: 1, body: "أعدت الكتابة" },
  });
  assert.ok(
    (await prisma.productReview.findFirstOrThrow({ where: { id: oneStar.id } })).hiddenAt,
    "CD-2: rewriting a hidden review does not un-hide it"
  );

  const unhidden = await request(`/merchant/stores/${storeA.slug}/reviews/${oneStar.id}/hidden`, {
    method: "PUT",
    token: tokenA,
    body: { hidden: false },
  });
  assert.equal(unhidden.status, 200);
  assert.equal(
    (await request(publicPath(storeA, shirt.product.id))).payload.summary.hiddenCount,
    0
  );
  assert.equal(
    await prisma.storeAuditEvent.count({
      where: { storeId: storeA.id, action: "review.unhidden" },
    }),
    1,
    "CD-2: restoring is recorded too"
  );

  // ============================================================
  // 5. Boundaries.
  // ============================================================
  assert.equal(
    (
      await request(`/merchant/stores/${storeB.slug}/reviews/${oneStar.id}/hidden`, {
        method: "PUT",
        token: tokenB,
        body: { hidden: true, reason: "تسلل" },
      })
    ).status,
    404,
    "CD-2: another store's merchant cannot reach this review"
  );
  assert.equal(
    (
      await request(`/merchant/stores/${storeA.slug}/reviews/${oneStar.id}/hidden`, {
        method: "PUT",
        token: tokenB,
        body: { hidden: true, reason: "تسلل" },
      })
    ).status,
    403,
    "CD-2: …nor borrow this store's path"
  );
  assert.equal(
    (await request(`/merchant/stores/${storeA.slug}/reviews`, { token: buyer.token })).status,
    403,
    "CD-2: a customer session is not a merchant session"
  );
  assert.equal(
    (await request(reviewPath(storeA, shirt.product.id), { method: "PUT", body: { rating: 5 } }))
      .status,
    401,
    "CD-2: writing needs a session"
  );
  // A shopper of store A cannot review store B's product even holding a valid
  // session: it is refused at the identity boundary (403), not as a missing
  // session (401). The distinction matters — the token IS real, it is simply not
  // a token for this shop.
  const crossStore = await request(reviewPath(storeB, foreign.product.id), {
    method: "PUT",
    token: buyer.token,
    body: { rating: 5 },
  });
  assert.equal(
    crossStore.status,
    403,
    `CD-2: a customer session is scoped to its own store — ${JSON.stringify(crossStore.payload)}`
  );
  assert.equal(
    await prisma.productReview.count({ where: { storeId: storeB.id } }),
    0,
    "CD-2: …and nothing was written into the other store"
  );
  // Reading is public — a shopper deciding whether to buy has no account yet.
  assert.equal(
    (await request(publicPath(storeA, shirt.product.id))).status,
    200,
    "CD-2: reading reviews needs no account"
  );

  // A withdrawn review frees the slot without leaving a ghost.
  const own = await prisma.productReview.findFirstOrThrow({
    where: { storeId: storeA.id, customerId: buyer.id },
  });
  // ق-175: the list tells the author which row is his — and tells nobody else.
  // Reading stays public: the flag rides a session when there is one and is
  // simply false without it. This is what lets a screen draw «سحب مراجعتي» on
  // exactly one line; before it, the DELETE below had no caller at all.
  const asAuthor = await request(publicPath(storeA, shirt.product.id), { token: buyer.token });
  assert.equal(
    asAuthor.payload.reviews.find((row) => row.id === own.id)?.mine,
    true,
    "ق-175: the author sees his own row as mine"
  );
  assert.equal(
    asAuthor.payload.reviews.filter((row) => row.mine).length,
    1,
    "ق-175: …and only that row"
  );
  const asCritic = await request(publicPath(storeA, shirt.product.id), { token: critic.token });
  assert.equal(
    asCritic.payload.reviews.find((row) => row.id === own.id)?.mine,
    false,
    "ق-175: another shopper does not"
  );
  const asGuest = await request(publicPath(storeA, shirt.product.id));
  assert.ok(
    asGuest.payload.reviews.every((row) => row.mine === false),
    "ق-175: a guest sees no mine at all"
  );
  assert.ok(
    asGuest.payload.reviews.every((row) => !("customerId" in row)),
    "ق-175: and the author id itself never leaves the server"
  );
  assert.equal(
    (
      await request(`/store/${storeA.slug}/reviews/${own.id}`, {
        method: "DELETE",
        token: critic.token,
      })
    ).status,
    404,
    "CD-2: one shopper cannot withdraw another's review"
  );
  assert.equal(
    (
      await request(`/store/${storeA.slug}/reviews/${own.id}`, {
        method: "DELETE",
        token: buyer.token,
      })
    ).status,
    204
  );
  assert.equal(
    (await request(publicPath(storeA, shirt.product.id))).payload.summary.count,
    1,
    "CD-2: a withdrawn review leaves the average"
  );
  const rewritten = await request(reviewPath(storeA, shirt.product.id), {
    method: "PUT",
    token: buyer.token,
    body: { rating: 5, body: "عدت ورأيي تغيّر" },
  });
  assert.equal(
    rewritten.status,
    200,
    "CD-2: …and he may write again, because the unique index is partial"
  );

  // ============================================================
  // 6. Wishlist.
  // ============================================================
  const wishPath = `/store/${storeA.slug}/account/wishlist`;
  const added = await request(wishPath, {
    method: "POST",
    token: buyer.token,
    body: { variantId: shoes.variant.id, notifyOnRestock: true },
  });
  assert.equal(added.status, 201, JSON.stringify(added.payload));
  const again = await request(wishPath, {
    method: "POST",
    token: buyer.token,
    body: { variantId: shoes.variant.id },
  });
  assert.equal(again.status, 201, "CD-2: adding twice is a double tap, not an error");
  assert.equal(
    await prisma.wishlistItem.count({ where: { storeId: storeA.id, customerId: buyer.id } }),
    1,
    "CD-2: …and stores one row"
  );
  assert.equal((await request(wishPath, { token: buyer.token })).payload.items.length, 1);
  // Another store's variant is a 404, never a 403: a 403 would answer «does
  // store B sell this?» for anyone holding any customer account.
  assert.equal(
    (
      await request(wishPath, {
        method: "POST",
        token: buyer.token,
        body: { variantId: foreign.variant.id },
      })
    ).status,
    404,
    "CD-2: another store's variant is indistinguishable from one that does not exist"
  );
  // Phase 19-ج: one code for every shape failure, and it names the field.
  const noVariant = await request(wishPath, { method: "POST", token: buyer.token, body: {} });
  assert.equal(noVariant.status, 422, JSON.stringify(noVariant.payload));
  assert.equal(noVariant.payload.error.code, "VALIDATION_FAILED");
  assert.equal(noVariant.payload.error.fields[0].path, "variantId");
  // …and a variantId that is not a uuid is refused HERE rather than reaching
  // Postgres, where a malformed uuid used to surface as a bare 500.
  const malformed = await request(wishPath, {
    method: "POST",
    token: buyer.token,
    body: { variantId: "not-a-uuid" },
  });
  assert.equal(malformed.status, 422, JSON.stringify(malformed.payload));
  assert.equal(malformed.payload.error.fields[0].path, "variantId");
  assert.equal((await request(wishPath, { method: "DELETE" })).status, 404);
  assert.equal(
    (await request(`${wishPath}/${shoes.variant.id}`, { method: "DELETE", token: lurker.token }))
      .status,
    404,
    "CD-2: removing something not on YOUR list is a 404"
  );

  // ============================================================
  // 7. Back in stock: once per ask, and a re-ask works.
  // ============================================================
  await prisma.notificationOutbox.deleteMany({
    where: { storeId: storeA.id, eventType: "stock.back_in_stock" },
  });
  await prisma.productVariant.update({
    where: { id: shoes.variant.id },
    data: { stockQuantity: 0 },
  });
  await prisma.wishlistItem.updateMany({
    where: { storeId: storeA.id, customerId: buyer.id, variantId: shoes.variant.id },
    data: { notifyOnRestock: true },
  });

  const whileEmpty = await scanRestocks();
  assert.equal(whileEmpty.enqueued, 0, "CD-2: nothing is sent while the shelf is empty");

  await prisma.productVariant.update({
    where: { id: shoes.variant.id },
    data: { stockQuantity: 7 },
  });

  // ق-208: this store never switched messaging on — the default for every store
  // on the platform. The scanner used to send marketing in its name anyway, and
  // because the request flag is retired in the same transaction as the enqueue,
  // a row the worker then refused (messaging off, cap 0) burned the shopper's
  // «نبّهني» with nothing ever arriving. Now the store's own switch gates the
  // scan, and his request stands until the store can honour it.
  const gated = await scanRestocks();
  assert.equal(
    gated.enqueued,
    0,
    "ق-208: a store that never switched messaging on sends no marketing in its name"
  );
  assert.equal(
    gated.candidates,
    0,
    "ق-208: …and the row is excluded by the QUERY, not fetched and dropped"
  );
  assert.equal(
    (
      await prisma.wishlistItem.findFirstOrThrow({
        where: { storeId: storeA.id, customerId: buyer.id, variantId: shoes.variant.id },
      })
    ).notifyOnRestock,
    true,
    "ق-208: the shopper's request is left standing, not burned"
  );
  await prisma.notificationSettings.upsert({
    where: { storeId: storeA.id },
    update: { isEnabled: true },
    create: { storeId: storeA.id, isEnabled: true },
  });

  const restocked = await scanRestocks();
  assert.equal(restocked.enqueued, 1, JSON.stringify(restocked));
  const alert = await prisma.notificationOutbox.findFirstOrThrow({
    where: { storeId: storeA.id, eventType: "stock.back_in_stock" },
  });
  assert.equal(alert.recipientKind, "customer");
  assert.equal(alert.recipient, buyer.email);

  // The request is retired in the same transaction, so the set DRAINS.
  assert.equal(
    (
      await prisma.wishlistItem.findFirstOrThrow({
        where: { storeId: storeA.id, customerId: buyer.id, variantId: shoes.variant.id },
      })
    ).notifyOnRestock,
    false,
    "CD-2: the request that asked for the alert is retired with it"
  );
  const secondPass = await scanRestocks();
  assert.equal(secondPass.enqueued, 0, "CD-2: a second pass sends nothing — he was already told");
  assert.equal(
    await prisma.notificationOutbox.count({
      where: { storeId: storeA.id, eventType: "stock.back_in_stock" },
    }),
    1
  );

  // And he may ask AGAIN. This is what keying on the wishlist row buys: a
  // variant+customer key would have silenced him permanently on the first alert.
  await request(`${wishPath}/${shoes.variant.id}`, { method: "DELETE", token: buyer.token });
  await request(wishPath, {
    method: "POST",
    token: buyer.token,
    body: { variantId: shoes.variant.id, notifyOnRestock: true },
  });
  const reAsked = await scanRestocks();
  assert.equal(reAsked.enqueued, 1, "CD-2: a fresh request earns a fresh alert");
  assert.equal(
    await prisma.notificationOutbox.count({
      where: { storeId: storeA.id, eventType: "stock.back_in_stock" },
    }),
    2
  );

  // A customer with no email has nowhere to be written to. He is excluded by the
  // QUERY, not fetched and discarded — this candidate set only drains when a
  // message is sent, so a row that can never be sent would be re-read on every
  // pass for ever. Asserted on the outcome (nothing enqueued, nothing
  // considered) rather than on a counter, because a counter of skips is exactly
  // the accumulation this design removes.
  await prisma.customer.update({ where: { id: lurker.id }, data: { email: null } });
  await prisma.wishlistItem.create({
    data: {
      storeId: storeA.id,
      customerId: lurker.id,
      productId: shoes.product.id,
      variantId: shoes.variant.id,
      notifyOnRestock: true,
    },
  });
  const outboxBefore = await prisma.notificationOutbox.count({
    where: { storeId: storeA.id, eventType: "stock.back_in_stock" },
  });
  const noEmail = await scanRestocks();
  assert.equal(noEmail.enqueued, 0, "CD-2: a phone-only customer produces no message");
  assert.equal(
    noEmail.candidates,
    0,
    "CD-2: …and is never even read as a candidate, so his row cannot pile up scan after scan"
  );
  assert.equal(
    await prisma.notificationOutbox.count({
      where: { storeId: storeA.id, eventType: "stock.back_in_stock" },
    }),
    outboxBefore
  );
  // His request stands: give him an address and the next restock reaches him.
  assert.equal(
    (
      await prisma.wishlistItem.findFirstOrThrow({
        where: { storeId: storeA.id, customerId: lurker.id },
      })
    ).notifyOnRestock,
    true,
    "CD-2: the request is left standing, not silently retired"
  );

  summary.cd2 = {
    purchaseGateRefusals: ["no order", "pending", "cancelled", "different product"],
    badgeIsColumn: true,
    averageBeforeHide: before.summary.average,
    averageAfterHide: after.summary.average,
    hiddenCount: after.summary.hiddenCount,
    auditActions: (
      await prisma.storeAuditEvent.findMany({
        where: { storeId: storeA.id, entityType: "product_review" },
        select: { action: true },
      })
    ).map((row) => row.action),
    wishlistLimit: WISHLIST_LIMIT,
    restockAlerts: 2,
  };

  // ============================================================
  // 8. CD-4 «يُشترى معه عادة» — recommendations from real baskets.
  //
  // The word «عادة» is the whole claim. One shopper who once bought two things
  // together is a coincidence; presenting it as a habit teaches shoppers that
  // the strip is noise, after which the genuine pairings are worth nothing
  // either. So the tests are about the threshold, and about what must never
  // appear in the list at all.
  // ============================================================
  const recPath = (store, productId) =>
    `/store/${store.slug}/products/${productId}/recommendations`;

  // Fixtures: a hero product, a partner bought with it repeatedly, a partner
  // bought with it once, and two partners that exist but must not be offered.
  const hero = await makeProduct(storeA, `${testId}-HERO`, "المنتج الأساسي");
  const habit = await makeProduct(storeA, `${testId}-HABIT`, "الرفيق المعتاد");
  const once = await makeProduct(storeA, `${testId}-ONCE`, "صدفة واحدة");
  const soldOut = await makeProduct(storeA, `${testId}-SOLDOUT`, "نفد تماماً", 0);
  const switchedOff = await makeProduct(storeA, `${testId}-OFF`, "موقوف");
  await prisma.product.update({ where: { id: switchedOff.product.id }, data: { isActive: false } });

  let basketSeq = 0;
  async function basket(status, partners) {
    basketSeq += 1;
    return prisma.storeOrder.create({
      data: {
        storeId: storeA.id,
        customerId: buyer.id,
        orderNumber: `CD4-${String(basketSeq).padStart(4, "0")}`,
        status,
        customerName: "زبون",
        customerEmail: `${testId}.buyer@codiq.test`,
        recipientPhone: "+9647100000005",
        shippingGovernorate: "بغداد",
        shippingAddressLine1: "شارع 1",
        subtotalIqd: 12000,
        deliveryFeeIqd: 0,
        totalIqd: 12000,
        items: {
          create: [hero, ...partners].map((entry) => ({
            productId: entry.product.id,
            variantId: entry.variant.id,
            sku: entry.variant.sku,
            productName: entry.product.name,
            quantity: 1,
            unitPriceIqd: 12000,
            lineTotalIqd: 12000,
          })),
        },
      },
    });
  }

  // Three real baskets pair hero with `habit`; each also carries an unbuyable
  // partner, so the exclusions below are tested against a pairing that WOULD
  // otherwise qualify — not against one that fails the threshold anyway.
  await basket("completed", [habit, soldOut, switchedOff]);
  await basket("completed", [habit, soldOut, switchedOff]);
  await basket("out_for_delivery", [habit, soldOut, switchedOff]);
  // One basket only for `once` — a coincidence.
  await basket("completed", [once]);

  const recommended = await request(recPath(storeA, hero.product.id));
  assert.equal(recommended.status, 200, JSON.stringify(recommended.payload));
  const names = recommended.payload.recommendations.map((row) => row.name);
  assert.deepEqual(
    names,
    ["الرفيق المعتاد"],
    `CD-4: only the pairing seen in ${recommended.payload.minOrdersTogether}+ separate orders is offered — got ${JSON.stringify(names)}`
  );
  assert.equal(
    recommended.payload.recommendations[0].ordersTogether,
    3,
    "CD-4: …and the count it rests on travels with it, so «عادة» is a claim and not a decoration"
  );
  assert.equal(
    recommended.payload.minOrdersTogether,
    3,
    "CD-4: the rule is shipped to the screen rather than hidden in the server"
  );
  // The three exclusions, each asserted by name so a regression says which broke.
  assert.ok(!names.includes("صدفة واحدة"), "CD-4: one basket is a coincidence, not a habit");
  assert.ok(
    !names.includes("نفد تماماً"),
    "CD-4: a product with nothing on the shelf is a dead end, not a recommendation"
  );
  assert.ok(!names.includes("موقوف"), "CD-4: a switched-off product is not offered");
  assert.ok(
    !names.includes("المنتج الأساسي"),
    "CD-4: a product is never recommended alongside itself"
  );

  // A cancelled basket is not evidence: nobody carried those goods home.
  const cancelledCount = (await request(recPath(storeA, once.product.id))).payload.recommendations
    .length;
  await basket("cancelled", [once]);
  await basket("cancelled", [once]);
  await basket("rejected", [once]);
  assert.equal(
    (await request(recPath(storeA, once.product.id))).payload.recommendations.length,
    cancelledCount,
    "CD-4: cancelled and rejected orders add nothing — an order refused at the door says nothing about what goes with what"
  );

  // Counted in ORDERS, not in lines: one basket carrying a partner twice is
  // still one shopper deciding once.
  const doubled = await basket("completed", [once]);
  await prisma.orderItem.create({
    data: {
      orderId: doubled.id,
      productId: once.product.id,
      variantId: once.variant.id,
      sku: once.variant.sku,
      productName: once.product.name,
      quantity: 1,
      unitPriceIqd: 12000,
      lineTotalIqd: 12000,
    },
  });
  const afterDoubling = (
    await request(recPath(storeA, hero.product.id))
  ).payload.recommendations.find((row) => row.name === "صدفة واحدة");
  assert.equal(
    afterDoubling,
    undefined,
    "CD-4: a duplicated line does not manufacture a habit — the count is DISTINCT orders"
  );

  // Tenancy: store B's catalogue can never surface in store A's strip, and a
  // product id from another store simply has no recommendations.
  const foreignRecs = await request(recPath(storeB, hero.product.id));
  assert.equal(foreignRecs.status, 200);
  assert.deepEqual(
    foreignRecs.payload.recommendations,
    [],
    "CD-4: asking store B about store A's product yields nothing, not a leak"
  );
  const allNames = recommended.payload.recommendations.map((row) => row.name);
  assert.ok(!allNames.includes("سلعة باء"), "CD-4: another store's product never appears");

  summary.recommendations = {
    minOrdersTogether: recommended.payload.minOrdersTogether,
    offered: names,
    ordersTogether: recommended.payload.recommendations[0].ordersTogether,
    excluded: [
      "single co-purchase",
      "out of stock",
      "inactive",
      "self",
      "cancelled/rejected baskets",
      "other store",
    ],
  };

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await sql.end();
  await prisma.$disconnect();
}
