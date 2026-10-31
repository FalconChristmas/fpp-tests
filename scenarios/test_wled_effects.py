"""Every WLED effect FPP carries (ported from WLED's FX.cpp: some 200 of
them, mostly untested) runs on a model under the sanitizers: started with
its default arguments, given a moment to render, then the next. One fppd
per model shape -- a 2D matrix, a 1D string and a small odd-sized one -- and
fppd must stay up and keep sending.

Regression: 8f99a54c3. Every gradient palette was copied out 72 bytes at a time,
past the end of the shorter ones: Fire 2012, on its default palette Fire,
took fppd down under ASan on every shape."""

import time
import urllib.parse

import pytest

from ddp import DdpReceiver
from test_overlays import effect, matrix, setup, stop_effects

SHAPES = {"matrix 32x16": (32, 16), "string 150": (150, 1), "odd 7x3": (7, 3)}


@pytest.mark.parametrize("shape", list(SHAPES))
def test_every_wled_effect_runs(fppd, shape):
    w, h = SHAPES[shape]
    channels = w * h * 3
    setup(fppd, [matrix("M", width=w, height=h)], channels=channels)
    with DdpReceiver(channels) as rx:
        fppd.start()
        names = [n for n in fppd.get("/overlays/effects") if n.startswith("WLED")]
        assert len(names) > 100, len(names)
        failed = []
        for name in names:
            try:
                effect(fppd, "M", name)
            except Exception as e:  # a refusal is fine; a crash shows below
                failed.append((name, str(e)[:80]))
            time.sleep(0.25)
            fppd.check_alive()
        since = time.monotonic()
        time.sleep(1)
        assert rx.count(since) > 5, "output stopped"
        stop_effects(fppd, "M")
    assert len(failed) < len(names) // 10, failed[:10]


def test_every_palette(fppd):
    """A palette-driven effect with every palette in the list: the
    built-ins, the FastLED ones and every gradient table."""
    w, h = 32, 16
    setup(fppd, [matrix("M", width=w, height=h)], channels=w * h * 3)
    fppd.start()
    desc = fppd.get("/overlays/effects/" + "WLED%20-%20Palette")
    pal = next(a for a in desc["args"] if a["name"] == "palette")
    palettes = pal.get("contents") or []
    assert len(palettes) > 60, pal
    for p in palettes:
        effect(fppd, "M", "WLED - Palette", palette=p)
        time.sleep(0.1)
        fppd.check_alive()


@pytest.mark.parametrize("level", [0, 255])
def test_every_wled_effect_with_its_sliders_at_the_ends(fppd, level):
    """Every effect again with every slider (speed, intensity, the custom
    ones) at 0 and at 255, where divisions by a slider and table lookups
    scaled by one meet their edges."""
    w, h = 32, 16
    setup(fppd, [matrix("M", width=w, height=h)], channels=w * h * 3)
    fppd.start()
    names = [n for n in fppd.get("/overlays/effects") if n.startswith("WLED")]
    for name in names:
        desc = fppd.get("/overlays/effects/" + urllib.parse.quote(name))
        overrides = {a["name"]: str(level) for a in desc.get("args", [])
                     if a.get("type") == "range"}
        try:
            effect(fppd, "M", name, **overrides)
        except Exception:
            pass
        time.sleep(0.2)
        fppd.check_alive()
    stop_effects(fppd, "M")


def test_audio_sync_packet_with_an_infinite_peak(fppd):
    """In WLED audio-sync receive mode, packets from the network whose
    major peak is +Inf are dropped: an audio-reactive effect keeps
    rendering, and stopping it and starting another each answer.

    Regression: 1d1a04bf7. The value went straight to the effects, and
    Rocktaves' "while (f > 249) f /= 2" never ends for +Inf; it spun holding
    the model's effect lock and the global WLED lock, so the effect API
    stopped answering."""
    import socket
    import struct
    w, h = 32, 16
    setup(fppd, [matrix("M", width=w, height=h)], channels=w * h * 3)
    fppd.settings(WLEDAudioSyncMode="receive", WLEDAudioSyncPort="11988")
    pkt = struct.pack("<6s2xffBB16sHff", b"00002\0", 100, 100, 1, 0, bytes(16), 0, 1000,
                      float("inf"))
    with DdpReceiver(w * h * 3) as rx:
        fppd.start()
        effect(fppd, "M", "WLED♪ - Rocktaves")
        # From an address that isn't one of fppd's own: those are ignored.
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.bind(("127.0.0.2", 0))
        try:
            end = time.monotonic() + 3
            while time.monotonic() < end:
                s.sendto(pkt, ("127.0.0.1", 11988))
                time.sleep(0.02)
        finally:
            s.close()
        stop_effects(fppd, "M", timeout=5)
        effect(fppd, "M", "WLED - Colorloop")
        since = time.monotonic()
        time.sleep(1)
        assert rx.count(since) > 5, "output stopped"
        stop_effects(fppd, "M", timeout=5)


