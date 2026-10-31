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
    It reads the cache through /fppd/mqtt/cache (e721577bb).
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


def test_legacy_playlist_topic_after_an_inserted_playlist_ends(fppd):
    """The deprecated playlist/repeat/set topic still reaches the playing
    playlist after an inserted playlist has come and gone.

    Regression: 84cf36987. Every playlist instance registered the legacy
    topics with a callback holding itself and never removed it, so the
    inserted playlist's callback replaced the resident one's; once the
    inserted playlist ended and was freed, the next message on the topic
    ran on freed memory on the MQTT thread.
    """
    from test_playlist_entries import pause, playlist, step, trace
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(30), step(2)]))
    fppd.write("playlists/Q.json", {"name": "Q", "repeat": 0, "loopCount": 0, "leadIn": [],
                                    "mainPlaylist": [step(7)], "leadOut": []})
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    repeat = lambda: int(status(fppd).get("repeat_mode") or 0)
    with broker():
        fppd.start()
        fppd.command("Start Playlist", "P", "false", "false")
        fppd.wait_for(lambda: trace(fppd) == "1", what="P to start")

        def heard():
            # fppd subscribes once it has connected; publish until it hears
            publish("playlist/repeat/set", "1")
            return repeat() == 1
        fppd.wait_for(heard, timeout=30, interval=1, what="fppd to act on playlist/repeat/set")
        fppd.command("Insert Playlist Immediate", "Q", "0", "0", "false")
        fppd.wait_for(lambda: trace(fppd) == "17", timeout=5, what="the inserted playlist to play")
        time.sleep(2)  # the main loop frees the finished inserted playlist
        publish("playlist/repeat/set", "0")
        fppd.wait_for(lambda: repeat() == 0, timeout=10,
                      what="the playing playlist to hear playlist/repeat/set")
        fppd.command("Stop Now")


def test_an_inserted_playlist_does_not_announce_idle(fppd):
    """Inserting a playlist into the one playing publishes no "idle" status
    over MQTT: the player doesn't go idle until the show ends.

    Regression: e14e24890. Every playlist's constructor announced idle
    (status "idle", an empty playlist name, repeat 0), meant for the
    resident playlist at startup; an inserted playlist is constructed
    mid-show, so subscribers saw the player go idle in the middle of it.
    """
    from test_playlist_entries import pause, playlist, step, trace
    if not shutil.which("mosquitto_sub"):
        pytest.skip("mosquitto_sub is not installed")
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(30), step(2)]))
    fppd.write("playlists/Q.json", {"name": "Q", "repeat": 0, "loopCount": 0, "leadIn": [],
                                    "mainPlaylist": [step(7)], "leadOut": []})
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    import threading
    got = []
    with broker():
        fppd.start()
        # fppd subscribes once it has connected; until then what it
        # publishes is lost, so wait for it to hear a probe first.
        probe = f"falcon/player/{HOST}/set/probe"
        fppd.wait_for(lambda: (_publish_many([probe]) or probe in fppd.get("/fppd/mqtt/cache")),
                      timeout=30, interval=1, what="fppd to connect")
        fppd.command("Start Playlist", "P", "false", "false")
        fppd.wait_for(lambda: trace(fppd) == "1", what="P to start")
        sub = subprocess.Popen(["mosquitto_sub", "-h", "127.0.0.1", "-p", PORT,
                                "-t", f"falcon/player/{HOST}/status"],
                               stdout=subprocess.PIPE, text=True)
        reader = threading.Thread(target=lambda: got.extend(l.strip() for l in sub.stdout),
                                  daemon=True)
        reader.start()
        try:
            # The status is retained: "playing" arrives as soon as we subscribe.
            fppd.wait_for(lambda: "playing" in got, what="the retained playing status")
            fppd.command("Insert Playlist Immediate", "Q", "0", "0", "false")
            fppd.wait_for(lambda: trace(fppd) == "17", timeout=5, what="the inserted playlist")
            time.sleep(1.5)
            assert status(fppd).get("status_name") == "playing"
        finally:
            sub.terminate()
            sub.wait(timeout=5)
            reader.join(5)
        fppd.command("Stop Now")
    assert "idle" not in got, f"status published while P played on: {got}"


