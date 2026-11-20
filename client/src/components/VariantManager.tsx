import { useCallback, useEffect, useState } from "react";
import { Boxes, LoaderCircle, PackageMinus, Pencil, Plus, Power, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Phase 20A-2: merchant-facing variant editor. Every product owns at least an
 * implicit default variant (backend guarantees it); this panel lists variants,
 * creates/edits them, adjusts variant-level inventory through the dedicated
 * inventory route, and surfaces the server guards (protected default variant,
 * order/cart references, duplicate SKU) with Arabic messages.
 */
export type ProductVariantRecord = {
  id: string;
  productId: string;
  sku: string;
  name: string;
  priceIqd: number;
  stockQuantity: number;
  lowStockThreshold: number;
  isLowStock: boolean;
  isDefault: boolean;
  isActive: boolean;
  position: number;
  options: Record<string, unknown>;
};

const money = new Intl.NumberFormat("ar-IQ");

const variantGuardMessages: Record<string, string> = {
  DEFAULT_VARIANT_PROTECTED: "لا يمكن حذف المتغير الافتراضي للمنتج.",
  VARIANT_REFERENCED_BY_ORDER: "لا يمكن حذف متغير مرتبط بطلب أو حجز سابق.",
  VARIANT_IN_USE: "لا يمكن حذف متغير موجود حاليًا في سلال العملاء.",
  DUPLICATE_VARIANT_SKU: "يوجد متغير آخر بنفس SKU داخل هذا المتجر.",
  INVALID_INPUT: "تحقق من القيم المدخلة: الأسعار والكميات يجب أن تكون أرقامًا موجبة.",
};

async function variantApi<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = payload && typeof payload === "object" && "error" in payload ? (payload as { error?: { code?: string; message?: string } }).error : undefined;
    throw new Error((error?.code ? variantGuardMessages[error.code] : undefined) ?? error?.message ?? "تعذر إتمام عملية المتغير.");
  }
  return payload as T;
}

function VariantField({ label, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return <label className="block text-right"><span className="mb-1.5 block text-xs font-bold text-[var(--codiq-text-secondary)]">{label}</span><input {...props} className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3.5 py-2.5 text-sm text-[var(--codiq-text)] outline-none transition focus:border-[var(--codiq-accent)] focus:ring-4 focus:ring-[var(--codiq-accent)]/10" /></label>;
}

type VariantDraft = { name: string; sku: string; priceIqd: string; stockQuantity: string; lowStockThreshold: string; isActive: boolean; options: Array<{ key: string; value: string }> };
const emptyDraft: VariantDraft = { name: "", sku: "", priceIqd: "", stockQuantity: "0", lowStockThreshold: "0", isActive: true, options: [] };

function draftFromVariant(variant: ProductVariantRecord): VariantDraft {
  return { name: variant.name, sku: variant.sku, priceIqd: String(variant.priceIqd), stockQuantity: String(variant.stockQuantity), lowStockThreshold: String(variant.lowStockThreshold), isActive: variant.isActive, options: Object.entries(variant.options ?? {}).map(([key, value]) => ({ key, value: String(value) })) };
}

function optionsPayload(rows: VariantDraft["options"]) {
  return Object.fromEntries(rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value.trim()]));
}

