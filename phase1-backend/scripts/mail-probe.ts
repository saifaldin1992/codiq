/**
 * Prove the mail channel actually delivers — not that it was configured.
 *
 * WHY. On 2026-09-05 the outbox was audited in both live environments:
 * production held **zero** rows, staging held 38 and every one of them was
 * `skipped`, newest 2026-08-25 — before SMTP existed. So at that moment the
 * platform had never sent a single email, while the worker's boot line
 * («started (provider: smtp-email)») and `/ready`'s `mail: { configured: true }`
 * both read as success. Both are true and neither is delivery: one proves the
 * variables were read, the other that they parse.
 *
 * The surface that would have found this is password recovery — at launch, for
 * a merchant locked out of his own shop, with no second channel to fall back on.
 *
 * TWO CHECKS, DELIBERATELY SEPARATE:
 *
 *   `pnpm mail:probe`
 *       Connects, negotiates TLS, authenticates — and sends NOTHING. This is
 *       the one to run on production: it proves the credential without putting
 *       a test message in anyone's inbox.
 *
 *   `pnpm mail:probe -- --to someone@example.com`
 *       …then sends one real message end to end. Only this proves delivery.
 *
 * IT WRITES NO ROW. The outbox is the record of what the PLATFORM sent to a
 * customer; an operator's probe is not that, and seeding it would corrupt the
 * one table «did the merchant get his email?» is answered from.
 *
 * Run it where the credential already lives — the Railway service — so the
 * secret is never copied anywhere to run a test.
 */
import { pathToFileURL } from "node:url";
import {
  HttpEmailProvider,
  SmtpEmailProvider,
  httpMailSettingsFromEnv,
  isEmailProviderConfigured,
  resolveNotificationProvider,
  smtpSettingsFromEnv,
} from "../src/notifications/notification-provider.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1] && !process.argv[index + 1]!.startsWith("--"))
    return process.argv[index + 1];
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : undefined;
}

/** Everything an operator needs to see, and nothing he must not. */
function describeSettings() {
  // ق-154: the probe now describes whichever transport will actually be used —
  // reporting SMTP settings while the platform sends over HTTPS would be a
  // probe that lies about the thing it exists to check.
  const http = httpMailSettingsFromEnv();
  if (http) {
    // The API key is reported as present/absent and never loaded into a string.
    return {
      transport: "https",
      provider: "resend",
      from: http.from,
      apiKey: process.env.CODIQ_RESEND_API_KEY ? "set" : "absent",
    };
  }
  const settings = smtpSettingsFromEnv();
  if (!settings) return null;
  // The password is not read here at all — not masked, not truncated. A value
  // that is never loaded cannot be logged by a later edit.
  return {
    transport: "smtp",
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    from: settings.from,
    user: settings.user ? "set" : "absent",
    pass: process.env.CODIQ_SMTP_PASS ? "set" : "absent",
  };
}

async function main() {
  const settings = httpMailSettingsFromEnv() ?? smtpSettingsFromEnv();
  if (!settings) {
    console.error(
      JSON.stringify(
        {
          probe: "mail",
          result: "not_configured",
          reason:
            "either CODIQ_RESEND_API_KEY (with a sender address) or CODIQ_SMTP_HOST and CODIQ_SMTP_FROM must be set; no provider resolves without one of them.",
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }
  // The demo environment refuses to resolve a provider on purpose (P27-7), and
  // a probe that "passed" there would be reporting on a channel that is
  // deliberately dead.
  if (!isEmailProviderConfigured()) {
    console.error(
      JSON.stringify(
        {
          probe: "mail",
          result: "provider_disabled",
          reason:
            "SMTP settings are present but no provider resolves — CODIQ_DEMO_MODE disables sending by design.",
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }

  // Resolved exactly as the outbox worker resolves it, so the probe cannot pass
  // on a transport the platform would not have chosen.
  const provider = resolveNotificationProvider();
  if (
    !provider ||
    !(provider instanceof HttpEmailProvider || provider instanceof SmtpEmailProvider)
  ) {
    console.error(
      JSON.stringify(
        {
          probe: "mail",
          result: "provider_disabled",
          reason: "no provider resolved — see CODIQ_DEMO_MODE.",
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }
  const connection = await provider.verifyTransport();
  if (!connection.ok) {
    const error = connection.error;
    console.error(
      JSON.stringify(
        {
          probe: "mail",
          result: "connect_failed",
          settings: describeSettings(),
          // The server's own sentence — «535 5.7.8 Username and Password not
          // accepted», «ETIMEDOUT», «self-signed certificate» — is the entire
          // diagnostic value here, and it goes to a terminal, never to a row.
          error:
            error instanceof Error
              ? `${(error as { code?: unknown }).code ?? "SMTP_ERROR"}: ${error.message}`
              : String(error),
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }

  const to = flag("to");
  if (!to) {
    console.log(
      JSON.stringify(
        {
          probe: "mail",
          result: "connect_ok",
          settings: describeSettings(),
          note: "الاتصال والمصادقة سليمان. لإثبات التسليم فعلاً: pnpm mail:probe -- --to <عنوان>",
        },
        null,
        2
      )
    );
    return;
  }

  const stamp = new Date().toISOString();
  const sent = await provider.sendEmail({
    to,
    subject: `CODIQ — فحص قناة البريد ${stamp}`,
    body: [
      "هذه رسالة فحص من منصة CODIQ.",
      "",
      "وصولها يعني أن قناة البريد تعمل فعلاً: الاتصال والمصادقة والتسليم.",
      `الوقت: ${stamp}`,
      `المُرسِل: ${settings.from}`,
    ].join("\n"),
  });

  console.log(
    JSON.stringify(
      {
        probe: "mail",
        result: sent.ok ? "sent" : "send_failed",
        outcome: sent.outcome,
        to,
        settings: describeSettings(),
      },
      null,
      2
    )
  );
  if (!sent.ok) process.exitCode = 1;
  else
    console.log(
      "\nافتح البريد وتأكّد من وصولها. «قُبلت من الخادم» ليست «وصلت» — قد تُحجب كرسالة مزعجة."
    );
}

// Only when this file IS the command: importing it (a test does) must not
// connect to anything.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
