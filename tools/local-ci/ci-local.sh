#!/usr/bin/env bash
# Run every non-browser check CI runs, locally, in CI's own order.
# Exists because today six failures were discovered by CI and not by me.
cd /d/saif/codiq/CODIQ-md5 || exit 1
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/codiq_ci_test?schema=public"
export CODIQ_POSTGRES_URL="$DATABASE_URL"
export CODIQ_POSTGRES_URL_UNPOOLED="$DATABASE_URL"
export CODIQ_TEST_DATABASE_URL="$DATABASE_URL"
export SESSION_JWT_SECRET="codiq-local-repro-secret-not-for-production"
export CODIQ_ALLOW_OWNER_REGISTRATION=true
export CODIQ_PRODUCTION_DATABASE_URL="postgresql://x:x@production-forbidden.invalid:5432/x"
export CODIQ_ENCRYPTION_KEY="local-verification-key-not-a-secret-0123456789abcdef0123456789abcdef"

# CI starts from an empty container; so does this. Stale rows from an earlier
# run produced three phantom failures on 2026-09-08 (phase1/phase9a/phase14).
# ONE SWEEP AT A TIME. `fresh-db.sh` runs DROP DATABASE ... WITH (FORCE) on the
# shared test database, so a second sweep started while the first is running
# kills every one of its connections mid-suite. That is exactly what produced
# nine "failures" on 2026-09-09 — `terminating connection due to administrator
# command` — none of which were defects. Refuse instead of corrupting the run.
LOCK="/tmp/codiq-sweep.lock"
if [ -e "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "REFUSING: a sweep is already running (pid $(cat "$LOCK")). Wait for it, or kill it first."
  exit 1
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT
# THE LOCK PROTECTS SWEEP-AGAINST-SWEEP AND NOTHING ELSE. On 2026-09-09 a sweep
# reported ri1 and retention as failures while a SINGLE suite was being re-run
# beside it for an unrelated proof — same database, same TRUNCATEs. Do not run
# `pnpm <suite>:test` while this is running; wait, or you will diagnose your own
# interference. (A per-suite lock would be the real fix; until then this note is.)

bash "$(dirname "$0")/fresh-db.sh" || exit 1

# CI's own list, in CI's order, minus the browser job and the setup steps.
mapfile -t SCRIPTS < <(grep -oE 'run: pnpm [a-z0-9:.-]+' .github/workflows/ci.yml \
  | sed 's/run: pnpm //' \
  | grep -vE '^(install|build|check|phase1:db:generate|phase1:db:migrate)$' \
  | grep -v ':browser$' \
  | awk '!seen[$0]++')

echo "${#SCRIPTS[@]} checks"
pass=0; fail=0; failed=()
for s in "${SCRIPTS[@]}"; do
  if pnpm "$s" >"/tmp/ci-${s//:/-}.log" 2>&1; then
    pass=$((pass+1))
  else
    fail=$((fail+1)); failed+=("$s"); echo "FAIL  $s  → /tmp/ci-${s//:/-}.log"
  fi
done
echo "---- $pass passed, $fail failed"
[ ${#failed[@]} -gt 0 ] && printf 'failed: %s\n' "${failed[*]}"
exit 0
