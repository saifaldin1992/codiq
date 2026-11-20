/**
 * المرحلة 20-3 «الأداء والفهارس» — the evidence behind every index in
 * migration 20260905140000, reproducible on any machine with a throwaway
 * PostgreSQL.
 *
 * NOT part of CI: seeding 1.96 million rows takes about four minutes, and the
 * numbers it prints are latency on whatever hardware runs it, not a pass/fail.
 * What CI enforces is `pnpm keyset:guard`, which needs no database at all. This
 * is the thing that produced the numbers in the migration header and in
 * docs/PERF_KEYSET_INDEXES.md, kept so they can be re-derived instead of
 * believed.
 *
 *     createdb codiq_perf_evidence
 *     CODIQ_TEST_DATABASE_URL=postgresql://…/codiq_perf_evidence pnpm phase1:db:migrate
 *     CODIQ_TEST_DATABASE_URL=… pnpm perf:evidence -- --seed
 *
 * `--seed` builds the corpus (once); without it the harness only measures.
 *
 * METHOD, inherited from PG-6's plan gate (ق-144): never EXPLAIN a query
 * someone typed into the test. Each page is built with Prisma from the SAME
 * declarative spec the service uses, the SQL the engine actually emitted is
 * captured off the query event, and THAT text is explained with THOSE
 * parameters. The keyset predicate is not re-implemented either — it is
 * imported from `services/list-page.ts`. The cursor is placed HALF WAY down
 * each list, because page one hides the defect entirely. Median of five runs
 * after a warm-up: one ANALYZE run is noise, not a number.
 *
 * The corpus is deliberately skewed — one «big» store holds half of every
 * store-scoped table — because that is the shape that hurts in a multi-tenant
 * schema, and because a few hundred rows are CORRECTLY sequentially scanned by
 * PostgreSQL, so an EXPLAIN over them proves nothing at all.
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { PrismaClient } from "@prisma/client";
import { keysetWhere, LIST_LIMIT_DEFAULT } from "../src/services/list-page.ts";

const prisma = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
const captured = [];
prisma.$on("query", (event) => captured.push(event));

const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const databaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL ?? process.env.DATABASE_URL);
process.env.DATABASE_URL = databaseUrl;
process.env.CODIQ_POSTGRES_URL = databaseUrl;
const sql = new Client({ connectionString: databaseUrl });
await sql.connect();


// ─────────────────────────────────────────────────────────────── the corpus
if (process.argv.includes("--seed")) {
  const file = readFileSync(new URL("./perf-index-evidence.seed.sql", import.meta.url), "utf8");
  // VACUUM cannot run inside a transaction block, and node-pg wraps a
  // multi-statement simple query in one — so the maintenance commands are
  // peeled off and run on their own.
  const statements = file.split(/^(VACUUM[^;]*;)$/gm);
  for (const chunk of statements) {
    const text = chunk.trim();
    if (text) await sql.query(text);
  }
  console.error("seeded.");
}

const one = async (text) => (await sql.query(text)).rows[0];
const bigStore = (await one("SELECT id FROM perf_s WHERE n = 0")).id;
const bigMerchant = (await one("SELECT id FROM perf_m WHERE n = 0")).id;
const busyCustomer = (await one(
  "SELECT customer_id AS id FROM store_orders WHERE store_id = $1 GROUP BY customer_id ORDER BY count(*) DESC LIMIT 1"
    .replace("$1", `'${bigStore}'`),
)).id;
const cartCutoff = new Date(Date.now() - 60 * 60 * 1000);
const bigCustomer = (await one("SELECT id FROM perf_c WHERE n = 0")).id;
const noisyOrder = (await one("SELECT order_id AS id FROM order_notes GROUP BY order_id ORDER BY count(*) DESC LIMIT 1")).id;

/**
 * Every list 20-2 paginates, as (model, base filter, ordering tuple).
 * `field`/`dir` are what the service passes to `keysetWhere`; `orderBy` is what
 * it passes to Prisma. They must agree or the page overlaps — that agreement is
 * itself asserted below.
 */
