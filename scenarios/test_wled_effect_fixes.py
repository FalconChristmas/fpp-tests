"""WLED effect fixes from 10.2, each run alone long enough to reach the
case that broke: Dancing Shadows with its particle pool used up, and Stream
once its iteration counter has passed 16 bits."""

import time
import urllib.parse

import pytest

from ddp import DdpReceiver
from test_overlays import effect, matrix, setup, stop_effects


def sliders(fppd, name):
    """The names of an effect's WLED sliders, in order (Speed, Intensity,
    then the custom ones), leaving out brightness."""
    desc = fppd.get("/overlays/effects/" + urllib.parse.quote(name))
    return [a["name"] for a in desc["args"]
            if a.get("type") == "range" and a["name"].lower() != "brightness"]


@pytest.mark.parametrize("speed, intensity", [(20, 255), (60, 255), (20, 64)])
def test_dancing_shadows_with_no_free_particle(fppd, speed, intensity):
    """PS Dancing Shadows on a short string at a slow speed, where the
    spotlights it sprays soon need more particles than are free, keeps
    running.

    Regression: 88a63c6d5. sprayEmit() returns -1 when no particle is free;
    stored in a uint32_t it indexed particles[4294967295] (a SIGSEGV)."""
    w, h = 30, 1
    setup(fppd, [matrix("M", width=w, height=h)], channels=w * h * 3)
    with DdpReceiver(w * h * 3) as rx:
        fppd.start()
        name = "WLED - PS Dancing Shadows"
        s, i = sliders(fppd, name)[:2]
        effect(fppd, "M", name, **{s: str(speed), i: str(intensity)})
        for _ in range(20):
            time.sleep(1)
            fppd.check_alive()
        since = time.monotonic()
        time.sleep(1)
        assert rx.count(since) > 5, "output stopped"
        stop_effects(fppd, "M")


def test_stream_holds_still_between_steps_past_16_bits(fppd):
    """Stream with a zone size of one pixel moves on once per step of its
    speed and sends the same frame between steps -- also once the step
    count (milliseconds of uptime / step) no longer fits 16 bits.

    Regression: 5fba4142c. The last step was kept in a 16-bit field and
    compared with the full count, which never matched past 65535: every
    frame was a new zone, so the stream flickered at the frame rate instead
    of stepping. WLED's millis() is the monotonic clock, which can't be
    faked here, so the step (25 to 790 ms, set by the speed) is chosen to
    put the count past 16 bits on this host; on a host up less than about
    two hours (a fresh CI runner) no step slow enough to tell apart is,
    and the test skips."""
    step = min(790, int(time.monotonic() * 1000 / 70000))
    if step < 100:
        pytest.skip(f"up {time.monotonic() / 3600:.1f} h: too short for a step count past 16 bits")
    speed = 255 - (step - 25 + 2) // 3
    step = 25 + 3 * (255 - speed)  # what fppd will use
    assert time.monotonic() * 1000 / step > 65536
    w, h = 50, 1
    setup(fppd, [matrix("M", width=w, height=h)], channels=w * h * 3)
    with DdpReceiver(w * h * 3) as rx:
        fppd.start()
        name = "WLED - Stream"
        speed_arg, zone = sliders(fppd, name)[:2]
        # "Zone size" 255: a zone of one pixel
        effect(fppd, "M", name, **{speed_arg: str(speed), zone: "255"})
        time.sleep(1)
        since = time.monotonic()
        time.sleep(4)
        frames = [f for _, f in rx.snapshot(since)]
        stop_effects(fppd, "M")
    steps = 4000 / step
    changes = sum(1 for a, b in zip(frames, frames[1:]) if a != b)
    assert len(frames) > 3 * steps + 10, f"{len(frames)} frames in 4 s: too few to tell"
    assert 0.5 * steps - 1 <= changes <= 1.5 * steps + 2, \
        f"{changes} changes in {len(frames)} frames over 4 s of {step} ms steps"
