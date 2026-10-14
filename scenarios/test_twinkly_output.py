"""The Twinkly channel output against a fake Twinkly (fake_twinkly.py) in its
own network namespace: the login/verify/realtime-mode handshake, frames on
UDP 7777 carrying the token, more than 900 channels split into fragments, a
rejected token, lights that come up after the show started, and the lights
put back to "off" when the output stops."""

import contextlib
import json
import os
import sys
import tempfile
import time

from fake_devices import device_network, wait_ready

ADDR = "10.88.0.2"
FAKE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fake_twinkly.py")
COLOR = bytes.fromhex("FF8001")


def twinkly_output(channels):
    return {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": channels,
        "universes": [{"active": 1, "description": "twinkly", "id": 0, "startChannel": 1,
                       "channelCount": channels, "type": 8, "address": ADDR, "priority": 0,
                       "monitor": 0, "deDuplicate": 0}],
    }]}


class Twinkly:
    def __init__(self, run, rejects=0):
        self.run = run
        self.rejects = rejects
        self.log = tempfile.mktemp(prefix="twinkly-", suffix=".jsonl")

    def start(self):
        wait_ready(self.run(sys.executable, "-I", FAKE, ADDR, self.log, str(self.rejects)), ADDR)

    def events(self, ev=None):
        try:
            with open(self.log) as f:
                out = [json.loads(l) for l in f if l.strip()]
        except FileNotFoundError:
            return []
        return [e for e in out if ev is None or e["ev"] == ev]

    def calls(self):
        return [(e["path"], e.get("token"), e.get("body")) for e in self.events("http")
                if e["method"] == "POST"]

    def frames(self):
        return self.events("udp")

    def realtime_token(self):
        """The token the lights were last put into realtime mode with."""
        for path, token, body in reversed(self.calls()):
            if path == "/xled/v1/led/mode" and '"rt"' in body:
                return token
        return None


@contextlib.contextmanager
def lights(rejects=0, started=True):
    with device_network([ADDR]) as run:
        t = Twinkly(run, rejects)
        if started:
            t.start()
        try:
            yield t
        finally:
            if os.path.exists(t.log):
                os.unlink(t.log)


def setup(fppd, channels):
    fppd.write("config/co-universes.json", twinkly_output(channels))
    fppd.settings(DisableFakeNetworkBridges="1")


def show_color(fppd, channels):
    fppd.command("Test Start", 1000, "RGB Single Color", f"1-{channels}", "#FF8001")


def lit_with_token(tw, token, fragment=0, length=None):
    """The latest frame for `fragment` carries `token` and is all COLOR."""
    fs = [f for f in tw.frames() if f["fragment"] == fragment]
    if not fs:
        return False
    f = fs[-1]
    data = bytes.fromhex(f["data"])
    want = COLOR * (len(data) // 3)
    return (f["version"] == 3 and f["token"] == token and data == want
            and (length is None or len(data) == length))


def test_handshake_then_frames_carry_the_token(fppd):
    """Login, verify with the token login gave, realtime mode with it, and
    then every frame carries it."""
    setup(fppd, 300)
    with lights() as tw:
        fppd.start()
        show_color(fppd, 300)
        fppd.wait_for(lambda: tw.realtime_token(), timeout=15, what="realtime mode")
        token = tw.realtime_token()
        paths = [p for p, _, _ in tw.calls()]
        assert paths[:3] == ["/xled/v1/login", "/xled/v1/verify", "/xled/v1/led/mode"], paths
        assert tw.calls()[1][1] == token, "verify used a different token from the realtime switch"
        fppd.wait_for(lambda: lit_with_token(tw, token, length=300), timeout=10,
                      what="frames lit with the token")


def test_more_than_900_channels_go_in_fragments(fppd):
    """1500 channels: fragment 0 carries the first 900, fragment 1 the
    other 600."""
    setup(fppd, 1500)
    with lights() as tw:
        fppd.start()
        show_color(fppd, 1500)
        fppd.wait_for(lambda: tw.realtime_token(), timeout=15, what="realtime mode")
        token = tw.realtime_token()
        fppd.wait_for(lambda: lit_with_token(tw, token, 0, 900) and lit_with_token(tw, token, 1, 600),
                      timeout=10, what="both fragments lit")


def test_a_rejected_token_is_retried(fppd):
    """Lights that refuse the first verify are not put into realtime mode
    with the refused token; fppd logs in again and gets there."""
    setup(fppd, 300)
    with lights(rejects=1) as tw:
        fppd.start()
        show_color(fppd, 300)
        fppd.wait_for(lambda: tw.realtime_token(), timeout=30, interval=0.5,
                      what="realtime mode after the rejected token")
        logins = [c for c in tw.calls() if c[0] == "/xled/v1/login"]
        assert len(logins) >= 2, tw.calls()
        refused = tw.calls()[1][1]
        assert tw.realtime_token() != refused, "realtime mode was set with the refused token"
        token = tw.realtime_token()
        fppd.wait_for(lambda: lit_with_token(tw, token), timeout=10, what="frames with the new token")


def test_lights_that_come_up_late_are_picked_up(fppd):
    """Lights powered on after the show started still get the handshake
    and the frames, without restarting fppd."""
    setup(fppd, 300)
    with lights(started=False) as tw:
        fppd.start()
        show_color(fppd, 300)
        time.sleep(3)
        tw.start()
        fppd.wait_for(lambda: tw.realtime_token(), timeout=20, interval=0.5,
                      what="realtime mode once the lights answered")
        token = tw.realtime_token()
        fppd.wait_for(lambda: lit_with_token(tw, token), timeout=10, what="frames")


def test_stopping_puts_the_lights_back(fppd):
    """When fppd stops, it switches the lights out of realtime mode, so they
    don't sit frozen on the last frame."""
    setup(fppd, 300)
    with lights() as tw:
        fppd.start()
        show_color(fppd, 300)
        fppd.wait_for(lambda: tw.realtime_token(), timeout=15, what="realtime mode")
        token = tw.realtime_token()
        rc = fppd.stop()
        fppd.exit_expected = True
        assert rc == 0, f"fppd exited {rc}"
        last = tw.calls()[-1]
        assert last[0] == "/xled/v1/led/mode" and '"off"' in last[2] and last[1] == token, tw.calls()[-3:]