def test_playlist_name_returns_after_an_insert_after_current(fppd):
    """When a playlist inserted with Insert Playlist After Current finishes,
    the playing playlist's name and status are published again.

    Regression: 38d5636fd. Hand-back resumed the parent,
    but Resume() republishes only a parent that was paused (Insert
    Immediate). After Current never pauses it, so playlist/name/status kept
    the finished insert's name for the rest of the show.
    """
    from test_playlist_entries import pause, playlist, step, trace
    if not shutil.which("mosquitto_sub"):
        pytest.skip("mosquitto_sub is not installed")
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(3), step(2), pause(30)]))
    fppd.write("playlists/Q.json", {"name": "Q", "repeat": 0, "loopCount": 0, "leadIn": [],
                                    "mainPlaylist": [step(7)], "leadOut": []})
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    import threading
    got = []
    with broker():
        fppd.start()
        probe = f"falcon/player/{HOST}/set/probe"
        fppd.wait_for(lambda: (_publish_many([probe]) or probe in fppd.get("/fppd/mqtt/cache")),
                      timeout=30, interval=1, what="fppd to connect")
        sub = subprocess.Popen(["mosquitto_sub", "-h", "127.0.0.1", "-p", PORT,
                                "-t", f"falcon/player/{HOST}/playlist/name/status"],
                               stdout=subprocess.PIPE, text=True)
        reader = threading.Thread(target=lambda: got.extend(l.strip() for l in sub.stdout),
                                  daemon=True)
        reader.start()
        try:
            fppd.command("Start Playlist", "P", "false", "false")
            fppd.wait_for(lambda: trace(fppd) == "1", what="P to start")
            fppd.command("Insert Playlist After Current", "Q", "-1", "-1", "false")
            fppd.wait_for(lambda: trace(fppd) == "172", timeout=15,
                          what="Q to play after P's pause and P to resume")
            time.sleep(1.5)
            assert status(fppd).get("status_name") == "playing"
        finally:
            sub.terminate()
            sub.wait(timeout=5)
            reader.join(5)
        fppd.command("Stop Now")
    assert "Q" in got, f"the insert's name was never published: {got}"
    assert got[-1] == "P", f"playlist/name/status still names the finished insert: {got}"


def test_state_topics_go_out_retained_at_qos_1(fppd):
    """fppd's state topics reach a subscriber retained and at the QoS 1
    every caller asks for.

    Regression: 82d3da8bf. MosquittoClient::Publish(topic, msg, retain, qos)
    handed PublishRaw() its last two arguments swapped, so every message was
    retained and the topics meant to be non-retained (status, playlist/...)
    went out at QoS 0. The fix keeps them retained and makes them QoS 1.
    """
    if not shutil.which("mosquitto_sub"):
        pytest.skip("mosquitto_sub is not installed")
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    with broker():
        fppd.start()
        probe = f"falcon/player/{HOST}/set/probe"
        fppd.wait_for(lambda: (_publish_many([probe]) or probe in fppd.get("/fppd/mqtt/cache")),
                      timeout=30, interval=1, what="fppd to connect")
        # Subscribed at QoS 2, a message arrives at the QoS it was published
        # with; %r is 1 for a retained message replayed on subscribe.
        prefix = f"falcon/player/{HOST}"
        out = subprocess.run(["mosquitto_sub", "-h", "127.0.0.1", "-p", PORT, "-q", "2",
                              "-t", f"{prefix}/status", "-t", f"{prefix}/version",
                              "-F", "%t %q %r", "-C", "2", "-W", "10"],
                             capture_output=True, text=True, timeout=20).stdout
    got = {t[len(prefix) + 1:]: (q, r) for t, q, r in (l.split() for l in out.splitlines())}
    # The control: version was retained at QoS 1 on both sides of the fix.
    assert got.get("version") == ("1", "1"), out
    assert got.get("status") == ("1", "1"), f"status not retained at QoS 1: {out}"


