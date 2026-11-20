/**
 * What this deployment is actually configured to do — answered before a merchant
 * discovers it.
 *
 * WHY THIS EXISTS. `config.ts` validates exactly two things at boot: the
 * database URL and `SESSION_JWT_SECRET`. Everything else is read at the point of
 * use, so a half-configured deployment starts clean and green and fails hours
 * later, on a merchant's action, in a code path nobody was watching. Two live
 * examples found on 2026-09-05, both in PRODUCTION:
 *
 *   · `CODIQ_PUBLIC_BASE_URL` is unset. `publicUrl()` therefore returns null,
 *     `resetLinkFor()` returns null, and password recovery answers
 *     `delivery: "unavailable"` for every merchant, owner and staff member. The
 *     service is honest — it refuses to mail a dead letter — but the feature
 *     that shipped in #119 does not work, and nothing said so.
 *   · The SMTP variables were all present and the outbox had never sent a single
 *     message, in either environment.
 *
 * THE DISTINCTION THAT DOES THE WORK — `absent` versus `incomplete`.
 *
 *   `absent`     — nothing in the group is set. Often legitimate: no SMTP means
 *                  notifications are marked `skipped`, which is a stated design.
 *   `incomplete` — SOME of the group is set and some is not. This is never
 *                  intentional. It is a half-finished edit in a dashboard, and
 *                  it is the exact shape that boots clean and fails at use.
 *
 * So `incomplete` is ALWAYS an error, while `absent` is an error only for the
 * groups a live deployment cannot do without.
 *
 * It reports names and booleans — NEVER a value, and never a host. `/ready` is
 * unauthenticated, and the existing `mail: { configured }` field set that rule.
 */

export type GroupVerdict = "ok" | "incomplete" | "absent";

/**
 * ق-231 — a group may be PRESENT and still not configured.
 *
 * The only reader today is the session key's length, and the shape is kept
 * deliberately narrow: a predicate that returns null when all is well, or the
 * variables to name and the sentence an operator can act on. It never turns an
 * absent group into a present one — it only downgrades an `ok`.
 */
export const SESSION_SECRET_MIN_BYTES = 32;

export interface EnvironmentGroup {
  /** Stable key, used by `/ready` and by the preflight's exit code. */
  key: string;
  /** What stops working when this group is not satisfied. Written for an operator, in Arabic. */
  consequence: string;
  /** Every variable that must be present for the group to be `ok`. */
  required: string[];
  /** ق-231: present, but not adequate — see the constant above. */
  weakWhen?: (environment: NodeJS.ProcessEnv) => { names: string[]; consequence: string } | null;
  /**
   * ق-154 — ALTERNATIVE ways to satisfy the same group, for a capability that
   * has more than one transport. Any ONE complete set makes the group `ok`.
   *
   * `mail` is the first: a deployment reaches inboxes through an HTTPS API OR
   * through SMTP, and demanding both would report a correctly configured
   * platform as broken. The sets are listed most-preferred first, and `missing`
   * reports the set that is CLOSEST to complete — telling an operator to finish
   * what he started rather than naming a transport he did not choose.
   */
  satisfiedBy?: string[][];
  /** Present-but-not-required members: they count toward "something is set" but never toward "incomplete". */
  optional?: string[];
  /**
   * True when a deployed environment (anything but `development`) cannot do its
   * job without this group. `absent` then fails the preflight instead of merely
   * being reported.
   */
  requiredInDeployment: boolean;
}

/**
 * The groups, in the order an operator should read them: the ones that stop the
 * platform first, then the ones that disable a feature.
 */
