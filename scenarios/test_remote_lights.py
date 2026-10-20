"""A MultiSync remote's lights go out with the master's, to well under a
frame.

This script is the master: it sends frame F's sync packet when F would go on
its wire (a master sends it just before the frame), every ten frames. The
remote's frames are timed off DDP on loopback against that timeline.
"""

import socket
import statistics
import time

import pytest

from ddp import DdpReceiver
from fseq import unique_frames, write_fseq
from multisync import PORT, sync_packet
from show import CHANNELS, ddp_output


@pytest.mark.parametrize("step_ms", [50, 25])
def test_remote_lights_hold_to_the_master(fppd, step_ms):
    """A remote whose lights start a frame and a half behind the master's
    pulls them in: from 10 s on, frames go out within 10 ms of the master's
    (median), with a 10-90% spread under 15 ms.

    Regression: 3d20ab6c7. The remote compared frame counts only, once a
    packet: its counter is already the next frame between passes, so in step
    it read one ahead of the master's, and only two frames' difference was
    corrected. A
    remote sat anywhere from on time to two frames late, never early -- 47-87
    ms at 20 fps on a BBB -- and one that started 1.5 frames late stayed
    there. Now the master's packets drive the same phase servo a player's
    media does.

    40 fps on 35d0909f9: +18.6 ms (Pi 5 run-local), +19.6 ms (BBB); on
    3d20ab6c7: +0.4 / +2.0 ms. At 20 fps the frame logic happened to catch
    this start before the fix (+0.9 / +2.5 ms); +0.4 / +2.1 ms after."""
    fps = 1000 // step_ms
    secs = 40
    frames = unique_frames(secs * fps, CHANNELS)
    lookup = {f: i for i, f in enumerate(frames)}
    write_fseq(f"{fppd.media}/sequences/Show.fseq", frames, step_ms=step_ms)
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1", fppMode="remote")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def send(action, frame=0):
        sock.sendto(sync_packet(action, "fseq", frame, frame * step_ms / 1000, "Show.fseq"),
                    ("127.0.0.1", PORT))

    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        send("open")
        time.sleep(0.5)
        send("start")
        # The master's frame 0 went out a frame and a half before the
        # remote's: the remote starts that far behind.
        t0 = time.monotonic() - 1.5 * step_ms / 1000
        f = 10
        while f < secs * fps - 10:
            due = t0 + f * step_ms / 1000
            while time.monotonic() < due:
                time.sleep(0.0005)
            send("sync", f)
            f += 10
        received = rx.snapshot()
        send("stop")
    sock.close()
    first = {}
    for t, d in received:
        i = lookup.get(d[:CHANNELS])
        if i is not None:
            first.setdefault(i, t)
    offs = [(first[i] - (t0 + i * step_ms / 1000)) * 1000 for i in sorted(first) if i * step_ms >= 10000]
    assert len(offs) > (secs - 12) * fps, f"only {len(offs)} frames seen from 10 s on"
    med = statistics.median(offs)
    dec = statistics.quantiles(offs, n=10)
    print(f"\n{fps} fps: remote frame minus master's, ms: median {med:+.1f}, 10-90% {dec[0]:+.1f}..{dec[-1]:+.1f}")
    assert abs(med) <= 10, f"the remote's lights sit {med:+.1f} ms from the master's"
    assert dec[-1] - dec[0] <= 15, f"the remote's lights wander {dec[-1] - dec[0]:.1f} ms (10-90%)"
