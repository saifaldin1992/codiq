/**
 * codiq — the public marketing landing page. Live pricing from the public plans
 * API and real merchant self-registration (approval-mode aware); session-aware
 * pricing CTA (visitor → preselected signup, merchant → upgrade request).
 *
 * v2 redesign (owner brief 2026-09-01): Apple-grade calm — one idea per
 * viewport, oversized Rubik, vast whitespace, the product as the only imagery —
 * executed under FOUR standing rules:
 *   1. Vector only. Every graphic is inline SVG; no raster asset anywhere, and
 *      perf-budget.guard.mjs FAILS the build on any raster reference (ق-137).
 *   2. Fast open (ق-137): «/» ships only this page's code (App.tsx lazy-loads
 *      every other surface), the hero renders with no fetch in its path, and
 *      the entry gzip budget in perf-budget.json may only fall.
 *   3. No payment/checkout promises — the signed-agreements disclaimer keeps
 *      its testid, wording and full legibility inside the proof band.
 *   4. Honest content only: no invented merchant counts; the trust figures are
 *      verifiable product facts and the lowest commission is read live from
 *      /api/public/plans.
 *
 * The page is 9 blocks (was 13): nav → hero → product-story (one sticky stage,
 * three beats) → pillars ledger → proof band (trust + payments merged) → how
 * rail → pricing → signup → footer. The FAQ, the value band, the 8-card grid
 * and HeroMotif died in the redesign (Faq.tsx/HeroMotif.tsx stay in the tree
 * for cheap restoration — an EDITORIAL cut, flagged to the owner at review).
 *
 * Motion is hand-rolled on IntersectionObserver/rAF — no animation dependency
 * enters the bundle — and every effect resolves to its finished state under the
 * scoped `prefers-reduced-motion: reduce` block in index.css.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import {
  ArrowLeft,
  BadgeCheck,
  Banknote,
  Check,
  CircleAlert,
  Clock4,
  CreditCard,
  FlaskConical,
  LayoutGrid,
  LoaderCircle,
  Minus,
  Pause,
  Play,
  RotateCcw,
  Smartphone,
  TriangleAlert,
  Wallet,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInputWithMeter } from "@/components/ui/password-input-with-meter";
import { BrandMark } from "@/components/BrandMark";
import { useDemoMode } from "@/components/DemoBanner";
import { DeviceShowcase } from "@/components/landing/DeviceShowcase";
import { OrderRail } from "@/components/landing/OrderRail";
import { PermissionsPanel, StorefrontPanel } from "@/components/landing/PanelDiagram";
import { Reveal } from "@/components/landing/Reveal";
import { merchantNavGroups } from "@/config/navigation";
import {
  fetchPlatformContact,
  formatContactPhone,
  PLATFORM_CONTACT_FALLBACK,
  whatsappLink,
  type PlatformContact,
} from "@/lib/platform-contact";
import {
  delayStyle,
  describeFetchFailure,
  scrollBehaviour,
  useCountUp,
  useInViewport,
  useMediaQuery,
  usePrefersReducedMotion,
  useReveal,
  useScrolledPast,
} from "@/lib/landing-motion";

type PublicPlan = {
  code: string;
  name: string;
  monthlyPriceIqd: number;
  commissionPercent: number;
  /** The owner's «توصية المنصة» pick — server-enforced to at most one plan. */
  isRecommended: boolean;
  /** The plan `subscribeMerchantToDefaultPlan` really assigns at registration. */
  isDefault: boolean;
  limits: Record<string, number>;
  // TODO(pricing-annual): the owner approved annual billing; when the plans
  // service starts publishing `annualPriceIqd`, add it here and switch the
  // «سنوي» option in the billing toggle below from disabled to live. Until the
  // API carries a real annual figure this page must not display one.
};

type BillingCycle = "monthly" | "annual";

/** Three real states — «failed» is what the swallowed `.catch()` used to hide. */
type LoadState = "loading" | "ready" | "failed";

/**
 * ONE numeral system for the whole page. Every figure — prices, plan limits,
 * statistics and commission percentages alike — goes through an `ar-IQ`
 * formatter, so Arabic-Indic digits and the Arabic decimal mark «٫» never sit
 * beside a raw Latin "2.5" inside the same card.
 */
const money = new Intl.NumberFormat("ar-IQ", { maximumFractionDigits: 0 });
/** Same numeral system as `money`, for the one statistic that can carry a fraction. */
const decimalMoney = new Intl.NumberFormat("ar-IQ", { maximumFractionDigits: 1 });
/**
 * Commissions arrive as basis points ÷ 100, so 250bps → 2.5. Formatting them
 * here is what stops «عمولة 2.5%» rendering in Latin digits with a Latin dot
 * two lines above «حتى ٣ متاجر». The sign is the Arabic percent mark «٪».
 */
const percent = new Intl.NumberFormat("ar-IQ", { maximumFractionDigits: 2 });
const PERCENT_SIGN = "٪";

/**
 * Arabic tamyiz — the counted noun changes shape with its number, and printing
 * one bare singular for every count («حتى ٣ متجر») is simply ungrammatical:
 *   1        → singular + واحد            «متجر واحد»
 *   2        → dual, and the numeral drops «متجرين»
 *   3 – 10   → جمع قلة                    «٣ متاجر»
 *   ≥100 round → مضاف إليه مجرور, which is the bare singular «٥٠٠ منتج»
 *   otherwise (11+) → مفرد منصوب          «١١ متجرًا»
 * `number: null` is how 1 and 2 suppress the digit — Arabic carries the count
 * inside the noun itself there, so «حتى ٢ متجرين» would say it twice.
 */
type CountedNoun = { one: string; two: string; few: string; many: string };

function countedNoun(count: number, forms: CountedNoun): { number: string | null; noun: string } {
  if (count === 1) return { number: null, noun: `${forms.one} واحد` };
  if (count === 2) return { number: null, noun: forms.two };
  const digits = money.format(count);
  if (count >= 3 && count <= 10) return { number: digits, noun: forms.few };
  if (count >= 100 && count % 100 === 0) return { number: digits, noun: forms.one };
  return { number: digits, noun: forms.many };
}

/**
 * `max_image_storage_mb` is measured in a unit symbol, not an Arabic counted
 * noun, so all four of its forms are identical on purpose: unit symbols do not
 * inflect («حتى ٣ MB صور»).
 */
const LIMIT_LABELS: [string, CountedNoun][] = [
  ["max_stores", { one: "متجر", two: "متجرين", few: "متاجر", many: "متجرًا" }],
  ["max_products", { one: "منتج", two: "منتجين", few: "منتجات", many: "منتجًا" }],
  ["max_staff", { one: "موظف", two: "موظفَين", few: "موظفين", many: "موظفًا" }],
  [
    "max_monthly_orders",
    { one: "طلب شهرياً", two: "طلبين شهرياً", few: "طلبات شهرياً", many: "طلبًا شهرياً" },
  ],
  ["max_image_storage_mb", { one: "MB صور", two: "MB صور", few: "MB صور", many: "MB صور" }],
];

/**
 * The pillars ledger — the old 8-card tools grid compressed to four ruled
 * lines (Linear-style: type and a hairline, no icons, no cards). Every claim
 * here survived word-for-word from the audited FEATURES/TRUST_FACTS copy; the
 * isolation line still describes the mechanisms that actually exist (scoped
 * queries + composite keys + isolation suites), never row-level security.
 */
const PILLARS = [
  {
    title: "عزل متاجر يفرضه الخادم",
    text: "كل استعلام يُقيَّد بمعرّف متجرك على الخادم، ومفاتيح مركّبة في القاعدة تمنع ربط أي سجل بمتجر آخر — وتغطيه اختبارات عزل قبل كل إصدار.",
  },
  {
    title: "مالية شفافة",
    text: "سجل مالي غير قابل للتلاعب، عمولات معلنة لكل خطة، وقيد العمولة يُكتب في نفس معاملة اكتمال الطلب.",
  },
  {
    title: "إشعارات موثوقة",
    text: "كل طلب وتغيير حالة وانخفاض مخزون يسجَّل في نفس معاملة العملية ثم يُرسل بإعادة محاولات تلقائية.",
  },
  {
    title: "أدوات نمو جاهزة",
    text: "استيراد وتصدير CSV محمي من حقن الصيغ، تقارير قمع وإيراد وسلات متروكة، وبكسلات Meta وTikTok وGA4 لكل متجر.",
  },
];

