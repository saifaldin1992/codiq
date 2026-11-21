import assert from "node:assert/strict";
import { createServer } from "node:http";
import { prisma } from "../src/db/prisma.js";
import { createApp } from "../src/http/app.js";
import { WEB_SESSION_COOKIE } from "../src/http/session-cookie.js";
import { createTypedSession } from "../src/auth/identity.js";
import { assertSafeTestDatabaseUrl } from "./helpers/test-database-guard.js";

const port = 3111;
const base = `http://127.0.0.1:${port}`;

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return {
    status: response.status,
    body: await response.json(),
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
}

function bearer(accessToken: string) {
  return { authorization: `Bearer ${accessToken}` };
}

const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
if (
  process.env.DATABASE_URL !== testDatabaseUrl ||
  process.env.CODIQ_POSTGRES_URL !== testDatabaseUrl
)
  throw new Error(
    "Refusing TRUNCATE: runtime database variables must both equal CODIQ_TEST_DATABASE_URL."
  );
await prisma.$executeRawUnsafe(
  "TRUNCATE TABLE storefront_rate_limits, settlements, ledger_entries, order_status_events, order_items, store_orders CASCADE"
);
await prisma.orderItem.deleteMany();
await prisma.storeOrder.deleteMany();
await prisma.product.deleteMany();
await prisma.customerSession.deleteMany();
// Addresses reference customers, so they go first. Without this the suite
// passes only while it runs BEFORE any suite that creates one — an ordering
// dependency that holds in CI today by luck of the step order, and breaks the
// moment the list is reordered.
await prisma.customerAddress.deleteMany();
await prisma.customer.deleteMany();
await prisma.merchantSession.deleteMany();
await prisma.platformOwnerSession.deleteMany();
await prisma.staffSession.deleteMany();
await prisma.staffMembershipPermissionOverride.deleteMany();
await prisma.storeStaffMembership.deleteMany();
await prisma.staff.deleteMany();
await prisma.merchantSubscription.deleteMany();
await prisma.deliveryRate.deleteMany();
await prisma.paymentMethod.deleteMany();
await prisma.notificationSettings.deleteMany();
await prisma.store.deleteMany();
await prisma.merchant.deleteMany();
await prisma.platformOwner.deleteMany();

const server = createServer(createApp());
await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

