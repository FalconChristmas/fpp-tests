"""fppd's crash handler. A SIGABRT sent from outside runs the fatal path
(pruning crashes/, building a report, then _exit) without a real fault, so
nothing else is broken when it runs. SIGUSR1 asks for a stack dump only, and
fppd carries on. ShareCrashData 0 makes the report a local one, never
uploaded."""

import json
import os
import re
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

    Also ea2123728 (only ten reports are kept: nothing is pruned without
    it) and 52acd5bce (the handler is registered for the signal: without it
    SIGABRT ends fppd by the default action, not through the handler).

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

    Also fdf8ea746: reports go in their own crashes/ directory. Shown red
    with the report named under upload/ instead.
    """
    crashes = os.path.join(fppd.media, "crashes")
    os.makedirs(crashes, exist_ok=True)
    run_crash_handler(fppd)
    zips = [n for n in os.listdir(crashes) if n.endswith(".zip")]
    assert zips, f"no report in {crashes}: {os.listdir(crashes)}"
    assert os.path.getsize(os.path.join(crashes, zips[0])) > 1000, "the report is empty"


def test_crash_report_is_named_for_the_system_uuid(fppd):
    """The report's file name carries the system's UUID, so reports from one
    system can be found and put together on the crash server.

    Regression: 4eacec20b. The name was platform, version and time only."""
    fppd.settings(SystemUUID="M1-fpptests0123abcd")
    crashes = os.path.join(fppd.media, "crashes")
    os.makedirs(crashes, exist_ok=True)
    run_crash_handler(fppd)
    zips = [n for n in os.listdir(crashes) if n.endswith(".zip")]
    assert zips, f"no report in {crashes}: {os.listdir(crashes)}"
    assert all("-M1-fpptests0123abcd-" in n for n in zips), zips


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

    Also guards e3a7cf772: the warnings thread is named "FPP-Warnings" (in
    /proc, and so in crash reports); without the name there is no such
    thread to find.
    Also ba777f822: the handler writes the "FPPD has crashed" warning into
    www/warnings.json for the pages to show.
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


def test_crash_report_tells_memory_damage_from_a_damaged_file(fppd, tmp_path):
    """A library whose code pages were damaged in RAM is reported as memory
    damage ("page cache DIFFERS from storage"), not as a file damaged on
    disk, and a library that really is damaged on disk still reads as one.

    A flipped bit in RAM is modelled with directstorage.so: the library's
    ordinary reads (its page cache) give the damaged bytes fppd ran, and its
    O_DIRECT reads give the intact bytes the storage holds.

    Regression: 8a7c3ea56. crash_module_integrity.py read the file through
    the page cache only, which shares its pages with the mapping, so the
    code at pc "matched the file" and the md5 mismatched the package: the
    verdict for a damaged file.
    """
    import hashlib
    import random
    import shims
    rng = random.Random(8)
    intact = bytes(rng.randrange(256) for _ in range(64 * 1024))
    flipped = bytearray(intact)
    flipped[0x1234] ^= 0x10
    flipped = bytes(flipped)
    libdir = tmp_path / "lib"
    libdir.mkdir()
    ram_hit = libdir / "libramhit.so"      # page cache damaged, storage intact
    disk_hit = libdir / "libdiskhit.so"    # damaged on disk
    ram_hit.write_bytes(flipped)
    disk_hit.write_bytes(flipped)
    storage = tmp_path / "libramhit.storage"
    storage.write_bytes(intact)
    dpkg = tmp_path / "dpkg"
    dpkg.mkdir()
    md5 = hashlib.md5(intact).hexdigest()
    (dpkg / "libfpptests.md5sums").write_text(
        f"{md5}  {str(ram_hit).lstrip('/')}\n{md5}  {str(disk_hit).lstrip('/')}\n")
    ram_base, disk_base = 0x7f0000000000, 0x7f1000000000
    code = flipped[0x1230:0x1240]
    ctx = tmp_path / "fppd_crash_context.log"
    ctx.write_text(
        "=== module map\n"
        f"{ram_base:x}-{ram_base + 0x10000:x} r-xp 00000000 00:00 1 {ram_hit}\n"
        f"{disk_base:x}-{disk_base + 0x10000:x} r-xp 00000000 00:00 2 {disk_hit}\n"
        "=== code at pc\n"
        f"0x{ram_base + 0x1230:x}: {code.hex(' ')}\n"
        f"0x{disk_base + 0x1230:x}: {code.hex(' ')}\n")
    out = tmp_path / "module_integrity.json"
    log = tmp_path / "redirects.log"
    env = dict(os.environ, LD_PRELOAD=shims.build("directstorage.c"),
               DIRECTSTORAGE_PATH=str(ram_hit), DIRECTSTORAGE_FROM=str(storage),
               DIRECTSTORAGE_LOG=str(log), FPP_DPKG_INFO_DIR=str(dpkg))
    r = subprocess.run(["python3", os.path.join(fppd.tree, "scripts", "crash_module_integrity.py"),
                        str(ctx), str(out)], capture_output=True, text=True, timeout=60, env=env)
    assert r.returncode == 0 and out.exists(), f"rc {r.returncode}\n{r.stdout}\n{r.stderr}"
    report = json.loads(out.read_text())
    modules = {m["path"]: m for m in report["modules"]}
    pcs = {c.get("module"): c for c in report["code_at_pc"]}
    assert modules[str(disk_hit)]["status"] == "DIFFERS from package", modules[str(disk_hit)]
    assert pcs[str(disk_hit)]["result"] == "matches file", pcs[str(disk_hit)]
    assert pcs[str(ram_hit)]["result"] == "page cache DIFFERS from storage", \
        f"memory damage at pc reads as a damaged file: {pcs[str(ram_hit)]}"
    assert modules[str(ram_hit)]["status"] == "page cache DIFFERS from storage", \
        f"memory damage reads as a damaged file: {modules[str(ram_hit)]}"
    assert report["page_cache_differs"] == [str(ram_hit)], report["page_cache_differs"]
    assert report["differs_from_package"] == [str(disk_hit)], report["differs_from_package"]


def test_crash_report_records_installed_plugin_versions(fppd, tmp_path):
    """A report has a plugins.json naming the commit
    each installed plugin sits on: here a git checkout owned by another user
    (as plugins are owned by fpp and the report runs as root), modified in
    place and cloned from an https remote with a token in its URL, and a
    plugin that isn't a git checkout. The commit and the -dirty state are
    recorded, the remote is, with its credentials gone.

    Added in 6eb1ee902. Nothing in a report said which plugin build the
    device ran, so a fix in a plugin repo could only be aged out by date.
    """
    plugin = os.path.join(fppd.media, "plugins", "fpp-tests-plugin")
    os.makedirs(plugin)
    git = ["git", "-C", plugin, "-c", "user.name=t", "-c", "user.email=t@t"]
    subprocess.run(["git", "init", "-q", plugin], check=True)
    with open(os.path.join(plugin, "pluginInfo.json"), "w") as f:
        f.write("{}\n")
    subprocess.run([*git, "add", "."], check=True)
    subprocess.run([*git, "commit", "-qm", "one"], check=True)
    subprocess.run([*git, "remote", "add", "origin",
                    "https://fpp-tests-user:LEAK-plugin-token@example.com/x/fpp-tests-plugin.git"], check=True)
    commit = subprocess.run([*git, "rev-parse", "--short", "HEAD"], check=True,
                            capture_output=True, text=True).stdout.strip()
    with open(os.path.join(plugin, "pluginInfo.json"), "a") as f:
        f.write("\n")
    subprocess.run(["chown", "-R", "1000:1000", plugin], check=True)
    os.makedirs(os.path.join(fppd.media, "plugins", "fpp-tests-copied"))
    os.makedirs(os.path.join(fppd.media, "crashes"))
    view = private_fppdir(fppd.tree, fppd.media)
    out = os.path.join(fppd.media, "crashes", "report.zip")
    env = dict(os.environ)
    env.pop("LD_PRELOAD", None)
    r = subprocess.run(["bash", os.path.join(view, "scripts", "generate_crash_report"), "2", out],
                       capture_output=True, text=True, timeout=180, env=env)
    assert r.returncode == 0 and os.path.exists(out), f"no report:\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}"
    with zipfile.ZipFile(out) as z:
        texts = {n: z.read(n).decode("latin-1") for n in z.namelist()}
    name = next((n for n in texts if n.endswith("plugins.json")), None)
    assert name, f"no plugins.json in the report: {sorted(texts)}"
    plugins = {p["name"]: p for p in json.loads(texts[name])["plugins"]}
    ours = plugins.get("fpp-tests-plugin")
    assert ours and ours.get("commit") == commit, f"the plugin's commit {commit} isn't recorded: {plugins}"
    assert ours.get("dirty") is True and ours.get("describe", "").endswith("-dirty"), ours
    assert ours.get("remote") == "https://example.com/x/fpp-tests-plugin.git", ours
    assert plugins.get("fpp-tests-copied", {}).get("error") == "not a git checkout", plugins
    leaks = sorted(n for n, t in texts.items() if "LEAK-plugin-token" in t or "fpp-tests-user" in t)
    assert not leaks, f"the remote's credentials ship in: {leaks}"


def test_crash_report_resolves_the_fallback_stack_to_lines(fppd, tmp_path):
    """When gdb gives no stack (here a gdb that fails at once), fppd records
    the raw frame addresses and the module map, and the report resolves them
    on the box: fppd_crash_addr2line.log names fppd's own functions with
    their file:line.

    Added in 0ab80c166. Before it a crash without gdb left only bare
    addresses, which can't be resolved anywhere but on the device that ran
    the binary.
    """
    stub = tmp_path / "bin"
    stub.mkdir()
    (stub / "gdb").write_text("#!/bin/sh\nexit 1\n")
    (stub / "gdb").chmod(0o755)
    crashes = os.path.join(fppd.media, "crashes")
    os.makedirs(crashes, exist_ok=True)
    fppd.settings(ShareCrashData="0")
    fppd.start(extra_env={"PATH": f"{stub}:{os.environ['PATH']}"})
    fppd.proc.send_signal(signal.SIGABRT)
    try:
        rc = fppd.proc.wait(timeout=180)
    except subprocess.TimeoutExpired:
        raise TimeoutError(f"the crash handler did not finish within 180s\n{fppd.tail()}")
    fppd.exit_expected = True
    assert rc == 255, f"fppd exited with {describe_rc(rc)}, not the crash handler's _exit(-1)\n{fppd.tail()}"
    texts = report_texts(fppd, crashes)
    crash_log = next((t for n, t in texts.items() if n.endswith("fppd_crash.log")), "")
    assert "=== raw frames" in crash_log, \
        f"gdb wasn't bypassed, so this proves nothing:\n{crash_log[:2000]}"
    name = next((n for n in texts if n.endswith("fppd_crash_addr2line.log")), None)
    assert name, f"the raw frames weren't resolved: {sorted(texts)}"
    resolved = texts[name]
    assert "MainLoop" in resolved and "fppd.cpp:" in resolved, \
        f"fppd's frames aren't named with their lines:\n{resolved}"


def crash_with_curl_stub(fppd, tmp_path, share):
    """Crash fppd with ShareCrashData `share` and a curl on its PATH that
    only records how it was called; the curl calls."""
    stub = tmp_path / "bin"
    stub.mkdir()
    calls = tmp_path / "curl-calls"
    (stub / "curl").write_text(f"#!/bin/sh\necho \"$@\" >> {calls}\n")
    (stub / "curl").chmod(0o755)
    os.makedirs(os.path.join(fppd.media, "crashes"), exist_ok=True)
    fppd.settings(ShareCrashData=share)
    fppd.start(extra_env={"PATH": f"{stub}:{os.environ['PATH']}"})
    fppd.proc.send_signal(signal.SIGABRT)
    try:
        rc = fppd.proc.wait(timeout=180)
    except subprocess.TimeoutExpired:
        raise TimeoutError(f"the crash handler did not finish within 180s\n{fppd.tail()}")
    fppd.exit_expected = True
    assert rc == 255, f"fppd exited with {describe_rc(rc)}, not the crash handler's _exit(-1)\n{fppd.tail()}"
    return calls.read_text().splitlines() if calls.exists() else []


def test_crash_context_records_the_temperature_at_the_fault(fppd, tmp_path):
    """The crash context has a "thermal at fault" section, ahead of the
    module map, with each thermal zone's type and temperature in degrees
    (or "(no thermal zones)") and each cpufreq policy's clock, even at the
    lowest share level.

    Added in 603511b4e. A SIGILL at a valid instruction can be a part
    running too hot for its clock, and nothing in a report said how hot it
    was: the CPU cools within seconds, so only a reading taken in the
    handler means anything."""
    crash_with_curl_stub(fppd, tmp_path, "1")
    texts = report_texts(fppd, os.path.join(fppd.media, "crashes"))
    context = next((t for n, t in texts.items() if n.endswith("fppd_crash_context.log")), "")
    assert "=== module map" in context, f"no crash context, so this proves nothing:\n{context[:2000]}"
    assert "=== thermal at fault ===" in context, f"no thermal section in the crash context:\n{context[:3000]}"
    thermal = context.split("=== thermal at fault ===", 1)[1]
    assert "=== module map" in thermal, "the thermal section came after the module map, which parsers read to the end"
    thermal = thermal.split("\n===", 1)[0]
    if os.path.exists("/sys/class/thermal/thermal_zone0/temp"):
        with open("/sys/class/thermal/thermal_zone0/type") as f:
            kind = f.read().strip()
        assert re.search(rf"^thermal_zone0 {re.escape(kind)}: -?\d+\.\d{{3}} C$", thermal, re.M), thermal
    else:
        assert "(no thermal zones)" in thermal, thermal
    if os.path.exists("/sys/devices/system/cpu/cpufreq/policy0/scaling_cur_freq"):
        assert re.search(r"^cpufreq policy0: \d+ kHz", thermal, re.M), thermal
    assert "=0x" not in thermal, f"the report side would read these as registers:\n{thermal}"


def test_crash_report_kept_locally_is_full_and_never_sent(fppd, tmp_path):
    """ShareCrashData 0 ("Keep locally, do not send") writes a full report,
    settings, configs and logs included, into crashes/, and uploads nothing.

    Regression: b4dd21938. 0 was "Disabled": no report was written at all,
    so the users most likely to read a crash themselves had none to read,
    while the UI told them to submit or delete reports.
    """
    calls = crash_with_curl_stub(fppd, tmp_path, "0")
    crashes = os.path.join(fppd.media, "crashes")
    texts = report_texts(fppd, crashes)
    missing = [n for n in ("settings", "logs/fppd.log") if not any(k.endswith(n) for k in texts)]
    assert not missing, f"the local report isn't a full one, it lacks {missing}: {sorted(texts)}"
    uploads = [c for c in calls if "crashUpload" in c]
    assert not uploads, f"a report kept locally was sent: {uploads}"


def test_crash_reports_disabled_writes_none(fppd, tmp_path):
    """ShareCrashData -1 ("Disabled") writes no report and sends nothing.

    Added in b4dd21938, where -1 took over "Disabled" from 0.
    """
    calls = crash_with_curl_stub(fppd, tmp_path, "-1")
    crashes = os.path.join(fppd.media, "crashes")
    assert not os.listdir(crashes), f"a disabled crash report was written: {os.listdir(crashes)}"
    assert not [c for c in calls if "crashUpload" in c], calls


def test_stack_traces_only_report_carries_no_log_lines(fppd, tmp_path):
    """At ShareCrashData 1 ("Send stack traces only") the report has the
    crash context -- playlist state, registers -- but none of the retained
    log ring, which is log content (host names, LAN addresses, discovered
    devices) and ships only where logs/fppd.log does.

    Also 85879fb81: ShareCrashData sets how much a report carries; with the
    setting ignored (always the full level) this test, the kept-locally one
    and the disabled one all go red.

    Regression: 8b5fc01e7. The ring was written into fppd_crash_context.log,
    which is copied at every level, so a user who narrowed sharing to stack
    traces sent their recent log lines.
    """
    crash_with_curl_stub(fppd, tmp_path, "1")
    texts = report_texts(fppd, os.path.join(fppd.media, "crashes"))
    context = next((t for n, t in texts.items() if n.endswith("fppd_crash_context.log")), None)
    assert context and "Main loop phase:" in context, \
        f"no crash context in the report, so this proves nothing: {sorted(texts)}"
    carrying = sorted(n for n, t in texts.items()
                      if "recent log lines (ring buffer" in t or "Crash handler called" in t)
    assert not carrying, f"a stack-traces-only report carries log lines in: {carrying}"


def test_crash_log_ring_holds_the_history_before_the_crash(fppd, tmp_path):
    """At level 3 the report carries the retained log ring, and the ring
    stops at the crash: none of the crash handler's own lines are in it.

    Regression: 8b5fc01e7. The ring kept recording while the handler ran,
    so its signal line and the stack it logged pushed out the pre-crash
    history the ring exists to keep.
    """
    crash_with_curl_stub(fppd, tmp_path, "3")
    texts = report_texts(fppd, os.path.join(fppd.media, "crashes"))
    ring = next((t for n, t in texts.items() if n.endswith("fppd_crash_log_ring.log")), None)
    assert ring and "(empty)" not in ring and len(ring.splitlines()) > 3, \
        f"no log ring in a level-3 report: {sorted(texts)}\n{(ring or '')[:2000]}"
    assert "Crash handler called" not in ring, \
        f"the crash handler's own lines are in the ring:\n{ring[-3000:]}"


def test_crash_context_records_the_playlist_and_the_registers(fppd, tmp_path):
    """A crash mid-playlist leaves a crash context with the playlist's name,
    section, position and the size of each section, and the registers at
    the fault, and a level-3 report's log ring keeps debug lines from before
    the crash that the info-level fppd.log never wrote.

    Added in 45ac03e43. A report carried a stack and nothing else: no
    playlist state, no registers for a stack that can't be unwound, and the
    debug line that explains a crash was filtered out before it was kept.
    """
    entry = {"type": "pause", "enabled": 1, "playOnce": 0, "duration": 600}
    fppd.write("playlists/CrashCtx.json", {
        "name": "CrashCtx", "repeat": 0, "loopCount": 0,
        "leadIn": [dict(entry, duration=0.2)], "mainPlaylist": [entry, entry, entry],
        "leadOut": [entry, entry]})
    stub = tmp_path / "bin"
    stub.mkdir()
    (stub / "curl").write_text("#!/bin/sh\nexit 0\n")
    (stub / "curl").chmod(0o755)
    crashes = os.path.join(fppd.media, "crashes")
    os.makedirs(crashes, exist_ok=True)
    fppd.settings(ShareCrashData="3", LogLevel="info")
    fppd.start(extra_env={"PATH": f"{stub}:{os.environ['PATH']}"})
    fppd.command("Start Playlist", "CrashCtx", "false", "false")
    fppd.wait_for(lambda: fppd.get("/fppd/status").get("current_playlist", {}).get("index") == "2",
                  timeout=30, what="the playlist to reach its main section")
    # The snapshot is refreshed on the main loop's next pass over the
    # playlist (Process()); the section switch itself records the old one.
    time.sleep(1)
    fppd.proc.send_signal(signal.SIGABRT)
    try:
        rc = fppd.proc.wait(timeout=180)
    except subprocess.TimeoutExpired:
        raise TimeoutError(f"the crash handler did not finish within 180s\n{fppd.tail()}")
    fppd.exit_expected = True
    assert rc == 255, f"fppd exited with {describe_rc(rc)}, not the crash handler's _exit(-1)\n{fppd.tail()}"
    import re
    texts = report_texts(fppd, crashes)
    context = next((t for n, t in texts.items() if n.endswith("fppd_crash_context.log")), "")
    state = re.search(r"Playlist state: name='CrashCtx' section=(\S+) pos=(\d+) .*"
                      r"sizes\(leadIn=(\d+) main=(\d+) leadOut=(\d+)\)", context)
    assert state, f"no playlist state in the crash context:\n{context[:2000]}"
    assert state.groups() == ("MainPlaylist", "0", "1", "3", "2"), state.group(0)
    assert re.search(r"=== registers at fault ===\n(pc|rip)=0x[0-9a-f]+ ", context), \
        f"no registers in the crash context:\n{context[:2000]}"
    ring = next((t for n, t in texts.items() if n.endswith("fppd_crash_log_ring.log")), "")
    log = next((t for n, t in texts.items() if n.endswith("logs/fppd.log")), "")
    # A ring line, past its timestamp, that fppd.log doesn't have.
    lines = [l.split(") ", 1)[1] for l in ring.splitlines() if re.match(r"\d{4}-\d\d-\d\d .*\) \[", l)]
    unlogged = [l for l in lines if l not in log]
    assert unlogged, f"the ring holds no debug lines fppd.log lacks:\nring:\n{ring[-2000:]}\nlog:\n{log[-2000:]}"


def test_crash_handler_skips_the_destructors_that_can_hang(fppd, tmp_path):
    """The crash handler leaves with _exit(): fppd exits at once with -1,
    without running global and library destructors -- here one
    (hangatexit.so) that never returns, as ~RTSPOutputManager didn't when
    the crashed thread still held its apply lock.

    Regression: 7c77248be. The handler ended with exit(-1), which ran the
    destructors; one waiting on a lock the crashed thread held kept fppd
    up until the handler's 120 s watchdog killed it, the show dark all that
    time.
    """
    import shims
    ran = tmp_path / "destructor"
    fppd.settings(ShareCrashData="-1")
    fppd.start(preload=[shims.build("hangatexit.c")], extra_env={"HANGATEXIT_FILE": str(ran)})
    fppd.proc.send_signal(signal.SIGABRT)
    try:
        rc = fppd.proc.wait(timeout=60)
    except subprocess.TimeoutExpired:
        fppd.proc.kill()
        fppd.proc.wait()
        fppd.exit_expected = True
        raise AssertionError(f"fppd was still up 60 s after the crash; destructor ran: {ran.exists()}\n{fppd.tail()}")
    fppd.exit_expected = True
    assert rc == 255, f"fppd exited with {describe_rc(rc)}, not the crash handler's _exit(-1)\n{fppd.tail()}"
    assert not ran.exists(), "the crash handler ran the destructors"
