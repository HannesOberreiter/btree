#!/usr/bin/env bash
# Starts the local development setup: the server with tsc --watch and nodemon,
# and the web app with quasar dev. Ctrl+C stops everything.
#
#   scripts/dev.sh
#
# The server reads apps/server/env/development.env, and the web app reads
# apps/web/.env. The script expects the development MariaDB and Redis to run
# already. Before the start, the script builds the server once and runs the
# migrations on the development database.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
server_port=8101
web_port=9000

# Stop all child processes when the script ends.
trap 'trap - INT TERM EXIT; kill 0 2>/dev/null' INT TERM EXIT

for port in "$server_port" "$web_port"; do
  if nc -z 127.0.0.1 "$port" 2>/dev/null; then
    echo "Something already listens on port $port. Stop it first." >&2
    exit 1
  fi
done

# Ports of the development MariaDB and Redis in development.env.
for port in 33062 6379; do
  if ! nc -z 127.0.0.1 "$port" 2>/dev/null; then
    echo "Nothing listens on port $port. Start MariaDB and Redis first." >&2
    exit 1
  fi
done

# Write each line with a prefix, so that the logs stay readable.
prefix() {
  awk -v p="[$1] " '{ print p $0; fflush() }'
}

echo "Build the server and run the migrations"
cd "$root/apps/server"
pnpm run build
pnpm run dev:knex migrate:latest

pnpm run dev:build 2>&1 | prefix build &
pnpm run dev:serve 2>&1 | prefix server &

cd "$root/apps/web"
pnpm run dev 2>&1 | prefix web &

wait
