-- «طلباتي» and «اشتريت منها» find a shopper's customer rows across EVERY store
-- by shopper_id alone. The only index on the column, customers_store_shopper_key,
-- leads with store_id, so that lookup was a full scan of customers — every
-- store's customers — on each page load. A partial index on shopper_id answers it.
CREATE INDEX customers_shopper_idx ON customers (shopper_id) WHERE shopper_id IS NOT NULL;
