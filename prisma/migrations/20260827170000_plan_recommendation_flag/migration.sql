-- CODIQ landing honesty fix (2026-08-27) — owner-controlled plan recommendation.
--
-- The public pricing grid used to badge «الأكثر اختياراً» on whichever plan
-- happened to sit second in the array. CODIQ has no customers, so that was an
-- invented popularity claim on a page that promises the opposite two sections
-- later. It is replaced by an explicit owner decision the platform stores.
--
-- ADDITIVE ONLY: one new column with a safe default. No drop, no truncate, no
-- delete, no rewrite of existing rows — every existing plan reads FALSE, which
-- means the pricing grid renders no badge until the owner picks a plan.
--
-- The «only one plan at a time» rule is enforced twice on purpose: the service
-- clears the other plans inside the same transaction that sets this one, and
-- the partial unique index below makes the invariant structural, so two racing
-- owner sessions cannot leave two recommended plans behind. A unique index on a
-- constant expression, restricted to the recommended rows, permits at most one
-- such row in the whole table.

BEGIN;

ALTER TABLE plans ADD COLUMN is_recommended BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX plans_single_recommended ON plans ((TRUE)) WHERE is_recommended;

COMMIT;
