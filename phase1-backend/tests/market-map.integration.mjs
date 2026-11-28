/**
 * Marketplace M11 — the stores map, «على طريقك», and the map's tiles, over HTTP.
 *
 *   1. The map: listed stores with a location inside the box, and only those.
 *   2. «على طريقك»: stores within the corridor of the line between two points,
 *      in the order they are passed; widening the corridor takes in more; a
 *      store past the end of the line is not «on the way»; bad input refused.
 *   3. Tiles through this server: off until configured; then fetched once and
 *      served from the cache; outside the grid 404; a provider answering with
 *      something that is not an image, or a redirect, is refused (502).
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

process.env.CODIQ_ALLOW_OWNER_REGISTRATION ??= "true";
const testId = `m11${Date.now().toString(36)}`;
const digits = String(Date.now()).slice(-7);
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL ?? process.env.DATABASE_URL);
delete process.env.CODIQ_MAP_TILE_URL;

const { prisma } = await import("../src/db/prisma.ts");
const { createApp } = await import("../src/http/app.ts");
const { clearMapTileCacheForTests } = await import(
  "../src/modules/market-stores/map-tiles.service.ts"
);
const server = createApp().listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const get = async (path) => {
  const response = await fetch(`${base}${path}`);
  const type = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    headers: response.headers,
    body: type.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer()),
  };
};

// A tile provider on this machine: counts its hits, and misbehaves on request.
const png = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000072b60d240000000d4944415478da63f80f0000010100005018d84d0000000049454e44ae426082",
  "hex"
);
let upstreamHits = 0;
const upstream = createServer((request, response) => {
  upstreamHits += 1;
  if (request.url.startsWith("/html/")) {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<script>alert(1)</script>");
    return;
  }
  if (request.url.startsWith("/redirect/")) {
    response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
    response.end();
    return;
  }
  response.writeHead(200, { "content-type": "image/png" });
  response.end(png);
});
upstream.listen(0);
await new Promise((resolve) => upstream.once("listening", resolve));
const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

const summary = {};
const storeIds = [];
try {
  const reg = await registerMerchantDirect({
    ownerName: "تاجر",
    businessName: "متجر",
    phone: `+96475${digits}1`.slice(0, 14),
    email: `${testId}@codiq.test`,
    password: "MarketMap!2026",
  });
  const merchantId = reg.payload.account.id;
  const listed = { marketStatus: "listed", marketStatusAt: new Date(), marketListedAt: new Date() };
  async function store(label, latitude, longitude, extra = listed) {
    const row = await prisma.store.create({
      data: {
        merchantId,
        name: `${label} ${testId}`,
        slug: `${testId}-${label}`,
        defaultSubdomain: `${testId}-${label}`,
        latitude,
        longitude,
        ...extra,
      },
    });
    storeIds.push(row.id);
    return row;
  }
  // The errand: due east along latitude 33.20 from 44.30 to 44.40 (≈ 9.3 km), south of the city's other test stores.
  const early = await store("early", 33.201, 44.32); // ≈ 0.1 km off, 1.9 km along
  await store("late", 33.196, 44.38); // ≈ 0.4 km off, 7.5 km along
  await store("wide", 33.225, 44.35); // ≈ 2.8 km off
  await store("past", 33.2, 44.46); // on the line's extension, 5.6 km past the end
  await store("hidden", 33.2005, 44.35, { marketStatus: "unlisted" });
  await store("noloc", null, null);
  const mine = (rows) =>
    rows
      .filter((row) => row.slug.startsWith(testId))
      .map((row) => row.slug.slice(testId.length + 1));

  // ── 1. the map ───────────────────────────────────────────────────────────
  const box = await get("/market/stores/map?south=33.19&west=44.31&north=33.23&east=44.39");
  assert.equal(box.status, 200);
  assert.deepEqual(
    mine(box.body.pins).sort(),
    ["early", "late", "wide"],
    "inside the box, listed, with a location"
  );
  const pin = box.body.pins.find((row) => row.slug === early.slug);
  assert.deepEqual([pin.latitude, pin.longitude, typeof pin.name], [33.201, 44.32, "string"]);
  assert.equal(
    (await get("/market/stores/map?south=33.3&west=44.3&north=33.2&east=44.4")).status,
    422,
    "an upside-down box"
  );
  assert.equal(
    (await get("/market/stores/map?south=abc&west=44.3&north=33.2&east=44.4")).status,
    422
  );
  assert.equal(
    (await get(`/market/stores/${early.slug}`)).status,
    200,
    "a store page still resolves beside /map"
  );
  summary.map = true;

  // ── 2. on the way ────────────────────────────────────────────────────────
  const route = await get("/market/stores/on-route?from=33.2,44.3&to=33.2,44.4&corridor=1");
  assert.equal(route.status, 200, JSON.stringify(route.body));
  assert.equal(route.headers.get("cache-control"), "private, no-store");
  assert.ok(
    Math.abs(route.body.routeKm - 9.3) < 0.2,
    `the line is ≈ 9.3 km (${route.body.routeKm})`
  );
  assert.deepEqual(
    mine(route.body.stores),
    ["early", "late"],
    "within a kilometre, in the order passed"
  );
  const [first, second] = route.body.stores.filter((row) => row.slug.startsWith(testId));
  assert.ok(first.distanceKm <= 0.2 && Math.abs(first.alongKm - 1.9) < 0.2, JSON.stringify(first));
  assert.ok(
    Math.abs(second.distanceKm - 0.4) < 0.15 && Math.abs(second.alongKm - 7.5) < 0.2,
    JSON.stringify(second)
  );
  assert.deepEqual(
    mine((await get("/market/stores/on-route?from=33.2,44.3&to=33.2,44.4&corridor=3")).body.stores),
    ["early", "wide", "late"],
    "a wider corridor takes in more"
  );
  assert.deepEqual(
    mine((await get("/market/stores/on-route?from=33.2,44.4&to=33.2,44.3&corridor=1")).body.stores),
    ["late", "early"],
    "the other way round, the other order"
  );
  assert.ok(
    !mine(
      (await get("/market/stores/on-route?from=33.2,44.3&to=33.2,44.4&corridor=5")).body.stores
    ).includes("past"),
    "past the end is not on the way"
  );
  assert.ok(!mine(route.body.stores).includes("hidden"));
  assert.equal(
    (await get("/market/stores/on-route?from=33.2,44.3&to=33.2,44.3001")).body.error.code,
    "ROUTE_TOO_SHORT"
  );
  assert.equal(
    (await get("/market/stores/on-route?from=33.2,44.3&to=30.5,47.8")).body.error.code,
    "ROUTE_TOO_LONG"
  );
  assert.equal(
    (await get("/market/stores/on-route?from=33.2,44.3&to=33.2,44.4&corridor=50")).status,
    422,
    "a corridor wider than 5 km"
  );
  assert.equal(
    (await get("/market/stores/on-route?from=33.2;drop table stores&to=33.2,44.4")).status,
    422
  );
  summary.route = true;

  // ── 3. tiles ─────────────────────────────────────────────────────────────
  assert.equal((await get("/market/map/config")).body.tiles, null, "off until configured");
  assert.equal((await get("/market/map/tiles/3/4/2")).body.error.code, "MAP_TILES_OFF");
  process.env.CODIQ_MAP_TILE_URL = `${upstreamBase}/{z}/{x}/{y}.png?key=secret-provider-key`;
  process.env.CODIQ_MAP_TILE_ATTRIBUTION = "© مزوّد الخرائط";
  clearMapTileCacheForTests();
  const config = (await get("/market/map/config")).body;
  assert.deepEqual(
    [config.tiles, config.attribution],
    ["/api/market/map/tiles/{z}/{x}/{y}", "© مزوّد الخرائط"]
  );
  assert.ok(
    !JSON.stringify(config).includes("secret-provider-key"),
    "the provider's key never reaches the browser"
  );
  upstreamHits = 0;
  const tile = await get("/market/map/tiles/3/4/2");
  assert.deepEqual(
    [tile.status, tile.headers.get("content-type"), tile.body.equals(png)],
    [200, "image/png", true]
  );
  assert.match(tile.headers.get("cache-control"), /public, max-age=86400/);
  await Promise.all([get("/market/map/tiles/3/4/2"), get("/market/map/tiles/3/4/2")]);
  assert.equal(upstreamHits, 1, "fetched once, then from the cache");
  assert.equal(
    (await get("/market/map/tiles/3/8/2")).status,
    404,
    "x outside the 8×8 grid of zoom 3"
  );
  assert.equal((await get("/market/map/tiles/23/0/0")).status, 404, "beyond the maximum zoom");
  assert.equal((await get("/market/map/tiles/3/-1/2")).status, 404);
  assert.equal(upstreamHits, 1, "none of those reached the provider");
  // Review batch 6: every tile not yet cached is one paid request to the provider, and the route
  // took any number from anyone — a script walking zoom 19 spent the operator's quota (and got
  // his key suspended). Fetches from the provider are now limited per address; the cache is not.
  await prisma.storefrontRateLimit.deleteMany({ where: { scope: "market_map_tile_upstream" } });
  for (let start = 0; start < 1000; start += 50) {
    const batch = await Promise.all(
      Array.from({ length: 50 }, (_, index) => get(`/market/map/tiles/10/${start + index}/7`))
    );
    assert.ok(batch.every((answer) => answer.status === 200));
  }
  assert.equal(
    (await get("/market/map/tiles/10/1000/7")).status,
    429,
    "a thousand fresh tiles in ten minutes, then the provider is spared"
  );
  assert.equal((await get("/market/map/tiles/3/4/2")).status, 200, "the cache still answers");
  await prisma.storefrontRateLimit.deleteMany({ where: { scope: "market_map_tile_upstream" } });
  process.env.CODIQ_MAP_TILE_URL = `${upstreamBase}/html/{z}/{x}/{y}`;
  assert.equal(
    (await get("/market/map/tiles/2/1/1")).status,
    502,
    "a provider answering HTML is refused, not relayed"
  );
  process.env.CODIQ_MAP_TILE_URL = `${upstreamBase}/redirect/{z}/{x}/{y}`;
  assert.equal((await get("/market/map/tiles/2/1/2")).status, 502, "a redirect is not followed");
  process.env.CODIQ_MAP_TILE_URL = "ftp://tiles.example/{z}/{x}/{y}";
  assert.equal((await get("/market/map/config")).body.tiles, null, "only http(s) templates");
  summary.tiles = true;

  console.log(JSON.stringify({ suite: "market-map", ok: true, summary }, null, 2));
} finally {
  delete process.env.CODIQ_MAP_TILE_URL;
  await prisma.store
    .updateMany({
      where: { id: { in: storeIds } },
      data: { marketStatus: "unlisted", marketStatusAt: new Date() },
    })
    .catch(() => undefined);
  server.close();
  upstream.close();
  await prisma.$disconnect();
}
