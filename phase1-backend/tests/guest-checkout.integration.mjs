/**
 * ق-201 — buying without an account, end to end.
 *
 * A stranger fills a cart, types his name, phone and address, and pays cash at
 * his door — no registration. This proves the shape behind that: his phone
 * becomes a shadow customer row, the SAME checkout runs (money, stock, delivery
 * fee, idempotency untouched), a second tap is a replay and not a second order,
 * a second purchase from the same phone lands on the same row, a phone that is
 * somebody's account is refused, the merchant can switch the door off, and a
 * password turns the guest into an account with every order already in it.
 *
 * Run: pnpm guest:checkout
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const testId = `guest-${Date.now()}`;
const suffix = String(Date.now()).slice(-8);
process.env.CODIQ_ALLOW_OWNER_REGISTRATION = "true";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits");

const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

/** One browser: a cookie jar that absorbs Set-Cookie and sends what it holds. */
function browser() {
  const jar = new Map();
  const absorb = (response) => {
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1);
      const gone = attrs.some((attr) => /^\s*(max-age=0|expires=thu, 01 jan 1970)/i.test(attr));
      if (gone) jar.delete(name);
      else jar.set(name, value);
    }
  };
  return {
    has: (name) => jar.has(name),
    async request(path, { method = "GET", body, headers = {} } = {}) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          origin: base,
          ...(jar.size
            ? { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ") }
            : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      absorb(response);
      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = text;
      }
      return { status: response.status, payload };
    },
  };
}

