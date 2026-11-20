-- PG-5 (ق-73) — the note the customer writes at checkout.
--
-- «اتصل قبل الوصول» · «هدية، لا تضع الفاتورة» · «الشقة فوق الصيدلية». These are
-- daily requests in the Iraqi market, and today a customer has nowhere to put
-- them: he calls the merchant, or the courier arrives to a locked door.
--
-- Additive and nullable, so no existing order is touched and no write path is
-- blocked while it applies. The length ceiling is a CHECK rather than a promise
-- in the service layer: the field is written inside the checkout transaction,
-- and a transaction is exactly where a silent truncation would go unnoticed.
--
-- 500 characters is the ceiling the plan set. It is enforced in three places on
-- purpose — the browser hints it, the service refuses beyond it, and the column
-- makes it impossible — because only the last one survives a new caller.

ALTER TABLE store_orders
  ADD COLUMN customer_note TEXT;

ALTER TABLE store_orders
  ADD CONSTRAINT store_orders_customer_note_length
  CHECK (customer_note IS NULL OR char_length(customer_note) <= 500);
