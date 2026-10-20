"""Settings fixes from 10.1 and 10.2: the loader on a line with no key, a
UUID helper that cannot be started, an over-long log file path, file writes
a locked reader must never see half done, and scripts/common's
getSetting while another reader holds the settings lock."""

import fcntl
import json
import os
import subprocess
import threading
import time

import pytest

import shims
from show import status


def test_keyless_last_line_is_skipped(fppd):
    """A settings file whose last line is only "==" (no key, no newline) is
    skipped, and the settings before it are read.

    Regression: d9fc8b2c3. A line strtok found no key in was freed and the
    loop went on reading into it; the loader then freed it again at the end
    (an ASan double free at startup). The loader was rewritten later
    (e4ada58de), so prove this one against d9fc8b2c3's parent."""
    fppd.settings(TimeFormat="K%Y")
    with open(os.path.join(fppd.media, "settings"), "a") as f:
        f.write("==")
    fppd.start()
    assert status(fppd)["timeStr"] == time.strftime("K%Y")


def test_uuid_helper_that_cannot_start(fppd):
    """fppd starts when scripts/get_uuid cannot be run (popen() fails, as it
    does out of memory or processes), just without a SystemUUID.

    Regression: 064f8ffc3. The failure was logged and the NULL stream then
    read with fgets(): a SIGSEGV on every start."""
    log = os.path.join(fppd.media, "tmp", "failpopen.log")
    fppd.start(preload=[shims.build("failpopen.c")],
               extra_env={"FAILPOPEN_MATCH": "get_uuid", "FAILPOPEN_LOG": log})
    with open(log) as f:
        assert "get_uuid" in f.read(), "fppd never asked for get_uuid; this proves nothing"


def test_log_file_path_longer_than_its_buffer(fppd):
    """fppd started with a log file path longer than its 1024-byte buffer
    (fppd -l) starts and runs.

    Regression: a36998ad1. The path was strcpy'd into the global
    logFileName[1024]: an ASan global-buffer-overflow at startup."""
    longpath = os.path.join(fppd.media, "logs", *(["d" * 200] * 6), "fppd.log")
    assert len(longpath) > 1100
    fppd.start(argv=[os.path.join(fppd.tree, "src", "fppd"), "-f", "-l", longpath])
    status(fppd)


def test_locked_reader_never_sees_a_half_written_file(fppd):
    """A reader holding a shared lock on a file fppd rewrites through
    PutFileContents() (here config/variables.json, saved on every persisted
    Set Variable) always reads the whole file, never an empty or partial
    one. PHP reads the settings file and fppd's JSON files that way.

    Regression: 8ffe7f0b1. The file was opened with "w" -- emptied -- before
    the lock was taken, and the buffered data was written at fclose(), after
    the lock was released: a locked reader nearly always saw it empty."""
    fppd.start()
    path = os.path.join(fppd.media, "config", "variables.json")

    def persist(i):
        fppd.command("Set Variable", "X", "Value", f"value-{i}", "1", "0", "100", "", "true")

    persist(0)
    fppd.wait_for(lambda: os.path.exists(path), what="variables.json to be written")
    bad, reads = [], [0]
    done = threading.Event()

    def reader():
        while not done.is_set():
            with open(path) as f:
                fcntl.flock(f, fcntl.LOCK_SH)
                text = f.read()
                fcntl.flock(f, fcntl.LOCK_UN)
            reads[0] += 1
            try:
                json.loads(text)["X"]["value"]
            except (ValueError, KeyError, TypeError):
                bad.append(text[:80])

    t = threading.Thread(target=reader, daemon=True)
    t.start()
    try:
        for i in range(1, 300):
            persist(i)
    finally:
        done.set()
        t.join(10)
    assert reads[0] > 100, f"only {reads[0]} reads; this proves nothing"
    assert not bad, f"{len(bad)} of {reads[0]} locked reads were not the whole file: {bad[:3]}"


def test_get_setting_waits_out_a_shared_lock(fppd):
    """scripts/common's getSetting reads a setting while another reader
    (PHP, fppd) holds a shared lock on the settings file, instead of
    returning nothing.

    Regression: efb6fcf92. It took an exclusive lock with flock -n, which
    gives up at once while any lock is held -- every page load takes a
    shared one -- and then exit 1'd its $(...) subshell: the caller got an
    empty value."""
    if not os.path.exists("/usr/bin/flock"):
        pytest.skip("getSetting only locks when /usr/bin/flock exists")
    fppd.settings(SomeTestSetting="expected-value")
    cfg = os.path.join(fppd.media, "settings")
    common = os.path.join(fppd.tree, "scripts", "common")
    with open(cfg) as f:
        fcntl.flock(f, fcntl.LOCK_SH)
        r = subprocess.run(["bash", "-c", f'. "{common}"; getSetting SomeTestSetting'],
                           capture_output=True, text=True, timeout=30,
                           env=dict(os.environ, FPPDIR=fppd.tree, CFGFILE=cfg, SETTINGSFILE=cfg))
        fcntl.flock(f, fcntl.LOCK_UN)
    assert r.stdout.strip() == "expected-value", (r.stdout, r.stderr[-2000:])