const summary = {};
try {
  const merchant = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    businessName: "متجر الضيوف",
    phone: `+96475${suffix}`,
    email: `${testId}.merchant@codiq.test`,
    password: "GuestMerchant!2026",
  });
  assert.equal(merchant.status, 201, JSON.stringify(merchant.payload));
  const store = await prisma.store.create({
    data: {
      merchantId: merchant.payload.account.id,
      name: "متجر الضيوف",
      slug: `${testId}-s`,
      defaultSubdomain: `${testId}-s`,
    },
  });
  await prisma.deliveryRate.create({
    data: { storeId: store.id, governorate: "Baghdad", amountIqd: 3000, isEnabled: true },
  });
  const product = await prisma.product.create({
    data: {
      storeId: store.id,
      sku: "GUEST-1",
      name: "عطر الضيف",
      priceIqd: 15000,
      stockQuantity: 10,
      lowStockThreshold: 0,
    },
  });
  const slug = store.slug;
  const cartCookie = `codiq_cart_${slug}`;
  const sessionCookie = `codiq_customer_session_${slug}`;
  const address = (name, phone) => ({
    recipientName: name,
    fullAddress: "حي الجامعة، زقاق ٤، دار ١٢",
    city: "بغداد",
    governorate: "Baghdad",
    phoneContact: phone,
  });

  // ── 1. a stranger fills a cart and buys — no account, no login ───────────
  const stranger = browser();
  const added = await stranger.request(`/store/${slug}/cart/items`, {
    method: "POST",
    body: { productId: product.id, quantity: 2 },
  });
  assert.equal(added.status, 200, JSON.stringify(added.payload));
  assert.ok(stranger.has(cartCookie), "a guest cart rides a cookie");
  const key1 = `${testId}-k1`;
  const first = await stranger.request(`/store/${slug}/checkout/guest`, {
    method: "POST",
    headers: { "idempotency-key": key1 },
    body: {
      cartVersion: added.payload.cart.version,
      fullName: "ضيف الواجهة",
      phone: "07712345678",
      address: address("ضيف الواجهة", "07712345678"),
      paymentMethodCode: "cod",
      note: "اتصل قبل الوصول",
      loyaltyPoints: 500,
    },
  });
  assert.equal(first.status, 201, JSON.stringify(first.payload));
  assert.equal(first.payload.replayed, false);
  assert.equal(first.payload.order.customerName, "ضيف الواجهة");
  assert.equal(
    first.payload.order.recipientPhone,
    "+9647712345678",
    "the courier gets an E.164 phone"
  );
  assert.equal(
    first.payload.order.totalIqd,
    2 * 15000 + 3000,
    "ق-201: the SAME checkout — items plus the governorate's delivery fee"
  );
  assert.equal(
    first.payload.order.loyaltyDiscountIqd,
    0,
    "ق-201: a guest spends no points, whatever the client sends"
  );
  assert.equal(first.payload.order.customerNote, "اتصل قبل الوصول");
  assert.equal(first.payload.account.isGuest, true);
  assert.ok(
    stranger.has(sessionCookie),
    "a session is issued so the confirmation page and «طلباتي» work"
  );
  assert.equal(
    stranger.has(cartCookie),
    false,
    "…and the guest cart cookie is retired with the cart it named"
  );
  const shadow = await prisma.customer.findUniqueOrThrow({
    where: { id: first.payload.account.id },
    select: { isGuest: true, passwordHash: true, phoneNormalized: true },
  });
  assert.deepEqual(
    shadow,
    { isGuest: true, passwordHash: null, phoneNormalized: "+9647712345678" },
    "a guest is a customer row without a password"
  );
  const me = await stranger.request(`/store/${slug}/account`);
  assert.equal(me.status, 200);
  assert.equal(me.payload.customer.isGuest, true, "the shell can tell a guest from an account");
  const mine = await stranger.request(`/store/${slug}/account/orders`);
  assert.equal(mine.payload.orders.length, 1, "his order is in his history");
  summary.guestOrder = { total: first.payload.order.totalIqd, session: true, isGuest: true };

  // ── 2. the second tap is the same order ──────────────────────────────────
  const again = await stranger.request(`/store/${slug}/checkout/guest`, {
    method: "POST",
    headers: { "idempotency-key": key1 },
    body: {
      cartVersion: added.payload.cart.version,
      fullName: "ضيف الواجهة",
      phone: "07712345678",
      address: address("ضيف الواجهة", "07712345678"),
      paymentMethodCode: "cod",
      note: "اتصل قبل الوصول",
    },
  });
  assert.equal(again.status, 200, JSON.stringify(again.payload));
  assert.equal(
    again.payload.replayed,
    true,
    "ق-201: a replay is recognised BEFORE the cart merge would change the fingerprint"
  );
  assert.equal(again.payload.order.id, first.payload.order.id);
  assert.equal(
    await prisma.storeOrder.count({ where: { storeId: store.id } }),
    1,
    "one tap, two taps — one order"
  );
  summary.replay = "same order";

  // ── 3. the same phone from another browser: same ROW, but no identity ────
  // ق-232. The other browser may be the same shopper on his second device — or
  // the courier who delivered his first parcel and remembers the number. The
  // server cannot tell, so it gives what the phone proves (the order lands on
  // the row the merchant already knows) and nothing the phone does not prove:
  // no session, no email back, no history. Before ق-232 this request returned
  // a live session for the first browser's row and its two orders — with the
  // shopper's address and phone — to whoever typed the number.
  const otherDevice = browser();
  const added2 = await otherDevice.request(`/store/${slug}/cart/items`, {
    method: "POST",
    body: { productId: product.id, quantity: 1 },
  });
  const second = await otherDevice.request(`/store/${slug}/checkout/guest`, {
    method: "POST",
    headers: { "idempotency-key": `${testId}-k2` },
    body: {
      cartVersion: added2.payload.cart.version,
      fullName: "ضيف الواجهة",
      phone: "+9647712345678",
      email: `${testId}.hijack@example.com`,
      address: address("ضيف الواجهة", "07712345678"),
      paymentMethodCode: "cod",
    },
  });
  assert.equal(second.status, 201, JSON.stringify(second.payload));
  assert.equal(
    second.payload.account,
    null,
    "ق-232: a phone with history here gets the order back and NOT the row — the number was never proof of the person"
  );
  assert.equal(second.payload.accessToken, null, "…and no token");
  assert.equal(otherDevice.has(sessionCookie), false, "…and no session cookie");
  assert.equal(
    await prisma.customer.count({
      where: { storeId: store.id, phoneNormalized: "+9647712345678" },
    }),
    1,
    "ق-201 still holds: one person, not two"
  );
  const rowAfter = await prisma.customer.findFirst({
    where: { storeId: store.id, phoneNormalized: "+9647712345678" },
    select: { id: true, email: true },
  });
  assert.equal(
    rowAfter.id,
    first.payload.account.id,
    "…and the order landed on the row the merchant already knows"
  );
  assert.notEqual(
    rowAfter.email,
    `${testId}.hijack@example.com`,
    "ق-232: typing the number does not re-point the row's recovery email either"
  );
  assert.equal(
    (await otherDevice.request(`/store/${slug}/account/orders`)).status,
    401,
    "ق-232: the second browser cannot read the history — that is the whole finding"
  );
  assert.equal(
    (await stranger.request(`/store/${slug}/account/orders`)).payload.orders.length,
    2,
    "…while the browser that CREATED the row still sees both orders on it"
  );
  // What the returning guest DOES get: the public tracking door, with the
  // order number he was just given and the phone he knows.
  const tracked = await otherDevice.request(`/store/${slug}/orders/track`, {
    method: "POST",
    body: { orderNumber: second.payload.order.orderNumber, phone: "07712345678" },
  });
  assert.equal(tracked.status, 200, JSON.stringify(tracked.payload));
  assert.equal(
    tracked.payload.order.orderNumber,
    second.payload.order.orderNumber,
    "…which shows him his own order and only his own order"
  );
  summary.samePhone = "same row, two orders, no identity for the second browser";

  // ── 4. a phone that is somebody's ACCOUNT is refused as a guest ──────────
  const member = browser();
  const registered = await member.request(`/store/${slug}/account/register`, {
    method: "POST",
    body: {
      fullName: "زبون مسجّل",
      phone: "07798765432",
      password: "RegisteredShopper!2026",
      email: `${testId}.member@example.com`,
    },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const impostor = browser();
  const added3 = await impostor.request(`/store/${slug}/cart/items`, {
    method: "POST",
    body: { productId: product.id, quantity: 1 },
  });
  const refused = await impostor.request(`/store/${slug}/checkout/guest`, {
    method: "POST",
    headers: { "idempotency-key": `${testId}-k3` },
    body: {
      cartVersion: added3.payload.cart.version,
      fullName: "منتحل",
      phone: "07798765432",
      address: address("منتحل", "07798765432"),
      paymentMethodCode: "cod",
    },
  });
  assert.equal(refused.status, 409, JSON.stringify(refused.payload));
  assert.equal(
    refused.payload.error.code,
    "CUSTOMER_ACCOUNT_EXISTS",
    "ق-201: a stranger's order is never attached to somebody's account"
  );
  assert.equal(
    impostor.has(sessionCookie),
    false,
    "…and no session is issued for a row that is not his"
  );
  assert.equal(
    (await member.request(`/store/${slug}/account/orders`)).payload.orders.length,
    0,
    "the account holder's history is untouched"
  );
  summary.accountPhoneRefused = "CUSTOMER_ACCOUNT_EXISTS";

  // ── 5. the merchant can switch the door off ──────────────────────────────
  await prisma.store.update({ where: { id: store.id }, data: { guestCheckoutEnabled: false } });
  const closed = await impostor.request(`/store/${slug}/checkout/guest`, {
    method: "POST",
    headers: { "idempotency-key": `${testId}-k4` },
    body: {
      cartVersion: added3.payload.cart.version,
      fullName: "ضيف جديد",
      phone: "07733344455",
      address: address("ضيف جديد", "07733344455"),
      paymentMethodCode: "cod",
    },
  });
  assert.equal(closed.status, 422);
  assert.equal(closed.payload.error.code, "GUEST_CHECKOUT_DISABLED");
  assert.equal(
    (await impostor.request(`/store/${slug}/public-config`)).payload.guestCheckout,
    false,
    "…and the storefront is told, so it asks him to sign in instead of failing at the end"
  );
  await prisma.store.update({ where: { id: store.id }, data: { guestCheckoutEnabled: true } });
  summary.switch = "GUEST_CHECKOUT_DISABLED";

  // ── 6. a guest chooses a password and becomes an account, orders included ─
  // From the browser that CREATED the row — the one door that proved something
  // (ق-232): the session minted at creation is his because the row was empty
  // when he got it. The second browser has no session and cannot do this.
  assert.equal(
    (
      await otherDevice.request(`/store/${slug}/account/password`, {
        method: "POST",
        body: { password: "Hijack!2026" },
      })
    ).status,
    401,
    "ق-232: no session, no password — the second browser cannot make the row an account"
  );
  const upgraded = await stranger.request(`/store/${slug}/account/password`, {
    method: "POST",
    body: { password: "GuestBecomesAccount!2026" },
  });
  assert.equal(upgraded.status, 200, JSON.stringify(upgraded.payload));
  assert.equal(upgraded.payload.account.isGuest, false);
  assert.equal(
    (
      await stranger.request(`/store/${slug}/account/password`, {
        method: "POST",
        body: { password: "Another!2026" },
      })
    ).status,
    409,
    "an account changes its password elsewhere, with the old one asked for"
  );
  const fresh = browser();
  const login = await fresh.request(`/store/${slug}/account/login`, {
    method: "POST",
    body: { phone: "07712345678", password: "GuestBecomesAccount!2026" },
  });
  assert.equal(login.status, 200, JSON.stringify(login.payload));
  assert.equal(
    (await fresh.request(`/store/${slug}/account/orders`)).payload.orders.length,
    2,
    "ق-201: the orders he placed as a guest are his account's"
  );
  summary.upgrade = "password set, login works, 2 orders kept";

  // ── 7. registering with a guest's phone does NOT claim the row ───────────
  // ق-232. This was the second door of the same finding: ق-201 let a register
  // call with a guest's number set a password on that guest's row and walk
  // away with his orders, addresses and points. The number proves nothing, so
  // the row is refused — and the refusal names the door that DOES prove
  // something, which depends on what the row holds.
  const walkIn = browser();
  const added4 = await walkIn.request(`/store/${slug}/cart/items`, {
    method: "POST",
    body: { productId: product.id, quantity: 1 },
  });
  const walkInOrder = await walkIn.request(`/store/${slug}/checkout/guest`, {
    method: "POST",
    headers: { "idempotency-key": `${testId}-k5` },
    body: {
      cartVersion: added4.payload.cart.version,
      fullName: "زائر",
      phone: "07755512345",
      address: address("زائر", "07755512345"),
      paymentMethodCode: "cod",
    },
  });
  assert.equal(walkInOrder.status, 201, JSON.stringify(walkInOrder.payload));
  const claim = await browser().request(`/store/${slug}/account/register`, {
    method: "POST",
    body: { fullName: "الزائر المسجّل", phone: "07755512345", password: "ClaimMyOrders!2026" },
  });
  assert.equal(claim.status, 409, JSON.stringify(claim.payload));
  assert.equal(
    claim.payload.error.code,
    "CUSTOMER_PHONE_UNVERIFIED",
    "ق-232: a guest row is never claimed by typing its number"
  );
  assert.match(
    claim.payload.error.message,
    /اطلب من المتجر/,
    "…a row with no email is sent to the merchant, who can call the number"
  );
  assert.doesNotMatch(
    claim.payload.error.message,
    /نسيت كلمة المرور/,
    "…and is not sent to a recovery door that has no address to write to"
  );
  const walkInRow = await prisma.customer.findFirst({
    where: { storeId: store.id, phoneNormalized: "+9647755512345" },
    select: { passwordHash: true, isGuest: true, fullName: true },
  });
  assert.deepEqual(
    walkInRow,
    { passwordHash: null, isGuest: true, fullName: "زائر" },
    "…and the row is untouched: no password, still a guest, still his name"
  );
  assert.equal(
    await prisma.customer.count({
      where: { storeId: store.id, phoneNormalized: "+9647755512345" },
    }),
    1,
    "…and no second identity was created beside it"
  );
  assert.equal(
    (
      await browser().request(`/store/${slug}/account/login`, {
        method: "POST",
        body: { phone: "07755512345", password: "ClaimMyOrders!2026" },
      })
    ).status,
    401,
    "…so the password the stranger chose opens nothing"
  );
  // A guest row WITH a recorded email is pointed at password recovery — the
  // door where possession of that address is what gets proved.
  const withEmail = browser();
  const added5 = await withEmail.request(`/store/${slug}/cart/items`, {
    method: "POST",
    body: { productId: product.id, quantity: 1 },
  });
  const withEmailOrder = await withEmail.request(`/store/${slug}/checkout/guest`, {
    method: "POST",
    headers: { "idempotency-key": `${testId}-k6` },
    body: {
      cartVersion: added5.payload.cart.version,
      fullName: "زائرة",
      phone: "07766612345",
      email: `${testId}.recover@example.com`,
      address: address("زائرة", "07766612345"),
      paymentMethodCode: "cod",
    },
  });
  assert.equal(withEmailOrder.status, 201, JSON.stringify(withEmailOrder.payload));
  const claimWithEmail = await browser().request(`/store/${slug}/account/register`, {
    method: "POST",
    body: { fullName: "منتحلة", phone: "07766612345", password: "ClaimHer!2026" },
  });
  assert.equal(claimWithEmail.status, 409);
  assert.equal(claimWithEmail.payload.error.code, "CUSTOMER_PHONE_UNVERIFIED");
  assert.match(
    claimWithEmail.payload.error.message,
    /نسيت كلمة المرور/,
    "ق-232: a row with an email is sent to recovery — the honest shopper has that inbox, the stranger does not"
  );
  // And a phone that already IS an account keeps the refusal it has always had.
  // ق-232 added ONE rule and one code; the account case is still decided by
  // `customers_store_phone_present_uq` and named by `errors.ts`, because a
  // second code for a refusal the platform already names is how contracts rot.
  const duplicate = await browser().request(`/store/${slug}/account/register`, {
    method: "POST",
    body: { fullName: "نسخة", phone: "07798765432", password: "SecondRow!2026" },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(
    duplicate.payload.error.code,
    "DUPLICATE_CUSTOMER_PHONE",
    "one number, one identity — and the code is the one phase 1 pinned, not a new one"
  );
  assert.equal(
    await prisma.customer.count({
      where: { storeId: store.id, phoneNormalized: "+9647798765432" },
    }),
    1
  );
  summary.registerRefused =
    "CUSTOMER_PHONE_UNVERIFIED (merchant / recovery), DUPLICATE_CUSTOMER_PHONE unchanged";

  // ── 8. a guest cannot sign in as a guest ─────────────────────────────────
  const noPassword = await browser().request(`/store/${slug}/account/login`, {
    method: "POST",
    body: { phone: "07733344455", password: "anything-at-all-2026" },
  });
  assert.equal(
    noPassword.status,
    401,
    "a row with no password admits nobody — the same answer as a wrong password, so the door leaks nothing"
  );
  summary.guestLoginRefused = 401;

  console.log(JSON.stringify({ suite: "guest-checkout", status: "passed", summary }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
}
