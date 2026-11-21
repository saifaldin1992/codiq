/**
 * ق-203 — the storefront's footer (P27-1 §4): the store's links, the store's
 * contact, the payment methods it actually takes, the store's copyright and
 * «مدعوم من CODIQ». Everything in it is the merchant's own data from
 * `public-config`; a block with nothing in it is not drawn.
 *
 * Icons are lucide line icons only — the platform's visual language, and no
 * brand bitmaps that would advertise a payment method that is not live.
 */
import { Link } from "wouter";
import {
  Banknote,
  Facebook,
  Ghost,
  Instagram,
  Mail,
  MapPin,
  MessageCircle,
  Music2,
  PackageSearch,
  Phone,
  Twitter,
  Wallet,
  Youtube,
} from "lucide-react";
import type { StorefrontConfig } from "@/lib/storefront-api";

const START_YEAR = 2025;
export function copyrightYears(now = new Date()): string {
  const year = now.getFullYear();
  return year > START_YEAR ? `${START_YEAR}–${year}` : String(START_YEAR);
}

/** Shown the Iraqi way (07…), dialled the E.164 way. */
export function displayPhone(e164: string): string {
  return e164.startsWith("+964") ? `0${e164.slice(4)}` : e164;
}
export function whatsappHref(e164: string): string {
  return `https://wa.me/${e164.replace(/[^0-9]/g, "")}`;
}

const POLICY_LABELS = {
  return: "سياسة الإرجاع والاستبدال",
  privacy: "سياسة الخصوصية",
  delivery: "سياسة التوصيل",
} as const;