const LISTS = [
  { id: "platform.merchants", src: "entitlement.service.ts:360", model: "merchant", table: "merchants",
    where: {}, field: "createdAt", dir: "desc", orderBy: [{ createdAt: "desc" }, { id: "desc" }] },

  { id: "platform.registration-requests", src: "registration.service.ts:114", model: "merchant", table: "merchants",
    where: { approvalStatus: "pending" }, field: "createdAt", dir: "asc", orderBy: [{ createdAt: "asc" }, { id: "asc" }] },

  { id: "platform.stores", src: "platform-directory.service.ts:29", model: "store", table: "stores",
    where: {}, field: "createdAt", dir: "desc", orderBy: [{ createdAt: "desc" }, { id: "desc" }] },

  { id: "platform.orders", src: "order-lifecycle.service.ts:306", model: "storeOrder", table: "store_orders",
    where: {}, field: "createdAt", dir: "desc", orderBy: [{ createdAt: "desc" }, { id: "desc" }] },

  { id: "platform.upgrade-requests", src: "entitlement.service.ts:464", model: "planUpgradeRequest", table: "plan_upgrade_requests",
    where: {}, field: "createdAt", dir: "desc", orderBy: [{ createdAt: "desc" }, { id: "desc" }] },

  { id: "platform.audit-events (control)", src: "platform-audit.service.ts:134", model: "platformAuditEvent", table: "platform_audit_events",
    where: {}, field: "createdAt", dir: "desc", orderBy: [{ createdAt: "desc" }, { id: "desc" }] },

  { id: "merchant.inventory.returns", src: "return-inspection.service.ts:47", model: "inventoryReservation", table: "inventory_reservations",
    where: { storeId: bigStore, returnDisposition: "pending_inspection" }, field: "returnedAt", dir: "desc",
    orderBy: [{ returnedAt: "desc" }, { id: "desc" }] },

  { id: "merchant.pos.shortfalls", src: "pos.service.ts:466", model: "posTicketShortfall", table: "pos_ticket_shortfalls",
    where: { storeId: bigStore, reviewedAt: null }, field: "createdAt", dir: "desc",
    orderBy: [{ createdAt: "desc" }, { id: "desc" }] },

  { id: "merchant.abandoned-carts", src: "abandoned-cart.service.ts:124", model: "shoppingCart", table: "shopping_carts",
    where: { storeId: bigStore, status: "active", lastActivityAt: { lt: cartCutoff }, items: { some: {} } },
    field: "lastActivityAt", dir: "desc", orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }] },

  { id: "merchant.returns", src: "return-request.service.ts:138", model: "returnRequest", table: "return_requests",
    where: { storeId: bigStore }, field: "createdAt", dir: "asc", orderBy: [{ createdAt: "asc" }, { id: "asc" }] },

  { id: "merchant.notifications.log", src: "notification-settings.service.ts:183", model: "notificationOutbox", table: "notification_outbox",
    where: { storeId: bigStore }, field: "createdAt", dir: "desc", orderBy: [{ createdAt: "desc" }, { id: "desc" }] },

  { id: "finance.settlements", src: "finance.service.ts:257", model: "settlement", table: "settlements",
    where: { merchantId: bigMerchant }, field: "createdAt", dir: "desc", orderBy: [{ createdAt: "desc" }, { id: "desc" }] },

  { id: "merchant.audit-events?entityType", src: "audit-log.service.ts:111", model: "storeAuditEvent", table: "store_audit_events",
    where: { storeId: bigStore, entityType: "product" }, field: "createdAt", dir: "desc",
    orderBy: [{ createdAt: "desc" }, { id: "desc" }] },

  { id: "merchant.audit-events (control)", src: "audit-log.service.ts:111", model: "storeAuditEvent", table: "store_audit_events",
    where: { storeId: bigStore }, field: "createdAt", dir: "desc", orderBy: [{ createdAt: "desc" }, { id: "desc" }] },

  { id: "storefront.account.orders", src: "storefront.service.ts:819", model: "storeOrder", table: "store_orders",
    where: { storeId: bigStore, customerId: busyCustomer }, field: "createdAt", dir: "desc",
    orderBy: [{ createdAt: "desc" }, { id: "desc" }] },

  { id: "merchant.trash (products)", src: "soft-delete.service.ts:770", model: "product", table: "products",
    where: { storeId: bigStore, deletedAt: { not: null } }, field: "deletedAt", dir: "desc",
    orderBy: [{ deletedAt: "desc" }, { id: "desc" }] },

  { id: "merchant.coupons", src: "coupon.service.ts:211", model: "coupon", table: "coupons",
    where: { storeId: bigStore, deletedAt: null }, field: "createdAt", dir: "desc",
    orderBy: [{ createdAt: "desc" }, { id: "desc" }] },

  { id: "merchant.catalog.products (control)", src: "product-catalog.service.ts:242", model: "product", table: "products",
    where: { storeId: bigStore, deletedAt: null }, field: "createdAt", dir: "desc",
    orderBy: [{ createdAt: "desc" }, { id: "desc" }] },

  { id: "storefront.products", src: "storefront.service.ts:249", model: "product", table: "products",
    where: { storeId: bigStore, isActive: true }, field: "createdAt", dir: "desc",
    orderBy: [{ createdAt: "desc" }, { id: "desc" }] },

  { id: "storefront.account.wishlist", src: "wishlist.service.ts:31", model: "wishlistItem", table: "wishlist_items",
    where: { storeId: bigStore, customerId: bigCustomer }, field: "createdAt", dir: "desc",
    orderBy: [{ createdAt: "desc" }, { id: "desc" }] },

  { id: "merchant.order.notes", src: "order-notes.service.ts:72", model: "orderNote", table: "order_notes",
    where: { storeId: bigStore, orderId: noisyOrder }, field: "createdAt", dir: "asc",
    orderBy: [{ createdAt: "asc" }, { id: "asc" }] },

  { id: "store.products (by sku)", src: "http/routes/orders.ts:53", model: "product", table: "products",
    where: { storeId: bigStore, deletedAt: null }, field: "sku", dir: "asc", parse: "text",
    orderBy: [{ sku: "asc" }, { id: "asc" }] },

  { id: "store.orders (by orderNumber)", src: "http/routes/orders.ts:78", model: "storeOrder", table: "store_orders",
    where: { storeId: bigStore }, field: "orderNumber", dir: "asc", parse: "text",
    orderBy: [{ orderNumber: "asc" }, { id: "asc" }] },
];

