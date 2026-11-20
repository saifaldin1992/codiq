/**
 * المرحلة 20-3 «الأداء والفهارس» — the keyset-index ratchet.
 *
 * Same mechanism as `list-envelope.guard.mjs` and `validation-adoption.guard.mjs`,
 * for the same reason: 20-2 gave every list ONE page shape, and that shape is
 * fast only on an index that is exactly `(ordering_col, id)` — with the tenant
 * column leading it where there is one. Without such an index the page is a
 * fresh sort of the whole partition, which is invisible in every test, in every
 * review, and on every developer laptop with two hundred rows in the table.
 *
 * WHAT IT ASKS, of every `keysetWhere(...)` call site in the backend:
 *
 *   1. IS THERE A REGISTRY ROW FOR IT?  `keyset-index.map.json` names, per
 *      list, the index that list rides. A NEW keyset list has no row, and that
 *      is the failure — the ratchet is about the next list, not this one's.
 *   2. DOES THE NAMED INDEX EXIST?  Not «is it declared» — the DDL is read from
 *      `prisma/migrations/**` in order, honouring DROP INDEX, because that is
 *      what actually runs against a database. A schema.prisma `@@index` that no
 *      migration ever created is a real bug this repository has already had
 *      (noted in migration 20260904100000) and it must not pass as coverage.
 *   3. DOES THE INDEX END IN `(ordering_col, id)`?  An index that stops before
 *      `id` leaves the tiebreaker to a sort, and one whose ordering column sits
 *      behind an unconstrained column cannot be walked in order at all.
 *   4. DOES THE SOURCE STILL AGREE WITH THE REGISTRY?  The ordering field and
 *      direction are read from the call site, mapped to a column through
 *      schema.prisma, and compared. A list that changes its sort column and
 *      keeps its old registry row is the exact silent-drift case.
 *   5. DOES `orderBy` AGREE WITH `keysetWhere`?  `keysetWhere(f, d)` beside
 *      `orderBy: [{ f: d }, { id: d }]` — if they disagree the pages OVERLAP or
 *      SKIP rows, which is a correctness bug, not a performance one. It is
 *      checked here because this is the guard that already has both in hand.
 *   6. IS EVERY REGISTRY ROW STILL REAL?  A row whose call site is gone is
 *      deleted, not left to rot into a false «covered».
 *
 * A list that genuinely needs no index of its own — because an existing one
 * already serves it, MEASURED — sets `"index": null` WITH A WRITTEN REASON that
 * carries the two numbers. That count may only FALL.
 *
 * WHY A REGISTRY RATHER THAN INFERENCE. The tempting version of this guard
 * derives the required index from the `where` object and looks for a match. It
 * would have to decide, from source text, which filters are always present,
 * whether a partial index's predicate is implied by the query, and whether the
 * planner can actually walk a given index in order. Every one of those is a
 * guess, and a guard that guesses wrong in the GREEN direction is worse than no
 * guard — this session has three of those on record: the csrf convention broken
 * on 21 routes with no guard watching, the validation ratchet blind to
 * single-line routes reporting 1 where there were 8, and 20-2's own first
 * ratchet missing the literal offender it was written to catch. This one cannot
 * report coverage it has not been told about: an unregistered call site is a
 * failure, full stop.
 *
 * No database, no network, no production access: source and migrations only.
 *
 * Run: pnpm keyset:guard
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const BACKEND = path.join(ROOT, "phase1-backend", "src");
const MIGRATIONS = path.join(ROOT, "prisma", "migrations");
const SCHEMA = path.join(ROOT, "prisma", "schema.prisma");
const REGISTRY = path.join(HERE, "keyset-index.map.json");
const MIN_REASON = 40;

const failures = [];
const stale = [];
const fail = (message) => failures.push(message);

// ─────────────────────────────────────────────────────────── schema.prisma
/**
 * model → { table, columns: { fieldName: columnName } }.
 * The field→column map is what turns a `keysetWhere("createdAt", …)` in
 * TypeScript into the `created_at` an index is actually built on.
 */
