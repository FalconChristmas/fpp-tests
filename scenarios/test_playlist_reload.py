"""A playing playlist's file edited under it, the stop paths' presets, and
what a playlist reports about itself (its debug dump, its MQTT status).

fppd notices an edited playlist file only at a few points while it plays
(Playlist::ReloadIfNeeded): when a pass of a repeating main section ends,
on the way to the lead-out, and when an entry ends during a graceful stop.
The edit is picked up if the file's mtime is newer than when it was loaded;
ReloadPlaylist then loads the new file in place, keeping the running
playlist's repeat, loop count and loop counter, and carries on at the start
of the new main section (never the lead-in again).

Entries append digits to a trace (see test_playlist_entries.py), so which
copy of the playlist ran each entry is read back from /variables. Every
edit replaces the file atomically with an mtime well past the old one, so
"modified" never depends on the clock or on a half-written file.

Not testable here: Playlist::FindPosForMS and GetFilenamesForPos are only
called from MultiSync::SyncPlaylistToMS, which nothing in fpp calls (it is
plugin API, used by the timecode plugins since 4f43eb1b3); GetCurrentPosInMS,
GetPosStartInMS, GetConfigStr, Playlist::ReplaceMatches and the PlaylistRef
operators have no caller in fpp at all.
"""

import json
import os
import queue
import subprocess
import threading
import time

from test_command_presets import variable
from test_playlist_commands import start, status_name, wait_idle, wait_trace
from test_playlist_entries import pause, playlist, status, step, trace
from test_playlist_presets import preset


def edit(fppd, name, content, bump=60):
    """Replace playlists/<name>.json in one rename, with an mtime `bump`
    seconds past the current file's, so fppd sees it as modified (it
    compares whole seconds) and never reads it half-written."""
    path = os.path.join(fppd.media, "playlists", f"{name}.json")
    old = os.stat(path).st_mtime
    tmp = path + ".tmp"
    if not isinstance(content, str):
        content = json.dumps(content, indent=4)
    with open(tmp, "w") as f:
        f.write(content)
    os.utime(tmp, (old + bump, old + bump))
    os.replace(tmp, path)


def wait_log(fppd, text, timeout=10):
    fppd.wait_for(lambda: text in fppd.log(), timeout=timeout, interval=0.1,
                  what=f"fppd to log {text!r}")


def test_edit_while_repeating_is_picked_up_at_the_end_of_the_pass(fppd):
    """A repeating playlist whose file is edited mid-pass plays the new main
    section from the next pass on, without its lead-in. The running
    playlist's loop count (3, from the old file) and repeat (from Start
    Playlist) are kept, and so is its count of passes so far: the new file
    says repeat 0 and loopCount 0, but there are three passes in all, the
    last two from the new file, then the new file's lead-out."""
    fppd.write("playlists/P.json", playlist(
        "P", lead_in=[step(5)], main=[step(1), pause(3)], lead_out=[step(9)], loop_count=3))
    fppd.start()
    start(fppd, "P", repeat=True)
    wait_trace(fppd, "51")
    # In pass 1's 3 s pause.
    edit(fppd, "P", playlist("P", lead_in=[step(6)], main=[step(2), pause(1)],
                             lead_out=[step(8)], repeat=0, loop_count=0))
    wait_trace(fppd, "512")
    assert status(fppd).get("repeat_mode") == 1, "the reload dropped the running playlist's repeat"
    wait_idle(fppd, timeout=20)
    assert trace(fppd) == "51228"


