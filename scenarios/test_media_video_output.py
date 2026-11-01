"""Which video output a video is played to: a connector with a display on it
(HDMI, DSI or Composite) is the display path, through kmssink; any other
name is a pixel overlay model, and so is an HDMI connector with nothing
plugged in.

The display is the fake card of fakedrm.c (an HDMI-A-1 with a display on
it) and the stand-in kmssink of fakekms.c. mediaoutput.cpp says which path
a video took when a playlist's media entry builds its media output
(LogLevel_MediaOut=debug)."""

import os
import time

import pytest

import fakedrm
from show import playlist, status
from test_video import kms_events, make_video

PATH_LINE = "Using GStreamer for video+"


def add_connector(fppd, name, state):
    """A /sys/class/drm entry for a connector the fake card doesn't drive, so
    fppd's checks of a connector's status see it."""
    d = os.path.join(fppd.media, "tmp", "fakedrm", "sys", "class", "drm", f"card0-{name}")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "status"), "w") as f:
        f.write(state + "\n")


def play(fppd, audio, out, setup=None):
    """Play a short video to `out` on the fake card, after setup(), and the
    lines mediaoutput.cpp logged about the path it took."""
    make_video(os.path.join(fppd.media, "videos", "Bars.mkv"), seconds=3)
    fppd.settings(DisableFakeNetworkBridges="1", LogLevel_MediaOut="debug")
    preload, env = fakedrm.start_env(fppd)
    if setup:
        setup()
    fppd.start(preload=preload, extra_env=env)
    fppd.write("playlists/Bars.json", playlist("Bars", [
        {"type": "media", "enabled": 1, "playOnce": 0, "mediaName": "Bars.mkv", "videoOut": out}]))
    fppd.command("Start Playlist", "Bars", "false", "false")
    fppd.wait_for(lambda: PATH_LINE in fppd.log(), timeout=15, what="the video's output to be chosen")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=30, interval=0.2,
                  what="the video to end")
    return [l for l in fppd.log().splitlines() if PATH_LINE in l]


def test_a_video_to_a_connected_composite_output_takes_the_display_path(fppd, audio):
    """A video played to Composite-1, a connector with a display on it, goes
    to the display (kmssink) as HDMI-A-1 does, not to a pixel overlay model
    that doesn't exist.

    Regression: 94a028f09. Only HDMI- and DSI- connectors were taken for
    displays: a Composite-# output (the Pi's TV-out) was looked for among the
    overlay models, and the video never reached the display."""
    lines = play(fppd, audio, "Composite-1", lambda: add_connector(fppd, "Composite-1", "connected"))
    assert any("video+HDMI playback" in l and "output=Composite-1" in l for l in lines), lines
    assert not any("video+overlay" in l for l in lines), lines


def test_a_video_to_an_hdmi_output_with_nothing_connected_is_not_sent_to_the_display(fppd, audio):
    """A video played to HDMI-A-1 when the connector says "disconnected" is
    treated as a pixel overlay output, not a display: nothing reaches the
    stand-in kmssink. The same video to the same connector with a display
    on it (the control) puts its frames on the display.

    Regression: 248a0f037. Every HDMI- name was an HDMI output whether or not
    anything was plugged in, so a video aimed at an empty port went to a
    kmssink with no display to open."""
    def unplug():
        with open(os.path.join(fppd.media, "tmp", "fakedrm", "sys", "class", "drm",
                               "card0-HDMI-A-1", "status"), "w") as f:
            f.write("disconnected\n")

    lines = play(fppd, audio, fakedrm.CONNECTOR, unplug)
    assert any("video+overlay" in l for l in lines), lines
    assert not any("video+HDMI" in l for l in lines), lines
    assert not [e for e in kms_events(fppd) if e[0] == "frame"], "frames reached the display"


def test_a_video_to_a_connected_hdmi_output_takes_the_display_path(fppd, audio):
    """The control for the two above: HDMI-A-1 with a display on it takes the
    display path and its frames reach the (stand-in) kmssink."""
    lines = play(fppd, audio, fakedrm.CONNECTOR)
    assert any("video+HDMI playback" in l and f"output={fakedrm.CONNECTOR}" in l for l in lines), lines
    assert [e for e in kms_events(fppd) if e[0] == "frame"], "no frame reached the display"
