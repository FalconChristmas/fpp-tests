"""What fppd leaves on, and reads from, a real mosquitto broker across a
lost connection: the retained "ready" topic and its last will, the
retained status re-sent on reconnect, publishing while disconnected, the
extra MQTTSubscribe topics and the message cache API that shows them.

The connection is lost the way a network drop loses it: fppd talks to the
broker through a TCP relay here, and closing the relay cuts fppd off while
the broker (and what it has retained) stays up."""

import contextlib
import shutil
import socket
import subprocess
import threading
import time

import pytest

from show import status
from test_mqtt_control import HOST, PORT, broker

RELAY_PORT = 18832
BASE = f"falcon/player/{HOST}"


class Relay:
    """A TCP relay from RELAY_PORT to the broker. cut() closes every
    connection through it and stops listening (a cable pulled: the broker
    sees fppd's socket close without an MQTT DISCONNECT, fppd sees its
    connection drop and its reconnects refused); restore() listens again."""

    def __init__(self):
        self.lock = threading.Lock()
        self.socks = []
        self.listener = None
        self.restore()

    def restore(self):
        s = socket.socket()
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", RELAY_PORT))
        s.listen(8)
        self.listener = s
        threading.Thread(target=self._accept, args=(s,), daemon=True).start()

    def _accept(self, listener):
        while True:
            try:
                c, _ = listener.accept()
            except OSError:
                return
            try:
                b = socket.create_connection(("127.0.0.1", int(PORT)), timeout=5)
            except OSError:
                c.close()
                continue
            with self.lock:
                self.socks += [c, b]
            for src, dst in ((c, b), (b, c)):
                threading.Thread(target=self._pump, args=(src, dst), daemon=True).start()

    @staticmethod
    def _pump(src, dst):
        try:
            while True:
                data = src.recv(65536)
                if not data:
                    break
                dst.sendall(data)
        except OSError:
            pass
        for s in (src, dst):
            with contextlib.suppress(OSError):
                s.shutdown(socket.SHUT_RDWR)

    def cut(self):
        # close() alone leaves the socket listening while the accept thread
        # is blocked in it; shutdown() wakes that accept.
        with contextlib.suppress(OSError):
            self.listener.shutdown(socket.SHUT_RDWR)
        with contextlib.suppress(OSError):
            self.listener.close()
        with self.lock:
            socks, self.socks = self.socks, []
        for s in socks:
            with contextlib.suppress(OSError):
                s.shutdown(socket.SHUT_RDWR)
            s.close()


def retained(topic):
    """What the broker holds retained for `topic` (under fppd's base topic),
    as a new subscriber is handed it on subscribing; None if nothing."""
    if not shutil.which("mosquitto_sub"):
        pytest.skip("mosquitto_sub is not installed")
    out = subprocess.run(["mosquitto_sub", "-h", "127.0.0.1", "-p", PORT, "-q", "1",
                          "--retained-only", "-W", "2", "-F", "%r|%p",
                          "-t", f"{BASE}/{topic}"],
                         capture_output=True, text=True, timeout=30).stdout
    got = [line.split("|", 1)[1] for line in out.splitlines() if line.startswith("1|")]
    return got[-1] if got else None


def publish(topic, payload):
    subprocess.run(["mosquitto_pub", "-h", "127.0.0.1", "-p", PORT, "-q", "1", "-r",
                    "-t", topic, "-m", payload], check=True, timeout=10)


def connected(fppd):
    return status(fppd).get("MQTT", {}).get("connected")


@contextlib.contextmanager
def through_relay(fppd, **settings):
    """A broker, a relay in front of it, and fppd connected through the
    relay. Yields the relay."""
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=str(RELAY_PORT), HostName=HOST, **settings)
    with broker():
        relay = Relay()
        try:
            fppd.start()
            fppd.wait_for(lambda: connected(fppd), timeout=20, what="fppd to connect to the broker")
            fppd.wait_for(lambda: retained("ready") == "1", timeout=10,
                          what="fppd's retained ready=1")
            yield relay
        finally:
            relay.cut()


def test_the_ready_topic_is_left_at_0_when_the_connection_drops(fppd):
    """When fppd's connection to the broker drops without a goodbye, the
    broker publishes fppd's last will, ready=0, and keeps it retained, so a
    subscriber arriving afterwards (Home Assistant restarting) sees the
    player as not ready rather than the stale retained 1.

    Regression: 344445e20. The will was set with retain false: the broker
    sent ready=0 to whoever was subscribed at that moment, and every later
    subscriber was handed the retained ready=1 of a player that was gone.
    """
    with through_relay(fppd) as relay:
        relay.cut()
        fppd.wait_for(lambda: not connected(fppd), timeout=15, what="fppd to see the drop")
        fppd.wait_for(lambda: retained("ready") != "1", timeout=10, interval=0.5,
                      what="the broker to retain anything but the old ready=1")
        assert retained("ready") == "0"


