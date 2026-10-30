"""eFuse handling on a pixel port (OutputMonitor): a trip, its retries and
its warning. The port is PixelCountSim's (tools/pixelcountsim.cpp, loaded as
a plugin), given an enable pin and an eFuse pin as a cape's port would have;
the pins are the TmpFile pins a container build has, so a pin is high while
/tmp/GPIO-<pin> exists. The eFuse pin reads high on a trip (eFuseOKValue 0)."""

import os
import time

import throw_plugin

ENABLE, EFUSE = "TF-11", "TF-12"


def pin_file(pin):
    return f"/tmp/GPIO-{pin}"


def high(pin):
    return os.path.exists(pin_file(pin))


def config(fppd, pixels=50):
    """co-pixelStrings.json: one PixelCountSim port with an enable and an
    eFuse pin."""
    return {"channelOutputs": [{
        "type": "PixelCountSim", "enabled": 1, "startChannel": 1,
        "channelCount": pixels * 3, "outputCount": 1,
        "outputs": [{
            "portNumber": 0, "protocol": "ws2811",
            "simCurrentFile": os.path.join(fppd.media, "tmp", "port1-ma"),
            "simWirePixels": pixels,
            "simPin": {"enablePin": ENABLE, "eFusePin": EFUSE},
            "virtualStrings": [{
                "description": "port1", "startChannel": 0, "pixelCount": pixels,
                "groupCount": 0, "reverse": 0, "colorOrder": "RGB", "nullNodes": 0,
                "endNulls": 0, "zigZag": 0, "brightness": 100, "gamma": "1.0"}]}]}]}


def efuse_warnings(fppd):
    return [w for w in fppd.get("/fppd/warnings") if w.startswith("eFUSE Triggered")]


def powered_port(fppd, **settings):
    """fppd with the port configured and its outputs on (enable pin high)."""
    throw_plugin.install(fppd, source="pixelcountsim.cpp", name="PixelCountSim")
    fppd.write("config/co-pixelStrings.json", config(fppd))
    fppd.settings(**settings)
    for pin in (ENABLE, EFUSE):
        if high(pin):
            os.unlink(pin_file(pin))
    fppd.start()
    fppd.command("Outputs On")
    fppd.wait_for(lambda: high(ENABLE), timeout=10, what="the port's enable pin to go high")
    assert any(p.get("name") == "Port 1" for p in fppd.get("/fppd/ports")), "Port 1 is not monitored"


def trip():
    with open(pin_file(EFUSE), "w"):
        pass


def test_an_efuse_warning_comes_down_when_the_strings_are_reloaded(fppd):
    """A port's eFuse trips (no retries): "eFUSE Triggered for Port 1" goes
    up. The trip is cleared and the string config saved again, which
    reloads the outputs and the port: the warning comes down.

    Regression: d3e4644f1. A receiver's eFuse or pixel-count warning can
    only be taken down by the text stored on its port, and the reload's
    RemovePortConfiguration() reset the port, text and all: the banner
    stayed until fppd restarted. (The pixel-count warning, the same id
    held the same way, is not exercised here.)"""
    powered_port(fppd, eFuseRetryCount="0")
    trip()
    fppd.wait_for(lambda: efuse_warnings(fppd), timeout=10, what="the eFuse warning")
    os.unlink(pin_file(EFUSE))
    loads = fppd.log().count("Calling Init() on PixelCountSim output")
    fppd.write("config/co-pixelStrings.json", config(fppd))
    fppd.wait_for(lambda: fppd.log().count("Calling Init() on PixelCountSim output") > loads, timeout=20,
                  what="the outputs to reload")
    time.sleep(2)
    assert efuse_warnings(fppd) == [], efuse_warnings(fppd)


