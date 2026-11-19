"""The crash report's count of fppd's open file descriptors by kind."""

import os
import re
import signal
import subprocess
import sys
import textwrap

import pytest

from fppd import describe_rc, sanitizer
from test_crash_reports import private_fppdir, report_texts

pytestmark = pytest.mark.skipif(sanitizer() == "tsan",
                                reason="the crash handler is signal-unsafe by design")

SECRET = "Smith-Family-Show-2026"


def test_a_crash_report_counts_fppds_open_descriptors_even_at_the_lowest_level(fppd):
    """A report at "stack traces only" has fppd_open_files.txt: fppd's open
    descriptors counted by kind, with its descriptor limit, taken from the
    crashed process itself.

    Added in 0bc731f4f. A player that leaks descriptors crashes once it reaches
    its limit, typically as a library asserting on EMFILE far from the leak,
    and nothing in a report said which kind of descriptor had piled up.
    """
    os.makedirs(os.path.join(fppd.media, "crashes"), exist_ok=True)
    fppd.settings(ShareCrashData="1")
    fppd.start()
    fppd.proc.send_signal(signal.SIGABRT)
    try:
        rc = fppd.proc.wait(timeout=180)
    except subprocess.TimeoutExpired:
        raise TimeoutError(f"the crash handler did not finish within 180s\n{fppd.tail()}")
    fppd.exit_expected = True
    assert rc == 255, f"fppd exited with {describe_rc(rc)}, not the crash handler's _exit(-1)\n{fppd.tail()}"
    texts = report_texts(fppd, os.path.join(fppd.media, "crashes"))
    names = sorted(texts)
    assert not any(n.endswith("logs/fppd.log") for n in names), f"not a level 1 report: {names}"
    listing = next((t for n, t in texts.items() if n.endswith("fppd_open_files.txt")), None)
    assert listing is not None, f"no fppd_open_files.txt in the report: {names}"
    assert "Max open files" in listing, listing
    # fppd always holds its listening sockets: proof the listing is fppd's
    assert re.search(r"^\s*\d+ socket:\[N\]$", listing, re.M), listing


def test_the_open_descriptor_count_names_kinds_not_files(fppd, tmp_path):
    """The listing counts each kind and carries no names: a media file is
    reduced to its folder, a file outside the system paths to "(other file)",
    and socket and pipe numbers are dropped.

    Added in 0bc731f4f, which ships the listing at every share level."""
    videos = os.path.join(fppd.media, "videos")
    os.makedirs(videos, exist_ok=True)
    media_file = os.path.join(videos, f"{SECRET}.mp4")
    other_dir = tmp_path / f"{SECRET}-dir"
    other_dir.mkdir()
    other_file = other_dir / "notes.txt"
    for p in (media_file, other_file):
        with open(p, "w") as f:
            f.write("x")
    holder = subprocess.Popen([sys.executable, "-c", textwrap.dedent(f"""
        import os, socket, sys, time
        keep = [open({media_file!r}), open({str(other_file)!r})]
        keep += [os.eventfd(0) for _ in range(5)]
        keep += [socket.socket() for _ in range(3)]
        keep += list(os.pipe())
        print("ready", flush=True)
        time.sleep(120)
    """)], stdout=subprocess.PIPE, text=True)
    try:
        assert holder.stdout.readline().strip() == "ready"
        view = private_fppdir(fppd.tree, fppd.media)
        out = os.path.join(fppd.media, "report.zip")
        r = subprocess.run(["bash", os.path.join(view, "scripts", "generate_crash_report"), "1", out],
                           capture_output=True, text=True, timeout=120,
                           env={**os.environ, "FPPD_PID": str(holder.pid)})
        assert r.returncode == 0, f"rc {r.returncode}\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}"
    finally:
        holder.kill()
        holder.wait()
    import zipfile
    with zipfile.ZipFile(out) as z:
        names = z.namelist()
        assert "fppd_open_files.txt" in names, names
        listing = z.read("fppd_open_files.txt").decode()
    assert SECRET not in listing, f"a file name reached the listing:\n{listing}"
    assert re.search(r"^\s*5 anon_inode:\[eventfd\]$", listing, re.M), listing
    assert re.search(r"^\s*3 socket:\[N\]$", listing, re.M), listing
    pipes = re.search(r"^\s*(\d+) pipe:\[N\]$", listing, re.M)  # the helper's stdout is one too
    assert pipes and int(pipes.group(1)) >= 2, listing
    assert re.search(rf"^\s*1 {re.escape(videos)}/\*$", listing, re.M), listing
    assert re.search(r"^\s*\d+ \(other file\)$", listing, re.M), listing
