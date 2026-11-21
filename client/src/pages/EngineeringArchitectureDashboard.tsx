import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleDotDashed,
  Cloud,
  Database,
  GitPullRequest,
  Layers3,
  LockKeyhole,
  Menu,
  Network,
  PanelTop,
  Route,
  ShieldCheck,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  architectureLayers,
  engineeringFacts,
  engineeringGates,
  roadmapStages,
  type ArchitectureLayer,
  type RoadmapStage,
} from "@/lib/engineering-roadmap-data";

type TimelineFilter = "all" | "product" | "readiness";

const toneClasses: Record<
  ArchitectureLayer["tone"],
  { ring: string; surface: string; icon: string; line: string }
> = {
  blue: {
    ring: "border-[#BFD7FF]",
    surface: "bg-[var(--codiq-accent-soft)]",
    icon: "text-[var(--codiq-accent)]",
    line: "bg-[#6EA8FF]",
  },
  violet: {
    ring: "border-[#D7C8FF]",
    surface: "bg-[#F5F0FF]",
    icon: "text-[#7351D9]",
    line: "bg-[#AA90FF]",
  },
  teal: {
    ring: "border-[#BDEDE4]",
    surface: "bg-[#EEFCF8]",
    icon: "text-[#11816D]",
    line: "bg-[#57BDAA]",
  },
  amber: {
    ring: "border-[#F8D99B]",
    surface: "bg-[var(--codiq-warning-soft)]",
    icon: "text-[#A56700]",
    line: "bg-[#E7B451]",
  },
  slate: {
    ring: "border-[#D5DDEB]",
    surface: "bg-[var(--codiq-canvas)]",
    icon: "text-[var(--codiq-text-secondary)]",
    line: "bg-[#92A0B7]",
  },
};

const statusClasses: Record<RoadmapStage["status"], string> = {
  "مواءمة مطلوبة": "bg-[var(--codiq-warning-soft)] text-[#9A6200] ring-[#F4D39A]",
  "قرار مالك مطلوب": "bg-[#F1EDFF] text-[#6147B7] ring-[#D6C7FF]",
  مخططة: "bg-[var(--codiq-accent-soft)] text-[#1C66C9] ring-[#BDD7FF]",
  "بوابة إلزامية": "bg-[var(--codiq-success-soft)] text-[#13795D] ring-[#BAE6D4]",
};

const riskClasses: Record<RoadmapStage["risk"], string> = {
  عالٍ: "bg-[var(--codiq-danger-soft)] text-[#B3473A]",
  متوسط: "bg-[var(--codiq-warning-soft)] text-[#946200]",
  منهجي: "bg-[var(--codiq-accent-soft)] text-[#2769BE]",
};

function LayerIcon({ id, className }: { id: string; className?: string }) {
  const icons = {
    experience: PanelTop,
    api: Route,
    domain: Network,
    data: Database,
    operations: Cloud,
  } as const;
  const Icon = icons[id as keyof typeof icons] ?? Layers3;
  return <Icon className={className} strokeWidth={1.9} />;
}

function StatusDot({ state }: { state: "done" | "blocked" | "planned" }) {
  if (state === "done")
    return <CheckCircle2 className="h-4 w-4 text-[#15936D]" aria-hidden="true" />;
  if (state === "blocked")
    return <CircleAlert className="h-4 w-4 text-[#D38A17]" aria-hidden="true" />;
  return <CircleDotDashed className="h-4 w-4 text-[#6B7A92]" aria-hidden="true" />;
}