function readSchema() {
  const source = readFileSync(SCHEMA, "utf8");
  const models = new Map();
  const modelRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let match;
  while ((match = modelRe.exec(source))) {
    const [, name, body] = match;
    const table = (body.match(/@@map\("([^"]+)"\)/) ?? [undefined, name])[1];
    const columns = {};
    const declared = [];
    const precision = {};
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("@@")) {
        const idx = trimmed.match(/^@@(index|unique)\(\[([^\]]*)\](?:.*?map:\s*"([^"]+)")?/);
        if (idx) declared.push({ fields: idx[2], map: idx[3] ?? null, kind: idx[1] });
        continue;
      }
      const field = trimmed.match(/^(\w+)\s+\S+/);
      if (!field || trimmed.startsWith("//") || trimmed.startsWith("///")) continue;
      const mapped = trimmed.match(/@map\("([^"]+)"\)/);
      columns[field[1]] = mapped ? mapped[1] : field[1];
      // ق-242: the declared STORAGE precision, which the cursor has to be able
      // to carry. `DateTime` alone is not enough to know that.
      const scalar = trimmed.match(/^\w+\s+(\w+)/);
      const stamp = trimmed.match(/@db\.Timestamptz\((\d+)\)/);
      if (scalar?.[1] === "DateTime") precision[field[1]] = stamp ? Number(stamp[1]) : null;
    }
    models.set(name, { table, columns, declared, precision });
  }
  return models;
}

const MODELS = readSchema();

// ───────────────────────────────────────────────────────────── migrations
/**
 * The DDL as it will actually be applied: every migration in filename order,
 * CREATE INDEX adding and DROP INDEX removing, so an index created in August
 * and dropped in September does not count as coverage in October.
 *
 * Only b-tree indexes are collected. A GIN trigram index (PG-6, ق-144) serves a
 * substring search and can never serve an ORDER BY, so counting one as
 * coverage would be precisely the lie this guard exists to prevent.
 */
function readMigrationIndexes() {
  const live = new Map();
  const dirs = readdirSync(MIGRATIONS).filter((entry) => statSync(path.join(MIGRATIONS, entry)).isDirectory()).sort();
  for (const dir of dirs) {
    const file = path.join(MIGRATIONS, dir, "migration.sql");
    let sql;
    try { sql = readFileSync(file, "utf8"); } catch { continue; }
    // Strip `-- …` comments so a CREATE INDEX quoted inside a rationale block
    // never counts as one that runs.
    const bare = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    const createRe = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?\s+ON\s+(?:public\.)?"?(\w+)"?\s*(?:USING\s+(\w+)\s*)?\(([^;]*?)\)\s*(WHERE\s[^;]*?)?;/gis;
    let match;
    while ((match = createRe.exec(bare))) {
      const [, name, table, method, columnList, predicate] = match;
      if (method && method.toLowerCase() !== "btree") { live.delete(name); continue; }
      const columns = columnList.split(",").map((part) => part.trim().replace(/"/g, "").split(/\s+/)[0]).filter(Boolean);
      live.set(name, { name, table, columns, partial: Boolean(predicate), migration: dir });
    }
    for (const drop of bare.matchAll(/DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?"?(\w+)"?/gis)) live.delete(drop[1]);
  }
  return live;
}

const DDL = readMigrationIndexes();

// ─────────────────────────────────────────────────────── the call sites
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** The nearest top-level declaration above an offset — the list's own name. */
function enclosingFunction(source, offset) {
  const before = source.slice(0, offset).split("\n");
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const named = before[i].match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=/);
    if (named) return named[1] ?? named[2];
  }
  return null;
}

/**
 * The value of a key at DEPTH 1 of an object literal's text — never one nested
 * inside a `select:` or a relation filter.
 */
function topLevelValue(objectText, key) {
  let depth = 0;
  for (let i = 0; i < objectText.length; i += 1) {
    const char = objectText[i];
    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") depth -= 1;
    else if (depth === 1 && objectText.startsWith(`${key}:`, i) && !/[\w$]/.test(objectText[i - 1] ?? "")) {
      const after = objectText.slice(i + key.length + 1);
      const opener = after.match(/^\s*(\[|\{)/);
      if (opener) return balanced(after, after.indexOf(opener[1]), opener[1] === "[" ? "[]" : "{}");
      const name = after.match(/^\s*([A-Za-z_$][\w$]*)/);
      return name ? name[1] : null;
    }
  }
  return null;
}

/** Balanced slice from `open`, which must be the opening bracket. */
function balanced(source, open, pair = "{}") {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === pair[0]) depth += 1;
    else if (source[i] === pair[1]) { depth -= 1; if (depth === 0) return source.slice(open, i + 1); }
  }
  return null;
}

