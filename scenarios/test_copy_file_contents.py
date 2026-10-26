"""CopyFileContents(), the file copy fppinit uses to install the WirePlumber
hook and refresh the PipeWire units, and the PRU loader uses to install a PRU
program. Run directly (tools/copycheck.cpp, linked against the tree's
libfpp): in a container nothing that reaches it reads what it returns."""

import os
import subprocess
import tempfile

from fppd import sanitizer

HERE = os.path.dirname(os.path.abspath(__file__))

_tool = None


def tool():
    """tools/copycheck.cpp built against the tree under test, once per run."""
    global _tool
    if _tool is None:
        src = os.path.join(os.environ["FPP_TREE"], "src")
        out = os.path.join(tempfile.mkdtemp(prefix="copycheck-"), "copycheck")
        flags = {"asan": ["-fsanitize=address"], "tsan": ["-fsanitize=thread"],
                 "ubsan": ["-fsanitize=undefined"]}.get(sanitizer(), [])
        cmd = ["g++", "-std=gnu++20", "-g", "-O1", *flags, f"-I{src}",
               os.path.join(HERE, "..", "tools", "copycheck.cpp"),
               f"-L{src}", "-lfpp", f"-Wl,-rpath,{src}", "-o", out]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError("building copycheck failed:\n" + r.stderr[-4000:])
        _tool = out
    return _tool


def copy(src, dest):
    env = dict(os.environ, ASAN_OPTIONS="halt_on_error=1:detect_leaks=0")
    r = subprocess.run([tool(), src, dest], capture_output=True, text=True, timeout=30, env=env)
    assert r.returncode == 0, f"copycheck exited {r.returncode}\n{r.stderr[-3000:]}"
    return r.stdout.strip() == "1", r.stderr


def test_copy_file_contents_reports_a_good_copy_as_good():
    """A copy of a non-empty file succeeds, says so, and leaves the same
    bytes at the destination; an empty file copies too; a source that
    doesn't exist is a failure.

    Regression: 178cb1ea6. sendfile() returns the number of bytes it
    copied, and CopyFileContents() took anything but 0 as a failure: every
    copy of a non-empty file reported failure (and the PRU loader that
    checks it refused to start a program it had installed), and an empty
    one reported success."""
    d = tempfile.mkdtemp(prefix="copy-")
    data = bytes(range(256)) * 300
    src = os.path.join(d, "src.conf")
    with open(src, "wb") as f:
        f.write(data)
    ok, err = copy(src, os.path.join(d, "dest.conf"))
    assert ok, f"a {len(data)}-byte copy was reported as failed: {err}"
    with open(os.path.join(d, "dest.conf"), "rb") as f:
        assert f.read() == data, "the copy is not the source"
    assert "Unable to copy" not in err, err

    empty = os.path.join(d, "empty")
    open(empty, "w").close()
    ok, err = copy(empty, os.path.join(d, "empty.copy"))
    assert ok and os.path.getsize(os.path.join(d, "empty.copy")) == 0, err

    ok, _ = copy(os.path.join(d, "missing"), os.path.join(d, "missing.copy"))
    assert not ok, "a copy of a missing file was reported as good"
