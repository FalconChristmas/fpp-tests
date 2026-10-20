"""What fppd's crash handler and its report-on-request build send, and when.
A SIGABRT sent from outside runs the crash handler's fatal path (see
test_crash_reports.py). The upload is curl run through the shell, so a curl
on fppd's PATH stands in for it: it records the call and sends nothing."""

import os
import signal
import subprocess
import threading
import zipfile

import pytest

from fppd import describe_rc, sanitizer

pytestmark = pytest.mark.skipif(sanitizer() == "tsan",
                                reason="the crash handler is signal-unsafe by design")


def stub_bin(tmp_path, **scripts):
    """A directory of stand-in commands, to put first on fppd's PATH."""
    d = tmp_path / "bin"
    d.mkdir(exist_ok=True)
    for name, body in scripts.items():
        (d / name).write_text("#!/bin/sh\n" + body)
        (d / name).chmod(0o755)
    return {"PATH": f"{d}:{os.environ['PATH']}"}


def recording_curl(fppd):
    calls = os.path.join(fppd.media, "tmp", "curl-calls")
    return calls, f'echo "$*" >> {calls}\nexit 0\n'


def crash(fppd):
    """SIGABRT a started fppd and wait for the handler's _exit(-1)."""
    fppd.proc.send_signal(signal.SIGABRT)
    try:
        rc = fppd.proc.wait(timeout=180)
    except subprocess.TimeoutExpired:
        raise TimeoutError(f"the crash handler did not finish within 180s\n{fppd.tail()}")
    fppd.exit_expected = True
    assert rc == 255, f"fppd exited with {describe_rc(rc)}, not the crash handler's _exit(-1)\n{fppd.tail()}"
    reports = fppd.sanitizer_reports()
    assert not reports, "sanitizer report:\n" + "\n".join(r[:8000] for r in reports)


def reports_in(fppd, manual=None):
    crashes = os.path.join(fppd.media, "crashes")
    names = sorted(n for n in os.listdir(crashes) if n.endswith(".zip")) if os.path.isdir(crashes) else []
    if manual is not None:
        names = [n for n in names if n.endswith("-manual.zip") == manual]
    return [os.path.join(crashes, n) for n in names]


def zip_texts(path):
    with zipfile.ZipFile(path) as z:
        return {n: z.read(n).decode("latin-1") for n in z.namelist()}


def check_stack_traces_only(fppd, calls):
    """The one report in crashes/ is a level-1 one, it was sent, and its
    crash context has the main-loop phase and the module map."""
    reports = reports_in(fppd)
    assert len(reports) == 1, f"reports: {reports}\n{fppd.tail()}"
    texts = zip_texts(reports[0])
    names = sorted(texts)
    context = next((t for n, t in texts.items() if n.endswith("fppd_crash_context.log")), None)
    assert context is not None, f"no crash context in the report: {names}"
    assert "Main loop phase: " in context, f"no main-loop phase:\n{context[:2000]}"
    assert "=== module map" in context and "libfpp" in context, \
        f"no module map in the crash context:\n{context[:2000]}"
    extra = [n for n in names if os.path.basename(n.rstrip("/")) == "settings"
             or n.lstrip("./").startswith(("config/", "logs/", "playlists/"))]
    assert not extra, f"a stack-traces-only crash report sent more: {extra}"
    assert not [n for n, t in texts.items() if "LEAK-" in t], "the report carries planted values"
    with open(calls) as f:
        uploads = [l for l in f if "crashUpload" in l]
    assert len(uploads) == 1 and os.path.basename(reports[0]) in uploads[0], \
        f"the report was not sent: {uploads}"
    stack = next((t for n, t in texts.items() if n.endswith("fppd_crash.log")), "")
    return stack


def test_stack_traces_only_sends_the_stack_and_the_module_map(fppd, tmp_path):
    """At "Send stack traces only" (ShareCrashData 1) a crash sends a report
    with no settings, configuration or logs, and its crash context carries
    the main-loop phase and the module map even though gdb produced a
    stack.

    Regression: e1467bbf8. The module map was written only when gdb failed,
    so a frame gdb could not resolve or unwind past could not be mapped back
    afterwards, and the main-loop phase was not recorded at all.
    """
    fppd.settings(ShareCrashData="1", HostName="LEAK-host")
    fppd.write("config/plugin.fpp-tests.json", {"note": "LEAK-config"})
    calls, curl = recording_curl(fppd)
    fppd.start(extra_env=stub_bin(tmp_path, curl=curl))
    crash(fppd)
    stack = check_stack_traces_only(fppd, calls)
    assert "gdb stack unavailable" not in stack, \
        "gdb failed, so the map was there for the old reason: this proves nothing"


