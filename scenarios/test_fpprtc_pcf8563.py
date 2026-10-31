"""fpprtc with the PCF8563 RTC chosen (piRTC 6), and which /dev/rtcN a
PocketBeagle2 sets up, in the fppinit sandbox (fppinit.py): its
/sys/bus/i2c and /sys/class/rtc are the scenario's own, so the real buses
and clocks are never touched, and modprobe and hwclock are stubs that
record their calls.

fpprtc is built in the container with BUILD_FPPRTC=1 (scripts/build-fpp.sh);
the container has no modprobe or hwclock, so the scenario stubs them.
The PocketBeagle2 test runs only on one.
"""

import os
import subprocess

import pytest

from fppinit import fppinit  # noqa: F401 -- the fixture

I2C = {f"i2c-{n}/{f}": "" for n in range(4) for f in ("new_device", "delete_device")}


def on_pb2():
    try:
        with open("/proc/device-tree/model") as f:
            return "PocketBeagle2" in f.read()
    except OSError:
        return False


def fpprtc(sb):
    if not os.path.exists(os.path.join(sb.tree, "src", "fpprtc")):
        pytest.skip("no fpprtc in the tree under test")
    try:
        r = sb._run(["/opt/fpp/src/fpprtc"], timeout=30, media_home=True)
    except subprocess.TimeoutExpired:
        pytest.fail("fpprtc never exited")
    out = r.stdout + r.stderr
    assert "AddressSanitizer" not in out, out[-3000:]
    return out


def new_devices(sb):
    """What fpprtc asked the kernel to create, on each bus."""
    return {n: sb.faked("/sys/bus/i2c/devices", f"i2c-{n}/new_device") for n in range(4)
            if sb.faked("/sys/bus/i2c/devices", f"i2c-{n}/new_device")}


def test_a_pcf8563_is_set_up_at_0x51(fppinit):
    """piRTC 6 loads rtc-pcf8563 and creates a pcf8563 at 0x51 on the cape
    bus (i2c-1 on a Pi, i2c-2 on a BeagleBone).

    Feature: c590b0be7 (the fpprtc half; options.php's "pcf8563" entry
    is its other). Also 64c065d5c: the chip-setup cases moved from piRTC into
    fpprtc (a wrong module or device name there fails this)."""
    fppinit.stub_if_missing("/usr/sbin/modprobe", "/usr/sbin/hwclock")
    fppinit.settings(piRTC="6")
    fppinit.fake_path("/sys/bus/i2c/devices", dict(I2C))
    out = fpprtc(fppinit)
    assert "pcf8563" in out, out
    assert any(c.split()[:2] == ["modprobe", "rtc-pcf8563"] for c in fppinit.calls()), fppinit.calls()
    assert list(new_devices(fppinit).values()) == ["pcf8563 0x51"], new_devices(fppinit)


@pytest.mark.skipif(not on_pb2(), reason="the internal RTC check is a PocketBeagle2's")
def test_a_pb2_sets_up_the_capes_rtc_beside_the_internal_one(fppinit):
    """When rtc0 is the AM62x's own RTC (rtc-ti-k3, no battery), the cape's
    clock is set up as rtc1: the cape's chip is created even though
    /dev/rtc0 exists, and the time is not read from rtc0.

    Regression: c590b0be7 (the BB64 half). The check looked at rtc1's
    name, so with rtc0 the internal RTC fpprtc took /dev/rtc0 as the cape's
    clock, created nothing and set the system time from a clock with no
    battery."""
    if not os.path.exists("/dev/rtc0"):
        pytest.skip("no /dev/rtc0 here to stand for the internal RTC")
    fppinit.settings(piRTC="5")
    fppinit.fake_path("/sys/bus/i2c/devices", dict(I2C))
    fppinit.fake_path("/sys/class/rtc", {"rtc0/name": "rtc-ti-k3 2b1f0000.rtc\n"})
    fppinit.device("rtc0")
    out = fpprtc(fppinit)
    assert new_devices(fppinit) == {2: "pcf85363 0x51"}, f"{new_devices(fppinit)}\n{out}"
    assert not [c for c in fppinit.calls() if c.startswith("hwclock") and "/dev/rtc0" in c and "-s" in c], \
        fppinit.calls()
