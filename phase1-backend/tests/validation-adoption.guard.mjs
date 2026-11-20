/**
 * Phase 19-ج adoption ratchet — the same mechanism as the design tokens, for the
 * same reason: a foundation nobody adopts is a foundation that rots.
 *
 * Converting all 88 write endpoints in one change would be unreviewable, and
 * doing them "as we touch them" is how a second validation style lives beside
 * the first for a year. So this counts the write routes that still read
 * `request.body` without a schema, per file, and refuses to let that number
 * grow — while any NEW route file must be schema-validated from the start.
 *
 * The count is deliberately a HEURISTIC (a route handler that mentions
 * `request.body` and no `parseOrThrow`/`validateBody`), and it is stated as one.
 * A heuristic that stops the number rising is worth more than an exact measure
 * nobody runs, and it cannot pass a route that is genuinely unvalidated.
 *
 * Run: pnpm validation:guard
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { routeFileLabel, routeSourceFiles } from "../source-layout.mjs";

const ROUTES = fileURLToPath(new URL("../src/http/routes", import.meta.url));
const LEGACY = JSON.parse(readFileSync(new URL("./validation-adoption.legacy.json", import.meta.url), "utf8"));

/** Where a write route is registered. The BODY is sliced separately, below. */
const ROUTE_HEAD = /app\.(post|put|patch|delete)\((["'`])(.*?)\2/g;
/** Any route registration — a single-line route's body ends where the next begins. */
const ANY_ROUTE = /\n {2}app\.(get|post|put|patch|delete)\(/g;

/**
 * A route's body runs to the FIRST of: the next route registration, or the
 * `\n  }));` that closes a multi-line handler.
 *
 * The `\n  }));` terminator alone was a blind spot with teeth: a single-line
 * route (whole handler on one line) has no such terminator of its own, so its
 * span ran on until some LATER route's closing line — swallowing every route
 * in between. Measured on catalog.ts during 19-ج: the file reported ONE
 * unvalidated route and contained EIGHT. Converting only the named one would
 * have zeroed the file's count with seven still hand-rolled — a ratchet that
 * lies with confidence, which is worse than no ratchet at all.
 */
function routeBody(source, startIndex) {
  ANY_ROUTE.lastIndex = startIndex + 1;
  const next = ANY_ROUTE.exec(source);
  const closer = source.indexOf("\n  }));", startIndex);
  const ends = [next ? next.index : Infinity, closer === -1 ? Infinity : closer + 7];
  const end = Math.min(ends[0], ends[1]);
  return source.slice(startIndex, end === Infinity ? source.length : end);
}

function unvalidated(source) {
  const found = [];
  ROUTE_HEAD.lastIndex = 0;
  let match;
  while ((match = ROUTE_HEAD.exec(source))) {
    const handler = routeBody(source, match.index);
    if (!handler.includes("request.body")) continue;         // nothing to validate
    if (handler.includes("parseOrThrow") || handler.includes("validateBody")) continue;
    found.push(`${match[1].toUpperCase()} ${match[3]}`);
  }
  return found;
}

const failures = [];
const improved = [];
let remaining = 0;

for (const full of routeSourceFiles()) {
  const entry = routeFileLabel(full);
  const routes = unvalidated(readFileSync(full, "utf8"));
  const allowed = LEGACY[entry];
  remaining += routes.length;

  if (routes.length === 0) {
    if (allowed !== undefined) improved.push(`${entry} is fully validated — delete its entry`);
    continue;
  }
  if (allowed === undefined) {
    failures.push(`${entry}: ${routes.length} write route(s) reading request.body with no schema, in a file with no legacy allowance.\n`
      + `    ${routes.slice(0, 3).join(", ")}${routes.length > 3 ? ", …" : ""}\n`
      + `    Give it a schema in src/http/schemas/ and parse with parseOrThrow — shape at the edge, meaning in the service.`);
  } else if (routes.length > allowed) {
    failures.push(`${entry}: ${routes.length} unvalidated write routes, up from ${allowed}. This file's debt may only shrink.\n    ${routes.join(", ")}`);
  } else if (routes.length < allowed) {
    improved.push(`${entry} is down to ${routes.length} (was ${allowed}) — lower its number`);
  }
}

if (improved.length) {
  console.log("Progress — update validation-adoption.legacy.json so the ratchet holds:");
  for (const line of improved) console.log(`  · ${line}`);
  console.log("");
}
if (failures.length) {
  console.error("Validation adoption guard failed:\n");
  for (const failure of failures) console.error(`  ✗ ${failure}\n`);
  process.exit(1);
}
console.log(`validation:guard ok — no new hand-rolled validation. ${remaining} write route(s) still to convert.`);
