/**
 * D-41 (phase 24-أ) — the correlation id at the edge.
 *
 * MOUNTED TWICE, ON PURPOSE. The security-headers work (19-د / D-34) found the
 * trap the hard way: middleware registered inside `createApp()` only ever
 * reaches `/api`, because that is where the composite server mounts the API
 * app. Every HTML document, `/sw.js`, `/robots.txt` and every storefront page
 * goes through the OUTER app and would carry no id at all. So this middleware
 * is registered first in `server/index.ts` AND first in `createApp()`, and is
 * idempotent: the inner instance sees the context the outer one opened, re-sets
 * the header and steps aside. Under `pnpm phase1:start` and in the integration
 * suites — where only the API app exists — the inner one is the edge.
 *
 * LOG MESSAGES ARE ENGLISH. The tone guard's masculine-Arabic rule is about
 * what a merchant reads; nobody reads a log line but an operator, and the
 * Arabic error MESSAGES that phase 22 will translate travel through here as
 * DATA (`ctx.code` / the response body), untouched. An English event name is
 * also greppable in a viewer that does not shape Arabic — `request.failed` is
 * one token in Railway's search box.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { currentLogContext, newCorrelationId, runWithLogContext } from "../logging/context.js";
import { logger } from "../logging/logger.js";

export const CORRELATION_HEADER = "x-request-id";

/**
 * An inbound `x-request-id` is NOT honoured as the correlation id.
 *
 * Every storefront request comes from a stranger's browser, so this header is
 * attacker-controlled input on the majority of the platform's traffic. Honouring
 * it would let anyone stamp one id on ten thousand requests (correlation becomes
 * meaningless exactly when it is needed), collide with a real id to poison
 * another tenant's trail, or plant a 4 KB string on every line of a request. No
 * trusted upstream sets it today: Railway does not, and the single proxy hop in
 * front is not ours to trust with identity.
 *
 * The value is not thrown away either. When it is well shaped it is recorded as
 * `upstreamRequestId` — a plain context field, never the id — so that a future
 * CDN trace can still be joined to ours without ever becoming it.
 */
const UPSTREAM_ID = /^[A-Za-z0-9_.:-]{8,64}$/;

/**
 * The route PATTERN, never the resolved URL: `/api/store/:storeSlug/orders/:orderId`.
 * A URL carries ids, a password-reset token and a `?q=` that is very often a
 * customer's phone number (redact.ts, item 7). The pattern carries none of them
 * and is the thing you actually group by.
 */
export function routePatternOf(request: Request): string {
  const pattern = (request.route as { path?: unknown } | undefined)?.path;
  if (typeof pattern === "string" && pattern.length > 0) return `${request.baseUrl}${pattern}`;
  return sanitizePath(`${request.baseUrl}${request.path}`);
}

/**
 * For a request that matched no route there is no pattern, so the path is used
 * with its long opaque segments removed — that is where a token would sit.
 */
function sanitizePath(path: string): string {
  return path
    .split("/")
    .map((segment) => (/^[A-Za-z0-9_-]{24,}$/.test(segment) ? ":opaque" : segment))
    .join("/")
    .slice(0, 200);
}

export function correlationMiddleware(): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    const open = currentLogContext();
    if (open) {
      // The outer app already opened this request's context. Re-assert the
      // header (this is a different mount, and cheap) and get out of the way.
      if (!response.headersSent) response.setHeader(CORRELATION_HEADER, open.requestId);
      next();
      return;
    }
    const requestId = newCorrelationId();
    const upstream = request.header(CORRELATION_HEADER);
    response.setHeader(CORRELATION_HEADER, requestId);
    runWithLogContext(
      {
        requestId,
        startedAt: Date.now(),
        method: request.method,
        ...(upstream && UPSTREAM_ID.test(upstream) ? { upstreamRequestId: upstream } : {}),
      },
      () => {
        // Registered only when someone is listening. At the default level this
        // whole branch is one integer comparison and no listener at all, which
        // is what keeps a successful request free of logging cost.
        if (logger.isLevelEnabled("debug")) {
          const startedAt = Date.now();
          response.on("finish", () => {
            logger.debug("request.completed", { route: routePatternOf(request), status: response.statusCode, durationMs: Date.now() - startedAt });
          });
        }
        next();
      },
    );
  };
}
