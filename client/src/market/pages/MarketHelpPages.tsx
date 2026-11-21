/**
 * Marketplace M7a — «المفضّلة»، «الإشعارات»، «المساعدة»، «تواصل معنا» و«قيّم التطبيق».
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import {
  Bell,
  CheckCheck,
  ChevronDown,
  CircleAlert,
  Copy,
  Heart,
  LifeBuoy,
  LoaderCircle,
  Mail,
  MessageCircle,
  Package,
  Phone,
  RotateCcw,
  Search,
  Send,
  Star,
  Store,
} from "lucide-react";
import { accountCall, displayPhone, useShopper } from "../market-shopper";
import { marketGet } from "../market-api";
import type { MarketProductCard } from "../market-products";
import type { MarketStoreCard } from "../market-types";
import { useMarketList } from "../use-market-list";
import { ProductCard } from "../components/ProductCard";
import { StoreListRow } from "../components/StoreCards";
import { Stars } from "../components/OrderAfterSales";
import { MarketEmptyState } from "../MarketEmptyState";
import { MarketSignIn } from "./MarketAccountPages";

const tabClass = (on: boolean) =>
  `rounded-full px-3 py-1.5 text-xs font-bold ${on ? "bg-[var(--codiq-accent)] text-[var(--codiq-surface)]" : "bg-[var(--codiq-surface)] text-[var(--codiq-text-secondary)]"}`;
const card = "space-y-3 rounded-[24px] bg-[var(--codiq-surface)] p-4 shadow-sm";
const input =
  "w-full rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-2.5 text-sm text-[var(--codiq-text)]";
const primary =
  "flex w-full items-center justify-center gap-2 rounded-full bg-[var(--codiq-accent)] py-3 text-sm font-bold text-[var(--codiq-surface)] disabled:opacity-60";
const loading = (
  <p className="text-center text-sm text-[var(--codiq-text-muted)]">
    <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…
  </p>
);
const more = (load: () => Promise<void>) => (
  <button
    type="button"
    onClick={() => void load()}
    className="w-full rounded-full border border-[var(--codiq-border)] bg-[var(--codiq-surface)] py-2.5 text-sm font-bold text-[var(--codiq-accent)]"
  >
    عرض المزيد
  </button>
);

function Failure({ text }: { text: string | null }) {
  return text ? (
    <p
      className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-3 py-2 text-xs font-semibold text-[var(--codiq-danger)]"
      data-testid="market-help-error"
    >
      <CircleAlert className="h-4 w-4 shrink-0" /> {text}
    </p>
  ) : null;
}

// ── المفضّلة ─────────────────────────────────────────────────────────────────

export function MarketFavouritesPage() {
  const { status, shopper } = useShopper();
  const tab = new URLSearchParams(useSearch()).get("tab") === "stores" ? "stores" : "products";
  const [, navigate] = useLocation();
  const productsList = useMarketList<MarketProductCard>(
    shopper && tab === "products" ? "/api/market/favourites/products" : null,
    "products"
  );
  const storesList = useMarketList<MarketStoreCard>(
    shopper && tab === "stores" ? "/api/market/favourites/stores" : null,
    "stores"
  );
  if (status === "loading") return null;
  if (!shopper) return <MarketSignIn />;
  const list = tab === "products" ? productsList : storesList;
  return (
    <div className="space-y-4" data-testid="market-favourites">
      <h1 className="text-xl font-black text-[var(--codiq-text)]">المفضّلة</h1>
      <div className="flex gap-2">
        <button
          type="button"
          aria-pressed={tab === "products"}
          onClick={() => navigate("/favourites")}
          className={tabClass(tab === "products")}
          data-testid="market-favourites-tab-products"
        >
          المنتجات
        </button>
        <button
          type="button"
          aria-pressed={tab === "stores"}
          onClick={() => navigate("/favourites?tab=stores")}
          className={tabClass(tab === "stores")}
          data-testid="market-favourites-tab-stores"
        >
          المتاجر
        </button>
      </div>
      {!list.items ? loading : null}
      {list.items?.length === 0 ? (
        tab === "products" ? (
          <MarketEmptyState
            icon={Heart}
            title="لا منتجات في المفضّلة"
            body="اضغط على القلب في أيّ منتج ليُحفظ هنا."
            action={
              <Link
                href="/"
                className="rounded-full bg-[var(--codiq-accent)] px-5 py-2.5 text-sm font-bold text-[var(--codiq-surface)]"
              >
                تسوّق الآن
              </Link>
            }
          />
        ) : (
          <MarketEmptyState
            icon={Store}
            title="لا تتابع أيّ متجر بعد"
            body="اضغط «متابعة» في صفحة أيّ متجر ليظهر هنا."
            action={
              <Link
                href="/stores"
                className="rounded-full bg-[var(--codiq-accent)] px-5 py-2.5 text-sm font-bold text-[var(--codiq-surface)]"
              >
                تصفّح المتاجر
              </Link>
            }
          />
        )
      ) : null}
      {tab === "products" ? (
        <div className="grid grid-cols-2 gap-3">
          {productsList.items?.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {storesList.items?.map((store) => (
            <StoreListRow key={store.slug} store={store} />
          ))}
        </div>
      )}
      {list.nextCursor ? more(list.loadMore) : null}
    </div>
  );
}

// ── الإشعارات ────────────────────────────────────────────────────────────────

type InboxItem = {
  key: string;
  kind: "order" | "return";
  at: string;
  read: boolean;
  title: string;
  body: string;
  link: string;
};

const unreadListeners = new Set<(count: number) => void>();
export function announceUnread(count: number) {
  unreadListeners.forEach((listener) => listener(count));
}

/** The bell's number; re-read on navigation and whenever the inbox page changes it. */
export function useUnreadCount() {
  const { shopper } = useShopper();
  const [location] = useLocation();
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!shopper) {
      setCount(0);
      return;
    }
    void marketGet<{ unread: number }>("/api/market/inbox/unread")
      .then((body) => setCount(body.unread))
      .catch(() => undefined);
  }, [shopper, location]);
  useEffect(() => {
    unreadListeners.add(setCount);
    return () => {
      unreadListeners.delete(setCount);
    };
  }, []);
  return count;
}

