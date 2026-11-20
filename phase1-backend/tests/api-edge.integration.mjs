/**
 * Integration — what the API says when the request never reaches a route.
 *
 * Three answers the 20-2 gate asked for, and all three were wrong in the same
 * direction: the platform blamed itself, or claimed success, for a request the
 * CALLER had malformed.
 *
 *   · an unmatched `/api/...` path answered `200 text/html` — the SPA shell,
 *     because the composite server's catch-all serves it to anything unclaimed.
 *     `storefront-api.ts` parses that as the success it claims to be and hands
 *     the caller `null as T`, so a renamed endpoint shows up as an empty screen
 *     days later with a 200 in every log.
 *   · a malformed JSON body answered 500 — "retry, it is not your fault", which
 *     is the one instruction that guarantees the caller sends it again.
 *   · a body over the 1 MB limit answered 500 for the same reason.
 *
 * Run: pnpm api:edge:test
 */
import assert from "node:assert/strict";
import { createApp } from "../src/http/app.ts";

const summary = {};
const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// ============================================================
// 1. An unmatched path is a 404 — as JSON, in the platform's envelope.
// ============================================================
for (const [method, path] of [["GET", "/does-not-exist"], ["POST", "/merchant/nope"], ["GET", "/store/x/definitely-not-a-route"]]) {
  const response = await fetch(`${base}${path}`, { method });
  assert.equal(response.status, 404, `${method} ${path} must be 404, not the SPA shell`);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/, `${method} ${path} must answer JSON — an HTML body is what the client silently read as success`);
  const body = await response.json();
  assert.equal(body.error?.code, "RESOURCE_NOT_FOUND", "the standard envelope, not a bespoke shape");
  // The 404 must ride the same rails as every other failure, or a merchant
  // reporting one has nothing to quote back.
  assert.match(body.error?.requestId ?? "", /^[0-9a-f]{16}$/, "…carrying the correlation id, like every other error");
}
summary.unmatched = "an unmatched API path is 404 JSON in the standard envelope, with a request id";

// A real route is untouched by the net — the guard must not have eaten the app.
const health = await fetch(`${base}/health`);
assert.equal(health.status, 200, "the catch-all sits AFTER the real routers and must not shadow one");
summary.realRoutesIntact = "a registered route still answers normally";

// ============================================================
// 2. Malformed JSON is the caller's 400, not the server's 500.
// ============================================================
const malformed = await fetch(`${base}/auth/platform/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: '{"email": "a@b.c", "password":',
});
assert.equal(malformed.status, 400, "one byte of bad JSON is a bad request, not a server failure");
const malformedBody = await malformed.json();
assert.equal(malformedBody.error?.code, "INVALID_JSON_BODY");
summary.malformedJson = "400 INVALID_JSON_BODY — the caller can act on it";

// ============================================================
// 3. An oversize body is 413, and the limit is real.
// ============================================================
const oversize = await fetch(`${base}/auth/platform/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "a@b.c", password: "x".repeat(1_200_000) }),
});
assert.equal(oversize.status, 413, "over the 1 MB parser limit is 413, the code that names the actual problem");
const oversizeBody = await oversize.json();
assert.equal(oversizeBody.error?.code, "REQUEST_BODY_TOO_LARGE");
summary.oversize = "413 REQUEST_BODY_TOO_LARGE at the 1 MB parser limit";

// ============================================================
// 4. A genuine SyntaxError from a handler keeps its 500.
// ============================================================
// The fix reads `error.type`, which body-parser stamps — deliberately NOT
// `instanceof SyntaxError`, because a SyntaxError thrown anywhere else is a real
// bug of ours and must not be reported to the caller as his fault.
const { classifyError } = await import("../src/http/errors.ts");
const ours = classifyError(new SyntaxError("Unexpected token in our own code"), { path: "/merchant/stores/x/orders" });
assert.equal(ours.status, 500, "a SyntaxError WITHOUT body-parser's type stamp is our bug and keeps its 500");
assert.equal(ours.mapped, false, "…and stays unmapped, so it is logged as the fault we own");
summary.notOverreaching = "only body-parser's own stamped errors are reclassified; our SyntaxErrors keep their 500";

server.close();
console.log(JSON.stringify({ suite: "api-edge", status: "passed", summary }, null, 2));