const sites = [];
for (const file of walk(BACKEND)) {
  const source = readFileSync(file, "utf8");
  const rel = path.relative(BACKEND, file).split(path.sep).join("/");
  const callRe = /keysetWhere\(\s*"([^"]+)"\s*,\s*"(asc|desc)"/g;
  let match;
  while ((match = callRe.exec(source))) {
    // The declaration itself, not a call site.
    if (/export function keysetWhere/.test(source.slice(Math.max(0, match.index - 40), match.index))) continue;
    const [, field, direction] = match;
    const fn = enclosingFunction(source, match.index);
    if (!fn) { fail(`${rel} — a keysetWhere(...) call sits outside any named function; the ratchet cannot key it. Move it into one.`); continue; }
    // The ordering tuple that must agree with the keyset.
    //
    // It has to come from the findMany's OWN `orderBy`, at depth 1 of its
    // argument object — the first `orderBy:` after the call site belongs to a
    // nested relation more often than not (`entitlement.service.ts` selects
    // `subscriptions: { orderBy: { startedAt: "desc" } }` before its own), and
    // reading that one is exactly how a ratchet ends up checking the wrong
    // thing and reporting green. The value is either an array literal or a name
    // bound to one (`soft-delete.service.ts` shares ONE `order` across its four
    // reads); a third shape is REPORTED, never skipped.
    // Which read does this keyset belong to? Two shapes exist in the codebase:
    // the predicate spread straight into `findMany({ where: { …keysetWhere() } })`,
    // and a `const page = { …keysetWhere() }` built first and then handed to one
    // or more reads below it (soft-delete's trash bin hands ONE to four). So:
    // the enclosing findMany if the call sits inside one, otherwise the first
    // findMany after it. Neither found is a failure, not a skip.
    const enclosing = source.lastIndexOf(".findMany(", match.index);
    let args = null;
    if (enclosing !== -1) {
      const span = balanced(source, source.indexOf("{", enclosing));
      if (span && match.index < source.indexOf("{", enclosing) + span.length) args = span;
    }
    if (!args) {
      const next = source.indexOf(".findMany(", match.index);
      if (next !== -1) args = balanced(source, source.indexOf("{", next));
    }
    let orderBy = null;
    if (!args) {
      fail(`${rel} — ${fn}(): this keysetWhere(...) belongs to no .findMany( the ratchet can find. The ordering cannot be checked.`);
    } else {
      const raw = topLevelValue(args, "orderBy");
      if (raw === null) fail(`${rel} — ${fn}(): the findMany carrying this keysetWhere has no orderBy of its own.`);
      else if (raw.startsWith("[")) orderBy = raw;
      else {
        const bound = source.match(new RegExp(String.raw`const\s+${raw.trim()}\s*=\s*\[`));
        if (bound) orderBy = balanced(source, source.indexOf("[", bound.index), "[]");
        if (!orderBy) fail(`${rel} — ${fn}(): orderBy is \`${raw.trim()}\`, which is neither an array literal nor a name bound to one in this file. Inline it so the ordering can be checked.`);
      }
    }
    sites.push({ key: `${rel}#${fn}`, rel, fn, field, direction, orderBy });
  }
}
if (sites.length === 0) fail("no keysetWhere(...) call sites found at all — the scan is broken, not the code.");

// ─────────────────────────────────────────────────────────── the registry
const registry = JSON.parse(readFileSync(REGISTRY, "utf8"));
const rows = new Map(registry.lists.map((row) => [row.key, row]));
let unindexed = 0;