def test_status_polls_stay_out_of_the_crash_log_ring(fppd):
    """The crash-time log ring keeps the last 256 lines at debug or coarser.
    Polling /fppd/status, as the UI and the OLED display do every second,
    puts nothing in it, so a report's ring still shows what led to the
    crash.

    Regression: dc270b795. Three debug lines per status request filled
    every slot of the ring with polling, and reports arrived with nothing
    else in it.
    """
    fppd.settings(ShareCrashData="0")
    fppd.start()
    for _ in range(300):
        fppd.get("/fppd/status")
    crash(fppd)
    reports = reports_in(fppd)
    assert reports, f"no report\n{fppd.tail()}"
    ring = next((t for n, t in zip_texts(reports[-1]).items() if n.endswith("fppd_crash_log_ring.log")), None)
    assert ring is not None, "no log ring in a level-3 report"
    lines = [l for l in ring.splitlines() if l.strip() and not l.startswith("===")]
    assert lines and lines != ["(empty)"], f"the ring is empty, so this proves nothing:\n{ring[:2000]}"
    polls = [l for l in lines if "/fppd/status" in l or "Getting fppd status" in l]
    assert not polls, f"{len(polls)} of the ring's {len(lines)} lines are status polls:\n" + "\n".join(polls[:5])


def hold_build(fppd):
    """A journalctl that holds a level-3 build open for 6 s (the report
    reads the boot journal) and says when the build got there."""
    return f"touch {fppd.media}/tmp/build-started\nsleep 6\n"


def post_report(fppd, timeout=280):
    return fppd.post("/internal/crashReport", timeout=timeout)


def test_a_report_on_request_is_built_once_kept_locally_and_never_hides_a_crash(fppd, tmp_path):
    """POST /internal/crashReport (behind POST /api/crashes/report) builds a
    -manual report in crashes/ and sends nothing; a second request while it
    builds answers busy and one just after answers rate-limited; and a crash
    a moment later still writes its own report.

    Feature: 1a88db3bc, 584744bc1 (one build at a time, then 10 s).
    Regression (1a88db3bc): the crash handler skips a report younger than a
    minute as "very recent", and a manual report would have counted, so
    asking for one hid the next real crash.
    """
    fppd.settings(ShareCrashData="0")
    calls, curl = recording_curl(fppd)
    env = stub_bin(tmp_path, curl=curl, journalctl=hold_build(fppd))
    fppd.start(extra_env=env)
    first = {}
    t = threading.Thread(target=lambda: first.update(post_report(fppd)))
    t.start()
    started = os.path.join(fppd.media, "tmp", "build-started")
    fppd.wait_for(lambda: os.path.exists(started), timeout=60, what="the build to start")
    second = post_report(fppd, timeout=10)
    t.join(timeout=280)
    assert not t.is_alive(), "the first build never answered"
    assert second.get("Code") == "busy", f"a second build during the first: {second}"
    assert first.get("Status") == "OK" and first.get("File", "").endswith("-manual.zip"), first
    path = os.path.join(fppd.media, "crashes", first["File"])
    assert os.path.getsize(path) > 0, "the report is empty"
    assert "settings" in {os.path.basename(n) for n in zip_texts(path)}, "not a level-3 report"
    third = post_report(fppd, timeout=10)
    assert third.get("Code") == "rate-limited", f"a build straight after one: {third}"
    assert not os.path.exists(calls), "a report on request was uploaded"
    crash(fppd)
    crashes = reports_in(fppd, manual=False)
    assert crashes, f"the crash after a report on request wrote no report\n{fppd.tail()}"


def test_fppd_stops_cleanly_while_a_report_on_request_builds(fppd, tmp_path):
    """SIGTERM while a report on request is building: fppd exits 0 and the
    sanitizer reports nothing (the build's thread answers a server that has
    stopped).

    Feature: 1a88db3bc.
    """
    fppd.start(extra_env=stub_bin(tmp_path, journalctl=hold_build(fppd)))
    t = threading.Thread(target=lambda: _ignore(lambda: post_report(fppd, timeout=60)), daemon=True)
    t.start()
    started = os.path.join(fppd.media, "tmp", "build-started")
    fppd.wait_for(lambda: os.path.exists(started), timeout=60, what="the build to start")
    rc = fppd.stop(timeout=60)
    fppd.exit_expected = True
    reports = fppd.sanitizer_reports()
    assert not reports, "sanitizer report:\n" + "\n".join(r[:8000] for r in reports)
    assert rc == 0, f"fppd exited with {describe_rc(rc)} on SIGTERM mid-build\n{fppd.tail()}"


def _ignore(fn):
    try:
        fn()
    except Exception:
        pass
