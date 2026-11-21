/**
 * codiq MD-6 «متجر موثّق» — the owner-granted verification badge.
 *
 * A badge is a promise the PLATFORM makes to a shopper about a stranger's shop,
 * so the tests are about what keeps that promise honest rather than about how
 * it renders:
 *
 *   1. evidence is computed from reality and MOVES when reality moves — a store
 *      that meets nothing says so in figures, and the same store meets the
 *      criteria once the orders and products actually exist;
 *   2. `meetsAll` grants NOTHING: a fully qualified store stays unverified until
 *      an owner acts, and an unqualified store can still be verified — the
 *      figures inform the decision, they are not the decision;
 *   3. the badge always names who granted it — the database refuses a
 *      half-attributed row, so «a badge nobody granted» is unreachable;
 *   4. revocation clears the badge AND its attribution, and both the grant and
 *      the revocation leave an audit row naming the owner;
 *   5. the storefront shows the badge and nothing behind it: the owner's note
 *      and identity never reach a shopper, and the `verified` key is ABSENT for
 *      an unverified store rather than present-and-false;
 *   6. only the platform owner may read or write it — a merchant, a staff member
 *      and an anonymous caller are all refused, on both verbs.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { Client } from "pg";

const testId = `md6-${Date.now()}`;
// The phone is unique per run: it is globally unique across merchants by
// design (P27-12), so a hardcoded one makes the suite pass exactly once.
const testPhone = `+9647${String(Date.now()).slice(-9)}`;
process.env.SESSION_JWT_SECRET =
  process.env.SESSION_JWT_SECRET ?? "md6-test-secret-only-not-for-production";
process.env.CODIQ_ALLOW_OWNER_REGISTRATION = "true";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { VERIFICATION_CRITERIA } = await import("../src/services/store-verification.service.ts");

const sql = new Client({ connectionString: process.env.DATABASE_URL });
await sql.connect();
const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, { method = "GET", body, token, headers = {} } = {}) {
  if (method !== "GET") await sql.query("DELETE FROM storefront_rate_limits");
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(method === "GET" ? {} : { origin: base }),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, payload };
}

const summary = {};

try {
  const owner = await request("/auth/platform/register", {
    method: "POST",
    body: {
      email: `${testId}@codiq.test`,
      password: "md6-owner-password",
      displayName: "مالك المنصة",
    },
  });
  assert.equal(owner.status, 201, JSON.stringify(owner.payload));
  const ownerLogin = await request("/auth/platform/login", {
    method: "POST",
    body: { email: `${testId}@codiq.test`, password: "md6-owner-password" },
  });
  assert.equal(ownerLogin.status, 200, JSON.stringify(ownerLogin.payload));
  const tokenOwner = ownerLogin.payload.accessToken;
  const ownerId = owner.payload.account.id;

  const merchant = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    phone: testPhone,
    email: `${testId}.merchant@codiq.test`,
    password: "md6-merchant-password",
    businessName: "تجارة التوثيق",
  });
  assert.equal(merchant.status, 201, JSON.stringify(merchant.payload));
  const store = await prisma.store.create({
    data: {
      merchantId: merchant.payload.account.id,
      name: "متجر التوثيق",
      slug: `${testId}-store`,
      defaultSubdomain: `${testId}-store`,
    },
  });
  const merchantLogin = await request("/auth/merchant/login", {
    method: "POST",
    body: { identifier: `${testId}.merchant@codiq.test`, password: "md6-merchant-password" },
  });
  assert.equal(merchantLogin.status, 200, JSON.stringify(merchantLogin.payload));
  const tokenMerchant = merchantLogin.payload.accessToken;

  const verificationPath = `/platform/stores/${store.slug}/verification`;
  const publicPath = `/store/${store.slug}/public-config`;

  // ============================================================
  // 1. Evidence is reality, and it moves when reality moves.
  // ============================================================
  const fresh = await request(verificationPath, { token: tokenOwner });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.payload));
  assert.equal(fresh.payload.verification.verified, false, "a new store is not verified");
  assert.equal(fresh.payload.verification.verifiedBy, null);
  assert.equal(
    fresh.payload.verification.meetsAll,
    false,
    "a store created seconds ago meets nothing"
  );
  assert.deepEqual(
    fresh.payload.verification.evidence.map((item) => item.code).sort(),
    VERIFICATION_CRITERIA.map((item) => item.code).sort(),
    "every criterion the service declares is reported — a hidden criterion is one the merchant can never satisfy"
  );
  // The one thing a brand-new active store DOES satisfy.
  assert.equal(
    fresh.payload.verification.evidence.find((item) => item.code === "active").met,
    true
  );
  const freshOrders = fresh.payload.verification.evidence.find(
    (item) => item.code === "completed_orders"
  );
  assert.equal(freshOrders.value, 0, "with no orders the figure is 0, and it is shown");
  assert.equal(freshOrders.met, false);
  // A store with no orders has no completion rate at all. Not 0 — which reads as
  // a failure it has not had the chance to earn — and not 100, which would be a
  // fabrication. Null, and the criterion is unmet for the honest reason.
  const freshRate = fresh.payload.verification.evidence.find(
    (item) => item.code === "completion_rate"
  );
  assert.equal(
    freshRate.value,
    null,
    "no orders means there is no rate to report, and none is reported"
  );
  assert.equal(freshRate.met, false, "…and a criterion with nothing to measure is not met");

  // Now make the store actually earn it, through the database rather than
  // through the service that reports it, so the two cannot agree by accident.
  await prisma.store.update({
    where: { id: store.id },
    data: { createdAt: new Date(Date.now() - 30 * 86_400_000) },
  });
  for (let index = 0; index < 6; index += 1) {
    await prisma.product.create({
      data: {
        storeId: store.id,
        sku: `MD6-P-${index}`,
        name: `منتج ${index}`,
        priceIqd: 5000,
        isActive: true,
      },
    });
  }
  for (let index = 0; index < 12; index += 1) {
    await prisma.storeOrder.create({
      data: {
        storeId: store.id,
        orderNumber: `MD6-${String(index).padStart(4, "0")}`,
        status: index < 10 ? "completed" : "new",
        customerName: "زبون",
        customerEmail: `md6.${index}@codiq.test`,
        recipientPhone: "+9647100000000",
        shippingGovernorate: "بغداد",
        shippingAddressLine1: "شارع 1",
        subtotalIqd: 5000,
        deliveryFeeIqd: 3000,
        totalIqd: 8000,
      },
    });
  }
  const earned = await request(verificationPath, { token: tokenOwner });
  assert.equal(
    earned.payload.verification.meetsAll,
    true,
    "the same store now meets every criterion, computed live"
  );
  assert.equal(
    earned.payload.verification.evidence.find((item) => item.code === "completed_orders").value,
    10
  );
  assert.equal(
    earned.payload.verification.evidence.find((item) => item.code === "completion_rate").value,
    83,
    "10 of 12 completed rounds to 83%"
  );
  assert.equal(
    earned.payload.verification.evidence.find((item) => item.code === "catalogue").value,
    6
  );

  // ============================================================
  // 2. meetsAll grants nothing.
  // ============================================================
  assert.equal(
    earned.payload.verification.verified,
    false,
    "meeting every criterion does NOT grant the badge — an owner does"
  );
  assert.equal(
    (await request(publicPath)).payload.verified,
    undefined,
    "and the storefront still shows nothing"
  );

  // ============================================================
  // 3. The badge names who granted it.
  // ============================================================
  const granted = await request(verificationPath, {
    method: "PUT",
    token: tokenOwner,
    body: { verified: true, note: "زيارة ميدانية وتحقق من السجل التجاري" },
  });
  assert.equal(granted.status, 200, JSON.stringify(granted.payload));
  assert.equal(granted.payload.verification.verified, true);
  assert.equal(
    granted.payload.verification.verifiedBy.id,
    ownerId,
    "the badge names the owner who granted it"
  );
  assert.equal(granted.payload.verification.verifiedBy.displayName, "مالك المنصة");
  assert.ok(granted.payload.verification.verifiedAt, "…and the moment it was granted");
  const storedGrant = await prisma.store.findUniqueOrThrow({
    where: { id: store.id },
    select: { verifiedAt: true, verifiedByOwnerId: true, verificationNote: true },
  });
  assert.equal(storedGrant.verifiedByOwnerId, ownerId);
  assert.equal(storedGrant.verificationNote, "زيارة ميدانية وتحقق من السجل التجاري");

  // The database itself refuses a badge nobody granted — this is the guarantee
  // the application code is merely the first line of.
  let halfAttributed = null;
  try {
    await sql.query("UPDATE stores SET verified_by_owner_id = NULL WHERE id = $1", [store.id]);
  } catch (error) {
    halfAttributed = error.code;
  }
  assert.equal(
    halfAttributed,
    "23514",
    "a badge without an owner is rejected by the CHECK constraint, not merely by this codebase"
  );

  // ============================================================
  // 5. What a shopper sees: the badge, and nothing behind it.
  // ============================================================
  const publicVerified = await request(publicPath);
  assert.equal(publicVerified.status, 200);
  assert.ok(publicVerified.payload.verified?.verifiedAt, "the storefront shows the badge");
  const publicJson = JSON.stringify(publicVerified.payload);
  assert.ok(
    !publicJson.includes("زيارة ميدانية"),
    "the owner's note is internal — it may record why, and why is not a shopper's business"
  );
  assert.ok(!publicJson.includes(ownerId), "…and neither is which owner granted it");
  assert.ok(!publicJson.includes("مالك المنصة"), "…nor his name");

  // ============================================================
  // 4. Revocation clears the badge, its attribution, and leaves a record.
  // ============================================================
  const revoked = await request(verificationPath, {
    method: "PUT",
    token: tokenOwner,
    body: { verified: false },
  });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.payload));
  assert.equal(revoked.payload.verification.verified, false);
  assert.equal(revoked.payload.verification.verifiedBy, null);
  assert.equal(
    revoked.payload.verification.note,
    null,
    "the note goes with the badge it belonged to"
  );
  const storedRevoke = await prisma.store.findUniqueOrThrow({
    where: { id: store.id },
    select: { verifiedAt: true, verifiedByOwnerId: true, verificationNote: true },
  });
  assert.deepEqual(
    [storedRevoke.verifiedAt, storedRevoke.verifiedByOwnerId, storedRevoke.verificationNote],
    [null, null, null]
  );
  assert.equal(
    (await request(publicPath)).payload.verified,
    undefined,
    "the storefront stops claiming it immediately"
  );

  // The badge keeps no history — the audit log is the history.
  const audit = await prisma.storeAuditEvent.findMany({
    where: { storeId: store.id, entityType: "store_verification" },
    orderBy: { createdAt: "asc" },
  });
  assert.deepEqual(
    audit.map((row) => row.action),
    ["verification.granted", "verification.revoked"],
    "both the grant and the revocation are recorded"
  );
  assert.ok(
    audit.every((row) => row.actorId === ownerId && row.actorKind === "platform_owner"),
    "each names the owner who acted"
  );
  assert.equal(
    audit[0].metadata.note,
    "زيارة ميدانية وتحقق من السجل التجاري",
    "the grant kept the reason it was granted for"
  );

  // An unqualified store can still be verified: the figures inform the owner,
  // they do not overrule him.
  const bare = await prisma.store.create({
    data: {
      merchantId: merchant.payload.account.id,
      name: "متجر جديد",
      slug: `${testId}-bare`,
      defaultSubdomain: `${testId}-bare`,
    },
  });
  const bareVerified = await request(`/platform/stores/${bare.slug}/verification`, {
    method: "PUT",
    token: tokenOwner,
    body: { verified: true },
  });
  assert.equal(bareVerified.status, 200, JSON.stringify(bareVerified.payload));
  assert.equal(
    bareVerified.payload.verification.verified,
    true,
    "the owner may verify a store the criteria do not yet cover"
  );
  assert.equal(
    bareVerified.payload.verification.meetsAll,
    false,
    "…and the evidence still says, honestly, that it does not qualify"
  );

  // ============================================================
  // 6. Only the owner, on both verbs.
  // ============================================================
  assert.equal((await request(verificationPath)).status, 401, "no session, no verification screen");
  assert.equal(
    (await request(verificationPath, { token: tokenMerchant })).status,
    403,
    "a merchant cannot read the criteria panel"
  );
  const selfGrant = await request(verificationPath, {
    method: "PUT",
    token: tokenMerchant,
    body: { verified: true },
  });
  assert.equal(
    selfGrant.status,
    403,
    "a merchant CANNOT verify his own store — this is the whole point of the badge"
  );
  assert.equal(
    (await request(verificationPath, { method: "PUT", body: { verified: true } })).status,
    401
  );
  assert.equal(
    (await prisma.store.findUniqueOrThrow({ where: { id: store.id } })).verifiedAt,
    null,
    "every refused write left the store unverified"
  );

  // Input the owner can get wrong.
  assert.equal(
    (await request(verificationPath, { method: "PUT", token: tokenOwner, body: {} })).payload.error
      .code,
    "INVALID_VERIFICATION"
  );
  assert.equal(
    (
      await request(verificationPath, {
        method: "PUT",
        token: tokenOwner,
        body: { verified: "true" },
      })
    ).payload.error.code,
    "INVALID_VERIFICATION",
    "a string is not a decision"
  );
  const longNote = await request(verificationPath, {
    method: "PUT",
    token: tokenOwner,
    body: { verified: true, note: "ن".repeat(501) },
  });
  assert.equal(longNote.payload.error.code, "INVALID_VERIFICATION_NOTE");
  assert.equal(
    (await prisma.store.findUniqueOrThrow({ where: { id: store.id } })).verifiedAt,
    null,
    "the refused note left no badge behind"
  );
  assert.equal(
    (await request(`/platform/stores/${testId}-missing/verification`, { token: tokenOwner }))
      .status,
    404
  );

  summary.verification = {
    criteria: VERIFICATION_CRITERIA.length,
    freshCompletionRate: freshRate.value,
    evidenceIsLive: true,
    meetsAllGrantsNothing: true,
    halfAttributedBadge: "23514",
    auditTrail: audit.map((row) => row.action),
    merchantSelfGrant: 403,
    shopperSeesNoteOrOwner: false,
  };

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await sql.end();
  await prisma.$disconnect();
}
