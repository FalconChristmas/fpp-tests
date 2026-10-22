"""fppd's crash handler. A SIGABRT sent from outside runs the fatal path
(pruning crashes/, building a report, then _exit) without a real fault, so
nothing else is broken when it runs. SIGUSR1 asks for a stack dump only, and
fppd carries on. ShareCrashData 0 makes the report a local one, never
uploaded."""

import json
import os
import signal
import subprocess
import time
import zipfile

import pytest

from fppd import describe_rc, sanitizer

# The crash handler is not async-signal-safe and can't be (it logs, lists
# crashes/ and runs scripts); tsan.supp says so for handleCrash, but here the
# allocations are inside libstdc++, whose frames don't reach handleCrash, so
# TSan reports every one. These scenarios are about what the handler does,
# not about races.
pytestmark = pytest.mark.skipif(sanitizer() == "tsan",
                                reason="the crash handler is signal-unsafe by design")

DAY = 86400


def seed_reports(fppd, newest_age=300):
    """Twelve reports where name order and age disagree, as after an
    upgrade: the 10.x names sort before the 9.x ones but are newer."""
    crashes = os.path.join(fppd.media, "crashes")
    os.makedirs(crashes, exist_ok=True)
    now = time.time()
    reports = {}
    for i in range(6):
        old = f"fpp-Linux-9.5-uuid-2025010{i}-000000.zip"
        new = f"fpp-Linux-10.2-uuid-2026090{i}-000000.zip"
        reports[old] = now - newest_age - (12 - i) * DAY   # oldest six
        reports[new] = now - newest_age - (6 - i) * DAY    # newest six
    for name, t in reports.items():
        path = os.path.join(crashes, name)
        with open(path, "wb") as f:
            f.write(b"PK\x05\x06" + bytes(18))  # an empty zip
        os.utime(path, (t, t))
    return crashes, reports


def run_crash_handler(fppd):
    """Start fppd, send it SIGABRT, and wait for the crash handler to finish:
    it exits with _exit(-1) once the report is written."""
    fppd.settings(ShareCrashData="0")
    fppd.start()
    fppd.proc.send_signal(signal.SIGABRT)
    try:
        # The report script is bounded at 300 s inside fppd; a test report
        # takes well under a minute.
        rc = fppd.proc.wait(timeout=180)
    except subprocess.TimeoutExpired:
        raise TimeoutError(f"the crash handler did not finish within 180s\n{fppd.tail()}")
    fppd.exit_expected = True
    assert rc == 255, f"fppd exited with {describe_rc(rc)}, not the crash handler's _exit(-1)\n{fppd.tail()}"
    reports = fppd.sanitizer_reports()
    assert not reports, "sanitizer report:\n" + "\n".join(r[:8000] for r in reports)


def test_crash_handler_prunes_the_oldest_reports_by_time(fppd):
    """With more than ten reports in crashes/, the crash handler deletes the
    oldest by time, even when the newest sort first by name.

    Regression: cce0e6327. Reports were pruned by name, and names start with
    the FPP version, so after an upgrade the newest ("10.x" sorts before
    "9.x") were the ones deleted.
    """
    crashes, reports = seed_reports(fppd)
    run_crash_handler(fppd)
    left = set(os.listdir(crashes))
    by_age = sorted(reports, key=reports.get)
    oldest_two, kept = by_age[:2], by_age[2:]
    assert not (left & set(oldest_two)), f"the oldest were kept: {sorted(left & set(oldest_two))}"
    missing = [n for n in kept if n not in left]
    assert not missing, f"newer reports were deleted: {missing}"


def test_crash_report_is_written_in_this_media_folder(fppd):
    """The crash report lands in crashes/ under fppd's own media folder, here
    a test directory rather than /home/fpp/media.

    Regression: 462d7b884. generate_crash_report changed directory to a
    hard-coded /home/fpp/media (or /opt/fpp) and gave up when neither
    existed, so outside a standard device it wrote no report at all.
    """
    crashes = os.path.join(fppd.media, "crashes")
    os.makedirs(crashes, exist_ok=True)
    run_crash_handler(fppd)
    zips = [n for n in os.listdir(crashes) if n.endswith(".zip")]
    assert zips, f"no report in {crashes}: {os.listdir(crashes)}"
    assert os.path.getsize(os.path.join(crashes, zips[0])) > 1000, "the report is empty"


