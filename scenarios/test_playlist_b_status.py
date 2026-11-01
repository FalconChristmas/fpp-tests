"""What a playlist reports about itself while it plays: the state string the
player and MQTT publish, the entries' elapsed times, and the warning a
looping playlist raises.

Entries append digits to a trace (see test_playlist_entries.py).
"""

import json
import os
import queue
import subprocess
import threading
import time

from test_playlist_commands import start, status_name, wait_idle, wait_trace
from test_playlist_entries import pause, playlist, status, step


def warnings(fppd):
    return [str(w) for w in status(fppd).get("warnings", [])]


def test_a_paused_playlist_says_paused(fppd):
    """A paused playlist reports "paused" as its state, over the API
    (/api/player/current) and in the playlist_details MQTT publishes, and
    "playing" again once resumed.

    Regression: 5c0620db6. Pause moved only the status enum; the state
    string those report came from a mirror that had no paused value, so a
    paused playlist told MQTT and status consumers it was playing.
    """
    from test_mqtt_control import HOST, PORT, broker
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST, MQTTFrequency="1")
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(60)]))

    def current_state():
        return fppd.get("/player/current").get("playlist", {}).get("currentState")

    with broker():
        # The payload is pretty-printed JSON over several lines: take it as
        # hex, one message a line.
        sub = subprocess.Popen(["mosquitto_sub", "-h", "127.0.0.1", "-p", PORT, "-F", "%x",
                                "-t", f"falcon/player/{HOST}/playlist_details"],
                               stdout=subprocess.PIPE, text=True)
        messages = queue.Queue()
        threading.Thread(target=lambda: [messages.put(json.loads(bytes.fromhex(line.strip())))
                                         for line in sub.stdout if line.strip()],
                         daemon=True).start()

        def next_status(timeout=15):
            """The status of the first playlist_details message to arrive
            after now (one already queued may predate the change)."""
            while not messages.empty():
                messages.get_nowait()
            return messages.get(timeout=timeout).get("status")

        try:
            fppd.start()
            start(fppd, "P")
            wait_trace(fppd, "1")
            time.sleep(0.5)  # into the pause entry
            assert current_state() == "playing"
            fppd.command("Pause Playlist")
            fppd.wait_for(lambda: status_name(fppd) == "paused", what="status paused")
            assert current_state() == "paused", "/api/player/current while paused"
            got = [next_status() for _ in range(2)]
            assert got == ["paused", "paused"], f"playlist_details status while paused: {got}"
            fppd.command("Resume Playlist")
            fppd.wait_for(lambda: status_name(fppd) == "playing", what="status playing")
            assert current_state() == "playing"
            fppd.command("Stop Now")
            wait_idle(fppd)
        finally:
            sub.terminate()
            sub.wait(timeout=5)


def test_a_script_entry_not_yet_started_reports_a_sane_elapsed_time(fppd):
    """While a playlist plays, its script entry that hasn't started yet
    reports a sane secondsElapsed in the playlist's config: no more than
    the clock's own reading, which is what a start time of zero gives (the
    seconds since boot or since 1970, depending on the clock the tree
    uses).

    Regression: 8d820b87d. The script entry's start time was left
    uninitialized until the entry first started, so a config read before
    then reported whatever the heap held: under ASan, whose allocator fills
    new memory with 0xbe, millions of years.
    """
    script = fppd.write("scripts/noop.sh", "#!/bin/sh\nexit 0\n")
    os.chmod(script, 0o755)
    fppd.write("playlists/P.json", playlist("P", main=[
        step(1), pause(30),
        {"type": "script", "enabled": 1, "playOnce": 0, "scriptName": "noop.sh",
         "scriptArgs": "", "blocking": False}]))
    # The fill is ASan's default; spelled out so the uninitialized value is
    # the same on every run.
    fppd.start(extra_env={"ASAN_OPTIONS": (
        "halt_on_error=1:detect_leaks=0:abort_on_error=0:malloc_fill_byte=190:"
        f"max_malloc_fill_size=4096:log_path={fppd.media}/logs/asan")})
    start(fppd, "P")
    wait_trace(fppd, "1")
    cfg = fppd.get("/fppd/playlist/config")
    scripts = [e for e in cfg.get("mainPlaylist", []) if e.get("type") == "script"]
    assert scripts, cfg.get("mainPlaylist")
    elapsed = scripts[0].get("secondsElapsed")
    assert elapsed is not None and elapsed <= time.time() + 86400, \
        f"secondsElapsed {elapsed} for a script entry that hasn't started"
    fppd.command("Stop Now")
    wait_idle(fppd)


def test_the_loop_warning_names_a_command_entry_that_restarts_itself(fppd):
    """A repeating playlist whose only entry is Restart Playlist Item lands
    back on itself until the notification cascade limit stops it; the
    warning that raises names a playlist command entry as a possible cause,
    not only presets.

    Regression: a997ae0a1. The warning blamed only a preset that starts a
    playlist ("Fix the preset configuration"), sending the user to look at
    presets they never set up.
    """
    fppd.write("playlists/Loop.json", {"name": "Loop", "repeat": 1, "loopCount": 0,
                                       "leadIn": [], "leadOut": [], "mainPlaylist": [
        {"type": "command", "enabled": 1, "playOnce": 0,
         "command": "Restart Playlist Item", "args": []}]})
    fppd.start()
    fppd.command("Start Playlist", "Loop", "true", "false")

    def loop_warning():
        return [w for w in warnings(fppd) if "loop detected" in w]
    fppd.wait_for(loop_warning, timeout=10, interval=0.2, what="the loop warning")
    w = loop_warning()[0]
    assert "command entry" in w and "Restart" in w, w
    fppd.command("Stop Now")
    wait_idle(fppd)


def test_a_pause_entry_reports_the_time_it_has_run(fppd):
    """A playing Pause entry reports how long it has been running, in the
    status's seconds played and elapsed, not a negative count down to its end.

    Regression: c6ac513ac. The elapsed time was the clock minus the entry's
    END time, so a 30 s pause 2 s in reported about -28 s.
    """
    fppd.write("playlists/P.json", playlist("P", main=[pause(30)]))
    fppd.start()
    start(fppd, "P")
    time.sleep(2.5)
    s = status(fppd)
    assert s.get("status_name") == "playing", s
    played, elapsed = int(s["seconds_played"]), int(s["seconds_elapsed"])
    assert 2 <= played <= 5, f"seconds_played {played} for a pause 2.5 s in"
    assert 2 <= elapsed <= 5, f"seconds_elapsed {elapsed} for a pause 2.5 s in"
    fppd.command("Stop Now")
    wait_idle(fppd)
