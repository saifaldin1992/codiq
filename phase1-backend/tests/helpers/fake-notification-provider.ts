import type { EmailMessage, NotificationProvider, ProviderResult, SmsMessage } from "../../src/notifications/notification-provider.js";

/** Deterministic in-memory provider for worker tests: records sends, fails on demand. */
export class FakeNotificationProvider implements NotificationProvider {
  readonly name = "fake";
  readonly sent: Array<{ channel: "email" | "sms"; to: string; subject?: string; body: string; replyTo?: string }> = [];
  failNext = 0;
  failAlways = false;
  delayMs = 0;

  private async maybeFail(): Promise<ProviderResult | null> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.failAlways || this.failNext > 0) {
      if (this.failNext > 0) this.failNext -= 1;
      return { ok: false, outcome: "fake_failure" };
    }
    return null;
  }

  async sendEmail(message: EmailMessage): Promise<ProviderResult> {
    const failure = await this.maybeFail();
    if (failure) return failure;
    this.sent.push({ channel: "email", to: message.to, subject: message.subject, body: message.body, replyTo: message.replyTo });
    return { ok: true, outcome: "fake_sent" };
  }

  async sendSms(message: SmsMessage): Promise<ProviderResult> {
    const failure = await this.maybeFail();
    if (failure) return failure;
    this.sent.push({ channel: "sms", to: message.to, body: message.body });
    return { ok: true, outcome: "fake_sent" };
  }
}
