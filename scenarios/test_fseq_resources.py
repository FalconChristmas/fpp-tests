"""Reading a sequence when the process is short of threads or memory.

Every open compressed (zstd or zlib) FSEQ decompresses its blocks ahead of
the player on a thread of its own, and every FSEQ effect opens the file
again, so a box running many at once can run out of threads; and a frame's
channel buffer is one allocation as big as the channels read, which a
512 MB controller can fail to make. Neither is fatal: the read-ahead is an
optimization, and a frame that can't be read is a frame not shown.
"""

import glob
import os
import time

import pytest

import shims
from fppd import sanitizer_runtime
from ddp import DdpReceiver
from fseq import unique_frames, write_fseq, write_fseq_reference
from show import CHANNELS, ddp_output, playlist, sequence_entry, status
from test_effects import running
from test_playback import assert_faithful, start, wait_idle

pytest.importorskip("zstandard")

STEP_MS = 50


@pytest.mark.parametrize("compression", ["zstd", "zlib"])
def test_a_compressed_sequence_plays_when_its_read_ahead_thread_cannot_start(fppd, compression):
    """With every FSEQ read-ahead thread failing to start (fseq_nothread.so
    throws std::thread's EAGAIN for it, nothing else), an eight-block
    compressed sequence plays through a playlist with every frame on the
    wire in order, the same file then runs twice as an FSEQ effect, and
    fppd is still up at the end.

    Regression: 158a9ca9f. The std::system_error from the read-ahead
    thread's constructor in prepareRead() was not caught, so fppd aborted
    the moment it opened the sequence; now it logs and getBlock() reads the
    blocks inline."""
    frames = unique_frames(160, CHANNELS)
    write_fseq_reference(os.path.join(fppd.media, "sequences", "Show.fseq"), frames,
                         step_ms=STEP_MS, compression=compression, blocks=8)
    fppd.write("playlists/Show.json", playlist("Show", [sequence_entry("Show.fseq")]))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")
    refused = os.path.join(fppd.media, "tmp", "nothread")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start(preload=[shims.build("fseq_nothread.c")],
                   extra_env={"FSEQ_NOTHREAD_FILE": refused})
        since = time.monotonic()
        start(fppd)
        wait_idle(fppd, timeout=len(frames) * STEP_MS / 1000 + 20)
        assert_faithful(frames, rx.snapshot(since))

        # Two effect copies of the file, each its own reader.
        for _ in range(2):
            fppd.command("FSEQ Effect Start", "Show", "false", "false", "false", "false")
        fppd.wait_for(lambda: running(fppd) == [], timeout=len(frames) * STEP_MS / 1000 + 20,
                      what="the effects to end")
    assert fppd.proc.poll() is None, "fppd exited"
    # The refusal was reached: the playlist's reader and both effects'.
    assert os.path.exists(refused) and len(open(refused).read().splitlines()) >= 3
    assert "reading blocks inline" in fppd.log()


def start_with_allocations_capped(fppd, mb):
    """Start fppd with the sanitizer's allocator refusing (returning null
    for) any single allocation over `mb` MB, as malloc does on a controller
    without the memory or address space. The allocator warns of each
    refusal; that goes to a log of its own, returned, for
    assert_only_refusals(), not to the one the harness fails a scenario on."""
    if not sanitizer_runtime(os.path.join(fppd.tree, "src", "fppd")):
        pytest.skip("needs a sanitizer build: its allocator is what is told to refuse")
    limited = os.path.join(fppd.media, "tmp", "limited")
    limit = f":max_allocation_size_mb={mb}:allocator_may_return_null=1:log_path={limited}"
    supp = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "sanitizers", "tsan.supp")
    fppd.start(extra_env={
        "ASAN_OPTIONS": "halt_on_error=1:detect_leaks=0:abort_on_error=0" + limit,
        "TSAN_OPTIONS": f"halt_on_error=0:suppressions={supp}" + limit,
    })
    return limited


def assert_only_refusals(limited):
    """The capped allocator's log holds refusals and nothing else."""
    for path in glob.glob(limited + "*"):
        other = [line for line in open(path, errors="replace").read().splitlines()
                 if line and "failed to allocate 0x" not in line]
        assert not other, "\n".join(other[:40])


# A frame of this many channels is over 1 MB, the largest allocation the
# sanitizer's allocator is then told to make.
BIG = 1200 * 1024


@pytest.mark.parametrize("version", [1, 2])
def test_a_frame_whose_buffer_cannot_be_allocated_is_skipped(fppd, version):
    """A DDP output of 1.2M channels makes fppd read every channel of a
    1.2M-channel sequence: each frame is one allocation of 1.2 MB.
    With the sanitizer's allocator refusing anything over 1 MB (returning
    null, as malloc does when a small controller is out of memory), the
    sequence still plays to its end and fppd stays up, logging each frame
    it couldn't allocate.

    Regression: 55d96e439. The frame readers didn't check the buffer, and
    read the channel data through the null pointer: fread(NULL, ...)
    faulted inside libc. (An uncompressed file: in a zstd one the
    decompressed block's own buffer is refused first, so the frame reader
    never gets as far as the copy.)"""
    frames = [bytes([i + 1]) * BIG for i in range(30)]
    write_fseq(os.path.join(fppd.media, "sequences", "Big.fseq"), frames, step_ms=STEP_MS,
               version=version)
    fppd.write("playlists/Big.json", playlist("Big", [sequence_entry("Big.fseq")]))
    fppd.write("config/co-universes.json", ddp_output(BIG))
    fppd.settings(DisableFakeNetworkBridges="1")
    limited = start_with_allocations_capped(fppd, 1)
    start(fppd, "Big")
    fppd.wait_for(lambda: status(fppd).get("current_sequence") == "Big.fseq", timeout=10,
                  what="the sequence to start")
    wait_idle(fppd, timeout=len(frames) * STEP_MS / 1000 + 20)
    assert fppd.proc.poll() is None, "fppd exited"
    assert "Failed to allocate" in fppd.log()
    assert_only_refusals(limited)
