#!/usr/bin/env bash
# Runs the Playwright e2e tests of apps/web against the server of the same
# checkout, locally and in CI. The script starts MariaDB and Redis from
# infra/test/compose.yml, builds and starts the server and the web app, runs the
# tests, and stops everything again.
#
#   scripts/e2e.sh                     # all tests
#   scripts/e2e.sh e2e/02-user/03-*    # arguments go to playwright test
#
# Environment:
#   TEST_DB_PORT, TEST_REDIS_PORT  host ports of the containers (3306, 6379)
#   E2E_WEB_PORT                   port of the web app (9000)
#   E2E_LOG_DIR                    directory for server.log and web.log
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
web_port=${E2E_WEB_PORT:-9000}
log_dir=${E2E_LOG_DIR:-$(mktemp -d)}
compose=(docker compose -f "$root/infra/test/compose.yml")

# The server reads apps/server/env/ci.env. dotenv keeps variables that are
# already set, so these values win over the file.
export ENVIRONMENT=ci NODE_ENV=ci
export DB_PORT=${TEST_DB_PORT:-3306} REDIS_PORT=${TEST_REDIS_PORT:-6379}
export AUTHORIZED=http://localhost:$web_port FRONTEND=http://localhost:$web_port

server_url=http://localhost:8102
web_url=http://localhost:$web_port

server_pid=
web_pid=
cleanup() {
  [[ -n $web_pid ]] && kill "$web_pid" 2>/dev/null || true
  [[ -n $server_pid ]] && kill "$server_pid" 2>/dev/null || true
  "${compose[@]}" down --volumes >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Wait until a URL answers, or print the log and fail.
wait_for() {
  for _ in $(seq 1 60); do
    curl -sf -o /dev/null "$1" && return 0
    sleep 1
  done
  echo "No answer from $1:" >&2
  cat "$2" >&2
  return 1
}

for url in "$server_url/api/v1/openapi.json" "$web_url/"; do
  if curl -s -o /dev/null "$url"; then
    echo "Something already answers on $url. Stop it, or set E2E_WEB_PORT." >&2
    exit 1
  fi
done

echo "Logs: $log_dir"

echo "Start MariaDB and Redis"
"${compose[@]}" up -d --wait

echo "Build and start the server"
cd "$root/apps/server"
pnpm install --frozen-lockfile
pnpm run build
pnpm run migrate
pnpm exec knex seed:run
node dist/app.bootstrap.js >"$log_dir/server.log" 2>&1 &
server_pid=$!
wait_for "$server_url/api/v1/openapi.json" "$log_dir/server.log"

# BRANCH=dev adds localhost to the Content Security Policy. The Matomo boot
# file fails without a host and a site ID, so the build gets dummies.
echo "Build and start the web app"
cd "$root/apps/web"
pnpm install --frozen-lockfile
pnpm --dir src-pwa install --frozen-lockfile
BRANCH=dev BACKEND_URL=$server_url/api \
  MATOMO_HOST=http://localhost:9999 MATOMO_SITE_ID=1 pnpm build
node_modules/.bin/vite preview --outDir dist/spa --port "$web_port" \
  --strictPort >"$log_dir/web.log" 2>&1 &
web_pid=$!
wait_for "$web_url/" "$log_dir/web.log"

echo "Run the e2e tests"
# CI also installs the system packages of the browser.
pnpm exec playwright install ${CI:+--with-deps} chromium
BACKEND_URL=$server_url/api PLAYWRIGHT_BACKEND_URL=$server_url \
  PLAYWRIGHT_API_ORIGIN=$web_url PLAYWRIGHT_BASE_URL=$web_url \
  pnpm exec playwright test "$@"
