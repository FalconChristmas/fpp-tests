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


def test_the_port_number_test_cycles_red_green_blue(fppd):
    """The port number test lights the pixels beyond the port's number in
    turn red, green and blue, in that order, and the port's own pixels
    white.

    Regression: 9e17aab9f. The cycle ran green, red, blue, against the
    convention of every other test."""
    start(fppd, port_config(fppd, 4))
    fppd.command("Test Start", "1000", "Output Specific", "--ALL--", "1")
    seen = []

    def colours():
        data = wire(fppd)
        if data and len(data) >= 12 and data[0:3] == bytes((255, 255, 255)) and any(data[3:6]):
            px = data[3:6]
            if not seen or seen[-1] != px:
                seen.append(px)
        return len(seen) >= 4 or None
    fppd.wait_for(colours, timeout=20, interval=0.1, what="the colours to cycle")
    fppd.command("Test Stop")
    assert seen[:3] == [bytes((255, 0, 0)), bytes((0, 255, 0)), bytes((0, 0, 255))], [s.hex() for s in seen]


def models(fppd):
    return {m["Name"]: m for m in fppd.get("/overlays/models")}


def test_an_auto_created_model_counts_the_pixels_a_group_count_shows(fppd):
    """A string of 30 pixels with a group count of 3 gets an overlay model
    of 30 channels worth of pixels (10 pixels, shown 3 times each), not 90.

    Regression: 0a2e7bb8c. The model's size ignored the group count."""
    throw_plugin.install(fppd, source="pixelstringdump.cpp", name="PixelStringDump")
    p = port_config(fppd, 30)
    p["virtualStrings"][0]["groupCount"] = 3
    p["virtualStrings"][0]["description"] = "Grouped"
    fppd.write(fppd.strings_config, outputs(p))
    fppd.write("config/model-overlays.json", {"autoCreate": True, "models": []})
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    m = fppd.wait_for(lambda: models(fppd).get("Grouped"), what="the auto-created model")
    assert m["ChannelCount"] == 30, m


def test_unnamed_virtual_strings_get_lettered_model_names(fppd):
    """A port of three unnamed virtual strings gets overlay models named
    String-1A-1, String-1A-2, String-1A-3.

    Regression: d19d3c7d4. The names were String-1-1.. with no letter, so
    the strings of different receivers on a port could not be told apart."""
    throw_plugin.install(fppd, source="pixelstringdump.cpp", name="PixelStringDump")
    p = port_config(fppd, 10)
    vs = p["virtualStrings"][0]
    vs["description"] = ""
    p["virtualStrings"] = [dict(vs, startChannel=i * 30) for i in range(3)]
    fppd.write(fppd.strings_config, {"channelOutputs": [{
        "type": "PixelStringDump", "enabled": 1, "startChannel": 1, "channelCount": 90,
        "outputCount": 1, "outputs": [p]}]})
    fppd.write("config/model-overlays.json", {"autoCreate": True, "models": []})
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    fppd.wait_for(lambda: len(models(fppd)) >= 3, what="the auto-created models")
    names = sorted(n for n in models(fppd) if n.startswith("String-1"))
    assert names == ["String-1A-1", "String-1A-2", "String-1A-3"], names


def test_an_auto_created_model_with_a_string_missing_is_still_made(fppd):
    """Virtual strings named "Arch-str-1" and "Arch-str-3", with no string 2,
    give one overlay model, Arch, across both: fppd starts, and the model is
    three strings wide less the one that isn't there.

    Regression: 91f81637d. The model's strings are collected by their -str-N
    index, which leaves a null in the list for the missing one; reading its
    start channel faulted while fppd created the auto models.
    """
    throw_plugin.install(fppd, source="pixelstringdump.cpp", name="PixelStringDump")
    p = port_config(fppd, 10)
    vs = p["virtualStrings"][0]
    p["virtualStrings"] = [dict(vs, description="Arch-str-1", startChannel=0),
                           dict(vs, description="Arch-str-3", startChannel=60)]
    fppd.write(fppd.strings_config, {"channelOutputs": [{
        "type": "PixelStringDump", "enabled": 1, "startChannel": 1, "channelCount": 90,
        "outputCount": 1, "outputs": [p]}]})
    fppd.write("config/model-overlays.json", {"autoCreate": True, "models": []})
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    m = fppd.wait_for(lambda: models(fppd).get("Arch"), what="the auto-created model")
    assert (m["StartChannel"], m["ChannelCount"]) == (1, 90), m
    assert m["StringCount"] == 2, m
