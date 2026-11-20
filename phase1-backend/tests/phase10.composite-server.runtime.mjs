import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";

async function freePort() {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate a local test port.");
  const { port } = address;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function launch(port) {
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "production", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  return { child, output: () => output };
}

async function waitForStartup(processHandle, port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (processHandle.output().includes(`Server running on http://localhost:${port}/`)) return;
    if (processHandle.child.exitCode !== null) throw new Error(`Composite server exited during startup: ${processHandle.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Composite server did not start on port ${port}: ${processHandle.output()}`);
}

const port = await freePort();
const primary = launch(port);

try {
  await waitForStartup(primary, port);

  const apiResponse = await fetch(`http://127.0.0.1:${port}/api/store/phase10-missing-store/products`);
  assert.equal(apiResponse.status, 404);
  assert.match(apiResponse.headers.get("content-type") ?? "", /application\/json/);

  const spaResponse = await fetch(`http://127.0.0.1:${port}/platform/login`);
  assert.equal(spaResponse.status, 200);
  assert.match(spaResponse.headers.get("content-type") ?? "", /text\/html/);
  const shellHtml = await spaResponse.text();
  assert.match(shellHtml, /id="root"/);

  // ── ق-223 — the hash is the cache key, and the shell must never be ─────────
  //
  // Vite content-hashes everything under /assets, so those bytes may be cached
  // for a year as immutable; the document that NAMES them must be re-validated
  // on every load or a stale shell keeps asking for chunks the last deploy
  // deleted. serve-static's default was `max-age=0` on everything — ~15 files,
  // each a conditional round trip Baghdad→Railway on metered mobile data.
  assert.equal(spaResponse.headers.get("cache-control"), "no-cache", "ق-223: the shell is re-validated on every load");
  const chunkPath = shellHtml.match(/(\/assets\/[^"']+\.js)/)?.[1];
  assert.ok(chunkPath, "the built shell names at least one hashed chunk");
  const chunk = await fetch(`http://127.0.0.1:${port}${chunkPath}`);
  assert.equal(chunk.status, 200);
  assert.equal(chunk.headers.get("cache-control"), "public, max-age=31536000, immutable", "ق-223: a content-hashed asset is cached for a year");

  // ── ق-241 — the wire bytes, on the REAL server ────────────────────────────
  //
  // `compression.guard.mjs` proves the middleware's behaviour in isolation; this
  // proves it is actually MOUNTED, and mounted where it covers all three
  // surfaces. A `compression()` registered inside `createApp()` would compress
  // `/api` and leave every HTML document and every built chunk raw — the exact
  // mistake D-34 and D-41 each made once on this same file, and one that no
  // unit test of the middleware could ever see.
  //
  // `fetch` decodes transparently, so the header is what tells the truth here.
  const compressedChunk = await fetch(`http://127.0.0.1:${port}${chunkPath}`, { headers: { "accept-encoding": "gzip" } });
  assert.equal(compressedChunk.headers.get("content-encoding"), "gzip", "ق-241: a built JavaScript chunk must go out compressed — this is the largest egress line in the platform");
  assert.match(compressedChunk.headers.get("vary") ?? "", /accept-encoding/i, "…and it must say so, or a shared cache serves it to a client that cannot decode");
  const compressedShell = await fetch(`http://127.0.0.1:${port}/platform/login`, { headers: { "accept-encoding": "gzip" } });
  assert.equal(compressedShell.headers.get("content-encoding"), "gzip", "ق-241: and so must the HTML document — it is Arabic, and Arabic is two bytes a letter");

  // A chunk the last deploy deleted is a 404, not the shell dressed as JavaScript.
  // The browser used to try to run HTML as a module and every open tab ended at
  // an English stack trace; now the client's vite:preloadError handler reloads.
  const purged = await fetch(`http://127.0.0.1:${port}/assets/gone-ABCDEF12.js`);
  assert.equal(purged.status, 404, "ق-223: a file-shaped path that is not on disk is a real 404");
  assert.doesNotMatch(purged.headers.get("content-type") ?? "", /text\/html/, "…and never text/html");
  // …while an app ROUTE that merely looks unfamiliar still gets the shell.
  const deepRoute = await fetch(`http://127.0.0.1:${port}/merchant/stores/some-shop/dashboard/orders`);
  assert.equal(deepRoute.status, 200);
  assert.match(deepRoute.headers.get("content-type") ?? "", /text\/html/);
  // …and the documents the crawlers ask for keep their own answers.
  const robots = await fetch(`http://127.0.0.1:${port}/robots.txt`);
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get("content-type") ?? "", /text\/plain/);

  const duplicate = launch(port);
  const [duplicateExitCode] = await once(duplicate.child, "exit");
  assert.notEqual(duplicateExitCode, 0);
  assert.match(duplicate.output(), new RegExp(`port ${port} is already in use`));

  console.log(JSON.stringify({ compositeServer: { port, apiStatus: apiResponse.status, spaStatus: spaResponse.status, duplicatePortExitCode: duplicateExitCode, caching: { shell: "no-cache", assets: "immutable", purgedChunk: purged.status, deepRoute: deepRoute.status } } }, null, 2));
} finally {
  if (primary.child.exitCode === null) {
    primary.child.kill("SIGTERM");
    await once(primary.child, "exit");
  }
}
