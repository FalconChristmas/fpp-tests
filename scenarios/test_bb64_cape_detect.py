"""Cape detection (fppcapedetect) on a PocketBeagle2, in the fppinit
sandbox: the cape overlay it installs in /boot/firmware/overlays, the
default it puts back, the reboot it asks for (and the reboot loop it
refuses), the pin modes a cape asks for, the vendor's site in the content
security policy, and how much of an EEPROM chip it copies.

The sandbox's /boot/firmware is a scratch directory and its /sys/bus/i2c
a fake one where a scenario needs an EEPROM chip, so no real overlay,
pad or EEPROM is touched. The PB2 cases run with run-local.sh on a
PocketBeagle2 (fppcapedetect is built for the board it runs on, and the
overlay handling is PLATFORM_BB64's), skipped elsewhere; the rest
wherever the tree under test has fppcapedetect, a container included.
"""

import glob
import json
import os
import pwd
import subprocess
import threading
import time

import pytest

import cape_eeprom as ee
from fppinit import fppinit  # noqa: F401 -- the fixture
from test_cape_detect import EEPROM, asked_to_reboot, boot_read, boot_write, cape_info, detect


def on_pb2():
    try:
        with open("/proc/device-tree/model") as f:
            return "PocketBeagle2" in f.read()
    except OSError:
        return False


pb2_only = pytest.mark.skipif(not on_pb2(), reason="the cape overlay handling is a PocketBeagle2's")

OVERLAYS = "overlays"
BASE = "overlays/fpp-cape-overlay.dtb"
DEFAULT = "overlays/fpp-cape-overlay-default.dtb"
CAPE_OVERLAY = "fpp-cape-overlay-bb64.dtb"  # what a cape's archive ships it as


def default_overlays(sb, installed=b"default overlay"):
    boot_write(sb, DEFAULT, b"default overlay")
    boot_write(sb, BASE, installed)


@pb2_only
def test_a_capes_overlay_is_installed_for_the_next_boot(fppinit):
    """A cape whose archive ships fpp-cape-overlay-bb64.dtb gets it copied
    over overlays/fpp-cape-overlay.dtb (which extlinux.conf's fdtoverlays
    loads) and a reboot is asked for, so the next boot applies it. The
    shipped default is left as it was. Detecting the same cape again
    changes nothing and asks for no reboot.

    Feature: 8b6cd76ab (a cape may provide an overlay). Regression:
    dfba1d3d7 -- the cape's file is looked for as fpp-cape-overlay-bb64.dtb;
    before it, under the name the default overlay itself has."""
    default_overlays(fppinit)
    fppinit.write_bytes(EEPROM, ee.image(ee.cape_info(), files={CAPE_OVERLAY: "cape overlay"}))
    out = detect(fppinit)
    assert boot_read(fppinit, BASE) == b"cape overlay", out
    assert boot_read(fppinit, DEFAULT) == b"default overlay", out
    assert asked_to_reboot(fppinit), f"a new overlay needs a reboot to apply\n{out}"

    out = detect(fppinit)
    assert boot_read(fppinit, BASE) == b"cape overlay", out
    assert not asked_to_reboot(fppinit), f"nothing changed, yet a reboot was asked for\n{out}"


@pb2_only
def test_with_no_cape_the_default_overlay_is_put_back(fppinit):
    """With no cape at all, an installed overlay left by a cape that has
    since been removed is replaced by the shipped default, and a reboot is
    asked for so the old cape's pins and devices go away.

    Regression: be0b66b2a. The "Could not detect any cape" path returned
    before the overlay was looked at, so a removed cape's overlay stayed
    applied for good."""
    default_overlays(fppinit, installed=b"previous cape's overlay")
    out = detect(fppinit)
    assert "Could not detect any cape" in out, out
    assert boot_read(fppinit, BASE) == b"default overlay", out
    assert asked_to_reboot(fppinit), out


@pb2_only
def test_a_cape_without_an_overlay_puts_the_default_back(fppinit):
    """A cape that ships no overlay, replacing one that did, gets the
    shipped default overlay installed again and a reboot.

    Regression: 8e4a5691f (revert back to the default overlay if the cape
    is removed or changes). It decided from
    /proc/device-tree/chosen/overlays; 0eb78b87f compares the files now,
    and this checks the behaviour, not the mechanism."""
    default_overlays(fppinit, installed=b"previous cape's overlay")
    fppinit.write_bytes(EEPROM, ee.image(ee.cape_info()))
    out = detect(fppinit)
    assert "Could not detect any cape" not in out, out
    assert boot_read(fppinit, BASE) == b"default overlay", out
    assert asked_to_reboot(fppinit), out