def test_a_port_turned_off_while_retrying_its_efuse_stays_off(fppd):
    """eFuse auto-retry on (5 retries, 1.5 s apart). The port trips, and
    the first retry pulses it back on at once; while the next is pending,
    with the fault still there, Outputs Off turns the port off. For the
    next 4 s the port's enable pin stays low: no retry powers it back up.

    Regression: 4387f1296. processRetries() kept pulsing the enable pin of
    a port that had been turned off while it was retrying, leaving it
    powered with the port marked off -- where a later trip is ignored."""
    powered_port(fppd, eFuseRetryCount="5", eFuseRetryInterval="1500", LogLevel_ChannelOut="debug")
    trip()
    fppd.wait_for(lambda: "Attempting reset retry" in fppd.log() or "eFuse triggered" in fppd.log(),
                  timeout=10, what="the eFuse trip to be seen")
    time.sleep(0.3)
    fppd.command("Outputs Off")
    fppd.wait_for(lambda: not high(ENABLE), timeout=5, what="Outputs Off to drop the enable pin")
    seen = []
    end = time.monotonic() + 4
    while time.monotonic() < end:
        seen.append(high(ENABLE))
        time.sleep(0.02)
    assert not any(seen), f"the enable pin went high {sum(seen)} times in 4 s with outputs off"


def port_status(fppd):
    return [p for p in fppd.get("/fppd/ports") if p.get("name") == "Port 1"]


def test_a_tripped_port_reports_a_fault_until_it_is_reset(fppd):
    """A port with an eFuse pin and no interrupt pin whose fuse trips shows
    status false in /fppd/ports, and keeps showing it after the eFuse pin
    reads good again (the port was turned off, which cleared it), until the
    outputs are turned back on.

    Regression: ef24128d9. The status followed the pin's present value, so a
    port that had tripped read healthy as soon as it was off."""
    powered_port(fppd, eFuseRetryCount="0")
    assert port_status(fppd)[0]["status"] is True
    trip()
    fppd.wait_for(lambda: efuse_warnings(fppd), timeout=10, what="the eFuse warning")
    os.unlink(pin_file(EFUSE))
    time.sleep(2)
    assert port_status(fppd)[0]["status"] is False, port_status(fppd)


def test_a_port_is_still_monitored_after_the_strings_are_saved_again(fppd):
    """Saving co-pixelStrings.json again with a different pixel count keeps
    the port in /fppd/ports, and its eFuse still raises its warning.

    Regression: 1d74ab059 (the port monitors vanished when a new string
    config was saved) and ce735a5ab (the reload reset the port monitor
    instead of deleting it under the output monitor)."""
    powered_port(fppd, eFuseRetryCount="0")
    loads = fppd.log().count("Calling Init() on PixelCountSim output")
    time.sleep(1.1)  # a save in a later second, as a person makes it
    fppd.write("config/co-pixelStrings.json", config(fppd, pixels=60))
    fppd.wait_for(lambda: fppd.log().count("Calling Init() on PixelCountSim output") > loads, timeout=20,
                  what="the outputs to reload")
    fppd.command("Outputs On")
    fppd.wait_for(lambda: port_status(fppd), timeout=10, what="Port 1 to be monitored again")
    trip()
    fppd.wait_for(lambda: efuse_warnings(fppd), timeout=10, what="the eFuse warning after the save")


def test_the_retry_count_applies_without_a_restart(fppd):
    """eFuseRetryCount changed while fppd runs (from 0 to 5, as the settings
    page does with no restart) takes effect on the next trip: the port is
    retried instead of raising its warning at once.

    Regression: de7f7c9f3. The count was read once at start, so the page's
    new value did nothing until fppd restarted (and the setting asked for
    that restart)."""
    from test_command_socket import send
    powered_port(fppd, eFuseRetryCount="0", eFuseRetryInterval="1500", LogLevel_ChannelOut="debug")
    send("SetSetting,eFuseRetryCount,5,")
    time.sleep(0.5)
    trip()
    fppd.wait_for(lambda: "Attempting reset retry" in fppd.log(), timeout=10, what="a retry after the trip")
    assert not efuse_warnings(fppd), "the trip raised its warning at once instead of retrying"