function ArchitectureMap({
  activeLayer,
  onLayerChange,
}: {
  activeLayer: ArchitectureLayer;
  onLayerChange: (layer: ArchitectureLayer) => void;
}) {
  return (
    <section
      aria-labelledby="architecture-map-title"
      className="rounded-[28px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-5 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-7"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold tracking-[0.12em] text-[var(--codiq-accent)]">
            خريطة حية للحدود
          </p>
          <h2
            id="architecture-map-title"
            className="mt-1 text-xl font-bold tracking-[-0.035em] text-[#15233E]"
          >
            طبقات النظام الحالية
          </h2>
        </div>
        <p className="max-w-sm text-sm leading-6 text-[var(--codiq-text-muted)]">
          اختر طبقة لعرض مسؤوليتها وأصعب تحدٍّ ينتظرها في خارطة التنفيذ.
        </p>
      </div>

      <div className="mt-6 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(250px,0.7fr)]">
        <div className="relative overflow-hidden rounded-[24px] border border-[var(--codiq-border)] bg-[radial-gradient(circle_at_88%_8%,rgba(197,219,255,0.56),transparent_34%),linear-gradient(135deg,#F9FBFF,#F4F7FC)] p-4 sm:p-5">
          <div className="absolute bottom-0 left-8 top-0 w-px bg-gradient-to-b from-transparent via-[#C9D9EE] to-transparent" />
          <div className="relative space-y-3">
            {architectureLayers.map((layer, index) => {
              const tone = toneClasses[layer.tone];
              const active = layer.id === activeLayer.id;
              return (
                <div key={layer.id} className="relative flex gap-3">
                  <div
                    className={`z-10 grid h-9 w-9 shrink-0 place-items-center rounded-xl ${tone.surface} ${tone.icon} ring-1 ${tone.ring}`}
                  >
                    <LayerIcon id={layer.id} className="h-[18px] w-[18px]" />
                  </div>
                  <button
                    type="button"
                    onClick={() => onLayerChange(layer)}
                    className={`group flex min-w-0 flex-1 items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-right transition-all duration-200 active:scale-[0.99] ${active ? `${tone.surface} ${tone.ring} shadow-[0_8px_18px_rgba(40,62,98,0.07)]` : "border-[var(--codiq-surface)] bg-white/75 hover:border-[#D6E3F5] hover:bg-[var(--codiq-surface)]"}`}
                    aria-pressed={active}
                  >
                    <span className="min-w-0">
                      <span
                        className={`block text-sm font-bold ${active ? "text-[#1B3254]" : "text-[#35435B]"}`}
                      >
                        {layer.label}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-[#7A879A]">
                        {layer.technologies.slice(0, 3).join(" · ")}
                      </span>
                    </span>
                    <ChevronLeft
                      className={`h-4 w-4 shrink-0 transition-transform duration-200 ${active ? `${tone.icon} -translate-x-0.5` : "text-[#9BA7B9] group-hover:-translate-x-0.5"}`}
                    />
                  </button>
                  {index < architectureLayers.length - 1 ? (
                    <span className={`absolute right-4 top-9 h-3 w-0.5 ${tone.line}/50`} />
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        <aside
          className={`rounded-[24px] border p-5 ${toneClasses[activeLayer.tone].surface} ${toneClasses[activeLayer.tone].ring}`}
          aria-live="polite"
        >
          <div
            className={`grid h-11 w-11 place-items-center rounded-2xl bg-[var(--codiq-surface)] ${toneClasses[activeLayer.tone].icon} shadow-sm`}
          >
            <LayerIcon id={activeLayer.id} className="h-5 w-5" />
          </div>
          <p className={`mt-5 text-xs font-bold ${toneClasses[activeLayer.tone].icon}`}>
            الطبقة المحددة
          </p>
          <h3 className="mt-1 text-lg font-bold text-[#1C2D49]">{activeLayer.label}</h3>
          <p className="mt-3 text-sm leading-7 text-[var(--codiq-text-secondary)]">
            {activeLayer.responsibility}
          </p>
          <div className="mt-5 rounded-2xl bg-white/75 p-3.5">
            <p className="flex items-center gap-2 text-xs font-bold text-[#35435B]">
              <AlertTriangle className="h-4 w-4 text-[#D18A17]" /> التحدي القادم
            </p>
            <p className="mt-2 text-xs leading-6 text-[#61708A]">{activeLayer.challenge}</p>
          </div>
          <div className="mt-5 flex flex-wrap gap-1.5">
            {activeLayer.technologies.map((technology) => (
              <span
                key={technology}
                className="rounded-full bg-[var(--codiq-surface)] px-2.5 py-1 text-[11px] font-semibold text-[#4D5B72] shadow-sm"
              >
                {technology}
              </span>
            ))}
          </div>
        </aside>
      </div>
    </section>
  );
}

function StageCard({
  stage,
  selected,
  onSelect,
}: {
  stage: RoadmapStage;
  selected: boolean;
  onSelect: (stage: RoadmapStage) => void;
}) {
  const Icon = stage.icon;
  return (
    <button
      type="button"
      onClick={() => onSelect(stage)}
      className={`group relative w-full overflow-hidden rounded-[22px] border p-4 text-right transition-all duration-200 active:scale-[0.99] ${selected ? "border-[#9FC5FF] bg-[var(--codiq-canvas)] shadow-[0_12px_28px_rgba(41,95,177,0.1)]" : "border-[var(--codiq-border)] bg-[var(--codiq-surface)] hover:-translate-y-0.5 hover:border-[#C9DAF0] hover:shadow-[0_12px_26px_rgba(31,55,98,0.065)]"}`}
      aria-pressed={selected}
    >
      <span
        className={`absolute left-0 top-0 h-full w-1 ${selected ? "bg-[var(--codiq-accent)]" : "bg-transparent"}`}
      />
      <span className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 items-center gap-3">
          <span
            className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${selected ? "bg-[#DCEBFF] text-[var(--codiq-accent)]" : "bg-[var(--codiq-canvas)] text-[#61708A]"}`}
          >
            <Icon className="h-[18px] w-[18px]" strokeWidth={1.9} />
          </span>
          <span className="min-w-0">
            <span className="block text-[11px] font-bold text-[var(--codiq-accent)]">
              المرحلة {stage.phase}
            </span>
            <span className="mt-0.5 block text-sm font-bold leading-5 text-[#283752]">
              {stage.title}
            </span>
          </span>
        </span>
        <ChevronLeft
          className={`mt-1 h-4 w-4 shrink-0 ${selected ? "text-[var(--codiq-accent)]" : "text-[#A1ADBD]"}`}
        />
      </span>
      <span className="mt-3 block text-xs leading-5 text-[var(--codiq-text-muted)]">
        {stage.emphasis}
      </span>
      <span className="mt-3 flex flex-wrap gap-1.5">
        <span
          className={`rounded-full px-2 py-1 text-[10px] font-bold ring-1 ring-inset ${statusClasses[stage.status]}`}
        >
          {stage.status}
        </span>
        <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${riskClasses[stage.risk]}`}>
          مخاطر {stage.risk}
        </span>
      </span>
    </button>
  );
}

export default function EngineeringArchitectureDashboard() {
  const [, navigate] = useLocation();
  const [activeLayer, setActiveLayer] = useState(architectureLayers[0]);
  const [activeStage, setActiveStage] = useState(roadmapStages[0]);
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>("all");
  const [mobileOpen, setMobileOpen] = useState(false);
  const visibleStages = useMemo(
    () =>
      timelineFilter === "all"
        ? roadmapStages
        : roadmapStages.filter((stage) => stage.group === timelineFilter),
    [timelineFilter]
  );

  return (
    <div dir="rtl" className="min-h-screen bg-[var(--codiq-canvas)] text-[#17233A]">
      <header className="sticky top-0 z-40 border-b border-[var(--codiq-border)] bg-white/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4 px-5 py-3.5 sm:px-8 lg:px-10">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[var(--codiq-accent)] text-white shadow-[0_10px_20px_rgba(30,111,219,0.25)]">
              <Layers3 className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-lg font-bold tracking-[-0.04em] text-[#15233E]">
                Codiq{" "}
                <span className="font-medium text-[var(--codiq-text-muted)]">· مسار الهندسة</span>
              </p>
              <p className="hidden text-xs text-[#7B889C] sm:block">
                خريطة المعمارية والبوابات التنفيذية
              </p>
            </div>
          </div>
          <div className="hidden items-center gap-2 md:flex">
            <span className="rounded-full bg-[var(--codiq-success-soft)] px-3 py-1.5 text-xs font-bold text-[#13795D]">
              <CheckCircle2 className="ml-1 inline h-3.5 w-3.5" />
              {engineeringFacts.completedFoundation}
            </span>
            <span className="rounded-full bg-[var(--codiq-warning-soft)] px-3 py-1.5 text-xs font-bold text-[#9A6200]">
              <CircleAlert className="ml-1 inline h-3.5 w-3.5" />
              {engineeringFacts.blockedCurrent}
            </span>
          </div>
          <button
            type="button"
            onClick={() => navigate("/")}
            className="inline-flex items-center gap-2 rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2 text-xs font-bold text-[#40506A] transition-colors hover:bg-[var(--codiq-canvas)] active:scale-[0.97]"
          >
            <ArrowLeft className="h-4 w-4" />{" "}
            <span className="hidden sm:inline">الصفحة الرئيسية</span>
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] px-5 py-7 sm:px-8 lg:px-10 lg:py-10">
        <section className="relative overflow-hidden rounded-[32px] border border-[#D7E6FB] bg-[#142C50] px-6 py-7 text-white shadow-[0_20px_50px_rgba(26,53,94,0.19)] sm:px-9 sm:py-9">
          <div className="absolute -left-20 -top-28 h-64 w-64 rounded-full bg-[#3692FF]/30 blur-3xl" />
          <div className="absolute bottom-0 right-1/4 h-52 w-52 rounded-full bg-[#4FE2C0]/15 blur-3xl" />
          <div className="relative grid gap-8 xl:grid-cols-[minmax(0,1.2fr)_minmax(390px,0.8fr)] xl:items-end">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-bold text-[#D4E6FF]">
                <Sparkles className="h-3.5 w-3.5 text-[#76B7FF]" /> لوحة متابعة توثيقية · لا تنفذ أي
                مرحلة تلقائياً
              </div>
              <h1 className="mt-5 max-w-3xl text-3xl font-bold leading-tight tracking-[-0.045em] sm:text-[40px]">
                المعمارية ثابتة.
                <br />
                <span className="text-[var(--codiq-brand-spark)]">
                  البوابة الصحيحة تحدد سرعة التوسع.
                </span>
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-[#C7D7EC]">
                واجهة داخلية لقراءة الوضع التقني: طبقات النظام الفعلية، نقطة التعطيل التشغيلية، وما
                الذي يجب إثباته قبل العبور إلى كل مرحلة من 12 إلى 26.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
              <div className="rounded-2xl border border-white/10 bg-white/[0.08] p-4">
                <p className="text-[11px] font-bold text-[#AFC7E4]">الأساس المنجز</p>
                <p className="mt-1 text-lg font-bold">1–11A</p>
                <p className="mt-1 text-xs text-[#C3D4E9]">هوية، عزل، Storefront وCI</p>
              </div>
              <div className="rounded-2xl border border-[#FFCC75]/20 bg-[#FFC868]/10 p-4">
                <p className="text-[11px] font-bold text-[#FFDDA0]">البوابة الحالية</p>
                <p className="mt-1 text-lg font-bold text-white">11B</p>
                <p className="mt-1 text-xs text-[#F4D6AA]">staging منفصلة غير مؤكدة</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.08] p-4">
                <p className="text-[11px] font-bold text-[#AFC7E4]">المراحل التالية</p>
                <p className="mt-1 text-lg font-bold">{engineeringFacts.upcomingCount} مرحلة</p>
                <p className="mt-1 text-xs text-[#C3D4E9]">من مواءمة المنتج إلى جاهزية عالمية</p>
              </div>
            </div>
          </div>
        </section>

        <section className="mt-5 grid gap-4 lg:grid-cols-3" aria-label="حالة التشغيل الأساسية">
          <article className="rounded-[23px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-5 shadow-[0_10px_24px_rgba(31,55,98,0.045)]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold text-[var(--codiq-text-muted)]">ضمان العزل</p>
                <p className="mt-1 text-base font-bold text-[#273650]">
                  حدود tenant داخل الخادم والبيانات
                </p>
              </div>
              <span className="grid h-10 w-10 place-items-center rounded-2xl bg-[var(--codiq-success-soft)] text-[#15936D]">
                <LockKeyhole className="h-5 w-5" />
              </span>
            </div>
            <p className="mt-3 text-xs leading-6 text-[var(--codiq-text-muted)]">
              {engineeringFacts.invariant}
            </p>
          </article>
          <article className="rounded-[23px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-5 shadow-[0_10px_24px_rgba(31,55,98,0.045)]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold text-[var(--codiq-text-muted)]">دليل التغيير</p>
                <p className="mt-1 text-base font-bold text-[#273650]">PR محمي وCI تكامل حاجب</p>
              </div>
              <span className="grid h-10 w-10 place-items-center rounded-2xl bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]">
                <GitPullRequest className="h-5 w-5" />
              </span>
            </div>
            <p className="mt-3 text-xs leading-6 text-[var(--codiq-text-muted)]">
              توجد وظيفة متصفح مرئية لكن غير حاجبة إلى حين إغلاق B-15.
            </p>
          </article>
          <article className="rounded-[23px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-5 shadow-[0_10px_24px_rgba(31,55,98,0.045)]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold text-[var(--codiq-text-muted)]">قرار قبل التنفيذ</p>
                <p className="mt-1 text-base font-bold text-[#273650]">لا افتراضات تشغيلية</p>
              </div>
              <span className="grid h-10 w-10 place-items-center rounded-2xl bg-[var(--codiq-warning-soft)] text-[#B8780A]">
                <ShieldCheck className="h-5 w-5" />
              </span>
            </div>
            <p className="mt-3 text-xs leading-6 text-[var(--codiq-text-muted)]">
              أي مرحلة مستقبلية تحتاج نطاقاً معتمداً، اختبارات، وموافقة صريحة قبل الدمج.
            </p>
          </article>
        </section>

        <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.18fr)_minmax(360px,0.82fr)]">
          <ArchitectureMap activeLayer={activeLayer} onLayerChange={setActiveLayer} />

          <section
            aria-labelledby="gates-title"
            className="rounded-[28px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-5 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-7"
          >
            <p className="text-xs font-bold tracking-[0.12em] text-[var(--codiq-accent)]">
              حارس التنفيذ
            </p>
            <h2
              id="gates-title"
              className="mt-1 text-xl font-bold tracking-[-0.035em] text-[#15233E]"
            >
              بوابات لا تتجاوزها المنصة
            </h2>
            <p className="mt-2 text-sm leading-6 text-[var(--codiq-text-muted)]">
              تسلسل ثابت لكل تغيير؛ يوقف التوسع غير الموثق قبل أن يصبح ديناً تقنياً.
            </p>
            <ol className="mt-6 space-y-3">
              {engineeringGates.map((gate, index) => (
                <li
                  key={gate.id}
                  className="relative flex gap-3 rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface-sunken)] p-3.5"
                >
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-[var(--codiq-surface)] text-xs font-extrabold text-[var(--codiq-accent)] shadow-sm">
                    {index + 1}
                  </span>
                  <div>
                    <p className="text-sm font-bold text-[#34435C]">{gate.label}</p>
                    <p className="mt-1 text-xs leading-5 text-[var(--codiq-text-muted)]">
                      {gate.detail}
                    </p>
                  </div>
                  {index < engineeringGates.length - 1 ? (
                    <span className="absolute -bottom-3 right-7 h-3 border-r border-dashed border-[#B6C7DB]" />
                  ) : null}
                </li>
              ))}
            </ol>
            <div className="mt-5 rounded-2xl bg-[#142C50] p-4 text-white">
              <p className="flex items-center gap-2 text-xs font-bold text-[#BFD8F7]">
                <Terminal className="h-4 w-4" /> قاعدة توقف فورية
              </p>
              <p className="mt-2 text-xs leading-6 text-[#E3EDF9]">
                مشكلة أمنية أو IDOR أو عدم اتساق قاعدة بيانات تعني التوقف والتقرير، لا إصلاحاً
                تلقائياً خارج النطاق.
              </p>
            </div>
          </section>
        </div>

        <section
          aria-labelledby="roadmap-title"
          className="mt-5 rounded-[28px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-5 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-7"
        >
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs font-bold tracking-[0.12em] text-[var(--codiq-accent)]">
                خارطة التحكم
              </p>
              <h2
                id="roadmap-title"
                className="mt-1 text-xl font-bold tracking-[-0.035em] text-[#15233E]"
              >
                من مرحلة 12 إلى إعلان الجاهزية
              </h2>
              <p className="mt-2 text-sm leading-6 text-[var(--codiq-text-muted)]">
                اختر مرحلة لقراءة التحدي والضابط والقرار الذي يمنع توسعاً غير آمن.
              </p>
            </div>
            <div
              className="inline-flex w-full rounded-2xl bg-[var(--codiq-canvas)] p-1 sm:w-auto"
              aria-label="تصفية المراحل"
            >
              {(["all", "product", "readiness"] as TimelineFilter[]).map((filter) => {
                const label =
                  filter === "all"
                    ? "الكل"
                    : filter === "product"
                      ? "12–17 · البناء"
                      : "18–26 · الجاهزية";
                return (
                  <button
                    key={filter}
                    type="button"
                    onClick={() => setTimelineFilter(filter)}
                    className={`flex-1 rounded-xl px-3 py-2 text-xs font-bold transition-colors sm:flex-none ${timelineFilter === filter ? "bg-[var(--codiq-surface)] text-[var(--codiq-accent)] shadow-sm" : "text-[var(--codiq-text-muted)] hover:text-[#41516C]"}`}
                    aria-pressed={timelineFilter === filter}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
            {visibleStages.map((stage) => (
              <StageCard
                key={stage.phase}
                stage={stage}
                selected={stage.phase === activeStage.phase}
                onSelect={setActiveStage}
              />
            ))}
          </div>

          <div
            className="mt-6 rounded-[24px] border border-[#CEE0FA] bg-[linear-gradient(135deg,#F4F8FF,#FCFDFF)] p-5 sm:p-6"
            aria-live="polite"
          >
            <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
              <div className="max-w-2xl">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-[var(--codiq-accent)] px-2.5 py-1 text-[11px] font-bold text-white">
                    المرحلة {activeStage.phase}
                  </span>
                  <span
                    className={`rounded-full px-2.5 py-1 text-[11px] font-bold ring-1 ring-inset ${statusClasses[activeStage.status]}`}
                  >
                    {activeStage.status}
                  </span>
                  <span
                    className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${riskClasses[activeStage.risk]}`}
                  >
                    مخاطر {activeStage.risk}
                  </span>
                </div>
                <h3 className="mt-4 text-xl font-bold text-[#1B3153]">{activeStage.title}</h3>
                <p className="mt-2 text-sm leading-7 text-[#5D6C84]">{activeStage.emphasis}</p>
              </div>
              <button
                type="button"
                onClick={() => setMobileOpen(true)}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#BFD7FF] bg-[var(--codiq-surface)] px-4 py-2.5 text-xs font-bold text-[var(--codiq-accent)] transition-colors hover:bg-[var(--codiq-canvas)] active:scale-[0.97]"
              >
                <CircleAlert className="h-4 w-4" /> قراءة القرار والضوابط{" "}
                <ChevronLeft className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-5 grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl bg-[var(--codiq-surface)] p-4">
                <p className="text-xs font-bold text-[#B06811]">التحدي التقني</p>
                <p className="mt-2 text-sm leading-6 text-[#56657C]">{activeStage.challenge}</p>
              </div>
              <div className="rounded-2xl bg-[var(--codiq-surface)] p-4">
                <p className="text-xs font-bold text-[#13795D]">الضابط المقترح</p>
                <p className="mt-2 text-sm leading-6 text-[#56657C]">{activeStage.safeguard}</p>
              </div>
            </div>
          </div>
        </section>
      </main>

      {mobileOpen ? (
        <button
          type="button"
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-40 bg-[#10253F]/35 backdrop-blur-[1px]"
          aria-label="إغلاق التفاصيل"
        />
      ) : null}
      <aside
        className={`fixed inset-x-0 bottom-0 z-50 mx-auto max-w-3xl rounded-t-[30px] bg-[var(--codiq-surface)] p-6 shadow-[0_-18px_50px_rgba(22,44,80,0.2)] transition-transform duration-[220ms] ease-[cubic-bezier(0.23,1,0.32,1)] ${mobileOpen ? "translate-y-0" : "translate-y-full"}`}
        aria-label="تفاصيل البوابة المحددة"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold text-[var(--codiq-accent)]">
              بوابة المرحلة {activeStage.phase}
            </p>
            <h3 className="mt-1 text-lg font-bold text-[#203451]">{activeStage.title}</h3>
          </div>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--codiq-canvas)] text-[var(--codiq-text-secondary)]"
            aria-label="إغلاق"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-5 rounded-2xl bg-[var(--codiq-warning-soft)] p-4">
          <p className="text-xs font-bold text-[#9A6200]">قرار المالك المطلوب أو شرط العبور</p>
          <p className="mt-2 text-sm leading-6 text-[#5A6678]">{activeStage.gate}</p>
        </div>
        <p className="mt-4 text-xs leading-6 text-[#7B8799]">
          المحتوى توثيقي لتسهيل المتابعة؛ لا يغيّر حالة أي مرحلة ولا يطلق عملية تنفيذ.
        </p>
      </aside>
    </div>
  );
}
