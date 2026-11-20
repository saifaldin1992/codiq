/**
 * ق-154 — the HTTPS mail transport, exercised against a real server that is not
 * the internet.
 *
 * WHY IT EXISTS AT ALL. `pnpm mail:probe` on production answered `ETIMEDOUT`
 * connecting to the IPv4 address of smtp.gmail.com:465 — a timeout, not a
 * refusal, which is what a blocked port looks like from inside. Railway's
 * documentation is explicit: **"SMTP is only available on the Pro plan and
 * above"**. So no SMTP configuration could ever have delivered a message from
 * this host, and the platform's password recovery was dead from the day it
 * shipped for a reason no amount of checking the Gmail app password would find.
 *
 * The assertions here are the ones a mail transport can fail silently on:
 * that the request is shaped the way the provider expects, that the API KEY
 * never reaches an outcome string (those strings are written to
 * `notification_outbox.last_outcome` and read by support), and that a hung
 * server becomes a fast retryable failure rather than an outbox row stuck in
 * `processing` — which is exactly what the SMTP attempt did for two minutes
 * while this was being diagnosed.
 *
 * A loopback server, not a mock: a hand-written fake would agree with whatever
 * the code does, including sending no Authorization header at all.
 *
 * Run: pnpm http:mail:test
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  HttpEmailProvider,
  SmtpEmailProvider,
  httpMailSettingsFromEnv,
  isEmailProviderConfigured,
  resolveNotificationProvider,
} from "../src/notifications/notification-provider.ts";

const API_KEY = "re_test_thisisnotarealkey_0123456789";
const received = [];

/** Answers whatever the current scenario says, and records what it was asked. */
let scenario = { status: 200, body: { id: "sent" }, delayMs: 0 };
const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    received.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      contentType: request.headers["content-type"],
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null,
    });
    const send = () => {
      response.writeHead(scenario.status, { "content-type": "application/json" });
      response.end(JSON.stringify(scenario.body));
    };
    if (scenario.delayMs) setTimeout(send, scenario.delayMs);
    else send();
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
const provider = new HttpEmailProvider({ apiKey: API_KEY, from: "CODIQ <no-reply@codiqos.com>" }, endpoint);

const summary = {};

// ============================================================
// 1. A send is one POST, correctly shaped and authenticated.
// ============================================================
const sent = await provider.sendEmail({ to: "owner@example.com", subject: "فحص", body: "نص" });
assert.deepEqual(sent, { ok: true, outcome: "http_accepted" });
const post = received.at(-1);
assert.equal(post.method, "POST");
assert.equal(post.url, "/emails");
assert.equal(post.authorization, `Bearer ${API_KEY}`, "the key travels in the header, where it belongs");
assert.equal(post.contentType, "application/json");
assert.equal(post.body.from, "CODIQ <no-reply@codiqos.com>");
assert.deepEqual(post.body.to, ["owner@example.com"], "the recipient is an array — the API rejects a bare string");
assert.equal(post.body.subject, "فحص");
assert.equal(post.body.text, "نص", "Arabic survives the JSON round trip");
assert.ok(!("reply_to" in post.body), "ق-184: no reply path asked for, no key sent — Resend refuses a null reply_to");
summary.send = "POST /emails, bearer auth, recipient array, Arabic body intact";

// ق-184 — the reply path on the wire. `reply_to` is an ARRAY like `to`, and it
// appears only when one was asked for; the audience that gets one is decided
// upstream by `supportReplyTo`, never here.
const withReply = await provider.sendEmail({ to: "owner@example.com", subject: "فحص", body: "نص", replyTo: "support@codiqos.com" });
assert.deepEqual(withReply, { ok: true, outcome: "http_accepted" });
assert.deepEqual(received.at(-1).body.reply_to, ["support@codiqos.com"], "ق-184: the reply address travels as an array");
summary.replyTo = "reply_to sent as an array, and omitted entirely when absent";

// ============================================================
// 2. A refusal is named — and says nothing secret.
// ============================================================
scenario = { status: 401, body: { name: "validation_error", message: "API key is invalid" }, delayMs: 0 };
const refused = await provider.sendEmail({ to: "owner@example.com", subject: "s", body: "b" });
assert.equal(refused.ok, false);
assert.equal(refused.outcome, "http_failed:401:validation_error", "the status and the provider's short name, and nothing else");
assert.ok(!refused.outcome.includes(API_KEY), "THE KEY MUST NEVER REACH AN OUTCOME — this string is written to notification_outbox.last_outcome");
assert.ok(!refused.outcome.includes("API key is invalid"), "…nor the provider's free-text message, which is not ours to store");
summary.refusal = "status + provider error name only; never the key, never the body";

