-- ق-202 — how many people came, and what they looked at.
--
-- The merchant's home page is being rebuilt to the reference dashboard's
-- arrangement, and two of its four headline numbers — «الزوار» and «معدل
-- التحويل» — had no data behind them: the platform never counted a visit. This
-- is the smallest honest counter that can carry them, and deliberately no more:
--
--   · DAILY TOTALS per store, not per-visitor rows. No identity, no IP, no user
--     agent, no path history — a number per day. There is nothing here to leak
--     and nothing a shopper would need to be told about (D-100).
--   · «visitors» is deduplicated by a first-party cookie that holds only the
--     Baghdad calendar day it was last counted on, so one shopper reloading is
--     one visitor and many visits. It is an approximation and is labelled one.
--   · Product views feed «الأكثر زيارة» the same way — a count per product per
--     day, cascading with the product it counts.
--
-- Days are Baghdad calendar days (Asia/Baghdad, no DST), because a merchant's
-- «اليوم» ends at his midnight and not at 03:00.
CREATE TABLE store_visits_daily (
  store_id  UUID    NOT NULL,
  day       DATE    NOT NULL,
  visits    INTEGER NOT NULL DEFAULT 0,
  visitors  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (store_id, day),
  CONSTRAINT store_visits_daily_store_fk FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
  CONSTRAINT store_visits_daily_non_negative CHECK (visits >= 0 AND visitors >= 0 AND visitors <= visits)
);

CREATE TABLE product_views_daily (
  store_id   UUID    NOT NULL,
  product_id UUID    NOT NULL,
  day        DATE    NOT NULL,
  views      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (store_id, product_id, day),
  CONSTRAINT product_views_daily_product_fk FOREIGN KEY (product_id, store_id) REFERENCES products(id, store_id) ON DELETE CASCADE,
  CONSTRAINT product_views_daily_non_negative CHECK (views >= 0)
);
-- «الأكثر زيارة» over a date range: one store, a span of days, summed per product.
CREATE INDEX product_views_daily_store_day_idx ON product_views_daily (store_id, day);