def test_edit_that_does_not_load_keeps_the_running_playlist(fppd):
    """An edit fppd can't use -- a half-written file, then one whose
    "repeat" is a word -- leaves the playing copy running: each is logged
    as such, and the next pass is still the old main section. A good edit
    after them is picked up at the end of the next pass."""
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(3)]))
    fppd.start()
    start(fppd, "P", repeat=True)
    wait_trace(fppd, "1")
    good = playlist("P", main=[step(2), pause(3)])

    # Not JSON at all: LoadJSON hands back null and ReloadPlaylist bails.
    edit(fppd, "P", json.dumps(good)[:40], bump=60)
    wait_trace(fppd, "11")
    wait_log(fppd, "got no usable playlist from")
    wait_log(fppd, "Error reloading playlist, continuing with existing copy.")

    # Parses, but Load() throws on the type and keeps what is loaded.
    bad = dict(good, repeat="often")
    edit(fppd, "P", bad, bump=120)
    wait_trace(fppd, "111")
    wait_log(fppd, "Playlist P is invalid")
    assert status_name(fppd) == "playing"

    edit(fppd, "P", good, bump=180)
    wait_trace(fppd, "1112")
    fppd.command("Stop Now")
    wait_idle(fppd)


def test_graceful_stop_plays_the_edited_lead_out(fppd):
    """Stop Gracefully mid-entry lets that entry finish, then plays the
    lead-out of the file as it is now (edited during that entry), not the
    one loaded at start, and goes idle; the rest of the main section is
    skipped. The PLAYLIST_STOPPING_GRACEFULLY preset runs when the stop is
    asked for, with the playlist's name."""
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(4), step(2)],
                                            lead_out=[step(9)]))
    fppd.write("config/commandPresets.json", {"commands": preset(
        "PLAYLIST_STOPPING_GRACEFULLY",
        ("Set Variable", "graceful", "Value", "%PLAYLIST_NAME%", "1", "0", "100", ""))})
    fppd.start()
    start(fppd, "P")
    wait_trace(fppd, "1")
    # All in the 4 s pause.
    edit(fppd, "P", playlist("P", main=[step(1), pause(4), step(2)], lead_out=[step(8)]))
    fppd.command("Stop Gracefully")
    fppd.wait_for(lambda: variable(fppd, "graceful") == "P", timeout=3, interval=0.1,
                  what="the PLAYLIST_STOPPING_GRACEFULLY preset to run")
    assert status_name(fppd) == "stopping gracefully"
    wait_idle(fppd, timeout=15)
    assert trace(fppd) == "18"


def test_graceful_stop_after_loop_finishes_the_pass(fppd):
    """Stop Gracefully "after loop" on a repeating playlist plays the rest
    of the current pass, then the lead-out -- that of the file as edited
    meanwhile -- and goes idle instead of repeating. The
    PLAYLIST_STOPPING_AFTER_LOOP preset runs when the stop is asked for,
    with the playlist's name."""
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(4), step(2)],
                                            lead_out=[step(9)]))
    fppd.write("config/commandPresets.json", {"commands": preset(
        "PLAYLIST_STOPPING_AFTER_LOOP",
        ("Set Variable", "afterLoop", "Value", "%PLAYLIST_NAME%", "1", "0", "100", ""))})
    fppd.start()
    start(fppd, "P", repeat=True)
    wait_trace(fppd, "1")
    # All in the 4 s pause.
    edit(fppd, "P", playlist("P", main=[step(1), pause(4), step(2)], lead_out=[step(8)]))
    fppd.command("Stop Gracefully", "true")
    fppd.wait_for(lambda: variable(fppd, "afterLoop") == "P", timeout=3, interval=0.1,
                  what="the PLAYLIST_STOPPING_AFTER_LOOP preset to run")
    assert status_name(fppd) == "stopping gracefully after loop"
    wait_idle(fppd, timeout=15)
    assert trace(fppd) == "128"


