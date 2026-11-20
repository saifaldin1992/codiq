-- ق-211 — the footer's «روابط مهمة» is the merchant's, and two more social homes.
--
-- ── the pages ────────────────────────────────────────────────────────────────
-- ق-199 gave the store three POLICIES: return, privacy, delivery. Those three are
-- not merely footer links — the checkout screen names them in its consent line,
-- and the delivery one is read where the fee is shown. They stay exactly as they
-- are.
--
-- What the reference shop has BESIDES those three is prose the merchant wrote
-- because his own shop needed it: «من نحن», «اتفاقية المستخدم», and an article
-- explaining what inspired perfumes are. There is no fixed list of those. A
-- platform that shipped an `about_text` column and a `terms_text` column would be
-- back here the week a merchant wanted a fourth page, so this is an ARRAY of
-- pages the merchant names himself, capped and shaped by zod:
--   [{ "slug": "about-us", "title": "من نحن", "body": "…" }]
--
-- JSONB and not a table, for the same reason `home_sections` is JSONB: the whole
-- set is read together on every storefront render (the footer lists them all),
-- it is written whole by one screen, nothing else joins to it, and no row of it
-- is ever queried by itself except by slug — which the array serves in one read
-- that is already cached with the public config.
ALTER TABLE stores
  ADD COLUMN custom_pages JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE stores
  ADD CONSTRAINT stores_custom_pages_is_array CHECK (jsonb_typeof(custom_pages) = 'array');

-- ── the socials ──────────────────────────────────────────────────────────────
-- Snapchat and YouTube, on the same terms as the four ق-199 handles: a USERNAME
-- and never a URL, so the shop cannot ship a link to a place it did not mean. The
-- prefix that turns a handle into an address lives in one map in the service.
ALTER TABLE stores
  ADD COLUMN social_snapchat TEXT,
  ADD COLUMN social_youtube TEXT;

ALTER TABLE stores
  ADD CONSTRAINT stores_social_handles_are_usernames_2 CHECK (
    (social_snapchat IS NULL OR social_snapchat ~ '^[A-Za-z0-9._-]{1,30}$')
    AND (social_youtube IS NULL OR social_youtube ~ '^[A-Za-z0-9._-]{1,30}$')
  );
