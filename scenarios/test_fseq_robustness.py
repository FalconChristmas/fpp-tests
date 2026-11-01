"""Sequence files that are damaged, hand-made or changed under fppd.

An FSEQ file is user data: xLights writes it, but so do other tools, a
half-finished upload leaves a truncated one, and its headers carry counts
and offsets that nothing else vouches for. Each scenario here plays one such
file and then a good sequence, which must still play every frame intact --
so a crash, a sanitizer report, a wedge or a player left broken all fail.
"""

import os
import struct
import subprocess
import time
import urllib.error

import pytest

from ddp import DdpReceiver
from fseq import unique_frames, write_fseq_reference
from show import CHANNELS, ddp_output, install, status
from test_fseq_resources import assert_only_refusals, start_with_allocations_capped
from test_playback import assert_faithful, start, wait_idle

STEP_MS = 50


def v2(frames, compression=None, blocks=1, sparse=None, vheaders=b""):
    """A reference-written v2 file as bytes, with extra variable headers
    appended after the writer's own (they end the header block, so a header
    that runs off its end runs off the buffer fppd reads it into)."""
    path = f"/tmp/fseq-robust-{os.getpid()}.fseq"
    write_fseq_reference(path, frames, step_ms=STEP_MS, compression=compression,
                         blocks=blocks, sparse=sparse)
    with open(path, "rb") as f:
        data = bytearray(f.read())
    os.unlink(path)
    if vheaders:
        off = struct.unpack_from("<H", data, 4)[0]
        data[off:off] = vheaders
        struct.pack_into("<H", data, 4, off + len(vheaders))
    return data


def vheader(code, payload):
    return struct.pack("<H", len(payload) + 4) + code.encode() + payload


def play_bad_then_good(fppd, bad, name="Bad.fseq", good_frames=40):
    """Play `bad`, then a good sequence; the good one must be faithful.
    Returns what the receiver saw while the bad one played."""
    frames = unique_frames(good_frames, CHANNELS)
    with DdpReceiver(CHANNELS) as rx:
        install(fppd, frames, step_ms=STEP_MS)
        with open(os.path.join(fppd.media, "sequences", name), "wb") as f:
            f.write(bytes(bad))
        fppd.start()
        try:
            fppd.command("Start Playlist", name, "false", "false")
        except urllib.error.HTTPError:
            pass  # refused is fine; surviving it is the point
        wait_idle(fppd, timeout=30)
        time.sleep(0.5)
        during = rx.snapshot()
        since = time.monotonic()
        start(fppd)
        wait_idle(fppd, timeout=20)
        time.sleep(0.3)
        assert_faithful(frames, rx.snapshot(since=since))
    return during


def test_block_count_larger_than_the_header(fppd):
    """A v2 header claiming 4095 compression blocks, with room for one, is
    clamped to the blocks it holds.

    Regression: 3cdf04aa0. The block table was read thousands of bytes past
    the header buffer (ASan heap overflow)."""
    pytest.importorskip("zstandard")
    data = v2(unique_frames(20, CHANNELS), compression="zstd")
    data[20] = (data[20] & 0x0F) | 0xF0
    data[21] = 0xFF
    play_bad_then_good(fppd, data)


def test_block_table_past_the_end_of_the_file(fppd):
    """A block table claiming more data than the file holds (a truncated
    upload) is clamped to the file.

    Regression: be17a58e8. Blocks starting past the end got a length of
    (next offset - own offset), which underflowed to nearly 2^64."""
    pytest.importorskip("zstandard")
    data = v2(unique_frames(30, CHANNELS), compression="zstd", blocks=3)
    struct.pack_into("<I", data, 32 + 8 + 4, 0x00FFFFFF)  # block 1's length
    play_bad_then_good(fppd, data)


def test_header_shorter_than_its_fixed_fields(fppd):
    """A v2 file whose header ends before the fixed 32-byte header does is
    refused, not read past.

    Regression: c1b081e83."""
    data = bytearray(b"PSEQ" + struct.pack("<HBB", 20, 0, 2) + b"\0" * 12)
    play_bad_then_good(fppd, data)


