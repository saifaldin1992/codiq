/** zod shapes for the market help routes. */
import { z } from "zod";
import { CONTACT_KINDS, FEEDBACK_LIKES } from "./help.service.js";

const codes = <T extends readonly { code: string }[]>(list: T) => list.map((entry) => entry.code) as unknown as [T[number]["code"], ...T[number]["code"][]];
const uuidCsv = (max: number) => z.string().optional().transform((value, context) => {
  const ids = (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  if (ids.length > max || ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
    context.addIssue({ code: "custom", message: `حتّى ${max} معرّفاً صحيحاً` });
    return z.NEVER;
  }
  return Array.from(new Set(ids));
});
const slugCsv = (max: number) => z.string().optional().transform((value, context) => {
  const slugs = (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  if (slugs.length > max || slugs.some((slug) => slug.length > 120)) {
    context.addIssue({ code: "custom", message: `حتّى ${max} متجراً` });
    return z.NEVER;
  }
  return Array.from(new Set(slugs));
});

export const favouriteFlagsQuerySchema = z.object({ products: uuidCsv(48), stores: slugCsv(48) });
export const helpQuerySchema = z.object({ q: z.string().trim().max(80).optional() });

export const contactSchema = z.object({
  kind: z.enum(codes(CONTACT_KINDS)),
  name: z.string().trim().min(1, "اكتب اسمك").max(80),
  phone: z.string().trim().min(8).max(20),
  body: z.string().trim().min(10, "اكتب ١٠ أحرف على الأقلّ").max(2000),
});
export const feedbackSchema = z.object({
  stars: z.number().int().min(1).max(5),
  liked: z.array(z.enum(codes(FEEDBACK_LIKES))).max(10).default([]).transform((liked) => Array.from(new Set(liked))),
  note: z.string().trim().max(1000).optional(),
});

export const inboxReadSchema = z.object({ key: z.string().trim().max(40) });

export const helpSectionCreateSchema = z.object({
  slug: z.string().trim().max(40).regex(/^[a-z0-9-]+$/, "حروف إنكليزيّة صغيرة وأرقام وشرطات")
    .refine((slug) => !slug.startsWith("-") && !slug.endsWith("-") && !slug.includes("--"), { message: "لا تبدأ الشرطة ولا تنتهي بها ولا تتكرّر" }),
  title: z.string().trim().min(1).max(80),
  position: z.number().int().min(0).max(1000).default(0),
});
export const helpSectionUpdateSchema = helpSectionCreateSchema.omit({ slug: true });
export const helpArticleSchema = z.object({
  sectionId: z.string().uuid(),
  question: z.string().trim().min(3).max(200),
  answer: z.string().trim().min(1).max(4000),
  isQuick: z.boolean().default(false),
  isPublished: z.boolean().default(true),
  position: z.number().int().min(0).max(1000).default(0),
});
export const supportContactsSchema = z.object({
  whatsapp: z.string().trim().max(20).nullable(),
  phone: z.string().trim().max(20).nullable(),
  email: z.string().trim().email().max(120).nullable().or(z.literal("").transform(() => null)),
  hours: z.string().trim().max(120).nullable(),
});
export const contactHandleSchema = z.object({ note: z.string().trim().max(500).optional() });
