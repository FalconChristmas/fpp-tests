"""Smaller decisions fppinit makes at boot, one sandbox run each (fppinit.py):
swap, SSH host keys, the boot partition's location, a container that isn't
Docker, the fan trip points and the legacy AES67 cleanup.

What is checked is what fppinit decides -- the files it writes and the
commands it runs, as the stubs record them.
"""

import json
import os

import pytest

from fppinit import MEDIA, fppinit  # noqa: F401 -- the fixture
from test_fppinit import assert_clean
from test_fppinit_network_boot import run

SWAPS_HEADER = "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n"


def zramswap_marker(sb):
    """A /usr/sbin/zramswap that notes it was run in the media directory
    (the stubs only cover commands fppinit's sandbox knows of)."""
    sb.root_file("/usr/sbin/zramswap", f"#!/bin/sh\necho \"$*\" > {MEDIA}/tmp/zramswap-ran\n")


def test_zram_swap_is_started_when_zram_is_not_swapping(fppinit):
    """With /usr/sbin/zramswap installed and no zram device in /proc/swaps,
    postNetwork starts zram swap, and with one already swapping it doesn't.

    Regression: 4aecc5702. The gate was whether /dev/zram0 exists, and a
    kernel built with CONFIG_ZRAM=y (the BeagleBone's) always has it, so
    zram swap never came up."""
    fppinit.settings(bootDelay="0")
    zramswap_marker(fppinit)
    fppinit.fake_path("/proc/swaps", SWAPS_HEADER + "/dev/mmcblk0p3\t\tpartition\t524284\t0\t-2\n")
    assert_clean(run(fppinit, "postNetwork", net=True))
    assert fppinit.media_exists("tmp/zramswap-ran") and fppinit.media_file("tmp/zramswap-ran") == "start\n", \
        "zramswap start was not run with no zram in /proc/swaps"

    os.unlink(os.path.join(fppinit.media, "tmp", "zramswap-ran"))
    fppinit.fake_path("/proc/swaps", SWAPS_HEADER + "/dev/zram0\t\t\t\tpartition\t524284\t0\t100\n")
    assert_clean(run(fppinit, "postNetwork", net=True))
    assert not fppinit.media_exists("tmp/zramswap-ran"), "zramswap start was run with zram already swapping"


def ssh_dir(sb, *names):
    sb.root_file("/etc/ssh/.fpp-test", "")  # fppinit lists the directory; the image may not have it
    for n in names:
        sb.root_file(f"/etc/ssh/{n}", "key\n")


def keygen_calls(sb):
    """The key files ssh-keygen was asked for. It runs in the background and
    isn't installed in every image, so a stand-in notes its calls itself."""
    log = os.path.join(sb.media, "tmp", "ssh-keygen.log")
    if not os.path.exists(log):
        return []
    with open(log) as f:
        return sorted(l.split("-f ")[-1].strip() for l in f if l.strip())


def fake_keygen(sb):
    sb.root_file("/usr/bin/ssh-keygen", f"#!/bin/sh\necho \"$*\" >> {MEDIA}/tmp/ssh-keygen.log\n")


def test_one_ssh_host_key_pair_left_by_an_interrupted_keygen_is_regenerated(fppinit):
    """Boot generates SSH host keys when fewer than two key pairs are there,
    and leaves two or more alone.

    Regression: e6f0327b6. One ssh_host file was enough to skip generating,
    and a reboot in the middle of ssh-keygen left a lone key and no sshd."""
    fake_keygen(fppinit)
    ssh_dir(fppinit, "ssh_host_ed25519_key", "ssh_host_ed25519_key.pub")
    assert_clean(fppinit.run("start"))
    assert keygen_calls(fppinit) == ["/etc/ssh/ssh_host_ecdsa_key", "/etc/ssh/ssh_host_ed25519_key",
                                     "/etc/ssh/ssh_host_rsa_key"], fppinit.calls()

    ssh_dir(fppinit, "ssh_host_ecdsa_key", "ssh_host_ecdsa_key.pub")
    os.unlink(os.path.join(fppinit.media, "tmp", "ssh-keygen.log"))
    assert_clean(fppinit.run("start"))
    assert keygen_calls(fppinit) == [], fppinit.calls()


