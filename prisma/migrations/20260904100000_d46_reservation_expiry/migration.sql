-- D-46 — a reservation that expires, so an abandoned COD order stops holding
-- the shelf hostage.
--
-- Today `inventory_reservations` has no clock at all, and the ONLY thing that
-- ever releases a row is a human moving the order to cancelled/rejected
-- (settleStorefrontReservations). So a storefront COD order that nobody ever
-- calls back sits in `new` forever, and its `status='active'` reservation is
-- subtracted from availability forever — by the storefront listing, by the
-- product page, by the checkout guard AND by the POS till's sellable slice
-- (pos.service.ts subtracts SUM(active reservations) before it may decrement).
-- The merchant sees «غير متوفر» on a product that is physically on his shelf,
-- and nothing in the product anywhere tells him why. Silent, cumulative lost
-- sales — which is exactly how the debt register described it.
--
-- Owner decision 8 (phase-20 blueprint): 72 hours, and ONLY while the order is
-- still `new`. Long enough for a merchant to phone a customer over a weekend,
-- short enough that stock is not pinned for weeks. Every other status is out of
-- scope at any age: a `processing` order has been acknowledged by a human, and
-- taking its stock away behind his back is a worse bug than the one being fixed.
--
-- ── THE CLOCK LIVES IN THE DATABASE, NOT IN A SERVICE ────────────────────────
-- `expires_at` is NOT NULL with a DEFAULT, in the same spirit as the
-- `inventory_movements` snapshot trigger and the generated `is_low_stock`
-- column: every writer produces a complete row, raw SQL included, and no
-- application code names the column in an INSERT. A reservation minted without
-- a clock would be D-46 quietly coming back, so the schema makes one
-- impossible rather than asking six writers to remember.
-- `phase1-backend/src/services/retention.ts` carries the readable copy
-- (RESERVATION_TTL_HOURS) and the integration suite asserts the two agree, so
-- changing the TTL in one place without the other fails CI.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) The column. Nullable first ⇒ instant ALTER, no rewrite, no lock held while
--    the storefront is checking out. NOT NULL arrives in step 3, after every
--    existing row has a value.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE inventory_reservations
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Backfill. `created_at + 72h` is the only honest answer: it is what the
--    value WOULD have been had the column existed when the row was written.
--
--    Every existing row is stamped, not just the active ones. A released or
--    consumed reservation's clock is meaningless — its status already put it
--    beyond the sweep — but a uniformly populated column means the release job
--    never has to carry an `IS NULL` branch for legacy rows, and NULL never
--    silently means «never expires».
--
--    Consequence worth stating out loud: every reservation older than 72 hours
--    is backfilled ALREADY EXPIRED, so the first sweep after this deploy
--    releases the whole standing backlog of abandoned `new` orders at once.
--    That is the intended cure, not an accident — it is the stock the merchant
--    has been unable to sell. Each release is individually transacted and
--    writes its own movement row, so the trail names every one of them.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE inventory_reservations
   SET expires_at = created_at + interval '72 hours'
 WHERE expires_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) The default and the NOT NULL. `now() + interval '72 hours'` is the ONE
--    authoritative copy of the TTL. Changing it means a new migration that
--    alters this default AND the constant in retention.ts — the test that
--    compares them is what makes «AND» enforceable instead of aspirational.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE inventory_reservations
  ALTER COLUMN expires_at SET DEFAULT now() + interval '72 hours';

ALTER TABLE inventory_reservations
  ALTER COLUMN expires_at SET NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) The index the release job scans on.
--
--    The job's candidate query is `status = 'active' AND expires_at <= now()`,
--    and `status` leads deliberately: 'active' is the SMALL, hot slice of this
--    table — every settled order's rows are 'released' or 'consumed' forever —
--    so the leading equality lands the scan on exactly the rows that can still
--    expire, and the range on `expires_at` walks them in due order.
--
--    Composite and NOT partial, on purpose. A partial `WHERE status='active'`
--    index would be a touch smaller and would be UNDECLARABLE in
--    prisma/schema.prisma, which is precisely the drift D-50 is open about
--    (schema.prisma:784 already declares an InventoryReservation index that no
--    migration ever created). Adding more of that debt to save a few pages is a
--    bad trade — this index is declared in the schema, byte for byte.
--
--    Plain CREATE INDEX, not CONCURRENTLY: `prisma migrate deploy` wraps a
--    migration file in a transaction and CONCURRENTLY cannot run inside one.
--    This is the existing house pattern (md1, 20260827190000).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS inventory_reservations_expiry_sweep_idx
  ON inventory_reservations (status, expires_at);
