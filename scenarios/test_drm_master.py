"""Who holds DRM master on the display cards while fppd runs.

DRM master is exclusive per card: while fppd's fd is master, no other client
(an X server, a kiosk, fbcon relighting a monitor) can modeset there.

Device only: run with run-local.sh on a Raspberry Pi with an empty HDMI-A-2
and nothing else holding DRM master on any card (stop a kiosk's X server).
On a Pi 5, /dev/dri/card0 is the v3d render card, which drives no display,
and the HDMI connectors are on card1. Skipped elsewhere.
"""

import errno
import fcntl
import glob
import os

import pytest

CONNECTOR = "HDMI-A-2"

DRM_IOCTL_SET_MASTER = 0x641E
DRM_IOCTL_DROP_MASTER = 0x641F


def connector_card():
    """/dev/dri/cardN that carries CONNECTOR, empty, or skip."""
    paths = glob.glob(f"/sys/class/drm/card*-{CONNECTOR}/status")
    if not paths:
        pytest.skip(f"no {CONNECTOR} connector here")
    with open(paths[0]) as f:
        if f.read().strip() != "disconnected":
            pytest.skip(f"{CONNECTOR} has a display attached")
    return "/dev/dri/" + paths[0].split("/")[4].split("-")[0]


def master_free(card):
    """Whether this process can become DRM master on card right now (it
    gives master straight back), or the errno that refused it."""
    fd = os.open(card, os.O_RDWR | os.O_CLOEXEC)
    try:
        fcntl.ioctl(fd, DRM_IOCTL_SET_MASTER)
        fcntl.ioctl(fd, DRM_IOCTL_DROP_MASTER)
        return True
    except OSError as e:
        return e.errno
    finally:
        os.close(fd)


def test_fppd_leaves_master_free_on_a_card_it_does_not_draw_on(fppd):
    """An FB model on an HDMI connector: while it runs, fppd is DRM master of
    that card and of no other, so a client on another card (an X server on
    a second display card, or one started later) can still become master.

    Regression: e402d0948. The first KMS framebuffer output opened every
    /dev/dri/card* and kept each fd DRM master for as long as any
    framebuffer output existed, cards it never draws on included: a kiosk
    started after fppd on another card got EBUSY and stayed dark.
    """
    drawn = connector_card()
    others = sorted(c for c in glob.glob("/dev/dri/card[0-9]*") if c != drawn)
    if not others:
        pytest.skip(f"no DRM card here besides {drawn}")
    for card in [drawn] + others:
        if master_free(card) is not True:
            pytest.skip(f"another process holds DRM master on {card} (a kiosk's X server?)")

    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [
        {"Name": "Projector", "Type": "FB", "Width": 64, "Height": 32, "Device": CONNECTOR}]})
    fppd.settings(DisableFakeNetworkBridges="1", LogLevel_MediaOut="debug")
    fppd.start()
    fppd.wait_for(lambda: "DRM: opened" in fppd.log() and
                  any(m.get("Name") == "Projector" for m in fppd.get("/overlays/models")),
                  timeout=20, what="the FB model on its card")
    for card in others:
        assert f"DRM: opened {card}" in fppd.log(), \
            f"fppd never opened {card}, so this proves nothing\n{fppd.tail()}"
    # The control: the card the model draws on is fppd's.
    assert master_free(drawn) == errno.EBUSY, \
        f"fppd is not DRM master of {drawn}, which its FB model drives\n{fppd.tail()}"
    held = [card for card in others if master_free(card) is not True]
    assert not held, f"fppd holds DRM master on {held}, where it draws nothing"