try {
  const ownerRegistration = await request("/auth/platform/register", {
    method: "POST",
    body: JSON.stringify({
      email: "owner.phase6@codiq.test",
      password: "phase6-owner-password",
      displayName: "مالك المرحلة السادسة",
    }),
  });
  assert.equal(ownerRegistration.status, 201);
  const ownerLogin = await request("/auth/platform/login", {
    method: "POST",
    body: JSON.stringify({ email: "owner.phase6@codiq.test", password: "phase6-owner-password" }),
  });
  assert.equal(ownerLogin.status, 200);
  assert.ok(ownerLogin.cookie?.startsWith(`${WEB_SESSION_COOKIE}=`));
  const ownerToken = ownerLogin.body.accessToken as string;

  const merchantA = await request("/platform/merchants/manual", {
    method: "POST",
    headers: { cookie: ownerLogin.cookie! },
    body: JSON.stringify({
      ownerName: "صاحب المتجر",
      phone: "+9647100769601",
      businessName: "تاجر يدوي A",
      email: "manual.a.phase6@codiq.test",
      temporaryPassword: "phase6-merchant-a",
      firstStoreName: "متجر يدوي A",
    }),
  });
  assert.equal(merchantA.status, 201);
  assert.equal(merchantA.body.merchant.isActive, true);
  assert.equal(merchantA.body.store.merchantId, merchantA.body.merchant.id);
  const storeA = merchantA.body.store as { id: string; slug: string };

  const merchantB = await request("/platform/merchants/manual", {
    method: "POST",
    headers: { cookie: ownerLogin.cookie! },
    body: JSON.stringify({
      ownerName: "صاحب المتجر",
      phone: "+9647100769602",
      businessName: "تاجر يدوي B",
      email: "manual.b.phase6@codiq.test",
      temporaryPassword: "phase6-merchant-b",
      firstStoreName: "متجر يدوي B",
    }),
  });
  assert.equal(merchantB.status, 201);
  const storeB = merchantB.body.store as { id: string; slug: string };

  const ownerEmailConflict = await request("/platform/merchants/manual", {
    method: "POST",
    headers: { cookie: ownerLogin.cookie! },
    body: JSON.stringify({
      ownerName: "صاحب المتجر",
      phone: "+9647100769603",
      businessName: "تاجر متعارض",
      email: "owner.phase6@codiq.test",
      temporaryPassword: "phase6-conflict-password",
      firstStoreName: "متجر متعارض",
    }),
  });
  assert.equal(ownerEmailConflict.status, 409);
  assert.equal(ownerEmailConflict.body.error.code, "EMAIL_RESERVED_FOR_PLATFORM_OWNER");

  const loginA = await request("/auth/merchant/login", {
    method: "POST",
    body: JSON.stringify({
      identifier: "manual.a.phase6@codiq.test",
      password: "phase6-merchant-a",
    }),
  });
  const loginB = await request("/auth/merchant/login", {
    method: "POST",
    body: JSON.stringify({
      identifier: "manual.b.phase6@codiq.test",
      password: "phase6-merchant-b",
    }),
  });
  assert.equal(loginA.status, 200);
  assert.equal(loginB.status, 200);
  assert.ok(loginA.cookie?.startsWith(`${WEB_SESSION_COOKIE}=`));
  const merchantAToken = loginA.body.accessToken as string;
  const merchantBToken = loginB.body.accessToken as string;

  // ── ق-218 — the password the provisioner typed opens ONE door ─────────────
  //
  // Nothing ever made the «temporary» password temporary. The merchant got it
  // over WhatsApp and had no reason to change a credential nobody told him was
  // provisional, so whoever typed it kept a working key to a live merchant
  // account — every shopper's name, phone and address, the order export, the COD
  // settlement details — and the store's own audit log attributed all of it to
  // the merchant. Platform staff hold no permission code that opens a merchant
  // dashboard, so this was the one path that granted it, and B-09 makes it the
  // launch path: the first ten merchants are recruited by hand.
  assert.equal(loginA.body.mustChangePassword, true, "ق-218: the login says so plainly");
  assert.equal(
    loginA.body.redirectTo,
    "/merchant/dashboard/account/security",
    "…and sends him to the one screen that fixes it"
  );
  const gatedStoreRoute = await request(`/merchant/stores/${storeA.slug}/customers/manual`, {
    method: "POST",
    headers: bearer(merchantAToken),
    body: JSON.stringify({ fullName: "قبل التغيير", phone: "07700000077" }),
  });
  assert.equal(gatedStoreRoute.status, 403, JSON.stringify(gatedStoreRoute.body));
  assert.equal(
    gatedStoreRoute.body.error.code,
    "PASSWORD_CHANGE_REQUIRED",
    "ق-218: the guard almost every store route uses asks — not only requireMerchantStore"
  );
  const gatedListRoute = await request("/merchant/stores", { headers: bearer(merchantAToken) });
  assert.equal(
    gatedListRoute.status,
    403,
    "…and so does a merchant route with no store in its path"
  );
  assert.equal(gatedListRoute.body.error.code, "PASSWORD_CHANGE_REQUIRED");
  const gatedFinance = await request("/merchant/finance/wallet", {
    headers: bearer(merchantAToken),
  });
  assert.equal(
    gatedFinance.status,
    403,
    "…including the money surfaces, which is what the key was worth"
  );
  // ق-226: the shell's bootstrap probe is the ONE merchant route that stays open
  // to him — otherwise he would be bounced to a login he has already passed,
  // with no way to reach the screen that lifts the gate.
  const shellProbe = await request("/merchant/session", { headers: bearer(merchantAToken) });
  assert.equal(
    shellProbe.status,
    200,
    `ق-226: the shell can boot for a merchant who must change his password — ${JSON.stringify(shellProbe.body)}`
  );
  assert.equal(
    shellProbe.body.mustChangePassword,
    true,
    "…and it says so, which is how the shell knows to open «الأمان» instead of the dashboard"
  );
  assert.equal(shellProbe.body.merchant.email, "manual.a.phase6@codiq.test");
  assert.equal(shellProbe.body.store.slug, storeA.slug, "…and which store the session is bound to");

  const changed = await request("/auth/password", {
    method: "POST",
    headers: bearer(merchantAToken),
    body: JSON.stringify({
      currentPassword: "phase6-merchant-a",
      newPassword: "OwnedByTheMerchant!2026",
    }),
  });
  assert.equal(
    changed.status,
    200,
    `ق-218: the ONE door that must stay open — ${JSON.stringify(changed.body)}`
  );
  const afterChange = await request("/merchant/stores", { headers: bearer(merchantAToken) });
  assert.equal(
    afterChange.status,
    200,
    "ق-218: and the moment the password is his, the platform is his"
  );
  const merchantRow = await prisma.merchant.findUniqueOrThrow({
    where: { id: merchantA.body.merchant.id },
    select: { passwordSetByProvisionerAt: true },
  });
  assert.equal(
    merchantRow.passwordSetByProvisionerAt,
    null,
    "…the mark comes off in the same transaction as the hash"
  );
  const loginAfter = await request("/auth/merchant/login", {
    method: "POST",
    body: JSON.stringify({
      identifier: "manual.a.phase6@codiq.test",
      password: "OwnedByTheMerchant!2026",
    }),
  });
  assert.equal(loginAfter.status, 200);
  assert.equal(
    loginAfter.body.mustChangePassword,
    undefined,
    "…and the next sign-in is an ordinary one"
  );
  // Store B stays gated on purpose — its merchant never changed his — so every
  // assertion below that uses B's session is also asserting that the gate does
  // not leak across accounts.
  const changedB = await request("/auth/password", {
    method: "POST",
    headers: bearer(merchantBToken),
    body: JSON.stringify({
      currentPassword: "phase6-merchant-b",
      newPassword: "OwnedByTheOtherOne!2026",
    }),
  });
  assert.equal(changedB.status, 200, JSON.stringify(changedB.body));

  const customerA = await request(`/merchant/stores/${storeA.slug}/customers/manual`, {
    method: "POST",
    headers: { cookie: loginA.cookie! },
    body: JSON.stringify({
      fullName: "زبون يدوي A",
      email: "shared.customer.phase6@codiq.test",
      phone: "07700000001",
    }),
  });
  assert.equal(customerA.status, 201);
  assert.equal(customerA.body.customer.storeId, storeA.id);

  // ── ق-212 — a customer added by hand is a REAL row of the shop's own kind ──
  //
  // This service used to write the typed text into `phone` and nothing into
  // `phone_normalized`, which is the ONLY column the shopper's sign-in door
  // reads. Every row it made was an account that could never be signed into,
  // while the screen said «تم ربط الزبون بالمتجر» and the recovery flow would
  // mail the person a link that set a password he still could not use.
  assert.equal(
    customerA.body.customer.phoneNormalized,
    "+9647700000001",
    "ق-212: the number is stored in the shape the sign-in door reads"
  );
  assert.equal(
    customerA.body.customer.isGuest,
    true,
    "ق-212: no credential is minted for a row nobody will ever hold the password of — it is a guest row (ق-201), claimable by its own owner"
  );

  // The email is OPTIONAL, as it is on the storefront's own registration: most
  // COD shoppers have none, and inventing one per customer collides on its
  // second use and burns the address for the shopper who really owns it.
  const withoutEmail = await request(`/merchant/stores/${storeA.slug}/customers/manual`, {
    method: "POST",
    headers: { cookie: loginA.cookie! },
    body: JSON.stringify({ fullName: "زبون بلا بريد", phone: "07700000009" }),
  });
  assert.equal(withoutEmail.status, 201, JSON.stringify(withoutEmail.body));
  assert.equal(withoutEmail.body.customer.email, null);

  // A number already on the shop's books is refused BY NAME rather than merged
  // silently: two rows for one shopper split his loyalty balance and his ق-179
  // block, and both fail silently on a divided identity.
  const samePhone = await request(`/merchant/stores/${storeA.slug}/customers/manual`, {
    method: "POST",
    headers: { cookie: loginA.cookie! },
    body: JSON.stringify({ fullName: "نفس الرقم", phone: "+9647700000001" }),
  });
  assert.equal(samePhone.status, 409);
  assert.equal(samePhone.body.error.code, "CUSTOMER_PHONE_TAKEN");
  assert.match(
    samePhone.body.error.message,
    /زبون يدوي A/,
    "…and it names the holder, so the merchant knows where to look"
  );

  const nonsensePhone = await request(`/merchant/stores/${storeA.slug}/customers/manual`, {
    method: "POST",
    headers: { cookie: loginA.cookie! },
    body: JSON.stringify({ fullName: "رقم خاطئ", phone: "hello" }),
  });
  assert.equal(nonsensePhone.status, 400);
  assert.equal(
    nonsensePhone.body.error.code,
    "INVALID_PHONE",
    "the number a courier dials is validated, not accepted as free text"
  );

  // ق-212 made the hand-added customer a REAL row; ق-232 decides who may open
  // it. Registering with its number is refused: the address and email the shop
  // recorded are the shopper's, and a stranger who knows the number must not
  // become him by typing it. The row holds an email, so the refusal names
  // password recovery — the door where possessing that inbox is what is proved.
  // The merchant's own record survives untouched either way.
  const claimed = await request(`/store/${storeA.slug}/account/register`, {
    method: "POST",
    body: JSON.stringify({
      fullName: "زبون يدوي A",
      phone: "07700000001",
      password: "ClaimedByHimself!2026",
    }),
  });
  assert.equal(claimed.status, 409, JSON.stringify(claimed.body));
  assert.equal(
    claimed.body.error.code,
    "CUSTOMER_PHONE_UNVERIFIED",
    "ق-232: a hand-added row is never claimed by typing its number"
  );
  assert.match(
    claimed.body.error.message,
    /نسيت كلمة المرور/,
    "…and, because the shop recorded his email, he is pointed at recovery"
  );
  const signedIn = await request(`/store/${storeA.slug}/account/login`, {
    method: "POST",
    body: JSON.stringify({ phone: "07700000001", password: "ClaimedByHimself!2026" }),
  });
  assert.equal(
    signedIn.status,
    401,
    `ق-232: …and the password the caller chose opens nothing — ${JSON.stringify(signedIn.body)}`
  );
  const untouched = await prisma.customer.findUniqueOrThrow({
    where: { id: customerA.body.customer.id },
    select: { email: true, passwordHash: true, isGuest: true },
  });
  assert.deepEqual(
    untouched,
    { email: "shared.customer.phase6@codiq.test", passwordHash: null, isGuest: true },
    "ق-212/ق-232: the merchant's record of how to reach him is exactly as he wrote it"
  );

  const duplicateCustomerA = await request(`/merchant/stores/${storeA.slug}/customers/manual`, {
    method: "POST",
    headers: { cookie: loginA.cookie! },
    body: JSON.stringify({
      fullName: "زبون مكرر A",
      email: "shared.customer.phase6@codiq.test",
      phone: "07700000002",
    }),
  });
  assert.equal(duplicateCustomerA.status, 409);
  assert.equal(duplicateCustomerA.body.error.code, "DUPLICATE_IDENTITY");

  const customerB = await request(`/merchant/stores/${storeB.slug}/customers/manual`, {
    method: "POST",
    headers: { cookie: loginB.cookie! },
    body: JSON.stringify({
      fullName: "زبون يدوي B",
      email: "shared.customer.phase6@codiq.test",
      phone: "07700000003",
    }),
  });
  assert.equal(customerB.status, 201);
  assert.equal(customerB.body.customer.storeId, storeB.id);

  const productA = await prisma.product.create({
    data: { storeId: storeA.id, sku: "P6-A", name: "منتج يدوي A", priceIqd: 10000 },
  });
  const productB = await prisma.product.create({
    data: { storeId: storeB.id, sku: "P6-B", name: "منتج يدوي B", priceIqd: 12000 },
  });
  const orderB = await prisma.storeOrder.create({
    data: {
      storeId: storeB.id,
      orderNumber: "P6-B-ORDER",
      customerName: "زبون يدوي B",
      status: "new",
      totalIqd: 12000,
      items: {
        create: {
          productId: productB.id,
          productName: productB.name,
          quantity: 1,
          unitPriceIqd: 12000,
          lineTotalIqd: 12000,
        },
      },
    },
  });

  const slugIdorA = await request(`/merchant/stores/${storeB.slug}/products`, {
    headers: bearer(merchantAToken),
  });
  const resourceIdorA = await request(`/merchant/stores/${storeA.slug}/products/${productB.id}`, {
    headers: bearer(merchantAToken),
  });
  const orderIdorA = await request(`/merchant/stores/${storeA.slug}/orders/${orderB.id}`, {
    headers: bearer(merchantAToken),
  });
  assert.equal(slugIdorA.status, 403);
  assert.equal(slugIdorA.body.error.code, "STORE_BOUNDARY_DENIED");
  assert.equal(resourceIdorA.status, 404);
  assert.equal(resourceIdorA.body.error.code, "RESOURCE_NOT_FOUND");
  assert.equal(orderIdorA.status, 404);
  assert.equal(orderIdorA.body.error.code, "RESOURCE_NOT_FOUND");

  const customerAToken = await createTypedSession("customer", customerA.body.customer.id);
  const customerCrossStore = await request(`/stores/${storeB.slug}/account`, {
    headers: bearer(customerAToken),
  });
  assert.equal(customerCrossStore.status, 403);
  assert.equal(customerCrossStore.body.error.code, "STORE_BOUNDARY_DENIED");
  const merchantPlatform = await request("/platform/dashboard", {
    headers: bearer(merchantAToken),
  });
  assert.equal(merchantPlatform.status, 403);
  assert.equal(merchantPlatform.body.error.code, "IDENTITY_BOUNDARY_DENIED");

  const ownerCanSeeManualB = await request(
    `/platform/stores/${storeB.slug}/products/${productB.id}`,
    { headers: bearer(ownerToken) }
  );
  assert.equal(ownerCanSeeManualB.status, 200);

  console.log(
    JSON.stringify(
      {
        webSessions: {
          ownerCookie: Boolean(ownerLogin.cookie),
          merchantCookie: Boolean(loginA.cookie),
        },
        merchantCreation: {
          status: merchantA.status,
          merchantId: merchantA.body.merchant.id,
          storeSlug: storeA.slug,
          storeMerchantIdMatches: true,
        },
        ownerEmailConflict: {
          status: ownerEmailConflict.status,
          code: ownerEmailConflict.body.error.code,
        },
        customerCreation: { status: customerA.status, storeId: customerA.body.customer.storeId },
        duplicateCustomer: {
          status: duplicateCustomerA.status,
          code: duplicateCustomerA.body.error.code,
        },
        sameCustomerEmailOtherStore: {
          status: customerB.status,
          storeId: customerB.body.customer.storeId,
        },
        idor: {
          merchantSlug: { status: slugIdorA.status, code: slugIdorA.body.error.code },
          product: { status: resourceIdorA.status, code: resourceIdorA.body.error.code },
          order: { status: orderIdorA.status, code: orderIdorA.body.error.code },
          customer: { status: customerCrossStore.status, code: customerCrossStore.body.error.code },
          platform: { status: merchantPlatform.status, code: merchantPlatform.body.error.code },
        },
        ownerOversight: ownerCanSeeManualB.status,
        seededProductA: productA.id,
      },
      null,
      2
    )
  );
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
}
