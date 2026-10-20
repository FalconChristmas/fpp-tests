"""Pixel overlay models on a real KMS connector (KMSFrameBuffer).

Device only: run with run-local.sh on a Raspberry Pi whose second HDMI port
(HDMI-A-2) is empty, while nothing else -- the device's own fppd, a desktop --
holds DRM master. Skipped elsewhere.
"""

import glob

import pytest

CONNECTOR = "HDMI-A-2"


def empty_connector():
    paths = glob.glob(f"/sys/class/drm/card*-{CONNECTOR}/status")
    if not paths:
        pytest.skip(f"no {CONNECTOR} connector here")
    with open(paths[0]) as f:
        if f.read().strip() != "disconnected":
            pytest.skip(f"{CONNECTOR} has a display attached")


def test_an_hdmi_output_with_no_display_still_comes_up(fppd):
    """An FB model on an HDMI connector with nothing plugged in is created
    (running a stand-in mode) and says so with warning 71, so a projector
    switched on later lights up without restarting fppd.

    Regression: 62ed3f548. A disconnected connector was skipped and its
    output never created.
    """
    empty_connector()
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [
        {"Name": "Projector", "Type": "FB", "Width": 1920, "Height": 1080, "Device": CONNECTOR}]})
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    names = [m.get("Name") for m in fppd.get("/overlays/models")]
    assert "Projector" in names, names
    warnings = fppd.get("/fppd/status").get("warningInfo", [])
    assert any(w.get("id") == 71 and CONNECTOR in w.get("message", "") and
               "no display detected" in w.get("message", "") for w in warnings), warnings
