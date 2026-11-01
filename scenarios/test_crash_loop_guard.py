"""What fppd's crash handler and its systemd unit do when it keeps crashing:
a crash straight after another writes and uploads nothing, and systemd
stops restarting fppd after a burst of failures."""

import os
import time

import pytest

from fppd import sanitizer
from test_crash_reports import run_crash_handler

pytestmark = pytest.mark.skipif(sanitizer() == "tsan",
                                reason="the crash handler is signal-unsafe by design")


def reports(crashes):
    return sorted(n for n in os.listdir(crashes) if n.endswith(".zip"))


def test_a_crash_straight_after_another_writes_no_second_report(fppd):
    """A report younger than a minute is a crash loop: the handler logs that
    and builds and uploads nothing.

    Regression: 0002947de. Every restart of a crashing fppd built a report
    and sent it, one after another."""
    crashes = os.path.join(fppd.media, "crashes")
    os.makedirs(crashes)
    recent = os.path.join(crashes, "fpp-Linux-10.2-uuid-20260901-000000.zip")
    with open(recent, "wb") as f:
        f.write(b"PK\x05\x06" + bytes(18))
    run_crash_handler(fppd)
    assert reports(crashes) == [os.path.basename(recent)], reports(crashes)
    assert "Very recent crash report found" in fppd.log(), fppd.tail()

    # With the last report older than a minute the next crash does report.
    old = time.time() - 300
    os.utime(recent, (old, old))
    fppd.exit_expected = False
    run_crash_handler(fppd)
    assert len(reports(crashes)) == 2, reports(crashes)


def test_systemd_stops_restarting_a_crash_looping_fppd():
    """The fppd unit restarts always, so it also sets a start limit: a few
    failures in a short window and systemd gives up instead of crashing for
    ever.

    Regression: 0002947de (five starts in 60 seconds)."""
    tree = os.environ.get("FPP_TREE", "")
    path = os.path.join(tree, "etc/systemd/fppd.service")
    if not tree or not os.path.exists(path):
        pytest.skip("the FPP tree is not known here")
    unit = {}
    with open(path) as f:
        for line in f:
            if "=" in line and not line.startswith("#"):
                k, v = line.strip().split("=", 1)
                unit[k] = v
    assert unit.get("Restart") == "always", unit.get("Restart")
    assert int(unit["StartLimitBurst"]) <= 5, unit.get("StartLimitBurst")
    assert 0 < int(unit["StartLimitIntervalSec"]) <= 300, unit.get("StartLimitIntervalSec")
