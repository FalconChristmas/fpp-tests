"""A KMS framebuffer output whose HDMI sink goes away and comes back.

Device only: run with run-local.sh on a Raspberry Pi whose HDMI-A-2 is empty
and nothing else holding DRM master. The scenario stands in for a display
being unplugged and plugged back by forcing the empty connector's status
("on", "off", "on") through a sysfs of its own -- run-local.sh's /sys is
read-only -- which makes the kernel send the same hotplug uevents, and
edidsink.so gives the connector an EDID while it reads connected. It puts
the connector back to "detect" afterwards. Skipped elsewhere.
"""

import contextlib
import glob
import os
import subprocess
import tempfile
import time

import pytest

CONNECTOR = "HDMI-A-2"


@contextlib.contextmanager
def connector_status():
    """A function that forces CONNECTOR's status ("on", "off", "detect"),
    through a writable sysfs of the scenario's own; "detect" again after."""
    paths = glob.glob(f"/sys/class/drm/card*-{CONNECTOR}/status")
    if not paths:
        pytest.skip(f"no {CONNECTOR} connector here")
    with open(paths[0]) as f:
        if f.read().strip() != "disconnected":
            pytest.skip(f"{CONNECTOR} has a display attached (or is forced already)")
    rel = os.path.relpath(paths[0], "/sys")
    mnt = tempfile.mkdtemp(prefix="sysrw-")
    if subprocess.run(["mount", "-t", "sysfs", "sysfs", mnt]).returncode:
        pytest.skip("cannot mount a writable sysfs here")

    def force(state):
        with open(os.path.join(mnt, rel), "w") as f:
            f.write(state)
    try:
        yield force
    finally:
        force("detect")
        subprocess.run(["umount", mnt])
        os.rmdir(mnt)


def test_an_hdmi_output_restarts_its_display_when_the_sink_comes_back(fppd):
    """A Virtual Matrix lit on HDMI-A-2; the display is unplugged and, a few
    seconds later, plugged back: fppd notices both from the kernel's
    hotplug uevents and gives the returning display a full off/on modeset.

    Regression: 9cc9195f4 (its hotplug half; test_kms_modeset.py has the
    modeset half). Nothing watched for hotplug: after a disconnect the
    output stayed as it was, and with fppd holding DRM master only around
    each flip the console's fbdev took master and turned the CRTC off, so
    the display stayed black until fppd restarted.
    """
    import shims
    with connector_status() as force:
        path = glob.glob(f"/sys/class/drm/card*-{CONNECTOR}/connector_id")[0]
        with open(path) as f:
            connector_id = f.read().strip()
        force("on")
        fppd.write("config/co-other.json", {"channelOutputs": [
            {"enabled": 1, "type": "VirtualMatrix", "startChannel": 1, "channelCount": 64 * 32 * 3,
             "device": CONNECTOR, "width": 64, "height": 32}]})
        fppd.settings(DisableFakeNetworkBridges="1", LogLevel_ChannelOut="info")
        fppd.start(preload=[shims.build("edidsink.c", libs=("-ldl", "-I/usr/include/libdrm"))],
                   extra_env={"EDIDSINK_CONNECTOR_ID": connector_id})
        fppd.command("Test Start", 1000, "RGB Cycle", f"1-{64 * 32 * 3}", "R-G-B")
        fppd.wait_for(lambda: f"KMSFrameBuffer: {CONNECTOR} mode" in fppd.log(), timeout=15,
                      what=f"the matrix on {CONNECTOR}")
        if "refused (Permission denied)" in fppd.log():
            pytest.skip("another process holds DRM master (a kiosk's X server?)")
        time.sleep(2)
        force("off")
        fppd.wait_for(lambda: f"KMSFrameBuffer {CONNECTOR}: display disconnected" in fppd.log(),
                      timeout=10, what="fppd to see the display go")
        force("on")
        fppd.wait_for(lambda: f"KMSFrameBuffer {CONNECTOR}: display reconnected" in fppd.log(),
                      timeout=10, what="fppd to see the display come back")
        fppd.wait_for(lambda: f"KMSFrameBuffer {CONNECTOR}: display restarted at" in fppd.log(),
                      timeout=10, what="the returning display's modeset")
        fppd.command("Test Stop")
