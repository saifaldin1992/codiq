import { config } from "../config.js";
import type { Request } from "express";

/**
 * D-63 — the dashboard session cookie carries the `__Host-` prefix.
 *
 * The prefix is not decoration. It is the ONLY cookie rule a browser enforces
 * against a SIBLING HOST: a cookie whose name begins with `__Host-` is stored
 * only when it is `Secure`, `Path=/` and carries NO `Domain` attribute — and
 * therefore can never have been written by `anything.codiq.iq` for the apex.
 * Without it, any host that ends up under the same registrable domain — a
 * status page, a staging box, a merchant's custom host pointed at the apex by
 * mistake, a subdomain someone parks years from now — can set `codiq_session`
 * for the whole domain and hand every dashboard a session of its choosing.
 * That is session fixation with no XSS anywhere in the chain, and it is the one
 * class of cookie attack that `HttpOnly`, `SameSite` and `Secure` together do
 * not touch.
 *
 * THE NAME FOLLOWS `Secure`, BECAUSE THE BROWSER REFUSES IT OTHERWISE. Local
 * http development is the one environment that cannot set a `Secure` cookie
 * (see `cookieSecureFromEnv`), and a `__Host-` cookie without `Secure` is
 * DROPPED SILENTLY — no error, no warning: sign-in would appear to succeed and
 * every request after it would answer 401 with nothing on screen to explain
 * why. So the same switch that decides `Secure` decides the name, and the two
 * can never disagree.
 *
 * ONE NAME IS ACCEPTED AT A TIME — never both. A fallback that also read the
 * bare name in production would hand back precisely the attack the prefix
 * exists to close: the sibling writes `codiq_session`, the server accepts it,
 * and the prefix becomes a comment. The cost of that strictness is that the
 * rename signs everyone out once, which is why it is being done now.
 */
export function webSessionCookieName(cookieSecure: boolean): string {
  return cookieSecure ? "__Host-codiq_session" : "codiq_session";
}

/** Resolved once at import, exactly like `config.cookieSecure`: it cannot drift mid-process. */
export const WEB_SESSION_COOKIE = webSessionCookieName(config.cookieSecure);

/**
 * The platform's ONE cookie parser.
 *
 * It was two — character for character — in `shared.ts` and in
 * `staff-permissions.ts`. Two copies of the same line are two places to change
 * for one rule, and the failure mode here is silent: the copy that kept reading
 * the old name would have left the staff surface accepting a cookie any sibling
 * host could write, while the merchant surface was protected. Same rule, one
 * implementation.
 */
export function cookieValue(request: Request, name: string): string | undefined {
  return request.headers.cookie?.split(";").map((value) => value.trim()).find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

/** The dashboard session token as the browser sent it, decoded — or undefined. */
export function readWebSessionCookie(request: Request): string | undefined {
  const raw = cookieValue(request, WEB_SESSION_COOKIE);
  return raw ? decodeURIComponent(raw) : undefined;
}