def report_texts(fppd, crashes):
    """Every file in the newest report in crashes/, as text."""
    import zipfile
    zips = sorted((n for n in os.listdir(crashes) if n.endswith(".zip")),
                  key=lambda n: os.path.getmtime(os.path.join(crashes, n)))
    assert zips, f"no report in {crashes}"
    out = {}
    with zipfile.ZipFile(os.path.join(crashes, zips[-1])) as z:
        for name in z.namelist():
            out[name] = z.read(name).decode("latin-1")
    return out


def test_crash_report_redacts_credentials_and_the_cape_serial(fppd):
    """Credentials in plugin configs and logs, coordinates written as numbers,
    and the cape EEPROM (with its serial) when serial sharing is off, stay out
    of the report.

    Regression: 9e9db1297. The redactor let through a JSON "pw", curl -u
    user:pass, mosquitto_pub -P, cookies, AWS and sk- API keys and numeric
    lat/long, and the EEPROM was copied whatever SendVendorSerial said.
    Also covers fec15ca35, which moved the report into
    scripts/generate_crash_report: before it the crash handler zipped the
    files itself, with nothing redacted.
    """
    crashes = os.path.join(fppd.media, "crashes")
    os.makedirs(crashes, exist_ok=True)
    fppd.write("config/plugin.leaky.json", {
        "broker": "b", "username": "u", "pw": "LEAK-json-pw",
        "location": {"Latitude": 40.71234, "Longitude": -74.00567}})
    fppd.write("config/plugin.leaky-cmds",
               "curl -s -u admin:LEAK-curl http://10.0.0.5/api\n"
               "mosquitto_pub -h b -u fpp -P LEAK-mosquitto -t a -m b\n"
               "Cookie: PHPSESSID=LEAK-cookie\n"
               "aws AKIAIOSFODNN7EXAMPLE openai sk-LEAKopenai1234567890abcdefgh\n"
               "lat=40.71234&lon=-74.00567\n")
    with open(os.path.join(fppd.media, "config", "cape-eeprom.bin"), "wb") as f:
        f.write(b"FPP02" + b"LEAK-cape-serial-0042" + bytes(64))
    fppd.settings(SendVendorSerial="0")
    run_crash_handler(fppd)
    texts = report_texts(fppd, crashes)
    assert any("plugin.leaky.json" in n for n in texts), \
        f"the plugin config isn't in the report, so this proves nothing: {sorted(texts)}"
    leaks = sorted({f"{name}: {tok}" for name, t in texts.items()
                    for tok in ("LEAK-", "AKIAIOSFODNN7EXAMPLE", "40.71234", "74.00567")
                    if tok in t})
    assert not leaks, f"the report carries secrets: {leaks}"


def test_requested_stack_dump_writes_no_report_and_fppd_carries_on(fppd):
    """SIGUSR1 (like SIGQUIT) asks a running fppd for a stack dump: it writes
    the gdb stack and leaves crashes/ alone, and fppd keeps running.

    Regression: fef9ddcf4. A requested dump ran the whole fatal path: it froze
    the crash log ring for good and built (and uploaded) a crash report for
    an fppd that had not crashed.
    """
    crashes = os.path.join(fppd.media, "crashes")
    os.makedirs(crashes, exist_ok=True)
    fppd.settings(ShareCrashData="0")
    fppd.start()
    fppd.proc.send_signal(signal.SIGUSR1)
    fppd.wait_for(lambda: "[Inferior 1 (process" in fppd.log(), timeout=90,
                  interval=0.5, what="the requested stack dump")
    # Long enough for the report script to have left a zip, had it run.
    time.sleep(10)
    fppd.check_alive()
    fppd.get("/fppd/status", timeout=10)
    assert not os.listdir(crashes), f"a requested dump wrote a report: {os.listdir(crashes)}"


