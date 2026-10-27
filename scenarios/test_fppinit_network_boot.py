"""fppinit's network bring-up at boot: the DHCP server's lease settings and a
pending lease reset, a hostapd that won't stop, Wi-Fi power saving, and a
USB network adapter whose USB link has died.

Run in the fppinit sandbox (fppinit.py). What is checked is what fppinit
decides -- the files it writes and the commands it runs, as the stubs
record them -- not what a kernel or a radio then does with them.
"""

import contextlib
import subprocess
import time

import pytest

from fppinit import Link, fppinit  # noqa: F401 -- the fixture
from test_fppinit import assert_clean

LEASE_DIR = "/var/lib/systemd/network/dhcp-server-lease"


def interface_file(**fields):
    return "".join(f'{k}="{v}"\n' for k, v in fields.items())


def run(sb, action, *args, net=False, timeout=300):
    """fppinit <action> in the sandbox, its media directory also at
    /home/fpp/media, where fppinit read it before FPP_MEDIA_DIR (e930dec80):
    these fixes' parents are older. net: in a network namespace of its own,
    so the box has no network but what the scenario fakes."""
    argv = ["/opt/fpp/src/fppinit", action, *args]
    return sb._run((["unshare", "--net"] if net else []) + argv, timeout=timeout, media_home=True)


def with_config_dirs(sb):
    """The directories setupNetwork writes into, which the container image
    may not have (fppinit writes the files, it doesn't make the dirs)."""
    for d in ("/etc/wpa_supplicant", "/etc/systemd/network", "/etc/hostapd"):
        sb.root_file(d + "/.fpp-test", "")


def test_a_dhcp_server_interface_keeps_its_leases_for_eight_hours(fppinit):
    """An interface that runs a DHCP server gets a [DHCPServer] section
    that persists its leases and hands them out for 8 hours.

    Regression: a1f1ec93e. The section set only the pool, so the leases
    took systemd's 1 hour default."""
    with_config_dirs(fppinit)
    fppinit.write("config/interface.eth0",
                  interface_file(INTERFACE="eth0", PROTO="static", ADDRESS="192.168.40.1",
                                 NETMASK="255.255.255.0", DHCPSERVER="1"))
    assert_clean(run(fppinit, "setupNetwork", net=True))
    net = fppinit.written("/etc/systemd/network/10-eth0.network")
    assert net is not None and "[DHCPServer]" in net, net
    server = net.split("[DHCPServer]", 1)[1]
    for line in ("PersistLeases=yes", "DefaultLeaseTimeSec=8h", "MaxLeaseTimeSec=8h"):
        assert line + "\n" in server, net


def test_a_pending_lease_reset_clears_the_dhcp_servers_leases_at_boot(fppinit):
    """Reset Config's network area leaves config/dhcpLeaseResetPending; the
    next boot's start step removes systemd-networkd's lease files and the
    marker, and leaves alone what isn't a lease.

    Regression: a1f1ec93e. Nothing cleared the leases, which survive a
    reboot since Debian 13 keeps them on disk, so a reset box went on
    handing old clients their old addresses."""
    with_config_dirs(fppinit)
    fppinit.write("config/dhcpLeaseResetPending", "1\n")
    for name in ("eth0", "wlan0"):
        fppinit.root_file(f"{LEASE_DIR}/{name}", '{"Leases":[]}\n')
    assert_clean(run(fppinit, "start", net=True))
    assert not fppinit.media_exists("config/dhcpLeaseResetPending"), "the marker was left"
    left = [n for n in ("eth0", "wlan0") if fppinit.written(f"{LEASE_DIR}/{n}") is not None]
    assert not left, f"lease files left behind: {left}"


