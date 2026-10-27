"""An Audio Output Group member with a delay: a PipeWire filter-chain of
builtin delay nodes, shaped as pipewire.php's generator writes it (capture
node fpp_fx_g<group>_<card>, delay_<ch> nodes with a "Delay (s)" control),
between fppd's stream and the audio fixture's null sink. fppd finds it from
config/pipewire-audio-groups.json and drives it with pw-cli; the scenario
listens to what comes out."""

import math
import os
import subprocess
import time

import pytest

from audio import RATE, SINK, write_tone_wav

CARD = "testcard"
FX_NODE = f"fpp_fx_g1_{CARD}"
DELAY_S = 1.0

FILTER_CONF = f"""
context.modules = [
  {{ name = libpipewire-module-filter-chain
    args = {{
      node.description = "Delay: fpp-tests"
      filter.graph = {{
        nodes = [
          {{ type = builtin label = delay name = delay_l config = {{ "max-delay" = 5.0 }} control = {{ "Delay (s)" = {DELAY_S} }} }}
          {{ type = builtin label = delay name = delay_r config = {{ "max-delay" = 5.0 }} control = {{ "Delay (s)" = {DELAY_S} }} }}
        ]
        links = [ ]
        inputs = [ "delay_l:In" "delay_r:In" ]
        outputs = [ "delay_l:Out" "delay_r:Out" ]
      }}
      capture.props = {{
        node.name = "{FX_NODE}"
        media.class = Audio/Sink
        audio.channels = 2
        audio.position = [ FL FR ]
      }}
      playback.props = {{
        node.name = "{FX_NODE}_out"
        node.target = "{SINK}"
        node.passive = true
        stream.dont-remix = true
        audio.channels = 2
        audio.position = [ FL FR ]
      }}
    }}
  }}
]
"""


@pytest.fixture
def delay_chain(audio):
    """The filter-chain, run as its own PipeWire client the way PipeWire's
    filter-chain service runs one, on the fixture's graph."""
    if not os.path.exists("/usr/share/pipewire/filter-chain.conf"):
        pytest.skip("PipeWire's filter-chain.conf is not installed")
    conf_dir = os.path.join(audio.dir, "pipewire", "filter-chain.conf.d")
    os.makedirs(conf_dir, exist_ok=True)
    with open(os.path.join(conf_dir, "50-fpp-tests-delay.conf"), "w") as f:
        f.write(FILTER_CONF)
    log = open(os.path.join(audio.dir, "filter-chain.log"), "w")
    proc = subprocess.Popen(["pipewire", "-c", "filter-chain.conf"], env=audio.env, stdout=log,
                            stderr=log, start_new_session=True)
    try:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            out = subprocess.run(["pw-cli", "ls", "Node"], env=audio.env, capture_output=True,
                                 text=True).stdout
            if f'"{FX_NODE}"' in out:
                break
            time.sleep(0.25)
        else:
            pytest.fail("the delay filter-chain never appeared; see " + log.name)
        yield
    finally:
        proc.terminate()
        proc.wait(timeout=10)


def tone_level(rec, samples, freq, start, end):
    """RMS of one frequency (Goertzel) over what was captured between the
    monotonic times start and end."""
    first = rec.count - (rec.ended - start) * RATE
    w = samples[max(0, int(first)):max(0, int(first + (end - start) * RATE))]
    if not w:
        return 0.0
    k = 2 * math.cos(2 * math.pi * freq / RATE)
    s1 = s2 = 0.0
    for x in w:
        s1, s2 = x + k * s1 - s2, s1
    power = s1 * s1 + s2 * s2 - k * s1 * s2
    return math.sqrt(max(power, 0.0)) / len(w)


def test_a_stopped_tracks_delayed_tail_is_flushed(fppd, audio, delay_chain):
    """A group member delayed 1 s: track A (600 Hz) is stopped 3 s in and
    track B (1000 Hz) started straight after. The second of A still in the
    delay's ring buffer when it stopped is thrown away, not played: from
    0.2 s after the stop until B comes through, nothing of A is heard.

    Regression: 53ae3a510. 1afd42202's FlushPipeWireDelayBuffers() never
    flushed: its pw-cli lookup took the "=" of the node.description line
    for the node id, so nothing was sent, and zeroing a delay node's
    "Delay (s)" doesn't empty its ring buffer anyway -- restored, it reads
    the old samples back. So the end of the stopped track played on for
    the length of the delay. Now the chain's output is muted for that
    long."""
    fppd.write("config/pipewire-audio-groups.json", {"groups": [
        {"id": 1, "name": "delayed", "members": [
            {"cardId": CARD, "delayMs": DELAY_S * 1000, "channels": 2}]}]})
    fppd.settings(PipeWireSinkName=FX_NODE)
    write_tone_wav(os.path.join(fppd.media, "music", "A.wav"), 8, freq=600)
    write_tone_wav(os.path.join(fppd.media, "music", "B.wav"), 4, freq=1000)
    fppd.start()
    rec = audio.record()
    t_play = time.monotonic()
    fppd.command("Play Media", "A.wav", "1", "0", "1", timeout=10)
    time.sleep(3)
    t_stop = time.monotonic()
    fppd.command("Stop All Media", timeout=10)
    fppd.command("Play Media", "B.wav", "1", "0", "1", timeout=10)
    time.sleep(4)
    samples = rec.stop()
    heard_a = tone_level(rec, samples, 600, t_play + 1.5, t_stop)
    assert heard_a > 0.05, f"precondition: A never came through the delay ({heard_a:.3f})"
    assert tone_level(rec, samples, 1000, t_stop + 1.5, t_stop + 2.5) > 0.05, "B was not heard"
    tail = [round(tone_level(rec, samples, 600, t_stop + ms / 1000, t_stop + ms / 1000 + 0.1), 3)
            for ms in range(200, 900, 100)]
    assert max(tail) < heard_a / 10, f"A after the stop, per 100 ms from 0.2 s: {tail} (A itself {heard_a:.3f})"
