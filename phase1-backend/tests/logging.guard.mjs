/**
 * codiq D-41 (phase 24-أ) — التسجيل المُهيكل, asserted rather than described.
 *
 * Five things are pinned here, and each one is a thing that silently stops
 * being true if nobody watches it:
 *
 *  1. EVERY line is one line of valid JSON carrying the same five keys. A
 *     logger that emits a bare string on one path is a logger you cannot query,
 *     and you find that out during the incident.
 *  2. The correlation id is STABLE across a request and DIFFERENT between two.
 *     An id that repeats is worse than no id — it merges two people's failures.
 *  3. The redaction list actually redacts. A password, a session token, a TOTP
 *     secret, a sealed envelope, an email and a phone are fed in through both
 *     doors (a context key and free text inside a message) and none of them may
 *     appear in the output.
 *  4. The error handler emits EXACTLY ONE error line per unmapped failure and
 *     still answers with the unchanged `{error:{code,message}}` envelope. Phase
 *     22 will translate those Arabic messages and the red team's fixes name
 *     those codes; a change here is a contract break, not a refactor.
 *  5. A job pass carries its own id, and two passes carry different ones.
 *
 * Plus the volume rule, checked in a CHILD PROCESS against real stdout at the
 * production level: a debug line must cost nothing when nobody is listening.
 */
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// This guard boots express and the error handler but never issues a query, so
// the two values `config.ts` demands at import are supplied here rather than
// requiring a database to assert a log line. The host cannot resolve, so a
// query added to this path in future fails loudly instead of touching anything.
process.env.SESSION_JWT_SECRET ??= "logging-guard-secret-not-for-production";
process.env.DATABASE_URL ??= "postgresql://guard:guard@logging-guard-never-connects.invalid:5432/guard";
// Read ONCE at import by the logger, so it is set before the first import below.
// `debug` is the level under test for the per-request line; the production
// default is asserted separately, in a child process.
process.env.CODIQ_LOG_LEVEL = "debug";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const express = (await import("express")).default;
const { logger, setLogSink } = await import("../src/logging/logger.ts");
const { runJobPass, setLogContext, currentCorrelationId } = await import("../src/logging/context.ts");
const { maskPhoneToLastFour, maskEmail, fingerprint } = await import("../src/logging/redact.ts");
const { correlationMiddleware, CORRELATION_HEADER } = await import("../src/http/correlation.ts");
const { errorHandler } = await import("../src/http/errors.ts");
const { HttpError } = await import("../src/auth/auth.errors.ts");

// ------------------------------------------------------------------ capture
const lines = [];
const restoreSink = setLogSink((line) => lines.push(line));
const drain = () => { const taken = lines.splice(0, lines.length); return taken; };
const parsed = (raw) => { try { return JSON.parse(raw); } catch (error) { assert.fail(`not JSON: ${raw}\n${error.message}`); } };

function assertShape(raw) {
  assert.equal(raw.includes("\n"), false, "a log line must be ONE line — a newline forges a second record");
  const event = parsed(raw);
  for (const key of ["level", "time", "message", "requestId", "ctx"]) {
    assert.ok(key in event, `every line carries \`${key}\` (missing in ${raw})`);
  }
  assert.ok(["debug", "info", "warn", "error"].includes(event.level), `level is one of the four: ${event.level}`);
  assert.equal(new Date(event.time).toISOString(), event.time, "time is ISO-8601 UTC");
  assert.equal(typeof event.message, "string");
  assert.equal(typeof event.ctx, "object");
  return event;
}

// ------------------------------------------------------- 1. the event shape
logger.info("shape check", { a: 1, nested: { b: [1, 2, 3] } });
{
  const [event] = drain().map(assertShape);
  assert.equal(event.level, "info");
  assert.equal(event.message, "shape check");
  assert.equal(event.requestId, null, "outside a request or a job there is no id, and the key is still present");
  assert.deepEqual(event.ctx, { a: 1, nested: { b: [1, 2, 3] } });
}

// A message a stranger controls cannot forge a second record.
logger.error("line one\nline two\r\nlevel\":\"info", {});
{
  const [event] = drain().map(assertShape);
  assert.ok(event.message.includes("line two"), "the newline survives as DATA inside the string");
  assert.equal(event.level, "error", "and it did not become a second, forged line");
}

