/**
 * codiq P27-7 — demo environment integration proof.
 *
 * `config.demoMode` is read ONCE at import, which is exactly the property worth
 * having and exactly what makes a single-process test impossible: the flag cannot
 * be flipped mid-run. So this file runs itself twice as a child process —
 * phase "off" (the flag absent, i.e. every other environment) and phase "on" —
 * against the same test database, sequentially.
 *
 * BOTH phases seed the same demo dataset and drive the same requests. The "off"
 * half is the important one: it proves the flag changes nothing at all when it is
 * not set — the platform surface answers as it does today, the guarded mutations
 * succeed on the very rows the demo protects, and the SMTP provider still resolves.
 *
 * Scenarios (× 2 phases):
 *   1. the 31-route platform surface + owner login/registration;
 *   2. GET /public/demo-status;
 *   3. POST /public/demo-login: existence, the session it mints, its store scope,
 *      and its rate limit;
 *   4. merchant-facing routes that happen to live in routes/platform.ts are NEVER
 *      caught by the /platform prefix guard;
 *   5. the two assertDemoWritable call sites, each proved against a seeded row AND
 *      against a row the "visitor" created (the guard must be targeted, not global);
 *   6. the notification provider and the outbox skip path, with SMTP configured in
 *      BOTH phases so the demo half proves the flag beats the configuration;
 *   7. the seed's two refusals, and the shape of the dataset it builds.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const phase = process.env.CODIQ_DEMO_TEST_PHASE;

if (!phase) {
  for (const nextPhase of ["off", "on"]) {
    const childEnv = { ...process.env, CODIQ_DEMO_TEST_PHASE: nextPhase };
    // Phase "off" must run with the variable genuinely ABSENT — the default state
    // of production, staging and every developer machine.
    if (nextPhase === "on") childEnv.CODIQ_DEMO_MODE = "true";
    else delete childEnv.CODIQ_DEMO_MODE;
    console.log(`\n===== P27-7 demo-mode suite — phase: ${nextPhase} =====`);
    const result = spawnSync(
      process.execPath,
      [...process.execArgv, fileURLToPath(import.meta.url)],
      { stdio: "inherit", env: childEnv }
    );
    if (result.status !== 0) {
      console.error(`[demo-mode] phase "${nextPhase}" failed with exit code ${result.status}`);
      process.exit(result.status ?? 1);
    }
  }
  console.log(
    "\n[demo-mode] both phases green — the flag is fully server-enforced and fully inert when off."
  );
  process.exit(0);
}

const demoOn = phase === "on";
process.env.SESSION_JWT_SECRET = "demo-mode-test-secret-only-not-for-production";
// Owner registration stays open in both phases: in the demo half the surface must
// still vanish, proving the demo guard is independent of that bootstrap switch.
process.env.CODIQ_ALLOW_OWNER_REGISTRATION = "true";
// A fully configured SMTP provider in BOTH phases.
process.env.CODIQ_SMTP_HOST = "smtp.demo-suite.invalid";
process.env.CODIQ_SMTP_FROM = "no-reply@demo-suite.invalid";

const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { config } = await import("../src/config.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { isEmailProviderConfigured, resolveNotificationProvider } = await import(
  "../src/notifications/notification-provider.ts"
);
const { processOutboxBatch } = await import("../src/notifications/outbox-worker.ts");
const { DEMO_MERCHANT_EMAIL, DEMO_MERCHANT_PASSWORD, DEMO_STAFF_EMAIL, DEMO_STORE_SLUG } =
  await import("../src/demo/demo-mode.ts");
const { assertDemoSeedTarget, seedDemoData } = await import("../scripts/seed-demo.ts");

assert.equal(config.demoMode, demoOn, "config.demoMode must mirror the phase under test");

const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, { method = "GET", body, token, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
  const payload =
    response.status === 204 ? null : isJson ? await response.json().catch(() => null) : null;
  return { status: response.status, payload };
}

/**
 * The complete platform surface: 2 owner-auth routes (routes/auth.ts), 21 owner
 * routes (routes/platform.ts) and 8 owner read routes (routes/orders.ts).
 * Kept as an explicit list so a new platform route that this suite forgets is a
 * visible omission rather than an invisible one.
 */
