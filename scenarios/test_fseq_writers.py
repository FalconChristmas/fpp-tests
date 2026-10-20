"""FSEQ writer failures and very large frames, through fsequtils: the zlib
writer with a frame larger than its output buffer, a zstd writer whose
compressor fails, and an output file that cannot be created. Output is
read back with test_fsequtils' independent reader."""

import os
import subprocess

import pytest

import shims
from fppd import sanitizer_runtime
from fseq import write_fseq_reference
from test_fsequtils import fsequtils, read_fseq, src  # noqa: F401 -- src is a fixture


def run_tool(args, timeout=120, preload=(), **env):
    """fsequtils with extra preloads (after its sanitizer runtime) and
    environment; returns the CompletedProcess."""
    tool = os.path.join(os.environ["FPP_TREE"], "src", "fsequtils")
    if not os.path.exists(tool):
        pytest.skip("no fsequtils in the tree under test")
    full = dict(os.environ, **env)
    if preload:
        full["LD_PRELOAD"] = " ".join(sanitizer_runtime(tool) + list(preload))
    return subprocess.run([tool, *map(str, args)], capture_output=True, text=True,
                          timeout=timeout, env=full)


def test_zlib_frame_as_large_as_the_output_buffer(tmp_path):
    """Converting to zlib, on a box with 512 MB of RAM (an 8 MB output
    buffer), a sequence of frames as large as FSEQ allows (8M channels) of
    data that doesn't compress reads back every channel of every frame.

    Coverage for 3cdf04aa0, which made the writer call deflate() until a
    frame's input is all taken: once per frame, a call that filled the
    output buffer left the rest unconsumed and the next frame replaced it
    (shown then with 40M-channel frames). Channel space has since been
    capped at 8M (02d0e8cdc), and an 8M frame into the smallest (8 MB)
    buffer is all taken by deflate's internal buffering, so this passes
    without that fix too; it guards the case nearest to it that remains.
    """
    channels, count = 8 * 1024 * 1024, 3
    frames = [os.urandom(channels) for _ in range(count)]  # incompressible
    path = str(tmp_path / "big.fseq")
    write_fseq_reference(path, frames, step_ms=50)
    out = str(tmp_path / "big-zlib.fseq")
    r = run_tool(["-c", "zlib", "-o", out, path], timeout=300,
                 preload=[shims.build("smallmem.c")], SMALLMEM_MB="512")
    assert r.returncode == 0 and "Sanitizer" not in r.stderr, (r.stdout + r.stderr)[-2000:]
    hdr, got = read_fseq(out)
    assert hdr["compression"] == 2 and hdr["channels"] == channels, hdr
    bad = [i for i in range(count) if got[i] != frames[i]]
    assert not bad, f"frames {bad} of {count} read back different"


def test_zstd_compressor_failure_ends_the_write(src, tmp_path):  # noqa: F811
    """A zstd write whose compressor fails on every call ends, with the
    failure logged, instead of spinning.

    Regression: 3cdf04aa0. ZSTD_compressStream2()'s result was never
    checked: an error consumes no input, so the frame loop called it again
    forever, and the end-of-block loop, testing "> 0", never ended on an
    error code either. The zstd half of the zlib hang be17a58e8 fixed."""
    log = str(tmp_path / "zstdfail.log")
    try:
        r = run_tool(["-c", "zstd", "-o", str(tmp_path / "out.fseq"), src[0]], timeout=60,
                     preload=[shims.build("zstdfail.c")], ZSTDFAIL_LOG=log)
    except subprocess.TimeoutExpired:
        pytest.fail("fsequtils was still writing 60 s after zstd started failing")
    assert os.path.exists(log), "the failing compressor was never called; this proves nothing"
    assert "Sanitizer" not in r.stderr, r.stderr[-4000:]
    assert "zstd could not" in r.stdout + r.stderr, (r.stdout + r.stderr)[-2000:]


@pytest.mark.parametrize("where", ["missing directory", "read-only directory"])
def test_output_that_cannot_be_created(src, tmp_path, where):  # noqa: F811
    """fsequtils writing to a path it cannot create (a directory that isn't
    there, one it may not write in) fails with an error and a non-zero exit.

    Regression: 506bfe12b. The writer's constructor called
    flock(fileno(file)) before anyone checked the fopen(), so a NULL file
    was a SIGSEGV (seen as a crash loop from a capture command)."""
    if where == "missing directory":
        out = tmp_path / "nowhere" / "out.fseq"
    else:
        ro = tmp_path / "ro"
        ro.mkdir()
        ro.chmod(0o555)
        if os.access(ro, os.W_OK):
            pytest.skip("running as root: a read-only directory is still writable")
        out = ro / "out.fseq"
    rc, stdout, err = fsequtils("-o", str(out), src[0])
    assert rc > 0, f"exit {rc}\n{(stdout + err)[-2000:]}"
    assert "Failed to create FSEQ file" in stdout, stdout + err
    assert not out.exists()
