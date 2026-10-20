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
    lists), and modprobe/rmmod as stubs that only log, for this mount
    namespace only.

    RGBMatrix's Init runs `rmmod snd_bcm2835` and `modprobe snd_dummy` when
    it finds snd_bcm2835 there -- on a device, taking its sound card away
    and adding a dummy one the device's PipeWire then picks up -- so a
    scenario hides the module, and makes sure no module command can reach
    the kernel if anything still tries. Yields the stub's log path."""
    kmod = os.path.realpath(shutil.which("rmmod") or "/usr/sbin/rmmod")
    if not os.path.exists(kmod):
        pytest.skip("no kmod here")
    with open("/proc/modules") as f:
        text = f.read().replace(name, "x" * len(name))
    work = tempfile.mkdtemp(prefix="modules-")
    fake, stub, log = (os.path.join(work, n) for n in ("modules", "kmod", "kmod.log"))
    with open(fake, "w") as f:
        f.write(text)
    with open(stub, "w") as f:
        f.write(f"#!/bin/sh\necho \"$(basename \"$0\") $*\" >> {log}\n")
    os.chmod(stub, 0o755)
    mounted = []
    try:
        for src, dst in ((fake, "/proc/modules"), (stub, kmod)):
            r = subprocess.run(["mount", "--bind", src, dst], capture_output=True, text=True)
            if r.returncode:
                pytest.skip(f"cannot bind over {dst} here: " + r.stderr.strip())
            mounted.append(dst)
        yield log
    finally:
        for dst in reversed(mounted):
            subprocess.run(["umount", dst])
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
        assert not os.path.exists(kmod_calls), open(kmod_calls).read()
    assert "The regular-pi1 pinout supports 1 output, but panels are assigned to 2" \
        in fppd.log(), fppd.tail()
    fppd.get("/fppd/status")
