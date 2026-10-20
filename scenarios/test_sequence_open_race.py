"""Two sequence opens at once, from different threads, while the first is
still telling its MultiSync remotes about it."""

import os
import threading
import time

import shims
from ddp import DdpReceiver
from fseq import unique_frames, write_fseq
from show import CHANNELS, ddp_output, playlist, sequence_entry, status
from test_command_socket import send


def test_open_superseded_while_announcing_stands_down(fppd):
    """A sequence started from the command socket, then another started over
    the API while the first is still sending its MultiSync open packet: the
    second one plays, from its first frames, and nothing of the first
    reaches the lights after it.

    Regression: 84996da33. The open released its lock while it sent the
    open packet, and when it took it back it replaced whatever had been
    opened meanwhile, without clearing that one's frame cache or read
    position: frames of one sequence played under the other's name.
    The open packet is made slow (300 ms) with slowsyncopen.so.
    """
    a = unique_frames(400, CHANNELS)
    b = unique_frames(400, CHANNELS, first=1000)
    write_fseq(os.path.join(fppd.media, "sequences", "A.fseq"), a)
    write_fseq(os.path.join(fppd.media, "sequences", "B.fseq"), b)
    fppd.write("playlists/B.json", playlist("B", [sequence_entry("B.fseq")]))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1", MultiSyncEnabled="1", MultiSyncRemotes="127.0.0.2")
    which = {f: ("A", i) for i, f in enumerate(a)}
    which.update({f: ("B", i) for i, f in enumerate(b)})
    with DdpReceiver(CHANNELS) as rx:
        fppd.start(preload=[shims.build("slowsyncopen.c")], extra_env={"SLOWSYNCOPEN_MS": "300"})
        t = threading.Thread(target=lambda: send("StartSequence,A.fseq,0", timeout=10), daemon=True)
        t.start()
        time.sleep(0.05)
        fppd.command("Start Playlist", "B", "false", "false")
        t.join(10)
        fppd.wait_for(lambda: status(fppd).get("current_sequence") == "B.fseq", timeout=5,
                      what="B to play")
        time.sleep(3)
        seen = [which.get(d[:CHANNELS]) for _, d in rx.snapshot()]
        fppd.command("Stop Now")
    seen = [s for s in seen if s]
    first_b = next((k for k, s in enumerate(seen) if s[0] == "B"), None)
    assert first_b is not None, f"B never reached the lights: {seen[:10]}"
    after = seen[first_b:]
    assert all(s[0] == "B" for s in after), \
        f"A's frames after B started: {[s for s in after if s[0] == 'A'][:5]}"
    assert after[0][1] <= 2, f"B started on the wire at frame {after[0][1]}"
    idx = [s[1] for s in after]
    assert idx == sorted(idx), f"B's frames out of order: {idx[:20]}"
