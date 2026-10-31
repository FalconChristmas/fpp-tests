"""How a cape and a board get their identity -- the serial written to a
blank cape EEPROM, the unit number given to a repaired PocketBeagle2
EEPROM, and the system UUID FPP reports -- plus fppcapedetect's
-force-defaults, in the fppinit sandbox (fppinit.py).
"""

import json
import os
import re
import shutil

import pytest

import cape_eeprom as ee
from fppinit import MEDIA, fppinit  # noqa: F401 -- the fixture
from test_cape_detect import EEPROM, detect, settings_of

# --- upgradeCapeFirmware on a blank EEPROM ---------------------------------

# Not under media/tmp, which the cape detection run at the end empties.
BLANK = "upload/fpp-tests-eeprom.bin"


def flash(sb, image):
    """scripts/upgradeCapeFirmware with `image` onto a blank (all 0xFF)
    EEPROM, which media/tmp/eeprom_location.txt points at as CapeUtils
    leaves it. Returns what was written."""
    sb.write_bytes(BLANK, b"\xff" * 32768)
    sb.write("tmp/eeprom_location.txt", f"/home/fpp/media/{BLANK}")
    sb.write_bytes("upload/fpp-tests-image.bin", image)
    r = sb._run(["/opt/fpp/scripts/upgradeCapeFirmware", "/home/fpp/media/upload/fpp-tests-image.bin"],
                timeout=180, media_home=True)
    out = r.stdout + r.stderr
    assert "Blank EEPROM" in out, out[-3000:]
    with open(os.path.join(sb.media, BLANK), "rb") as f:
        return f.read(), out


def cs_value(data):
    """The value of the 'cs' type-97 record, and where it is."""
    pos = 58
    while pos + 8 <= len(data):
        length = int(data[pos:pos + 6].rstrip(b"\0") or b"0")
        if length == 0:
            break
        code = int(data[pos + 6:pos + 8].rstrip(b"\0"))
        if code == 97 and data[pos + 8:pos + 20].rstrip(b"\0") == b"cs":
            return data[pos + 20:pos + 8 + length], pos + 20
        pos += 8 + length + (64 if code < 50 else 0)
    return None, None


def test_a_blank_eeprom_gets_a_serial_of_its_own(fppinit):
    """Flashing a vendor image onto a blank EEPROM gives the cape a serial
    of its own -- "FPP-" and 12 hex digits, different on every flash --
    instead of the sample serial the image was built with, and blanks the
    image's 'cs' checksum (which vouches for that sample) in place, so
    nothing else in the image moves.

    Regression: 11b0ee7c2. The image was copied verbatim, so every cape
    flashed from one downloadable image had the same serial.
    """
    image = ee.image(ee.cape_info(), serial="200824211045", extras={"cs": "0123456789abcdef"})
    first, out = flash(fppinit, image)
    serial = first[42:58].decode()
    assert re.fullmatch(r"FPP-[0-9A-F]{12}", serial), f"serial {serial!r}:\n{out[-2000:]}"
    cs, at = cs_value(first)
    assert cs == b"\0" * 16, f"the sample serial's checksum was kept: {cs!r}"
    assert len(first) == len(image), "the image changed length"
    differ = [i for i in range(len(image)) if first[i] != image[i]]
    assert all(42 <= i < 58 or at <= i < at + 16 for i in differ), \
        f"bytes outside the serial and the checksum changed: {differ[:20]}"

    second, _ = flash(fppinit, image)
    assert second[42:58].decode() != serial, "two flashes of one image got the same serial"


def test_a_virtual_eeprom_image_keeps_its_internal_serial(fppinit):
    """FPP's own virtual EEPROM images carry the serial FPP-INTERNAL, which
    the cape pages key on; they are written exactly as they are.

    Regression: 11b0ee7c2 (the exception it makes).
    """
    image = ee.image(ee.cape_info(), serial="FPP-INTERNAL")
    written, out = flash(fppinit, image)
    assert written == image, out[-2000:]


# --- fppcapedetect -force-defaults -----------------------------------------

