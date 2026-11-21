/**
 * codiq PR-1 (19-أ) «استعادة كلمة السر» browser acceptance — the whole recovery
 * driven in real Chromium, with the DATABASE checked after each screen.
 *
 *   the merchant meets «هل نسيت كلمة السر؟» on his own sign-in page → asks for a
 *   link and is answered with a CONDITIONAL sentence, never «we found you» →
 *   a stranger's address gets the IDENTICAL screen, word for word → the link is
 *   read out of the mail the worker actually SENT (nothing is minted by this
 *   test) → the reset page opens, refuses a mismatched confirmation, then takes
 *   a new password → he is NOT signed in: he is handed the door and signs in
 *   there with the new password → the same link opened a second time shows the
 *   dead-link screen, in the browser, where a person would meet it.
 *
 * WHY A BROWSER IS REQUIRED FOR THIS AND NOT ONLY THE INTEGRATION SUITE. Three
 * of the promises here are UI contracts and cannot be asserted from an HTTP
 * client: that the two answers are the same TEXT on screen (the server returning
 * an identical body means nothing if the page then renders «هذا البريد غير
 * مسجّل»), that the link in the mail actually resolves to a working page in a
 * browser that has no session, and that the success screen offers the sign-in
 * door rather than pretending he is already inside.
 *
 * Harness mirrors ps1.browser-acceptance.mjs: built server from dist, TRUNCATE
 * fixture reset, screenshots into the artifacts dir.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { chromium } from "playwright";

const runId = `pr1-ui-${Date.now().toString(36)}`;
const port = 3241;
const base = `http://127.0.0.1:${port}`;
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
process.env.SESSION_JWT_SECRET = "pr1-browser-seed-secret-not-for-production";
// Sealed by the SERVER when it queues the mail, opened by THIS process when it
// drains the outbox — so both must derive from the same root, exactly as the API
// and the standalone worker do in production.
process.env.CODIQ_ENCRYPTION_KEY = "pr1-browser-encryption-root-not-a-secret-0123456789";
// The public base is this very server, so the link in the mail is one a browser
// can actually open — which is the thing being tested.
process.env.CODIQ_PUBLIC_BASE_URL = base;

const { prisma } = await import("../src/db/prisma.ts");
const { processOutboxBatch } = await import("../src/notifications/outbox-worker.ts");
const { FakeNotificationProvider } = await import("./helpers/fake-notification-provider.ts");

const web = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    DATABASE_URL: dbUrl,
    SESSION_JWT_SECRET: "pr1-browser-seed-secret-not-for-production",
    // A host and a from address are all `smtpSettingsFromEnv` needs to report
    // the channel as configured. Nothing is ever handed to a real SMTP server:
    // the worker process is OFF and this suite drains the outbox itself with a
    // fake provider.
    CODIQ_SMTP_HOST: "smtp.invalid.test",
    CODIQ_SMTP_FROM: "codiq.iraq@example.test",
    CODIQ_PUBLIC_BASE_URL: base,
    CODIQ_NOTIFICATIONS_WORKER: "off",
  },
  stdio: "ignore",
});

const artifactsDir = process.env.CODIQ_TEST_ARTIFACTS_DIR ?? "/home/ubuntu/webdev-static-assets";
fs.mkdirSync(artifactsDir, { recursive: true });
const executablePath =
  process.env.CODIQ_CHROMIUM_PATH ??
  (process.platform === "linux" ? "/usr/bin/chromium" : undefined);

async function waitFor(url) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function json(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", origin: base, ...(init.headers ?? {}) },
  });
  return { response, body: await response.json().catch(() => null) };
}

const provider = new FakeNotificationProvider();

/**
 * Drains the queue and returns the link out of the message that was SENT.
 *
 * The clock is moved one worker tick forward deliberately: `next_attempt_at`
 * defaults to Postgres' NOW() while the worker compares against Node's, and a
 * millisecond of skew between the two machines would otherwise make a
 * just-created row «not due yet». The real worker polls every 5 seconds, so a
 * row is always claimed on a later tick than the one that created it.
 */
async function readMailedLink(recipient) {
  const before = provider.sent.length;
  // WAIT FOR THE ROW, DO NOT ASSUME IT. The clock note above is real but it is
  // only half the problem: the row is written by the SERVER process, and this
  // drain runs in the TEST process. The browser returns as soon as the page
  // renders its confirmation, so the two are only ordered by luck — and on a
  // loaded CI runner the drain can win. That is exactly how this failed on
  // 2026-09-05 («got 0») while passing every time locally.
  //
  // Waiting on the CONDITION rather than on a sleep is the rule the 2026-09-05
  // flake hunt settled: a timeout raise turns a fast red into a slow red, while
  // a condition wait removes the race. If the row never appears the loop still
  // ends and the assertion below reports the real count, so a genuine «no mail
  // was minted» defect fails exactly as loudly as before.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const queued = await prisma.notificationOutbox.count({
      where: { recipient, status: "pending" },
    });
    if (queued > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await processOutboxBatch(provider, { batchSize: 50, now: new Date(Date.now() + 5000) });
  const sent = provider.sent.slice(before).filter((message) => message.to === recipient);
  assert.equal(sent.length, 1, `exactly one recovery mail for ${recipient} (got ${sent.length})`);
  const link = /https?:\/\/\S+/.exec(sent[0].body)?.[0];
  assert.ok(link, `the mail must carry an absolute link:\n${sent[0].body}`);
  return link;
}