const OWNER_AUTH_ROUTES = [
  ["POST", "/auth/platform/register"],
  ["POST", "/auth/platform/login"],
];
const PLATFORM_ROUTES = [
  ["POST", "/platform/merchants/manual"],
  ["GET", "/platform/plans"],
  ["PATCH", "/platform/plans/00000000-0000-4000-8000-000000000001"],
  ["GET", "/platform/merchants"],
  ["GET", "/platform/merchants/00000000-0000-4000-8000-000000000001/subscription"],
  ["PUT", "/platform/merchants/00000000-0000-4000-8000-000000000001/subscription"],
  ["GET", "/platform/finance/report"],
  ["POST", "/platform/finance/settlements"],
  ["GET", "/platform/finance/settlements/00000000-0000-4000-8000-000000000001"],
  ["POST", "/platform/finance/adjustments"],
  ["GET", "/platform/settings/registration"],
  ["PUT", "/platform/settings/registration"],
  ["GET", "/platform/merchants/registration-requests"],
  ["POST", "/platform/merchants/00000000-0000-4000-8000-000000000001/approval"],
  ["GET", "/platform/stores"],
  ["POST", "/platform/plans"],
  ["POST", "/platform/plans/00000000-0000-4000-8000-000000000001/archive"],
  ["POST", "/platform/plans/00000000-0000-4000-8000-000000000001/unarchive"],
  ["GET", "/platform/upgrade-requests"],
  ["POST", "/platform/upgrade-requests/00000000-0000-4000-8000-000000000001/approve"],
  ["POST", "/platform/upgrade-requests/00000000-0000-4000-8000-000000000001/reject"],
  ["GET", "/platform/dashboard"],
  ["GET", `/platform/stores/${DEMO_STORE_SLUG}/products`],
  ["GET", `/platform/stores/${DEMO_STORE_SLUG}/products/00000000-0000-4000-8000-000000000001`],
  ["GET", `/platform/stores/${DEMO_STORE_SLUG}/orders`],
  ["GET", `/platform/stores/${DEMO_STORE_SLUG}/orders/00000000-0000-4000-8000-000000000001`],
  ["GET", "/platform/orders"],
  ["GET", "/platform/orders/00000000-0000-4000-8000-000000000001"],
  ["GET", "/platform/orders/00000000-0000-4000-8000-000000000001/history"],
];
assert.equal(
  OWNER_AUTH_ROUTES.length + PLATFORM_ROUTES.length,
  31,
  "the platform surface is 31 routes; update this suite when it changes"
);

/**
 * The same surface reached with a DIFFERENT LETTER CASE. Express routes
 * case-insensitively by default (`case sensitive routing` is off), so every one
 * of these reaches the very same handler as its lower-case twin — while a guard
 * comparing `request.path` literally would wave them straight past. Before the
 * fix these answered 401 MISSING_SESSION instead of 404, which advertises that
 * an owner area exists, and would have been a real hole the moment
 * `CODIQ_ALLOW_OWNER_REGISTRATION` was set on the demo service by mistake.
 *
 * The list above is lower-case only, which is exactly why CI was green while the
 * hole was open; these rows are the regression fence.
 */
const OWNER_CASE_VARIANT_ROUTES = [
  ["GET", "/Platform/plans"],
  ["GET", "/PLATFORM/merchants"],
  ["GET", "/PlAtFoRm/dashboard"],
  ["GET", "/platform/Stores"],
  ["POST", "/Auth/Platform/register"],
  ["POST", "/Auth/Platform/login"],
  ["POST", "/AUTH/PLATFORM/login"],
];

const summary = { phase, demoMode: config.demoMode };