@pb2_only
def test_a_read_only_probe_leaves_the_overlay_alone(fppinit):
    """`fppcapedetect -ro` (fppd's outputs, the setup wizard) only reads
    the cape: with no cape and a stale overlay installed it neither puts
    the default back nor reboots. The boot run then does.

    Feature: 9a056c9dd (the -ro mode)."""
    default_overlays(fppinit, installed=b"previous cape's overlay")
    out = detect(fppinit, "-ro")
    assert boot_read(fppinit, BASE) == b"previous cape's overlay", out
    assert not asked_to_reboot(fppinit), out

    out = detect(fppinit)
    assert boot_read(fppinit, BASE) == b"default overlay", f"the control: a full run restores it\n{out}"


@pb2_only
def test_a_reboot_that_did_not_fix_it_is_not_repeated(fppinit):
    """The reboot marker /.fppcapereboot still there means the last boot
    was cape detection's own reboot, and the overlay is changing again: the
    overlay is still installed, but instead of rebooting again (forever)
    it says so in media/tmp/reboot, which the UI shows.

    Regression: 9594b049a (prevent never ending reboot loops)."""
    default_overlays(fppinit)
    fppinit.root_file("/.fppcapereboot", " ")
    fppinit.write_bytes(EEPROM, ee.image(ee.cape_info(), files={CAPE_OVERLAY: "cape overlay"}))
    out = detect(fppinit)
    assert boot_read(fppinit, BASE) == b"cape overlay", out
    assert fppinit.media_exists("tmp/reboot"), f"no reboot-loop notice\n{out}"
    assert "Reboot Cycle Detected" in fppinit.media_file("tmp/reboot"), out


def test_copy_files_replace_a_longer_file_whole(fppinit):
    """copyFiles over a file that is longer than the cape's leaves exactly
    the cape's file, not the cape's bytes followed by the tail of the old
    one.

    Regression: 9594b049a (truncate before copying). The target was opened
    without O_TRUNC, so a shorter file was written over the start of the
    old one and the rest stayed: an asoundrc or config with garbage after
    it."""
    src = "/opt/fpp/etc/jurisdictions.json"
    with open(os.path.join(fppinit.tree, "etc", "jurisdictions.json"), "rb") as f:
        want = f.read()
    fppinit.write_bytes("config/cape-copied.json", want + b"\n" + b"x" * 8192)
    fppinit.write_bytes(EEPROM, ee.image(ee.cape_info(copyFiles={src: "config/cape-copied.json"})))
    out = detect(fppinit)
    with open(os.path.join(fppinit.media, "config/cape-copied.json"), "rb") as f:
        got = f.read()
    assert len(got) == len(want) and got == want, \
        f"{len(got)} bytes after the copy, the cape's file has {len(want)}\n{out[-2000:]}"


# A pinctrl that records how it was called, for the sandbox's /usr/bin.
PINCTRL = """#!/bin/sh
printf '%s\\n' "$*" >> /pinctrl-calls.log
exit 0
"""


@pb2_only
def test_a_cape_sets_the_pin_modes_it_asks_for(fppinit):
    """A cape-info "pinctrl" block ({pin: [mode, ...]}) has each mode set
    through pinctrl -s, in order, at detection; and the real pinctrl knows
    each pin and mode asked for here (its -l lists them).

    Feature: b959a8eba (capes may set pin states)."""
    tool = os.path.join(fppinit.tree, "capes", "drivers", "pinctrl", "pinctrl")
    if not os.path.exists(tool):
        pytest.skip("the tree's pinctrl is not built (make -C capes/drivers/pinctrl pinctrl)")
    fppinit.root_file("/usr/bin/pinctrl", PINCTRL)
    fppinit.write_bytes(EEPROM, ee.image(ee.cape_info(pinctrl={
        "P2_04": ["gpio_pu"], "P1_06": ["gpio", "gpio_pd"]})))
    out = detect(fppinit)
    calls = (fppinit.written("/pinctrl-calls.log") or "").splitlines()
    assert calls == ["-s P1_06 gpio", "-s P1_06 gpio_pd", "-s P2_04 gpio_pu"], f"{calls}\n{out}"
    for pin, mode in (("P2_04", "gpio_pu"), ("P1_06", "gpio"), ("P1_06", "gpio_pd")):
        listed = subprocess.run([tool, "-l", pin], capture_output=True, text=True, timeout=30)
        assert listed.returncode == 0 and mode in listed.stdout.replace("[", " ").replace("]", " ").split(), \
            f"pinctrl -l {pin}: {listed.stdout}{listed.stderr}"


