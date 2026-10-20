"""Pixel overlay models: where their buffers come from when shared memory
can't be had, and their child lists under concurrent submodel changes."""

import http.client
import threading
import time
import urllib.parse

import shims
from ddp import DdpReceiver
from fppd import API
from show import ddp_output

WIDTH, HEIGHT = 10, 5
CHANNELS = WIDTH * HEIGHT * 3


def matrix(name, width, height, start=1):
    return {"Name": name, "Type": "Channel", "StartChannel": start,
            "ChannelCount": width * height * 3, "ChannelCountPerNode": 3,
            "Orientation": "horizontal", "StartCorner": "TL",
            "StringCount": height, "StrandsPerString": 1}


def submodel(name, parent, x, y, w, h):
    return {"Name": name, "Type": "Sub", "Parent": parent,
            "XOffset": x, "YOffset": y, "Width": w, "Height": h,
            "StartChannel": 1, "ChannelCount": w * h * 3, "ChannelCountPerNode": 3,
            "Orientation": "horizontal", "StartCorner": "TL",
            "StringCount": h, "StrandsPerString": 1}


def setup(fppd, models, channels):
    fppd.write("config/co-universes.json", ddp_output(channels))
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": models})
    fppd.settings(DisableFakeNetworkBridges="1")


def put(fppd, path, body):
    return fppd.request("PUT", "/overlays/" + path, body)


def test_a_model_without_shared_memory_starts_dark_and_works(fppd):
    """With shared memory refused for every model buffer, a model still
    gets working, zeroed memory: enabled, it puts black on the wire, not
    whatever the heap held; filled, it shows its colour; its overlay buffer
    can still be mapped for the bulk pixel calls.

    Regression: 3993d2ba4. The fallback to an anonymous mapping passed
    MAP_ANON without MAP_PRIVATE, which mmap() always refuses, so every
    shm_open() failure landed on a malloc() that was never cleared: the
    model's channels started out as heap garbage (an ASan build's 0xbe
    fill here) and went on the wire as soon as the model was enabled.
    """
    setup(fppd, [matrix("M", WIDTH, HEIGHT)], CHANNELS)
    with DdpReceiver(CHANNELS) as rx:
        fppd.start(preload=[shims.build("failshm.c")],
                   extra_env={"FAILSHM_PREFIX": "/FPP"})
        assert "Could not create shared memory" in fppd.log(), \
            "shm_open() was not refused: the shim did not engage"
        put(fppd, "model/M/state", {"State": 1})
        since = time.monotonic()
        assert rx.wait_frames(10, timeout=10, since=since), "no frames with the model enabled"
        frames = [d for t, d in rx.snapshot(since=since)]
        dirty = [d for d in frames if any(d)]
        assert not dirty, f"an untouched model put {dirty[0][:12].hex()}... on the wire"
        put(fppd, "model/M/fill", {"RGB": [10, 20, 30]})
        fppd.wait_for(lambda: rx.last() == bytes([10, 20, 30]) * (WIDTH * HEIGHT),
                      timeout=10, interval=0.05, what="the fill on the wire")
        put(fppd, "model/M/mmap", {})
        put(fppd, "model/M/state", {"State": 0})


def test_submodels_toggled_from_many_threads_while_output_runs(fppd):
    """Four submodels, the quarters of a 120x120 parent, switched on and off
    as fast as four clients can ask, for 15 s, while the output draws the
    parent every frame: fppd stays up and answers, and afterwards a fill of
    the parent still reaches the wire. (The quarters are big so that the
    output thread spends a good part of each frame walking them.)

    Regression: bdfbc7444. The parent's list of enabled children was a
    plain std::list that setChildState() erased from on the HTTP threads
    while the output thread walked it in flushChildren(), under different
    locks: the walk stood on a freed node (an ASan heap-use-after-free) and
    scattered writes through channelMap with its garbage rectangle.
    """
    side, sub = 120, 60
    channels = side * side * 3
    corners = [(0, 0), (sub, 0), (0, sub), (sub, sub)]
    models = [matrix("P", side, side)] + [
        submodel(f"S{i}", "P", x, y, sub, sub) for i, (x, y) in enumerate(corners)]
    setup(fppd, models, channels)
    stop = threading.Event()
    host, port = urllib.parse.urlsplit(API).netloc.split(":")
    errors = []

    def toggle(name):
        conn = None
        state = 1
        while not stop.is_set():
            try:
                if conn is None:
                    conn = http.client.HTTPConnection(host, int(port), timeout=10)
                conn.request("PUT", f"/overlays/model/{name}/state",
                             body='{"State": %d}' % state,
                             headers={"Content-Type": "application/json"})
                conn.getresponse().read()
                state = 2 if state == 0 else 0  # Transparent / Disabled
            except Exception as e:
                errors.append(repr(e))
                conn = None
                time.sleep(0.01)

    with DdpReceiver(channels) as rx:
        fppd.start()
        for i in range(len(corners)):
            put(fppd, f"model/S{i}/fill", {"RGB": [0, 0, 40 + i]})
        # The parent stays disabled: it is drawn because it has children,
        # through flushChildren(), on every frame the output thread runs.
        fppd.command("Test Start", 25, "RGB Single Color", f"1-{channels}", "#010101")
        threads = [threading.Thread(target=toggle, args=(f"S{i}",), daemon=True)
                   for i in range(len(corners))]
        for t in threads:
            t.start()
        try:
            end = time.monotonic() + 15
            while time.monotonic() < end:
                fppd.check_alive()
                time.sleep(0.5)
        finally:
            stop.set()
            for t in threads:
                t.join(15)
        fppd.check_alive()
        assert len(errors) < 20, f"{len(errors)} failed requests: {errors[:3]}"
        fppd.command("Test Stop")
        for i in range(len(corners)):
            put(fppd, f"model/S{i}/state", {"State": 0})
        put(fppd, "model/P/state", {"State": 1})
        put(fppd, "model/P/fill", {"RGB": [9, 8, 7]})
        fppd.wait_for(lambda: rx.last() == bytes([9, 8, 7]) * (side * side),
                      timeout=10, interval=0.05, what="the parent's fill on the wire")
