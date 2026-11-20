#!/usr/bin/env bash
# Run every browser-acceptance suite locally, once, after a single build.
# Exists because five failures today were discovered by CI and not by me.
cd /d/saif/codiq/CODIQ-md5 || exit 1
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/codiq_ci_test?schema=public"
export CODIQ_POSTGRES_URL="$DATABASE_URL"
export CODIQ_POSTGRES_URL_UNPOOLED="$DATABASE_URL"
export CODIQ_TEST_DATABASE_URL="$DATABASE_URL"
export SESSION_JWT_SECRET="codiq-local-repro-secret-not-for-production"
export CODIQ_ALLOW_OWNER_REGISTRATION=true
export CODIQ_PRODUCTION_DATABASE_URL="postgresql://x:x@production-forbidden.invalid:5432/x"
export CODIQ_ENCRYPTION_KEY="local-verification-key-not-a-secret-0123456789abcdef0123456789abcdef"

pnpm build >/dev/null 2>&1 || { echo "BUILD FAILED"; exit 1; }
echo "build ok"

pass=0; fail=0
for f in phase1-backend/tests/*.browser-acceptance.mjs; do
  name=$(basename "$f" .browser-acceptance.mjs)
  if node --import tsx "$f" >"/tmp/bs-$name.log" 2>&1; then
    echo "PASS  $name"; pass=$((pass+1))
  else
    echo "FAIL  $name  → /tmp/bs-$name.log"; fail=$((fail+1))
  fi
done
echo "---- $pass passed, $fail failed"