export function StorefrontFooter({
  slug,
  config,
}: {
  slug: string;
  config: StorefrontConfig | null;
}) {
  const contact = config?.contact;
  const social = config?.social;
  const policies = config?.policies ?? [];
  // ق-211: the merchant's own pages, after the policies, in the order he put them.
  const pages = config?.pages ?? [];
  const methods = config?.paymentMethods ?? [];
  return (
    <footer className="mt-14 border-t border-[var(--storefront-border)] bg-[var(--storefront-surface)]">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-10 sm:px-6 md:grid-cols-3">
        <div>
          <h2 className="text-base font-black text-[var(--storefront-text)]">روابط مهمة</h2>
          <ul className="mt-4 space-y-2.5 text-sm text-[var(--storefront-muted)]">
            <li>
              <Link href={`/store/${slug}`} className="hover:text-[var(--storefront-accent)]">
                الرئيسية
              </Link>
            </li>
            <li>
              <Link
                href={`/store/${slug}/products`}
                className="hover:text-[var(--storefront-accent)]"
              >
                كل المنتجات
              </Link>
            </li>
            {/* CD-1a: the public tracking entry point lives in the footer so a customer
                without an account can always reach it from any storefront page. */}
            <li>
              <Link
                href={`/store/${slug}/track`}
                data-testid="footer-track-link"
                className="inline-flex items-center gap-1.5 hover:text-[var(--storefront-accent)]"
              >
                <PackageSearch className="h-4 w-4" />
                أين طلبي؟
              </Link>
            </li>
            {policies.map((kind) => (
              <li key={kind}>
                <Link
                  href={`/store/${slug}/policies/${kind}`}
                  className="hover:text-[var(--storefront-accent)]"
                >
                  {POLICY_LABELS[kind]}
                </Link>
              </li>
            ))}
            {pages.map((page) => (
              <li key={page.slug}>
                <Link
                  href={`/store/${slug}/pages/${page.slug}`}
                  data-testid={`footer-page-${page.slug}`}
                  className="hover:text-[var(--storefront-accent)]"
                >
                  {page.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className="text-base font-black text-[var(--storefront-text)]">تواصل معنا</h2>
          {contact || social ? (
            <ul className="mt-4 space-y-2.5 text-sm text-[var(--storefront-muted)]">
              {contact?.whatsapp ? (
                <li>
                  <a
                    href={whatsappHref(contact.whatsapp)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 hover:text-[var(--storefront-accent)]"
                  >
                    <MessageCircle className="h-4 w-4" />
                    <span dir="ltr">{displayPhone(contact.whatsapp)}</span>
                    <span className="text-xs">واتساب</span>
                  </a>
                </li>
              ) : null}
              {contact?.phone ? (
                <li>
                  <a
                    href={`tel:${contact.phone}`}
                    className="inline-flex items-center gap-2 hover:text-[var(--storefront-accent)]"
                  >
                    <Phone className="h-4 w-4" />
                    <span dir="ltr">{displayPhone(contact.phone)}</span>
                  </a>
                </li>
              ) : null}
              {contact?.email ? (
                <li>
                  <a
                    href={`mailto:${contact.email}`}
                    className="inline-flex items-center gap-2 hover:text-[var(--storefront-accent)]"
                  >
                    <Mail className="h-4 w-4" />
                    <span dir="ltr">{contact.email}</span>
                  </a>
                </li>
              ) : null}
              {contact?.addressLine || contact?.city ? (
                <li className="inline-flex items-start gap-2">
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{[contact.addressLine, contact.city].filter(Boolean).join("، ")}</span>
                </li>
              ) : null}
              {social ? (
                <li className="flex flex-wrap gap-2 pt-1">
                  {social.instagram ? (
                    <a
                      href={social.instagram}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="إنستغرام"
                      className="grid h-9 w-9 place-items-center rounded-full border border-[var(--storefront-border)] hover:border-[var(--storefront-accent)] hover:text-[var(--storefront-accent)]"
                    >
                      <Instagram className="h-4 w-4" />
                    </a>
                  ) : null}
                  {social.facebook ? (
                    <a
                      href={social.facebook}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="فيسبوك"
                      className="grid h-9 w-9 place-items-center rounded-full border border-[var(--storefront-border)] hover:border-[var(--storefront-accent)] hover:text-[var(--storefront-accent)]"
                    >
                      <Facebook className="h-4 w-4" />
                    </a>
                  ) : null}
                  {social.x ? (
                    <a
                      href={social.x}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="إكس"
                      className="grid h-9 w-9 place-items-center rounded-full border border-[var(--storefront-border)] hover:border-[var(--storefront-accent)] hover:text-[var(--storefront-accent)]"
                    >
                      <Twitter className="h-4 w-4" />
                    </a>
                  ) : null}
                  {social.tiktok ? (
                    <a
                      href={social.tiktok}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="تيك توك"
                      className="grid h-9 w-9 place-items-center rounded-full border border-[var(--storefront-border)] hover:border-[var(--storefront-accent)] hover:text-[var(--storefront-accent)]"
                    >
                      <Music2 className="h-4 w-4" />
                    </a>
                  ) : null}
                  {/* ق-211: lucide has no Snapchat mark — the ghost is the platform's line icon for it, not a brand bitmap. */}
                  {social.snapchat ? (
                    <a
                      href={social.snapchat}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="سناب شات"
                      className="grid h-9 w-9 place-items-center rounded-full border border-[var(--storefront-border)] hover:border-[var(--storefront-accent)] hover:text-[var(--storefront-accent)]"
                    >
                      <Ghost className="h-4 w-4" />
                    </a>
                  ) : null}
                  {social.youtube ? (
                    <a
                      href={social.youtube}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="يوتيوب"
                      className="grid h-9 w-9 place-items-center rounded-full border border-[var(--storefront-border)] hover:border-[var(--storefront-accent)] hover:text-[var(--storefront-accent)]"
                    >
                      <Youtube className="h-4 w-4" />
                    </a>
                  ) : null}
                </li>
              ) : null}
            </ul>
          ) : (
            <p className="mt-4 text-sm leading-6 text-[var(--storefront-muted)]">
              تابع طلبك من «أين طلبي؟» أو من حسابك.
            </p>
          )}
        </div>
        <div>
          <h2 className="text-base font-black text-[var(--storefront-text)]">وسائل الدفع</h2>
          <ul className="mt-4 flex flex-wrap gap-2">
            {methods.map((method) => (
              <li
                key={method.code}
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--storefront-border)] bg-[var(--storefront-canvas)] px-3 py-1.5 text-xs font-bold text-[var(--storefront-text)]"
              >
                {method.kind === "cod" ? (
                  <Banknote className="h-3.5 w-3.5 text-[var(--storefront-accent)]" />
                ) : (
                  <Wallet className="h-3.5 w-3.5 text-[var(--storefront-accent)]" />
                )}
                {method.displayName}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs leading-5 text-[var(--storefront-muted)]">
            تُعرض وسائل الدفع التي يقبلها المتجر فعلاً.
          </p>
        </div>
      </div>
      <div className="border-t border-[var(--storefront-border)]">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4 text-xs text-[var(--storefront-muted)] sm:px-6">
          <span>
            الحقوق محفوظة © {copyrightYears()} {config?.name ?? slug}
          </span>
          <a
            href="/"
            className="inline-flex items-center gap-1 font-bold text-[var(--storefront-text)] hover:text-[var(--storefront-accent)]"
          >
            مدعوم من <span className="tracking-wide">Codiq</span>
          </a>
        </div>
      </div>
    </footer>
  );
}
