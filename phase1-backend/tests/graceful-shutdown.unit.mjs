/**
 * D-70 — a deploy must not truncate the response somebody is reading.
 *
 * THE DEFECT THIS PINS WAS LIVE ON EVERY DEPLOY. `server/index.ts` answered
 * SIGTERM with `stopChild(); process.exit(0);` — no `server.close()` anywhere in
 * the file. Railway sends SIGTERM to start every deployment, so every request in
 * flight at that moment had its socket destroyed while the response was still
 * being written. The shopper saw a checkout fail on a page with no error on it.
 * Nothing logged it: the process that would have logged it was the one exiting.
 *
 * The assertions below are ordered by what actually goes wrong:
 *
 *   1. the in-flight response is delivered WHOLE          ← the defect itself
 *   2. the process exits only AFTER it has been delivered  ← not merely «later»
 *   3. no new connection is accepted once shutdown began   ← close() really ran
 *   4. a handler that never answers cannot hold the process past the deadline
 *   5. a second signal does not restart the sequence
 *
 * Every case injects `exit`, because the real one would take this suite with it.
 * The signal path is exercised through `process.emit` rather than by calling
 * `shutdown()` directly — a handler that is never registered is the same bug in
 * a different place, and calling the function by hand would not notice.
 *
 * ONE CONSEQUENCE OF INJECTING `exit`: nothing actually dies here, so the
 * truncated body cannot be observed directly. Two observables stand in for it,
 * and reintroducing `stopChild(); exit(0)` trips both — the ORDER (exit recorded
 * before the last byte was written) and the REFUSAL (a connection opened after
 * the signal still succeeds, which can only mean `close()` never ran).
 */
import assert from "node:assert/strict";
import http from "node:http";

process.env.SESSION_JWT_SECRET ??= "graceful-shutdown-unit-secret-not-for-production";
process.env.DATABASE_URL ??= "postgresql://guard:guard@shutdown-unit-never-connects.invalid:5432/guard";

const { installGracefulShutdown, shutdownGraceMsFromEnv, DEFAULT_SHUTDOWN_GRACE_MS } = await import("../../server/graceful-shutdown.ts");

const summary = {};
const openSockets = new Set();

/** A server plus the bookkeeping every case below needs; sockets are tracked so the suite can always exit. */
function listen(handler) {
  const server = http.createServer(handler);
  server.on("connection", (socket) => {
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/** A raw request on its OWN connection — a pooled one would hide `closeIdleConnections`. */
function get(port, path = "/") {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path, agent: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body, complete: response.complete }));
    });
    request.on("error", reject);
    request.end();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================
// 1-3. The in-flight response survives, and it decides when the process dies.
// ============================================================
// The handler writes its body in two pieces with a pause between them, which is
// what a real response does and what `process.exit` used to cut in half.
{
  const order = [];
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });

  const { server, port } = await listen(async (_request, response) => {
    requestStarted();
    // Recorded SERVER-side. The client's `end` event and the server's close
    // callback race on two different sockets, so ordering them against each
    // other measures the event loop, not the fix. What the fix promises is that
    // the last byte of this response is written BEFORE the process ends.
    response.on("finish", () => order.push("response-written"));
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("first-half|");
    await sleep(150);
    response.end("second-half");
  });

  let stopped = 0;
  const exits = [];
  const installed = installGracefulShutdown(server, () => { stopped += 1; order.push("worker-stopped"); }, {
    graceMs: 5000,
    exit: (code) => { order.push("exit"); exits.push(code); },
  });

  const inFlight = get(port);
  await started;
  process.emit("SIGTERM");

  const response = await inFlight;
  assert.equal(response.status, 200, "the request that was in flight when SIGTERM arrived still answers 200");
  assert.equal(response.body, "first-half|second-half", "…and its body arrives WHOLE — this is the defect: process.exit cut it here");
  assert.equal(response.complete, true, "…with the connection closed normally rather than destroyed mid-message");

  // A connection opened AFTER the signal must be refused: that is the only proof
  // that `close()` ran rather than the drain merely having been slow.
  await assert.rejects(get(port), (error) => ["ECONNREFUSED", "ECONNRESET"].includes(error.code), "no new connection is accepted once shutdown has begun");

  await sleep(50);
  assert.deepEqual(exits, [0], "the process exits once, cleanly");
  assert.equal(stopped, 1, "the outbox worker is told to stop exactly once");
  assert.deepEqual(order, ["worker-stopped", "response-written", "exit"], "ORDER IS THE POINT: the worker is signalled first, the last byte of the response is written, and only THEN does the process end");
  installed.dispose();
  summary.drains = "an in-flight response is delivered whole, and exit(0) happens after it — not before";
  summary.refusesNew = "a connection opened after the signal is refused, so server.close() demonstrably ran";
}

