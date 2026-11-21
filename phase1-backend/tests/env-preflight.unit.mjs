/**
 * Unit — the environment preflight, and the one distinction it exists for.
 *
 * On 2026-09-05 production was found running with `CODIQ_PUBLIC_BASE_URL` unset.
 * `publicUrl()` therefore returned null, `resetLinkFor()` returned null, and
 * password recovery answered `delivery: "unavailable"` to every merchant, owner
 * and staff member — from the day #119 shipped. The service was honest; nothing
 * else was. The boot was green, `/health` said ok, and no log line existed to
 * search for.
 *
 * What is pinned here is the distinction that catches that class of thing:
 *
 *   `absent`     — nothing in the group is set. Sometimes a legitimate decision.
 *   `incomplete` — half the group is set. NEVER a decision. It is an unfinished
 *                  edit in a dashboard, and it is precisely the shape that boots
 *                  clean and fails at first use.
 *
 * Run: pnpm env:check:test
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const { ENVIRONMENT_GROUPS, reportEnvironment, readinessSummary } = await import("../src/config/environment-report.ts");

const summary = {};
/** A fully-configured deployed environment, used as the baseline to break. */
const COMPLETE = {
  NODE_ENV: "production",
  // Security pass 2026-11: a database across a network is reached over TLS.
  DATABASE_URL: "postgresql://x/y?sslmode=require",
  // ق-231: 44 base64 characters, the shape `openssl rand -base64 32` produces.
  // It used to read "s" — and the assertion below called that «fully
  // configured», which is the whole defect this line now refuses to describe.
  SESSION_JWT_SECRET: "0123456789abcdef0123456789abcdef0123456789ab",
  CODIQ_ENCRYPTION_KEY: "k",
  CODIQ_PUBLIC_BASE_URL: "https://codiq.example",
  CODIQ_SMTP_HOST: "smtp.example",
  CODIQ_SMTP_FROM: "a@b.c",
  // ق-235: present in the baseline because the baseline means «fully
  // configured», and a deployment nothing is watching is not that.
  SENTRY_DSN: "https://k@o0.ingest.de.sentry.io/1",
  PRODUCT_S3_BUCKET: "b",
  CODIQ_MAP_TILE_URL: "https://tiles.example/{z}/{x}/{y}.png?key=k",
  CODIQ_PAYMENTS_PROVIDER: "provider-x",
  CODIQ_PAYMENTS_WEBHOOK_SECRET: "a-webhook-signing-secret-of-48-characters-length",
  PRODUCT_S3_REGION: "r",
  PRODUCT_S3_ACCESS_KEY_ID: "id",
  PRODUCT_S3_SECRET_ACCESS_KEY: "secret",
  // ق-241: «fully configured» now includes backups that do not share a failure
  // domain with the thing they back up. Their ABSENCE is not an outage — see
  // section 8 — but a baseline that calls the shared bucket complete would be
  // describing the gap as the goal.
  CODIQ_BACKUP_S3_ENDPOINT: "https://backup.example",
  CODIQ_BACKUP_S3_BUCKET: "codiq-dumps",
  CODIQ_BACKUP_S3_ACCESS_KEY_ID: "backup-id",
  CODIQ_BACKUP_S3_SECRET_ACCESS_KEY: "backup-secret",
};

// ============================================================
// 1. The baseline passes — otherwise every assertion below is meaningless.
// ============================================================
const complete = reportEnvironment(COMPLETE);
assert.equal(complete.ok, true, "a fully-configured production environment must pass");
assert.deepEqual(complete.groups.filter((g) => g.verdict !== "ok"), [], "…with every group ok");
summary.baseline = "a complete production environment passes with every group ok";

// Security pass 2026-11: two rules a complete environment must also keep.
{
  const plaintext = reportEnvironment({ ...COMPLETE, DATABASE_URL: "postgresql://x/y" });
  assert.equal(plaintext.ok, false, "a remote database without sslmode fails");
  assert.deepEqual(plaintext.groups.find((group) => group.key === "database").missing, ["DATABASE_URL"]);
  const otpLog = reportEnvironment({ ...COMPLETE, CODIQ_OTP_PROVIDER: "insecure-log" });
  assert.equal(otpLog.ok, false, "sign-in codes written to the log fail a deployed preflight");
  const ownerOpen = reportEnvironment({ ...COMPLETE, CODIQ_ALLOW_OWNER_REGISTRATION: "true" });
  assert.deepEqual(ownerOpen.groups.find((group) => group.key === "session").missing, ["CODIQ_ALLOW_OWNER_REGISTRATION"], "open owner registration is named, under sign-in");
  const fakePayments = reportEnvironment({ ...COMPLETE, CODIQ_PAYMENTS_PROVIDER: "fake" });
  assert.deepEqual(fakePayments.groups.find((group) => group.key === "session").missing, ["CODIQ_PAYMENTS_PROVIDER"], "the test payment provider in a deployment is named");
  assert.equal(reportEnvironment({ ...COMPLETE, CODIQ_PAYMENTS_WEBHOOK_SECRET: "short" }).groups.find((group) => group.key === "payments").verdict, "incomplete", "a short signing secret is not a configured one");
  assert.equal(reportEnvironment({ ...COMPLETE, NODE_ENV: "development", CODIQ_OTP_PROVIDER: "insecure-log", CODIQ_ALLOW_OWNER_REGISTRATION: "true" }).groups.find((group) => group.key === "session").verdict, "ok", "development may use them");
  summary.securityPass = "plaintext database URLs and test switches left on fail a deployed preflight";
}

