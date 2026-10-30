"""The banner fppd writes at the top of its log on every start: FPP version,
branch, and the device model, so a log sent in for a problem says what it
ran on."""

import os

import shims


def test_the_log_banner_names_the_device_model(fppd):
    """The startup banner carries the board's model from the device tree.

    Regression: ff828a178. The banner had only the version and branch, so
    logs from different boards couldn't be told apart."""
    model = os.path.join(fppd.media, "tmp", "fpp-tests-model")
    os.makedirs(os.path.dirname(model), exist_ok=True)
    with open(model, "wb") as f:
        f.write(b"fpp-tests Board Model Rev 1.2\0")
    fppd.start(preload=[shims.build("fakesys.c")],
               extra_env={"FAKESYS": f"/proc/device-tree/model={model}"})
    fppd.wait_for(lambda: "FPP " in fppd.log(), timeout=10, what="the startup banner")
    lines = [l for l in fppd.log().splitlines() if "Model:" in l]
    assert any("Model: fpp-tests Board Model Rev 1.2" in l for l in lines), \
        f"no model in the banner: {lines or fppd.log()[:1500]}"