def test_a_capes_vendor_site_is_added_to_the_allowed_domains(fppinit):
    """A cape's vendor site and the host of its logo are added to img-src
    in csp_allowed_domains.json, the list ManageApacheContentPolicy.sh
    builds the Apache policy from, so the cape page can show the vendor's
    logo.

    Feature: 2936b36bd (the cape-detect half; its other half, dropping
    three vendors from the stock img-src, is superseded by the script's
    rewritten defaults, and since then the script also reads the vendor
    from cape-info.json itself, so the generated header alone could not
    show this)."""
    fppinit.write_bytes(EEPROM, ee.image(ee.cape_info(vendor={
        "name": "fpp-tests", "url": "https://vendor.example.com/",
        "image": "https://images.example.net/logos/cape.png"})))
    out = detect(fppinit)
    assert fppinit.media_exists("config/csp_allowed_domains.json"), out
    csp = json.loads(fppinit.media_file("config/csp_allowed_domains.json"))
    assert "https://vendor.example.com/" in csp.get("img-src", []), f"{csp}\n{out}"
    assert "https://images.example.net/" in csp.get("img-src", []), f"{csp}\n{out}"


def eeprom_chip(sb, data):
    """A cape EEPROM chip at 2-0050 holding `data`, on a /sys/bus/i2c/devices
    of the scenario's own (the real buses never reachable)."""
    sb.fake_path("/sys/bus/i2c/devices", {
        "i2c-0/new_device": "", "i2c-0/delete_device": "",
        "i2c-1/new_device": "", "i2c-1/delete_device": "",
        "i2c-2/new_device": "", "i2c-2/delete_device": "",
        "2-0050/eeprom": data,
    })


def detect_with_chip(sb):
    """detect(), with i2cdetect (a stub in the sandbox) answering for a chip
    at 0x50, which is how cape detection probes for one."""
    sb.stub_output("i2cdetect", "-y", "50: 50\n")
    return detect(sb)


@pb2_only
def test_only_the_used_part_of_an_eeprom_chip_is_copied(fppinit):
    """Reading an EEPROM chip over i2c is slow, so it is copied 256 bytes
    at a time and the copy stops at the first block whose last 64 bytes are
    all 0xFF (an erased chip's fill): tmp/eeprom.bin ends there, however
    large the chip, and the cape is still detected from it.

    Regression: 5e2358f57. The whole chip was read, 32 KB for a 24c256."""
    img = ee.image(ee.cape_info())
    used = img + b"\xff" * (256 - len(img) % 256)
    chip = used + b"\xa5" * (32768 - len(used))
    eeprom_chip(fppinit, chip)
    out = detect_with_chip(fppinit)
    assert "2-0050/eeprom" in out, out
    assert cape_info(fppinit)["id"] == "TestCape", out
    with open(os.path.join(fppinit.media, "tmp/eeprom.bin"), "rb") as f:
        got = f.read()
    assert got == used, f"copied {len(got)} bytes of the 32768 byte chip, the cape uses {len(used)}\n{out}"


