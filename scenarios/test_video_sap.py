"""The SAP announcer for a video group's RTP members, started and stopped
from two threads at once."""

import os
import socket
import threading
import time

import shims
from test_video import free_udp_port, make_video, rtp_consumer, setup


def test_sap_announcer_survives_start_and_stop_from_two_threads(fppd, audio):
    """A video group with an RTP member on the playback slot, a video
    played to it again and again, and the video outputs reloaded
    continuously alongside: the announcer is started from each video's
    start thread and stopped and started by every reload on the main
    loop, and fppd survives it all.

    vid_sapdelay.c holds each StartSAPAnnouncer() 300 ms between setting
    its running flag and assigning its std::thread, so a reload's Stop
    lands in that window on nearly every pass instead of once in a long
    while.

    Regression: 3ea7a37eb. Start tested the flag and assigned the thread as
    two unserialized steps, and Stop returned early on a cleared flag: a
    Stop inside the window left the thread joinable, and the next Start
    assigned over it -- std::terminate(), fppd gone with SIGABRT
    ("terminate called without an active exception")."""
    from test_command_socket import send
    make_video(os.path.join(fppd.media, "videos", "Short.mkv"), seconds=2)
    consumer = rtp_consumer(free_udp_port(), "mjpeg", source="")
    del consumer["sourceNode"]
    setup(fppd, [consumer])
    fppd.start(preload=[shims.build("vid_sapdelay.c")])

    done = threading.Event()
    errors = []

    def reload_loop():
        while not done.is_set():
            try:
                send("reloadVideoOutputs", timeout=15)
            except (socket.timeout, OSError) as e:
                errors.append(repr(e))
                return
            time.sleep(0.05)
    t = threading.Thread(target=reload_loop)
    t.start()
    try:
        for _ in range(12):
            fppd.command("Play Media", "Short.mkv", "1", "0", "1", "HDMI-A-1")
            time.sleep(1.0)
            fppd.check_alive()
    finally:
        done.set()
        t.join(30)
    assert not errors, f"a reload got no answer: {errors}"
    assert "SAP announcer thread started" in fppd.log(), \
        "the announcer never started, so this proves nothing"
    fppd.get("/fppd/status", timeout=10)
