-- PG-2 (d) — the three new permission codes.
--
-- `staff_membership_permission_overrides_code` is an enum-shaped CHECK
-- (20260824154500:47-59). Adding a code to PERMISSION_CODES in TypeScript
-- WITHOUT widening it here compiles, passes typecheck, and then fails at
-- runtime with 23514 the first time a merchant grants or denies the new code on
-- a membership — surfacing as a bare 500. This is the `cart.abandoned` lesson
-- (docs/DEVELOPMENT_ENVIRONMENT.md §4) applied to permissions.
--
-- All three are store_manager-only in ROLE_PERMISSION_MATRIX; a store_staff
-- member must not read the log that names whoever disabled him, nor undo a
-- manager's removal. The CHECK governs OVERRIDES, so it must accept them anyway
-- — a merchant may deliberately grant one to a single member.

ALTER TABLE staff_membership_permission_overrides
  DROP CONSTRAINT staff_membership_permission_overrides_code;

ALTER TABLE staff_membership_permission_overrides
  ADD CONSTRAINT staff_membership_permission_overrides_code CHECK (permission_code IN (
    'catalog.products.view',
    'catalog.products.create',
    'catalog.products.update',
    'catalog.products.delete',
    'catalog.categories.manage',
    'inventory.update',
    'orders.view',
    'orders.update',
    'customers.view',
    'team.manage',
    'settings.manage',
    'catalog.trash.view',
    'catalog.trash.restore',
    'catalog.audit.view'
  ));
