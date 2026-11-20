import { readFile } from "node:fs/promises";
import { applySeoToShell, robotsTxt, sitemapXml, storeSitemapXml, storefrontSeoFor } from "../phase1-backend/src/services/storefront-seo.service.js";
import { spawn } from "child_process";
import compression from "compression";
import express from "express";
import fs from "fs";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { API_MOUNT_LEGACY, API_MOUNT_V1 } from "../phase1-backend/src/http/api-version.js";
import { createApp as createCodiqApi } from "../phase1-backend/src/http/app.js";
import { correlationMiddleware } from "../phase1-backend/src/http/correlation.js";
import { securityHeaders } from "../phase1-backend/src/http/security-headers.js";
import { logger } from "../phase1-backend/src/logging/logger.js";
import { initSentry } from "../phase1-backend/src/observability/sentry.js";
import { OUTBOX_SIGNAL_MESSAGE, setOutboxSignalSink } from "../phase1-backend/src/jobs/outbox-signal.js";
import { installGracefulShutdown } from "./graceful-shutdown.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Phase 15 (ADR-004): the outbox worker runs as its own OS process beside the
// HTTP server — never a timer inside the request path. Disable with
// CODIQ_NOTIFICATIONS_WORKER=off (tests drive processOutboxBatch directly).
//
// RETURNS ITS OWN STOP FUNCTION (D-70). It used to own the process's SIGTERM
// handler as well, which is why the HTTP server never got one: the first
// listener registered `process.exit(0)` and the second — the one that would
// have closed the server — was never written. Ownership now splits along the
// obvious line: this function knows how to stop the child, `startServer` knows
// what else must happen before the process dies.
function startOutboxWorkerProcess(): () => void {
  const nothingToStop = () => {};
  if (process.env.CODIQ_NOTIFICATIONS_WORKER === "off") return nothingToStop;
  const workerPath = path.resolve(__dirname, "worker.js");
  if (!fs.existsSync(workerPath)) return nothingToStop;
  // A crashed worker used to stay down until the next deploy, silently stopping
  // all notifications (debt D-42). Respawn with exponential backoff; a child that
  // survives 5 minutes resets the backoff so transient crashes never compound.
  let child: ReturnType<typeof spawn> | null = null;
  let restarts = 0;
  let shuttingDown = false;
  const spawnWorker = () => {
    const startedAt = Date.now();
    // ق-239 — AN IPC CHANNEL, NOT JUST INHERITED STREAMS.
    //
    // The worker now sleeps between long ticks so the database may suspend, and
    // this is how it learns a row arrived without polling for one: the process
    // that WROTE it says so. `"ipc"` as the fourth stdio slot is the whole
    // mechanism — no network, no broker, and nothing touching Postgres.
    //
    // It matters that the sender is this process: it has just committed a
    // transaction, so the database is awake at that instant anyway. The signal
    // buys the shopper his confirmation in about a second and costs nothing.
    child = spawn(process.execPath, [workerPath], { stdio: ["inherit", "inherit", "inherit", "ipc"], env: process.env });
    // Registered on every spawn, because a respawned worker is a NEW channel —
    // a sink still holding the dead child would silently signal nobody, and the
    // symptom (notifications merely slow) is one nobody would trace back here.
    setOutboxSignalSink(() => { child?.send?.(OUTBOX_SIGNAL_MESSAGE); });
    child.on("exit", (code) => {
      // Between the crash and the respawn there is no one to tell. Clearing the
      // sink makes `signalOutboxWork()` a no-op for those seconds rather than a
      // throw into whatever transaction happened to be enqueueing.
      setOutboxSignalSink(null);
      if (shuttingDown) return;
      if (Date.now() - startedAt > 5 * 60 * 1000) restarts = 0;
      const delayMs = Math.min(60_000, 1000 * 2 ** Math.min(restarts, 6));
      restarts += 1;
      logger.warn("outbox worker exited; restarting", { job: "outbox-worker", exitCode: code, delayMs, restart: restarts });
      setTimeout(spawnWorker, delayMs).unref();
    });
  };
  spawnWorker();
  const stopChild = () => { shuttingDown = true; setOutboxSignalSink(null); try { child?.kill("SIGTERM"); } catch { /* already gone */ } };
  process.on("exit", stopChild);
  return stopChild;
}


