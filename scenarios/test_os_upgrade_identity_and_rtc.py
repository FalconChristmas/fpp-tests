"""What an FPPOS upgrade keeps of the board's identity, and how fpprtc gives
up on an RTC that isn't answering.

The upgrade half takes upgradeOS-part2.sh's save and restore steps, as
written in the tree under test, and runs them on scratch trees standing in
for the image and the running root, as test_os_upgrade_steps.py does: part2
itself only runs chrooted into a real image.

The fpprtc half runs in the fppinit sandbox (fppinit.py) with the cape's
i2c bus faked, so delete_device writes land in the scenario's own files,
and hwclock a stub. fpprtc is not built in a container: these run with
run-local.sh on a Pi or a Beagle, and are skipped elsewhere.
"""

import os
import subprocess

import pytest

from fppinit import fppinit  # noqa: F401 -- the fixture

TREE = os.environ.get("FPP_TREE", "")


# --- upgradeOS-part2.sh -----------------------------------------------------

def part2():
    with open(os.path.join(TREE, "SD", "upgradeOS-part2.sh")) as f:
        return f.read()


def between(start, end):
    src = part2()
    i = src.find(start)
    j = src.find(end, i)
    assert i >= 0 and j > i, f"upgradeOS-part2.sh has no block from {start!r} to {end!r}"
    return src[i:j]


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(content)


MACHINE_ID = "0123456789abcdef0123456789abcdef\n"


def upgrade_identity(tmp_path):
    """The board's root at mnt/ with its own hostname and machine-id, put
    through part2's save, a stand-in for the root rsync that brings the
    image's /etc (the image's hostname, and the "uninitialized" machine-id
    an image ships with so each card makes its own), and part2's restore.
    Returns the restored mnt/etc and the script's output."""
    mnt = tmp_path / "mnt"
    write(str(mnt / "etc/ssh/ssh_host_ed25519_key"), "key")
    write(str(mnt / "etc/hostname"), "fpp-tests\n")
    write(str(mnt / "etc/machine-id"), MACHINE_ID)
    (tmp_path / "tmp").mkdir()
    save = between("# temporarily copy the ssh keys", "# --- Reconcile")
    rsync = ("rm -rf mnt/etc && mkdir -p mnt/etc/ssh && "
             "echo FPP > mnt/etc/hostname && echo uninitialized > mnt/etc/machine-id\n")
    restore = between("#restore the ssh keys", "#create a file in root")
    r = subprocess.run(["bash", "-c", save + "\n" + rsync + restore], cwd=str(tmp_path),
                       capture_output=True, text=True, timeout=60)
    return mnt / "etc", r.stdout + r.stderr


def test_the_hostname_survives_an_os_upgrade(tmp_path):
    """part2 saves /etc/hostname before the root rsync copies the image's
    over it, and puts it back after, so the board comes up from an FPPOS
    upgrade under the name it had.

    Regression: dd1874c90. Nothing saved it, so the first boot after an
    upgrade came up as the image's hostname.
    """
    etc, out = upgrade_identity(tmp_path)
    assert (etc / "ssh/ssh_host_ed25519_key").exists(), f"the control: the ssh keys are restored\n{out}"
    assert (etc / "hostname").read_text() == "fpp-tests\n", \
        f"the board's hostname was replaced by the image's:\n{out}"


def test_the_machine_id_survives_an_os_upgrade(tmp_path):
    """part2 saves /etc/machine-id before the root rsync and puts it back
    after, so the board keeps its systemd identity (and the DHCP client id
    and journal names derived from it) across an FPPOS upgrade.

    Regression: 7c8bcc993 (the upgrade half; its BBB-FlashMMC.sh and Pi
    image build halves, which keep the build machine's id out of the
    images, are image-build steps not reached here). Nothing saved it, so
    the board took the image's machine-id -- the build machine's, or
    "uninitialized" for a new one on next boot.
    """
    etc, out = upgrade_identity(tmp_path)
    assert (etc / "ssh/ssh_host_ed25519_key").exists(), f"the control: the ssh keys are restored\n{out}"
    assert (etc / "machine-id").read_text() == MACHINE_ID, \
        f"the board's machine-id was replaced by the image's:\n{out}"