def thread_kill(pid, name, sig):
    """Send `sig` to the one thread of `pid` named `name` (tgkill), as a fault
    on that thread would raise it there."""
    import ctypes
    import platform
    tids = []
    for tid in os.listdir(f"/proc/{pid}/task"):
        try:
            with open(f"/proc/{pid}/task/{tid}/comm") as f:
                if f.read().strip() == name:
                    tids.append(int(tid))
        except OSError:
            pass
    assert len(tids) == 1, f"threads named {name}: {tids}"
    nr = {"x86_64": 234, "aarch64": 131}[platform.machine()]
    libc = ctypes.CDLL(None, use_errno=True)
    assert libc.syscall(nr, pid, tids[0], sig) == 0, os.strerror(ctypes.get_errno())


def test_crash_on_the_warnings_thread_exits_through_the_handler(fppd):
    """A fatal signal on the warnings thread itself (a crash inside a
    warnings listener) runs the crash handler to its end: fppd leaves the
    "FPPD has crashed" warning and exits with the handler's _exit(-1).

    Regression: 3a52e4ffb. The handler stopped the warnings thread by
    joining it, here from that same thread: join() threw, terminate
    aborted, and the SIGABRT ran the whole handler again (its re-entry guard
    had already been reset), which joined itself again. fppd ended by
    abort, or by the handler's two-minute watchdog, never through _exit(-1).
    """
    fppd.settings(ShareCrashData="0")
    fppd.start()
    thread_kill(fppd.proc.pid, "FPP-Warnings", signal.SIGSEGV)
    try:
        rc = fppd.proc.wait(timeout=180)
    except subprocess.TimeoutExpired:
        raise TimeoutError(f"the crash handler did not finish within 180s\n{fppd.tail()}")
    fppd.exit_expected = True
    assert rc == 255, f"fppd exited with {describe_rc(rc)}, not the crash handler's _exit(-1)\n{fppd.tail()}"
    with open(os.path.join(fppd.tree, "www", "warnings.json")) as f:
        assert json.load(f) == ["FPPD has crashed.  Check crash reports."]
    reports = fppd.sanitizer_reports()
    assert not reports, "sanitizer report:\n" + "\n".join(r[:8000] for r in reports)


def private_fppdir(tree, media):
    """A view of the tree whose www/media_root.txt names this test's media
    directory, for running a script from the tree directly. The tree's own
    media_root.txt is rewritten by every fppd that starts from it, other
    runs' included. Scripts find FPP from their own path (logically, so
    through these links), and so their media directory from this file."""
    view = os.path.join(media, "tmp", "fppdir")
    os.makedirs(os.path.join(view, "www"))
    for entry in os.listdir(tree):
        if entry != "www":
            os.symlink(os.path.join(tree, entry), os.path.join(view, entry))
    for entry in os.listdir(os.path.join(tree, "www")):
        if entry != "media_root.txt":
            os.symlink(os.path.join(tree, "www", entry), os.path.join(view, "www", entry))
    with open(os.path.join(view, "www", "media_root.txt"), "w") as f:
        f.write(media)
    return view


def test_crash_report_says_when_it_could_not_write_the_zip(fppd):
    """generate_crash_report exits non-zero and says so when the zip could
    not be written -- here because crashes/ is a file, not a directory.

    Regression: e0bbeef37. It printed "Crash report created" and exited 0
    whatever zip did, so fppd and the UI went looking for a report that
    wasn't there.
    """
    with open(os.path.join(fppd.media, "crashes"), "w") as f:
        f.write("not a directory\n")
    view = private_fppdir(fppd.tree, fppd.media)
    out = os.path.join(fppd.media, "crashes", "report.zip")
    r = subprocess.run(["bash", os.path.join(view, "scripts", "generate_crash_report"), "1", out],
                       capture_output=True, text=True, timeout=120)
    text = f"rc {r.returncode}\nstdout:\n{r.stdout[-2000:]}\nstderr:\n{r.stderr[-2000:]}"
    assert "Generating crash report in" in r.stdout, f"the script stopped before the zip step:\n{text}"
    assert "Crash report created" not in r.stdout, f"a report that wasn't made was announced:\n{text}"
    assert "Could not create" in r.stderr, f"no word that the report wasn't made:\n{text}"
    assert r.returncode == 1, text


