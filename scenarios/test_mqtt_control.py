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


def _publish_many(topics, payload=b"v"):
    """Publish each topic once (QoS 0) over one raw MQTT 3.1.1 connection:
    a mosquitto_pub process per topic would take minutes for thousands."""
    import socket

    def remaining(n):
        out = b""
        while True:
            b = n % 128
            n //= 128
            out += bytes([b | (0x80 if n else 0)])
            if not n:
                return out

    def packet(kind, body):
        return bytes([kind]) + remaining(len(body)) + body

    def s16(b):
        return len(b).to_bytes(2, "big") + b

    s = socket.create_connection(("127.0.0.1", int(PORT)), timeout=10)
    s.sendall(packet(0x10, s16(b"MQTT") + b"\x04\x02\x00\x3c" + s16(b"fpp-tests-many")))
    assert s.recv(4)[:1] == b"\x20", "no CONNACK from the broker"
    for t in topics:
        s.sendall(packet(0x30, s16(t.encode()) + payload))
    s.sendall(b"\xe0\x00")
    s.close()


def test_mqtt_cache_has_a_bound(fppd):
    """Thousands of distinct topics under the subscribed set/# wildcard
    don't grow fppd's message cache past its bound, and the newest topic is
    still in it.

    Regression: da791090a. Every message on a subscribed topic was
    cached per topic for good, so anyone able to publish under set/# could
    grow fppd, one topic name after another, until it ran out of memory.
    """
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    base = f"falcon/player/{HOST}/set/cachetest"
    with broker():
        fppd.start()
        # fppd subscribes once it has connected; publish until it hears
        fppd.wait_for(lambda: (_publish_many([f"{base}/probe"]) or
                               f"{base}/probe" in fppd.get("/fppd/mqtt/cache")),
                      timeout=30, interval=1, what="fppd to subscribe")
        topics = [f"{base}/{i}" for i in range(6000)]
        _publish_many(topics)
        fppd.wait_for(lambda: topics[-1] in fppd.get("/fppd/mqtt/cache"), timeout=30,
                      interval=0.5, what="the last topic to reach the cache")
        cache = [t for t in fppd.get("/fppd/mqtt/cache") if t.startswith("falcon/")]
    assert len(cache) <= 4096, f"{len(cache)} topics cached"


def test_shutdown_while_the_broker_drops_connections(fppd):
    """fppd exits promptly on SIGTERM while its MQTT client is still trying
    to reach a broker that silently drops the connection attempt.

    Regression: 11a37e5ed. 5cac5ea15 stopped the client with a clean
    disconnect and an unbounded join of libmosquitto's network thread,
    which waited on its pending connect until the SYN retries ran out --
    about a minute here, two on a device -- so shutdown and restart took
    that long (fppd sat in mosquitto_loop_stop() from ~MosquittoClient).
    The broker here is a listener whose accept queue is full, so Linux
    drops every further SYN to it."""
    import signal
    import socket
    import subprocess

    port = 18832
    lst = socket.socket()
    lst.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    lst.bind(("127.0.0.1", port))
    lst.listen(0)  # never accepted: one connection fills the queue
    fill = []
    try:
        for _ in range(3):
            c = socket.socket()
            c.setblocking(False)
            try:
                c.connect(("127.0.0.1", port))
            except BlockingIOError:
                pass
            fill.append(c)
            time.sleep(0.2)
        fppd.settings(MQTTHost="127.0.0.1", MQTTPort=str(port), HostName=HOST)
        fppd.start()
        time.sleep(5)  # well into the client's connect
        began = time.monotonic()
        fppd.proc.send_signal(signal.SIGTERM)
        try:
            rc = fppd.proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            raise AssertionError("fppd was still running 15 s after SIGTERM, "
                                 "waiting on the MQTT network thread") from None
        fppd.exit_expected = True
        took = time.monotonic() - began
        assert rc == 0, f"fppd exited {rc}"
        print(f"fppd exited {took:.1f} s after SIGTERM")
    finally:
        for c in fill:
            c.close()
        lst.close()
