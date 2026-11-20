-- ق-185 — the dedupe key protected nothing for a message with no store.
--
-- `notification_outbox_dedupe` is UNIQUE(store_id, dedupe_key), and every
-- scanner that relies on it — the merchant digest, the abandoned cart, the
-- back-in-stock notice, the courier dispatch — passes a real store_id, so the
-- once-only rule has always held for them.
--
-- It does NOT hold for a store-less row. Postgres treats NULLs as distinct in a
-- unique index, so UNIQUE(NULL, 'k') never collides with UNIQUE(NULL, 'k'), and
-- a merchant-account message (`recipient_kind = 'account'`, `store_id IS NULL`
-- — the shape a trial reminder or any other account notice must take) would be
-- re-enqueued on EVERY scanner pass. A ten-minute scanner over a three-day
-- window is more than four hundred copies of one email, and the code that wrote
-- it would look exactly like the code that works.
--
-- NULLS NOT DISTINCT on the existing index would be the wrong repair: it would
-- also collapse the rows whose dedupe_key is NULL, which is MOST rows — every
-- order confirmation would collide with the next. The right shape is a second,
-- partial index covering precisely the gap: store-less rows that asked to be
-- deduplicated.
CREATE UNIQUE INDEX notification_outbox_dedupe_no_store
  ON notification_outbox (dedupe_key)
  WHERE store_id IS NULL AND dedupe_key IS NOT NULL;

COMMENT ON INDEX notification_outbox_dedupe_no_store IS
  'ق-185: the store-less half of the dedupe rule. UNIQUE(store_id, dedupe_key) cannot enforce it because NULL store ids never collide.';
