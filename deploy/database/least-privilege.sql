-- Security pass 2026-11 — the application runs as a role that can read and
-- write ROWS and nothing else. Migrations keep running as the owner.
--
-- Why: today the server connects as the database owner. Every query it sends
-- could therefore CREATE, ALTER, DROP or TRUNCATE any table, rewrite migration
-- history, or edit the ledger. The code does none of that (no DDL anywhere under
-- phase1-backend/src), so the least privilege that runs it is exactly DML — and
-- if a query were ever subverted, that is all it could do.
--
-- HOW TO APPLY (once per database, as the owner — e.g. Neon's main role):
--   1. CREATE ROLE codiq_app LOGIN PASSWORD '<a long random password>';
--   2. psql "$CODIQ_POSTGRES_URL_UNPOOLED" -v ON_ERROR_STOP=1 -f deploy/database/least-privilege.sql
--   3. Point CODIQ_POSTGRES_URL (the app's pooled URL) at codiq_app.
--      Leave CODIQ_POSTGRES_URL_UNPOOLED on the owner: `prisma migrate deploy` uses it.
-- Re-running is safe: every statement is idempotent.

-- Nobody but the owner creates objects in the schema.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO codiq_app;

-- Rows: read and write. No TRUNCATE, no REFERENCES, no TRIGGER.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO codiq_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO codiq_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO codiq_app;

-- Tables the next migrations create get the same grants automatically
-- (this applies to objects created by the role running this script: the owner).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO codiq_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO codiq_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO codiq_app;

-- Migration history is the owner's.
REVOKE INSERT, UPDATE, DELETE ON TABLE _prisma_migrations FROM codiq_app;

-- APPEND-ONLY BY RULE, NOT BY HABIT. The money ledger and the two audit logs
-- are only ever inserted into (retention.ts lists them as NEVER_AUTO_DELETED).
-- The application role may add a line; it may never change or erase one.
REVOKE UPDATE, DELETE ON TABLE ledger_entries, store_audit_events, platform_audit_events FROM codiq_app;

-- Marketplace M12: the `vector` type (pgvector) is created by the migration, run as the
-- database owner; codiq_app only reads and writes product_image_embeddings like any table.
