"""The MQTT channel output (channeloutput/MQTTOutput.cpp): channels from a
playing sequence published to a topic on the local mosquitto broker, with
the payload template's %..% tokens filled in, and checked by a subscriber
here against values computed independently, with exact fractions, from the
standard RGB to HSV/HSI formulas.

A topic carries one message per change of the output's own channels: the
output remembers the last values it published (all zero to begin with) and
publishes only when they differ.

Not checked: DumpConfig() logs the topic on its "Payload" line (PROBLEMS.md
13); it is only a debug log line.
"""

import contextlib
import os
import subprocess
import threading
import time
from fractions import Fraction

from fseq import write_fseq
from show import playlist, sequence_entry, status
from test_mqtt_control import HOST, PORT, broker

PREFIX = "fpp-tests/mqttout"
HOLD = 8      # frames each step of a sequence is held (50 ms frames)
CHANNELS = 16


class Subscriber:
    """mosquitto_sub on PREFIX/#, its messages collected as (topic, payload)
    in arrival order. Ready once it has heard its own probe, so nothing
    published after that is missed."""

    def __init__(self):
        self.messages = []
        self.lock = threading.Lock()
        self.proc = subprocess.Popen(
            ["mosquitto_sub", "-h", "127.0.0.1", "-p", PORT, "-q", "1", "-v",
             "-t", f"{PREFIX}/#"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()

    def _read(self):
        for line in self.proc.stdout:
            topic, _, payload = line.rstrip("\n").partition(" ")
            with self.lock:
                self.messages.append((topic, payload))

    def on(self, topic):
        with self.lock:
            return [p for t, p in self.messages if t == topic]

    def wait_ready(self):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            subprocess.run(["mosquitto_pub", "-h", "127.0.0.1", "-p", PORT,
                            "-t", f"{PREFIX}/probe", "-m", "probe"], check=True, timeout=10)
            time.sleep(0.2)
            if self.on(f"{PREFIX}/probe"):
                return
        raise TimeoutError("mosquitto_sub never heard its probe")

    def close(self):
        self.proc.terminate()
        self.proc.wait(timeout=5)
        self.thread.join(timeout=5)


@contextlib.contextmanager
def broker_and_subscriber():
    with broker():
        sub = Subscriber()
        try:
            sub.wait_ready()
            yield sub
        finally:
            sub.close()


def mqtt_output(topic, start, channel_type=None, payload=None, count=None):
    """One co-other.json entry, as the UI saves it (channelCount follows the
    channel type there; the output itself reads channels by its type)."""
    o = {"type": "MQTTOutput", "enabled": 1, "startChannel": start,
         "channelCount": count or {"RGBW": 4, "Single": 1}.get(channel_type, 3),
         "topic": topic}
    if channel_type is not None:
        o["channelType"] = channel_type
    if payload is not None:
        o["payload"] = payload
    return o


def write_outputs(fppd, outputs):
    """co-other.json, renamed into place: fppd watches it and reloads its
    outputs when it changes, and must never see it half written."""
    path = os.path.join(fppd.media, "config", "co-other.json")
    fppd.write("config/co-other.json.tmp", {"channelOutputs": outputs})
    os.replace(path + ".tmp", path)


def start_show(fppd, frames, outputs):
    """Sequence, playlist, outputs and the broker settings; start fppd and
    wait until its MQTT client is connected (an output publishes nothing
    before that)."""
    write_fseq(os.path.join(fppd.media, "sequences", "Show.fseq"), frames, step_ms=50)
    fppd.write("playlists/Show.json", playlist("Show", [sequence_entry("Show.fseq")]))
    write_outputs(fppd, outputs)
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    fppd.start()
    fppd.wait_for(lambda: status(fppd).get("MQTT", {}).get("connected"), timeout=30,
                  interval=0.2, what="fppd's MQTT client to connect")


def noise(i):
    """A byte that changes every frame, for channels no output reads."""
    return (i * 37 + 11) % 256


# --- independent expectations ---------------------------------------------

def hsiv(r, g, b):
    """Hue in degrees and HSI saturation, HSV saturation, intensity and
    value in percent, exactly (Fractions), from 0-255 RGB: the hexagonal hue
    of HSV (60 degrees per sextant from red, 0 for a grey), HSI saturation
    1 - min/I with I the mean, HSV saturation (max - min)/max, V = max."""
    R, G, B = (Fraction(x, 255) for x in (r, g, b))
    hi, lo = max(R, G, B), min(R, G, B)
    c = hi - lo
    intensity = (R + G + B) / 3
    if c == 0:
        hue, si = Fraction(0), Fraction(0)
    else:
        if hi == R:
            hue = 60 * (((G - B) / c) % 6)
        elif hi == G:
            hue = 60 * ((B - R) / c + 2)
        else:
            hue = 60 * ((R - G) / c + 4)
        si = 1 - lo / intensity
    sv = c / hi if hi else Fraction(0)
    return {"H": hue, "SI": si * 100, "SV": sv * 100, "I": intensity * 100, "V": hi * 100}


# fppd computes these in single-precision float and truncates to an int. An
# exact value close below or at an integer could truncate either way, so every
# color used here keeps each value at least 0.001 away from an integer, except
# for the ones fppd's float arithmetic hits exactly (0, 100, and the hues 0,
# 120 and 240 of the primaries, from 0.0 and 1.0 channels).
EXACT = {"H": {0, 120, 240}, "SI": {0, 100}, "SV": {0, 100}, "I": {0, 100}, "V": {0, 100}}


def truncated(r, g, b):
    out = {}
    for k, v in hsiv(r, g, b).items():
        whole = int(v)
        if v == whole:
            assert whole in EXACT[k], f"({r},{g},{b}) {k} is exactly {whole}: pick another color"
        else:
            assert min(v - whole, whole + 1 - v) > Fraction(1, 1000), \
                f"({r},{g},{b}) {k} = {float(v)} is too close to an integer: pick another color"
        out[k] = whole
    return out


ALL_TOKENS = ("R=%R% G=%G% B=%B% W=%W% RS=%RS% GS=%GS% BS=%BS% WS=%WS% SW=%SW% "
              "H=%H% S=%S% SI=%SI% SV=%SV% I=%I% V=%V%")


def all_tokens(r, g, b, w=0):
    t = truncated(r, g, b)
    return (f"R={r} G={g} B={b} W={w} "
            f"RS={r * 100 // 255} GS={g * 100 // 255} BS={b * 100 // 255} WS={w * 100 // 255} "
            f"SW={'ON' if max(r, g, b, w) == 255 else 'OFF'} "
            f"H={t['H']} S={t['SI']} SI={t['SI']} SV={t['SV']} I={t['I']} V={t['V']}")


def published(values, render):
    """What a topic should carry for a run of channel values: one message
    per change, starting from all zero."""
    out, last = [], None
    for v in values:
        if v != last and (last is not None or any(v)):
            out.append(render(*v))
        last = v
    return out


# --- scenarios ------------------------------------------------------------

RGB_STEPS = [
    (0, 0, 0),
    (255, 0, 0), (0, 255, 0), (0, 0, 255),   # the three hue sextant branches
    (255, 128, 0),
    (255, 128, 0),                           # held: no new message
    (200, 90, 41),
    (220, 30, 90),                           # red highest, blue over green: hue wraps past 360
    (30, 201, 111),                          # green highest
    (90, 60, 230),                           # blue highest
    (77, 77, 77),                            # grey: no hue or saturation
    (255, 255, 255),
    (254, 128, 0),                           # 254 is not ON
    (0, 0, 0),
]
RGBW_STEPS = [
    (0, 0, 0, 0),
    (0, 0, 0, 128),                          # white alone changes: published
    (10, 20, 31, 128),
    (10, 20, 31, 255),                       # same color, white full: ON
    (10, 20, 31, 255),
    (255, 0, 0, 0),                          # red full, white off: ON
    (254, 254, 254, 254),                    # nothing full: OFF
    (128, 64, 202, 77),
    (128, 64, 201, 77),
    (128, 64, 201, 77),
    (128, 64, 201, 77),
    (1, 0, 0, 0),
    (1, 0, 0, 0),
    (0, 0, 0, 0),
]
SINGLE_STEPS = [0, 1, 1, 200, 254, 255, 255, 3, 3, 3, 128, 0, 0, 0]


def test_mqtt_output_payload_tokens(fppd):
    """Four MQTT outputs on one sequence, each with its own topic:

    - RGB, channels 1-3, a payload with every token: %R% %G% %B% and %W%
      (0 for RGB) as 0-255; %RS% %GS% %BS% %WS% as percent, (v * 100) / 255
      in integers; %SW% ON if any channel is 255, else OFF; %H% the hue in
      whole degrees, %S% and %SI% the HSI saturation, %SV% the HSV
      saturation, %I% the intensity (mean) and %V% the value (max), in whole
      percent, truncated. Colors cover each hue sextant branch, a hue that
      wraps negative, grey, white and black.
    - RGB with no payload configured, and one with an empty payload: both
      publish the default "%R%,%G%,%B%".
    - RGBW, channels 5-8: white is the fourth channel and changes alone are
      published; the HSV tokens come from red, green and blue only.
    - Single, channel 10: the channel is %W%; red, green and blue stay 0.

    Each topic carries exactly one message per change of its own channels,
    in order: channels 4, 9 and 11-16 change every frame and are read by no
    output, and a value held for several steps is published once.

    Regression: 85f33b352. The HSV and intensity tokens were computed from
    r / 255 in integer division, so they were only ever 0 or 100.
    """
    steps = list(zip(RGB_STEPS, RGBW_STEPS, SINGLE_STEPS))
    frames = []
    for (rgb, rgbw, single) in steps:
        for _ in range(HOLD):
            i = len(frames)
            f = [noise(i + k) for k in range(CHANNELS)]
            f[0:3] = rgb
            f[4:8] = rgbw
            f[9] = single
            frames.append(bytes(f))
    # A few blank frames at the end: all channels have come back to 0 there
    frames += [bytes(CHANNELS)] * HOLD

    want = {
        "rgb": published(RGB_STEPS, all_tokens),
        "default": published(RGB_STEPS, lambda r, g, b: f"{r},{g},{b}"),
        "empty": published(RGB_STEPS, lambda r, g, b: f"{r},{g},{b}"),
        "rgbw": published(RGBW_STEPS, lambda r, g, b, w: all_tokens(r, g, b, w)),
        "single": published([(v,) for v in SINGLE_STEPS],
                            lambda w: f"{w} {w * 100 // 255} {'ON' if w == 255 else 'OFF'} R=0"),
    }
    with broker_and_subscriber() as sub:
        start_show(fppd, frames, [
            mqtt_output(f"{PREFIX}/rgb", 1, "RGB", ALL_TOKENS),
            mqtt_output(f"{PREFIX}/default", 1),
            mqtt_output(f"{PREFIX}/empty", 1, "RGB", ""),
            mqtt_output(f"{PREFIX}/rgbw", 5, "RGBW", ALL_TOKENS),
            mqtt_output(f"{PREFIX}/single", 10, "Single", "%W% %WS% %SW% R=%R%"),
        ])
        fppd.command("Start Playlist", "Show", "false", "false")
        for name, msgs in want.items():
            fppd.wait_for(lambda: len(sub.on(f"{PREFIX}/{name}")) >= len(msgs), timeout=30,
                          interval=0.2, what=f"{len(msgs)} messages on {name}")
        fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=30,
                      interval=0.2, what="the sequence to end")
        time.sleep(1)  # anything late or extra would be here by now
        got = {name: sub.on(f"{PREFIX}/{name}") for name in want}
    for name in want:
        assert got[name] == want[name], f"{name}: got {got[name]}, want {want[name]}"


def test_mqtt_output_reconfigured_while_playing(fppd):
    """co-other.json rewritten while a sequence plays: fppd closes the MQTT
    output and starts one from the new config. The new output, on its new
    topic, publishes the color already showing (it starts from all zero, as
    the first one did); the old one publishes nothing more, even when the
    channels change after the reload (the playlist stopped: back to 0)."""
    color = (12, 34, 56)
    frames = [bytes(color) + bytes([noise(i)]) for i in range(1200)]  # 60 s
    with broker_and_subscriber() as sub:
        start_show(fppd, frames, [mqtt_output(f"{PREFIX}/before", 1)])
        fppd.command("Start Playlist", "Show", "false", "false")
        fppd.wait_for(lambda: sub.on(f"{PREFIX}/before"), timeout=30, interval=0.1,
                      what="the color on the first topic")
        write_outputs(fppd, [mqtt_output(f"{PREFIX}/after", 1)])
        fppd.wait_for(lambda: sub.on(f"{PREFIX}/after"), timeout=30, interval=0.1,
                      what="the color on the new topic")
        fppd.command("Stop Now")
        fppd.wait_for(lambda: len(sub.on(f"{PREFIX}/after")) >= 2, timeout=30, interval=0.1,
                      what="the blank after the stop on the new topic")
        time.sleep(1)  # anything late or extra would be here by now
        before, after = sub.on(f"{PREFIX}/before"), sub.on(f"{PREFIX}/after")
    assert before == ["12,34,56"], f"the old output: {before}"
    assert after == ["12,34,56", "0,0,0"], f"the new output: {after}"


def output_warnings(fppd):
    return [w for w in status(fppd).get("warnings", []) if "MQTTOutput" in w]


def test_mqtt_output_refuses_a_wildcard_topic(fppd):
    """An MQTT output whose topic has a subscription wildcard (+ or #) is
    refused at start, with an output warning, and does not disturb another
    MQTT output that publishes as usual.

    Regression: e1c2d756b. A wildcard topic was accepted and every publish
    to it failed in the library, logged once per change, with no warning.
    """
    frames = [bytes([(i // HOLD) * 10 % 256] * 3) for i in range(5 * HOLD)]
    with broker_and_subscriber() as sub:
        start_show(fppd, frames, [mqtt_output(f"{PREFIX}/+/plus", 1),
                                  mqtt_output(f"{PREFIX}/hash/#", 1),
                                  mqtt_output(f"{PREFIX}/ok", 1)])
        warnings = output_warnings(fppd)
        fppd.command("Start Playlist", "Show", "false", "false")
        fppd.wait_for(lambda: len(sub.on(f"{PREFIX}/ok")) >= 4, timeout=30, interval=0.2,
                      what="the four colors on the good output")
        fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=30,
                      interval=0.2, what="the sequence to end")
        time.sleep(1)
        ok = sub.on(f"{PREFIX}/ok")
    assert warnings, "no output warning for a topic with a wildcard"
    log = fppd.log()
    for topic in (f"{PREFIX}/+/plus", f"{PREFIX}/hash/#"):
        assert f"MQTT Output topic '{topic}' contains a wildcard" in log, f"{topic} was not refused"
    assert "Error running mosquitto_publish" not in log
    assert ok == ["10,10,10", "20,20,20", "30,30,30", "40,40,40", "0,0,0"], ok


def test_mqtt_output_needs_a_broker(fppd):
    """Without an MQTT broker configured an MQTT output is refused at start
    with an output warning, and fppd plays on without it."""
    write_fseq(os.path.join(fppd.media, "sequences", "Show.fseq"),
               [bytes([50, 60, 70])] * 20, step_ms=50)
    fppd.write("playlists/Show.json", playlist("Show", [sequence_entry("Show.fseq")]))
    write_outputs(fppd, [mqtt_output(f"{PREFIX}/nobroker", 1)])
    fppd.start()
    assert output_warnings(fppd), "no output warning for an MQTT output without a broker"
    assert "MQTT Not Configured, cannot start MQTT Output" in fppd.log()
    fppd.command("Start Playlist", "Show", "false", "false")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", timeout=10,
                  interval=0.1, what="the playlist to start")
