"""What fppinit's start action and a few smaller actions write for the
services around fppd: the Apache password config, the boot delay in a
container, the DHCP networkd files, the tether, the kiosk policy.

Run in the fppinit sandbox (fppinit.py): what is checked is the files
written and the commands run, as the stubs record them.
"""

import os

from fppinit import MEDIA, fppinit  # noqa: F401 -- the fixture
from test_fppinit import assert_clean
from test_fppinit_audio_cards import set_setting
from test_fppinit_boot_services import ssh_dir
from test_fppinit_network_boot import run, with_config_dirs

UI_PASSWORD_CONF = "config/ui-password-config.conf"


def start(sb, **kw):
    """fppinit start, with the /etc/ssh directory its host key check lists."""
    ssh_dir(sb, "ssh_host_ecdsa_key", "ssh_host_ecdsa_key.pub", "ssh_host_rsa_key", "ssh_host_rsa_key.pub")
    r = sb.run("start")
    assert_clean(r)
    return r


def test_start_creates_the_virtual_display_assets_directory(fppinit):
    """The directories boot makes in the media directory include
    virtualdisplay_assets.

    Regression: a62d7aeb0. The directory was missing from the list, and
    the virtual display's uploads had nowhere to go on a fresh install."""
    os.rmdir(os.path.join(fppinit.media, "images"))
    start(fppinit)
    assert os.path.isdir(os.path.join(fppinit.media, "virtualdisplay_assets"))
    assert os.path.isdir(os.path.join(fppinit.media, "images")), "the list is not being walked, so this proves nothing"


def test_start_writes_an_open_ui_password_config_for_apache(fppinit):
    """With no UI password set up, boot writes config/ui-password-config.conf
    -- the file apache2.site includes -- as an open RequireAny with
    LOCAL_PROTECT=0, writes no .htaccess, and leaves a config that is there
    alone.

    Regressions: d44f4dd1a (the UI password moved from config/.htaccess to
    this Apache config file) and c5c2bdbd5 (the no-password case wrote
    Apache 2.2 "Allow from All", which Apache 2.4 refuses to load)."""
    start(fppinit)
    conf = fppinit.media_file(UI_PASSWORD_CONF)
    assert "<RequireAny>\n  Require all granted\n</RequireAny>" in conf and "LOCAL_PROTECT=0" in conf, conf
    assert "Allow from" not in conf, conf
    assert not fppinit.media_exists("config/.htaccess")

    fppinit.write(UI_PASSWORD_CONF, "# the user's own\n")
    start(fppinit)
    assert fppinit.media_file(UI_PASSWORD_CONF) == "# the user's own\n"
    with open(os.path.join(fppinit.tree, "etc/apache2.site")) as f:
        assert "IncludeOptional /home/fpp/media/config/ui-password-config.conf" in f.read()


def test_boot_delay_is_not_started_in_a_container(fppinit):
    """In a container, start sets up no boot delay countdown and clears a
    stale one; on a device it writes it.

    Regression: 63607331b. A container never processed the delay, and the
    UI showed a boot delay warning that never went away."""
    fppinit.settings(bootDelay="30")
    fppinit.root_file("/etc/fpp/container", "")
    fppinit.write("tmp/boot_delay", "1767225600,30")
    start(fppinit)
    assert not fppinit.media_exists("tmp/boot_delay"), "a container showed a boot delay"

    fppinit.root_file("/etc/fpp/container", None)
    start(fppinit)
    assert fppinit.media_file("tmp/boot_delay").endswith(",30"), "a device shows no boot delay, so this proves nothing"


def dhcp_network(sb, **lines):
    with_config_dirs(sb)
    sb.settings(bootDelay="0", **lines)
    sb.write("config/interface.eth0", "INTERFACE=\"eth0\"\nPROTO=\"dhcp\"\n")
    assert_clean(run(sb, "setupNetwork", net=True))
    return sb.written("/etc/systemd/network/10-eth0.network") or ""


def test_a_dhcp_interface_uses_the_leases_domains_and_ignores_its_ntp_servers(fppinit):
    """The .network file for a DHCP interface takes the search domains from
    the lease (UseDomains=true), and NTP servers only when UseNTPFromDHCP is
    on (otherwise UseNTP=no).

    Regressions: 82d9eebea (UseDomains) and 7c2433585 (UseNTPFromDHCP;
    the NTP daemon was ntpsec then, chrony now)."""
    net = dhcp_network(fppinit)
    assert "UseDomains=true" in net and "UseNTP=no" in net, net
    with open(os.path.join(fppinit.tree, "etc/systemd/network/50-default.network")) as f:
        assert "UseDomains=true" in f.read()

    net = dhcp_network(fppinit, UseNTPFromDHCP="1")
    assert "UseDomains=true" in net and "UseNTP=no" not in net, net