function VariantForm({ draft, setDraft, includeStock, busy, onSubmit, onCancel }: { draft: VariantDraft; setDraft: (draft: VariantDraft) => void; includeStock: boolean; busy: boolean; onSubmit: () => void; onCancel: () => void }) {
  return <form onSubmit={(event) => { event.preventDefault(); onSubmit(); }} className="mt-3 grid gap-3 rounded-2xl bg-[var(--codiq-surface-sunken)] p-4 sm:grid-cols-2">
    <VariantField required label="اسم المتغير" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
    <VariantField required label="SKU المتغير" value={draft.sku} onChange={(event) => setDraft({ ...draft, sku: event.target.value })} />
    <VariantField required type="number" min="0" label="سعر المتغير (د.ع)" value={draft.priceIqd} onChange={(event) => setDraft({ ...draft, priceIqd: event.target.value })} />
    {includeStock ? <VariantField type="number" min="0" label="مخزون المتغير" value={draft.stockQuantity} onChange={(event) => setDraft({ ...draft, stockQuantity: event.target.value })} /> : null}
    <VariantField type="number" min="0" label="حد تنبيه المتغير" value={draft.lowStockThreshold} onChange={(event) => setDraft({ ...draft, lowStockThreshold: event.target.value })} />
    <label className="flex items-center gap-2 self-end pb-1 text-sm font-bold text-[var(--codiq-text-secondary)]"><input type="checkbox" checked={draft.isActive} onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })} className="h-4 w-4 accent-[var(--codiq-accent)]" />متغير فعّال في المتجر</label>
    <div className="space-y-2 sm:col-span-2">
      <div className="flex items-center justify-between"><span className="text-xs font-bold text-[var(--codiq-text-secondary)]">خيارات المتغير (مثل المقاس واللون)</span><Button type="button" variant="outline" size="sm" onClick={() => setDraft({ ...draft, options: [...draft.options, { key: "", value: "" }] })}><Plus className="ml-1 h-3.5 w-3.5" />إضافة خيار</Button></div>
      {draft.options.map((row, index) => <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-2">
        <input aria-label={`مفتاح الخيار ${index + 1}`} placeholder="مثال: اللون" value={row.key} onChange={(event) => setDraft({ ...draft, options: draft.options.map((entry, at) => at === index ? { ...entry, key: event.target.value } : entry) })} className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3.5 py-2.5 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]" />
        <input aria-label={`قيمة الخيار ${index + 1}`} placeholder="مثال: أحمر" value={row.value} onChange={(event) => setDraft({ ...draft, options: draft.options.map((entry, at) => at === index ? { ...entry, value: event.target.value } : entry) })} className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3.5 py-2.5 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]" />
        <Button type="button" variant="ghost" size="icon" aria-label={`إزالة الخيار ${index + 1}`} className="self-center text-[#B34B43]" onClick={() => setDraft({ ...draft, options: draft.options.filter((_, at) => at !== index) })}><X className="h-4 w-4" /></Button>
      </div>)}
    </div>
    <div className="flex gap-2 sm:col-span-2">
      <Button disabled={busy} type="submit" size="sm">{busy ? <LoaderCircle className="ml-1 h-3.5 w-3.5 animate-spin" /> : null}حفظ المتغير</Button>
      <Button disabled={busy} type="button" variant="outline" size="sm" onClick={onCancel}>إلغاء</Button>
    </div>
  </form>;
}

export function VariantInventoryForm({ variant, busy, onSave }: { variant: ProductVariantRecord; busy: boolean; onSave: (stockQuantity: number, reason: string) => void }) {
  const [quantityValue, setQuantityValue] = useState(String(variant.stockQuantity));
  const [reason, setReason] = useState("تعديل مخزون يدوي");
  return <div className="mt-3 grid gap-3 rounded-2xl bg-[var(--codiq-surface-sunken)] p-4 sm:grid-cols-[160px_1fr_auto]">
    <VariantField label="الكمية الجديدة للمتغير" type="number" min="0" value={quantityValue} onChange={(event) => setQuantityValue(event.target.value)} />
    <VariantField label="سبب تعديل المخزون" value={reason} onChange={(event) => setReason(event.target.value)} />
    <div className="self-end"><Button disabled={busy} type="button" size="sm" onClick={() => onSave(Number(quantityValue), reason)}>حفظ مخزون المتغير</Button></div>
  </div>;
}

function VariantBadges({ variant }: { variant: ProductVariantRecord }) {
  return <>
    {variant.isDefault ? <span className="rounded-full bg-[var(--codiq-accent-soft)] px-2 py-0.5 text-[10px] font-bold text-[#1B64C4]">افتراضي</span> : null}
    {!variant.isActive ? <span className="rounded-full bg-[var(--codiq-canvas)] px-2 py-0.5 text-[10px] font-bold text-[var(--codiq-text-muted)]">معطّل</span> : null}
    {variant.isLowStock ? <span className="rounded-full bg-[var(--codiq-danger-soft)] px-2 py-0.5 text-[10px] font-bold text-[#B44B40]">مخزون منخفض</span> : null}
  </>;
}

function VariantMeta({ variant }: { variant: ProductVariantRecord }) {
  const optionEntries = Object.entries(variant.options ?? {});
  return <>
    <p className="mt-1.5 text-xs text-[var(--codiq-text-muted)]">SKU: {variant.sku} · المخزون: {variant.stockQuantity} · حد التنبيه: {variant.lowStockThreshold}</p>
    {optionEntries.length ? <div className="mt-2 flex flex-wrap gap-1.5">{optionEntries.map(([key, value]) => <span key={key} className="rounded-full bg-[var(--codiq-neutral-soft)] px-2 py-0.5 text-[10px] font-bold text-[#5A6C87]">{key}: {String(value)}</span>)}</div> : null}
  </>;
}