def test_sparse_range_outside_channel_space(fppd):
    """A sparse range whose start lies past the end of channel space is
    clamped where its data is copied into the channel buffer.

    Regression: 02d0e8cdc (#3048). The copy ran off the end of fppd's
    channel data."""
    # 2M channels from channel 15.7M: past the 8M channel buffer by more
    # than the copy, so the old copy faulted rather than landing quietly in
    # whatever is mapped next to it.
    n = 2_000_000
    data = v2([bytes([i + 1]) * n for i in range(3)], sparse=[(0, n)])
    data[32:35] = (0xF00000).to_bytes(3, "little")  # range 0's start channel
    play_bad_then_good(fppd, data)


def test_v1_sequence_narrower_than_an_output(fppd):
    """A v1 sequence of 150 channels, played with a second output whose
    channels start at 3001 -- wholly past the file's end -- plays every
    frame to the first output intact -- with fppd's allocations capped at
    1 GB, as a 32-bit controller's address space caps them.

    Regression: 078a49c97. V1FSEQFile::prepareRead clamped such a range to
    (channels in the file - range start), which underflowed, so every
    frame's buffer was sized at nearly 4 GB: on a 64-bit box an 8 MB copy
    of uninitialized memory into the channels past the file each frame; on
    a 32-bit one the allocation fails, and the frame was then read through
    the null pointer (since 55d96e439, not loaded at all). V2 files already
    skipped ranges past their end."""
    frames = unique_frames(40, CHANNELS)
    out = ddp_output(CHANNELS)
    past = ddp_output(100, address="127.0.0.3")["channelOutputs"][0]
    past["startChannel"] = past["universes"][0]["startChannel"] = 3001
    out["channelOutputs"].append(past)
    with DdpReceiver(CHANNELS, host="127.0.0.1") as rx:
        install(fppd, frames, step_ms=STEP_MS, version=1)
        fppd.write("config/co-universes.json", out)
        limited = start_with_allocations_capped(fppd, 1024)
        since = time.monotonic()
        start(fppd)
        wait_idle(fppd, timeout=20)
        time.sleep(0.3)
        assert_faithful(frames, rx.snapshot(since=since))
    assert_only_refusals(limited)


def test_unterminated_media_name(fppd):
    """An 'mf' (media file) header whose name has no NUL, at the end of
    the header block, is read only as far as its own length.

    Regression: 782d7a22f (#2993). Starting the .fseq as a playlist read
    the name with strrchr() off the end of the header data."""
    data = v2(unique_frames(20, CHANNELS), vheaders=vheader("mf", b"song" * 8))
    play_bad_then_good(fppd, data)


@pytest.mark.parametrize("payload", [
    b"\x01",
    b"\x01\x05\x00",
    b"\x01\x01\x00\x00\x00" + b"10.0.0.1",
    b"\x01\x01\x00\x00\x00\x00" + b"Preset",
    b"\x01\x01\x00\x00\x00\x00Preset\x00\x09\x00\x00\x00\x01\x00\x00\x00",
], ids=["version only", "short count", "ips unterminated", "command unterminated",
        "ranges short"])
def test_malformed_frame_command_header(fppd, payload):
    """A truncated 'FC' (frame commands) header is dropped and the
    sequence still plays.

    Regression: f660d469d. The parser read its strings with a bare
    std::string(char*) and its counts with no size check, running off the
    end of the header data while the sequence opened."""
    data = v2(unique_frames(20, CHANNELS), vheaders=vheader("FC", payload))
    play_bad_then_good(fppd, data)


def test_zero_step_time(fppd):
    """A header whose step time byte is 0 plays at the 50 ms default.

    Regression: 74d476d5d. Every consumer divided by it: SIGFPE on x86 and
    32-bit ARM. (On aarch64 a division by zero is 0, so the crash can't
    show there; fppd's log line saying the 0 was replaced can.)"""
    frames = unique_frames(40, CHANNELS)
    data = v2(frames)
    data[18] = 0
    during = play_bad_then_good(fppd, data)
    assert_faithful(frames, during)
    assert "step time 0, using 50ms" in fppd.log(), "the zero step time was not replaced"


