"""scripts/generateEEPROM making and cloning a cape EEPROM image, with
fppcapedetect (the player's side) reading what it wrote."""

import json
import os
import subprocess

import cape_eeprom as ee
from fppinit import fppinit  # noqa: F401 -- the fixture
from test_cape_detect import EEPROM, cape_info, detect

TREE = os.environ.get("FPP_TREE", "")
TOOL = os.path.join(TREE, "scripts", "generateEEPROM")


def tool(*args, cwd=None):
    r = subprocess.run(["php", "-d", "short_open_tag=1", TOOL, *args],
                       capture_output=True, text=True, timeout=30, cwd=cwd)
    return r.stdout + r.stderr


def generate(tmp_path, serial="GEN0001"):
    archive = tmp_path / "capedir"
    archive.mkdir()
    (archive / "cape-info.json").write_text(json.dumps(ee.cape_info(id="GeneratedCape")))
    img = tmp_path / "gen.bin"
    out = tool("-n", "GeneratedCape", "-v", "2.5", "-s", serial, "-d", str(archive),
               "-o", str(img), cwd=tmp_path)
    assert img.exists() and img.stat().st_size > 0, out
    return img


def test_a_generated_image_is_read_back_and_detected_by_the_player(fppinit, tmp_path):
    """generateEEPROM -n/-v/-s/-d/-o makes an image whose header reads
    back as written, and fppcapedetect installs it: the cape-info.json from
    the directory given with -d, packed into the image, is published.

    Feature: d756d77f9 (the tool and its fppEEPROM class). The tests in
    test_cape_eeprom_tool.py read images other code made; this one writes
    one with the tool and hands it to the player.
    """
    img = generate(tmp_path)
    out = tool("-e", str(img), "-i")
    assert "GeneratedCape" in out and "2.5" in out and "GEN0001" in out, out
    fppinit.write_bytes(EEPROM, img.read_bytes())
    detect(fppinit)
    assert cape_info(fppinit)["id"] == "GeneratedCape", fppinit.media_file("tmp/cape-info.json")


def test_a_cloned_image_has_the_new_serial_and_the_same_cape(fppinit, tmp_path):
    """generateEEPROM -e IMAGE -s NEWSERIAL -o COPY writes a copy that reads
    back with the new cape serial and its name and version unchanged, and
    the player still detects the same cape from it.

    Feature: d756d77f9 (the clone path of the tool).
    """
    img = generate(tmp_path)
    copy = tmp_path / "clone.bin"
    out = tool("-e", str(img), "-s", "CLONE002", "-o", str(copy), cwd=tmp_path)
    assert copy.exists(), out
    info = tool("-e", str(copy), "-i")
    assert "Cape Serial #     : CLONE002" in info, info
    assert "GeneratedCape" in info and "2.5" in info, info
    fppinit.write_bytes(EEPROM, copy.read_bytes())
    detect(fppinit)
    assert cape_info(fppinit)["id"] == "GeneratedCape", fppinit.media_file("tmp/cape-info.json")