export const ENVIRONMENT_GROUPS: EnvironmentGroup[] = [
  {
    key: "database",
    consequence: "لا شيء يعمل — الخادم لا يقلع أصلاً.",
    required: ["DATABASE_URL"],
    optional: ["CODIQ_POSTGRES_URL", "CODIQ_POSTGRES_URL_UNPOOLED"],
    requiredInDeployment: true,
  },
  {
    key: "session",
    consequence: "لا أحد يستطيع تسجيل الدخول — الخادم لا يقلع أصلاً.",
    required: ["SESSION_JWT_SECRET"],
    optional: ["SESSION_JWT_SECRET_PREVIOUS"],
    requiredInDeployment: true,
    // ق-231: D-62 required the secret to EXIST and said nothing about its
    // length. A short key that signs five identities' sessions is not a
    // configured platform, so the preflight says so in the word it already has.
    weakWhen: (environment) => {
      const value = environment.SESSION_JWT_SECRET ?? "";
      const bytes = Buffer.byteLength(value, "utf8");
      if (!value || bytes >= SESSION_SECRET_MIN_BYTES) return null;
      return {
        names: ["SESSION_JWT_SECRET"],
        consequence: `مفتاح توقيع الجلسات ${bytes} بايت — والحدّ ${SESSION_SECRET_MIN_BYTES} (ASVS 2.10). مفتاحٌ قصير يُكسَر خارج الخادم من رمزٍ واحد ملتقَط، ومن كسره يسكّ جلسةً لأيّ تاجر أو مالك أو زبون. دوّره مع SESSION_JWT_SECRET_PREVIOUS كي لا يخرج أحد: openssl rand -base64 48`,
      };
    },
  },
  {
    key: "encryption",
    // D-40/D-62: TOTP secrets and the provider key live under this root. Absent
    // outside development, `secret-box` falls back to a constant published in
    // this repository — which is why its absence must be loud, not merely noted.
    consequence: "أسرار المصادقة الثنائية تُشفَّر بجذرٍ منشور في المستودع — لا سرَّ فيه.",
    required: ["CODIQ_ENCRYPTION_KEY"],
    optional: ["CODIQ_ENCRYPTION_KEY_PREVIOUS"],
    requiredInDeployment: true,
  },
  {
    key: "publicBaseUrl",
    // The star finding. Two shipped features die silently without it.
    consequence: "استعادة كلمة السرّ تُجيب «غير متاحة» لكل تاجر ومالك وموظّف، وروابط إلغاء الاشتراك تختفي — بلا خطأ واحد في السجلّ.",
    required: ["CODIQ_PUBLIC_BASE_URL"],
    requiredInDeployment: true,
  },
  {
    key: "mail",
    consequence: "كل رسالة تُوسَم `skipped`: لا تأكيد طلب، ولا استعادة كلمة سرّ، ولا إشعار.",
    // ق-154: TWO transports, and either one satisfies this group.
    //
    // The HTTPS set is listed first because it is the one that works on this
    // host: Railway disables outbound SMTP below the Pro plan, and the probe on
    // production proved it — `ETIMEDOUT` on the IPv4 address of
    // smtp.gmail.com:465, a timeout rather than a refusal, which is what a
    // blocked port looks like from the inside.
    //
    // SMTP stays a first-class option because a host that allows the port is a
    // perfectly good deployment, and because local development uses it.
    // Three sets, not two, and the second is the reason this list is written
    // out rather than computed: `httpMailSettingsFromEnv` accepts
    // `CODIQ_SMTP_FROM` as the sender when `CODIQ_MAIL_FROM` is absent, so a
    // deployment that adds only an API key to an existing SMTP configuration is
    // COMPLETE. A report that demanded `CODIQ_MAIL_FROM` there would call a
    // working platform broken — the precise failure this whole file exists to
    // end.
    required: [],
    satisfiedBy: [
      ["CODIQ_RESEND_API_KEY", "CODIQ_MAIL_FROM"],
      ["CODIQ_RESEND_API_KEY", "CODIQ_SMTP_FROM"],
      ["CODIQ_SMTP_HOST", "CODIQ_SMTP_FROM"],
    ],
    // ق-184: `CODIQ_SUPPORT_EMAIL` is optional and stays optional. Unset means
    // platform mail carries no reply path — a missing courtesy, never a missing
    // delivery, so it must not be able to call a working deployment broken.
    optional: ["CODIQ_SMTP_PORT", "CODIQ_SMTP_SECURE", "CODIQ_SMTP_USER", "CODIQ_SMTP_PASS", "CODIQ_SMTP_FAMILY", "CODIQ_SUPPORT_EMAIL"],
    requiredInDeployment: true,
  },
  {
    /**
     * ق-235 — the reporter that lives outside.
     *
     * `requiredInDeployment` is FALSE, deliberately: a deployment without error
     * reporting is degraded, not broken, and making it a boot-blocker would be
     * the same mistake ق-231 refused — a fix that takes a live platform down on
     * the day it ships. But it is listed, so `pnpm env:check` and `/ready` can
     * answer «is anything watching?» — which on 2026-09-09 nothing could, and
     * the outage ran for two days.
     */
    key: "observability",
    consequence: "لا شيء يُبلّغ عن أعطال الخادم من خارجه — انقطاعٌ كالذي جرى في 2026-09-09 يمرّ صامتاً حتى يشتكي تاجر.",
    required: ["SENTRY_DSN"],
    requiredInDeployment: false,
  },
  {
    key: "storage",
    consequence: "رفع صور المنتجات يفشل عند أول محاولة — والتاجر يكتشفها لا الخادم.",
    required: ["PRODUCT_S3_BUCKET", "PRODUCT_S3_REGION", "PRODUCT_S3_ACCESS_KEY_ID", "PRODUCT_S3_SECRET_ACCESS_KEY"],
    optional: ["PRODUCT_S3_ENDPOINT", "PRODUCT_S3_FORCE_PATH_STYLE"],
    requiredInDeployment: true,
  },
  /**
   * ق-241 — «أين تسكن النسخ الاحتياطية؟» سؤالٌ يجب أن يُجاب من `/ready` لا من
   * قراءة ملفٍّ في المستودع.
   *
   * `absent` هنا **ليست عطلاً**: النسخ تعمل، لكنّها تسكن حاوية صور المنتجات
   * نفسها (فجوة `DISASTER_RECOVERY.md` رقم ٢)، فحسابُ تخزينٍ واحدٌ يضيع يأخذ
   * التفريغ والصور معاً. ولذلك `requiredInDeployment: false` — البند توصيةٌ
   * يملك المالك وحده تنفيذها (حساب تخزينٍ ثانٍ بمفاتيحه)، ولا يصحّ أن يحوّل
   * منصّةً تعمل إلى بوّابةٍ حمراء.
   *
   * أمّا `incomplete` — أي بعضُ المتغيّرات دون بعض — **فعطلٌ حقيقيّ ويجب أن
   * يُسقِط الفحص**: `resolveBackupStorage` يرفض التشغيل عندها ولا يعود إلى
   * حاوية الصور بصمت، لأنّ الاعتقاد بأنّ النسخ معزولةٌ وهي ليست كذلك أسوأ من
   * معرفة أنّها مشتركة.
   */
  {
    key: "backupIsolation",
    consequence: "النسخ الاحتياطية تسكن حاوية صور المنتجات نفسها — فقدانُ حساب التخزين يأخذ النسختين معاً. نسخةٌ تموت مع ما تحميه ليست نسخة.",
    required: [
      "CODIQ_BACKUP_S3_ENDPOINT",
      "CODIQ_BACKUP_S3_BUCKET",
      "CODIQ_BACKUP_S3_ACCESS_KEY_ID",
      "CODIQ_BACKUP_S3_SECRET_ACCESS_KEY",
    ],
    optional: ["CODIQ_BACKUP_S3_REGION", "CODIQ_BACKUP_S3_FORCE_PATH_STYLE"],
    requiredInDeployment: false,
  },
];

