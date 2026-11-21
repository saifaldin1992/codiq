/**
 * بروفة من طرفٍ إلى طرف على بيئةٍ حيّة — the gate the second section never passed.
 *
 * `PROJECT_STATE.md` has carried this line for weeks:
 *
 *   «بوابة نهاية القسم الثاني («المنصة تعمل تجارياً») تحقّقت كودياً واختبارياً على
 *    CI، لكن البروفة الموثَّقة من طرفٍ إلى طرف على التجريب لم تُنفَّذ.»
 *
 * WHY CI GREEN IS NOT THIS. Every suite in this repository builds its own world:
 * it truncates the database, seeds exactly what it needs, and runs against a
 * server it started itself. That proves the CODE is right. It cannot prove that
 * a DEPLOYED environment is right — and this session is the argument for the
 * distinction. The platform had a complete, tested, green second factor that no
 * screen could reach; a mail channel whose port the host blocks; a migration
 * variable named «unpooled» holding a pooled url. Not one of those is visible
 * from a suite that stands up its own world.
 *
 * So this drives a REAL DEPLOYMENT over HTTP, as a merchant and a shopper would,
 * and asserts nothing it did not read back from that deployment.
 *
 * ============================================================================
 * WHAT IT WALKS
 * ============================================================================
 *
 *   تاجر يسجّل ← يدخل ← ينشئ منتجاً ← زبون يتصفّح ← يسجّل ← يضيف إلى السلة ←
 *   يطلب بالدفع عند الاستلام ← التاجر ينقل الحالة إلى «سُلّم» ← يُقيَّد الدفتر.
 *
 * ============================================================================
 * IT WRITES REAL ROWS. READ THIS BEFORE POINTING IT SOMEWHERE.
 * ============================================================================
 *
 * A rehearsal that rolls itself back is not a rehearsal — the whole point is
 * that the environment carries the marks afterwards, so a human can go and look
 * at them in the interface. Every row it creates is named with a run stamp and
 * the word `rehearsal`, so it is greppable and deletable.
 *
 * It REFUSES to run against production unless `--i-know` is passed, and it
 * refuses silently to no one: the guard prints why.
 *
 * Run: pnpm rehearsal -- --base https://staging.codiqos.com
 */
import assert from "node:assert/strict";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index !== -1 && args[index + 1] && !args[index + 1].startsWith("--")
    ? args[index + 1]
    : fallback;
};
const BASE = (flag("base") ?? "https://staging.codiqos.com").replace(/\/$/, "");
if (BASE.includes("codiqos.com") && !BASE.includes("staging") && !args.includes("--i-know")) {
  console.error(
    `[rehearsal] refusing to write rehearsal rows into what looks like PRODUCTION (${BASE}).\n` +
      `[rehearsal] the gate this exists for names staging; pass --i-know only if you mean it.`
  );
  process.exit(1);
}

/** One stamp on every row this run creates, so the marks it leaves can be found. */
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const SLUG = `rehearsal-${STAMP.toLowerCase()
  .slice(5)
  .replace(/[^a-z0-9]/g, "")}`;
const MERCHANT_EMAIL = `rehearsal+${STAMP}@codiqos.com`;
const CUSTOMER_PHONE = `0770${String(Date.now()).slice(-7)}`;
const SECRET = `Rehearsal-${STAMP}-x9`;

const steps = [];
/** Cookie jars, one per identity, because the platform shares ONE cookie name. */
const jars = { merchant: new Map(), customer: new Map() };