def test_stop_now_runs_its_presets_in_order(fppd):
    """Stop Now mid-entry ends the playlist at once: the rest of the entry,
    the main section and the lead-out never run. The PLAYLIST_STARTED
    preset ran when it started, and PLAYLIST_STOPPING_NOW then
    PLAYLIST_STOPPED when it stopped, in that order, each with the
    playlist's name."""
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(30), step(2)],
                                            lead_out=[step(9)]))
    events = ("Set Variable", "events", "Expression", "", "1", "0", "100", "=events*10+{}", "false")
    fppd.write("config/commandPresets.json", {"commands":
        preset("PLAYLIST_STARTED",
               ("Set Variable", "started", "Value", "%PLAYLIST_NAME%", "1", "0", "100", ""),
               tuple(a.format(1) for a in events)) +
        preset("PLAYLIST_STOPPING_NOW",
               ("Set Variable", "stoppingNow", "Value", "%PLAYLIST_NAME%", "1", "0", "100", ""),
               tuple(a.format(2) for a in events)) +
        preset("PLAYLIST_STOPPED", tuple(a.format(3) for a in events))})
    fppd.start()
    fppd.command("Set Variable", "events", "Value", "0", "1", "0", "100", "")
    start(fppd, "P")
    wait_trace(fppd, "1")
    fppd.wait_for(lambda: variable(fppd, "started") == "P", timeout=5, interval=0.1,
                  what="the PLAYLIST_STARTED preset to run")
    fppd.command("Stop Now")
    wait_idle(fppd, timeout=5)  # well inside the 30 s pause
    fppd.wait_for(lambda: variable(fppd, "stoppingNow") == "P", timeout=5, interval=0.1,
                  what="the PLAYLIST_STOPPING_NOW preset to run")
    fppd.wait_for(lambda: float(variable(fppd, "events") or 0) == 123, timeout=5, interval=0.1,
                  what="PLAYLIST_STOPPED to run after PLAYLIST_STOPPING_NOW")
    time.sleep(1)
    assert trace(fppd) == "1", "an entry ran after Stop Now"


def test_debug_log_dumps_the_loaded_playlist(fppd):
    """With the Playlist log at debug, loading a playlist logs what was
    loaded: its name, description, repeat and loop count, each section's
    entries by type, and "(No Lead Out)" for an empty lead-out."""
    fppd.settings(LogLevel_Playlist="debug")
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(30)],
                                            repeat=1, loop_count=4, desc="dump check"))
    fppd.start()
    start(fppd, "P")
    wait_trace(fppd, "1")
    log = fppd.log()
    at = log.find("Playlist: P\n")
    assert at >= 0, "no dump of the loaded playlist"
    dump = log[at:].splitlines()
    want = ["Playlist: P", "  Description      : dump check", "  Repeat           : 1",
            "  Loop Count       : 4", "  Lead In:", "  Main Playlist:",
            "  Lead Out         : (No Lead Out)"]
    seen = [w for w in want if any(line.endswith(w) for line in dump[:40])]
    assert seen == want, f"dump is missing {sorted(set(want) - set(seen))}:\n" + "\n".join(dump[:40])
    # Lead-in: the trace reset (a command); main: a command and a pause.
    types = [line.split("Entry Type: ", 1)[1] for line in dump[:40] if "Entry Type: " in line]
    assert types[:3] == ["command", "command", "pause"], types
    fppd.command("Stop Now")
    wait_idle(fppd)


def test_mqtt_playlist_details(fppd):
    """With MQTTFrequency set, fppd publishes playlist_details every period:
    while a playlist plays, its status, name, repeat, description and the
    current entry's type; once stopped, "idle" with no active playlists."""
    from test_mqtt_control import HOST, PORT, broker
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST, MQTTFrequency="1")
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(60)], desc="mqtt check"))
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
        try:
            fppd.start()
            start(fppd, "P", repeat=True)
            wait_trace(fppd, "1")

            def next_message(pred, what, timeout=15):
                end = time.monotonic() + timeout
                while (left := end - time.monotonic()) > 0:
                    try:
                        msg = messages.get(timeout=left)
                    except queue.Empty:
                        break
                    if pred(msg):
                        return msg
                raise AssertionError(f"no playlist_details message {what}")

            playing = next_message(lambda m: m.get("status") == "playing", "while playing")
            assert playing["activePlaylists"] == [{
                "name": "P", "repeat": 1, "description": "mqtt check",
                "currentItems": [{"type": "pause", "playOnce": 0}]}], playing
            fppd.command("Stop Now")
            wait_idle(fppd)
            idle = next_message(lambda m: m.get("status") == "idle", "once stopped")
            assert idle["activePlaylists"] == [], idle
        finally:
            sub.terminate()
            sub.wait(timeout=5)
