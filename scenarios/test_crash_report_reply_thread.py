"""POST /internal/crashReport (behind POST /api/crashes/report) builds its
report on a thread of its own and answers from there, so the response
crosses from that thread to drogon's I/O loop."""

import os
import time


def test_answers_from_the_report_thread_do_not_race_the_io_loop(fppd, tmp_path):
    """One real build, then a burst of requests inside its 10 s cooldown.
    Each is answered "rate-limited" from the report's thread, and fppd must
    stop with no sanitizer report.

    Regression: fpp 243a951c4. The thread called drogon's callback itself,
    which hands the response to the I/O loop through trantor's lock-free
    queue, and then dropped its references to the response and the request
    after the loop could already have sent and freed them. A TSan build
    can't see that queue, so it reported the response as raced on every
    request (first seen running the web suite against a TSan fppd). The
    thread now passes only the result, under a lock, and the loop makes and
    sends the answer. Only TSan sees the difference.

    Under the other flavors it checks that the build and the cooldown
    answers still arrive."""
    # The boot journal is the slow part of a level-3 report.
    bindir = tmp_path / "bin"
    bindir.mkdir()
    (bindir / "journalctl").write_text("#!/bin/sh\nexit 0\n")
    (bindir / "journalctl").chmod(0o755)
    fppd.start(extra_env={"PATH": f"{bindir}:{os.environ['PATH']}"})

    first = fppd.post("/internal/crashReport", timeout=280)
    assert first.get("Status") == "OK", f"the report was not built: {first}"
    built = time.monotonic()

    answers = []
    while time.monotonic() - built < 8 and len(answers) < 200:
        answers.append(fppd.post("/internal/crashReport", timeout=10).get("Code"))
    assert answers and set(answers) == {"rate-limited"}, f"cooldown answers: {answers[:20]}"

    rc = fppd.stop(timeout=60)
    fppd.exit_expected = True
    reports = fppd.sanitizer_reports()
    assert not reports, "sanitizer report:\n" + "\n".join(r[:8000] for r in reports)
    assert rc == 0, f"fppd exited with {rc}\n{fppd.tail()}"
