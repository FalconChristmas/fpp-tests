"""The PLAYLIST_* command presets fppd runs around playlist transitions."""

import time

from test_command_presets import variable
from test_playlist_commands import start, status_name, wait_idle, wait_trace
from test_playlist_entries import pause, playlist, step


def preset(name, *commands):
    """One preset entry per command, all under one preset name."""
    return [{"name": name, "command": c[0], "args": list(c[1:]), "presetSlot": 0}
            for c in commands]


def test_stop_now_stopped_preset_leaves_the_resumed_parent_playing(fppd):
    """A PLAYLIST_STOPPED preset that runs Stop Now does not stop the playlist
    an inserted one hands back to: the preset still runs when the inserted
    playlist ends, and the parent carries on.

    Regression for #3114 (fixed by 3080bab59): since presets were deferred to the end of a
    transition (339be2612), the inserted playlist's PLAYLIST_STOPPED ran after
    the parent had resumed, and its Stop Now stopped the parent -- a show
    went dark after every Remote Falcon request. FPP 9 ran it while the
    inserted playlist was still current, where Stop Now did nothing.
    """
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(30), step(2)]))
    fppd.write("playlists/Q.json", {"name": "Q", "repeat": 0, "loopCount": 0, "leadIn": [],
                                    "mainPlaylist": [step(7)], "leadOut": []})
    fppd.write("config/commandPresets.json", {"commands": preset(
        "PLAYLIST_STOPPED",
        ("Set Variable", "stopped", "Value", "seen", "1", "0", "100", ""),
        ("Stop Now",))})
    fppd.start()
    start(fppd, "P")
    wait_trace(fppd, "1")
    fppd.command("Insert Playlist Immediate", "Q", "0", "0", "false")
    wait_trace(fppd, "17", timeout=5)
    fppd.wait_for(lambda: variable(fppd, "stopped") == "seen", timeout=5, interval=0.1,
                  what="the inserted playlist's PLAYLIST_STOPPED preset to run")
    time.sleep(1.5)
    assert status_name(fppd) == "playing", \
        "the PLAYLIST_STOPPED preset's Stop Now stopped the playlist the inserted one handed back to"

    # Ending the parent itself still stops: the preset is not disarmed.
    fppd.command("Set Variable", "stopped", "Value", "", "1", "0", "100", "")
    fppd.command("Next Playlist Item")
    wait_idle(fppd)
    fppd.wait_for(lambda: variable(fppd, "stopped") == "seen", timeout=5, interval=0.1,
                  what="PLAYLIST_STOPPED to run when the parent ends")


def test_a_hard_stop_whose_stopped_preset_starts_a_playlist_ends(fppd):
    """A schedule window that ends with a hard stop, and a PLAYLIST_STOPPED
    preset that starts another playlist ("play something after the show"):
    the scheduled playlist stops once, the preset's playlist then plays, and
    fppd keeps answering.

    Regression: 11a12675a. The hard stop looped "while not idle: Stop Now".
    The preset ran inline as the playlist stopped and started the next one,
    so the status was playing again and the loop stopped it, which fired the
    preset again -- forever, on the main loop, until the stall watchdog
    restarted fppd.
    """
    from test_scheduler import STOP_HARD, schedule_entry, window
    fppd.write("playlists/Show.json", playlist("Show", main=[pause(600)]))
    fppd.write("playlists/Idle.json", playlist("Idle", main=[pause(600)]))
    fppd.write("config/commandPresets.json", {"commands": preset(
        "PLAYLIST_STOPPED",
        ("Set Variable", "stops", "Expression", "", "1", "0", "100", "=stops+1", "false"),
        ("Start Playlist", "Idle", "true", "false"))})
    start_at, end_at = window(-60, 20)
    fppd.write("config/schedule.json", [schedule_entry("Show", start_at, end_at, stop_type=STOP_HARD)])
    fppd.start()
    fppd.command("Set Variable", "stops", "Value", "0", "1", "0", "100", "")
    status = lambda: fppd.get("/fppd/status", timeout=3)
    fppd.wait_for(lambda: status().get("current_playlist", {}).get("playlist") == "Show",
                  timeout=30, interval=0.5, what="the scheduled playlist to start")
    fppd.wait_for(lambda: status().get("current_playlist", {}).get("playlist") == "Idle",
                  timeout=30, interval=0.5, what="the preset's playlist to take over after the hard stop")
    time.sleep(3)
    s = status()
    assert s.get("status_name") == "playing" and s["current_playlist"]["playlist"] == "Idle", s
    assert float(variable(fppd, "stops")) == 1, \
        f"PLAYLIST_STOPPED ran {variable(fppd, 'stops')} times for one hard stop"


def test_start_while_paused_stops_the_paused_playlist(fppd):
    """A start of the paused playlist (Start Playlist At Item) stops it as a
    stop would -- its PLAYLIST_STOPPED preset runs -- and it plays again
    from the item.

    Regression: 018f7fd38. A paused playlist didn't count as running, so
    the start went straight to loading the new one over it: the paused
    entry was dropped without being stopped, and no stop callback or
    PLAYLIST_STOPPED preset ran.
    """
    from test_playlist_commands import wait_in_pause
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(30)]))
    fppd.write("config/commandPresets.json", {"commands": preset(
        "PLAYLIST_STOPPED", ("Set Variable", "stopped", "Value", "seen", "1", "0", "100", ""))})
    fppd.start()
    start(fppd, "P")
    wait_in_pause(fppd, "1")
    fppd.command("Pause Playlist")
    fppd.wait_for(lambda: status_name(fppd) == "paused", what="status paused")
    # Row 2 is step 1 (row 1 is the lead-in's reset, skipped this way).
    fppd.command("Start Playlist At Item", "P", "2", "true", "false")
    wait_trace(fppd, "11")
    fppd.wait_for(lambda: variable(fppd, "stopped") == "seen", timeout=5, interval=0.1,
                  what="PLAYLIST_STOPPED for the paused playlist")
    fppd.command("Stop Now")
    wait_idle(fppd)
