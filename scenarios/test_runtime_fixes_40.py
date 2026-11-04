"""Fixes from the 4.x and 5.0 releases that are still reachable in fppd."""

import os
import time

import pytest

from ddp import DdpReceiver
from fseq import unique_frames, write_fseq
from show import CHANNELS, ddp_output, install

from test_playlist_commands import wait_idle
from test_playlist_entries import pause, playlist, status, step, trace


def test_a_random_playlist_started_at_an_item_is_not_shuffled(fppd):
    """Start Playlist At Item on a randomised playlist plays the item asked
    for first, every time (the rest follow in a fresh shuffle).

    Regression: 93578ac57. The playlist was shuffled on load even when a start
    position was given, so the item asked for was whatever the shuffle left
    at that row. Twenty starts: a plain shuffle leaves step 3 at item 4 one
    time in four."""
    fppd.write("playlists/R.json", playlist("R", main=[step(1), step(2), step(3), step(4)], random=1))
    fppd.start()
    for _ in range(20):
        fppd.command("Set Variable", "trace", "Value", "0")
        fppd.command("Start Playlist At Item", "R", "4", "false", "false")
        wait_idle(fppd)
        got = trace(fppd)
        assert got.startswith("3") and sorted(got) == ["1", "2", "3", "4"], got


def test_a_playlist_entry_note_is_kept_and_reported(fppd):
    """A note on any playlist entry stays in the playlist and is part of the
    entry's reported config.

    Regression: 3ef65f983. Only some entry types carried their Note."""
    e = pause(30)
    e["note"] = "keep me"
    fppd.write("playlists/N.json", playlist("N", main=[e]))
    fppd.start()
    fppd.command("Start Playlist", "N", "false", "false")
    cur = fppd.wait_for(lambda: (lambda c: c if c.get("type") == "pause" else None)(
        fppd.get("/player/current")["playlist"].get("currentEntry", {})), what="the pause entry")
    assert cur.get("note") == "keep me", cur
    fppd.command("Stop Now")


def test_fppd_uptime_grows(fppd):
    """The status reports seconds since fppd started, and the number
    increases.

    Feature: d910a50ab (#945)."""
    fppd.start()
    a = fppd.get("/fppd/status", timeout=5)
    time.sleep(2.2)
    b = fppd.get("/fppd/status", timeout=5)
    assert b["uptimeTotalSeconds"] >= a["uptimeTotalSeconds"] + 2, (a, b)



def test_threaded_udp_output_delivers_every_target_every_frame(fppd):
    """A UDP output set to multi-threaded sending, with two targets, delivers
    the whole frame to both of them: the receiver sees complete frames made of
    the two halves.

    Feature: 2e6475431 (the per-address send queues)."""
    from ddp import DdpReceiver
    from fseq import unique_frames
    from show import install
    frames = unique_frames(40, 120)
    install(fppd, frames)
    out = {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 120, "threaded": 1,
        "universes": [
            {"active": 1, "description": "a", "id": 64001, "startChannel": 1, "channelCount": 60,
             "type": 5, "address": "127.0.0.1", "priority": 0, "monitor": 0, "deDuplicate": 0},
            {"active": 1, "description": "b", "id": 64002, "startChannel": 61, "channelCount": 60,
             "type": 5, "address": "127.0.0.2", "priority": 0, "monitor": 0, "deDuplicate": 0}]}]}
    fppd.write("config/co-universes.json", out)
    first = {f[:60]: i for i, f in enumerate(frames)}
    second = {f[60:]: i for i, f in enumerate(frames)}
    with DdpReceiver(120) as rx:
        fppd.start()
        fppd.command("Start Playlist", "Show", "false", "false")
        wait_idle(fppd, timeout=20)
        snap = rx.snapshot()
    # each target's half is a frame of its own to the receiver (both push)
    a = {first[f[:60]] for _, f in snap if f[:60] in first and not any(f[60:])}
    # (type 5 counts from the target's own first channel, so the second half arrives at 0)
    b = {second[f[:60]] for _, f in snap if f[:60] in second and f[:60] not in first and not any(f[60:])}
    assert len(a) >= 30 and len(b) >= 30, f"halves received: {len(a)} and {len(b)} of 40"


