"""MultiSync, both sides: fppd as master (what it announces, captured off the
loopback interface) and as remote (driven by sync packets this test sends)."""

import socket
import time

from capture import UdpCapture
from ddp import DdpReceiver
from fseq import unique_frames, write_fseq
from multisync import PORT, parse_sync, sync_packet
from show import CHANNELS, ddp_output, install, status

STEP_MS = 50
REMOTE = "127.0.0.2"


def test_master_announces_what_it_plays(fppd):
    """As master, fppd tells its remotes to open and start the sequence,
    keeps them in sync with frame numbers that match its own output, and
    tells them to stop.

    - open, then start, both at frame 0, naming the sequence;
    - sync packets with strictly increasing frames, no more than 10 apart,
      whose seconds field is frame x step time;
    - each sync's frame within 2 of what the master's own lights showed at
      that moment;
    - stop after Stop Now, then blanking.
    """
    frames = unique_frames(400, CHANNELS)
    lookup = {f: i for i, f in enumerate(frames)}
    with UdpCapture(PORT, REMOTE) as cap, DdpReceiver(CHANNELS) as rx:
        install(fppd, frames, step_ms=STEP_MS)
        fppd.settings(MultiSyncEnabled="1", MultiSyncRemotes=REMOTE)
        fppd.start()
        fppd.command("Start Playlist", "Show", "false", "false")
        time.sleep(5)
        fppd.command("Stop Now")
        time.sleep(1.5)
        packets = cap.snapshot()
        wire = [(t, lookup.get(d[:CHANNELS])) for t, d in rx.snapshot()]

    syncs = [s for s in (parse_sync(t, p) for t, _, _, p in packets) if s]
    ours = [s for s in syncs if s.filename == "Show.fseq" and s.file_type == "fseq"]
    actions = [s.action for s in ours]
    assert actions[:2] == ["open", "start"], f"sequence of announcements: {actions[:6]}"
    assert ours[0].frame == 0 and ours[1].frame == 0, ours[:2]
    assert actions[-1] == "stop", f"last announcement was {actions[-1]}"

    beats = [s for s in ours if s.action == "sync"]
    assert len(beats) >= 8, f"only {len(beats)} sync packets in 5 s"
    for a, b in zip(beats, beats[1:]):
        assert b.frame > a.frame, f"sync frames went from {a.frame} to {b.frame}"
        assert b.frame - a.frame <= 10, f"sync gap of {b.frame - a.frame} frames"
    for s in beats:
        assert abs(s.seconds - s.frame * STEP_MS / 1000) < 0.002, \
            f"frame {s.frame} announced as {s.seconds:.3f} s"
        shown = [i for t, i in wire if t <= s.time and i is not None]
        assert shown and abs(shown[-1] - s.frame) <= 2, \
            f"sync said frame {s.frame} while the master showed {shown[-1] if shown else None}"

    stop_at = next(s.time for s in ours if s.action == "stop")
    blanks = [t for t, _, _, p in packets if p[:4] == b"FPPD" and p[4] == 0x03 and t >= stop_at]
    assert blanks, "no blanking packet after stop"


def test_remote_follows_its_master(fppd):
    """As remote, fppd plays what sync packets tell it to: it opens and
    starts the sequence, its output follows the master's frame numbers
    (including a jump), and it stops and goes dark on stop."""
    frames = unique_frames(600, CHANNELS)
    lookup = {f: i for i, f in enumerate(frames)}
    write_fseq(f"{fppd.media}/sequences/Show.fseq", frames, step_ms=STEP_MS)
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1", fppMode="remote")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def send(action, frame=0):
        sock.sendto(sync_packet(action, "fseq", frame, frame * STEP_MS / 1000, "Show.fseq"),
                    ("127.0.0.1", PORT))

    def shown_since(t):
        return [lookup.get(d[:CHANNELS]) for tt, d in rx.snapshot(since=t)]

    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        assert status(fppd).get("mode_name") == "remote", status(fppd).get("mode_name")
        send("open")
        time.sleep(0.5)
        send("start")
        began = time.monotonic()
        for _ in range(8):
            time.sleep(0.5)
            frame = round((time.monotonic() - began) * 1000 / STEP_MS)
            send("sync", frame)
        fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", timeout=5,
                      what="the remote to report playing")
        assert status(fppd).get("current_sequence") == "Show.fseq", status(fppd)
        now_frame = round((time.monotonic() - began) * 1000 / STEP_MS)
        recent = [i for i in shown_since(time.monotonic() - 0.3) if i is not None]
        assert recent and abs(recent[-1] - now_frame) <= 4, \
            f"remote showing frame {recent[-1] if recent else None}, master at {now_frame}"

        # The master jumps ahead (a seek, or a master restarted mid-show).
        jumped = time.monotonic()
        for k in range(6):
            send("sync", 400 + k * 10)
            time.sleep(0.5)
        later = [i for i in shown_since(jumped + 1.0) if i is not None]
        assert later and min(later) >= 390, \
            f"remote did not follow the jump to frame 400: showed {later[:5]}"

        send("stop")
        fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=10,
                      what="the remote to stop")
        time.sleep(0.5)
        assert not any(rx.last()), "the remote's output was left lit after stop"
    sock.close()