/** Four honest steps — each one maps to a screen that exists today. */
const STEPS = [
  {
    title: "أنشئ حسابك ومتجرك",
    text: "استمارة واحدة تُنشئ حسابك التاجر ومتجرك الأول ورابطه الفرعي — بلا بطاقة ائتمان.",
  },
  {
    title: "ارفع منتجاتك",
    text: "أضف المنتجات ومتغيراتها وتصنيفاتها يدوياً، أو استورد كتالوجك كاملاً بملف CSV.",
  },
  {
    title: "شارك رابط متجرك",
    text: "اضبط المحافظات التي تخدمها وسعر التوصيل لكل واحدة، ثم انشر رابط متجرك الجاهز للبيع.",
  },
  {
    title: "استقبل الطلبات وحصّل",
    text: "تابع الطلب عبر حالاته، أرسل الإشعارات، واقرأ مستحقاتك وعمولتك في سجل مالي واضح.",
  },
];

/** Arabic-Indic ghost numerals for the how rail — `dir="ltr"` runs, like every figure. */
const STEP_NUMERALS = ["٠١", "٠٢", "٠٣", "٠٤"];

const STOREFRONT_CAPABILITIES = [
  "كتالوج المنتجات",
  "متغيّرات ومقاسات",
  "سلة بحجز مخزون",
  "إتمام الطلب بالدفع عند الاستلام",
  "حساب زبون وسجل طلباته",
  "عناوين محفوظة",
  "توصيل حسب المحافظة",
  "كوبونات خصم",
];

/**
 * Electronic payment is NOT live (phase 25a — no gateway agreement signed), so
 * these are rendered as muted «قريباً» chips, never as available methods, and as
 * neutral typographic chips rather than brand logos we hold no licence for.
 */
const UPCOMING_PAYMENTS = [
  { name: "كي كارد", icon: CreditCard },
  { name: "زين كاش", icon: Smartphone },
  { name: "المحافظ العراقية", icon: Wallet },
];

/**
 * Verifiable statements — each traced to the file that implements it.
 * The isolation line names the four mechanisms that actually exist
 * (phase5.tenancy.integration.ts proves them end to end: a cross-store slug is
 * refused 403 STORE_BOUNDARY_DENIED and a cross-store id 404 RESOURCE_NOT_FOUND).
 * The ledger line stays as written — `ledger_entries_immutable` and
 * `settlements_immutable` in migration 20260825190000 are real database triggers.
 */
const TRUST_FACTS = [
  "عزل المتاجر يفرضه الخادم: جلسات منفصلة ومفاتيح مركّبة، وتغطيه اختبارات عزل قبل كل إصدار",
  "سجل مالي إضافي فقط — القاعدة ترفض تعديل القيود أو حذفها",
  "قيد العمولة يُكتب في نفس معاملة اكتمال الطلب",
  "إرجاع الطلب خلال ١٥ يوماً يعكس العمولة تلقائياً",
];

/** Generated from the single navigation source of truth: only shipped menus appear. */
const LIVE_DASHBOARD_MENUS = Array.from(
  new Set(
    merchantNavGroups.flatMap((group) =>
      group.entries.filter((entry) => entry.status === "implemented").map((entry) => entry.label)
    )
  )
);

/** The three product-story beats — copy carried over verbatim from the audited showcase rows. */
const STORY_BEATS = [
  {
    eyebrow: "٠١ · واجهة المتجر",
    title: "رابط جاهز للبيع منذ لحظة التسجيل",
    text: "يُنشأ لمتجرك رابط فرعي خاص به فور التسجيل: كتالوج بالعربية، صفحة منتج بمتغيراته، سلة تحجز المخزون، وإتمام طلب دون أي إعداد إضافي.",
  },
  {
    eyebrow: "٠٢ · دورة حياة الطلب",
    title: "من «جديدة» إلى «مكتملة» بانتقالات محكومة",
    text: "الطلب لا يقفز بين الحالات: كل انتقال يتحقق منه الخادم، ويكتب حركته المخزنية وإشعاره وقيده المالي في نفس المعاملة — فلا يبقى نصف عملية معلّقاً.",
  },
  {
    eyebrow: "٠٣ · لوحة التحكم",
    title: "فريقك يعمل، وأنت تقرر ما يراه",
    text: "أضف موظفيك بأدوار جاهزة ثم اسمح أو امنع كل صلاحية على حدة. الخادم يعيد حساب الصلاحيات في كل طلب حساس — إخفاء زر في الواجهة ليس حماية.",
  },
];

/**
 * The public register contract stays untouched (it never accepts a plan):
 * for a non-free selected plan, the form logs the fresh merchant in through
 * the existing login endpoint and files the upgrade request automatically.
 */
