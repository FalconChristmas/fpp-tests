"""Raspberry Pi-only channel outputs (SPI-nRF24L01, RGBMatrix) refusing a
config they can't run, before they reach any hardware.

Device only: run with run-local.sh on a Raspberry Pi (these plugins are only
built there). Skipped elsewhere.
"""

import contextlib
import os
import shutil
import subprocess
import tempfile

import pytest

import hosttools


def on_pi(model=""):
    try:
        with open("/proc/device-tree/model") as f:
            return f.read().startswith("Raspberry Pi" + (" " + model if model else ""))
    except OSError:
        return False


def have_plugin(fppd, name):
    if not on_pi() or not os.path.exists(os.path.join(fppd.tree, "src", f"libfpp-co-{name}.so")):
        pytest.skip(f"no {name} output in a Raspberry Pi build here")


def test_an_invalid_nrf24_speed_is_refused(fppd):
    """An SPI-nRF24L01 output saved with a speed it doesn't know (7) is
    refused with an error naming the speed and warning 40, and fppd carries
    on. The check runs before any SPI access, so no radio is needed.

    Regression: a2ddf1fd8. The error passed the int to "%s", which read it
    as a pointer: SIGSEGV in Init at startup.
    """
    have_plugin(fppd, "SPI-nRF24L01")
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "enabled": 1, "type": "SPI-nRF24L01", "startChannel": 1, "channelCount": 32,
        "speed": 7, "channel": 10}]})
    status = fppd.start()
    assert "Invalid speed 7 from config" in fppd.log(), fppd.tail()
    assert any("invalid speed" in w for w in status.get("warnings", [])), status


@contextlib.contextmanager
def without_module(name):
    """/proc/modules without `name` (not even in other modules' "used by"
    lists), for this mount namespace only.

    RGBMatrix's Init runs `rmmod snd_bcm2835` and `modprobe snd_dummy` when
    it finds snd_bcm2835 there -- on a device, taking its sound card away
    and adding a dummy one the device's PipeWire then picks up. run-local.sh
    already stands in for the module commands (they only log), so nothing
    reaches the kernel; hiding the module as well keeps the output on the
    path a board without the sound driver takes. Yields a hosttools.CallLog
    of the module commands run meanwhile."""
    if not hosttools.stubbed("kmod"):
        pytest.skip("needs run-local.sh's module-command stub (not --host-modules)")
    with open("/proc/modules") as f:
        text = f.read().replace(name, "x" * len(name))
    work = tempfile.mkdtemp(prefix="modules-")
    fake = os.path.join(work, "modules")
    with open(fake, "w") as f:
        f.write(text)
    r = subprocess.run(["mount", "--bind", fake, "/proc/modules"], capture_output=True, text=True)
    if r.returncode:
        shutil.rmtree(work, ignore_errors=True)
        pytest.skip("cannot bind over /proc/modules here: " + r.stderr.strip())
    try:
        yield hosttools.kmod_calls()
    finally:
        subprocess.run(["umount", "/proc/modules"])
        shutil.rmtree(work, ignore_errors=True)


def rgbmatrix(pinout, panels):
    """One RGBMatrix output of 32x16 panels; `panels` is (output, panel)
    pairs."""
    width = 32 * (max(p for _, p in panels) + 1)
    height = 16 * (max(o for o, _ in panels) + 1)
    return {"channelOutputs": [{
        "type": "LEDPanelMatrix", "subType": "RGBMatrix", "enabled": 1, "startChannel": 1,
        "channelCount": width * height * 3, "panelWidth": 32, "panelHeight": 16,
        "panelScan": 8, "wiringPinout": pinout, "colorOrder": "RGB", "brightness": 10,
        "panelColorDepth": 8, "invertedData": 0, "ledPanelsLayout": f"{width // 32}x{height // 16}",
        "panels": [{"outputNumber": o, "panelNumber": p, "colorOrder": "", "xOffset": p * 32,
                    "yOffset": o * 16, "orientation": "N"} for o, p in panels]}]}


@pytest.mark.skipif(on_pi("5") or on_pi("Compute Module 5"),
                    reason="RGBMatrix refuses a Raspberry Pi 5 before any of this")
