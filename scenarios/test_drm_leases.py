"""How video pipelines and the KMS framebuffer outputs share a display card's
connectors (DrmCards: one master fd per card, a DRM lease per kmssink).

Device only: run with run-local.sh on a Raspberry Pi with both HDMI
connectors on one card, HDMI-A-2 reading "connected", and nothing else
holding DRM master. With nothing plugged in, force the connector before the
run (echo on > /sys/class/drm/card1-HDMI-A-2/status) and put it back after
(echo detect). Skipped elsewhere.
"""

import glob
import os
import time

import pytest

CONNECTOR = "HDMI-A-2"


def forced_connector():
    """(card path, connector id) of CONNECTOR, which must read connected."""
    paths = glob.glob(f"/sys/class/drm/card*-{CONNECTOR}/status")
    if not paths:
        pytest.skip(f"no {CONNECTOR} connector here")
    with open(paths[0]) as f:
        if f.read().strip() != "connected":
            pytest.skip(f"{CONNECTOR} must read connected (force it: echo on > its status)")
    with open(os.path.join(os.path.dirname(paths[0]), "connector_id")) as f:
        connector_id = int(f.read())
    return "/dev/dri/" + paths[0].split("/")[4].split("-")[0], connector_id


def failplane_calls(path):
    """[(k|f|c, fd, monotonic s, rc)] from failplane.so's log."""
    try:
        with open(path) as f:
            return [(w, int(fd), float(t), int(rc)) for w, fd, _, t, rc in (l.split() for l in f if l.strip())]
    except FileNotFoundError:
        return []


def test_a_restarted_camera_keeps_its_connector_held_after_the_old_lease_goes(fppd, audio):
    """A camera group on HDMI-A-2, with an FB model on the same connector
    standing aside for it. The camera's display fails and its consumer is
    restarted while the dead pipeline's teardown is held up for 2.6 s, past
    the 2 s the restart waits for it: the restart shares the card's fd, and
    when the old lease is finally given back the FB model keeps standing
    aside, because the restarted camera still holds the connector.

    Regression: 9df850c6c. The lease-less fallback recorded no hold of its
    own on a connector someone already held, so the old lease's release
    erased the connector's mark: HeldByMedia() said it was free and the FB
    model came back ("showing output again") over the running camera.

    failplane.so fails two of kmssink's plane updates after its first 60
    and holds the teardown (the first drmModeRmFB() after them) for 2600 ms.
    """
    import shims
    from test_command_socket import send
    from test_video import SOURCE, hdmi_consumer, setup as video_setup, source
    card, connector_id = forced_connector()
    # No input source yet: the camera starts once the FB model is showing,
    # since only a lit output has anything to stand aside with.
    video_setup(fppd, [hdmi_consumer(1, source=SOURCE, connector_id=connector_id, card=card, group=3)])
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [
        {"Name": "Under", "Type": "FB", "Width": 64, "Height": 32, "Device": CONNECTOR}]})
    fppd.settings(LogLevel_ChannelOut="info", LogLevel_MediaOut="debug")
    log = os.path.join(fppd.media, "tmp", "failplane.log")
    fppd.start(preload=[shims.build("failplane.c")],
               extra_env={"FAILPLANE_LOG": log, "FAILPLANE_SKIP": "60", "FAILPLANE_COUNT": "2",
                          "FAILPLANE_STOP_DELAY_MS": "2600"})
    if "refused (Permission denied)" in fppd.log():
        pytest.skip("another process holds DRM master (a kiosk's X server?)")
    fppd.command("Overlay Model Fill", "Under", "Enabled", "#FF0000")
    time.sleep(2)
    fppd.write("config/pipewire-video-input-sources-gen.json",
               [source("videotestsrc", pattern="ball", framerate=30)])
    send("reloadVideoInputs", timeout=5)
    aside = f"KMSFrameBuffer {CONNECTOR}: media is playing here, standing aside"
    back = f"KMSFrameBuffer {CONNECTOR}: media finished, showing output again"
    fppd.wait_for(lambda: aside in fppd.log(), timeout=20, what="the FB model to stand aside for the camera")
    fppd.wait_for(lambda: [1 for w, _, _, _ in failplane_calls(log) if w == "c"], timeout=30,
                  what="the dead kmssink's teardown to be held up")
    held = next(t for w, _, t, _ in failplane_calls(log) if w == "c")
    # Its lease goes back 2.6 s on; then give the FB model time to react.
    fppd.wait_for(lambda: time.monotonic() > held + 2.6 + 3, timeout=10, what="the old lease to go")
    out = fppd.log()
    # The controls: the restart really did come while the old lease was
    # held, and took the card's shared fd.
    assert "still held by a teardown after 2 s" in out, fppd.tail()
    assert "(card's shared fd)" in out, fppd.tail()
    running = [t for w, _, t, rc in failplane_calls(log) if w == "k" and rc >= 0 and t > held + 2.6]
    assert running, f"the restarted camera did not draw after the old lease went\n{fppd.tail()}"
    assert back not in out, \
        f"the FB model came back over the restarted camera\n{fppd.tail()}"