// ============================================================
// 2. The production defect itself, reproduced.
// ============================================================
const { CODIQ_PUBLIC_BASE_URL: _dropped, ...noBaseUrl } = COMPLETE;
const withoutBaseUrl = reportEnvironment(noBaseUrl);
assert.equal(withoutBaseUrl.ok, false, "production without CODIQ_PUBLIC_BASE_URL must FAIL — this is the live 2026-09-05 state, in which password recovery was dead");
const baseUrlGroup = withoutBaseUrl.groups.find((g) => g.key === "publicBaseUrl");
assert.equal(baseUrlGroup.verdict, "absent");
assert.deepEqual(baseUrlGroup.missing, ["CODIQ_PUBLIC_BASE_URL"], "and it must NAME the variable — «something is wrong» is not an answer an operator can act on");
assert.match(baseUrlGroup.consequence, /استعادة كلمة السرّ/, "…and say what stops working, not merely that a variable is missing");
summary.theLiveDefect = "production without CODIQ_PUBLIC_BASE_URL fails the preflight and names both the variable and the consequence";

// ============================================================
// 3. `incomplete` fails EVERYWHERE — development included.
// ============================================================
// Half a group is never a decision. A developer who set the bucket and forgot
// the key wants to know now, not at his first upload.
const halfStorage = reportEnvironment({ NODE_ENV: "development", PRODUCT_S3_BUCKET: "b" });
const storage = halfStorage.groups.find((g) => g.key === "storage");
assert.equal(storage.verdict, "incomplete", "some-but-not-all is `incomplete`, distinct from `absent`");
assert.equal(halfStorage.ok, false, "…and it fails even in development, where absence is otherwise tolerated");
assert.ok(storage.missing.includes("PRODUCT_S3_REGION") && storage.missing.includes("PRODUCT_S3_SECRET_ACCESS_KEY"), "every missing member is named");
summary.incompleteAlwaysFails = "a half-configured group fails in every environment, development included";

// ============================================================
// 4. …while plain `absent` is tolerated in development only.
// ============================================================
const bareDev = reportEnvironment({ NODE_ENV: "development" });
assert.equal(bareDev.ok, true, "a developer must be able to work on one feature without standing up the other five");
assert.ok(bareDev.groups.every((g) => g.verdict === "absent"), "…and every group reports `absent` rather than pretending to be ok");
const bareProd = reportEnvironment({ NODE_ENV: "production" });
assert.equal(bareProd.ok, false, "the same emptiness in production is a failure");
summary.absentIsContextual = "absence passes in development and fails in a deployed environment";

// ============================================================
// 5. An optional member alone makes the group `incomplete`, not `absent`.
// ============================================================
// The trap: setting only CODIQ_SMTP_PASS looks like "mail is configured" to a
// human reading a dashboard, while the provider resolves to null and every
// message is silently marked `skipped`.
const passOnly = reportEnvironment({ NODE_ENV: "production", CODIQ_SMTP_PASS: "p" });
const mail = passOnly.groups.find((g) => g.key === "mail");
assert.equal(mail.verdict, "incomplete", "an optional member set alone still means SOMETHING is set — the group is half-done, not untouched");
// ق-154: with nothing chosen yet, the advice names the transport that WORKS on
// this host. Railway disables outbound SMTP below the Pro plan, so telling an
// operator to finish configuring SMTP would be telling him to finish a road
// that ends at a wall.
assert.deepEqual(mail.missing, ["CODIQ_RESEND_API_KEY", "CODIQ_MAIL_FROM"]);
summary.optionalCounts = "an optional member alone makes the group incomplete, which is the honest reading";

// ============================================================
// 5b. ق-154 — EITHER transport satisfies `mail`, and the advice follows the
//     one the operator actually started.
// ============================================================
const httpsOnly = reportEnvironment({ NODE_ENV: "production", CODIQ_RESEND_API_KEY: "re_x", CODIQ_MAIL_FROM: "CODIQ <a@b.c>" });
assert.equal(httpsOnly.groups.find((g) => g.key === "mail").verdict, "ok", "an HTTPS-only deployment is COMPLETE — demanding SMTP too would call a working platform broken");

