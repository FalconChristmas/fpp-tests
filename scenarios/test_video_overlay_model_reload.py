"""A video playing to a pixel overlay model when an output reload replaces the
model: the playing video has to follow it to the new one.
"""

import os


from test_overlays import colorlight_panel, resave_outputs
from test_video import make_video


def showing(fppd):
    """Whether the Panel model is on and has anything but black in it."""
    m = [x for x in fppd.get("/overlays/models") if x.get("Name") == "Panel"]
    if not m or not m[0].get("isActive"):
        return False
    return any(fppd.get("/overlays/model/Panel/data").get("data", []))


def test_a_playing_video_follows_its_model_through_an_output_reload(fppd, audio):
    """A video plays to an output's own model. Saving the outputs removes that
    model and creates it again, off and black, with the video still playing:
    the video lights up the new one without being restarted, and goes on using
    it, rather than the one that has gone.

    Regression: a5b69be94. The reload stops the channel output thread, and the main
    loop's restart check didn't count a video, while the new model isn't
    active until a frame reaches it, so nothing started the thread again and
    the model stayed dark while the video played on. And IsOverlayingVideo()
    read the model pointer without the lock the reload's listener writes it
    under, a data race TSan reported on every reload mid-video.
    """
    make_video(os.path.join(fppd.media, "videos", "Bars.mkv"), seconds=40, width=64, height=32)
    fppd.write("config/channeloutputs.json", colorlight_panel())
    fppd.settings(DisableFakeNetworkBridges="1", VideoOutput="Panel", LogLevel_MediaOut="info")
    fppd.start()
    fppd.command("Play Media", "Bars.mkv", "1", "0", "1", "--Default--")
    fppd.wait_for(lambda: showing(fppd), timeout=20, interval=0.2, what="the video on the model")

    log_marker = "GStreamer started playing"
    assert fppd.log().count(log_marker) == 1
    resave_outputs(fppd)
    fppd.wait_for(lambda: showing(fppd), timeout=15, interval=0.2,
                  what="the video on the model created by the reload")
    assert fppd.log().count(log_marker) == 1, "the video was restarted to get there"