def test_a_framebuffer_output_keeps_flipping_beside_a_camera_on_the_same_card(fppd, audio):
    """A camera group showing on HDMI-A-2 while an FB model draws on
    HDMI-A-1 of the same card: both run at once, the camera's plane
    updates going through and the FB model page-flipping all the while.

    Regression: 0d6a6d5db. DRM master is exclusive per card, and the
    camera's kmssink opened a second fd that held master for as long as it
    ran, while the framebuffer output took master and dropped it around
    every flip on its own fd: from the camera's start every one of its
    master requests failed and its picture froze (or, the other way round,
    the camera started without master and showed nothing). Now the card has
    one master fd and the camera a DRM lease of its own connector.

    failplane.so logs the camera's plane updates and page flips and the FB
    model's flips (none of them failed here). The FB model's connector may
    be empty: it runs a stand-in mode.
    """
    import shims
    from test_video import hdmi_consumer, setup as video_setup, source
    card, connector_id = forced_connector()
    other = glob.glob(f"/sys/class/drm/{os.path.basename(card)}-HDMI-A-1/status")
    if not other:
        pytest.skip(f"no HDMI-A-1 on {card}")
    video_setup(fppd, [hdmi_consumer(1, connector_id=connector_id, card=card, group=3)],
                [source("videotestsrc", pattern="ball", framerate=30)])
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [
        {"Name": "Beside", "Type": "FB", "Width": 64, "Height": 32, "Device": "HDMI-A-1"}]})
    fppd.settings(LogLevel_ChannelOut="info", LogLevel_MediaOut="debug")
    planes = os.path.join(fppd.media, "tmp", "failplane.log")
    fppd.start(preload=[shims.build("failplane.c")],
               extra_env={"FAILPLANE_LOG": planes, "FAILPLANE_SKIP": "1000000"})

    def draw(seconds):
        end = time.monotonic() + seconds
        n = 0
        while time.monotonic() < end:
            fppd.command("Overlay Model Fill", "Beside", "Enabled", ("#FF0000", "#0000FF")[n % 2])
            n += 1
            time.sleep(0.03)

    fppd.wait_for(lambda: [1 for w, _, _, rc in failplane_calls(planes) if w == "k" and rc >= 0],
                  timeout=20, what="the camera's first frame on its plane")
    draw(1)
    t0 = time.monotonic()
    draw(4)
    calls = [(w, t) for w, _, t, rc in failplane_calls(planes) if rc >= 0 and t > t0]
    shown = [t for w, t in calls if w in "kK"]
    flipped = [t for w, t in calls if w == "F"]
    assert len(shown) >= 30, f"the camera put {len(shown)} frames on its plane in 4 s\n{fppd.tail()}"
    assert len(flipped) >= 30, f"the FB model flipped {len(flipped)} times in 4 s beside the camera\n{fppd.tail()}"
