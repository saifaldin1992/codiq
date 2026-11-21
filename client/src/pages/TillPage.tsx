/**
 * الكاشير (ق-132, ق-135) — the till: a FULL-SCREEN counter surface, deliberately
 * OUTSIDE the dashboard shell. A cashier with a queue does not navigate; the
 * three things he touches are reachable without a mouse:
 *
 *   1. the scan/search box — autofocused, refocused after every action; a
 *      barcode scanner types a SKU and sends Enter,
 *   2. the cart — steppers, an optional discount, the TOTAL in large type,
 *   3. «حصّل» — F2 or Ctrl+Enter, a compact cash panel, done.
 *
 * IDEMPOTENCY IS THE TILL'S JOB. `ticketId` is minted ONCE when the payment
 * panel opens and survives network failures — retrying reuses the SAME id,
 * which is what makes the server's replay path safe. Any cart or discount edit
 * discards it: an edited sale is a different sale.
 *
 * OUT-OF-STOCK STAYS SELLABLE. The unit already left the shelf and the cash is
 * in the drawer; the server clamps the decrement and records the shortfall.
 * Refusing at the till is the one thing this screen must never do.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Link, useParams } from "wouter";
import {
  Banknote,
  CircleAlert,
  CircleCheck,
  CloudOff,
  LayoutDashboard,
  LoaderCircle,
  Minus,
  MonitorSmartphone,
  Plus,
  RefreshCw,
  ScanBarcode,
  ShieldAlert,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getTillQueue, type QueueRecord } from "@/lib/till-queue";
import { registerTillServiceWorker, updateTillServiceWorker } from "@/lib/till-sw";
// PG-6 (ق-74): the ONE place a copy of `codiq_ar_normalize_v1` is unavoidable.
// `pnpm search:mirror` runs 76 strings through this file and through the SQL
// function and fails on the first byte of difference, so the offline answer and
// the online answer fold «قميص» the same way. Never write a second normalizer.
import { normalizeArabicV1, SEARCH_MIN_NEEDLE_LENGTH } from "@shared/search/arabic-normalize";

type PosDevice = {
  id: string;
  label: string;
  deviceShort: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
};
type CatalogVariant = {
  id: string;
  sku: string;
  name: string;
  priceIqd: number;
  stockQuantity: number;
  isDefault: boolean;
  isActive: boolean;
};
type CatalogProduct = {
  id: string;
  sku: string;
  name: string;
  isActive: boolean;
  variants: CatalogVariant[];
};
type CartLine = {
  variantId: string;
  productName: string;
  variantName: string;
  sku: string;
  unitPriceIqd: number;
  quantity: number;
};
type Shortfall = { variantId: string; shortfallQty: number };
/** orderNumber is null while the sale is queued locally («بانتظار المزامنة»). */
type DoneSale = {
  orderNumber: string | null;
  replayed: boolean;
  shortfalls: (Shortfall & { label: string })[];
  totalIqd: number;
  changeDue: number;
  queuedAt: number | null;
};

const money = new Intl.NumberFormat("ar-IQ");

/** IQD notes in circulation — the amounts a cashier is actually handed. */
const QUICK_NOTES = [1000, 5000, 10000, 25000, 50000];

/**
 * PG-6 (ق-74) — the till searches the SERVER when it can and its own snapshot
 * when it cannot, and the cashier is never told which.
 *
 * The snapshot (ق-142) is capped at 5×100 rows, so a shop with 3,000 products
 * used to report «no results» for everything past row 500 even with a perfect
 * connection. `GET /merchant/stores/:slug/pos/products?q=` sees the whole
 * catalog. But the snapshot is not an optimisation to be replaced — it is why
 * the till still sells during a power cut, so it stays the FALLBACK on every
 * failure: a refused request, a 4xx, a dead server, a cut cable. The grid
 * silently becomes the offline filter and the sale goes through.
 *
 * NOTHING on that path logs. `pos-offline.browser-acceptance.mjs` fails the run
 * on a console error, and rightly: a till that logs while «working» is one blip
 * away from not working.
 */
const SEARCH_DEBOUNCE_MS = 250;
const SHORT_QUERY_MESSAGE = "أدخل حرفين على الأقل للبحث.";

/** The snapshot filter — the offline answer, folded by the mirrored normalizer. */
function matchesNeedle(product: CatalogProduct, needle: string): boolean {
  return (
    normalizeArabicV1(product.name).includes(needle) ||
    normalizeArabicV1(product.sku).includes(needle) ||
    product.variants.some(
      (variant) =>
        normalizeArabicV1(variant.name).includes(needle) ||
        normalizeArabicV1(variant.sku).includes(needle)
    )
  );
}

/** isActive=false is the merchant's explicit «لا يُباع», at both search sources. */
function sellableSlice(products: CatalogProduct[]): CatalogProduct[] {
  return products
    .filter((product) => product.isActive)
    .map((product) => ({
      ...product,
      variants: product.variants.filter((variant) => variant.isActive),
    }))
    .filter((product) => product.variants.length > 0);
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

/** Digits only, accepting Arabic-Indic keyboards (٠١٢٣٤٥٦٧٨٩ / ۰-۹). */
function parseIqd(text: string): number {
  const ascii = text
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/\D/g, "");
  if (!ascii) return 0;
  const value = Number(ascii);
  return Number.isSafeInteger(value) ? value : 0;
}

/** Arabic counts change the noun: 1 and 2 have their own forms, 3–10 take the plural, 11+ return to the singular. */
function piecesPhrase(count: number): string {
  if (count === 1) return "قطعة واحدة";
  if (count === 2) return "قطعتين";
  if (count <= 10) return `${money.format(count)} قطع`;
  return `${money.format(count)} قطعة`;
}

function lineLabel(productName: string, variantName: string): string {
  return variantName && variantName !== productName
    ? `${productName} — ${variantName}`
    : productName;
}

const timeFormat = new Intl.DateTimeFormat("ar-IQ", { hour: "2-digit", minute: "2-digit" });
const DAY_MS = 24 * 60 * 60 * 1000;

/** Same count grammar as piecesPhrase, for queued sales. */
function salesPhrase(count: number): string {
  if (count === 1) return "بيعة واحدة";
  if (count === 2) return "بيعتين";
  if (count <= 10) return `${money.format(count)} بيعات`;
  return `${money.format(count)} بيعة`;
}

/** «منذ …» age of the catalog snapshot the offline till is selling from. */
function relativeAge(from: number): string {
  const minutes = Math.floor((Date.now() - from) / 60_000);
  if (minutes < 1) return "منذ لحظات";
  if (minutes === 1) return "منذ دقيقة";
  if (minutes === 2) return "منذ دقيقتين";
  if (minutes < 60)
    return minutes <= 10
      ? `منذ ${money.format(minutes)} دقائق`
      : `منذ ${money.format(minutes)} دقيقة`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "منذ ساعة";
  if (hours === 2) return "منذ ساعتين";
  if (hours < 24)
    return hours <= 10 ? `منذ ${money.format(hours)} ساعات` : `منذ ${money.format(hours)} ساعة`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "منذ يوم";
  if (days === 2) return "منذ يومين";
  return days <= 10 ? `منذ ${money.format(days)} أيام` : `منذ ${money.format(days)} يوماً`;
}

