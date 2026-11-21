import { ProductShareCard } from "@/components/ProductShareCard";
import {
  AttributesEditor,
  cleanAttributes,
  type AttributeGroup,
} from "@/components/AttributesEditor";
import { ReturnInspectionCard } from "@/components/ReturnInspectionCard";
import { ReturnInspectionHistory } from "@/components/ReturnInspectionHistory";
import { InventoryMovementsPanel } from "@/components/InventoryMovementsPanel";
import {
  Boxes,
  CopyPlus,
  CornerDownLeft,
  FileDown,
  FileUp,
  FolderTree,
  ImagePlus,
  LoaderCircle,
  PackagePlus,
  Pencil,
  RefreshCw,
  Share2,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
// PG-2: `window.confirm` could not state a single consequence, could not carry
// a «تراجع», and could not answer a 409 without throwing the merchant back to
// square one. The shared sheet does all three (plan §4).
import {
  DeleteConfirmSheet,
  UndoBar,
  type DeleteTarget,
  type SoftDeleteResponse,
} from "@/components/DeleteConfirmSheet";
import {
  ProductVariantRecord,
  VariantInventoryPanel,
  VariantManager,
} from "@/components/VariantManager";

type Category = {
  id: string;
  name: string;
  parentCategoryId?: string | null;
  _count?: { products: number };
};
type Image = { id: string; contentType: string; byteSize: number; sortOrder: number };
type Product = {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  priceIqd: number;
  stockQuantity: number;
  lowStockThreshold: number;
  isLowStock: boolean;
  requiresPrescription?: boolean;
  attributes?: AttributeGroup[];
  isActive: boolean;
  category: { id: string; name: string } | null;
  images: Image[];
  variants?: ProductVariantRecord[];
};
type Mode = "list" | "add" | "categories" | "inventory" | "import-export";

const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const money = new Intl.NumberFormat("ar-IQ");

/**
 * PG-6 (ق-74) — the catalog search is the SERVER's now.
 *
 * It used to load `?limit=100` and filter THAT array in the browser, so a
 * merchant with 3,000 products searching «قميص» was told «no results» for every
 * match from product 101 onward — and the command palette's own deep link
 * (`?q=<sku>`) landed on a page that filtered its own hit away. `q` goes to
 * `GET /merchant/stores/:slug/catalog/products`, which searches every LIVE
 * product in the store through `codiq_ar_normalize_v1` and hands back the
 * ranked page.
 *
 * The floor and the debounce are the command palette's, to the millisecond and
 * to the letter: two characters (below that a trigram index has no full trigram
 * to stand on, and the server's schema answers 400) and 250 ms. The message is
 * the palette's word for word — a merchant must not be told two different
 * things by two search boxes in one dashboard.
 */
const MIN_SEARCH_LENGTH = 2;
const SEARCH_DEBOUNCE_MS = 250;
const SHORT_QUERY_MESSAGE = "أدخل حرفين على الأقل للبحث.";

/** The `?q=` the command palette deep-links with, read once at mount. */
function seededQuery() {
  return typeof window === "undefined"
    ? ""
    : (new URLSearchParams(window.location.search).get("q")?.trim() ?? "");
}

function apiError(payload: unknown) {
  if (typeof payload === "object" && payload && "error" in payload) {
    const error = (payload as { error?: { message?: string } }).error;
    return error?.message ?? "تعذر إتمام العملية.";
  }
  return "تعذر إتمام العملية.";
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(apiError(payload));
  return payload as T;
}

function Input({
  label,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="block text-right">
      <span className="mb-1.5 block text-xs font-bold text-[var(--codiq-text-secondary)]">
        {label}
      </span>
      <input
        {...props}
        className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3.5 py-2.5 text-sm text-[var(--codiq-text)] outline-none transition focus:border-[var(--codiq-accent)] focus:ring-4 focus:ring-[var(--codiq-accent)]/10"
      />
    </label>
  );
}

export function ProductCatalogManager({ storeSlug, mode }: { storeSlug?: string; mode: Mode }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // MD-4: the product being turned into a share image, or null.
  const [sharing, setSharing] = useState<Product | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [variantsOpen, setVariantsOpen] = useState<string | null>(null);
  // PG-2 cleanup: `mode.startsWith("categories")` returns <CategoryManager/> a
  // few lines below, so this component's OWN category form and list were
  // unreachable long before this branch. They are gone rather than converted —
  // porting the delete sheet into code that cannot render would have been
  // adding new dead code to old.
  const [newProduct, setNewProduct] = useState({
    sku: "",
    name: "",
    description: "",
    priceIqd: "",
    stockQuantity: "0",
    lowStockThreshold: "0",
    categoryId: "",
    requiresPrescription: false,
    attributes: [] as AttributeGroup[],
  });
  const [files, setFiles] = useState<File[]>([]);
  // MD-1: the unified search links here with `?q=<sku>`, so a product hit lands
  // on that product instead of on the top of an unfiltered catalog. Seeded once
  // at mount and editable afterwards.
  const [listFilter, setListFilter] = useState(seededQuery);
  // PG-6: what the SERVER was last asked for — `listFilter` debounced through
  // the floor. Seeded from the same deep link so the first load already carries
  // `q` and the palette's hit is never fetched twice.
  const [appliedQuery, setAppliedQuery] = useState(() => {
    const seed = seededQuery();
    return seed.length >= MIN_SEARCH_LENGTH ? seed : "";
  });
  const [searching, setSearching] = useState(false);
  // PG-2: the sheet is opened by setting a target; the undo bar survives until
  // the merchant dismisses it or acts again.
  const [deleteTarget, setDeleteTarget] = useState<(DeleteTarget & { label: string }) | null>(null);
  const [undo, setUndo] = useState<{ result: SoftDeleteResponse; label: string } | null>(null);

  const base = storeSlug ? `/api/merchant/stores/${encodeURIComponent(storeSlug)}/catalog` : null;
  // PG-6: the search box belongs to the LIST screen. «الجرد» and the returns
  // queue read the same `products` array and have no search box of their own,
  // so a `?q=` left in the address bar must not narrow their haystack.
  const activeQuery = mode === "list" ? appliedQuery : "";
  // Phase 20A-2: `quiet` refreshes in place (after variant mutations) without
  // swapping the whole workspace to the loading state.
  const refresh = useCallback(
    async (quiet = false) => {
      if (!base) return;
      if (!quiet) setLoading(true);
      try {
        // PG-6: `limit` is unchanged — the cap is on the ANSWER now, not on the
        // haystack the browser then filtered, so page 2 of the catalog no longer
        // hides its own matches.
        const query = activeQuery ? `&q=${encodeURIComponent(activeQuery)}` : "";
        const [productData, categoryData] = await Promise.all([
          api<{ products: Product[] }>(`${base}/products?limit=100${query}`),
          api<{ categories: Category[] }>(`${base}/categories`),
        ]);
        setProducts(productData.products);
        setCategories(categoryData.categories);
        setMessage(null);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "تعذر تحميل بيانات المنتج.");
      } finally {
        setLoading(false);
        setSearching(false);
      }
    },
    [base, activeQuery]
  );

  // PG-6: a query-driven reload is QUIET. The loading branch below replaces the
  // whole workspace, which would unmount the search box and steal the caret on
  // every debounce tick; only a first load or a store switch earns it.
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    const quiet = loadedFor.current === base;
    loadedFor.current = base;
    void refresh(quiet);
  }, [refresh, base]);

  // PG-6: the palette's debounce, to the millisecond. Below the floor the
  // applied query is EMPTY — the unfiltered list is what sits behind the short
  // -query notice, so clearing the box restores it without a second round trip.
  useEffect(() => {
    const trimmed = listFilter.trim();
    const next = trimmed.length >= MIN_SEARCH_LENGTH ? trimmed : "";
    if (next === appliedQuery) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => setAppliedQuery(next), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [listFilter, appliedQuery]);

  // Phase 20A: a product is low-stock when ANY of its variants is low-stock
  // (matching the server-side merchant filter); legacy payloads without
  // variants fall back to the product flag.
  const lowStock = useMemo(
    () =>
      products.filter((product) =>
        product.variants?.length
          ? product.variants.some((variant) => variant.isLowStock)
          : product.isLowStock
      ),
    [products]
  );
  const trimmedFilter = listFilter.trim();
  const tooShort = trimmedFilter.length > 0 && trimmedFilter.length < MIN_SEARCH_LENGTH;

  function validateFiles(selected: File[]) {
    if (selected.length > 8) throw new Error("يمكن رفع 8 صور كحد أقصى لكل منتج.");
    // ق-238: خمسةَ عشر لا خمسة. الخمسة كانت سقفَ تخزينٍ يرتدي ثوبَ قاعدة رفع،
    // وهاتفٌ بـ48 ميغابكسل يتجاوزها روتينياً — فيُرفَض التاجر ويستنتج أنّ
    // المنصّة معطوبة. الخادم يُعيد ترميز ما يصله، فما يُخزَّن ~٥٦٠ كيلو مهما رفع.
    if (selected.some((file) => !allowedImageTypes.has(file.type) || file.size > 15 * 1024 * 1024))
      throw new Error("الصور المسموحة هي JPEG أو PNG أو WebP وبحجم لا يتجاوز 15 MB.");
  }

  async function createProduct(event: React.FormEvent) {
    event.preventDefault();
    if (!base) return;
    try {
      validateFiles(files);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "صور المنتج غير صالحة.");
      return;
    }
    setBusy(true);
    try {
      const created = await api<{ product: Product }>(`${base}/products`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...newProduct,
          priceIqd: Number(newProduct.priceIqd),
          stockQuantity: Number(newProduct.stockQuantity),
          lowStockThreshold: Number(newProduct.lowStockThreshold),
          categoryId: newProduct.categoryId || null,
          attributes: cleanAttributes(newProduct.attributes),
        }),
      });
      if (files.length) {
        const form = new FormData();
        files.forEach((file) => form.append("images", file));
        await api(`${base}/products/${created.product.id}/images`, { method: "POST", body: form });
      }
      setNewProduct({
        sku: "",
        name: "",
        description: "",
        priceIqd: "",
        stockQuantity: "0",
        lowStockThreshold: "0",
        categoryId: "",
        requiresPrescription: false,
        attributes: [] as AttributeGroup[],
      });
      setFiles([]);
      await refresh();
      setMessage("تم إنشاء المنتج وصوره داخل المتجر الحالي.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تعذر إنشاء المنتج.");
    } finally {
      setBusy(false);
    }
  }

  async function saveProduct(product: Product, values: Record<string, unknown>) {
    if (!base) return;
    setBusy(true);
    // ق-243: stock leaves the PATCH. The editor used to resend the quantity it
    // had LOADED on every save, and the server wrote it over the live stock —
    // a till sale that landed since the page opened was silently undone by a
    // typo fix in the description. Stock now travels ONLY when the merchant
    // changed the field, and only through the inventory door, carrying the
    // number he saw (`expectedStockQuantity`) so a stale tab is refused with
    // 409 instead of overwriting a sale.
    const { stockQuantity, ...catalogValues } = values;
    try {
      await api(`${base}/products/${product.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(catalogValues),
      });
      if (typeof stockQuantity === "number" && stockQuantity !== product.stockQuantity) {
        await api(`${base}/products/${product.id}/inventory`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            stockQuantity,
            expectedStockQuantity: product.stockQuantity,
            reason: "تعديل من شاشة المنتج",
          }),
        });
      }
      setEditing(null);
      await refresh();
      setMessage("تم تحديث المنتج.");
    } catch (error) {
      // The refresh on failure is not cosmetic: a 409 STOCK_CHANGED means the
      // number on screen is wrong, and the merchant must see the live one before
      // he decides again.
      setMessage(error instanceof Error ? error.message : "تعذر تحديث المنتج.");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  function askRemoveProduct(product: Product) {
    setUndo(null);
    setMessage(null);
    setDeleteTarget({
      entityType: "product",
      id: product.id,
      label: product.name,
      secondary: product.sku,
    });
  }

  // MD-1 «نسخ منتج بنقرة»: the server copies the product, its category and ALL
  // variants with fresh `-COPY…` SKUs. The copy starts at ZERO stock and WITHOUT
  // images — both stated up-front so the merchant is never surprised.
  async function duplicate(product: Product) {
    if (
      !base ||
      !window.confirm(
        `سيتم إنشاء نسخة من «${product.name}» بكل متغيراتها.\nالنسخة تُحفظ كمسودّة غير منشورة، ومخزونها يبدأ من صفر، والصور لا تُنسخ في هذه النسخة الأولى.\nانشريها بنفسك بعد ضبط المخزون والسعر.`
      )
    )
      return;
    setBusy(true);
    try {
      const created = await api<{ product: Product }>(`${base}/products/${product.id}/duplicate`, {
        method: "POST",
      });
      await refresh();
      setMessage(
        `تم إنشاء نسخة «${created.product.name}» بـ SKU ${created.product.sku} — مسودّة غير منشورة، المخزون صفر والصور غير منسوخة.`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تعذر نسخ المنتج.");
    } finally {
      setBusy(false);
    }
  }

  if (mode.startsWith("categories")) return <CategoryManager storeSlug={storeSlug} />;
  if (mode === "import-export") return <CsvTransferPanel storeSlug={storeSlug} />;
  if (!storeSlug)
    return (
      <div className="rounded-[24px] border border-[#F3CBCA] bg-[#FFF7F7] p-6 text-sm leading-7 text-[#9B3733]">
        <ShieldAlert className="mb-3 h-6 w-6" />
        اختر متجرًا عبر مسار لوحة التاجر المقيد بـ`store-slug` قبل إدارة المنتجات. لا تُحمّل واجهة
        المنتجات بيانات من دون سياق متجر صريح.
      </div>
    );
  if (loading)
    return (
      <div className="flex items-center gap-3 rounded-[24px] bg-[var(--codiq-surface)] p-7 text-sm text-[#61708A]">
        <LoaderCircle className="h-5 w-5 animate-spin text-[var(--codiq-accent)]" />
        جارٍ تحميل كتالوج المتجر…
      </div>
    );

  const ProductCard = ({ product }: { product: Product }) => (
    <article className="rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-4 shadow-sm">
      <div className="flex items-start gap-4">
        <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-xl bg-[var(--codiq-accent-soft)] text-xs text-[#416B9E]">
          {product.images[0] ? (
            <img
              src={`${base}/products/${product.id}/images/${product.images[0].id}?v=thumb`}
              alt={product.name}
              className="h-full w-full object-cover"
            />
          ) : (
            <ImagePlus className="h-5 w-5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-bold text-[#273753]">{product.name}</h3>
            {product.requiresPrescription ? (
              <span className="rounded-full bg-[#F2EEFF] px-2.5 py-1 text-[11px] font-bold text-[#6955B7]">
                بوصفة طبية
              </span>
            ) : null}
            <span
              className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${product.isLowStock ? "bg-[var(--codiq-danger-soft)] text-[#B44B40]" : "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]"}`}
            >
              {product.isLowStock ? "مخزون منخفض" : "المخزون متاح"}
            </span>
          </div>
          <p className="mt-1 text-xs text-[var(--codiq-text-muted)]">
            SKU: {product.sku} · {money.format(product.priceIqd)} د.ع · الكمية:{" "}
            {product.stockQuantity}
          </p>
          <p className="mt-1 text-xs text-[var(--codiq-text-muted)]">
            {product.category?.name ?? "بلا تصنيف"} · {product.images.length} صورة
          </p>
        </div>
      </div>
      {editing === product.id ? (
        <ProductEditor
          product={product}
          categories={categories}
          busy={busy}
          onSave={(values) => void saveProduct(product, values)}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(product.id)}>
            <Pencil className="ml-1 h-3.5 w-3.5" />
            تعديل
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid={`product-share-${product.sku}`}
            onClick={() => setSharing(product)}
          >
            <Share2 className="ml-1 h-3.5 w-3.5" />
            مشاركة
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            data-testid={`product-duplicate-${product.sku}`}
            onClick={() => void duplicate(product)}
          >
            <CopyPlus className="ml-1 h-3.5 w-3.5" />
            نسخ
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid={`product-delete-${product.sku}`}
            className="border-[#F0C7C4] text-[#B34B43] hover:bg-[#FFF7F7]"
            onClick={() => askRemoveProduct(product)}
          >
            <Trash2 className="ml-1 h-3.5 w-3.5" />
            إزالة
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid={`product-variants-toggle-${product.sku}`}
            aria-expanded={variantsOpen === product.id}
            onClick={() => setVariantsOpen(variantsOpen === product.id ? null : product.id)}
          >
            <Boxes className="ml-1 h-3.5 w-3.5" />
            المتغيرات ({product.variants?.length ?? 1})
          </Button>
        </div>
      )}
      {variantsOpen === product.id && base ? (
        <VariantManager
          base={base}
          productId={product.id}
          initial={product.variants}
          onChanged={() => void refresh(true)}
        />
      ) : null}
    </article>
  );

  return (
    <div className="space-y-5" dir="rtl">
      {sharing ? (
        <ProductShareCard
          storeSlug={storeSlug}
          product={{
            id: sharing.id,
            name: sharing.name,
            priceIqd: sharing.priceIqd, // ق-238: بطاقة المشاركة تُرسَم على canvas بحجمٍ اجتماعيّ — تأخذ «full».
            imageUrl: sharing.images[0]
              ? `${base}/products/${sharing.id}/images/${sharing.images[0].id}?v=full`
              : null,
          }}
          onClose={() => setSharing(null)}
        />
      ) : null}
      {message ? (
        <div className="rounded-2xl border border-[#D8E6F8] bg-[var(--codiq-canvas)] px-4 py-3 text-sm text-[#35577F]">
          {message}
        </div>
      ) : null}
      {undo ? (
        <UndoBar
          result={undo.result}
          label={undo.label}
          storeSlug={storeSlug}
          onUndone={() => {
            setUndo(null);
            void refresh();
            setMessage("أُعيد العنصر إلى متجرك.");
          }}
          onDismiss={() => setUndo(null)}
        />
      ) : null}
      {deleteTarget ? (
        <DeleteConfirmSheet
          storeSlug={storeSlug}
          target={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={(result) => {
            setUndo({ result, label: deleteTarget.label });
            void refresh();
          }}
          onDeactivated={() => {
            void refresh();
            setMessage("أُخفي المنتج عن الزبائن وبقي في لوحتك.");
          }}
        />
      ) : null}
      {mode === "add" ? (
        <form
          onSubmit={createProduct}
          className="space-y-5 rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-6 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-8"
        >
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]">
              <PackagePlus className="h-5 w-5" />
            </span>
            <div>
              <h2 className="font-bold text-[#273753]">إضافة منتج فعلي</h2>
              <p className="text-xs text-[var(--codiq-text-muted)]">
                سيُربط المنتج والتصنيف والصور والمخزون بالمتجر الحالي فقط.
              </p>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              required
              label="اسم المنتج"
              value={newProduct.name}
              onChange={(event) => setNewProduct({ ...newProduct, name: event.target.value })}
            />
            <Input
              required
              label="SKU"
              value={newProduct.sku}
              onChange={(event) => setNewProduct({ ...newProduct, sku: event.target.value })}
            />
            <Input
              required
              type="number"
              min="0"
              label="السعر بالدينار العراقي"
              value={newProduct.priceIqd}
              onChange={(event) => setNewProduct({ ...newProduct, priceIqd: event.target.value })}
            />
            <Input
              type="number"
              min="0"
              label="كمية المخزون"
              value={newProduct.stockQuantity}
              onChange={(event) =>
                setNewProduct({ ...newProduct, stockQuantity: event.target.value })
              }
            />
            <Input
              type="number"
              min="0"
              label="حد تنبيه المخزون"
              value={newProduct.lowStockThreshold}
              onChange={(event) =>
                setNewProduct({ ...newProduct, lowStockThreshold: event.target.value })
              }
            />
            <label className="block text-right">
              <span className="mb-1.5 block text-xs font-bold text-[var(--codiq-text-secondary)]">
                التصنيف
              </span>
              <select
                value={newProduct.categoryId}
                onChange={(event) =>
                  setNewProduct({ ...newProduct, categoryId: event.target.value })
                }
                className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3.5 py-2.5 text-sm text-[var(--codiq-text)]"
              >
                <option value="">بلا تصنيف</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block text-right">
            <span className="mb-1.5 block text-xs font-bold text-[var(--codiq-text-secondary)]">
              الوصف
            </span>
            <textarea
              value={newProduct.description}
              onChange={(event) =>
                setNewProduct({ ...newProduct, description: event.target.value })
              }
              rows={4}
              className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3.5 py-2.5 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]"
            />
          </label>
          <AttributesEditor
            value={newProduct.attributes}
            onChange={(attributes) => setNewProduct({ ...newProduct, attributes })}
          />
          <label className="flex items-start gap-3 rounded-2xl border border-[#E4D9F3] bg-[#FBF9FF] p-4 text-right">
            <input
              type="checkbox"
              data-testid="product-requires-prescription"
              checked={newProduct.requiresPrescription}
              onChange={(event) =>
                setNewProduct({ ...newProduct, requiresPrescription: event.target.checked })
              }
              className="mt-1 h-4 w-4 accent-[#6955B7]"
            />
            <span>
              <span className="block text-sm font-bold text-[#4B3E7E]">منتج بوصفة طبية</span>
              <span className="mt-1 block text-xs leading-6 text-[var(--codiq-text-muted)]">
                يطلب المتجر من الزبون رفع صورة الوصفة بعد إنشاء الطلب، ولا يمكن نقل الطلب إلى «قيد
                المعالجة» قبل اعتمادها.
              </span>
            </span>
          </label>
          <label className="block rounded-2xl border border-dashed border-[#B8CBE8] bg-[var(--codiq-surface-sunken)] p-4 text-right">
            <span className="mb-2 flex items-center gap-2 text-sm font-bold text-[#38557C]">
              <ImagePlus className="h-4 w-4" />
              صور المنتج
            </span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
              className="block w-full text-xs text-[#60728D]"
            />
            <span className="mt-2 block text-[11px] text-[#7B8BA1]">
              JPEG / PNG / WebP، 5 MB لكل صورة، و8 صور كحد أقصى.{" "}
              {files.length ? `تم اختيار ${files.length} صورة.` : ""}
            </span>
          </label>
          <Button
            disabled={busy}
            type="submit"
            className="rounded-xl bg-[var(--codiq-accent)] px-5"
          >
            {busy ? (
              <LoaderCircle className="ml-2 h-4 w-4 animate-spin" />
            ) : (
              <PackagePlus className="ml-2 h-4 w-4" />
            )}
            إنشاء المنتج
          </Button>
        </form>
      ) : null}
      {mode === "inventory" && base ? (
        <div className="space-y-3">
          {/* RI-1: the returns-inspection queue lives on the INVENTORY screen — the
        goods decision is inventory authority, and staff gating rides the same
        inventory.update the screen itself already requires. */}
          <ReturnInspectionCard storeSlug={storeSlug} />
          <ReturnInspectionHistory storeSlug={storeSlug} />
          {lowStock.map((product) => (
            <VariantInventoryPanel
              key={product.id}
              base={base}
              product={{ id: product.id, name: product.name, variants: product.variants ?? [] }}
              onChanged={() => void refresh(true)}
            />
          ))}
          {!lowStock.length ? (
            <div className="rounded-[24px] bg-[var(--codiq-success-soft)] p-6 text-sm text-[var(--codiq-success)]">
              لا توجد تنبيهات نفاد أو انخفاض مخزون حاليًا.
            </div>
          ) : null}
          <InventoryMovementsPanel
            storeSlug={storeSlug}
            products={products.map((product) => ({ id: product.id, name: product.name }))}
          />
        </div>
      ) : null}
      {mode === "list" ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-bold text-[#435672]" data-testid="product-list-count">
              {activeQuery
                ? `${products.length} منتج يطابق «${activeQuery}» في كامل المتجر`
                : `${products.length} منتج في المتجر الحالي`}
              {searching ? (
                <span className="ms-2 text-xs font-semibold text-[var(--codiq-text-muted)]">
                  جارٍ البحث…
                </span>
              ) : null}
            </p>
            <div className="flex items-center gap-2">
              <input
                aria-label="البحث في منتجات المتجر"
                data-testid="product-list-filter"
                value={listFilter}
                onChange={(event) => setListFilter(event.target.value)}
                placeholder="ابحث بالاسم أو SKU…"
                className="w-52 rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2 text-xs text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]"
              />
              {listFilter ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setListFilter("")}>
                  مسح
                </Button>
              ) : null}
              <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>
                <RefreshCw className="ml-1 h-3.5 w-3.5" />
                تحديث
              </Button>
            </div>
          </div>
          {/* PG-6: the floor the server's schema enforces, said on the client so a
          single character never becomes a 400 the merchant has to read. */}
          {tooShort ? (
            <div
              data-testid="product-search-min-length"
              className="rounded-[24px] bg-[var(--codiq-surface)] p-7 text-sm text-[var(--codiq-text-muted)]"
            >
              {SHORT_QUERY_MESSAGE}
            </div>
          ) : (
            <>
              {products.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
              {!products.length ? (
                <div className="rounded-[24px] bg-[var(--codiq-surface)] p-7 text-sm text-[var(--codiq-text-muted)]">
                  {activeQuery
                    ? "لا يطابق أي منتج هذه التصفية."
                    : "لا توجد منتجات بعد. استخدم «إضافة منتج» لإنشاء أول منتج فعلي."}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ProductEditor({
  product,
  categories,
  busy,
  onSave,
  onCancel,
}: {
  product: Product;
  categories: Category[];
  busy: boolean;
  onSave: (values: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(product.name);
  const [description, setDescription] = useState(product.description ?? "");
  const [priceIqd, setPriceIqd] = useState(String(product.priceIqd));
  const [quantity, setQuantity] = useState(String(product.stockQuantity));
  const [threshold, setThreshold] = useState(String(product.lowStockThreshold));
  const [categoryId, setCategoryId] = useState(product.category?.id ?? "");
  const [requiresPrescription, setRequiresPrescription] = useState(
    product.requiresPrescription === true
  );
  const [attributes, setAttributes] = useState<AttributeGroup[]>(product.attributes ?? []);
  return (
    <div className="mt-4 grid gap-3 rounded-2xl bg-[var(--codiq-surface-sunken)] p-4 sm:grid-cols-2">
      <Input label="الاسم" value={name} onChange={(event) => setName(event.target.value)} />
      <Input
        label="السعر"
        type="number"
        min="0"
        value={priceIqd}
        onChange={(event) => setPriceIqd(event.target.value)}
      />
      <Input
        label="الكمية"
        type="number"
        min="0"
        value={quantity}
        onChange={(event) => setQuantity(event.target.value)}
      />
      <Input
        label="حد التنبيه"
        type="number"
        min="0"
        value={threshold}
        onChange={(event) => setThreshold(event.target.value)}
      />
      <label className="block text-right sm:col-span-2">
        <span className="mb-1.5 block text-xs font-bold text-[var(--codiq-text-secondary)]">
          الوصف
        </span>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={3}
          className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3.5 py-2.5 text-sm"
        />
      </label>
      <label className="block text-right sm:col-span-2">
        <span className="mb-1.5 block text-xs font-bold text-[var(--codiq-text-secondary)]">
          التصنيف
        </span>
        <select
          value={categoryId}
          onChange={(event) => setCategoryId(event.target.value)}
          className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3.5 py-2.5 text-sm"
        >
          <option value="">بلا تصنيف</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </label>
      <div className="sm:col-span-2">
        <AttributesEditor value={attributes} onChange={setAttributes} />
      </div>
      <label className="flex items-center gap-2 text-right sm:col-span-2">
        <input
          type="checkbox"
          checked={requiresPrescription}
          onChange={(event) => setRequiresPrescription(event.target.checked)}
          className="h-4 w-4 accent-[#6955B7]"
        />
        <span className="text-xs font-bold text-[#4B3E7E]">منتج بوصفة طبية</span>
      </label>
      <div className="flex gap-2 sm:col-span-2">
        <Button
          disabled={busy}
          type="button"
          size="sm"
          onClick={() =>
            onSave({
              name,
              description,
              priceIqd: Number(priceIqd),
              stockQuantity: Number(quantity),
              lowStockThreshold: Number(threshold),
              categoryId: categoryId || null,
              requiresPrescription,
              attributes: cleanAttributes(attributes),
            })
          }
        >
          حفظ
        </Button>
        <Button disabled={busy} type="button" variant="outline" size="sm" onClick={onCancel}>
          إلغاء
        </Button>
      </div>
    </div>
  );
}

// ---------- Phase 20B-3 (D-25): CSV import/export ----------

type CsvRowError = { row: number; column: string; code: string; message: string };
type CsvPreview = {
  totalRows: number;
  newProducts: number;
  newVariants: number;
  errors: CsvRowError[];
};

/**
 * Mandatory-preview import flow (decision §8.8): the merchant uploads a UTF-8
 * CSV, a dry-run validates every row WITHOUT writing, the row errors render as
 * a table, and only an error-free preview unlocks the all-or-nothing commit.
 */
function CsvTransferPanel({ storeSlug }: { storeSlug?: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [result, setResult] = useState<{ createdProducts: number; createdVariants: number } | null>(
    null
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const base = storeSlug ? `/api/merchant/stores/${encodeURIComponent(storeSlug)}/catalog` : null;

  async function post(dryRun: boolean) {
    if (!base || !file) return;
    setBusy(true);
    setFailure(null);
    if (dryRun) {
      setPreview(null);
      setResult(null);
    }
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch(`${base}/import/products${dryRun ? "?dryRun=true" : ""}`, {
        method: "POST",
        credentials: "same-origin",
        body: form,
      });
      const payload = await response.json().catch(() => null);
      if (dryRun) {
        if (!response.ok) throw new Error(apiError(payload));
        setPreview(payload as CsvPreview);
      } else if (response.ok) {
        setResult(payload as { createdProducts: number; createdVariants: number });
        setPreview(null);
        setFile(null);
      } else if (payload?.validation) {
        // The file changed between preview and commit: show the fresh row errors.
        setPreview(payload.validation as CsvPreview);
        setFailure(apiError(payload));
      } else {
        throw new Error(apiError(payload));
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "تعذر معالجة الملف.");
    } finally {
      setBusy(false);
    }
  }

  if (!storeSlug || !base)
    return (
      <div
        className="rounded-[24px] border border-[#F3CBCA] bg-[#FFF7F7] p-6 text-sm leading-7 text-[#9B3733]"
        dir="rtl"
      >
        <ShieldAlert className="mb-3 h-6 w-6" />
        اختر متجرًا عبر مسار لوحة التاجر المقيد بـ`store-slug` قبل الاستيراد أو التصدير.
      </div>
    );
  return (
    <div className="max-w-[1030px] space-y-5" dir="rtl">
      {failure ? (
        <p
          data-testid="csv-error"
          className="rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"
        >
          {failure}
        </p>
      ) : null}
      {result ? (
        <p
          data-testid="csv-import-success"
          className="rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]"
        >
          تم الاستيراد بالكامل: {result.createdProducts} منتج جديد و{result.createdVariants} متغير
          إضافي داخل المتجر الحالي.
        </p>
      ) : null}
      <section className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]">
            <FileUp className="h-5 w-5" />
          </span>
          <div>
            <h2 className="font-bold text-[#273753]">استيراد منتجات من CSV</h2>
            <p className="mt-1 text-xs leading-6 text-[var(--codiq-text-muted)]">
              صف لكل متغير مع تجميع بعمود product_sku؛ أول صف لكل منتج ينشئه (إنشاء فقط — SKU
              الموجود يُرفض). حتى 2000 صف وملف 2 MB بترميز UTF-8. category_path بصيغة «أب &gt; فرع
              &gt; ورقة» حتى ثلاثة مستويات. المعاينة إلزامية والتنفيذ كل-أو-لا-شيء.
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <input
            type="file"
            accept=".csv,text/csv"
            data-testid="csv-file-input"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setPreview(null);
              setResult(null);
              setFailure(null);
            }}
            className="block text-xs text-[#60728D]"
          />
          <Button
            type="button"
            disabled={!file || busy}
            data-testid="csv-dryrun"
            onClick={() => void post(true)}
            className="rounded-xl bg-[var(--codiq-accent)]"
          >
            {busy ? (
              <LoaderCircle className="ml-2 h-4 w-4 animate-spin" />
            ) : (
              <FileUp className="ml-2 h-4 w-4" />
            )}
            فحص الملف (معاينة)
          </Button>
          <Button
            type="button"
            disabled={!file || busy || !preview || preview.errors.length > 0}
            data-testid="csv-commit"
            onClick={() => void post(false)}
            className="rounded-xl bg-[#1F7A4D] hover:bg-[#186340]"
          >
            تأكيد الاستيراد
          </Button>
        </div>
        {preview ? (
          <div className="mt-5 space-y-3">
            <p
              data-testid="csv-dryrun-summary"
              className="rounded-2xl bg-[var(--codiq-canvas)] px-4 py-3 text-sm font-semibold text-[#35577F]"
            >
              المعاينة: {preview.totalRows} صف بيانات — {preview.newProducts} منتج جديد و
              {preview.newVariants} متغير إضافي ·{" "}
              {preview.errors.length
                ? `${preview.errors.length} خطأ يمنع الاستيراد`
                : "لا أخطاء — يمكن تأكيد الاستيراد"}
              .
            </p>
            {preview.errors.length ? (
              <div className="overflow-x-auto rounded-2xl border border-[#F2CFCC]">
                <table
                  className="w-full min-w-[520px] text-right text-sm"
                  data-testid="csv-errors-table"
                >
                  <thead>
                    <tr className="bg-[#FFF6F5] text-[11px] font-bold text-[#A33B35]">
                      <th className="px-3 py-2">الصف</th>
                      <th className="px-3 py-2">العمود</th>
                      <th className="px-3 py-2">الخطأ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.errors.map((error, index) => (
                      <tr
                        key={`${error.row}-${error.column}-${index}`}
                        className="border-t border-[#F7E2E0]"
                      >
                        <td className="px-3 py-2 font-bold text-[#7D3A34]" dir="ltr">
                          {error.row}
                        </td>
                        <td className="px-3 py-2 text-xs text-[#7D3A34]" dir="ltr">
                          {error.column}
                        </td>
                        <td className="px-3 py-2 text-xs leading-6 text-[#7D3A34]">
                          {error.message}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
      <section className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]">
            <FileDown className="h-5 w-5" />
          </span>
          <div>
            <h2 className="font-bold text-[#273753]">تصدير المنتجات</h2>
            <p className="mt-1 text-xs leading-6 text-[var(--codiq-text-muted)]">
              ملف CSV ببث تدريجي بنفس أعمدة الاستيراد (يعاد استيراده كما هو) مع BOM لسلامة العربية
              في Excel.
            </p>
          </div>
        </div>
        <a
          data-testid="csv-export-products"
          href={`${base}/export/products.csv`}
          download
          className="mt-5 inline-flex items-center gap-2 rounded-xl border border-[#C9D9EE] bg-[var(--codiq-surface)] px-4 py-2.5 text-sm font-bold text-[var(--codiq-accent)] transition hover:bg-[var(--codiq-canvas)]"
        >
          <FileDown className="h-4 w-4" />
          تنزيل products.csv
        </a>
      </section>
    </div>
  );
}

// ---------- Nested category tree helpers (approved 2026-08-26) ----------
const CATEGORY_MAX_DEPTH = 3;

function categoryChildrenMap(categories: Category[]) {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const children = new Map<string | null, Category[]>();
  for (const category of categories) {
    const parentId =
      category.parentCategoryId && byId.has(category.parentCategoryId)
        ? category.parentCategoryId
        : null;
    children.set(parentId, [...(children.get(parentId) ?? []), category]);
  }
  return children;
}

function categoryDepth(categories: Category[], categoryId: string) {
  const byId = new Map(categories.map((category) => [category.id, category]));
  let depth = 1;
  let current = byId.get(categoryId);
  while (
    current?.parentCategoryId &&
    byId.has(current.parentCategoryId) &&
    depth <= CATEGORY_MAX_DEPTH
  ) {
    depth += 1;
    current = byId.get(current.parentCategoryId);
  }
  return depth;
}

function categoryDescendantIds(categories: Category[], categoryId: string) {
  const children = categoryChildrenMap(categories);
  const ids = new Set<string>();
  const walk = (id: string) => {
    for (const child of children.get(id) ?? []) {
      if (!ids.has(child.id)) {
        ids.add(child.id);
        walk(child.id);
      }
    }
  };
  walk(categoryId);
  return ids;
}

function categorySubtreeHeight(categories: Category[], categoryId: string): number {
  const children = categoryChildrenMap(categories);
  const walk = (id: string): number =>
    1 + Math.max(0, ...(children.get(id) ?? []).map((child) => walk(child.id)));
  return walk(categoryId);
}

/** Flat depth-first list of the tree, each entry annotated with its depth (1-based). */
function flattenCategoryTree(categories: Category[]) {
  const children = categoryChildrenMap(categories);
  const rows: Array<{ category: Category; depth: number }> = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const category of children.get(parentId) ?? []) {
      rows.push({ category, depth });
      if (depth < CATEGORY_MAX_DEPTH) walk(category.id, depth + 1);
    }
  };
  walk(null, 1);
  return rows;
}

function ParentCategorySelect({
  label,
  categories,
  value,
  excludeIds,
  movingSubtreeHeight,
  onChange,
}: {
  label: string;
  categories: Category[];
  value: string;
  excludeIds?: Set<string>;
  movingSubtreeHeight?: number;
  onChange: (value: string) => void;
}) {
  const height = movingSubtreeHeight ?? 1;
  const options = flattenCategoryTree(categories).filter(
    ({ category, depth }) => !excludeIds?.has(category.id) && depth + height <= CATEGORY_MAX_DEPTH
  );
  return (
    <label className="block text-right">
      <span className="mb-1.5 block text-xs font-bold text-[var(--codiq-text-secondary)]">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3.5 py-2.5 text-sm text-[var(--codiq-text)]"
      >
        <option value="">تصنيف رئيسي (بلا أب)</option>
        {options.map(({ category, depth }) => (
          <option
            key={category.id}
            value={category.id}
          >{`${" ".repeat(depth - 1)}${depth > 1 ? "└ " : ""}${category.name}`}</option>
        ))}
      </select>
    </label>
  );
}

function CategoryTreeRow({
  category,
  depth,
  childCount,
  busy,
  onRemove,
}: {
  category: Category;
  depth: number;
  childCount: number;
  busy: boolean;
  onRemove: (category: Category) => void;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-xl border border-[var(--codiq-border)] px-4 py-3"
      style={{ marginRight: (depth - 1) * 24 }}
    >
      <span className="flex items-center gap-2 text-sm font-semibold text-[#354761]">
        {depth > 1 ? (
          <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-[#9DACC2]" />
        ) : (
          <FolderTree className="h-3.5 w-3.5 shrink-0 text-[#7E93B4]" />
        )}
        {category.name}
        <span className="text-xs font-normal text-[#8391A4]">
          {category._count?.products ?? 0} منتج{childCount ? ` · ${childCount} فرع` : ""}
        </span>
      </span>
      <Button
        disabled={busy || (category._count?.products ?? 0) > 0 || childCount > 0}
        type="button"
        variant="ghost"
        size="sm"
        className="text-[#B34B43]"
        onClick={() => onRemove(category)}
      >
        إزالة
      </Button>
    </div>
  );
}

function CategoryManager({ storeSlug }: { storeSlug?: string }) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [newName, setNewName] = useState("");
  const [newParentId, setNewParentId] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [renamed, setRenamed] = useState("");
  const [editedParentId, setEditedParentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [undo, setUndo] = useState<{ result: SoftDeleteResponse; label: string } | null>(null);
  const base = storeSlug
    ? `/api/merchant/stores/${encodeURIComponent(storeSlug)}/catalog/categories`
    : null;
  const refresh = useCallback(async () => {
    if (!base) return;
    try {
      const data = await api<{ categories: Category[] }>(base);
      setCategories(data.categories);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تعذر تحميل التصنيفات.");
    }
  }, [base]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const selected = categories.find((category) => category.id === selectedId);
  const tree = useMemo(() => flattenCategoryTree(categories), [categories]);
  const childCounts = useMemo(() => {
    const children = categoryChildrenMap(categories);
    return new Map(
      categories.map((category) => [category.id, (children.get(category.id) ?? []).length])
    );
  }, [categories]);
  const editExcluded = useMemo(() => {
    if (!selectedId) return new Set<string>();
    const excluded = categoryDescendantIds(categories, selectedId);
    excluded.add(selectedId);
    return excluded;
  }, [categories, selectedId]);
  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!base || !newName.trim()) return;
    setBusy(true);
    try {
      await api(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newName, parentCategoryId: newParentId || null }),
      });
      setNewName("");
      setNewParentId("");
      await refresh();
      setMessage("تم إنشاء التصنيف.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تعذر إنشاء التصنيف.");
    } finally {
      setBusy(false);
    }
  }
  async function saveEdit(event: React.FormEvent) {
    event.preventDefault();
    if (!base || !selectedId || !renamed.trim()) return;
    setBusy(true);
    try {
      await api(`${base}/${selectedId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: renamed, parentCategoryId: editedParentId || null }),
      });
      await refresh();
      setMessage("تم حفظ تعديلات التصنيف.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تعذر تعديل التصنيف.");
    } finally {
      setBusy(false);
    }
  }
  function askRemove(category: Category) {
    setUndo(null);
    setMessage(null);
    setDeleteTarget({ entityType: "product_category", id: category.id, label: category.name });
  }
  if (!storeSlug)
    return (
      <div className="rounded-[24px] border border-[#F3CBCA] bg-[#FFF7F7] p-6 text-sm text-[#9B3733]">
        يلزم اختيار متجر صريح قبل إدارة التصنيفات.
      </div>
    );
  return (
    <div className="space-y-5" dir="rtl">
      {message ? (
        <div className="rounded-2xl border border-[#D8E6F8] bg-[var(--codiq-canvas)] px-4 py-3 text-sm text-[#35577F]">
          {message}
        </div>
      ) : null}
      {undo ? (
        <UndoBar
          result={undo.result}
          label={undo.label}
          storeSlug={storeSlug}
          onUndone={() => {
            setUndo(null);
            void refresh();
            setMessage("أُعيد التصنيف إلى متجرك.");
          }}
          onDismiss={() => setUndo(null)}
        />
      ) : null}
      {deleteTarget ? (
        <DeleteConfirmSheet
          storeSlug={storeSlug}
          target={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={(result) => {
            if (selectedId === deleteTarget.id) {
              setSelectedId("");
              setRenamed("");
              setEditedParentId("");
            }
            setUndo({ result, label: deleteTarget.label });
            void refresh();
          }}
        />
      ) : null}
      <div className="grid gap-5 lg:grid-cols-2">
        <form onSubmit={create} className="rounded-[26px] bg-[var(--codiq-surface)] p-6 shadow-sm">
          <h2 className="font-bold text-[#273753]">تصنيف جديد</h2>
          <p className="mt-1 text-xs leading-6 text-[var(--codiq-text-muted)]">
            يبقى الاسم فريدًا داخل المتجر الحالي فقط، ويمكن وضع التصنيف تحت تصنيف أب حتى ثلاثة
            مستويات.
          </p>
          <div className="mt-5 space-y-4">
            <Input
              required
              label="اسم التصنيف"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
            <ParentCategorySelect
              label="التصنيف الأب"
              categories={categories}
              value={newParentId}
              onChange={setNewParentId}
            />
          </div>
          <Button
            disabled={busy}
            type="submit"
            className="mt-4 rounded-xl bg-[var(--codiq-accent)]"
          >
            إضافة التصنيف
          </Button>
        </form>
        <form
          onSubmit={saveEdit}
          className="rounded-[26px] bg-[var(--codiq-surface)] p-6 shadow-sm"
        >
          <h2 className="font-bold text-[#273753]">تعديل تصنيف</h2>
          <div className="mt-5 space-y-4">
            <label className="block text-right">
              <span className="mb-1.5 block text-xs font-bold text-[var(--codiq-text-secondary)]">
                التصنيف
              </span>
              <select
                data-testid="category-edit-select"
                value={selectedId}
                onChange={(event) => {
                  const id = event.target.value;
                  setSelectedId(id);
                  const picked = categories.find((category) => category.id === id);
                  setRenamed(picked?.name ?? "");
                  setEditedParentId(picked?.parentCategoryId ?? "");
                }}
                className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3.5 py-2.5 text-sm"
              >
                <option value="">اختر تصنيفًا</option>
                {tree.map(({ category, depth }) => (
                  <option
                    key={category.id}
                    value={category.id}
                  >{`${" ".repeat(depth - 1)}${depth > 1 ? "└ " : ""}${category.name}`}</option>
                ))}
              </select>
            </label>
            <Input
              required
              label="الاسم الجديد"
              value={renamed}
              disabled={!selected}
              onChange={(event) => setRenamed(event.target.value)}
            />
            <ParentCategorySelect
              label="التصنيف الأب"
              categories={categories}
              value={editedParentId}
              excludeIds={editExcluded}
              movingSubtreeHeight={selectedId ? categorySubtreeHeight(categories, selectedId) : 1}
              onChange={setEditedParentId}
            />
          </div>
          <Button
            disabled={busy || !selectedId}
            type="submit"
            className="mt-4 rounded-xl bg-[var(--codiq-accent)]"
          >
            حفظ التعديلات
          </Button>
        </form>
      </div>
      <section className="rounded-[26px] bg-[var(--codiq-surface)] p-6 shadow-sm">
        <h2 className="font-bold text-[#273753]">شجرة تصنيفات المتجر</h2>
        <p className="mt-1 text-xs leading-6 text-[var(--codiq-text-muted)]">
          التصنيفات الفرعية تظهر بإزاحة تحت تصنيفها الأب. لا يمكن حذف تصنيف له فروع أو منتجات.
        </p>
        <div className="mt-4 space-y-2">
          {tree.map(({ category, depth }) => (
            <CategoryTreeRow
              key={category.id}
              category={category}
              depth={depth}
              childCount={childCounts.get(category.id) ?? 0}
              busy={busy}
              onRemove={askRemove}
            />
          ))}
          {!categories.length ? (
            <p className="text-sm text-[#7A879A]">لا توجد تصنيفات بعد.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
