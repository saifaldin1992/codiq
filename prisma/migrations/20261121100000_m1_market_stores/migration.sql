-- Marketplace M1 — the stores directory (docs/MARKETPLACE_PLAN.md §1.4, D1–D9).
--
-- 1. A store appears in the market only after the merchant asks and the owner
--    agrees (open decision §4: «بطلب وموافقة المالك»). market_status is that
--    whole story; a store that was never asked about is 'unlisted'.
-- 2. Three owner-granted marks the shopper sees beside «موثّق» (already
--    stores.verified_at): a brand, a paid boost until a date, and «سفير» (the
--    platform's pick of the month) until a date.
-- 3. store_market_metrics — the computed reputation: the facts the directory
--    sorts by, the overall score, its tier and the earned badges. Written only
--    by the hourly market-metrics job (services in modules/market-stores);
--    nothing else may treat it as a source of truth.

ALTER TABLE stores
  ADD COLUMN market_status           TEXT NOT NULL DEFAULT 'unlisted',
  ADD COLUMN market_status_at        TIMESTAMPTZ(6),
  ADD COLUMN market_status_note      TEXT,
  ADD COLUMN market_listed_at        TIMESTAMPTZ(6),
  ADD COLUMN is_brand                BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN boosted_until           TIMESTAMPTZ(6),
  ADD COLUMN ambassador_until        TIMESTAMPTZ(6),
  ADD CONSTRAINT stores_market_status_known CHECK (market_status IN ('unlisted','pending','listed','rejected','delisted')),
  -- Every status other than the initial one is a decision made at a moment.
  ADD CONSTRAINT stores_market_status_dated CHECK (market_status = 'unlisted' OR market_status_at IS NOT NULL),
  -- A listed store knows when it first joined (the «متجر جديد» badge reads it).
  ADD CONSTRAINT stores_market_listed_dated CHECK (market_status <> 'listed' OR market_listed_at IS NOT NULL),
  ADD CONSTRAINT stores_market_note_length CHECK (market_status_note IS NULL OR length(market_status_note) <= 500);

-- The directory reads listed stores only.
CREATE INDEX stores_market_listed_idx ON stores (market_status, governorate_key) WHERE market_status = 'listed';
-- The owner's queue reads pending requests oldest first.
CREATE INDEX stores_market_pending_idx ON stores (market_status_at, id) WHERE market_status = 'pending';

CREATE TABLE store_market_metrics (
  store_id                 UUID PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE ON UPDATE CASCADE,
  -- 0–100, the weighted sum of seven criteria (market-score.ts). NULL until the
  -- store has enough completed orders to be judged: «لم تُحتسب بعد».
  score                    NUMERIC(5,2),
  tier                     TEXT,
  rating_avg               NUMERIC(3,2),
  rating_count             INTEGER NOT NULL DEFAULT 0,
  completed_orders         INTEGER NOT NULL DEFAULT 0,
  completed_orders_30d     INTEGER NOT NULL DEFAULT 0,
  cancel_rate              NUMERIC(5,4),
  repeat_rate              NUMERIC(5,4),
  median_response_minutes  INTEGER,
  in_stock_rate            NUMERIC(5,4),
  views_30d                INTEGER NOT NULL DEFAULT 0,
  product_count            INTEGER NOT NULL DEFAULT 0,
  -- [{code, level}] — the badges earned by numbers; owner-granted marks are read from stores.
  badges                   JSONB NOT NULL DEFAULT '[]'::jsonb,
  computed_at              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT store_market_metrics_score_range CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  CONSTRAINT store_market_metrics_tier_known CHECK (tier IS NULL OR tier IN ('bronze','silver','gold','platinum')),
  CONSTRAINT store_market_metrics_tier_needs_score CHECK (tier IS NULL OR score IS NOT NULL),
  CONSTRAINT store_market_metrics_rating_range CHECK (rating_avg IS NULL OR rating_avg BETWEEN 1 AND 5),
  CONSTRAINT store_market_metrics_rates_range CHECK (
    (cancel_rate IS NULL OR cancel_rate BETWEEN 0 AND 1) AND (repeat_rate IS NULL OR repeat_rate BETWEEN 0 AND 1)
    AND (in_stock_rate IS NULL OR in_stock_rate BETWEEN 0 AND 1)),
  CONSTRAINT store_market_metrics_counts_nonnegative CHECK (
    rating_count >= 0 AND completed_orders >= 0 AND completed_orders_30d >= 0 AND views_30d >= 0 AND product_count >= 0
    AND (median_response_minutes IS NULL OR median_response_minutes >= 0)),
  CONSTRAINT store_market_metrics_badges_array CHECK (jsonb_typeof(badges) = 'array')
);
