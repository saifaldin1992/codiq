-- PG-8 (ق-76) — the new merchant's first path.
--
-- TWO TIMESTAMPS, AND NOTHING ELSE. Every other step's state is DERIVED from the
-- data itself: «first product» is complete because a product exists, «delivery»
-- because an enabled rate exists, «published» because the store is active. That
-- is the acceptance criterion — a manual flag drifts from reality the first time
-- a merchant deletes the product the flag says he created.
--
-- The two that CANNOT be derived, because nothing else in the database records
-- them:
--   * preview_seen_at — he opened the «what an arriving order looks like» view;
--   * dismissed_at    — he skipped the path, or finished it. Once set, the path
--                       never returns: deleting his only product later must not
--                       resurrect a welcome mat.
--
-- ⚠️ There is deliberately NO demo-order column, and no demo order.
--
-- The plan's fourth step is «طلب تجريبي», and its own acceptance criterion warns
-- that such an order must never reach the ledger or the analytics «وإلا لوّث
-- أرقام التاجر من يومه الأول». Meeting that with a real row would mean excluding
-- it at ELEVEN aggregate sites across five services today, and at every aggregate
-- written from now on — a tax nobody pays forever, where the first missed call
-- site silently corrupts a merchant's own numbers.
--
-- So the step shows him the order screen rendered from HIS product without
-- inserting anything. It satisfies the intent — he learns what an arriving order
-- looks like before his first customer sends one — and satisfies the constraint
-- absolutely rather than by vigilance.

ALTER TABLE stores
  ADD COLUMN onboarding_preview_seen_at TIMESTAMPTZ(6),
  ADD COLUMN onboarding_dismissed_at TIMESTAMPTZ(6);
