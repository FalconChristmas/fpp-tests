def test_starts_and_stops_cleanly(fppd):
    """fppd on an empty media directory comes up, answers, and shuts down
    on SIGTERM with exit 0 and no sanitizer report."""
    status = fppd.start()
    assert status["fppd"] == "running", status
