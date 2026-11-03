"""The playlist status topics fppd publishes over MQTT: what a subscriber
hears on a resume, at the end of an inserted playlist, and while a
sequence plays."""

import shutil
import subprocess
import threading
import time

import pytest

from fseq import solid_frames
from show import CHANNELS, install, status
from test_mqtt_control import HOST, PORT, broker, publish
from test_playlist_entries import pause, playlist, step, trace


def _connected(fppd):
    """Wait until fppd has subscribed: what it publishes before it has
    connected is lost."""
    probe = f"falcon/player/{HOST}/set/probe"
    fppd.wait_for(lambda: (publish("set/probe") or probe in fppd.get("/fppd/mqtt/cache")),
                  timeout=30, interval=1, what="fppd to connect")


class _Subscriber:
    """mosquitto_sub on the given topics (under falcon/player/HOST/), each
    message collected as "topic payload" in got."""

    def __init__(self, *topics):
        if not shutil.which("mosquitto_sub"):
            pytest.skip("mosquitto_sub is not installed")
        args = ["mosquitto_sub", "-h", "127.0.0.1", "-p", PORT, "-F", "%t %p"]
        for t in topics:
            args += ["-t", f"falcon/player/{HOST}/{t}"]
        self.got = []
        self.prefix = f"falcon/player/{HOST}/"
        self.sub = subprocess.Popen(args, stdout=subprocess.PIPE, text=True)
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        for line in self.sub.stdout:
            line = line.rstrip("\n")
            self.got.append(line[len(self.prefix):] if line.startswith(self.prefix) else line)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.sub.terminate()
        self.sub.wait(timeout=5)
        self.reader.join(5)


def test_resuming_a_paused_playlist_publishes_its_name_again(fppd):
    """Pause Playlist then Resume Playlist: the resume publishes the
    playlist's name on playlist/name/status again.

    Regression: 7d5cb653e. Resume() put the playlist back to playing without
    republishing its name, so a subscriber whose name topic had been changed
    while the playlist was paused (an inserted playlist's, say) kept it.
    """
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(60), step(2)]))
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    with broker():
        fppd.start()
        _connected(fppd)
        fppd.command("Start Playlist", "P", "false", "false")
        fppd.wait_for(lambda: trace(fppd) == "1", what="P to start")
        with _Subscriber("playlist/name/status") as s:
            # Retained: P's name arrives as soon as we subscribe.
            fppd.wait_for(lambda: "playlist/name/status P" in s.got, what="the retained name")
            fppd.command("Pause Playlist")
            fppd.wait_for(lambda: status(fppd).get("status_name") == "paused", timeout=5,
                          what="P to pause")
            before = len(s.got)
            fppd.command("Resume Playlist")
            fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", timeout=5,
                          what="P to resume")
            try:
                fppd.wait_for(lambda: "playlist/name/status P" in s.got[before:], timeout=5,
                              what="the name to be published on the resume")
            except TimeoutError:
                raise AssertionError(f"no playlist/name/status after the resume: {s.got}") from None
        fppd.command("Stop Now")


def test_an_inserted_playlist_ending_does_not_publish_idle(fppd):
    """A playlist inserted with Insert Playlist Immediate plays and ends, and
    the playlist it interrupted plays on: no "idle" status is published when
    the inserted one ends, only when the parent itself ends.

    Regression: 3decdef36. SetIdle() published idle (status "idle", an empty
    playlist name and section) for every playlist that went idle, so the end
    of an inserted child told subscribers the player had stopped while its
    parent was still playing.
    """
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(8), step(2)]))
    fppd.write("playlists/Q.json", {"name": "Q", "repeat": 0, "loopCount": 0, "leadIn": [],
                                    "mainPlaylist": [step(7)], "leadOut": []})
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    with broker():
        fppd.start()
        _connected(fppd)
        fppd.command("Start Playlist", "P", "false", "false")
        fppd.wait_for(lambda: trace(fppd) == "1", what="P to start")
        with _Subscriber("status") as s:
            fppd.wait_for(lambda: "status playing" in s.got, what="the retained playing status")
            fppd.command("Insert Playlist Immediate", "Q", "0", "0", "false")
            fppd.wait_for(lambda: trace(fppd) == "17", timeout=5, what="the inserted playlist")
            # Q has ended and handed back to P, which is back on its pause.
            fppd.wait_for(lambda: status(fppd).get("current_playlist", {}).get("playlist") == "P",
                          timeout=5, what="P to be the playing playlist again")
            time.sleep(1.5)
            assert status(fppd).get("status_name") == "playing"
            during = list(s.got)
            # The control: the parent's own end does publish idle.
            fppd.wait_for(lambda: trace(fppd) == "172" and
                          status(fppd).get("status_name") == "idle", timeout=15,
                          what="P to finish")
            fppd.wait_for(lambda: "status idle" in s.got[len(during):], timeout=5,
                          what="idle to be published at the end of P; got " + str(s.got))
    assert "status idle" not in during, f"idle published while P played on: {during}"
