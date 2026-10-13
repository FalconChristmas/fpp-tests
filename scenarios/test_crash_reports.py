"""fppd's crash handler, entered without crashing: SIGUSR1 runs it (pruning
crashes/ and building a report) and fppd carries on. ShareCrashData 0 makes
the report a local one, never uploaded."""

import os
import signal
import time

import pytest

from fppd import sanitizer

# The crash handler is not async-signal-safe and can't be (it logs, lists
# crashes/ and runs scripts); tsan.supp says so for handleCrash, but here the
# allocations are inside libstdc++, whose frames don't reach handleCrash, so
# TSan reports every one. These scenarios are about what the handler does,
# not about races.
pytestmark = pytest.mark.skipif(sanitizer() == "tsan",
                                reason="the crash handler is signal-unsafe by design")

DAY = 86400


def seed_reports(fppd, newest_age=300):
    """Twelve reports where name order and age disagree, as after an
    upgrade: the 10.x names sort before the 9.x ones but are newer."""
    crashes = os.path.join(fppd.media, "crashes")
    os.makedirs(crashes, exist_ok=True)
    now = time.time()
    reports = {}
    for i in range(6):
        old = f"fpp-Linux-9.5-uuid-2025010{i}-000000.zip"
        new = f"fpp-Linux-10.2-uuid-2026090{i}-000000.zip"
        reports[old] = now - newest_age - (12 - i) * DAY   # oldest six
        reports[new] = now - newest_age - (6 - i) * DAY    # newest six
    for name, t in reports.items():
        path = os.path.join(crashes, name)
        with open(path, "wb") as f:
            f.write(b"PK\x05\x06" + bytes(18))  # an empty zip
        os.utime(path, (t, t))
    return crashes, reports


def run_crash_handler(fppd, done, what):
    """Start fppd, send it SIGUSR1, and wait until `done()`; fppd must still
    be running and answering afterwards."""
    fppd.settings(ShareCrashData="0")
    fppd.start()
    fppd.proc.send_signal(signal.SIGUSR1)
    fppd.wait_for(done, timeout=90, interval=0.5, what=what)
    time.sleep(2)
    fppd.check_alive()
    fppd.get("/fppd/status", timeout=10)


def test_crash_handler_prunes_the_oldest_reports_by_time(fppd):
    """With more than ten reports in crashes/, the crash handler deletes the
    oldest by time, even when the newest sort first by name.

    Regression: cce0e6327. Reports were pruned by name, and names start with
    the FPP version, so after an upgrade the newest ("10.x" sorts before
    "9.x") were the ones deleted.
    """
    crashes, reports = seed_reports(fppd)
    # Pruning happens before the report is built, so wait for it alone.
    run_crash_handler(fppd, lambda: len(set(os.listdir(crashes)) & set(reports)) <= 10,
                      "the crash handler to prune crashes/")
    left = set(os.listdir(crashes))
    by_age = sorted(reports, key=reports.get)
    oldest_two, kept = by_age[:2], by_age[2:]
    assert not (left & set(oldest_two)), f"the oldest were kept: {sorted(left & set(oldest_two))}"
    missing = [n for n in kept if n not in left]
    assert not missing, f"newer reports were deleted: {missing}"


def test_crash_report_is_written_in_this_media_folder(fppd):
    """The crash report lands in crashes/ under fppd's own media folder, here
    a test directory rather than /home/fpp/media.

    Regression: 462d7b884. generate_crash_report changed directory to a
    hard-coded /home/fpp/media (or /opt/fpp) and gave up when neither
    existed, so outside a standard device it wrote no report at all.
    """
    crashes = os.path.join(fppd.media, "crashes")
    os.makedirs(crashes, exist_ok=True)
    run_crash_handler(fppd, lambda: any(n.endswith(".zip") for n in os.listdir(crashes)),
                      "the crash handler to write a report")
    zips = [n for n in os.listdir(crashes) if n.endswith(".zip")]
    assert zips, f"no report in {crashes}: {os.listdir(crashes)}"
    assert os.path.getsize(os.path.join(crashes, zips[0])) > 1000, "the report is empty"
