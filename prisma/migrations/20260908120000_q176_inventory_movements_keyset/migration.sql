-- ق-176: the stock movement log is now READ, newest first, per store, with the
-- house keyset on (created_at, id). The index that existed —
-- inventory_movements_store_product_created_idx (store_id, product_id, created_at)
-- — serves one product's history but cannot walk a whole store's log in time
-- order, and it stops before the id tiebreaker. This one ends in (created_at, id)
-- with the tenant leading it, which is the shape 20-3 requires of every page.
CREATE INDEX inventory_movements_store_created_id_idx ON inventory_movements(store_id, created_at DESC, id DESC);