try {
  // ---------- 0. the seed's two refusals (pure, no database access) ----------
  const demoUrl = "postgresql://user:pass@ep-demo-branch.neon.tech:5432/codiq_demo";
  assert.throws(
    () => assertDemoSeedTarget({ CODIQ_DEMO_MODE: "false", CODIQ_POSTGRES_URL: demoUrl }),
    /CODIQ_DEMO_MODE/,
    "seeding without the flag must refuse"
  );
  assert.throws(
    () =>
      assertDemoSeedTarget({
        CODIQ_DEMO_MODE: "true",
        CODIQ_POSTGRES_URL: "postgresql://u:p@host:5432/codiq_production",
      }),
    /does not contain/,
    "seeding a non-demo database must refuse"
  );
  assert.equal(
    assertDemoSeedTarget({ CODIQ_DEMO_MODE: "true", CODIQ_POSTGRES_URL: demoUrl }),
    demoUrl
  );
  // The live test database is `codiq_ci_test`, so the CLI guard would (correctly)
  // refuse it; the rebuild itself is driven directly.
  assert.throws(
    () => assertDemoSeedTarget(process.env),
    demoOn ? /does not contain/ : /CODIQ_DEMO_MODE/
  );
  summary.seedRefusals = {
    withoutFlag: "refused",
    withoutDemoInUrl: "refused",
    accepted: "demo branch only",
  };

  // ---------- 1. rebuild the demo dataset (identical in both phases) ----------
  const seeded = await seedDemoData();
  assert.deepEqual(
    {
      products: seeded.products,
      variants: seeded.variants,
      orders: seeded.orders,
      ledgerEntries: seeded.ledgerEntries,
      customers: seeded.customers,
      coupons: seeded.coupons,
      categories: seeded.categories,
      deliveryRates: seeded.deliveryRates,
    },
    {
      products: 12,
      variants: 20,
      orders: 15,
      ledgerEntries: 8,
      customers: 2,
      coupons: 2,
      categories: 8,
      deliveryRates: 5,
    }
  );
  // Re-running must land on the same dataset — idempotent by wipe-and-rebuild.
  const reseeded = await seedDemoData();
  assert.equal(reseeded.orders, seeded.orders);
  assert.equal(reseeded.storeSlug, DEMO_STORE_SLUG);
  assert.equal(await prisma.merchant.count(), 1, "the rebuild leaves exactly one merchant");
  const statusCounts = Object.fromEntries(
    (await prisma.storeOrder.groupBy({ by: ["status"], _count: { _all: true } })).map((row) => [
      row.status,
      row._count._all,
    ])
  );
  assert.deepEqual(statusCounts, {
    completed: 6,
    returned: 1,
    cancelled: 1,
    rejected: 1,
    out_for_delivery: 1,
    preparation: 1,
    processing: 2,
    new: 2,
  });
  summary.seed = seeded;

  // ---------- 2. the platform surface ----------
  const platformResults = [];
  for (const [method, path] of [...OWNER_AUTH_ROUTES, ...PLATFORM_ROUTES]) {
    const result = await request(path, { method, ...(method === "GET" ? {} : { body: {} }) });
    platformResults.push({
      method,
      path,
      status: result.status,
      code: result.payload?.error?.code ?? null,
    });
  }
  // ---------- 2b. the same surface in a different letter case ----------
  const caseVariantResults = [];
  for (const [method, path] of OWNER_CASE_VARIANT_ROUTES) {
    const result = await request(path, { method, ...(method === "GET" ? {} : { body: {} }) });
    caseVariantResults.push({
      method,
      path,
      status: result.status,
      code: result.payload?.error?.code ?? null,
    });
  }
  if (demoOn) {
    for (const result of caseVariantResults) {
      assert.equal(
        result.status,
        404,
        `${result.method} ${result.path} must be 404 in demo mode — Express routes case-insensitively, so a capital letter must not walk past the guard`
      );
      assert.equal(
        result.code,
        "RESOURCE_NOT_FOUND",
        `${result.method} ${result.path} must answer RESOURCE_NOT_FOUND, never a 401 that confirms the owner area exists`
      );
    }
  } else {
    // The premise of the whole rule, proved rather than assumed: outside demo
    // mode a capital letter reaches the REAL owner handler (401, not Express's
    // own 404), which is precisely why the guard has to normalise the case.
    for (const result of caseVariantResults.filter((row) => row.method === "GET")) {
      assert.equal(
        result.status,
        401,
        `${result.method} ${result.path} must reach the real owner route outside demo mode — if this is 404, Express turned case-sensitive and this suite's premise changed`
      );
      assert.equal(result.code, "MISSING_SESSION");
    }
  }
  summary.platformSurfaceCaseVariants = caseVariantResults.map((row) =>
    `${row.method} ${row.path} → ${row.status} ${row.code ?? ""}`.trim()
  );

  if (demoOn) {
    for (const result of platformResults) {
      assert.equal(result.status, 404, `${result.method} ${result.path} must be 404 in demo mode`);
      assert.equal(
        result.code,
        "RESOURCE_NOT_FOUND",
        `${result.method} ${result.path} must answer RESOURCE_NOT_FOUND — never 403, which would confirm the owner area exists`
      );
    }
    summary.platformSurface = {
      routes: platformResults.length,
      allStatuses: [...new Set(platformResults.map((row) => row.status))],
      allCodes: [...new Set(platformResults.map((row) => row.code))],
    };
  } else {
    // Unchanged from today: no session ⇒ 401 MISSING_SESSION on every owner route.
    for (const result of platformResults.filter((row) => row.path.startsWith("/platform"))) {
      assert.equal(
        result.status,
        401,
        `${result.method} ${result.path} must still answer 401 outside demo mode`
      );
      assert.equal(result.code, "MISSING_SESSION");
    }
    // …and the owner really can sign in and use the surface.
    const registered = await request("/auth/platform/register", {
      method: "POST",
      body: {
        email: "owner.demo-suite@codiq.iq",
        password: "OwnerDemoSuite2026!",
        displayName: "مالك الاختبار",
      },
    });
    assert.equal(registered.status, 201, JSON.stringify(registered.payload));
    const badLogin = await request("/auth/platform/login", {
      method: "POST",
      body: { email: "owner.demo-suite@codiq.iq", password: "WrongPassword2026!" },
    });
    assert.equal(badLogin.status, 401);
    assert.equal(
      badLogin.payload.error.code,
      "INVALID_PLATFORM_OWNER_CREDENTIALS",
      "a wrong password is 401, not the demo 404"
    );
    const ownerLogin = await request("/auth/platform/login", {
      method: "POST",
      body: { email: "owner.demo-suite@codiq.iq", password: "OwnerDemoSuite2026!" },
    });
    assert.equal(ownerLogin.status, 200, JSON.stringify(ownerLogin.payload));
    const ownerToken = ownerLogin.payload.accessToken;
    for (const path of [
      "/platform/dashboard",
      "/platform/plans",
      "/platform/merchants",
      "/platform/stores",
      "/platform/finance/report",
      "/platform/orders",
      "/platform/settings/registration",
      "/platform/upgrade-requests",
      "/platform/merchants/registration-requests",
    ]) {
      const result = await request(path, { token: ownerToken });
      assert.equal(
        result.status,
        200,
        `${path} must still work for the owner: ${JSON.stringify(result.payload)}`
      );
    }
    const ownerStores = await request("/platform/stores", { token: ownerToken });
    assert.ok(
      JSON.stringify(ownerStores.payload).includes(DEMO_STORE_SLUG),
      "the owner directory still lists the store"
    );
    summary.platformSurface = {
      unauthenticated: "401 MISSING_SESSION",
      ownerLogin: 200,
      ownerReadRoutes: 9,
    };
  }

  // ---------- 3. demo status ----------
  const status = await request("/public/demo-status");
  assert.equal(status.status, 200);
  assert.deepEqual(status.payload, { demo: demoOn });
  summary.demoStatus = status.payload;

  // ---------- 3b. merchant self-registration ----------
  // The demo's most expensive failure was not a leak but a broken promise: a
  // prospect who trimmed the demo link met the ordinary marketing page, signed
  // up, was told «تم إنشاء متجرك بنجاح!», and lost account and store to the
  // 01:00 TRUNCATE with no notification possible. So the demo refuses this —
  // but out loud, in Arabic, unlike the owner surface's deliberate silence.
  const signupBody = {
    businessName: "نشاط زائر الديمو",
    storeName: "متجر زائر الديمو",
    storeSlug: "visitor-signup-demo-suite",
    email: "visitor.signup.demo-suite@codiq.iq",
    password: "VisitorSignup2026!",
    ownerName: "زائر الديمو",
    phone: "+9647701900777",
  };
  const signup = await request("/public/merchants/register", {
    method: "POST",
    body: signupBody,
    headers: { origin: base },
  });
  // Case-insensitive here too: the same route, reached with a capital letter.
  const signupCased = await request("/public/Merchants/Register", {
    method: "POST",
    body: signupBody,
    headers: { origin: base },
  });
  if (demoOn) {
    assert.equal(signup.status, 403, JSON.stringify(signup.payload));
    assert.equal(signup.payload.error.code, "DEMO_REGISTRATION_DISABLED");
    assert.ok(
      /نسخة تجريبية/.test(signup.payload.error.message),
      "the refusal is Arabic and explains itself, not a silent 404"
    );
    assert.ok(
      /موقع Codiq الرسمي/.test(signup.payload.error.message),
      "the refusal points the visitor at the real site"
    );
    assert.equal(
      signupCased.status,
      403,
      "a capital letter must not reach the real registration handler either"
    );
    assert.equal(signupCased.payload.error.code, "DEMO_REGISTRATION_DISABLED");
    assert.equal(
      await prisma.merchant.count({ where: { email: signupBody.email } }),
      0,
      "no account may be created in the demo environment"
    );
    summary.selfRegistration = {
      status: 403,
      code: signup.payload.error.code,
      casedVariant: signupCased.status,
      accountsCreated: 0,
    };
  } else {
    // Untouched everywhere else: real self-registration still works.
    assert.equal(signup.status, 201, JSON.stringify(signup.payload));
    assert.equal(signup.payload.store.slug, signupBody.storeSlug);
    assert.equal(await prisma.merchant.count({ where: { email: signupBody.email } }), 1);
    summary.selfRegistration = { status: 201, storeSlug: signup.payload.store.slug };
  }

  // ---------- 4. guest entry ----------
  let merchantToken;
  if (demoOn) {
    const guest = await request("/public/demo-login", { method: "POST", body: {} });
    assert.equal(guest.status, 200, JSON.stringify(guest.payload));
    assert.equal(guest.payload.redirectTo, `/merchant/stores/${DEMO_STORE_SLUG}/dashboard`);
    merchantToken = guest.payload.accessToken;
    assert.ok(typeof merchantToken === "string" && merchantToken.length > 20);
    summary.demoLogin = { status: 200, redirectTo: guest.payload.redirectTo };
  } else {
    const guest = await request("/public/demo-login", { method: "POST", body: {} });
    assert.equal(
      guest.status,
      404,
      "the guest-entry route must not exist outside the demo environment"
    );
    // The documented merchant credentials still work through the ordinary login.
    const login = await request("/auth/merchant/login", {
      method: "POST",
      body: { identifier: DEMO_MERCHANT_EMAIL, password: DEMO_MERCHANT_PASSWORD },
    });
    assert.equal(login.status, 200, JSON.stringify(login.payload));
    merchantToken = login.payload.accessToken;
    summary.demoLogin = { status: 404, note: "route not registered" };
  }

  // The session is an ordinary merchant session: it reads the seeded store…
  const dashboard = await request(`/merchant/stores/${DEMO_STORE_SLUG}/dashboard`, {
    token: merchantToken,
  });
  assert.equal(dashboard.status, 200, JSON.stringify(dashboard.payload));
  const orders = await request(`/merchant/stores/${DEMO_STORE_SLUG}/orders`, {
    token: merchantToken,
  });
  assert.equal(orders.status, 200);
  assert.equal(
    orders.payload.orders.length,
    15,
    "the seeded orders are visible to the demo merchant"
  );
  const products = await request(`/merchant/stores/${DEMO_STORE_SLUG}/catalog/products`, {
    token: merchantToken,
  });
  assert.equal(products.payload.products.length, 12);

  // …and nothing else. A store belonging to another merchant stays closed.
  const foreignMerchant = await prisma.merchant.create({
    data: {
      email: "foreign.demo-suite@codiq.iq",
      passwordHash: "$2a$12$0000000000000000000000000000000000000000000000000000",
      businessName: "تاجر آخر",
    },
    select: { id: true },
  });
  await prisma.store.create({
    data: {
      merchantId: foreignMerchant.id,
      name: "متجر آخر",
      slug: "foreign-demo-suite",
      defaultSubdomain: "foreign-demo-suite",
    },
  });
  const foreign = await request("/merchant/stores/foreign-demo-suite/dashboard", {
    token: merchantToken,
  });
  assert.equal(foreign.status, 403);
  assert.equal(
    foreign.payload.error.code,
    "STORE_BOUNDARY_DENIED",
    "the demo session is scoped to the seeded store only"
  );
  summary.sessionScope = {
    seededStore: 200,
    foreignStore: "403 STORE_BOUNDARY_DENIED",
    orders: 15,
    products: 12,
  };

  // ---------- 5. merchant routes registered inside routes/platform.ts ----------
  // These share the file with the owner routes but not the /platform prefix; the
  // guard must never touch them.
  for (const path of [
    "/merchant/subscription",
    "/merchant/finance/report",
    "/merchant/finance/settlements",
  ]) {
    const result = await request(path, { token: merchantToken });
    assert.equal(
      result.status,
      200,
      `${path} must stay open to the merchant in both phases: ${JSON.stringify(result.payload)}`
    );
  }
  const health = await request("/health");
  assert.equal(health.status, 200, "the health probe is never blocked");
  summary.merchantSurfaceIntact = true;

  // ---------- 6. the two assertDemoWritable call sites ----------
  const rename = await request(`/merchant/stores/${DEMO_STORE_SLUG}`, {
    method: "PATCH",
    token: merchantToken,
    body: { name: "اسم غيّره زائر" },
  });
  const team = await request(`/merchant/stores/${DEMO_STORE_SLUG}/team`, { token: merchantToken });
  assert.equal(team.status, 200, JSON.stringify(team.payload));
  const seededMembership = team.payload.team.find(
    (member) => member.staff.email === DEMO_STAFF_EMAIL
  );
  assert.ok(seededMembership, "the seeded staff member exists");
  const disableSeeded = await request(
    `/merchant/stores/${DEMO_STORE_SLUG}/team/${seededMembership.id}`,
    { method: "PATCH", token: merchantToken, body: { isActive: false } }
  );

  // A store and a staff member the "visitor" created — the guard must let these through.
  const ownStore = await request("/merchant/stores", {
    method: "POST",
    token: merchantToken,
    body: { name: "متجر أنشأه الزائر", slug: "visitor-store-demo-suite" },
  });
  assert.equal(ownStore.status, 201, JSON.stringify(ownStore.payload));
  // Creating a store re-binds the session COOKIE, not this bearer token, so the
  // rename below runs on a fresh session bound to the newly created store.
  const visitorLogin = await request("/auth/merchant/login", {
    method: "POST",
    body: { identifier: DEMO_MERCHANT_EMAIL, password: DEMO_MERCHANT_PASSWORD },
  });
  assert.equal(visitorLogin.status, 200, JSON.stringify(visitorLogin.payload));
  // P27-21: the visitor now owns the seeded demo store AND the one he just
  // created, so sign-in binds him to the seeded (older) one. Reaching the new
  // store is a switch — the same two steps the merchant takes in the interface.
  const visitorSwitch = await request("/merchant/stores/switch", {
    method: "POST",
    token: visitorLogin.payload.accessToken,
    body: { storeSlug: "visitor-store-demo-suite" },
  });
  assert.equal(
    visitorSwitch.status,
    200,
    `the visitor may switch to the store he created: ${JSON.stringify(visitorSwitch.payload)}`
  );
  const renameOwn = await request("/merchant/stores/visitor-store-demo-suite", {
    method: "PATCH",
    token: visitorSwitch.payload.accessToken,
    body: { name: "اسم جديد للمتجر الجديد" },
  });
  assert.equal(
    renameOwn.status,
    200,
    `a store the visitor created must always rename: ${JSON.stringify(renameOwn.payload)}`
  );

  const newStaff = await request(`/merchant/stores/${DEMO_STORE_SLUG}/team`, {
    method: "POST",
    token: merchantToken,
    body: {
      email: "added.demo-suite@codiq.iq",
      displayName: "موظف أضافه الزائر",
      temporaryPassword: "VisitorStaff2026!",
      roleCode: "store_staff",
    },
  });
  assert.equal(newStaff.status, 201, JSON.stringify(newStaff.payload));
  const disableNew = await request(
    `/merchant/stores/${DEMO_STORE_SLUG}/team/${newStaff.payload.membership.id}`,
    { method: "PATCH", token: merchantToken, body: { isActive: false } }
  );
  assert.equal(
    disableNew.status,
    200,
    `a staff member the visitor added must always be manageable: ${JSON.stringify(disableNew.payload)}`
  );

  if (demoOn) {
    assert.equal(rename.status, 403, JSON.stringify(rename.payload));
    assert.equal(rename.payload.error.code, "DEMO_READ_ONLY");
    assert.ok(
      /متجر النسخة التجريبية/.test(rename.payload.error.message),
      "the refusal is Arabic and explains itself"
    );
    assert.equal(
      (await prisma.store.findUnique({ where: { slug: DEMO_STORE_SLUG }, select: { name: true } }))
        .name,
      "متجر رواء",
      "the seeded name survived the attempt"
    );
    assert.equal(disableSeeded.status, 403, JSON.stringify(disableSeeded.payload));
    assert.equal(disableSeeded.payload.error.code, "DEMO_READ_ONLY");
    assert.equal(
      (
        await prisma.storeStaffMembership.findUnique({
          where: { id: seededMembership.id },
          select: { isActive: true },
        })
      ).isActive,
      true,
      "the seeded staff login survived the attempt"
    );
  } else {
    assert.equal(
      rename.status,
      200,
      `renaming is untouched outside demo mode: ${JSON.stringify(rename.payload)}`
    );
    assert.equal(rename.payload.store.name, "اسم غيّره زائر");
    assert.equal(
      disableSeeded.status,
      200,
      `disabling a membership is untouched outside demo mode: ${JSON.stringify(disableSeeded.payload)}`
    );
    assert.equal(disableSeeded.payload.membership.isActive, false);
  }
  summary.demoWritableGuard = {
    seededStoreRename: rename.status,
    seededStaffDisable: disableSeeded.status,
    visitorStoreRename: renameOwn.status,
    visitorStaffDisable: disableNew.status,
  };

  // ---------- 7. notifications ----------
  assert.equal(
    isEmailProviderConfigured(),
    !demoOn,
    "the demo reports no email provider even with SMTP configured"
  );
  const provider = resolveNotificationProvider();
  if (demoOn) {
    assert.equal(
      provider,
      null,
      "SMTP host + from are set, and the demo still resolves to no provider"
    );
    const store = await prisma.store.findUniqueOrThrow({
      where: { slug: DEMO_STORE_SLUG },
      select: { id: true },
    });
    await prisma.notificationOutbox.create({
      data: {
        storeId: store.id,
        eventType: "order.created",
        recipientKind: "merchant",
        channel: "email",
        recipient: "prospect@example.com",
        payload: { orderNumber: "DMO-1015", storeName: "متجر رواء" },
        dedupeKey: "demo-suite-outbox",
      },
    });
    const batch = await processOutboxBatch(provider);
    assert.equal(batch.skipped, 1, JSON.stringify(batch));
    assert.equal(batch.sent, 0);
    const row = await prisma.notificationOutbox.findFirstOrThrow({
      where: { dedupeKey: "demo-suite-outbox" },
      select: { status: true, lastOutcome: true, sentAt: true },
    });
    assert.deepEqual(
      { status: row.status, lastOutcome: row.lastOutcome, sentAt: row.sentAt },
      { status: "skipped", lastOutcome: "no_provider_configured", sentAt: null }
    );
    summary.notifications = { provider: null, outbox: "skipped:no_provider_configured" };
  } else {
    assert.ok(provider, "SMTP configuration still produces a real provider outside demo mode");
    assert.equal(provider.name, "smtp-email");
    summary.notifications = { provider: provider.name };
  }

  // ---------- 8. guest-entry rate limit (demo phase only) ----------
  if (demoOn) {
    await prisma.storefrontRateLimit.deleteMany({});
    let limited = null;
    for (let attempt = 0; attempt < 40 && limited === null; attempt += 1) {
      const result = await request("/public/demo-login", { method: "POST", body: {} });
      if (result.status === 429)
        limited = { attempt: attempt + 1, code: result.payload?.error?.code };
    }
    assert.ok(limited, "the guest-entry endpoint must be rate limited");
    assert.equal(limited.code, "RATE_LIMITED");
    assert.equal(
      limited.attempt,
      31,
      "the documented budget is 30 guest sessions per IP per 10 minutes"
    );
    summary.demoLoginRateLimit = limited;
  }

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
}
