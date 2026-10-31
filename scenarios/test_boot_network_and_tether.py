"""Boot-time network and clock handling: what fppd's unit waits for, which
addresses end postNetwork's wait for the network, how long the tether hooks
wait for an address, and the networkd-dispatcher hooks that run them.

Run in the fppinit sandbox (fppinit.py), in a network namespace of its own
where the scenario builds the interfaces it needs: what is checked is what
fppinit and the hooks decide -- their output, the files they write and the
commands they run, as the stubs record them.
"""

import os
import re

import pytest

from fppinit import MEDIA, fppinit  # noqa: F401 -- the fixture
from test_fppinit import assert_clean
from test_fppinit_network_boot import interface_file, network_ports, run, with_config_dirs
from test_fppinit_pi import on_pi
from test_fppinit_tethering_boot import HOSTAPD_CONF

DISPATCHER = "/opt/fpp/etc/networkd-dispatcher"
# Where /proc/device-tree links to: the fake goes on the link's target, under
# the /sys the sandbox mounts before its fakes.
MODEL = "/sys/firmware/devicetree/base/model"


def in_netns(sb, script, timeout=300):
    """`script` (sh) in the sandbox, in a network namespace of its own, with
    the media directory also at /home/fpp/media."""
    return sb._run(["unshare", "--net", "sh", "-c", script], timeout=timeout, media_home=True)


def unit_list(path, key):
    """Every unit named on `key=` lines of a unit file's [Unit] section."""
    names, section = [], None
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line.startswith("["):
                section = line
            elif section == "[Unit]" and line.startswith(key + "="):
                names += line.split("=", 1)[1].split()
    return names


def test_fppd_starts_without_waiting_for_the_clock_to_be_synchronized():
    """fppd.service is ordered after fpp_postnetwork only, not after
    time-sync.target: a box with no network (or no time server) still
    starts fppd, which holds its scheduler until the clock is valid.

    Regression: 0c2626a55. fppd waited for time-sync.target, which a box
    with no route to a time server never reaches, so fppd did not start."""
    tree = os.environ.get("FPP_TREE")
    if not tree:
        pytest.skip("no tree under test")
    unit = os.path.join(tree, "etc", "systemd", "fppd.service")
    after = unit_list(unit, "After")
    assert "fpp_postnetwork.service" in after, f"fppd.service After= is {after}, so this proves nothing"
    assert "time-sync.target" not in after, f"fppd.service waits for the clock: After={after}"


def test_an_address_on_the_dummy_interface_does_not_end_the_wait_for_the_network(fppinit):
    """postNetwork takes the dummy interface down before it waits for an
    address: with dummy0 holding an address and eth0 getting its own 3 s in,
    the wait goes on until eth0 has it, and dummy0's is never reported.

    Regression: 0b88e6a59. dummy0 was removed after the wait, so its address
    ended the wait at once: the box went on (and fppd started) before the
    real interface had an address."""
    fppinit.settings(bootDelay="0", LogLevel="info")
    r = in_netns(fppinit,
                 "ip link set lo up && ip link add dummy0 type dummy && "
                 "ip addr add 10.98.0.1/24 dev dummy0 && ip link set dummy0 up && "
                 "ip link add eth0 type veth peer name eth0p && ip link set eth0 up && ip link set eth0p up || exit 99; "
                 "(sleep 3; ip addr add 10.99.0.5/24 dev eth0) & "
                 "exec /opt/fpp/src/fppinit postNetwork")
    out = r.stdout + r.stderr
    assert r.returncode != 99, f"could not make the interfaces (no dummy driver?):\n{out[-3000:]}"
    assert_clean(r)
    assert "Found dummy0 IP Address" not in out, f"the wait took dummy0's address:\n{out[-3000:]}"
    assert "Found eth0 IP Address 10.99.0.5" in out, f"the wait ended before eth0 had its address:\n{out[-3000:]}"


@pytest.mark.skipif(not on_pi(), reason="a Raspberry Pi build of fppinit")
def test_a_pi_zero_2_w_interface_does_not_ignore_carrier_loss(fppinit):
    """On a Pi Zero 2 W, setupNetwork leaves IgnoreCarrierLoss out of an
    interface's .network file; on other boards (the control: this board's
    own model) it has IgnoreCarrierLoss=5s. Device only: the model is
    faked on a Pi build.

    Regression: 8d9cb347f (#2487). The Zero 2 W's radio drops carrier
    briefly, and with the loss ignored networkd kept the stale state: the
    board fell off the network."""
    with_config_dirs(fppinit)
    fppinit.write("config/interface.eth0",
                  interface_file(INTERFACE="eth0", PROTO="static", ADDRESS="192.168.40.1",
                                 NETMASK="255.255.255.0"))
    network = "/etc/systemd/network/10-eth0.network"
    assert_clean(run(fppinit, "setupNetwork", net=True))
    own = fppinit.written(network) or ""
    assert "IgnoreCarrierLoss=5s" in own, f"no IgnoreCarrierLoss on this board, so this proves nothing:\n{own}"
    fppinit.fake_path(MODEL, "Raspberry Pi Zero 2 W Rev 1.0\0")
    assert_clean(run(fppinit, "setupNetwork", net=True))
    zero = fppinit.written(network) or ""
    assert "Address=192.168.40.1" in zero.replace(" ", ""), zero
    assert "IgnoreCarrierLoss" not in zero, f"a Pi Zero 2 W ignores carrier loss:\n{zero}"


