/**
 * ق-199 — «واجهة المتجر»: the merchant owns his shop's face, and the shopper sees it.
 *
 * Proves the one rule end to end: a field the merchant sets from his screen
 * reaches the shopper's `public-config` in the shape the storefront reads —
 * and nothing else does. Along the way: phones normalise to E.164, a social
 * handle that is a URL is refused, the announcement cannot be on with nothing
 * in it, each written policy has a public page and an unwritten one is a 404,
 * the logo is metered against the storage plan and can be removed, another
 * tenant sees none of it, and the support address becomes Reply-To on the
 * store's own customer mail (ق-184's second half).
 *
 * Run: pnpm storefront:config
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const testId = `sfc-${Date.now()}`;
const suffix = String(Date.now()).slice(-8);
process.env.CODIQ_ALLOW_OWNER_REGISTRATION = "true";
process.env.CODIQ_PUBLIC_BASE_URL = "https://demo.codiqos.test";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);

// ── an S3 the suite owns, exactly as the banner suite does ───────────────────
const { spawn } = await import("node:child_process");
const { CreateBucketCommand, S3Client } = await import("@aws-sdk/client-s3");
const { killTree } = await import("./helpers/child-process.mjs");
const bucket = `codiq-${testId}`;
const s3Port = 4573;
process.env.PRODUCT_S3_ENDPOINT = `http://127.0.0.1:${s3Port}`;
process.env.PRODUCT_S3_BUCKET = bucket;
process.env.PRODUCT_S3_ACCESS_KEY_ID = "S3RVER";
process.env.PRODUCT_S3_SECRET_ACCESS_KEY = "S3RVER";
process.env.PRODUCT_S3_REGION = "us-east-1";
process.env.PRODUCT_S3_FORCE_PATH_STYLE = "true";
const moto = spawn("moto_server", ["-H", "127.0.0.1", "-p", String(s3Port)], { stdio: "ignore" });
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    await fetch(`http://127.0.0.1:${s3Port}`);
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (attempt === 59) throw new Error("Moto S3-compatible test server did not start.");
}
await new S3Client({
  endpoint: process.env.PRODUCT_S3_ENDPOINT,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" },
}).send(new CreateBucketCommand({ Bucket: bucket }));

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { createTypedSession } = await import("../src/auth/identity.ts");
const { merchantUsage } = await import("../src/services/entitlement.service.ts");
const { processOutboxBatch } = await import("../src/notifications/outbox-worker.ts");
const { FakeNotificationProvider } = await import("./helpers/fake-notification-provider.ts");
const { HOME_SECTION_KEYS } = await import("../src/http/schemas/storefront-config.schema.ts");
await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits");

const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function request(path, { method = "GET", body, token, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      origin: base,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { status: response.status, payload, headers: response.headers };
}

async function uploadLogo(slug, token) {
  const form = new FormData();
  form.append("image", new Blob([PNG], { type: "image/png" }), "logo.png");
  const response = await fetch(`${base}/merchant/stores/${slug}/storefront/logo`, {
    method: "POST",
    headers: { origin: base, authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { status: response.status, payload };
}

const summary = {};
try {
  const merchantA = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    businessName: "متجر الواجهة",
    phone: `+96478${suffix}`,
    email: `${testId}.a@codiq.test`,
    password: "StorefrontOwner!2026",
  });
  assert.equal(merchantA.status, 201, JSON.stringify(merchantA.payload));
  const storeA = await prisma.store.create({
    data: {
      merchantId: merchantA.payload.account.id,
      name: "متجر الواجهة",
      slug: `${testId}-a`,
      defaultSubdomain: `${testId}-a`,
    },
  });
  const tokenA = await createTypedSession("merchant", merchantA.payload.account.id, storeA.id);
  const merchantB = await registerMerchantDirect({
    ownerName: "تاجر آخر",
    businessName: "متجر الجار",
    phone: `+96479${suffix}`,
    email: `${testId}.b@codiq.test`,
    password: "StorefrontNeighbour!2026",
  });
  const storeB = await prisma.store.create({
    data: {
      merchantId: merchantB.payload.account.id,
      name: "متجر الجار",
      slug: `${testId}-b`,
      defaultSubdomain: `${testId}-b`,
    },
  });
  const tokenB = await createTypedSession("merchant", merchantB.payload.account.id, storeB.id);
  const merchantPath = `/merchant/stores/${storeA.slug}/storefront`;

  // ── 1. the defaults say what a fresh store is ────────────────────────────
  const fresh = await request(merchantPath, { token: tokenA });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.payload));
  const defaults = fresh.payload.storefront;
  assert.equal(defaults.name, "متجر الواجهة");
  assert.equal(defaults.logo, null);
  assert.equal(defaults.announcementEnabled, false);
  assert.equal(
    defaults.guestCheckoutEnabled,
    true,
    "ق-199: registration is optional by default — the owner's instruction"
  );
  assert.deepEqual(
    defaults.homeSections.map((section) => section.key),
    [...HOME_SECTION_KEYS],
    "every section, in default order, before the merchant touched anything"
  );
  assert.ok(
    defaults.homeSections.every((section) => section.enabled && section.title !== undefined)
  );
  const freshPublic = await request(`/store/${storeA.slug}/public-config`);
  assert.equal(freshPublic.status, 200);
  assert.equal(
    freshPublic.payload.name,
    "متجر الواجهة",
    "ق-199: the shopper sees the NAME, not the slug"
  );
  for (const key of ["logoUrl", "announcement", "contact", "social", "policies", "headline"])
    assert.equal(
      key in freshPublic.payload,
      false,
      `${key} is ABSENT until there is something to say`
    );
  assert.equal(freshPublic.payload.guestCheckout, true);
  assert.equal(freshPublic.payload.homeSections.length, HOME_SECTION_KEYS.length - 0);
  summary.defaults = { guestCheckout: true, sections: defaults.homeSections.length };

  // ── 2. the merchant writes, one section at a time ─────────────────────────
  const identity = await request(merchantPath, {
    method: "PUT",
    token: tokenA,
    body: {
      name: "عطور الواجهة",
      headline: "عطور أصلية تصل بابك",
      subline: "توصيل لكل العراق — الدفع عند الاستلام",
    },
  });
  assert.equal(identity.status, 200, JSON.stringify(identity.payload));
  assert.equal(identity.payload.storefront.name, "عطور الواجهة");
  const announce = await request(merchantPath, {
    method: "PUT",
    token: tokenA,
    body: { announcementText: "توصيل مجاني لطلبات فوق ٥٠ ألف", announcementEnabled: true },
  });
  assert.equal(announce.status, 200, JSON.stringify(announce.payload));
  const contact = await request(merchantPath, {
    method: "PUT",
    token: tokenA,
    body: {
      supportEmail: "help@perfumes.iq",
      supportPhone: "07701234567",
      supportWhatsapp: "+9647801234567",
      addressLine: "شارع الكرادة، مقابل الجسر",
      city: "بغداد",
    },
  });
  assert.equal(contact.status, 200, JSON.stringify(contact.payload));
  assert.equal(
    contact.payload.storefront.supportPhone,
    "+9647701234567",
    "ق-199: a phone typed the Iraqi way is stored E.164"
  );
  const social = await request(merchantPath, {
    method: "PUT",
    token: tokenA,
    body: {
      socialInstagram: "@perfumes.iq",
      socialX: "perfumes_iq",
      socialFacebook: "",
      socialTiktok: null,
    },
  });
  assert.equal(social.status, 200, JSON.stringify(social.payload));
  assert.equal(
    social.payload.storefront.socialInstagram,
    "perfumes.iq",
    "a leading @ is forgiven, not stored"
  );
  assert.equal(social.payload.storefront.socialFacebook, null, '"" clears');
  const policies = await request(merchantPath, {
    method: "PUT",
    token: tokenA,
    body: {
      policyReturn: "الإرجاع خلال ٧ أيام بحالة المنتج الأصلية.",
      policyDelivery: "التوصيل خلال ٢–٤ أيام عمل.",
    },
  });
  assert.equal(policies.status, 200, JSON.stringify(policies.payload));
  const sections = await request(merchantPath, {
    method: "PUT",
    token: tokenA,
    body: {
      guestCheckoutEnabled: false,
      homeSections: [
        { key: "best_selling", enabled: true, title: "الأكثر طلباً" },
        { key: "reviews", enabled: false },
      ],
    },
  });
  assert.equal(sections.status, 200, JSON.stringify(sections.payload));
  assert.deepEqual(
    sections.payload.storefront.homeSections
      .slice(0, 2)
      .map((section) => [section.key, section.enabled, section.title]),
    [
      ["best_selling", true, "الأكثر طلباً"],
      ["reviews", false, "آراء العملاء"],
    ],
    "stored entries lead in their order; an untitled one keeps its default title"
  );
  assert.equal(
    sections.payload.storefront.homeSections.length,
    HOME_SECTION_KEYS.length,
    "…and every section the merchant never mentioned follows, on"
  );
  summary.written = ["identity", "announcement", "contact", "social", "policies", "sections"];

  // ── 3. …and the shopper sees exactly that, in the storefront's shape ──────
  const shop = await request(`/store/${storeA.slug}/public-config`);
  assert.equal(shop.status, 200);
  const config = shop.payload;
  assert.equal(config.name, "عطور الواجهة");
  assert.equal(config.headline, "عطور أصلية تصل بابك");
  assert.deepEqual(config.announcement, { text: "توصيل مجاني لطلبات فوق ٥٠ ألف" });
  assert.deepEqual(config.contact, {
    email: "help@perfumes.iq",
    phone: "+9647701234567",
    whatsapp: "+9647801234567",
    addressLine: "شارع الكرادة، مقابل الجسر",
    city: "بغداد",
  });
  assert.deepEqual(
    config.social,
    { instagram: "https://www.instagram.com/perfumes.iq", x: "https://x.com/perfumes_iq" },
    "ق-199: the prefix is the server's; the merchant only ever supplied a username"
  );
  assert.deepEqual(
    config.policies,
    ["return", "delivery"],
    "only the policies he wrote are announced"
  );
  assert.equal(config.guestCheckout, false);
  assert.ok(
    Array.isArray(config.paymentMethods),
    "the ENABLED payment methods, whatever they are — never a decorative logo row"
  );
  assert.deepEqual(
    config.homeSections.map((section) => section.key).includes("reviews"),
    false,
    "a section switched off is not sent to the shopper at all"
  );
  assert.equal(config.homeSections[0].title, "الأكثر طلباً");
  summary.publicMirrors = Object.keys(config).sort();

  // ── 4. the refusals that protect a shopper ────────────────────────────────
  const urlHandle = await request(merchantPath, {
    method: "PUT",
    token: tokenA,
    body: { socialInstagram: "https://instagram.com/perfumes.iq" },
  });
  assert.equal(
    urlHandle.status,
    422,
    "ق-199: a handle is a username, never a URL — the prefix is fixed in code so nothing can carry a scheme"
  );
  const badPhone = await request(merchantPath, {
    method: "PUT",
    token: tokenA,
    body: { supportPhone: "12345" },
  });
  assert.equal(badPhone.status, 422);
  assert.equal(badPhone.payload.error.code, "INVALID_SUPPORT_PHONE");
  await request(merchantPath, {
    method: "PUT",
    token: tokenA,
    body: { announcementEnabled: false, announcementText: "" },
  });
  const emptyStrip = await request(merchantPath, {
    method: "PUT",
    token: tokenA,
    body: { announcementEnabled: true },
  });
  assert.equal(emptyStrip.status, 422, "the strip cannot be switched on with nothing in it");
  assert.equal(emptyStrip.payload.error.code, "ANNOUNCEMENT_TEXT_REQUIRED");
  const nothing = await request(merchantPath, { method: "PUT", token: tokenA, body: {} });
  assert.equal(nothing.status, 422, "an empty PUT is a caller mistake worth naming");
  summary.refused = {
    urlHandle: 422,
    badPhone: "INVALID_SUPPORT_PHONE",
    emptyStrip: "ANNOUNCEMENT_TEXT_REQUIRED",
    emptyPut: 422,
  };

  // ── 5. each written policy has a page; an unwritten one is a 404 ──────────
  const returnPolicy = await request(`/store/${storeA.slug}/policies/return`);
  assert.equal(returnPolicy.status, 200, JSON.stringify(returnPolicy.payload));
  assert.equal(returnPolicy.payload.policy.title, "سياسة الإرجاع والاستبدال");
  assert.match(returnPolicy.payload.policy.body, /٧ أيام/);
  assert.equal(
    (await request(`/store/${storeA.slug}/policies/privacy`)).status,
    404,
    "he never wrote a privacy policy, so there is no page pretending he did"
  );
  assert.equal(
    (await request(`/store/${storeA.slug}/policies/refund`)).status,
    404,
    "an unknown kind is simply not found"
  );
  summary.policies = { return: 200, privacy: 404, unknown: 404 };

  // ── 6. the logo: uploaded, served, metered, replaced, removed ─────────────
  const usageBefore = (await merchantUsage(prisma, merchantA.payload.account.id))
    .max_image_storage_mb;
  const logo = await uploadLogo(storeA.slug, tokenA);
  assert.equal(logo.status, 200, JSON.stringify(logo.payload));
  assert.ok(
    logo.payload.storefront.logo?.url.includes(`/store/${storeA.slug}/logo?v=`),
    "the URL carries a version so the bytes may be cached as immutable"
  );
  const withLogo = await request(`/store/${storeA.slug}/public-config`);
  assert.equal(
    withLogo.payload.logoUrl,
    logo.payload.storefront.logo.url,
    "ق-199: the shopper is handed the same URL"
  );
  const bytes = await fetch(`${base}${withLogo.payload.logoUrl.replace(/^\/api/, "")}`);
  assert.equal(bytes.status, 200);
  assert.equal(bytes.headers.get("content-type"), "image/png");
  // Review batch 3, م-٤: the same picture, re-encoded without its EXIF — not the same bytes.
  const sharpCheck = (await import("sharp")).default;
  const servedMeta = await sharpCheck(Buffer.from(await bytes.arrayBuffer())).metadata();
  const sentMeta = await sharpCheck(PNG).metadata();
  assert.deepEqual(
    [servedMeta.format, servedMeta.width, servedMeta.height],
    [sentMeta.format, sentMeta.width, sentMeta.height],
    "the same picture comes back"
  );
  const usageAfter = (await merchantUsage(prisma, merchantA.payload.account.id))
    .max_image_storage_mb;
  assert.ok(
    usageAfter > usageBefore,
    `ق-199: the logo counts against the storage plan (before ${usageBefore}, after ${usageAfter}) — a charge against a meter that never moves is not a limit`
  );
  const firstKey = (
    await prisma.store.findUniqueOrThrow({
      where: { id: storeA.id },
      select: { logoObjectKey: true },
    })
  ).logoObjectKey;
  const replaced = await uploadLogo(storeA.slug, tokenA);
  assert.equal(replaced.status, 200);
  assert.notEqual(
    (
      await prisma.store.findUniqueOrThrow({
        where: { id: storeA.id },
        select: { logoObjectKey: true },
      })
    ).logoObjectKey,
    firstKey,
    "replacing is a new object under a new URL"
  );
  const removed = await request(`${merchantPath}/logo`, { method: "DELETE", token: tokenA });
  assert.equal(removed.status, 200, JSON.stringify(removed.payload));
  assert.equal(removed.payload.storefront.logo, null);
  assert.equal(
    "logoUrl" in (await request(`/store/${storeA.slug}/public-config`)).payload,
    false,
    "…and the shopper's payload drops the key"
  );
  assert.equal((await fetch(`${base}/store/${storeA.slug}/logo`)).status, 404);
  assert.equal(
    (await request(`${merchantPath}/logo`, { method: "DELETE", token: tokenA })).status,
    404,
    "deleting a logo that is not there is a 404, not a silent success"
  );
  summary.logo = { served: true, metered: true, replaced: true, removed: true };

  // ── 7. another tenant sees none of it ─────────────────────────────────────
  const neighbour = await request(`/merchant/stores/${storeB.slug}/storefront`, { token: tokenB });
  assert.equal(neighbour.status, 200);
  assert.equal(neighbour.payload.storefront.headline, null, "store B has its own, empty, face");
  assert.equal(neighbour.payload.storefront.supportEmail, null);
  const crossTenant = await request(merchantPath, {
    method: "PUT",
    token: tokenB,
    body: { headline: "اختراق" },
  });
  assert.ok(
    [403, 404].includes(crossTenant.status),
    `B's session cannot write A's face — got ${crossTenant.status}`
  );
  assert.equal(
    (await request(merchantPath, { token: tokenA })).payload.storefront.headline,
    "عطور أصلية تصل بابك",
    "…and A is untouched"
  );
  const neighbourPublic = await request(`/store/${storeB.slug}/public-config`);
  assert.equal(neighbourPublic.payload.name, "متجر الجار");
  assert.equal("contact" in neighbourPublic.payload, false);
  summary.tenantIsolation = true;

  // ── 8. ق-184's second half: the support address is Reply-To on customer mail ─
  await prisma.notificationSettings.upsert({
    where: { storeId: storeA.id },
    update: { isEnabled: true },
    create: { storeId: storeA.id, isEnabled: true },
  });
  const now = new Date(Date.now() + 1000);
  const mail = await prisma.notificationOutbox.create({
    data: {
      storeId: storeA.id,
      eventType: "order.created",
      recipientKind: "customer",
      channel: "email",
      recipient: `${testId}.shopper@example.com`,
      dedupeKey: `${testId}-reply-to`,
      payload: {
        storeName: "عطور الواجهة",
        orderNumber: "SFC-1",
        itemCount: 1,
        totalIqd: 25000,
        trackingUrl: `/store/${storeA.slug}/track`,
      },
    },
    select: { id: true },
  });
  const provider = new FakeNotificationProvider();
  await processOutboxBatch(provider, { now, batchSize: 50 });
  const sentMail = provider.sent.find((message) => message.to === `${testId}.shopper@example.com`);
  assert.ok(
    sentMail,
    `the order mail went out: ${JSON.stringify(await prisma.notificationOutbox.findUnique({ where: { id: mail.id }, select: { status: true, lastOutcome: true } }))}`
  );
  assert.equal(
    sentMail.replyTo,
    "help@perfumes.iq",
    "ق-184/ق-199: a shopper who replies to his confirmation reaches the SHOP, not the platform"
  );
  summary.replyTo = "store support email";

  // ── 9. ق-211 — the merchant's own footer pages, and the last two socials ──
  const pages = await request(merchantPath, {
    method: "PUT",
    token: tokenA,
    body: {
      customPages: [
        { slug: "about-us", title: "من نحن", body: "نحن متجر عطور في بغداد.\n\nنبيع الأصلي فقط." },
        {
          slug: "user-agreement",
          title: "اتفاقية المستخدم",
          body: "باستخدامك المتجر أنت توافق على شروطه.",
        },
      ],
      socialSnapchat: "@perfumes.iq",
      socialYoutube: "@PerfumesIQ",
    },
  });
  assert.equal(pages.status, 200, JSON.stringify(pages.payload));
  assert.deepEqual(
    pages.payload.storefront.customPages.map((page) => page.slug),
    ["about-us", "user-agreement"],
    "the pages are stored in the merchant's order"
  );
  assert.equal(
    pages.payload.storefront.socialSnapchat,
    "perfumes.iq",
    "ق-199's rule holds for the new handles: a leading @ is forgiven and stripped"
  );
  assert.equal(pages.payload.storefront.socialYoutube, "PerfumesIQ");

  const publicPages = await request(`/store/${storeA.slug}/public-config`);
  assert.deepEqual(
    publicPages.payload.pages,
    [
      { slug: "about-us", title: "من نحن" },
      { slug: "user-agreement", title: "اتفاقية المستخدم" },
    ],
    "the footer is handed the links, in order"
  );
  assert.equal(
    publicPages.payload.pages.some((page) => "body" in page),
    false,
    "ق-211: the BODIES stay out of the first request — six long pages would be sixty kilobytes nobody has clicked yet"
  );
  assert.equal(
    publicPages.payload.social.snapchat,
    "https://www.snapchat.com/add/perfumes.iq",
    "the prefix is fixed in code, so the stored value can never carry a scheme"
  );
  assert.equal(publicPages.payload.social.youtube, "https://www.youtube.com/@PerfumesIQ");

  const aboutPage = await request(`/store/${storeA.slug}/pages/about-us`);
  assert.equal(aboutPage.status, 200, JSON.stringify(aboutPage.payload));
  assert.equal(aboutPage.payload.page.title, "من نحن");
  assert.match(
    aboutPage.payload.page.body,
    /الأصلي فقط/,
    "…and the body arrives on the page's own route"
  );
  assert.equal(
    (await request(`/store/${storeA.slug}/pages/ABOUT-US`)).status,
    200,
    "the slug is case-insensitive in the URL, because people type addresses by hand"
  );
  assert.equal(
    (await request(`/store/${storeA.slug}/pages/nowhere`)).status,
    404,
    "a page the merchant never wrote is not found — there is no empty-page state"
  );
  assert.equal(
    (await request(`/store/${storeB.slug}/pages/about-us`)).status,
    404,
    "…and store B has none of A's pages"
  );

  const reserved = await request(merchantPath, {
    method: "PUT",
    token: tokenA,
    body: { customPages: [{ slug: "return", title: "إرجاع", body: "نص" }] },
  });
  assert.equal(
    reserved.status,
    422,
    "ق-211: a page whose slug shadows a policy is a trap for the merchant reading his own footer"
  );
  const duplicate = await request(merchantPath, {
    method: "PUT",
    token: tokenA,
    body: {
      customPages: [
        { slug: "faq", title: "أسئلة", body: "نص" },
        { slug: "faq", title: "أسئلة ٢", body: "نص" },
      ],
    },
  });
  assert.equal(duplicate.status, 422, "two pages cannot share one address");
  const arabicSlug = await request(merchantPath, {
    method: "PUT",
    token: tokenA,
    body: { customPages: [{ slug: "من-نحن", title: "من نحن", body: "نص" }] },
  });
  assert.equal(
    arabicSlug.status,
    422,
    "the slug is the URL: an Arabic one becomes forty characters of noise in the address bar, while the TITLE is free Arabic"
  );
  const tooMany = await request(merchantPath, {
    method: "PUT",
    token: tokenA,
    body: {
      customPages: Array.from({ length: 7 }, (unused, index) => ({
        slug: `page-${index}`,
        title: `صفحة ${index}`,
        body: "نص",
      })),
    },
  });
  assert.equal(tooMany.status, 422, "six pages is the ceiling");
  const stillThere = await request(`/store/${storeA.slug}/public-config`);
  assert.equal(
    stillThere.payload.pages.length,
    2,
    "…and every refusal left the two good pages exactly as they were"
  );

  const cleared = await request(merchantPath, {
    method: "PUT",
    token: tokenA,
    body: { customPages: [] },
  });
  assert.equal(cleared.status, 200);
  assert.equal(
    "pages" in (await request(`/store/${storeA.slug}/public-config`)).payload,
    false,
    "an empty list drops the key, like every other absent-unless-set field"
  );
  assert.equal(
    (await request(`/store/${storeA.slug}/pages/about-us`)).status,
    404,
    "…and the page goes with it"
  );
  summary.customPages = {
    stored: 2,
    publicLinksOnly: true,
    bodyOnItsOwnRoute: true,
    reservedSlug: 422,
    duplicate: 422,
    arabicSlug: 422,
    overSix: 422,
    cleared: true,
  };
  summary.socials = { snapchat: "prefix in code", youtube: "prefix in code" };

  console.log(JSON.stringify({ suite: "storefront-config", status: "passed", summary }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
  await killTree(moto);
}