const smtpOnly = reportEnvironment({ NODE_ENV: "production", CODIQ_SMTP_HOST: "smtp.example", CODIQ_SMTP_FROM: "CODIQ <a@b.c>" });
assert.equal(smtpOnly.groups.find((g) => g.key === "mail").verdict, "ok", "…and so is an SMTP-only one, on a host that allows the port");

// The third set exists because `httpMailSettingsFromEnv` accepts the SMTP
// sender address: adding only an API key to an existing SMTP configuration is a
// complete HTTPS setup, and the report must agree with the provider.
const keyOnSmtpFrom = reportEnvironment({ NODE_ENV: "production", CODIQ_RESEND_API_KEY: "re_x", CODIQ_SMTP_FROM: "CODIQ <a@b.c>" });
assert.equal(keyOnSmtpFrom.groups.find((g) => g.key === "mail").verdict, "ok", "an API key beside an existing CODIQ_SMTP_FROM is a complete configuration — the provider says so, so the report must too");

// And a half-finished HTTPS setup names what is left of THAT transport, not the
// other one.
const halfHttps = reportEnvironment({ NODE_ENV: "production", CODIQ_RESEND_API_KEY: "re_x" });
assert.deepEqual(halfHttps.groups.find((g) => g.key === "mail").missing, ["CODIQ_MAIL_FROM"], "the closest set is reported, so the advice finishes what was started");
summary.mailTransports = "https or smtp; the report names whichever set is closest to done";

// ============================================================
// 5c. ق-231 — PRESENT is not the same as ADEQUATE.
// ============================================================
// D-62 closed half of this: the secret must exist. Nothing said how LONG, so an
// eight-character value passed every check on the platform — and an
// eight-character HMAC key is brute-forceable offline from ONE captured token,
// which yields the power to mint a session for any merchant, any platform owner,
// any shopper. ASVS 2.10 puts the floor at 32 bytes.
//
// It is reported as `incomplete` rather than as a new verdict because that word
// already means precisely this: «half-configured, and never on purpose».
const shortSecret = reportEnvironment({ ...COMPLETE, SESSION_JWT_SECRET: "s3cr3t" });
const sessionGroup = shortSecret.groups.find((g) => g.key === "session");
assert.equal(sessionGroup.verdict, "incomplete", "a six-byte session key is a half-configured platform, not a configured one — `ok` here is the whole defect");
assert.equal(shortSecret.ok, false, "…and it fails the preflight, in every environment");
assert.deepEqual(sessionGroup.missing, ["SESSION_JWT_SECRET"], "and it NAMES the variable — an operator cannot act on «something is weak»");
assert.match(sessionGroup.consequence, /6 بايت/, "…states the length he actually has");
assert.match(sessionGroup.consequence, /32/, "…and the one he needs");
assert.match(sessionGroup.consequence, /SESSION_JWT_SECRET_PREVIOUS/, "…and how to rotate WITHOUT signing everyone out, because advice that causes an outage is not taken");

// The boundary itself, both sides, so the check cannot quietly drift to a
// different number than the constant it claims to enforce.
const { SESSION_SECRET_MIN_BYTES } = await import("../src/config/environment-report.ts");
assert.equal(SESSION_SECRET_MIN_BYTES, 32, "ASVS 2.10 — pinned so lowering it is a deliberate, visible edit");
const atFloor = reportEnvironment({ ...COMPLETE, SESSION_JWT_SECRET: "x".repeat(SESSION_SECRET_MIN_BYTES) });
assert.equal(atFloor.groups.find((g) => g.key === "session").verdict, "ok", "exactly at the floor passes — the limit is a minimum, not an exclusive bound");
const belowFloor = reportEnvironment({ ...COMPLETE, SESSION_JWT_SECRET: "x".repeat(SESSION_SECRET_MIN_BYTES - 1) });
assert.equal(belowFloor.groups.find((g) => g.key === "session").verdict, "incomplete", "…and one byte below it does not");

// A weak value must never MANUFACTURE presence: an absent secret is still
// `absent`, so the group that a developer legitimately left unset does not
// suddenly start reporting a length complaint about an empty string.
const noSecret = reportEnvironment({ NODE_ENV: "development" });
assert.equal(noSecret.groups.find((g) => g.key === "session").verdict, "absent", "an unset secret is absent, not weak — the length check only ever downgrades an `ok`");
summary.weakIsNotConfigured = "a session key under 32 bytes reports `incomplete` and names both the length it has and the rotation that fixes it";

