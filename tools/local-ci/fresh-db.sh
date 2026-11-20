#!/usr/bin/env bash
# Recreate the local CI database exactly the way CI's fresh postgres container
# starts: empty, then every migration. Stale rows from a previous run are not
# a state CI ever sees, and they produced three phantom failures on 2026-09-08.
set -eo pipefail
cd /d/saif/codiq/CODIQ-md5
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/codiq_ci_test?schema=public"
export CODIQ_POSTGRES_URL="$DATABASE_URL"
export CODIQ_POSTGRES_URL_UNPOOLED="$DATABASE_URL"
export CODIQ_TEST_DATABASE_URL="$DATABASE_URL"
export SESSION_JWT_SECRET="codiq-local-repro-secret-not-for-production"
export CODIQ_ALLOW_OWNER_REGISTRATION=true
export CODIQ_PRODUCTION_DATABASE_URL="postgresql://x:x@production-forbidden.invalid:5432/x"
export CODIQ_ENCRYPTION_KEY="local-verification-key-not-a-secret-0123456789abcdef0123456789abcdef"
PSQL="/c/Program Files/PostgreSQL/16/bin/psql.exe"
PGPASSWORD=postgres "$PSQL" -h localhost -U postgres -d postgres -q -c "DROP DATABASE IF EXISTS codiq_ci_test WITH (FORCE);" -c "CREATE DATABASE codiq_ci_test;"
pnpm phase1:db:generate >/dev/null
pnpm phase1:db:migrate
echo "fresh-db: ready"