# --- fpprtc -----------------------------------------------------------------

I2C = {f"i2c-{n}/{f}": "" for n in range(4) for f in ("new_device", "delete_device")}


def fpprtc(sb):
    if not os.path.exists(os.path.join(sb.tree, "src", "fpprtc")):
        pytest.skip("no fpprtc in the tree under test")
    try:
        r = sb._run(["/opt/fpp/src/fpprtc"], timeout=30, media_home=True)
    except subprocess.TimeoutExpired:
        pytest.fail("fpprtc never exited")
    out = r.stdout + r.stderr
    assert "AddressSanitizer" not in out, out[-3000:]
    return out


def deleted(sb):
    """What fpprtc asked the kernel to remove, on each bus."""
    return {n: sb.faked("/sys/bus/i2c/devices", f"i2c-{n}/delete_device") for n in range(4)
            if sb.faked("/sys/bus/i2c/devices", f"i2c-{n}/delete_device")}


def test_an_rtc_that_never_appears_is_removed_again(fppinit):
    """With an RTC chip selected (piRTC) but none answering -- the wrong
    chip chosen, or the cape taken off -- /dev/rtcN never appears; fpprtc
    then deletes the i2c device it created, at the chip's address on the
    cape bus. The sandbox has no /dev/rtc*, which is exactly that case.

    Regression: a98c7fb9a. The device was left in place, and the kernel
    driver kept retrying a chip that wasn't there, filling the system log
    with i2c errors.
    """
    fppinit.settings(piRTC="2")
    fppinit.fake_path("/sys/bus/i2c/devices", dict(I2C))
    out = fpprtc(fppinit)
    created = {n: fppinit.faked("/sys/bus/i2c/devices", f"i2c-{n}/new_device") for n in range(4)}
    bus = [n for n, v in created.items() if v]
    assert [created[n] for n in bus] == ["ds1307 0x68"], f"the control: the DS1307 is created\n{created}\n{out}"
    assert deleted(fppinit) == {bus[0]: "0x68"}, \
        f"the RTC that never appeared was left on the bus: {deleted(fppinit)}\n{out}"


def test_an_rtc_that_cant_be_read_is_removed(fppinit):
    """When /dev/rtcN is there but reading the time fails with "Remote I/O
    error" (the chip doesn't answer at its address), fpprtc deletes the i2c
    device and doesn't install the daily job that writes the time back to
    it. hwclock is the sandbox's stub, made to fail that way, and the
    machine's /dev/rtc0 is only seen, never opened.

    Regression: a98c7fb9a. The failure wasn't looked at: the device stayed,
    the driver's errors filled the system log, and the cron job went on
    writing to a clock that wasn't there.
    """
    if not os.path.exists(os.path.join(fppinit.tree, "src", "fpprtc")):
        pytest.skip("no fpprtc in the tree under test")
    if not os.path.exists("/dev/rtc0"):
        pytest.skip("no /dev/rtc0 here to stand for the RTC's device")
    fppinit.settings(piRTC="5")
    fppinit.fake_path("/sys/bus/i2c/devices", dict(I2C))
    fppinit.device("rtc0")
    fppinit.stub_output("hwclock", "-s",
                        "hwclock: ioctl(RTC_RD_TIME) to /dev/rtc0 to read the time failed: Remote I/O error\n")
    out = fpprtc(fppinit)
    assert any(c.startswith("hwclock -s") for c in fppinit.calls()), \
        f"the control: the time is read from the RTC\n{fppinit.calls()}\n{out}"
    gone = deleted(fppinit)
    assert list(gone.values()) == ["0x51"], f"the RTC that can't be read was left on the bus: {gone}\n{out}"
    assert fppinit.written("/etc/cron.daily/update-RTC") is None, \
        f"the daily job to write the time to the missing RTC was installed\n{out}"
