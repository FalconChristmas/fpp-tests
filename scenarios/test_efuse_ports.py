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


def config(fppd, pixels=50, sim_pin=None):
    """co-pixelStrings.json: one PixelCountSim port with an enable and an
    eFuse pin."""
    return {"channelOutputs": [{
        "type": "PixelCountSim", "enabled": 1, "startChannel": 1,
        "channelCount": pixels * 3, "outputCount": 1,
        "outputs": [{
            "portNumber": 0, "protocol": "ws2811",
            "simCurrentFile": os.path.join(fppd.media, "tmp", "port1-ma"),
            "simWirePixels": pixels,
            "simPin": sim_pin if sim_pin is not None else {"enablePin": ENABLE, "eFusePin": EFUSE},
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
    held the same way, is not exercised here.)

    Also b3a8244a6, which made a reload remove each port and add it again:
    with the port only re-registered by name, the old trip state stayed
    and so did the banner."""
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
    config was saved: the port reset in place kept its emptied name).
    Coverage only for ce735a5ab (the reload resets the port monitor instead
    of deleting it under the output monitor): with the delete put back it
    still passes, since the race it closed is not reached here."""
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


def test_a_string_reload_sends_a_multisync_ping(fppd):
    """Saving co-pixelStrings.json again (the outputs reload and fppd works
    out its channel ranges afresh) sends a MultiSync ping straight away,
    so other systems need not wait for the next hourly ping to learn what
    changed.

    Regression: ce735a5ab (the ping after the output ranges change). The
    other half of it, resetting a port's monitor in place on a reload
    instead of deleting it under its GPIO callbacks, is a race this does
    not reach."""
    import contextlib
    from capture import UdpCapture
    from multisync import PORT
    from test_multisync_systems import interface

    def pings(caps):
        return sum(1 for c in caps for _, _, _, p in c.snapshot() if p[4:5] == b"\x04")

    with contextlib.ExitStack() as stack:
        stack.enter_context(interface("10.77.0.1"))
        throw_plugin.install(fppd, source="pixelcountsim.cpp", name="PixelCountSim")
        fppd.write("config/co-pixelStrings.json", config(fppd))
        fppd.start()
        # The ping goes out from the dummy interface; where the kernel puts
        # each copy (out of it, or back over loopback) is its business, so
        # both are watched.
        caps = [stack.enter_context(UdpCapture(PORT, iface=i)) for i in ("fpptest0", "lo")]
        loads = fppd.log().count("Calling Init() on PixelCountSim output")
        time.sleep(1.5)  # a save in a later second, as a person makes it
        before = pings(caps)
        fppd.write("config/co-pixelStrings.json", config(fppd, pixels=60))
        fppd.wait_for(lambda: fppd.log().count("Calling Init() on PixelCountSim output") > loads, timeout=20,
                      what="the outputs to reload")
        fppd.wait_for(lambda: pings(caps) > before, timeout=5, interval=0.1,
                      what=f"a ping after the reload ({before} before it)")


def test_the_retry_count_applies_without_a_restart(fppd):
    """eFuseRetryCount changed while fppd runs (from 0 to 5, as the settings
    page does with no restart) takes effect on the next trip: the port is
    retried instead of raising its warning at once.

    Also b07d2a609, which added the retries (a trip raised its warning at
    once, whatever the setting).

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


def test_a_port_moved_to_another_enable_pin_drives_the_new_one(fppd):
    """The string config is saved again with the port's enable pin moved
    to another line: after the reload, Outputs On drives the new pin high
    and the old one is no longer the port's.

    Regression: b3a8244a6. A reload re-registered each port by name only:
    a port already known kept the pins it was first given, so a changed
    enable or eFuse pin took effect only after fppd restarted.
    """
    moved = "TF-13"
    powered_port(fppd, eFuseRetryCount="0")
    if high(moved):
        os.unlink(pin_file(moved))
    cfg = config(fppd)
    cfg["channelOutputs"][0]["outputs"][0]["simPin"]["enablePin"] = moved
    loads = fppd.log().count("Calling Init() on PixelCountSim output")
    time.sleep(1.1)  # a save in a later second, as a person makes it
    fppd.write("config/co-pixelStrings.json", cfg)
    fppd.wait_for(lambda: fppd.log().count("Calling Init() on PixelCountSim output") > loads, timeout=20,
                  what="the outputs to reload")
    fppd.command("Outputs Off")
    fppd.command("Outputs On")
    fppd.wait_for(lambda: high(moved), timeout=10,
                  what=f"the moved enable pin {moved} to go high (old pin high: {high(ENABLE)})")


def start_with_pins(fppd, sim_pin, **settings):
    throw_plugin.install(fppd, source="pixelcountsim.cpp", name="PixelCountSim")
    fppd.write("config/co-pixelStrings.json", config(fppd, sim_pin=sim_pin))
    fppd.settings(**settings)
    for pin in (ENABLE, EFUSE):
        if high(pin):
            os.unlink(pin_file(pin))
    fppd.start()


def test_a_port_whose_enable_pin_does_not_exist_is_refused_and_fppd_goes_on(fppd):
    """A port configured with an enable pin the machine does not have raises
    the could-not-find-pin warning for it and is left unmonitored for
    power, and Outputs On and Off, the ports list and the status all carry
    on without a crash -- also when its eFuse trips with auto-retry on,
    which has no enable pin to pulse.

    Regression: c9399e47c and 972377af9. The missing pin was used as if it
    were there (an eFuse retry pulsed the null pin), and the pin lists were
    popped for a pin that was never pushed. Both are now also guarded
    elsewhere: e8bce1a7b drops a retry for a port with no enable pin, and
    71da49119 pushes a pin only once it is found, leaving nothing to pop."""
    start_with_pins(fppd, {"enablePin": "NOSUCHPIN", "eFusePin": EFUSE},
                    eFuseRetryCount="3", eFuseRetryInterval="100")
    fppd.wait_for(lambda: any("Could not find pin NOSUCHPIN" in w for w in fppd.get("/fppd/warnings")),
                  timeout=10, what="the could-not-find-pin warning")
    fppd.command("Outputs On")
    trip()
    time.sleep(1.5)
    fppd.check_alive()
    os.unlink(pin_file(EFUSE))
    fppd.command("Outputs Off")
    fppd.get("/fppd/ports")
    fppd.get("/fppd/status")
    fppd.check_alive()


def test_a_port_with_no_efuse_pin_survives_outputs_off_and_on(fppd):
    """A port with an enable pin and no eFuse pin turns off and on with
    Outputs Off and Outputs On, and the enable pin follows.

    Regression: 7833e6c39. The check for a tripped fuse that cleared its
    warning read the missing pin: a null dereference on the first pass."""
    start_with_pins(fppd, {"enablePin": ENABLE})
    fppd.command("Outputs On")
    fppd.wait_for(lambda: high(ENABLE), timeout=10, what="the enable pin to go high")
    time.sleep(1.5)
    fppd.command("Outputs Off")
    fppd.wait_for(lambda: not high(ENABLE), timeout=10, what="the enable pin to go low")
    fppd.check_alive()


def test_set_port_status_turns_one_port_on_and_off(fppd):
    """The Set Port Status command turns the named port's power off and on
    again: the enable pin goes low for "Port 1" false and high for true.

    Regression: 593df45c2 (the command added)."""
    powered_port(fppd, eFuseRetryCount="0")
    fppd.command("Set Port Status", "Port 1", "false")
    fppd.wait_for(lambda: not high(ENABLE), timeout=10, what="the port to go off")
    fppd.command("Set Port Status", "Port 1", "true")
    fppd.wait_for(lambda: high(ENABLE), timeout=10, what="the port to come back on")


def test_a_ports_bank_label_is_in_its_status(fppd):
    """A port configured with a "bank" label (the group a controller totals
    its current by) carries it in /fppd/ports, and one without carries none.

    Regression: 429970c25. The monitor was built without reading its config
    through setConfig(), so the bank label from the cape never reached the
    status and the page's per-bank totals were all labelled alike."""
    start_with_pins(fppd, {"enablePin": ENABLE, "eFusePin": EFUSE, "bank": "A"})
    fppd.wait_for(lambda: port_status(fppd), timeout=10, what="Port 1 to be monitored")
    assert port_status(fppd)[0].get("bank") == "A", port_status(fppd)
