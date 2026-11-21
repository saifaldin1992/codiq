/**
 * Unit — ق-235: what Sentry is allowed to be told about your shoppers.
 *
 * This platform is cash-on-delivery. An order payload carries a shopper's full
 * name, his home address and his phone number, and the Sentry SDK captures
 * request bodies, cookies and headers BY DEFAULT. So the interesting question is
 * not «does the reporter work» — it is «what leaves the server», and that is
 * what this file pins.
 *
 * It exercises `beforeSend` and `beforeBreadcrumb` as the SDK will call them,
 * with no network and no DSN: the hooks are read straight off the init options.
 *
 * Run: pnpm sentry:test
 */
import assert from "node:assert/strict";

const summary = {};

// ============================================================
// 1. INERT UNLESS CONFIGURED — the property every other test relies on.
// ============================================================
// Every local run, every CI run and every one of the 110 checks must behave
// exactly as it did before this module existed. If this assertion ever fails,
// the whole estate has quietly acquired a network dependency.
const { initSentry, sentryEnabled } = await import("../src/observability/sentry.ts");
assert.equal(
  initSentry({ NODE_ENV: "test" }),
  false,
  "no SENTRY_DSN means no initialisation at all"
);
assert.equal(sentryEnabled(), false, "…and nothing reports itself as active");
summary.inertWithoutDsn = true;

// A fault reported while inert must be a no-op, not a throw. A reporter that can
// break a request is worse than no reporter.
const { reportServerFault } = await import("../src/observability/sentry.ts");
reportServerFault(new Error("boom"), { requestId: "abc", route: "/x", status: 500 });
summary.reportIsSafeWhenInert = true;

// ============================================================
// 2. THE SCRUB — captured with a real DSN, then never sent.
// ============================================================
// The DSN below is syntactically valid and points at a host that cannot resolve,
// so `init` builds a live client (which is what gives us the real hooks) while
// `beforeSend` returning null keeps anything from being queued.
const Sentry = await import("@sentry/node");
assert.equal(
  initSentry({
    NODE_ENV: "test",
    SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry-never-resolves.invalid/0",
  }),
  true
);
assert.equal(sentryEnabled(), true);

const options = Sentry.getClient().getOptions();
assert.equal(
  options.sendDefaultPii,
  false,
  "ق-235: PII capture must be off EXPLICITLY — a future SDK default must not be able to turn it on"
);
assert.equal(
  options.tracesSampleRate,
  0,
  "tracing samples healthy traffic, which here means sampling order payloads"
);

// A realistic event: the shape the SDK builds for a failed checkout.
const shopper = {
  name: "أحمد عبد الله",
  phone: "+9647701234567",
  email: "ahmed@example.com",
  address: "بغداد، الكرادة، محلة ٩٠٩",
};
const event = {
  message: `checkout failed for ${shopper.email} (${shopper.phone})`,
  request: {
    url: `https://codiqos.com/api/store/x/checkout?email=${shopper.email}`,
    query_string: `email=${shopper.email}`,
    data: { fullName: shopper.name, phone: shopper.phone, address: shopper.address },
    cookies: { codiq_customer_x: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.aaaaaaaaaaaa" },
    headers: {
      authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.bbbbbbbbbbbb",
      cookie: "codiq_session=x",
    },
  },
  user: { email: shopper.email, ip_address: "37.236.1.1" },
  tags: { "http.status": "500" },
};

const sent = options.beforeSend(structuredClone(event), {});
assert.ok(sent, "a 500 is the server's own fault and must be reported");

// The carriers whose whole purpose is to hold what must not leave.
assert.equal(
  sent.request.data,
  undefined,
  "ق-235: the request BODY never leaves — it is where the address and the phone live"
);
assert.equal(
  sent.request.cookies,
  undefined,
  "ق-235: …nor the cookies, which carry the session ق-230 spent a decision protecting"
);
assert.equal(
  sent.request.headers,
  undefined,
  "ق-235: …nor the headers, which carry the bearer token"
);
assert.equal(
  sent.request.query_string,
  undefined,
  "ق-235: a query string is user input too — an email in ?q= is still an email"
);
assert.equal(
  sent.user,
  undefined,
  "ق-235: and no user identity, which is an email and an IP address"
);

// Then everything that DID survive is scrubbed by the logger's own rules, so
// there is one redaction rule on this platform rather than two that drift.
const serialised = JSON.stringify(sent);
for (const [label, secret] of [
  ["email", shopper.email],
  ["phone", shopper.phone],
  ["address", shopper.address],
  ["name", shopper.name],
]) {
  assert.ok(
    !serialised.includes(secret),
    `ق-235: the shopper's ${label} must not appear anywhere in the event — found it in ${serialised.slice(0, 200)}`
  );
}
assert.ok(!/eyJ[A-Za-z0-9_-]+\./.test(serialised), "ق-235: no JWT survives either");
summary.nothingAboutACustomerLeaves =
  "body, cookies, headers, query string and user identity dropped; survivors scrubbed";

// ============================================================
// 3. A REFUSAL IS NOT AN INCIDENT.
// ============================================================
// The free plan allows 5,000 events a month. Reporting every 404 and every
// validation refusal is how a signal becomes noise nobody reads — the same
// lesson ق-231 wrote down about warnings.
for (const status of ["400", "401", "403", "404", "409", "422"]) {
  assert.equal(
    options.beforeSend({ ...structuredClone(event), tags: { "http.status": status } }, {}),
    null,
    `ق-235: ${status} is the platform working correctly, not an incident`
  );
}
for (const status of ["500", "502", "503"]) {
  assert.ok(
    options.beforeSend({ ...structuredClone(event), tags: { "http.status": status } }, {}),
    `ق-235: ${status} is a fault the server owns`
  );
}
summary.refusalsAreNotIncidents = "4xx dropped, 5xx kept";

// ============================================================
// 4. Breadcrumbs are scrubbed too — they are the trail, not the event.
// ============================================================
const crumb = options.beforeBreadcrumb(
  { message: `looked up ${shopper.email}`, data: { phone: shopper.phone } },
  {}
);
assert.ok(
  !JSON.stringify(crumb).includes(shopper.email),
  "ق-235: a breadcrumb is a place a phone number hides"
);
assert.ok(!JSON.stringify(crumb).includes(shopper.phone));
summary.breadcrumbsScrubbed = true;

console.log(JSON.stringify({ suite: "sentry-scrub", status: "passed", summary }, null, 2));
