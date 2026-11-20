/**
 * Integration — `/ready` survives a diagnostic it cannot read.
 *
 * WHAT HAPPENED. Minutes after the 2026-09-05 production deploy, `/api/ready`
 * answered `500 INTERNAL_ERROR` on every request:
 *
 *     ERROR: unrecognized configuration parameter "pg_trgm.word_similarity_threshold"
 *
 * `pg_trgm` registers that setting from its shared library, and PostgreSQL loads
 * an extension's library LAZILY — on first use of one of its functions in that
 * backend. `CREATE EXTENSION` writes catalog entries; it does not load the
 * module into every future connection. A fresh pooled connection that has never
 * answered a search therefore does not know the setting exists.
 *
 * WHY NOTHING CAUGHT IT. CI, staging and local runs all execute a search on the
 * same connection before ever calling `/ready`, which loads the module. The read
 * fails ONLY on a connection where nobody has searched — which is exactly what
 * production is, and only on its very first request. A green suite could not
 * have caught it; the shape of the test was the blind spot, not the coverage.
 *
 * SO THE ASSERTION HERE IS NOT «the threshold is 0.4». It is the structural
 * rule the outage taught: an OPTIONAL diagnostic must never be able to take down
 * the endpoint that carries it. `/ready` also reports the database, the mail
 * channel and the six configuration groups; losing all of that because one
 * number could not be read is the worse failure.
 *
 * Run: pnpm ready:test
 */
import assert from "node:assert/strict";

const summary = {};
const { createApp } = await import("../src/http/app.ts");
const { searchEngine } = await import("../src/services/search/index.ts");

const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// A failing assertion used to leave this server open, and node then died on
// Windows with `UV_HANDLE_CLOSING` and exit code 3221226505 — which reads as
// «127» through a pipe and hides WHY the suite failed behind a crash. The
// cleanup belongs on the way out, not only on the happy path.
process.on("exit", () => { try { server.close(); } catch { /* already closed */ } });

// ============================================================
// 1. The happy path — everything readable.
// ============================================================
const ok = await fetch(`${base}/ready`);
assert.equal(ok.status, 200, "a healthy platform answers 200");
const body = await ok.json();
assert.equal(body.status, "ok");
assert.equal(body.db, "ok");
assert.ok(body.search?.engine, "the engine names itself");
assert.equal(typeof body.mail?.configured, "boolean");
assert.ok(body.config?.groups, "the six configuration groups are reported");
summary.healthy = `200 with db, search (${body.search.engine}), mail and config`;

// ============================================================
// 2. THE REGRESSION: a threshold that cannot be read is not an outage.
// ============================================================
// The real failure was a raw 42704 from `current_setting` escaping into the
// route. Simulated at the seam rather than by uninstalling an extension,
// because what must be proven is the ENDPOINT's behaviour when this throws.
const original = searchEngine.threshold;
try {
  searchEngine.threshold = async () => {
    throw Object.assign(new Error('unrecognized configuration parameter "pg_trgm.word_similarity_threshold"'), { code: "42704" });
  };
  const degraded = await fetch(`${base}/ready`);
  assert.equal(degraded.status, 200, "an unreadable DIAGNOSTIC must not turn /ready into a 500 — this is the whole regression");
  const payload = await degraded.json();
  assert.equal(payload.db, "ok", "…and the checks that DID succeed must still be reported");
  assert.ok(payload.config?.groups, "…including the configuration groups, which are the reason an operator opens this route");
  summary.degrades = "a throwing threshold leaves /ready at 200 with every other field intact";
} finally {
  searchEngine.threshold = original;
}

// ============================================================
// 3. The reader itself never throws — it reports «unavailable».
// ============================================================
// The engine's own contract: a string, always. Callers print it as-is, so a
// rejected promise here would push the problem back into every caller.
const value = await searchEngine.threshold();
assert.equal(typeof value, "string", "threshold() resolves to a string rather than rejecting");
assert.ok(value.length > 0);
summary.readerIsTotal = `threshold() resolved to «${value}» instead of throwing`;

// ============================================================
// 4. And it loads the module before reading, so the number is REAL.
// ============================================================
// ق-144: `ALTER DATABASE … SET` applies to NEW sessions, so a long-lived pooled
// connection can silently keep the old 0.6 while the migration says 0.4.
// Reporting a value read WITHOUT loading pg_trgm would report a default nobody
// searches with — true-looking and useless.
const { readFileSync } = await import("node:fs");
const source = readFileSync(new URL("../src/services/search/postgres-trigram.engine.ts", import.meta.url), "utf8");
assert.match(source, /word_similarity\(/, "the threshold read must touch a pg_trgm function so the module is loaded first");
summary.loadsFirst = "the read forces pg_trgm to load, so the number is the one a real search would use";

// ============================================================
// 5. D-66 — NEITHER PROBE NAMES THE DEPLOYMENT.
// ============================================================
// Both routes are unauthenticated by necessity: Railway's health check runs
// before any credential exists, so whatever they say, they say to the internet.
// `env: process.env.NODE_ENV` was in both bodies, and it is the single most
// useful sentence for someone mapping the platform — it separates the
// production host from the staging one that shares its code and its migrations.
//
// Proven with a SENTINEL rather than by reading the key: asserting only that
// `body.env` is undefined would still pass if the value moved into a differently
// named field. The value is what must not appear, anywhere in the response.
const realNodeEnv = process.env.NODE_ENV;
try {
  process.env.NODE_ENV = "codiq-probe-sentinel-9f2a";
  for (const path of ["/health", "/ready"]) {
    const probe = await fetch(`${base}${path}`);
    assert.equal(probe.status, 200, `${path} still answers 200`);
    const text = await probe.text();
    assert.ok(!text.includes("codiq-probe-sentinel-9f2a"), `D-66: ${path} must not name the deployment to an anonymous caller`);
    assert.equal(JSON.parse(text).env, undefined, `D-66: ${path} carries no «env» field`);
  }
  summary.namesNoEnvironment = "D-66: /health and /ready answer 200 without NODE_ENV reaching the body under any key";
} finally {
  if (realNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = realNodeEnv;
}

server.close();
console.log(JSON.stringify({ suite: "ready-endpoint", status: "passed", summary }, null, 2));