def fc_header(entries):
    """An 'FC' header: version 1, no IP filter, then each preset name with
    its (start, stop) frame ranges."""
    out = b"\x01" + struct.pack("<I", len(entries)) + b"\0"
    for name, ranges in entries:
        out += name.encode() + b"\0" + struct.pack("<I", len(ranges))
        for s, e in ranges:
            out += struct.pack("<II", s, e)
    return out


def counter(name):
    return {"name": name, "command": "Set Variable",
            "args": [name, "Increment", "", "1", "0", "100", ""], "presetSlot": 0}


def variable(fppd, name):
    v = (fppd.get("/variables", timeout=5) or {}).get(name, {}).get("value")
    return int(float(v)) if v not in (None, "") else 0


def test_frame_commands_fire_once_per_play(fppd):
    """Presets attached to frames by an 'FC' header fire exactly once per
    play: on the first frame, mid-sequence, and the _END presets including
    one on the last frame, where the sequence closes. (Coverage: before
    4ae64c3a0 this played the same; the jump below is what it fixed.)

    Also ebde44039: running presets from 'FC' tracks stored in the fseq."""
    n = 60
    frames = unique_frames(n, CHANNELS)
    names = ["A", "B"]
    presets = []
    for p in names:
        presets += [counter(p), counter(p + "_END")]
    with DdpReceiver(CHANNELS):
        install(fppd, frames, step_ms=STEP_MS)
        fppd.write("config/commandPresets.json", {"commands": presets})
        with open(os.path.join(fppd.media, "sequences", "Show.fseq"), "wb") as f:
            f.write(bytes(v2(frames, vheaders=vheader("FC", fc_header([
                ("A", [(0, 30)]), ("B", [(20, n - 1)])])))))
        fppd.start()
        start(fppd)
        wait_idle(fppd, timeout=20)
        time.sleep(1)
        got = {p: variable(fppd, p) for p in names + [p + "_END" for p in names]}
    assert got == {"A": 1, "B": 1, "A_END": 1, "B_END": 1}, got


def test_sequence_truncated_while_playing(fppd):
    """A sequence file cut short while it plays (replaced by an upload, say)
    shows black for the frames it no longer has, not whatever the heap held.

    Regression: 34f0376e9. Frames were malloc()ed and returned even when
    the read failed, so a short read put uninitialised memory on the
    lights (0xbe under ASan, which fills fresh allocations with it)."""
    n = 200
    frames = unique_frames(n, CHANNELS)
    path = None
    with DdpReceiver(CHANNELS) as rx:
        install(fppd, frames, step_ms=STEP_MS)
        path = os.path.join(fppd.media, "sequences", "Show.fseq")
        data_offset = struct.unpack_from("<H", open(path, "rb").read(8), 4)[0]
        fppd.start()
        start(fppd)
        fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", what="playing")
        time.sleep(1.5)
        cut = time.monotonic()
        os.truncate(path, data_offset + 80 * CHANNELS)
        wait_idle(fppd, timeout=n * STEP_MS / 1000 + 20)
        time.sleep(0.3)
        after = [d for t, d in rx.snapshot(since=cut)]
    # A frame read across the cut can be part file (what stdio had already
    # buffered) and part zero-filled: each byte is the frame's own or 0. A
    # frame's first three channels name it (unique_frames).
    def from_the_file(d):
        idx = int.from_bytes(d[:3], "big") - 1
        f = frames[idx] if 0 <= idx < n else bytes(CHANNELS)
        return all(b == 0 or b == e for b, e in zip(d, f))
    strange = [d for d in after if not from_the_file(d)]
    assert after, "nothing was sent after the file was cut"
    assert not strange, (f"{len(strange)} frames after the cut were neither the "
                         f"sequence's nor black, e.g. {strange[0][:16].hex()}")



