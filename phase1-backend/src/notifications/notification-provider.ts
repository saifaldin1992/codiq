/**
 * codiq phase 15 — notification provider abstraction (ADR-004).
 * One real provider ships in this phase: platform-level SMTP email, configured
 * exclusively through server environment variables. The Iraqi SMS channel stays
 * an explicit stub until an SMS provider is contracted (integrations phase).
 * Provider secrets never reach API responses, client code, or the outbox log.
 */
import dns from "node:dns/promises";
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { demoModeFromEnv } from "../config.js";

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  /**
   * ق-184 — where a reply goes. Optional because it is NOT the same answer for
   * every recipient; the outbox worker decides per row. See `supportReplyTo`.
   */
  replyTo?: string;
}

export interface SmsMessage {
  to: string;
  body: string;
}

export interface ProviderResult {
  ok: boolean;
  /** Short, secret-free summary stored in notification_outbox.last_outcome. */
  outcome: string;
}

export interface NotificationProvider {
  readonly name: string;
  sendEmail(message: EmailMessage): Promise<ProviderResult>;
  sendSms(message: SmsMessage): Promise<ProviderResult>;
}

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export function smtpSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpSettings | null {
  const host = env.CODIQ_SMTP_HOST?.trim();
  const from = env.CODIQ_SMTP_FROM?.trim();
  if (!host || !from) return null;
  return {
    host,
    port: Number(env.CODIQ_SMTP_PORT ?? 587),
    secure: env.CODIQ_SMTP_SECURE === "true",
    user: env.CODIQ_SMTP_USER || undefined,
    pass: env.CODIQ_SMTP_PASS || undefined,
    from,
  };
}

/**
 * ق-154 — the HTTPS mail channel, and why it had to exist.
 *
 * `pnpm mail:probe` on production answered `ETIMEDOUT` on the IPv4 address of
 * smtp.gmail.com:465 — a timeout, not a refusal, which is the signature of a
 * port nothing is listening on the other side of. Railway's own documentation
 * says it plainly: **"SMTP is only available on the Pro plan and above"**, and
 * outbound SMTP is disabled on Free, Trial and Hobby. So the platform's mail
 * was not misconfigured and the Gmail app password was never wrong — the
 * transport is BLOCKED AT THE HOST, and no amount of correct SMTP settings can
 * cross it.
 *
 * HTTPS is not blocked, so the fix is a provider that speaks it. That is also
 * where this was always going: `PRE_LAUNCH_CHECKLIST.md` already required
 * moving off Gmail once the domain existed — Gmail caps at roughly 500
 * recipients a day and mail from an `@gmail.com` sender is filtered far harder
 * than mail from a verified domain. The domain arrived today.
 *
 * SMTP IS KEPT, not replaced: a host that allows the port stays a valid
 * deployment, and the local development story does not change. The selection is
 * by CONFIGURATION, not by environment sniffing — whichever key is present wins,
 * and HTTPS wins when both are, because it is the one that works everywhere.
 */
export interface HttpMailSettings {
  apiKey: string;
  from: string;
}

export function httpMailSettingsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): HttpMailSettings | null {
  const apiKey = env.CODIQ_RESEND_API_KEY?.trim();
  // `CODIQ_MAIL_FROM` is the transport-neutral name. It falls back to the SMTP
  // one so that switching transports does not require re-typing an address that
  // is already correct in production.
  const from = env.CODIQ_MAIL_FROM?.trim() || env.CODIQ_SMTP_FROM?.trim();
  if (!apiKey || !from) return null;
  return { apiKey, from };
}

/**
 * ق-184 — the address a human can reply to, and the audience that gets it.
 *
 * Every message this platform sent went out from `no-reply@` with NO reply
 * path at all. For a shopper's order confirmation that is defensible — his
 * question is «متى يوصل طلبي؟» and it belongs to the shop, not to us. For the
 * merchant it is not: the trial-expiry notice, the digest and above all the
 * password-recovery mail are the moments a locked-out merchant answers, and a
 * bounce there is a merchant lost at exactly the wrong minute.
 *
 * So the reply path is set by AUDIENCE, not globally — `merchant` and
 * `account` carry it, `customer` does not. Routing shoppers here would make
 * the platform the support desk for every store on it, which does not scale
 * past the first dozen merchants and is the merchant's job besides. The store's
 * own contact address is P27-2's; when it lands, the `customer` branch gets it
 * and this function keeps answering only for the platform's own mail.
 *
 * Unset is a valid deployment: no variable, no header, and the mail still
 * sends. It is a missing courtesy, never a missing delivery.
 */
export function supportReplyToFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.CODIQ_SUPPORT_EMAIL?.trim() || null;
}

/** Recipient kinds whose mail comes from the PLATFORM and deserves a reply path. */
const PLATFORM_AUDIENCE = new Set(["merchant", "account"]);

export function supportReplyTo(
  recipientKind: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (!PLATFORM_AUDIENCE.has(recipientKind)) return undefined;
  return supportReplyToFromEnv(env) ?? undefined;
}