async function startServer() {
  // ق-235: FIRST, before any route exists. Sentry's handlers wrap what is
  // registered after them, and an error thrown while the app is still being
  // assembled is exactly the class of fault nobody is watching for. Returns
  // false and does nothing at all when SENTRY_DSN is unset, so local runs, CI
  // and every test are byte-for-byte unchanged.
  if (initSentry()) logger.info("sentry.enabled", { environment: process.env.NODE_ENV ?? "unknown" });
  const app = express();
  const server = createServer(app);
  // 19-د (D-34): Railway terminates TLS at a single proxy hop, so `req.secure`
  // is false on every real request unless this is set — and HSTS is emitted on
  // https only. The API app has said the same line since phase 1; this is the
  // OUTER app, which serves every HTML document and had never been told.
  app.set("trust proxy", 1);
  // D-41 (phase 24-أ): FIRST of all, ahead even of the security headers. This
  // is the ONLY mount that sees every HTML document, `/sw.js`, `/robots.txt`
  // and every storefront page — the same lesson D-34 learned below, applied to
  // the correlation id: registered inside `createApp()` alone it would reach
  // `/api` and nothing else.
  app.use(correlationMiddleware());
  // 19-د (D-34): FIRST, before static files, before the API, before the SPA
  // catch-all. This is the mount that matters: the security headers used to be
  // set inside the API app alone, so every HTML document the platform serves —
  // the dashboards, the till, and every storefront on every custom merchant
  // domain — went out with no CSP at all. It also covers `/sw.js`, whose own
  // response headers are the CSP the till's service worker runs under.
  app.use(securityHeaders());
  /**
   * ق-241 — ARABIC TEXT COMPRESSES BY ABOUT NINE PARTS IN TEN, AND NOTHING WAS
   * COMPRESSING IT.
   *
   * Every byte this platform sends is Arabic UTF-8 — product names, order
   * lists, the dashboard's own JavaScript — and Arabic costs two bytes per
   * letter on the wire while compressing better than Latin text does. The
   * platform was sending all of it raw. Railway bills egress at $0.05/GB and
   * the cost model put egress at roughly nine tenths of the monthly bill, so
   * this single line is the largest cost lever in the platform; the shopper on
   * an Iraqi mobile network is the other half of the reason, and the more
   * important one.
   *
   * MOUNTED HERE, ON THE OUTER APP, so it covers all three surfaces at once:
   * the API (mounted below), every HTML document, and the built assets under
   * `dist/public`. Registered inside `createApp()` it would have reached `/api`
   * and nothing else — the same lesson D-34 and D-41 both learned above.
   *
   * WHAT IS NOT COMPRESSED, AND WHY THAT NEEDS NO EXEMPTION LIST: the default
   * filter asks the `compressible` module about the content type, so webp
   * product images, PNG logos and anything else already compressed are skipped
   * — recompressing them costs CPU and adds bytes. The 1 KB floor is also the
   * default: below it the gzip header is most of the payload.
   *
   * ON BREACH, said plainly rather than left for someone to worry about later.
   * Compressing a response lets an attacker who can (a) see its size and (b)
   * inject text INTO THE SAME BODY that also holds a secret, recover that
   * secret byte by byte. Both conditions must hold. CODIQ's CSRF defence is an
   * ORIGIN CHECK, not a token in a body (ق-229), and no response mixes a secret
   * with echoed caller input: the session token appears only in sign-in answers,
   * which reflect nothing the caller sent. The day either of those changes —
   * a CSRF token in a payload, or an endpoint that echoes `q` back beside
   * anything secret — this line needs revisiting, and that sentence is the
   * reason it is written here rather than in a commit message nobody will find.
   */
  app.use(compression());
  // The same portable Express API is mounted in production under a relative prefix.
  // Database and signing values are supplied only by standard environment variables.
  //
  // المرحلة 20-4: ONE app object, TWO mount paths. `/api/v1` is registered
  // FIRST and that ordering is load-bearing — Express strips the mount path and
  // matches the remainder, so an `/api` mount registered ahead of it would claim
  // `/api/v1/orders`, hand the app `/v1/orders`, match nothing, and answer the
  // 404 net. See `phase1-backend/src/http/api-version.ts`.
  const codiqApi = createCodiqApi();
  app.use(API_MOUNT_V1, codiqApi);
  app.use(API_MOUNT_LEGACY, codiqApi);
  const stopOutboxWorker = startOutboxWorkerProcess();
  installGracefulShutdown(server, stopOutboxWorker);

  // Serve static files from dist/public in production
  const staticPath =
    process.env.NODE_ENV === "production"
      ? path.resolve(__dirname, "public")
      : path.resolve(__dirname, "..", "dist", "public");

  // ق-223 — THE HASH IS THE CACHE KEY, AND THE SHELL MUST NEVER BE.
  //
  // Vite content-hashes everything under /assets, so the bytes at one of those
  // URLs can never change: they earn a year of `immutable`. The document that
  // NAMES them (index.html) and the service worker must be re-validated on every
  // load or a stale shell keeps asking for chunks a deploy has already deleted —
  // Vite's own deployment guidance, verbatim. serve-static's default was
  // `max-age=0` on everything, so the shell's ~15 files each cost a conditional
  // round trip Baghdad→Railway→Baghdad on every navigation, with no CDN in front
  // and on metered mobile data.
  app.use(express.static(staticPath, {
    setHeaders(res, filePath) {
      res.setHeader("cache-control", /[\\/]assets[\\/]/.test(filePath) ? "public, max-age=31536000, immutable" : "no-cache");
    },
  }));

  // P27-16 (ق-104) — a crawler asking for these must get a FILE, not the app.
  // Serving the SPA shell at /robots.txt told every crawler the file was a web
  // page, which is worse than answering 404.
  const originOf = (req: express.Request) => req.protocol + "://" + (req.get("host") ?? "");
  app.get("/robots.txt", (req, res) => {
    res.type("text/plain").send(robotsTxt(originOf(req)));
  });
  app.get("/sitemap.xml", (req, res, next) => {
    sitemapXml(originOf(req)).then((xml) => res.type("application/xml").send(xml)).catch(next);
  });
  app.get("/store/:slug/sitemap.xml", (req, res, next) => {
    storeSitemapXml(req.params.slug, originOf(req))
      .then((xml) => (xml ? res.type("application/xml").send(xml) : res.status(404).type("text/plain").send("Not found")))
      .catch(next);
  });

  // Handle client-side routing — the shell for every route, with its head
  // rewritten from the database for the PUBLIC storefront pages. Without this
  // every store on the platform shared one title: the platform's own.
  const shellPath = path.join(staticPath, "index.html");
  // ق-223 — A PATH SHAPED LIKE A FILE IS NOT A ROUTE. `express.static` falls
  // through for a file that is not there, and this catch-all used to answer it
  // with 200 text/html: a `/assets/*.js` chunk deleted by the last deploy
  // (`emptyOutDir: true`) came back as the shell, the browser tried to run HTML
  // as a module, and the tab ended at an English stack trace. The service
  // worker had to hand-roll a content-type check because the server lied. Now
  // it gets the truth — 404 — and the client's `vite:preloadError` handler
  // reloads a stale tab on its own. Only a path whose LAST segment carries an
  // extension is treated as a file; every app route is extension-free, and the
  // three document routes above (robots, sitemaps) are answered before this.
  const FILE_SHAPED = /\.[a-z0-9]{1,8}$/i;
  app.get("*", (req, res, next) => {
    if (FILE_SHAPED.test(req.path)) { res.status(404).type("text/plain").send("Not found"); return; }
    // The shell reaches most visitors through THIS branch, not through
    // express.static (an app route like /platform/login is not a file), and
    // `sendFile` stamps its own `max-age=0` unless told not to — so the
    // no-cache rule is set here and sendFile is asked to leave it alone.
    res.setHeader("cache-control", "no-cache");
    storefrontSeoFor(req.path, originOf(req))
      .then((seo) => {
        if (!seo) { res.sendFile(shellPath, { cacheControl: false }); return; }
        // Read per request rather than cached at boot: the shell changes on
        // deploy, and a stale copy in memory would outlive it.
        return readFile(shellPath, "utf8").then((html) => { res.type("html").send(applySeoToShell(html, seo)); });
      })
      // A metadata failure must never cost the visitor his page.
      .catch(() => { res.sendFile(shellPath, { cacheControl: false }); });
  });

  const port = Number(process.env.PORT ?? 3000);

  server.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      logger.error(`Server failed to start: port ${port} is already in use.`, { port, code: error.code });
    } else {
      logger.error(`Server failed to start on port ${port}: ${error.message}`, { port, err: error });
    }
    process.exit(1);
  });

  server.listen(port, () => {
    // The MESSAGE text is unchanged on purpose: `phase10.composite-server
    // .runtime.mjs` waits for this exact sentence on stdout, and `JSON
    // .stringify` leaves it intact inside the line.
    logger.info(`Server running on http://localhost:${port}/`, { port, env: process.env.NODE_ENV ?? "unknown" });
  });
}

startServer().catch((error) => logger.error("composite server failed to start", { err: error }));
