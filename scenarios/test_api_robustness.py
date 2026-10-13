"""fppd's own HTTP API (port 32322) against hostile input.

Every documented route is called with odd path values and bodies -- broken
and wrong-typed JSON, huge and deeply nested values, encoded NULs and path
traversal, numbers past any range. Any answer is fine, an error included;
the scenario fails only if fppd stops answering (a wedge), dies, or the
sanitizer reports something. One fppd per route, so a failure names it.

Left out: POST /fppd/shutdown (stops fppd by design), /internal/* and the
plugin lifecycle route (no plugins here).
"""

import json
import os
import time
import urllib.error
import urllib.parse

import pytest

from fseq import unique_frames
from show import CHANNELS, install

ROUTES = [
    ("DELETE", "/fppd/e131stats"),
    ("DELETE", "/variables/{}"),
    ("GET", "/aes67"),
    ("GET", "/command/{}"),
    ("GET", "/commandPresets"),
    ("GET", "/commandPresets/{}"),
    ("GET", "/commands"),
    ("GET", "/commands/{}"),
    ("GET", "/fppd/condition/preview"),
    ("GET", "/fppd/e131stats"),
    ("GET", "/fppd/effects"),
    ("GET", "/fppd/log"),
    ("GET", "/fppd/mqtt/cache"),
    ("GET", "/fppd/multiSyncStats"),
    ("GET", "/fppd/multiSyncSystems"),
    ("GET", "/fppd/playlist/config"),
    ("GET", "/fppd/playlist/filetime"),
    ("GET", "/fppd/playlists"),
    ("GET", "/fppd/ports"),
    ("GET", "/fppd/ports/list"),
    ("GET", "/fppd/ports/pixelCount"),
    ("GET", "/fppd/ports/stop"),
    ("GET", "/fppd/schedule"),
    ("GET", "/fppd/schedule/range"),
    ("GET", "/fppd/sequence"),
    ("GET", "/fppd/status"),
    ("GET", "/fppd/testing"),
    ("GET", "/fppd/testing/tests"),
    ("GET", "/fppd/testing/tests/{}"),
    ("GET", "/fppd/version"),
    ("GET", "/fppd/volume"),
    ("GET", "/fppd/warnings"),
    ("GET", "/fppd/warnings_full"),
    ("GET", "/gpio"),
    ("GET", "/gpio/{}"),
    ("GET", "/models"),
    ("GET", "/models/{}"),
    ("GET", "/opusrtp"),
    ("GET", "/overlays/effects"),
    ("GET", "/overlays/effects/{}"),
    ("GET", "/overlays/fonts"),
    ("GET", "/overlays/model/{}"),
    ("GET", "/overlays/model/{}/clear"),
    ("GET", "/overlays/model/{}/data"),
    ("GET", "/overlays/model/{}/data/raw"),
    ("GET", "/overlays/model/{}/preview"),
    ("GET", "/overlays/models"),
    ("GET", "/overlays/running"),
    ("GET", "/overlays/settings"),
    ("GET", "/player"),
    ("GET", "/player/current"),
    ("GET", "/player/status"),
    ("GET", "/fppd/recurringtasks"),
    ("GET", "/rtspoutput"),
    ("GET", "/variables"),
    ("GET", "/variables/{}"),
    ("POST", "/command"),
    ("POST", "/command/{}"),
    ("POST", "/fppd/effects/{}"),
    ("POST", "/fppd/gpio/ext"),
    ("POST", "/fppd/log/level/{}"),
    ("POST", "/fppd/outputs"),
    ("POST", "/fppd/outputs/remap"),
    ("POST", "/fppd/schedule"),
    ("POST", "/fppd/testing"),
    ("POST", "/fppd/volume/{}"),
    ("POST", "/gpio/{}"),
    ("POST", "/models"),
    ("POST", "/models/raw"),
    ("POST", "/fppd/recurringtasks"),
    ("POST", "/variables/{}"),
    ("PUT", "/overlays/model/{}/data"),
    ("PUT", "/overlays/model/{}/fill"),
    ("PUT", "/overlays/model/{}/mmap"),
    ("PUT", "/overlays/model/{}/pixel"),
    ("PUT", "/overlays/model/{}/save"),
    ("PUT", "/overlays/model/{}/state"),
    ("PUT", "/overlays/model/{}/text"),
    ("PUT", "/overlays/range/{}"),
]

# Path values: a real name first (so the route reaches its handler), then
# the odd ones. Already URL-encoded where it matters.
VALUES = [
    "M", "", "x", "%00", "..%2F..%2F..%2Fetc%2Fpasswd", "A" * 4000, "-1", "0",
    "99999999999999999999", "%FF%FE%FD", "1-2-3", "*", "%25s%25s%25n", "M%2FM", "%20",
    "1-99999999", "99999999-1", "-5--3",
]

