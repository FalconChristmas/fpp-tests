"""Boot-time behaviours in the fppinit sandbox (fppinit.py): the SD card's
fpp directory, the default host name, and the upgrade steps that install
OS files.
"""

import os

from fppinit import fppinit  # noqa: F401 -- the fixture
from test_fppinit_boot_config import start
from test_upgrade_steps import boot_write


def step_leaves(sb, n, *paths):
    """Run upgrade step n, then say which of the absolute paths exist in
    the same sandbox run (the next run starts from a clean overlay)."""
    if not sb.media_exists("settings"):
        sb.write("settings", "")
    r = sb._run(["sh", "-c", f"/opt/fpp/upgrade/{n}/upgrade.sh >/dev/null 2>&1; "
                 "for p in " + " ".join(paths) + "; do test -e $p && echo $p; done"],
                timeout=120, media_home=True)
    return r.stdout.split()

TREE = os.environ.get("FPP_TREE", "")


def test_files_in_the_boot_partitions_fpp_directory_are_copied_into_the_media_directory_once(fppinit):
    """Files a user drops in /boot/firmware/fpp on the SD card are copied
    into the media directory at boot, and a copy_done marker stops the
    copy from running again.

    Regression: f14f73827. Settings and configs prepared on a computer
    never reached a fresh install."""
    boot_write(fppinit, "fpp/config/prepared.json", '{"from": "sd"}')
    start(fppinit)
    assert fppinit.media_exists("config/prepared.json"), "the SD card's file was not copied"
    assert os.path.exists(os.path.join(fppinit.boot, "fpp", "copy_done"))

    boot_write(fppinit, "fpp/second.txt", "later")
    start(fppinit)
    assert not fppinit.media_exists("second.txt"), "the copy ran twice"


def test_a_missing_host_name_setting_defaults_the_host_name_to_fpp(fppinit):
    """With no HostName setting, boot names the host fpp rather than
    leaving it blank.

    Regression: c46e65374. An empty setting wrote an empty /etc/hostname."""
    fppinit.root_file("/etc/fpp/container", None)
    fppinit.root_file("/etc/hostname", "oldname\n")
    fppinit.write("settings", "")
    r = fppinit.run("checkHostName")
    assert fppinit.written("/etc/hostname").strip() == "fpp", r.stdout + r.stderr
    assert "hostname fpp" in fppinit.calls(), fppinit.calls()


def test_upgrade_91_removes_the_gpiochip4_udev_rule_except_on_a_desktop(fppinit):
    """Upgrade 91 removes the gpiochip4 udev rule on a non-desktop install
    and leaves it on a desktop.

    Regression: ee41f398f. The rule renames the Pi 5's gpiochip, which
    fppd's GPIO code does not expect on a headless install."""
    rule = "/usr/lib/udev/rules.d/60-gpiochip4.rules"
    fppinit.root_file(rule, "# rule\n")
    fppinit.root_file("/etc/fpp/desktop", None)
    assert not step_leaves(fppinit, 91, rule)

    fppinit.root_file(rule, "# rule\n")
    fppinit.root_file("/etc/fpp/desktop", "")
    assert step_leaves(fppinit, 91, rule), "a desktop install lost its rule"


def test_upgrade_90_installs_the_networkd_dispatcher_scripts_except_on_a_desktop(fppinit):
    """Upgrade 90 copies FPP's networkd-dispatcher scripts into /etc, but
    not on a desktop install.

    Regression: 86231bc07. The scripts that start the time sync and
    tether checks when a link comes up were never installed on upgrade."""
    fppinit.root_file("/etc/fpp/desktop", None)
    shipped = sorted(os.listdir(os.path.join(TREE, "etc", "networkd-dispatcher")))
    assert shipped
    want = ["/etc/networkd-dispatcher/initialized.d"] + [f"/etc/networkd-dispatcher/{d}" for d in shipped]
    assert step_leaves(fppinit, 90, *want) == want


def test_upgrade_89_installs_the_fpp_systemd_units_and_reloads_systemd(fppinit):
    """Upgrade 89 copies the fpp* unit files to /lib/systemd/system and
    reloads systemd.

    Regression: 966a6ea86. Updated units stayed at their old contents
    until the next reboot."""
    shipped = [f for f in os.listdir(os.path.join(TREE, "etc", "systemd")) if f.startswith("fpp")]
    assert shipped
    want = [f"/lib/systemd/system/{f}" for f in shipped]
    assert step_leaves(fppinit, 89, *want) == want
    assert "systemctl daemon-reload" in fppinit.calls(), fppinit.calls()
