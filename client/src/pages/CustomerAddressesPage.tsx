/**
 * ق-173 — «عناويني»: the shopper edits and removes what he saved.
 *
 * `PATCH` and `DELETE /store/:slug/account/addresses/:id` shipped with a full
 * validation schema and no caller. The only place an address appeared was the
 * checkout, and there it could only be created — a moved shopper, a mistyped
 * phone, a flat above the pharmacy that is now the one across the street: none
 * of it could be fixed, and the list only ever grew. The sibling act — pulling
 * back a return request — had its button; this one did not.
 */
import { useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { CircleAlert, LoaderCircle, MapPin, Pencil, Plus, Star, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AddressForm, emptyAddress, type AddressDraft } from "@/components/AddressForm";
import { useStorefront } from "@/components/StorefrontProvider";
import { EmptyState, ErrorState, LoadingState } from "@/components/StorefrontStates";
import { governorateLabel } from "@/lib/governorates";
import { Address, DeliveryArea, errorMessage, storefrontApi } from "@/lib/storefront-api";

type Editing = { id: string | "new"; draft: AddressDraft; isDefault: boolean } | null;

export default function CustomerAddressesPage() {
  const { slug, customer, loading, setNotice } = useStorefront();
  const [, navigate] = useLocation();
  const [addresses, setAddresses] = useState<Address[] | null>(null);
  const [areas, setAreas] = useState<DeliveryArea[]>([]);
  const [loadingAreas, setLoadingAreas] = useState(true);
  const [editing, setEditing] = useState<Editing>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await storefrontApi.addresses(slug);
      setAddresses(result.addresses);
      setFailure(null);
    } catch (error) {
      setFailure(errorMessage(error));
    }
  }, [slug]);

  useEffect(() => {
    if (!customer) return;
    void load();
    let cancelled = false;
    void (async () => {
      try {
        const result = await storefrontApi.deliveryAreas(slug);
        if (!cancelled) setAreas(result.areas);
      } catch {
        if (!cancelled) setAreas([]);
      } finally {
        if (!cancelled) setLoadingAreas(false);
      }
    })();
    return () => { cancelled = true; };
  }, [customer, load, slug]);

  function startEdit(address: Address) {
    setConfirmDelete(null);
    setEditing({
      id: address.id,
      isDefault: address.isDefault,
      draft: { recipientName: address.recipientName, fullAddress: address.fullAddress, city: address.city, governorate: address.governorate, phoneContact: address.phoneContactNormalized },
    });
  }

  async function save() {
    if (!editing) return;
    const body = {
      recipientName: editing.draft.recipientName.trim(),
      fullAddress: editing.draft.fullAddress.trim(),
      city: editing.draft.city.trim(),
      governorate: editing.draft.governorate,
      phoneContact: editing.draft.phoneContact.trim(),
      // A first address becomes the default on its own; an edit keeps whatever
      // the row already was — «اجعله الافتراضي» is its own act below.
      isDefault: editing.id === "new" ? (addresses?.length ?? 0) === 0 : editing.isDefault,
    };
    setBusy(true);
    setFailure(null);
    try {
      if (editing.id === "new") await storefrontApi.addAddress(slug, body);
      else await storefrontApi.updateAddress(slug, editing.id, body);
      setEditing(null);
      setNotice(editing.id === "new" ? "أُضيف العنوان." : "حُفظ التعديل.");
      await load();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function makeDefault(address: Address) {
    setBusy(true);
    setFailure(null);
    try {
      await storefrontApi.updateAddress(slug, address.id, {
        recipientName: address.recipientName, fullAddress: address.fullAddress, city: address.city, governorate: address.governorate, phoneContact: address.phoneContactNormalized, isDefault: true,
      });
      setNotice("صار هذا عنوانك الافتراضي.");
      await load();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove(address: Address) {
    setBusy(true);
    setFailure(null);
    try {
      await storefrontApi.deleteAddress(slug, address.id);
      setConfirmDelete(null);
      setNotice("حُذف العنوان.");
      await load();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingState />;
  if (!customer) return <EmptyState title="سجّل الدخول لإدارة عناوينك" detail="العناوين المحفوظة تخصّ حسابك في هذا المتجر." action={{ label: "تسجيل الدخول", onClick: () => navigate(`/store/${slug}/account/login`) }} />;

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-[var(--storefront-accent)]">حسابي</p>
          <h1 className="mt-1 text-3xl font-black text-[var(--codiq-text)]">عناويني</h1>
          <p className="mt-2 text-sm leading-6 text-[var(--codiq-text-muted)]">العناوين التي تختار منها عند إتمام الطلب. عدّل ما تغيّر، واحذف ما لم يعد لك.</p>
        </div>
        {editing ? null : (
          <Button type="button" data-testid="address-add" onClick={() => { setConfirmDelete(null); setEditing({ id: "new", draft: emptyAddress, isDefault: false }); }} className="h-11 rounded-xl font-bold">
            <Plus className="ml-1 h-4 w-4" />عنوان جديد
          </Button>
        )}
      </div>

      {failure ? <ErrorState message={failure} retry={() => void load()} /> : null}

      {editing ? (
        <form
          data-testid="address-form"
          onSubmit={(event) => { event.preventDefault(); void save(); }}
          className="rounded-[26px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 sm:p-6"
        >
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 font-black text-[var(--codiq-text)]"><MapPin className="h-5 w-5 text-[var(--storefront-accent)]" />{editing.id === "new" ? "عنوان جديد" : "تعديل العنوان"}</h2>
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)} aria-label="إغلاق"><X className="h-4 w-4" /></Button>
          </div>
          <AddressForm idPrefix="address" draft={editing.draft} onChange={(draft) => setEditing({ ...editing, draft })} areas={areas} loadingAreas={loadingAreas} />
          <div className="mt-5 flex gap-2">
            <Button type="submit" data-testid="address-save" disabled={busy || loadingAreas || areas.length === 0} className="h-11 rounded-xl px-6 font-bold">
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : editing.id === "new" ? "إضافة" : "حفظ"}
            </Button>
            <Button type="button" variant="outline" onClick={() => setEditing(null)} className="h-11 rounded-xl">إلغاء</Button>
          </div>
        </form>
      ) : null}

      {addresses === null && !failure ? <LoadingState label="جارٍ تحميل العناوين…" /> : null}
      {addresses?.length === 0 && !editing ? <EmptyState title="لا عناوين محفوظة" detail="أضف عنوانًا هنا أو عند إتمام أول طلب." action={{ label: "عنوان جديد", onClick: () => setEditing({ id: "new", draft: emptyAddress, isDefault: false }) }} /> : null}

      {addresses?.length ? (
        <ul className="space-y-3" data-testid="address-list">
          {addresses.map((address) => (
            <li key={address.id} data-testid="address-card" className={`rounded-2xl border p-4 ${address.isDefault ? "border-[var(--storefront-accent)] bg-[var(--codiq-canvas)]" : "border-[var(--codiq-border)] bg-[var(--codiq-surface)]"}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-black text-[var(--codiq-text)]">
                    {address.recipientName}
                    {address.isDefault ? <span className="rounded-full bg-[var(--codiq-accent-soft)] px-2 py-0.5 text-[11px] text-[var(--storefront-accent)]">افتراضي</span> : null}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-[var(--codiq-text-muted)]">{address.fullAddress}، {address.city}، {governorateLabel(address.governorate)}</p>
                  <p className="mt-1 text-xs font-bold text-[var(--codiq-text-secondary)]" dir="ltr">{address.phoneContactNormalized}</p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {address.isDefault ? null : (
                    <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void makeDefault(address)} className="rounded-xl text-xs font-bold"><Star className="ml-1 h-3.5 w-3.5" />اجعله الافتراضي</Button>
                  )}
                  <Button type="button" variant="ghost" size="sm" disabled={busy} data-testid="address-edit" onClick={() => startEdit(address)} className="rounded-xl text-xs font-bold"><Pencil className="ml-1 h-3.5 w-3.5" />تعديل</Button>
                  {confirmDelete === address.id ? (
                    <>
                      <Button type="button" size="sm" disabled={busy} data-testid="address-delete-confirm" onClick={() => void remove(address)} className="rounded-xl bg-[var(--codiq-danger)] text-xs font-bold text-white hover:bg-[var(--codiq-danger)]">تأكيد الحذف</Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDelete(null)} className="rounded-xl text-xs">إلغاء</Button>
                    </>
                  ) : (
                    <Button type="button" variant="ghost" size="sm" disabled={busy} data-testid="address-delete" onClick={() => { setEditing(null); setConfirmDelete(address.id); }} className="rounded-xl text-xs font-bold text-[var(--codiq-danger)]"><Trash2 className="ml-1 h-3.5 w-3.5" />حذف</Button>
                  )}
                </div>
              </div>
              {confirmDelete === address.id ? <p role="alert" className="mt-3 flex items-center gap-2 text-xs text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4 shrink-0" />يُحذف العنوان من حسابك ولا يمسّ طلباتك السابقة.</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
