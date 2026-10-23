"""The current-based pixel count (/fppd/ports/pixelCount, string test type
999): it lights windows of pixels on each port, reads the port's current
sensor, and reports how many pixels are on the wire.

The ports are a pixel string output built for the scenario
(tools/pixelcountsim.cpp, loaded as a plugin): it hands its strings to the
string tester the way the DPIPixels and BeagleBone string outputs do, and
writes each port's current to the file its sensor reads, for a simulated
string of a given length: 30 mA dark and 60 mA a pixel at full white."""

import os

import throw_plugin

PORT = "Port 1"


def outputs(fppd, configured, wire, nulls=0):
    """co-pixelStrings.json: one PixelCountSim port, `configured` pixels from
    channel 1 after `nulls` null nodes, with `wire` pixels on the wire."""
    return {"channelOutputs": [{
        "type": "PixelCountSim", "enabled": 1, "startChannel": 1,
        "channelCount": configured * 3, "outputCount": 1,
        "outputs": [{
            "portNumber": 0, "protocol": "ws2811",
            "simCurrentFile": os.path.join(fppd.media, "tmp", "port1-ma"),
            "simWirePixels": wire,
            "virtualStrings": [{
                "description": "port1", "startChannel": 0, "pixelCount": configured,
                "groupCount": 0, "reverse": 0, "colorOrder": "RGB", "nullNodes": nulls,
                "endNulls": 0, "zigZag": 0, "brightness": 100, "gamma": "1.0"}]}]}]}


def port(fppd):
    for p in fppd.get("/fppd/ports"):
        if p.get("name") == PORT:
            return p
    return None


def loads(fppd):
    return fppd.log().count("Calling Init() on PixelCountSim output")


def counts(fppd):
    """The tester's "Pixel count: port 1 has ..." lines so far."""
    return [l.split("Pixel count: ", 1)[1] for l in fppd.log().splitlines()
            if "Pixel count: port 1 has " in l]


def count_pixels(fppd, n):
    """Run the pixel count and wait for its nth result; return the line and
    the port's status after it."""
    fppd.get("/fppd/ports/pixelCount")
    fppd.wait_for(lambda: len(counts(fppd)) >= n, timeout=180, interval=0.5,
                  what=f"pixel count {n} to finish")
    line = counts(fppd)[n - 1]
    # The start of each count clears the port's pixelCount, and the end sets
    # it just after logging the line: wait for it rather than race the log.
    status = fppd.wait_for(lambda: (p := port(fppd)) and "pixelCount" in p and p,
                           what="the port's pixel count in its status")
    fppd.get("/fppd/ports/stop")
    fppd.wait_for(lambda: fppd.get("/fppd/status").get("status_name") == "idle",
                  timeout=10, what="test mode to stop")
    return line, status


def test_a_pixel_count_after_a_port_is_reconfigured_uses_the_new_config(fppd):
    """A port configured for 50 pixels, with 50 on the wire, counts 50. The
    port is then reconfigured, without a restart, for 150 pixels after 2
    null nodes, with 152 on the wire: the next count reports 150 pixels,
    against 150 configured and 2 nulls.

    Regression: db22d6978. The tester worked out each port's configured
    count, null nodes and search limit (configured plus 64) on its first
    run and kept them: the second count still took 50 configured and no
    nulls, searched only to pixel 114, and reported 114 pixels until fppd
    restarted.
    """
    throw_plugin.install(fppd, source="pixelcountsim.cpp", name="PixelCountSim")
    fppd.write("config/co-pixelStrings.json", outputs(fppd, 50, 50))
    # 100 frames a second, not 20: each reading takes 66 frames
    fppd.settings(LogLevel_ChannelOut="info", E131BridgingInterval="10")
    fppd.start()
    fppd.wait_for(lambda: port(fppd), what=f"{PORT} to be monitored")

    line, status = count_pixels(fppd, 1)
    assert line.startswith("port 1 has 50 pixels on the wire (50 configured, 0 nulls)"), line
    assert status.get("pixelCount") == 50, status

    before = loads(fppd)
    fppd.write("config/co-pixelStrings.json", outputs(fppd, 150, 152, nulls=2))
    fppd.wait_for(lambda: loads(fppd) > before, timeout=20, what="the outputs to reload")
    fppd.wait_for(lambda: port(fppd), what=f"{PORT} to be monitored again")

    line, status = count_pixels(fppd, 2)
    assert line.startswith("port 1 has 152 pixels on the wire (150 configured, 2 nulls)"), line
    assert status.get("pixelCount") == 150, status
