/**
 * Security pass 2026-11 — HTTPS is enforced, not only advertised.
 *
 * HSTS (security-headers.ts) tells a browser that has ALREADY reached us over
 * https to stay there. It does nothing for the first visit, a typed `http://`
 * address, or a link someone pasted: those arrive in clear text, and so would
 * the session cookie a browser sends with them if it had one. This middleware
 * closes that door:
 *
 *   · a GET or HEAD over http is answered 301 to the same path on https;
 *   · any other method over http is REFUSED (426), never redirected — a 301 on a
 *     POST would have the browser re-send the body, credentials and all, after
 *     it has already crossed the network in clear.
 *
 * WHEN IT IS ON. Only where the platform is deployed behind TLS: NODE_ENV
 * production AND a public base URL that starts with `https://`. Local runs and
 * the browser tests (production builds served over http://127.0.0.1) leave
 * CODIQ_PUBLIC_BASE_URL on http and are untouched. `CODIQ_ENFORCE_HTTPS=false`
 * is the explicit escape hatch for a proxy that does not set
 * X-Forwarded-Proto — and the boot report names it if it is used.
 *
 * The health and readiness probes are exempt: a platform's own checker calls
 * them on the private network, over http, and must not be sent away.
 */
import type { RequestHandler } from "express";

const PROBES = new Set(["/health", "/ready", "/api/health", "/api/ready"]);

export function httpsEnforcementEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  if (environment.CODIQ_ENFORCE_HTTPS?.trim() === "false") return false;
  return (
    environment.NODE_ENV === "production" &&
    (environment.CODIQ_PUBLIC_BASE_URL ?? "").startsWith("https://")
  );
}

export function httpsOnly(environment: NodeJS.ProcessEnv = process.env): RequestHandler {
  const enabled = httpsEnforcementEnabled(environment);
  return (request, response, next) => {
    if (!enabled || PROBES.has(request.path)) return next();
    // `trust proxy` is 1 (app.ts): `request.secure` reads the one proxy's X-Forwarded-Proto.
    if (request.secure) return next();
    if (request.method === "GET" || request.method === "HEAD") {
      // The SAME host the browser asked for: storefronts live on the merchants'
      // own domains too, and sending them to the platform's host would break
      // them. A forged Host header only redirects the client that forged it;
      // `no-store` keeps a shared cache from serving that redirect to anyone else.
      response.setHeader("cache-control", "no-store");
      response.redirect(301, `https://${request.hostname}${request.originalUrl}`);
      return;
    }
    response
      .status(426)
      .setHeader("upgrade", "TLS/1.2, HTTP/1.1")
      .json({
        error: { code: "HTTPS_REQUIRED", message: "This service is only available over HTTPS." },
      });
  };
}