def test_a_hostapd_that_will_not_stop_is_killed_and_setup_goes_on(fppinit):
    """Leaving tethering (a hostapd config is left over and hostapd is
    running) with a hostapd whose stop never finishes: setupNetwork gives
    the stop 10 s, kills hostapd, and returns.

    Regression: ffebdfa3d. The stop was waited for without a bound, so
    fppinit -- and the Network page's Restart Network request that runs
    it -- hung for as long as hostapd did."""
    with_config_dirs(fppinit)
    fppinit.root_file("/etc/hostapd/hostapd.conf", "interface=wlan0\n")
    fppinit.settings(EnableTethering="2")
    fppinit.service("hostapd", enabled=True, active=True)
    fppinit.stop_hang("hostapd", 3600)
    began = time.monotonic()
    try:
        r = run(fppinit, "setupNetwork", net=True, timeout=90)
    except subprocess.TimeoutExpired:
        pytest.fail(f"setupNetwork still hadn't returned after 90 s; calls: {fppinit.calls()}")
    took = time.monotonic() - began
    assert_clean(r)
    calls = fppinit.calls()
    assert [c for c in calls if c.startswith("systemctl") and "stop hostapd" in c], \
        f"hostapd was never stopped, so this proves nothing: {calls}"
    assert [c for c in calls if c.startswith("systemctl kill") and "SIGKILL" in c and "hostapd" in c], \
        f"hostapd was never killed: {calls}"
    assert took < 60, f"setupNetwork took {took:.0f} s"


IW = "#!/bin/sh\nprintf '%s\\n' \"iw $*\" >> /fppinit-calls.log\n"


@contextlib.contextmanager
def wireless_dummies(*names):
    """Dummy interfaces named like Wi-Fi adapters, each with an IPv4 and an
    IPv6 address, so getifaddrs() lists each one three times."""
    made = []
    try:
        for i, name in enumerate(names):
            r = subprocess.run(["ip", "link", "add", name, "type", "dummy"], capture_output=True, text=True)
            if r.returncode:
                pytest.skip(f"cannot add a dummy interface: {r.stderr.strip()}")
            made.append(name)
            subprocess.run(["ip", "addr", "add", f"10.254.{70 + i}.1/24", "dev", name], check=True)
            subprocess.run(["ip", "-6", "addr", "add", f"fd00:254:{70 + i}::1/64", "dev", name, "nodad"],
                           check=True)
            subprocess.run(["ip", "link", "set", name, "up"], check=True)
        yield
    finally:
        for name in made:
            subprocess.run(["ip", "link", "del", name], capture_output=True)


def test_boot_turns_off_wifi_power_saving_once_per_adapter(fppinit):
    """postNetwork turns 802.11 power saving off on every wireless
    interface, with one iw call per interface though each has an IPv4 and
    an IPv6 address as well as its link.

    Regression: 06d70729c. disableWLANPowerManagement() was never called,
    so power saving stayed at whatever the driver chose; and it walked
    getifaddrs() entry by entry, one per address family, so it would have
    run iw up to three times for each adapter."""
    fppinit.root_file("/usr/sbin/iw", IW)
    fppinit.settings(bootDelay="0", EnableTethering="2")
    with wireless_dummies("wlan0", "wlan1"):
        r = run(fppinit, "postNetwork")
    assert_clean(r)
    power = [c for c in fppinit.calls() if c.startswith("iw ") and "power_save off" in c]
    assert sorted(power) == ["iw dev wlan0 set power_save off", "iw dev wlan1 set power_save off"], \
        f"{power}; all calls: {fppinit.calls()}"


# A USB Wi-Fi adapter on port 1-1 whose link has died below the driver: its
# netdev is there, without carrier, and the kernel log is full of -EPROTO
# against the port.
USB_DEVICE = "/tmp/fpp-usb/usb1/1-1/1-1:1.0"