function SignupForm({
  defaultPlan,
  selectedPlan,
}: {
  defaultPlan: PublicPlan | null;
  selectedPlan: PublicPlan | null;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<{
    approvalStatus: string;
    storeSlug: string;
    upgrade: "requested" | "failed" | null;
  } | null>(null);
  const [, navigate] = useLocation();
  // P27-7: in the demo environment the server refuses this registration
  // (403 DEMO_REGISTRATION_DISABLED), because an account created here is
  // destroyed by the 01:00 reseed with no way to warn its owner. Swapping the
  // form for the explanation means the visitor never fills five fields just to
  // be turned away — the server rule stands on its own, this only spares them
  // the walk into it.
  const demo = useDemoMode();

  async function requestSelectedPlanUpgrade(
    storeSlug: string,
    email: FormDataEntryValue | null,
    password: FormDataEntryValue | null
  ): Promise<"requested" | "failed"> {
    try {
      // P27-21: the merchant just registered, so the store is brand new and his
      // ONLY one — identity sign-in lands him on it. The store slug stays a
      // parameter because the upgrade request below is store-scoped.
      const login = await fetch("/api/auth/merchant/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: email, password }),
      });
      if (!login.ok) return "failed";
      const upgrade = await fetch("/api/merchant/subscription/upgrade-request", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planCode: selectedPlan?.code }),
      });
      return upgrade.ok ? "requested" : "failed";
    } catch {
      return "failed";
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setFailure(null);
    try {
      const response = await fetch("/api/public/merchants/register", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          businessName: form.get("businessName"),
          ownerName: form.get("ownerName"),
          phone: form.get("phone"),
          storeName: form.get("storeName"),
          storeSlug: form.get("storeSlug"),
          email: form.get("email"),
          password: form.get("password"),
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(body?.error?.message ?? body?.error?.code ?? "فشل التسجيل.");
      let upgrade: "requested" | "failed" | null = null;
      if (body.approvalStatus === "approved" && selectedPlan && selectedPlan.code !== "free") {
        upgrade = await requestSelectedPlanUpgrade(
          body.store.slug,
          form.get("email"),
          form.get("password")
        );
      }
      setResult({ approvalStatus: body.approvalStatus, storeSlug: body.store.slug, upgrade });
    } catch (error) {
      // A dropped connection is a TypeError with an English browser message; a
      // real server rejection carries its own Arabic text. `describeFetchFailure`
      // keeps «رابط المتجر مستخدم بالفعل.» and replaces "Failed to fetch".
      setFailure(describeFetchFailure(error));
    } finally {
      setPending(false);
    }
  }

  if (result) {
    return result.approvalStatus === "approved" ? (
      <div
        data-testid="signup-success"
        className="rounded-[24px] bg-[var(--codiq-success-soft)] p-7 text-center"
      >
        <BadgeCheck className="mx-auto h-10 w-10 text-[var(--codiq-success)]" />
        <p className="mt-3 text-lg font-bold text-[#1C4532]">تم إنشاء متجرك بنجاح!</p>
        <p className="mt-2 text-sm text-[#3E6B54]">
          معرّف متجرك:{" "}
          <span className="font-bold" dir="ltr">
            {result.storeSlug}
          </span>
        </p>
        {result.upgrade === "requested" ? (
          <p
            data-testid="signup-upgrade-requested"
            className="mx-auto mt-3 max-w-sm rounded-xl bg-white/70 px-4 py-2.5 text-xs font-semibold leading-6 text-[#3E6B54]"
          >
            أُرسل طلب ترقيتك إلى خطة «{selectedPlan?.name}» وسيراجعه فريق المنصة — تبدأ على الخطة
            المجانية حتى الموافقة.
          </p>
        ) : null}
        {result.upgrade === "failed" ? (
          <p
            data-testid="signup-upgrade-failed"
            className="mx-auto mt-3 max-w-sm rounded-xl bg-[var(--codiq-warning-soft)] px-4 py-2.5 text-xs font-semibold leading-6 text-[#8A6620]"
          >
            تعذّر إرسال طلب الترقية تلقائياً — يمكنك طلب خطة «{selectedPlan?.name}» من لوحة التاجر
            بعد الدخول.
          </p>
        ) : null}
        <Button
          onClick={() => navigate("/merchant/login")}
          className="cq-cta mt-5 rounded-xl bg-[var(--codiq-success)] text-white hover:bg-[#1F5C41]"
        >
          ادخل إلى لوحة التاجر <ArrowLeft className="mr-2 h-4 w-4" />
        </Button>
      </div>
    ) : (
      <div
        data-testid="signup-pending"
        className="rounded-[24px] bg-[var(--codiq-warning-soft)] p-7 text-center"
      >
        <Clock4 className="mx-auto h-10 w-10 text-[#A76B13]" />
        <p className="mt-3 text-lg font-bold text-[#7A5210]">استلمنا طلبك!</p>
        <p className="mt-2 text-sm leading-6 text-[#8A6620]">
          طلب تسجيلك قيد مراجعة إدارة المنصة. ستتمكن من الدخول فور الموافقة، ومعرّف متجرك المحجوز:{" "}
          <span className="font-bold" dir="ltr">
            {result.storeSlug}
          </span>
        </p>
      </div>
    );
  }

  if (demo === true) {
    return (
      <div
        data-testid="signup-demo-disabled"
        className="rounded-[24px] bg-[var(--codiq-accent-soft)] p-7 text-center"
      >
        <FlaskConical className="mx-auto h-10 w-10 text-[#1B4E96]" strokeWidth={1.7} />
        <p className="mt-3 text-lg font-bold text-[#1B4E96]">التسجيل معطّل في النسخة التجريبية</p>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-7 text-[#315F9E]">
          هذه نسخة للاستعراض فقط، وبياناتها تُمحى بالكامل كل ليلة — أي حساب يُنشأ هنا يختفي مع
          متجره. لإنشاء متجر حقيقي انتقل إلى موقع Codiq الرسمي.
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
          <Button
            asChild
            className="cq-cta rounded-xl bg-[var(--codiq-accent)] text-white hover:bg-[var(--codiq-accent-hover)]"
          >
            <a href="https://codiqos.com/" rel="noreferrer">
              انتقل إلى الموقع الرسمي <ArrowLeft className="mr-2 h-4 w-4" />
            </a>
          </Button>
          {/* The useful action here: the guest entry that shows the whole
              dashboard on the seeded store, with nothing to lose. */}
          <Button
            variant="ghost"
            onClick={() => navigate("/demo")}
            className="rounded-xl font-bold text-[#1B4E96] hover:bg-white/70"
          >
            جرّب اللوحة كضيف
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <label className="block space-y-1.5 text-sm font-semibold text-[#44526A]">
        <span>اسم النشاط التجاري</span>
        <Input data-testid="signup-business" name="businessName" required minLength={2} />
      </label>
      <label className="block space-y-1.5 text-sm font-semibold text-[#44526A]">
        <span>اسم المتجر</span>
        <Input data-testid="signup-store-name" name="storeName" required minLength={2} />
      </label>
      <label className="block space-y-1.5 text-sm font-semibold text-[#44526A]">
        <span>رابط المتجر (إنجليزي)</span>
        <Input
          data-testid="signup-store-slug"
          name="storeSlug"
          required
          pattern="[a-z0-9][a-z0-9-]{1,48}[a-z0-9]"
          placeholder="my-store"
          dir="ltr"
        />
      </label>
      {/* P27-12 (ق-100): the person, and the number he answers. «متجر النور» does
          not take a call about a return, and this number becomes his sign-in
          identity in P27-21 — which is why it is unique across the platform. */}
      <label className="block space-y-1.5 text-sm font-semibold text-[#44526A]">
        <span>اسمك الشخصي</span>
        <Input data-testid="signup-owner-name" name="ownerName" required minLength={2} />
      </label>
      <label className="block space-y-1.5 text-sm font-semibold text-[#44526A]">
        <span>رقم الهاتف</span>
        <Input
          data-testid="signup-phone"
          name="phone"
          required
          inputMode="tel"
          placeholder="07XXXXXXXXX"
          dir="ltr"
        />
      </label>
      <label className="block space-y-1.5 text-sm font-semibold text-[#44526A]">
        <span>البريد الإلكتروني</span>
        <Input data-testid="signup-email" name="email" type="email" required dir="ltr" />
      </label>
      <div className="block space-y-1.5 text-sm font-semibold text-[#44526A] sm:col-span-2">
        <label htmlFor="signup-password-field">كلمة المرور (8 خانات فأكثر)</label>
        <PasswordInputWithMeter
          id="signup-password-field"
          data-testid="signup-password"
          name="password"
          required
          minLength={8}
        />
      </div>
      {failure ? (
        <p
          data-testid="signup-error"
          className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)] sm:col-span-2"
        >
          <CircleAlert className="h-4 w-4" /> {failure}
        </p>
      ) : null}
      <div className="sm:col-span-2">
        <Button
          data-testid="signup-submit"
          disabled={pending}
          className="cq-cta w-full rounded-xl bg-[var(--codiq-accent)] py-6 text-base font-bold text-white hover:bg-[var(--codiq-accent-hover)]"
        >
          {/* The default plan is the one `subscribeMerchantToDefaultPlan` really
              assigns (DEFAULT_PLAN_CODE), flagged `isDefault` by the plans API —
              not whichever plan happens to sort first. */}
          {/* Guillemets, matching the upgrade notices above: plan names carry
              their own article («المجانية»), so «خطة المجانية» would read wrong
              while «خطة «المجانية»» works for every name the owner may choose. */}
          {pending ? (
            <LoaderCircle className="h-5 w-5 animate-spin" />
          ) : (
            <>
              أنشئ متجرك الآن — خطة «{defaultPlan?.name ?? "المجانية"}»{" "}
              <ArrowLeft className="mr-2 h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </form>
  );
}

/**
 * One animated statistic. `value` is a verified fact; the counter only animates
 * how it arrives. Digits go through the same ar-IQ formatter the prices use, so
 * the page never mixes Arabic-Indic and Latin numerals, and the figure plus its
 * suffix share one `dir="ltr"` run so «١٪» reads in the right order.
 */
function StatCounter({
  value,
  suffix,
  label,
  decimals = 0,
  delay,
}: {
  value: number | null;
  suffix?: string;
  label: string;
  decimals?: number;
  delay: number;
}) {
  const { ref, revealed } = useReveal<HTMLDivElement>();
  const animated = useCountUp(value ?? 0, revealed && value !== null);
  const formatter = decimals > 0 ? decimalMoney : money;
  return (
    <div
      ref={ref}
      data-revealed={revealed ? "true" : "false"}
      style={delayStyle(delay)}
      className="cq-reveal"
    >
      <p className="text-3xl font-bold tracking-[-0.03em] text-[#15233E] sm:text-[2.35rem]">
        <span dir="ltr" className="inline-block tabular-nums">
          {value === null ? "—" : formatter.format(animated)}
          {suffix ? (
            <span className="text-xl font-bold text-[var(--codiq-accent)] sm:text-2xl">
              {suffix}
            </span>
          ) : null}
        </span>
      </p>
      <p className="mt-1.5 text-[13px] font-semibold leading-6 text-[var(--codiq-text-secondary)]">
        {label}
      </p>
    </div>
  );
}

/**
 * The dashboard-menu marquee.
 *
 * WCAG 2.2.2 (level A): anything that moves automatically for more than five
 * seconds needs a mechanism to pause it. The only stop used to be `:hover`,
 * which is a mouse — a keyboard or touch visitor had no way to hold the strip
 * still and read it. This adds a real button with an Arabic accessible name and
 * `aria-pressed`, so it is reachable by Tab and announced as a toggle.
 *
 * It also stops paying for itself off screen: `useInViewport` flips
 * `data-cq-onscreen`, and index.css parks the animation while the block is out
 * of view, which matters on the low-end Android handsets this market runs.
 */
function CapabilityMarquee() {
  const [playing, setPlaying] = useState(true);
  const { ref, visible } = useInViewport<HTMLDivElement>();
  return (
    <div className="mt-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-semibold text-[#63718A]">
          قوائم تعمل اليوم في لوحة التاجر — مولّدة من مصدر التنقل نفسه:
        </p>
        <button
          type="button"
          data-testid="marquee-toggle"
          aria-pressed={!playing}
          onClick={() => setPlaying((current) => !current)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-1.5 text-[12px] font-bold text-[var(--codiq-text-secondary)] transition hover:border-[#C7D6EB] hover:text-[var(--codiq-accent)]"
        >
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {playing ? "إيقاف الحركة" : "تشغيل الحركة"}
        </button>
      </div>
      <div
        ref={ref}
        className="cq-marquee -mx-1"
        data-cq-playing={playing ? "true" : "false"}
        data-cq-onscreen={visible ? "true" : "false"}
      >
        <div className="cq-marquee__track py-1">
          {[...LIVE_DASHBOARD_MENUS, ...LIVE_DASHBOARD_MENUS].map((label, index) => (
            <span
              key={`${label}-${index}`}
              aria-hidden={index >= LIVE_DASHBOARD_MENUS.length ? "true" : undefined}
              className="shrink-0 rounded-full border border-[var(--codiq-accent-soft)] bg-[var(--codiq-surface)] px-3.5 py-1.5 text-[12.5px] font-semibold whitespace-nowrap text-[#4E5D78]"
            >
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Live pricing. Every testid and the session-aware CTA behaviour are unchanged. */
function PricingSection({
  plans,
  plansState,
  onRetryPlans,
  merchantSession,
  ctaBusy,
  onChoose,
  onUpgrade,
}: {
  plans: PublicPlan[];
  plansState: LoadState;
  onRetryPlans: () => void;
  merchantSession: { planCode: string } | null;
  ctaBusy: boolean;
  onChoose: (plan: PublicPlan) => void;
  onUpgrade: (plan: PublicPlan) => void;
}) {
  // Monthly is the only cycle the API publishes today, so «سنوي» renders disabled
  // with a «قريباً» hint rather than showing an invented annual figure.
  const [billing, setBilling] = useState<BillingCycle>("monthly");
  const annualAvailable = false;

  return (
    <section id="pricing" className="mx-auto max-w-6xl px-5 pt-24 lg:pt-32">
      <Reveal className="text-center">
        <h2 className="text-[1.8rem] font-bold tracking-[-0.03em] text-[#15233E] sm:text-[2.5rem]">
          خطط واضحة. بلا مفاجآت.
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-[15px] leading-8 text-[var(--codiq-text-secondary)]">
          تبدأ مجاناً وترقّي حين تنمو مبيعاتك. الحدود تُفرض بعدالة على الخادم والعمولة معلنة لكل
          خطة.
        </p>
      </Reveal>

      <Reveal delay={80} className="mt-8 flex justify-center">
        <div className="cq-billing inline-flex items-center gap-1 rounded-full border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] p-1.5 shadow-[0_8px_24px_rgba(31,55,98,0.05)]">
          <button
            type="button"
            aria-pressed={billing === "monthly"}
            onClick={() => setBilling("monthly")}
            className="cq-billing__option rounded-full px-5 py-2 text-[13px] font-bold"
          >
            شهري
          </button>
          <button
            type="button"
            aria-pressed={billing === "annual"}
            disabled={!annualAvailable}
            onClick={() => annualAvailable && setBilling("annual")}
            className="cq-billing__option flex items-center gap-2 rounded-full px-5 py-2 text-[13px] font-bold disabled:cursor-not-allowed"
          >
            سنوي
            <span className="rounded-full bg-[var(--codiq-neutral-soft)] px-2 py-0.5 text-[10px] font-bold text-[#5C6B85]">
              قريباً
            </span>
          </button>
        </div>
      </Reveal>

      <div className="mt-10 grid items-stretch gap-5 md:grid-cols-3">
        {plansState === "loading" ? (
          <p
            data-testid="plans-loading"
            className="text-center text-sm text-[var(--codiq-text-secondary)] md:col-span-3"
          >
            <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ تحميل الخطط…
          </p>
        ) : null}
        {/* An explicit, recoverable failure. Swallowing the rejection used to leave
            «جارٍ تحميل الخطط…» spinning forever whenever /api/public/plans was
            unreachable — the visitor was told nothing and given nothing to do. */}
        {plansState === "failed" ? (
          <div
            data-testid="plans-error"
            role="alert"
            className="mx-auto max-w-md rounded-[24px] border border-[#F2D6DA] bg-[#FFF6F7] px-6 py-7 text-center md:col-span-3"
          >
            <TriangleAlert className="mx-auto h-8 w-8 text-[var(--codiq-danger)]" />
            <p className="mt-3 text-[15px] font-bold text-[#8E2333]">تعذّر تحميل خطط الأسعار</p>
            <p className="mt-2 text-[13px] leading-7 text-[#7A4049]">
              قد يكون الاتصال بالإنترنت منقطعاً أو الخادم مشغولاً. الأسعار تُقرأ مباشرة من المنصة،
              فلا نعرض لك أرقاماً مخزّنة قد تكون قديمة.
            </p>
            <Button
              data-testid="plans-retry"
              onClick={onRetryPlans}
              variant="outline"
              className="cq-cta--ghost mt-5 rounded-xl border-[#E7C3C8] bg-[var(--codiq-surface)] font-bold text-[var(--codiq-danger)] hover:bg-[var(--codiq-danger-soft)]"
            >
              <RotateCcw className="ml-2 h-4 w-4" /> إعادة المحاولة
            </Button>
          </div>
        ) : null}
        {plansState === "ready" && plans.length === 0 ? (
          <p
            data-testid="plans-empty"
            className="text-center text-sm text-[var(--codiq-text-secondary)] md:col-span-3"
          >
            لا توجد خطط منشورة حالياً.
          </p>
        ) : null}
        {plans.map((plan, index) => {
          // The owner decides this from her own dashboard, one plan at a time —
          // it is NOT «الأكثر اختياراً» derived from array position. CODIQ has no
          // customers, so a popularity claim would contradict the proof band
          // above, which promises no invented merchant numbers.
          const recommended = plan.isRecommended;
          return (
            <Reveal key={plan.code} delay={index * 110}>
              <div
                data-testid={`landing-plan-${plan.code}`}
                data-recommended={recommended ? "true" : "false"}
                className={`cq-plan cq-card flex h-full flex-col rounded-[26px] border bg-[var(--codiq-surface)] p-7 ${recommended ? "border-[var(--codiq-accent)] shadow-[0_26px_60px_rgba(30,111,219,0.16)] ring-4 ring-[var(--codiq-accent)]/10" : "border-[var(--codiq-neutral-soft)] shadow-[0_16px_44px_rgba(31,55,98,0.055)]"}`}
              >
                {recommended ? (
                  <p
                    data-testid={`landing-plan-recommended-${plan.code}`}
                    className="mb-3 inline-flex w-fit items-center gap-1.5 self-start rounded-full bg-[var(--codiq-accent)] px-3 py-1 text-[11px] font-bold text-white"
                  >
                    <BadgeCheck className="h-3.5 w-3.5" /> توصية المنصة
                  </p>
                ) : null}
                <p className="text-lg font-bold text-[#263650]">{plan.name}</p>

                <div className="cq-price mt-3" key={`${plan.code}-${billing}`}>
                  <p className="flex flex-wrap items-baseline gap-x-2 text-[2.35rem] font-bold leading-none tracking-[-0.035em] text-[#15233E]">
                    {plan.monthlyPriceIqd === 0 ? (
                      "مجاناً"
                    ) : (
                      <>
                        <span dir="ltr" className="tabular-nums">
                          {money.format(plan.monthlyPriceIqd)}
                        </span>
                        <span className="text-[13px] font-semibold text-[#63718A]">
                          د.ع / شهرياً
                        </span>
                      </>
                    )}
                  </p>
                </div>

                {/* Through the ar-IQ formatter, like every other figure on the
                    page: «عمولة ٢٫٥٪» — never a raw Latin "2.5%" one line above
                    «حتى ٣ متاجر» inside the same card. */}
                <p className="mt-3 inline-flex w-fit items-center gap-1.5 rounded-full bg-[var(--codiq-canvas)] px-3 py-1.5 text-xs font-bold text-[#41618F]">
                  عمولة{" "}
                  <span dir="ltr" className="tabular-nums">
                    {percent.format(plan.commissionPercent)}
                    {PERCENT_SIGN}
                  </span>{" "}
                  على الطلبات المكتملة
                </p>

                <ul className="mt-6 space-y-3 text-sm text-[#44526A]">
                  {LIMIT_LABELS.map(([key, forms]) => {
                    // A dash — not a checkmark — whenever the live payload grants no
                    // such allowance, so the comparison stays honest either way.
                    const limit = plan.limits[key];
                    const included = typeof limit === "number" && limit > 0;
                    // Arabic tamyiz: «متجر واحد» / «متجرين» / «٣ متاجر» / «١١ متجرًا».
                    const counted = included ? countedNoun(limit, forms) : null;
                    return (
                      <li key={key} className="flex items-center gap-2.5">
                        <span
                          className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ${included ? "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]" : "bg-[var(--codiq-neutral-soft)] text-[#79889F]"}`}
                        >
                          {included ? (
                            <Check size={12} strokeWidth={3} />
                          ) : (
                            <Minus size={12} strokeWidth={3} />
                          )}
                        </span>
                        {counted ? (
                          <span>
                            حتى
                            {counted.number ? (
                              <>
                                {" "}
                                <span dir="ltr" className="font-semibold tabular-nums">
                                  {counted.number}
                                </span>
                              </>
                            ) : null}{" "}
                            {counted.noun}
                          </span>
                        ) : (
                          <span className="text-[#63718A]">{forms.one} — غير مشمول</span>
                        )}
                      </li>
                    );
                  })}
                </ul>

                <div className="mt-auto pt-7">
                  {merchantSession ? (
                    merchantSession.planCode === plan.code ? (
                      <Button
                        data-testid={`plan-cta-${plan.code}`}
                        disabled
                        variant="outline"
                        className="w-full rounded-xl border-[var(--codiq-border-strong)] text-[#63718A] disabled:opacity-100"
                      >
                        خطتك الحالية
                      </Button>
                    ) : (
                      <Button
                        data-testid={`plan-cta-${plan.code}`}
                        disabled={ctaBusy}
                        onClick={() => onUpgrade(plan)}
                        className="cq-cta w-full rounded-xl bg-[var(--codiq-accent)] py-5 font-bold text-white hover:bg-[var(--codiq-accent-hover)]"
                      >
                        الترقية إلى هذه الخطة
                      </Button>
                    )
                  ) : (
                    <Button
                      data-testid={`plan-cta-${plan.code}`}
                      onClick={() => onChoose(plan)}
                      variant={recommended ? "default" : "outline"}
                      className={
                        recommended
                          ? "cq-cta w-full rounded-xl bg-[var(--codiq-accent)] py-5 font-bold text-white hover:bg-[var(--codiq-accent-hover)]"
                          : "cq-cta--ghost w-full rounded-xl border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] py-5 font-bold text-[var(--codiq-accent)] hover:bg-[var(--codiq-surface-sunken)]"
                      }
                    >
                      ابدأ بهذه الخطة <ArrowLeft className="mr-2 h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            </Reveal>
          );
        })}
      </div>
      <Reveal delay={120}>
        <p className="mt-6 text-center text-xs leading-7 text-[#63718A]">
          الأسعار والحدود والعمولات تُقرأ مباشرة من خطط المنصة لحظة فتح الصفحة، وتُفرض على الخادم لا
          على الواجهة.
        </p>
      </Reveal>
    </section>
  );
}

export default function Home() {
  const [, navigate] = useLocation();
  const [plans, setPlans] = useState<PublicPlan[]>([]);
  const [plansState, setPlansState] = useState<LoadState>("loading");
  const [selectedPlan, setSelectedPlan] = useState<PublicPlan | null>(null);
  // Cheap session probe: 200 → a logged-in merchant (upgrade CTA), 401 → visitor (signup CTA).
  const [merchantSession, setMerchantSession] = useState<{ planCode: string } | null>(null);
  /**
   * PC-1 — the footer's contact details, owner-editable since 2026-09-04.
   *
   * It starts at the COMPILED-IN values, never at null and never at a spinner:
   * the request below is a reconciliation, not a dependency, so nothing about
   * first paint waits on it (ق-137). A visitor on a bad connection reads a real
   * email and a real phone immediately, and if `/api/public/contact` never
   * answers he never learns that anything was meant to happen.
   */
  const [contact, setContact] = useState<PlatformContact>(PLATFORM_CONTACT_FALLBACK);
  const [ctaBusy, setCtaBusy] = useState(false);
  const navElevated = useScrolledPast(6);
  // The nav's own «ابدأ مجاناً» appears only after the hero's CTA pair has
  // scrolled away — before that it would duplicate a button already on screen.
  const navCtaShown = useScrolledPast(480);
  // ONE DeviceShowcase instance, chosen at mount (ق-137) — never two mounts
  // with one hidden by CSS. The same query picks the product-story structure:
  // the sticky theater needs a wide viewport AND motion; everyone else gets
  // the three plain stacked rows, which are the finished state of the theater.
  const wide = useMediaQuery("(min-width: 1024px)");
  const reducedMotion = usePrefersReducedMotion();
  const theater = wide && !reducedMotion;
  const heroDevices = useInViewport<HTMLDivElement>();
  // Three one-shot beat reveals drive both the text entrances and the stage:
  // the deepest revealed beat is the active panel. One-shot is the page's
  // existing reveal grammar — scrolling back up keeps the last panel, which is
  // calmer than re-animating in reverse.
  const beat1 = useReveal<HTMLDivElement>();
  const beat2 = useReveal<HTMLDivElement>();
  const beat3 = useReveal<HTMLDivElement>();
  const activeStage = beat3.revealed ? 2 : beat2.revealed ? 1 : 0;
  const beats = [beat1, beat2, beat3];
  const howRail = useReveal<HTMLDivElement>();

  /**
   * The plans request now REPORTS its failures. It used to end in
   * `.catch(() => undefined)`, so an unreachable `/api/public/plans` left the
   * pricing grid spinning «جارٍ تحميل الخطط…» forever and the trust band showing
   * «—%», with nothing on screen to retry.
   */
  const loadPlans = useCallback(async () => {
    setPlansState("loading");
    try {
      const response = await fetch("/api/public/plans");
      if (!response.ok) throw new Error(`plans request failed (${response.status})`);
      const body = await response.json();
      setPlans(body.plans ?? []);
      setPlansState("ready");
    } catch {
      setPlans([]);
      setPlansState("failed");
    }
  }, []);

  useEffect(() => {
    void loadPlans();
  }, [loadPlans]);

  useEffect(() => {
    // The session probe stays silent on purpose: a visitor is the expected case,
    // and a failed probe simply means «render the signup CTA» — nothing to report.
    fetch("/api/merchant/subscription", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) return;
        const body = await response.json().catch(() => null);
        if (body?.plan?.code) setMerchantSession({ planCode: body.plan.code });
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    // Silent for the same reason the probe above is: the page already holds a
    // correct answer, so there is nothing here to report to a visitor.
    void fetchPlatformContact().then((published) => {
      if (published) setContact(published);
    });
  }, []);

  /** Lowest published commission, straight from the plans payload — never hard-coded. */
  const lowestCommission = useMemo(
    () => (plans.length === 0 ? null : Math.min(...plans.map((plan) => plan.commissionPercent))),
    [plans]
  );

  /**
   * The plan the server really assigns at registration (`DEFAULT_PLAN_CODE`,
   * flagged `isDefault` by the plans API) — not `plans[0]`, which only guessed
   * from sort order and would mislabel the signup CTA the moment the owner
   * re-ordered the grid.
   */
  const defaultPlan = useMemo(() => plans.find((plan) => plan.isDefault) ?? null, [plans]);

  function scrollToSection(id: string) {
    // `behavior` is resolved at click time from the live media query: passing
    // "smooth" here would override the CSS reduced-motion opt-out entirely.
    document.getElementById(id)?.scrollIntoView({ behavior: scrollBehaviour() });
  }

  function choosePlanAsVisitor(plan: PublicPlan) {
    setSelectedPlan(plan);
    scrollToSection("signup");
  }

  async function requestUpgradeAsMerchant(plan: PublicPlan) {
    setCtaBusy(true);
    try {
      const response = await fetch("/api/merchant/subscription/upgrade-request", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planCode: plan.code }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
      toast.success("أُرسل طلبك وسيراجعه فريق المنصة.");
    } catch (error) {
      toast.error(describeFetchFailure(error));
    } finally {
      setCtaBusy(false);
    }
  }

  // Owner rule: the start year is fixed at 2025, the end is the client clock — never a typed-in year.
  const startYear = 2025;
  const currentYear = new Date().getFullYear();
  const copyrightYears = currentYear > startYear ? `${startYear}–${currentYear}` : `${startYear}`;

  /** One story beat's text block — shared by the theater and the stacked layout. */
  const beatText = (index: number) => (
    <div
      ref={beats[index].ref}
      data-revealed={beats[index].revealed ? "true" : "false"}
      className="cq-reveal"
    >
      <p
        className="text-xs font-bold tracking-[0.16em] text-[var(--codiq-accent)]"
        dir="ltr"
        style={{ textAlign: "start" }}
      >
        {STORY_BEATS[index].eyebrow}
      </p>
      <h3 className="mt-3 text-[1.55rem] font-bold leading-[1.4] tracking-[-0.03em] text-[#15233E] sm:text-[1.9rem]">
        {STORY_BEATS[index].title}
      </h3>
      <p className="mt-4 text-[15px] leading-8 text-[var(--codiq-text-secondary)]">
        {STORY_BEATS[index].text}
      </p>
      {index === 0 ? (
        <ul className="mt-6 flex flex-wrap gap-2">
          {STOREFRONT_CAPABILITIES.map((capability) => (
            <li
              key={capability}
              className="rounded-full border border-[var(--codiq-accent-soft)] bg-[var(--codiq-surface)] px-3 py-1.5 text-[12.5px] font-semibold text-[#4E5D78]"
            >
              {capability}
            </li>
          ))}
        </ul>
      ) : null}
      {index === 2 ? <CapabilityMarquee /> : null}
    </div>
  );

  /** One story beat's vector panel — `active` rides the beat's own reveal. */
  const beatPanel = (index: number) => {
    if (index === 0) return <StorefrontPanel active={beats[0].revealed} />;
    if (index === 1) {
      return (
        <div className="rounded-[28px] border border-[var(--codiq-neutral-soft)] bg-[var(--codiq-surface)] p-7 shadow-[0_14px_40px_rgba(31,55,98,0.05)]">
          <OrderRail active={beats[1].revealed} />
        </div>
      );
    }
    return <PermissionsPanel active={beats[2].revealed} />;
  };

  return (
    // No `overflow-x: hidden` here on purpose: it would turn this element into a
    // scrollport and quietly break BOTH sticky surfaces — the nav and the
    // product-story stage. Sections clip their own bleed.
    <div dir="rtl" className="min-h-screen bg-[var(--codiq-canvas)] font-sans text-[#17233A]">
      {/* 1 ------------------------------------------------------------ sticky nav */}
      <header
        className={`cq-nav sticky top-0 z-40 border-b bg-white/85 backdrop-blur-xl ${navElevated ? "border-[var(--codiq-border-strong)] shadow-[0_10px_30px_rgba(28,52,96,0.07)]" : "border-transparent"}`}
      >
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-3 py-2.5 sm:px-5 sm:py-4">
          {/* Owner correction (2026-09-01, amending ق-138): the lockup reads in
              LATIN order like the Pinterest reference — mark on the LEFT, word
              to its right — even inside this RTL page, hence dir="ltr". And the
              wordmark is «Codiq»: capital C, lowercase rest (supersedes the old
              all-caps rule for the lockup; prose and <title> are untouched). */}
          <div dir="ltr" className="flex shrink-0 items-center gap-2.5">
            <BrandMark className="h-8 w-8 rounded-xl sm:h-10 sm:w-10" />
            {/* The wordmark steps aside below `sm`; the mark itself never leaves. */}
            <p className="hidden text-lg font-bold tracking-[-0.04em] text-[#15233E] sm:block sm:text-xl">
              Codiq
            </p>
          </div>
          {/*
            Four destinations need ~298px of intrinsic width, but a 320px phone
            leaves only ~240px in this row — and the old fix (a horizontal
            scroller with `scrollbar-width: none`) pushed «لوحة المنصة» outside
            the container with NO visible affordance to reach it. 360px handsets
            are the most common in Iraq, so nothing here may depend on a hidden
            scroll. The row wraps instead: below `sm` it becomes a second full
            line, so every target keeps its accessible name and its own tap area
            at 320px, and nothing is ever clipped.
          */}
          <nav
            aria-label="روابط المنصة"
            className="flex w-full flex-wrap items-center justify-end gap-x-0.5 gap-y-1 text-sm font-semibold sm:w-auto sm:flex-nowrap sm:gap-2"
          >
            <a
              href="#pricing"
              onClick={(event) => {
                event.preventDefault();
                scrollToSection("pricing");
              }}
              className="shrink-0 rounded-xl px-1.5 py-2 text-[12px] text-[var(--codiq-text-secondary)] transition hover:bg-[var(--codiq-canvas)] hover:text-[var(--codiq-accent)] sm:px-3 sm:text-sm"
            >
              الأسعار
            </a>
            <Button
              variant="ghost"
              onClick={() => navigate("/merchant/login")}
              className="h-9 shrink-0 rounded-xl px-1.5 text-[12px] text-[var(--codiq-text-secondary)] sm:h-10 sm:px-3 sm:text-sm"
            >
              دخول التاجر
            </Button>
            {/* Explicit white fill: measured on the page's own #F4F7FB the brand
                blue lands at 4.49:1 — one hundredth under AA. On white it is
                4.83:1, and a solid outline button reads better in the bar anyway. */}
            <Button
              onClick={() => navigate("/platform/login")}
              variant="outline"
              className="cq-cta--ghost h-9 shrink-0 rounded-xl border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-1.5 text-[12px] text-[var(--codiq-accent)] sm:h-10 sm:px-3 sm:text-sm"
            >
              لوحة المنصة
            </Button>
            {/* The late CTA (Shopify pattern): «ابدأ مجاناً» stays reachable from
                anywhere once the hero's own pair has scrolled away. Hidden below
                `sm` — the wrapped two-line bar has no room for a fourth target. */}
            <Button
              onClick={() => scrollToSection("signup")}
              data-shown={navCtaShown ? "true" : "false"}
              aria-hidden={navCtaShown ? undefined : "true"}
              tabIndex={navCtaShown ? undefined : -1}
              className="cq-nav-cta cq-cta hidden h-9 shrink-0 rounded-xl bg-[var(--codiq-accent)] px-3 text-[12px] font-bold text-white hover:bg-[var(--codiq-accent-hover)] sm:inline-flex sm:h-10 sm:text-sm"
            >
              ابدأ مجاناً
            </Button>
          </nav>
        </div>
      </header>

      {/* 2 ------------------------------------------- hero: one idea, product beneath */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-40 h-[560px] bg-[radial-gradient(62%_60%_at_50%_0%,rgba(30,111,219,0.11),rgba(30,111,219,0))]"
        />
        <div className="relative mx-auto max-w-6xl px-5 pb-16 pt-10 text-center lg:pb-20 lg:pt-16">
          <Reveal>
            <p className="inline-flex items-center gap-2 rounded-full border border-[#DCE8FA] bg-[var(--codiq-accent-soft)] px-4 py-1.5 text-xs font-bold text-[var(--codiq-accent-hover)]">
              <LayoutGrid className="h-3.5 w-3.5" /> منصة عراقية لبناء المتاجر الإلكترونية
            </p>
          </Reveal>
          <Reveal delay={90}>
            <h1 className="mx-auto mt-5 max-w-3xl text-[2.05rem] font-bold leading-[1.32] tracking-[-0.035em] text-[#15233E] sm:text-[3.4rem] sm:leading-[1.18]">
              أطلق متجرك الإلكتروني في العراق{" "}
              <span className="whitespace-nowrap text-[var(--codiq-accent)]">خلال دقائق</span>
            </h1>
          </Reveal>
          <Reveal delay={170}>
            <p className="mx-auto mt-5 max-w-2xl text-[15px] leading-8 text-[var(--codiq-text-secondary)] sm:text-[17px] sm:leading-9">
              كل ما تحتاجه لتبيع في العراق — من رفع أول منتج حتى تحصيل ثمنه — في منصة واحدة
              بالعربية: متاجر متعددة، فريق بصلاحيات دقيقة، إشعارات موثوقة، ومالية شفافة بسجل غير
              قابل للتلاعب.
            </p>
          </Reveal>
          <Reveal delay={250}>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Button
                onClick={() => scrollToSection("signup")}
                className="cq-cta rounded-2xl bg-[var(--codiq-accent)] px-8 py-6 text-base font-bold text-white hover:bg-[var(--codiq-accent-hover)]"
              >
                ابدأ مجاناً <ArrowLeft className="mr-2 h-5 w-5" />
              </Button>
              <Button
                variant="outline"
                onClick={() => scrollToSection("pricing")}
                className="cq-cta--ghost rounded-2xl border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-8 py-6 text-base font-bold text-[#33435D]"
              >
                شاهد الأسعار
              </Button>
            </div>
          </Reveal>
          <Reveal delay={320}>
            <p className="mt-6 text-[13px] font-semibold leading-7 text-[#63718A]">
              بلا بطاقة ائتمان · واجهة عربية كاملة RTL · الدفع عند الاستلام جاهز من أول يوم
            </p>
          </Reveal>
          {/* The product, HUGE, as the hero's only imagery — Apple's product-page
              grammar. ONE instance; `frames` follows the live media query instead
              of mounting a hidden duplicate. `data-cq-onscreen` parks the device
              float + screen-cycle keyframes once the hero scrolls away. */}
          <Reveal delay={380} className="mx-auto mt-12 w-full max-w-[920px]">
            <div ref={heroDevices.ref} data-cq-onscreen={heroDevices.visible ? "true" : "false"}>
              <DeviceShowcase frames={wide ? 2 : 4} className="h-auto w-full" />
            </div>
          </Reveal>
        </div>
      </section>

      {/* 3 --------------------------- product-story: one sticky stage, three beats */}
      <section
        id="product"
        className="border-y border-[var(--codiq-border)] bg-[var(--codiq-surface)]"
      >
        <div className="mx-auto max-w-6xl px-5 py-20 lg:py-28">
          <Reveal className="mx-auto max-w-2xl text-center">
            <h2 className="text-[1.8rem] font-bold tracking-[-0.03em] text-[#15233E] sm:text-[2.5rem]">
              متجر أمام زبونك. لوحة تحكم خلفه.
            </h2>
            <p className="mt-4 text-[15px] leading-8 text-[var(--codiq-text-secondary)]">
              وبينهما دورة حياة طلب واحدة يفرضها الخادم على الجميع — لا استثناءات ولا حالات مخفية.
            </p>
          </Reveal>

          {theater ? (
            /* The Apple pattern, CSS-only: the stage holds the viewport with
               `position: sticky` while the three beats scroll past; each beat's
               reveal flips `data-stage` and the panels cross-fade. No pinning
               library, no scroll math, logical properties throughout — the grid
               mirrors correctly in RTL (text column = inline start = right). */
            <div className="mt-16 grid grid-cols-2 items-start gap-16">
              <div className="flex flex-col gap-[36vh] pb-[16vh] pt-[4vh]">
                {STORY_BEATS.map((beat, index) => (
                  <div key={beat.title} className="max-w-[440px]">
                    {beatText(index)}
                  </div>
                ))}
              </div>
              <div className="sticky self-start" style={{ insetBlockStart: "96px" }}>
                <div className="cq-stage" data-stage={activeStage}>
                  <div className="cq-stage__panel cq-stage__panel--0">{beatPanel(0)}</div>
                  <div className="cq-stage__panel cq-stage__panel--1">{beatPanel(1)}</div>
                  <div className="cq-stage__panel cq-stage__panel--2">{beatPanel(2)}</div>
                </div>
              </div>
            </div>
          ) : (
            /* Below lg AND under reduced motion: the finished state — three
               plain stacked rows, each panel static beside its text. */
            <div className="mt-14 space-y-16">
              {STORY_BEATS.map((beat, index) => (
                <div key={beat.title} className="grid items-center gap-8 lg:grid-cols-2 lg:gap-14">
                  <div>{beatText(index)}</div>
                  <div>{beatPanel(index)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* 4 --------------------------------------- pillars: a ruled type ledger */}
      <section className="mx-auto max-w-4xl px-5 pt-20 lg:pt-28">
        <Reveal className="mx-auto max-w-2xl text-center">
          <h2 className="text-[1.8rem] font-bold tracking-[-0.03em] text-[#15233E] sm:text-[2.5rem]">
            يفرضها الخادم. لا الواجهة.
          </h2>
          <p className="mt-4 text-[15px] leading-8 text-[var(--codiq-text-secondary)]">
            أربع ركائز تعمل تحت كل شاشة تراها في اللوحة.
          </p>
        </Reveal>
        <div className="mt-12">
          {PILLARS.map((pillar, index) => (
            <Reveal key={pillar.title} delay={index * 80}>
              <div
                className={`grid gap-2 py-7 sm:grid-cols-[220px_1fr] sm:gap-10 ${index > 0 ? "border-t border-[var(--codiq-border)]" : ""}`}
              >
                <p className="text-[1.15rem] font-bold leading-7 tracking-[-0.02em] text-[#15233E]">
                  {pillar.title}
                </p>
                <p className="text-[15px] leading-8 text-[var(--codiq-text-secondary)]">
                  {pillar.text}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* 5 ---------------- proof band: real numbers + payment honesty, one card */}
      <section className="mx-auto max-w-6xl px-5 pt-20 lg:pt-28">
        <div className="grid gap-12 rounded-[32px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-7 py-10 shadow-[0_16px_44px_rgba(31,55,98,0.05)] lg:grid-cols-[1.1fr_0.9fr] lg:gap-14 lg:px-12 lg:py-14">
          <div>
            <Reveal>
              <h2 className="text-[1.6rem] font-bold tracking-[-0.03em] text-[#15233E] sm:text-[2.1rem]">
                أرقام من داخل المنصة، لا من إعلان.
              </h2>
            </Reveal>
            <div className="mt-9 grid grid-cols-2 gap-x-6 gap-y-8">
              {/* Tamyiz again, by hand because these three counts are compile-time
                  constants rather than payload values: 18 and 11 take مفرد منصوب
                  («محافظةً», «صلاحيةً») and 8 takes جمع قلة («حالات»). */}
              <StatCounter
                delay={0}
                value={18}
                label="محافظةً عراقيةً مهيأةً لأسعار التوصيل في كل متجر جديد"
              />
              <StatCounter
                delay={90}
                value={8}
                label="حالات في دورة حياة الطلب بانتقالات يفرضها الخادم"
              />
              <StatCounter
                delay={180}
                value={11}
                label="صلاحيةً دقيقةً تُمنح أو تُمنع لكل موظف على حدة"
              />
              <StatCounter
                delay={270}
                value={lowestCommission}
                suffix={PERCENT_SIGN}
                decimals={lowestCommission !== null && !Number.isInteger(lowestCommission) ? 1 : 0}
                label="أقل عمولة معلنة على الطلبات المكتملة — تُقرأ الآن من خطط المنصة"
              />
            </div>
            <ul className="mt-9 grid gap-3 border-t border-[var(--codiq-neutral-soft)] pt-7">
              {TRUST_FACTS.slice(0, 2).map((fact, index) => (
                <Reveal
                  as="li"
                  key={fact}
                  delay={index * 80}
                  className="flex items-start gap-2.5 text-[13.5px] leading-7 text-[#4E5D78]"
                >
                  <span className="mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]">
                    <Check size={12} strokeWidth={3} />
                  </span>
                  {fact}
                </Reveal>
              ))}
            </ul>
          </div>

          <div className="space-y-7">
            <div>
              <p className="mb-3 text-[13px] font-bold text-[#3C6B52]">متاح الآن في كل متجر</p>
              <div className="cq-pay cq-pay--live rounded-[20px] border border-[#CDE7D9] bg-[#F3FBF6] p-4">
                <div className="flex items-center gap-3">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-[var(--codiq-surface)] text-[var(--codiq-success)]">
                    <Banknote className="h-5 w-5" />
                  </span>
                  <p className="min-w-0 flex-1 text-[15px] font-bold text-[#1C4532]">
                    الدفع عند الاستلام
                  </p>
                  <span className="shrink-0 rounded-full bg-[var(--codiq-success)] px-3 py-1 text-[11px] font-bold text-white">
                    متاح الآن
                  </span>
                </div>
                <p className="mt-2.5 text-[12.5px] leading-6 text-[#3E6B54] sm:ps-14">
                  مفعّل في متجرك منذ لحظة إنشائه، بأسعار توصيل تضبطها لكل محافظة.
                </p>
              </div>
            </div>

            <div>
              <p className="mb-3 text-[13px] font-bold text-[#63718A]">قيد العمل — لم يُفعّل بعد</p>
              {/* Neutral typographic chips, not brand logos: CODIQ holds no
                  brand-asset licence, and none of these is live yet. */}
              <ul className="grid gap-2.5">
                {UPCOMING_PAYMENTS.map((method, index) => (
                  <Reveal as="li" key={method.name} delay={index * 80}>
                    <div className="cq-pay flex h-full items-center gap-2.5 rounded-2xl border border-dashed border-[var(--codiq-border-strong)] bg-[var(--codiq-surface-sunken)] px-3.5 py-3">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-[var(--codiq-neutral-soft)] text-[#79889F]">
                        <method.icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 text-[13px] font-bold text-[var(--codiq-text-secondary)]">
                        {method.name}
                      </span>
                      <span className="ms-auto shrink-0 rounded-full bg-[var(--codiq-neutral-soft)] px-2 py-0.5 text-[10px] font-bold text-[#5C6B85]">
                        قريباً
                      </span>
                    </div>
                  </Reveal>
                ))}
              </ul>
              {/*
                The disclaimer, not a footnote.

                «قيد العمل» above is what qualifies the chips; this sentence is
                what qualifies the promise — no gateway agreement is signed. It
                keeps its own bordered card, its alert icon, 13.5px type at
                8.41:1, so the qualification is read as easily as the claim it
                qualifies. Same testid, same legal wording, always on screen
                whenever the chips are.
              */}
              <p
                data-testid="payments-disclaimer"
                className="mt-4 flex items-start gap-2.5 rounded-2xl border border-[#EBD9B4] bg-[#FFFBF0] px-4 py-3.5 text-[13.5px] font-semibold leading-7 text-[#3F4E67]"
              >
                <TriangleAlert
                  aria-hidden="true"
                  className="mt-1 h-4 w-4 shrink-0 text-[#8A6620]"
                />
                <span>
                  الدفع الإلكتروني — كي كارد، زين كاش، والمحافظ العراقية — ضمن خطة تطوير المنصة و
                  <strong className="font-bold">لم تُوقَّع اتفاقياته بعد</strong>، فلا تظهر هذه
                  الخيارات لزبائنك اليوم.
                </span>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 6 --------------------------------------------- how: a typographic rail */}
      <section id="how" className="mx-auto max-w-6xl px-5 pt-20 lg:pt-28">
        <Reveal className="mx-auto max-w-2xl text-center">
          <h2 className="text-[1.8rem] font-bold tracking-[-0.03em] text-[#15233E] sm:text-[2.5rem]">
            من التسجيل إلى أول طلب. جلسة واحدة.
          </h2>
          <p className="mt-4 text-[15px] leading-8 text-[var(--codiq-text-secondary)]">
            كل خطوة منها شاشة موجودة اليوم في المنصة.
          </p>
        </Reveal>
        <div
          ref={howRail.ref}
          data-revealed={howRail.revealed ? "true" : "false"}
          className="cq-steprail mt-12"
        >
          {/* The connecting rule draws in from the start side (right, in RTL) —
              compositor-only scaleX, painted full under reduced motion. */}
          <div
            aria-hidden="true"
            className="cq-steprail__rule hidden h-0.5 rounded-full bg-[var(--codiq-border-strong)] lg:block"
          />
          <div className="mt-10 grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step, index) => (
              <Reveal key={step.title} delay={index * 100}>
                <div>
                  <p
                    className="text-[3.2rem] font-bold leading-none tracking-[-0.03em] text-[var(--codiq-text-muted)] opacity-40"
                    dir="ltr"
                    style={{ textAlign: "start" }}
                  >
                    {STEP_NUMERALS[index]}
                  </p>
                  <p className="mt-4 text-[15px] font-bold text-[#20304C]">{step.title}</p>
                  <p className="mt-2 text-[13px] leading-7 text-[var(--codiq-text-secondary)]">
                    {step.text}
                  </p>
                  {index === STEPS.length - 1 ? (
                    <button
                      type="button"
                      onClick={() => scrollToSection("signup")}
                      className="mt-3 inline-flex items-center gap-1.5 text-[14px] font-bold text-[var(--codiq-accent-hover)] transition hover:text-[var(--codiq-accent)]"
                    >
                      ابدأ الآن <ArrowLeft className="h-4 w-4" />
                    </button>
                  ) : null}
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* 7 ---------------------------------------------------------------- pricing */}
      <PricingSection
        plans={plans}
        plansState={plansState}
        onRetryPlans={() => void loadPlans()}
        merchantSession={merchantSession}
        ctaBusy={ctaBusy}
        onChoose={choosePlanAsVisitor}
        onUpgrade={(plan) => void requestUpgradeAsMerchant(plan)}
      />

      {/* 8 ------------------------------------------------ closing CTA + registration */}
      <section id="signup" className="relative mt-20 overflow-hidden lg:mt-28">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_80%_at_50%_0%,rgba(30,111,219,0.16),rgba(30,111,219,0))]"
        />
        <div className="relative mx-auto max-w-3xl px-5 py-20">
          <Reveal className="text-center">
            <h2 className="text-[1.9rem] font-bold leading-[1.35] tracking-[-0.035em] text-[#15233E] sm:text-[2.6rem]">
              ابدأ تجارتك اليوم.
            </h2>
            <p className="mx-auto mt-4 max-w-lg text-[15px] leading-8 text-[var(--codiq-text-secondary)]">
              أنشئ حسابك ومتجرك الأول في خطوة واحدة — تبدأ على الخطة المجانية وتستطيع الترقية متى
              شئت.
            </p>
          </Reveal>
          <Reveal delay={100} className="mt-10">
            <div className="rounded-[28px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-8 shadow-[0_26px_64px_rgba(31,55,98,0.10)] sm:p-10">
              <h3 className="text-xl font-bold tracking-[-0.03em] text-[#15233E]">
                سجّل تاجراً جديداً
              </h3>
              {selectedPlan ? (
                <p
                  data-testid="selected-plan-chip"
                  className="mt-4 inline-flex items-center gap-2 rounded-full bg-[var(--codiq-accent-soft)] px-4 py-1.5 text-xs font-bold text-[var(--codiq-accent-hover)]"
                >
                  الخطة المختارة: {selectedPlan.name}
                  {/* The glyph stays 14px, but the hit area is 24×24 with a
                      negative margin so the chip does not grow around it — a 16px
                      target is unusable with a thumb. */}
                  <button
                    type="button"
                    onClick={() => setSelectedPlan(null)}
                    aria-label="إلغاء اختيار الخطة"
                    className="-my-1 -ms-1 grid h-6 w-6 shrink-0 place-items-center rounded-full text-[var(--codiq-accent-hover)]/80 transition hover:bg-white/70 hover:text-[var(--codiq-accent-hover)]"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </p>
              ) : null}
              <div className="mt-6">
                <SignupForm defaultPlan={defaultPlan} selectedPlan={selectedPlan} />
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* 9 ----------------------------------------------------------------- footer */}
      <footer className="border-t border-[var(--codiq-border)] bg-[var(--codiq-surface)]">
        <div className="mx-auto max-w-6xl px-5 py-9">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div dir="ltr" className="flex items-center gap-2.5">
              <BrandMark className="h-8 w-8 rounded-lg" />
              <p className="text-sm font-bold tracking-[-0.03em] text-[var(--codiq-text)]">Codiq</p>
              <p
                className="text-xs font-semibold leading-6 text-[var(--codiq-text-secondary)]"
                dir="rtl"
              >
                منصة المتاجر الإلكترونية في العراق
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-[#63718A]">
              {/* PC-1: the three contact links are the owner's to change from his
                  dashboard («حسابي ومعلومات التواصل»), not a pull request. */}
              <a
                className="transition hover:text-[var(--codiq-accent)]"
                href={`mailto:${contact.email}`}
                dir="ltr"
                data-testid="footer-contact-email"
              >
                {contact.email}
              </a>
              <a
                className="transition hover:text-[var(--codiq-accent)]"
                href={`tel:${contact.phone}`}
                dir="ltr"
                data-testid="footer-contact-phone"
              >
                {formatContactPhone(contact.phone)}
              </a>
              <a
                className="transition hover:text-[var(--codiq-accent)]"
                href={whatsappLink(contact.whatsapp)}
                target="_blank"
                rel="noreferrer"
                data-testid="footer-contact-whatsapp"
              >
                واتساب
              </a>
              {/* The staff door left this page entirely (owner decision,
                  2026-09-01, completing P27-18): a staff member is APPOINTED by
                  his merchant and arrives by the invitation link the team screen
                  now hands out — the public page's audience is the prospective
                  merchant. The /staff/login route itself stays alive; deleting
                  the link was only safe once StoreTeamManager started giving the
                  merchant that link to send. */}
            </div>
          </div>
          <p className="mt-7 border-t border-[var(--codiq-neutral-soft)] pt-5 text-center text-xs text-[#63718A]">
            جميع الحقوق محفوظة © <span dir="ltr">{copyrightYears}</span> Codiq
          </p>
        </div>
      </footer>
    </div>
  );
}
