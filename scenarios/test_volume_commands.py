"""Volume commands: stepping the global volume up and down within 0..100,
one stream slot's own volume, heard on a PipeWire null sink, and the
targeted forms that hand a PipeWire node's volume to the PHP API.

The global volume is read back from GET /fppd/volume. The targeted forms
POST to http://localhost/api/system/volume, which on a player is Apache;
here a stand-in server on port 80 records what fppd sends it.
"""

import http.server
import json
import os
import socket
import threading
import time
import urllib.error

import pytest

from audio import write_tone_wav


def volume(fppd):
    return fppd.get("/fppd/volume")["volume"]


def refused(fppd, *cmd):
    """The command's error text, or None if it was accepted."""
    try:
        fppd.command(*cmd)
    except urllib.error.HTTPError as e:
        return getattr(e, "body", "") or str(e.code)
    return None


def test_volume_steps_stay_within_0_and_100(fppd):
    """Volume Increase, Volume Decrease and Volume Adjust move the volume by
    their amount from where it is, stop at 100 and at 0 rather than going
    past, and a call with the wrong number of arguments is refused and
    changes nothing."""
    fppd.settings(volume="50")
    fppd.start()
    assert volume(fppd) == 50
    steps = [
        ("Volume Increase", "10", 60),
        ("Volume Increase", "55", 100),   # 115, clamped
        ("Volume Decrease", "30", 70),
        ("Volume Decrease", "90", 0),     # -20, clamped
        ("Volume Adjust", "25", 25),
        ("Volume Adjust", "-5", 20),
        ("Volume Adjust", "-100", 0),
        ("Volume Adjust", "100", 100),
        ("Volume Adjust", "-37", 63),
        ("Volume Increase", "0", 63),
        ("Volume Decrease", "0", 63),
    ]
    for name, amount, want in steps:
        fppd.command(name, amount)
        got = volume(fppd)
        assert got == want, f"{name} {amount} left the volume at {got}, expected {want}"
    # The status page reports the same level.
    assert fppd.get("/fppd/status")["volume"] == 63
    for cmd in (("Volume Increase",), ("Volume Decrease",), ("Volume Adjust",),
                ("Volume Increase", "5", "6"), ("Volume Decrease", "5", "6")):
        assert refused(fppd, *cmd) is not None, f"{cmd} was accepted"
        assert volume(fppd) == 63, f"{cmd} changed the volume to {volume(fppd)}"


def peak(samples):
    return max((abs(x) for x in samples), default=0.0)


def test_set_slot_volume_scales_only_that_slot(fppd, audio):
    """Set Slot Volume on a playing slot scales what that slot plays (25
    plays at a quarter of the level, 150 is taken as 100, a negative volume
    as 0, which mutes it without stopping it) and leaves the global volume alone; on an idle slot, or a slot
    number outside 1..5, it is refused."""
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 40, amplitude=0.5)
    fppd.start()
    fppd.command("Play Media", "Tone.wav", "1", "0", "2")

    def level(seconds=1.0):
        time.sleep(0.3)  # the change is in the pipeline before the recording
        rec = audio.record()
        time.sleep(seconds)
        return peak(rec.stop())

    full = None
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        full = level()
        if full > 0.3:
            break
    assert full and full > 0.3, f"slot 2 never played at full level (peak {full})"
    global_before = volume(fppd)

    fppd.command("Set Slot Volume", "2", "25")
    quarter = level()
    assert 0.18 <= quarter / full <= 0.32, f"at 25 the peak went {full:.3f} -> {quarter:.3f}"
    assert volume(fppd) == global_before, "a slot's volume changed the global volume"

    # Muted after 25, not after 100: a negative volume handed on as it came
    # is out of the volume element's range and ignored, so the slot would
    # stay at 25 rather than at full level.
    fppd.command("Set Slot Volume", "2", "-20")
    muted = level()
    assert muted < 0.01, f"a negative slot volume (taken as 0) still played at {muted:.3f}"
    s = fppd.command("Media Slot Status")[1]
    assert s["status"] == "playing", f"slot 2 stopped instead of being muted: {s}"

    fppd.command("Set Slot Volume", "2", "150")
    back = level()
    assert 0.9 <= back / full <= 1.1, f"150 (taken as 100) played at {back:.3f}, full is {full:.3f}"

    assert "not active" in (refused(fppd, "Set Slot Volume", "3", "50") or ""), \
        "Set Slot Volume on an idle slot was accepted"
    for slot in ("0", "6", "x"):
        assert "Invalid slot" in (refused(fppd, "Set Slot Volume", slot, "50") or ""), \
            f"Set Slot Volume on slot {slot!r} was accepted"
    assert refused(fppd, "Set Slot Volume", "2") is not None, "a slot with no volume was accepted"
    fppd.command("Stop Media Slot", "2")


