-- CD-1 «حزمة تدليل الزبون» — customer-delight batch.
--
-- The batch is ADDITIVE and needs no new table or column: public order tracking
-- reads store_orders/order_status_events, one-click reorder writes the existing
-- cart tables, and the courier notice rides the phase-15 notification outbox.
--
-- The ONLY schema change is the outbox event_type CHECK: phase 15 pinned it to
-- three values and phase 20B-2 widened it to four. CD-1b introduces
-- `order.courier_dispatched` («مندوبك في الطريق»), so the constraint is dropped
-- and recreated with the full allowed set — exactly the 20B-2 pattern. Existing
-- rows all carry one of the previously allowed values, so the recreated CHECK
-- validates without a rewrite.

ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_event_type;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_event_type
  CHECK (event_type IN ('order.created', 'order.status_changed', 'low_stock', 'cart.abandoned', 'order.courier_dispatched'));