def test_haveged_is_started_only_to_seed_ssh_key_generation(fppinit):
    """Without a hardware RNG, generating SSH host keys starts haveged first;
    with all the keys there, boot doesn't start it.

    Regression: d87f3888e. fppinit.service stopped waiting on haveged on
    every boot, and a board with no /dev/hwrng and no entropy would block
    in ssh-keygen on its first boot."""
    ssh_dir(fppinit)
    assert_clean(fppinit.run("start"))
    assert "systemctl start haveged.service" in fppinit.calls(), fppinit.calls()

    ssh_dir(fppinit, "ssh_host_ecdsa_key", "ssh_host_ecdsa_key.pub",
            "ssh_host_ed25519_key", "ssh_host_ed25519_key.pub")
    assert_clean(fppinit.run("start"))
    assert not any("haveged" in c for c in fppinit.calls()), fppinit.calls()


def common_boot_dir(sb):
    r = sb._run(["bash", "-c", ". /opt/fpp/scripts/common; echo \"$FPPBOOTDIR\""])
    assert r.returncode == 0, r.stdout + r.stderr
    return r.stdout.strip().splitlines()[-1]


def test_the_boot_directory_is_where_the_boot_config_is(fppinit):
    """scripts/common names the directory holding config.txt or uEnv.txt as
    the boot directory, not /boot/firmware because it exists.

    Regression: 700ab6675. A BeagleBone Black has a /boot/firmware (ID.txt,
    START.HTM) and its uEnv.txt in /boot, and everything that edited the
    boot config edited a file the boot loader never read."""
    fppinit.root_file("/boot/uEnv.txt", "uname_r=6.1\n")
    assert common_boot_dir(fppinit) == "/boot"

    with open(os.path.join(fppinit.boot, "config.txt"), "w") as f:
        f.write("[all]\n")
    assert common_boot_dir(fppinit) == "/boot/firmware"


def test_a_podman_container_is_a_container_without_dockerenv(fppinit):
    """/etc/fpp/container marks a container, whatever runs it: with it, and
    no /.dockerenv, boot names the host after the container (HostDescription
    "Docker ID: ...") instead of managing the hostname itself.

    Regression: 3ac96bc11. Only /.dockerenv counted, which podman doesn't
    create, and boot ran the hardware setup of a real device in it."""
    fppinit.root_file("/.dockerenv", None)
    fppinit.root_file("/etc/fpp/container", "")
    assert_clean(fppinit.run("checkHostName"))
    settings = fppinit.media_file("settings") if fppinit.media_exists("settings") else ""
    assert "HostDescription = \"Docker ID:" in settings, f"settings: {settings!r}"

    fppinit.root_file("/etc/fpp/container", None)
    os.unlink(os.path.join(fppinit.media, "settings"))
    assert_clean(fppinit.run("checkHostName"))
    assert not fppinit.media_exists("settings") or "Docker ID" not in fppinit.media_file("settings")


def thermal_zone(**trips):
    zone = {"type": "cpu-thermal\n"}
    for i, t in enumerate(trips.values()):
        zone[f"trip_point_{i}_temp"] = f"{t}\n"
        zone[f"trip_point_{i}_type"] = "active\n"
    return {"thermal_zone0/" + k: v for k, v in zone.items()}


def test_boot_applies_the_fan_trip_point_settings(fppinit):
    """FanTrip_<zone>_<n> settings, in degrees C, are written to the thermal
    zone's trip points as millidegrees when boot starts (the kernel resets
    them every boot).

    Regression: b5879e534."""
    fppinit.root_file("/etc/fpp/container", None)
    ssh_dir(fppinit, "ssh_host_ecdsa_key", "ssh_host_ecdsa_key.pub", "ssh_host_rsa_key", "ssh_host_rsa_key.pub")
    fppinit.fake_path("/sys/class/thermal", thermal_zone(a=50000, b=60000))
    fppinit.settings(FanTrip_cputhermal_0="45.5", FanTrip_cputhermal_1="70")
    assert_clean(fppinit.run("start"))
    assert fppinit.faked("/sys/class/thermal", "thermal_zone0/trip_point_0_temp") == "45500"
    assert fppinit.faked("/sys/class/thermal", "thermal_zone0/trip_point_1_temp") == "70000"
    snapshot = json.loads(fppinit.media_file("tmp/fan_thermal_defaults.json"))
    assert snapshot == {"cputhermal_0": 50000, "cputhermal_1": 60000}, snapshot


