"""Bridged channel ranges as they are merged into the channel data: one
range inside another, and a range that reaches the reserved channels after
the real ones. Same harness as test_bridge_inputs.py: packets streamed to
fppd on 127.0.0.1, and what comes back out read off a raw output."""

import time

from packets import DDP_PORT, Sender, ddp
from test_bridge_inputs import region, setup, wait_output
from udp import Listener

OUT_PORT = 5000


def test_bridged_range_inside_another_keeps_the_outer_tail(fppd):
    """Two DDP ranges, channels 101-150 lying inside 1-300: every channel of
    the outer range reaches the output, including 151-300 after the inner
    one ends.

    Regression: 86305bdcf. Merging the overlapping ranges into runs set the
    run's end to the end of the range just added, so the inner range cut
    the outer one short at 150, and channels 151-300 were never copied.
    """
    setup(fppd)
    inner = bytes([0x44]) * 50

    def outer(n):
        # A value that changes every second, so nothing left over from an
        # earlier round (or the idle blank) can pass for it.
        return bytes([0x10 + (n // 20) % 8]) * 300

    with Listener(OUT_PORT) as out:
        fppd.start()
        with Sender(lambda n: [(ddp(0, outer(n), seq=n % 15 + 1), DDP_PORT),
                               (ddp(100, inner, seq=n % 15 + 1), DDP_PORT)]):
            for _ in range(3):
                f = wait_output(fppd, out, lambda f: region(f, 101, 50) == inner and f[0] != 0,
                                "the bridged ranges on the output")
                v = f[0]
                assert region(f, 151, 150) == bytes([v]) * 150, \
                    f"channels 151-300: {set(region(f, 151, 150))}, channel 1 carries {v:#x}"
                time.sleep(1)


def test_bridged_data_stays_out_of_the_reserved_channels(fppd):
    """A DDP packet whose last eight bytes fall past the real channels, on
    the reserved "always off" and "always white" ones, is refused: a null
    pixel at the start of a string still reads off.

    Regression: f53085a75. Bridged writes were bounded by the end of the
    reserved channels, not of the real ones, so this packet turned the
    reserved "off" channels on, and every null pixel and smart-receiver
    lead-in/out read 0xFF from then on.
    """
    max_channels = 8192 * 1024  # FPPD_MAX_CHANNELS
    setup(fppd)
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [{
        "Name": "M", "Type": "Channel", "StartChannel": 601, "ChannelCount": 30,
        "ChannelCountPerNode": 3, "Orientation": "horizontal", "StartCorner": "TL",
        "StringCount": 1, "StrandsPerString": 1}]})
    # A string of one null pixel then nine real ones (channels 1-27), drawn
    # onto M's one row. M itself sits on channels 601-630, clear of them:
    # the enabled model is written over its own channels after the bridge.
    fppd.write("config/co-pixelStrings.json", {"channelOutputs": [{
        "type": "ModelPixelStrings", "enabled": 1, "startChannel": 1, "channelCount": 27,
        "modelName": "M", "outputs": [{
            "portNumber": 0, "protocol": "ws2811", "virtualStrings": [{
                "description": "s", "startChannel": 0, "pixelCount": 9, "groupCount": 0,
                "reverse": 0, "colorOrder": "RGB", "nullNodes": 1, "endNulls": 0,
                "zigZag": 0, "brightness": 100, "gamma": "1.0"}]}]}]})
    real = bytes([0x22]) * 27
    fppd.start()

    def model_data():
        return fppd.get("/overlays/model/M/data").get("data") or []
    with Sender(lambda n: [(ddp(max_channels - 10, bytes([0xFF]) * 18, seq=n % 15 + 1), DDP_PORT),
                           (ddp(0, real, seq=n % 15 + 1), DDP_PORT)]):
        fppd.wait_for(lambda: model_data()[3:30] == list(real), timeout=10,
                      what="the string's real pixels on the model")
        time.sleep(1)
        data = model_data()
    assert data[:3] == [0, 0, 0], f"the null pixel reads {data[:3]}"
