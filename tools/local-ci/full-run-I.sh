#!/usr/bin/env bash
# Batch I — build, every browser suite CI runs (in CI's order, against a real
# composite server on 3114), then the full non-browser sweep.
cd /d/saif/codiq/CODIQ-md5 || exit 1
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/codiq_ci_test?schema=public"
export CODIQ_POSTGRES_URL="$DATABASE_URL"
export CODIQ_POSTGRES_URL_UNPOOLED="$DATABASE_URL"
export CODIQ_TEST_DATABASE_URL="$DATABASE_URL"
export SESSION_JWT_SECRET="codiq-local-repro-secret-not-for-production"
export CODIQ_ALLOW_OWNER_REGISTRATION=true
export CODIQ_PRODUCTION_DATABASE_URL="postgresql://x:x@production-forbidden.invalid:5432/x"
export CODIQ_ENCRYPTION_KEY="local-verification-key-not-a-secret-0123456789abcdef0123456789abcdef"

echo "=== build"
pnpm build >/tmp/fri-build.log 2>&1 || { echo "BUILD FAILED"; tail -20 /tmp/fri-build.log; exit 1; }
echo "build ok"

# The browser job's own list, read from the workflow so this cannot drift.
START=$(grep -n 'name: ci / browser acceptance' .github/workflows/ci.yml | cut -d: -f1)
mapfile -t BROWSER < <(awk -v s="$START" 'NR>s && /run: pnpm /{print $3}' .github/workflows/ci.yml \
  | grep -vE '^(install|build|check)$' | awk '!seen[$0]++')
echo "browser suites: ${#BROWSER[@]}"

PORT=3114 node dist/index.js >/tmp/fri-composite.log 2>&1 &
COMPOSITE=$!
for _ in $(seq 1 40); do
  curl --fail --silent http://127.0.0.1:3114/platform/login >/dev/null && break
  sleep 1
done
echo "composite up: $(curl --fail --silent -o /dev/null -w '%{http_code}' http://127.0.0.1:3114/platform/login)"

bpass=0; bfail=0; bfailed=()
for s in "${BROWSER[@]}"; do
  log="/tmp/fri-${s//:/-}.log"
  if PHASE13_WEB_BASE_URL=http://127.0.0.1:3114 pnpm "$s" >"$log" 2>&1; then
    echo "PASS  $s"; bpass=$((bpass+1))
  else
    echo "FAIL  $s  → $log"; bfail=$((bfail+1)); bfailed+=("$s")
  fi
done
kill "$COMPOSITE" 2>/dev/null || true
echo "---- browser: $bpass passed, $bfail failed"
[ ${#bfailed[@]} -gt 0 ] && printf 'browser failed: %s\n' "${bfailed[*]}"

echo "=== sweep"
bash "C:/Users/mycom/AppData/Local/Temp/claude/D--saif-codiq/a0b23f00-d406-4983-b7c7-74c3fa7e6ff4/scratchpad/ci-local.sh"
