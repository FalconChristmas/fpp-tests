"""A MultiSync remote's lights go out with the master's, to well under a
frame.

This script is the master: it sends frame F's sync packet when F would go on
its wire (a master sends it just before the frame), every ten frames. The
remote's frames are timed off DDP on loopback against that timeline.
"""

import random
import socket
import statistics
import time

import pytest

from ddp import DdpReceiver
from fseq import unique_frames, write_fseq
from multisync import PORT, sync_packet
from show import CHANNELS, ddp_output


def _remote_frames(fppd, step_ms, behind=1.5, late_ms=lambda f: 0.0, secs=40):
    """Run as the master for a remote whose lights start `behind` frames
    behind; each sync packet goes out late_ms(frame) after its frame. The
    remote's frames from 10 s on: (index, ms after the master's)."""
    fps = 1000 // step_ms
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
        # The master's frame 0 went out `behind` frames before the remote's.
        t0 = time.monotonic() - behind * step_ms / 1000
        f = 10
        while f < secs * fps - 10:
            due = t0 + f * step_ms / 1000 + late_ms(f) / 1000
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
    out = [(i, (first[i] - (t0 + i * step_ms / 1000)) * 1000) for i in sorted(first) if i * step_ms >= 10000]
    assert len(out) > (secs - 12) * fps, f"only {len(out)} frames seen from 10 s on"
    return out


def _summary(label, got):
    """Median and 10-90% of the offsets, and the 99th-percentile frame gap
    error: offsets are against the master's timeline, so a change from one
    frame to the next is that gap's error."""
    offs = [o for _, o in got]
    med = statistics.median(offs)
    dec = statistics.quantiles(offs, n=10)
    gaps = sorted(abs(b - a) for (i, a), (j, b) in zip(got, got[1:]) if j == i + 1)
    gap = gaps[int(0.99 * len(gaps))]
    print(f"\n{label}: remote frame minus master's, ms: median {med:+.1f}, 10-90% {dec[0]:+.1f}..{dec[-1]:+.1f}, "
          f"99th-percentile frame gap error {gap:.1f} ms")
    return med, dec[-1] - dec[0], gap


@pytest.mark.parametrize("step_ms", [50, 25])
def test_remote_lights_hold_to_the_master(fppd, step_ms):
    """A remote whose lights start a frame and a half behind the master's
    pulls them in: from 10 s on, frames go out within 10 ms of the master's
    (median), with a 10-90% spread under 15 ms.

    Regression: 3d20ab6c7. The remote compared frame counts only, once a
    packet: its counter is already the next frame between passes, so in step
    it read one ahead of the master's, and only two frames' difference was
    corrected. At 40 fps that left a remote's lights about 0.7 frame late
    from any start; one also playing the show's audio settled a different
    distance late each start. Now the master's packets drive the same phase
    servo a player's media does.

    40 fps on 35d0909f9: +17.4 to +18.0 ms (Pi 5 run-local, starts 0.25-1.75
    frames behind), +19.8 to +22.2 ms (BBB); on 3d20ab6c7: +0.4 / +2.1 ms.
    At 20 fps the frame logic already held lights alone within 4 ms from any
    start (+0.9 / +2.5 ms here before the fix); +0.4 / +2.1 ms after."""
    med, spread, _ = _summary(f"{1000 // step_ms} fps", _remote_frames(fppd, step_ms))
    assert abs(med) <= 10, f"the remote's lights sit {med:+.1f} ms from the master's"
    assert spread <= 15, f"the remote's lights wander {spread:.1f} ms (10-90%)"


def test_remote_lights_ride_out_late_packets(fppd):
    """Sync packets that arrive late -- a busy master, the network, the
    remote's own scheduling -- don't move the remote's frames: with a third
    of them 10-40 ms late, its lights go out 10-90% within 8 ms of each
    other, and within 6 ms of the master's (median). The spread is what
    late packets move; the median only bounds it, since a busy Docker host
    alone puts it 2 ms late. (The frame gap error is printed, not judged:
    Docker's timer jitter puts its 99th percentile near 5 ms with no late
    packets at all.)

    Regression: d9b8f5d3b. The remote steered by every packet as it
    arrived, half the error each, so each late packet pulled its lights
    later and the next pulled them back. Now it steers by the earliest of
    the last two seconds.

    Median and 10-90%, parent -> d9b8f5d3b: Docker ASan +6.9 ms,
    +2.5..+19.4 -> +1.9 ms, +1.1..+5.1; run-local Pi 5 +5.5 ms, +1.7..+17.2
    -> +0.8 ms, +0.6..+1.3; BBB +7.0 ms, +3.2..+18.7 -> +2.5 ms, +2.0..+3.8."""
    rnd = random.Random(20261020)

    def late_ms(f):
        return rnd.uniform(10, 40) if rnd.random() < 1 / 3 else rnd.uniform(0, 2)

    med, spread, _ = _summary("late packets", _remote_frames(fppd, 50, late_ms=late_ms))
    assert abs(med) <= 6, f"late packets moved the remote's lights to {med:+.1f} ms from the master's"
    assert spread <= 8, f"late packets make the remote's lights wander {spread:.1f} ms (10-90%)"


def test_remote_lights_follow_a_part_frame_remote_offset(fppd):
    """remoteOffset moves a remote's lights by what it says, not by that
    rounded to a frame: +30 ms at 20 fps puts them 30 ms ahead of the
    master's (median within 5 ms of that).

    Also a9e2df492: a remote's sequence takes the sync packet's seconds (which
    carry remoteOffset) rather than its frame number; without that the offset
    does nothing (+2.5 ms here, not +30).

    Regression: b08fe4a62. The remote turned the master's offset seconds into a
    whole frame number, so +30 ms moved its lights a whole frame (50 ms)
    ahead, and anything under half a frame did nothing. Media takes the
    offset seconds as they are: +100 ms put the remote's sound -101 ms
    from the master's, and -100 ms +100 ms (Pi 5, run-local).

    +30 ms, parent -> b08fe4a62: Docker ASan -46.7 -> -26.8 ms (its own
    +2 ms baseline); run-local Pi 5 -49.8 -> -29.7 ms. -30 ms: +50.2 -> +30.2 ms; +10 ms ->
    -9.7 ms."""
    fppd.settings(remoteOffset="30")
    med, _, _ = _summary("remoteOffset +30 ms", _remote_frames(fppd, 50, behind=0.0))
    assert abs(med + 30) <= 5, f"remoteOffset +30 ms put the remote's lights {med:+.1f} ms from the master's"
