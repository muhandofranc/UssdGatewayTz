"""In-stack scheduler — runs SQL maintenance tasks on a schedule.
================================================================

Lives as its own compose service(s) so the schedule travels with the
docker-compose stack — no host cron, no /etc/cron.d/, no surprise on
host rebuild. Logs to stdout (`docker compose logs scheduler`).

Two modes, picked by SCHEDULER_MODE:

  daily      — fires once a day at SCHEDULER_TIME (UTC, HH:MM, default
               02:00). TASKS_DAILY is the task list. Used to refresh
               `daily_session_summary` for yesterday so the /summary
               page + Overview chart's past-days bars stay current.

  intraday   — fires every SCHEDULER_INTERVAL_SECS (default 300 = 5min).
               TASKS_INTRADAY is the task list. Used to refresh
               `today_session_summary_mv` so the Overview chart's TODAY
               bar updates without re-aggregating millions of legs at
               page-load time.

Crash-safety: failure of any tick (Postgres unreachable, SQL syntax
error in a future task, etc.) is caught + logged; the loop continues.
"""
from __future__ import annotations

import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import psycopg2

from .config import load as load_settings


LOGGER = logging.getLogger("scheduler")


# ---- Task catalogues ----------------------------------------------
#
# Each tuple: (SQL expression, human-readable description for the log).
# All run in autocommit; the cursor's fetchone() result is logged when
# present so you can see e.g. "rows inserted: 432" in the output.

TASKS_DAILY: list[tuple[str, str]] = [
    (
        # Refresh yesterday's roll-up so the /summary page + Overview
        # chart's "past days" bars are current. Idempotent re-runs
        # capture any late-arriving rows.
        "SELECT refresh_daily_session_summary(CURRENT_DATE - 1, CURRENT_DATE - 1)",
        "refresh_daily_session_summary(yesterday)",
    ),
    (
        # Keep ≥ 2 weeks of weekly partitions ahead of the live
        # ussd_session_logs table — target-based, so calling daily
        # is a no-op once the runway is full and a one-partition
        # extension when the runway shrinks below target. Without
        # this, partitions run out and inserts land in DEFAULT.
        # See db/014 for the function definition + cutover notes.
        "SELECT ensure_session_log_partitions_weekly(2)",
        "ensure_session_log_partitions_weekly(2)",
    ),
    (
        # Retention — drops monthly/weekly/daily partitions whose
        # END date is older than 90 days. Fast metadata-only drops,
        # not a row-by-row DELETE. Idempotent: returns 0 when
        # nothing is past retention. Tune the 90 to your compliance
        # / disk budget — see db/014 for the function definition.
        "SELECT drop_old_session_log_partitions(90)",
        "drop_old_session_log_partitions(90)",
    ),
]

TASKS_INTRADAY: list[tuple[str, str]] = [
    (
        # Refresh today's MV so the Overview chart's "today" bar
        # tracks live traffic without scanning millions of legs at
        # page-load time. CONCURRENTLY keeps the page responsive
        # during the refresh.
        "SELECT refresh_today_session_summary_mv()",
        "refresh_today_session_summary_mv()",
    ),
]


# ---- Helpers ------------------------------------------------------

def _parse_hhmm(s: str) -> tuple[int, int]:
    h, m = s.split(":")
    return int(h), int(m)


def _next_daily(hh: int, mm: int, now: datetime) -> datetime:
    """Next UTC datetime at hh:mm — same day if still in the future,
    otherwise tomorrow."""
    target = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return target


def _run_tasks(tasks: list[tuple[str, str]]) -> None:
    s = load_settings()
    conn = psycopg2.connect(
        host=s.pg.host, port=s.pg.port, user=s.pg.user,
        password=s.pg.password, dbname=s.pg.db, sslmode=s.pg.sslmode,
        application_name="ussd_gateway_tz_scheduler",
        connect_timeout=10,
    )
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            for sql, desc in tasks:
                try:
                    cur.execute(sql)
                    try:
                        result = cur.fetchone()
                    except psycopg2.ProgrammingError:
                        # Not all statements return rows; treat as ok.
                        result = None
                    LOGGER.info("✓ %s%s", desc,
                                f" → {result}" if result is not None else " — ok")
                except Exception:
                    LOGGER.exception("✗ %s failed", desc)
    finally:
        conn.close()


# ---- Loop variants ------------------------------------------------

def _loop_daily() -> int:
    hh, mm = _parse_hhmm(os.environ.get("SCHEDULER_TIME", "02:00"))
    LOGGER.info("scheduler [daily] started — fire at %02d:%02d UTC", hh, mm)
    while True:
        now = datetime.now(timezone.utc)
        target = _next_daily(hh, mm, now)
        sleep_secs = (target - now).total_seconds()
        LOGGER.info("next fire at %s (sleeping %.0fs)",
                    target.strftime("%Y-%m-%d %H:%M UTC"), sleep_secs)
        try:
            time.sleep(sleep_secs)
        except KeyboardInterrupt:
            LOGGER.info("interrupted; exiting")
            return 0
        LOGGER.info("--- daily tick ---")
        try:
            _run_tasks(TASKS_DAILY)
        except Exception:
            LOGGER.exception("daily tick failed — will retry tomorrow")
        LOGGER.info("--- tick done ---")


def _loop_intraday() -> int:
    interval = int(os.environ.get("SCHEDULER_INTERVAL_SECS", "300"))
    LOGGER.info("scheduler [intraday] started — fire every %ds", interval)
    while True:
        LOGGER.info("intraday tick")
        try:
            _run_tasks(TASKS_INTRADAY)
        except Exception:
            LOGGER.exception("intraday tick failed — will retry next cycle")
        try:
            time.sleep(interval)
        except KeyboardInterrupt:
            LOGGER.info("interrupted; exiting")
            return 0


# ---- Entry point --------------------------------------------------

def main() -> int:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s: %(message)s",
    )
    mode = os.environ.get("SCHEDULER_MODE", "daily").lower()
    if mode == "intraday":
        return _loop_intraday()
    if mode == "daily":
        return _loop_daily()
    LOGGER.error("unknown SCHEDULER_MODE=%r (expected 'daily' or 'intraday')", mode)
    return 2


if __name__ == "__main__":
    sys.exit(main())