def wedged_adapter(sb, log_port="1-1"):
    """wlan0 on USB port 1-1, configured as a Wi-Fi client, with no carrier;
    the box has no other network (the run is in a network namespace of its
    own). The kernel log has USB protocol errors against `log_port`."""
    sb.root_file(USB_DEVICE + "/uevent", "DEVTYPE=usb_interface\n")
    sb.fake_path("/sys/class/net", {
        "lo/carrier": "1\n", "lo/flags": "0x9\n",
        "wlan0/carrier": "0\n", "wlan0/flags": "0x1003\n", "wlan0/wireless/.keep": "",
        "wlan0/device": Link(USB_DEVICE),
    })
    sb.fake_path("/sys/bus/usb/drivers/usb", {"bind": "", "unbind": ""})
    errors = "".join(f"[   {12 + i}.000000] usb {log_port}: device descriptor read/64, error -71\n"
                     for i in range(8))
    sb.root_file("/usr/bin/dmesg", "#!/bin/sh\ncat <<'EOF'\n" + errors + "EOF\n")
    sb.write("config/interface.wlan0",
             interface_file(INTERFACE="wlan0", PROTO="dhcp", SSID="TestNet", PSK="testpass123"))
    sb.settings(bootDelay="0")


def boot(sb, action="postNetwork", *args):
    return run(sb, action, *args, net=True)


def reboots(sb):
    return [c for c in sb.calls() if c.startswith("systemctl") and "reboot" in c]


def usb_resets(sb):
    """Ports written to the usb driver's unbind/bind, the re-enumeration the
    reboot replaced (c33c76e64)."""
    return (sb.faked("/sys/bus/usb/drivers/usb", "unbind") + sb.faked("/sys/bus/usb/drivers/usb", "bind")).split()


@pytest.mark.parametrize("case", ["wedged", "errors-on-another-port", "tethering"])
def test_a_wedged_usb_wifi_adapter_reboots_the_box(fppinit, case):
    """A USB Wi-Fi adapter with no carrier, no other network, and USB
    protocol errors against its own port in this boot's kernel log: the
    boot's postNetwork step asks for a forced reboot, without waiting for
    it, and counts the attempt in /var/tmp. With the errors against another
    port, or with tethering configured (no upstream network is expected),
    it doesn't.

    Regression: 06b8205c0. The recovery unbound and rebound the adapter on
    the usb driver, which on a real wedge fails its descriptor reads every
    time; the box stayed unreachable until someone power cycled it."""
    wedged_adapter(fppinit, log_port="2-1" if case == "errors-on-another-port" else "1-1")
    if case == "tethering":
        fppinit.settings(EnableTethering="1", TetherInterface="wlan0")
    r = boot(fppinit)
    assert_clean(r)
    if case != "wedged":
        assert not reboots(fppinit), f"{case}: rebooted: {fppinit.calls()}"
        return
    assert [c for c in reboots(fppinit) if "--force --force reboot" in c], \
        f"no forced reboot was asked for; resets {usb_resets(fppinit)}; calls: {fppinit.calls()}\n" \
        + r.stdout[-2000:]
    count = fppinit.written("/var/tmp/fpp-usbnet-wedge-reboots")
    assert count is not None and count.split()[0] == "1", count


def test_a_carrier_change_handler_never_resets_a_wedged_adapter(fppinit):
    """With the same dead adapter, `fppinit checkForTether wlan0` -- which
    networkd-dispatcher runs on every carrier change -- neither reboots nor
    re-enumerates anything, while the boot's postNetwork step does reset
    it (the control: this is a signature the recovery acts on).

    Regression: 25772b274. The re-enumeration was reachable from every
    caller of waitForInterfacesUp(), checkForTether included; a reset is a
    carrier change, so the dispatcher reset the adapter again every few
    seconds for as long as the box was up."""
    wedged_adapter(fppinit)
    fppinit.settings(EnableTethering="2")
    fppinit.service("fpp_postnetwork", active=True)
    for _ in range(2):
        assert_clean(boot(fppinit, "checkForTether", "wlan0"))
        assert not reboots(fppinit), f"checkForTether rebooted: {fppinit.calls()}"
        assert not usb_resets(fppinit), f"checkForTether re-enumerated USB {usb_resets(fppinit)}"
    assert_clean(boot(fppinit))
    assert reboots(fppinit) or usb_resets(fppinit), \
        f"postNetwork didn't reset the adapter either, so this proves nothing: {fppinit.calls()}"