// Cycles, depth and unserializable members cost their detail, never the line.
const cyclic = { name: "root" };
cyclic.self = cyclic;
logger.warn("cycle", { cyclic, deep: { a: { b: { c: { d: { e: "too far" } } } } }, big: "x".repeat(4000) });
{
  const [event] = drain().map(assertShape);
  assert.equal(event.ctx.cyclic.self, "[circular]");
  assert.equal(event.ctx.deep.a.b.c, "[depth]");
  assert.ok(event.ctx.big.endsWith("…(+3488)"), "a long string is truncated, and says by how much");
}

// ---------------------------------------------------------- 3. the redaction
const SECRETS = {
  password: "correct-horse-battery-staple",
  passwordHash: "$2b$12$abcdefghijklmnopqrstuv",
  accessToken: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.9dK3lQ0PmBfR2sT4uV6wX8yZ0aB1cD2eF3gH4iJ5kL6",
  totpSecret: "JBSWY3DPEHPK3PXP",
  totpCode: "492113",
  cookie: "codiq_session=eyJhbGciOiJIUzI1NiJ9.aaaaaaaa.bbbbbbbb",
  authorization: "Bearer 4f3d2c1b0a998877665544332211",
  encryptionKey: "local-verification-key-not-a-secret-0123456789abcdef",
  objectKey: "stores/9f2c/products/44a1/2f6c8e1d-4b7a-4f0e-9c22-8a1b3d5e7f90.jpg",
  recoveryCode: "7HQ2-M4XK-9PLD",
  sealedSecret: "codiq1.k7a2.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBB.CCCCCCCCCCCCCCCCCCCCCCCC",
};
const FREE_TEXT =
  'duplicate key value violates unique constraint (email)=(taif.yahya@gmail.com) phone +9647701234567 local 07701234567 ' +
  'header "Authorization: Bearer 4f3d2c1b0a998877665544332211" token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.9dK3lQ0PmBfR2sT4uV6wX8yZ0aB1cD2eF3gH4iJ5kL6 ' +
  'sealed codiq1.k7a2.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBB.CCCCCCCCCCCCCCCCCCCCCCCC';
logger.error(FREE_TEXT, { ...SECRETS, err: new Error(FREE_TEXT), storeId: "store-1", orderId: "order-1" });
{
  const [raw] = drain();
  const event = assertShape(raw);
  for (const [key, value] of Object.entries(SECRETS)) {
    assert.equal(raw.includes(value), false, `\`${key}\` reached the log line: ${value}`);
    assert.equal(event.ctx[key], "[redacted]", `\`${key}\` must be redacted by KEY, not merely absent`);
  }
  assert.equal(raw.includes("taif.yahya@gmail.com"), false, "an email inside free text is masked");
  assert.equal(raw.includes("+9647701234567"), false, "an E.164 phone inside free text is masked");
  assert.equal(raw.includes("07701234567"), false, "the Iraqi local phone form inside free text is masked");
  assert.ok(raw.includes("•••@gmail.com"), "the email domain survives — a whole-domain bounce is an operational fact");
  assert.ok(raw.includes("••••4567"), "the phone keeps its last four, the same shape the command palette shows");
  assert.ok(event.message.includes("[redacted:jwt]"), "a JWT in free text is replaced");
  assert.ok(event.message.includes("[redacted:sealed]"), "a secret-box envelope in free text is replaced");
  assert.ok(event.message.includes("Bearer [redacted]"), "a bearer credential in free text is replaced");
  assert.ok(event.ctx.err.message.includes("[redacted:jwt]"), "an ERROR message is scrubbed on the same rules");
  // The ids an audit actually needs are NOT collateral damage of the above.
  assert.equal(event.ctx.storeId, "store-1");
  assert.equal(event.ctx.orderId, "order-1");
}

// Redaction reaches NESTED keys too — and that is exactly why a job reports its
// tables as values in a list rather than as keys in a map: half the operational
// table names contain `pass` or `token` and would be redacted by name.
logger.info("nested", { outer: { sessionToken: "s3cr3t-value-here", count: 4 }, tables: [{ table: "password_reset_tokens", deleted: 12 }] });
{
  const [event] = drain().map(assertShape);
  assert.equal(event.ctx.outer.sessionToken, "[redacted]");
  assert.equal(event.ctx.outer.count, 4);
  assert.deepEqual(event.ctx.tables, [{ table: "password_reset_tokens", deleted: 12 }], "a table NAME is a value, and values are not redacted by key");
}

