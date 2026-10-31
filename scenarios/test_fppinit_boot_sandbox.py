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


def test_tether_checks_do_nothing_while_setup_network_is_running(fppinit):
    """While tmp/networkSetup exists (fppinit setupNetwork is running),
    checkForTether leaves the tether alone; once it is gone, the same
    call sets the access point up.

    Regression: ce0603072. The link changes setupNetwork itself causes
    ran the tether checks, which fought it over hostapd."""
    from test_fppinit_network_boot import network_ports, run, with_config_dirs
    from test_fppinit_tethering_boot import HOSTAPD_CONF
    with_config_dirs(fppinit)
    fppinit.settings(bootDelay="0", EnableTethering="1", TetherInterface="wlan0")
    network_ports(fppinit, wlan0="wifi")
    fppinit.service("fpp_postnetwork", enabled=True, active=True)
    fppinit.write("tmp/networkSetup", "1")
    run(fppinit, "checkForTether", "wlan0", net=True)
    assert not fppinit.written(HOSTAPD_CONF), "the tether was set up while setupNetwork ran"
    os.unlink(os.path.join(fppinit.media, "tmp", "networkSetup"))
    run(fppinit, "checkForTether", "wlan0", net=True)
    assert "interface=wlan0" in (fppinit.written(HOSTAPD_CONF) or ""), fppinit.calls()


def sandbox_sh(sb, script):
    """Run a shell script in the sandbox with the media directory at
    /home/fpp/media, as upgrade steps see it; its stdout."""
    if not sb.media_exists("settings"):
        sb.write("settings", "")
    r = sb._run(["sh", "-c", script], timeout=120, media_home=True)
    return r.stdout


def test_upgrade_87_leaves_one_safe_directory_entry_for_the_fpp_tree(fppinit):
    """Upgrade 87 replaces however many safe.directory entries for /opt/fpp
    a user's git config has gathered with one.

    Regression: 4e68f73aa. Each update added another copy of the entry, and
    --add alone never removed the old ones."""
    out = sandbox_sh(fppinit, "export HOME=/tmp/h; mkdir -p $HOME; "
                              "for i in 1 2 3; do git config --global --add safe.directory /opt/fpp; done; "
                              "git config --global --add safe.directory /somewhere/else; "
                              "/opt/fpp/upgrade/87/upgrade.sh >/dev/null 2>&1; "
                              "git config --global --get-all safe.directory")
    assert out.split() == ["/somewhere/else", "/opt/fpp"], out


def test_upgrade_81_keeps_the_45_newest_backups(fppinit):
    """Upgrade 81 purges config/backups down to the 45 most recent files.

    Regression: d13dcc15c. Thousands of backups piled up and the backup
    script's own cleanup ran out of memory deleting them."""
    out = sandbox_sh(fppinit, "mkdir -p /home/fpp/media/config/backups && cd /home/fpp/media/config/backups && "
                              "for i in $(seq 100 149); do touch -d \"2020-01-01 00:00:$((i-100))\" b$i.json; done; "
                              "/opt/fpp/upgrade/81/upgrade.sh >/dev/null 2>&1; ls | sort | tr '\\n' ' '")
    left = out.split()
    assert len(left) == 45, left
    assert "b149.json" in left and "b104.json" not in left and "b105.json" in left, left


def unpartitioned_after_start(sb, sfdisk_output):
    """The UnpartitionedSpace setting `fppinit start` leaves when sfdisk -F
    ends with the given text."""
    sb.root_file("/dev/mmcblk0", "")
    sb.root_file("/etc/fpp/desktop", None)
    sb.stub_output("sfdisk", "-F", sfdisk_output)
    # fppinit runs /usr/sbin/sfdisk, where the image has none to stub
    sb.root_file("/usr/sbin/sfdisk", "#!/bin/sh\ncat /fppinit-state/sfdisk.-F.out\n")
    start(sb)
    for line in sb.media_file("settings").splitlines():
        if line.startswith("UnpartitionedSpace"):
            return line.split("=", 1)[1].strip().strip('"')
    return None


def test_unpartitioned_space_is_reported_in_whole_gigabytes(fppinit):
    """Boot records the free space after the last partition in the
    UnpartitionedSpace setting: the gigabytes sfdisk -F ends its listing
    with, and 0 for anything smaller or no space at all.

    Regression: 0d6a88404. The check moved from a shell script to fppinit
    and the setting the UI reads (to offer expanding the SD card) went
    stale."""
    assert unpartitioned_after_start(fppinit, "Unpartitioned space /dev/mmcblk0: 12 GiB, 12884901888 bytes, 25165824 sectors\n"
                                              "Start      End  Sectors Size\n3481600 25165823 21684224  12G\n") == "12"
    assert unpartitioned_after_start(fppinit, "Start End Sectors Size\n1 2 3  500M\n") == "0"


def test_start_with_no_sfdisk_output_leaves_no_unpartitioned_space(fppinit):
    """fppinit start completes, and records no unpartitioned space, when
    `sfdisk -F` prints nothing (sfdisk missing or failing).

    Regression: 382a16359. checkUnpartitionedSpace() took back() of the
    empty split of the output, which is undefined: a SEGV under ASan that
    killed fppinit start."""
    assert unpartitioned_after_start(fppinit, "") == "0"