def chrony_sources_left(sb, **settings):
    """Run setupNetwork with a DHCP source file chrony would read in
    /run/chrony-dhcp, and list what is left there afterwards (/run is a
    tmpfs of the sandbox's, so the run itself has to look)."""
    with_config_dirs(sb)
    sb.settings(bootDelay="0", **settings)
    sb.write("config/interface.eth0", "INTERFACE=\"eth0\"\nPROTO=\"dhcp\"\n")
    r = sb._run(["unshare", "--net", "sh", "-c",
                 "mkdir -p /run/chrony-dhcp && echo 'server 192.0.2.1' > /run/chrony-dhcp/eth0.sources; "
                 "/opt/fpp/src/fppinit setupNetwork; "
                 f"ls /run/chrony-dhcp > {MEDIA}/tmp/chrony-left"], timeout=200, media_home=True)
    assert_clean(r)
    return sb.media_file("tmp/chrony-left").split()


def test_an_unset_ntp_from_dhcp_clears_the_dhcp_servers_chrony_picked_up(fppinit):
    """Without UseNTPFromDHCP, setupNetwork removes the NTP sources a DHCP
    lease left for chrony; with it on, it leaves them.

    Regression: 7c2433585, in its chrony form (f55aa5f85 replaced the
    ntpsec DHCP config it wrote)."""
    assert chrony_sources_left(fppinit) == []
    assert chrony_sources_left(fppinit, UseNTPFromDHCP="1") == ["eth0.sources"]


def test_a_wifi_interface_with_no_ssid_gets_no_network_file(fppinit):
    """An interface.wlan0 with no SSID (and not the tether) is not a usable
    client: it gets no .network file, and with an SSID it does.

    Regression: a24ff2d1f. An unconfigured wlan0 got a .network file that
    made networkd wait for an association that was never coming."""
    with_config_dirs(fppinit)
    fppinit.write("config/interface.wlan0", 'INTERFACE="wlan0"\nPROTO="dhcp"\n')
    start(fppinit)
    assert fppinit.written("/etc/systemd/network/10-wlan0.network") is None

    fppinit.write("config/interface.wlan0", 'INTERFACE="wlan0"\nPROTO="dhcp"\nSSID="Home"\nPSK="secretsecret"\n')
    start(fppinit)
    assert "Name=wlan0" in (fppinit.written("/etc/systemd/network/10-wlan0.network") or "")


def test_a_kiosk_url_cleared_in_the_ui_falls_back_to_the_local_page(fppinit):
    """The kiosk's Chromium policy opens KioskUrl, and http://localhost/
    when the UI has cleared it (it stores a pair of quotes, not nothing).

    Regression: 314f22d12 (#2165). The policy opened a page named \"\"."""
    fppinit.settings(Kiosk="1", KioskUrl='""')
    fppinit.root_file("/opt/fpp/SD/FPP_Kiosk.sh", "#!/bin/sh\nexit 0\n")
    assert_clean(fppinit.run("installKiosk"))
    policy = fppinit.written("/etc/chromium/policies/managed/policy.json") or ""
    assert '"RestoreOnStartupURLs": ["http://localhost/"]' in policy, policy

    fppinit.settings(KioskUrl="http://show.example/")
    os.unlink(os.path.join(fppinit.media, "settings"))
    fppinit.settings(Kiosk="1", KioskUrl="http://show.example/")
    assert_clean(fppinit.run("installKiosk"))
    assert 'RestoreOnStartupURLs": ["http://show.example/"]' in (
        fppinit.written("/etc/chromium/policies/managed/policy.json") or "")


def test_a_container_description_has_no_stray_whitespace(fppinit):
    """The container's HostDescription is "Docker ID: <id>" with the id
    trimmed.

    Regression: 1b32f389d. The id came with its newline, and the settings
    file got a description split over two lines."""
    fppinit.root_file("/etc/fpp/container", "")
    assert_clean(fppinit.run("checkHostName"))
    settings = fppinit.media_file("settings")
    desc = [l for l in settings.splitlines() if l.startswith("HostDescription")]
    assert len(desc) == 1 and desc[0].startswith('HostDescription = "Docker ID: ') and desc[0].endswith('"'), settings
    assert desc[0] == desc[0].strip() and '\\n' not in desc[0] and not desc[0].endswith(' "'), desc


def tether_removal(sb, enable):
    """maybeRemoveTether for a new interface on a box with hostapd running
    and a lease on eth0."""
    set_setting(sb, EnableTethering=str(enable), bootDelay="0")
    sb.service("hostapd", enabled=True, active=True)
    sb.root_file("/etc/systemd/network/10-wlan0.network", "[Match]\nName=wlan0\n")
    return sb._run(["unshare", "--net", "sh", "-c",
                    "ip link add eth0 type veth peer name eth0p && ip link set eth0 up && "
                    "ip addr add 10.99.0.2/24 dev eth0 && "
                    "exec /opt/fpp/src/fppinit maybeRemoveTether eth0"], timeout=120, media_home=True)


def test_a_routable_interface_does_not_end_tethering_that_is_set_to_enabled(fppinit):
    """When another interface comes up, boot stops the tether access point
    unless tethering is set to Enabled (EnableTethering=1).

    Regression: 520acccec. A tether the user had asked to keep on was shut
    down as soon as an Ethernet cable was plugged in."""
    assert_clean(tether_removal(fppinit, 0))
    assert "systemctl stop hostapd.service" in fppinit.calls(), fppinit.calls()
    assert_clean(tether_removal(fppinit, 1))
    assert not [c for c in fppinit.calls() if "hostapd" in c and "stop" in c], fppinit.calls()