// Amounts and order numbers must survive: masking «any long run of digits»
// would make every money path unreadable, which is the opposite of the point.
logger.info("total 12500000 IQD on ORD-000123456", {});
{
  const [event] = drain().map(assertShape);
  assert.ok(event.message.includes("12500000"), "an IQD total is not a phone number");
  assert.ok(event.message.includes("ORD-000123456"), "an order number is not a phone number");
}

// The one masker on the platform, and the shape the palette already shows.
assert.equal(maskPhoneToLastFour("+9647701234567"), "••••4567");
assert.equal(maskPhoneToLastFour(null), null);
assert.equal(maskEmail("taif@example.com"), "•••@example.com");
assert.equal(fingerprint("stores/a/b.jpg"), fingerprint("stores/a/b.jpg"), "a fingerprint is stable within the process");
assert.notEqual(fingerprint("stores/a/b.jpg"), fingerprint("stores/a/c.jpg"));
assert.equal(fingerprint("stores/a/b.jpg").length, 8);

// -------------------------------------------------- 5. a job pass and its id
{
  const seen = [];
  await runJobPass("retention", async () => {
    logger.info("job.pass", { job: "retention", deleted: 3 });
    setLogContext({ table: "rate_limits" });
    logger.warn("still inside the same pass", {});
    seen.push(currentCorrelationId());
  });
  const first = drain().map(assertShape);
  assert.equal(first.length, 2);
  assert.equal(first[0].requestId, first[1].requestId, "both lines of one pass carry the SAME id");
  assert.equal(first[0].requestId, seen[0]);
  assert.equal(first[0].ctx.job, "retention", "the job names itself in the context");
  assert.equal(first[1].ctx.table, "rate_limits", "what the pass learned is on the later line");

  await runJobPass("retention", async () => { logger.info("second pass", {}); });
  const second = drain().map(assertShape);
  assert.notEqual(first[0].requestId, second[0].requestId, "two passes of the SAME job are distinguishable");
  assert.match(second[0].requestId, /^[0-9a-f]{16}$/, "16 hex characters — a string a merchant can read back over WhatsApp");
}

// Outside a request and outside a pass, `setLogContext` is a no-op and not a crash.
setLogContext({ orderId: "no-context-here" });

// ------------------------------- 2 & 4. a real request through the real stack
const app = express();
app.use(correlationMiddleware());
app.get("/ok", (_request, response) => { response.status(200).json({ ok: true }); });
app.get("/orders/:orderId/settlements/:settlementId", () => { throw new Error("kaboom in the money path"); });
app.get("/reset/:token", () => { throw new HttpError(422, "RESERVED_STORE_SLUG", "هذا الرابط محجوز للمنصة — اختر رابطاً آخر لمتجرك."); });
app.get("/degraded", () => { throw new HttpError(503, "IMAGE_STORAGE_NOT_CONFIGURED", "تخزين الصور غير مهيأ على هذه البيئة."); });
app.use(errorHandler);

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

// A successful request: the header is there, and at the production level it
// would cost nothing at all (asserted in the child process below).
{
  const response = await fetch(`${origin}/ok`);
  await response.json();
  await settle();
  const id = response.headers.get(CORRELATION_HEADER);
  assert.match(id ?? "", /^[0-9a-f]{16}$/, "every response carries x-request-id, success included");
  const events = drain().map(assertShape);
  assert.equal(events.length, 1, "at debug: exactly one request.completed line");
  assert.equal(events[0].message, "request.completed");
  assert.equal(events[0].requestId, id, "the logged id IS the one the caller was handed");
  assert.equal(events[0].ctx.route, "/ok");
  assert.equal(events[0].ctx.status, 200);
  assert.equal(typeof events[0].ctx.durationMs, "number");
}

