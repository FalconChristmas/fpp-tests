"""A SIGBUS on a thread other than fppd's main one, as a video consumer thread
gets when a DRM buffer goes away: fppd loses that thread and keeps the show
running. tools/sigbusplugin.cpp raises it."""

import os
import signal
import time

import pytest

import throw_plugin
from fppd import sanitizer

# The sanitizers' own SIGBUS handling, and TSan's deferred signals, are not what
# a player runs.
pytestmark = pytest.mark.skipif(sanitizer() == "tsan", reason="TSan defers the signal; see above")


def test_a_sigbus_on_another_thread_ends_only_that_thread(fppd):
    """fppd answers the request whose thread died, is still running and serving
    its API, and warns that the video thread crashed."""
    throw_plugin.install(fppd, source="sigbusplugin.cpp", name="fpp-sigbus")
    fppd.start()
    assert fppd.get("/sigbus/thread", timeout=60) == "survived"
    fppd.check_alive()
    assert fppd.get("/fppd/status").get("status_name") == "idle"
    fppd.wait_for(lambda: any("Video thread crashed (SIGBUS)" in w for w in fppd.get("/fppd/warnings")),
                  timeout=10, what=f"the warning; have {fppd.get('/fppd/warnings')}")
    assert "terminating thread only" in fppd.log()


def test_a_second_sigbus_on_another_thread_ends_only_that_thread_too(fppd):
    """After one thread has been ended by a SIGBUS, a SIGBUS on another thread
    is handled the same way: that thread ends, fppd keeps running, and the
    handler logs it.

    Regression: 49f2b29a0. After ending the first thread the handler put back SIG_DFL
    for SIGBUS, meaning for this thread, but sigaction() is process-wide: the
    second SIGBUS killed fppd outright, with no crash handler line and no
    report."""
    throw_plugin.install(fppd, source="sigbusplugin.cpp", name="fpp-sigbus")
    fppd.start()
    assert fppd.get("/sigbus/thread", timeout=60) == "survived"
    assert fppd.get("/sigbus/thread", timeout=60) == "survived"
    fppd.check_alive()
    assert fppd.get("/fppd/status").get("status_name") == "idle"
    assert fppd.log().count("terminating thread only") == 2


def test_a_fault_in_the_ending_threads_cleanup_ends_fppd_instead_of_looping(fppd):
    """A real SIGBUS (a read of a mapping whose file was truncated) on another
    thread, and a second one from that thread's own exit cleanup (a
    thread-specific data destructor) while the crash handler is ending it: the second takes the default action -- fppd
    ends promptly, killed by SIGBUS -- rather than running the crash handler
    again for the thread already leaving, looping or hanging.

    A safety check on 49f2b29a0, which leaves SIGBUS installed for every
    thread (it used to put back SIG_DFL, for the whole process, before ending
    the thread): SIGBUS is still blocked on the ending thread, so a fault there
    can't reach the handler."""
    marker = os.path.join(fppd.media, "tmp", "refaulted")
    os.makedirs(os.path.dirname(marker), exist_ok=True)
    throw_plugin.install(fppd, source="sigbusplugin.cpp", name="fpp-sigbus")
    fppd.start()
    fppd.exit_expected = True
    try:
        fppd.get(f"/sigbus/refault?marker={marker}", timeout=60)
    except Exception:
        pass  # fppd is gone before it answers
    # Not fppd.wait_for(): that raises FppdDied, which is what this waits for.
    deadline = time.monotonic() + 30
    while fppd.proc.poll() is None and time.monotonic() < deadline:
        time.sleep(0.2)
    assert fppd.proc.poll() is not None, "fppd still running 30s after the second SIGBUS"
    assert os.path.exists(marker), "the exit cleanup never ran"
    assert fppd.proc.returncode == -signal.SIGBUS, f"fppd exited {fppd.proc.returncode}\n{fppd.tail()}"
    assert fppd.log().count("terminating thread only") == 1, fppd.tail()
