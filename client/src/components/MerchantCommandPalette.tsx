/**
 * MD-1 «البحث الشامل الواحد» — one command palette for the merchant dashboard.
 *
 * Opens with Ctrl/⌘+K or the header button, searches products (name/SKU),
 * orders (order number/customer phone) and customers (name/phone) of the
 * CURRENT store through a single store-scoped endpoint, and jumps to the match.
 *
 * Client rules that mirror the server contract: a minimum of two characters
 * before any request, a 250 ms debounce, and one in-flight request at a time
 * (later responses win, earlier ones are discarded). The server is the sole
 * authority on scope — the palette sends nothing but the query string.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, PackageSearch, Receipt, Search, UserRound } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 250;

type SearchScope = "products" | "orders" | "customers";
type ProductHit = {
  id: string;
  sku: string;
  name: string;
  priceIqd: number;
  isActive: boolean;
  href: string;
};
type OrderHit = {
  id: string;
  orderNumber: string;
  status: string;
  customerName: string;
  totalIqd: number;
  createdAt: string;
  href: string;
};
type CustomerHit = { id: string; fullName: string; phone: string | null; href: string };
/**
 * `scopes` names the sections the SERVER was allowed to answer for this actor,
 * and only those sections are present in the payload at all. That distinction is
 * the point: a staff member without `customers.view` must be told the customer
 * section is not theirs, never shown an empty list that reads as "no such
 * customer".
 */
type SearchResults = {
  scopes: SearchScope[];
  truncated: SearchScope[];
  products: ProductHit[];
  orders: OrderHit[];
  customers: CustomerHit[];
};

const EMPTY_RESULTS: SearchResults = {
  scopes: [],
  truncated: [],
  products: [],
  orders: [],
  customers: [],
};
const scopeLabels: Record<SearchScope, string> = {
  products: "المنتجات",
  orders: "الطلبات",
  customers: "الزبائن",
};
const money = new Intl.NumberFormat("ar-IQ");

const orderStatusLabels: Record<string, string> = {
  new: "جديدة",
  processing: "قيد المعالجة",
  preparation: "قيد التجهيز",
  out_for_delivery: "قيد التوصيل",
  completed: "مكتملة",
  cancelled: "ملغاة",
  rejected: "مرفوضة",
  returned: "مرتجعة",
};

export function MerchantCommandPaletteButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      data-testid="global-search-open"
      onClick={onOpen}
      className="inline-flex items-center gap-2 rounded-full border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-1.5 text-xs font-semibold text-[var(--codiq-text-secondary)] shadow-sm transition hover:border-[#BED3EF] hover:text-[var(--codiq-accent-hover)]"
    >
      <Search className="h-4 w-4 text-[var(--codiq-accent)]" />
      <span>بحث شامل</span>
      <kbd
        className="hidden rounded-md bg-[var(--codiq-neutral-soft)] px-1.5 py-0.5 text-[10px] font-bold text-[#8490A5] sm:inline"
        dir="ltr"
      >
        Ctrl K
      </kbd>
    </button>
  );
}

export function useMerchantCommandPalette() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // `event.key` is undefined for some synthetic/IME events, and this is a
      // GLOBAL listener: an unguarded `.toLowerCase()` there throws on every
      // keystroke of an affected input, anywhere in the dashboard.
      if ((event.ctrlKey || event.metaKey) && event.key?.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return { open, setOpen };
}