// An UNMAPPED failure — the case that used to be `console.error(error)`.
let firstFailureId;
{
  const response = await fetch(`${origin}/orders/ord-42/settlements/set-7`);
  const body = await response.json();
  await settle();
  const id = response.headers.get(CORRELATION_HEADER);
  firstFailureId = id;
  assert.equal(response.status, 500);
  assert.deepEqual(body, { error: { code: "INTERNAL_ERROR", message: "Unexpected server error.", requestId: id } },
    "the envelope is unchanged apart from the one string the merchant reads back");

  const events = drain().map(assertShape);
  const errors = events.filter((event) => event.level === "error");
  assert.equal(errors.length, 1, `EXACTLY one error line per failure, got ${errors.length}`);
  const [failure] = errors;
  assert.equal(failure.message, "request.failed");
  assert.equal(failure.requestId, id, "the line and the body name the same request");
  assert.equal(failure.ctx.route, "/orders/:orderId/settlements/:settlementId", "the route PATTERN, never the resolved URL");
  assert.equal(failure.ctx.method, "GET");
  assert.equal(failure.ctx.status, 500);
  assert.equal(failure.ctx.code, "INTERNAL_ERROR");
  assert.equal(typeof failure.ctx.durationMs, "number");
  // The money-path ids, harvested from the matched route without one edit to a
  // route handler — this is what makes auditing 25أ possible.
  assert.equal(failure.ctx.params.orderId, "ord-42");
  assert.equal(failure.ctx.params.settlementId, "set-7");
  assert.ok(failure.ctx.err.stack.includes("kaboom in the money path"), "the stack is kept — this is a fault the server owns");
  // Every line of THIS request shares the id, and no other request's does.
  for (const event of events) assert.equal(event.requestId, id, "one request, one id, on every line it produced");
}

// A MAPPED 4xx: the caller's mistake. The response says so; the log does not shout.
{
  const secret = "eyJhbGciOiJIUzI1NiJ9.eyJyZXNldCI6MX0.ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
  const response = await fetch(`${origin}/reset/${secret}`);
  const body = await response.json();
  await settle();
  const id = response.headers.get(CORRELATION_HEADER);
  assert.equal(response.status, 422);
  assert.equal(body.error.code, "RESERVED_STORE_SLUG");
  assert.equal(body.error.message, "هذا الرابط محجوز للمنصة — اختر رابطاً آخر لمتجرك.",
    "not one Arabic message changed — phase 22 translates these and the red team's fixes name them");
  assert.equal(body.error.requestId, id);
  assert.notEqual(id, firstFailureId, "two requests are never given the same id");

  const events = drain().map(assertShape);
  assert.equal(events.filter((event) => event.level === "error").length, 0, "a 4xx is not a server fault");
  const rejected = events.find((event) => event.message === "request.rejected");
  assert.ok(rejected, "it is still visible at debug, with its code");
  assert.equal(rejected.level, "debug");
  assert.equal(rejected.ctx.code, "RESERVED_STORE_SLUG");
  assert.equal(rejected.ctx.route, "/reset/:token");
  assert.equal(rejected.ctx.params.token, "[redacted]", "a `:token` route parameter is a credential, not an id");
  for (const raw of [JSON.stringify(events)]) assert.equal(raw.includes(secret), false, "the reset token never reaches a log line");
}

// A MAPPED 5xx: handled, but still degraded. Someone should see it repeat.
{
  const response = await fetch(`${origin}/degraded`);
  const body = await response.json();
  await settle();
  assert.equal(response.status, 503);
  assert.equal(body.error.code, "IMAGE_STORAGE_NOT_CONFIGURED");
  const events = drain().map(assertShape);
  assert.equal(events.filter((event) => event.level === "error").length, 0, "mapped: nobody is paged");
  const degraded = events.find((event) => event.message === "request.degraded");
  assert.ok(degraded, "but it is a warn, not a debug");
  assert.equal(degraded.level, "warn");
  assert.equal(degraded.ctx.status, 503);
}

await new Promise((resolve) => server.close(resolve));
restoreSink();

// ------------------------------------- the volume rule, on real stdout, at the
// production level. `CODIQ_LOG_LEVEL` is read once at import, so this is the
// only honest way to assert the default: a separate process.
{
  const loggerUrl = pathToFileURL(path.join(repoRoot, "phase1-backend", "src", "logging", "logger.ts")).href;
  const script = path.join(os.tmpdir(), `codiq-log-volume-${process.pid}.mjs`);
  fs.writeFileSync(
    script,
    `const { logger } = await import(${JSON.stringify(loggerUrl)});\n` +
      `logger.debug("per-request bookkeeping", { route: "/ok" });\n` +
      `logger.info("worker.started", { job: "outbox" });\n` +
      `logger.error("request.failed", { status: 500 });\n` +
      `if (logger.isLevelEnabled("debug")) { console.log("DEBUG_WAS_ENABLED"); }\n`,
    "utf8",
  );
  try {
    const childEnv = { ...process.env };
    delete childEnv.CODIQ_LOG_LEVEL;
    const child = spawnSync(process.execPath, ["--import", "tsx", script], { cwd: repoRoot, encoding: "utf8", env: childEnv });
    assert.equal(child.status, 0, `child failed: ${child.stderr}`);
    const emitted = child.stdout.split("\n").filter((line) => line.trim().length > 0);
    assert.equal(emitted.includes("DEBUG_WAS_ENABLED"), false, "debug is OFF at the production default");
    assert.equal(emitted.length, 2, `info + error and nothing else, got:\n${child.stdout}`);
    const events = emitted.map(assertShape);
    assert.deepEqual(events.map((event) => event.level), ["info", "error"]);
  } finally {
    fs.rmSync(script, { force: true });
  }
}