def test_audio_sync_sender_survives_media(fppd, audio):
    """With WLED Audio Sync sending and media playing, the sender analyses
    every audio frame and sends it, and fppd stays up.

    Regression: bcf77f734. computeAudioFrame() binned the spectrum into a
    17-entry array, but its loop fills bucket 17 as well: at 44.1 or 48 kHz
    the top bins land there, so every frame wrote one float past the array
    on the sender's thread (an ASan stack-buffer-overflow on the first)."""
    import os
    from audio import write_tone_wav
    from udp import Listener
    port = 21988
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 10, freq=1000)
    fppd.settings(WLEDAudioSyncMode="send", WLEDAudioSyncDest="127.0.0.1",
                  WLEDAudioSyncPort=str(port))
    with Listener(port) as rx:
        fppd.start()
        fppd.command("Play Media", "Tone.wav", "1", "0", "1")
        fppd.wait_for(lambda: rx.count_since(0) >= 50, timeout=15,
                      what="the sender to analyse and send the playing media")
        time.sleep(2)
        fppd.check_alive()


def test_effects_on_two_differently_shaped_models(fppd):
    """A WLED effect keeps drawing all of its 32x16 model after another
    WLED effect starts on a 64x8 one: every row of the first keeps
    changing.

    Regression: d01c005e8. WLED keeps the matrix geometry in statics, and
    building the second model's effect reset them to 64x8 under the first:
    its pixels were then indexed 64 to a row, so its top 8 rows landed on
    every other row and the rest of the model froze."""
    from test_overlays import wait_output
    channels = 32 * 16 * 3 + 64 * 8 * 3
    setup(fppd, [matrix("A", width=32, height=16), matrix("B", start=1537, width=64, height=8)],
          channels=channels)
    with DdpReceiver(channels) as rx:
        fppd.start()
        effect(fppd, "A", "WLED - Rainbow")
        wait_output(fppd, rx, lambda f: any(f[:1536]), "A's effect to draw")
        effect(fppd, "B", "WLED - Rainbow")
        wait_output(fppd, rx, lambda f: any(f[1536:]), "B's effect to draw")
        time.sleep(0.5)
        first = rx.last()
        time.sleep(1.5)
        last = rx.last()

    def row(f, r):
        return f[r * 96:(r + 1) * 96]
    frozen = [r for r in range(16) if row(first, r) == row(last, r)]
    assert not frozen, f"rows {frozen} of the 32x16 model stopped changing once the 64x8 effect started"


@pytest.mark.parametrize("name", ["Shimmer", "Color Clouds", "PacMan", "Slow Transition"])
def test_the_ported_fx_effects_are_offered_and_draw(fppd, name):
    """Shimmer, Color Clouds, PacMan and Slow Transition, ported from
    newer WLED, are offered with the other WLED effects and light a model.

    Feature: f976e090f (before it, none of the four existed).

    Regression: 810852c41. Every mode past 127 was named "WLED♪ - ", as if
    sound reactive; these four are past 127, and none of them is."""
    w, h = 32, 16
    channels = w * h * 3
    setup(fppd, [matrix("M", width=w, height=h)], channels=channels)
    with DdpReceiver(channels) as rx:
        fppd.start()
        assert "WLED - " + name in fppd.get("/overlays/effects")
        effect(fppd, "M", "WLED - " + name)
        fppd.wait_for(lambda: rx.last() is not None and any(rx.last()), timeout=10,
                      interval=0.1, what=f"{name} on the wire")