/**
 * The one list 20-2 left as raw SQL.
 *
 * It cannot be captured the way the others are: `pulseCohort` runs on the
 * `db/prisma.ts` SINGLETON, which is constructed with no query logging, and
 * there is no honest way to attach one after the fact. So the statement is
 * TRANSCRIBED from platform-pulse.service.ts — and the transcription is checked
 * against the source below, fragment by fragment, so a future edit to the
 * cohort SQL makes this measurement fail loudly instead of silently measuring a
 * query the platform no longer runs.
 */
const PULSE_SOURCE = readFileSync(new URL("../src/services/platform-pulse.service.ts", import.meta.url), "utf8");
const PULSE = {
  never_sold: `SELECT m.id, m.business_name, m.email FROM merchants m
        WHERE m.approval_status = 'approved' AND m.id NOT IN (
          SELECT DISTINCT s.merchant_id FROM store_orders o JOIN stores s ON s.id = o.store_id
          WHERE o.status <> ALL($1::text[])
        ) AND (m.business_name, m.id) > ($2, $3::uuid) ORDER BY m.business_name, m.id LIMIT 26`,
  active: `SELECT m.id, m.business_name, m.email FROM merchants m
        WHERE m.id IN (
          SELECT DISTINCT s.merchant_id FROM store_orders o JOIN stores s ON s.id = o.store_id
          WHERE o.created_at >= $1 AND o.status <> ALL($2::text[])
        ) AND (m.business_name, m.id) > ($3, $4::uuid) ORDER BY m.business_name, m.id LIMIT 26`,
};
for (const fragment of [
  "SELECT DISTINCT s.merchant_id FROM store_orders o JOIN stores s ON s.id = o.store_id",
  "ORDER BY m.business_name, m.id LIMIT",
  "(m.business_name, m.id) > (",
  "m.approval_status = 'approved' AND m.id NOT IN (",
  "SELECT m.id, m.business_name, m.email FROM merchants m",
]) {
  if (!PULSE_SOURCE.includes(fragment)) throw new Error(`pulse transcription is stale — source no longer contains: ${fragment}`);
}

