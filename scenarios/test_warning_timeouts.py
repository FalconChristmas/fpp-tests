"""Warnings that come down by themselves, and the warnings file fppd keeps
for the web UI (warnplugin.cpp raises them)."""

import json
import os
import time

from test_plugin_warnings import full, start

MSG = "fpp-tests timed warning"


def timed(fppd, seconds):
    fppd.command("Warning Test Add Timed", str(seconds), "9002", MSG)


def test_a_warning_with_a_timeout_comes_down_by_itself(fppd):
    """A warning raised with a timeout is listed, and gone once the timeout
    passes, with nothing removing it.

    Regression: 320a5f8f2. The expiry moved from a per-second counter checked
    on reads to a wake-up timer in the warnings thread, which prunes what has
    timed out."""
    start(fppd)
    timed(fppd, 3)
    fppd.wait_for(lambda: full(fppd, MSG), timeout=5, what="the timed warning")
    fppd.wait_for(lambda: not full(fppd, MSG), timeout=15, interval=0.25,
                  what="the timed warning to expire")


def test_raising_a_warning_again_moves_its_timeout_later_not_earlier(fppd):
    """Raised again with a later timeout, a warning outlives its first one;
    raised again with an earlier one, it keeps the later.

    Regression: 320a5f8f2. A repeat raise returned without touching the
    warning, so a warning a check re-raised every few seconds expired on its
    first timeout anyway and flickered."""
    start(fppd)
    timed(fppd, 4)
    fppd.wait_for(lambda: full(fppd, MSG), timeout=5, what="the timed warning")
    timed(fppd, 12)
    timed(fppd, 1)          # earlier than what it has: ignored
    time.sleep(7)           # past the first timeout (4 s) and the earlier one
    assert full(fppd, MSG), "the warning came down at its first timeout"
    fppd.wait_for(lambda: not full(fppd, MSG), timeout=15, interval=0.25,
                  what="the warning to expire at its extended timeout")


def test_the_warnings_file_follows_raises_and_removals(fppd):
    """www/warnings_full.json, which the web UI reads, lists a warning soon
    after it is raised and drops it soon after it is removed.

    Regression: f14de88e2. The warnings thread is woken for each change; a
    broken wake-up leaves the file as it was when fppd started."""
    start(fppd)
    path = os.path.join(fppd.tree, "www", "warnings_full.json")

    def listed():
        try:
            with open(path) as f:
                return any(w.get("message") == MSG for w in json.load(f))
        except (OSError, ValueError):
            return False

    fppd.command("Warning Test Add", "9002", MSG)
    fppd.wait_for(listed, timeout=10, interval=0.25, what="the warning in warnings_full.json")
    fppd.command("Warning Test Remove", "9002", MSG)
    fppd.wait_for(lambda: not listed(), timeout=10, interval=0.25,
                  what="the warning out of warnings_full.json")
