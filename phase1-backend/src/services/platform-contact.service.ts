/**
 * PC-1 (owner request, 2026-09-04) — «معلومات التواصل» as DATA, not as code.
 *
 * The owner's message asked for three things by value — a contact email, a
 * contact number and a WhatsApp number — and for a fourth thing by intent:
 * «اذا تم اضافه زر تغيير … و رقم التواصل … و كافه معلومات التواصل في لوحة
 * المالك». The fourth is the one that matters. Until now those three strings
 * were compiled into the landing page, so changing a phone number meant a pull
 * request, a review, a build and a deploy — and the owner could not do any of
 * them. This service is what turns that into a form he fills in himself.
 *
 * IT USES `PlatformSetting`, the key/value table that already carries the logo
 * (platform-brand.service.ts) and the registration mode (registration.service.ts).
 * A dedicated table for three strings would be a second mechanism for the same
 * job, and ق-06 says the second one is the mistake.
 *
 * THE DEFAULTS LIVE IN THE CODE, not only in a seed row. `readPlatformContact`
 * answers correctly against an EMPTY table, which is what makes a fresh database
 * — a new environment, a restored backup, a developer's laptop — already right
 * rather than merely fixable. The migration seeds the rows as well, so the owner
 * SEES them in his dashboard on day one instead of an empty form.
 *
 * WHATSAPP FOLLOWS THE PHONE UNLESS IT IS SET. Most of the time they are one
 * number and asking for it twice is asking to have it typed wrong once. Storing
 * "no override" as an ABSENT ROW rather than as a copy of the phone is what makes
 * that true over time: change the phone and WhatsApp moves with it, exactly as a
 * person would expect, instead of silently pointing at last year's number.
 */
import { HttpError } from "../auth/auth.errors.js";
import { IRAQI_MOBILE_E164, normalizeEmail, toE164 } from "../auth/identity.js";
import { prisma } from "../db/prisma.js";
import type { PlatformActor } from "../auth/platform-permissions.js";
import { recordPlatformAuditEvent } from "./platform-audit.service.js";

export const CONTACT_EMAIL_KEY = "platform.contact.email";
export const CONTACT_PHONE_KEY = "platform.contact.phone";
/** Absent means «the same number as the phone» — see the head of this file. */
export const CONTACT_WHATSAPP_KEY = "platform.contact.whatsapp";

/**
 * The values the owner gave on 2026-09-04. These are the PUBLIC contact details
 * of the platform, not anybody's login — the owner's sign-in address is a row in
 * `platform_owners` and appears nowhere in this file.
 *
 * `client/src/lib/platform-contact.ts` carries these same two values as the
 * landing page's compiled-in fallback, so a visitor sees the right number before
 * the fetch resolves and even if it never does. Two copies, deliberately: the
 * backend does not import from `shared/`, which is the house arrangement
 * (see the note at the foot of client/src/config/navigation.ts).
 */
export const DEFAULT_PLATFORM_CONTACT = {
  email: "codiq.iraq@gmail.com",
  phone: "+9647777782092",
} as const;

export interface PlatformContact {
  email: string;
  phone: string;
  /** Always resolved — equals `phone` when no separate number is stored. */
  whatsapp: string;
}

export interface PlatformContactAdminView extends PlatformContact {
  /**
   * Whether WhatsApp is a number of its own. The owner's form needs this to tell
   * «the same as the phone» from «happens to be equal today», and the two behave
   * differently the next time the phone changes. NEVER part of the public read.
   */
  whatsappIsSeparate: boolean;
}

/**
 * A tiny in-process memo, because this is read by every visitor to «/» and the
 * answer is three short strings that change perhaps twice a year. It is
 * invalidated by the writer in the SAME process; another instance simply serves
 * the previous values for at most the TTL, which for a phone number in a footer
 * is not a correctness problem. The HTTP `cache-control` on the public route is
 * the second, larger layer — see routes/public.ts.
 */
const CACHE_TTL_MS = 60_000;
let cached: { value: PlatformContactAdminView; expiresAt: number } | null = null;

/** Called by the writer so the owner's own next page load shows what he just saved. */
function invalidateContactCache() {
  cached = null;
}

/**
 * The platform's contact details, ALWAYS complete. A missing row is the default,
 * never `null` and never an error: a landing page that cannot render a phone
 * number because a settings row was deleted is a worse outcome than one showing
 * the number the code was shipped with.
 */
