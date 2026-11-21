/**
 * PS-2 — every route on an identity's OWN account surface must be reachable
 * from the interface.
 *
 * WHY THIS GUARD EXISTS, precisely.
 *
 * 19-أ shipped the platform owner's second factor whole: the service, the
 * routes, the migration, the login path, and an integration test that proves all
 * of it green. ق-124 then made the factor mandatory for him. Every one of those
 * pieces was correct, and the factor was still impossible to turn on for a
 * month — because no screen ever called `/platform/security/totp/begin`. Staff
 * got an enrolment screen; the owner, the one identity with nobody above him to
 * restore access, got none. Nothing in the repository could tell: a route with
 * no caller compiles, tests green, deploys, and answers 200 to a request no
 * human being can make.
 *
 * It was found by the owner opening his own security page on the live platform.
 * That is not a detection mechanism.
 *
 * THE RULE. Every path registered in the files below must appear as a literal
 * `/api…` string somewhere under `client/src`. It is deliberately dumb: it does
 * not prove the screen works, only that a caller EXISTS. That is the whole gap
 * this class of defect lives in, and dumb is why it cannot itself rot.
 *
 * SCOPE. Only surfaces where an identity acts on its own account — the place
 * where "unreachable" means a person is locked out of his own security with no
 * one to appeal to. It is not a general route-coverage guard and must not grow
 * into one: an admin route with no button is a missing feature, while THIS is a
 * promise the platform makes to someone about his own account and then breaks.
 *
 * Run: pnpm owner:surface:guard
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const CLIENT_SRC = path.join(repoRoot, "client", "src");

/** Route modules whose paths a person must be able to reach from a screen. */
const SURFACES = [
  "phase1-backend/src/http/routes/owner-security.ts",
  "phase1-backend/src/http/routes/account-security.ts",
];

/**
 * Paths with no client caller ON PURPOSE. Each needs a reason, and "not built
 * yet" is not one — that is exactly the state this guard is here to report.
 */
const EXEMPT = new Map([]);

/** The mount `createApp()` sits behind inside the composite server. */
const API_PREFIX = "/api";

function sourceFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (/\.(tsx?|jsx?)$/.test(entry)) found.push(full);
  }
  return found;
}

/** `app.get("/platform/security/totp", …)` → `/platform/security/totp` */
export function registeredPaths(source) {
  const paths = [];
  for (const match of source.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)) {
    paths.push({ method: match[1].toUpperCase(), route: match[2] });
  }
  return paths;
}

const clientSource = sourceFiles(CLIENT_SRC)
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

const unreachable = [];
let checked = 0;

for (const surface of SURFACES) {
  const source = readFileSync(path.join(repoRoot, surface), "utf8");
  for (const { method, route } of registeredPaths(source)) {
    const url = `${API_PREFIX}${route}`;
    if (EXEMPT.has(url)) continue;
    checked += 1;
    if (!clientSource.includes(url)) unreachable.push({ surface, method, url });
  }
}

if (unreachable.length) {
  console.error(
    `PS-2: ${unreachable.length} route(s) on an owner's own account surface have NO caller in client/src. ` +
      `A person cannot reach his own account settings, and nothing else in this repository would say so:\n` +
      unreachable
        .map((entry) => `  ${entry.method} ${entry.url} — registered in ${entry.surface}`)
        .join("\n") +
      `\n\nBuild the screen, or add the path to EXEMPT with the reason it has no caller.`
  );
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify(
      {
        suite: "owner-surface",
        status: "passed",
        summary: {
          surfaces: SURFACES.length,
          routesChecked: checked,
          unreachable: 0,
          exempt: EXEMPT.size,
        },
      },
      null,
      2
    )
  );
}