for (const site of sites) {
  const row = rows.get(site.key);
  if (!row) {
    fail(`${site.rel} — ${site.fn}() pages with keysetWhere("${site.field}", "${site.direction}") and has no row in tests/keyset-index.map.json.\n`
      + `    Add one naming the composite index this page rides — (…tenant, ${site.field}, id) — after MEASURING it\n`
      + `    with EXPLAIN (ANALYZE, BUFFERS) at a cursor half way down the list, the way\n`
      + `    phase1-backend/tests/perf-index-evidence.mjs does. If an existing index already serves it, set\n`
      + `    "index": null and put BOTH numbers in "reason".`);
    continue;
  }
  row.seen = true;

  // (5) the ordering tuple must be the one the keyset walks, or pages overlap.
  if (site.orderBy) {
    // `as const` is a type annotation, not part of the ordering tuple.
    const flat = site.orderBy.replace(/as const/g, "").replace(/\s+/g, "");
    if (!flat.startsWith(`[{${site.field}:"${site.direction}"}`)) {
      fail(`${site.rel} — ${site.fn}(): orderBy does not start with { ${site.field}: "${site.direction}" }, but keysetWhere does.\n    Got ${site.orderBy.replace(/\s+/g, " ")}. Pages built on two different orderings overlap or skip rows.`);
    }
    if (!flat.includes(`{id:"${site.direction}"}`)) {
      fail(`${site.rel} — ${site.fn}(): the id tiebreaker in orderBy must run "${site.direction}", the same way as the keyset.\n    Got ${site.orderBy.replace(/\s+/g, " ")}.`);
    }
  }

  const model = MODELS.get(row.model);
  if (!model) { fail(`tests/keyset-index.map.json — ${site.key} names model "${row.model}", which is not in schema.prisma.`); continue; }
  const column = model.columns[site.field];
  if (!column) { fail(`tests/keyset-index.map.json — ${site.key}: model ${row.model} has no field "${site.field}".`); continue; }
  if (row.column !== column) {
    fail(`tests/keyset-index.map.json — ${site.key} records column "${row.column}" but ${row.model}.${site.field} maps to "${column}".\n    The list changed its sort column; the index it needs changed with it.`);
    continue;
  }

  /**
   * ق-242 — THE CURSOR MUST BE ABLE TO CARRY WHAT THE COLUMN STORES.
   *
   * `encodeListCursor` serialises with `Date.toISOString()`, and a JS Date holds
   * whole milliseconds. A column declared `Timestamptz(6)` stores microseconds,
   * so the two sides of one rule disagree about the same instant: a DESCENDING
   * page then asks `created_at <= …494` for a row stored `…494832`, which is
   * false, and every row sharing that millisecond is never served again — a
   * short answer with nothing in it that looks like an error. An ASCENDING page
   * asks `>=` and serves the boundary row forever; with `limit=1` it never
   * advances at all.
   *
   * MEASURED, so the rule is not larger than its reason: Prisma supplies
   * `@default(now())` itself at MILLISECOND precision, so today's writes tie on
   * whole milliseconds and the id tiebreaker already covers them. It is a write
   * that lets the COLUMN DEFAULT fire — raw SQL, a trigger, a backfill — that
   * lands a sub-millisecond value, and every one of these columns carries
   * `DEFAULT now()`. This keeps that door shut.
   *
   * Enforced HERE because this is the file that already knows which columns a
   * keyset orders on. A new list added to a `(6)` column fails the build with
   * the migration it owes, rather than silently dropping rows in production.
   */
  const declaredPrecision = model.precision?.[site.field];
  if (declaredPrecision !== undefined && declaredPrecision !== 3) {
    fail(`prisma/schema.prisma — ${row.model}.${site.field} is ordered by a keyset (${site.key}) but is declared `
      + `${declaredPrecision === null ? "without an explicit @db.Timestamptz(n)" : `@db.Timestamptz(${declaredPrecision})`}.\n`
      + `    A cursor carries milliseconds (Date.toISOString()); anything finer is stored and never named, so pages\n`
      + `    drop rows silently. Add a migration «ALTER TABLE "${model.table}" ALTER COLUMN "${column}" TYPE timestamptz(3)»\n`
      + `    and declare @db.Timestamptz(3) here. Do it while the table is small — narrowing the precision rewrites it.`);
  }

  if (row.index === null) {
    unindexed += 1;
    if (typeof row.reason !== "string" || row.reason.trim().length < MIN_REASON) {
      fail(`tests/keyset-index.map.json — ${site.key} claims no index is needed with no real reason (${MIN_REASON}+ characters, and it must carry the measured before/after).`);
    } else if (!/\d/.test(row.reason)) {
      fail(`tests/keyset-index.map.json — ${site.key} claims no index is needed but its reason carries no measurement.\n    «هذا أسرع» بلا قياس = رأي (OPERATING_GUIDE). Put the two numbers in it.`);
    }
    continue;
  }

  const index = DDL.get(row.index);
  if (!index) {
    fail(`${site.rel} — ${site.fn}() rides index "${row.index}", which NO migration in prisma/migrations creates (or a later one drops it).\n`
      + `    A declaration in schema.prisma is not an index; only the DDL is. Add the CREATE INDEX to a migration.`);
    continue;
  }
  if (index.table !== model.table) {
    fail(`tests/keyset-index.map.json — ${site.key} names "${row.index}", which is on "${index.table}", not on ${row.model}'s table "${model.table}".`);
    continue;
  }
  const tail = index.columns.slice(-2);
  if (tail[0] !== column || tail[1] !== "id") {
    fail(`${site.rel} — ${site.fn}() orders by (${column}, id) but "${row.index}" is (${index.columns.join(", ")}).\n`
      + `    A keyset page rides an index that ENDS in (${column}, id): anything after them cannot be walked in order,\n`
      + `    and stopping before id leaves the tiebreaker to a sort.`);
  }
}