export function isEmailProviderConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  // P27-7: the demo reports the truth to the merchant UI — no provider, no sends.
  if (demoModeFromEnv(env)) return false;
  return httpMailSettingsFromEnv(env) !== null || smtpSettingsFromEnv(env) !== null;
}

/**
 * The HTTPS transport (Resend). One POST per message, no connection to keep.
 *
 * EVERY REQUEST CARRIES A DEADLINE. The reason is not theoretical: the SMTP
 * attempt that exposed this whole problem sat in `processing` for two full
 * minutes holding an outbox row, because a blocked port does not refuse — it
 * hangs. `AbortSignal.timeout` turns that into a fast, retryable failure with a
 * name, which is what the outbox ladder is built to handle.
 *
 * The API key never reaches an outcome string. Resend's error bodies do not
 * contain it, but the outcome is written to `notification_outbox.last_outcome`
 * and read by merchants' support requests, so only the status code and the
 * provider's short error NAME are recorded — never a body, never a header.
 */
export class HttpEmailProvider implements NotificationProvider {
  readonly name = "resend-email";
  private readonly settings: HttpMailSettings;
  private readonly endpoint: string;

  constructor(settings: HttpMailSettings, endpoint = "https://api.resend.com") {
    this.settings = settings;
    this.endpoint = endpoint;
  }

  async sendEmail(message: EmailMessage): Promise<ProviderResult> {
    try {
      const response = await fetch(`${this.endpoint}/emails`, {
        method: "POST",
        // ASVS V15.3.2: the provider API never redirects; following one would
        // carry the API key to wherever it pointed.
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.settings.apiKey}`,
          "content-type": "application/json",
        },
        // `reply_to` is omitted entirely when absent — Resend rejects a null.
        body: JSON.stringify({
          from: this.settings.from,
          to: [message.to],
          subject: message.subject,
          text: message.body,
          ...(message.replyTo ? { reply_to: [message.replyTo] } : {}),
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return { ok: true, outcome: "http_accepted" };
      // A 4xx is a permanent problem (bad key, unverified sender) and a 5xx is
      // transient; both are named the same way here because the outbox ladder
      // already distinguishes them by how many times they recur.
      const name = await response
        .json()
        .then((body: unknown) => {
          const named = body as { name?: unknown };
          return typeof named?.name === "string" ? named.name : "error";
        })
        .catch(() => "unreadable_body");
      return { ok: false, outcome: `http_failed:${response.status}:${name}` };
    } catch (error) {
      const code = error instanceof Error ? error.name : "HTTP_ERROR";
      return { ok: false, outcome: `http_failed:${code}` };
    }
  }

  /**
   * Proves the credential without sending: Resend answers `GET /domains` for a
   * valid key and 401 for an invalid one. The same shape as the SMTP probe's
   * `verifyTransport`, so `mail:probe` treats both transports identically.
   */
  async verifyTransport(): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
      const response = await fetch(`${this.endpoint}/domains`, {
        redirect: "error",
        headers: { authorization: `Bearer ${this.settings.apiKey}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return { ok: true };
      return {
        ok: false,
        error: new Error(
          `HTTP ${response.status} from ${this.endpoint}/domains — the API key was refused or the account is not usable.`
        ),
      };
    } catch (error) {
      return { ok: false, error };
    }
  }

  async sendSms(): Promise<ProviderResult> {
    return { ok: false, outcome: "sms_not_configured" };
  }
}

/** Injectable so the address selection can be tested without touching DNS. */
export type AddressLookup = (host: string, family: number) => Promise<string>;

const systemLookup: AddressLookup = async (host, family) =>
  (await dns.lookup(host, { family })).address;

export class SmtpEmailProvider implements NotificationProvider {
  readonly name = "smtp-email";
  private readonly settings: SmtpSettings;
  private readonly lookup: AddressLookup;
  private readonly from: string;

  constructor(settings: SmtpSettings, lookup: AddressLookup = systemLookup) {
    this.from = settings.from;
    this.settings = settings;
    this.lookup = lookup;
  }

