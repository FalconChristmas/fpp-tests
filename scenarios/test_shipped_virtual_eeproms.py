"""The virtual EEPROM images fpp ships under capes/: each one reads, names
the cape it is for, and publishes what it provides when installed.

They are binary files, committed in bulk, and nothing else opens them
until someone installs one on a box.
"""

import glob
import io
import json
import os
import subprocess
import tarfile

import pytest

from fppinit import fppinit  # noqa: F401 -- the fixture
from test_cape_detect import EEPROM, cape_info, detect

TREE = os.environ.get("FPP_TREE", "")
IMAGES = sorted(glob.glob(os.path.join(TREE, "capes", "*", "*-eeprom.bin")))


def archive_info(path, tmp_path):
    out = tmp_path / "x"
    r = subprocess.run(["php", "-d", "short_open_tag=1", os.path.join(TREE, "scripts", "generateEEPROM"),
                        "-e", path, "-x", str(out)], capture_output=True, text=True, timeout=30)
    tgz = out / "tmp" / "cape-info.tgz"
    assert tgz.exists(), r.stdout + r.stderr
    with tarfile.open(tgz) as t:
        names = [m.name.removeprefix("./") for m in t.getmembers()]
        member = next(m for m in t.getmembers() if m.name.removeprefix("./") == "cape-info.json")
        info = json.load(io.TextIOWrapper(t.extractfile(member)))
    info["_files"] = names
    return info


def test_there_are_shipped_images_to_check():
    """The control for the sweep below: it must find the images, or it
    passes having checked none."""
    assert len(IMAGES) >= 10, IMAGES


@pytest.mark.parametrize("path", IMAGES, ids=[os.path.relpath(p, os.path.join(TREE, "capes")) for p in IMAGES])
def test_a_shipped_virtual_eeprom_reads_and_names_its_cape(path, tmp_path):
    """Each capes/*/*-eeprom.bin parses (generateEEPROM -e), holds a
    cape-info.json, and that cape-info names the cape the image's name field
    is a prefix of or has as a prefix.

    Feature: 4b8c1805b and the other commits that added or changed these
    binary images (a truncated or hand-edited one is unreadable until a
    user installs it).
    """
    info = archive_info(path, tmp_path)
    r = subprocess.run(["php", "-d", "short_open_tag=1", os.path.join(TREE, "scripts", "generateEEPROM"),
                        "-e", path, "-i"], capture_output=True, text=True, timeout=30)
    name = [l.split(":", 1)[1].strip() for l in r.stdout.splitlines() if l.startswith("Cape Name")]
    assert name, r.stdout + r.stderr
    # a revision's id and the image's name differ by a suffix either way
    # (F8-Bv2 against F8-B, DPIPixels-24 against DPIPixels-24v1)
    cid = info.get("id", "")
    assert cid and (name[0].startswith(cid) or cid.startswith(name[0])), (name, info)


@pytest.mark.parametrize("image,provides", [("rPi-28D", ["strings"]), ("rPi-MFC", ["panels", "strings"])])
def test_a_shipped_pi_virtual_eeprom_publishes_what_it_provides(fppinit, image, provides):
    """Installed as the virtual EEPROM, rPi-28D provides strings and rPi-MFC
    panels and strings, and neither disables the DPI pixel output.

    Feature: 4db65409e (the provides lists), 32cd0ce61 (rPi-28D keeps
    DPIPixels enabled).
    """
    with open(os.path.join(TREE, "capes", "pi", f"{image}-eeprom.bin"), "rb") as f:
        fppinit.write_bytes(EEPROM, f.read())
    detect(fppinit)
    info = cape_info(fppinit)
    assert sorted(info.get("provides", [])) == sorted(provides), info
    assert "DPIPixels" not in info.get("disableOutputs", []), info