export function MarketNotificationsPage() {
  const { status, shopper } = useShopper();
  const [, navigate] = useLocation();
  const [generation, setGeneration] = useState(0);
  const list = useMarketList<InboxItem>(
    shopper ? `/api/market/inbox?limit=20&g=${generation}` : null,
    "items"
  );
  if (status === "loading") return null;
  if (!shopper) return <MarketSignIn />;
  const unread = list.items?.filter((item) => !item.read).length ?? 0;
  async function open(item: InboxItem) {
    if (!item.read)
      await accountCall<{ unread: number }>("/api/market/inbox/read", {
        method: "POST",
        body: JSON.stringify({ key: item.key }),
      })
        .then((body) => announceUnread(body.unread))
        .catch(() => undefined);
    navigate(item.link);
  }
  async function readAll() {
    await accountCall("/api/market/inbox/read-all", { method: "POST" });
    announceUnread(0);
    setGeneration((value) => value + 1);
  }
  return (
    <div className="space-y-4" data-testid="market-notifications">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-black text-[var(--codiq-text)]">الإشعارات</h1>
        {unread ? (
          <button
            type="button"
            onClick={() => void readAll()}
            className="inline-flex items-center gap-1 text-xs font-bold text-[var(--codiq-accent)]"
            data-testid="market-notifications-read-all"
          >
            <CheckCheck className="h-4 w-4" /> تحديد الكلّ كمقروء
          </button>
        ) : null}
      </div>
      {!list.items ? loading : null}
      {list.items?.length === 0 ? (
        <MarketEmptyState
          icon={Bell}
          title="لا إشعارات بعد"
          body="ستصلك هنا تحديثات طلباتك وردود المتاجر."
        />
      ) : null}
      <ul className="space-y-2">
        {list.items?.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              onClick={() => void open(item)}
              className={`flex w-full items-start gap-3 rounded-[20px] p-3 text-right shadow-sm ${item.read ? "bg-[var(--codiq-surface)]" : "bg-[var(--codiq-accent-soft)]"}`}
              data-testid={`market-notification-${item.key}`}
              data-read={item.read ? "1" : "0"}
            >
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--codiq-surface)] text-[var(--codiq-accent)]">
                {item.kind === "return" ? (
                  <RotateCcw className="h-4 w-4" />
                ) : (
                  <Package className="h-4 w-4" />
                )}
              </span>
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="flex items-center justify-between gap-2">
                  <span className="text-sm font-black text-[var(--codiq-text)]">{item.title}</span>
                  {!item.read ? (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full bg-[var(--codiq-danger)]"
                      aria-label="غير مقروء"
                    />
                  ) : null}
                </span>
                <span className="block text-xs leading-5 text-[var(--codiq-text-secondary)]">
                  {item.body}
                </span>
                <span className="block text-[10px] text-[var(--codiq-text-muted)]">
                  {new Date(item.at).toLocaleString("ar-IQ")}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {list.nextCursor ? more(list.loadMore) : null}
    </div>
  );
}