def test_a_chip_is_read_from_a_copy_and_let_go(fppinit):
    """A cape EEPROM found as a chip on i2c is copied to media/tmp/eeprom.bin
    and detected from the copy: where the chip was is recorded in
    tmp/eeprom_location.txt and in cape-info.json's eepromLocation, and the
    chip's device is deleted again, so nothing is left that could write
    over the EEPROM. Off a Beagle too: the chip is on whichever bus the
    platform looks at first (0, 1 on a Pi, 2 on a Beagle), so each has one.

    Regression: 68d0086cc. The chip stayed instantiated and was read (and
    reported) in place: the eeprom sysfs file stayed writable for the
    whole uptime.

    Also 8589afa84 (the EEPROM location and its validity in cape-info), and
    121a2107f: the copy is the fpp user's, not root's (fppcapedetect runs as
    root), so the web UI, as fpp, can read and replace it.
    """
    img = ee.image(ee.cape_info())
    data = img + b"\xff" * (32768 - len(img))  # an erased 24c256 past the image
    devs = {}
    for b in (0, 1, 2):
        devs.update({f"i2c-{b}/new_device": "", f"i2c-{b}/delete_device": "", f"{b}-0050/eeprom": data})
    fppinit.fake_path("/sys/bus/i2c/devices", devs)
    out = detect_with_chip(fppinit)
    assert fppinit.media_exists("tmp/eeprom_location.txt"), f"where the chip was is not recorded\n{out}"
    where = fppinit.media_file("tmp/eeprom_location.txt").strip()
    assert where.startswith("/sys/bus/i2c/devices/") and where.endswith("-0050/eeprom"), where
    bus = where.split("/")[-2].split("-")[0]
    info = cape_info(fppinit)
    assert info["id"] == "TestCape", out
    assert info.get("eepromLocation") == where, f"{info.get('eepromLocation')} != {where}"
    with open(os.path.join(fppinit.media, "tmp/eeprom.bin"), "rb") as f:
        got = f.read()
    assert got[:len(img)] == img, f"tmp/eeprom.bin is not the chip's ({len(got)} bytes)"
    st = os.stat(os.path.join(fppinit.media, "tmp/eeprom.bin"))
    try:
        fpp = pwd.getpwnam("fpp")
    except KeyError:
        fpp = None  # the Docker sandbox has no fpp user to hand the copy to; a player does
    if fpp:
        assert (st.st_uid, st.st_gid) == (fpp.pw_uid, fpp.pw_gid), \
            f"tmp/eeprom.bin is owned by {st.st_uid}:{st.st_gid}, not fpp ({fpp.pw_uid}:{fpp.pw_gid})"
    assert fppinit.faked("/sys/bus/i2c/devices", f"i2c-{bus}/delete_device").startswith("0x50"), \
        f"the chip on bus {bus} was left instantiated\n{out}"


def test_an_eeprom_the_kernel_is_slow_to_present_is_still_read(fppinit):
    """The EEPROM chip answers at 0x50 but its sysfs eeprom file only
    appears three seconds after "24c256 0x50" is written to the bus's
    new_device, as on an older armv6 Pi: detection waits for it, copies it
    and finds the cape.

    Regression: ce47f6e81 ("Older armv6 Pi's can take about 8-10 s to prepare
    the eeprom for reading, give it more time"). The wait was 50 x 10ms, and
    as long again after writing new_device a second time: a chip a Pi Zero
    took longer over was given up on ("Couldn't get eeprom") and the cape
    came up as no cape.
    """
    img = ee.image(ee.cape_info())
    data = img + b"\xff" * (32768 - len(img))
    devs = {}
    for b in (0, 1, 2):
        devs.update({f"i2c-{b}/new_device": "", f"i2c-{b}/delete_device": ""})
    fppinit.fake_path("/sys/bus/i2c/devices", devs)
    idx = list(fppinit.fakes).index("/sys/bus/i2c/devices")
    seen = {}
    stop = threading.Event()

    def kernel():
        # The run's copy of the fake directory is made when it starts.
        while not stop.is_set():
            for nd in glob.glob(os.path.join(fppinit.dir, "run-*", f"fake-{idx}", "i2c-*", "new_device")):
                with open(nd) as f:
                    if "24c256 0x50" in f.read():
                        seen["at"] = time.monotonic()
                        bus = os.path.basename(os.path.dirname(nd)).split("-")[1]
                        if stop.wait(3):
                            return
                        chip = os.path.join(os.path.dirname(os.path.dirname(nd)), f"{bus}-0050")
                        os.makedirs(chip, exist_ok=True)
                        with open(os.path.join(chip, "eeprom"), "wb") as e:
                            e.write(data)
                        seen["bus"] = bus
                        return
            time.sleep(0.02)

    t = threading.Thread(target=kernel, daemon=True)
    t.start()
    try:
        out = detect_with_chip(fppinit)
    finally:
        stop.set()
        t.join(5)
    assert "at" in seen, f"new_device was never written for the chip\n{out[-3000:]}"
    assert "bus" in seen, f"detection was over before the eeprom file appeared\n{out[-3000:]}"
    assert "Couldn't get eeprom" not in out, out[-3000:]
    assert cape_info(fppinit)["id"] == "TestCape", out[-3000:]
    with open(os.path.join(fppinit.media, "tmp/eeprom.bin"), "rb") as f:
        assert f.read()[:len(img)] == img
