"""fppd's two watchdogs: the one over its main loop, which restarts a fppd
whose loop has stopped, and the crash handler's, which kills a fppd whose
crash handling has wedged. Each is shown against a wedge that would last
for ever without it."""

import ctypes
import os
import platform
import re
import signal
import subprocess
import time

import pytest

import shims
from fppd import describe_rc, sanitizer
from test_playlist_entries import pause, playlist, status

STALL_RESUME = "/run/fppd/stall_resume"


def tgkill(pid, tid, sig):
    nr = {"x86_64": 234, "aarch64": 131}[platform.machine()]
    libc = ctypes.CDLL(None, use_errno=True)
    assert libc.syscall(nr, pid, tid, sig) == 0, os.strerror(ctypes.get_errno())


def test_a_stalled_main_loop_is_restarted_and_the_show_resumes(fppd):
    """With the main loop stuck (life_mainstall.so holds its epoll_wait()),
    the API still answers and says the loop is stalled, fppd logs every
    thread's state and exits once MainLoopStallRestartTimeout has passed,
    and the fppd started after it (systemd's Restart=always) picks the
    playlist back up.

    Regression: 313224740. Nothing watched the main loop: the API kept
    answering "playing" while sync packets, the command socket (so "Restart
    FPPD" too) and media went unserviced, and only a power cycle got the
    box back."""
    os.makedirs(os.path.dirname(STALL_RESUME), exist_ok=True)
    if os.path.exists(STALL_RESUME):
        os.remove(STALL_RESUME)
    stall = os.path.join(fppd.media, "tmp", "stall")
    fppd.write("playlists/Show.json", playlist("Show", main=[pause(300)]))
    fppd.settings(MainLoopStallTimeout="2", MainLoopStallRestartTimeout="8")
    try:
        fppd.start(preload=[shims.build("life_mainstall.c")], extra_env={"LIFE_STALL_FILE": stall})
        fppd.command("Start Playlist", "Show", "false", "false")
        fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", timeout=10,
                      what="the playlist to start")
        time.sleep(1)  # a pass of the loop sees it playing
        open(stall, "w").close()
        fppd.wait_for(lambda: os.path.exists(stall + ".held"), timeout=10,
                      what="the main loop to stall")
        fppd.wait_for(lambda: any("main loop is stalled" in w
                                  for w in fppd.get("/fppd/status", timeout=5).get("warnings", [])),
                      timeout=10, interval=0.5, what="the API to say the main loop is stalled")
        try:
            rc = fppd.proc.wait(timeout=90)
        except subprocess.TimeoutExpired:
            raise AssertionError(f"fppd still running 90 s into a main-loop stall\n{fppd.tail()}")
        fppd.exit_expected = True
        assert rc == 1, f"fppd exited with {describe_rc(rc)}, not the watchdog's exit(1)\n{fppd.tail()}"
        reports = fppd.sanitizer_reports()
        assert not reports, "sanitizer report:\n" + "\n".join(r[:8000] for r in reports)
        log = fppd.log()
        assert "Main loop watchdog: no main loop iteration" in log, fppd.tail()
        assert "exiting so a clean fppd is started" in log, fppd.tail()
        # Every thread's state, the stalled main thread's among them.
        assert "thread states" in log and re.search(rf"\btid {fppd.proc.pid}\s", log), fppd.tail()

        os.remove(stall)
        fppd.exit_expected = False
        fppd.start()
        fppd.wait_for(lambda: status(fppd).get("current_playlist", {}).get("playlist") == "Show"
                      and status(fppd).get("status_name") == "playing",
                      timeout=20, interval=0.5, what="the new fppd to resume the playlist")
        assert "killed by the main-loop watchdog" in fppd.log()
    finally:
        if os.path.exists(STALL_RESUME):
            os.remove(STALL_RESUME)


# The crash handler is not async-signal-safe, by design: test_crash_reports.py.
@pytest.mark.skipif(sanitizer() == "tsan", reason="the crash handler is signal-unsafe by design")
def test_a_crash_handler_wedged_on_the_log_still_exits(fppd):
    """fppd takes a fatal signal while another of its threads is stuck inside
    a write to fppd.log (life_logstall.so: storage that stopped answering),
    holding the log's locks. The crash handler needs them -- to log, and to
    flush every stream before it exits -- and waits; its watchdog kills the
    process two minutes in, so systemd can start a fresh one.

    Regression: 60c1e7ac4. Nothing bounded the crash handler: fppd hung in
    it for ever, systemd saw it running, and Restart=always never fired.
    The main-loop watchdog is turned off, so it can't end the wedge
    instead."""
    stall = os.path.join(fppd.media, "tmp", "logstall")
    fppd.settings(MainLoopStallTimeout="0")
    fppd.start(preload=[shims.build("life_logstall.c")], extra_env={"LIFE_LOGSTALL_FILE": stall})
    open(stall, "w").close()
    try:
        fppd.command("No Such Command", timeout=3)  # logged on an HTTP thread, which wedges
    except Exception:
        pass
    fppd.wait_for(lambda: os.path.exists(stall + ".held"), timeout=10,
                  what="a thread to wedge in a log write")
    started = time.monotonic()
    tgkill(fppd.proc.pid, fppd.proc.pid, signal.SIGABRT)
    try:
        rc = fppd.proc.wait(timeout=170)
    except subprocess.TimeoutExpired:
        raise AssertionError(f"the crash handler was still running 170 s after the signal\n{fppd.tail()}")
    took = time.monotonic() - started
    fppd.exit_expected = True
    assert rc == -signal.SIGALRM, \
        f"fppd exited with {describe_rc(rc)} after {took:.0f} s, not by the crash handler's watchdog\n{fppd.tail()}"
    assert 100 <= took <= 150, f"the crash handler's watchdog fired {took:.0f} s in"