// ── المساعدة ────────────────────────────────────────────────────────────────

type HelpArticle = {
  id: string;
  question: string;
  answer: string;
  isQuick: boolean;
  section?: { slug: string; title: string };
};
type HelpCenter = {
  query: string | null;
  results: HelpArticle[];
  quick: HelpArticle[];
  sections: { id: string; slug: string; title: string; articles: HelpArticle[] }[];
  contacts: {
    whatsapp: string | null;
    phone: string | null;
    email: string | null;
    hours: string | null;
  };
  contactKinds: { code: string; label: string }[];
};

function Answer({ article }: { article: HelpArticle }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-[var(--codiq-border)] last:border-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-2 py-3 text-right text-sm font-bold text-[var(--codiq-text)]"
        data-testid={`market-help-q-${article.id}`}
      >
        {article.question}
        <ChevronDown className={`h-4 w-4 shrink-0 transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <p
          className="whitespace-pre-line pb-3 text-xs leading-6 text-[var(--codiq-text-secondary)]"
          data-testid={`market-help-a-${article.id}`}
        >
          {article.answer}
        </p>
      ) : null}
    </div>
  );
}

export function MarketHelpPage() {
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [help, setHelp] = useState<HelpCenter | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    marketGet<HelpCenter>(`/api/market/help${applied ? `?q=${encodeURIComponent(applied)}` : ""}`, {
      signal: controller.signal,
    })
      .then(setHelp)
      .catch((error: Error) => {
        if (error.name !== "AbortError") setFailure(error.message);
      });
    return () => controller.abort();
  }, [applied]);
  const contacts = help?.contacts;
  return (
    <div className="space-y-4" data-testid="market-help">
      <h1 className="text-xl font-black text-[var(--codiq-text)]">كيف نساعدك؟</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setApplied(query.trim());
        }}
        role="search"
      >
        <label className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-surface)] px-3 py-2.5 shadow-sm">
          <Search className="h-4 w-4 text-[var(--codiq-text-muted)]" />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              if (!event.target.value) setApplied("");
            }}
            type="search"
            placeholder="ابحث في الأسئلة الشائعة"
            aria-label="بحث في المساعدة"
            className="w-full bg-transparent text-sm outline-none"
            data-testid="market-help-search"
          />
        </label>
      </form>
      <Failure text={failure} />
      {!help ? (
        loading
      ) : help.query ? (
        <section className={card} data-testid="market-help-results">
          <p className="text-sm font-black text-[var(--codiq-text)]">نتائج «{help.query}»</p>
          {help.results.length ? (
            help.results.map((article) => <Answer key={article.id} article={article} />)
          ) : (
            <p className="text-xs text-[var(--codiq-text-muted)]">
              لم نجد إجابة. جرّب كلمات أخرى أو تواصل معنا.
            </p>
          )}
        </section>
      ) : (
        <>
          {help.quick.length ? (
            <section className={card} data-testid="market-help-quick">
              <p className="text-sm font-black text-[var(--codiq-text)]">حلول سريعة</p>
              {help.quick.map((article) => (
                <Answer key={article.id} article={article} />
              ))}
            </section>
          ) : null}
          {help.sections.map((section) => (
            <section
              key={section.id}
              className={card}
              data-testid={`market-help-section-${section.slug}`}
            >
              <p className="text-sm font-black text-[var(--codiq-text)]">{section.title}</p>
              {section.articles.map((article) => (
                <Answer key={article.id} article={article} />
              ))}
            </section>
          ))}
        </>
      )}
      <section className={card} data-testid="market-help-contact">
        <p className="text-sm font-black text-[var(--codiq-text)]">ما زلت تحتاج مساعدة؟</p>
        {contacts?.hours ? (
          <p className="text-xs text-[var(--codiq-text-secondary)]">
            أوقات العمل: {contacts.hours}
          </p>
        ) : null}
        <div className="grid gap-2">
          <Link
            href="/help/contact"
            className="flex items-center justify-center gap-2 rounded-full bg-[var(--codiq-accent)] py-2.5 text-sm font-bold text-[var(--codiq-surface)]"
            data-testid="market-help-contact-form"
          >
            <Send className="h-4 w-4" /> راسلنا
          </Link>
          {contacts?.whatsapp ? (
            <a
              href={`https://wa.me/${contacts.whatsapp.replace(/[^\d]/g, "")}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 rounded-full border border-[var(--codiq-border)] py-2.5 text-sm font-bold text-[var(--codiq-text)]"
            >
              <MessageCircle className="h-4 w-4" /> واتساب
            </a>
          ) : null}
          {contacts?.phone ? (
            <div className="flex gap-2">
              <a
                href={`tel:${contacts.phone}`}
                className="flex flex-1 items-center justify-center gap-2 rounded-full border border-[var(--codiq-border)] py-2.5 text-sm font-bold text-[var(--codiq-text)]"
              >
                <Phone className="h-4 w-4" /> <span dir="ltr">{displayPhone(contacts.phone)}</span>
              </a>
              <button
                type="button"
                aria-label="نسخ الرقم"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(displayPhone(contacts.phone ?? ""))
                    .then(() => setCopied(true));
                }}
                className="rounded-full border border-[var(--codiq-border)] px-4 text-[var(--codiq-text)]"
              >
                <Copy className="h-4 w-4" />
              </button>
            </div>
          ) : null}
          {copied ? (
            <p className="text-center text-[11px] font-bold text-[var(--codiq-success)]">
              نُسخ الرقم
            </p>
          ) : null}
          {contacts?.email ? (
            <a
              href={`mailto:${contacts.email}`}
              className="flex items-center justify-center gap-2 rounded-full border border-[var(--codiq-border)] py-2.5 text-sm font-bold text-[var(--codiq-text)]"
            >
              <Mail className="h-4 w-4" /> {contacts.email}
            </a>
          ) : null}
        </div>
      </section>
    </div>
  );
}

