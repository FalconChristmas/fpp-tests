"""fppd with an MQTT setup that can't start: it carries on without MQTT."""

import time


def test_a_failed_mqtt_init_is_not_registered_for_events(fppd):
    """When the MQTT client can't be set up (here a CA file that doesn't
    exist), fppd warns and goes on without MQTT: nothing is published
    through the half-made client.

    Regression: 94bcd32df. The client was registered as an event handler
    even when its Init failed, so each status publish went through a client
    that never connected. (The topics here are the once-a-second playlist
    status and the ready/version publishes at start.)"""
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort="18899", MQTTCaFile="/nonexistent/ca.pem",
                  MQTTFrequency="1", MQTTStatusFrequency="1", LogLevel_Control="debug")
    fppd.start()
    fppd.wait_for(lambda: "MQTT Init failed" in fppd.log(), timeout=10, what="the init failure to be logged")
    assert "MQTT init failed at startup" in str(fppd.get("/fppd/warnings"))
    time.sleep(4)
    log = fppd.log()
    published = [line for line in log.splitlines()
                 if "Cannot publish to MQTT" in line or "mosquitto_publish" in line]
    assert not published, f"events went to a client that failed to start: {published[:3]}"
