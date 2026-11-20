import type { Server } from "node:http";
import { logger } from "../phase1-backend/src/logging/logger.js";

/**
 * D-70 — THE PROCESS CLOSES ITS SERVER BEFORE IT DIES.
 *
 * What used to be here, in `server/index.ts`, was one line:
 *
 *     process.on("SIGTERM", () => { stopChild(); process.exit(0); });
 *
 * Railway sends SIGTERM on EVERY deploy, and `process.exit` is immediate and
 * unconditional — every request being served at that instant had its socket
 * destroyed mid-response. For a shopper that is a checkout that fails on a page
 * showing no error; for a merchant it is a half-written import. It happened on
 * every deploy and nothing recorded it, because the process that would have
 * logged it was already gone.
 *
 * `server.close()` is the fix: it stops ACCEPTING new connections and calls
 * back once the last in-flight response has been written.
 *
 * THREE DETAILS THAT MAKE IT REAL RATHER THAN DECORATIVE:
 *
 *   · `closeIdleConnections()` — `close()` on its own also waits for keep-alive
 *     sockets that are merely open and will never send another byte. A browser
 *     holding one for its next navigation would keep the old process alive until
 *     the platform lost patience and sent SIGKILL: the same truncated response
 *     we are removing, arriving later. Idle sockets are closed at once; a socket
 *     with a request in flight is not touched.
 *
 *   · THE DEADLINE. One slow handler must not hold the process past the
 *     platform's own patience, because what arrives then is SIGKILL — no
 *     callback, no log line, nothing flushed. Exiting ourselves at
 *     `CODIQ_SHUTDOWN_GRACE_MS` leaves a `shutdown.forced` line behind, which is
 *     the only evidence anyone will ever have that a handler is too slow.
 *
 *   · IDEMPOTENCE. SIGINT after SIGTERM, or a platform that sends the signal
 *     twice, must not start a second close: the second `server.close()` calls
 *     back with `ERR_SERVER_NOT_RUNNING` and would read in the log as a failure
 *     during shutdown, which is exactly the wrong thing to be debugging.
 *
 * Its own module, not a function inside `server/index.ts`, for one reason:
 * importing that file RUNS `startServer()`. A rule this easy to weaken is a rule
 * that has to be testable without booting the platform to check it.
 */
export const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;

export function shutdownGraceMsFromEnv(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(environment.CODIQ_SHUTDOWN_GRACE_MS);
  // A missing, zero or nonsense value takes the default; anything below a second
  // is rounded up to one, because a grace window shorter than a request is the
  // truncated response wearing a different name.
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SHUTDOWN_GRACE_MS;
  return Math.max(1000, raw);
}

export interface GracefulShutdownOptions {
  /** Overridable so the deadline can be proven in milliseconds rather than waited out. */
  graceMs?: number;
  /** Injected in tests: the real one ends the process and takes the suite with it. */
  exit?: (code: number) => void;
}

export function installGracefulShutdown(
  server: Server,
  stopOutboxWorker: () => void,
  options: GracefulShutdownOptions = {},
) {
  const graceMs = options.graceMs ?? shutdownGraceMsFromEnv();
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown.begin", { signal, graceMs });
    // The worker first: it is a separate process with its own SIGTERM handler
    // that stops its scheduler and disconnects Prisma, so it spends the grace
    // window doing that in parallel with the requests draining here.
    stopOutboxWorker();
    server.close((error) => {
      if (error) logger.warn("shutdown.close_failed", { signal, err: error });
      else logger.info("shutdown.complete", { signal });
      exit(0);
    });
    server.closeIdleConnections();
    const deadline = setTimeout(() => {
      logger.warn("shutdown.forced", { signal, graceMs });
      exit(0);
    }, graceMs);
    // Unreferenced on purpose: once every socket is closed the loop should be
    // free to end on its own. An unreferenced timer still FIRES while anything
    // else is holding the process open, which is the only case it exists for.
    deadline.unref();
  };

  const onSigterm = () => shutdown("SIGTERM");
  const onSigint = () => shutdown("SIGINT");
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);

  return {
    shutdown,
    isShuttingDown: () => shuttingDown,
    /** Tests install this repeatedly in one process; nothing in production calls it. */
    dispose: () => {
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("SIGINT", onSigint);
    },
  };
}
