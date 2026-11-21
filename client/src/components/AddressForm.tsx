/**
 * ق-173 — the one address form, used wherever a shopper writes an address.
 *
 * It lived inline in the checkout page, which was the only place an address
 * could be WRITTEN — and there it could only be created. `PATCH` and `DELETE`
 * on `/store/:slug/account/addresses/:id` had shipped with a full validation
 * schema and no caller: a saved address could be added and never corrected or
 * removed, so a shopper's list only ever grew. The addresses page (ق-173) needs
 * the same five fields for editing, and a form that exists twice is the drift
 * this repository keeps paying for — so it was lifted here rather than copied.
 *
 * `idPrefix` keeps the checkout's element ids and test ids byte-identical to
 * what they were: the browser suites find «المحافظة» by label and
 * `checkout-governorate` by test id, and a refactor must not move them.
 */
import { Input } from "@/components/ui/input";
import { DeliveryArea, formatIqd } from "@/lib/storefront-api";

export type AddressDraft = {
  recipientName: string;
  fullAddress: string;
  city: string;
  governorate: string;
  phoneContact: string;
};
export const emptyAddress: AddressDraft = {
  recipientName: "",
  fullAddress: "",
  city: "",
  governorate: "",
  phoneContact: "",
};

function AddressInput({
  id,
  label,
  value,
  onChange,
  inputMode,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  inputMode?: "tel" | "text";
}) {
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-bold text-[var(--codiq-text-secondary)]">
        {label}
      </label>
      <Input
        id={id}
        value={value}
        inputMode={inputMode}
        onChange={(event) => onChange(event.target.value)}
        required
        className="h-11 rounded-xl"
      />
    </div>
  );
}

export function AddressForm({
  draft,
  onChange,
  areas,
  loadingAreas,
  idPrefix = "checkout",
}: {
  draft: AddressDraft;
  onChange: (next: AddressDraft) => void;
  /** The store's priced governorates (ق-162) — the shopper chooses, never types. */
  areas: DeliveryArea[];
  loadingAreas: boolean;
  idPrefix?: string;
}) {
  const set = (patch: Partial<AddressDraft>) => onChange({ ...draft, ...patch });
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <AddressInput
        id={`${idPrefix}-recipient`}
        label="اسم المستلم"
        value={draft.recipientName}
        onChange={(value) => set({ recipientName: value })}
      />
      <AddressInput
        id={`${idPrefix}-phone`}
        label="هاتف المستلم"
        inputMode="tel"
        value={draft.phoneContact}
        onChange={(value) => set({ phoneContact: value })}
      />
      <div className="sm:col-span-2">
        <AddressInput
          id={`${idPrefix}-address`}
          label="العنوان التفصيلي"
          value={draft.fullAddress}
          onChange={(value) => set({ fullAddress: value })}
        />
      </div>
      <AddressInput
        id={`${idPrefix}-city`}
        label="المدينة"
        value={draft.city}
        onChange={(value) => set({ city: value })}
      />
      <div className="space-y-2">
        <label
          htmlFor={`${idPrefix}-governorate`}
          className="text-sm font-bold text-[var(--codiq-text-secondary)]"
        >
          المحافظة
        </label>
        <select
          id={`${idPrefix}-governorate`}
          data-testid={`${idPrefix}-governorate`}
          required
          value={draft.governorate}
          onChange={(event) => set({ governorate: event.target.value })}
          className="h-11 w-full rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]"
        >
          <option value="" disabled>
            {loadingAreas
              ? "جارٍ تحميل المحافظات…"
              : areas.length
                ? "اختر المحافظة"
                : "لا توجد محافظات متاحة"}
          </option>
          {areas.map((area) => (
            <option key={area.key} value={area.key}>
              {area.name} — {formatIqd.format(area.amountIqd)} د.ع
            </option>
          ))}
        </select>
        {!loadingAreas && areas.length === 0 ? (
          <p role="alert" className="text-xs leading-5 text-[var(--codiq-danger)]">
            هذا المتجر لم يفعّل التوصيل إلى أي محافظة بعد، فلا يمكن إتمام الطلب. تواصل مع المتجر.
          </p>
        ) : null}
      </div>
    </div>
  );
}
