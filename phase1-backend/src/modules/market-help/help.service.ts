/**
 * Marketplace M7 — «المساعدة»: the FAQ (owner-managed, searchable), «تواصل معنا»
 * and «قيّم التطبيق», and the support contacts the owner sets.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import { normalizeIraqiMobile } from "../../auth/identity.js";
import { consumeStorefrontRateLimit } from "../../services/storefront.service.js";
import { decodeListCursor, encodeListCursor, pageOf, parseListLimit } from "../../services/list-page.js";
import { normalizedSearchTerm } from "../../services/search/index.js";

// ── support contacts ───────────────────────────────────────────────────────

export type SupportContacts = { whatsapp: string | null; phone: string | null; email: string | null; hours: string | null };
const CONTACTS_KEY = "support_contacts";
const NO_CONTACTS: SupportContacts = { whatsapp: null, phone: null, email: null, hours: null };

export async function supportContacts(): Promise<SupportContacts> {
  const row = await prisma.marketSetting.findUnique({ where: { key: CONTACTS_KEY }, select: { value: true } });
  return { ...NO_CONTACTS, ...((row?.value ?? {}) as Partial<SupportContacts>) };
}

export async function setSupportContacts(input: SupportContacts) {
  const value = {
    whatsapp: input.whatsapp ? normalizeIraqiMobile(input.whatsapp) : null,
    phone: input.phone ? normalizeIraqiMobile(input.phone) : null,
    email: input.email?.trim().toLowerCase() || null,
    hours: input.hours?.trim() || null,
  };
  await prisma.marketSetting.upsert({ where: { key: CONTACTS_KEY }, create: { key: CONTACTS_KEY, value }, update: { value } });
  return value;
}

// ── FAQ ───────────────────────────────────────────────────────────────────

const ARTICLE_SELECT = { id: true, question: true, answer: true, isQuick: true, position: true } as const;

/** Sections with their published answers, the quick ones on top. Or, with `q`, only the matches. */
export async function helpCenter(rawQuery: string | undefined) {
  const normalized = rawQuery ? await normalizedSearchTerm(rawQuery) : null;
  const [sections, contacts] = await Promise.all([
    prisma.helpSection.findMany({
      orderBy: [{ position: "asc" }, { id: "asc" }],
      take: 30,
      select: { id: true, slug: true, title: true, articles: { where: { isPublished: true }, orderBy: [{ position: "asc" }, { id: "asc" }], take: 100, select: ARTICLE_SELECT } },
    }),
    supportContacts(),
  ]);
  if (normalized) {
    // Every word must appear; the generated column holds the normalized text.
    const words = normalized.split(" ").filter(Boolean).slice(0, 6);
    const conditions = words.map((word) => Prisma.sql`search_text LIKE '%' || codiq_like_escape(${word}) || '%'`);
    const matches = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM help_articles WHERE is_published AND ${Prisma.join(conditions, " AND ")} ORDER BY position, id LIMIT 50`;
    const ids = new Set(matches.map((row) => row.id));
    const results = sections.flatMap((section) => section.articles.filter((article) => ids.has(article.id)).map((article) => ({ ...article, section: { slug: section.slug, title: section.title } })));
    return { query: rawQuery, results, sections: [], quick: [], contacts };
  }
  const quick = sections.flatMap((section) => section.articles.filter((article) => article.isQuick).map((article) => ({ ...article, section: { slug: section.slug, title: section.title } })));
  return { query: null, results: [], sections: sections.filter((section) => section.articles.length), quick, contacts };
}

/** The owner's view: every section and article, published or not. */
export async function helpAdmin() {
  const sections = await prisma.helpSection.findMany({
    orderBy: [{ position: "asc" }, { id: "asc" }],
    take: 30,
    select: { id: true, slug: true, title: true, position: true, articles: { orderBy: [{ position: "asc" }, { id: "asc" }], take: 100, select: { ...ARTICLE_SELECT, isPublished: true, sectionId: true } } },
  });
  return { sections, contacts: await supportContacts() };
}

export async function createHelpSection(input: { slug: string; title: string; position: number }) {
  if (await prisma.helpSection.findUnique({ where: { slug: input.slug }, select: { id: true } })) throw new HttpError(409, "HELP_SECTION_EXISTS", "يوجد قسم بهذا المعرّف.");
  return { section: await prisma.helpSection.create({ data: input, select: { id: true, slug: true, title: true, position: true } }) };
}

export async function updateHelpSection(id: string, input: { title: string; position: number }) {
  const found = await prisma.helpSection.updateMany({ where: { id }, data: input });
  if (!found.count) throw new HttpError(404, "HELP_SECTION_NOT_FOUND", "القسم غير موجود.");
  return { ok: true };
}

export async function deleteHelpSection(id: string) {
  if (await prisma.helpArticle.count({ where: { sectionId: id } })) throw new HttpError(409, "HELP_SECTION_NOT_EMPTY", "انقل أسئلة القسم أو احذفها أولاً.");
  await prisma.helpSection.deleteMany({ where: { id } });
  return { ok: true };
}

type ArticleInput = { sectionId: string; question: string; answer: string; isQuick: boolean; isPublished: boolean; position: number };

export async function createHelpArticle(input: ArticleInput) {
  if (!(await prisma.helpSection.findUnique({ where: { id: input.sectionId }, select: { id: true } }))) throw new HttpError(422, "HELP_SECTION_NOT_FOUND", "القسم غير موجود.");
  return { article: await prisma.helpArticle.create({ data: input, select: { ...ARTICLE_SELECT, isPublished: true, sectionId: true } }) };
}

export async function updateHelpArticle(id: string, input: ArticleInput) {
  if (!(await prisma.helpSection.findUnique({ where: { id: input.sectionId }, select: { id: true } }))) throw new HttpError(422, "HELP_SECTION_NOT_FOUND", "القسم غير موجود.");
  const found = await prisma.helpArticle.updateMany({ where: { id }, data: input });
  if (!found.count) throw new HttpError(404, "HELP_ARTICLE_NOT_FOUND", "السؤال غير موجود.");
  return { ok: true };
}

export async function deleteHelpArticle(id: string) {
  await prisma.helpArticle.deleteMany({ where: { id } });
  return { ok: true };
}

// ── «تواصل معنا» ───────────────────────────────────────────────────────────

export const CONTACT_KINDS = [{ code: "suggestion", label: "اقتراح" }, { code: "problem", label: "مشكلة" }, { code: "question", label: "استفسار" }] as const;

export async function submitContactMessage(input: { kind: "suggestion" | "problem" | "question"; name: string; phone: string; body: string }, shopperId: string | null, ip: string) {
  await consumeStorefrontRateLimit({ scope: "market_contact_ip", rawKey: ip, limit: 5, windowMs: 60 * 60 * 1000 });
  let phone: string;
  try { phone = normalizeIraqiMobile(input.phone); } catch { throw new HttpError(422, "INVALID_PHONE", "اكتب رقم موبايل عراقيّاً صحيحاً."); }
  const message = await prisma.marketContactMessage.create({
    data: { shopperId, kind: input.kind, name: input.name, phone, body: input.body },
    select: { id: true, createdAt: true },
  });
  return { message };
}

const CONTACT_KIND = "market-contact-messages";
export async function contactMessages(status: string | undefined, rawCursor: unknown, rawLimit: unknown) {
  const limit = parseListLimit(rawLimit, 100, 30);
  const cursor = decodeListCursor(CONTACT_KIND, rawCursor);
  const at = cursor ? new Date(cursor.value) : null;
  const rows = await prisma.marketContactMessage.findMany({
    where: { ...(status === "new" || status === "handled" ? { status } : {}), ...(cursor && at ? { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: cursor.id } }] } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: { id: true, kind: true, name: true, phone: true, body: true, status: true, handledAt: true, handledNote: true, createdAt: true, shopperId: true },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(CONTACT_KIND, last.createdAt, last.id));
  return { messages: page, nextCursor };
}

export async function handleContactMessage(id: string, note: string | undefined) {
  const found = await prisma.marketContactMessage.updateMany({ where: { id, status: "new" }, data: { status: "handled", handledAt: new Date(), handledNote: note?.trim() || null } });
  if (!found.count) throw new HttpError(409, "CONTACT_ALREADY_HANDLED", "الرسالة غير موجودة أو عولجت مسبقاً.");
  return { ok: true };
}

// ── «قيّم التطبيق» ─────────────────────────────────────────────────────────

export const FEEDBACK_LIKES = [
  { code: "easy_to_use", label: "سهولة الاستخدام" }, { code: "variety", label: "تنوّع المتاجر والمنتجات" },
  { code: "prices", label: "الأسعار والعروض" }, { code: "delivery", label: "سرعة التوصيل" }, { code: "support", label: "خدمة العملاء" },
] as const;
const FEEDBACK_COOLDOWN_DAYS = 7;

export async function submitFeedback(shopperId: string, input: { stars: number; liked: string[]; note?: string }) {
  const recent = await prisma.marketAppFeedback.findFirst({ where: { shopperId, createdAt: { gte: new Date(Date.now() - FEEDBACK_COOLDOWN_DAYS * 86_400_000) } }, select: { id: true } });
  if (recent) throw new HttpError(429, "FEEDBACK_TOO_SOON", "شكراً لك، وصلنا تقييمك مؤخّراً. يمكنك التقييم مجدّداً بعد أسبوع.");
  const feedback = await prisma.marketAppFeedback.create({ data: { shopperId, stars: input.stars, liked: input.liked, note: input.note?.trim() || null }, select: { id: true, stars: true, createdAt: true } });
  return { feedback };
}

const FEEDBACK_KIND = "market-app-feedback";
export async function feedbackSummary(rawCursor: unknown, rawLimit: unknown) {
  const limit = parseListLimit(rawLimit, 100, 30);
  const cursor = decodeListCursor(FEEDBACK_KIND, rawCursor);
  const at = cursor ? new Date(cursor.value) : null;
  const [aggregate, groups, rows] = await Promise.all([
    prisma.marketAppFeedback.aggregate({ _avg: { stars: true }, _count: { _all: true } }),
    prisma.marketAppFeedback.groupBy({ by: ["stars"], _count: { _all: true } }),
    prisma.marketAppFeedback.findMany({
      where: cursor && at ? { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: cursor.id } }] } : {},
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: { id: true, stars: true, liked: true, note: true, createdAt: true },
    }),
  ]);
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(FEEDBACK_KIND, last.createdAt, last.id));
  const labels = new Map<string, string>(FEEDBACK_LIKES.map((like) => [like.code, like.label]));
  return {
    average: aggregate._avg.stars === null ? null : Math.round(aggregate._avg.stars * 10) / 10,
    count: aggregate._count._all,
    distribution: [1, 2, 3, 4, 5].map((stars) => ({ stars, count: groups.find((group) => group.stars === stars)?._count._all ?? 0 })),
    feedback: page.map((row) => ({ ...row, likedLabels: row.liked.map((code) => labels.get(code) ?? code) })),
    nextCursor,
  };
}
