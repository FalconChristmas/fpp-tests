"""A video playing to a pixel overlay model when an output reload replaces the
model: the playing video has to follow it to the new one.
"""

import os

import pytest

from fppd import sanitizer
from test_overlays import colorlight_panel, resave_outputs
from test_video import make_video


def showing(fppd):
    """Whether the Panel model is on and has anything but black in it."""
    m = [x for x in fppd.get("/overlays/models") if x.get("Name") == "Panel"]
    if not m or not m[0].get("isActive"):
        return False
    return any(fppd.get("/overlays/model/Panel/data").get("data", []))


# GStreamerOutput's model listener writes m_videoOverlayModel holding
# m_videoOverlayModelLock, and IsOverlayingVideo() reads it holding only
# m_overlayOutputsLock: a data race TSan reports whenever this reload happens
# mid-video. Run this under TSan again once they share a lock.
@pytest.mark.skipif(sanitizer() == "tsan", reason="m_videoOverlayModel is read without its lock; see above")
def test_a_playing_video_follows_its_model_through_an_output_reload(fppd, audio):
    """A video plays to an output's own model. Saving the outputs removes that
    model and creates it again, off and black, with the video still playing:
    the video lights up the new one without being restarted, and goes on using
    it, rather than the one that has gone.

    alwaysTransmit keeps the channel output thread coming back after the
    reload stops it. Without it nothing restarts the thread, since the main
    loop's check doesn't count a video and the new model isn't active until a
    frame reaches it, so the model stays dark while the video plays on.
    """
    make_video(os.path.join(fppd.media, "videos", "Bars.mkv"), seconds=40, width=64, height=32)
    fppd.write("config/channeloutputs.json", colorlight_panel())
    fppd.settings(DisableFakeNetworkBridges="1", VideoOutput="Panel", LogLevel_MediaOut="info", alwaysTransmit="1")
    fppd.start()
    fppd.command("Play Media", "Bars.mkv", "1", "0", "1", "--Default--")
    fppd.wait_for(lambda: showing(fppd), timeout=20, interval=0.2, what="the video on the model")

    log_marker = "GStreamer started playing"
    assert fppd.log().count(log_marker) == 1
    resave_outputs(fppd)
    fppd.wait_for(lambda: showing(fppd), timeout=15, interval=0.2,
                  what="the video on the model created by the reload")
    assert fppd.log().count(log_marker) == 1, "the video was restarted to get there"
