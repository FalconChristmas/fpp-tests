"""Control over MQTT: a local mosquitto broker, fppd connected to it, and
topics published with mosquitto_pub."""

import contextlib
import shutil
import subprocess
import time

import pytest

from fseq import solid_frames
from show import CHANNELS, install, status
from test_scheduler import schedule_entry, window

PORT = "18831"
HOST = "mqtttest"


@contextlib.contextmanager
def broker():
    if not shutil.which("mosquitto") or not shutil.which("mosquitto_pub"):
        pytest.skip("mosquitto and mosquitto_pub are not installed")
    proc = subprocess.Popen(["mosquitto", "-p", PORT],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(0.5)
        yield
    finally:
        proc.terminate()
        proc.wait(timeout=5)


def publish(topic, payload=""):
    subprocess.run(["mosquitto_pub", "-h", "127.0.0.1", "-p", PORT,
                    "-t", f"falcon/player/{HOST}/{topic}", "-m", payload],
                   check=True, timeout=10)


@pytest.mark.parametrize("topic", ["set/playlist/Show/stop/now",
                                   "set/playlist/ALLPLAYLISTS/stop/now",
                                   "set/playlist/Show/stop/graceful"])
def test_mqtt_stop_keeps_the_scheduled_playlist_stopped(fppd, topic):
    """A playlist stopped over MQTT inside its schedule window stays
    stopped, as one stopped from the UI or the API does.

    Regression: the MQTT stop topics called the playlist's own StopNow and
    StopGracefully, which do not record a forced stop, so the scheduler saw
    its window's playlist not playing and started it straight back up.
    Fixed by 3d9f55b23, which routes them through the Player. Verify with
    --base set to its parent plus e3c90bec8 and bdc71586c: before those, the
    main loop could miss the stop altogether (so nothing restarted, fix or
    not), and a second graceful stop that reached an idle player wedged it
    in "stopping gracefully".
    """
    install(fppd, solid_frames(40, CHANNELS, 50))  # 2 s, so graceful ends soon
    start, end = window(-60, 600)
    fppd.write("config/schedule.json", [schedule_entry("Show", start, end)])
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    with broker():
        fppd.start()
        fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", timeout=30,
                      interval=0.5, what="the scheduled playlist to start")
        # Let the main loop see it playing: it asks the scheduler what to do
        # only on a playing-to-idle change it has seen.
        time.sleep(3)

        def heard():
            # fppd subscribes once it has connected; publish until it hears.
            # Only until: one stop is the case under test, not a stream of them.
            publish(topic)
            return status(fppd).get("status_name") != "playing"
        fppd.wait_for(heard, timeout=30, interval=1, what="fppd to act on the MQTT stop")
        fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=10,
                      interval=0.2, what="the playlist to stop")
        # The scheduler looks every second; give it several
        seen = set()
        for _ in range(16):
            time.sleep(0.5)
            seen.add(status(fppd).get("status_name"))
    assert seen == {"idle"}, f"the scheduler restarted the playlist after an MQTT stop: {seen}"
