/**
 * codiq — cookies carry `Secure` everywhere except local http development.
 *
 * THIS PINS A DEFECT THAT WAS LIVE. Every cookie in the platform read
 * `NODE_ENV === "production"`, and `production` is set only by the `start`
 * script — staging runs `NODE_ENV=staging` (docs/DEPLOYMENT.md). So staging,
 * served over https, was issuing SESSION cookies without `Secure`: a single
 * plain-http request to that host would put the session token on the wire.
 *
 * The rule is inverted for a reason worth testing rather than trusting. The old
 * form had to NAME every environment that deserves protection, so forgetting one
 * failed OPEN and silently. The new form names the one environment that cannot
 * have it, so forgetting fails CLOSED and loudly — a cookie the browser refuses
 * to store, noticed on the first sign-in.
 *
 * The assertions below are mostly about the environments NOBODY thought of when
 * writing the original line, because those are what it got wrong.
 */
import assert from "node:assert/strict";

// This guard reads rules, never a database — but `config.ts` demands both of
// these at import and D-63 brought `shared.ts` (and with it the Prisma client
// module) into the graph. The URL points at a host that cannot resolve, so a
// query added to this path in future fails loudly instead of touching anything.
process.env.SESSION_JWT_SECRET ??= "cookie-secure-guard-secret-not-for-production";
process.env.DATABASE_URL ??= "postgresql://guard:guard@cookie-guard-never-connects.invalid:5432/guard";

const { cookieSecureFromEnv } = await import("../src/config.ts");

// The environment that was actually broken.
assert.equal(cookieSecureFromEnv({ NODE_ENV: "staging" }), true, "staging is https and MUST set Secure — this is the defect that shipped");

// The ones that already worked, and must keep working.
assert.equal(cookieSecureFromEnv({ NODE_ENV: "production" }), true, "production");
assert.equal(cookieSecureFromEnv({ NODE_ENV: "development" }), false, "local http development is the one exception");

// The ones nobody has invented yet. Under the OLD rule every one of these was
// insecure by default, which is exactly how staging came to be broken.
for (const unnamed of ["demo", "preview", "qa", "test", "sandbox", undefined]) {
  assert.equal(
    cookieSecureFromEnv({ NODE_ENV: unnamed }),
    true,
    `«${unnamed ?? "unset"}» is not development, so it gets Secure — an unnamed environment must fail CLOSED`,
  );
}

// The escape hatch, both ways. It exists for an https local setup or an http
// staging box; it is not the mechanism.
assert.equal(cookieSecureFromEnv({ NODE_ENV: "development", CODIQ_COOKIE_SECURE: "true" }), true, "the hatch can turn it ON in development");
assert.equal(cookieSecureFromEnv({ NODE_ENV: "production", CODIQ_COOKIE_SECURE: "false" }), false, "…and OFF where it would otherwise be on");
// Anything that is not the literal "false" leaves it on: a typo in an override
// must not silently strip Secure from production.
for (const typo of ["False", "FALSE", "0", "no", "off", " "]) {
  assert.equal(
    cookieSecureFromEnv({ NODE_ENV: "production", CODIQ_COOKIE_SECURE: typo }),
    true,
    `«${typo}» is not the literal "false" — a typo in the override must not strip Secure`,
  );
}

// ============================================================
// D-63 — the dashboard cookie's NAME follows the same switch.
// ============================================================
// `__Host-` is the only cookie rule a browser enforces against a SIBLING HOST:
// a cookie so named is stored only when it is `Secure`, `Path=/` and carries no
// `Domain`, so no subdomain can write one for the apex. Without it, anything
// that ever serves content under the same registrable domain can set
// `codiq_session` for everyone — session fixation with no XSS in the chain.
//
// The name has to follow `Secure` because a `__Host-` cookie WITHOUT `Secure` is
// dropped silently: sign-in would appear to work and every request after it
// would answer 401, with nothing in the browser or the log to say why. Tying
// both to one function is what makes that impossible rather than unlikely.
const { webSessionCookieName, WEB_SESSION_COOKIE } = await import("../src/http/session-cookie.ts");

assert.equal(webSessionCookieName(true), "__Host-codiq_session", "wherever the cookie is Secure it carries the prefix");
assert.equal(webSessionCookieName(false), "codiq_session", "…and local http development, which cannot set Secure, gets the bare name");

// The pairing, stated as the invariant it is: every environment that sets
// `Secure` gets the prefix, and the only one that does not is the only one that
// cannot have it.
for (const environment of ["production", "staging", "demo", "qa", "test", undefined]) {
  const secure = cookieSecureFromEnv({ NODE_ENV: environment });
  assert.equal(secure, true);
  assert.equal(webSessionCookieName(secure), "__Host-codiq_session", `«${environment ?? "unset"}» is https, so its cookie is __Host- prefixed`);
}
assert.equal(webSessionCookieName(cookieSecureFromEnv({ NODE_ENV: "development" })), "codiq_session", "development is the single exception, and it is the same exception as Secure");

// The prefix is a browser rule with three conditions, and ALL of them are ours
// to keep. A name alone proves nothing: `setWebSession` must also be sending
// `Secure`, `Path=/` and no `Domain`, or the browser silently refuses to store
// the cookie and the platform locks everyone out.
const { setWebSession, clearWebSession } = await import("../src/http/shared.ts");
for (const [label, apply] of [["setWebSession", (response) => setWebSession(response, "a-token")], ["clearWebSession", clearWebSession]]) {
  const recorded = [];
  apply({ cookie: (name, ...rest) => recorded.push({ name, options: rest.at(-1) }), clearCookie: (name, options) => recorded.push({ name, options }) });
  assert.equal(recorded.length, 1, `${label} writes exactly one cookie`);
  const [written] = recorded;
  assert.equal(written.name, WEB_SESSION_COOKIE, `${label} uses the resolved name — set and clear must never disagree, or sign-out leaves a live cookie behind`);
  if (!WEB_SESSION_COOKIE.startsWith("__Host-")) continue;
  assert.equal(written.options.secure, true, `${label}: a __Host- cookie without Secure is DROPPED by the browser, silently`);
  assert.equal(written.options.path, "/", `${label}: __Host- requires Path=/`);
  assert.equal(written.options.domain, undefined, `${label}: __Host- requires NO Domain attribute — that is the whole point of it`);
}

console.log(
  JSON.stringify(
    {
      sessionCookieName: {
        resolved: WEB_SESSION_COOKIE,
        rule: "__Host-codiq_session wherever Secure is set; codiq_session in local http development only",
        enforced: "Secure + Path=/ + no Domain, asserted on the real setWebSession/clearWebSession calls",
        closes: "a sibling host writing the session cookie for the apex — session fixation with no XSS",
      },
      cookieSecure: {
        secureIn: ["production", "staging", "demo", "qa", "unset — anything not development"],
        insecureIn: ["development"],
        override: "CODIQ_COOKIE_SECURE, and only the literal \"false\" disables it",
        defectPinned: "staging was issuing session cookies without Secure",
      },
    },
    null,
    2,
  ),
);
console.log("cookie:secure OK");
