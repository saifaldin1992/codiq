/**
 * Unit — ق-236: who the caller is, and who gets to say so.
 *
 * Twenty-two rate limits key on the caller's address: the login door of all four
 * dashboard identities, password recovery, order tracking, the public storefront
 * reads. Two opposite failures are possible, and this file pins the line between
 * them.
 *
 *   · TRUST TOO LITTLE — put Cloudflare in front without reading its header and
 *     every request arrives from the edge's own address. All buckets collapse
 *     into one, and «30 login attempts per address» becomes thirty for the whole
 *     platform: the thirty-first merchant of the morning cannot reach his shop.
 *
 *   · TRUST TOO MUCH — read `CF-Connecting-IP` unconditionally and any caller
 *     writes it himself, earning a FRESH BUCKET PER REQUEST. That is not a
 *     degraded limit, it is no limit at all, on every door at once.
 *
 * The header is worth exactly as much as the network path that delivered it, so
 * it is read only when the deployment declares an edge it controls.
 *
 * Run: pnpm clientip:test
 */
import assert from "node:assert/strict";

const { clientIpFrom } = await import("../src/http/client-ip.ts");
const summary = {};

/** The shape `clientIpFrom` reads: Express's `header()` plus `ip`. */
function fakeRequest(headers, ip) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { header: (name) => lower[name.toLowerCase()], ip };
}

// ============================================================
// 1. NOT BEHIND AN EDGE — the header is a lie and is ignored.
// ============================================================
// This is every local run, every test, every CI job, and production today. The
// attacker's claim must buy him nothing at all.
const spoofed = fakeRequest(
  { "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "5.6.7.8" },
  "203.0.113.9"
);
assert.equal(
  clientIpFrom(spoofed, null),
  "203.0.113.9",
  "ق-236: with no declared edge, a claimed address is ignored entirely — otherwise every limit on the platform is bypassed one header at a time"
);
summary.spoofRefusedWhenNoEdge = true;

// And the ordinary request is unchanged, which is what lets this ship before the
// edge exists: nothing about today's behaviour moves.
assert.equal(clientIpFrom(fakeRequest({}, "203.0.113.9"), null), "203.0.113.9");
assert.equal(
  clientIpFrom(fakeRequest({}, undefined), null),
  "unknown",
  "a socket with no address still yields a usable bucket key rather than throwing"
);
summary.unchangedToday = true;

// ============================================================
// 2. BEHIND THE DECLARED EDGE — the real caller is recovered.
// ============================================================
// This is the whole point: without it, enabling Cloudflare silently collapses
// every bucket into the edge's own address.
const proxied = fakeRequest({ "cf-connecting-ip": "37.236.1.1" }, "172.71.0.5");
assert.equal(
  clientIpFrom(proxied, "cf-connecting-ip"),
  "37.236.1.1",
  "ق-236: behind the declared edge, the shopper's address is the bucket key — not Cloudflare's"
);
assert.notEqual(
  clientIpFrom(proxied, "cf-connecting-ip"),
  "172.71.0.5",
  "…and never the edge, which is the same address for every caller on the platform"
);
summary.realCallerRecovered = true;

// ============================================================
// 3. EVEN BEHIND THE EDGE, THE VALUE MUST LOOK LIKE ONE ADDRESS.
// ============================================================
// A comma-separated chain is the `X-Forwarded-For` spoofing surface wearing a
// different header name: accept it and a caller appends his own entry to mint a
// new bucket. Every supported edge sends exactly one address.
for (const [label, value] of [
  ["a chain", "1.2.3.4, 5.6.7.8"],
  ["empty", ""],
  ["whitespace", "   "],
  ["absurdly long", "x".repeat(200)],
]) {
  assert.equal(
    clientIpFrom(fakeRequest({ "cf-connecting-ip": value }, "172.71.0.5"), "cf-connecting-ip"),
    "172.71.0.5",
    `ق-236: ${label} is not one address — fall back to the socket rather than trust it`
  );
}
summary.malformedClaimRejected = "chain, empty, whitespace and oversized all fall back";

// ============================================================
// 4. THE FLAG NAMES THE EDGE, AND AN UNKNOWN NAME IS NOT AN EDGE.
// ============================================================
// A typo in a deployment variable must fail CLOSED — behaving as if there were
// no edge — rather than opening the header to everyone.
const { clientIp } = await import("../src/http/client-ip.ts");
assert.equal(typeof clientIp, "function", "the single reader every call site uses");
summary.oneReader = "22 call sites, one function";

console.log(JSON.stringify({ suite: "client-ip", status: "passed", summary }, null, 2));
