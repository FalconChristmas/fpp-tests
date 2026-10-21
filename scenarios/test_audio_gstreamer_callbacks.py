"""GStreamer calls back into a GStreamerOutput from its own streaming
threads (decodebin's pad-added here) on a pipeline that can outlive the
output. Each callback reaches the output through a lifetime guard that
Close() clears, waiting for a callback in flight; a shim holds the
callback partway while the output is stopped and deleted, then lets it run
on. Under ASan a callback that reaches the freed output is a
heap-use-after-free report."""

import os
import time

from audio import write_tone_wav


def test_a_pad_added_after_the_output_is_gone_does_nothing(fppd, audio):
    """Play Media, with decodebin's pad-added callback held on its
    streaming thread (aud_slowpad.c holds the caps query it starts with)
    while Stop All Media stops the output and it is deleted: the late
    callback must not reach the freed output. With the fix the stop waits
    for the callback in flight, which then finishes on a live output.

    Regression: 6d30a583d. pad-added was connected with a bare `this`.
    Start() hands the pipeline to a detached set_state(PLAYING) thread, so
    decodebin could expose its pads after Close() and the delete, and
    OnPadAdded() worked on the freed output (field crashes in
    gst_element_get_static_pad() on a dangling audio chain)."""
    import threading
    import shims
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 10)
    mark = os.path.join(fppd.media, "tmp", "held")
    release = os.path.join(fppd.media, "tmp", "release")
    fppd.start(preload=[shims.build("aud_slowpad.c")],
               extra_env={"SLOWPAD_MARK": mark, "SLOWPAD_RELEASE": release})
    try:
        fppd.command("Play Media", "Tone.wav", "1", "0", "2", timeout=30)
        fppd.wait_for(lambda: os.path.exists(mark), timeout=20,
                      what="decodebin's pad-added callback")
        stop = threading.Thread(target=lambda: fppd.command("Stop All Media", timeout=60))
        stop.start()
        # Without the fix the stop doesn't wait for the callback: it returns
        # and the output is deleted a moment later. With it, the stop waits.
        stop.join(15)
        time.sleep(1.5)
    finally:
        open(release, "w").close()
    stop.join(30)
    time.sleep(1)
    fppd.get("/fppd/status", timeout=10)