def test_force_defaults_resets_a_users_value_to_the_capes(fppinit):
    """`fppcapedetect -force-defaults` -- the firmware upgrade page's "reset
    to defaults" -- sets each of the cape's defaults even where the user
    chose otherwise, replacing the line rather than adding a second; it
    still may not switch on telemetry where that needs prior opt-in.

    Regression: 55ed9a5d1. The never-override rule had made the flag do
    nothing for exactly the settings it exists to reset.
    """
    fppinit.settings(CapeTestChosen="mine", LegalJurisdiction="EU")
    fppinit.write_bytes(EEPROM, ee.image(ee.cape_info(defaultSettings={
        "CapeTestChosen": "cape", "statsPublish": "Enabled"})))
    out = detect(fppinit)
    assert settings_of(fppinit).get("CapeTestChosen") == "mine", f"the control: a plain detect\n{out}"

    out = detect(fppinit, "-force-defaults")
    s = settings_of(fppinit)
    assert s.get("CapeTestChosen") == "cape", f"{fppinit.media_file('settings')}\n{out}"
    lines = [l for l in fppinit.media_file("settings").splitlines() if l.split("=")[0].strip() == "CapeTestChosen"]
    assert len(lines) == 1, f"CapeTestChosen lines: {lines}"
    assert "statsPublish" not in s, f"-force-defaults switched telemetry on in the EU:\n{out}"


# --- PocketBeagle2 EEPROM repair -------------------------------------------

# Stands in for xxd where the system has none (images built before it was
# added): -r turns a dump back into bytes, -p prints plain hex.
XXD = """#!/usr/bin/python3
import sys
if "-r" in sys.argv:
    out = bytearray()
    for line in sys.stdin:
        if ":" not in line:
            continue
        off, rest = line.split(":", 1)
        data = bytes.fromhex(rest.strip().split("  ")[0].replace(" ", ""))
        off = int(off, 16)
        out[off:off + len(data)] = data
    sys.stdout.buffer.write(bytes(out))
else:
    print(sys.stdin.buffer.read().hex())
"""


def repair(sb, script, eeprom):
    sb.write_bytes("tmp/pb2-eeprom.bin", eeprom)
    if not shutil.which("xxd"):
        sb.root_file("/usr/bin/xxd", XXD)
    r = sb._run(["env", f"PB2_EEPROM={MEDIA}/tmp/pb2-eeprom.bin", "bash",
                 f"/opt/fpp/capes/drivers/bb64/{script}"])
    with open(os.path.join(sb.media, "tmp", "pb2-eeprom.bin"), "rb") as f:
        data = f.read()
    assert data[:4] == b"\xaa\x55\x33\xee", f"no board EEPROM written:\n{(r.stdout + r.stderr)[-2000:]}"
    return data[50:56].decode(errors="replace")


@pytest.mark.parametrize("script", ["fix_pb2_eeprom.sh", "fix_pb2i_eeprom.sh"])
def test_a_repaired_pocketbeagle2_gets_a_unit_number_the_factory_cannot_issue(fppinit, script):
    """The PocketBeagle2 EEPROM repair gives a board whose unit number is
    blank, or only partly programmed, six digits led by 2-9 -- the factory
    never issues past 9999, so its numbers all lead with 0 -- and keeps a
    fully programmed factory number exactly as it is.

    Regression: d3f92966d. Only the low four digits were randomized, inside
    the factory's range, so repaired boards could collide with real ones
    (and shared their first twelve characters with each other).
    """
    for eeprom in (b"\xff" * 256, b"\xff" * 50 + b"00" + b"\xff" * 204):
        unit = repair(fppinit, script, eeprom)
        assert re.fullmatch(r"[2-9][0-9]{5}", unit), f"assigned unit number {unit!r}"
    programmed = bytearray(b"\xff" * 256)
    programmed[50:56] = b"001234"
    assert repair(fppinit, script, bytes(programmed)) == "001234", "a factory unit number was replaced"


# --- get_uuid ----------------------------------------------------------------

DMIDECODE = """#!/bin/sh
printf 'System Information\\n\\tManufacturer: fpp-tests\\n\\tSerial Number: Not Specified\\n'
printf '\\tUUID: 4c4c4544-0042-3510-8051-b4c04f4e4d32\\n'
"""


def get_uuid(sb, *args, container=False):
    env = ["env", "FPP_DOCKERENV=/fpp-tests-none"]
    if not container:
        env.append("FPP_CONTAINERFILE=/fpp-tests-none")
    r = sb._run([*env, "/opt/fpp/scripts/get_uuid", *args], media_home=True)
    assert r.returncode == 0, r.stdout + r.stderr
    return r.stdout.strip()


