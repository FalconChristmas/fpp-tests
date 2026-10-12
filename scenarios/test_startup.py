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
