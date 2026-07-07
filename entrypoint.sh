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

# Prometheus multi-worker mode.
#
# Uvicorn runs several worker processes (see Dockerfile CMD). Each
# process holds its own copy of prometheus-client Counter/Histogram
# state in memory. To have them all sum into a single scrape output,
# prometheus-client uses a shared directory of memory-mapped files
# — one file per metric per worker.
#
# The directory MUST exist and be empty at container start (stale
# files from a previous run pollute the counter totals). We wipe +
# recreate it here, then export PROMETHEUS_MULTIPROC_DIR so that the
# app processes see it before they import prometheus_client.
export PROMETHEUS_MULTIPROC_DIR="${PROMETHEUS_MULTIPROC_DIR:-/tmp/prometheus-multiproc}"
rm -rf "$PROMETHEUS_MULTIPROC_DIR"
mkdir -p "$PROMETHEUS_MULTIPROC_DIR"

echo "→ applying migrations + bootstrap admin (if env set)…"
python -m app.db_init

echo "→ starting: $* (PROMETHEUS_MULTIPROC_DIR=$PROMETHEUS_MULTIPROC_DIR)"
exec "$@"
