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


def test_start_writes_the_kiosk_policy_before_the_browser_can_start(fppinit):
    """With the kiosk on, fppinit start writes Chromium's policy file with
    the KioskUrl, rather than leaving it to a later step.

    Regression: e2741d13f. The kiosk browser started with the old URL until
    something else wrote the policy."""
    fppinit.settings(Kiosk="1", KioskUrl="http://show.example/kiosk")
    fppinit.root_file("/etc/fpp/kiosk", "")
    start(fppinit)
    policy = fppinit.written("/etc/chromium/policies/managed/policy.json") or ""
    assert 'RestoreOnStartupURLs": ["http://show.example/kiosk"]' in policy, policy


def test_boot_scripts_get_the_fpp_and_source_directories_in_their_environment(fppinit):
    """The UserCallbackHook.sh and plugin scripts fppinit starts see FPPDIR
    and SRCDIR.

    Regression: b813a041b. A script that sourced FPP's helpers from
    $FPPDIR found nothing when started at boot."""
    for rel in ("plugins/fpp-tests-plugin/scripts/preStart.sh", "scripts/UserCallbackHook.sh"):
        fppinit.write(rel, '#!/bin/sh\necho "$FPPDIR $SRCDIR" > "$0.env"\n')
        os.chmod(os.path.join(fppinit.media, rel), 0o755)
    r = fppinit._run(["sh", "-c", "/opt/fpp/src/fppinit runPreStartScripts; sleep 2"], media_home=True)
    assert r.returncode == 0, r.stdout + r.stderr
    for rel in ("plugins/fpp-tests-plugin/scripts/preStart.sh", "scripts/UserCallbackHook.sh"):
        assert fppinit.media_exists(rel + ".env"), f"{rel} did not run"
        assert fppinit.media_file(rel + ".env").strip() == "/opt/fpp /opt/fpp/src", rel


def test_post_network_sets_the_time_zone_again_once_the_network_is_up(fppinit):
    """fppinit postNetwork re-applies the TimeZone setting, since the
    attempt at the start of boot may not have worked.

    Regression: 6aa657c26. A time zone that timedatectl could not set early
    in boot stayed wrong until the next boot."""
    fppinit.settings(TimeZone="America/New_York")
    fppinit.root_file("/etc/timezone", None)
    r = fppinit._run(["sh", "-c", "ln -sf /usr/share/zoneinfo/Europe/London /etc/localtime; "
                      "exec /opt/fpp/src/fppinit postNetwork"], media_home=True)
    assert "timedatectl set-timezone America/New_York" in fppinit.calls(), \
        fppinit.calls() + [(r.stdout + r.stderr)[-1500:]]


def test_wifi_is_unblocked_just_before_hostapd_is_started(fppinit):
    """Setting the network up with tethering on unblocks the radio again
    after the network is restarted and before hostapd is (re)started.

    Regression: ffd19747b. An rfkill that blocked wlan0 after the first
    unblock left hostapd unable to start the access point."""
    from test_fppinit_tethering_boot import tether_on_a_wired_box
    # fppinit only unblocks when /usr/sbin/rfkill exists; the image has none
    fppinit.root_file("/usr/sbin/rfkill", "#!/bin/sh\necho \"rfkill $*\" >> /fppinit-calls.log\n")
    tether_on_a_wired_box(fppinit, carrier=0)
    calls = fppinit.calls()
    i = next(n for n, c in enumerate(calls) if "reload-or-restart hostapd" in c)
    assert "rfkill unblock wifi" in calls[:i], calls
    j = max(n for n, c in enumerate(calls[:i]) if "reload-or-restart systemd-networkd" in c)
    assert "rfkill unblock wifi" in calls[j:i], calls
