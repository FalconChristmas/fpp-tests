"""The RGBMatrix output and the Pi's onboard sound driver, on a Raspberry Pi
that is not a Pi 5 (RGBMatrix refuses those first).

Device only: run with run-local.sh on a Raspberry Pi. The module commands
are run-local.sh's stand-ins, which only log, so the driver is never
really unloaded: it stays in /proc/modules, the case the output refuses.
"""

import contextlib
import os
import shutil
import tempfile
import subprocess

import pytest

import hosttools
from test_pi_outputs import have_plugin, on_pi, rgbmatrix


@contextlib.contextmanager
def with_module(name):
    """/proc/modules listing `name`, for this mount namespace only: the real
    list if it has it, one more line if not. Yields a hosttools.CallLog of the
    module commands run meanwhile."""
    if not hosttools.stubbed("kmod"):
        pytest.skip("needs run-local.sh's module-command stub (not --host-modules)")
    with open("/proc/modules") as f:
        text = f.read()
    if name not in text:
        text += f"{name} 24576 0 - Live 0x0000000000000000\n"
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


@pytest.mark.skipif(on_pi("5") or on_pi("Compute Module 5"),
                    reason="RGBMatrix refuses a Raspberry Pi 5 before any of this")
def test_a_matrix_output_unloads_the_onboard_sound_driver_or_refuses(fppd):
    """With snd_bcm2835 loaded, the RGBMatrix output runs rmmod on it and
    modprobe snd_dummy (so the box keeps a sound card); if it is still
    loaded after that the output is refused, with a warning that says to
    reboot, and fppd carries on.

    Regression: 6274fbf57. The panel library drives the pins the onboard
    sound shares: the output came up with the driver loaded and the panel
    flickered or stayed dark."""
    have_plugin(fppd, "matrix-RGBMatrix")
    fppd.write("config/channeloutputs.json", rgbmatrix("regular-pi1", [(0, 0)]))
    with with_module("snd_bcm2835") as kmod_calls:
        fppd.start()
        fppd.wait_for(lambda: "snd_bcm2835 is stil loaded" in fppd.log(), timeout=20,
                      what="the RGBMatrix output to be refused")
        calls = kmod_calls.calls()
    assert [c for c in calls if c.startswith("rmmod") and "snd_bcm2835" in c], calls
    assert [c for c in calls if c.startswith("modprobe") and "snd_dummy" in c], calls
    warnings = [w.get("message", "") for w in fppd.get("/fppd/status").get("warningInfo", [])]
    assert any("cannot run with snd_bcm2835 enabled" in w for w in warnings), warnings