def test_frame_commands_skipped_by_a_jump_still_fire(fppd):
    """A remote catching up to its master skips frames; presets on the
    frames it skipped still fire, once.

    Regression: 4ae64c3a0. Triggers fired only for a frame actually sent,
    so a frame dropped by a catch-up jump -- often the one carrying an _END
    -- never fired. (A jump of more than 2 s is a seek, which fires only the
    frame landed on; this one is about 1.4 s.)"""
    import socket
    from multisync import PORT, sync_packet
    from show import ddp_output
    frames = unique_frames(200, CHANNELS)
    with open(os.path.join(fppd.media, "sequences", "Show.fseq"), "wb") as f:
        f.write(bytes(v2(frames, vheaders=vheader("FC", fc_header([("J", [(30, 34)])])))))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.write("config/commandPresets.json", {"commands": [counter("J"), counter("J_END")]})
    fppd.settings(DisableFakeNetworkBridges="1", fppMode="remote")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def send(action, frame=0):
        sock.sendto(sync_packet(action, "fseq", frame, frame * STEP_MS / 1000, "Show.fseq"),
                    ("127.0.0.1", PORT))

    with DdpReceiver(CHANNELS):
        fppd.start()
        send("open")
        time.sleep(1)
        send("start")
        time.sleep(0.5)  # about frame 10
        send("sync", 38)  # the master is ~28 frames on: jump over 30-34
        jumped = time.monotonic()
        while time.monotonic() - jumped < 2:
            time.sleep(0.25)
            send("sync", 38 + round((time.monotonic() - jumped) * 1000 / STEP_MS))
        send("stop")
        time.sleep(1.5)
        got = {p: variable(fppd, p) for p in ("J", "J_END")}
    sock.close()
    assert got == {"J": 1, "J_END": 1}, got


def vm_hwm_kb(fppd):
    with open(f"/proc/{fppd.proc.pid}/status") as f:
        for line in f:
            if line.startswith("VmHWM:"):
                return int(line.split()[1])
    return 0


def test_frame_command_header_with_many_ranges_stays_small(fppd):
    """An 'FC' header naming one long preset name over 5000 frame ranges
    (about 55 KB of header) costs fppd about that much to load, not a copy
    of the name per range. (The ranges lie past the last frame: firing
    them would churn through the sanitizer's quarantine and blur the
    measure.)

    Regression: 488190d50 (SP-7). The trigger table copied the name into
    every range, twice for a command (its _END twin too): 5000 ranges of a
    15 KB name grew fppd by about 150 MB, and a crafted header by hundreds.
    """
    name = "N" * 15000
    data = v2(unique_frames(20, CHANNELS),
              vheaders=vheader("FC", fc_header([(name, [(1000 + i, 1000 + i) for i in range(5000)])])))
    assert len(data) < 65536 - 1000, "the header must fit FSEQ's 16-bit data offset"
    frames = unique_frames(40, CHANNELS)
    with DdpReceiver(CHANNELS):
        install(fppd, frames, step_ms=STEP_MS)
        with open(os.path.join(fppd.media, "sequences", "Bad.fseq"), "wb") as f:
            f.write(bytes(data))
        fppd.start()
        # Playing any sequence the first time raises the peak (buffers, the
        # output thread); measure from after a plain one.
        start(fppd)
        wait_idle(fppd, timeout=30)
        before = vm_hwm_kb(fppd)
        fppd.command("Start Playlist", "Bad.fseq", "false", "false")
        wait_idle(fppd, timeout=30)
        grew = (vm_hwm_kb(fppd) - before) // 1024
        print(f"peak {before // 1024} MB before the header, grew {grew} MB")
    assert grew < 50, f"loading the header grew fppd's peak memory by {grew} MB"


