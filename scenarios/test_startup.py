import os
import re


def only_thread_leaks(report):
    """A TSan log whose every warning is a thread leak."""
    kinds = re.findall(r"WARNING: ThreadSanitizer: (.+?) \(", report)
    return bool(kinds) and all(k == "thread leak" for k in kinds)


def test_starts_and_stops_cleanly(fppd):
    """fppd on an empty media directory comes up, answers, and shuts down
    on SIGTERM with exit 0 and no sanitizer report."""
    status = fppd.start()
    assert status["fppd"] == "running", status


def test_failed_startup_exits_cleanly(fppd):
    """An fppd that gives up during startup leaves through exit(), which runs
    every static destructor. Holding the MultiSync port makes it do that.

    Regression: 04a6037fb. exit() ran the static destructors while the
    warnings notify thread was reading WarningHolder's map, and freed it
    under the thread. Behind that, a71ee18c4: ~PluginManager's cleanup read
    the media-directory string after it had been destroyed. fppd now leaves
    through _exit(), so only the first is reachable from here.
    """
    import socket

    from fppd import FppdDied

    held = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    held.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    held.bind(("0.0.0.0", 32320))
    try:
        try:
            fppd.start(timeout=30)
        except FppdDied:
            pass
        else:
            raise AssertionError("fppd started although the MultiSync port was taken")
        fppd.exit_expected = True
        assert fppd.proc.returncode == 1, fppd.tail()
        reports = fppd.sanitizer_reports()
        assert not reports, "sanitizer report:\n" + "\n".join(r[:8000] for r in reports)
    finally:
        held.close()


def test_failed_startup_after_media_init_exits(fppd):
    """A startup failure after InitMediaOutput() has started the volume worker
    still ends fppd. A directory where the command socket goes makes its bind
    fail, which is after media init and before the HTTP server. slowbind.so
    holds that bind back 1.5 s, as a device's slower startup does, so the
    worker has applied the volume and is waiting by then.

    Regression: 5503f89ff. That failure left through exit(), whose static
    destructors destroyed the condition variable the volume worker
    (cbf88ae78) was waiting on. glibc's pthread_cond_destroy() waits for its
    waiters, so fppd hung and never exited -- under systemd it was never
    restarted either. (Under ASan the same teardown first read a freed
    settings-listener map; in an optimized build it hangs.)
    """
    import shutil

    import shims
    from fppd import FppdDied

    server = "/run/fppd/FPPD"
    fppd.settings(volume=50)
    if os.path.lexists(server) and not os.path.isdir(server):
        os.unlink(server)
    os.makedirs(os.path.join(server, "in-the-way"), exist_ok=True)
    try:
        try:
            fppd.start(timeout=30, preload=[shims.build("slowbind.c")])
        except FppdDied:
            pass
        else:
            raise AssertionError("fppd started although its command socket could not bind")
        fppd.exit_expected = True
        assert fppd.proc.returncode == 1, fppd.tail()
        # It leaves through _exit() with no teardown, on purpose, so a worker
        # that has finished but was never joined (the video input reload
        # worker) is reported as a thread leak. That is the exit this scenario
        # asks for, not a defect; a race still fails it.
        reports = [r for r in fppd.sanitizer_reports() if not only_thread_leaks(r)]
        assert not reports, "sanitizer report:\n" + "\n".join(r[:8000] for r in reports)
    finally:
        shutil.rmtree(server, ignore_errors=True)