/** VARIANT_NOT_FOUND is un-poisonable (restore-from-trash) — say so instead of echoing the server. */
function failureHint(record: QueueRecord): string {
  if (record.lastError?.code === "VARIANT_NOT_FOUND")
    return "صنف محذوف من الكتالوج — أعد المنتج من سلة المحذوفات ثم أعد المحاولة.";
  return record.lastError?.message ?? "تعذر إتمام العملية.";
}

export default function TillPage() {
  const { storeSlug } = useParams<{ storeSlug: string }>();
  const slug = storeSlug ?? "";
  const base = `/api/merchant/stores/${encodeURIComponent(slug)}`;
  const deviceStorageKey = `codiq-till-device:${slug}`;

  const [devices, setDevices] = useState<PosDevice[] | null>(null);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [device, setDevice] = useState<PosDevice | null>(null);
  const [choosing, setChoosing] = useState(false);

  const [products, setProducts] = useState<CatalogProduct[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogReload, setCatalogReload] = useState(0);

  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [discountText, setDiscountText] = useState("");

  const [payment, setPayment] = useState<{ received: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [done, setDone] = useState<DoneSale | null>(null);

  // The ticket id lives OUTSIDE the payment panel's state on purpose: closing
  // the panel and reopening it without touching the cart must reuse the same
  // id, so a retry after a lost response stays a replay, never a second sale.
  const ticketRef = useRef<string | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  // ق-142: the scan box takes focus back on the NEXT FRAME, and a frame is long
  // enough for a modal to open inside it. A cashier who rings an item and
  // reaches for F2 in the same breath opens the payment panel — and then this
  // focus, scheduled by addLine BEFORE that panel existed, pulls him back to the
  // catalog filter. His first digits go into the search box, `payment.received`
  // never moves, and «تم — سجّل البيعة» sits disabled with nothing on screen
  // saying why. The frame may only land while the scan box is still the screen
  // he is on; whoever opened a panel over it owns focus until it closes, and
  // every close path calls focusScan again.
  const modalOwnsFocusRef = useRef(false);
  const focusScan = useCallback(() => {
    requestAnimationFrame(() => {
      if (!modalOwnsFocusRef.current) scanRef.current?.focus();
    });
  }, []);

  // ---------------------------------------------------------------- offline queue

  const queue = useMemo(() => getTillQueue(slug), [slug]);
  const queueState = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const [queueOpen, setQueueOpen] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [catalogAt, setCatalogAt] = useState<number | null>(null);
  const [catalogFromSnapshot, setCatalogFromSnapshot] = useState(false);
  const snapshotRef = useRef(false);
  useEffect(() => {
    snapshotRef.current = catalogFromSnapshot;
  }, [catalogFromSnapshot]);

  // A LAYOUT effect, not a passive one, and that is the whole point: a
  // requestAnimationFrame callback runs BEFORE the browser paints and a passive
  // effect runs after it, so a passive update would tell the pending frame the
  // truth one frame too late — which is exactly the frame that does the damage.
  useLayoutEffect(() => {
    modalOwnsFocusRef.current = Boolean(payment || done || revoked || choosing || queueOpen);
  });

  useEffect(() => {
    void queue.init();
    registerTillServiceWorker();
    updateTillServiceWorker();
    const onOnline = () => {
      // 'online' is a HINT: the queue's own flush concludes reachability from
      // fetch outcomes. It is also the moment a long-lived till checks for a
      // deploy and swaps a snapshot catalog for a fresh one.
      updateTillServiceWorker();
      if (snapshotRef.current) setCatalogReload((n) => n + 1);
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [queue]);

  // The current pairing decides whether a flush 403/404 halts the queue or
  // dead-letters a stale ticket; the cached object makes offline reboots sellable.
  useEffect(() => {
    queue.setActiveDevice(device?.id ?? null);
    if (device) void queue.saveDevice(device);
  }, [device, queue]);

  // A fresh DEVICE_REVOKED met by the background flush raises the same screen
  // the direct confirm path does.
  useEffect(() => {
    if (queueState.halt === "revoked") setRevoked(true);
  }, [queueState.halt]);

  const showOfflinePill = queueState.offline || catalogFromSnapshot;
  const [, setAgeTick] = useState(0);
  useEffect(() => {
    if (!showOfflinePill) return;
    const timer = window.setInterval(() => setAgeTick((n) => n + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [showOfflinePill]);

  // ---------------------------------------------------------------- devices

  const loadDevices = useCallback(async () => {
    setDevicesError(null);
    setDevices(null);
    try {
      const data = await api<{ devices: PosDevice[] }>(`${base}/pos/devices`);
      const active = data.devices.filter((entry) => !entry.revokedAt);
      setDevices(active);
      if (active.length === 1) {
        setDevice(active[0]!);
        setChoosing(false);
        return;
      }
      if (active.length > 1) {
        let stored: string | null = null;
        try {
          stored = localStorage.getItem(deviceStorageKey);
        } catch {
          /* private mode */
        }
        const remembered = active.find((entry) => entry.id === stored);
        if (remembered) {
          setDevice(remembered);
          setChoosing(false);
        } else {
          setDevice(null);
          setChoosing(true);
        }
      }
    } catch (error) {
      // Offline boot: the device OBJECT cached after the first successful load
      // restores a sellable till; pairing itself stays online-only.
      const cached = await queue.loadDevice<PosDevice>();
      if (cached) {
        setDevices([cached]);
        setDevice(cached);
        setChoosing(false);
        return;
      }
      setDevicesError(error instanceof Error ? error.message : "تعذر تحميل الأجهزة.");
    }
  }, [base, deviceStorageKey, queue]);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  function chooseDevice(entry: PosDevice) {
    setDevice(entry);
    setChoosing(false);
    // A device change makes the minted ticket a different sale's ticket.
    ticketRef.current = null;
    try {
      localStorage.setItem(deviceStorageKey, entry.id);
    } catch {
      /* best effort */
    }
    focusScan();
  }

  // ---------------------------------------------------------------- catalog

  useEffect(() => {
    let cancelled = false;
    setCatalogError(null);
    setProducts(null);
    (async () => {
      try {
        const all: CatalogProduct[] = [];
        let cursor: string | null = null;
        // 5 pages × 100 covers every plan tier today; the till filters in memory.
        for (let page = 0; page < 5; page += 1) {
          const url: string = `${base}/catalog/products?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
          const data: { products: CatalogProduct[]; nextCursor: string | null } = await api(url);
          all.push(...data.products);
          cursor = data.nextCursor;
          if (!cursor) break;
        }
        const active = all.filter((product) => product.isActive);
        if (!cancelled) {
          setProducts(active);
          setCatalogAt(Date.now());
          setCatalogFromSnapshot(false);
        }
        // Persisted after EVERY successful load — the snapshot is what a till
        // that boots offline sells from (capped by the 5×100 loader above).
        void queue.saveCatalog(active);
      } catch (error) {
        const snapshot = await queue.loadCatalog<CatalogProduct>();
        if (cancelled) return;
        if (snapshot) {
          setProducts(snapshot.products);
          setCatalogAt(snapshot.fetchedAt);
          setCatalogFromSnapshot(true);
          return;
        }
        setCatalogError(error instanceof Error ? error.message : "تعذر تحميل الكتالوج.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, catalogReload, queue]);

  // isActive=false VARIANTS are hidden too: deactivation is the merchant's
  // explicit «لا يُباع», unlike out-of-stock which stays sellable.
  const sellable = useMemo(() => sellableSlice(products ?? []), [products]);

  // ---------------------------------------------------------- PG-6: search
  const needle = search.trim();
  const foldedNeedle = normalizeArabicV1(search);
  const tooShort = needle.length > 0 && needle.length < SEARCH_MIN_NEEDLE_LENGTH;
  // The server's answer, tagged with the needle that produced it: a hit set is
  // only allowed to render for the exact needle on screen, so a landing
  // response can never re-filter a box the cashier has already retyped.
  const [remoteHits, setRemoteHits] = useState<{
    needle: string;
    products: CatalogProduct[];
  } | null>(null);
  // The palette's stale-response ticket, NOT an AbortController: aborting a
  // request Chromium has already opened can surface as a console line, and this
  // page's tripwire is armed with an empty allowlist.
  const searchTicket = useRef(0);

  useEffect(() => {
    // Below the floor nothing is asked of the server — its schema would answer
    // 400, which is a console error on a screen that must not produce any.
    if (needle.length < SEARCH_MIN_NEEDLE_LENGTH) {
      searchTicket.current += 1;
      setRemoteHits(null);
      return;
    }
    const ticket = (searchTicket.current += 1);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(
            `${base}/pos/products?q=${encodeURIComponent(needle)}&limit=100`,
            { credentials: "same-origin" }
          );
          if (ticket !== searchTicket.current) return;
          if (!response.ok) {
            setRemoteHits(null);
            return;
          }
          const payload = (await response.json()) as { products?: CatalogProduct[] };
          if (ticket !== searchTicket.current) return;
          setRemoteHits(
            Array.isArray(payload.products) ? { needle, products: payload.products } : null
          );
        } catch {
          // THE OFFLINE PATH, and it is deliberately silent. Dropping the hits
          // hands the grid back to the snapshot filter below; the cashier sees
          // products, not an error, and the sale he is halfway through lands in
          // the queue exactly as ق-142 designed it.
          if (ticket === searchTicket.current) setRemoteHits(null);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [base, needle]);

  // A device change or a fresh catalog invalidates nothing about the needle, but
  // a NEW STORE does — the hits belong to the store they were fetched from.
  useEffect(() => {
    searchTicket.current += 1;
    setRemoteHits(null);
  }, [base]);

  const remoteSellable = useMemo(() => sellableSlice(remoteHits?.products ?? []), [remoteHits]);
  /** The server answered for exactly this needle. Anything else falls back. */
  const serverAnswered = remoteHits !== null && remoteHits.needle === needle;

  const localFiltered = useMemo(() => {
    if (!foldedNeedle) return sellable;
    return sellable.filter((product) => matchesNeedle(product, foldedNeedle));
  }, [sellable, foldedNeedle]);

  const filtered = tooShort ? [] : serverAnswered ? remoteSellable : localFiltered;
  const searchSource = !needle ? "idle" : serverAnswered ? "server" : "local";

  // ---------------------------------------------------------------- cart

  const addLine = useCallback(
    (product: CatalogProduct, variant: CatalogVariant) => {
      ticketRef.current = null;
      setCart((prev) => {
        const existing = prev.find((line) => line.variantId === variant.id);
        if (existing)
          return prev.map((line) =>
            line.variantId === variant.id ? { ...line, quantity: line.quantity + 1 } : line
          );
        return [
          ...prev,
          {
            variantId: variant.id,
            productName: product.name,
            variantName: variant.name,
            sku: variant.sku,
            unitPriceIqd: variant.priceIqd,
            quantity: 1,
          },
        ];
      });
      focusScan();
    },
    [focusScan]
  );

  function stepLine(variantId: string, delta: 1 | -1) {
    ticketRef.current = null;
    setCart((prev) =>
      prev
        .map((line) =>
          line.variantId === variantId ? { ...line, quantity: line.quantity + delta } : line
        )
        .filter((line) => line.quantity > 0)
    );
    focusScan();
  }

  function clearCart() {
    ticketRef.current = null;
    setCart([]);
    setDiscountText("");
    setSaveFailed(false);
    focusScan();
  }

  const subtotal = cart.reduce((sum, line) => sum + line.quantity * line.unitPriceIqd, 0);
  const discount = Math.min(parseIqd(discountText), subtotal);
  const total = subtotal - discount;

  // Enter in the scan box: exactly one exact-SKU match adds instantly (the
  // barcode-scanner path); anything else leaves the filtered grid to pick from.
  function handleScanKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!foldedNeedle) return;
    const hits: { product: CatalogProduct; variant: CatalogVariant }[] = [];
    const seen = new Set<string>();
    // The SNAPSHOT first and unconditionally: it is the only pool a till with a
    // dead network has, and the scanner must resolve before any request could.
    // The server's hits are appended so a barcode whose product lives beyond
    // the cached 500 rows still scans — deduped by variant id, because a
    // product present in both pools must not read as two matches and refuse.
    for (const product of serverAnswered ? [...sellable, ...remoteSellable] : sellable) {
      for (const variant of product.variants) {
        if (seen.has(variant.id)) continue;
        seen.add(variant.id);
        if (normalizeArabicV1(variant.sku) === foldedNeedle) hits.push({ product, variant });
      }
    }
    if (hits.length === 1) {
      addLine(hits[0]!.product, hits[0]!.variant);
      setSearch("");
    }
  }

  // ---------------------------------------------------------------- payment

  const openPayment = useCallback(() => {
    if (!device || choosing || cart.length === 0 || submitting || done || revoked || payment)
      return;
    if (!ticketRef.current) ticketRef.current = crypto.randomUUID();
    setPayError(null);
    setPayment({ received: "" });
  }, [device, choosing, cart.length, submitting, done, revoked, payment]);

  function closePayment() {
    // Closing MID-FLIGHT is refused: the in-flight 201 would land on whatever
    // cart the cashier rings next and wipe it from a stale closure. Money and
    // server state stay right either way (same ticketId) — the guard protects
    // the SCREEN from lying for a second.
    if (submitting) return;
    // The ticket id survives the close: same cart, same sale, same id.
    setPayment(null);
    setPayError(null);
    focusScan();
  }

  async function confirmSale() {
    const ticketId = ticketRef.current;
    // The ref, not the state: state updates flush AFTER the second click of a
    // fast double-click has already dispatched. The server would dedupe the
    // sale anyway (UNIQUE on the ticket), but the optimistic stock decrement
    // would run twice and the done card would flash «replayed» at the cashier.
    if (!device || !payment || submitting || inFlight.current || !ticketId) return;
    inFlight.current = true;
    setSubmitting(true);
    setPayError(null);
    setSaveFailed(false);
    try {
      // ENQUEUE-THEN-SEND. deviceReportedAt is the confirm click — the moment
      // cash changes hands — and lives inside the persisted payload string,
      // which every retry resends VERBATIM: the server fingerprint hashes the
      // lines in array order, so recomputing at flush time would turn an
      // honest retry into a terminal 409.
      const soldLines = cart.map((line) => ({
        variantId: line.variantId,
        quantity: line.quantity,
        unitPriceIqd: line.unitPriceIqd,
      }));
      const record: QueueRecord = {
        ticketId,
        deviceId: device.id,
        payload: JSON.stringify({
          deviceId: device.id,
          ticketId,
          lines: soldLines,
          discountIqd: discount,
          totalIqd: total,
          deviceReportedAt: new Date().toISOString(),
        }),
        state: "pending",
        createdAt: Date.now(),
        attempts: 0,
        lastError: null,
        labels: cart.map((line) => ({
          variantId: line.variantId,
          label: lineLabel(line.productName, line.variantName),
        })),
        totalIqd: total,
        changeDue: Math.max(0, parseIqd(payment.received) - total),
        result: null,
      };
      const outcome = await queue.confirmEnqueue(record);
      if (outcome.kind === "unsaved") {
        // Money that would die with a reload — hard failure, never silent:
        // the panel stays open with the lines and total for the paper copy.
        setSaveFailed(true);
        return;
      }
      if (outcome.kind === "revoked") {
        setRevoked(true);
        return;
      }
      if (outcome.kind === "rejected") {
        // Cart intact, same ticketId — the confirm button IS the retry.
        setPayError(outcome.message);
        return;
      }

      // Post-success bookkeeping reads the QUEUE RECORD's lines and labels,
      // never the live cart — a flushed or replayed ticket has no cart. The
      // catalog's stock numbers follow the sale optimistically (the grid must
      // not advertise units this very sale took off the shelf), mirrored into
      // the IDB snapshot so consecutive offline sales see declining numbers.
      setProducts(
        (prev) =>
          prev?.map((product) => ({
            ...product,
            variants: product.variants.map((variant) => {
              let sold = 0;
              for (const line of soldLines) {
                if (line.variantId === variant.id) sold += line.quantity;
              }
              return sold
                ? { ...variant, stockQuantity: Math.max(0, variant.stockQuantity - sold) }
                : variant;
            }),
          })) ?? prev
      );
      void queue.mirrorStockSold(soldLines);

      const labelOf = (variantId: string) => {
        for (const entry of record.labels) {
          if (entry.variantId === variantId) return entry.label;
        }
        return variantId;
      };
      setDone(
        outcome.kind === "confirmed"
          ? {
              orderNumber: outcome.result.orderNumber,
              replayed: outcome.result.replayed,
              shortfalls: outcome.result.shortfalls.map((entry) => ({
                ...entry,
                label: labelOf(entry.variantId),
              })),
              totalIqd: record.totalIqd,
              changeDue: record.changeDue,
              queuedAt: null,
            }
          : {
              orderNumber: null,
              replayed: false,
              shortfalls: [],
              totalIqd: record.totalIqd,
              changeDue: record.changeDue,
              queuedAt: record.createdAt,
            }
      );
      setCart([]);
      setDiscountText("");
      setPayment(null);
      ticketRef.current = null;
    } catch (error) {
      // Cart intact, same ticketId — the confirm button IS the retry.
      setPayError(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setSubmitting(false);
      inFlight.current = false;
    }
  }

  function newSale() {
    setDone(null);
    setSearch("");
    focusScan();
  }

  function reloadAfterRevoke() {
    try {
      localStorage.removeItem(deviceStorageKey);
    } catch {
      /* best effort */
    }
    ticketRef.current = null;
    setRevoked(false);
    setPayment(null);
    setPayError(null);
    setDevice(null);
    // The halt was THIS pairing's; the new pairing decides the queue's fate.
    queue.resetHalt();
    void loadDevices();
  }

  // ---------------------------------------------------------------- keyboard

  // Registered every render so the handler always sees fresh state — the
  // listener is one function, re-attaching it is cheaper than a stale closure.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (done) {
        if (event.key === "Escape" || event.key === "F2") {
          event.preventDefault();
          newSale();
        }
        return;
      }
      if (revoked) return;
      if (queueOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          setQueueOpen(false);
          focusScan();
        }
        return;
      }
      if (payment) {
        // The panel owns its keys: Enter lives on the received input, Esc closes.
        if (event.key === "Escape") {
          event.preventDefault();
          closePayment();
        }
        return;
      }
      // The chooser opened from «تغيير الجهاز» has a device behind it, so Esc
      // may dismiss it; the first-run chooser (no device yet) may not be skipped.
      if (choosing && device && event.key === "Escape") {
        event.preventDefault();
        setChoosing(false);
        focusScan();
        return;
      }
      if (event.key === "F2" || (event.key === "Enter" && event.ctrlKey)) {
        event.preventDefault();
        openPayment();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSearch("");
        focusScan();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (device) focusScan();
  }, [device, focusScan]);

  // ---------------------------------------------------------------- render

  const received = payment ? parseIqd(payment.received) : 0;
  const shortChange = payment ? received - total : 0;

  const chip = "rounded-full px-2.5 py-1 text-[11px] font-bold";

  return (
    <div className="min-h-screen bg-[var(--codiq-canvas)] text-[var(--codiq-text)]">
      <header className="sticky top-0 z-40 border-b border-[var(--codiq-border)] bg-[var(--codiq-surface)]">
        <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-2xl bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent-on-soft)]">
              <Banknote className="h-5 w-5" />
            </span>
            <div>
              <h1 className="text-base font-bold leading-tight">الكاشير</h1>
              <p className="text-xs text-[var(--codiq-text-muted)]" dir="ltr">
                {slug}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {queueState.halt === "gone" ? (
              <span
                data-testid="till-queue-pill"
                className="flex items-center gap-2 rounded-xl bg-[var(--codiq-danger-soft)] px-3 py-1.5 text-xs font-bold text-[var(--codiq-danger)]"
              >
                <CloudOff className="h-4 w-4 shrink-0" /> تعذرت المزامنة — الجهاز غير معروف في هذا
                المتجر، نادِ المدير
              </span>
            ) : queueState.flushing && queueState.pending > 0 && !submitting ? (
              <span
                data-testid="till-queue-pill"
                className="flex items-center gap-2 rounded-xl bg-[var(--codiq-accent-soft)] px-3 py-1.5 text-xs font-bold text-[var(--codiq-accent-on-soft)]"
              >
                <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" /> جارٍ المزامنة (
                <span className="tabular-nums">{money.format(queueState.pending)}</span>)
              </span>
            ) : showOfflinePill ? (
              <span
                data-testid="till-queue-pill"
                className="flex items-center gap-2 rounded-xl bg-[var(--codiq-warning-soft)] px-3 py-1.5 text-xs font-bold text-[var(--codiq-warning)]"
              >
                <CloudOff className="h-4 w-4 shrink-0" />
                <span>
                  غير متصل — البيع مستمر
                  {catalogAt !== null ? ` من كتالوج محفوظ ${relativeAge(catalogAt)}` : ""}
                  {catalogAt !== null && Date.now() - catalogAt > DAY_MS
                    ? " · الأسعار وأرقام المخزون قد تكون قديمة"
                    : ""}
                </span>
              </span>
            ) : null}
            {queueState.records.length > 0 && (
              <button
                type="button"
                data-testid="till-queue-counters"
                onClick={() => setQueueOpen(true)}
                className="flex items-center gap-1.5 rounded-xl border border-[var(--codiq-border)] px-3 py-1.5 text-xs font-bold text-[var(--codiq-text-secondary)] transition hover:border-[var(--codiq-border-strong)] hover:text-[var(--codiq-text)]"
              >
                <span>
                  مؤكدة <span className="tabular-nums">{money.format(queueState.confirmed)}</span>
                </span>
                <span>
                  · معلّقة <span className="tabular-nums">{money.format(queueState.pending)}</span>
                </span>
                {queueState.failed > 0 && (
                  <span className="text-[var(--codiq-danger)]">
                    · فشلت <span className="tabular-nums">{money.format(queueState.failed)}</span>
                  </span>
                )}
              </button>
            )}
            {device && (
              <span className="flex items-center gap-2 rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface-sunken)] px-3 py-1.5 text-xs font-semibold text-[var(--codiq-text-secondary)]">
                <MonitorSmartphone className="h-4 w-4 text-[var(--codiq-accent)]" />
                {device.label}
                <span
                  className="font-bold tracking-widest text-[var(--codiq-accent-on-soft)]"
                  dir="ltr"
                >
                  {device.deviceShort}
                </span>
              </span>
            )}
            {device && (devices?.length ?? 0) > 1 && (
              <Button
                variant="ghost"
                size="sm"
                data-testid="till-change-device"
                className="text-xs font-bold text-[var(--codiq-text-muted)]"
                onClick={() => setChoosing(true)}
              >
                تغيير الجهاز
              </Button>
            )}
            {/* Back the way he CAME, not to a hardcoded dashboard: the till
                serves merchants AND staff (pos.sell), and their dashboards are
                different routes. history.back() returns each to his own; the
                merchant path is only the cold-start fallback (direct URL,
                bookmark) — a staff member cold-starting can use his sidebar. */}
            <button
              type="button"
              onClick={() => {
                if (window.history.length > 1) window.history.back();
                else
                  window.location.assign(`/merchant/stores/${encodeURIComponent(slug)}/dashboard`);
              }}
              data-testid="till-exit"
              className="flex items-center gap-1.5 rounded-xl border border-[var(--codiq-border)] px-3 py-1.5 text-xs font-bold text-[var(--codiq-text-secondary)] transition hover:border-[var(--codiq-border-strong)] hover:text-[var(--codiq-text)]"
            >
              <LayoutDashboard className="h-3.5 w-3.5" /> خروج إلى اللوحة
            </button>
          </div>
        </div>
      </header>

      {/* Session-family refusals PAUSE the queue — re-login drains it. Never a
          dead-letter: the sales behind this banner are real money. */}
      {queueState.halt === "session" && (
        <div
          data-testid="till-queue-session"
          className="border-b border-[var(--codiq-border)] bg-[var(--codiq-warning-soft)] px-4 py-2.5 text-center text-sm font-bold text-[var(--codiq-warning)]"
        >
          انتهت الجلسة —{" "}
          <Link
            href="/merchant/login"
            data-testid="till-queue-session-login"
            className="underline underline-offset-2"
          >
            سجّل الدخول
          </Link>{" "}
          لمزامنة {salesPhrase(queueState.pending)} محفوظة
        </div>
      )}
      {saveFailed && (
        <div
          data-testid="till-queue-save-failed-banner"
          className="border-b-2 border-[var(--codiq-danger)] bg-[var(--codiq-danger-soft)] px-4 py-3 text-center text-sm font-bold text-[var(--codiq-danger)]"
        >
          تعذر حفظ البيعة على هذا الجهاز — سجّلها ورقياً. السلة والإجمالي باقيان على الشاشة.
        </div>
      )}

      {/* -------- device loading / error / none -------- */}
      {devices === null && !devicesError && (
        <div className="mx-auto flex max-w-[1400px] items-center gap-3 p-6 text-sm text-[var(--codiq-text-muted)]">
          <LoaderCircle className="h-5 w-5 animate-spin text-[var(--codiq-accent)]" /> جارٍ تحميل
          أجهزة الكاشير…
        </div>
      )}
      {devicesError && (
        <div className="mx-auto max-w-[560px] p-6">
          <div className="rounded-2xl bg-[var(--codiq-danger-soft)] p-5 text-sm font-semibold text-[var(--codiq-danger)]">
            <p className="flex items-center gap-2">
              <CircleAlert className="h-4 w-4 shrink-0" /> {devicesError}
            </p>
            <Button
              variant="outline"
              size="sm"
              data-testid="till-devices-retry"
              className="mt-4 gap-2 rounded-xl"
              onClick={() => void loadDevices()}
            >
              <RefreshCw className="h-4 w-4" /> إعادة المحاولة
            </Button>
          </div>
        </div>
      )}
      {devices !== null && devices.length === 0 && (
        <div className="mx-auto max-w-[560px] p-6">
          <div className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-8 text-center shadow-[0_16px_44px_rgba(31,55,98,0.055)]">
            <MonitorSmartphone className="mx-auto mb-4 h-10 w-10 text-[var(--codiq-accent)]" />
            <h2 className="mb-2 text-lg font-bold">لا يوجد جهاز كاشير مربوط بهذا المتجر</h2>
            <p className="mb-6 text-sm leading-7 text-[var(--codiq-text-muted)]">
              اربط جهازاً أولاً من <strong>الإعدادات ← نقطة البيع</strong> في لوحة التاجر، ثم عُد
              إلى هذه الشاشة.
            </p>
            <Button asChild className="rounded-xl font-bold">
              <Link
                href={`/merchant/stores/${encodeURIComponent(slug)}/dashboard/settings/pos`}
                data-testid="till-goto-settings"
              >
                فتح الإعدادات
              </Link>
            </Button>
          </div>
        </div>
      )}

      {/* -------- the till itself -------- */}
      {device && (
        <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 p-4 sm:p-6 lg:flex-row lg:items-start">
          {/* catalog: scan box + grid */}
          <section className="min-w-0 flex-1">
            <div className="relative mb-4">
              <ScanBarcode className="pointer-events-none absolute start-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[var(--codiq-text-muted)]" />
              <Input
                ref={scanRef}
                data-testid="till-scan"
                autoFocus
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={handleScanKey}
                placeholder="امسح الباركود أو ابحث بالاسم أو SKU…"
                className="h-14 rounded-2xl border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] ps-12 text-lg font-semibold shadow-[0_16px_44px_rgba(31,55,98,0.055)]"
                autoComplete="off"
              />
            </div>

            {products === null && !catalogError && (
              <div className="flex items-center gap-3 rounded-[24px] bg-[var(--codiq-surface)] p-7 text-sm text-[var(--codiq-text-muted)]">
                <LoaderCircle className="h-5 w-5 animate-spin text-[var(--codiq-accent)]" /> جارٍ
                تحميل الكتالوج…
              </div>
            )}
            {catalogError && (
              <div className="rounded-2xl bg-[var(--codiq-danger-soft)] p-5 text-sm font-semibold text-[var(--codiq-danger)]">
                <p className="flex items-center gap-2">
                  <CircleAlert className="h-4 w-4 shrink-0" /> {catalogError}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="till-catalog-retry"
                  className="mt-4 gap-2 rounded-xl"
                  onClick={() => setCatalogReload((n) => n + 1)}
                >
                  <RefreshCw className="h-4 w-4" /> إعادة المحاولة
                </Button>
              </div>
            )}
            {/* PG-6: the floor the server's schema enforces, said here so a
                single character is never a 400 in the cashier's console. */}
            {products !== null && tooShort && (
              <p
                data-testid="till-search-min-length"
                className="rounded-[24px] bg-[var(--codiq-surface)] p-7 text-sm text-[var(--codiq-text-muted)]"
              >
                {SHORT_QUERY_MESSAGE}
              </p>
            )}
            {products !== null && !tooShort && filtered.length === 0 && (
              <p className="rounded-[24px] bg-[var(--codiq-surface)] p-7 text-sm text-[var(--codiq-text-muted)]">
                {needle ? `لا نتائج لـ «${needle}».` : "لا منتجات منشورة في هذا المتجر بعد."}
              </p>
            )}

            {/* `data-search-source` carries no pixels and no copy — it is how
                the acceptance suites tell «the server answered» from «the
                snapshot did», which is the whole claim of this change. */}
            <div
              data-testid="till-grid"
              data-search-source={searchSource}
              className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
            >
              {filtered.map((product) => {
                const multi = product.variants.length > 1;
                if (!multi) {
                  const variant = product.variants[0]!;
                  return (
                    <button
                      key={product.id}
                      type="button"
                      data-testid={`till-add-${variant.id}`}
                      onClick={() => addLine(product, variant)}
                      className="rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-4 text-start transition hover:border-[var(--codiq-accent)] focus-visible:border-[var(--codiq-accent)] focus-visible:outline-none"
                    >
                      <p className="mb-1 line-clamp-2 text-sm font-bold">{product.name}</p>
                      <p className="mb-3 text-[11px] text-[var(--codiq-text-muted)]" dir="ltr">
                        {variant.sku}
                      </p>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-bold tabular-nums text-[var(--codiq-accent-strong)]">
                          {money.format(variant.priceIqd)} د.ع
                        </span>
                        {variant.stockQuantity <= 0 ? (
                          <span
                            className={`${chip} bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]`}
                          >
                            نفد
                          </span>
                        ) : (
                          <span
                            className={`${chip} bg-[var(--codiq-neutral-soft)] tabular-nums text-[var(--codiq-text-secondary)]`}
                          >
                            {money.format(variant.stockQuantity)}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                }
                return (
                  <div
                    key={product.id}
                    className="rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-4"
                  >
                    <p className="mb-1 line-clamp-2 text-sm font-bold">{product.name}</p>
                    <p className="mb-3 text-[11px] text-[var(--codiq-text-muted)]" dir="ltr">
                      {product.sku}
                    </p>
                    <div className="space-y-1.5">
                      {product.variants.map((variant) => (
                        <button
                          key={variant.id}
                          type="button"
                          data-testid={`till-add-${variant.id}`}
                          onClick={() => addLine(product, variant)}
                          className="flex w-full items-center justify-between gap-2 rounded-xl bg-[var(--codiq-surface-sunken)] px-3 py-2 text-start transition hover:bg-[var(--codiq-accent-soft)] focus-visible:bg-[var(--codiq-accent-soft)] focus-visible:outline-none"
                        >
                          <span className="min-w-0 truncate text-xs font-semibold">
                            {variant.name}
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            <span className="text-xs font-bold tabular-nums text-[var(--codiq-accent-strong)]">
                              {money.format(variant.priceIqd)}
                            </span>
                            {variant.stockQuantity <= 0 ? (
                              <span
                                className={`${chip} bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]`}
                              >
                                نفد
                              </span>
                            ) : (
                              <span
                                className={`${chip} bg-[var(--codiq-surface)] tabular-nums text-[var(--codiq-text-secondary)]`}
                              >
                                {money.format(variant.stockQuantity)}
                              </span>
                            )}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* the cart */}
          <aside className="w-full shrink-0 lg:sticky lg:top-[84px] lg:w-[400px]">
            <div className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-5 shadow-[0_16px_44px_rgba(31,55,98,0.055)]">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-sm font-bold">
                  السلة
                  {cart.length > 0 && (
                    <span className="ms-2 rounded-full bg-[var(--codiq-accent-soft)] px-2 py-0.5 text-[11px] font-bold tabular-nums text-[var(--codiq-accent-on-soft)]">
                      {money.format(cart.length)}
                    </span>
                  )}
                </h2>
                {cart.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="till-clear-cart"
                    className="gap-1.5 text-xs font-bold text-[var(--codiq-text-muted)]"
                    onClick={clearCart}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> إفراغ
                  </Button>
                )}
              </div>

              {cart.length === 0 ? (
                <p className="rounded-2xl bg-[var(--codiq-surface-sunken)] px-4 py-6 text-center text-xs leading-6 text-[var(--codiq-text-muted)]">
                  مرّر باركوداً أو اختر من الشبكة لإضافة أول صنف.
                </p>
              ) : (
                <ul className="space-y-2">
                  {cart.map((line) => (
                    <li
                      key={line.variantId}
                      className="rounded-2xl border border-[var(--codiq-border)] px-3 py-2.5"
                    >
                      <p className="mb-2 text-xs font-bold leading-5">
                        {lineLabel(line.productName, line.variantName)}
                      </p>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1">
                          <Button
                            variant="outline"
                            size="icon-sm"
                            data-testid={`till-line-dec-${line.variantId}`}
                            aria-label="إنقاص الكمية"
                            className="rounded-lg"
                            onClick={() => stepLine(line.variantId, -1)}
                          >
                            <Minus className="h-3.5 w-3.5" />
                          </Button>
                          <span className="w-8 text-center text-sm font-bold tabular-nums">
                            {money.format(line.quantity)}
                          </span>
                          <Button
                            variant="outline"
                            size="icon-sm"
                            data-testid={`till-line-inc-${line.variantId}`}
                            aria-label="زيادة الكمية"
                            className="rounded-lg"
                            onClick={() => stepLine(line.variantId, 1)}
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        <div className="text-end">
                          <p className="text-[11px] tabular-nums text-[var(--codiq-text-muted)]">
                            {money.format(line.unitPriceIqd)} × {money.format(line.quantity)}
                          </p>
                          <p className="text-sm font-bold tabular-nums">
                            {money.format(line.quantity * line.unitPriceIqd)} د.ع
                          </p>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-4 space-y-2 border-t border-[var(--codiq-border)] pt-4">
                <div className="flex items-center justify-between text-xs text-[var(--codiq-text-secondary)]">
                  <span>المجموع</span>
                  <span className="font-bold tabular-nums">{money.format(subtotal)} د.ع</span>
                </div>
                <label className="flex items-center justify-between gap-3 text-xs text-[var(--codiq-text-secondary)]">
                  <span>الخصم (د.ع)</span>
                  <Input
                    data-testid="till-discount"
                    inputMode="numeric"
                    value={discountText}
                    onChange={(event) => {
                      ticketRef.current = null;
                      setDiscountText(event.target.value);
                    }}
                    onBlur={() => setDiscountText(discount > 0 ? String(discount) : "")}
                    placeholder="0"
                    className="h-9 w-28 rounded-xl text-end tabular-nums"
                  />
                </label>
                <div className="flex items-center justify-between pt-1">
                  <span className="text-sm font-bold">الإجمالي</span>
                  <span className="text-2xl font-bold tabular-nums text-[var(--codiq-accent-strong)]">
                    {money.format(total)} د.ع
                  </span>
                </div>
              </div>

              <Button
                data-testid="till-collect"
                disabled={cart.length === 0}
                onClick={openPayment}
                className="mt-4 w-full gap-2 rounded-2xl py-6 text-lg font-bold"
              >
                <Banknote className="h-5 w-5" /> حصّل
                <span
                  className="rounded-md bg-white/20 px-1.5 py-0.5 text-[11px] font-bold"
                  dir="ltr"
                >
                  F2
                </span>
              </Button>

              <p
                className="mt-3 text-center text-[11px] leading-5 text-[var(--codiq-text-muted)]"
                dir="ltr"
              >
                Enter = مسح/إضافة · F2 أو Ctrl+Enter = حصّل · Esc = إغلاق/مسح
              </p>
            </div>
          </aside>
        </main>
      )}

      {/* -------- device chooser (one-time, remembered per store) -------- */}
      {choosing && (devices?.length ?? 0) > 1 && !done && !revoked && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="اختيار جهاز الكاشير"
        >
          <div className="w-full max-w-[420px] rounded-[26px] bg-[var(--codiq-surface)] p-7">
            <h2 className="mb-1 text-lg font-bold">أي جهاز هذا؟</h2>
            <p className="mb-5 text-sm leading-6 text-[var(--codiq-text-muted)]">
              يُحفظ اختيارك على هذا المتصفح، وتغيّره لاحقاً من أعلى الشاشة.
            </p>
            <div className="space-y-2">
              {devices!.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  data-testid={`till-device-${entry.id}`}
                  onClick={() => chooseDevice(entry)}
                  className="flex w-full items-center justify-between gap-3 rounded-2xl border border-[var(--codiq-border)] px-4 py-4 text-start transition hover:border-[var(--codiq-accent)] focus-visible:border-[var(--codiq-accent)] focus-visible:outline-none"
                >
                  <span className="text-sm font-bold">{entry.label}</span>
                  <span
                    className="rounded-lg bg-[var(--codiq-accent-soft)] px-2 py-1 text-xs font-bold tracking-widest text-[var(--codiq-accent-on-soft)]"
                    dir="ltr"
                  >
                    {entry.deviceShort}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* -------- the cash panel -------- */}
      {payment && !done && !revoked && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="تحصيل المبلغ"
        >
          <div className="w-full max-w-[440px] rounded-[26px] bg-[var(--codiq-surface)] p-7">
            <div className="mb-5 text-center">
              <p className="mb-1 text-xs font-bold text-[var(--codiq-text-muted)]">المطلوب</p>
              <p className="text-4xl font-bold tabular-nums text-[var(--codiq-accent-strong)]">
                {money.format(total)} <span className="text-lg">د.ع</span>
              </p>
            </div>

            <label
              htmlFor="till-received"
              className="mb-1.5 block text-sm font-semibold text-[var(--codiq-text-secondary)]"
            >
              المبلغ المستلم
            </label>
            <Input
              id="till-received"
              data-testid="till-received"
              autoFocus
              inputMode="numeric"
              value={payment.received}
              onChange={(event) => setPayment({ received: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && received >= total && !submitting) {
                  event.preventDefault();
                  void confirmSale();
                }
              }}
              placeholder="0"
              className="h-14 rounded-2xl text-center text-2xl font-bold tabular-nums"
              autoComplete="off"
            />

            <div className="mt-3 flex flex-wrap justify-center gap-2">
              <Button
                variant="outline"
                size="sm"
                data-testid="till-quick-exact"
                className="rounded-xl font-bold"
                onClick={() => setPayment({ received: String(total) })}
              >
                مبلغ مضبوط
              </Button>
              {QUICK_NOTES.map((note) => (
                <Button
                  key={note}
                  variant="outline"
                  size="sm"
                  data-testid={`till-quick-${note}`}
                  className="rounded-xl font-bold tabular-nums"
                  onClick={() =>
                    setPayment((prev) => ({
                      received: String(parseIqd(prev?.received ?? "") + note),
                    }))
                  }
                >
                  +{money.format(note)}
                </Button>
              ))}
            </div>

            <div
              className={`mt-4 flex items-center justify-between rounded-2xl px-4 py-3 text-sm font-bold ${shortChange < 0 ? "bg-[var(--codiq-warning-soft)] text-[var(--codiq-warning)]" : "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]"}`}
            >
              <span>{shortChange < 0 ? "المتبقي على الزبون" : "الباقي للزبون"}</span>
              <span className="tabular-nums">{money.format(Math.abs(shortChange))} د.ع</span>
            </div>

            {payError && (
              <p
                data-testid="till-pay-error"
                className="mt-3 flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"
              >
                <CircleAlert className="h-4 w-4 shrink-0" /> {payError}
              </p>
            )}

            {/* A failed ENQUEUE write is money that dies with a reload — a hard
                failure, never the silent-degrade pattern conveniences use. */}
            {saveFailed && (
              <p
                data-testid="till-queue-save-failed"
                className="mt-3 flex items-center gap-2 rounded-2xl border-2 border-[var(--codiq-danger)] bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-bold leading-6 text-[var(--codiq-danger)]"
              >
                <TriangleAlert className="h-5 w-5 shrink-0" /> تعذر حفظ البيعة على هذا الجهاز —
                سجّلها ورقياً. السلة والإجمالي باقيان على الشاشة.
              </p>
            )}

            <Button
              data-testid="till-confirm"
              disabled={submitting || received < total}
              onClick={() => void confirmSale()}
              className="mt-4 w-full rounded-2xl py-6 text-base font-bold"
            >
              {submitting ? (
                <LoaderCircle className="h-5 w-5 animate-spin" />
              ) : payError ? (
                "إعادة المحاولة"
              ) : (
                "تم — سجّل البيعة"
              )}
            </Button>
            <Button
              variant="ghost"
              data-testid="till-close-payment"
              disabled={submitting}
              className="mt-2 w-full rounded-xl text-xs font-bold text-[var(--codiq-text-muted)]"
              onClick={closePayment}
            >
              إغلاق (Esc)
            </Button>
          </div>
        </div>
      )}

      {/* -------- revoked: its own state, not an error toast -------- */}
      {revoked && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="الجهاز ملغى"
        >
          <div className="w-full max-w-[420px] rounded-[26px] bg-[var(--codiq-surface)] p-8 text-center">
            <ShieldAlert className="mx-auto mb-4 h-10 w-10 text-[var(--codiq-danger)]" />
            <h2 className="mb-2 text-lg font-bold">هذا الجهاز أُلغي ربطه</h2>
            {queueState.pending + queueState.failed > 0 && (
              <p
                data-testid="till-queue-revoked-count"
                className="mb-4 rounded-2xl bg-[var(--codiq-warning-soft)] px-4 py-3 text-sm font-bold leading-6 text-[var(--codiq-warning)]"
              >
                {salesPhrase(queueState.pending + queueState.failed)} لم تُسجَّل بعد — تفاصيلها
                محفوظة في سجل المزامنة على هذا الجهاز.
              </p>
            )}
            <p className="mb-6 text-sm leading-7 text-[var(--codiq-text-muted)]">
              نادِ المدير: البيعة لم تُسجَّل، والسلة محفوظة كما هي. بعد ربط جهاز جديد من الإعدادات
              اضغط «تحديث الأجهزة» وأكمل من حيث توقفت.
            </p>
            <Button
              data-testid="till-revoked-reload"
              className="w-full rounded-xl font-bold"
              onClick={reloadAfterRevoke}
            >
              <RefreshCw className="h-4 w-4" /> تحديث الأجهزة
            </Button>
          </div>
        </div>
      )}

      {/* -------- done: the receipt number, big -------- */}
      {done && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="تم تسجيل البيعة"
        >
          <div className="w-full max-w-[460px] rounded-[26px] bg-[var(--codiq-surface)] p-8 text-center">
            <CircleCheck className="mx-auto mb-3 h-12 w-12 text-[var(--codiq-success)]" />
            <h2 className="mb-1 text-lg font-bold">تم تسجيل البيعة</h2>
            {/* The screen never claims more than the server confirmed: a queued
                sale gets the chip and its local time, never an order number. */}
            {done.queuedAt !== null ? (
              <div
                className="mb-4 flex items-center justify-center gap-2"
                data-testid="till-queue-pending-chip"
              >
                <span className="rounded-full bg-[var(--codiq-warning-soft)] px-3 py-1.5 text-sm font-bold text-[var(--codiq-warning)]">
                  بانتظار المزامنة
                </span>
                <span
                  className="text-sm font-bold tabular-nums text-[var(--codiq-text-muted)]"
                  dir="ltr"
                >
                  {timeFormat.format(done.queuedAt)}
                </span>
              </div>
            ) : (
              <p
                className="mb-4 text-3xl font-bold tabular-nums tracking-wide text-[var(--codiq-accent-strong)]"
                dir="ltr"
                data-testid="till-order-number"
              >
                {done.orderNumber}
              </p>
            )}

            {done.replayed && (
              <p className="mb-3 rounded-2xl bg-[var(--codiq-accent-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-accent-on-soft)]">
                كانت هذه البيعة مسجلة سابقاً — لم تُسجَّل مرتين.
              </p>
            )}

            {done.shortfalls.length > 0 && (
              <div
                className="mb-3 rounded-2xl bg-[var(--codiq-warning-soft)] px-4 py-3 text-start text-sm font-semibold text-[var(--codiq-warning)]"
                data-testid="till-shortfalls"
              >
                <p className="mb-1 flex items-center gap-2 font-bold">
                  <TriangleAlert className="h-4 w-4 shrink-0" /> بيع فوق المخزون
                </p>
                {done.shortfalls.map((entry) => (
                  <p key={entry.variantId} className="leading-6">
                    سُجّل عجز {piecesPhrase(entry.shortfallQty)} — {entry.label}
                  </p>
                ))}
              </div>
            )}

            <div className="mb-5 space-y-1.5 rounded-2xl bg-[var(--codiq-surface-sunken)] px-4 py-3 text-sm">
              <div className="flex items-center justify-between text-[var(--codiq-text-secondary)]">
                <span>الإجمالي</span>
                <span className="font-bold tabular-nums">{money.format(done.totalIqd)} د.ع</span>
              </div>
              <div className="flex items-center justify-between font-bold text-[var(--codiq-success)]">
                <span>الباقي للزبون</span>
                <span className="tabular-nums">{money.format(done.changeDue)} د.ع</span>
              </div>
            </div>

            <Button
              data-testid="till-new-sale"
              autoFocus
              className="w-full rounded-2xl py-6 text-base font-bold"
              onClick={newSale}
            >
              بيعة جديدة
            </Button>
          </div>
        </div>
      )}

      {/* -------- the queue drawer: every ticket, its state, its receipt -------- */}
      {queueOpen && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="سجل المزامنة"
        >
          <div
            className="flex max-h-[85vh] w-full max-w-[560px] flex-col rounded-[26px] bg-[var(--codiq-surface)] p-6"
            data-testid="till-queue-drawer"
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold">سجل المزامنة</h2>
              <Button
                variant="ghost"
                size="sm"
                data-testid="till-queue-close"
                className="text-xs font-bold text-[var(--codiq-text-muted)]"
                onClick={() => {
                  setQueueOpen(false);
                  focusScan();
                }}
              >
                إغلاق (Esc)
              </Button>
            </div>
            {queueState.records.length === 0 ? (
              <p className="rounded-2xl bg-[var(--codiq-surface-sunken)] px-4 py-6 text-center text-xs leading-6 text-[var(--codiq-text-muted)]">
                لا بيعات في السجل بعد.
              </p>
            ) : (
              <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto pe-1">
                {queueState.records
                  .slice()
                  .reverse()
                  .map((record) => (
                    <li
                      key={record.ticketId}
                      data-testid={`till-queue-row-${record.ticketId}`}
                      className="rounded-2xl border border-[var(--codiq-border)] px-3 py-2.5"
                    >
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <span
                          className="text-[11px] font-semibold tabular-nums text-[var(--codiq-text-muted)]"
                          dir="ltr"
                        >
                          {timeFormat.format(record.createdAt)}
                        </span>
                        {record.state === "confirmed" && record.result ? (
                          <span
                            className="rounded-full bg-[var(--codiq-success-soft)] px-2.5 py-1 text-[11px] font-bold tabular-nums text-[var(--codiq-success)]"
                            dir="ltr"
                          >
                            {record.result.orderNumber}
                          </span>
                        ) : record.state === "pending" ? (
                          <span className="rounded-full bg-[var(--codiq-warning-soft)] px-2.5 py-1 text-[11px] font-bold text-[var(--codiq-warning)]">
                            بانتظار المزامنة
                          </span>
                        ) : (
                          <span className="rounded-full bg-[var(--codiq-danger-soft)] px-2.5 py-1 text-[11px] font-bold text-[var(--codiq-danger)]">
                            فشلت
                          </span>
                        )}
                      </div>
                      <p className="mb-1.5 text-xs font-semibold leading-5">
                        {record.labels.map((entry) => entry.label).join("، ")}
                      </p>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-bold tabular-nums">
                          {money.format(record.totalIqd)} د.ع
                        </span>
                        {record.state === "failed" && (
                          <Button
                            variant="outline"
                            size="sm"
                            data-testid={`till-queue-retry-${record.ticketId}`}
                            className="gap-1.5 rounded-xl text-xs font-bold"
                            onClick={() => void queue.retryTicket(record.ticketId)}
                          >
                            <RefreshCw className="h-3.5 w-3.5" /> إعادة المحاولة
                          </Button>
                        )}
                      </div>
                      {record.state === "failed" && (
                        <p className="mt-1.5 text-[11px] font-semibold leading-5 text-[var(--codiq-danger)]">
                          {failureHint(record)}
                        </p>
                      )}
                    </li>
                  ))}
              </ul>
            )}
            <p className="mt-3 text-center text-[11px] leading-5 text-[var(--codiq-text-muted)]">
              يحفظ هذا الجهاز نسخة من الكتالوج حتى {money.format(500)} منتج كحدّ أقصى — ما بعدها لا
              يظهر في البيع دون اتصال.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
