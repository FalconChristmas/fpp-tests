"""The HTTP API under concurrent load while a show plays: every request has
to be answered and the lights have to keep their cadence. Lock-order
deadlocks between an HTTP handler and the output thread or main loop only
show when the two meet, so this makes them meet a lot."""

import random
import threading
import time
import urllib.error

from ddp import DdpReceiver
from fseq import unique_frames, write_fseq
from show import ddp_output, playlist, sequence_entry
from test_overlays import matrix, submodel

CHANNELS = 150
STEP_MS = 10  # 100 fps: FPP's busiest cadence


def install(fppd, seconds=40):
    write_fseq(f"{fppd.media}/sequences/Load.fseq", unique_frames(seconds * 100, CHANNELS),
               step_ms=STEP_MS)
    fppd.write("playlists/Load.json", playlist("Load", [sequence_entry("Load.fseq")], repeat=1))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [
        matrix("M"), submodel("S", "M", 0, 0, 4, 2)]})
    fppd.settings(DisableFakeNetworkBridges="1")


def hammer(fppd, seconds, clients=6):
    """Random API traffic from `clients` threads; returns the first wedge."""
    stop_at = time.monotonic() + seconds
    wedged = []

    def put(path, body):
        return fppd.request("PUT", path, body, timeout=10)

    calls = [
        lambda r: fppd.get("/fppd/status", timeout=10),
        lambda r: fppd.get("/overlays/models", timeout=10),
        lambda r: fppd.get("/overlays/running", timeout=10),
        lambda r: fppd.get("/overlays/model/M", timeout=10),
        lambda r: fppd.get("/models", timeout=10),
        lambda r: fppd.get("/fppd/schedule", timeout=10),
        lambda r: put(f"/overlays/model/{r.choice('MS')}/state", {"State": r.randint(0, 3)}),
        lambda r: put(f"/overlays/model/{r.choice('MS')}/fill", {"RGB": [r.randint(0, 255), 0, 9]}),
        lambda r: fppd.command("Overlay Model Effect", "M", "Enabled", "Color Fade", "#FF0000",
                               "#0000FF", "1000", timeout=10),
        lambda r: fppd.command("Overlay Model Effect", "M", "Enabled", "Stop Effects", timeout=10),
        lambda r: put(f"/overlays/range/{r.randint(1, 100)}-{r.randint(100, 150)}",
                      {"Value": r.randint(0, 255)}),
        lambda r: put("/overlays/range/1-1", {"deleteAll": True}),
        lambda r: fppd.command("Volume Set", str(r.randint(0, 100)), timeout=10),
        lambda r: fppd.command("Set Variable", "V", "Value", str(r.random()), "1", "0", "100", "",
                               timeout=10),
    ]

    def client(seed):
        rnd = random.Random(seed)
        while time.monotonic() < stop_at and not wedged:
            call = rnd.choice(calls)
            try:
                call(rnd)
            except TimeoutError as e:
                wedged.append(str(e))
                return
            except (urllib.error.HTTPError, ValueError):
                pass  # a refused request is an answer
            time.sleep(rnd.random() * 0.02)

    threads = [threading.Thread(target=client, args=(s,)) for s in range(clients)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return wedged


def test_api_load_while_a_show_plays(fppd):
    """Six clients firing status, overlay, effect, range, volume and
    variable requests for 30 s at a 100 fps show: every request is
    answered, and the show never stops for a second.

    A general guard, not tied to one fix: the lock-order deadlocks found
    in the REST audits needed an HTTP handler and the output thread or main
    loop to meet, and random load is how they meet in the field. It does not
    reliably catch any one old bug (37c8f92a8's inversion needs a submodel's
    first parent lookup to coincide, and passed on its parent). Its control:
    a build with one overlay route made to stall 15 s fails it, every client
    wedged, because the stalls fill drogon's thread pool.
    """
    install(fppd)
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fppd.command("Start Playlist", "Load", "true", "false")
        fppd.wait_for(lambda: rx.count() > 10, timeout=10, what="the show to start")
        since = time.monotonic()
        wedged = hammer(fppd, 30)
        times = [t for t, _ in rx.snapshot(since=since)]
    assert not wedged, wedged[0]
    gaps = [b - a for a, b in zip(times, times[1:])]
    assert gaps and max(gaps) < 1.0, \
        f"the show stopped for {max(gaps):.2f} s under load" if gaps else "no frames under load"
