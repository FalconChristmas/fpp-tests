"""POST /internal/crashReport (behind POST /api/crashes/report, the
Diagnostic Report) sends nothing until its build is done, and on a Pi Zero
or BeagleBone the build takes minutes."""

import http.client
import os
import time
import urllib.error

# Past drogon's default 60 s idle-connection timeout, and well inside the
# report's 240 s script limit
BUILD_SECONDS = 75


def test_a_report_that_builds_for_over_a_minute_is_still_answered(fppd, tmp_path):
    """A build that runs longer than a minute must still get its answer.

    Regression: fpp 7fd3e93ec (issue #3178), which sets drogon's
    idle-connection timeout to 300 s in src/httpAPI.cpp.
    Drogon closes a connection after 60 s with no reads or writes, and a
    request waiting for its answer counts as idle, so the finished report's
    answer was dropped and the client got an empty reply. PHP turned that
    into "fppd is running but did not respond" on every slow board, which
    the 240 s script limit and PHP's 270 s wait were sized for.

    A stub journalctl (the boot journal is read once, unbounded, at level 3)
    holds the build for BUILD_SECONDS."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    (bindir / "journalctl").write_text(f"#!/bin/sh\nsleep {BUILD_SECONDS}\nexit 0\n")
    (bindir / "journalctl").chmod(0o755)
    fppd.start(extra_env={"PATH": f"{bindir}:{os.environ['PATH']}"})

    started = time.monotonic()
    try:
        reply = fppd.post("/internal/crashReport", timeout=280)
    except (http.client.RemoteDisconnected, ConnectionResetError, urllib.error.URLError) as e:
        took = time.monotonic() - started
        raise AssertionError(
            f"fppd dropped the connection after {took:.0f}s instead of answering "
            f"the report ({e!r})") from e
    took = time.monotonic() - started
    assert took >= BUILD_SECONDS, f"the build did not wait for the stub ({took:.0f}s)"
    assert reply.get("Status") == "OK", f"the report was not built: {reply}"

    rc = fppd.stop(timeout=60)
    fppd.exit_expected = True
    reports = fppd.sanitizer_reports()
    assert not reports, "sanitizer report:\n" + "\n".join(r[:8000] for r in reports)
    assert rc == 0, f"fppd exited with {rc}\n{fppd.tail()}"
