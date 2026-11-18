sleep 5
if [ "${IS_CHILD:-false}" != "true" ]; then
  pnpm run migrate
fi
# exec replaces the shell, so node is PID 1 and gets SIGTERM from Docker.
exec node dist/app.bootstrap.js