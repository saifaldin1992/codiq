/**
 * PC-1 — the platform's contact details on the client side.
 *
 * THE FALLBACK IS THE POINT OF THIS FILE. The landing page is under a hard speed
 * budget (ق-137) and its footer must never wait on a request, so the values ship
 * COMPILED IN: the page paints the correct email and phone with zero network in
 * its path, and `/api/public/contact` only reconciles them afterwards. If that
 * request is slow, fails, or is blocked, the visitor still sees a real way to
 * reach the platform rather than a blank line or a spinner.
 *
 * These three strings MIRROR `DEFAULT_PLATFORM_CONTACT` in
 * `phase1-backend/src/services/platform-contact.service.ts`, which is the source
 * of truth. Two copies rather than one shared module because the backend does not
 * import from `shared/` — the house arrangement, stated at the foot of
 * `client/src/config/navigation.ts` and used the same way by the permission-code
 * unions there. They can only disagree while a deploy is half-done, and a footer
 * showing the previous phone number for a few minutes is the whole cost.
 */
export type PlatformContact = {
  email: string;
  /** E.164, e.g. `+9647777782092` — the storage and link form, never the display one. */
  phone: string;
  /** Always present: the server resolves it to the phone when no separate number is set. */
  whatsapp: string;
};

export const PLATFORM_CONTACT_FALLBACK: PlatformContact = {
  email: "codiq.iraq@gmail.com",
  phone: "+9647777782092",
  whatsapp: "+9647777782092",
};

/**
 * `+9647777782092` → `+964 777 778 2092`. A fifteen-digit run is unreadable and
 * uncheckable — a person cannot tell at a glance whether the number in the footer
 * is his own. Grouped after the country code, in the shape Iraqi numbers are
 * written on shop signs and business cards.
 *
 * Anything that is not an Iraqi E.164 mobile is returned untouched: this is a
 * formatter, and inventing groups for a shape it does not know would be worse
 * than printing what it was given.
 */
export function formatContactPhone(phone: string): string {
  const match = /^\+964(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return match ? `+964 ${match[1]} ${match[2]} ${match[3]}` : phone;
}

/** wa.me wants the digits without the leading «+» and without spaces. */
export function whatsappLink(whatsapp: string): string {
  return `https://wa.me/${whatsapp.replace(/\D/g, "")}`;
}

/**
 * Reads the published details, or `null` when they cannot be read. Silent by
 * design: the caller already holds a correct answer, so a failure here is not an
 * error to report to a visitor — it is simply nothing to reconcile.
 */
export async function fetchPlatformContact(): Promise<PlatformContact | null> {
  try {
    const response = await fetch("/api/public/contact");
    if (!response.ok) return null;
    const body = await response.json();
    const contact = body?.contact;
    if (typeof contact?.email !== "string" || typeof contact?.phone !== "string" || typeof contact?.whatsapp !== "string") return null;
    return { email: contact.email, phone: contact.phone, whatsapp: contact.whatsapp };
  } catch {
    return null;
  }
}
