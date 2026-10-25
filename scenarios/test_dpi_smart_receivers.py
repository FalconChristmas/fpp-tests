"""DPIPixels strings on a latch cape, licensed past two outputs.

Device only: run with run-local.sh on a Raspberry Pi with a signed cape
EEPROM in its media tmp/eeprom.bin, as cape detection leaves it. Without a
license only two strings get smart receivers or latch banks, and the banks
these need are never reached; run-local.sh offers the EEPROM as an unsigned
virtual one, since its signature is bound to the bus. So the tests put it
back on the bus: a stand-in i2cdetect answers at 0x50 on i2c-1, and
fakesys.so serves the copy as that chip's sysfs eeprom file. Cape string
configs go to /opt/fpp/capes/pi/strings, which run-local.sh overlays, as in
test_dpi_pixels.py.

The smart receiver overflow needs an ASan build (the 16K-page kernel); its
Init may fail afterwards for want of a DPI display connector, and only what
happens before that matters. The latch banks case runs on the fake DPI
panel of fakedrm.so.
"""

import os
import shutil

import pytest

import shims
from fppd import sanitizer
from test_dpi_pixels import on_pi, write_cape

DEVICE_EEPROM = "/home/fpp/media/tmp/eeprom.bin"


def signed_cape_env(fppd):
    """(preload, extra_env) that show fppd the device's signed cape EEPROM
    on i2c-1 at 0x50."""
    try:
        with open(DEVICE_EEPROM, "rb") as f:
            image = f.read()
    except OSError:
        pytest.skip(f"no cape EEPROM in {DEVICE_EEPROM}")
    if not image.startswith(b"FPP02") or b"99" not in image:
        pytest.skip("the cape EEPROM is not signed")
    chip = os.path.join(fppd.media, "tmp", "i2c-1-0050")
    os.makedirs(chip)
    shutil.copy(DEVICE_EEPROM, os.path.join(chip, "eeprom"))
    # Where cape detection found it this boot (the overlay keeps the device's
    # own file out of reach of this write).
    with open("/home/fpp/media/tmp/eeprom_location.txt", "w") as f:
        f.write("/sys/bus/i2c/devices/1-0050/eeprom")
    bindir = os.path.join(fppd.media, "tmp", "bin")
    os.makedirs(bindir)
    with open(os.path.join(bindir, "i2cdetect"), "w") as f:
        f.write("#!/bin/sh\necho '50: 50'\n")
    os.chmod(os.path.join(bindir, "i2cdetect"), 0o755)
    return [shims.build("fakesys.c")], {"FAKESYS": f"/sys/bus/i2c/devices/1-0050={chip}",
                                        "PATH": bindir + ":" + os.environ["PATH"]}


# Four outputs on one pin, one per latch bank: the fourth is in the last.
CAPE = {"latches": ["P1-29", "P1-31", "P1-26", "P1-24"],
        "outputs": [{"pin": "P1-7"}, {"sharedOutput": 0}, {"sharedOutput": 0}, {"sharedOutput": 0}]}


def vstring(desc, start, pixels):
    return {"description": desc, "startChannel": start, "pixelCount": pixels, "groupCount": 0,
            "reverse": 0, "colorOrder": "RGB", "nullNodes": 0, "endNulls": 0, "zigZag": 0,
            "brightness": 100, "gamma": "1.0"}


def plain(port, start, pixels=10):
    return {"portNumber": port, "protocol": "ws2811", "virtualStrings": [vstring(f"port{port}", start, pixels)]}


