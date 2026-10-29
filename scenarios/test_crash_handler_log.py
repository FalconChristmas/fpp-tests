"""What fppd's crash handler logs about a crash -- which signal, on which
thread, and the gdb stack, given a gdb that is slow to produce it -- and
what generate_crash_report adds when the user shares statistics."""

import os
import re
import signal
import subprocess

import pytest

from fppd import describe_rc, sanitizer
from test_crash_report_privacy import build_report, built, file_named

# As in test_crash_reports.py: the handler is signal-unsafe by design.
not_under_tsan = pytest.mark.skipif(sanitizer() == "tsan",
                                    reason="the crash handler is signal-unsafe by design")


def crash(fppd, extra_env=None, timeout=180):
    """Start fppd, send it SIGABRT and wait for the crash handler's _exit(-1)."""
    os.makedirs(os.path.join(fppd.media, "crashes"), exist_ok=True)
    fppd.settings(ShareCrashData="0")
    fppd.start(extra_env=extra_env)
    fppd.proc.send_signal(signal.SIGABRT)
    try:
        rc = fppd.proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        raise TimeoutError(f"the crash handler did not finish within {timeout}s\n{fppd.tail()}")
    fppd.exit_expected = True
    assert rc == 255, f"fppd exited with {describe_rc(rc)}, not the crash handler's _exit(-1)\n{fppd.tail()}"


@not_under_tsan
def test_crash_log_names_the_signal_and_the_thread(fppd):
    """The crash handler's first log line gives the thread id, the signal
    number and its name and description: "signal=6 (SIGABRT: Aborted)".

    Regression: 5ac878d97. It logged "Crash handler called:  6": no name
    for the signal, and no thread, in a log where every other thread keeps
    writing."""
    crash(fppd)
    m = re.search(r"Crash handler called in thread (\d+):  signal=6 \(SIGABRT: Aborted\)", fppd.log())
    assert m, "\n".join(l for l in fppd.log().splitlines() if "Crash handler" in l) or fppd.tail()


@not_under_tsan
def test_a_gdb_slower_than_twenty_seconds_still_gives_the_stack(fppd, tmp_path):
    """A gdb that takes 25 s to print its stack (a stand-in that sleeps, then
    prints, with no child process for the first watchdog to kill) is waited
    for: its stack is in the log.

    Regression: 5ac878d97. The watchdogs gave gdb 10 s and then 20 s, and
    killed it: on a loaded Pi or a BeagleBone a real gdb takes longer than
    that to load fppd's symbols, so the crash log had no stack at all."""
    stub = tmp_path / "bin"
    stub.mkdir()
    (stub / "gdb").write_text("#!/usr/bin/python3\nimport time\ntime.sleep(25)\n"
                              "print('#0  fpp-tests-slow-gdb-stack-marker')\n")
    (stub / "gdb").chmod(0o755)
    crash(fppd, extra_env={"PATH": f"{stub}:{os.environ['PATH']}"}, timeout=240)
    assert "fpp-tests-slow-gdb-stack-marker" in fppd.log(), \
        "the slow gdb's stack is not in the log:\n" + "\n".join(
            l for l in fppd.log().splitlines() if "gdb" in l.lower() or "Stack" in l)


def test_a_settings_level_report_carries_the_stats_when_they_are_shared(fppd):
    """A level-2 report from a box that publishes statistics (statsPublish
    Enabled) carries the cached statistics payload, /tmp/fpp_stats.json.

    Regression: 4e63af299. The report never included it, though it says
    which plugins and outputs the crashed box runs."""
    stats = "/tmp/fpp_stats.json"
    if os.path.exists(stats):
        pytest.skip(f"{stats} already exists here; not overwriting it")
    fppd.settings(statsPublish="Enabled")
    with open(stats, "w") as f:
        f.write('{"uuid": "fpp-tests-stats", "plugins": ["fpp-tests-plugin"]}\n')
    try:
        r, texts = build_report(fppd, 2)
    finally:
        os.unlink(stats)
    built(r, texts)
    assert file_named(texts, "settings") is not None, \
        f"not a level-2 report, so this proves nothing: {sorted(texts)}"
    payload = file_named(texts, "fpp_stats.json")
    assert payload and "fpp-tests-plugin" in payload, f"no statistics in the report: {sorted(texts)}"
