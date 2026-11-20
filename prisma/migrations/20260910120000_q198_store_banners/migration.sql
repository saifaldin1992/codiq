-- ق-198 — the merchant owns the large images on his own front page.
--
-- The storefront's landing page had no imagery a merchant could change: the
-- only thing he could put there was the vacation banner, which is one line of
-- text. The reference shop the owner is matching leads with a full-bleed slider
-- of several large images, and that slider IS the shop's first impression —
-- leaving it un-editable would mean every store on this platform opens with the
-- same nothing.
--
-- Shaped after `product_images` deliberately, down to the column names: the same
-- upload guard, the same magic-byte validation, the same S3 helper, and the same
-- `max_image_storage_mb` plan meter already sum bytes from that table, so a
-- second shape here would have been a second thing to keep honest.
CREATE TABLE store_banners (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id     UUID NOT NULL,
  object_key   TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  byte_size    INTEGER NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  -- Optional: where the slide takes the shopper. NULL is an ordinary decorative
  -- slide, which is what most of them are.
  link_url     TEXT,
  -- Arabic alt text. Not decoration: a shop whose entire hero is images is
  -- unreadable to a screen reader without it, and phase 22 owes WCAG.
  alt_text     TEXT,
  -- Hidden rather than deleted, so a seasonal slide can come back without a
  -- re-upload and without a second charge against the storage plan.
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT store_banners_store_fk FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE RESTRICT,
  -- A byte size that is zero or negative would make the plan meter lie.
  CONSTRAINT store_banners_byte_size_positive CHECK (byte_size > 0),
  -- Absolute http(s) only. A slide that can carry `javascript:` is a stored XSS
  -- the merchant hands to every one of his own shoppers.
  CONSTRAINT store_banners_link_url_http CHECK (link_url IS NULL OR link_url ~ '^https?://')
);

-- The storefront's read: the live slides of one store, in order. `is_active` is
-- in the predicate rather than the key because the public page never asks for
-- the hidden ones.
CREATE INDEX store_banners_store_order_idx ON store_banners (store_id, sort_order, id) WHERE is_active;
-- The merchant's own screen lists them all, hidden included.
CREATE INDEX store_banners_store_all_idx ON store_banners (store_id, sort_order, id);