// ============================================================
// 4. A handler that never answers cannot hold the process open forever.
// ============================================================
// Without the deadline this is where SIGKILL arrives instead: no callback, no
// log line, nothing flushed. The clean path cannot fire here — `close()` never
// calls back while a request is open — so an exit at all proves the deadline.
{
  const { server, port } = await listen(() => { /* never responds — the slow handler */ });
  const exits = [];
  const installed = installGracefulShutdown(server, () => {}, { graceMs: 120, exit: (code) => exits.push(code) });

  const hanging = get(port).catch(() => "aborted");
  await sleep(40);
  process.emit("SIGTERM");
  assert.deepEqual(exits, [], "before the deadline the process is still waiting for the handler, as it should be");

  await sleep(300);
  assert.deepEqual(exits, [0], "at the deadline the process ends ITSELF, so the shutdown.forced line exists to find");
  installed.dispose();
  for (const socket of openSockets) socket.destroy();
  await hanging;
  summary.deadline = "a handler that never responds is cut off at CODIQ_SHUTDOWN_GRACE_MS, by us rather than by SIGKILL";
}

// ============================================================
// 5. A second signal does not start a second shutdown.
// ============================================================
// Railway sends SIGTERM; a person pressing Ctrl-C during a slow drain sends
// SIGINT. The second `server.close()` would call back with ERR_SERVER_NOT_RUNNING
// and put a failure line in the log of a shutdown that went fine.
{
  const { server, port } = await listen((_request, response) => response.end("ok"));
  let stopped = 0;
  const exits = [];
  const installed = installGracefulShutdown(server, () => { stopped += 1; }, { graceMs: 5000, exit: (code) => exits.push(code) });

  assert.equal((await get(port)).body, "ok", "the server answers normally before any signal");
  process.emit("SIGTERM");
  process.emit("SIGINT");
  process.emit("SIGTERM");
  await sleep(80);

  assert.equal(stopped, 1, "the worker is stopped once, not once per signal");
  assert.deepEqual(exits, [0], "and the process exits once");
  assert.equal(installed.isShuttingDown(), true);
  installed.dispose();
  summary.idempotent = "SIGTERM, SIGINT and SIGTERM again run one shutdown between them";
}

// ============================================================
// 6. The grace window reads its environment variable, and distrusts it.
// ============================================================
// A window shorter than a request is the truncated response wearing a different
// name, so the floor is a second; anything unparseable takes the default rather
// than becoming NaN, which would make `setTimeout` fire immediately and turn the
// whole mechanism off silently.
assert.equal(shutdownGraceMsFromEnv({}), DEFAULT_SHUTDOWN_GRACE_MS, "unset means the default");
assert.equal(shutdownGraceMsFromEnv({ CODIQ_SHUTDOWN_GRACE_MS: "25000" }), 25_000, "a real value is honoured");
assert.equal(shutdownGraceMsFromEnv({ CODIQ_SHUTDOWN_GRACE_MS: "250" }), 1000, "…but never below a second");
for (const nonsense of ["", "  ", "abc", "0", "-5", "NaN"]) {
  assert.equal(shutdownGraceMsFromEnv({ CODIQ_SHUTDOWN_GRACE_MS: nonsense }), DEFAULT_SHUTDOWN_GRACE_MS, `«${nonsense}» is not a duration — it must fall back, not become NaN`);
}
summary.graceWindow = `default ${DEFAULT_SHUTDOWN_GRACE_MS}ms, floor 1000ms, and any unparseable value falls back instead of disabling the wait`;

for (const socket of openSockets) socket.destroy();
console.log(JSON.stringify({ suite: "graceful-shutdown", status: "passed", summary }, null, 2));
