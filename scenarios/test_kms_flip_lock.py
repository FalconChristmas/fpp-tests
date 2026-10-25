"""What a KMS framebuffer output's page flips hold up.

Runs anywhere, Docker included: the display is the fake Pi 3 card of
fakedrm.c (see fakedrm.py), which paces page flips to a 60 Hz vblank as a
real one does.
"""

import os

import fakedrm
import shims


def test_a_flipping_virtual_matrix_does_not_hold_the_media_lock(fppd):
    """A Virtual Matrix on HDMI, driven at 100 frames a second by test mode:
    another thread taking fppd's mediaOutputLock 500 times while it flips
    almost never waits more than a millisecond for it.

    Regression: 9224532d8. Every flip held mediaOutputLock for its whole
    length, the wait for the previous flip and the phase-alignment sleep
    included -- most of a refresh. The main loop takes that lock to process
    media on every pass, MultiSync for each master position update and a
    remote's status build, so all of them stalled behind the display
    (measured on a Pi 5: 70% of acquisitions waited over 1 ms).

    lockwait.so does the timing from inside fppd, 6 s after it starts.
    """
    fppd.write("config/co-other.json", {"channelOutputs": [
        {"enabled": 1, "type": "VirtualMatrix", "startChannel": 1, "channelCount": 64 * 32 * 3,
         "device": fakedrm.CONNECTOR, "width": 64, "height": 32}]})
    fppd.settings(DisableFakeNetworkBridges="1", E131BridgingInterval="10", LogLevel_ChannelOut="info")
    preload, env = fakedrm.start_env(fppd)
    out = os.path.join(fppd.media, "tmp", "lockwait.txt")
    env.update(LOCKWAIT_OUT=out, LOCKWAIT_DELAY_MS="6000", LOCKWAIT_COUNT="500")
    fppd.start(preload=preload + [shims.build("lockwait.c", libs=("-ldl", "-lpthread"))], extra_env=env)
    fppd.wait_for(lambda: f"KMSFrameBuffer: {fakedrm.CONNECTOR} mode" in fppd.log(), timeout=15,
                  what="the Virtual Matrix on the fake display")
    fppd.command("Test Start", 1000, "RGB Cycle", f"1-{64 * 32 * 3}", "R-G-B")

    def result():
        try:
            with open(out) as f:
                line = f.read()
        except FileNotFoundError:
            return None
        return line if line.endswith("\n") else None
    line = fppd.wait_for(result, timeout=30, what="lockwait's timings")
    fppd.command("Test Stop")
    assert line.strip() != "missing", "fppd has no mediaOutputLock to time"
    samples, over, median, longest = (int(v) for v in line.split())
    assert over <= samples // 20, \
        (f"{over} of {samples} takes of mediaOutputLock waited over 1 ms "
         f"(median {median} us, longest {longest / 1000:.1f} ms) while the matrix flipped")