def test_url_command_with_an_empty_post_body_sends_a_post(fppd):
    """The URL command with method POST and no data sends a real POST with an
    empty body ("Content-Length: 0"), and finishes promptly.

    Feature: 97f6a9ad5. urlHelper always sets the POST fields. Green-only:
    with that block disabled curl still sends Content-Length: 0 for the
    method, so this does not tell the fix apart."""
    import http.server
    import threading
    seen = []

    class H(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            seen.append(("POST", self.headers.get("Content-Length")))
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")

        def do_GET(self):
            seen.append(("GET", None))
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        fppd.start()
        t0 = time.monotonic()
        fppd.command("URL", f"http://127.0.0.1:{srv.server_port}/hook", "POST", "", timeout=20)
        took = time.monotonic() - t0
    finally:
        srv.shutdown()
    assert seen and seen[0][0] == "POST", seen
    assert seen[0][1] == "0", seen
    assert took < 10, took


def _frame_period_ms(received):
    """The period frames went out at: the median gap between consecutive
    frames the receiver identified (a unique_frames() index), per frame
    index. A median is not moved by the odd frame a loaded sanitizer build
    sends late, nor by the output thread restarting its cadence after one."""
    first = {}
    for t, data in received:
        n = (data[0] << 16) | (data[1] << 8) | data[2]
        if n:
            first.setdefault(n - 1, t)
    xs = sorted(first)
    assert len(xs) > 100, f"only {len(xs)} identifiable frames arrived"
    gaps = sorted((first[b] - first[a]) * 1000.0 / (b - a) for a, b in zip(xs, xs[1:]))
    return gaps[len(gaps) // 2], len(xs)


def test_a_17ms_sequence_goes_out_every_17ms(fppd):
    """A sequence whose step time does not divide 1000 (17 ms, 58.8 fps)
    goes out at its own frame time.

    Coverage for f3deb9823, not a regression test: the refresh rate was an
    int, 1000 / 17 = 58, and the output thread's frame period came from it
    (1000000 / 58 = 17241 us), so the lights fell 1.4% behind the audio.
    On master the output thread's cadence holds a sequence to its step time
    whatever that rate says: with the fix undone by hand this still passes.
    600 frames of 17 ms; their median gap tells 17.24 ms from 17.00."""
    frames = unique_frames(600, CHANNELS)
    with DdpReceiver(CHANNELS) as rx:
        install(fppd, frames, step_ms=17)
        fppd.start()
        fppd.command("Start Playlist", "Show", "false", "false")
        wait_idle(fppd, timeout=30)
        period, n = _frame_period_ms(rx.snapshot())
    assert abs(period - 17.0) < 0.08, f"frames went out every {period:.3f} ms ({n} frames), not 17"


@pytest.mark.xfail(strict=True, reason="src/effects.cpp truncates 1000 / frameTime to an int")
def test_a_17ms_fseq_effect_goes_out_every_17ms(fppd):
    """The same for an FSEQ run as an effect with no sequence playing: its
    frames go out at its own 17 ms step time.

    Open bug: StartEffect() (src/effects.cpp) still sets the refresh rate as
    1000 / frameTime in ints, the truncation f3deb9823 fixed for sequences.
    Master puts this effect out every 17.23 ms; with 1000.0f / frameTime it
    is 17.0. Strict, so this turns red when that is fixed: drop the xfail
    then."""
    frames = unique_frames(400, CHANNELS)
    write_fseq(os.path.join(fppd.media, "sequences", "Fx.fseq"), frames, step_ms=17)
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fppd.command("FSEQ Effect Start", "Fx", "false", "false")
        fppd.wait_for(lambda: not fppd.get("/fppd/effects").get("runningEffects"), timeout=30,
                      interval=0.25, what="the effect to finish")
        period, n = _frame_period_ms(rx.snapshot())
    assert abs(period - 17.0) < 0.08, f"effect frames went out every {period:.3f} ms ({n} frames), not 17"