def aes67_files(sb):
    for f in ("pipewire/pipewire.conf.d/96-fpp-aes67-rtp.conf", "pipewire/pipewire.conf.d/96-fpp-aes67-sap.conf",
              "ptp4l-fpp.conf"):
        sb.root_file("/etc/" + f, "legacy\n")


def test_legacy_aes67_cleanup_kills_daemons_only_when_it_finds_their_config(fppinit):
    """setupAudio removes the config of the old Python AES67 daemons and
    kills the daemons only when it removed one; on a box that has none, it
    runs no pkill.

    Regression: a63986075. Both pkill scans (a shell and a walk of every
    /proc/*/cmdline) ran on every boot, on the way to fppd."""
    assert_clean(fppinit.run("setupAudio"))
    assert not [c for c in fppinit.calls() if c.startswith("pkill")], fppinit.calls()

    aes67_files(fppinit)
    assert_clean(fppinit.run("setupAudio"))
    killed = [c for c in fppinit.calls() if c.startswith("pkill")]
    assert any("fpp_aes67_sap" in c for c in killed) and any("ptp4l" in c for c in killed), fppinit.calls()


def test_timezone_is_read_from_the_localtime_link_not_etc_timezone(fppinit):
    """setupTimezone compares the TimeZone setting with the zone /etc/localtime
    points into, and runs timedatectl only when they differ -- on an image
    with no /etc/timezone (Debian 13).

    Regression: 8e30c94c3. The current zone was read from /etc/timezone,
    always empty on trixie, so every boot (twice) paid for timedatectl's
    D-Bus round trip, ~15 s on a BeagleBone."""
    fppinit.settings(TimeZone="America/New_York")
    fppinit.root_file("/etc/timezone", None)

    def run_with_zone(zone):
        return fppinit._run(["sh", "-c", f"ln -sf /usr/share/zoneinfo/{zone} /etc/localtime; "
                             "exec /opt/fpp/src/fppinit setupTimezone"])
    assert_clean(run_with_zone("America/New_York"))
    assert not [c for c in fppinit.calls() if c.startswith("timedatectl")], fppinit.calls()
    assert_clean(run_with_zone("Europe/London"))
    assert "timedatectl set-timezone America/New_York" in fppinit.calls(), fppinit.calls()


def apt_get(sb, exit_code):
    """An apt-get that notes its calls in the media directory and exits with
    `exit_code` (fppinit runs it by name, so one on the PATH is used)."""
    sb.root_file("/usr/bin/apt-get", f"#!/bin/sh\necho \"$*\" >> {MEDIA}/tmp/apt-get.log\nexit {exit_code}\n")


def test_user_packages_are_retried_next_boot_when_apt_fails(fppinit):
    """After an OS reflash, boot installs the packages in
    config/userpackages.json and clears the /fppos_upgraded marker only once
    apt succeeded: a failed apt-get leaves the marker for the next boot, and a
    good one removes it.

    Regression: d62418e17. The marker was removed whatever apt said, so a
    package install that failed at boot (no network yet) was never retried and
    the kiosk packages stayed missing."""
    fppinit.settings(bootDelay="0")
    fppinit.write("config/userpackages.json", ["htop"])
    fppinit.root_file("/fppos_upgraded", "")
    apt_get(fppinit, 1)
    assert_clean(run(fppinit, "postNetwork", net=True))
    assert "install" not in fppinit.media_file("tmp/apt-get.log"), "installed after apt-get update failed"
    assert fppinit.written("/fppos_upgraded") is not None, "the marker was consumed though apt failed"

    os.unlink(os.path.join(fppinit.media, "tmp", "apt-get.log"))
    apt_get(fppinit, 0)
    assert_clean(run(fppinit, "postNetwork", net=True))
    assert "install -y htop" in fppinit.media_file("tmp/apt-get.log"), fppinit.media_file("tmp/apt-get.log")
    assert fppinit.written("/fppos_upgraded") is None, "the marker was left after the packages installed"
