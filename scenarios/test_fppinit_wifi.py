"""fppinit setupNetwork, Wi-Fi side: the wpa_supplicant config it writes for
a client network (and a backup one), and the systemd-networkd file for the
tethering access point, from config/interface.<if> and config/leases.<if>.

Run in the fppinit sandbox (fppinit.py); what is checked is the text of the
files written, which is all fppinit decides -- associating with a real
access point is the driver's business and is device-only.
"""

import contextlib
import subprocess

import pytest

from fppinit import fppinit  # noqa: F401 -- the fixture
from test_fppinit import assert_clean

WPA_CONF = "/etc/wpa_supplicant/wpa_supplicant-wlan0.conf"
TETHER_NETWORK = "/etc/systemd/network/10-wlan0.network"


def interface_file(**fields):
    return "".join(f'{k}="{v}"\n' for k, v in fields.items())


def with_config_dirs(sb):
    """The directories setupNetwork writes into, which the container image
    may not have (fppinit writes the files, it doesn't make the dirs)."""
    for d in ("/etc/wpa_supplicant", "/etc/systemd/network", "/etc/hostapd"):
        sb.root_file(d + "/.fpp-test", "")


def wpa_config(sb, **fields):
    """Run setupNetwork with a client interface.wlan0 of `fields`, and return
    the wpa_supplicant config it wrote as (global lines, [network block
    dicts])."""
    with_config_dirs(sb)
    sb.write("config/interface.wlan0",
             interface_file(INTERFACE="wlan0", PROTO="dhcp", **fields))
    assert_clean(sb.run("setupNetwork"))
    text = sb.written(WPA_CONF)
    assert text is not None, f"no {WPA_CONF} was written; calls: {sb.calls()}"
    globals_, blocks, block = [], [], None
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("network={"):
            block = {}
        elif line == "}" and block is not None:
            blocks.append(block)
            block = None
        elif block is not None and "=" in line:
            k, v = line.split("=", 1)
            block[k] = v
        elif line:
            globals_.append(line)
    return globals_, blocks, text


PRIMARY = dict(SSID="PrimaryNet", PSK="primary-pass")
BACKUP = dict(BACKUPSSID="BackupNet", BACKUPPSK="backup-pass")


def test_a_wpa3_backup_network_uses_its_own_password(fppinit):
    """A WPA3 backup network's SAE password is the backup's own PSK.

    Regression: 19e5bc3e0. The backup block's sae_password was built from the
    primary network's PSK, so a WPA3 backup SSID with a password of its own
    always failed SAE (its psk= line was right, which hid it on WPA2)."""
    _, blocks, text = wpa_config(fppinit, WPA3="1", BACKUPWPA3="1", **PRIMARY, **BACKUP)
    assert len(blocks) == 2, text
    primary, backup = blocks
    assert primary["ssid"] == '"PrimaryNet"' and primary["sae_password"] == '"primary-pass"', text
    assert backup["ssid"] == '"BackupNet"', text
    assert backup["key_mgmt"] == "SAE WPA-PSK", text
    assert backup["sae_password"] == '"backup-pass"', text


@pytest.mark.parametrize("off", ["0", "false"])
def test_a_flag_written_as_0_or_false_is_off(fppinit, off):
    """WPA3, BACKUPWPA3, HIDDEN and BACKUPHIDDEN written as "0" or "false"
    (by an API caller -- the UI writes "1" or "") are off: plain WPA-PSK, no
    SAE, no scan_ssid.

    Regression: 19e5bc3e0. Any non-empty value turned the flag on."""
    globals_, blocks, text = wpa_config(fppinit, WPA3=off, BACKUPWPA3=off, HIDDEN=off,
                                        BACKUPHIDDEN=off, **PRIMARY, **BACKUP)
    assert len(blocks) == 2, text
    for b in blocks:
        assert b["key_mgmt"] == "WPA-PSK", text
        assert "sae_password" not in b and "scan_ssid" not in b, text
    assert not [g for g in globals_ if g.startswith("sae_pwe")], text


