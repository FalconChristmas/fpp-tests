"""Effects started and stopped over MQTT: the set/effect/start, startbg and
stop topics, on a local mosquitto broker (test_mqtt_control's)."""

import time

from eseq import model_frames, write_eseq
from show import status
from test_effects import SIZE, START, outputs_only, running
from test_mqtt_control import HOST, PORT, broker, publish


def connected(fppd):
    outputs_only(fppd)
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    fppd.start()
    fppd.wait_for(lambda: status(fppd).get("MQTT", {}).get("connected"), timeout=20,
                  what="fppd to connect to the broker")


def publish_until(fppd, topic, payload, predicate, what):
    """Publish again each second until `predicate` holds: the broker
    connection can still be subscribing when the first message goes out."""
    def done():
        if predicate():
            return True
        publish(topic, payload)
        time.sleep(0.5)
        return predicate()
    fppd.wait_for(done, timeout=30, interval=0.5, what=what)


def test_effects_are_started_and_stopped_by_mqtt_topics(fppd):
    """set/effect/start with an effect's name runs it, set/effect/startbg
    runs one as a background effect, set/effect/stop with a name stops that
    one, and set/effect/stop with no payload stops them all.

    Regression: 8faab644e. The effect topics moved with the rest of the MQTT
    control to callbacks registered through Events; without the effect
    callback registered, the topics are subscribed and ignored."""
    for name in ("fx", "fy", "fz"):
        write_eseq(fppd, name, model_frames(400, SIZE, seed=1), START)
    with broker():
        connected(fppd)
        publish_until(fppd, "set/effect/start", "fx", lambda: running(fppd) == ["fx"], "set/effect/start to run fx")
        publish_until(fppd, "set/effect/startbg", "fy", lambda: running(fppd) == ["fx", "fy"],
                      "set/effect/startbg to run fy")

        publish("set/effect/stop", "fx")
        fppd.wait_for(lambda: running(fppd) == ["fy"], timeout=10, what="set/effect/stop fx to stop only fx")

        publish("set/effect/start", "fz")
        fppd.wait_for(lambda: running(fppd) == ["fy", "fz"], timeout=10, what="fz to start")
        publish("set/effect/stop", "")
        fppd.wait_for(lambda: running(fppd) == [], timeout=10, what="set/effect/stop with no payload to stop all")
