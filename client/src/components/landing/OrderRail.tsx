/**
 * codiq landing — the order-lifecycle rail.
 *
 * A vector diagram (no screenshot, no illustration) of the *real* state machine
 * in `phase1-backend/src/services/order-lifecycle.service.ts`: five forward
 * stages the merchant drives, plus the three terminal states the server also
 * accepts. Labels are the exact Arabic strings the dashboard shows.
 *
 * `active` comes from the section's scroll reveal: the connectors draw
 * downwards and the nodes pop in sequence. Under reduced motion the section
 * reveals on mount and index.css strips the transitions, leaving a static
 * diagram.
 */
import { Check } from "lucide-react";
import { delayStyle } from "@/lib/landing-motion";

/** Forward path — `new → processing → preparation → out_for_delivery → completed`. */
const STAGES = [
  { label: "جديدة", note: "الطلب يصل بالدفع عند الاستلام ويُحجز مخزونه فوراً" },
  { label: "قيد المعالجة", note: "تأكيد الطلب مع الزبون قبل التجهيز" },
  { label: "قيد التجهيز", note: "تجهيز البنود وخصم المخزون بحركة مسجّلة" },
  { label: "قيد التوصيل", note: "إشعار «مندوبك في الطريق» يخرج من طابور الإرسال" },
  { label: "مكتملة", note: "تُحتسب العمولة في الدفتر المالي في نفس المعاملة" },
] as const;

/** Terminal states the same machine accepts — shown so the diagram stays truthful. */
const TERMINALS = ["ملغاة", "مرفوضة", "مرتجعة"] as const;

export function OrderRail({ active }: { active: boolean }) {
  return (
    <div data-active={active ? "true" : "false"} className="cq-rail">
      <ol className="cq-rail__list">
        {STAGES.map((stage, index) => (
          <li key={stage.label} className="cq-rail__row" style={delayStyle(index * 130)}>
            <span className="cq-rail__node" aria-hidden="true">
              <Check size={13} strokeWidth={3} color="#FFFFFF" />
            </span>
            <div className="cq-rail__body">
              <p className="text-[15px] font-bold text-[#20304C]">{stage.label}</p>
              <p className="mt-1 text-[13px] leading-6 text-[var(--codiq-text-secondary)]">
                {stage.note}
              </p>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-[var(--codiq-neutral-soft)] pt-5">
        <p className="text-[12px] font-semibold text-[#63718A]">وحالات الإنهاء الأخرى:</p>
        {TERMINALS.map((terminal, index) => (
          <span
            key={terminal}
            className="cq-rail__terminal rounded-full border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-1 text-[12px] font-semibold text-[var(--codiq-text-secondary)]"
            style={delayStyle(700 + index * 90)}
          >
            {terminal}
          </span>
        ))}
      </div>
    </div>
  );
}
