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
