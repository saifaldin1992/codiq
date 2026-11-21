import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { Client } from "pg";
import { createApp } from "../src/http/app.js";
import { config } from "../src/config.js";
import { prisma } from "../src/db/prisma.js";
import { createStoreFoundation } from "../src/services/store-bootstrap.service.js";
import { assertSafeTestDatabaseUrl } from "./helpers/test-database-guard.js";
import { assertNoEnumerationOracle } from "./helpers/login-timing.js";

const port = 3101;
const baseUrl = `http://127.0.0.1:${port}`;

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  return { response, body: (await response.json()) as any };
}

async function run() {
  const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
  if (
    process.env.DATABASE_URL !== testDatabaseUrl ||
    process.env.CODIQ_POSTGRES_URL !== testDatabaseUrl
  )
    throw new Error(
      "Refusing TRUNCATE: runtime database variables must both equal CODIQ_TEST_DATABASE_URL."
    );
  await prisma.$executeRawUnsafe(
    "TRUNCATE TABLE storefront_rate_limits, settlements, ledger_entries, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders CASCADE"
  );
  await prisma.customerSession.deleteMany();
  await prisma.merchantSession.deleteMany();
  await prisma.platformOwnerSession.deleteMany();
  await prisma.staffSession.deleteMany();
  await prisma.staffMembershipPermissionOverride.deleteMany();
  await prisma.storeStaffMembership.deleteMany();
  await prisma.staff.deleteMany();
  await prisma.merchantSubscription.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.deliveryRate.deleteMany();
  await prisma.notificationSettings.deleteMany();
  await prisma.paymentMethod.deleteMany();
  await prisma.store.deleteMany();
  await prisma.merchant.deleteMany();
  await prisma.platformOwner.deleteMany();

  const server = createApp().listen(port);
  try {
    const removedRegisterAlias = await fetch(`${baseUrl}/stores/store-a/account/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const removedLoginAlias = await fetch(`${baseUrl}/stores/store-a/account/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(removedRegisterAlias.status, 404);
    assert.equal(removedLoginAlias.status, 404);

    const ownerRegistration = await request("/auth/platform/register", {
      method: "POST",
      body: JSON.stringify({
        email: "owner.phase1@codiq.test",
        password: "owner-phase1-password",
        displayName: "Phase One Owner",
      }),
    });
    assert.equal(ownerRegistration.response.status, 201);

    const merchantRegistration = await registerMerchantDirect({
      ownerName: "صاحب المتجر",
      phone: "+9647100033101",
      email: "merchant.phase1@codiq.test",
      password: "merchant-phase1-password",
      businessName: "Phase One Merchant",
    });
    assert.equal(merchantRegistration.response.status, 201);
    const storeA = await createStoreFoundation({
      merchantId: merchantRegistration.body.account.id,
      name: "Store A",
      slug: "store-a",
      defaultSubdomain: "store-a",
    });
    const storeB = await createStoreFoundation({
      merchantId: merchantRegistration.body.account.id,
      name: "Store B",
      slug: "store-b",
      defaultSubdomain: "store-b",
    });
    const storefrontProduct = await prisma.product.create({
      data: {
        storeId: storeA.id,
        sku: "PHASE1-STOREFRONT",
        name: "Storefront Test Product",
        priceIqd: 1000,
        stockQuantity: 2,
        lowStockThreshold: 1,
      },
    });
    const [paymentMethods, notificationSettings, deliveryRates] = await Promise.all([
      prisma.paymentMethod.findMany({ where: { storeId: storeA.id }, orderBy: { code: "asc" } }),
      prisma.notificationSettings.findUnique({ where: { storeId: storeA.id } }),
      prisma.deliveryRate.count({ where: { storeId: storeA.id } }),
    ]);
    assert.equal(storeA.customDomain, null);
    // ق-209: lowercase, cash only — the never-enableable card row is gone; a gateway arrives with 25أ as a real switch.
    assert.deepEqual(
      paymentMethods.map((method) => [method.code, method.isEnabled]),
      [["cod", true]]
    );
    assert.equal(notificationSettings?.apiKey, null);
    assert.equal(notificationSettings?.isEnabled, false);
    assert.equal(deliveryRates, 18);

    const ownerLogin = await request("/auth/platform/login", {
      method: "POST",
      body: JSON.stringify({ email: "owner.phase1@codiq.test", password: "owner-phase1-password" }),
    });
    assert.equal(ownerLogin.response.status, 200);
    assert.equal(ownerLogin.body.redirectTo, "/platform/dashboard");
    const ownerDashboard = await request("/platform/dashboard", {
      headers: { authorization: `Bearer ${ownerLogin.body.accessToken}` },
    });
    assert.equal(ownerDashboard.response.status, 200);
    assert.equal(ownerDashboard.body.area, "platform_owner");

    const directDatabaseClient = new Client({ connectionString: config.databaseUrl });
    await directDatabaseClient.connect();
    let databaseTriggerResult: { code?: string; message?: string } = {};
    let staffTriggerResult: { code?: string; message?: string } = {};
    try {
      await directDatabaseClient.query(
        "INSERT INTO merchants (email, password_hash, business_name) VALUES ($1, $2, $3)",
        ["owner.phase1@codiq.test", "not-a-real-password", "Direct SQL Bypass Attempt"]
      );
      assert.fail("The PostgreSQL Trigger should have rejected this direct INSERT.");
    } catch (error: any) {
      databaseTriggerResult = { code: error.code, message: error.message };
      assert.equal(error.code, "23505");
      assert.match(error.message, /CODIQ_EMAIL_CONFLICT/);
    }
    try {
      // Phase 14: the same guard now also refuses a staff identity that reuses an owner/merchant email.
      await directDatabaseClient.query(
        "INSERT INTO staff (email, password_hash, display_name) VALUES ($1, $2, $3)",
        ["owner.phase1@codiq.test", "not-a-real-password", "Direct Staff Bypass Attempt"]
      );
      assert.fail("The PostgreSQL Trigger should have rejected this direct staff INSERT.");
    } catch (error: any) {
      staffTriggerResult = { code: error.code, message: error.message };
      assert.equal(error.code, "23505");
      assert.match(error.message, /CODIQ_EMAIL_CONFLICT/);
    } finally {
      await directDatabaseClient.end();
    }

    // =====================================================================
    // P27-12 + P27-21 — the guards the tenth review proved were MISSING.
    //
    // It copied the branch, injected three surgical mutations — killed the
    // `07…` sign-in path, removed the owner-name guard, deleted the duplicate
    // phone check — and ran ELEVEN blocking suites. All eleven stayed green.
    // The headline of the whole batch could have died in silence while CI
    // reported success. Moving 108 call sites is not testing a feature.
    // =====================================================================

    // The local form is the one an Iraqi actually types. If only +964… worked,
    // the feature would be a footnote rather than a feature.
    const localFormLogin = await request("/auth/merchant/login", {
      method: "POST",
      body: JSON.stringify({ identifier: "07100033101", password: "merchant-phase1-password" }),
    });
    assert.equal(
      localFormLogin.response.status,
      200,
      `P27-21: signing in with the LOCAL 07… form must work — ${JSON.stringify(localFormLogin.body)}`
    );
    assert.equal(localFormLogin.body.storeCount, 2);
    const e164Login = await request("/auth/merchant/login", {
      method: "POST",
      body: JSON.stringify({ identifier: "+9647100033101", password: "merchant-phase1-password" }),
    });
    assert.equal(
      e164Login.response.status,
      200,
      "P27-21: …and so must the +964 form, since both normalise to one number"
    );

    // A wrong password on a REAL phone must be indistinguishable from an
    // unknown one: with one public door, any difference is an oracle.
    const wrongPassword = await request("/auth/merchant/login", {
      method: "POST",
      body: JSON.stringify({ identifier: "07100033101", password: "definitely-not-it" }),
    });
    const unknownPhone = await request("/auth/merchant/login", {
      method: "POST",
      body: JSON.stringify({ identifier: "07709999999", password: "definitely-not-it" }),
    });
    assert.equal(wrongPassword.response.status, 401);
    // D-41 (24-أ): every error body now also carries `requestId`, so the two
    // answers differ in that ONE field and in no other. The field is compared
    // separately rather than skipped: it is random per request and independent
    // of the identifier, which is exactly what makes it useless as an oracle —
    // and asserting that the two ids DIFFER is what proves it is per-request
    // noise rather than something derived from the account.
    const answerWithoutId = (body: any) => ({
      ...body,
      error: { ...body.error, requestId: undefined },
    });
    assert.deepEqual(
      answerWithoutId(wrongPassword.body),
      answerWithoutId(unknownPhone.body),
      "P27-21: a registered phone and an unknown one answer IDENTICALLY — otherwise the door enumerates merchants"
    );
    assert.match(
      wrongPassword.body.error.requestId,
      /^[0-9a-f]{16}$/,
      "D-41: the answer names the request the merchant can quote"
    );
    assert.notEqual(
      wrongPassword.body.error.requestId,
      unknownPhone.body.error.requestId,
      "D-41: …and that id is per-request noise, never derived from the identifier"
    );

    // A malformed identifier is a shape error, decided before any lookup.
    const malformed = await request("/auth/merchant/login", {
      method: "POST",
      body: JSON.stringify({ identifier: "not-an-identifier", password: "x" }),
    });
    assert.equal(malformed.response.status, 400);
    assert.equal(malformed.body.error.code, "INVALID_MERCHANT_IDENTIFIER");

    // P27-12: the two new fields are REQUIRED, and the phone is unique across
    // the platform — the mutation run deleted both guards unnoticed.
    const missingOwnerName = await registerMerchantDirect({
      email: "no.owner.name@codiq.test",
      password: "phase1-owner-name-pass",
      businessName: "بلا اسم شخصي",
      phone: "07701555777",
    });
    assert.equal(
      missingOwnerName.response.status,
      422,
      "P27-12: a personal name is required — «متجر النور» does not answer a phone"
    );
    assert.equal(missingOwnerName.body.error.code, "INVALID_OWNER_NAME");
    const missingPhone = await registerMerchantDirect({
      email: "no.phone@codiq.test",
      password: "phase1-no-phone-pass",
      businessName: "بلا هاتف",
      ownerName: "صاحب بلا هاتف",
    });
    assert.equal(missingPhone.response.status, 422);
    assert.equal(missingPhone.body.error.code, "INVALID_MERCHANT_PHONE");
    const landline = await registerMerchantDirect({
      email: "landline@codiq.test",
      password: "phase1-landline-pass",
      businessName: "أرضي",
      ownerName: "صاحب أرضي",
      phone: "017184000",
    });
    assert.equal(
      landline.response.status,
      422,
      "P27-12: a landline is refused — this number is a cash-on-delivery channel"
    );

    // The duplicate, both sequentially AND as a race. The race is what proves
    // the partial index is the real guarantee rather than the read-before-write,
    // and it is the path that used to answer with a CUSTOMER's English message.
    const duplicateSequential = await registerMerchantDirect({
      email: "duplicate.phone@codiq.test",
      password: "phase1-duplicate-pass",
      businessName: "رقم مكرر",
      ownerName: "صاحب مكرر",
      phone: "07100033101",
    });
    assert.equal(
      duplicateSequential.response.status,
      409,
      "P27-12: the phone is unique across the PLATFORM, not per store"
    );
    assert.equal(duplicateSequential.body.error.code, "DUPLICATE_MERCHANT_PHONE");
    assert.ok(
      /[؀-ۿ]/.test(duplicateSequential.body.error.message),
      "P27-12: …and says so in Arabic, not in a customer's English sentence about «this store»"
    );

    // The register throttle added for ع-5 is 6 per ten minutes, and the refusals
    // above legitimately spent it. This block is about REGISTRATION semantics,
    // not about the throttle, so the bucket is cleared rather than the limit
    // raised — raising it to make a test pass would be weakening a real guard.
    await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits");
    const racers = await Promise.all(
      [1, 2].map((n) =>
        registerMerchantDirect({
          email: `race.phone.${n}@codiq.test`,
          password: "phase1-race-pass-value",
          businessName: `سباق ${n}`,
          ownerName: "صاحب السباق",
          phone: "07701555222",
        })
      )
    );
    const created = racers.filter((r) => r.response.status === 201);
    const refused = racers.filter((r) => r.response.status === 409);
    assert.equal(
      created.length,
      1,
      `P27-12: exactly one of two concurrent registrations wins — ${racers.map((r) => r.response.status).join(",")}`
    );
    assert.equal(refused.length, 1);
    assert.equal(
      refused[0].body.error.code,
      "DUPLICATE_MERCHANT_PHONE",
      `P27-12: the loser of the RACE gets the merchant message too — ${JSON.stringify(refused[0].body)}`
    );

    // A merchant whose stores are all deactivated gets a sentence he can act on
    // rather than the bare 404 the old door gave him.
    await prisma.store.updateMany({
      where: { merchant: { email: "merchant.phase1@codiq.test" } },
      data: { isActive: false },
    });
    const noActiveStore = await request("/auth/merchant/login", {
      method: "POST",
      body: JSON.stringify({
        identifier: "merchant.phase1@codiq.test",
        password: "merchant-phase1-password",
      }),
    });
    assert.equal(noActiveStore.response.status, 403);
    assert.equal(noActiveStore.body.error.code, "MERCHANT_NO_ACTIVE_STORE");
    assert.ok(
      noActiveStore.body.error.message.includes("تواصل"),
      "P27-21: …and it tells him what to do next"
    );
    await prisma.store.updateMany({
      where: { merchant: { email: "merchant.phase1@codiq.test" } },
      data: { isActive: true },
    });
    const merchantLogin = await request("/auth/merchant/login", {
      method: "POST",
      body: JSON.stringify({
        identifier: "merchant.phase1@codiq.test",
        password: "merchant-phase1-password",
      }),
    });
    assert.equal(merchantLogin.response.status, 200);
    // P27-21: this merchant owns TWO stores, so identity sign-in binds the
    // session to the oldest and opens the dashboard with the switcher already
    // open. Both halves are asserted — the redirect alone would not prove the
    // client is told WHY it was sent there.
    assert.equal(merchantLogin.body.redirectTo, "/merchant/stores/store-a/dashboard?stores=switch");
    assert.equal(merchantLogin.body.storeCount, 2);
    const merchantDashboard = await request("/merchant/stores/store-a/dashboard", {
      headers: { authorization: `Bearer ${merchantLogin.body.accessToken}` },
    });
    assert.equal(merchantDashboard.response.status, 200);
    assert.equal(merchantDashboard.body.area, "merchant");
    const merchantOtherStore = await request("/merchant/stores/store-b/dashboard", {
      headers: { authorization: `Bearer ${merchantLogin.body.accessToken}` },
    });
    assert.equal(merchantOtherStore.response.status, 403);
    assert.equal(merchantOtherStore.body.error.code, "STORE_BOUNDARY_DENIED");
    // Reaching the SECOND store is now the two-step path a real merchant walks:
    // sign in, then switch. That is a stronger test than the old one, which
    // minted a store-B session directly through a door that no longer exists.
    const merchantStoreBLogin = await request("/merchant/stores/switch", {
      method: "POST",
      headers: { authorization: `Bearer ${merchantLogin.body.accessToken}` },
      body: JSON.stringify({ storeSlug: "store-b" }),
    });
    assert.equal(merchantStoreBLogin.response.status, 200);
    assert.equal(merchantStoreBLogin.body.redirectTo, "/merchant/stores/store-b/dashboard");
    const merchantStoreBDashboard = await request("/merchant/stores/store-b/dashboard", {
      headers: { authorization: `Bearer ${merchantStoreBLogin.body.accessToken}` },
    });
    assert.equal(merchantStoreBDashboard.response.status, 200);
    const ownerAgainstMerchantArea = await request("/merchant/stores/store-a/dashboard", {
      headers: { authorization: `Bearer ${ownerLogin.body.accessToken}` },
    });
    assert.equal(ownerAgainstMerchantArea.response.status, 403);
    assert.equal(ownerAgainstMerchantArea.body.error.code, "IDENTITY_BOUNDARY_DENIED");
    const merchantAgainstOwnerArea = await request("/platform/dashboard", {
      headers: { authorization: `Bearer ${merchantLogin.body.accessToken}` },
    });
    assert.equal(merchantAgainstOwnerArea.response.status, 403);
    assert.equal(merchantAgainstOwnerArea.body.error.code, "IDENTITY_BOUNDARY_DENIED");

    const guestCart = await request("/store/store-a/cart/items", {
      method: "POST",
      body: JSON.stringify({ productId: storefrontProduct.id, quantity: 1 }),
    });
    assert.equal(guestCart.response.status, 200);
    const guestCookie = guestCart.response.headers
      .get("set-cookie")
      ?.match(/codiq_cart_store-a=[^;]+/)?.[0];
    assert.ok(guestCookie);
    const customerARegistration = await request("/store/store-a/account/register", {
      method: "POST",
      headers: { cookie: guestCookie },
      body: JSON.stringify({
        email: "same.customer@codiq.test",
        phone: "+9647700000001",
        password: "customer-phase1-password",
        fullName: "Store A Customer",
      }),
    });
    const duplicateCustomerInSameStore = await request("/store/store-a/account/register", {
      method: "POST",
      body: JSON.stringify({
        email: "another.customer@codiq.test",
        phone: "+9647700000001",
        password: "customer-phase1-password",
        fullName: "Duplicate Customer",
      }),
    });
    const customerBRegistration = await request("/store/store-b/account/register", {
      method: "POST",
      body: JSON.stringify({
        email: "same.customer@codiq.test",
        phone: "+9647700000001",
        password: "customer-phase1-password",
        fullName: "Store B Customer",
      }),
    });
    assert.equal(
      customerARegistration.response.status,
      201,
      JSON.stringify(customerARegistration.body)
    );
    assert.equal(customerARegistration.body.cart.items.length, 1);
    assert.match(
      customerARegistration.response.headers.get("set-cookie") ?? "",
      /codiq_customer_session_store-a=/
    );
    assert.equal(duplicateCustomerInSameStore.response.status, 409);
    assert.equal(duplicateCustomerInSameStore.body.error.code, "DUPLICATE_CUSTOMER_PHONE");
    assert.equal(customerBRegistration.response.status, 201);
    const customerALogin = await request("/store/store-a/account/login", {
      method: "POST",
      body: JSON.stringify({ phone: "+9647700000001", password: "customer-phase1-password" }),
    });
    assert.equal(customerALogin.response.status, 200);
    assert.match(
      customerALogin.response.headers.get("set-cookie") ?? "",
      /codiq_customer_session_store-a=/
    );
    const customerOwnStore = await request("/store/store-a/account", {
      headers: { authorization: `Bearer ${customerALogin.body.accessToken}` },
    });
    assert.equal(customerOwnStore.response.status, 200);
    const customerOtherStore = await request("/store/store-b/account", {
      headers: { authorization: `Bearer ${customerALogin.body.accessToken}` },
    });
    assert.equal(customerOtherStore.response.status, 403);
    assert.equal(customerOtherStore.body.error.code, "STORE_BOUNDARY_DENIED");

    const blockedConflict = await registerMerchantDirect({
      ownerName: "صاحب المتجر",
      phone: "+9647100033102",
      email: "owner.phase1@codiq.test",
      password: "another-phase1-password",
      businessName: "Should Be Rejected",
    });
    assert.equal(blockedConflict.response.status, 409);
    assert.equal(blockedConflict.body.error.code, "EMAIL_RESERVED_FOR_PLATFORM_OWNER");

    // =====================================================================
    // 19-د (ATTACK-SURFACE) — the CLOCK must not say what the status code
    // refuses to say.
    //
    // The `deepEqual(wrongPassword.body, unknownPhone.body)` assertion above
    // has stood since P27-21 and it is not enough on its own: it compares the
    // two ANSWERS and never the time taken to produce them. Four of the five
    // doors returned without running bcrypt when nobody matched, so «no such
    // account» came back in ~20 ms and «wrong password» in ~800 ms — a
    // difference a single request resolves. See helpers/login-timing.ts.
    //
    // The buckets are cleared first, deliberately: the customer door allows 12
    // attempts per ten minutes per address and this block spends ten. Clearing
    // is not hiding a limit — the limit has its own assertions elsewhere; it is
    // keeping THIS measurement from being a 429 latency measurement instead.
    // =====================================================================
    await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits");
    const wrongPasswordFor = (body: Record<string, unknown>, path: string) => () =>
      request(path, { method: "POST", body: JSON.stringify(body) });
    const doorTimings = {
      platformOwner: await assertNoEnumerationOracle("platform-owner door", {
        known: wrongPasswordFor(
          { email: "owner.phase1@codiq.test", password: "wrong-on-purpose" },
          "/auth/platform/login"
        ),
        unknown: wrongPasswordFor(
          { email: "nobody.phase1@codiq.test", password: "wrong-on-purpose" },
          "/auth/platform/login"
        ),
      }),
      merchant: await assertNoEnumerationOracle("merchant door", {
        known: wrongPasswordFor(
          { identifier: "07100033101", password: "wrong-on-purpose" },
          "/auth/merchant/login"
        ),
        unknown: wrongPasswordFor(
          { identifier: "07709999999", password: "wrong-on-purpose" },
          "/auth/merchant/login"
        ),
      }),
      customer: await assertNoEnumerationOracle("storefront customer door", {
        known: wrongPasswordFor(
          { phone: "+9647700000001", password: "wrong-on-purpose" },
          "/store/store-a/account/login"
        ),
        unknown: wrongPasswordFor(
          { phone: "+9647700999999", password: "wrong-on-purpose" },
          "/store/store-a/account/login"
        ),
      }),
    };
    // The measurement is only meaningful if both branches really answered 401.
    for (const [door, path, body] of [
      [
        "platformOwner",
        "/auth/platform/login",
        { email: "nobody.phase1@codiq.test", password: "wrong-on-purpose" },
      ],
      [
        "merchant",
        "/auth/merchant/login",
        { identifier: "07709999999", password: "wrong-on-purpose" },
      ],
      [
        "customer",
        "/store/store-a/account/login",
        { phone: "+9647700999999", password: "wrong-on-purpose" },
      ],
    ] as const) {
      const refusal = await request(path, { method: "POST", body: JSON.stringify(body) });
      assert.equal(
        refusal.response.status,
        401,
        `${door}: the unknown-identity probe must be a 401, not ${refusal.response.status} — ${JSON.stringify(refusal.body)}`
      );
    }
    await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits");

    console.log(
      JSON.stringify(
        {
          platformOwner: {
            email: ownerRegistration.body.account.email,
            redirectTo: ownerLogin.body.redirectTo,
            protectedArea: ownerDashboard.body.area,
          },
          merchant: {
            email: merchantRegistration.body.account.email,
            redirectTo: merchantLogin.body.redirectTo,
            protectedArea: merchantDashboard.body.area,
          },
          foundationReadiness: {
            customDomain: storeA.customDomain,
            paymentMethods: paymentMethods.map((method) => ({
              code: method.code,
              isEnabled: method.isEnabled,
            })),
            notificationApiKey: notificationSettings?.apiKey,
            notificationEnabled: notificationSettings?.isEnabled,
            deliveryRateRows: deliveryRates,
          },
          identityBoundary: {
            ownerToMerchantArea: ownerAgainstMerchantArea.body.error.code,
            merchantToOwnerArea: merchantAgainstOwnerArea.body.error.code,
          },
          merchantStoreBoundary: {
            storeASessionToStoreA: merchantDashboard.response.status,
            storeASessionToStoreB: merchantOtherStore.response.status,
            deniedCode: merchantOtherStore.body.error.code,
            separateStoreBSessionToStoreB: merchantStoreBDashboard.response.status,
          },
          customerPhoneUniqueness: {
            sameStoreDuplicateStatus: duplicateCustomerInSameStore.response.status,
            sameStoreDuplicateCode: duplicateCustomerInSameStore.body.error.code,
            differentStoreRegistrationStatus: customerBRegistration.response.status,
            mergedGuestCartItems: customerARegistration.body.cart.items.length,
          },
          customerStoreBoundary: {
            sameEmailCreatedInTwoStores: true,
            ownStoreStatus: customerOwnStore.response.status,
            otherStoreStatus: customerOtherStore.response.status,
            deniedCode: customerOtherStore.body.error.code,
          },
          removedCustomerAliases: {
            register: removedRegisterAlias.status,
            login: removedLoginAlias.status,
          },
          apiEmailConflict: {
            status: blockedConflict.response.status,
            code: blockedConflict.body.error.code,
            message: blockedConflict.body.error.message,
          },
          databaseTriggerConflict: databaseTriggerResult,
          staffDatabaseTriggerConflict: staffTriggerResult,
          enumerationOracle: doorTimings,
        },
        null,
        2
      )
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
