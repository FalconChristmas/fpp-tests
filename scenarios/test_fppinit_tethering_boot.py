"""fppinit's network setup and tethering decisions in cases that need no
Wi-Fi hardware: no config directory, a fresh install that enables
tethering, and a cable that is plugged in.

Run in the fppinit sandbox (fppinit.py), in a network namespace of its own
where a scenario says so: what is checked is the files written, not what
an access point then does.
"""

import os
import shutil

from fppinit import MEDIA, Link, fppinit  # noqa: F401 -- the fixture
from test_fppinit import assert_clean
from test_fppinit_network_boot import network_ports, run, with_config_dirs

HOSTAPD_CONF = "/etc/hostapd/hostapd.conf"
TETHER_NETWORK = "/etc/systemd/network/10-wlan0.network"


def test_setup_network_with_no_config_directory_completes(fppinit):
    """With no config directory in the media directory at all, setupNetwork
    still finishes instead of throwing from the directory iterator.

    Regression: 76ae6a363. A fresh install has no config directory yet,
    and the exception ended fppinit before the rest of its boot."""
    with_config_dirs(fppinit)
    shutil.rmtree(os.path.join(fppinit.media, "config"))
    fppinit.settings(bootDelay="0")
    r = run(fppinit, "setupNetwork", net=True)
    assert_clean(r)
    assert "filesystem error" not in r.stdout + r.stderr, r.stdout[-2000:]


def test_enabled_tethering_with_no_interface_files_writes_the_access_point(fppinit):
    """EnableTethering=1 on a box with no interface config files (a fresh
    install) still gets a hostapd.conf and a .network file with a DHCP
    server for the tether interface.

    Regression: a55f6341d (its setupNetwork half; boot runs setupNetwork alone,
    the setupNetwork action goes on to tether). The tether files were only written from an
    interface config, so a fresh install never offered its access point."""
    with_config_dirs(fppinit)
    shutil.rmtree(os.path.join(fppinit.media, "config"))
    fppinit.settings(bootDelay="0", EnableTethering="1", TetherInterface="wlan0")
    network_ports(fppinit, wlan0="wifi")
    # "start" sets the network up from the config alone: setupNetwork's own
    # action goes on to the tethering step, which writes the same files.
    fppinit.root_file("/etc/ssh/.fpp-test", "")
    assert_clean(run(fppinit, "start", net=True))
    assert "interface=wlan0" in (fppinit.written(HOSTAPD_CONF) or ""), fppinit.written(HOSTAPD_CONF)
    net = fppinit.written(TETHER_NETWORK) or ""
    assert "Name=wlan0" in net and "DHCPServer=yes" in net, net
    assert "Address=192.168.8.1/24" in net, net


def tether_on_a_wired_box(sb, carrier):
    with_config_dirs(sb)
    sb.settings(bootDelay="0", TetherInterface="wlan0")
    network_ports(sb, wlan0="wifi", eth0="wired")
    sb.fake_path("/sys/class/net", {
        "lo/carrier": "1\n", "lo/flags": "0x9\n",
        "eth0/carrier": f"{carrier}\n", "eth0/flags": "0x1003\n", "eth0/device": Link("/tmp/fpp-dev/eth0"),
        "wlan0/carrier": "0\n", "wlan0/flags": "0x1003\n", "wlan0/device": Link("/tmp/fpp-dev/wlan0"),
        "wlan0/wireless/.keep": ""})
    r = run(sb, "setupNetwork", net=True)
    assert_clean(r)
    return r


