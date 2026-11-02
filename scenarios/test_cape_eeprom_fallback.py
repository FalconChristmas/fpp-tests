"""Cape detection (fppcapedetect) when the EEPROM it finds first is not an
FPP one, in the fppinit sandbox (see test_cape_detect.py)."""

import cape_eeprom as ee
from fppinit import fppinit  # noqa: F401 -- the fixture
from test_cape_detect import EEPROM, cape_info, detect


def test_a_bad_vendor_eeprom_falls_back_to_the_virtual_one_in_config(fppinit):
    """The vendor fallback image is there but is not an FPP EEPROM (zeroed),
    and the user has uploaded a virtual one to config/cape-eeprom.bin: the
    header mismatch is reported and the uploaded image is the cape found.

    Regression: 5abd09838. The fallback tested file_exists() the wrong way
    round: an uploaded image was thrown away as "no cape", and it was used
    only when there was none."""
    fppinit.root_file("/opt/fpp-vendor/cape-eeprom.bin", "\0" * 128)
    fppinit.write_bytes(EEPROM, ee.image(ee.cape_info()))
    out = detect(fppinit)
    assert "EEPROM header miss-match" in out, out
    assert cape_info(fppinit)["id"] == "TestCape", out