function assertOrderingAgrees(list) {
  const [primary, tie] = list.orderBy;
  const [field] = Object.keys(primary);
  if (field !== list.field) throw new Error(`${list.id}: orderBy field ${field} != keysetWhere field ${list.field}`);
  if (primary[field] !== list.dir) throw new Error(`${list.id}: orderBy direction != keysetWhere direction`);
  if (tie.id !== list.dir) throw new Error(`${list.id}: the id tiebreaker runs the other way — pages will overlap`);
}

/** A cursor half-way down the list: page 1 hides the defect, page N/2 does not. */
async function midCursor(list) {
  const total = await prisma[list.model].count({ where: list.where });
  const skip = Math.max(0, Math.floor(total / 2));
  const [row] = await prisma[list.model].findMany({
    where: list.where, orderBy: list.orderBy, skip, take: 1,
    select: { id: true, [list.field]: true },
  });
  return { total, cursor: row ? { value: String(row[list.field] instanceof Date ? row[list.field].toISOString() : row[list.field]), id: row.id } : undefined };
}

async function capturePageSql(list, cursor) {
  captured.length = 0;
  await prisma[list.model].findMany({
    where: { ...list.where, ...keysetWhere(list.field, list.dir, cursor, list.parse ?? "date") },
    orderBy: list.orderBy,
    take: LIST_LIMIT_DEFAULT + 1,
  });
  const event = captured.filter((e) => e.query.includes(`"${list.table}"`)).pop();
  if (!event) throw new Error(`${list.id}: no SQL captured for ${list.table}`);
  return { text: event.query, values: JSON.parse(event.params) };
}

/** Median of five, after one warm-up: a single ANALYZE run is noise, not a number. */
async function explain(text, values) {
  const run = async () => (await sql.query({ text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`, values })).rows[0]["QUERY PLAN"][0];
  await run();
  const runs = [];
  for (let i = 0; i < 5; i += 1) runs.push(await run());
  runs.sort((a, b) => a["Execution Time"] - b["Execution Time"]);
  const median = runs[2];
  return {
    ms: median["Execution Time"],
    plan: median.Plan,
    text: JSON.stringify(median.Plan),
    shared: median.Plan["Shared Hit Blocks"] + (median.Plan["Shared Read Blocks"] ?? 0),
  };
}

function verdict(explained, table) {
  const t = explained.text;
  const seq = new RegExp(`"Node Type":"Seq Scan"[^}]*"Relation Name":"${table}"`).test(t);
  const sort = /"Node Type":"(Sort|Incremental Sort)"/.test(t);
  const nodes = [];
  const walk = (node) => { nodes.push(node["Node Type"] + (node["Index Name"] ? ` (${node["Index Name"]})` : "")); (node.Plans ?? []).forEach(walk); };
  walk(explained.plan);
  return { seq, sort, shape: nodes.join(" › ") };
}

const results = [];
for (const list of LISTS) {
  assertOrderingAgrees(list);
  const { total, cursor } = await midCursor(list);
  const { text, values } = await capturePageSql(list, cursor);
  const explained = await explain(text, values);
  results.push({ id: list.id, src: list.src, table: list.table, rows: total, ms: explained.ms, buffers: explained.shared, ...verdict(explained, list.table) });
}

{
  const anchor = (await sql.query("SELECT business_name, id FROM merchants ORDER BY business_name, id OFFSET 30000 LIMIT 1")).rows[0];
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const total = (await one("SELECT count(*)::int AS id FROM merchants")).id;
  for (const [kind, values] of [
    ["never_sold", [["cancelled", "rejected"], anchor.business_name, anchor.id]],
    ["active", [sevenDaysAgo, ["cancelled", "rejected"], anchor.business_name, anchor.id]],
  ]) {
    const explained = await explain(PULSE[kind], values);
    results.push({
      id: `platform.pulse.cohort/${kind}`, src: "platform-pulse.service.ts:141", table: "merchants",
      rows: total, ms: explained.ms, buffers: explained.shared, ...verdict(explained, "merchants"),
    });
  }
}

const label = process.argv[2] ?? "run";
console.log(JSON.stringify({ label, results }, null, 2));

await prisma.$disconnect();
await sql.end();
