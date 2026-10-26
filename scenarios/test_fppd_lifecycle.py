"""fppd's life as a process: what it reports about how long it has been up,
a scheduled command around a restart, its log file across a logrotate
rename, and how it exits."""

import datetime
import os
import stat
import time

import shims
from test_schedule_calendar import YEAR, ZONE, entry


def test_status_uptime_is_whole_days_hours_minutes_and_seconds(fppd):
    """/api/fppd/status gives fppd's uptime as whole days, hours, minutes and
    seconds that add up to uptimeTotalSeconds, the same in uptimeStr, and the
    system's own uptime next to it, as the kernel reports it.

    Regression: 17101a535. The days, hours and minutes were fractions of the
    total (3 s up read as 0.05 minutes, 0.0008 hours), the minutes were
    worked out from the seconds past the hour divided by 60, and the
    system's uptime was not reported at all."""
    fppd.start()
    fppd.wait_for(lambda: fppd.get("/fppd/status").get("uptimeTotalSeconds", 0) >= 3, timeout=15,
                  what="three seconds of uptime")
    s = fppd.get("/fppd/status")
    with open("/proc/uptime") as f:
        kernel = float(f.read().split()[0])
    parts = {k: s.get(k) for k in ("uptimeDays", "uptimeHours", "uptimeMinutes", "uptimeSeconds",
                                   "uptimeTotalSeconds")}
    assert all(isinstance(v, int) for v in parts.values()), f"not whole numbers: {parts}"
    d, h, m, sec, total = (parts[k] for k in ("uptimeDays", "uptimeHours", "uptimeMinutes",
                                               "uptimeSeconds", "uptimeTotalSeconds"))
    assert 0 <= h < 24 and 0 <= m < 60 and 0 <= sec < 60, parts
    assert d * 86400 + h * 3600 + m * 60 + sec == total, parts
    assert s.get("uptimeStr") == f"{d} days, {h} hours, {m} minutes, {sec} seconds", s.get("uptimeStr")
    system = s.get("systemUptimeTotalSeconds")
    assert isinstance(system, int), f"systemUptimeTotalSeconds: {system!r}"
    assert system >= total, f"the system has been up {system} s, fppd {total} s"
    assert abs(system - kernel) <= 5, f"systemUptimeTotalSeconds {system}, the kernel says {kernel:.0f}"


def test_a_command_scheduled_just_before_fppd_starts_is_not_run_again(fppd):
    """A command scheduled at 12:00:10 runs once, at 12:00:10, and an fppd
    started a few seconds later, at 12:00:14, does not run it again.

    Regression: 6f26fbe55 (its scheduler half). The scheduler fires any
    command whose second falls between its last check and now, so that a
    second it missed (a slow reload, a clock step) still runs; the last
    check started at the epoch, so every fppd started within the catch-up
    cap of a command ran it again -- a scheduled "Outputs Off" or restart a
    second time on every restart."""
    runs = os.path.join(fppd.media, "tmp", "runs")
    script = fppd.write("scripts/count.sh", f"#!/bin/sh\necho ran >> {runs}\n")
    os.chmod(script, os.stat(script).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    at = datetime.datetime(YEAR, 6, 10, 12, 0, 10)
    fppd.write("config/schedule.json", [entry(7, at.strftime("%H:%M:%S"), at.strftime("%H:%M:%S"),
                                              playlist="", command="Run Script",
                                              args=["count.sh", "", ""])])

    def count():
        try:
            with open(runs) as f:
                return len(f.read().split())
        except FileNotFoundError:
            return 0

    fppd.start(fake_time=f"{YEAR}-06-10 12:00:05", tz=ZONE)
    fppd.wait_for(lambda: count() == 1, timeout=20, interval=0.25,
                  what="the 12:00:10 command to run")
    rc = fppd.stop()
    assert rc == 0, f"fppd exited with {rc} on SIGTERM\n{fppd.tail()}"
    reports = fppd.sanitizer_reports()
    assert not reports, "sanitizer report:\n" + "\n".join(r[:8000] for r in reports)

    fppd.start(fake_time=f"{YEAR}-06-10 12:00:14", tz=ZONE)
    time.sleep(4)
    assert count() == 1, f"the 12:00:10 command ran {count()} times; the fppd started at 12:00:14 ran it again"


def test_the_log_stays_open_and_follows_a_logrotate_rename(fppd):
    """fppd writes its log through one open file, not an open per line, and
    once logrotate renames fppd.log away, the lines it writes a second later
    go to a fresh fppd.log and none to the renamed one.

    Regression: a7bbcb527. Every log line opened fppd.log, wrote and closed
    it: on a slow SD card that metadata traffic could stall whichever thread
    was logging -- the channel output thread among them -- and drop frames.
    life_logopens.so counts the opens."""
    opens = os.path.join(fppd.media, "tmp", "logopens")
    fppd.start(preload=[shims.build("life_logopens.c")], extra_env={"LIFE_LOGOPENS_LOG": opens})
    log = os.path.join(fppd.media, "logs", "fppd.log")

    def count():
        try:
            with open(opens) as f:
                return len(f.read().splitlines())
        except FileNotFoundError:
            return 0

    def unknown(name):
        try:
            fppd.command(name)
        except Exception:
            pass  # it answers with an error; the log line is what counts

    before = count()
    for i in range(40):
        unknown(f"No Such Command {i}")
    fppd.wait_for(lambda: "No Such Command 39" in open(log, errors="replace").read(), timeout=10,
                  what="the 40 lines in fppd.log")
    assert count() - before <= 1, \
        f"fppd.log was opened {count() - before} times for 40 log lines"

    rotated = log + ".1"
    os.rename(log, rotated)
    time.sleep(1.5)  # fppd looks at the name at most once a second
    unknown("After The Rename")
    fppd.wait_for(lambda: os.path.exists(log) and "After The Rename" in open(log, errors="replace").read(),
                  timeout=10, what="the line after the rename in a fresh fppd.log")
    with open(rotated, errors="replace") as f:
        assert "After The Rename" not in f.read(), "the line after the rename went to the renamed log"


def test_shutdown_skips_the_global_destructors(fppd):
    """fppd stopped with SIGTERM exits 0 without running the C++ global and
    static destructors, so one that would crash -- a file-static
    std::thread still joinable at exit, as the Events publish thread and the
    warnings thread could be left by a restart during the drawn-out
    shutdown -- never gets the chance.

    Regression: 2302ce6c0. On Linux main() returned, __cxa_finalize ran
    every destructor, and ~thread() on a joinable thread called
    std::terminate: the most common fppd crash on the crash dashboard. The
    thread here is life_staticthread.so's own file-static std::thread,
    started at load and never joined, so the destructor pass is the only
    thing that can reach it; fppd's own threads have since been made
    immune (leaked, not destroyed), so they no longer show it."""
    fppd.start(preload=[shims.build("life_staticthread.cpp", libs=("-ldl", "-lstdc++", "-lpthread"))], extra_env={"LIFE_STATIC_THREAD": "1"})
    time.sleep(1)
    rc = fppd.stop()
    fppd.exit_expected = True
    from fppd import describe_rc
    assert rc == 0, f"fppd exited with {describe_rc(rc)} on SIGTERM\n{fppd.tail()}"
    reports = fppd.sanitizer_reports()
    assert not reports, "sanitizer report:\n" + "\n".join(r[:8000] for r in reports)
    assert "terminate called" not in open(os.path.join(fppd.media, "logs", "fppd.stdout"),
                                          errors="replace").read()