export function VariantManager({ base, productId, initial, onChanged }: { base: string; productId: string; initial?: ProductVariantRecord[]; onChanged?: () => void }) {
  const [variants, setVariants] = useState<ProductVariantRecord[]>(initial ?? []);
  const [loading, setLoading] = useState(!initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [inventoryId, setInventoryId] = useState<string | null>(null);
  const [draft, setDraft] = useState<VariantDraft>(emptyDraft);

  const variantsUrl = `${base}/products/${productId}/variants`;
  const reload = useCallback(async () => {
    try { const data = await variantApi<{ variants: ProductVariantRecord[] }>(variantsUrl); setVariants(data.variants); }
    catch (error) { setMessage(error instanceof Error ? error.message : "تعذر تحميل متغيرات المنتج."); }
    finally { setLoading(false); }
  }, [variantsUrl]);
  useEffect(() => { void reload(); }, [reload]);

  async function run(operation: () => Promise<unknown>, success: string) {
    setBusy(true);
    try { await operation(); setMessage(success); await reload(); onChanged?.(); return true; }
    catch (error) { setMessage(error instanceof Error ? error.message : "تعذر إتمام عملية المتغير."); return false; }
    finally { setBusy(false); }
  }

  async function createVariant() {
    const done = await run(() => variantApi(variantsUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: draft.name, sku: draft.sku, priceIqd: Number(draft.priceIqd), stockQuantity: Number(draft.stockQuantity), lowStockThreshold: Number(draft.lowStockThreshold), isActive: draft.isActive, options: optionsPayload(draft.options) }) }), "تم إنشاء المتغير داخل المنتج الحالي.");
    if (done) { setCreating(false); setDraft(emptyDraft); }
  }

  async function saveVariant(variant: ProductVariantRecord) {
    const done = await run(() => variantApi(`${variantsUrl}/${variant.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: draft.name, sku: draft.sku, priceIqd: Number(draft.priceIqd), lowStockThreshold: Number(draft.lowStockThreshold), isActive: draft.isActive, options: optionsPayload(draft.options) }) }), "تم تحديث المتغير.");
    if (done) setEditingId(null);
  }

  async function saveInventory(variant: ProductVariantRecord, stockQuantity: number, reason: string) {
    const done = await run(() => variantApi(`${variantsUrl}/${variant.id}/inventory`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stockQuantity, reason }) }), "تم تحديث مخزون المتغير.");
    if (done) setInventoryId(null);
  }

  async function toggleActive(variant: ProductVariantRecord) {
    await run(() => variantApi(`${variantsUrl}/${variant.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ isActive: !variant.isActive }) }), variant.isActive ? "تم تعطيل المتغير في المتجر." : "تم تفعيل المتغير في المتجر.");
  }

  async function removeVariant(variant: ProductVariantRecord) {
    if (!window.confirm("هل تريد إزالة هذا المتغير؟")) return;
    await run(() => variantApi(`${variantsUrl}/${variant.id}`, { method: "DELETE" }), "تمت إزالة المتغير.");
  }

  if (loading) return <div className="mt-4 flex items-center gap-2 rounded-2xl bg-[var(--codiq-surface-sunken)] p-4 text-xs text-[#61708A]"><LoaderCircle className="h-4 w-4 animate-spin text-[var(--codiq-accent)]" />جارٍ تحميل متغيرات المنتج…</div>;

  return <div data-testid="variant-manager" className="mt-4 rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface-sunken)] p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="flex items-center gap-2 text-sm font-bold text-[#354761]"><Boxes className="h-4 w-4 text-[var(--codiq-accent)]" />متغيرات المنتج<span className="text-xs font-normal text-[#8391A4]">{variants.length} متغير</span></span>
      {!creating ? <Button type="button" variant="outline" size="sm" onClick={() => { setCreating(true); setEditingId(null); setInventoryId(null); setDraft(emptyDraft); }}><Plus className="ml-1 h-3.5 w-3.5" />إضافة متغير</Button> : null}
    </div>
    {message ? <div className="mt-3 rounded-xl border border-[#D8E6F8] bg-[var(--codiq-canvas)] px-3.5 py-2.5 text-xs text-[#35577F]">{message}</div> : null}
    {creating ? <VariantForm draft={draft} setDraft={setDraft} includeStock busy={busy} onSubmit={() => void createVariant()} onCancel={() => { setCreating(false); setDraft(emptyDraft); }} /> : null}
    <div className="mt-3 space-y-2.5">
      {variants.map((variant) => <div key={variant.id} data-testid={`variant-row-${variant.sku}`} className="rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-bold text-[#354761]">{variant.name}</span><VariantBadges variant={variant} /></div>
          <span className="text-xs font-bold text-[var(--codiq-accent)]">{money.format(variant.priceIqd)} د.ع</span>
        </div>
        <VariantMeta variant={variant} />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { setEditingId(editingId === variant.id ? null : variant.id); setCreating(false); setInventoryId(null); setDraft(draftFromVariant(variant)); }}><Pencil className="ml-1 h-3.5 w-3.5" />تحرير</Button>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { setInventoryId(inventoryId === variant.id ? null : variant.id); setCreating(false); setEditingId(null); }}><PackageMinus className="ml-1 h-3.5 w-3.5" />ضبط المخزون</Button>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void toggleActive(variant)}><Power className="ml-1 h-3.5 w-3.5" />{variant.isActive ? "تعطيل" : "تفعيل"}</Button>
          <Button type="button" variant="outline" size="sm" disabled={busy || variant.isDefault} title={variant.isDefault ? "المتغير الافتراضي محمي من الحذف." : undefined} className="border-[#F0C7C4] text-[#B34B43] hover:bg-[#FFF7F7]" onClick={() => void removeVariant(variant)}><Trash2 className="ml-1 h-3.5 w-3.5" />إزالة</Button>
        </div>
        {editingId === variant.id ? <VariantForm draft={draft} setDraft={setDraft} includeStock={false} busy={busy} onSubmit={() => void saveVariant(variant)} onCancel={() => setEditingId(null)} /> : null}
        {inventoryId === variant.id ? <VariantInventoryForm variant={variant} busy={busy} onSave={(stockQuantity, reason) => void saveInventory(variant, stockQuantity, reason)} /> : null}
      </div>)}
      {!variants.length ? <p className="text-xs text-[#7A879A]">لا توجد متغيرات بعد.</p> : null}
    </div>
  </div>;
}

