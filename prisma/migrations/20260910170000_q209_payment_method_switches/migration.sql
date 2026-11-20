-- ق-209 — payment methods the merchant switches on and off.
--
-- Phase 1 created `payment_methods` and then forbade it from meaning anything:
-- `payment_methods_only_cod_enabled` allowed exactly one enabled row, COD, and
-- `store_orders_payment_method_allowed` let an order carry only 'cod' (or the
-- till's 'cash'). No code ever wrote a row, so every store's list was empty and
-- the merchant's «الدفع» page was a paragraph.
--
-- The owner wants what the reference dashboard has: a switch per method. The
-- electronic GATEWAYS still wait for phase 25أ — a switch that says «زين كاش»
-- and charges nobody would be a lie to the shopper — so what a merchant may
-- switch on today is a MANUAL WALLET TRANSFER: he names his wallet, the shopper
-- picks it at checkout, sees the number, transfers, and the order is created
-- «بانتظار التحويل» until the merchant confirms. That is how Iraqi shops take
-- electronic money today, and it needs no gateway.
--
-- Codes are lowercase everywhere ('cod' is what every order already carries);
-- the one legacy 'COD' spelling is folded before the new CHECK sees it.
--
-- ORDER MATTERS, and it was wrong once (ق-247, 2026-09-14): phase 1's
-- `payment_methods_only_cod_enabled` says «an enabled row is spelled 'COD'»,
-- so lowering the code while that CHECK still stands is a 23514 on every
-- database that has a store — which is every database except the empty one
-- CI migrates. Staging failed here on 2026-09-14 13:18 UTC and stayed pinned
-- to an older build until this file was corrected; production had not run it.
-- The old CHECK goes FIRST. `migration-rehearsal.integration.mjs` now replays
-- every unreleased migration over production-shaped rows so this cannot recur.
ALTER TABLE payment_methods DROP CONSTRAINT IF EXISTS payment_methods_only_cod_enabled;
UPDATE payment_methods SET code = lower(code);
-- Phase 1's bootstrap also wrote a 'CARD' row per store that the old CHECK
-- forbade from ever being enabled — a dead row, not a method. It goes; a
-- gateway arrives with 25أ as a real switch, not as a placeholder.
DELETE FROM payment_methods WHERE code NOT IN ('cod', 'zaincash', 'asiahawala', 'fib');
ALTER TABLE payment_methods ADD CONSTRAINT payment_methods_code_known CHECK (code IN ('cod', 'zaincash', 'asiahawala', 'fib'));

ALTER TABLE store_orders DROP CONSTRAINT IF EXISTS store_orders_payment_method_allowed;
ALTER TABLE store_orders ADD CONSTRAINT store_orders_payment_method_allowed CHECK (payment_method_code IN ('legacy', 'cod', 'cash', 'zaincash', 'asiahawala', 'fib'));
