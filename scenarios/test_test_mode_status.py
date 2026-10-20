"""Channel test mode as other clients see it (the running test in fppd's
status and its WebSocket push), a test config with a field of the wrong
type, and the trailing partial pixel of the fill and cycle patterns."""

import json
import time

from ddp import DdpReceiver
from show import CHANNELS, ddp_output
from test_status_websocket import snapshot, wait_snapshot
from wsclient import WebSocket


def setup(fppd):
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")


def last(rx):
    return rx.last() or bytes(CHANNELS)


def wait_output(fppd, rx, predicate, what, timeout=10):
    def check():
        f = last(rx)
        return f if predicate(f) else None
    return fppd.wait_for(check, timeout=timeout, interval=0.05, what=what)


def test_the_running_test_is_in_status_and_pushed(fppd):
    """While a test pattern runs, GET /fppd/status carries it as "testMode"
    (its mode and channels, as GET /fppd/testing gives them) and the status
    WebSocket pushes it to a connected client; an output-specific test's
    per-output "config" blob is left out of it; once stopped, it is gone.

    Feature: 1b88ae8f6 -- so the Testing dropdowns of every open page can
    follow a test started, changed or stopped elsewhere.
    """
    setup(fppd)
    fppd.start()
    ws = WebSocket("/fppdws")
    snapshot(ws)
    fppd.command("Test Start", 500, "RGB Chase", "1-30", "R-G-B")
    tm = fppd.get("/fppd/status").get("testMode")
    assert tm and tm.get("mode") == "RGBChase" and tm.get("channelSet") == "1-30", tm
    assert tm.get("enabled") == 1, tm
    pushed = wait_snapshot(ws, lambda s: (s.get("testMode") or {}).get("mode") == "RGBChase",
                           what="the running test")
    assert pushed["status_name"] == "testing"

    fppd.command("Test Start", 500, "Output Specific", "--ALL--", "1",
                 json.dumps({"ports": [1, 2, 3]}))
    full = fppd.get("/fppd/testing").get("config", {})
    assert full.get("mode") == "Outputs" and "config" in full, full
    tm = fppd.get("/fppd/status").get("testMode")
    assert tm and tm.get("mode") == "Outputs" and tm.get("outputs") == "--ALL--", tm
    assert "config" not in tm, f"the per-output config went into status: {tm}"

    fppd.command("Test Stop")
    fppd.wait_for(lambda: "testMode" not in fppd.get("/fppd/status"), what="testMode gone after Test Stop")
    wait_snapshot(ws, lambda s: "testMode" not in s and s["status_name"] == "idle",
                  what="the stop")
    ws.close()


def test_a_fill_with_a_colour_of_the_wrong_type_still_runs(fppd):
    """An RGB fill posted to /fppd/testing with color1 as a "#202020"
    string (not the int the field holds) and the other two as ints runs:
    the bad field reads as 0 and the good ones are used.

    Regression: 9f80039ee. The patterns read their fields with bare jsoncpp
    accessors, which throw on a string; 73b282af2 had already caught that,
    so fppd lived, but the whole test was refused for the one field.
    """
    setup(fppd)
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fppd.post("/fppd/testing", {
            "enabled": 1, "mode": "RGBFill", "cycleMS": 1000, "channelSet": "1-30",
            "channelSetType": "channelRange", "color1": "#202020", "color2": 32, "color3": 48})
        frame = wait_output(fppd, rx, lambda f: any(f), "the fill")
        assert frame[:30] == bytes([0, 32, 48]) * 10, frame[:30].hex()
        assert fppd.get("/fppd/status")["status_name"] == "testing"


def test_fill_and_cycle_light_a_trailing_partial_pixel(fppd):
    """RGB Single Color and RGB Cycle over ten channels (three pixels and
    one channel more) light the tenth channel too, with the first colour
    of a pixel, and nothing past it.

    Regression: 872f0876d. Both patterns stepped a whole pixel at a time
    and stopped at the last whole one, so channel 10 stayed dark.
    """
    setup(fppd)
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fppd.command("Test Start", 1000, "RGB Single Color", "1-10", "#405060")
        frame = wait_output(fppd, rx, lambda f: any(f), "the single colour")
        assert frame[:10] == (bytes([0x40, 0x50, 0x60]) * 4)[:10], frame[:12].hex()
        assert not any(frame[10:])
        fppd.command("Test Stop")
        wait_output(fppd, rx, lambda f: not any(f), "dark")
        fppd.command("Test Start", 200, "RGB Cycle", "1-10", "R-G-B")
        wait_output(fppd, rx, lambda f: any(f), "the cycle")
        since = time.monotonic()
        time.sleep(1.5)
        frames = [f for _, f in rx.snapshot(since)]
        lit = [f for f in frames if any(f[:9])]
        assert lit, "the cycle lit nothing"
        assert all(f[9] == f[0] for f in lit), \
            f"channel 10 does not follow its pixel's first channel: {[f[:10].hex() for f in lit[:5]]}"
        assert all(not any(f[10:]) for f in frames), "the cycle spilled past channel 10"
