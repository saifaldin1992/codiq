/**
 * المرحلة 20-2 «العقد الموحّد» — the list-contract ratchet.
 *
 * Same mechanism as `validation-adoption.guard.mjs`, for the same reason: a
 * contract nobody enforces drifts back. This one answers two questions about
 * every `app.get` route that produces a collection:
 *
 *   1. CAN IT REACH PAGE 2?  A route that returns «all rows for this store» is
 *      a time bomb at the first merchant with a thousand products — the whole
 *      of D-18. The route (or the service it delegates to) must thread a
 *      `nextCursor`.
 *   2. IS ITS CURSOR THE HOUSE DIALECT?  A page that mints `nextCursor` must
 *      mint it through `encodeListCursor`/`pageOf` in `services/list-page.ts`.
 *      Three dialects coexisted before 20-2 — an encoded keyset, a Prisma
 *      `cursor:{id}` anchor read, and a pipe-joined `deletedAt|id` string — and
 *      a fourth would arrive the same way the third did: quietly, in one file.
 *   3. DOES IT SAY WHICH STORE IT IS A LIST OF?  `catalog.ts` sent `storeSlug`
 *      on one route and not on the two beside it — the [pagination] audit's own
 *      example of how thirty-one collection keys across six envelope shapes
 *      came to exist. A store-scoped list echoes `storeSlug`.
 *
 * DETECTION IS MECHANICAL, NOT BY NAME. A GET route counts as a list route when
 * its handler — or any function it calls, followed one hop into the services —
 * reads rows with `.findMany(`, `.groupBy(` or a raw query. Naming heuristics
 * were rejected on purpose: the house convention is `list*`, but
 * `abandonedCartsPanel`, `salesSeries`, `pulseCohort` and `boughtTogether` are
 * all collections that do not follow it, and a ratchet blind to four known
 * offenders is the ratchet that lied with confidence in 19-ج.
 *
 * OVER-DETECTION IS THE SAFE DIRECTION and is used deliberately: a route the
 * rule flags that is genuinely bounded by its domain — eighteen governorates,
 * five session tables, one order's own line items — goes in the allowlist WITH
 * A WRITTEN REASON. The mandate says to say it in a comment rather than
 * silently; the allowlist is that comment, in a file CI reads.
 *
 * Both counters may only FALL.
 *
 * Run: pnpm list:guard
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { routeFileLabel, routeSourceFiles } from "../source-layout.mjs";

const BACKEND = fileURLToPath(new URL("../src", import.meta.url));
const ROUTES = path.join(BACKEND, "http", "routes");
const LEGACY = JSON.parse(readFileSync(new URL("./list-envelope.legacy.json", import.meta.url), "utf8"));

const MIN_REASON = 20;
/** Reading rows. `$queryRaw` covers the raw-SQL lists the ORM never sees. */
const READS_ROWS = /\.findMany\s*\(|\.groupBy\s*\(|\$queryRaw|\$queryRawUnsafe/;
/** The shared dialect. A page that mints a cursor any other way is hand-rolled. */
const HOUSE_CURSOR = /encodeListCursor|pageOf\s*\(/;

/** Every route registration; a single-line route's body ends where the next begins. */
const ANY_ROUTE = /\n {2}app\.(get|post|put|patch|delete)\(/g;
const GET_ROUTE = /app\.get\((["'`])(.*?)\1/g;

/**
 * Lifted verbatim from `validation-adoption.guard.mjs`, including the blind-spot
 * fix that cost a false «fully validated» reading: the `\n  }));` terminator
 * alone made a single-line route's span run on until some LATER route's closing
 * line, swallowing every route in between.
 */
function routeBody(source, startIndex) {
  ANY_ROUTE.lastIndex = startIndex + 1;
  const next = ANY_ROUTE.exec(source);
  const closer = source.indexOf("\n  }));", startIndex);
  const ends = [next ? next.index : Infinity, closer === -1 ? Infinity : closer + 7];
  const end = Math.min(ends[0], ends[1]);
  return source.slice(startIndex, end === Infinity ? source.length : end);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * name → body text, brace-matched.
 *
 * The scan cannot simply take «the first `{` after the name»: a parameter's
 * inline object type (`store: { id: string; slug: string }`) and a return type
 * (`Promise<{ customers: Row[]; nextCursor: string | null }>`) both contain
 * braces BEFORE the body, and taking either of them silently truncated the
 * indexed body to a type annotation. That is how the first run of this guard
 * missed `sendProductsForStore` — the literal D-18 offender it was written to
 * catch. So: skip the type parameters, balance the parameter list, then skip
 * the return type by counting angle brackets, and only then open the body.
 *
 * Collisions concatenate: detection must never lose a hit to a shared name.
 */
function indexFunctions(source, into) {
  const declaration = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?=[<(]|function\b)/g;
  let match;
  while ((match = declaration.exec(source))) {
    const name = match[1] ?? match[2];
    let i = declaration.lastIndex;
    const skipSpace = () => { while (i < source.length && /\s/.test(source[i])) i += 1; };
    skipSpace();
    if (source.startsWith("function", i)) { i += "function".length; skipSpace(); }
    // Optional type parameters.
    if (source[i] === "<") {
      let angle = 0;
      for (; i < source.length; i += 1) {
        if (source[i] === "<") angle += 1;
        else if (source[i] === ">") { angle -= 1; if (angle === 0) { i += 1; break; } }
      }
      skipSpace();
    }
    if (source[i] !== "(") continue;
    let parens = 0;
    for (; i < source.length; i += 1) {
      if (source[i] === "(") parens += 1;
      else if (source[i] === ")") { parens -= 1; if (parens === 0) { i += 1; break; } }
    }
    // The return type may itself carry braces inside angle brackets.
    let angle = 0;
    let open = -1;
    for (; i < source.length; i += 1) {
      const char = source[i];
      if (char === "<") angle += 1;
      else if (char === ">") angle = Math.max(0, angle - 1);
      else if (char === ";" && angle === 0) break;           // a declaration, no body
      else if (char === "{" && angle === 0) { open = i; break; }
    }
    if (open === -1) continue;
    let depth = 0;
    let end = open;
    for (; end < source.length; end += 1) {
      if (source[end] === "{") depth += 1;
      else if (source[end] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    into.set(name, (into.get(name) ?? "") + "\n" + source.slice(open, Math.min(end + 1, source.length)));
  }
}

const bodies = new Map();
for (const file of walk(path.join(BACKEND, "services"))) indexFunctions(readFileSync(file, "utf8"), bodies);
for (const file of routeSourceFiles()) indexFunctions(readFileSync(file, "utf8"), bodies);
for (const file of walk(path.join(BACKEND, "modules"))) indexFunctions(readFileSync(file, "utf8"), bodies);
// The soft-delete audit/trash lists and the notification log live beside the
// services; nothing else outside `services/` produces a collection today.

/**
 * Comments are PROSE, not behaviour.
 *
 * 20-3: `exportOrdersCsv` gained a comment explaining why it does NOT mint a
 * client-facing `nextCursor`, and that sentence alone moved the route out of
 * the «unpaginated» bucket and into «hand-rolled cursor» — the guard read a
 * word about the code as the code. It flips the other way just as easily: a
 * route that genuinely has no cursor passes the moment someone writes the word
 * in a TODO above it. So the detection text is stripped of `//` and block
 * comments first, and only real statements are searched.
 */
function stripComments(source) {
  // The `[^:]` before `//` keeps a URL inside a string literal (`https://…`)
  // from swallowing the rest of its line.
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** The handler plus one hop into everything it calls, with local helpers inlined. */
/**
 * ق-249: a GATE is not a producer. `assertCapabilityAvailable` reads the
 * availability overrides (a `.findMany`) to decide whether the route may run
 * at all, and hands nothing to the response. Following that hop made four
 * settings routes (loyalty, integrations, abandoned-cart settings,
 * analytics/customers) look like collections the day they gained the gate.
 * The hop stops at the gate.
 */
const GATES_NOT_PRODUCERS = new Set(["assertCapabilityAvailable", "resolveAvailability"]);

function producerText(handler) {
  let text = handler;
  const called = new Set();
  for (const match of handler.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g)) if (!GATES_NOT_PRODUCERS.has(match[1])) called.add(match[1]);
  for (const name of called) {
    const body = bodies.get(name);
    if (body) text += "\n" + body;
  }
  // A second hop: a route-file helper (`sendProductsForStore`) delegates to a
  // service function, and the collection lives at the far end of that call.
  const secondHop = new Set();
  for (const name of called) {
    const body = bodies.get(name);
    if (!body) continue;
    for (const match of body.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g)) if (!called.has(match[1])) secondHop.add(match[1]);
  }
  for (const name of secondHop) {
    const body = bodies.get(name);
    if (body) text += "\n" + body;
  }
  return text;
}

function allowanceFor(file, bucket, route) {
  const entries = LEGACY[file]?.[bucket] ?? [];
  return entries.find((entry) => entry.route === route);
}

const failures = [];
const stale = [];
let unpaginated = 0;
let handRolled = 0;
let missingSlug = 0;

for (const full of routeSourceFiles()) {
  const entry = routeFileLabel(full);
  const source = readFileSync(full, "utf8");
  const seenUnpaginated = new Set();
  const seenHandRolled = new Set();
  const seenMissingSlug = new Set();

  GET_ROUTE.lastIndex = 0;
  let match;
  while ((match = GET_ROUTE.exec(source))) {
    const route = `GET ${match[2]}`;
    const handler = routeBody(source, match.index);
    const rawText = producerText(handler);
    const text = stripComments(rawText);
    if (!READS_ROWS.test(text)) {
      // 20-3 tripwire: stripping comments must never make a route STOP being a
      // list route. If a `.findMany(` only ever appeared inside a comment the
      // route was never a producer; if it appeared in both, this cannot fire.
      if (READS_ROWS.test(rawText)) {
        failures.push(`${entry} — GET ${match[2]} reads rows only inside a COMMENT. Detection would have been driven by prose; write the guard a real signal.`);
      }
      continue;
    }

    if (!text.includes("nextCursor")) {
      unpaginated += 1;
      seenUnpaginated.add(route);
      const allowed = allowanceFor(entry, "unpaginated", route);
      if (!allowed) {
        failures.push(`${entry} — ${route} returns a collection with no nextCursor.\n`
          + `    Thread a cursor through services/list-page.ts (readListCursor + keysetWhere + pageOf),\n`
          + `    or — if this list is genuinely bounded by its domain — add it to\n`
          + `    tests/list-envelope.legacy.json under "unpaginated" with a written reason.`);
      } else if (typeof allowed.reason !== "string" || allowed.reason.trim().length < MIN_REASON) {
        failures.push(`${entry} — ${route} has an allowlist entry with no real reason (${MIN_REASON}+ characters required).`);
      }
      continue;
    }

    if (!HOUSE_CURSOR.test(text)) {
      handRolled += 1;
      seenHandRolled.add(route);
      const allowed = allowanceFor(entry, "handRolledCursor", route);
      if (!allowed) {
        failures.push(`${entry} — ${route} mints nextCursor without services/list-page.ts.\n`
          + `    One cursor dialect: base64url(JSON) with a version and a list kind, from encodeListCursor.\n`
          + `    A second dialect is how the third one arrived.`);
      } else if (typeof allowed.reason !== "string" || allowed.reason.trim().length < MIN_REASON) {
        failures.push(`${entry} — ${route} has an allowlist entry with no real reason (${MIN_REASON}+ characters required).`);
      }
    }
  }

  // The third axis, and the one the [pagination] audit named by example: a
  // store-scoped list must SAY which store it is a list of. `catalog.ts` sent
  // `storeSlug` on one route and not on the two beside it, and thirty-one
  // collection keys across six envelope shapes grew out of exactly that kind of
  // per-route decision. The echo is redundant with the path on purpose — it is
  // what makes a captured response self-describing, and it is what the majority
  // of these routes already did.
  GET_ROUTE.lastIndex = 0;
  while ((match = GET_ROUTE.exec(source))) {
    if (!match[2].includes(":storeSlug")) continue;
    const handler = routeBody(source, match.index);
    const text = stripComments(producerText(handler));
    if (!READS_ROWS.test(text)) continue;
    const route = `GET ${match[2]}`;
    // The echo may be set by the route or by a helper it delegates to.
    if (/storeSlug:/.test(text)) continue;
    missingSlug += 1;
    seenMissingSlug.add(route);
    const allowed = allowanceFor(entry, "missingStoreSlug", route);
    if (!allowed) {
      failures.push(`${entry} — ${route} is a store-scoped list whose envelope does not carry storeSlug.\n`
        + `    One envelope: { <resource>: T[], nextCursor, storeSlug, …facets }.`);
    } else if (typeof allowed.reason !== "string" || allowed.reason.trim().length < MIN_REASON) {
      failures.push(`${entry} — ${route} has an allowlist entry with no real reason (${MIN_REASON}+ characters required).`);
    }
  }

  for (const [bucket, seen] of [["unpaginated", seenUnpaginated], ["handRolledCursor", seenHandRolled], ["missingStoreSlug", seenMissingSlug]]) {
    for (const allowed of LEGACY[entry]?.[bucket] ?? []) {
      if (!seen.has(allowed.route)) stale.push(`${entry} → ${bucket} → ${allowed.route} is no longer detected — delete the entry.`);
    }
  }
}

if (stale.length) {
  console.log("Progress — update tests/list-envelope.legacy.json so the ratchet holds:");
  for (const line of stale) console.log(`  · ${line}`);
  console.log("");
}
if (failures.length) {
  console.error("List envelope guard failed:\n");
  for (const failure of failures) console.error(`  ✗ ${failure}\n`);
  process.exit(1);
}
if (stale.length) process.exit(1);
console.log(`list:guard ok — ${unpaginated} allowlisted unpaginated list route(s), ${handRolled} allowlisted hand-rolled cursor(s), ${missingSlug} allowlisted store-scoped list(s) with no storeSlug echo. Every number may only fall.`);