def test_legacy_position_topics_while_a_playlist_advances(fppd):
    """The deprecated playlist/name/set and sectionPosition/set topics arrive
    while a playlist is moving from entry to entry.

    Covers e04cf1842, which takes m_playlistMutex for both on the MQTT
    thread: name/set read the playlist's section position there with no
    lock while the playlist thread moved it, and SetPosition() wrote the
    start position the same way. Not a red-before-green test: the playlist
    thread publishes its status right after each move, and that publish's
    lock orders the accesses for TSan in all but a microsecond window, so
    neither build reports the race here. What this checks is that the
    playlist keeps playing and nothing wedges with the lock taken there.
    """
    from test_playlist_entries import playlist, reset, step
    # Command entries finish at once, so the playlist advances every tick.
    fppd.write("playlists/P.json", playlist("P", main=[reset(), step(1), step(2), step(3)]))
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    repeat = lambda: int(status(fppd).get("repeat_mode") or 0)
    with broker():
        fppd.start()
        fppd.command("Start Playlist", "P", "false", "false")

        def heard():
            # fppd subscribes once it has connected; publish until it hears
            publish("playlist/repeat/set", "1")
            return repeat() == 1
        fppd.wait_for(heard, timeout=30, interval=1, what="fppd to act on playlist/repeat/set")
        for i in range(40):
            publish("playlist/name/set", "P")
            publish("playlist/sectionPosition/set", str(i % 4))
            time.sleep(0.05)
        fppd.wait_for(lambda: status(fppd).get("current_playlist", {}).get("playlist") == "P",
                      timeout=10, what="P to keep playing")
        fppd.command("Stop Now")


class RefusingBroker:
    """A minimal MQTT 3.1.1 broker on its own port that answers every
    CONNECT with CONNACK "not authorised" (5) and closes, until accept() is
    called; after that it accepts, acknowledges SUBSCRIBEs and PINGREQs,
    and keeps the connection. connects holds each CONNECT's monotonic
    time."""

    PORT = 18832

    def __init__(self):
        import socket
        import threading
        self.connects = []
        self.accepting = False
        self.listener = socket.create_server(("127.0.0.1", self.PORT), reuse_port=False)
        self.listener.settimeout(0.5)
        self.stopping = False
        self.conns = []
        threading.Thread(target=self._serve, daemon=True).start()

    def accept(self):
        self.accepting = True

    def _serve(self):
        import threading
        while not self.stopping:
            try:
                c, _ = self.listener.accept()
            except OSError:
                continue
            self.conns.append(c)
            threading.Thread(target=self._client, args=(c,), daemon=True).start()

    @staticmethod
    def _read(c, n):
        out = b""
        while len(out) < n:
            b = c.recv(n - len(out))
            if not b:
                raise ConnectionError
            out += b
        return out

    def _packet(self, c):
        kind = self._read(c, 1)[0]
        length, shift = 0, 0
        while True:
            b = self._read(c, 1)[0]
            length |= (b & 0x7F) << shift
            shift += 7
            if not b & 0x80:
                break
        return kind, self._read(c, length) if length else b""

    def _client(self, c):
        try:
            kind, _ = self._packet(c)
            if kind != 0x10:
                return
            self.connects.append(time.monotonic())
            if not self.accepting:
                c.sendall(b"\x20\x02\x00\x05")
                return
            c.sendall(b"\x20\x02\x00\x00")
            while not self.stopping:
                kind, body = self._packet(c)
                if kind & 0xF0 == 0x80:      # SUBSCRIBE: grant QoS 0 to each topic
                    n, i = 0, 2
                    while i < len(body):
                        i += 2 + int.from_bytes(body[i:i + 2], "big") + 1
                        n += 1
                    c.sendall(bytes([0x90, 2 + n]) + body[:2] + b"\x00" * n)
                elif kind & 0xF0 == 0x30 and kind & 0x06:   # PUBLISH, QoS 1+
                    tl = int.from_bytes(body[:2], "big")
                    c.sendall(b"\x40\x02" + body[2 + tl:4 + tl])
                elif kind == 0xC0:
                    c.sendall(b"\xd0\x00")
                elif kind == 0xE0:
                    return
        except OSError:
            pass
        finally:
            c.close()

    def close(self):
        self.stopping = True
        self.listener.close()
        for c in self.conns:
            try:
                c.close()
            except OSError:
                pass