def test_panels_on_more_outputs_than_the_pinout_has_are_refused(fppd):
    """Panels on outputs 1 and 2 of the regular-pi1 pinout, which has data
    pins for one chain, refuse the output with an error naming both counts,
    and fppd carries on.

    Regression: 7b4420973. FPP's own table said regular-pi1 had 2 chains and
    compared it with the panels per chain rather than the number of chains,
    so the config passed and the library's Framebuffer constructor
    abort()ed fppd at startup. The refusal comes before the library is
    asked for anything, so no GPIO is driven.
    """
    have_plugin(fppd, "matrix-RGBMatrix")
    fppd.write("config/channeloutputs.json", rgbmatrix("regular-pi1", [(0, 0), (1, 0)]))
    with without_module("snd_bcm2835") as kmod_calls:
        fppd.start()
        fppd.wait_for(lambda: "panels are assigned to" in fppd.log(), timeout=20,
                      what="the RGBMatrix output to be refused")
        assert not kmod_calls.calls(), kmod_calls.calls()
    assert "The regular-pi1 pinout supports 1 output, but panels are assigned to 2" \
        in fppd.log(), fppd.tail()
    fppd.get("/fppd/status")


def refused_before_the_library(fppd, cfg, preload=(), env=None):
    """Start fppd with `cfg` (an RGBMatrix output on an unknown pinout, so
    that a config getting past the check under test is refused at the
    pinout check, still before the library drives a GPIO) and return the
    RGBMatrix lines of its log once the output has been refused."""
    fppd.write("config/channeloutputs.json", cfg)
    with without_module("snd_bcm2835"):
        fppd.start(preload=list(preload), extra_env=env)
        fppd.wait_for(lambda: "exceeds maximum" in fppd.log() or "Raspberry Pi 5" in fppd.log()
                      or "Unknown LED panel wiring pinout" in fppd.log(), timeout=20,
                      what="the RGBMatrix output to be refused")
    return fppd.log()


def warnings50(fppd):
    return [w.get("message", "") for w in fppd.get("/fppd/status").get("warningInfo", []) if w.get("id") == 50]


@pytest.mark.skipif(on_pi("5") or on_pi("Compute Module 5"),
                    reason="RGBMatrix refuses a Raspberry Pi 5 before any of this")
def test_an_rgbmatrix_output_with_more_channels_than_fppd_has_is_refused(fppd):
    """An RGBMatrix output saved with a channel count past fppd's channel
    buffer (8M channels) is refused at once, with an error naming the count
    and warning 50, and fppd carries on.

    Regression: 254444b72 (the check; 60bc70ea8 made it compile, as it read
    a `channelCount` that isn't in scope there). Before it the count went
    unchecked into the output. The pinout here is one the library doesn't
    know, so without the check the output is refused at the pinout instead
    and no GPIO is driven either way.
    """
    have_plugin(fppd, "matrix-RGBMatrix")
    cfg = rgbmatrix("fpp-tests-no-such-pinout", [(0, 0)])
    cfg["channelOutputs"][0]["channelCount"] = 8192 * 1024 + 3
    log = refused_before_the_library(fppd, cfg)
    assert "channelCount 8388611 exceeds maximum of 8388608" in log, fppd.tail()
    assert any("channel count exceeds" in w for w in warnings50(fppd)), warnings50(fppd)


@pytest.mark.parametrize("model", ["Raspberry Pi Compute Module 5 Rev 1.0",
                                   "Raspberry Pi 5 Model B Rev 1.0"], ids=["cm5", "pi5"])
def test_an_rgbmatrix_output_on_a_compute_module_5_is_refused(fppd, model):
    """On a board whose device tree says "Raspberry Pi Compute Module 5" or
    "Raspberry Pi 5 Model B" (served to fppd by fakesys.so), the RGBMatrix
    output is refused -- the library can't drive the RP1's GPIO -- with
    warning 50.

    Regression: ace9b3ec5. Only "Raspberry Pi 5" was recognised, so on a CM5
    the output went on to the library. The pinout here is one the library
    doesn't know, so without the check the output is refused at the pinout
    instead and no GPIO is driven either way.

    Also 1e7eb1dfd, which added the Pi 5 check (the pi5 case): the library
    hung there. Its other half, the Null guards in the destructor and
    pointer initialisers, is not tested separately.
    """
    have_plugin(fppd, "matrix-RGBMatrix")
    dt = os.path.join(fppd.media, "tmp", "device-tree")
    os.makedirs(dt)
    with open(os.path.join(dt, "model"), "wb") as f:
        f.write(model.encode() + b"\0")
    import shims
    log = refused_before_the_library(fppd, rgbmatrix("fpp-tests-no-such-pinout", [(0, 0)]),
                                     preload=[shims.build("fakesys.c")],
                                     env={"FAKESYS": f"/proc/device-tree={dt}"})
    assert "RGBMatrix does work on Raspberry Pi 5" in log, fppd.tail()
    assert any("Raspberry Pi 5 / CM5" in w for w in warnings50(fppd)), warnings50(fppd)
