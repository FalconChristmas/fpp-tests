"""BeagleBone PRU outputs under run-local.sh, against PRUs that never answer.

run-local.sh hides the PRUs from the test fppd on a BeagleBone (an empty
/sys/class/remoteproc and /lib/firmware, /dev/mem as /dev/null, a pinctrl that
only logs). An AM62x fppd then runs its FAKE_PRU mode: PRU memory is anonymous
memory and nothing is started, so an output's Init, PrepData and SendData run
in full against a PRU that never takes a command. That reaches the host side
of the PRU drivers -- config parsing, firmware builds, test patterns, reloads,
a PRU that stops answering -- without touching the device's own outputs.

Cape string configs come from /opt/fpp/capes/<platform>/strings, a path
CapeUtils hardcodes; run-local.sh overlays /opt/fpp, so what a scenario writes
there lands in its scratch layer. Panel configs come only from the cape's
EEPROM, so panel scenarios use the cape the device has.
"""

import json
import os

import pytest

CAPES = "/opt/fpp/capes/bb64/strings"


def fake_pru(fppd):
    """Skip unless fppd runs on an AM62x BeagleBone with its PRUs hidden."""
    if not os.environ.get("FPP_TESTS_BEAGLE"):
        pytest.skip("needs a BeagleBone under run-local.sh")
    if os.path.exists("/sys/class/remoteproc/remoteproc0/state"):
        pytest.skip("the PRUs are not hidden (run through run-local.sh)")
    if not os.path.exists(os.path.join(fppd.tree, "src", "libfpp-co-BBShiftString.so")):
        pytest.skip("the tree is not built for a BeagleBone")
    if not _am62x():
        pytest.skip("FAKE_PRU mode is AM62x only")


def _am62x():
    try:
        with open("/proc/device-tree/compatible", "rb") as f:
            return b"am62" in f.read()
    except OSError:
        return False


def write_string_cape(name, cape):
    """Install a cape string config (`cape` as JSON) under `name`, the
    output's subType."""
    os.makedirs(CAPES, exist_ok=True)
    path = os.path.join(CAPES, name + ".json")
    with open(path, "w") as f:
        json.dump(cape, f, indent=4)
    return path


def pixel_output(port, pixels, start=0):
    """One port's string config: `pixels` RGB pixels from channel `start`
    (0-based)."""
    return {"portNumber": port, "protocol": "ws2811", "differentialType": 0,
            "virtualStrings": [{"description": f"port{port}", "startChannel": start,
                                "pixelCount": pixels, "groupCount": 0, "reverse": 0,
                                "colorOrder": "RGB", "nullNodes": 0, "endNulls": 0,
                                "zigZag": 0, "brightness": 100, "gamma": "1.0"}]}


def strings_config(driver, subtype, outputs, channels=None):
    """co-bbbStrings.json for one string output."""
    channels = channels or max(
        [vs["startChannel"] + vs["pixelCount"] * 3 for o in outputs for vs in o["virtualStrings"]] + [3])
    return {"channelOutputs": [{"type": driver, "subType": subtype, "enabled": 1,
                                "startChannel": 1, "channelCount": channels,
                                "outputCount": len(outputs), "pinoutVersion": "1.x",
                                "outputs": outputs}]}
