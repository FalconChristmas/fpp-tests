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


import pytest


@pytest.mark.parametrize("sig", ["SIGINT", "SIGTERM"])
def test_a_stop_signal_is_handled_without_allocating(fppd, sig):
    """SIGINT and SIGTERM stop fppd through a handler that only clears the
    main loop's flag: fppd exits 0, and ThreadSanitizer (the tsan flavor)
    sees no signal-unsafe call in a signal handler.

    Regression: 5b9e29f57. drogon's handlers ran for both signals; they log
    the signal, which allocates, and then ran fppd's callback, all inside
    the handler, so a signal landing while a thread was in malloc could
    deadlock the shutdown.
    """
    import signal as signals
    from fppd import describe_rc
    fppd.start()
    time.sleep(1)
    fppd.proc.send_signal(getattr(signals, sig))
    rc = fppd.proc.wait(timeout=60)
    fppd.exit_expected = True
    assert rc == 0, f"fppd exited with {describe_rc(rc)} on {sig}\n{fppd.tail()}"
    reports = fppd.sanitizer_reports()
    assert not reports, "sanitizer report:\n" + "\n".join(r[:8000] for r in reports)


# Runs argv[2:] with a pseudo-terminal as its stdout and stderr, copies what
# it writes there to argv[1], passes SIGTERM/SIGINT on, and exits as it did.
ON_A_TERMINAL = r"""
import os, pty, signal, sys
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[2], sys.argv[2:])
for s in (signal.SIGTERM, signal.SIGINT):
    signal.signal(s, lambda n, f: os.kill(pid, n))
with open(sys.argv[1], "wb", buffering=0) as out:
    while True:
        try:
            data = os.read(fd, 65536)
        except InterruptedError:
            continue
        except OSError:
            break
        if not data:
            break
        out.write(data)
while True:
    try:
        _, status = os.waitpid(pid, 0)
        break
    except InterruptedError:
        continue
sys.exit(os.waitstatus_to_exitcode(status) & 0xff)
"""


def unknown_command(fppd, name):
    try:
        fppd.command(name)
    except Exception:
        pass  # it answers with an error; the log line is what counts


def test_fppd_f_on_a_terminal_echoes_its_log_lines(fppd):
    """fppd -f run from a terminal echoes every log line to it as well as
    writing fppd.log.

    Regression: 2beec3674. The copy to stdout of a line already written to
    the log file was dropped (so journald, reading a systemd fppd's stdout,
    wouldn't get every line twice), and that took the echo away from a
    person running fppd -f in a terminal too.
    """
    tty = os.path.join(fppd.media, "logs", "fppd.tty")
    fppd.start(argv=["python3", "-c", ON_A_TERMINAL, tty, os.path.join(fppd.tree, "src", "fppd"), "-f"])
    unknown_command(fppd, "No Such Command On A Terminal")
    log = os.path.join(fppd.media, "logs", "fppd.log")
    fppd.wait_for(lambda: "No Such Command On A Terminal" in open(log, errors="replace").read(),
                  timeout=10, what="the line in fppd.log")
    fppd.wait_for(lambda: "No Such Command On A Terminal" in open(tty, errors="replace").read(),
                  timeout=5, what="the line echoed to the terminal")


def test_fppd_f_into_a_pipe_writes_its_log_lines_once(fppd):
    """fppd -f with stdout a pipe or a file (as under systemd, where journald
    reads it) leaves the lines it writes to fppd.log off stdout, so the
    journal doesn't hold every line twice.

    Kept by 2beec3674, which brought the echo back only for a terminal.
    """
    fppd.start()
    unknown_command(fppd, "No Such Command Into A Pipe")
    log = os.path.join(fppd.media, "logs", "fppd.log")
    fppd.wait_for(lambda: "No Such Command Into A Pipe" in open(log, errors="replace").read(),
                  timeout=10, what="the line in fppd.log")
    time.sleep(0.5)
    with open(os.path.join(fppd.media, "logs", "fppd.stdout"), errors="replace") as f:
        assert "No Such Command Into A Pipe" not in f.read(), "a line in fppd.log was copied to stdout too"


def test_media_stopped_just_before_shutdown_keeps_its_files_until_exit(fppd, audio):
    """A 6-channel file playing to a pipewiresink of its own, stopped, and
    fppd stopped straight after, while the track's pipeline is still being
    torn down on its own thread: fppd exits 0 and nothing on the way out
    finds a file descriptor closed under it.

    Regression: 320a29525. At the end of shutdown fppd closed every
    descriptor from 3 up in its own process, for the restart's exec not to
    inherit them, while that teardown and the PipeWire threads it shares
    were still running: GStreamer couldn't wake its polls ("Bad file
    descriptor"), GLib found its fds already closed, and PipeWire's
    blocking invoke lost the eventfd it waits on, so a stream was freed
    while its converter still ran (TSan: free_tmp against the resampler).
    The descriptors are now marked close-on-exec instead, which the exec and
    _exit() close for it."""
    from test_remote_media import write_six_channel_wav
    write_six_channel_wav(os.path.join(fppd.media, "music", "Six.wav"), 10, 10)
    fppd.start()
    fppd.command("Play Media", "Six.wav", "1", "0", "1")
    fppd.wait_for(lambda: fppd.get("/fppd/status").get("current_song") == "Six.wav", timeout=10,
                  what="the file to play")
    time.sleep(1)
    fppd.command("Stop Media Slot", "1", timeout=10)
    rc = fppd.stop()
    fppd.exit_expected = True
    from fppd import describe_rc
    out = open(os.path.join(fppd.media, "logs", "fppd.stdout"), errors="replace").read()
    bad = [line for line in out.splitlines() if "Bad file descriptor" in line or "EBADF" in line]
    assert not bad, f"{len(bad)} lines like: {bad[0]}"
    assert rc == 0, f"fppd exited with {describe_rc(rc)} on SIGTERM\n{fppd.tail()}"
    reports = fppd.sanitizer_reports()
    assert not reports, "sanitizer report:\n" + "\n".join(r[:8000] for r in reports)
