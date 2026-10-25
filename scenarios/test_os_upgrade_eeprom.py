"""The Raspberry Pi boot loader step of an FPPOS upgrade (SD/upgradeOS-part2.sh).

part2 runs chrooted into the new, read-only .fppos image, with the real disk
bind-mounted at /mnt. Its boot loader step is taken out of the script as the
tree under test has it and run with a stand-in rpi-eeprom-update that records
the environment it was started with. On a Pi, the real rpi-eeprom-update is
then checked to take those variables from its environment.
"""

import os
import re
import shutil
import subprocess

import pytest

from test_os_upgrade_steps import between


def eeprom_update_env(tmp_path):
    """The environment the boot loader step starts rpi-eeprom-update with."""
    block = between('logStage "Updating boot loader"', "\nfi\n")
    record = tmp_path / "env"
    stub = tmp_path / "rpi-eeprom-update"
    stub.write_text(f'#!/bin/sh\nenv > {record}\necho "$*" >> {record}.args\n')
    stub.chmod(0o755)
    assert "/bin/rpi-eeprom-update" in block, block
    script = "logStage() { :; }\n" + block.replace("/bin/rpi-eeprom-update", str(stub))
    r = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=30,
                       env={"PATH": os.environ["PATH"]})
    assert r.returncode == 0, r.stdout + r.stderr
    assert (tmp_path / "env.args").read_text().split() == ["-a"], "the step did not apply the update"
    return dict(line.split("=", 1) for line in record.read_text().splitlines() if "=" in line)


def real_tool():
    """The device's rpi-eeprom-update's source, or skip."""
    tool = shutil.which("rpi-eeprom-update", path="/usr/bin:/bin")
    if not tool:
        pytest.skip("no rpi-eeprom-update here (a Raspberry Pi has one)")
    with open(tool) as f:
        return f.read()


def test_the_boot_loader_update_stages_on_the_real_boot_partition(tmp_path):
    """The step tells rpi-eeprom-update to write pieeprom.upd/.sig to
    /mnt/boot/firmware, the real disk's boot partition.

    Regression: 6b6a61a9f (#2796). It wrote them to the chroot's own
    /boot/firmware, in the read-only image: "Read-only file system", and
    the update never reached the partition the board boots from.
    """
    env = eeprom_update_env(tmp_path)
    assert env.get("BOOTFS") == "/mnt/boot/firmware", env.get("BOOTFS")


def test_the_boot_loader_update_backs_up_to_the_real_disk(tmp_path):
    """The step tells rpi-eeprom-update to put its backup of the boot loader
    config under /mnt, on the real disk.

    Regression: d350cb169 (#2796). The backup went to the default
    /var/lib/raspberrypi/bootloader/backup, inside the read-only image:
    "Read-only file system".
    """
    env = eeprom_update_env(tmp_path)
    assert env.get("FIRMWARE_BACKUP_DIR") == "/mnt/var/lib/raspberrypi/bootloader/backup", \
        env.get("FIRMWARE_BACKUP_DIR")


def test_the_real_rpi_eeprom_update_takes_both_from_its_environment():
    """The receiving end of the two above, on a Pi: the installed
    rpi-eeprom-update reads FIRMWARE_BACKUP_DIR from its environment
    (defaulting it only when unset), and looks for the boot partition
    itself only when BOOTFS is empty -- so what the step sets is used.
    """
    src = real_tool()
    assert re.search(r'^FIRMWARE_BACKUP_DIR=\$\{FIRMWARE_BACKUP_DIR:-', src, re.M), \
        "rpi-eeprom-update no longer takes FIRMWARE_BACKUP_DIR from its environment"
    assert re.search(r'^\s*elif \[ -z "\$BOOTFS" \]; then', src, re.M), \
        "rpi-eeprom-update no longer takes BOOTFS from its environment"