export function MerchantCommandPalette({
  storeSlug,
  open,
  onOpenChange,
  navigate,
}: {
  storeSlug?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  navigate: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults>(EMPTY_RESULTS);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const requestId = useRef(0);

  const trimmed = query.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < MIN_QUERY_LENGTH;

  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults(EMPTY_RESULTS);
      setFailure(null);
      setLoading(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !storeSlug || trimmed.length < MIN_QUERY_LENGTH) {
      setResults(EMPTY_RESULTS);
      setLoading(false);
      return;
    }
    const ticket = (requestId.current += 1);
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/merchant/stores/${encodeURIComponent(storeSlug)}/search?q=${encodeURIComponent(trimmed)}`,
          { credentials: "same-origin" }
        );
        const payload = await response.json().catch(() => null);
        if (ticket !== requestId.current) return;
        if (!response.ok) {
          setResults(EMPTY_RESULTS);
          setFailure(payload?.error?.message ?? "تعذر تنفيذ البحث.");
          return;
        }
        setResults({
          scopes: payload.scopes ?? [],
          truncated: payload.truncated ?? [],
          products: payload.products ?? [],
          orders: payload.orders ?? [],
          customers: payload.customers ?? [],
        });
        setFailure(null);
      } catch {
        if (ticket === requestId.current) {
          setResults(EMPTY_RESULTS);
          setFailure("تعذر الاتصال بخدمة البحث.");
        }
      } finally {
        if (ticket === requestId.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, storeSlug, trimmed]);

  const go = useCallback(
    (href: string) => {
      onOpenChange(false);
      navigate(href);
    },
    [navigate, onOpenChange]
  );
  const total = useMemo(
    () => results.products.length + results.orders.length + results.customers.length,
    [results]
  );
  // What was actually searched, in the merchant's words — so "no results" can
  // never be confused with "you are not allowed to see that section".
  const searchedLabel = useMemo(
    () =>
      results.scopes.length
        ? results.scopes.map((scope) => scopeLabels[scope]).join(" و")
        : "المتجر الحالي",
    [results.scopes]
  );
  const truncatedLabel = useMemo(
    () => results.truncated.map((scope) => scopeLabels[scope]).join(" و"),
    [results.truncated]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-xl" showCloseButton={false}>
        <DialogTitle className="sr-only">البحث الشامل في المتجر الحالي</DialogTitle>
        <DialogDescription className="sr-only">
          ابحث في المنتجات والطلبات والزبائن ضمن متجر الجلسة فقط.
        </DialogDescription>
        <div dir="rtl">
          {/* shouldFilter=false: the server already filtered and ranked; cmdk must
              not re-filter the store-scoped results locally. */}
          <Command shouldFilter={false} className="rounded-none">
            {/* cmdk's own input, not a bare <input>: it carries role="combobox"
                with aria-expanded / aria-controls / aria-activedescendant, so a
                screen reader announces the active option and the result count
                as the merchant types. A plain input announces none of that. */}
            <div className="relative [&_[data-slot=command-input-wrapper]]:h-12 [&_[data-slot=command-input-wrapper]]:border-[var(--codiq-border)] [&_[data-slot=command-input-wrapper]]:px-4">
              <CommandInput
                autoFocus
                data-testid="global-search-input"
                aria-label="البحث الشامل"
                value={query}
                onValueChange={setQuery}
                placeholder="ابحث عن منتج أو طلب أو زبون…"
                className="h-12 text-sm text-[var(--codiq-text)] placeholder:text-[#9AA8BB]"
              />
              {loading ? (
                <LoaderCircle className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-[var(--codiq-accent)]" />
              ) : null}
            </div>
            <CommandList className="max-h-[340px]">
              {!storeSlug ? (
                <div className="px-4 py-6 text-center text-sm text-[#7D8BA0]">
                  اختر متجراً من مبدّل المتاجر قبل البحث.
                </div>
              ) : null}
              {storeSlug && tooShort ? (
                <div
                  data-testid="global-search-min-length"
                  className="px-4 py-6 text-center text-sm text-[#7D8BA0]"
                >
                  أدخل حرفين على الأقل للبحث.
                </div>
              ) : null}
              {failure ? (
                <div className="px-4 py-6 text-center text-sm font-semibold text-[var(--codiq-danger)]">
                  {failure}
                </div>
              ) : null}
              {storeSlug &&
              !failure &&
              !tooShort &&
              trimmed.length >= MIN_QUERY_LENGTH &&
              !loading &&
              total === 0 ? (
                <CommandEmpty data-testid="global-search-empty">
                  لا توجد نتائج مطابقة داخل {searchedLabel}.
                </CommandEmpty>
              ) : null}
              {results.products.length ? (
                <CommandGroup heading="المنتجات">
                  {results.products.map((product) => (
                    <CommandItem
                      key={product.id}
                      value={`product-${product.id}`}
                      data-testid={`global-search-product-${product.sku}`}
                      onSelect={() => go(product.href)}
                      className="cursor-pointer"
                    >
                      <PackageSearch className="ml-2 h-4 w-4 text-[var(--codiq-accent)]" />
                      <span className="flex min-w-0 flex-1 flex-col text-right">
                        <span className="truncate font-semibold text-[#273753]">
                          {product.name}
                        </span>
                        <span className="truncate text-[11px] text-[var(--codiq-text-muted)]">
                          SKU: {product.sku} · {money.format(product.priceIqd)} د.ع
                          {product.isActive ? "" : " · غير منشور"}
                        </span>
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
              {results.orders.length ? (
                <CommandGroup heading="الطلبات">
                  {results.orders.map((order) => (
                    <CommandItem
                      key={order.id}
                      value={`order-${order.id}`}
                      data-testid={`global-search-order-${order.orderNumber}`}
                      onSelect={() => go(order.href)}
                      className="cursor-pointer"
                    >
                      <Receipt className="ml-2 h-4 w-4 text-[var(--codiq-accent)]" />
                      <span className="flex min-w-0 flex-1 flex-col text-right">
                        <span className="truncate font-semibold text-[#273753]">
                          {order.orderNumber}
                        </span>
                        <span className="truncate text-[11px] text-[var(--codiq-text-muted)]">
                          {order.customerName} · {orderStatusLabels[order.status] ?? order.status} ·{" "}
                          {money.format(order.totalIqd)} د.ع
                        </span>
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
              {results.customers.length ? (
                <CommandGroup heading="الزبائن">
                  {results.customers.map((customer) => (
                    <CommandItem
                      key={customer.id}
                      value={`customer-${customer.id}`}
                      data-testid={`global-search-customer-${customer.id}`}
                      onSelect={() => go(customer.href)}
                      className="cursor-pointer"
                    >
                      <UserRound className="ml-2 h-4 w-4 text-[var(--codiq-accent)]" />
                      <span className="flex min-w-0 flex-1 flex-col text-right">
                        <span className="truncate font-semibold text-[#273753]">
                          {customer.fullName}
                        </span>
                        <span
                          className="truncate text-[11px] text-[var(--codiq-text-muted)]"
                          dir="ltr"
                        >
                          {customer.phone ?? "—"}
                        </span>
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
            </CommandList>
            <p
              data-testid="global-search-footer"
              className="border-t border-[var(--codiq-border)] px-4 py-2 text-[11px] leading-5 text-[#8490A5]"
            >
              نتائج متجر الجلسة فقط · البحث يشمل {searchedLabel} · حتى 5 نتائج لكل نوع
              {truncatedLabel ? (
                <span className="block font-bold text-[#A76B13]">
                  هناك مطابقات إضافية في {truncatedLabel} خارج أول 5 — أكمل كتابة البحث لتضييقه.
                </span>
              ) : null}
            </p>
          </Command>
        </div>
      </DialogContent>
    </Dialog>
  );
}
