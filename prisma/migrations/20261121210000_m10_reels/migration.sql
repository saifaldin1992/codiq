-- Marketplace M10 — short videos (docs/MARKETPLACE_PLAN.md R1–R4).
--
--   market_reels        a store's short video, optionally of one of its products. Shown only once
--                       the owner approves it (R4). Stored as MP4/WebM in the image bucket and
--                       served with byte ranges; HLS waits for a transcoding service.
--   market_reel_likes   one like per shopper per reel
--   market_reel_views   one view per viewer per reel per day — the counter cannot be pumped by
--                       replaying a request
--
-- The counters on market_reels are denormalized for the feed; the two tables are the truth.

CREATE TABLE market_reels (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id           UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE ON UPDATE CASCADE,
  product_id         UUID,
  caption            TEXT,
  video_object_key   TEXT NOT NULL UNIQUE,
  video_content_type TEXT NOT NULL,
  video_byte_size    INTEGER NOT NULL,
  poster_object_key  TEXT UNIQUE,
  poster_content_type TEXT,
  status             TEXT NOT NULL DEFAULT 'pending',
  decision_note      TEXT,
  decided_at         TIMESTAMPTZ(6),
  published_at       TIMESTAMPTZ(6),
  view_count         INTEGER NOT NULL DEFAULT 0,
  like_count         INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT market_reels_product_fk FOREIGN KEY (product_id, store_id) REFERENCES products(id, store_id) ON DELETE SET NULL (product_id) ON UPDATE CASCADE,
  CONSTRAINT market_reels_status CHECK (status IN ('pending', 'approved', 'rejected', 'removed')),
  CONSTRAINT market_reels_video_type CHECK (video_content_type IN ('video/mp4', 'video/webm', 'video/quicktime')),
  CONSTRAINT market_reels_video_size CHECK (video_byte_size > 0 AND video_byte_size <= 31457280),
  CONSTRAINT market_reels_caption CHECK (caption IS NULL OR char_length(caption) <= 300),
  CONSTRAINT market_reels_counts CHECK (view_count >= 0 AND like_count >= 0),
  CONSTRAINT market_reels_published CHECK ((status = 'approved') = (published_at IS NOT NULL))
);
CREATE INDEX market_reels_feed_idx ON market_reels (published_at DESC, id DESC) WHERE status = 'approved';
CREATE INDEX market_reels_store_idx ON market_reels (store_id, created_at DESC, id DESC);
CREATE INDEX market_reels_queue_idx ON market_reels (status, created_at, id);

CREATE TABLE market_reel_likes (
  reel_id     UUID NOT NULL REFERENCES market_reels(id) ON DELETE CASCADE ON UPDATE CASCADE,
  shopper_id  UUID NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (reel_id, shopper_id)
);

CREATE TABLE market_reel_views (
  reel_id     UUID NOT NULL REFERENCES market_reels(id) ON DELETE CASCADE ON UPDATE CASCADE,
  viewer_key  TEXT NOT NULL,
  day         DATE NOT NULL,
  PRIMARY KEY (reel_id, viewer_key, day),
  CONSTRAINT market_reel_views_key_shape CHECK (char_length(viewer_key) = 64)
);
CREATE INDEX market_reel_views_day_idx ON market_reel_views (day);
