"""An enable pin several pixel ports share (OutputMonitor), as on a cape
whose ports have one output enable between them. The ports are
PixelCountSim's (tools/pixelcountsim.cpp), which drops its trailing empty
ports after setting them up, as DPIPixels does; the pins are the TmpFile
pins of a container build, high while /tmp/GPIO-<pin> exists.

pinrelease.cpp makes a released TmpFile pin behave like a released gpiod
line: setValue() on it does nothing until it is claimed again. Without it a
TmpFile pin's releasePin() is a no-op, and a pin released too early still
works.
"""

import os

import shims
import throw_plugin
from test_efuse_ports import high, pin_file

SHARED, OTHER = "TF-11", "TF-12"


def ports(fppd, *spec):
    """co-pixelStrings.json: one PixelCountSim port per (pixels, enable pin)."""
    outputs = []
    for n, (pixels, pin) in enumerate(spec):
        outputs.append({
            "portNumber": n, "protocol": "ws2811",
            "simCurrentFile": os.path.join(fppd.media, "tmp", f"port{n + 1}-ma"),
            "simWirePixels": pixels,
            "simPin": {"enablePin": pin},
            "virtualStrings": [{
                "description": f"port{n + 1}", "startChannel": n * 150, "pixelCount": pixels,
                "groupCount": 0, "reverse": 0, "colorOrder": "RGB", "nullNodes": 0,
                "endNulls": 0, "zigZag": 0, "brightness": 100, "gamma": "1.0"}]})
    return {"channelOutputs": [{
        "type": "PixelCountSim", "enabled": 1, "startChannel": 1,
        "channelCount": 150 * len(spec), "outputCount": len(spec),
        "simDropTrailingEmpty": True, "outputs": outputs}]}


def start(fppd, *spec):
    throw_plugin.install(fppd, source="pixelcountsim.cpp", name="PixelCountSim")
    fppd.write("config/co-pixelStrings.json", ports(fppd, *spec))
    for pin in (SHARED, OTHER):
        if high(pin):
            os.unlink(pin_file(pin))
    fppd.start(preload=[shims.build("pinrelease.cpp", libs=("-ldl", "-lstdc++"))])
    fppd.wait_for(lambda: fppd.get("/fppd/ports"), what="the ports to be monitored")


def test_dropping_an_empty_port_leaves_the_shared_enable_pin_working(fppd):
    """Port 1 has pixels and port 2, empty, shares its enable pin; port 2
    is dropped at init. Outputs On still drives the pin high.

    Regression: a054bd305. Removing port 2 released the pin while port 1
    still used it, and from then on setting it did nothing: the cape's
    outputs were never enabled."""
    start(fppd, (50, SHARED), (0, SHARED))
    fppd.command("Outputs On")
    fppd.wait_for(lambda: high(SHARED), timeout=10, what=f"the shared enable pin {SHARED} to go high")


def test_dropping_an_empty_port_leaves_the_pin_to_the_empty_ports_still_on_it(fppd):
    """Port 1 is empty, port 2 has pixels on a pin of its own, and port 3,
    empty, shares port 1's pin and is dropped at init. Set Port Status
    still turns port 1's pin on and off.

    Regression: 720ccbf06. The pin was kept only while an enabled port
    shared it; port 1 is registered disabled for having no pixels, so the
    pin was released under it and Port Status writes to it did nothing."""
    start(fppd, (0, SHARED), (50, OTHER), (0, SHARED))
    fppd.command("Outputs On")
    fppd.wait_for(lambda: high(OTHER), timeout=10, what="port 2's enable pin to go high")
    fppd.command("Set Port Status", "Port 1", "true")
    fppd.wait_for(lambda: high(SHARED), timeout=10, what=f"port 1's enable pin {SHARED} to go high")
    fppd.command("Set Port Status", "Port 1", "false")
    fppd.wait_for(lambda: not high(SHARED), timeout=10, what=f"port 1's enable pin {SHARED} to go low")
