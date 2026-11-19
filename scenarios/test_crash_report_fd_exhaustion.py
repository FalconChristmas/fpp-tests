"""A crash report from an fppd that has run out of file descriptors."""

import os
import resource
import signal
import subprocess

import pytest

from fppd import describe_rc, sanitizer
from test_crash_reports import report_texts

pytestmark = pytest.mark.skipif(sanitizer() == "tsan",
                                reason="the crash handler is signal-unsafe by design")


def test_crash_report_keeps_its_stack_when_fppd_is_out_of_file_descriptors(fppd):
    """With no file descriptor left, a crash still produces a report with
    fppd_crash.log and fppd_crash_context.log in it.

    The soft RLIMIT_NOFILE is set below the number of descriptors fppd holds,
    so every open() fails with EMFILE until something raises the limit again,
    as on a player that has leaked descriptors up to its limit.

    Regression: 5b20c5799. The handler's open() of each /tmp file (and gdb's)
    failed silently, so the report carried no stack, no registers and no
    module map. That happened on players leaking descriptors through repeated
    video playback, where kmssink's own EMFILE assert was the crash.
    """
    os.makedirs(os.path.join(fppd.media, "crashes"), exist_ok=True)
    fppd.settings(ShareCrashData="0")
    fppd.start()
    pid = fppd.proc.pid
    held = len(os.listdir(f"/proc/{pid}/fd"))
    _, hard = resource.prlimit(pid, resource.RLIMIT_NOFILE)
    if hard != resource.RLIM_INFINITY and hard < held + 64:
        pytest.skip(f"hard limit {hard} leaves the handler no room above the {held} descriptors fppd holds")
    resource.prlimit(pid, resource.RLIMIT_NOFILE, (held - 8, hard))
    fppd.proc.send_signal(signal.SIGABRT)
    try:
        rc = fppd.proc.wait(timeout=180)
    except subprocess.TimeoutExpired:
        raise TimeoutError(f"the crash handler did not finish within 180s\n{fppd.tail()}")
    fppd.exit_expected = True
    assert rc == 255, f"fppd exited with {describe_rc(rc)}, not the crash handler's _exit(-1)\n{fppd.tail()}"

    texts = report_texts(fppd, os.path.join(fppd.media, "crashes"))
    names = sorted(texts)
    assert any(n.endswith("logs/fppd.log") for n in names), f"no full report, so this proves nothing: {names}"
    stack = next((t for n, t in texts.items() if n.endswith("fppd_crash.log")), None)
    context = next((t for n, t in texts.items() if n.endswith("fppd_crash_context.log")), None)
    assert stack, f"no stack (fppd_crash.log) in the report: {names}"
    assert context and "=== module map" in context, f"no crash context in the report: {names}"