export async function readPlatformContact(now = Date.now()): Promise<PlatformContactAdminView> {
  if (cached && cached.expiresAt > now) return cached.value;
  const rows = await prisma.platformSetting.findMany({
    where: { key: { in: [CONTACT_EMAIL_KEY, CONTACT_PHONE_KEY, CONTACT_WHATSAPP_KEY] } },
    select: { key: true, value: true },
  });
  const stored = new Map(rows.map((row) => [row.key, row.value.trim()]));
  const email = stored.get(CONTACT_EMAIL_KEY) || DEFAULT_PLATFORM_CONTACT.email;
  const phone = stored.get(CONTACT_PHONE_KEY) || DEFAULT_PLATFORM_CONTACT.phone;
  const whatsappOverride = stored.get(CONTACT_WHATSAPP_KEY) || "";
  const value: PlatformContactAdminView = {
    email,
    phone,
    whatsapp: whatsappOverride || phone,
    whatsappIsSeparate: whatsappOverride.length > 0,
  };
  cached = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

/** The three fields the world may see, and nothing else that lives beside them. */
export function publicContactView(contact: PlatformContactAdminView): PlatformContact {
  // Named field by field rather than spread-minus-one: a future field added to
  // the admin view must be published by a DECISION, not by having been forgotten.
  return { email: contact.email, phone: contact.phone, whatsapp: contact.whatsapp };
}

/**
 * Deliberately NOT `normalizeIraqiMobile`: that function owns the MERCHANT's
 * sign-in identity and answers with `INVALID_MERCHANT_PHONE`, which is the wrong
 * sentence to show the owner editing the platform's own footer. The rule is the
 * same and is reused wholesale — `toE164` plus `IRAQI_MOBILE_E164`, the two
 * pieces that actually decide — only the refusal speaks for this surface.
 *
 * A landline is refused for the reason `normalizeIraqiMobile` states: this
 * number is a WhatsApp channel, and a landline does not serve one.
 */
function normalizeContactMobile(value: unknown, field: "phone" | "whatsapp"): string {
  const normalized = toE164(value);
  if (!normalized || !IRAQI_MOBILE_E164.test(normalized)) {
    throw new HttpError(
      422,
      "INVALID_PLATFORM_CONTACT_PHONE",
      `${field === "phone" ? "رقم التواصل" : "رقم واتساب"} يجب أن يكون رقم موبايل عراقياً بصيغة 07XXXXXXXXX أو \u200E+9647XXXXXXXXX.`
    );
  }
  return normalized;
}

export interface UpdatePlatformContactInput {
  email: string;
  phone: string;
  /** `null` or an empty string means «follow the phone» — the row is removed. */
  whatsapp?: string | null;
}

/**
 * 19-ب idiom: the three settings and their audit record commit together. These
 * are the addresses every visitor is told to use to reach the platform, so a
 * change to them that left no trace would be a change nobody could later explain.
 */
export async function updatePlatformContact(
  actor: PlatformActor,
  input: UpdatePlatformContactInput
): Promise<PlatformContactAdminView> {
  const email = normalizeEmail(input.email);
  const phone = normalizeContactMobile(input.phone, "phone");
  const rawWhatsapp = typeof input.whatsapp === "string" ? input.whatsapp.trim() : "";
  const whatsapp = rawWhatsapp ? normalizeContactMobile(rawWhatsapp, "whatsapp") : null;
  // Storing an override identical to the phone would freeze WhatsApp at today's
  // number the next time the phone moves. Same number ⇒ no override.
  const override = whatsapp && whatsapp !== phone ? whatsapp : null;

  await prisma.$transaction(async (tx) => {
    await tx.platformSetting.upsert({
      where: { key: CONTACT_EMAIL_KEY },
      create: { key: CONTACT_EMAIL_KEY, value: email },
      update: { value: email },
    });
    await tx.platformSetting.upsert({
      where: { key: CONTACT_PHONE_KEY },
      create: { key: CONTACT_PHONE_KEY, value: phone },
      update: { value: phone },
    });
    if (override) {
      await tx.platformSetting.upsert({
        where: { key: CONTACT_WHATSAPP_KEY },
        create: { key: CONTACT_WHATSAPP_KEY, value: override },
        update: { value: override },
      });
    } else {
      await tx.platformSetting.deleteMany({ where: { key: CONTACT_WHATSAPP_KEY } });
    }
    await recordPlatformAuditEvent(tx, {
      entityType: "platform_contact",
      entityLabel: "معلومات التواصل",
      action: "contact_details_changed",
      actor,
      metadata: {
        email,
        phone,
        whatsapp: override ?? phone,
        whatsappIsSeparate: override !== null,
      },
    });
  });

  invalidateContactCache();
  return { email, phone, whatsapp: override ?? phone, whatsappIsSeparate: override !== null };
}
