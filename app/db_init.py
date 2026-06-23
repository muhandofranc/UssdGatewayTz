"""One-shot schema apply: `python -m app.db_init`.

Reads db/001_init.sql (and any future db/*.sql in lex order) and
executes them against the configured Postgres. Every statement in
the migration files is idempotent (CREATE … IF NOT EXISTS / INSERT
… ON CONFLICT DO NOTHING) so this is safe to run multiple times.

Concurrency: docker-compose starts gateway, scheduler, and
scheduler-intraday in parallel — they share this image and run the
same entrypoint, so all three would otherwise race on the same
migration set. A few migrations (notably db/013) take an
ACCESS EXCLUSIVE lock on `ussd_session_logs` for non-CONCURRENT
CREATE INDEX statements; two callers in flight at once deadlock
(`psycopg2.errors.DeadlockDetected` observed 2026-06-23). The
pg_advisory_lock below serialises callers: only one runs the loop
at a time, the others wait then fast-path on the `schema_migrations`
tracking table.

Tracking table: `schema_migrations(filename PRIMARY KEY, applied_at)`
records which files have run. Before taking the advisory lock we do
a cheap SELECT — if every db/*.sql filename is already present, we
skip the lock and the file loop entirely. This is what keeps rebuild
fast on the 2nd and 3rd container: they spend ~10ms each instead of
re-executing 17 idempotent DDL files in series behind the lock.

For a real production migration story, swap this for Alembic or
sqitch later (Phase 4) — this script is just the dev / first-deploy
bootstrap.
"""
from __future__ import annotations

import logging
import os
import sys

import psycopg2

from .config import load as load_settings


# Application-specific advisory lock key. Any 64-bit signed integer
# works; this constant is hardcoded so the lock identity is stable
# across deploys and rebuilds. Session-scoped — auto-released if the
# holding connection drops mid-run (e.g. container OOM during a long
# migration), so there's no risk of permanent lock-out.
_MIGRATION_LOCK_KEY = 4815162342


def _migrations_dir() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, "..", "db"))


def main() -> int:
    logging.basicConfig(level="INFO",
                        format="%(asctime)s %(levelname)s: %(message)s")
    s = load_settings()
    mdir = _migrations_dir()
    if not os.path.isdir(mdir):
        logging.error("migrations dir not found: %s", mdir)
        return 1
    files = sorted(f for f in os.listdir(mdir) if f.endswith(".sql"))
    if not files:
        logging.warning("no .sql files in %s", mdir)
        return 0

    logging.info("applying %d migration file(s) to host=%s db=%s",
                 len(files), s.pg.host, s.pg.db)
    conn = psycopg2.connect(
        host=s.pg.host, port=s.pg.port, user=s.pg.user,
        password=s.pg.password, dbname=s.pg.db, sslmode=s.pg.sslmode,
        application_name="ussd_gateway_tz_migrate",
        connect_timeout=10,
    )
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            # Tracking table — created outside the advisory lock so the
            # SELECT below is always against a real table. Idempotent.
            cur.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations ("
                "filename TEXT PRIMARY KEY, "
                "applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
            )

            # Fast path: if every file is already recorded, skip the
            # lock + loop entirely. Containers 2 and 3 normally land here.
            cur.execute("SELECT filename FROM schema_migrations")
            applied = {row[0] for row in cur.fetchall()}
            pending = [f for f in files if f not in applied]
            if not pending:
                logging.info("all %d migration(s) already applied — skipping",
                             len(files))
            else:
                # Serialise across containers — see module docstring.
                logging.info("acquiring migration lock (key=%s)…",
                             _MIGRATION_LOCK_KEY)
                cur.execute("SELECT pg_advisory_lock(%s)",
                            (_MIGRATION_LOCK_KEY,))
                logging.info("migration lock acquired")
                try:
                    # Re-check after acquiring the lock: a sibling
                    # container may have applied them while we waited.
                    cur.execute("SELECT filename FROM schema_migrations")
                    applied = {row[0] for row in cur.fetchall()}
                    pending = [f for f in files if f not in applied]
                    logging.info("%d pending after lock", len(pending))
                    for f in pending:
                        path = os.path.join(mdir, f)
                        logging.info("  applying %s", f)
                        with open(path, "r", encoding="utf-8") as fh:
                            sql = fh.read()
                        cur.execute(sql)
                        cur.execute(
                            "INSERT INTO schema_migrations (filename) "
                            "VALUES (%s) ON CONFLICT (filename) DO NOTHING",
                            (f,),
                        )
                finally:
                    cur.execute("SELECT pg_advisory_unlock(%s)",
                                (_MIGRATION_LOCK_KEY,))
        logging.info("migrations complete")
    finally:
        conn.close()

    # Bootstrap admin is an optional, idempotent step keyed off
    # BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD. Silent no-op when
    # unset, no-op when the user already exists. Lives in a separate
    # module so it can also be run on its own (`python -m app.seed_admin`).
    from . import seed_admin  # local import to keep db_init's dep surface tight
    seed_admin.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