  /**
   * ق-153 — the mail channel was a COIN FLIP, and this is the line that stopped it.
   *
   * The probe on production answered, verbatim:
   *
   *   ESOCKET: connect ENETUNREACH 2a00:1450:4025:401::6d:465 - Local (:::0)
   *
   * An IPv6 address for smtp.gmail.com, on a container with no IPv6 route —
   * Railway reports `"ipv6EgressEnabled": false` on this service. But the
   * interesting part is not that it failed; it is HOW OFTEN. Read nodemailer's
   * own resolver (`lib/shared/index.js`): it resolves BOTH families, concatenates
   * them, and then
   *
   *   const host = addresses[Math.floor(Math.random() * addresses.length)];
   *
   * picks one AT RANDOM. `smtp.gmail.com` publishes exactly one A record and one
   * AAAA record — measured, not assumed — so every send was a fifty-fifty bet on
   * a network the container cannot reach. That is worse than a channel that never
   * works: it looks like flakiness, it cannot be reproduced on demand, and the
   * half that succeeds is read as proof that the configuration is fine.
   *
   * THE FIRST FIX WAS A PLACEBO, and it is worth recording. `family: 4` on the
   * transport does nothing: `resolveHostname` never reads it — nodemailer only
   * hands `family` to `net.connect`, long after it has already chosen the
   * address. A test asserting that option would have guarded a comfort.
   *
   * What actually works is giving nodemailer a literal address: its resolver
   * short-circuits on `net.isIP(options.host)` and uses what it was handed. The
   * hostname then has to be restored for TLS — `tls.servername` — or the
   * certificate is validated against a number and every connection fails to
   * verify. Both halves are required; either alone is broken.
   *
   * WHY THIS FIX IS NARROW, and must stay narrow. Everything else this container
   * dials — S3, Neon — goes through `net.connect` and therefore through Node's
   * Happy Eyeballs (`autoSelectFamily`, on by default since Node 20), which
   * tries the other family within milliseconds when the first refuses. The
   * measured proof sits in the same database: a product image was uploaded to S3
   * from this container at 18:38 on the day this was found. nodemailer is the
   * exception because it resolves the name ITSELF and hands `connect` a literal,
   * so Happy Eyeballs never gets a name to be clever about. Do not copy this
   * address-pinning into the S3 client or the database URL: there it would
   * REMOVE a working fallback.
   *
   * A fresh transporter per operation, deliberately: nothing is pooled here, and
   * resolving each time is what keeps a long-lived worker from holding an address
   * Gmail has since rotated away.
   *
   * `CODIQ_SMTP_FAMILY=6` for an IPv6-only host; `0` leaves the choice to
   * nodemailer, which is exactly today's coin flip and is offered only as an
   * escape hatch. And a lookup that FAILS falls back to the hostname — a DNS
   * hiccup must not be the thing that makes password recovery impossible.
   */
  private async transport(): Promise<Transporter> {
    const family = Number(process.env.CODIQ_SMTP_FAMILY ?? 4);
    const auth = this.settings.user
      ? { auth: { user: this.settings.user, pass: this.settings.pass ?? "" } }
      : {};
    const base = { port: this.settings.port, secure: this.settings.secure, ...auth };
    if (family !== 4 && family !== 6) {
      return nodemailer.createTransport({ host: this.settings.host, ...base });
    }
    try {
      const address = await this.lookup(this.settings.host, family);
      return nodemailer.createTransport({
        host: address,
        tls: { servername: this.settings.host },
        ...base,
      });
    } catch {
      return nodemailer.createTransport({ host: this.settings.host, ...base });
    }
  }

  async sendEmail(message: EmailMessage): Promise<ProviderResult> {
    try {
      const transporter = await this.transport();
      await transporter.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.body,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      });
      return { ok: true, outcome: "smtp_accepted" };
    } catch (error) {
      const code =
        error instanceof Error && "code" in error
          ? String((error as { code?: unknown }).code)
          : "SMTP_ERROR";
      return { ok: false, outcome: `smtp_failed:${code}` };
    }
  }

  /**
   * Opens the connection, negotiates TLS and authenticates — WITHOUT sending.
   *
   * The worker's boot line («started (provider: smtp-email)») proves only that
   * the variables were READ. It says nothing about whether the host answers or
   * the credential is accepted, and on 2026-09-05 the outbox showed why that
   * gap matters: zero rows had ever been sent from either environment, so a
   * configuration nobody had exercised was being treated as a working channel.
   * Password recovery is the surface that would have discovered it — at launch,
   * for a merchant locked out of his own shop.
   *
   * The error is RETURNED rather than folded into a `ProviderResult`, because
   * the operator needs the SMTP server's own sentence («535 …») and that
   * sentence can contain the account name — which is exactly why it must reach
   * a terminal and never `notification_outbox.last_outcome`.
   */
  async verifyTransport(): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
      await (await this.transport()).verify();
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  async sendSms(): Promise<ProviderResult> {
    return { ok: false, outcome: "sms_not_configured" };
  }
}

/**
 * Resolves the platform provider from the environment. Returns null when no
 * provider is configured; the worker then marks rows as skipped instead of
 * pretending a delivery happened.
 */
export function resolveNotificationProvider(
  env: NodeJS.ProcessEnv = process.env
): NotificationProvider | null {
  // P27-7: the demo environment must never emit a real message to a real inbox,
  // whatever SMTP variables happen to be present. Returning null reuses the
  // existing "no provider ⇒ mark the row skipped" branch in the outbox worker —
  // no second delivery path to keep honest.
  if (demoModeFromEnv(env)) return null;
  // ق-154: HTTPS first when it is configured. Not a preference — a fact about
  // where this runs: Railway disables outbound SMTP below the Pro plan, so on
  // this host the SMTP provider cannot deliver at all however correct its
  // settings are. A deployment that configures both is telling us it has an API
  // key, and the API key is the transport that works.
  const http = httpMailSettingsFromEnv(env);
  if (http) return new HttpEmailProvider(http);
  const smtp = smtpSettingsFromEnv(env);
  if (smtp) return new SmtpEmailProvider(smtp);
  return null;
}
