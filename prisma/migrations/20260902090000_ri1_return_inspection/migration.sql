-- RI-1 «فحص المرتجعات» — resolving pending_inspection at last.
-- A returned order's goods sat in a state NOTHING consumed: every refused COD
-- delivery bled phantom inventory. This adds the resolution vocabulary
-- (restocked / written_off / split) plus the audit trio, with the arithmetic
-- enforced by the database itself so a resolution row can never lie.
--
-- The original two-value CHECK (20260818011500:112) was INLINE and unnamed, so
-- Postgres auto-named it — drop that exact name (IF EXISTS, defensively) before
-- adding the extended, properly NAMED constraint (the notification_outbox
-- event_type drop/re-add precedent).
ALTER TABLE inventory_reservations
  DROP CONSTRAINT IF EXISTS inventory_reservations_return_disposition_check;
ALTER TABLE inventory_reservations
  ADD CONSTRAINT inventory_reservations_return_disposition_allowed
  CHECK (return_disposition IN ('not_returned', 'pending_inspection', 'restocked', 'written_off', 'split'));

ALTER TABLE inventory_reservations
  ADD COLUMN restocked_quantity integer NOT NULL DEFAULT 0,
  ADD COLUMN written_off_quantity integer NOT NULL DEFAULT 0,
  ADD COLUMN inspected_at timestamptz,
  ADD COLUMN inspected_by_kind text,
  ADD COLUMN inspected_by_id uuid,
  ADD COLUMN inspection_note text;

ALTER TABLE inventory_reservations
  ADD CONSTRAINT inventory_reservations_inspected_by_kind
  CHECK (inspected_by_kind IS NULL OR inspected_by_kind IN ('merchant', 'staff'));

-- Self-enforcing arithmetic (the *_deleted_implies_inactive idiom): the
-- disposition, the two quantities and the audit stamp move as ONE fact.
ALTER TABLE inventory_reservations
  ADD CONSTRAINT inventory_reservations_inspection_consistent CHECK (
    (return_disposition IN ('not_returned', 'pending_inspection') AND restocked_quantity = 0 AND written_off_quantity = 0 AND inspected_at IS NULL)
    OR (return_disposition = 'restocked' AND restocked_quantity = quantity AND written_off_quantity = 0 AND inspected_at IS NOT NULL)
    OR (return_disposition = 'written_off' AND written_off_quantity = quantity AND restocked_quantity = 0 AND inspected_at IS NOT NULL)
    OR (return_disposition = 'split' AND restocked_quantity > 0 AND written_off_quantity > 0 AND restocked_quantity + written_off_quantity = quantity AND inspected_at IS NOT NULL)
  );

ALTER TABLE inventory_reservations
  ADD CONSTRAINT inventory_reservations_note_length
  CHECK (inspection_note IS NULL OR length(inspection_note) <= 500);

-- The queue reads exactly one shape; keep it hot the same way the
-- availability sums are (partial index, 9a precedent).
CREATE INDEX IF NOT EXISTS inventory_reservations_pending_inspection_idx
  ON inventory_reservations (store_id, returned_at DESC)
  WHERE return_disposition = 'pending_inspection';
