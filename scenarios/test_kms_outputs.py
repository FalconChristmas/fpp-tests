"""Pixel overlay models on a real KMS connector (KMSFrameBuffer).

Device only: run with run-local.sh on a Raspberry Pi whose second HDMI port
(HDMI-A-2) is empty, while nothing else -- the device's own fppd, a desktop --
holds DRM master. Skipped elsewhere.
"""

import glob
import os
import time

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


def test_a_deleted_framebuffer_never_gets_a_flip_event(fppd):
    """Taking one of two HDMI outputs on a card off in an output reload, again
    and again while both are drawing, never delivers a page-flip event to the
    deleted framebuffer.

    Regression: 90a99035b. A flip carried "this" as its event data, the
    framebuffers on a card share its fd (any of them drains the others'
    events), and the destructor left its last flip queued: the surviving
    output's next drmHandleEvent() ran the flip handler on the freed object,
    which wrote its flip counters into the heap.

    Needs both HDMI connectors of one card empty and a build without a
    sanitizer: flipguard.c (which interposes free()) stands in for ASan,
    which can't run on the Pi 4's kernel. An FB model on HDMI-A-1 keeps the
    card open; a Virtual Matrix on HDMI-A-2 comes and goes.
    """
    from fppd import sanitizer
    import shims
    if sanitizer(fppd.tree):
        pytest.skip("flipguard interposes free(); run on a build without a sanitizer")
    cards = set()
    for c in ("HDMI-A-1", "HDMI-A-2"):
        paths = glob.glob(f"/sys/class/drm/card*-{c}/status")
        if not paths:
            pytest.skip(f"no {c} connector here")
        with open(paths[0]) as f:
            if f.read().strip() != "disconnected":
                pytest.skip(f"{c} has a display attached")
        cards.add(paths[0].split("/")[4].split("-")[0])
    if len(cards) != 1:
        pytest.skip("the HDMI connectors are on different cards")
    guard = shims.build("flipguard.c")
    flips = os.path.join(fppd.media, "logs", "flipguard.log")

    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [
        {"Name": "Keep", "Type": "FB", "Width": 64, "Height": 32, "Device": "HDMI-A-1"}]})
    matrix = {"channelOutputs": [{"enabled": 1, "type": "VirtualMatrix", "startChannel": 1,
                                  "channelCount": 64 * 32 * 3, "device": "HDMI-A-2",
                                  "width": 64, "height": 32}]}
    fppd.write("config/co-other.json", matrix)
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start(preload=[guard], extra_env={"FLIPGUARD_LOG": flips})
    fppd.command("Test Start", 1000, "RGB Cycle", "1-6144", "R-G-B")

    def draw(seconds):
        end = time.monotonic() + seconds
        n = 0
        while time.monotonic() < end:
            fppd.command("Overlay Model Fill", "Keep", "Enabled", ("#FF0000", "#0000FF")[n % 2])
            n += 1
            time.sleep(0.03)

    for _ in range(8):
        draw(1.5)
        fppd.write("config/co-other.json", {"channelOutputs": []})
        draw(1.5)
        fppd.write("config/co-other.json", matrix)
    draw(1.5)
    out = fppd.log()
    assert "flipguard:" not in out, fppd.tail()
    with open(flips) as f:
        lines = f.read().split()
    flipped = set(lines[i + 1] for i in range(0, len(lines) - 1, 2) if lines[i] == "flip")
    # both outputs flipped, so the reloads really did run with flips queued
    assert len(flipped) >= 2, lines[-20:]
    fppd.command("Test Stop")
