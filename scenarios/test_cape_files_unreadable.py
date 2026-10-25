"""Cape detection (fppcapedetect) when a file it reads is there but cannot
be read, in the fppinit sandbox (see test_cape_detect.py).

A file that exists and refuses to open is ordinary at boot: a sysfs node
whose device went away, a boot partition with odd permissions. Root reads
any regular file, so the unreadable file here is a link to a write-only
sysfs attribute, which the kernel refuses to open for reading even for
root (EACCES).

Runs on a device (fppcapedetect isn't built in a container).
"""

import os

import pytest

import cape_eeprom as ee
from fppinit import fppinit  # noqa: F401 -- the fixture
from test_cape_detect import detect, pi_only

EEPROM = "config/cape-eeprom.bin"
# Write-only (--w-------): open(O_RDONLY) fails with EACCES, as root too.
UNREADABLE = "/sys/bus/platform/drivers_probe"


def unreadable_link(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    os.symlink(UNREADABLE, path)


@pytest.fixture(autouse=True)
def _needs_unreadable():
    try:
        open(UNREADABLE, "rb").close()
    except PermissionError:
        return
    except OSError as e:
        pytest.skip(f"{UNREADABLE}: {e}")
    pytest.skip(f"{UNREADABLE} can be read here, so it cannot stand in for an unreadable file")


def test_an_eeprom_that_cannot_be_read_is_no_cape(fppinit):
    """The virtual EEPROM is there (a link to a node that refuses reads):
    detection reports a header mismatch, finds no cape and exits 0.

    Regression: 75b8c26ad. The header check fread() from fopen()'s result
    unchecked, so fppcapedetect died of SIGSEGV at boot instead of carrying
    on without a cape."""
    unreadable_link(os.path.join(fppinit.media, EEPROM))
    out = detect(fppinit)
    assert "EEPROM header miss-match" in out, out[-3000:]
    assert not fppinit.media_exists("tmp/cape-info.json"), out[-3000:]


@pi_only
def test_a_boot_config_that_cannot_be_read_is_left_alone(fppinit):
    """A cape is found, and config.txt -- which cape detection reads to
    manage the cape's overlay lines -- is there but refuses reads:
    detection exits 0 and leaves the file as it was. (It reads as empty,
    so detection then tries to add the overlay line, cannot write it
    either, and says so.)

    Regression: 75b8c26ad. get_file_contents() fseek()'d fopen()'s result
    unchecked, and fppcapedetect died of SIGSEGV."""
    fppinit.write_bytes(EEPROM, ee.image(ee.cape_info()))
    unreadable_link(os.path.join(fppinit.boot, "config.txt"))
    out = detect(fppinit)
    assert os.readlink(os.path.join(fppinit.boot, "config.txt")) == UNREADABLE, out[-3000:]
    assert "could not write /boot/firmware/config.txt" in out, out[-3000:]
