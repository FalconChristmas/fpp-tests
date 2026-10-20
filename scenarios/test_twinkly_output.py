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

    def reject_verifies(self, n):
        """Refuse the next n verify calls."""
        with open(self.log + ".reject", "w") as f:
            f.write(str(n))

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
            for f in (t.log, t.log + ".reject"):
                if os.path.exists(f):
                    os.unlink(f)


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
    """Lights that refuse the token from a login are not put into realtime
    mode with it; fppd logs in again within seconds and gets there (f96bf3a98).
    The refusal comes after a restart of the output, on the login that
    restart makes: on the first start a second login was already on its way
    for other reasons and hid the bug."""
    setup(fppd, 300)
    with lights() as tw:
        fppd.start()
        show_color(fppd, 300)
        # Starting the test restarts the output, which logs in a second time.
        fppd.wait_for(lambda: tw.realtime_token() and lit_with_token(tw, tw.realtime_token()),
                      timeout=15, what="frames in realtime mode")
        fppd.command("Test Stop")
        fppd.wait_for(lambda: tw.calls()[-1][2] == '{"mode": "off"}', timeout=10, what="the output stopping")
        n = len(tw.calls())
        tw.reject_verifies(1)
        show_color(fppd, 300)

        def refusals():
            return [e["token"] for e in tw.events("verify") if not e["ok"]]
        fppd.wait_for(refusals, timeout=15, what="the refused verify")
        refused = refusals()[0]
        # PrepareData() logs in again once 5s pass with no token.
        def realtime_since():
            return [t for p, t, b in tw.calls()[n:] if p == "/xled/v1/led/mode" and '"rt"' in b]
        fppd.wait_for(realtime_since, timeout=20, interval=0.5, what="realtime mode after the refusal")
        assert refused not in realtime_since(), "realtime mode was set with the refused token"
        logins = [c for c in tw.calls()[n:] if c[0] == "/xled/v1/login"]
        assert len(logins) >= 2, tw.calls()[n:]
        token = realtime_since()[-1]
        fppd.wait_for(lambda: lit_with_token(tw, token), timeout=10, what="frames with the new token")


def test_lights_that_come_up_late_are_picked_up(fppd):
    """Lights powered on after the show started still get the handshake
    and the frames, without restarting fppd.

    Regression: fc98627a9. The login failed while the lights were off, and
    the only retries were the 120 s token check and the re-login after
    MAXPACKETS, so for up to two minutes they got frames with no token,
    which they ignore."""
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


def test_monitored_lights_that_answer_only_after_output_started_get_a_login(fppd):
    """Monitored lights whose address isn't there when output starts (they
    fail fppd's pings then) get the login and realtime handshake, and frames
    carrying its token, once they answer the next periodic ping.

    Regression: 4959c4759. StartingOutput() starts only outputs valid at
    that moment; one whose pings failed then was never started, so its
    login never ran (authenticate() returns early until the output has
    started), yet it got frames, with no token, once it answered.
    """
    from fake_devices import NETNS, DEV_IF, _ip

    config = twinkly_output(300)
    config["channelOutputs"][0]["universes"][0]["monitor"] = 1
    fppd.write("config/co-universes.json", config)
    fppd.settings(DisableFakeNetworkBridges="1")
    with device_network([]) as run:
        tw = Twinkly(run)
        try:
            fppd.start()
            fppd.wait_for(lambda: [w for w in fppd.get("/fppd/status").get("warningInfo", [])
                                   if w.get("id") == 27],
                          timeout=60, interval=1, what="fppd to give up on the lights")
            show_color(fppd, 300)  # output starts while the lights are down
            time.sleep(2)
            _ip("addr", "add", ADDR + "/24", "dev", DEV_IF, ns=NETNS)
            tw.start()
            fppd.wait_for(lambda: tw.realtime_token(), timeout=45, interval=0.5,
                          what="realtime mode once the lights answered")
            token = tw.realtime_token()
            fppd.wait_for(lambda: lit_with_token(tw, token), timeout=10, what="frames with the token")
        finally:
            for f in (tw.log, tw.log + ".reject"):
                if os.path.exists(f):
                    os.unlink(f)