// ---------------------------------------------------------------- tripwire
// This suite provokes no 401s or 403s of its own — every screen here is
// session-less by design — so ANY console error is a real defect.
const consoleErrors = [];
function armTripwire(page, tag) {
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`[${tag}] ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    consoleErrors.push(`[${tag}] pageerror: ${error.message}`);
  });
}
function assertConsoleClean(where) {
  assert.equal(
    consoleErrors.length,
    0,
    `page console must stay clean (${where}):\n${consoleErrors.join("\n")}`
  );
}

const browser = await chromium.launch({ executablePath, headless: true });
try {
  await waitFor(`${base}/api/health`);
  await prisma.$executeRawUnsafe(
    "TRUNCATE TABLE storefront_rate_limits, password_reset_tokens, notification_outbox, customer_sessions, customers, merchant_sessions, stores, merchants, platform_owner_sessions, platform_owners CASCADE"
  );

  // ------------------------------------------------------------- fixtures
  const merchantEmail = `${runId}.merchant@codiq.test`;
  const oldPassword = "Pr1UiOldPass2026!";
  const newPassword = "Pr1UiFreshPass2026!";
  const registered = await registerMerchantDirect({
    email: merchantEmail,
    password: oldPassword,
    businessName: "متجر الاستعادة",
    ownerName: "سيف الدين",
    phone: `+9647${String(Date.now()).slice(-9)}`,
  });
  assert.equal(registered.response.status, 201, JSON.stringify(registered.body));
  await prisma.store.create({
    data: {
      merchantId: registered.body.account.id,
      name: "متجر الاستعادة",
      slug: `${runId}-store`,
      defaultSubdomain: `${runId}-store`,
    },
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(30000);
  armTripwire(page, "merchant");

  // ==========================================================================
  // 1. THE LINK EXISTS ON THE SIGN-IN PAGE.
  //
  //    It was deliberately withheld until today — the file said so in a comment
  //    — because a dead «هل نسيت كلمة السر؟» is the invented promise ق-10
  //    forbids. Asserting it is present is asserting the feature is REACHABLE
  //    by the person who needs it, which is the half a service test cannot see.
  // ==========================================================================
  await page.goto(`${base}/merchant/login`);
  await page.getByTestId("login-forgot-password").waitFor();
  await page.screenshot({ path: `${artifactsDir}/pr1-login-with-link.png`, fullPage: true });
  await page.getByTestId("login-forgot-password").click();
  await page.waitForURL("**/forgot-password?kind=merchant");
  assertConsoleClean("the merchant reached the recovery page from his own door");

  // ==========================================================================
  // 2. THE ANSWER IS A CONDITIONAL, AND IT IS THE SAME FOR A STRANGER.
  //
  //    The server already answers identically; this is the half that could
  //    still leak. A page that rendered «لم نجد هذا البريد» would hand an
  //    account list to anyone with a browser, whatever the API did.
  // ==========================================================================
  await page.getByTestId("reset-request-email").fill(merchantEmail);
  await page.getByTestId("reset-request-submit").click();
  await page.getByTestId("reset-request-queued").waitFor();
  const knownText = (await page.getByTestId("reset-request-queued").innerText()).trim();
  assert.match(
    knownText,
    /إن كان هذا البريد/,
    `the promise must be conditional, not a confirmation: ${knownText}`
  );
  await page.screenshot({ path: `${artifactsDir}/pr1-request-known.png`, fullPage: true });

  const mailedLink = await readMailedLink(merchantEmail);

  await page.goto(`${base}/forgot-password?kind=merchant`);
  await page.getByTestId("reset-request-email").fill(`${runId}.nobody@codiq.test`);
  await page.getByTestId("reset-request-submit").click();
  await page.getByTestId("reset-request-queued").waitFor();
  const unknownText = (await page.getByTestId("reset-request-queued").innerText()).trim();
  assert.equal(
    unknownText,
    knownText,
    "PR-1: an address nobody registered must produce the SAME words on screen"
  );
  await page.screenshot({ path: `${artifactsDir}/pr1-request-unknown.png`, fullPage: true });

  // …and nothing was minted for it. The screen says the same thing; the
  // database must not disagree with the screen.
  const strays = await prisma.passwordResetToken.count({
    where: { emailNormalized: `${runId}.nobody@codiq.test` },
  });
  assert.equal(strays, 0, "PR-1: the identical screen is backed by an identical absence of rows");
  assertConsoleClean("both requests answered identically");

  // ==========================================================================
  // 3. THE LINK OPENS A WORKING PAGE IN A BROWSER WITH NO SESSION.
  // ==========================================================================
  assert.ok(mailedLink.startsWith(base), `the mailed link must be openable: ${mailedLink}`);
  await page.goto(mailedLink);
  await page.getByTestId("reset-consume-submit").waitFor();
  await page.screenshot({ path: `${artifactsDir}/pr1-reset-form.png`, fullPage: true });

  // ق-28: no horizontal overflow on a phone. A recovery screen is reached from
  // a mail app on a phone more often than from a desk.
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  assert.ok(
    overflow <= 1,
    `PR-1: the reset screen must not scroll sideways at 390px (overflow ${overflow}px)`
  );
  await page.screenshot({ path: `${artifactsDir}/pr1-reset-form-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // A mismatched confirmation is caught on the page, before the link is spent.
  await page.getByTestId("reset-consume-password").fill(newPassword);
  await page.getByTestId("reset-consume-confirm").fill("something-else-entirely");
  await page.getByTestId("reset-consume-submit").click();
  await page.getByTestId("reset-consume-error").waitFor();
  const stillLive = await prisma.passwordResetToken.findFirst({
    where: { consumedAt: null, invalidatedAt: null },
  });
  assert.ok(
    stillLive,
    "PR-1: a typo in the confirmation must not burn the link and leave him with nothing"
  );

  // ==========================================================================
  // 4. THE RESET SUCCEEDS AND DOES NOT SIGN HIM IN.
  //
  //    The whole TOTP argument rests on this: if a mail link minted a session,
  //    whoever owns the mailbox of an enrolled owner would get exactly what the
  //    second factor exists to withhold.
  // ==========================================================================
  await page.getByTestId("reset-consume-confirm").fill(newPassword);
  await page.getByTestId("reset-consume-submit").click();
  await page.getByTestId("reset-consume-done").waitFor();
  await page.screenshot({ path: `${artifactsDir}/pr1-reset-done.png`, fullPage: true });

  const cookies = await context.cookies();
  // `endsWith`, not `===`: D-63 made the name `__Host-codiq_session` wherever
  // `Secure` is set, and an equality check against the bare name would pass here
  // by matching NOTHING — an assertion of absence is the one kind that goes
  // quiet instead of failing when the name it names stops existing.
  assert.equal(
    cookies.filter((cookie) => cookie.name.endsWith("codiq_session")).length,
    0,
    "PR-1: no session cookie is issued by a reset — he is handed the door, not carried through it"
  );

  await page.getByTestId("reset-consume-login").click();
  await page.waitForURL("**/merchant/login**");
  assertConsoleClean("reset completed and handed him his own door");

  // ==========================================================================
  // 5. THE NEW PASSWORD IS THE PASSWORD — typed into the real form.
  // ==========================================================================
  await page.locator('input[name="identifier"]').fill(merchantEmail);
  await page.locator('input[name="password"]').fill(newPassword);
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await page.waitForURL("**/merchant/stores/**/dashboard**");
  await page.screenshot({ path: `${artifactsDir}/pr1-signed-in.png`, fullPage: true });
  assertConsoleClean("signed in with the recovered password");

  // ==========================================================================
  // 6. THE SAME LINK, OPENED AGAIN, IS DEAD — and says so on screen.
  //
  //    A link that works twice is a link an interceptor can use AFTER its owner
  //    has. The database already refuses it; this is the person meeting that
  //    refusal, and being told what to do about it.
  // ==========================================================================
  const secondVisit = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const secondPage = await secondVisit.newPage();
  secondPage.setDefaultTimeout(30000);
  armTripwire(secondPage, "replay");
  await secondPage.goto(mailedLink);
  await secondPage.getByTestId("reset-consume-dead").waitFor();
  assert.equal(
    await secondPage.getByTestId("reset-consume-submit").count(),
    0,
    "PR-1: a spent link offers no form at all"
  );
  await secondPage.getByTestId("reset-consume-restart").waitFor();
  await secondPage.screenshot({ path: `${artifactsDir}/pr1-link-spent.png`, fullPage: true });
  assertConsoleClean("a spent link is refused on screen");

  console.log(
    JSON.stringify(
      {
        pr1Browser: {
          linkOnLoginPage: true,
          answerIdentical: true,
          sessionIssuedByReset: false,
          spentLinkShowsDeadScreen: true,
        },
      },
      null,
      2
    )
  );
  console.log("pr1-browser OK");
} finally {
  await browser.close();
  web.kill();
  await prisma.$disconnect();
}
