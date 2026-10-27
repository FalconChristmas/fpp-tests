"""fppd's status, built on the HTTP threads, the status websocket's push timer
and the warnings thread, against what it reports on changing underneath it:
media coming and going, warnings added and cleared, and fppd shutting down.

These are races. A lost one under ASan is a use-after-free; the
unsynchronized reads behind them show under TSan (run.sh --flavor tsan) even
when the two sides don't overlap in time, which is what makes the TSan runs
the red checks here.
"""

import json
import os
import socket
import threading
import time
import urllib.error

import pytest

import shims
from audio import write_tone_wav
from multisync import sync_packet
from wsclient import TEXT, WebSocket

MULTISYNC_PORT = 32320


def poll(fppd, stop, errors, path="/fppd/status"):
    try:
        while not stop.is_set():
            fppd.get(path, timeout=10)
    except Exception as e:  # noqa: BLE001 -- reported by the caller
        errors.append(e)


def test_remote_status_polled_across_media_changes(fppd, audio):
    """A remote told by MultiSync to play one file after another, six
    changes, while status is polled from three threads: each poll answers,
    and the remote reports each file as it plays.

    Regression: 215e11b5e. A remote's status read the media file name
    through the global mediaOutput with no lock, while every media change
    deletes that object under mediaOutputLock on the main loop (TSan: data
    race between the status read in GetCurrentFPPDStatus and the delete in
    CloseMediaOutput; a use-after-free when they meet)."""
    for name in ("A.wav", "B.wav"):
        write_tone_wav(os.path.join(fppd.media, "music", name), 10)
    fppd.settings(fppMode="remote")
    fppd.start()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def send(action, name, seconds=0.0):
        sock.sendto(sync_packet(action, "media", 0, seconds, name), ("127.0.0.1", MULTISYNC_PORT))

    stop = threading.Event()
    errors = []
    pollers = [threading.Thread(target=poll, args=(fppd, stop, errors)) for _ in range(3)]
    for t in pollers:
        t.start()
    try:
        for i in range(6):
            name = ("A.wav", "B.wav")[i % 2]
            send("open", name)
            send("start", name)
            fppd.wait_for(lambda: fppd.get("/fppd/status").get("media_filename") == name,
                          timeout=10, interval=0.05, what=f"the remote to report {name}")
            began = time.monotonic()
            while time.monotonic() - began < 1.0:
                send("sync", name, time.monotonic() - began)
                time.sleep(0.25)
            send("stop", name, time.monotonic() - began)
            fppd.wait_for(lambda: fppd.get("/fppd/status").get("media_filename") != name,
                          timeout=10, interval=0.05, what=f"the remote to drop {name}")
    finally:
        stop.set()
        for t in pollers:
            t.join(20)
    assert not errors, errors[0]


def test_a_held_warning_push_does_not_publish_an_older_status(fppd):
    """The push the warnings thread makes for a new warning (an unknown
    command) is held 2.5 s part-way through building its status
    (status_buildhold.so, just after it reads the uptime) while the 1 s
    timer pushes on: a client connected throughout never sees the status go
    back -- the pushed uptime never decreases.

    Regression: 70eabb3a3. Each push built its status outside the lock and
    published it inside, so a build that took longer than a later one was
    published after it, as the newest state: the client got the held
    build's older status (its uptime, and whatever else had changed since --
    a just-cleared warning, a playlist that had moved on)."""
    trigger = os.path.join(fppd.media, "tmp", "buildhold")
    fppd.start(preload=[shims.build("status_buildhold.c")],
               extra_env={"STATUS_BUILDHOLD_FILE": trigger,
                          "STATUS_BUILDHOLD_THREAD": "FPP-Warnings",
                          "STATUS_BUILDHOLD_MS": "2500"})
    ws = WebSocket("/fppdws")
    seen = []
    stop = threading.Event()

    def read():
        while not stop.is_set():
            try:
                op, payload = ws.message(timeout=0.5)
            except socket.timeout:
                continue
            if op == TEXT:
                seen.append(json.loads(payload)["data"]["status"]["systemUptimeTotalSeconds"])

    reader = threading.Thread(target=read)
    reader.start()
    try:
        fppd.wait_for(lambda: len(seen) >= 2, timeout=10, what="the first pushes")
        open(trigger, "w").close()
        with pytest.raises(urllib.error.HTTPError):  # refused, and a warning added
            fppd.command("No Such Command For The Status Push")
        fppd.wait_for(lambda: os.path.exists(trigger + ".held"), timeout=10, interval=0.02,
                      what="the warnings thread's push to be held")
        time.sleep(5)
    finally:
        stop.set()
        reader.join(10)
        ws.close()
    assert len(seen) >= 5, f"too few pushes to judge: {seen}"
    assert seen == sorted(seen), f"the pushed uptime went back: {seen}"