export interface GroupReport {
  key: string;
  verdict: GroupVerdict;
  /** Required names that are absent. Names only — never values. */
  missing: string[];
  consequence: string;
}

export interface EnvironmentReport {
  environment: string;
  deployed: boolean;
  ok: boolean;
  groups: GroupReport[];
}

function present(environment: NodeJS.ProcessEnv, name: string): boolean {
  return (environment[name] ?? "").trim().length > 0;
}

export function reportEnvironment(environment: NodeJS.ProcessEnv = process.env): EnvironmentReport {
  const nodeEnv = environment.NODE_ENV ?? "unknown";
  // `development` is the ONLY environment allowed to run half-configured — it is
  // where a developer works on one feature without standing up the other five.
  const deployed = nodeEnv !== "development";
  const groups = ENVIRONMENT_GROUPS.map<GroupReport>((group) => {
    // A group with alternatives is satisfied by ANY complete set; the one
    // reported as `missing` is whichever set is closest to done, so the advice
    // names the transport the operator actually started configuring.
    const sets = group.satisfiedBy ?? [group.required];
    const shortfalls = sets.map((set) => set.filter((name) => !present(environment, name)));
    const missing = [...shortfalls].sort((a, b) => a.length - b.length)[0] ?? [];
    const anySet = [...sets.flat(), ...(group.optional ?? [])].some((name) => present(environment, name));
    let verdict: GroupVerdict = missing.length === 0 ? "ok" : anySet ? "incomplete" : "absent";
    let consequence = group.consequence;
    let reported = missing;
    /**
     * ق-231 — present is not the same as adequate.
     *
     * D-62 closed half of this: the secret must exist. Nothing said how LONG,
     * so an eight-character value passed every check on the platform — and an
     * eight-character HMAC key is brute-forceable offline from one captured
     * token, which yields the power to MINT a session for any merchant, any
     * platform owner, any shopper. ASVS 2.10 puts the floor at 32 bytes.
     *
     * Reported as `incomplete` rather than as a new verdict, because that word
     * already means exactly this: «half-configured, and never on purpose». It
     * therefore fails `pnpm env:check` in EVERY environment and shows on
     * `/ready` — while the server itself only warns (config.ts), so that the fix
     * cannot take a live platform down on the day it ships.
     */
    const weak = group.weakWhen?.(environment);
    if (verdict === "ok" && weak) {
      verdict = "incomplete";
      reported = weak.names;
      consequence = weak.consequence;
    }
    return { key: group.key, verdict, missing: reported, consequence };
  });
  const ok = groups.every((group, index) => {
    if (group.verdict === "ok") return true;
    // Half-configured is never intentional, in any environment.
    if (group.verdict === "incomplete") return false;
    return !(deployed && ENVIRONMENT_GROUPS[index]!.requiredInDeployment);
  });
  return { environment: nodeEnv, deployed, ok, groups };
}

/** The compact form for `/ready`: one boolean per group, no names, no values. */
export function readinessSummary(environment: NodeJS.ProcessEnv = process.env): { ok: boolean; groups: Record<string, GroupVerdict> } {
  const report = reportEnvironment(environment);
  const groups: Record<string, GroupVerdict> = {};
  for (const group of report.groups) groups[group.key] = group.verdict;
  return { ok: report.ok, groups };
}
