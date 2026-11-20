/**
 * ق-199 — the merchant's typed attribute groups on a product: a group label in
 * his own vocabulary («النوتة العطرية») and its rows (مقدمة: برغموت …). The
 * storefront draws them as definition lists under «تفاصيل المنتج».
 */
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export type AttributeGroup = { group: string; rows: Array<{ key: string; value: string }> };

const input = "h-9 w-full rounded-lg border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-2.5 text-xs text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]";

export function AttributesEditor({ value, onChange }: { value: AttributeGroup[]; onChange: (next: AttributeGroup[]) => void }) {
  const update = (index: number, patch: Partial<AttributeGroup>) => onChange(value.map((group, i) => i === index ? { ...group, ...patch } : group));
  return (
    <div data-testid="attributes-editor" className="rounded-2xl border border-dashed border-[var(--codiq-border-strong)] bg-[var(--codiq-surface-sunken)] p-4 text-right">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-bold text-[var(--codiq-text-secondary)]">خصائص المنتج <span className="text-xs font-semibold text-[var(--codiq-text-muted)]">(اختياري)</span></span>
        <Button type="button" size="sm" variant="outline" className="h-8 rounded-lg text-xs" disabled={value.length >= 10} onClick={() => onChange([...value, { group: "", rows: [{ key: "", value: "" }] }])}><Plus className="ml-1 h-3.5 w-3.5" />مجموعة</Button>
      </div>
      <p className="mt-1 text-xs leading-5 text-[var(--codiq-text-muted)]">مثال: مجموعة «النوتة العطرية» بصفوف «المقدمة: برغموت»، «القلب: ياسمين»، «القاعدة: مسك». تظهر تحت «تفاصيل المنتج» في متجرك.</p>
      {value.map((group, gi) => (
        <div key={gi} className="mt-3 rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-3">
          <div className="flex items-center gap-2">
            <input value={group.group} onChange={(event) => update(gi, { group: event.target.value })} maxLength={60} placeholder="اسم المجموعة" aria-label="اسم المجموعة" className={input} />
            <Button type="button" size="sm" variant="ghost" aria-label="حذف المجموعة" className="h-8 shrink-0 rounded-lg text-[var(--codiq-danger)]" onClick={() => onChange(value.filter((_, i) => i !== gi))}><Trash2 className="h-4 w-4" /></Button>
          </div>
          <div className="mt-2 space-y-2">
            {group.rows.map((row, ri) => (
              <div key={ri} className="flex items-center gap-2">
                <input value={row.key} onChange={(event) => update(gi, { rows: group.rows.map((r, i) => i === ri ? { ...r, key: event.target.value } : r) })} maxLength={60} placeholder="الصفة" aria-label="الصفة" className={input} />
                <input value={row.value} onChange={(event) => update(gi, { rows: group.rows.map((r, i) => i === ri ? { ...r, value: event.target.value } : r) })} maxLength={200} placeholder="القيمة" aria-label="القيمة" className={input} />
                <Button type="button" size="sm" variant="ghost" aria-label="حذف الصف" disabled={group.rows.length <= 1} className="h-8 shrink-0 rounded-lg text-[var(--codiq-text-muted)]" onClick={() => update(gi, { rows: group.rows.filter((_, i) => i !== ri) })}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            ))}
            <Button type="button" size="sm" variant="ghost" className="h-8 rounded-lg text-xs text-[var(--codiq-accent)]" disabled={group.rows.length >= 20} onClick={() => update(gi, { rows: [...group.rows, { key: "", value: "" }] })}><Plus className="ml-1 h-3.5 w-3.5" />صف</Button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Drops empty rows and empty groups so a half-filled editor never becomes a 422. */
export function cleanAttributes(groups: AttributeGroup[]): AttributeGroup[] {
  return groups
    .map((group) => ({ group: group.group.trim(), rows: group.rows.map((row) => ({ key: row.key.trim(), value: row.value.trim() })).filter((row) => row.key && row.value) }))
    .filter((group) => group.group && group.rows.length);
}