def test_crash_report_drops_the_cape_serial_from_logs(fppd, tmp_path):
    """With serial sharing off (SendVendorSerial=0), the cape serial is left
    out of every file in a level-3 report: the line fppcapedetect prints at
    boot ("Serial Number: ..."), in fppd.log and in the boot log alike, and
    the serial itself wherever else a log carries it.

    Regression: 5a3524b2a. Only config/cape-eeprom.bin was withheld
    (9e9db1297): the redactor had no rule for the serial, so fppd.log kept
    the capedetect line, and boot.log (dmesg plus the fppinit journal) was
    copied with no redaction at all.
    """
    serial = "LEAK-sn-0042"
    line = f"Found cape fpp-tests-cape, Version 1.0, Serial Number: {serial}"
    fppd.write("logs/fppd.log", f"2026-01-01 00:00:00 fppinit: {line}\n"
               f"2026-01-01 00:00:01 fpp-tests: cape {serial} registered\n")
    fppd.write("tmp/cape-info.json", {"id": "fpp-tests-cape", "serialNumber": serial})
    fppd.settings(SendVendorSerial="0")
    os.makedirs(os.path.join(fppd.media, "crashes"))
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for tool in ("journalctl", "dmesg"):
        (bin_dir / tool).write_text(f"#!/bin/sh\necho '{line}'\n")
        (bin_dir / tool).chmod(0o755)
    view = private_fppdir(fppd.tree, fppd.media)
    out = os.path.join(fppd.media, "crashes", "report.zip")
    env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}")
    env.pop("LD_PRELOAD", None)
    r = subprocess.run(["bash", os.path.join(view, "scripts", "generate_crash_report"), "3", out],
                       capture_output=True, text=True, timeout=180, env=env)
    assert r.returncode == 0 and os.path.exists(out), f"no report:\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}"
    with zipfile.ZipFile(out) as z:
        texts = {n: z.read(n).decode("latin-1") for n in z.namelist()}
    for name, what in (("logs/fppd.log", "registered"), ("tmp/boot.log", "Found cape")):
        assert any(n.endswith(name) and what in t for n, t in texts.items()), \
            f"{name} with the serial's line isn't in the report, so this proves nothing: {sorted(texts)}"
    leaks = sorted(n for n, t in texts.items() if "LEAK-sn" in t)
    assert not leaks, f"the cape serial ships in: {leaks}"


def test_crash_report_checks_the_crashing_code_against_the_disk(fppd):
    """The crash context carries the instruction bytes around the faulting
    pc, and module_integrity.json says those bytes are what the file on disk
    holds, that the packaged libraries fppd had mapped match what dpkg
    installed, and gives a sha256 for the files no package owns.

    Added in b6579e1d2. A SIGILL at an instruction that is valid in the
    packaged library means the library was damaged on disk or replaced under
    fppd, and a report could only show that by inference from the stack.
    """
    import re
    crashes = os.path.join(fppd.media, "crashes")
    os.makedirs(crashes, exist_ok=True)
    run_crash_handler(fppd)
    texts = report_texts(fppd, crashes)
    context = next((t for n, t in texts.items() if n.endswith("fppd_crash_context.log")), "")
    # Only the code section has lines of an address and sixteen hex bytes
    code = re.findall(r"^0x[0-9a-f]+:((?: [0-9a-f]{2}){16})$", context, re.M)
    assert len(code) == 2, f"no code bytes around pc in the crash context:\n{context[:1500]}"
    name = next((n for n in texts if n.endswith("module_integrity.json")), None)
    assert name, f"no module_integrity.json in the report: {sorted(texts)}"
    integrity = json.loads(texts[name])
    results = [c.get("result") for c in integrity["code_at_pc"]]
    assert results == ["matches file", "matches file"], \
        f"the code at pc was not checked against the disk: {integrity['code_at_pc']}"
    assert integrity["summary"].get("ok", 0) > 0, \
        f"no mapped library was checked against its package: {integrity['summary']}"
    assert not integrity["differs_from_package"], integrity["differs_from_package"]
    ours = [m for m in integrity["modules"] if m["path"].endswith("/libfpp.so")]
    assert ours and re.fullmatch(r"[0-9a-f]{64}", ours[0].get("sha256", "")), \
        f"libfpp.so has no sha256: {ours}"
