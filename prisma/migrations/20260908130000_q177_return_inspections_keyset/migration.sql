-- ق-177: inspected returns are now READ, newest decision first, per store, with
-- the house keyset on (inspected_at, id). No existing index on
-- inventory_reservations leads with the tenant and ends in that pair.
CREATE INDEX inventory_reservations_store_inspected_id_idx ON inventory_reservations(store_id, inspected_at DESC, id DESC);
