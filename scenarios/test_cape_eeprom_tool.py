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
