/**
 * ق-194 — a limit whose key the caller chooses is not a limit.
 *
 * ============================================================================
 * WHAT WAS ACTUALLY BROKEN
 * ============================================================================
 *
 * Two shapes of the same mistake, found by an adversarial audit on 2026-09-09
 * and each confirmed by two independent skeptics:
 *
 *   1. THE STAFF DOOR. Its bucket was keyed `staff:${storeSlug}:${ip}`, and
 *      `:storeSlug` is a free path segment nobody resolves before the limiter.
 *      Change one character, land in a brand-new bucket, never see a 429 —
 *      unbounded password guessing against any staff account on the platform.
 *      The merchant door four lines above CARRIES A COMMENT DESCRIBING THIS
 *      EXACT BYPASS BEING REMOVED FROM IT. The staff door was left with it.
 *
 *      It was also a free denial of service: `loginStaff` runs an unconditional
 *      bcrypt-12 compare (the 19-د anti-enumeration measure), and at the time
 *      the library was pure JS — ~500 ms of BLOCKING work on a single-threaded
 *      event loop per guess. (D-36 moved it to the threadpool; the guess still
 *      costs the CPU, so the ceiling still matters.)
 *
 *   2. THE ANONYMOUS STOREFRONT WRITES. `cart_write` and `coupon_preview` keyed
 *      on `guestCartToken` — an unsigned cookie the caller sends. Rotate it and
 *      the ceiling stops existing: unbounded cart-row minting, and unbounded
 *      coupon-code enumeration whose 200-vs-422 says which codes are real and
 *      what each is worth.
 *
 * ============================================================================
 * WHAT THIS ASSERTS, AND WHY IT IS SHAPED THIS WAY
 * ============================================================================
 *
 * The assertion is NOT «a 429 eventually appears». It is that the 429 appears
 * FOR AN ATTACKER WHO IS ROTATING THE PART HE CONTROLS — which is the only
 * question that was ever open. A test that hammered one fixed key would have
 * passed against the broken code.
 *
 * Run: pnpm ratelimit:key
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const testId = `rlk-${Date.now()}`;
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

async function request(path, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: base, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  return { status: response.status, payload };
}

const summary = {};
try {
  const merchant = await registerMerchantDirect({ ownerName: "صاحب المتجر", businessName: "متجر الحدود", phone: `+96478${suffix}`, email: `${testId}.m@codiq.test`, password: "RateLimitMerchant!2026" });
  assert.equal(merchant.status, 201, JSON.stringify(merchant.payload));
  const store = await prisma.store.create({ data: { merchantId: merchant.payload.account.id, name: "متجر الحدود", slug: `${testId}-s`, defaultSubdomain: `${testId}-s` } });

  // ── 1. the staff door: rotating the slug must NOT mint a fresh budget ─────
  //
  // Every request below carries a DIFFERENT store slug, which is exactly the
  // attack. The door answers 404 for a slug that is not a store — that is fine
  // and not what is being measured; what is being measured is that the attempts
  // are still counted against one budget, so a 429 arrives.
  let staffStatus = null;
  let staffAttempts = 0;
  for (let attempt = 0; attempt < 45; attempt += 1) {
    staffAttempts += 1;
    const answer = await request(`/auth/staff/stores/${testId}-nope-${attempt}/login`, {
      method: "POST",
      body: { email: `victim@codiq.test`, password: `guess-${attempt}` },
    });
    if (answer.status === 429) { staffStatus = 429; break; }
  }
  assert.equal(staffStatus, 429, `ق-194: rotating the slug must not mint a new bucket — ${staffAttempts} guesses passed unlimited, which is unbounded password guessing against every staff account on the platform`);
  assert.ok(staffAttempts > 30, "…and the budget really is the documented 30, not something tighter that would lock out a shop");
  summary.staffDoorHoldsAcrossSlugs = { attemptsUntil429: staffAttempts };

  // ── 2. the anonymous cart: rotating the guest cookie must not either ──────
  await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits");
  const product = await prisma.product.create({ data: { storeId: store.id, sku: "RLK-1", name: "منتج الحدّ", priceIqd: 1000, stockQuantity: 500, isActive: true } });
  const variant = await prisma.productVariant.findFirstOrThrow({ where: { productId: product.id }, select: { id: true } });

  let cartStatus = null;
  let cartAttempts = 0;
  for (let attempt = 0; attempt < 700; attempt += 1) {
    cartAttempts += 1;
    const answer = await request(`/store/${store.slug}/cart/items`, {
      method: "POST",
      // A different guest-cart cookie every time — the caller naming his own bucket.
      headers: { cookie: `codiq_cart_${store.slug}=rotate-${attempt}` },
      body: { productId: product.id, variantId: variant.id, quantity: 1 },
    });
    if (answer.status === 429) { cartStatus = 429; break; }
  }
  assert.equal(cartStatus, 429, `ق-194: rotating the guest cookie must not mint a new bucket — ${cartAttempts} anonymous writes passed, each one a permanent shopping_carts row in the shared database`);
  summary.cartHoldsAcrossCookies = { attemptsUntil429: cartAttempts };

  // ── 3. …and an ordinary shopper is NOT the one who pays for it ───────────
  //
  // The address ceiling is deliberately far above the per-caller one, because a
  // whole Iraqi neighbourhood shares one address. This asserts the honest
  // shopper's own budget is still the ordinary 60 and that he reaches it long
  // before the wall built for the script.
  await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits");
  let honestStatus = null;
  let honestAttempts = 0;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    honestAttempts += 1;
    const answer = await request(`/store/${store.slug}/cart/items`, {
      method: "POST",
      headers: { cookie: `codiq_cart_${store.slug}=one-honest-shopper` },
      body: { productId: product.id, variantId: variant.id, quantity: 1 },
    });
    if (answer.status === 429) { honestStatus = 429; break; }
  }
  assert.equal(honestStatus, 429);
  assert.ok(honestAttempts <= 61, `ق-194: one shopper still gets his own ordinary ceiling (${honestAttempts}), which is what keeps the address ceiling from being the thing anyone meets`);
  summary.honestShopperKeepsHisOwnCeiling = { attemptsUntil429: honestAttempts };

  // ── 4. ق-196: the ROUTES must use the ceiling, not merely have one available ──
  //
  // The first version of this case called `consumeStorefrontRateLimit` directly
  // with a hand-built key. It passed while the route was reverted to the plain
  // limiter — it proved the LIMITER works, which nobody doubted, and said
  // nothing about whether checkout uses it. That is the exact defect this whole
  // audit has been hunting, written by me, in the test meant to prove the fix.
  //
  // Read as source instead. It is a static claim and it belongs in a static
  // check: exercising 48 real checkouts through four fixture customers would
  // prove the same sentence and cost a minute of CI for it.
  const { readFileSync } = await import("node:fs");
  const routeSources = {
    "routes/storefront.ts": readFileSync(new URL("../src/http/routes/storefront.ts", import.meta.url), "utf8"),
    "routes/marketing.ts": readFileSync(new URL("../src/http/routes/marketing.ts", import.meta.url), "utf8"),
  };
  // Every scope whose caller-supplied key was the defect. `customer_register`
  // and `customer_login` are absent on purpose: both are already keyed on the
  // address itself, which the caller cannot change.
  const mustCarryCeiling = [
    { file: "routes/storefront.ts", scope: "cart_write" },
    { file: "routes/storefront.ts", scope: "checkout" },
    { file: "routes/marketing.ts", scope: "coupon_preview" },
  ];
  const unguarded = mustCarryCeiling.filter(({ file, scope }) =>
    new RegExp(`limitStorefrontWrite\\(request, "${scope}"`).test(routeSources[file]),
  );
  assert.deepEqual(
    unguarded,
    [],
    `ق-196: ${unguarded.map((row) => `${row.file} → ${row.scope}`).join(", ")} fell back to the plain limiter, whose key the caller chooses. ` +
      `Registration allows eight accounts per address per ten minutes and each gets its own fresh per-caller budget, so without the address ceiling one address mints them without bound.`,
  );
  for (const { file, scope } of mustCarryCeiling) {
    assert.ok(
      new RegExp(`limitStorefrontWriteWithAddressCeiling\\(request, "${scope}"`).test(routeSources[file]),
      `ق-196: ${file} → ${scope} must consume the address ceiling`,
    );
  }
  summary.routesCarryTheAddressCeiling = mustCarryCeiling.map((row) => row.scope);
  console.log(JSON.stringify({ suite: "rate-limit-key", status: "passed", summary }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
}
