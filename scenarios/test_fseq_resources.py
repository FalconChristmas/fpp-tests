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


def refusals(limited):
    """The allocations the capped allocator refused, one line each."""
    return [line for path in glob.glob(limited + "*")
            for line in open(path, errors="replace").read().splitlines()
            if "failed to allocate 0x" in line]


def test_reading_a_zstd_sequence_allocates_for_its_blocks_only(fppd):
    """Three copies of a small zstd sequence run at once as FSEQ effects,
    each reading the file through its own handler, with the sanitizer's
    allocator refusing anything over 16 MB. None of them asks for that
    much: a reader's buffers are sized by the file's blocks.

    Regression: 991dbcbf1. The zstd handler's constructor
    allocated its writer's 32 MB staging buffer (8 MB on a box with 1 GB
    or less) for readers too, which never use it. Every FSEQ effect is a
    reader of its own, so a 32 bit player running a few dozen at once ran
    out of address space, and the next thread fppd started threw."""
    with open("/proc/meminfo") as f:
        total_kb = int(next(l for l in f if l.startswith("MemTotal:")).split()[1])
    if total_kb <= 1024 * 1024:
        pytest.skip("with 1 GB or less the staging buffer is 8 MB, under the cap")
    frames = unique_frames(200, CHANNELS)
    write_fseq(os.path.join(fppd.media, "sequences", "Small.fseq"), frames,
               step_ms=STEP_MS, compression="zstd")
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")
    limited = start_with_allocations_capped(fppd, 16)
    assert refusals(limited) == [], "refused before any effect started"
    for _ in range(3):
        fppd.command("FSEQ Effect Start", "Small", "false", "false", "false", "false")
    fppd.wait_for(lambda: len(running(fppd)) == 3, timeout=5, what="the three effects to run")
    fppd.wait_for(lambda: running(fppd) == [], timeout=len(frames) * STEP_MS / 1000 + 20,
                  what="the effects to end")
    assert fppd.proc.poll() is None, "fppd exited"
    assert refusals(limited) == [], "\n".join(refusals(limited)[:10])


def test_a_sequence_whose_read_thread_cannot_start_is_not_opened(fppd):
    """A remote opens its first sequence on the master's sync packets, from
    the main loop, and that first open starts the sequence read thread.
    With the thread failing to start (fseq_nothread.so throws std::thread's
    EAGAIN for it once), that open fails and fppd stays up; the syncs that
    follow open the sequence and the remote plays it.

    Regression: 991dbcbf1. On a remote whose first sync packet came after
    dozens of FSEQ effects had used up the address space, the uncaught
    std::system_error from that thread's constructor aborted fppd. (Over
    HTTP the command catch of 5504aa6e0 already stopped it.)"""
    import socket
    from multisync import PORT, sync_packet
    frames = unique_frames(400, CHANNELS)
    write_fseq(os.path.join(fppd.media, "sequences", "Show.fseq"), frames, step_ms=STEP_MS)
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1", fppMode="remote")
    refused = os.path.join(fppd.media, "tmp", "nothread")
    fppd.start(preload=[shims.build("fseq_nothread.c")],
               extra_env={"FSEQ_NOTHREAD_FILE": refused, "FSEQ_NOTHREAD_MATCH": "P8Sequence",
                          "FSEQ_NOTHREAD_LIMIT": "1"})
    time.sleep(1)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        began = time.monotonic()

        def sync():
            t = time.monotonic() - began
            sock.sendto(sync_packet("sync", "fseq", int(t * 1000 / STEP_MS), t, "Show.fseq"),
                        ("127.0.0.1", PORT))
            return status(fppd).get("current_sequence") == "Show.fseq"

        fppd.wait_for(sync, timeout=10, interval=0.25, what="the remote to play Show.fseq")
    finally:
        sock.close()
    assert fppd.proc.poll() is None, "fppd exited"
    assert os.path.exists(refused) and len(open(refused).read().splitlines()) == 1, \
        "the read thread's start was never refused"
    assert "Could not start the sequence read thread" in fppd.log()


def stack_room(pid, tid):
    """How far a blocked thread's stack pointer is above the bottom of the
    mapping it is in: the room its stack has to grow into. (Measured down
    from the pointer, so a mapping the kernel merged above doesn't count.)"""
    with open(f"/proc/{pid}/task/{tid}/syscall") as f:
        fields = f.read().split()
    sp = int(fields[-2], 16)
    with open(f"/proc/{pid}/maps") as f:
        for line in f:
            lo, hi = (int(x, 16) for x in line.split()[0].split("-"))
            if lo <= sp < hi:
                return sp - lo
    raise AssertionError(f"no mapping holds sp {sp:#x}")


def test_a_read_ahead_thread_has_a_small_stack(fppd):
    """A looping FSEQ effect on a zstd file has a read-ahead thread of its
    own, and that thread's stack is a few hundred KB, not the 8 MB a thread
    gets by default.

    Regression: 614451021. The read-ahead thread was a std::thread, with the default
    stack: 8 MB of address space for each open compressed sequence, and
    every FSEQ effect is one, which a 32 bit player running dozens of them
    could not spare."""
    write_fseq(os.path.join(fppd.media, "sequences", "Loop.fseq"), unique_frames(400, CHANNELS),
               step_ms=STEP_MS, compression="zstd")
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    fppd.command("FSEQ Effect Start", "Loop", "true", "false", "false", "false")
    pid = fppd.proc.pid

    def readers():
        out = []
        for comm in glob.glob(f"/proc/{pid}/task/*/comm"):
            try:
                if open(comm).read().strip() == "FSEQReadThread":
                    out.append(comm.split("/")[-2])
            except OSError:
                pass
        return out

    fppd.wait_for(lambda: readers(), timeout=5, what="the effect's read-ahead thread")
    time.sleep(0.5)  # let it settle into its wait
    room = stack_room(pid, readers()[0])
    fppd.command("Effects Stop")
    assert room < 1024 * 1024, f"the read-ahead thread's stack has {room // 1024} KB"
