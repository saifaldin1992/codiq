/**
 * P27-16 (ق-104) — make a merchant's store findable and shareable.
 *
 * THE PROBLEM THIS SOLVES, measured before it was written: every store page on
 * staging served the PLATFORM's title. A crawler asking for
 * `/store/some-shop` was told the page is «CODIQ — منصة المتاجر الإلكترونية»,
 * with no store name, no product, no description — because the app is a single
 * page and its shell is static. Ten thousand stores would have shared one title.
 * And `robots.txt` answered with HTML, which is worse than answering 404.
 *
 * The fix is server-side and small: for the handful of PUBLIC storefront routes,
 * the shell is served with its head rewritten from the database. Everything else
 * — the dashboards, the sign-in pages — keeps the untouched shell, because a
 * crawler has no business there and neither has the extra query.
 *
 * ق-10 governs the structured data: `Product` carries a price and availability
 * because those are real, and carries NO rating fields, because reviews do not
 * exist yet (they are CD-2). An empty `aggregateRating` is a fabricated one.
 */
import { prisma } from "../db/prisma.js";

const LIVE = { deletedAt: null, isActive: true } as const;

/** Escapes a value for insertion into an HTML attribute or a text node. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
}

/** JSON-LD is injected inside a <script> tag, so `<` must never survive. */
function escapeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export interface StorefrontSeo {
  title: string;
  description: string;
  canonical: string;
  image: string | null;
  jsonLd: unknown[];
}

function truncate(text: string, max = 300): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/**
 * Reads the metadata for a public storefront path, or null when the path is not
 * a storefront page (which is most of them).
 */
