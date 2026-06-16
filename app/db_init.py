"""One-shot schema apply: `python -m app.db_init`.

Reads db/001_init.sql (and any future db/*.sql in lex order) and
executes them against the configured Postgres. Every statement in
the migration files is idempotent (CREATE … IF NOT EXISTS / INSERT
… ON CONFLICT DO NOTHING) so this is safe to run multiple times.

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
            for f in files:
                path = os.path.join(mdir, f)
                logging.info("  applying %s", f)
                with open(path, "r", encoding="utf-8") as fh:
                    sql = fh.read()
                cur.execute(sql)
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
