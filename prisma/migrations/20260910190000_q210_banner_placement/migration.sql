-- ق-210 — the front page has TWO sliders, not one.
--
-- The reference shop opens with a full-bleed hero slider and carries a SECOND,
-- shorter promotional slider further down the page, between the rails. Both are
-- the merchant's own photographs, uploaded through the same pipeline, ordered on
-- the same screen — the only thing that differs is WHERE on the page they land.
--
-- That is one column, not a second table: a second `store_banners_mid` would
-- have meant a second upload route, a second plan meter to keep honest, and a
-- second place for a `javascript:` link to reach a shopper. `placement` keeps one
-- table, one validator, one meter.
--
-- DEFAULT 'hero' is what makes this migration safe on a live shop: every slide
-- that exists today was uploaded for the top of the page and stays there.
ALTER TABLE store_banners
  ADD COLUMN placement TEXT NOT NULL DEFAULT 'hero';

-- The set is closed in the database and not only in zod, for the same reason the
-- payment-method codes are (ق-209): a placement the storefront cannot render is
-- an invisible slide the merchant paid storage for and cannot find.
ALTER TABLE store_banners
  ADD CONSTRAINT store_banners_placement_ck CHECK (placement IN ('hero', 'mid'));

-- The live read is «this store's active slides for THIS placement, in order», so
-- the placement belongs in the index ahead of the sort key. Partial on is_active
-- exactly like store_banners_store_order_idx, which this one now supersedes for
-- the storefront's two queries; the merchant's own screen reads every row and
-- needs no index.
CREATE INDEX IF NOT EXISTS store_banners_placement_order_idx
  ON store_banners (store_id, placement, sort_order, id)
  WHERE is_active;
