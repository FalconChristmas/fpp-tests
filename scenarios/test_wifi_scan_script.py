"""scripts/wifi_scan.sh (the Troubleshooting page's WiFi scan) on an adapter
that is down, run as root in the fppinit sandbox (fppinit.py).

The adapter is a real dummy interface in the scenario's network namespace,
brought up and down by the real `ip` (the scenario container has NET_ADMIN).
iw and iwlist are stand-ins that answer as the real ones do: a scan of an
interface whose operstate is "down" fails with "Network is down", anything
else lists one network.  So whether the scan finds anything, and the state
the adapter is left in, are the kernel's answers.
"""

import subprocess

import pytest

from fppinit import fppinit  # noqa: F401 -- the fixture

DEV = "wlfpptest0"
SSID = "fpp-tests-net"

IW = f"""#!/bin/sh
printf '%s\\n' "iw $*" >> /fppinit-calls.log
state=$(cat /sys/class/net/{DEV}/operstate 2>/dev/null)
case "$*" in
  dev) printf 'phy#0\\n\\tInterface {DEV}\\n\\t\\ttype managed\\n' ;;
  "dev {DEV} info") printf 'Interface {DEV}\\n\\tifindex 9\\n\\ttype managed\\n' ;;
  "dev {DEV} link") echo "Not connected." ;;
  "dev {DEV} scan"*)
    if [ "$state" = down ]; then echo "command failed: Network is down (-100)" >&2; exit 240; fi
    printf 'BSS 02:11:22:33:44:55(on {DEV})\\n\\tfreq: 2437\\n\\tsignal: -48.00 dBm\\n\\tSSID: {SSID}\\n\\tRSN:\\t * Version: 1\\n' ;;
esac
exit 0
"""

IWLIST = f"""#!/bin/sh
printf '%s\\n' "iwlist $*" >> /fppinit-calls.log
if [ "$(cat /sys/class/net/{DEV}/operstate 2>/dev/null)" = down ]; then
    echo "{DEV}     Interface doesn't support scanning : Network is down" >&2; exit 255
fi
printf '{DEV}     Scan completed :\\n          Cell 01 - Address: 02:11:22:33:44:55\\n                    ESSID:"{SSID}"\\n'
exit 0
"""


def operstate():
    with open(f"/sys/class/net/{DEV}/operstate") as f:
        return f.read().strip()


@pytest.fixture
def adapter(fppinit):
    if subprocess.run(["ip", "link", "add", DEV, "type", "dummy"], capture_output=True).returncode != 0:
        pytest.skip("cannot add a dummy interface here (needs NET_ADMIN)")
    fppinit.unstub("iw")
    fppinit.root_file("/usr/sbin/iw", IW)
    fppinit.root_file("/usr/sbin/iwlist", IWLIST)
    try:
        yield fppinit
    finally:
        subprocess.run(["ip", "link", "del", DEV], capture_output=True)


def test_a_down_adapter_is_brought_up_to_scan_and_left_down(adapter):
    """An adapter that is down is brought up for the scan, which then finds
    the network, and is put back down afterwards.

    Regression: 2d0dd5c85 ("Set the interface up before the scan and restore
    afterwords").  A down adapter (no network configured on it) failed every
    scan with "Network is down", so the scan listed nothing.
    """
    assert operstate() == "down"
    r = adapter._run(["bash", "/opt/fpp/scripts/wifi_scan.sh"])
    out = r.stdout + r.stderr
    scans = [c for c in adapter.calls() if " scan" in c]
    assert scans, f"nothing was scanned: {adapter.calls()}\n{out[-2000:]}"
    assert "Network is down" not in out, out[-2000:]
    assert out.count(SSID) == 2, f"the iw and iwlist scans should each list the network:\n{out[-2000:]}"
    assert operstate() == "down", "the adapter was left up"


def test_an_adapter_that_was_up_stays_up(adapter):
    """The other half of 2d0dd5c85: only an adapter that was down is put
    back down."""
    subprocess.run(["ip", "link", "set", DEV, "up"], check=True)
    assert operstate() != "down"
    r = adapter._run(["bash", "/opt/fpp/scripts/wifi_scan.sh"])
    out = r.stdout + r.stderr
    assert out.count(SSID) == 2, out[-2000:]
    assert operstate() != "down", "an adapter that was up was taken down"