@pytest.mark.skipif(not on_pi(), reason="DPIPixels is built for a Raspberry Pi")
def test_a_long_smart_receiver_string_in_the_last_latch_bank_stays_in_its_mask(fppd):
    """A string in the last latch bank on two v1 smart receivers: the first
    receiver's 36-channel marker and 1588 pixels fill the string's 4800
    channels, so the second receiver's marker (and the rest of the string)
    is past what a DPI string can have. Init builds the string's receiver on/off mask
    without writing past it, and goes on to refuse the string.

    Regression: 1eb33c85b. The mask was built before the length check, from
    every receiver marker on the string: the second receiver's lead-in and
    lead-out, at channels 4800-4817 and 4854-4871, were cleared in
    onOffMask[3][...], past the last bank's row, over the members after it
    and off the end of the output object: an ASan heap-buffer-overflow in
    DPIPixelsOutput::Init().
    """
    if sanitizer(fppd.tree) != "asan":
        pytest.skip("needs an ASan build to see the overflow")
    write_cape("TestLatchDPI", CAPE)
    long_port = {"portNumber": 3, "protocol": "ws2811", "differentialType": 2,
                 "virtualStrings": [vstring("A", 120, 1588)],
                 "virtualStringsB": [vstring("B", 4884, 10)]}
    fppd.write("config/co-pixelStrings.json", {"channelOutputs": [
        {"type": "DPIPixels", "subType": "TestLatchDPI", "enabled": 1, "startChannel": 1,
         "channelCount": 4914, "outputCount": 4,
         "outputs": [plain(0, 0), plain(1, 30), plain(2, 60), long_port]}]})
    fppd.settings(LogLevel_ChannelOut="debug")
    preload, env = signed_cape_env(fppd)
    fppd.start(preload=preload, extra_env=env)
    out = fppd.log()
    with open(os.path.join(fppd.media, "logs", "fppd.stdout")) as f:
        detect = f.read()
    # The control: the cape was found signed on the bus, so all four strings
    # are licensed and the last one keeps its receivers and its length.
    assert "eeprom location is valid" in detect and "signature verified" in detect, detect[-2000:]
    if "DPIPixels is licensed for" in out:
        pytest.skip("the cape licenses too few DPI outputs; the last bank's strings get no smart receivers")
    # Past the mask: refused for its length, or (no DPI connector here) for
    # want of a framebuffer, both of which come after it.
    assert "Max 4800 channels (1600 pixels) per string" in out or \
        "cannot open FrameBuffer device" in out, fppd.tail()


def test_two_latched_outputs_on_one_pin_each_take_1600_pixels(fppd):
    """A latch cape with two outputs on one data pin, in latch banks 0 and
    1, each with the full 1600 pixels: DPIPixels comes up on the fake DPI
    panel sized for one 4800-channel string over two latch banks, with no
    warning.

    Coverage for 87f8f80c8, which gave every latched output the full 1600
    pixels: before it, outputs sharing a pin through latches shared that
    pin's 1600. Its parent predates the KMS DPI output the fake panel
    drives, and no hand patch brings the shared banks back, so this cannot
    be shown red.
    """
    import fakedrm
    write_cape("TestLatch2", {"latches": ["P1-29", "P1-31"],
                              "outputs": [{"pin": "P1-7"}, {"sharedOutput": 0}]})
    fppd.write("config/co-pixelStrings.json", {"channelOutputs": [
        {"type": "DPIPixels", "subType": "TestLatch2", "enabled": 1, "startChannel": 1,
         "channelCount": 9600, "outputCount": 2,
         "outputs": [plain(0, 0, 1600), plain(1, 4800, 1600)]}]})
    fppd.settings(LogLevel_ChannelOut="info")
    preload, env = fakedrm.dpi_env(fppd)
    more, more_env = signed_cape_env(fppd)
    env.update(more_env)
    fppd.start(preload=preload + more, extra_env=env)
    fppd.wait_for(lambda: "DPIPixels: framebuffer 1920x" in fppd.log(), timeout=15,
                  what="DPIPixels to come up on the fake DPI panel")
    assert "for 4800 channel longest string, 2 latch banks" in fppd.log(), fppd.tail()
    warnings = fppd.get("/fppd/status").get("warnings", [])
    assert not [w for w in warnings if "DPI" in w], warnings
