/**
 * Marketplace M4 — the market shopper's account, over HTTP.
 *
 *   1. Sign-in by phone: a code is sent (through the provider, never in the
 *      response), the answer does not say whether the phone has an account, a
 *      second code within a minute is refused, a wrong code spends a try and
 *      says how many are left, five wrong tries end the code, an expired code
 *      is refused, a code works once, and the right code signs in (cookie +
 *      token) — creating the account the first time only.
 *   2. The session is a SHOPPER session: a store customer or merchant token is
 *      refused at /market/me, and signing out ends it.
 *   3. Profile: name, email, gender, interests (unknown category refused).
 *   4. Addresses: governorate→district enforced; the shopper's own phone needs
 *      no code, another phone needs one sent to THAT phone; the alternate phone
 *      must differ; first address is the default, one default at a time, and
 *      deleting the default promotes the next; another shopper's address is a
 *      404; the delivery quote reads the store's rate for the governorate.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

process.env.CODIQ_ALLOW_OWNER_REGISTRATION ??= "true";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL ?? process.env.DATABASE_URL);
const { prisma } = await import("../src/db/prisma.ts");
const { createApp } = await import("../src/http/app.ts");
const { setOtpProviderForTests, OTP_MAX_ATTEMPTS } = await import("../src/modules/market-account/otp.service.ts");

const sent = [];
setOtpProviderForTests({ name: "capture", async send(phone, code, purpose) { sent.push({ phone, code, purpose }); } });
const lastCode = (phone) => [...sent].reverse().find((row) => row.phone === phone)?.code;

const testId = `m4${Date.now().toString(36)}`;
const digits = String(Date.now()).slice(-7);
const phoneA = `+96477${digits}1`.slice(0, 14);
const phoneB = `+96478${digits}2`.slice(0, 14);
const phoneOther = `+96479${digits}3`.slice(0, 14);
const server = createApp().listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const summary = {};

function client() {
  const jar = new Map();
  return {
    jar,
    async request(path, { method = "GET", body, headers = {} } = {}) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), origin: base, ...(jar.size ? { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ") } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      for (const line of response.headers.getSetCookie?.() ?? []) {
        const [pair, ...attributes] = line.split(";");
        const eq = pair.indexOf("=");
        const name = pair.slice(0, eq).trim();
        if (attributes.some((attr) => /expires=thu, 01 jan 1970|max-age=0/i.test(attr))) jar.delete(name); else jar.set(name, pair.slice(eq + 1));
      }
      return { status: response.status, payload: await response.json().catch(() => null) };
    },
  };
}

async function signIn(shopper, phone) {
  const asked = await shopper.request("/market/auth/code", { method: "POST", body: { phone } });
  assert.equal(asked.status, 200, JSON.stringify(asked.payload));
  const verified = await shopper.request("/market/auth/verify", { method: "POST", body: { challengeId: asked.payload.challengeId, code: lastCode(phone) } });
  assert.equal(verified.status, 200, JSON.stringify(verified.payload));
  return verified.payload;
}

const shopperIds = [];
try {
  // ── 1. sign-in ───────────────────────────────────────────────────────────
  const a = client();
  const local = `07${phoneA.slice(5)}`;
  const first = await a.request("/market/auth/code", { method: "POST", body: { phone: local } });
  assert.equal(first.status, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.code, undefined, "the code is never in the response");
  assert.deepEqual(Object.keys(first.payload).sort(), ["challengeId", "expiresAt", "resendAfterSeconds"], "nothing says whether an account exists");
  assert.equal(sent.at(-1).phone, phoneA, "07… is normalized to +964…");
  assert.equal((await a.request("/market/auth/code", { method: "POST", body: { phone: phoneA } })).payload.error.code, "OTP_TOO_SOON", "one code a minute");
  assert.equal((await a.request("/market/auth/code", { method: "POST", body: { phone: "0612345" } })).status, 422, "not an Iraqi mobile");
  assert.equal((await a.request("/market/auth/code", { method: "POST", body: { phone: phoneA }, headers: { origin: "https://evil.example" } })).status, 403);

  const right = lastCode(phoneA);
  const wrong = right === "000000" ? "111111" : "000000";
  const miss = await a.request("/market/auth/verify", { method: "POST", body: { challengeId: first.payload.challengeId, code: wrong } });
  assert.equal(miss.status, 422);
  assert.equal(miss.payload.error.attemptsLeft, OTP_MAX_ATTEMPTS - 1);
  const ok = await a.request("/market/auth/verify", { method: "POST", body: { challengeId: first.payload.challengeId, code: right } });
  assert.equal(ok.status, 200, JSON.stringify(ok.payload));
  assert.equal(ok.payload.isNew, true);
  assert.equal(ok.payload.shopper.phone, phoneA);
  shopperIds.push(ok.payload.shopper.id);
  assert.ok([...a.jar.keys()].some((name) => name.includes("codiq_shopper_session")), "a session cookie is set");
  assert.equal((await a.request("/market/auth/verify", { method: "POST", body: { challengeId: first.payload.challengeId, code: right } })).status === 200, false, "a code works once");

  // Five wrong tries end a code, even with the right one after.
  await prisma.shopperOtpChallenge.updateMany({ where: { phoneNormalized: phoneA }, data: { createdAt: new Date(Date.now() - 120_000) } });
  const second = await a.request("/market/auth/code", { method: "POST", body: { phone: phoneA } });
  for (let n = 0; n < OTP_MAX_ATTEMPTS; n += 1) await a.request("/market/auth/verify", { method: "POST", body: { challengeId: second.payload.challengeId, code: lastCode(phoneA) === "000000" ? "111111" : "000000" } });
  const locked = await a.request("/market/auth/verify", { method: "POST", body: { challengeId: second.payload.challengeId, code: lastCode(phoneA) } });
  assert.equal(locked.payload.error.code, "OTP_EXHAUSTED", "out of tries");
  // An expired code is refused.
  await prisma.shopperOtpChallenge.updateMany({ where: { phoneNormalized: phoneA }, data: { createdAt: new Date(Date.now() - 120_000) } });
  const third = await a.request("/market/auth/code", { method: "POST", body: { phone: phoneA } });
  await prisma.shopperOtpChallenge.update({ where: { id: third.payload.challengeId }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await a.request("/market/auth/verify", { method: "POST", body: { challengeId: third.payload.challengeId, code: lastCode(phoneA) } })).payload.error.code, "OTP_EXPIRED");
  // Signing in again finds the same account.
  await prisma.shopperOtpChallenge.updateMany({ where: { phoneNormalized: phoneA }, data: { createdAt: new Date(Date.now() - 120_000) } });
  const again = await signIn(client(), phoneA);
  assert.equal(again.isNew, false);
  assert.equal(again.shopper.id, ok.payload.shopper.id);
  const hashes = await prisma.shopperOtpChallenge.findMany({ where: { phoneNormalized: phoneA }, select: { codeHash: true } });
  assert.ok(hashes.every((row) => /^[0-9a-f]{64}$/.test(row.codeHash) && !sent.some((s) => s.code === row.codeHash)), "only HMACs are stored");
  summary.signIn = true;

  // ── 2. the session's kind ────────────────────────────────────────────────
  const me = await a.request("/market/me");
  assert.equal(me.status, 200);
  assert.match(me.payload.shopper.publicId, /^[0-9A-F]{8}$/);
  const merchant = await registerMerchantDirect({ ownerName: "تاجر", businessName: "متجر", phone: `+96475${digits}9`.slice(0, 14), email: `${testId}@codiq.test`, password: "MarketAccount!2026" });
  const store = await prisma.store.create({ data: { merchantId: merchant.payload.account.id, name: `متجر ${testId}`, slug: `${testId}-s`, defaultSubdomain: `${testId}-s`, marketStatus: "listed", marketStatusAt: new Date(), marketListedAt: new Date() } });
  const merchantToken = (await a.request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}@codiq.test`, password: "MarketAccount!2026" } })).payload.accessToken;
  assert.ok(merchantToken, "the merchant signs in");
  const asMerchant = await fetch(`${base}/market/me`, { headers: { authorization: `Bearer ${merchantToken}` } });
  assert.equal(asMerchant.status, 403, "a merchant session is not a shopper session");
  assert.equal((await fetch(`${base}/market/me`, { headers: { authorization: `Bearer ${ok.payload.accessToken}` } })).status, 200, "the app token works as a Bearer");
  const outside = client();
  const nobody = await outside.request("/market/me");
  assert.deepEqual([nobody.status, nobody.payload.shopper], [200, null], "no session: nobody, not an error");
  assert.equal((await fetch(`${base}/market/me`, { headers: { authorization: "Bearer not-a-token" } })).status, 401, "a bad session is still a 401");
  summary.sessionKind = true;

  // ── 3. profile ───────────────────────────────────────────────────────────
  const phones = await prisma.marketCategory.findUniqueOrThrow({ where: { slug: "phones" } });
  assert.equal((await a.request("/market/me", { method: "PUT", body: { fullName: "علي", email: null, gender: "male", interests: [999999] } })).status, 422);
  const profile = await a.request("/market/me", { method: "PUT", body: { fullName: "علي حسن", email: "Ali@Example.com", gender: "male", interests: [phones.id, phones.id] } });
  assert.equal(profile.status, 200, JSON.stringify(profile.payload));
  assert.equal(profile.payload.shopper.email, "ali@example.com");
  assert.deepEqual(profile.payload.shopper.interests, [phones.id]);
  summary.profile = true;

  // ── 4. addresses ─────────────────────────────────────────────────────────
  const kadhimiya = await prisma.district.findFirstOrThrow({ where: { governorateKey: "Baghdad", nameAr: "الكاظمية" } });
  const ashar = await prisma.district.findFirstOrThrow({ where: { governorateKey: "Basra", nameAr: "العشار" } });
  const address = (extra) => ({ label: "البيت", recipientName: "علي حسن", phone: phoneA, altPhone: null, governorateKey: "Baghdad", districtId: kadhimiya.id, addressLine: "شارع ٢٠، قرب الجامع", latitude: 33.37, longitude: 44.33, ...extra });
  assert.equal((await a.request("/market/me/addresses", { method: "POST", body: address({ governorateKey: "Basra" }) })).payload.error.code, "DISTRICT_NOT_IN_GOVERNORATE");
  assert.equal((await a.request("/market/me/addresses", { method: "POST", body: address({ altPhone: phoneA }) })).payload.error.code, "ALT_PHONE_SAME");
  const home = await a.request("/market/me/addresses", { method: "POST", body: address({ altPhone: phoneB }) });
  assert.equal(home.status, 201, JSON.stringify(home.payload));
  assert.equal(home.payload.address.isDefault, true, "the first address is the default");
  assert.equal(home.payload.address.district.name, "الكاظمية");

  const work = address({ label: "العمل", phone: phoneOther, governorateKey: "Basra", districtId: ashar.id });
  assert.equal((await a.request("/market/me/addresses", { method: "POST", body: work })).payload.error.code, "ADDRESS_PHONE_UNVERIFIED", "another phone needs its own code");
  const phoneCode = await a.request("/market/me/addresses/phone-code", { method: "POST", body: { phone: phoneOther } });
  assert.equal(phoneCode.status, 200);
  assert.equal(sent.at(-1).phone, phoneOther, "the code goes to the address phone, not the shopper's");
  const workSaved = await a.request("/market/me/addresses", { method: "POST", body: { ...work, isDefault: true, phoneVerification: { challengeId: phoneCode.payload.challengeId, code: lastCode(phoneOther) } } });
  assert.equal(workSaved.status, 201, JSON.stringify(workSaved.payload));
  let list = (await a.request("/market/me/addresses")).payload.addresses;
  assert.equal(list.filter((row) => row.isDefault).length, 1, "one default at a time");
  assert.equal(list[0].id, workSaved.payload.address.id, "the new default first");

  const b = client();
  const bSigned = await signIn(b, phoneB);
  shopperIds.push(bSigned.shopper.id);
  assert.equal((await b.request(`/market/me/addresses/${home.payload.address.id}`, { method: "PUT", body: address({}) })).status, 404, "another shopper's address is a 404");
  assert.equal((await b.request(`/market/me/addresses/${home.payload.address.id}`, { method: "DELETE" })).status, 404);

  // Editing without changing the phone keeps its proof; changing it to an unproven one is refused.
  assert.equal((await a.request(`/market/me/addresses/${workSaved.payload.address.id}`, { method: "PUT", body: { ...work, addressLine: "العشار، شارع الكورنيش" } })).status, 200);
  assert.equal((await a.request(`/market/me/addresses/${workSaved.payload.address.id}`, { method: "PUT", body: { ...work, phone: phoneB } })).payload.error.code, "ADDRESS_PHONE_UNVERIFIED");

  list = (await a.request(`/market/me/addresses/${workSaved.payload.address.id}`, { method: "DELETE" })).payload.addresses;
  assert.deepEqual(list.map((row) => [row.id, row.isDefault]), [[home.payload.address.id, true]], "deleting the default promotes the next");

  // Delivery quote from a listed store.
  await prisma.deliveryRate.create({ data: { storeId: store.id, governorate: "Baghdad", amountIqd: 5000, isEnabled: true } });
  const quote = await a.request(`/market/me/addresses/${home.payload.address.id}/delivery?store=${store.slug}`);
  assert.deepEqual([quote.payload.available, quote.payload.amountIqd], [true, 5000]);
  await prisma.store.update({ where: { id: store.id }, data: { marketStatus: "unlisted" } });
  assert.equal((await a.request(`/market/me/addresses/${home.payload.address.id}/delivery?store=${store.slug}`)).status, 404, "only stores in the market");
  summary.addresses = true;

  // ── sign out ─────────────────────────────────────────────────────────────
  assert.equal((await a.request("/market/auth/logout", { method: "POST" })).status, 200);
  assert.equal((await fetch(`${base}/market/me`, { headers: { authorization: `Bearer ${ok.payload.accessToken}` } })).status, 401, "the session is ended, not only the cookie");
  summary.signOut = true;

  console.log(JSON.stringify({ suite: "market-account", ok: true, summary }, null, 2));
} finally {
  setOtpProviderForTests(null);
  if (shopperIds.length) await prisma.shopper.deleteMany({ where: { id: { in: shopperIds } } }).catch(() => undefined);
  server.close();
  await prisma.$disconnect();
}