class FakeApache:
    """Stands in for the player's Apache on port 80: records each POST's
    path and JSON body, and answers after `delay` seconds with `reply`."""

    def __init__(self, delay=0.0, reply=b'{"status":"OK"}'):
        self.posts = []
        posts = self.posts

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n).decode(errors="replace")
                try:
                    body = json.loads(body)
                except ValueError:
                    pass
                time.sleep(delay)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(reply)))
                self.end_headers()
                self.wfile.write(reply)
                posts.append((self.path, body))

            def log_message(self, *a):
                pass

        class Server(http.server.ThreadingHTTPServer):
            allow_reuse_address = True
            address_family = socket.AF_INET

        try:
            self.server = Server(("127.0.0.1", 80), Handler)
        except OSError as e:
            pytest.skip(f"port 80 is not free to stand in for Apache: {e}")
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def test_targeted_volume_goes_to_the_pipewire_api(fppd):
    """Volume Set and Volume Adjust with a target leave the global volume
    alone and POST the target with an absolute "volume" or a relative
    "adjust" to /api/system/volume, returning what that answered; with an
    empty target they set the global volume as before."""
    fppd.settings(volume="40")
    api = FakeApache(reply=b'{"status":"OK","volume":33}')
    try:
        fppd.start()
        got = fppd.command("Volume Set", "33", "slot:2")
        assert got == {"status": "OK", "volume": 33}, f"Volume Set returned {got!r}"
        fppd.command("Volume Adjust", "-7", "sink:fpp_group_default")
        fppd.command("Volume Adjust", "12", "route:a b:c\"d")
        assert api.posts == [
            ("/api/system/volume", {"target": "slot:2", "volume": 33}),
            ("/api/system/volume", {"target": "sink:fpp_group_default", "adjust": -7}),
            ("/api/system/volume", {"target": "route:a b:c\"d", "adjust": 12}),
        ], api.posts
        assert volume(fppd) == 40, "a targeted volume changed the global volume"

        fppd.command("Volume Set", "55", "")
        assert volume(fppd) == 55
        fppd.command("Volume Adjust", "-5", "")
        assert volume(fppd) == 50
        assert len(api.posts) == 3, "an empty target went to the PipeWire API"
    finally:
        api.close()


def test_targeted_volume_from_a_preset_finishes_after_the_preset(fppd):
    """A preset of targeted volume commands returns at once, while the API
    takes 2 s to answer, and every request still arrives; the late
    answers go nowhere and fppd carries on.

    The preset drops each command's result while the request is still
    running; the transfer is handed to the main loop, which finishes it and
    throws its reply away."""
    from test_commands import preset
    api = FakeApache(delay=2.0, reply=b"x" * 200000)
    try:
        fppd.write("config/commandPresets.json", {"commands": [
            preset("Duck", {"command": "Volume Adjust", "args": ["-10", "slot:1"]}),
            preset("Duck", {"command": "Volume Set", "args": ["20", "slot:3"]}),
        ]})
        fppd.start()
        began = time.monotonic()
        fppd.command("Trigger Command Preset", "Duck", timeout=20)
        took = time.monotonic() - began
        assert took < 1.5, f"triggering the preset took {took:.1f}s"
        fppd.wait_for(lambda: len(api.posts) == 2, timeout=10, what="both requests to be answered")
        assert sorted(b["target"] for _, b in api.posts) == ["slot:1", "slot:3"], api.posts
        time.sleep(0.5)  # the main loop reads the replies and lets them go
    finally:
        api.close()