@pytest.mark.parametrize("action,iface,most", [("maybeRemoveTether", "eth0", 8),
                                                ("checkForTether", "wlan0", 10)])
def test_the_tether_hooks_wait_only_briefly_for_an_address(fppinit, action, iface, most):
    """Run from networkd-dispatcher on a link change, maybeRemoveTether
    waits about 2 s and checkForTether about 4 s for an address that does
    not come (eth0 has carrier, DHCP never answers), not the 20 s the boot
    waits.

    Regression: 470e2f5b7. Both waited the boot's 20 s, holding up the
    dispatcher's other hooks for each link change."""
    with_config_dirs(fppinit)
    fppinit.settings(bootDelay="0", EnableTethering="2", TetherInterface="wlan0")
    fppinit.service("hostapd", enabled=True, active=True)
    fppinit.service("fpp_postnetwork", enabled=True, active=True)
    fppinit.fake_path("/sys/class/net", {"lo/carrier": "1\n", "lo/flags": "0x9\n",
                                         "eth0/carrier": "1\n", "eth0/flags": "0x1003\n"})
    # Timed inside the sandbox, so its own setup and teardown don't count.
    r = in_netns(fppinit,
                 "ip link set lo up && ip link add eth0 type veth peer name eth0p && "
                 "ip link set eth0 up && ip link set eth0p up || exit 99; "
                 f"s=$(date +%s%N); /opt/fpp/src/fppinit {action} {iface}; rc=$?; "
                 "echo \"took-ms $(( ($(date +%s%N) - s) / 1000000 ))\"; exit $rc")
    out = r.stdout + r.stderr
    assert r.returncode != 99, f"could not make the interfaces:\n{out[-3000:]}"
    assert_clean(r)
    assert "Could not get a valid IP address" in out, f"{action} did not wait for an address:\n{out[-3000:]}"
    took = int(re.search(r"took-ms (\d+)", out).group(1)) / 1000
    assert took < most, f"{action} {iface} took {took:.1f} s waiting for an address"


def test_a_usb_gadget_link_coming_up_leaves_the_tether_up(fppinit):
    """The routable hook (check_tether) takes the tether down when another
    interface gets a real address (eth0), but not when the USB gadget link
    to a computer (usb0, 192.168.7.2) comes up.

    Regression: 947365239. The hook was a shell script of its own that took
    down hostapd for any interface but the tether's, so plugging the box
    into a computer's USB port dropped the access point."""
    with_config_dirs(fppinit)
    fppinit.settings(bootDelay="0", TetherInterface="wlan0")
    fppinit.service("hostapd", enabled=True, active=True)
    hook = DISPATCHER + "/routable.d/check_tether"
    setup = ("ip link set lo up && ip link add eth0 type veth peer name eth0p && ip link set eth0 up && "
             "ip link set eth0p up && ip addr add 10.99.0.5/24 dev eth0 || exit 99; ")

    def stopped():
        return [c for c in fppinit.calls() if re.match(r"systemctl (stop|disable) hostapd", c)]

    r = in_netns(fppinit, setup + f"IFACE=eth0 ADDR=10.99.0.5 {hook}")
    assert r.returncode != 99, r.stdout + r.stderr
    assert stopped(), f"eth0 getting an address left the tether up, so this proves nothing: {fppinit.calls()}"
    r = in_netns(fppinit, setup + f"IFACE=usb0 ADDR=192.168.7.2 {hook}")
    assert not stopped(), f"usb0 coming up took the tether down: {fppinit.calls()}\n{(r.stdout + r.stderr)[-2000:]}"


def test_a_wifi_adapter_coming_up_without_an_address_brings_the_tether_up(fppinit):
    """When networkd sees a Wi-Fi adapter (initialized) with no address, its
    hook runs fppinit checkForTether for it, which with tethering on writes
    the access point's hostapd.conf for that adapter.

    Regression: 947365239. There was no such hook: an adapter that appeared
    after boot (a USB dongle plugged in) never became the tether."""
    with_config_dirs(fppinit)
    fppinit.settings(bootDelay="0", EnableTethering="1", TetherInterface="wlan0")
    network_ports(fppinit, wlan0="wifi")
    fppinit.service("fpp_postnetwork", enabled=True, active=True)
    hook = DISPATCHER + "/initialized.d/fpptether"
    # The hook backgrounds fppinit; wait for it before the sandbox ends.
    r = in_netns(fppinit,
                 f"IFACE=wlan0 IP_ADDRS= {hook}; sleep 0.5; "
                 "i=0; while [ $i -lt 600 ] && grep -qsx fppinit /proc/[0-9]*/comm; do sleep 0.1; i=$((i+1)); done")
    conf = fppinit.written(HOSTAPD_CONF) or ""
    assert "interface=wlan0" in conf, \
        f"wlan0 coming up did not set up the tether: {fppinit.calls()}\n{(r.stdout + r.stderr)[-2000:]}"
