import type { LucideIcon } from "lucide-react";
import {
  BellRing,
  Blocks,
  ChartNoAxesCombined,
  CreditCard,
  FileCheck2,
  Globe2,
  Languages,
  Landmark,
  LockKeyhole,
  Network,
  Search,
  ServerCog,
  ShieldCheck,
  SlidersHorizontal,
  UsersRound,
  Workflow,
} from "lucide-react";

export type ArchitectureLayer = {
  id: string;
  label: string;
  shortLabel: string;
  tone: "blue" | "violet" | "teal" | "amber" | "slate";
  technologies: string[];
  responsibility: string;
  challenge: string;
};

export type RoadmapStage = {
  phase: number;
  title: string;
  group: "product" | "readiness";
  emphasis: string;
  status: "مواءمة مطلوبة" | "قرار مالك مطلوب" | "مخططة" | "بوابة إلزامية";
  risk: "عالٍ" | "متوسط" | "منهجي";
  icon: LucideIcon;
  challenge: string;
  safeguard: string;
  gate: string;
};

export const architectureLayers: ArchitectureLayer[] = [
  {
    id: "experience",
    label: "تجربة المستخدم",
    shortLabel: "الواجهة",
    tone: "blue",
    technologies: ["React 19", "Vite 7", "TypeScript", "Wouter", "Tailwind v4", "RTL"],
    responsibility:
      "لوحات المالك والتاجر وواجهة Storefront العربية، مع اتصال same-origin إلى REST API.",
    challenge:
      "تطوير theme وi18n وSEO وإتاحة الوصول من دون نقل منطق الأعمال أو التفويض إلى المتصفح.",
  },
  {
    id: "api",
    label: "حدود التطبيق",
    shortLabel: "REST API",
    tone: "violet",
    technologies: ["Node.js", "Express 4", "REST", "Zod", "Multer"],
    responsibility: "مصادقة، تفويض، مسارات متجرية، رفع الصور، ومعالجة أخطاء موحدة تحت /api.",
    challenge: "توحيد versioning وRBAC والـmiddleware من دون كسر العقود الحالية أو عزل المتاجر.",
  },
  {
    id: "domain",
    label: "منطق المجال",
    shortLabel: "الخدمات",
    tone: "teal",
    technologies: ["Services", "Transactions", "Idempotency", "Row locks"],
    responsibility: "السلات، checkout، الحجوزات، تسعير التوصيل، المخزون ودورة الطلبات.",
    challenge:
      "الإبقاء على سلامة التسلسل بين الطلب والحجز والحدث المالي أو الخارجي عند نمو المنصة.",
  },
  {
    id: "data",
    label: "البيانات والعزل",
    shortLabel: "PostgreSQL",
    tone: "amber",
    technologies: ["PostgreSQL", "Neon", "Prisma 6", "Composite FKs", "Triggers"],
    responsibility: "مصدر الحقيقة متعدد المستأجرين؛ store_id والعلاقات المركبة والقيود والمعاملات.",
    challenge:
      "هجرات additive-first، فهارس بحث واقعية، وسجل مالي append-only من دون تراجع في العزل.",
  },
  {
    id: "operations",
    label: "التشغيل والجودة",
    shortLabel: "التشغيل",
    tone: "slate",
    technologies: ["GitHub Actions", "PostgreSQL 16 CI", "Railway", "S3-compatible / R2"],
    responsibility: "بوابة PR وCI، التخزين الكائني، النشر المرحلي، والمراقبة والاستعادة مستقبلاً.",
    challenge: "إثبات staging منفصلة، ثم jobs وalerts وrestore حقيقي قبل إدخال الدفع والتكاملات.",
  },
];

