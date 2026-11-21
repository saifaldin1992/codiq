-- Marketplace M9 — the prize wheel (docs/MARKETPLACE_PLAN.md W1–W7).
--
--   market_wheels        the wheel: open or closed, its window, the free spins a day, how much a
--                        delivered order must be worth for one more spin, the most a shopper may win,
--                        how long a prize waits to be claimed
--   wheel_prizes         its segments. `weight` and `stock` NEVER leave the server: the browser
--                        receives labels only, and the draw happens here.
--   wheel_spin_grants    extra spins earned by delivered orders (once per order)
--   wheel_spins          every spin, won or not — the log support reads
--   wheel_wins           what a spin won, and where it is: waiting to be claimed, claimed, on its
--                        way, delivered, expired, cancelled
--
-- STOCK IS A CHECK. `won_count <= stock` is enforced here and the draw takes a prize with
-- `UPDATE … SET won_count = won_count + 1 WHERE won_count < stock`: of a thousand spins at once,
-- each unit is handed out once, and the spin that finds it gone draws again among the rest.

CREATE TABLE market_wheels (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                     TEXT NOT NULL UNIQUE,
  title                    TEXT NOT NULL,
  how_to_play              TEXT,
  is_open                  BOOLEAN NOT NULL DEFAULT false,
  starts_at                TIMESTAMPTZ(6) NOT NULL,
  ends_at                  TIMESTAMPTZ(6) NOT NULL,
  daily_free_spins         SMALLINT NOT NULL DEFAULT 1,
  iqd_per_extra_spin       INTEGER NOT NULL DEFAULT 25000,
  max_extra_spins_per_order SMALLINT NOT NULL DEFAULT 3,
  max_wins_per_shopper     SMALLINT NOT NULL DEFAULT 3,
  claim_days               SMALLINT NOT NULL DEFAULT 7,
  created_at               TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT market_wheels_slug_shape CHECK (slug ~ '^[a-z0-9-]{1,60}$'),
  CONSTRAINT market_wheels_text CHECK (char_length(title) BETWEEN 1 AND 80 AND (how_to_play IS NULL OR char_length(how_to_play) <= 2000)),
  CONSTRAINT market_wheels_window CHECK (ends_at > starts_at),
  CONSTRAINT market_wheels_numbers CHECK (daily_free_spins BETWEEN 0 AND 10 AND iqd_per_extra_spin > 0 AND max_extra_spins_per_order BETWEEN 0 AND 20 AND max_wins_per_shopper BETWEEN 1 AND 100 AND claim_days BETWEEN 1 AND 90)
);

CREATE TABLE wheel_prizes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wheel_id      UUID NOT NULL REFERENCES market_wheels(id) ON DELETE CASCADE ON UPDATE CASCADE,
  label         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  weight        INTEGER NOT NULL,
  stock         INTEGER,
  won_count     INTEGER NOT NULL DEFAULT 0,
  points        INTEGER,
  coupon_id     UUID REFERENCES platform_coupons(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  position      SMALLINT NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT wheel_prizes_kind CHECK (
    (kind = 'nothing' AND points IS NULL AND coupon_id IS NULL AND stock IS NULL) OR
    (kind = 'points' AND points > 0 AND coupon_id IS NULL) OR
    (kind = 'coupon' AND coupon_id IS NOT NULL AND points IS NULL) OR
    (kind = 'physical' AND points IS NULL AND coupon_id IS NULL AND stock IS NOT NULL)),
  CONSTRAINT wheel_prizes_weight CHECK (weight BETWEEN 0 AND 1000000),
  CONSTRAINT wheel_prizes_stock CHECK ((stock IS NULL OR stock >= 0) AND won_count >= 0 AND (stock IS NULL OR won_count <= stock)),
  CONSTRAINT wheel_prizes_label CHECK (char_length(label) BETWEEN 1 AND 40)
);
CREATE INDEX wheel_prizes_wheel_idx ON wheel_prizes (wheel_id, position);

CREATE TABLE wheel_spin_grants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wheel_id    UUID NOT NULL REFERENCES market_wheels(id) ON DELETE CASCADE ON UPDATE CASCADE,
  shopper_id  UUID NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  order_id    UUID,
  spins       SMALLINT NOT NULL,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT wheel_spin_grants_spins CHECK (spins BETWEEN 1 AND 20),
  CONSTRAINT wheel_spin_grants_order_once UNIQUE (wheel_id, order_id)
);
CREATE INDEX wheel_spin_grants_shopper_idx ON wheel_spin_grants (wheel_id, shopper_id);

CREATE TABLE wheel_spins (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wheel_id    UUID NOT NULL REFERENCES market_wheels(id) ON DELETE CASCADE ON UPDATE CASCADE,
  shopper_id  UUID NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  kind        TEXT NOT NULL,
  day         DATE NOT NULL,
  prize_id    UUID REFERENCES wheel_prizes(id) ON DELETE SET NULL ON UPDATE CASCADE,
  prize_label TEXT NOT NULL,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT wheel_spins_kind CHECK (kind IN ('free', 'bonus'))
);
CREATE INDEX wheel_spins_shopper_idx ON wheel_spins (wheel_id, shopper_id, created_at DESC, id DESC);
CREATE INDEX wheel_spins_day_idx ON wheel_spins (wheel_id, shopper_id, day, kind);

CREATE TABLE wheel_wins (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wheel_id      UUID NOT NULL REFERENCES market_wheels(id) ON DELETE CASCADE ON UPDATE CASCADE,
  spin_id       UUID NOT NULL UNIQUE REFERENCES wheel_spins(id) ON DELETE CASCADE ON UPDATE CASCADE,
  shopper_id    UUID NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  prize_id      UUID NOT NULL REFERENCES wheel_prizes(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending',
  claim_by      TIMESTAMPTZ(6) NOT NULL,
  claimed_at    TIMESTAMPTZ(6),
  wallet_id     UUID,
  address_id    UUID,
  note          TEXT,
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT wheel_wins_status CHECK (status IN ('pending', 'claimed', 'shipping', 'delivered', 'cancelled'))
);
CREATE INDEX wheel_wins_shopper_idx ON wheel_wins (shopper_id, created_at DESC, id DESC);
CREATE INDEX wheel_wins_board_idx ON wheel_wins (wheel_id, shopper_id);
CREATE INDEX wheel_wins_queue_idx ON wheel_wins (wheel_id, status, created_at);