for (const row of registry.lists) {
  if (!row.seen) stale.push(`${row.key} is in tests/keyset-index.map.json but no keysetWhere(...) call site matches it — delete the row.`);
}

// ────────────────────────────────── declared-but-never-created (the drift)
/**
 * The second axis, and the one migration 20260904100000 names by example:
 * schema.prisma declared an InventoryReservation index that no migration ever
 * created. A `@@index` is a promise about the database; this checks the
 * database was actually told.
 */
const driftAllowed = new Set(registry.schemaOnlyIndexes ?? []);
let drift = 0;
for (const [name, model] of MODELS) {
  for (const declared of model.declared) {
    if (declared.kind !== "index") continue;
    const columns = declared.fields.split(",").map((part) => part.trim().split("(")[0]).map((field) => model.columns[field] ?? field);
    const mapped = declared.map;
    const found = mapped
      ? DDL.get(mapped)
      : [...DDL.values()].find((idx) => idx.table === model.table && idx.columns.join(",") === columns.join(","));
    if (found) continue;
    const label = `${name}.@@index([${declared.fields}])${mapped ? ` map:"${mapped}"` : ""}`;
    drift += 1;
    if (!driftAllowed.has(label)) {
      fail(`prisma/schema.prisma — ${label} is declared but no migration creates it.\n`
        + `    Either add the CREATE INDEX to a migration, or list it under "schemaOnlyIndexes" in\n`
        + `    tests/keyset-index.map.json if it is genuinely created some other way.`);
    }
  }
}
for (const label of driftAllowed) {
  if (!label.includes("@@index")) stale.push(`"schemaOnlyIndexes" entry ${label} is not an @@index label — it can never match.`);
}

// ─────────────────────────────────────────────────────────────── verdict
if (stale.length) {
  console.log("Progress — update tests/keyset-index.map.json so the ratchet holds:");
  for (const line of stale) console.log(`  · ${line}`);
  console.log("");
}
if (failures.length) {
  console.error("Keyset index guard failed:\n");
  for (const failure of failures) console.error(`  ✗ ${failure}\n`);
  process.exit(1);
}
if (stale.length) process.exit(1);
console.log(
  `keyset:guard ok — ${sites.length} keyset list(s) across ${new Set(sites.map((s) => s.rel)).size} file(s); `
  + `${DDL.size} b-tree index(es) read from prisma/migrations; `
  + `${unindexed} list(s) allowlisted as needing no index of their own; ${drift} declared-but-uncreated index(es). `
  + `The last two numbers may only fall.`,
);