// ============================================================
// 6. `/ready` leaks nothing — no names, no values.
// ============================================================
// The endpoint is unauthenticated. `mail: { configured }` set this rule when it
// deliberately reported a boolean rather than the host or the user.
const ready = readinessSummary({ ...COMPLETE, CODIQ_SMTP_HOST: "smtp.internal.example", PRODUCT_S3_SECRET_ACCESS_KEY: "REAL-LOOKING-SECRET" });
const serialized = JSON.stringify(ready);
assert.ok(!serialized.includes("REAL-LOOKING-SECRET"), "no value may reach an unauthenticated response");
assert.ok(!serialized.includes("smtp.internal.example"), "…nor a hostname");
assert.ok(!/CODIQ_|PRODUCT_S3_|SESSION_/.test(serialized), "…nor a variable NAME: the summary carries verdicts only");
assert.deepEqual(Object.keys(ready.groups).sort(), ENVIRONMENT_GROUPS.map((g) => g.key).sort(), "every group is reported");
summary.readyLeaksNothing = "the /ready summary carries verdicts only — no values, no hosts, no variable names";

// ============================================================
// 7. Every group states a CONSEQUENCE, not just a name.
// ============================================================
// «CODIQ_PUBLIC_BASE_URL is missing» tells an operator nothing. «Password
// recovery answers unavailable to every merchant» tells him whether to stop the
// deploy. A group added later without one would quietly regress that.
for (const group of ENVIRONMENT_GROUPS) {
  assert.ok(group.consequence.length > 25, `group ${group.key} must say what stops working, in a sentence an operator can act on`);
  // ق-154 widened the shape: a group demands variables through `required`, or
  // through alternative `satisfiedBy` sets when a capability has more than one
  // transport. The rule is unchanged in substance — a group that demands
  // NOTHING can never report a problem, and is therefore worse than absent.
  const sets = group.satisfiedBy ?? [group.required];
  assert.ok(sets.length > 0, `group ${group.key} must require something`);
  for (const set of sets) {
    assert.ok(set.length > 0, `group ${group.key} has an EMPTY satisfying set — it would report ok on a bare environment`);
  }
  if (group.satisfiedBy) {
    assert.equal(group.required.length, 0, `group ${group.key} must not mix required with satisfiedBy — two rules for one group is one rule too many`);
  }
}
summary.consequencesNotNames = "every group states what stops working, not merely which variable is absent";

// ============================================================
// 8. The script prints no value, and runs nothing on import.
// ============================================================
const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "env-check.ts");
const source = readFileSync(scriptPath, "utf8");
assert.ok(!/process\.env\[/.test(source) && !/environment\[/.test(source), "the script must never read a value itself — it prints the report's verdicts");
assert.ok(/invokedDirectly/.test(source), "importing it must run nothing");
summary.scriptIsThin = "the preflight script reads no value of its own and runs nothing on import";

// ============================================================
// 9. ق-241 — where the backups live, and the one state that IS an outage.
// ============================================================
// Three cases, and the middle one is the whole point:
//
//   all four set  → ok       — the dumps survive the loss of the image bucket
//   none set      → absent   — they share it. A named gap, NOT a red gate: the
//                              second storage account is the owner's to mint,
//                              and a working platform must not go red waiting.
//   some set      → incomplete AND the whole report fails — half-configured is
//                              never intentional, and `resolveBackupStorage`
//                              refuses to run rather than fall back silently.
const { CODIQ_BACKUP_S3_ENDPOINT: _e, CODIQ_BACKUP_S3_BUCKET: _b, CODIQ_BACKUP_S3_ACCESS_KEY_ID: _i, CODIQ_BACKUP_S3_SECRET_ACCESS_KEY: _s, ...noDedicatedBackup } = COMPLETE;
const shared = reportEnvironment(noDedicatedBackup);
assert.equal(shared.groups.find((g) => g.key === "backupIsolation").verdict, "absent", "no dedicated destination is reported, not hidden");
assert.equal(shared.ok, true, "…but it does NOT fail the preflight — the platform backs up correctly, into the wrong failure domain, and that is the owner's call to fix");

const halfConfigured = reportEnvironment({ ...noDedicatedBackup, CODIQ_BACKUP_S3_BUCKET: "codiq-dumps" });
assert.equal(halfConfigured.groups.find((g) => g.key === "backupIsolation").verdict, "incomplete", "a bucket with no keys is half-configured");
assert.equal(halfConfigured.ok, false, "…and half-configured always fails: believing the dumps are isolated when they are not is worse than knowing they share a bucket");
summary.backupIsolation = "absent is reported and tolerated; half-configured fails the preflight, because that is the state that lies";

console.log(JSON.stringify({ suite: "env-preflight", status: "passed", summary }, null, 2));
