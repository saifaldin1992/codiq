/**
 * «دعم السوق» — the owner's side of help: the FAQ (sections and answers, the
 * quick ones, drafts) and the support contacts; «تواصل معنا» messages with
 * «تمّت المعالجة»; and what shoppers think of the app.
 */
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CircleCheck, LoaderCircle, Plus, Star, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SupportTicketsWorkspace } from "@/components/SupportTicketsWorkspace";

type Tab = "tickets" | "help" | "messages" | "feedback";
const TABS: { id: Tab; label: string }[] = [
  { id: "tickets", label: "التذاكر" },
  { id: "help", label: "الأسئلة الشائعة" },
  { id: "messages", label: "رسائل تواصل معنا" },
  { id: "feedback", label: "تقييم التطبيق" },
];

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
  return body as T;
}
const input =
  "w-full rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-2 text-sm";
const card =
  "space-y-3 rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm";
type Report = { ok: (message: string) => void; fail: (message: string) => void };

export function PlatformMarketSupportPanel() {
  const [tab, setTab] = useState<Tab>("tickets");
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const report: Report = {
    ok: (message) => {
      setNotice(message);
      setFailure(null);
    },
    fail: (message) => {
      setFailure(message);
      setNotice(null);
    },
  };
  return (
    <div className="max-w-[1030px] space-y-4" data-testid="platform-market-support">
      <div className="flex flex-wrap gap-2">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-pressed={tab === entry.id}
            onClick={() => {
              setTab(entry.id);
              setFailure(null);
              setNotice(null);
            }}
            data-testid={`market-support-tab-${entry.id}`}
            className={`rounded-full px-3 py-1.5 text-sm font-bold ${tab === entry.id ? "bg-[var(--codiq-accent)] text-[var(--codiq-surface)]" : "bg-[var(--codiq-surface-sunken)] text-[var(--codiq-text-secondary)]"}`}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {failure ? (
        <p
          className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"
          data-testid="market-support-error"
        >
          <CircleAlert className="h-4 w-4" /> {failure}
        </p>
      ) : null}
      {notice ? (
        <p
          className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]"
          data-testid="market-support-notice"
        >
          <CircleCheck className="h-4 w-4" /> {notice}
        </p>
      ) : null}
      {tab === "tickets" ? (
        <SupportTicketsWorkspace kind="platform" />
      ) : tab === "help" ? (
        <HelpTab report={report} />
      ) : tab === "messages" ? (
        <MessagesTab report={report} />
      ) : (
        <FeedbackTab />
      )}
    </div>
  );
}

// ── FAQ ──────────────────────────────────────────────────────────────────────

type Article = {
  id: string;
  sectionId: string;
  question: string;
  answer: string;
  isQuick: boolean;
  isPublished: boolean;
  position: number;
};
type Section = { id: string; slug: string; title: string; position: number; articles: Article[] };
type Contacts = {
  whatsapp: string | null;
  phone: string | null;
  email: string | null;
  hours: string | null;
};
const EMPTY_ARTICLE = { question: "", answer: "", isQuick: false, isPublished: true, position: 0 };

