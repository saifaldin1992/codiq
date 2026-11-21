/**
 * codiq landing — FAQ accordion.
 *
 * Hand-rolled (no accordion dependency): a button per question carrying
 * `aria-expanded`/`aria-controls`, and a `grid-template-rows: 0fr → 1fr`
 * transition for the smooth open. index.css removes the transition under
 * `prefers-reduced-motion: reduce`; the open/closed state itself is real DOM
 * state, so nothing depends on the animation running.
 *
 * Every answer below is checked against this repository — see the source note
 * on each entry — because CODIQ has no customers yet and may not imply otherwise.
 */
import { useState } from "react";
import { Plus } from "lucide-react";

type Question = { q: string; a: string };

const QUESTIONS: Question[] = [
  {
    // registration.service.ts — public register, free plan, owner-reviewed upgrades.
    q: "هل أحتاج بطاقة ائتمان للبدء؟",
    a: "لا. التسجيل مجاني وتبدأ مباشرة على الخطة المجانية. الدفع الإلكتروني للاشتراكات غير مفعّل بعد، وطلب الترقية يصل إلى فريق المنصة ليراجعه ويعتمده.",
  },
  {
    // store-bootstrap.service.ts — COD enabled, CARD created disabled.
    q: "ما طرق الدفع المتاحة في متجري؟",
    a: "الدفع عند الاستلام مفعّل في متجرك منذ لحظة إنشائه. الدفع بالبطاقة غير مفعّل بعد على المنصة، ولن نعرض على زبونك خياراً لا نستطيع تنفيذه.",
  },
  {
    // store-bootstrap.service.ts — 18 governorates seeded disabled with amount 0.
    q: "كيف أضبط أسعار التوصيل؟",
    // Arabic-Indic digits, and «محافظةً» — 18 takes مفرد منصوب, not the bare plural.
    a: "كل متجر جديد يُهيَّأ بـ١٨ محافظةً عراقيةً معطّلة وبسعر صفر. تُفعِّل المحافظات التي تخدمها فعلاً وتحدد سعر التوصيل لكل واحدة منها من إعدادات التوصيل.",
  },
  {
    // finance.service.ts — commission on subtotal at order_completed, 15-day auto reversal.
    q: "متى تُحتسب العمولة وكيف؟",
    a: "عند اكتمال الطلب فقط، وتُحسب على مجموع البنود دون أجرة التوصيل، بنسبة خطتك لحظة الاكتمال. وإذا أُرجع الطلب خلال خمسة عشر يوماً يُقيَّد عكس العمولة تلقائياً.",
  },
  {
    // ADR-006 — append-only ledger; the database refuses UPDATE/DELETE.
    q: "هل أستطيع الوثوق بالأرقام المالية؟",
    a: "السجل المالي إضافي فقط: كل قيد يُكتب داخل نفس معاملة تغيير حالة الطلب، وقاعدة البيانات نفسها ترفض تعديل القيود أو حذفها — لا نحن ولا أنت.",
  },
  {
    // staff-permissions.ts — 11 codes, server-side resolution on every request.
    q: "هل يرى موظفوني كل شيء في المتجر؟",
    a: "لا. هناك إحدى عشرة صلاحية دقيقة تُمنح أو تُمنع لكل موظف بأدوار واستثناءات، والخادم هو من يتحقق منها في كل طلب — إخفاء زر في الواجهة ليس حماية.",
  },
  {
    // Isolation is enforced in the APPLICATION layer, not by Postgres row-level
    // security — there is no `ROW LEVEL SECURITY`/`CREATE POLICY` in prisma/, so
    // this answer must not claim one. What it names instead is all verifiable:
    // four separate session types (merchant/staff/customer/platform-owner),
    // storeId-scoped queries behind requireStoreActor/requireMerchantStore, 19
    // composite `(id, storeId)` foreign keys in schema.prisma, and
    // phase5.tenancy.integration.ts, which asserts 403 STORE_BOUNDARY_DENIED on a
    // tampered store slug and 404 RESOURCE_NOT_FOUND on a cross-store id.
    q: "هل بيانات متجري معزولة عن بقية التجار؟",
    a: "نعم. لكل نوع دخول جلسته المنفصلة، وكل استعلام يُقيَّد بمعرّف متجرك قبل تنفيذه، ومفاتيح مركّبة في قاعدة البيانات تمنع ربط أي سجل بمتجر آخر. ويعمل قبل كل إصدار اختبار عزل يحاول الوصول إلى بيانات متجر ليس متجرك ويجب أن يُرفض.",
  },
  {
    // Storefront: default subdomain created with the store; custom domains are phase 24.
    q: "هل أحصل على رابط لمتجري؟",
    a: "نعم، يُنشأ لمتجرك رابط فرعي خاص به فور التسجيل ويعمل مباشرة. أما ربط نطاقك الخاص فهو ضمن خطة تطوير المنصة ولم يُطلق بعد.",
  },
];

export function Faq() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);
  return (
    <div className="divide-y divide-[var(--codiq-neutral-soft)] overflow-hidden rounded-[26px] border border-[var(--codiq-neutral-soft)] bg-[var(--codiq-surface)] shadow-[0_14px_40px_rgba(31,55,98,0.05)]">
      {QUESTIONS.map((item, index) => {
        const open = openIndex === index;
        return (
          <div key={item.q} className="cq-faq" data-open={open ? "true" : "false"}>
            <h3>
              <button
                type="button"
                id={`faq-trigger-${index}`}
                aria-expanded={open}
                aria-controls={`faq-panel-${index}`}
                onClick={() => setOpenIndex(open ? null : index)}
                className="flex w-full items-center justify-between gap-4 px-6 py-5 text-start text-[15px] font-bold text-[#20304C] transition hover:bg-[var(--codiq-surface-sunken)] sm:px-7"
              >
                <span>{item.q}</span>
                <span
                  aria-hidden="true"
                  className="cq-faq__icon grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]"
                >
                  <Plus size={15} strokeWidth={2.4} />
                </span>
              </button>
            </h3>
            {/* No `hidden` attribute: display:none would cancel the open transition.
                index.css collapses the panel to zero rows and flips it to
                `visibility: hidden`, which removes it from the accessibility tree
                and the tab order just the same. */}
            <div
              id={`faq-panel-${index}`}
              role="region"
              aria-labelledby={`faq-trigger-${index}`}
              className="cq-faq__panel"
            >
              <div className="min-h-0">
                <p className="px-6 pb-6 text-[14px] leading-8 text-[var(--codiq-text-secondary)] sm:px-7">
                  {item.a}
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
