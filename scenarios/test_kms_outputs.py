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

    Also guards c80ce6cc7: KMSFrameBuffer was built only where kms++'s
    headers were installed, and current images have none, so the model fell
    back to fbdev and warned that /dev/fb0 could not be opened.
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


def test_a_restarted_camera_does_not_share_the_framebuffer_outputs_fd(fppd, audio):
    """A camera group showing on HDMI-A-2 whose display fails (its kmssink
    errors), next to an FB model drawing on HDMI-A-1 of the same card: the
    camera is restarted on a lease of its own, never on the card's shared fd
    the framebuffer output flips on, and comes back without stalling.

    Regression: 4e06babd8. The dead pipeline's teardown runs on a thread of its
    own and gives the lease back only once its kmssink is gone, but the
    restart asked for the connector at once: on a Pi 5 it usually came 12 ms
    after the release, and now and then before it. Found held, the
    connector got no CRTC and DrmCards::AcquireLease() fell back to the
    card's master fd, where the framebuffer outputs drain every page-flip
    event: kmssink could lose its own event (a 3 s stall) or take theirs
    (SIGSEGV through their flip token; 081ff8d9e stopped kmssink waiting for
    events at all). failplane.so holds the teardown up for 300 ms, so the
    restart always asks while the old lease is held.

    Device only: both HDMI connectors on one card, HDMI-A-2 reading
    "connected", and nothing else holding DRM master -- a kiosk's X server
    does; switch away from its VT (chvt 2) for the run, chvt 1 after. With
    nothing plugged in, force the connector before the run (echo on >
    /sys/class/drm/card1-HDMI-A-2/status) and put it back after (echo
    detect). failplane.so fails two of kmssink's plane updates, after its
    first 60, and logs every one.
    """
    import shims
    from test_video import hdmi_consumer, setup as video_setup, source
    paths = {c: glob.glob(f"/sys/class/drm/card*-{c}/status") for c in ("HDMI-A-1", "HDMI-A-2")}
    if not paths["HDMI-A-1"] or not paths["HDMI-A-2"]:
        pytest.skip("needs HDMI-A-1 and HDMI-A-2")
    card = paths["HDMI-A-2"][0].split("/")[4].split("-")[0]
    if paths["HDMI-A-1"][0].split("/")[4].split("-")[0] != card:
        pytest.skip("the HDMI connectors are on different cards")
    with open(paths["HDMI-A-2"][0]) as f:
        if f.read().strip() != "connected":
            pytest.skip("HDMI-A-2 must read connected (force it: echo on > its status)")
    with open(os.path.join(os.path.dirname(paths["HDMI-A-2"][0]), "connector_id")) as f:
        connector_id = int(f.read())

    video_setup(fppd, [hdmi_consumer(1, connector_id=connector_id, card=f"/dev/dri/{card}", group=3)],
                [source("videotestsrc", pattern="ball", framerate=30)])
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [
        {"Name": "Keep", "Type": "FB", "Width": 64, "Height": 32, "Device": "HDMI-A-1"}]})
    log = os.path.join(fppd.media, "tmp", "failplane.log")
    fppd.start(preload=[shims.build("failplane.c")],
               extra_env={"FAILPLANE_LOG": log, "FAILPLANE_SKIP": "60", "FAILPLANE_COUNT": "2",
                          "FAILPLANE_STOP_DELAY_MS": "300"})

    def calls():
        try:
            with open(log) as f:
                return [(w, int(fd), float(t), int(rc)) for w, fd, _, t, rc in (l.split() for l in f if l.strip())]
        except FileNotFoundError:
            return []

    n = 0
    end = time.monotonic() + 25
    while time.monotonic() < end:
        fppd.command("Overlay Model Fill", "Keep", "Enabled", ("#FF0000", "#0000FF")[n % 2])
        n += 1
        time.sleep(0.03)
    out = fppd.log()
    if "refused (Permission denied)" in out:
        pytest.skip("another process holds DRM master (a kiosk's X server?)")
    got = calls()
    fb_fds = {fd for w, fd, _, _ in got if w == "f"}
    failed = [t for w, _, t, rc in got if w == "k" and rc < 0]
    # The controls: the framebuffer output drew, the camera's display
    # failed, and its consumer really was restarted.
    assert fb_fds, "the framebuffer output never updated its plane"
    assert failed, "kmssink never reached its failing frame"
    assert [1 for w, _, _, _ in got if w == "c"], "the dead kmssink's teardown was never held up"
    assert "pipeline died" in out and out.count("kmssink on DRM") >= 2, fppd.tail()
    after = [(fd, t) for w, fd, t, rc in got if w == "k" and rc >= 0 and t > failed[-1]]
    assert after, fppd.tail()
    assert after[0][1] - failed[-1] < 15, f"the camera took {after[0][1] - failed[-1]:.1f} s to come back"
    shared = sorted({fd for fd, _ in after if fd in fb_fds})
    assert not shared, f"the restarted kmssink drew on the framebuffer outputs' fd {shared}"
    gaps = [b - a for (_, a), (_, b) in zip(after, after[1:])]
    assert max(gaps, default=0) < 1.0, f"the restarted camera stalled {max(gaps):.1f} s"