// ------------------------------------------------------------ 6. the ratchet
// `console.error(error)` is what this phase exists to remove. It may not come
// back into the request pipeline or a job loop, where a line with no
// correlation id is a report nobody can act on.
{
  const watched = [
    "phase1-backend/src/http",
    "phase1-backend/src/logging",
    "phase1-backend/src/notifications",
    "phase1-backend/src/services/retention-job.ts",
    "phase1-backend/src/services/reservation-expiry-job.ts",
    "phase1-backend/src/services/soft-delete/purge-job.ts",
    "phase1-backend/src/services/product-image-storage.service.ts",
    "phase1-backend/src/auth/secret-box.ts",
    "phase1-backend/src/index.ts",
    "server/index.ts",
  ];
  const files = [];
  const walk = (target) => {
    const absolute = path.join(repoRoot, target);
    if (!fs.existsSync(absolute)) assert.fail(`the ratchet watches a path that no longer exists: ${target}`);
    if (fs.statSync(absolute).isDirectory()) {
      for (const entry of fs.readdirSync(absolute)) walk(path.join(target, entry));
      return;
    }
    if (absolute.endsWith(".ts")) files.push({ target, absolute });
  };
  for (const target of watched) walk(target);
  const offenders = [];
  for (const { target, absolute } of files) {
    const source = fs.readFileSync(absolute, "utf8");
    source.split("\n").forEach((line, index) => {
      if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) return;
      if (/\bconsole\.(log|error|warn|info|debug)\s*\(/.test(line)) offenders.push(`${target}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `bare console output in the request pipeline:\n${offenders.join("\n")}`);
}

// ONE masker on the platform. A second copy of «what a masked phone looks like»
// drifts silently, and the drift lands as a customer's phone number on stdout.
{
  const source = fs.readFileSync(path.join(repoRoot, "phase1-backend/src/services/merchant-search.service.ts"), "utf8");
  assert.ok(
    /import \{ maskPhoneToLastFour \} from "\.\.\/logging\/redact\.js";/.test(source) && /export \{ maskPhoneToLastFour \};/.test(source),
    "merchant-search.service.ts must re-export the masker from logging/redact.ts, never own a second copy",
  );
  assert.equal(/export function maskPhoneToLastFour/.test(source), false, "a second implementation reappeared");
}

// ASVS 5.0 V16.3: which refusals are security events (logged at warn) and which are not.
{
  const { isSecurityRefusal } = await import("../src/http/errors.ts");
  for (const [status, code] of [[401, "INVALID_MERCHANT_CREDENTIALS"], [401, "INVALID_SECOND_FACTOR"], [401, "STAFF_ACCESS_REVOKED"], [401, "WEBHOOK_SIGNATURE_INVALID"], [403, "STORE_BOUNDARY_DENIED"], [403, "STAFF_PERMISSION_DENIED"], [403, "CSRF_ORIGIN_DENIED"], [429, "RATE_LIMITED"]]) {
    assert.equal(isSecurityRefusal(status, code), true, `${status} ${code} is a security event`);
  }
  for (const [status, code] of [[401, "MISSING_SESSION"], [401, "SECOND_FACTOR_REQUIRED"], [403, "PLAN_LIMIT_EXCEEDED"], [422, "INVALID_ORDER_TRANSITION"], [404, "RESOURCE_NOT_FOUND"]]) {
    assert.equal(isSecurityRefusal(status, code), false, `${status} ${code} is not — polling and business refusals must not flood the log`);
  }
}

console.log("logging guard OK");
