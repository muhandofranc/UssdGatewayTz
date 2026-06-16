"""Idempotent bootstrap: create the super_admin portal user if missing.

Reads `BOOTSTRAP_ADMIN_EMAIL` + `BOOTSTRAP_ADMIN_PASSWORD` from env.
Behaviour:

- Both env vars empty / unset  -> silent no-op. Set on first deploy,
  remove (or leave blank) afterwards.
- Email already exists         -> log + no-op. We never touch an
  existing user's password from here; if you've forgotten it, reset
  via SQL (`UPDATE portal_users SET password_hash=...`).
- Email missing                -> generate bcrypt(rounds=12) hash and
  insert as `super_admin`, `active=TRUE`.

Same idempotency contract as `db_init.py`, so wiring `db_init -> seed_admin`
on every container start is safe.
"""
from __future__ import annotations

import logging
import os

import bcrypt
import psycopg2

from .config import load as load_settings

LOGGER = logging.getLogger(__name__)

_ADMIN_DEFAULT_NAME = "Bootstrap Super Admin"


def run() -> None:
    email = os.environ.get("BOOTSTRAP_ADMIN_EMAIL", "").strip().lower()
    pw = os.environ.get("BOOTSTRAP_ADMIN_PASSWORD", "")
    if not email or not pw:
        return

    s = load_settings()
    conn = psycopg2.connect(
        host=s.pg.host, port=s.pg.port, user=s.pg.user,
        password=s.pg.password, dbname=s.pg.db, sslmode=s.pg.sslmode,
        application_name="ussd_gateway_tz_seed_admin",
        connect_timeout=10,
    )
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM portal_users WHERE LOWER(email) = %s",
                (email,),
            )
            if cur.fetchone() is not None:
                LOGGER.info("bootstrap admin %s already exists — no-op", email)
                return

            cur.execute("SELECT id FROM roles WHERE key = 'super_admin'")
            row = cur.fetchone()
            if row is None:
                # Migrations include the super_admin role; this only fires
                # if seed runs against a half-built schema.
                LOGGER.error(
                    "super_admin role missing — migrations incomplete; "
                    "skipping bootstrap admin"
                )
                return
            role_id = row[0]

            hashed = bcrypt.hashpw(
                pw.encode("utf-8"), bcrypt.gensalt(rounds=12)
            ).decode("utf-8")
            cur.execute(
                """
                INSERT INTO portal_users
                    (email, name, password_hash, role_id, active)
                VALUES (%s, %s, %s, %s, TRUE)
                """,
                (email, _ADMIN_DEFAULT_NAME, hashed, role_id),
            )
            LOGGER.warning(
                "seeded bootstrap admin %s — CHANGE PASSWORD on first login",
                email,
            )
    finally:
        conn.close()


if __name__ == "__main__":
    logging.basicConfig(
        level="INFO", format="%(asctime)s %(levelname)s: %(message)s"
    )
    run()
