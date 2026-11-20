/**
 * Unit — the mail probe, and the secret it must never print.
 *
 * The probe exists because on 2026-09-05 the outbox proved the platform had
 * never sent an email from either live environment, while two separate signals
 * — the worker's boot line and `/ready`'s `mail.configured` — read as success.
 * A probe that repeated that mistake would be worse than none, so what is
 * asserted here is what it must NOT do:
 *
 *   1. never put the SMTP password in its output, and
 *   2. never touch the outbox, whose rows mean "the platform sent this to a
 *      customer" — an operator's test is not that.
 *
 * Run: pnpm mail:probe:test
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const summary = {};
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const scriptPath = path.join(root, "phase1-backend", "scripts", "mail-probe.ts");
const source = readFileSync(scriptPath, "utf8");

// ============================================================
// 1. It writes nothing. Ever.
// ============================================================
// The outbox answers «did the merchant get his email?». Seeding it with an
// operator's probe corrupts the only table that question has.
assert.ok(!/notification_outbox|notificationOutbox|prisma\./.test(source), "the probe must not touch the database at all — the outbox is the record of what the PLATFORM sent");
summary.writesNothing = "no database access in the probe at all";

// ============================================================
// 2. The password is never read, so it cannot be printed.
// ============================================================
// Stronger than masking: `describeSettings` reports pass as "set"/"absent" and
// never loads the value, so a later edit cannot accidentally interpolate it.
const passReads = source.match(/CODIQ_SMTP_PASS/g) ?? [];
assert.equal(passReads.length, 1, "CODIQ_SMTP_PASS may be referenced exactly once — to report presence, never to print a value");
assert.ok(/CODIQ_SMTP_PASS \? "set" : "absent"/.test(source), "…and that one reference must collapse it to set/absent");
assert.ok(!/settings\.pass/.test(source), "the resolved password field is never read by the probe");
summary.noSecretInOutput = "the password is collapsed to set/absent and its value is never loaded";

// ============================================================
// 3. Connecting and SENDING are separate on purpose.
// ============================================================
// The default must be safe to run against production: it proves the credential
// without putting a test message in a real inbox.
assert.ok(/verifyTransport\(\)/.test(source), "the default path verifies the transport");
assert.ok(/const to = flag\("to"\)/.test(source) && source.indexOf("verifyTransport()") < source.indexOf('flag("to")'), "…and it verifies BEFORE it considers sending, so a bad credential is reported without an attempted delivery");
summary.twoChecks = "verify by default; a real send only when --to names a recipient";

// ============================================================
// 4. It runs, and says the honest thing with no configuration.
// ============================================================
// Run with a deliberately empty SMTP environment: no host means no provider,
// and the probe must SAY so and exit non-zero rather than report success.
let output = "";
let exitCode = 0;
try {
  output = execFileSync(process.execPath, ["--import", "tsx", scriptPath], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CODIQ_SMTP_HOST: "", CODIQ_SMTP_FROM: "", CODIQ_SMTP_PASS: "" },
  });
} catch (error) {
  exitCode = error.status ?? 1;
  output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
}
assert.equal(exitCode, 1, "an unconfigured channel is a FAILED probe — exiting 0 would be the exact lie this file exists to prevent");
assert.match(output, /not_configured/, "…and it names the reason");
summary.honestWhenAbsent = "with no SMTP settings the probe exits 1 and says not_configured";

// ============================================================
// 5. Importing it connects to nothing.
// ============================================================
const module = await import("../scripts/mail-probe.ts");
assert.ok(module !== null, "the module imports cleanly without running main()");
assert.ok(/invokedDirectly/.test(source), "…because it guards on being invoked as the command");
summary.importable = "importing the probe runs nothing";

// ============================================================
// 6. ع-6 — the transport connects to a resolved IPv4 address, and still
//    validates the certificate against the HOSTNAME.
// ============================================================
// What the probe found on production, verbatim:
//
//   ESOCKET: connect ENETUNREACH 2a00:1450:4025:401::6d:465 - Local (:::0)
//
// An IPv6 address for smtp.gmail.com, on a container with no IPv6 route. But
// the failure was not constant, and that is the part worth guarding. Read
// nodemailer's own resolver: it resolves BOTH families, concatenates them, and
// picks `addresses[Math.floor(Math.random() * addresses.length)]`. Gmail
// publishes exactly one A and one AAAA record — so every send was a fifty-fifty
// bet, which reads as flakiness rather than as a broken channel.
//
// The FIRST attempt at this fix set `family: 4` on the transport, and it was a
// placebo: `resolveHostname` never reads that option. A test written against it
// would have guarded a comfort. So this asserts the two things that actually
// carry the fix, through an INJECTED resolver — no DNS, no network, and the
// assertion cannot pass by accident on a machine whose DNS happens to behave.
const { SmtpEmailProvider } = await import("../src/notifications/notification-provider.ts");
const settings = { host: "smtp.example.invalid", port: 465, secure: true, from: "CODIQ <x@example.invalid>", user: "x", pass: "y" };

const asked = [];
const fakeLookup = async (host, family) => {
  asked.push({ host, family });
  return family === 6 ? "2a00:1450:4001:c21::6c" : "142.251.127.109";
};

const ipv4 = await new SmtpEmailProvider(settings, fakeLookup).transport();
assert.deepEqual(asked, [{ host: "smtp.example.invalid", family: 4 }], "it resolves the configured host, asking for IPv4");
assert.equal(ipv4.options.host, "142.251.127.109", "the transport connects to a LITERAL address — nodemailer's own resolver short-circuits on net.isIP and cannot then pick an unreachable family at random");
assert.equal(ipv4.options.tls?.servername, "smtp.example.invalid", "…and the hostname is restored for TLS, or the certificate is validated against a number and every connection fails to verify");
assert.equal(ipv4.options.port, 465);
assert.equal(ipv4.options.secure, true);
assert.equal(ipv4.options.auth?.user, "x", "authentication survives the rewrite");

// An IPv6-only host must be able to say so without a code change.
process.env.CODIQ_SMTP_FAMILY = "6";
try {
  const ipv6 = await new SmtpEmailProvider(settings, fakeLookup).transport();
  assert.equal(ipv6.options.host, "2a00:1450:4001:c21::6c", "CODIQ_SMTP_FAMILY=6 selects the other family");
  assert.equal(ipv6.options.tls?.servername, "smtp.example.invalid");
} finally {
  delete process.env.CODIQ_SMTP_FAMILY;
}

// A DNS hiccup must not be the thing that makes password recovery impossible:
// it falls back to the hostname, which is exactly today's behaviour.
const failing = await new SmtpEmailProvider(settings, async () => { throw new Error("EAI_AGAIN"); }).transport();
assert.equal(failing.options.host, "smtp.example.invalid", "a failed lookup falls back to the hostname rather than refusing to build a transport");

summary.addressSelection = "connects to a resolved literal (IPv4 by default), keeps tls.servername for certificate validation, and falls back to the hostname when resolution fails";

console.log(JSON.stringify({ suite: "mail-probe", status: "passed", summary }, null, 2));
