/**
 * Marketplace M0 (docs/MARKETPLACE_PLAN.md §3): the geography and store facts.
 *
 *   1. The SQL governorate list (codiq_is_governorate_key) is the TS list — the
 *      migration copied it, and this is what keeps the two equal.
 *   2. Every governorate has districts to pick from.
 *   3. The constraints refuse what they promise to refuse: a district from
 *      another governorate, half a coordinate, a pick-up with no place,
 *      a weekday 7, a zero-length shift — and accept a shift across midnight.
 *   4. GET /market/geo answers the whole tree, in the platform's order, cacheable.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

process.env.CODIQ_ALLOW_OWNER_REGISTRATION ??= "true";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL ?? process.env.DATABASE_URL);
const { prisma } = await import("../src/db/prisma.ts");
const { GOVERNORATES } = await import("../src/services/governorates.ts");
const { createApp } = await import("../src/http/app.ts");

const testId = `m0-${Date.now()}`;
const suffix = String(Date.now()).slice(-8);
const summary = {};

async function refused(promise, code, what) {
  await assert.rejects(
    promise,
    (error) => {
      const message = String(error?.message ?? error);
      assert.ok(message.includes(code), `${what}: expected ${code}, got ${message.slice(0, 300)}`);
      return true;
    },
    what
  );
}

let server;
let storeId;
try {
  // ── 1. one governorate list ─────────────────────────────────────────────
  for (const { key } of GOVERNORATES) {
    const [row] = await prisma.$queryRaw`SELECT codiq_is_governorate_key(${key}) AS ok`;
    assert.equal(row.ok, true, `SQL must know governorate ${key}`);
  }
  const [definition] =
    await prisma.$queryRaw`SELECT pg_get_functiondef('codiq_is_governorate_key'::regproc) AS body`;
  const sqlKeys = [...definition.body.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(
    sqlKeys,
    GOVERNORATES.map((g) => g.key).sort(),
    "codiq_is_governorate_key and governorates.ts list the same eighteen keys"
  );
  summary.governorateListsEqual = sqlKeys.length;

  // ── 2. districts for every governorate ──────────────────────────────────
  const counts = await prisma.district.groupBy({ by: ["governorateKey"], _count: { _all: true } });
  assert.equal(counts.length, GOVERNORATES.length, "every governorate has at least one district");
  summary.districts = counts.reduce((sum, row) => sum + row._count._all, 0);

  // ── 3. constraints ──────────────────────────────────────────────────────
  const merchant = await registerMerchantDirect({
    ownerName: "سوق",
    businessName: "متجر السوق",
    phone: `+96477${suffix}`,
    email: `${testId}@codiq.test`,
    password: "MarketFoundation!2026",
  });
  assert.equal(merchant.status, 201, JSON.stringify(merchant.payload));
  const store = await prisma.store.create({
    data: {
      merchantId: merchant.payload.account.id,
      name: "متجر السوق",
      slug: `${testId}-s`,
      defaultSubdomain: `${testId}-s`,
    },
  });
  storeId = store.id;
  const kadhimiya = await prisma.district.findFirstOrThrow({
    where: { governorateKey: "Baghdad", nameAr: "الكاظمية" },
  });

  await refused(
    prisma.$executeRaw`UPDATE stores SET governorate_key = 'Basra', district_id = ${kadhimiya.id} WHERE id = ${store.id}::uuid`,
    "stores_district_in_governorate",
    "a Baghdad district in Basra"
  );
  await refused(
    prisma.$executeRaw`UPDATE stores SET district_id = ${kadhimiya.id} WHERE id = ${store.id}::uuid`,
    "stores_district_needs_governorate",
    "a district without its governorate"
  );
  await refused(
    prisma.$executeRaw`UPDATE stores SET governorate_key = 'Atlantis' WHERE id = ${store.id}::uuid`,
    "stores_governorate_known",
    "an unknown governorate"
  );
  await refused(
    prisma.$executeRaw`UPDATE stores SET latitude = 33.3 WHERE id = ${store.id}::uuid`,
    "stores_coordinates_pair",
    "half a coordinate"
  );
  await refused(
    prisma.$executeRaw`UPDATE stores SET latitude = 95, longitude = 44 WHERE id = ${store.id}::uuid`,
    "stores_coordinates_range",
    "a latitude off the planet"
  );
  await refused(
    prisma.$executeRaw`UPDATE stores SET pickup_enabled = true WHERE id = ${store.id}::uuid`,
    "stores_pickup_needs_location",
    "a pick-up with no place"
  );
  await refused(
    prisma.$executeRaw`UPDATE stores SET cover_object_key = 'covers/x.webp' WHERE id = ${store.id}::uuid`,
    "stores_cover_complete",
    "a cover without its type and size"
  );

  const placed = await prisma.store.update({
    where: { id: store.id },
    data: {
      governorateKey: "Baghdad",
      districtId: kadhimiya.id,
      latitude: 33.378,
      longitude: 44.339,
      pickupEnabled: true,
      businessType: "أجهزة ذكية",
    },
    select: { district: { select: { nameAr: true } }, pickupEnabled: true },
  });
  assert.equal(placed.district?.nameAr, "الكاظمية");
  assert.equal(placed.pickupEnabled, true);
  summary.constraintsRefused = 7;

  await refused(
    prisma.$executeRaw`INSERT INTO store_opening_hours (store_id, weekday, opens_at, closes_at) VALUES (${store.id}::uuid, 7, '09:00', '17:00')`,
    "store_opening_hours_weekday_range",
    "weekday 7"
  );
  await refused(
    prisma.$executeRaw`INSERT INTO store_opening_hours (store_id, weekday, opens_at, closes_at) VALUES (${store.id}::uuid, 1, '09:00', '09:00')`,
    "store_opening_hours_not_empty",
    "a zero-length shift"
  );
  await prisma.$executeRaw`INSERT INTO store_opening_hours (store_id, weekday, opens_at, closes_at) VALUES (${store.id}::uuid, 4, '18:00', '02:00')`;
  const hours = await prisma.storeOpeningHour.findMany({ where: { storeId: store.id } });
  assert.equal(hours.length, 1, "a shift across midnight is accepted");
  summary.openingHours = true;

  // ── 4. GET /market/geo ─────────────────────────────────────────────────
  server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const response = await fetch(`http://127.0.0.1:${server.address().port}/market/geo`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /public, max-age=3600/);
  const body = await response.json();
  assert.deepEqual(
    body.governorates.map((g) => g.key),
    GOVERNORATES.map((g) => g.key),
    "governorates in the platform's order"
  );
  const baghdad = body.governorates.find((g) => g.key === "Baghdad");
  assert.equal(baghdad.name, "بغداد");
  assert.ok(baghdad.districts.some((d) => d.id === kadhimiya.id && d.name === "الكاظمية"));
  await prisma.district.update({ where: { id: kadhimiya.id }, data: { isActive: false } });
  const after = await (await fetch(`http://127.0.0.1:${server.address().port}/market/geo`)).json();
  assert.ok(
    !after.governorates
      .find((g) => g.key === "Baghdad")
      .districts.some((d) => d.id === kadhimiya.id),
    "an inactive district is not offered"
  );
  await prisma.district.update({ where: { id: kadhimiya.id }, data: { isActive: true } });
  summary.geoEndpoint = body.governorates.length;

  console.log(JSON.stringify({ suite: "market-foundation", ok: true, summary }, null, 2));
} finally {
  server?.close();
  if (storeId)
    await prisma.store
      .update({
        where: { id: storeId },
        data: {
          districtId: null,
          governorateKey: null,
          pickupEnabled: false,
          latitude: null,
          longitude: null,
        },
      })
      .catch(() => undefined);
  await prisma.$disconnect();
}
