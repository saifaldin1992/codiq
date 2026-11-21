/**
 * ق-236 — من هو المتّصل حقاً، حين يقف وسيطٌ ثانٍ أمام المنصّة.
 *
 * THE DEFECT THIS PREVENTS, before it is introduced. Twenty-three call sites key
 * a rate limit on `request.ip` — the login door of all four dashboard
 * identities, password recovery, order tracking, the public storefront reads.
 * `app.set("trust proxy", 1)` says the platform sits behind EXACTLY ONE proxy,
 * and on Railway alone that is true.
 *
 * Putting Cloudflare in front makes it two. Express, still told to trust one,
 * then reports the CLOUDFLARE EDGE as the caller — so every request on the
 * platform arrives from a handful of addresses and every IP-keyed bucket
 * collapses into one. «30 login attempts per address per ten minutes» becomes
 * thirty attempts FOR THE WHOLE PLATFORM: the thirty-first merchant of the
 * morning is locked out of his own shop. It is precisely the failure the comment
 * at `app.ts:44` says `trust proxy` was set to prevent, reintroduced by adding a
 * layer meant to protect us.
 *
 * WHY THIS IS NOT SIMPLY «READ CF-CONNECTING-IP». That header is a claim made in
 * a request, and any caller can write it. Trusting it unconditionally would hand
 * every attacker a FRESH RATE-LIMIT BUCKET PER REQUEST — a complete bypass of
 * every limit on the platform, which is far worse than the collapse it fixes.
 * The header is worth exactly as much as the network path that delivered it.
 *
 * So it is read ONLY when the deployment declares, out of band, that an edge it
 * controls sits in front: `CODIQ_TRUSTED_EDGE=cloudflare`. Unset — which is
 * every local run, every test, and production today — nothing changes at all and
 * `request.ip` is the answer, exactly as before.
 *
 * The flag is deliberately the NAME of the edge rather than a boolean: the next
 * question after «are we behind something?» is always «behind what?», and a
 * boolean cannot answer it.
 */
import type { Request } from "express";

/** The header each supported edge uses to carry the original caller. */
const EDGE_CLIENT_IP_HEADER: Record<string, string> = {
  cloudflare: "cf-connecting-ip",
};

/**
 * Read once at import, like `config.ts` does for its own flags: the edge cannot
 * change under a running process, and re-reading `process.env` per request in a
 * hot path is how a deployment ends up half-behind-an-edge.
 */
const trustedEdgeHeader =
  EDGE_CLIENT_IP_HEADER[(process.env.CODIQ_TRUSTED_EDGE ?? "").trim().toLowerCase()] ?? null;

/** Exported for the suite, which must be able to prove both states. */
export function clientIpFrom(
  request: Request,
  edgeHeader: string | null = trustedEdgeHeader
): string {
  if (edgeHeader) {
    const claimed = request.header(edgeHeader);
    // A single address, never a list: `X-Forwarded-For`-style chains are exactly
    // the spoofing surface this function exists to close, and every edge in the
    // table above sends one address.
    if (claimed && !claimed.includes(",")) {
      const trimmed = claimed.trim();
      if (trimmed.length > 0 && trimmed.length <= 45) return trimmed;
    }
  }
  return request.ip ?? "unknown";
}

/**
 * The one reader. Every rate limit, every audit row and every security log that
 * needs «who called» uses this and never `request.ip` directly — so the day a
 * second edge is added there is ONE line to change, not twenty-three.
 */
export function clientIp(request: Request): string {
  return clientIpFrom(request);
}
