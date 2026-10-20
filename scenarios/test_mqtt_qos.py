"""The QoS and retain flags fppd's own MQTT topics are published with,
seen by a mosquitto_sub on a local broker (test_mqtt_control's)."""

import shutil
import subprocess
import time

import pytest

from fseq import solid_frames
from show import CHANNELS, install, status
from test_mqtt_control import HOST, PORT, broker


def subscribe(topic, seconds):
    """Every message on `topic` (under fppd's base topic) for `seconds`, as
    (topic, qos, retained, payload), subscribed at QoS 1."""
    if not shutil.which("mosquitto_sub"):
        pytest.skip("mosquitto_sub is not installed")
    return subprocess.Popen(
        ["mosquitto_sub", "-h", "127.0.0.1", "-p", PORT, "-q", "1", "-W", str(seconds),
         "-F", "%t|%q|%r|%p", "-t", f"falcon/player/{HOST}/{topic}"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)


def messages(proc):
    out, _ = proc.communicate(timeout=60)
    return [tuple(line.split("|", 3)) for line in out.splitlines() if line.count("|") >= 3]


def test_state_topics_are_qos_1_and_retained(fppd):
    """fppd's status and playlist topics reach a QoS 1 subscriber at QoS 1,
    and stay retained on the broker for the next subscriber.

    Regression: 82d3da8bf (#2954). Publish() passed retain and qos to
    PublishRaw() in the wrong order, so every message was retained but the
    status, playlist/*, fppd_status and similar topics went out at QoS 0
    whatever the caller asked for."""
    install(fppd, solid_frames(40, CHANNELS, 50))  # a 2 s show
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    with broker():
        fppd.start()
        fppd.wait_for(lambda: status(fppd).get("MQTT", {}).get("connected"), timeout=20,
                      what="fppd to connect to the broker")
        live = subscribe("status", 8)
        time.sleep(1)
        fppd.command("Start Playlist", "Show", "false", "false")
        fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=20,
                      interval=0.2, what="the show to end")
        got = messages(live)
        later = messages(subscribe("status", 3))
    published = [m for m in got if m[2] == "0"]  # not the retained copy sent on subscribe
    assert published, f"no live status messages: {got}"
    assert {m[1] for m in got} == {"1"}, f"status delivered at QoS {sorted({m[1] for m in got})}: {got}"
    assert later and later[0][2] == "1", f"status not retained for a new subscriber: {later}"
