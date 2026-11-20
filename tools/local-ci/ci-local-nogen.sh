#!/usr/bin/env bash
# ci-local.sh, but with fresh-db-nogen.sh: `prisma generate` rewrites
# query_engine-windows.dll.node and Windows refuses the rename while the
# demo-view server on :3300 holds it open. The schema has not changed since the
# last generate, so the client on disk is the client this sweep would produce.
cd /d/saif/codiq/CODIQ-md5 || exit 1
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/codiq_ci_test?schema=public"
export CODIQ_POSTGRES_URL="$DATABASE_URL"
export CODIQ_POSTGRES_URL_UNPOOLED="$DATABASE_URL"
export CODIQ_TEST_DATABASE_URL="$DATABASE_URL"
export SESSION_JWT_SECRET="codiq-local-repro-secret-not-for-production"
export CODIQ_ALLOW_OWNER_REGISTRATION=true
export CODIQ_PRODUCTION_DATABASE_URL="postgresql://x:x@production-forbidden.invalid:5432/x"
export CODIQ_ENCRYPTION_KEY="local-verification-key-not-a-secret-0123456789abcdef0123456789abcdef"
LOCK="/tmp/codiq-sweep.lock"
if [ -e "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "REFUSING: a sweep is already running (pid $(cat "$LOCK"))."; exit 1
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT
bash "C:/Users/mycom/AppData/Local/Temp/claude/D--saif-codiq/a0b23f00-d406-4983-b7c7-74c3fa7e6ff4/scratchpad/fresh-db-nogen.sh" || exit 1
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
