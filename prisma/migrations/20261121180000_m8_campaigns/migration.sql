-- Marketplace M8a — campaigns and hourly deals (docs/MARKETPLACE_PLAN.md H1–H3).
--
--   market_campaigns        a seasonal event with its own page (owner)
--   market_campaign_days    its day-by-day schedule («جدول الأيام»)
--   market_deal_slots       the hours of «عرض الساعة» inside it (owner)
--   market_deals            a store's product put forward for one hour at a percentage
--                           off; live only once the owner approves it. The STORE funds it:
--                           it is a lower price for that hour, nothing else.
--
-- ONE PRICE RULE. codiq_live_price() is the price a product sells at right now: its
-- variant's price, less the best approved deal whose hour covers the instant. Every
-- place that quotes or charges a price calls it — the cart snapshots, the market
-- listings, and the checkout's FOR UPDATE read. A cart priced during the hour and
-- paid after it fails the checkout's snapshot check (CART_PRICE_CHANGED) and is
-- re-priced: the deal price cannot be bought outside its hour, whatever the browser sends.

CREATE TABLE market_campaigns (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  subtitle      TEXT,
  starts_at     TIMESTAMPTZ(6) NOT NULL,
  ends_at       TIMESTAMPTZ(6) NOT NULL,
  is_published  BOOLEAN NOT NULL DEFAULT false,
  min_percent   SMALLINT NOT NULL DEFAULT 10,
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT market_campaigns_slug_shape CHECK (slug ~ '^[a-z0-9-]{1,60}$'),
  CONSTRAINT market_campaigns_title_length CHECK (char_length(title) BETWEEN 1 AND 80 AND (subtitle IS NULL OR char_length(subtitle) <= 200)),
  CONSTRAINT market_campaigns_window CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '60 days'),
  CONSTRAINT market_campaigns_min_percent CHECK (min_percent BETWEEN 1 AND 90)
);

CREATE TABLE market_campaign_days (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   UUID NOT NULL REFERENCES market_campaigns(id) ON DELETE CASCADE ON UPDATE CASCADE,
  day           DATE NOT NULL,
  title         TEXT NOT NULL,
  note          TEXT,
  CONSTRAINT market_campaign_days_unique UNIQUE (campaign_id, day),
  CONSTRAINT market_campaign_days_text CHECK (char_length(title) BETWEEN 1 AND 80 AND (note IS NULL OR char_length(note) <= 300))
);

CREATE TABLE market_deal_slots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   UUID NOT NULL REFERENCES market_campaigns(id) ON DELETE CASCADE ON UPDATE CASCADE,
  title         TEXT,
  starts_at     TIMESTAMPTZ(6) NOT NULL,
  ends_at       TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT market_deal_slots_window CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '24 hours'),
  CONSTRAINT market_deal_slots_title CHECK (title IS NULL OR char_length(title) <= 80)
);
CREATE INDEX market_deal_slots_campaign_idx ON market_deal_slots (campaign_id, starts_at);
CREATE INDEX market_deal_slots_window_idx ON market_deal_slots (starts_at, ends_at);

CREATE TABLE market_deals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id       UUID NOT NULL REFERENCES market_deal_slots(id) ON DELETE CASCADE ON UPDATE CASCADE,
  store_id      UUID NOT NULL,
  product_id    UUID NOT NULL,
  percent_off   SMALLINT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  decision_note TEXT,
  decided_at    TIMESTAMPTZ(6),
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT market_deals_product_fk FOREIGN KEY (product_id, store_id) REFERENCES products(id, store_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT market_deals_unique UNIQUE (slot_id, product_id),
  CONSTRAINT market_deals_percent CHECK (percent_off BETWEEN 1 AND 90),
  CONSTRAINT market_deals_status_known CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn'))
);
CREATE INDEX market_deals_live_idx ON market_deals (product_id) WHERE status = 'approved';
CREATE INDEX market_deals_slot_idx ON market_deals (slot_id, status);
CREATE INDEX market_deals_store_idx ON market_deals (store_id, created_at DESC, id DESC);

-- The deal off one product at one instant: the best approved percentage among the
-- published campaigns' hours covering it, or NULL.
CREATE FUNCTION codiq_live_deal_percent(p_product UUID, p_at TIMESTAMPTZ) RETURNS INTEGER
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT max(d.percent_off)::int
    FROM market_deals d
    JOIN market_deal_slots s ON s.id = d.slot_id
    JOIN market_campaigns c ON c.id = s.campaign_id
   WHERE d.product_id = p_product AND d.status = 'approved' AND c.is_published
     AND s.starts_at <= p_at AND s.ends_at > p_at
$$;

-- The price a variant sells at right now. Rounded DOWN to the dinar in the shopper's favour.
CREATE FUNCTION codiq_live_price(p_product UUID, p_base INTEGER, p_at TIMESTAMPTZ) RETURNS INTEGER
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN pct IS NULL THEN p_base ELSE p_base - ceil(p_base * pct / 100.0)::int END
    FROM (SELECT codiq_live_deal_percent(p_product, p_at) AS pct) x
$$;