// ============================================================
// 3. A hung server becomes a fast, named, retryable failure.
// ============================================================
// The SMTP attempt this transport replaces sat in `processing` for two full
// minutes on a blocked port. A deadline is the difference between a retry and
// a wedged queue.
const impatient = new HttpEmailProvider({ apiKey: API_KEY, from: "x@y.z" }, endpoint);
scenario = { status: 200, body: { id: "late" }, delayMs: 250 };
const original = AbortSignal.timeout;
AbortSignal.timeout = () => original.call(AbortSignal, 40);
try {
  const timedOut = await impatient.sendEmail({ to: "a@b.c", subject: "s", body: "b" });
  assert.equal(timedOut.ok, false, "a server that does not answer in time is a FAILURE, not a silent success");
  assert.match(timedOut.outcome, /^http_failed:/, `named, not swallowed: ${timedOut.outcome}`);
} finally {
  AbortSignal.timeout = original;
}
summary.deadline = "every request carries a timeout; a slow server is a fast retryable failure";

// ============================================================
// 4. The credential is proved without sending anything.
// ============================================================
scenario = { status: 200, body: { data: [] }, delayMs: 0 };
assert.deepEqual(await provider.verifyTransport(), { ok: true });
assert.equal(received.at(-1).url, "/domains", "verification reads, it does not send");
assert.equal(received.at(-1).method, "GET");
scenario = { status: 401, body: { name: "unauthorized" }, delayMs: 0 };
const bad = await provider.verifyTransport();
assert.equal(bad.ok, false, "a refused key is a failed probe");
assert.ok(!String(bad.error).includes(API_KEY), "and the error it hands the operator carries no key");
summary.verify = "GET /domains proves the credential without putting a test message in a real inbox";

// ============================================================
// 5. Selection: HTTPS wins when both transports are configured.
// ============================================================
// Not a preference — a fact about the host. SMTP cannot deliver here at all.
const both = {
  CODIQ_RESEND_API_KEY: API_KEY,
  CODIQ_SMTP_HOST: "smtp.gmail.com",
  CODIQ_SMTP_FROM: "CODIQ <x@gmail.com>",
  NODE_ENV: "production",
};
assert.ok(resolveNotificationProvider(both) instanceof HttpEmailProvider, "with both configured, the transport that works is chosen");
assert.ok(resolveNotificationProvider({ CODIQ_SMTP_HOST: "h", CODIQ_SMTP_FROM: "f" }) instanceof SmtpEmailProvider, "SMTP remains a first-class transport for a host that allows the port");
assert.equal(resolveNotificationProvider({}), null, "and no configuration still resolves NOTHING — the outbox marks rows skipped rather than pretending");
summary.selection = "https > smtp > none";

// ============================================================
// 6. The sender address falls back, so switching transports is one variable.
// ============================================================
// Production already holds a correct `CODIQ_SMTP_FROM`; making the operator
// re-type it under a new name would be a step that exists only to be forgotten.
assert.equal(
  httpMailSettingsFromEnv({ CODIQ_RESEND_API_KEY: API_KEY, CODIQ_SMTP_FROM: "CODIQ <a@b.c>" })?.from,
  "CODIQ <a@b.c>",
  "CODIQ_SMTP_FROM serves as the sender when CODIQ_MAIL_FROM is absent",
);
assert.equal(
  httpMailSettingsFromEnv({ CODIQ_RESEND_API_KEY: API_KEY, CODIQ_MAIL_FROM: "CODIQ <new@b.c>", CODIQ_SMTP_FROM: "CODIQ <old@b.c>" })?.from,
  "CODIQ <new@b.c>",
  "…and the transport-neutral name wins when both are present",
);
assert.equal(httpMailSettingsFromEnv({ CODIQ_RESEND_API_KEY: API_KEY }), null, "a key with no sender is INCOMPLETE, not a provider");
assert.ok(isEmailProviderConfigured(both), "and /ready reports the platform as configured through either transport");
summary.senderFallback = "CODIQ_MAIL_FROM, else CODIQ_SMTP_FROM; a key alone is not a provider";

server.close();
console.log(JSON.stringify({ suite: "http-mail", status: "passed", summary }, null, 2));
