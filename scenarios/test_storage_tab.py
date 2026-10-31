"""When the Settings page shows the Storage tab, and what it offers there.

The decisions are blocks of www/settings.php, www/settings-all.php and
www/settings-storage.php that look at the booted root device (findmnt) and
the disks beside it (/dev/<disk>, lsblk). Each block is taken out of the
tree under test and run with php-cli, with a stand-in findmnt and lsblk on
its PATH and its /dev/<disk> lookups pointed at a scratch directory, so any
disk layout can be had anywhere, Docker included.
"""

import os
import shutil
import subprocess

import pytest

TREE = os.environ.get("FPP_TREE", "")

GB = 1024 ** 3


def block(page, start, end):
    with open(os.path.join(TREE, "www", page)) as f:
        src = f.read()
    i = src.find(start)
    j = src.find(end, i)
    assert i >= 0 and j > i, f"www/{page} has no block from {start!r} to {end!r}"
    return src[i:j]


def run_php(tmp_path, code, root, disks, settings):
    """Run PHP code as if booted from /dev/<root>, with disks
    ({name: bytes}) present; returns its output."""
    php = shutil.which("php")
    if not php:
        pytest.skip("no php-cli here")
    bindir = tmp_path / "bin"
    dev = tmp_path / "dev"
    bindir.mkdir()
    dev.mkdir()
    for name, size in disks.items():
        (dev / name).write_text("")
    sizes = "".join(f"  {name}) echo {size} ;;\n" for name, size in disks.items())
    tools = {
        "findmnt": f"#!/bin/sh\necho /dev/{root}\n",
        "colrm": "#!/bin/sh\ncut -c$(($2 + 1))-\n",
        # the disk is the last argument, /dev/<name>
        "lsblk": f'#!/bin/sh\nfor a in "$@"; do d="$a"; done\ncase "${{d##*/}}" in\n{sizes}esac\n',
    }
    for name, text in tools.items():
        (bindir / name).write_text(text)
        (bindir / name).chmod(0o755)
    # Only file_exists() looks at the disk node itself; lsblk is the stand-in.
    code = code.replace('file_exists("/dev/" . $target)', f'file_exists("{dev}/" . $target)')
    script = tmp_path / "page.php"
    script.write_text("<?php\n$settings = " + php_array(settings) + ";\n" + code)
    r = subprocess.run([php, str(script)], capture_output=True, text=True, timeout=30,
                       env={"PATH": f"{bindir}:{os.environ['PATH']}"})
    assert r.returncode == 0, r.stdout + r.stderr
    return r.stdout.strip()


def php_array(d):
    return "array(" + ", ".join(f"'{k}' => '{v}'" for k, v in d.items()) + ")"


PI = {"Platform": "Raspberry Pi", "SubPlatform": "Raspberry Pi 5 Model B Rev 1.0", "UnpartitionedSpace": "0"}

PAGES = [("settings.php", "$storageUILevel = 1;", "$tabIDs = array();"),
         ("settings-all.php", "$storageUILevel = 1;", "$pages = array(")]


@pytest.mark.parametrize("page,start,end", PAGES, ids=["settings", "settings-all"])
@pytest.mark.parametrize("root,disks,level", [
    ("mmcblk0p2", {"nvme0n1": 256 * GB}, "0"),
    ("mmcblk0p2", {"sda": 64 * GB}, "0"),
    ("mmcblk0p2", {}, "1"),
    ("mmcblk0p2", {"sda": 8 * GB}, "1"),
    ("nvme0n1p2", {"mmcblk0": 64 * GB}, "1"),
], ids=["sd+nvme", "sd+usb", "sd-alone", "sd+small-usb", "nvme+sd"])
def test_the_storage_tab_is_basic_when_an_sd_boot_has_a_disk_to_flash_to(tmp_path, page, start, end,
                                                                          root, disks, level):
    """Booted from the SD card with an NVMe or USB disk over 12GB beside it,
    the Storage tab is shown at the Basic UI level (0), so flashing to that
    disk is not hidden behind the Advanced level; an SD card alone, a small
    USB stick, or a system booted from NVMe keeps it at Advanced (1).

    Regression: a378ec949. The tab was Basic only with unpartitioned space
    on the SD card, so a Pi booted from SD with an NVMe drive fitted showed
    no Storage tab until the UI was switched to Advanced.
    """
    code = block(page, start, end) + "\necho $storageUILevel;\n"
    assert run_php(tmp_path, code, root, disks, PI) == level


def test_an_sd_boot_with_root_on_the_third_partition_gets_the_sd_card_actions(tmp_path):
    """Root on mmcblk0p3 (an SD card laid out with a third partition) with
    unpartitioned space left: the Storage tab treats it as an SD boot and
    offers the SD card actions (Grow Filesystem, New Partition), as for root
    on mmcblk0p2.

    Regression: ba0954519 (#2665). Only mmcblk0p1/p2 (and nvme0n1p2, sda2)
    counted, so a root on mmcblk0p3 was offered nothing.
    """
    code = block("settings-storage.php", "$addnewfsbutton = false;", "\n// Every disk")
    code += "\necho $addnewfsbutton ? 'offered' : 'none';\n"
    space = dict(PI, UnpartitionedSpace="1000")
    for root in ("mmcblk0p2", "mmcblk0p3"):
        (tmp_path / root).mkdir()
        assert run_php(tmp_path / root, code, root, {}, space) == "offered", root


def test_a_boot_from_nvme_or_usb_gets_the_new_partition_action(tmp_path):
    """Root on the NVMe drive's or the USB disk's second partition
    (nvme0n1p2, sda2, as flashing to them lays them out) with unpartitioned
    space left: the Storage tab offers New Partition, as for an SD boot.

    Regression: f821717f9. Only an SD card root (mmcblk0p1/p2) counted, so a
    Pi booted from NVMe or USB was offered nothing for the space left over.
    """
    code = block("settings-storage.php", "$addnewfsbutton = false;", "\n// Every disk")
    code += "\necho $addnewfsbutton ? 'offered' : 'none';\n"
    space = dict(PI, UnpartitionedSpace="1000")
    for root in ("nvme0n1p2", "sda2"):
        (tmp_path / root).mkdir()
        assert run_php(tmp_path / root, code, root, {}, space) == "offered", root