export const roadmapStages: RoadmapStage[] = [
  {
    phase: 12,
    title: "مواءمة Storefront وحساب الزبون",
    group: "product",
    emphasis: "مراجعة فجوة 9B، لا إعادة بناء واجهة موجودة.",
    status: "مواءمة مطلوبة",
    risk: "منهجي",
    icon: Blocks,
    challenge: "حماية checkout الحالي من أي تحسين بصري أو تغيير لسلوك السلة.",
    safeguard: "ربط كل فجوة بسيناريو قبول وعقد API واختبار متجرين.",
    gate: "اعتماد سيناريوهات القبول والفجوات المثبتة فقط.",
  },
  {
    phase: 13,
    title: "Store Switcher وإنشاء المتاجر",
    group: "product",
    emphasis: "تعدد متاجر التاجر مع بقاء الجلسة مقيدة بمتجر.",
    status: "قرار مالك مطلوب",
    risk: "عالٍ",
    icon: Network,
    challenge: "تبديل السياق بلا توسيع صامت لصلاحية جلسة التاجر.",
    safeguard: "إصدار جلسة جديدة لكل متجر مع اختبار 403 للتاجر نفسه على متجر غير مختار.",
    gate: "تحديد الحد المؤقت للمتاجر وسياسة المتجر المعطل.",
  },
  {
    phase: 14,
    title: "Staff والصلاحيات الدقيقة",
    group: "product",
    emphasis: "هويات staff مستقلة، memberships وpermissions وnavigation مركزي.",
    status: "قرار مالك مطلوب",
    risk: "عالٍ",
    icon: UsersRound,
    challenge: "Retrofit لكل endpoint حساس دون ثغرة permission أو IDOR.",
    safeguard: "Permission resolver واحد ومصفوفة موجب/سالب تغطي المسارات القائمة والجديدة.",
    gate: "ADR لنموذج staff، قائمة permissions، وتعريف الأدوار الحزمية.",
  },
  {
    phase: 15,
    title: "Outbox والإشعارات",
    group: "product",
    emphasis: "أحداث ذرية وعامل إرسال قابل لإعادة المحاولة.",
    status: "قرار مالك مطلوب",
    risk: "عالٍ",
    icon: BellRing,
    challenge: "التكرار أو الفقد عند فشل مزود خارجي أو إعادة محاولة العامل.",
    safeguard: "Outbox في نفس المعاملة، worker مستقل، idempotency وdead-letter queue.",
    gate: "اختيار مزود الرسائل الأول وبيئة تشغيل العامل.",
  },
  {
    phase: 16,
    title: "الخطط والاشتراكات",
    group: "product",
    emphasis: "Feature Gating خادمي وحدود قابلة للقياس.",
    status: "قرار مالك مطلوب",
    risk: "عالٍ",
    icon: SlidersHorizontal,
    challenge: "منع تجاوز الحد بطلبات متزامنة أو عبر API مباشر.",
    safeguard: "Entitlement resolver موحد واختبارات تزامن وحدود وbackfill آمن.",
    gate: "تعريف الخطط والحدود والأسعار الاسترشادية.",
  },
  {
    phase: 17,
    title: "التسويات والعمولات والنطاقات",
    group: "product",
    emphasis: "سجل مالي immutable وحل Host إلى متجر.",
    status: "قرار مالك مطلوب",
    risk: "عالٍ",
    icon: Landmark,
    challenge: "منع قيد مالي مكرر أو توجيه نطاق إلى متجر خاطئ.",
    safeguard: "Ledger append-only، قيود فريدة، Trigger وHost resolver محكوم واختبارات DNS/TLS.",
    gate: "نافذة الإرجاع، نسب العمولة وسياسة التسجيل الذاتي.",
  },
  {
    phase: 18,
    title: "التدقيق المعماري وسجل الدين",
    group: "readiness",
    emphasis: "توثيق واقع النظام قبل أي refactor كبير.",
    status: "بوابة إلزامية",
    risk: "منهجي",
    icon: FileCheck2,
    challenge: "تحويل الانطباعات إلى سجل قابل للتنفيذ بأدلة وقياس.",
    safeguard: "Master Architecture وDebt Register مرتبطان بملف أو اختبار أو metric.",
    gate: "اعتماد ترتيب أولويات سجل الدين من المالك.",
  },
  {
    phase: 19,
    title: "الأمان والعزل الفعلي",
    group: "readiness",
    emphasis: "OWASP/ASVS واختبارات هجوم على النظام الموسع.",
    status: "بوابة إلزامية",
    risk: "عالٍ",
    icon: ShieldCheck,
    challenge: "اختبار files/jobs/domains/staff وليس API الحالية فقط.",
    safeguard: "تقارير قبل/بعد، gitleaks للتاريخ، واختبارات XSS وfixation وbrute-force.",
    gate: "لا توجد مشكلة Critical مفتوحة قبل العبور.",
  },
  {
    phase: 20,
    title: "البيانات وAPI v1 والبحث",
    group: "readiness",
    emphasis: "OpenAPI، pagination، error contracts وبحث PostgreSQL.",
    status: "قرار مالك مطلوب",
    risk: "متوسط",
    icon: Search,
    challenge: "إصدار /api/v1 بلا كسر مسارات Storefront أو عقود المتصفح.",
    safeguard: "خطة انتقال متوافقة وcontract tests وEXPLAIN على بيانات واقعية.",
    gate: "اعتماد عقد API v1 وسياسة التوافق العكسي.",
  },
  {
    phase: 21,
    title: "Design System وTheme المتاجر",
    group: "readiness",
    emphasis: "Tokens مركزية وترحيل واجهة تدريجي.",
    status: "مخططة",
    risk: "متوسط",
    icon: ChartNoAxesCombined,
    challenge: "Refactor بلا big-bang ومعالجة تحذير حجم bundle بقياس حقيقي.",
    safeguard: "Migration feature-by-feature وvisual regression وإثبات theme بتغيير tokens فقط.",
    gate: "ترتيب refactor وفق سجل الدين وB-12.",
  },
  {
    phase: 22,
    title: "i18n وWCAG وSEO",
    group: "readiness",
    emphasis: "عربي/إنجليزي، RTL/LTR، إتاحة وفهرسة المتاجر.",
    status: "قرار مالك مطلوب",
    risk: "متوسط",
    icon: Languages,
    challenge: "اللغة والاتجاه وcanonical وstructured data في SPA متعددة المتاجر.",
    safeguard: "Message catalog، اختبارات اتجاه، تدفقات keyboard وmetadata وسياسة noindex.",
    gate: "تحديد اللغات وسياسة فهرسة المتاجر.",
  },
  {
    phase: 23,
    title: "الأداء والحمل",
    group: "readiness",
    emphasis: "قياس p50/p95/p99 وحمل checkout متزامن.",
    status: "قرار مالك مطلوب",
    risk: "عالٍ",
    icon: Workflow,
    challenge: "التوازن بين Serializable/locks وسرعة الاستجابة عند مخزون محدود.",
    safeguard: "Load profile متدرج، تتبع retries، وصحة نتائج المنافسة قبل throughput.",
    gate: "إقرار performance budgets وأهداف الحمل.",
  },
  {
    phase: 24,
    title: "التشغيل والمراقبة والاستعادة",
    group: "readiness",
    emphasis: "Logs منظمة، alerts، restore، caches وwebhooks.",
    status: "قرار مالك مطلوب",
    risk: "عالٍ",
    icon: ServerCog,
    challenge: "إثبات الاستعادة والخدمة المتأثرة بدلاً من افتراض نجاح النسخ.",
    safeguard: "Restore على فرع معزول، RPO/RTO مقاسان وrequest/store context في logs.",
    gate: "اختيار observability وخطة RPO/RTO قابلة للمراجعة.",
  },
  {
    phase: 25,
    title: "الدفع والشحن والفوترة",
    group: "readiness",
    emphasis: "تكاملات مالية وخارجية خلف Provider abstractions.",
    status: "قرار مالك مطلوب",
    risk: "عالٍ",
    icon: CreditCard,
    challenge: "Webhooks مكررة أو متأخرة وحالة دفع/شحنة لا تثبت من المتصفح.",
    safeguard: "تحقق توقيع، provider idempotency، event uniqueness وsandbox reconciliation.",
    gate: "اختيار بوابة الدفع وشركة التوصيل الأوليين.",
  },
  {
    phase: 26,
    title: "التدقيق النهائي وإعلان الجاهزية",
    group: "readiness",
    emphasis: "تجميع أدلة الاختبار والتشغيل والأمن كملف جاهزية واحد.",
    status: "بوابة إلزامية",
    risk: "منهجي",
    icon: Globe2,
    challenge: "تحويل المعرفة الموزعة إلى وثائق وتشغيل قابل للتدقيق الخارجي.",
    safeguard: "مصفوفة Evidence لكل معيار وقائمة استثناءات مقبولة بقرار المالك.",
    gate: "اعتماد final production audit فقط بعد استيفاء أو توثيق كل بند.",
  },
];

export const engineeringGates = [
  { id: "scope", label: "نطاق واضح", detail: "وثيقة قبول وحدود صريحة قبل لمس الكود." },
  { id: "branch", label: "فرع وPR", detail: "تغيير معزول؛ لا دفع مباشر إلى main." },
  {
    id: "proof",
    label: "دليل واختبارات",
    detail: "اختبارات إيجابية وسلبية وIDOR أو تزامن عند الحاجة.",
  },
  { id: "review", label: "مراجعة المالك", detail: "تقرير، مراجعة خارجية وموافقة صريحة قبل الدمج." },
];

export const engineeringFacts = {
  completedFoundation: "المراحل 1–11A",
  blockedCurrent: "11B · staging غير مؤكدة",
  upcomingCount: roadmapStages.length,
  invariant: "كل قراءة وكتابة متجرية مقيّدة بسياق store_id",
};