def test_tethering_waits_for_a_wired_port_with_a_cable(fppinit):
    """A box with no address yet but a wired port with carrier does not bring
    up the tether access point (a lease is on its way); with no cable
    plugged in, it does.

    Regression: 4d165cf8d. Tethering came up on every boot that was
    quicker than DHCP, and a box on a wired network lost it to an AP."""
    tether_on_a_wired_box(fppinit, carrier=0)
    assert fppinit.written(HOSTAPD_CONF), "with no cable, tethering was not enabled, so this proves nothing"

    r = tether_on_a_wired_box(fppinit, carrier=1)
    assert not fppinit.written(HOSTAPD_CONF), f"tethering was enabled with a cable plugged in:\n{r.stdout[-2000:]}"
    assert "has link, not enabling tethering" in r.stdout


def test_a_dhcp_interface_does_not_take_its_hostname_from_the_lease(fppinit):
    """The .network file for a DHCP interface says UseHostname=false, and
    so does the default one the image ships: FPP owns the hostname.

    Regression: 516c4fbdf. networkd set the hostname from the lease through
    systemd-hostnamed and polkit, ~21 s of a BeagleBone's boot to set a
    name FPP had already written."""
    with_config_dirs(fppinit)
    fppinit.write("config/interface.eth0", "INTERFACE=\"eth0\"\nPROTO=\"dhcp\"\n")
    fppinit.settings(bootDelay="0")
    assert_clean(run(fppinit, "setupNetwork", net=True))
    net = fppinit.written("/etc/systemd/network/10-eth0.network") or ""
    assert "[DHCPv4]" in net and "UseHostname=false" in net, net
    with open(os.path.join(fppinit.tree, "etc/systemd/network/50-default.network")) as f:
        assert "UseHostname=false" in f.read()


def announcing(sb, address_after=None):
    """Run announceIP on a box whose eth0 gets 10.99.0.2 `address_after`
    seconds in (None: no address, ever), with stand-ins for flite and
    pw-play that note what they were given; returns the run."""
    sb.root_file("/usr/bin/flite", f"#!/bin/sh\necho \"flite $*\" >> {MEDIA}/tmp/announced\n")
    sb.root_file("/usr/bin/pw-play", f"#!/bin/sh\necho \"pw-play $*\" >> {MEDIA}/tmp/announced\n")
    sb.root_file("/run/fppd/.keep", "")
    add = "ip addr add 10.99.0.2/24 dev eth0"
    later = f"(sleep {address_after}; {add}) &" if address_after is not None else ""
    return sb._run(["unshare", "--net", "sh", "-c",
                    "ip link add eth0 type veth peer name eth0p && ip link set eth0 up && " + later +
                    " exec /opt/fpp/src/fppinit announceIP"], timeout=120, media_home=True)


def test_the_ip_announcement_is_its_own_action_and_waits_for_the_address(fppinit):
    """announceIP speaks the box's addresses -- also when the DHCP lease lands
    a few seconds after it started -- and says so when there is none; boot's
    postNetwork no longer runs flite itself.

    Regressions: ca64544e2 (the announcement moved from postNetwork into
    announceIP, run by its own unit after PipeWire) and 174a54698 (the
    announcement gave up at once when the address was not there yet)."""
    assert_clean(announcing(fppinit, address_after=3))
    said = fppinit.media_file("tmp/announced") if fppinit.media_exists("tmp/announced") else ""
    assert "flite" in said and "I Have Found The Following I P Addresses" in said and "10.99.0.2" in said, \
        f"announced: {said!r}"
    assert "pw-play" in said, said

    os.unlink(os.path.join(fppinit.media, "tmp", "announced"))
    fppinit.settings(bootDelay="0")
    fppinit.root_file("/usr/bin/flite", f"#!/bin/sh\necho \"flite $*\" >> {MEDIA}/tmp/announced\n")
    r = fppinit._run(["unshare", "--net", "sh", "-c",
                      "ip link add eth0 type veth peer name eth0p && ip link set eth0 up && ip addr add 10.99.0.2/24 dev eth0 && "
                      "exec /opt/fpp/src/fppinit postNetwork"], timeout=200, media_home=True)
    assert_clean(r)
    assert not fppinit.media_exists("tmp/announced"), "postNetwork announced the address itself"