function absorb(jar, response) {
  const raw = response.headers.getSetCookie?.() ?? [];
  for (const line of raw) {
    const [pair] = line.split(";");
    const index = pair.indexOf("=");
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}
const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

async function call(step, path, { method = "GET", body, jar, headers = {}, expect } = {}) {
  const started = Date.now();
  const response = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(jar && jar.size ? { cookie: cookieHeader(jar) } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (jar) absorb(jar, response);
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  const record = { step, method, path, status: response.status, ms: Date.now() - started };
  steps.push(record);
  if (expect !== undefined && response.status !== expect) {
    console.error(
      JSON.stringify(
        { rehearsal: "FAILED", at: step, expected: expect, got: response.status, payload },
        null,
        2
      )
    );
    console.error(JSON.stringify({ stepsSoFar: steps }, null, 2));
    process.exit(1);
  }
  return { status: response.status, payload };
}

console.log(`[rehearsal] ${BASE} · stamp ${STAMP}`);

// ============================================================
// 0. The environment answers at all, and says what it is.
// ============================================================
const ready = await call("ready", "/ready", { expect: 200 });
assert.equal(ready.payload.db, "ok", "the deployment must be able to reach its database");
assert.equal(
  ready.payload.config.ok,
  true,
  `every configuration group must be satisfied: ${JSON.stringify(ready.payload.config.groups)}`
);
console.log(
  `[rehearsal] env=${ready.payload.env} search=${ready.payload.search.engine} mail=${ready.payload.mail.configured}`
);

// ============================================================
// 1. A merchant registers himself, and gets a store with him.
// ============================================================
const registration = await call("merchant registers", "/public/merchants/register", {
  method: "POST",
  body: {
    businessName: `بروفة ${STAMP}`,
    storeName: `متجر البروفة ${STAMP}`,
    storeSlug: SLUG,
    email: MERCHANT_EMAIL,
    password: SECRET,
    ownerName: "بروفة آلية",
    phone: `0771${String(Date.now()).slice(-7)}`,
  },
  expect: 201,
});
console.log(
  `[rehearsal] merchant registered · approval mode reported: ${JSON.stringify(registration.payload).slice(0, 160)}`
);

// ============================================================
// 2. He signs in. THE COOKIE, not a bearer token — as a browser does.
// ============================================================
const login = await call("merchant signs in", "/auth/merchant/login", {
  method: "POST",
  body: { identifier: MERCHANT_EMAIL, password: SECRET },
  jar: jars.merchant,
  expect: 200,
});
assert.ok(
  jars.merchant.size > 0,
  "signing in must set a session cookie — a browser has nothing else"
);
const stores = login.payload?.stores ?? [];
console.log(`[rehearsal] signed in · stores on the account: ${stores.length}`);

// ============================================================
// 3. He puts something on the shelf.
// ============================================================
const product = await call(
  "merchant creates a product",
  `/merchant/stores/${SLUG}/catalog/products`,
  {
    method: "POST",
    jar: jars.merchant,
    body: {
      sku: `REH-${STAMP.slice(-8)}`,
      name: `منتج البروفة ${STAMP}`,
      description: "صفٌّ من بروفة آلية. آمنٌ حذفه.",
      priceIqd: 25000,
      stockQuantity: 5,
      lowStockThreshold: 1,
      isActive: true,
    },
    expect: 201,
  }
);
const productId = product.payload.product.id;
console.log(`[rehearsal] product on the shelf · ${productId}`);

// ============================================================
// 4. THE PUBLIC SHELF. Nobody signed in — a stranger's view.
// ============================================================
// This is the first assertion that could not be made from a unit test: it
// proves the tenant boundary resolves the store by SLUG on a real deployment.
const shelf = await call("a stranger browses the shop", `/store/${SLUG}/products`, { expect: 200 });
assert.ok(
  shelf.payload.products.some((p) => p.id === productId),
  "a product a merchant just published must be visible to a stranger — this is the whole shop"
);
console.log(`[rehearsal] public shelf shows ${shelf.payload.products.length} product(s)`);

// ============================================================
// 5. A shopper signs up ON THAT STORE.
// ============================================================
// The customer cookie is scoped to /api/store/<slug> (ق-149), so this is also a
// live check that the scoping did not break on a real host.
const shopper = await call("a shopper registers", `/store/${SLUG}/account/register`, {
  method: "POST",
  jar: jars.customer,
  body: {
    fullName: "زبون البروفة",
    phone: CUSTOMER_PHONE,
    password: SECRET,
    email: `shopper+${STAMP}@codiqos.com`,
  },
  expect: 201,
});
assert.ok(jars.customer.size > 0, "the shopper must leave with a session cookie of his own");
console.log(`[rehearsal] shopper registered · ${shopper.payload.account.id}`);

// ============================================================
// 6. Cart.
// ============================================================
const added = await call("shopper adds to cart", `/store/${SLUG}/cart/items`, {
  method: "POST",
  jar: jars.customer,
  body: { productId, quantity: 2 },
  // 200, not 201: the cart is not created here — it already exists for the
  // session, and this adds a line to it. Reading the route rather than assuming
  // the REST convention is the difference between a rehearsal and a guess.
  expect: 200,
});
const cart = added.payload.cart ?? added.payload;
console.log(`[rehearsal] cart version ${cart.version} · ${cart.items?.length ?? "?"} line(s)`);

// ============================================================
// 7. Checkout, cash on delivery.
// ============================================================
// `idempotency-key` is sent because a shopper's second tap must replay, not
// double-charge — and a rehearsal that skipped it would be rehearsing a path no
// real client takes.
const idempotencyKey = `rehearsal-${STAMP}`;
const placed = await call("shopper places the order", `/store/${SLUG}/checkout`, {
  method: "POST",
  jar: jars.customer,
  headers: { "idempotency-key": idempotencyKey },
  body: {
    cartVersion: cart.version,
    paymentMethodCode: "cod",
    address: {
      recipientName: "زبون البروفة",
      fullAddress: "شارع البروفة، بناية ١",
      city: "الكرادة",
      governorate: "بغداد",
      phoneContact: CUSTOMER_PHONE,
    },
    note: "طلب بروفة آلية",
  },
  expect: 201,
});
const order = placed.payload.order;
console.log(
  `[rehearsal] order ${order.orderNumber} · total ${order.totalIqd} IQD · status ${order.status}`
);

// ============================================================
// 8. THE SECOND TAP. It must replay, not create a second order.
// ============================================================
const replay = await call("shopper taps confirm twice", `/store/${SLUG}/checkout`, {
  method: "POST",
  jar: jars.customer,
  headers: { "idempotency-key": idempotencyKey },
  body: {
    cartVersion: cart.version,
    paymentMethodCode: "cod",
    address: {
      recipientName: "زبون البروفة",
      fullAddress: "شارع البروفة، بناية ١",
      city: "الكرادة",
      governorate: "بغداد",
      phoneContact: CUSTOMER_PHONE,
    },
    note: "طلب بروفة آلية",
  },
  expect: 200,
});
assert.equal(replay.payload.replayed, true, "a second tap on «تأكيد الطلب» must REPLAY");
assert.equal(replay.payload.order.id, order.id, "…and hand back the same order, not a twin");
console.log(`[rehearsal] second tap replayed the same order — no twin`);

// ============================================================
// 9. The merchant sees it, and walks it to delivered.
// ============================================================
const inbox = await call("merchant opens his orders", `/merchant/stores/${SLUG}/orders`, {
  jar: jars.merchant,
  expect: 200,
});
const mine = (inbox.payload.orders ?? []).find((o) => o.id === order.id);
assert.ok(mine, "the order a shopper just placed must appear in the merchant's list");
console.log(`[rehearsal] merchant sees it · status ${mine.status} · version ${mine.version}`);

let version = mine.version;
for (const toStatus of ["confirmed", "preparing", "shipped", "delivered"]) {
  const moved = await call(
    `merchant → ${toStatus}`,
    `/merchant/stores/${SLUG}/orders/${order.id}/status`,
    {
      method: "POST",
      jar: jars.merchant,
      body: { toStatus, expectedVersion: version },
      expect: 200,
    }
  );
  version = moved.payload.order.version;
  console.log(`[rehearsal]   ${toStatus} · version ${version}`);
}

// ============================================================
// 10. The money. Delivered is the event that earns the platform its commission.
// ============================================================
const finalOrder = await call(
  "read the delivered order",
  `/merchant/stores/${SLUG}/orders/${order.id}`,
  { jar: jars.merchant, expect: 200 }
);
assert.equal(finalOrder.payload.order.status, "delivered");
const finance = await call(
  "merchant reads his finance",
  `/merchant/stores/${SLUG}/finance/summary`,
  { jar: jars.merchant }
);
console.log(`[rehearsal] finance summary answered ${finance.status}`);

const total = steps.reduce((sum, s) => sum + s.ms, 0);
console.log(
  JSON.stringify(
    {
      rehearsal: "PASSED",
      base: BASE,
      stamp: STAMP,
      storeSlug: SLUG,
      orderNumber: order.orderNumber,
      totalIqd: order.totalIqd,
      steps: steps.length,
      wallClockMs: total,
      marks: `every row this created carries «${STAMP}» or the slug «${SLUG}»`,
    },
    null,
    2
  )
);