@pytest.mark.parametrize("flags", [dict(WPA3="1"), dict(BACKUPWPA3="1")], ids=["primary", "backup only"])
def test_wpa3_allows_hunting_and_pecking(fppinit, flags):
    """With WPA3 ticked -- on the primary, or on the backup alone -- the
    global sae_pwe is 2 (hash-to-element where the AP offers it,
    hunting-and-pecking otherwise); without WPA3 there is no sae_pwe line.

    Regression: 6930ee0ab. It was sae_pwe=1 (H2E only): wpa_supplicant then
    skips every BSS of an AP that doesn't advertise H2E -- most WPA2/WPA3
    mixed-mode routers -- so the WPA3 box never connected. And the line was
    written only for a WPA3 primary, though it is global."""
    globals_, _, text = wpa_config(fppinit, **flags, **PRIMARY, **BACKUP)
    assert [g for g in globals_ if g.startswith("sae_pwe")] == ["sae_pwe=2"], text


def test_no_wpa3_writes_no_sae_pwe(fppinit):
    """The other side of the above: no WPA3 anywhere, no sae_pwe."""
    globals_, _, text = wpa_config(fppinit, **PRIMARY, **BACKUP)
    assert not [g for g in globals_ if g.startswith("sae_pwe")], text


def test_pmf_is_one_global_optional_not_per_network(fppinit):
    """Protected Management Frames are asked for once, as the global
    "optional" pmf=1, and never per network.

    Regression: f89e89604 (#2953). Every network block carried
    ieee80211w=1, which wpa_supplicant applies without checking the
    driver: on a chip with no MFP support (Pi Zero W / Pi 3B) it negotiated
    PMF with any PMF-capable AP and then dropped the association. The
    global default is skipped when the driver has no BIP cipher."""
    globals_, blocks, text = wpa_config(fppinit, WPA3="1", **PRIMARY, **BACKUP)
    assert globals_.count("pmf=1") == 1, text
    assert len(blocks) == 2, text
    for b in blocks:
        assert "ieee80211w" not in b, text


@contextlib.contextmanager
def wifi_adapter(name):
    """A dummy interface named like a Wi-Fi adapter, so /sys/class/net/<name>
    exists and fppinit's tethering step thinks there is one to bring up."""
    r = subprocess.run(["ip", "link", "add", name, "type", "dummy"], capture_output=True, text=True)
    if r.returncode:
        pytest.skip(f"cannot add a dummy interface: {r.stderr.strip()}")
    try:
        yield
    finally:
        subprocess.run(["ip", "link", "del", name], capture_output=True)


LEASE = "[DHCPServerStaticLease]\nMACAddress=02:00:00:00:00:77\nAddress=192.168.8.77\n"


@pytest.mark.parametrize("adapter", [False, True], ids=["setupNetwork", "maybeEnableTethering"])
def test_tethering_ap_uses_the_configured_pool_and_leases(fppinit, adapter):
    """The tethering access point's DHCP server hands out the pool set on
    the Network page (DHCP Pool Offset / Size in interface.wlan0) and
    carries the static leases from config/leases.wlan0 -- whether the
    .network file comes from setupNetwork alone (no adapter present) or is
    rewritten by the tethering step that follows it (a wlan0 is present).

    Regression: b96c202e9. The tethering step rewrote the file with a
    hard-coded pool of 10/100 and no leases, so the second write undid the
    user's pool; and setupNetwork looked for the leases at
    "<media>config/leases.wlan0" (no "/"), so they were never included.
    """
    with_config_dirs(fppinit)
    fppinit.settings(EnableTethering="1", TetherInterface="wlan0")
    fppinit.write("config/interface.wlan0",
                  interface_file(INTERFACE="wlan0", PROTO="static", ADDRESS="192.168.8.1",
                                 NETMASK="255.255.255.0", DHCPOFFSET="100", DHCPPOOLSIZE="50"))
    fppinit.write("config/leases.wlan0", LEASE)
    with wifi_adapter("wlan0") if adapter else contextlib.nullcontext():
        r = fppinit.run("setupNetwork")
    assert_clean(r)
    net = fppinit.written(TETHER_NETWORK)
    assert net is not None, f"no {TETHER_NETWORK} was written:\n{r.stdout[-2000:]}"
    if adapter:
        assert "No interface for tethering" not in r.stdout, \
            f"the tethering step never ran, so this proves nothing:\n{r.stdout[-2000:]}"
    assert "PoolOffset=100\n" in net and "PoolSize=50\n" in net, net
    assert "PoolOffset=10\n" not in net, net
    assert "Address=192.168.8.77" in net, f"the static lease is missing:\n{net}"
