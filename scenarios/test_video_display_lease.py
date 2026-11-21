"""The video display's DRM lease while a track's pipeline may still use it.

A decoder can take its frames from the display's pool (kmssink answers its
allocation query), and those frames are dumb buffers on the display's lease.
So the lease must stay open for as long as any pipeline that may hold them
lives -- a wedged one included -- and be given back once none does, or the
last frame stays on screen and a Virtual Matrix on the port never returns.

Runs anywhere, Docker included: the display is the fake card of fakedrm.c
and the kmssink fakekms.c (test_video_display).
"""

import os
import time

import fakedrm
import shims
from test_video import make_video
from test_video_display import CONNECTOR, display_events


def stops(fppd):
    return sum(1 for e, *_ in display_events(fppd) if e == "stop")


def play_with_wedged_teardown(fppd, wedge_ms):
    """Play Media of a 2 s video to the display, whose pipeline's NULL
    transition is held `wedge_ms` (slowstate.c), past fppd's 10 s deadline
    (the display's own, later, is not): returns once the teardown has been
    abandoned."""
    make_video(os.path.join(fppd.media, "videos", "Clip.mkv"), seconds=2)
    fppd.settings(DisableFakeNetworkBridges="1", LogLevel_MediaOut="debug",
                  GStreamerWedgeRebootLimit="0")
    preload, env = fakedrm.start_env(fppd)
    env.update(SLOWSTATE_STATE="1", SLOWSTATE_THREAD="FPP-GstReaper", SLOWSTATE_MS=str(wedge_ms),
               SLOWSTATE_ONCE="1")
    fppd.start(preload=preload + [shims.build("slowstate.c")], extra_env=env)
    fppd.command("Play Media", "Clip.mkv", "1", "0", "1", CONNECTOR)
    fppd.wait_for(lambda: any(e == "frame" for e, *_ in display_events(fppd)), timeout=15,
                  what="the video on the display")
    fppd.wait_for(lambda: "teardown wedged" in fppd.log(), timeout=40, interval=0.5,
                  what="the video's teardown to be abandoned")


def test_a_wedged_pipeline_that_stops_after_all_gives_the_display_back(fppd, audio):
    """A video whose teardown wedges past fppd's deadline but does finish
    two seconds later: once it has, the display closes, as after any video.

    Regression: 6695588df. The abandoned track kept its use of the display
    (5fbef578d) until the restart that several wedges lead to, so after one
    wedge the display never closed: the last frame stayed up for good."""
    play_with_wedged_teardown(fppd, 12000)
    fppd.wait_for(lambda: "abandoned pipeline teardown eventually completed" in fppd.log(), timeout=10,
                  interval=0.2, what="the wedged teardown to finish")
    fppd.wait_for(lambda: stops(fppd) >= 1, timeout=5, interval=0.2,
                  what="the display to close once the wedged pipeline let go")


def play_from_the_display_s_pool(fppd, seconds=4, **kms):
    """Play Media of a `seconds` long 10 fps video to the display, whose sink
    answers the decoder's allocation query with a pool of dumb buffers on
    its lease (FAKEKMS_POOL, as the real kmssink does), until the display
    has closed and given its lease back. `kms`: more of fakekms.c's
    settings."""
    make_video(os.path.join(fppd.media, "videos", "Clip.mkv"), seconds=seconds)
    fppd.settings(DisableFakeNetworkBridges="1", LogLevel_MediaOut="debug")
    preload, env = fakedrm.start_env(fppd)
    env.update(FAKEKMS_POOL="1", FAKEDRM_LOG_DUMBS="1", **kms)
    fppd.start(preload=preload, extra_env=env)
    fppd.command("Play Media", "Clip.mkv", "1", "0", "1", CONNECTOR)
    fppd.wait_for(lambda: "close lease" in fakedrm.log(fppd), timeout=seconds + 20, interval=0.2,
                  what="the display to give its lease back")
    # The pool's lines carry the display's connector too.
    events = display_events(fppd)
    assert any(e == "alloc" for e, *_ in events), \
        "precondition: the video's frames came from the display's pool"
    return events


def lease_lost_buffers(fppd, events):
    closed = [l for l in fakedrm.log(fppd).splitlines()
              if l.startswith("close lease") and not l.endswith(": 0 dumb buffers still on it")]
    lost = sum(1 for e, *_ in events if e == "lostdumb")
    return closed, lost


def test_a_failed_display_keeps_its_lease_until_the_video_lets_go(fppd, audio):
    """A display whose sink fails a second into a video (FAKEKMS_FAIL_AFTER,
    a display that went away) is torn down, but its lease is closed only
    once the video has let go of the frames it took from the display's
    pool: no dumb buffer is still on the lease as it closes, and none is
    destroyed on a closed fd afterwards.

    Regression: 7fe5e379e. The failed display's teardown closed the lease
    while the video still played, under the decoder's buffers from its
    pool; their release then went to a closed fd, or to whichever lease
    took its number."""
    play_from_the_display_s_pool(fppd, FAKEKMS_FAIL_AFTER="10")
    time.sleep(1)
    closed, lost = lease_lost_buffers(fppd, display_events(fppd))
    assert not closed and not lost, \
        f"the lease was closed under the video's frames: {closed}, {lost} buffers released on a closed fd"
