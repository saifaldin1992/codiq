/**
 * D-41 (phase 24-أ) — the structured logger.
 *
 * ONE event shape, JSON, one line, stdout:
 *
 *   {"level":"error","time":"2026-09-05T09:12:33.482Z","message":"request.failed",
 *    "requestId":"9f2c4a1b7d3e8056","ctx":{"route":"/api/orders/:orderId", … }}
 *
 * WHY stdout and no transport. Railway ingests the process's stdout and parses
 * a JSON line, promoting `level` and `message` into its own viewer. A transport
 * — a file, a socket, a vendor SDK — would add a failure mode (a full disk, a
 * dead collector) to a path whose entire job is to survive the failure it is
 * describing. Redirecting stdout is the deployment's business, not the code's.
 *
 * WHY no dependency. pino and winston are excellent and both are the wrong
 * trade here: this repo carries ZERO logging libraries today, the whole surface
 * needed is «serialize, redact, write», and the redaction rules in `redact.ts`
 * are the part that actually needs reviewing — putting a general-purpose
 * framework under them buys transports and levels we do not use and adds a
 * supply-chain dependency to the process that handles session tokens.
 *
 * WHY it is cheap when nothing is listening. `emit` compares two integers and
 * returns before it builds anything: no object literal, no serialization, no
 * string. A caller whose CONTEXT is expensive to build asks `isLevelEnabled`
 * first. The per-request completion line is `debug`, so in production the cost
 * of this module on a successful request is one integer comparison.
 */

import { currentLogContext } from "./context.js";
import { redactKey, scrubText } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel | "silent", number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/**
 * Read ONCE at import, like `config.demoMode` and `config.cookieSecure`: the
 * threshold cannot drift mid-process, and a log level that changes under a
 * running incident is a log nobody can reason about.
 *
 * `silent` exists for the integration suites, which drive hundreds of requests
 * per run and would otherwise bury a real assertion failure in transcript.
 */
function thresholdFromEnv(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment.CODIQ_LOG_LEVEL?.trim().toLowerCase();
  if (raw && raw in RANK) return RANK[raw as LogLevel | "silent"];
  return RANK.info;
}

const THRESHOLD = thresholdFromEnv();

/** Caps. A log line is evidence, not a payload; an unbounded one is a denial of service against the reader. */
const MAX_DEPTH = 4;
const MAX_ARRAY = 20;
const MAX_STRING = 512;
const MAX_STACK = 2000;
const MAX_LINE = 8192;

type Sink = (line: string) => void;
const stdoutSink: Sink = (line) => {
  process.stdout.write(`${line}\n`);
};
let sink: Sink = stdoutSink;

/**
 * Test seam. Returns the restore function so a suite can never leave the sink
 * swapped for the next file — the same shape the repo's other seams use.
 */
export function setLogSink(next: Sink): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

export function isLevelEnabled(level: LogLevel): boolean {
  return RANK[level] >= THRESHOLD;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const stack =
      typeof error.stack === "string" ? scrubText(error.stack).slice(0, MAX_STACK) : undefined;
    return {
      name: error.name,
      message: scrubText(error.message).slice(0, MAX_STRING),
      ...(stack ? { stack } : {}),
    };
  }
  return { name: "NonError", message: scrubText(String(error)).slice(0, MAX_STRING) };
}

/**
 * The value walker. It is the only path from a caller's object to the wire, so
 * every rule in `redact.ts` is applied here and cannot be routed around.
 */
function sanitize(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string": {
      const scrubbed = scrubText(value);
      return scrubbed.length > MAX_STRING
        ? `${scrubbed.slice(0, MAX_STRING)}…(+${scrubbed.length - MAX_STRING})`
        : scrubbed;
    }
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "function":
      return "[function]";
    case "symbol":
      return value.toString();
    default:
      break;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return serializeError(value);
  if (depth >= MAX_DEPTH) return "[depth]";
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => sanitize(item, depth + 1, seen));
    if (value.length > MAX_ARRAY) items.push(`…(+${value.length - MAX_ARRAY})`);
    return items;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) continue;
    output[key] = redactKey(key) ? "[redacted]" : sanitize(item, depth + 1, seen);
  }
  return output;
}

