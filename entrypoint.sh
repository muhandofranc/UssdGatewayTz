#!/bin/sh
# Container entrypoint:
#   1. apply db/*.sql migrations (idempotent)
#   2. seed the bootstrap super_admin if BOOTSTRAP_ADMIN_EMAIL +
#      BOOTSTRAP_ADMIN_PASSWORD are set in env (idempotent; skipped
#      silently if the email already exists or the vars are blank)
#   3. exec the original CMD (uvicorn)
#
# Postgres readiness is guaranteed by `depends_on: postgres:
# condition: service_healthy` in docker-compose.yml; if you ever run
# this image outside compose against a not-yet-ready DB, add a
# wait-loop here.
set -eu

echo "→ applying migrations + bootstrap admin (if env set)…"
python -m app.db_init

echo "→ starting: $*"
exec "$@"
