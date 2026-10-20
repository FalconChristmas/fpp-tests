"""setSetting in scripts/common, which the shell scripts use to write the
settings file, under the lock PHP and fppd take on it."""

import fcntl
import os
import subprocess
import threading
import time


def common(fppd, script, timeout=30):
    """Run bash with scripts/common sourced from the tree under test, pointed
    at this scenario's media directory (fppd.start() wrote media_root.txt)."""
    env = dict(os.environ, FPPDIR=fppd.tree)
    return subprocess.run(["bash", "-c", '. "$FPPDIR/scripts/common"; ' + script],
                          env=env, capture_output=True, text=True, timeout=timeout)


def hold_lock(path, kind, seconds):
    """Hold a lock on path in a thread, as a PHP page or fppd reading it does."""
    ready = threading.Event()

    def run():
        with open(path) as f:
            fcntl.flock(f, kind)
            ready.set()
            time.sleep(seconds)
            fcntl.flock(f, fcntl.LOCK_UN)
    t = threading.Thread(target=run, daemon=True)
    t.start()
    ready.wait(5)
    return t


def test_set_setting_waits_for_a_reader_instead_of_failing(fppd):
    """With a reader holding a shared lock on the settings file, setSetting
    waits for it to go and then writes the value.

    Regression: efb6fcf92. setSetting asked for an exclusive lock with
    flock -n and gave up at once when anything held any lock -- every page
    load and every fppd read takes a shared one -- so it silently wrote
    nothing. (getSetting's half of the fix is
    test_settings_fixes.py::test_get_setting_waits_out_a_shared_lock.)"""
    fppd.settings(FppTestsKey="fpp-tests-value")
    fppd.start()
    path = os.path.join(fppd.media, "settings")

    t = hold_lock(path, fcntl.LOCK_SH, 2)
    began = time.monotonic()
    done = common(fppd, "setSetting FppTestsKey fpp-tests-written")
    t.join()
    with open(path) as f:
        text = f.read()
    assert 'FppTestsKey = "fpp-tests-written"' in text, f"setSetting under a reader's lock wrote nothing: {done.stderr!r}"
    # It waited for the reader rather than writing under its lock.
    assert time.monotonic() - began >= 1.5
