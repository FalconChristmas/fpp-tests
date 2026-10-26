"""Test mode over outputs that change under it: RGB Single Color started
before the outputs it lights are loaded, and started again after a Test Stop
with the colour and channels it last ran with. The receiving end is the DDP
frames fppd sends."""

import time

from ddp import DdpReceiver
from show import CHANNELS, ddp_output

FILL = {"mode": "RGBFill", "cycleMS": 1000, "color1": 10, "color2": 20, "color3": 30,
        "color4": 200, "channelsPerNode": 4, "enabled": 1, "channelSet": "1-150",
        "channelSetType": "channelRange"}
LIT = bytes([10, 20, 30, 200] * 38)[:CHANNELS]


def last(rx):
    return rx.last() or bytes(CHANNELS)


def wait_output(fppd, rx, predicate, what, timeout=10):
    def check():
        f = last(rx)
        return f if predicate(f) else None
    return fppd.wait_for(check, timeout=timeout, interval=0.05, what=what)


def lit(frame):
    return sum(1 for b in frame if b)


def test_fill_started_before_its_outputs_covers_them_once_loaded(fppd):
    """A fill of 1-150 started while no output is configured lights all 150
    channels once a 150-channel output is saved, without being started again.

    Regression: 90fe1372f. The channel set was resolved against the outputs
    only when its text changed. With no outputs yet, 1-150 was clipped to
    the 1-8 placeholder (plus one), and it stayed 1-9 -- the rest of the
    output dark while /api/testmode said 1-150 -- until a different channel
    set was asked for."""
    fppd.settings(DisableFakeNetworkBridges="1", LogLevel_ChannelOut="info")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fppd.post("/fppd/testing", FILL)
        time.sleep(0.5)
        fppd.write("config/co-universes.json", ddp_output(CHANNELS))
        fppd.wait_for(lambda: "Determined range needed 0 - 149" in fppd.log(), timeout=10,
                      what="the 150-channel output to be loaded")
        wait_output(fppd, rx, lambda f: any(f), "the fill on the new output")
        time.sleep(0.5)
        frame = last(rx)
        assert frame == LIT, f"{lit(frame)} of {CHANNELS} channels lit: {frame[:16].hex(' ')} ..."
        assert fppd.get("/fppd/testing")["config"]["channelSet"] == "1-150"


def test_fill_started_again_after_test_stop_lights_again_at_once(fppd):
    """The same fill, stopped and started again through /fppd/testing a
    moment after the output went dark, lights every channel again within a
    second each time (it takes about a tenth), and goes dark at each stop.

    Regression: 57f6defb1. A started test didn't ask for the output thread;
    the main loop starts it only when it isn't running, and after a Test
    Stop the thread still counts as running for the 2.5 s it waits idle to
    be asked. A test started in that window put out nothing -- the
    receiver kept the stop's black frame -- until the wait ran out, 1.7 to
    2.4 s later here."""
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fppd.post("/fppd/testing", FILL)
        wait_output(fppd, rx, lambda f: f == LIT, "the fill")
        for n, pause in enumerate((0.3, 1.0, 0.3)):
            fppd.post("/fppd/testing", {"enabled": 0})
            wait_output(fppd, rx, lambda f: not any(f), f"stop {n + 1}: dark")
            time.sleep(pause)
            t0 = time.monotonic()
            fppd.post("/fppd/testing", FILL)
            wait_output(fppd, rx, lambda f: f == LIT, f"start {n + 1}, {pause} s after the stop: "
                        "every channel lit within 1 s", timeout=1.0)
            print(f"start {n + 1}: lit after {time.monotonic() - t0:.2f} s")