/**
 * Inventory workspace card: one low-stock product expanded into its variant
 * rows, each adjustable through the variant inventory route.
 */
export function VariantInventoryPanel({ base, product, onChanged }: { base: string; product: { id: string; name: string; variants: ProductVariantRecord[] }; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  async function save(variant: ProductVariantRecord, stockQuantity: number, reason: string) {
    setBusy(true);
    try {
      await variantApi(`${base}/products/${product.id}/variants/${variant.id}/inventory`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stockQuantity, reason }) });
      setMessage("تم تحديث مخزون المتغير.");
      setOpenId(null);
      onChanged?.();
    } catch (error) { setMessage(error instanceof Error ? error.message : "تعذر تحديث مخزون المتغير."); }
    finally { setBusy(false); }
  }
  return <div className="rounded-[22px] border border-[#F2D4D0] bg-[var(--codiq-surface)] p-5 shadow-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="font-bold text-[#354761]">{product.name}</p>
      <span className="rounded-full bg-[var(--codiq-danger-soft)] px-2.5 py-1 text-xs font-bold text-[#B44B40]">تنبيه مخزون</span>
    </div>
    {message ? <div className="mt-3 rounded-xl border border-[#D8E6F8] bg-[var(--codiq-canvas)] px-3.5 py-2.5 text-xs text-[#35577F]">{message}</div> : null}
    <div className="mt-3 space-y-2.5">
      {product.variants.map((variant) => <div key={variant.id} data-testid={`inventory-variant-row-${variant.sku}`} className="rounded-xl border border-[var(--codiq-border)] p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-bold text-[#354761]">{variant.name}</span><VariantBadges variant={variant} /></div>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setOpenId(openId === variant.id ? null : variant.id)}><PackageMinus className="ml-1 h-3.5 w-3.5" />ضبط المخزون</Button>
        </div>
        <VariantMeta variant={variant} />
        {openId === variant.id ? <VariantInventoryForm variant={variant} busy={busy} onSave={(stockQuantity, reason) => void save(variant, stockQuantity, reason)} /> : null}
      </div>)}
    </div>
  </div>;
}