export async function storefrontSeoFor(pathname: string, origin: string): Promise<StorefrontSeo | null> {
  const store = /^\/store\/([^/?#]+)/.exec(pathname);
  if (!store) return null;
  const slug = decodeURIComponent(store[1]!);
  const row = await prisma.store.findFirst({
    where: { slug, isActive: true },
    // NOTE: `Store` has no description column yet — that is P27-2 §5, unbuilt. The
    // description below is DERIVED from the name rather than invented, and becomes
    // the merchant's own words the moment that field exists.
    select: { id: true, name: true, slug: true },
  });
  // An unknown or deactivated store gets the untouched shell: the SPA renders
  // its own «not found», and inventing a title for it would be inventing a page.
  if (!row) return null;

  const storeUrl = `${origin}/store/${encodeURIComponent(row.slug)}`;
  const storeDescription = truncate(`تسوّق من ${row.name} — الطلب والتوصيل داخل العراق.`);

  const product = /^\/store\/[^/?#]+\/products\/([^/?#]+)/.exec(pathname);
  if (product) {
    const productRow = await prisma.product.findFirst({
      where: { id: product[1]!, storeId: row.id, ...LIVE },
      select: {
        id: true, name: true, description: true, sku: true, priceIqd: true, stockQuantity: true,
        images: { select: { id: true }, take: 1 },
        category: { select: { name: true } },
      },
    });
    if (productRow) {
      const productUrl = `${storeUrl}/products/${encodeURIComponent(productRow.id)}`;
      const image = productRow.images[0] ? `${storeUrl}/products/${encodeURIComponent(productRow.id)}/images/${encodeURIComponent(productRow.images[0].id)}` : null;
      return {
        title: `${productRow.name} — ${row.name}`,
        description: truncate(productRow.description || `${productRow.name} من ${row.name}.`),
        canonical: productUrl,
        image,
        jsonLd: [
          {
            "@context": "https://schema.org",
            "@type": "Product",
            name: productRow.name,
            ...(productRow.description ? { description: truncate(productRow.description) } : {}),
            sku: productRow.sku,
            ...(image ? { image: [image] } : {}),
            offers: {
              "@type": "Offer",
              url: productUrl,
              priceCurrency: "IQD",
              price: productRow.priceIqd,
              // The real thing, from the real column — not a constant.
              availability: productRow.stockQuantity > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
              seller: { "@type": "Organization", name: row.name },
            },
            // NO aggregateRating: reviews are CD-2 and do not exist. An empty one
            // would be a fabricated signal, which is exactly what ق-10 forbids.
          },
          {
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: [
              { "@type": "ListItem", position: 1, name: row.name, item: storeUrl },
              ...(productRow.category ? [{ "@type": "ListItem", position: 2, name: productRow.category.name, item: storeUrl }] : []),
              { "@type": "ListItem", position: productRow.category ? 3 : 2, name: productRow.name, item: productUrl },
            ],
          },
        ],
      };
    }
  }

  return {
    title: `${row.name} — متجر إلكتروني في العراق`,
    description: storeDescription,
    canonical: storeUrl,
    image: null,
    jsonLd: [{
      "@context": "https://schema.org",
      "@type": "OnlineStore",
      name: row.name,
      description: storeDescription,
      url: storeUrl,
    }],
  };
}

/**
 * Rewrites the static shell's head. The tags are REPLACED rather than appended:
 * two `<title>` elements or two `og:title`s leave the crawler to pick, and it
 * does not pick the one we meant.
 */
export function applySeoToShell(html: string, seo: StorefrontSeo): string {
  const title = escapeHtml(seo.title);
  const description = escapeHtml(seo.description);
  const canonical = escapeHtml(seo.canonical);
  /**
   * 19-د (OUTPUT-SAFETY) — every replacement below is a FUNCTION, never a string.
   *
   * In a replacement STRING, `$&`, `` $` ``, `$'`, `$$` and `$1`..`$n` are
   * expansion patterns that the regex engine reads AFTER `escapeHtml` has run.
   * `escapeHtml` covers `[&<>"']` and cannot cover `$` — escaping `$` in the
   * VALUE would corrupt the merchant's own text. So a product named «عطر $2»
   * used to splice capture group 2 — a literal `"` — into the attribute and
   * close it early, and a description quoting a price in dollars («بسعر $100»,
   * which no attacker has to arrange) expanded `$1` into the opening tag. The
   * merchant, not the platform, then decided the markup of a page the platform
   * serves.
   *
   * The callback form disables all `$` interpretation. It is chosen over a
   * hand-rolled `$` escape because it is the form the NEXT tag added to this
   * chain inherits for free, where the escape would have to be remembered.
   */
  let out = html
    .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${title}</title>`)
    .replace(/(<meta\s+name="description"\s+content=")[\s\S]*?(")/, (_m, open: string, close: string) => `${open}${description}${close}`)
    .replace(/(<meta\s+property="og:title"\s*\n?\s*content=")[\s\S]*?(")/, (_m, open: string, close: string) => `${open}${title}${close}`)
    .replace(/(<meta\s+property="og:description"\s*\n?\s*content=")[\s\S]*?(")/, (_m, open: string, close: string) => `${open}${description}${close}`)
    .replace(/(<meta\s+property="og:url"\s+content=")[\s\S]*?(")/, (_m, open: string, close: string) => `${open}${canonical}${close}`)
    .replace(/(<meta\s+name="twitter:title"\s*\n?\s*content=")[\s\S]*?(")/, (_m, open: string, close: string) => `${open}${title}${close}`)
    .replace(/(<meta\s+name="twitter:description"\s*\n?\s*content=")[\s\S]*?(")/, (_m, open: string, close: string) => `${open}${description}${close}`)
    // The shell already ships a canonical for the landing page. It must be
    // REPLACED, never joined by a second one: a crawler that finds two canonical
    // links honours neither, which is worse than having none at all.
    .replace(/<link\s+rel="canonical"[^>]*>/, () => `<link rel="canonical" href="${canonical}" />`);

  const alreadyCanonical = /<link\s+rel="canonical"/.test(out);
  const extra = [
    // Only ADD one when the shell had none to replace.
    ...(alreadyCanonical ? [] : [`<link rel="canonical" href="${canonical}" />`]),
    ...(seo.image ? [`<meta property="og:image" content="${escapeHtml(seo.image)}" />`, `<meta name="twitter:image" content="${escapeHtml(seo.image)}" />`, `<meta name="twitter:card" content="summary_large_image" />`] : []),
    ...seo.jsonLd.map((block) => `<script type="application/ld+json">${escapeJsonLd(block)}</script>`),
  ].join("\n    ");

  // A STRING pattern expands `$&`, `` $` `` and `$'` in the replacement exactly
  // as a regex one does, and `extra` carries the product name inside the JSON-LD.
  // Same callback rule, same reason.
  return out.replace("</head>", () => `  ${extra}\n  </head>`);
}

/** A real text file. Serving HTML here told every crawler the file was a page. */
export function robotsTxt(origin: string): string {
  return [
    "User-agent: *",
    // The dashboards are behind sessions and carry nothing a crawler should index.
    "Disallow: /platform/",
    "Disallow: /merchant/",
    "Disallow: /staff/",
    "Disallow: /api/",
    "Allow: /",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
}

/**
 * One sitemap listing the landing page and every ACTIVE store. Per-store product
 * sitemaps are a separate file per store so a large catalogue never inflates
 * this one past the 50k-URL limit.
 */
export async function sitemapXml(origin: string): Promise<string> {
  const stores = await prisma.store.findMany({ where: { isActive: true }, select: { slug: true, updatedAt: true }, orderBy: { createdAt: "asc" }, take: 45_000 });
  const urls = [
    `<url><loc>${escapeHtml(origin)}/</loc></url>`,
    ...stores.map((store) => `<url><loc>${escapeHtml(`${origin}/store/${encodeURIComponent(store.slug)}`)}</loc><lastmod>${store.updatedAt.toISOString()}</lastmod></url>`),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

/** A store's own products, so a catalogue is crawlable without a giant index. */
export async function storeSitemapXml(slug: string, origin: string): Promise<string | null> {
  const store = await prisma.store.findFirst({ where: { slug, isActive: true }, select: { id: true, slug: true } });
  if (!store) return null;
  const products = await prisma.product.findMany({ where: { storeId: store.id, ...LIVE }, select: { id: true, updatedAt: true }, orderBy: { createdAt: "asc" }, take: 45_000 });
  const storeUrl = `${origin}/store/${encodeURIComponent(store.slug)}`;
  const urls = [
    `<url><loc>${escapeHtml(storeUrl)}</loc></url>`,
    ...products.map((product) => `<url><loc>${escapeHtml(`${storeUrl}/products/${encodeURIComponent(product.id)}`)}</loc><lastmod>${product.updatedAt.toISOString()}</lastmod></url>`),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}