HANG_SERVER = ("import socket, sys, time\n"
               "s = socket.socket()\n"
               "s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)\n"
               "s.bind((sys.argv[1], 80))\n"
               "s.listen(64)\n"
               "print('ready', flush=True)\n"
               "held = []\n"
               "while True:\n"
               "    held.append(s.accept())\n")


def test_reload_does_not_wait_for_a_hung_login(fppd):
    """Saving the E1.31 outputs while a Twinkly's login is hanging (its
    lights accept the connection and never answer) doesn't stop the other
    outputs: a DDP output next to it keeps getting frames across two saves.

    Regression: 84bc571e7. ~UDPOutput() spun on processCurls() until every
    HTTP request in the process had finished, holding outputThreadLock, so
    output stopped for the rest of the hung login (up to its 10 s timeout).
    The second save comes 3 s after the first, when the new output's login
    has just started, so on the parent its gap is about 7 s.
    """
    from ddp import DdpReceiver
    from show import ddp_output

    def config(description):
        c = ddp_output(150)
        c["channelOutputs"][0]["channelCount"] = 450
        c["channelOutputs"][0]["universes"].append(
            dict(twinkly_output(300)["channelOutputs"][0]["universes"][0],
                 startChannel=151, description=description))
        return c

    fppd.write("config/co-universes.json", config("a"))
    fppd.settings(DisableFakeNetworkBridges="1")
    with device_network([ADDR]) as run, DdpReceiver(150) as rx:
        srv = run(sys.executable, "-I", "-c", HANG_SERVER, ADDR)
        assert srv.stdout.readline().strip() == "ready"
        fppd.start()
        fppd.request("PUT", "/overlays/range/1-450", {"Value": 42})
        assert rx.wait_frames(5, timeout=10), "no DDP frames"
        time.sleep(3)
        since = time.monotonic()
        fppd.write("config/co-universes.json", config("b"))
        time.sleep(3)
        fppd.write("config/co-universes.json", config("c"))
        time.sleep(4)
        # the end of the window counts too: output that stopped and never
        # came back is the longest gap of all
        times = [t for t, _ in rx.snapshot(since=since - 0.5)] + [time.monotonic()]
        gaps = [b - a for a, b in zip(times, times[1:])]
        assert gaps and max(gaps) < 2.5, \
            f"DDP stopped {max(gaps):.1f} s across the saves" if gaps else "no DDP frames"
        assert fppd.log().count("Calling Init() on UDPOutput output") >= 3, "the saves never reloaded"


def test_stopping_lights_that_never_logged_in_makes_no_call(fppd):
    """Stopping the output for lights that refused every login (so never
    got a token, never went into realtime mode) doesn't try to switch them
    off: the blocking call would run on the output thread, or under
    outputThreadLock on a reload, and only time out on a dead device.

    Regression: fc98627a9. StoppingOutput() always posted "mode off" with a
    blocking curl call (up to 5 s), whether or not the device answered or
    this output had a token.
    """
    setup(fppd, 300)
    with lights() as tw:
        open(tw.log + ".refuse-logins", "w").close()
        try:
            fppd.start()
            show_color(fppd, 300)
            fppd.wait_for(lambda: [c for c in tw.calls() if c[0] == "/xled/v1/login"], timeout=15,
                          what="a refused login")
            time.sleep(2)
            fppd.command("Test Stop")
            time.sleep(4)
            offs = [c for c in tw.calls() if c[0] == "/xled/v1/led/mode"]
            assert not offs, f"led/mode posted to lights that never logged in: {offs}"
        finally:
            os.unlink(tw.log + ".refuse-logins")