def test_frame_effect_running_past_the_end_stops_with_the_sequence(fppd):
    """An effect an 'FE' header starts on frame 2 and ends past the last
    frame is stopped when the sequence ends, not left looping.

    Regression: 4ae64c3a0. Effects started by FE triggers loop, and nothing
    stopped one whose end frame the sequence never reached: it ran on after
    the show, until someone stopped it by hand.

    Also ebde44039: effects started from 'FE' tracks stored in the fseq.
    """
    from eseq import solid, write_eseq
    from test_effects import running
    frames = unique_frames(40, CHANNELS)  # 2 s
    with DdpReceiver(CHANNELS):
        install(fppd, frames, step_ms=STEP_MS)
        write_eseq(fppd, "E", solid(20, 3, 0x40), 101)
        with open(os.path.join(fppd.media, "sequences", "Show.fseq"), "wb") as f:
            f.write(bytes(v2(frames, vheaders=vheader("FE", fc_header([("E", [(2, 100000)])])))))
        fppd.start()
        start(fppd)
        fppd.wait_for(lambda: running(fppd) == ["E"], timeout=5, what="the FE effect to start")
        wait_idle(fppd, timeout=20)
        fppd.wait_for(lambda: running(fppd) == [], timeout=3,
                      what="the FE effect to stop with the sequence")


def test_frame_effect_starting_as_the_sequence_stops_is_stopped(fppd):
    """An 'FE' effect whose file is slow to open, so that it is still
    starting when Stop Now closes the sequence, is stopped once it has
    started instead of looping on.

    Regression: 488190d50 (SP-6). The effect started after the close had
    swapped out the list of effects to stop, so it was recorded nowhere
    and looped forever.
    """
    import shims
    from eseq import solid, write_eseq
    from test_effects import running
    frames = unique_frames(200, CHANNELS)  # 10 s
    with DdpReceiver(CHANNELS):
        install(fppd, frames, step_ms=STEP_MS)
        write_eseq(fppd, "E", solid(20, 3, 0x40), 101)
        with open(os.path.join(fppd.media, "sequences", "Show.fseq"), "wb") as f:
            f.write(bytes(v2(frames, vheaders=vheader("FE", fc_header([("E", [(2, 100000)])])))))
        fppd.start(preload=[shims.build("slowfileopen.c")],
                   extra_env={"SLOWFILEOPEN_SUFFIX": "/E.eseq", "SLOWFILEOPEN_MS": "2000"})
        start(fppd)
        time.sleep(0.5)
        fppd.command("Stop Now", timeout=20)
        wait_idle(fppd, timeout=20)
        time.sleep(3)
        assert running(fppd) == [], f"still running after the stop: {running(fppd)}"



def test_fsequtils_says_when_it_drops_channels(fppd, tmp_path):
    """fsequtils converting a file wider than FPP's channel space (8388608
    channels, a file written by another tool) says that it keeps only the
    first 8388608, rather than writing a shorter file without a word.

    Regression: 49b2a39e3. The conversion read and wrote only the first
    8388608 channels and printed nothing about the rest.
    """
    src = str(tmp_path / "wide.fseq")
    write_fseq_reference(src, [bytes([7]) * 8_400_000], step_ms=STEP_MS)
    r = subprocess.run([os.path.join(fppd.tree, "src", "fsequtils"), "-o", str(tmp_path / "out.fseq"), src],
                       capture_output=True, text=True, timeout=120,
                       env=dict(os.environ, LD_LIBRARY_PATH=os.path.join(fppd.tree, "src")))
    out = r.stdout + r.stderr
    assert r.returncode == 0, out
    assert "only the first 8388608 channels are used" in out, out


def test_output_wider_than_a_sparse_sequence_is_logged(fppd):
    """A sparse sequence storing only channels 1-75, played to a 150-channel
    output: fppd logs that the output asks for channels the file doesn't
    have, and the 75 it has play intact.

    Regression: 30b5a7439. Nothing said why the rest of the output stayed
    dark."""
    frames = unique_frames(40, CHANNELS)
    with DdpReceiver(CHANNELS) as rx:
        install(fppd, frames, step_ms=STEP_MS, sparse=[(0, 75)])
        fppd.start()
        since = time.monotonic()
        start(fppd)
        wait_idle(fppd, timeout=20)
        time.sleep(0.3)
        got = [d[:75] for _, d in rx.snapshot(since=since)]
    assert "Requested output range outside read ranges" in fppd.log(), \
        "no log line for the channels the file doesn't have"
    want = {f[:75] for f in frames}
    assert len(want & set(got)) >= 36, f"{len(want & set(got))} of 40 frames' stored channels seen"
