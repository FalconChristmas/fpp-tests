"""A fake Raspberry Pi 3 display card for fppd (see fakedrm.c), so a scenario
can drive HDMI where there is no display, in Docker included.

fppd sees /dev/dri/card0 with a 1920x1080@60 display on HDMI-A-1, and the
kmssink it plays video into is fakekms.c, putting each frame on its leased
plane of that card. The card refuses a commit over the vc4 display load
limit with ENOSPC, as a Pi 0-3 does.
"""

import os
import subprocess

import pytest

import shims

CONNECTOR = "HDMI-A-1"


def start_env(fppd):
    """(preload, extra_env) for fppd.start(): the fake card, and the stand-in
    kmssink committing its frames to it."""
    from test_video import fake_kms_env
    flags = subprocess.run(["pkg-config", "--cflags", "libdrm"], capture_output=True, text=True)
    if flags.returncode:
        pytest.skip("the libdrm development files are not installed")
    so = shims.build("fakedrm.c", libs=("-ldl", "-lpthread", *flags.stdout.split()))
    root = os.path.join(fppd.media, "tmp", "fakedrm")
    sysfs = os.path.join(root, "sys", "class", "drm", f"card0-{CONNECTOR}")
    os.makedirs(sysfs)
    for name, text in (("status", "connected"), ("enabled", "enabled"), ("connector_id", "35"),
                       ("modes", "1920x1080\n1280x720")):
        with open(os.path.join(sysfs, name), "w") as f:
            f.write(text + "\n")
    env = fake_kms_env(fppd, FAKEKMS_SETPLANE=1)
    env.update(FAKEDRM_DIR=root, FAKEDRM_LOG=os.path.join(fppd.media, "tmp", "fakedrm.log"))
    return [so], env


def log(fppd):
    """What the fake card did: plane changes and refusals, one per line."""
    try:
        with open(os.path.join(fppd.media, "tmp", "fakedrm.log")) as f:
            return f.read()
    except FileNotFoundError:
        return ""
