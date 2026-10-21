"""Per-operator idle-session limits.

One gateway-wide limit could not fit every network: Vodacom ends its own
sessions at 60s (and reports it as user_cancelled), while Tigo keeps them
open to ~120s. These pin how USSD_SESSION_IDLE_EXPIRY_SECS_<OPERATOR> is
read, how it falls back to the default, and the misconfigurations that
must refuse to start rather than silently switch expiry off.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import SessionExpiryConfig, load       # noqa: E402

_PREFIX = "USSD_SESSION_IDLE_EXPIRY_SECS"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for name in list(os.environ):
        if name.startswith(_PREFIX) or name == "USSD_SESSION_EXPIRY_NOTIFY_MAX_AGE_SECS":
            monkeypatch.delenv(name)


def test_unset_every_operator_uses_the_default():
    cfg = load().expiry
    assert cfg.idle_secs_by_operator == {}
    assert cfg.idle_secs_for("tigo") == cfg.idle_secs == 130


def test_per_operator_values_override_the_default(monkeypatch):
    monkeypatch.setenv(_PREFIX, "100")
    monkeypatch.setenv(_PREFIX + "_VODACOM", "75")
    monkeypatch.setenv(_PREFIX + "_TIGO", "130")
    cfg = load().expiry
    assert cfg.idle_secs_by_operator == {"vodacom": 75, "tigo": 130}
    assert cfg.idle_secs_for("vodacom") == 75
    assert cfg.idle_secs_for("tigo") == 130
    # No line of its own -> the default, not some other operator's value.
    assert cfg.idle_secs_for("airtel") == 100


def test_lookup_is_case_insensitive(monkeypatch):
    monkeypatch.setenv(_PREFIX + "_HALOTEL", "120")
    assert load().expiry.idle_secs_for("Halotel") == 120


def test_empty_value_means_use_the_default(monkeypatch):
    # The compose example passes every per-operator variable through as
    # ${VAR:-}, so an unset one arrives as "" -- it must not become 0.
    monkeypatch.setenv(_PREFIX + "_AIRTEL", "")
    cfg = load().expiry
    assert "airtel" not in cfg.idle_secs_by_operator
    assert cfg.idle_secs_for("airtel") == cfg.idle_secs


def test_non_integer_refuses_to_start(monkeypatch):
    monkeypatch.setenv(_PREFIX + "_TIGO", "2m")
    with pytest.raises(ValueError):
        load()


@pytest.mark.parametrize("bad", ["0", "-5"])
def test_non_positive_limit_refuses_to_start(monkeypatch, bad):
    # <= 0 would expire every live session on the first sweep.
    monkeypatch.setenv(_PREFIX + "_VODACOM", bad)
    with pytest.raises(ValueError, match="vodacom"):
        load()


def test_limit_at_or_above_the_backlog_guard_refuses_to_start(monkeypatch):
    # The claim skips rows older than notify_max_age_secs, so a limit at
    # or above it would never expire that operator's sessions at all.
    monkeypatch.setenv("USSD_SESSION_EXPIRY_NOTIFY_MAX_AGE_SECS", "600")
    monkeypatch.setenv(_PREFIX + "_TIGO", "600")
    with pytest.raises(ValueError, match="tigo"):
        load()


def test_default_is_validated_too():
    with pytest.raises(ValueError, match="default"):
        SessionExpiryConfig(enabled=True, idle_secs=0, notify_max_age_secs=3600,
                            sweep_interval_secs=5, batch=200)