def test_ready_and_version_are_retained_again_after_a_reconnect(fppd):
    """Once fppd reconnects after a drop, the broker again holds ready=1,
    and the retained version and branch, which fppd otherwise publishes
    only once at startup.

    Regression: 6c0ebb5bc. Nothing re-published them on reconnect, so after
    any network blip the broker kept the last will's ready=0 (and, on a
    broker restarted meanwhile, no version at all) until fppd restarted.
    """
    with through_relay(fppd) as relay:
        version = retained("version")
        assert version, "fppd published no retained version at startup"
        relay.cut()
        fppd.wait_for(lambda: not connected(fppd), timeout=15, what="fppd to see the drop")
        fppd.wait_for(lambda: retained("ready") == "0", timeout=10, interval=0.5,
                      what="the last will's ready=0")
        # A broker that lost its retained store meanwhile (restarted with no
        # persistence) is the other case: clear version and branch.
        publish(f"{BASE}/version", "")
        publish(f"{BASE}/branch", "")
        relay.restore()
        fppd.wait_for(lambda: connected(fppd), timeout=30, interval=0.5,
                      what="fppd to reconnect")
        fppd.wait_for(lambda: retained("ready") == "1", timeout=10, interval=0.5,
                      what="ready=1 retained again after the reconnect")
        assert retained("version") == version
        assert retained("branch")


def test_publishing_while_disconnected_is_not_logged_as_an_error(fppd):
    """While the broker is unreachable, fppd's once-a-second status
    publishes fail with "no connection"; that is expected and logged at
    debug level only, not as an error each second.

    Regression: 56515e4de. Every failed publish logged "Error running
    mosquitto_publish: 4" at error level, one or more lines a second for as
    long as the broker was away.
    """
    with through_relay(fppd, MQTTStatusFrequency="1", LogLevel_Control="debug") as relay:
        relay.cut()
        fppd.wait_for(lambda: not connected(fppd), timeout=15, what="fppd to see the drop")
        fppd.wait_for(lambda: fppd.log().count("Cannot publish to MQTT, not connected") >= 3
                      or fppd.log().count("Error running mosquitto_publish") >= 3,
                      timeout=20, interval=0.5, what="three publishes while disconnected")
        log = fppd.log()
    errors = [line for line in log.splitlines() if "Error running mosquitto_publish" in line]
    assert not errors, f"{len(errors)} publish errors logged while disconnected: {errors[:3]}"


def test_each_mqttsubscribe_topic_is_subscribed_and_cached(fppd):
    """MQTTSubscribe takes several topics separated by ";" (spaces around
    them ignored); fppd subscribes to each, and what arrives on them is in
    the message cache that /api/fppd/mqtt/cache answers with, alongside a
    Status of OK.

    Regression: 822657700 (#2099). The setting was one topic: "a; b" was
    subscribed to as the single topic "a; b", so nothing published on a or
    b ever reached fppd's cache (or the conditions that read it). The same
    commit gave the cache answer its Status.
    """
    with through_relay(fppd, MQTTSubscribe=" other/one/# ;other/two;; ") as _:
        def heard():
            publish("other/one/temp", "21.5")
            publish("other/two", "on")
            cache = fppd.get("/fppd/mqtt/cache")
            return "other/one/temp" in cache and "other/two" in cache
        fppd.wait_for(heard, timeout=15, interval=1, what="both extra topics in the cache")
        cache = fppd.get("/fppd/mqtt/cache")
    assert cache["other/one/temp"] == "21.5" and cache["other/two"] == "on", cache
    assert cache.get("Status") == "OK", cache


def test_the_message_cache_api_answers_with_each_topics_last_payload(fppd):
    """GET /api/fppd/mqtt/cache answers with every topic fppd has cached and
    the last payload that arrived on it.

    Regression: e721577bb (#2098). The endpoint added there; before it
    plugins and debugging had no way to read the cache.
    """
    with through_relay(fppd):
        topic = f"{BASE}/set/fpp-tests/value"

        def heard():
            publish(topic, "first")
            return fppd.get("/fppd/mqtt/cache").get(topic) == "first"
        fppd.wait_for(heard, timeout=15, interval=1, what="the topic in the cache")
        publish(topic, "second")
        fppd.wait_for(lambda: fppd.get("/fppd/mqtt/cache").get(topic) == "second", timeout=10,
                      interval=0.5, what="the cache to hold the newer payload")