def test_a_placeholder_dmi_serial_is_not_an_identity(fppinit):
    """A DMI serial of "Not Specified" (what most boards without one say)
    is passed over for the DMI UUID, not cut down to "Not".

    Regression: b9f68c58a. The serial was one awk field, so "Not" became
    the identity of every such machine.
    """
    if open("/proc/cpuinfo").read().lower().count("serial"):
        pytest.skip("this machine's /proc/cpuinfo has a serial, which get_uuid takes first")
    fppinit.root_file("/usr/sbin/dmidecode", DMIDECODE)
    fppinit.root_file("/etc/machine-id", "0123456789abcdef0123456789abcdef\n")
    assert get_uuid(fppinit) == "M2-4c4c4544-0042-3510-8051-b4c04f4e4d32"
    assert get_uuid(fppinit, "--source") == "dmidecode"


def test_an_uninitialized_machine_id_is_not_an_identity(fppinit):
    """The literal "uninitialized" that images ship in /etc/machine-id is
    never reported; with no other source, a generated UUID is.

    Regression: b9f68c58a.
    """
    if open("/proc/cpuinfo").read().lower().count("serial"):
        pytest.skip("this machine's /proc/cpuinfo has a serial, which get_uuid takes first")
    fppinit.root_file("/usr/sbin/dmidecode", None)
    fppinit.root_file("/etc/machine-id", "uninitialized\n")
    uuid = get_uuid(fppinit)
    assert "uninitialized" not in uuid, uuid
    assert re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", uuid), uuid
    assert get_uuid(fppinit, "--source") == "generated"


def test_a_container_keeps_its_identity_in_the_media_directory(fppinit):
    """In a container every hardware source is the host's (and machine-id
    the image's), so get_uuid uses a generated UUID kept in the media
    directory, which a recreated container -- a fresh /etc -- still has.

    Feature: b9f68c58a.
    """
    fppinit.root_file("/usr/sbin/dmidecode", DMIDECODE)
    fppinit.root_file("/etc/fpp/container", "")
    first = get_uuid(fppinit, container=True)
    assert fppinit.media_exists("config/fpp_uuid"), "no copy in the media directory"
    assert fppinit.media_file("config/fpp_uuid").strip() == first
    # Each run starts from a fresh overlay: /etc/fpp/fpp_uuid is gone again.
    assert get_uuid(fppinit, container=True) == first
    assert get_uuid(fppinit, "--source", container=True) == "container"


# --- upgradeCapeFirmware on a signed EEPROM --------------------------------

def test_a_signed_eeprom_keeps_its_signature_when_the_backup_copy_fails(fppinit):
    """Upgrading a signed cape with an unsigned image of the same cape carries
    the signature section across even when the backup copy of the old
    EEPROM cannot be made, and says so.

    Regression: a6bbb5842 (and 3397da27b). The signature was read back
    from the backup file, so a failed copy() quietly left the cape
    unlicensed.
    """
    sig = (b"KEY123"[:6].decode(), b"S" * 64)
    old = ee.image(ee.cape_info(), signature=sig)
    new = ee.image(ee.cape_info(), extras={"cs": "0123456789abcdef"})
    fppinit.write_bytes("config/fpp-tests-eeprom.bin", old + b"\xff" * (32768 - len(old)))
    fppinit.write("tmp/eeprom_location.txt", "/home/fpp/media/config/fpp-tests-eeprom.bin")
    fppinit.write_bytes("config/fpp-tests-image.bin", new)
    # a file where the backups directory should be: the backup copy fails
    shutil.rmtree(os.path.join(fppinit.media, "upload"), ignore_errors=True)
    fppinit.write("upload", "not a directory")
    r = fppinit._run(["/opt/fpp/scripts/upgradeCapeFirmware", "/home/fpp/media/config/fpp-tests-image.bin"],
                     timeout=180, media_home=True)
    out = r.stdout + r.stderr
    with open(os.path.join(fppinit.media, "config", "fpp-tests-eeprom.bin"), "rb") as f:
        result = f.read()
    assert "Found Cape" in out, out[-3000:]
    assert b"S" * 64 in result and b"KEY123" in result, f"the signature section was lost:\n{out[-2500:]}"
    assert "Preserved signature section from previous EEPROM" in out, out[-2500:]