# Bodies: none, then broken and wrong-typed JSON, and other junk.
BODIES = [
    None, b"", b"{", b"[]", b"null", b'"str"', b"123", b'{"a":', b"\xff\xfe\x00\x01",
    b"[" * 5000 + b"]" * 5000,
    json.dumps({"command": [], "args": 5, "name": {}, "model": None, "x": -1, "y": 1e300,
                "color": "#zzz", "r": "a", "g": [], "b": {}, "data": "%%%", "state": "x",
                "Message": None, "Position": "Center", "Font": 7, "FontSize": -9999,
                "ranges": 3, "startChannel": -100, "channelCount": 99999999}).encode(),
    json.dumps({"command": "Volume Set", "args": ["-50000"]}).encode(),
    json.dumps({"enabled": 1, "mode": "RGBChase", "cycleMS": 0, "channelSet": "1-99999999",
                "colorPattern": "", "channelsPerNode": 0}).encode(),
    json.dumps([{"enabled": True}] * 3).encode(),
    json.dumps({"x": "A" * 100000}).encode(),
]


def environment(fppd):
    """Something for the routes to find: an output, a model, a playlist, a
    sequence, a preset and a variable."""
    install(fppd, unique_frames(200, CHANNELS))
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [{
        "Name": "M", "Type": "Channel", "StartChannel": 1, "ChannelCount": 150,
        "ChannelCountPerNode": 3, "Orientation": "horizontal", "StartCorner": "TL",
        "StringCount": 5, "StrandsPerString": 1}]})
    fppd.write("config/commandPresets.json", {"commands": [{
        "name": "P", "command": "Set Variable", "args": ["V", "Value", "1"], "presetSlot": 0}]})


def call(fppd, method, path, body):
    try:
        fppd.request(method, path, body, timeout=10)
    except urllib.error.HTTPError:
        pass  # any answer, including an error, is fine
    except (ConnectionResetError, urllib.error.URLError) as e:
        fppd.check_alive()  # raises if fppd died
        if "timed out" in str(e):
            raise


@pytest.mark.parametrize("method, route", ROUTES, ids=[f"{m} {r}" for m, r in ROUTES])
def test_route_survives_hostile_input(fppd, method, route):
    environment(fppd)
    fppd.start()
    fppd.command("Start Playlist", "Show", "true", "false")
    values = VALUES if "{}" in route else [None]
    for v in values:
        path = route.format(v) if v is not None else route
        for body in (BODIES if method != "GET" else [None]):
            call(fppd, method, path, body)
        if method == "GET" and "?" not in path:
            # query strings the GET handlers may read
            for q in ("?simple=true", "?names=true&x=%00", "?" + "a=" + "B" * 4000, "?expression=" + "(" * 3000):
                call(fppd, method, path + q, None)
    # fppd still does its job afterwards
    fppd.get("/fppd/status", timeout=10)
    fppd.command("Stop Now")


def code_of(fppd, method, path, body=None):
    try:
        fppd.request(method, path, body, timeout=10)
        return 200
    except urllib.error.HTTPError as e:
        return e.code


@pytest.mark.parametrize("value", ["x", "99999999999999999999", "", "5x", "%00"])
def test_volume_that_is_not_a_number_is_refused(fppd, value):
    """POST /fppd/volume/<value> with something that isn't a whole number
    answers 400 and leaves the volume alone.

    Regression: the value went through atoi(): "x" set the volume to 0 and a
    number too big for an int to -1 (clamped to 0) -- a stray request muted
    the show and answered "Volume set". Fixed by 10ef6cc46.
    """
    fppd.settings(volume="70")
    fppd.start()
    fppd.post("/fppd/volume/70")
    assert fppd.get("/fppd/volume")["volume"] == 70
    assert code_of(fppd, "POST", "/fppd/volume/" + value) in (400, 404)
    assert fppd.get("/fppd/volume")["volume"] == 70, "a bad volume request changed the volume"
    assert fppd.post("/fppd/volume/150")["volume"] == 100, "an over-range volume should clamp to 100"


def test_overlay_range_put_validates_before_changing_anything(fppd):
    """PUT /overlays/range/<ranges> refuses a body that isn't a JSON object,
    a value that isn't a number and a range list it can't parse -- answering
    400 and changing nothing -- instead of treating a garbled body as a
    delete (200, range gone), throwing on an array body (empty 500), or
    applying the ranges before a bad one and then failing (before
    5aa30eadd)."""
    from ddp import DdpReceiver
    environment(fppd)
    fppd.start()
    with DdpReceiver(CHANNELS) as rx:
        fppd.request("PUT", "/overlays/range/1-3", {"Value": 200})
        fppd.wait_for(lambda: rx.last() and rx.last()[:3] == bytes([200] * 3), what="the range lit")
        for path, body in [("/overlays/range/1-3", b"{"), ("/overlays/range/1-3", b"[]"),
                           ("/overlays/range/1-3", {"Value": "lots"}), ("/overlays/range/1-3/x", None),
                           ("/overlays/range/1-3,4x", {"Value": 9})]:
            assert code_of(fppd, "PUT", path, body) == 400, f"PUT {path} {body!r} was not refused"
        time.sleep(0.5)
        assert rx.last()[:3] == bytes([200] * 3), "a refused request changed the range"
        assert not any(rx.last()[3:6]), "a refused request applied a range before the bad one"
