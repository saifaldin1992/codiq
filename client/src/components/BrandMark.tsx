import { usePlatformBrand } from "@/hooks/usePlatformBrand";

/**
 * codiq brand mark — a self-contained inline SVG so the logo renders in every
 * environment (dev, staging, production) without depending on any external asset
 * host. Replaces the former /manus-storage/* PNG that only existed behind a
 * dev-only proxy (phase-18 debt D-19). Uses currentColor-friendly tokens so it
 * stays crisp on light and dark surfaces.
 *
 * P27-20 (ق-107): when the owner has uploaded a logo, THAT is what renders here
 * — and because every surface draws its mark through this one component, one
 * upload changes the platform everywhere at once. The inline SVG below stays as
 * the default and the fallback: it needs no network, no storage and no
 * configuration, so a page can never be left with a hole where the brand was.
 *
 * ⚠️ Three places this component CANNOT reach, stated in the owner's panel too
 * rather than discovered later:
 *   - the browser-tab icon, read from index.html before any script runs;
 *   - link previews on WhatsApp and Facebook, read by crawlers from a static tag;
 *   - a logo inside an email that has already been sent — it is gone.
 * Those three change on a new deploy, not on an upload.
 */
export function BrandMark({ className, title = "Codiq" }: { className?: string; title?: string }) {
  const { logo } = usePlatformBrand();

  if (logo) {
    return (
      <img
        src={logo.url}
        alt={title}
        className={className}
        // The uploaded file may be any aspect ratio, while every call site sizes
        // this as a square. `object-contain` letterboxes it instead of stretching
        // a wordmark into something the owner would not recognise.
        style={{ objectFit: "contain" }}
        loading="eager"
        decoding="async"
      />
    );
  }

  return (
    /**
     * ق-138 (2026-09-01): the owner-approved circular mark, in the Pinterest
     * lockup grammar he chose — a SOLID flat circle carrying a white 'C' with
     * round terminals, the COD coin sitting in the letter's gap. Approved
     * geometry, not to be eyeballed: stroke 9 and coin radius 5.3 on the 96
     * viewBox — the coin's diameter (10.6) reads ~18% thicker than the letter
     * stroke, which is exactly the balance he signed off («أصغر من الأولى،
     * وأسمك بقليل من جسم الحرف»). The gradient rounded-square this replaces
     * lives on in git history. At favicon sizes the coin is dropped entirely
     * (see client/index.html) — below ~24px it smears into noise.
     */
    <svg
      viewBox="0 0 96 96"
      role="img"
      aria-label={title}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="48" cy="48" r="48" fill="var(--codiq-brand-coin)" />
      {/* The 'C' opens toward the Latin reading direction, like the reference. */}
      <path
        d="M63.5 32.6a21.4 21.4 0 1 0 0 30.8"
        fill="none"
        stroke="var(--codiq-brand-ink)"
        strokeWidth="9"
        strokeLinecap="round"
      />
      <circle cx="61.4" cy="48" r="5.3" fill="var(--codiq-brand-spark)" />
    </svg>
  );
}
