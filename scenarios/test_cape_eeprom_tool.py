"""scripts/generateEEPROM reading a cape EEPROM image."""

import os
import subprocess

import cape_eeprom as ee

TREE = os.environ.get("FPP_TREE", "")


def test_a_signed_images_device_serial_is_read_from_after_the_cape_serial(tmp_path):
    """An image with a signed-data record (type 96: the 16-byte cape serial
    then the 42-byte device serial) reports both serials as written.

    Regression: 44cd0174f. The device serial was read from the wrong offset,
    shifted by the cape serial's length, so it came out as the wrong text."""
    cape_serial, device_serial = "CAPE-SERIAL-0001", "DEVICE-SERIAL-ABCDEF-0123456789"
    data = ee.header(serial="TEST0001") + ee.record(96, cape_serial.encode().ljust(16, b"\0") + device_serial.encode().ljust(42, b"\0")) + ee.END
    img = tmp_path / "signed.bin"
    img.write_bytes(data)
    r = subprocess.run(["php", "-d", "short_open_tag=1", os.path.join(TREE, "scripts", "generateEEPROM"), "-e", str(img), "-i"],
                       capture_output=True, text=True, timeout=30)
    out = r.stdout + r.stderr
    assert f"Device Serial #   : {device_serial}" in out, out
    assert f"{cape_serial}" in out, out


def test_a_serial_given_with_s_is_written_to_the_image(tmp_path):
    """generateEEPROM -s SERIAL (the value as the next argument) writes that
    serial into the image it generates.

    Regression: acf39a13a. -s was declared with an optional value, which
    PHP's getopt only takes when attached to the option, so "-s SERIAL"
    left the serial empty and the value was treated as a stray argument."""
    tool = os.path.join(TREE, "scripts", "generateEEPROM")
    img = tmp_path / "out.bin"
    gen = subprocess.run(["php", "-d", "short_open_tag=1", tool, "-n", "TestCape", "-s", "SER12345", "-l", "file", "-o", str(img)],
                         capture_output=True, text=True, timeout=30, cwd=tmp_path)
    assert img.exists(), gen.stdout + gen.stderr
    r = subprocess.run(["php", "-d", "short_open_tag=1", tool, "-e", str(img), "-i"],
                       capture_output=True, text=True, timeout=30)
    assert "Cape Serial #     : SER12345" in r.stdout + r.stderr, r.stdout + r.stderr
