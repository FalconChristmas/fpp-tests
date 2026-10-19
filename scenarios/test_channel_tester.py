"""Channel test mode (Test Start / Test Stop, /fppd/testing): what each test
pattern puts on the wire, over which channels, and what bad arguments do."""

import time

import pytest

from ddp import DdpReceiver
from show import CHANNELS, ddp_output, status

R, G, B = b"\xff\x00\x00", b"\x00\xff\x00", b"\x00\x00\xff"


def setup(fppd):
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")


def start_test(fppd, interval, pattern, *args):
    return fppd.command("Test Start", interval, pattern, *args)


def last(rx):
    return rx.last() or bytes(CHANNELS)


def wait_output(fppd, rx, predicate, what, timeout=10):
    def check():
        f = last(rx)
        return f if predicate(f) else None
    return fppd.wait_for(check, timeout=timeout, interval=0.05, what=what)


def lit(frame):
    return [i for i, b in enumerate(frame) if b]


def test_single_color_fills_exactly_the_range(fppd):
    """RGB Single Color repeats its colour over the channel range (1-based,
    inclusive) and touches nothing else; Test Stop leaves the output dark
    and status idle again."""
    setup(fppd)
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        start_test(fppd, 1000, "RGB Single Color", "11-40", "#FF8001")
        frame = wait_output(fppd, rx, lambda f: any(f), "the test colour")
        assert frame[10:40] == b"\xff\x80\x01" * 10
        assert not any(frame[:10]) and not any(frame[40:])
        assert status(fppd).get("status_name") == "testing"

        fppd.command("Test Stop")
        wait_output(fppd, rx, lambda f: not any(f), "the output dark after Test Stop")
        fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", what="status idle")


def test_several_ranges(fppd):
    """A channel set of several ranges, comma- or semicolon-separated,
    lights each range and nothing between them (d9907912a)."""
    setup(fppd)
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        for sets in ("1-3,10-12,31-33", "1-3;10-12;31-33"):
            start_test(fppd, 1000, "Single Channel Fill", sets, "200")
            want = [0, 1, 2, 9, 10, 11, 30, 31, 32]
            wait_output(fppd, rx, lambda f: lit(f) == want, f"exactly channels of {sets}")
            fppd.command("Test Stop")
            wait_output(fppd, rx, lambda f: not any(f), "dark")


def test_rgb_chase_moves_and_covers_a_partial_pixel(fppd):
    """R-G-B chase over ten channels (three pixels and one channel more):
    every frame is the R,G,B sequence starting somewhere, it moves on each
    cycle, and the trailing partial pixel is lit too (872f0876d)."""
    setup(fppd)
    rotations = {(R + G + B + R)[:10], (B + R + G + B)[:10], (G + B + R + G)[:10]}
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        start_test(fppd, 200, "RGB Chase", "1-10", "R-G-B")
        wait_output(fppd, rx, lambda f: any(f), "the chase")
        since = time.monotonic()
        time.sleep(2)
        seen = {f[:10] for _, f in rx.snapshot(since)}
        assert seen <= rotations, f"chase frames that are not a rotation of R-G-B: {seen - rotations}"
        assert seen == rotations, f"the chase did not move through all three positions: {seen}"
        assert all(not any(f[10:]) for _, f in rx.snapshot(since)), "the chase spilled past channel 10"


def test_single_channel_chase(fppd):
    """Single Channel Chase lights one channel in every chaseSize, at the
    chase value, and moves one channel per cycle."""
    setup(fppd)
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        start_test(fppd, 200, "Single Channel Chase", "1-12", "77", "4")
        wait_output(fppd, rx, lambda f: any(f), "the chase")
        since = time.monotonic()
        time.sleep(2)
        frames = [f for _, f in rx.snapshot(since)]
        positions = set()
        for f in frames:
            on = lit(f)
            assert set(f[i] for i in on) == {77}, "a chase channel not at the chase value"
            assert len(on) == 3 and on[1] - on[0] == 4 and on[2] - on[1] == 4, on
            positions.add(on[0])
        assert positions == {0, 1, 2, 3}, f"the chase did not walk its 4 positions: {positions}"


@pytest.mark.parametrize("size", ["0", "-3", "99999999"])
def test_single_channel_chase_with_a_bad_size(fppd, size):
    """A chase size below 2 or past channel space is clamped, not obeyed.

    Regression: SetupTest() stepped through the channels by the chase size,
    so 0 looped forever on the HTTP thread running the command (fppd
    wedged) and a negative size wrote before the test buffer (an ASan
    heap-buffer-overflow); CycleData() read one chase size in, past the
    buffer for a huge size (that read lands in other mapped memory, so the
    huge case passes either way). Fixed by 6966fdb11.
    """
    setup(fppd)
    fppd.start()
    try:
        start_test(fppd, 200, "Single Channel Chase", "1-12", "77", size)
    except Exception:
        pass  # an error answer is fine; a wedge or crash is not
    for _ in range(10):
        fppd.get("/fppd/status", timeout=5)
        time.sleep(0.2)
    fppd.command("Test Stop", timeout=5)