export interface LogFields {
  /** An Error to serialize (name, message, scrubbed stack). Any other key is plain context. */
  err?: unknown;
  [key: string]: unknown;
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  // The cheap path: two integers, and nothing is allocated.
  if (RANK[level] < THRESHOLD) return;
  const context = currentLogContext();
  let line: string;
  try {
    const ctx: Record<string, unknown> = {};
    if (context) {
      for (const [key, value] of Object.entries(context)) {
        if (key === "requestId" || key === "startedAt" || value === undefined) continue;
        ctx[key] = redactKey(key) ? "[redacted]" : sanitize(value, 1, new WeakSet());
      }
    }
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        if (key === "err") {
          ctx.err = serializeError(value);
          continue;
        }
        ctx[key] = redactKey(key) ? "[redacted]" : sanitize(value, 1, new WeakSet());
      }
    }
    // `JSON.stringify` escapes newlines, quotes and control characters, so a
    // string a stranger controls — a header, a slug, a Postgres error echoing
    // his input — can never forge a second log line. That is why the message is
    // serialized rather than concatenated.
    line = JSON.stringify({
      level,
      time: new Date().toISOString(),
      message: scrubText(message).slice(0, MAX_STRING),
      requestId: context?.requestId ?? null,
      ctx,
    });
    if (line.length > MAX_LINE) {
      line = JSON.stringify({
        level,
        time: new Date().toISOString(),
        message: scrubText(message).slice(0, MAX_STRING),
        requestId: context?.requestId ?? null,
        ctx: { oversized: true, droppedBytes: line.length },
      });
    }
  } catch (failure) {
    // Logging must never be the reason a request dies. A context object with a
    // throwing getter or an unserializable member costs its detail, not the
    // line and certainly not the response.
    line = JSON.stringify({
      level,
      time: new Date().toISOString(),
      message: scrubText(message).slice(0, MAX_STRING),
      requestId: context?.requestId ?? null,
      ctx: { logSerializationFailed: failure instanceof Error ? failure.name : "unknown" },
    });
  }
  try {
    sink(line);
  } catch {
    /* stdout is gone (a closed pipe). There is nowhere left to report that to. */
  }
}

/**
 * LEVELS — the rule, so that «what is a warn» is not decided per call site.
 *
 *  debug  Per-request bookkeeping: `request.completed` (method, route, status,
 *         duration) and `request.rejected` (a mapped 4xx). OFF in production —
 *         see the volume note below.
 *  info   Something changed, or the process reached a milestone: boot, worker
 *         start and stop, a sweep that actually deleted or released rows, a
 *         notification batch that delivered. Rare, and each line is worth
 *         keeping for a month.
 *  warn   A degraded but handled condition that a human should see if it
 *         repeats: a mapped error that is nonetheless a 5xx, a job pass that
 *         completed with failed tables, a worker child that exited and is being
 *         restarted, the development encryption key in use.
 *  error  A fault the server owns: an unmapped exception reaching the error
 *         handler, a job pass that threw, a row a sweep could not process. Each
 *         one is a thing to fix; if these are not rare the level is wrong.
 *
 * VOLUME — a successful request logs NOTHING at the default level.
 *
 * The platform is one container serving the API, every dashboard and every
 * storefront. An access line per request at a modest 50 req/s is 4.3 million
 * lines a day: a real Railway ingest cost, and — worse — a haystack that hides
 * the twelve lines that matter. The proxy in front already has the access log;
 * what stdout must carry is the thing the proxy cannot see, which is the fault
 * and the context around it.
 *
 * Expected lines per request, production (`CODIQ_LOG_LEVEL` unset ⇒ info):
 *   • 2xx/3xx  →  0
 *   • 4xx      →  0   (the response IS the answer; the caller made the mistake)
 *   • 5xx      →  1   (exactly one, from the error handler)
 * With `CODIQ_LOG_LEVEL=debug`, add exactly one `request.completed` line per
 * request — the switch to flip while an incident is open, never the default.
 */
export const logger = {
  debug: (message: string, fields?: LogFields) => emit("debug", message, fields),
  info: (message: string, fields?: LogFields) => emit("info", message, fields),
  warn: (message: string, fields?: LogFields) => emit("warn", message, fields),
  error: (message: string, fields?: LogFields) => emit("error", message, fields),
  isLevelEnabled,
};
