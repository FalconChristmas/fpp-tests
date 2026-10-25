"""What a pixel string port puts on the wire: PixelString's output buffer,
as the string drivers (DPIPixels, BBShiftString, BBB48String) bit-flip it
onto their pins, in normal running and under the string testers.

The port is a pixel string output built for the scenario
(tools/pixelstringdump.cpp, loaded as a plugin) that writes each port's
bytes to a file every frame, so this runs anywhere -- no cape, no PRU. It
goes in the strings config the build reads (a BeagleBone's is its own).
"""

import os
import time

import throw_plugin


def port_config(fppd, pixels, start=0, protocol="ws2811", nulls=0, end_nulls=0, **extra):
    c = {"portNumber": 0, "protocol": protocol,
         "dumpFile": os.path.join(fppd.media, "tmp", "port1.bin"),
         "virtualStrings": [{
             "description": "port1", "startChannel": start, "pixelCount": pixels,
             "groupCount": 0, "reverse": 0, "colorOrder": "RGB", "nullNodes": nulls,
             "endNulls": end_nulls, "zigZag": 0, "brightness": 100, "gamma": "1.0"}]}
    c.update(extra)
    return c


def outputs(port):
    vs = port["virtualStrings"][0]
    return {"channelOutputs": [{
        "type": "PixelStringDump", "enabled": 1, "startChannel": 1,
        "channelCount": vs["startChannel"] + vs["pixelCount"] * 3, "outputCount": 1,
        "outputs": [port]}]}


def wire(fppd):
    try:
        with open(os.path.join(fppd.media, "tmp", "port1.bin"), "rb") as f:
            return f.read()
    except FileNotFoundError:
        return None


def start(fppd, port):
    throw_plugin.install(fppd, source="pixelstringdump.cpp", name="PixelStringDump")
    fppd.write(fppd.strings_config, outputs(port))
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()


def test_the_string_testers_leave_null_pixels_dark(fppd):
    """A port of 10 pixels after 2 null pixels, with 1 more at the end: the
    port number, pixel count and fade string tests each light the 10 real
    pixels and leave the 3 nulls at zero.

    Regression: 3b5a24b8c. The testers ignored the null nodes and wrote
    their pattern from the first byte, so the nulls were lit and every real
    pixel's test value landed 2 pixels late.
    """
    start(fppd, port_config(fppd, 10, nulls=2, end_nulls=1))
    for test in ("1", "2", "7"):  # port number, pixel count by port, fade white
        fppd.command("Test Start", "1000", "Output Specific", "--ALL--", test)

        def lit():
            data = wire(fppd)
            return data if data and len(data) == 39 and any(data[6:36]) else None
        data = fppd.wait_for(lit, timeout=15, interval=0.2, what=f"test {test} on the port")
        assert data[:6] == bytes(6) and data[36:] == bytes(3), (test, data.hex(" "))
        fppd.command("Test Stop")
        time.sleep(1)


def test_a_tm1814_port_leads_with_its_constant_current_words(fppd):
    """A TM1814 port of 4 pixels puts the C1/C2 constant current words
    ahead of its pixel data -- 38 mA, level 63 on all four channels and
    then its complement -- and, as a TM18xx line idles high, the whole
    frame is inverted: C1/C2 and then 255 minus each channel.

    Regression: 5b4a92f11. The port's protocol was saved by the UI but
    never read: a TM1814 string got plain ws2811 data, no C1/C2 (so the
    parts sat at their 6.5 mA floor) and an uninverted line.
    """
    start(fppd, port_config(fppd, 4, protocol="tm1814"))
    fppd.request("PUT", "/overlays/range/1-12", {"Value": 0x40})
    fppd.wait_for(lambda: (d := wire(fppd)) and len(d) >= 12 and d[-1] in (0x40, 0xBF), timeout=10,
                  what=f"the channels on the wire (last {wire(fppd)!r})")
    data = wire(fppd)
    assert data == bytes([0xC0] * 4 + [0x3F] * 4 + [0xBF] * 12), data.hex(" ")