function HelpTab({ report }: { report: Report }) {
  const [sections, setSections] = useState<Section[] | null>(null);
  const [contacts, setContacts] = useState<Contacts>({
    whatsapp: null,
    phone: null,
    email: null,
    hours: null,
  });
  const [newSection, setNewSection] = useState({ slug: "", title: "" });
  const [draft, setDraft] = useState<
    ({ id: string | null; sectionId: string } & typeof EMPTY_ARTICLE) | null
  >(null);
  const load = useCallback(async () => {
    try {
      const body = await call<{ sections: Section[]; contacts: Contacts }>(
        "/api/platform/market/help"
      );
      setSections(body.sections);
      setContacts(body.contacts);
    } catch (error) {
      report.fail((error as Error).message);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void load();
  }, [load]);
  async function run(action: () => Promise<unknown>, message: string) {
    try {
      await action();
      report.ok(message);
      await load();
    } catch (error) {
      report.fail((error as Error).message);
    }
  }
  if (!sections)
    return (
      <p className="text-sm text-[var(--codiq-text-muted)]">
        <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…
      </p>
    );
  return (
    <div className="space-y-4">
      <section className={card} data-testid="market-support-contacts">
        <h3 className="font-bold text-[var(--codiq-text)]">بيانات التواصل مع الدعم</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            value={contacts.whatsapp ?? ""}
            onChange={(event) => setContacts({ ...contacts, whatsapp: event.target.value || null })}
            placeholder="واتساب 07XXXXXXXXX"
            dir="ltr"
            className={input}
            data-testid="market-support-whatsapp"
          />
          <input
            value={contacts.phone ?? ""}
            onChange={(event) => setContacts({ ...contacts, phone: event.target.value || null })}
            placeholder="هاتف 07XXXXXXXXX"
            dir="ltr"
            className={input}
          />
          <input
            value={contacts.email ?? ""}
            onChange={(event) => setContacts({ ...contacts, email: event.target.value || null })}
            placeholder="البريد"
            dir="ltr"
            className={input}
          />
          <input
            value={contacts.hours ?? ""}
            onChange={(event) => setContacts({ ...contacts, hours: event.target.value || null })}
            placeholder="أوقات العمل"
            className={input}
            data-testid="market-support-hours"
          />
        </div>
        <Button
          onClick={() =>
            void run(
              () =>
                call("/api/platform/market/help/contacts", {
                  method: "PUT",
                  body: JSON.stringify({ ...contacts, email: contacts.email ?? null }),
                }),
              "حُفظت بيانات التواصل."
            )
          }
          data-testid="market-support-contacts-save"
        >
          حفظ
        </Button>
      </section>

      {draft ? (
        <section className={card} data-testid="market-support-article-form">
          <h3 className="font-bold text-[var(--codiq-text)]">
            {draft.id ? "تعديل سؤال" : "سؤال جديد"}
          </h3>
          <select
            value={draft.sectionId}
            onChange={(event) => setDraft({ ...draft, sectionId: event.target.value })}
            className={input}
          >
            {sections.map((section) => (
              <option key={section.id} value={section.id}>
                {section.title}
              </option>
            ))}
          </select>
          <input
            value={draft.question}
            onChange={(event) => setDraft({ ...draft, question: event.target.value })}
            placeholder="السؤال"
            maxLength={200}
            className={input}
            data-testid="market-support-question"
          />
          <textarea
            value={draft.answer}
            onChange={(event) => setDraft({ ...draft, answer: event.target.value })}
            placeholder="الجواب"
            rows={4}
            maxLength={4000}
            className={input}
            data-testid="market-support-answer"
          />
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.isQuick}
                onChange={(event) => setDraft({ ...draft, isQuick: event.target.checked })}
                data-testid="market-support-quick"
              />{" "}
              حلّ سريع
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.isPublished}
                onChange={(event) => setDraft({ ...draft, isPublished: event.target.checked })}
              />{" "}
              منشور
            </label>
            <label className="flex items-center gap-2">
              الترتيب{" "}
              <input
                type="number"
                min={0}
                max={1000}
                value={draft.position}
                onChange={(event) =>
                  setDraft({ ...draft, position: Number(event.target.value) || 0 })
                }
                className="w-20 rounded-lg border border-[var(--codiq-border)] px-2 py-1"
              />
            </label>
          </div>
          <div className="flex gap-2">
            <Button
              disabled={draft.question.trim().length < 3 || !draft.answer.trim()}
              onClick={() => {
                const { id, ...body } = draft;
                void run(
                  () =>
                    call(
                      id
                        ? `/api/platform/market/help/articles/${id}`
                        : "/api/platform/market/help/articles",
                      { method: id ? "PUT" : "POST", body: JSON.stringify(body) }
                    ),
                  "حُفظ السؤال."
                ).then(() => setDraft(null));
              }}
              data-testid="market-support-article-save"
            >
              حفظ
            </Button>
            <Button variant="outline" onClick={() => setDraft(null)}>
              إلغاء
            </Button>
          </div>
        </section>
      ) : null}

      {sections.map((section) => (
        <section
          key={section.id}
          className={card}
          data-testid={`market-support-section-${section.slug}`}
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-bold text-[var(--codiq-text)]">
              {section.title}{" "}
              <span className="text-xs font-normal text-[var(--codiq-text-muted)]">
                ({section.articles.length.toLocaleString("ar-IQ")})
              </span>
            </h3>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDraft({ id: null, sectionId: section.id, ...EMPTY_ARTICLE })}
                data-testid={`market-support-add-${section.slug}`}
              >
                <Plus className="h-4 w-4" /> سؤال
              </Button>
              {!section.articles.length ? (
                <Button
                  size="sm"
                  variant="outline"
                  aria-label="حذف القسم"
                  onClick={() =>
                    void run(
                      () =>
                        call(`/api/platform/market/help/sections/${section.id}`, {
                          method: "DELETE",
                        }),
                      "حُذف القسم."
                    )
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              ) : null}
            </div>
          </div>
          <ul className="divide-y divide-[var(--codiq-border)]">
            {section.articles.map((article) => (
              <li key={article.id} className="flex items-start justify-between gap-3 py-2">
                <button
                  type="button"
                  onClick={() =>
                    setDraft({
                      id: article.id,
                      sectionId: article.sectionId,
                      question: article.question,
                      answer: article.answer,
                      isQuick: article.isQuick,
                      isPublished: article.isPublished,
                      position: article.position,
                    })
                  }
                  className="min-w-0 text-right"
                >
                  <p className="text-sm font-semibold text-[var(--codiq-text)]">
                    {article.question}
                  </p>
                  <p className="text-xs text-[var(--codiq-text-muted)]">
                    {[article.isQuick ? "حلّ سريع" : null, article.isPublished ? null : "مسودّة"]
                      .filter(Boolean)
                      .join(" — ")}
                  </p>
                </button>
                <button
                  type="button"
                  aria-label="حذف السؤال"
                  onClick={() =>
                    void run(
                      () =>
                        call(`/api/platform/market/help/articles/${article.id}`, {
                          method: "DELETE",
                        }),
                      "حُذف السؤال."
                    )
                  }
                  className="text-[var(--codiq-danger)]"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <section className={card}>
        <h3 className="font-bold text-[var(--codiq-text)]">قسم جديد</h3>
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <input
            value={newSection.title}
            onChange={(event) => setNewSection({ ...newSection, title: event.target.value })}
            placeholder="العنوان"
            className={input}
          />
          <input
            value={newSection.slug}
            onChange={(event) => setNewSection({ ...newSection, slug: event.target.value })}
            placeholder="المعرّف (delivery)"
            dir="ltr"
            className={input}
          />
          <Button
            disabled={!newSection.title.trim() || !newSection.slug.trim()}
            onClick={() =>
              void run(
                () =>
                  call("/api/platform/market/help/sections", {
                    method: "POST",
                    body: JSON.stringify({ ...newSection, position: sections.length + 1 }),
                  }),
                "أُضيف القسم."
              ).then(() => setNewSection({ slug: "", title: "" }))
            }
          >
            إضافة
          </Button>
        </div>
      </section>
    </div>
  );
}

// ── «تواصل معنا» ─────────────────────────────────────────────────────────────

type Message = {
  id: string;
  kind: string;
  name: string;
  phone: string;
  body: string;
  status: string;
  handledAt: string | null;
  handledNote: string | null;
  createdAt: string;
};
const KIND_LABEL: Record<string, string> = {
  suggestion: "اقتراح",
  problem: "مشكلة",
  question: "استفسار",
};

function MessagesTab({ report }: { report: Report }) {
  const [status, setStatus] = useState<"new" | "handled">("new");
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const load = useCallback(
    async (after?: string) => {
      try {
        const body = await call<{ messages: Message[]; nextCursor: string | null }>(
          `/api/platform/market/contact-messages?status=${status}${after ? `&cursor=${encodeURIComponent(after)}` : ""}`
        );
        setMessages((current) => (after ? [...(current ?? []), ...body.messages] : body.messages));
        setCursor(body.nextCursor);
      } catch (error) {
        report.fail((error as Error).message);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status]
  );
  useEffect(() => {
    setMessages(null);
    void load();
  }, [load]);
  return (
    <section className={card} data-testid="market-support-messages">
      <div className="flex gap-2">
        {(["new", "handled"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={status === value}
            onClick={() => setStatus(value)}
            className={`rounded-full px-3 py-1 text-xs font-bold ${status === value ? "bg-[var(--codiq-accent)] text-[var(--codiq-surface)]" : "bg-[var(--codiq-surface-sunken)] text-[var(--codiq-text-secondary)]"}`}
          >
            {value === "new" ? "جديدة" : "تمّت معالجتها"}
          </button>
        ))}
      </div>
      {!messages ? (
        <LoaderCircle className="h-5 w-5 animate-spin text-[var(--codiq-text-muted)]" />
      ) : messages.length === 0 ? (
        <p className="text-sm text-[var(--codiq-text-muted)]">لا رسائل.</p>
      ) : (
        <ul className="divide-y divide-[var(--codiq-border)]">
          {messages.map((message) => (
            <li
              key={message.id}
              className="space-y-1 py-3"
              data-testid={`market-support-message-${message.id}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-bold text-[var(--codiq-text)]">
                  {KIND_LABEL[message.kind] ?? message.kind}: {message.name} —{" "}
                  <span dir="ltr">{message.phone}</span>
                </p>
                <span className="text-xs text-[var(--codiq-text-muted)]">
                  {new Date(message.createdAt).toLocaleString("ar-IQ")}
                </span>
              </div>
              <p className="whitespace-pre-line text-sm text-[var(--codiq-text-secondary)]">
                {message.body}
              </p>
              {message.status === "new" ? (
                <Button
                  size="sm"
                  onClick={() =>
                    void call(`/api/platform/market/contact-messages/${message.id}/handled`, {
                      method: "POST",
                      body: "{}",
                    })
                      .then(() => {
                        report.ok("عُلّمت الرسالة كمعالَجة.");
                        setMessages(
                          (current) => current?.filter((row) => row.id !== message.id) ?? null
                        );
                      })
                      .catch((error: Error) => report.fail(error.message))
                  }
                  data-testid={`market-support-handle-${message.id}`}
                >
                  تمّت المعالجة
                </Button>
              ) : (
                <p className="text-xs text-[var(--codiq-success)]">
                  عولجت{" "}
                  {message.handledAt ? new Date(message.handledAt).toLocaleDateString("ar-IQ") : ""}
                  {message.handledNote ? ` — ${message.handledNote}` : ""}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {cursor ? (
        <Button variant="outline" onClick={() => void load(cursor)}>
          المزيد
        </Button>
      ) : null}
    </section>
  );
}

// ── «تقييم التطبيق» ──────────────────────────────────────────────────────────

type Feedback = {
  average: number | null;
  count: number;
  distribution: { stars: number; count: number }[];
  feedback: {
    id: string;
    stars: number;
    likedLabels: string[];
    note: string | null;
    createdAt: string;
  }[];
  nextCursor: string | null;
};

function FeedbackTab() {
  const [data, setData] = useState<Feedback | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    void call<Feedback>("/api/platform/market/feedback")
      .then(setData)
      .catch((error: Error) => setFailure(error.message));
  }, []);
  if (failure) return <p className="text-sm text-[var(--codiq-danger)]">{failure}</p>;
  if (!data)
    return <LoaderCircle className="h-5 w-5 animate-spin text-[var(--codiq-text-muted)]" />;
  const top = Math.max(1, ...data.distribution.map((row) => row.count));
  return (
    <section className={card} data-testid="market-support-feedback">
      <p className="text-2xl font-black text-[var(--codiq-text)]">
        {data.average === null ? "—" : data.average.toLocaleString("ar-IQ")}{" "}
        <Star className="inline h-5 w-5 fill-[var(--codiq-rating)] text-[var(--codiq-rating)]" />{" "}
        <span className="text-sm font-normal text-[var(--codiq-text-muted)]">
          من {data.count.toLocaleString("ar-IQ")} تقييم
        </span>
      </p>
      <div className="space-y-1">
        {[...data.distribution].reverse().map((row) => (
          <div key={row.stars} className="flex items-center gap-2 text-xs">
            <span className="w-6">{row.stars.toLocaleString("ar-IQ")}★</span>
            <span className="h-2 flex-1 rounded-full bg-[var(--codiq-surface-sunken)]">
              <span
                className="block h-2 rounded-full bg-[var(--codiq-rating)]"
                style={{ width: `${(row.count / top) * 100}%` }}
              />
            </span>
            <span className="w-8 text-left">{row.count.toLocaleString("ar-IQ")}</span>
          </div>
        ))}
      </div>
      <ul className="divide-y divide-[var(--codiq-border)]">
        {data.feedback.map((row) => (
          <li key={row.id} className="py-2 text-sm">
            <p className="font-semibold text-[var(--codiq-text)]">
              {row.stars.toLocaleString("ar-IQ")}★{" "}
              {row.likedLabels.length ? `— ${row.likedLabels.join("، ")}` : ""}
            </p>
            {row.note ? <p className="text-[var(--codiq-text-secondary)]">{row.note}</p> : null}
            <p className="text-xs text-[var(--codiq-text-muted)]">
              {new Date(row.createdAt).toLocaleDateString("ar-IQ")}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