def test_a_refusing_broker_is_logged_once_and_retried_with_backoff(fppd):
    """A broker that refuses fppd's credentials gets one log line saying so,
    not a warning per attempt, and fppd's reconnects back off (1 s doubling)
    instead of coming every second; once the broker accepts, fppd logs that
    it got in after the refused attempts.

    Regression: 6e660d3c7. A refusal wasn't logged as one at all: each
    attempt logged "Mosquitto Disconnected. Will try reconnect" at warning,
    and libmosquitto's fixed 1 s retry hammered the broker (here 15 or so
    attempts in 15 s, against 4 or 5 with the backoff)."""
    broker = RefusingBroker()
    try:
        fppd.settings(MQTTHost="127.0.0.1", MQTTPort=str(RefusingBroker.PORT), HostName=HOST,
                      MQTTUsername="fpp", MQTTPassword="wrong")
        fppd.start()
        fppd.wait_for(lambda: broker.connects, timeout=15, what="fppd's first CONNECT")
        time.sleep(15)
        attempts = len(broker.connects)
        log = fppd.log()
        refused = [l for l in log.splitlines() if "refused connection" in l]
        retries = [l for l in log.splitlines() if "Will try reconnect" in l]
        assert len(refused) == 1, f"{len(refused)} refusal lines:\n" + "\n".join(refused[:5])
        assert "not authori" in refused[0], refused[0]
        assert not retries, f"{len(retries)} reconnect warnings for refusals:\n" + "\n".join(retries[:5])
        assert attempts <= 6, f"{attempts} connection attempts in 15 s: no backoff"
        broker.accept()
        fppd.wait_for(lambda: "accepted connection after" in fppd.log(), timeout=45, interval=0.5,
                      what="fppd to reconnect once the broker accepts")
    finally:
        broker.close()


def test_resuming_a_paused_playlist_publishes_its_status_again(fppd):
    """Pause Playlist then Resume Playlist: the resume publishes the status
    ("playing") and the section topics again.

    Regression: d3a9b9c0a. Resume put the playlist back to playing without
    telling MQTT, so a subscriber stayed on "paused".
    """
    from test_playlist_entries import pause, playlist, step, trace
    if not shutil.which("mosquitto_sub"):
        pytest.skip("mosquitto_sub is not installed")
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(60), step(2)]))
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    import threading
    got = []
    with broker():
        fppd.start()
        probe = f"falcon/player/{HOST}/set/probe"
        fppd.wait_for(lambda: (_publish_many([probe]) or probe in fppd.get("/fppd/mqtt/cache")),
                      timeout=30, interval=1, what="fppd to connect")
        fppd.command("Start Playlist", "P", "false", "false")
        fppd.wait_for(lambda: trace(fppd) == "1", what="P to start")
        sub = subprocess.Popen(["mosquitto_sub", "-h", "127.0.0.1", "-p", PORT, "-v", "-t", f"falcon/player/{HOST}/status",
                                "-t", f"falcon/player/{HOST}/playlist/section/status"],
                               stdout=subprocess.PIPE, text=True)
        reader = threading.Thread(target=lambda: got.extend(l.strip() for l in sub.stdout), daemon=True)
        reader.start()
        try:
            fppd.wait_for(lambda: any(l.endswith("/status playing") for l in got), what="the retained playing status")
            fppd.command("Pause Playlist")
            time.sleep(1)
            before = len(got)
            fppd.command("Resume Playlist")
            fppd.wait_for(lambda: any(l.endswith("/status playing") for l in got[before:]), timeout=5,
                          what="playing to be published again after the resume; got " + str(got[before:]))
            assert any("/playlist/section/status" in l for l in got[before:]), got[before:]
        finally:
            sub.terminate()
            sub.wait(timeout=5)
            reader.join(5)
        fppd.command("Stop Now")