@pytest.mark.parametrize("args, what", [
    (["1000", "RGB Single Color"], "too few arguments"),
    (["1000", "RGB Single Color", "1-30", ""], "an empty colour"),
    (["1000", "RGB Single Color", "1-30", "#GGHHII"], "a colour that is not hex"),
    (["1000", "Single Channel Fill", "1-30", "lots"], "a value that is not a number"),
    (["1000", "Single Channel Chase", "1-30", "255", "x"], "a chase size that is not a number"),
    (["1000", "Custom Chase", "1-30", "", "3"], "an empty custom pattern"),
    (["1000", "Custom Chase", "1-30", "FF00", "7"], "an odd channels-per-node"),
    (["", "RGB Chase", "1-30", "R-G-B"], "an empty interval"),
    (["1000", "RGB Chase", "30-1", "R-G-B"], "a range given backwards"),
    # a range starting past every output: only its end was clamped, so the
    # pattern was copied that far past the channel buffer (SIGSEGV on the
    # output thread whenever the address is unmapped -- these two always are;
    # fixed by c4e8c2f44)
    (["1000", "RGB Chase", "1999999999-1999999999", "R-G-B"], "a range past every output"),
    (["1000", "RGB Chase", "1-3;500000000-500000000", "R-G-B"], "a good range and one past every output"),
    (["1000", "No Such Pattern", "1-30", "1"], "an unknown pattern"),
])
def test_bad_test_start_arguments_are_survived(fppd, args, what):
    """Test Start with bad arguments answers (an error is fine) and leaves
    fppd running and able to run a good test afterwards (73b282af2,
    9f80039ee, a117c89a7)."""
    setup(fppd)
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        try:
            fppd.post("/command", {"command": "Test Start", "args": args}, timeout=5)
        except Exception as e:
            if "wedged" in str(e):
                raise
        time.sleep(0.5)
        fppd.command("Test Stop")
        start_test(fppd, 1000, "RGB Single Color", "1-3", "#010203")
        wait_output(fppd, rx, lambda f: f[:3] == b"\x01\x02\x03", f"a good test after {what}")


def test_a_start_channel_past_int_max_is_refused(fppd):
    """A start channel past INT_MAX is refused, not wrapped. atoi() turned
    4294967295 into -1, so "4294967295-30" became channels 0..29 starting one
    byte before the channel buffer: a write outside it on every frame, and
    the pattern landing one byte off on the wire, which is what shows here
    without a sanitizer.

    Regression: 63be4acc8."""
    setup(fppd)
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        start_test(fppd, 1000, "RGB Single Color", "4294967295-30", "#010203")
        time.sleep(1.5)
        assert not any(last(rx)), f"a wrapped range was tested: {last(rx)[:12].hex()}"
        fppd.command("Test Stop")
        start_test(fppd, 1000, "RGB Single Color", "1-3", "#010203")
        wait_output(fppd, rx, lambda f: f[:3] == b"\x01\x02\x03", "a good test afterwards")


def test_testing_api_describes_the_patterns(fppd):
    """GET /fppd/testing/tests lists the patterns; /fppd/testing/tests/<name>
    gives each one's arguments; GET /fppd/testing returns the running
    test's config."""
    setup(fppd)
    fppd.start()
    names = fppd.get("/fppd/testing/tests")
    assert "RGB Chase" in names and "Single Channel Chase" in names and len(names) >= 8
    for name in names:
        info = fppd.get("/fppd/testing/tests/" + name.replace(" ", "%20"))
        assert isinstance(info, dict) and "args" in info, f"{name}: {info!r}"
    start_test(fppd, 500, "RGB Chase", "1-30", "R-G-B")
    cfg = fppd.get("/fppd/testing").get("config", {})
    assert cfg.get("mode") == "RGBChase" and cfg.get("channelSet") == "1-30", cfg


def test_test_pattern_keeps_cycling_through_a_clock_step(fppd):
    """A cycling test pattern keeps moving when the wall clock steps back.
    The next cycle was due at a wall-clock time, so a step back held the
    pattern still for as long as the step. Fixed by 867cc6ba3."""
    setup(fppd)
    with DdpReceiver(CHANNELS) as rx:
        fppd.start(fake_time="2026-12-24 18:00:00")
        start_test(fppd, 200, "RGB Chase", "1-9", "R-G-B")
        wait_output(fppd, rx, lambda f: any(f), "the chase")
        fppd.set_clock("2026-12-24 17:00:00")
        time.sleep(0.5)
        since = time.monotonic()
        time.sleep(2)
        seen = {f[:9] for _, f in rx.snapshot(since)}
        assert len(seen) >= 3, f"the chase stopped moving after the clock stepped back: {len(seen)} frame(s)"