export function MarketContactPage() {
  const { shopper } = useShopper();
  const [kinds, setKinds] = useState<{ code: string; label: string }[]>([]);
  const [kind, setKind] = useState("question");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  useEffect(() => {
    void marketGet<HelpCenter>("/api/market/help")
      .then((help) => setKinds(help.contactKinds))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (shopper) {
      setName((value) => value || shopper.fullName || "");
      setPhone((value) => value || displayPhone(shopper.phone));
    }
  }, [shopper]);
  if (sent)
    return (
      <MarketEmptyState
        icon={LifeBuoy}
        title="وصلتنا رسالتك"
        body="سيتواصل معك فريق الدعم على رقمك في أقرب وقت."
        action={
          <Link
            href="/help"
            className="rounded-full bg-[var(--codiq-accent)] px-5 py-2.5 text-sm font-bold text-[var(--codiq-surface)]"
          >
            العودة للمساعدة
          </Link>
        }
        testId="market-contact-sent"
      />
    );
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      await accountCall("/api/market/contact", {
        method: "POST",
        body: JSON.stringify({
          kind,
          name: name.trim(),
          phone: phone.replace(/\s/g, ""),
          body: body.trim(),
        }),
      });
      setSent(true);
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="space-y-4"
      data-testid="market-contact"
    >
      <Link href="/help" className="text-xs font-bold text-[var(--codiq-accent)]">
        ← المساعدة
      </Link>
      <h1 className="text-xl font-black text-[var(--codiq-text)]">تواصل معنا</h1>
      <section className={card}>
        <div className="flex flex-wrap gap-2">
          {kinds.map((entry) => (
            <button
              key={entry.code}
              type="button"
              aria-pressed={kind === entry.code}
              onClick={() => setKind(entry.code)}
              className={tabClass(kind === entry.code)}
              data-testid={`market-contact-kind-${entry.code}`}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <label className="block space-y-1 text-xs font-bold text-[var(--codiq-text-secondary)]">
          الاسم
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            required
            className={input}
            data-testid="market-contact-name"
          />
        </label>
        <label className="block space-y-1 text-xs font-bold text-[var(--codiq-text-secondary)]">
          رقم الهاتف
          <input
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            inputMode="tel"
            dir="ltr"
            placeholder="07XX XXX XXXX"
            required
            className={input}
            data-testid="market-contact-phone"
          />
        </label>
        <label className="block space-y-1 text-xs font-bold text-[var(--codiq-text-secondary)]">
          رسالتك
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={5}
            maxLength={2000}
            required
            className={input}
            data-testid="market-contact-body"
          />
        </label>
        <p className="text-[11px] text-[var(--codiq-text-muted)]">
          {body.trim().length < 10
            ? "اكتب ١٠ أحرف على الأقلّ."
            : `${body.trim().length.toLocaleString("ar-IQ")} / ٢٠٠٠`}
        </p>
        <Failure text={failure} />
        <button
          type="submit"
          disabled={busy || body.trim().length < 10 || !name.trim()}
          className={primary}
          data-testid="market-contact-submit"
        >
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}{" "}
          إرسال
        </button>
      </section>
    </form>
  );
}

export function MarketFeedbackPage() {
  const { status, shopper } = useShopper();
  const [likes, setLikes] = useState<{ code: string; label: string }[]>([]);
  const [stars, setStars] = useState(0);
  const [liked, setLiked] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    void marketGet<{ liked: { code: string; label: string }[] }>("/api/market/feedback/options")
      .then((body) => setLikes(body.liked))
      .catch(() => undefined);
  }, []);
  const prompt = useMemo(
    () => (stars >= 4 ? "ما الذي أعجبك؟" : stars ? "ما الذي نحسّنه؟" : ""),
    [stars]
  );
  if (status === "loading") return null;
  if (!shopper) return <MarketSignIn />;
  if (done)
    return (
      <MarketEmptyState
        icon={Star}
        title="شكراً لتقييمك"
        body="رأيك يساعدنا على تحسين السوق."
        action={
          <Link
            href="/"
            className="rounded-full bg-[var(--codiq-accent)] px-5 py-2.5 text-sm font-bold text-[var(--codiq-surface)]"
          >
            الرئيسيّة
          </Link>
        }
        testId="market-feedback-done"
      />
    );
  async function submit() {
    setBusy(true);
    setFailure(null);
    try {
      await accountCall("/api/market/feedback", {
        method: "POST",
        body: JSON.stringify({ stars, liked, note: note.trim() || undefined }),
      });
      setDone(true);
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4" data-testid="market-feedback">
      <h1 className="text-xl font-black text-[var(--codiq-text)]">قيّم التطبيق</h1>
      <section className={`${card} text-center`}>
        <p className="text-sm font-bold text-[var(--codiq-text)]">ما رأيك بتجربتك في السوق؟</p>
        <div className="flex justify-center">
          <Stars
            value={stars}
            onChange={setStars}
            label="تقييم التطبيق"
            testId="market-feedback-stars"
          />
        </div>
        {prompt ? <p className="text-sm font-black text-[var(--codiq-text)]">{prompt}</p> : null}
        {stars ? (
          <div className="flex flex-wrap justify-center gap-1.5">
            {likes.map((like) => {
              const on = liked.includes(like.code);
              return (
                <button
                  key={like.code}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setLiked(
                      on ? liked.filter((code) => code !== like.code) : [...liked, like.code]
                    )
                  }
                  className={tabClass(on)}
                  data-testid={`market-feedback-like-${like.code}`}
                >
                  {like.label}
                </button>
              );
            })}
          </div>
        ) : null}
        {stars ? (
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="ملاحظاتك (اختياريّ)"
            className={input}
            data-testid="market-feedback-note"
          />
        ) : null}
        <Failure text={failure} />
        <button
          type="button"
          disabled={!stars || busy}
          onClick={() => void submit()}
          className={primary}
          data-testid="market-feedback-submit"
        >
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null} إرسال التقييم
        </button>
      </section>
    </div>
  );
}
