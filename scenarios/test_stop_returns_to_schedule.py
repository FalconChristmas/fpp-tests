"""Stopping a playlist started by hand inside a schedule window hands the
player back to the scheduler."""

import os
import time

from fseq import solid_frames, write_fseq
from show import CHANNELS, install, playlist, sequence_entry, status
from test_scheduler import schedule_entry, window


def current(fppd):
    s = status(fppd)
    return s.get("status_name"), (s.get("current_playlist") or {}).get("playlist")


def test_stop_now_of_a_manual_playlist_returns_to_the_schedule(fppd):
    """Start another playlist over a scheduled one, Stop Now it, and the
    scheduled playlist plays again. Five times over, because the bug lost
    the stop in a window of a few milliseconds.

    Regression: the main loop treated "stopping now", which a Stop Now holds
    while the entry stops, as not playing, so a pass that read it never saw
    the change to idle: the stopped playlist was not cleaned up and the
    scheduler was not asked, and the player sat idle inside the window.
    Fixed by bdc71586c.
    """
    install(fppd, solid_frames(40, CHANNELS, 50))
    write_fseq(os.path.join(fppd.media, "sequences", "Other.fseq"), solid_frames(40, CHANNELS, 90),
               step_ms=50)
    fppd.write("playlists/Other.json", playlist("Other", [sequence_entry("Other.fseq")], repeat=1))
    start, end = window(-60, 600)
    fppd.write("config/schedule.json", [schedule_entry("Show", start, end)])
    fppd.start()
    fppd.wait_for(lambda: current(fppd) == ("playing", "Show"), timeout=30, interval=0.5,
                  what="the scheduled playlist to start")
    for i in range(5):
        fppd.command("Start Playlist", "Other", "true", "false")
        fppd.wait_for(lambda: current(fppd) == ("playing", "Other"), timeout=10, interval=0.2,
                      what=f"the manual playlist to start (round {i + 1})")
        time.sleep(1.5)
        fppd.command("Stop Now")
        fppd.wait_for(lambda: current(fppd) == ("playing", "Show"), timeout=10, interval=0.2,
                      what=f"the scheduled playlist to play again after Stop Now (round {i + 1})")


def test_starts_and_stops_from_several_threads_in_a_schedule_window(fppd):
    """Playlists started and stopped from MQTT and over HTTP at once, while
    a schedule window is open and the scheduler checks the player every
    second: fppd keeps answering and taking commands, and settles once they
    stop.

    Regression: 49e2b966e and 6827666c7. The player's playlist name, start
    and stop times and force-stop state were written by whichever thread
    started or stopped a playlist and read by the scheduler and status with
    no lock; two threads assigning the name at once could free its buffer
    twice (49e2b966e). The playlist's own repeat flag, schedule entry and
    name were still read with no lock on the MQTT thread -- a Start
    Playlist logging GetRepeat() while the scheduler's load cleared it
    (6827666c7). A race: it fails only in the TSan build (run.sh --flavor
    tsan); elsewhere this is coverage.
    """
    import threading
    from test_mqtt_control import HOST, PORT, broker, _publish_many
    install(fppd, solid_frames(40, CHANNELS, 50))
    write_fseq(os.path.join(fppd.media, "sequences", "Other.fseq"), solid_frames(40, CHANNELS, 90),
               step_ms=50)
    fppd.write("playlists/Other.json", playlist("Other", [sequence_entry("Other.fseq")], repeat=1))
    start, end = window(-60, 600)
    fppd.write("config/schedule.json", [schedule_entry("Show", start, end)])
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    with broker():
        fppd.start()
        fppd.wait_for(lambda: current(fppd) == ("playing", "Show"), timeout=30, interval=0.5,
                      what="the scheduled playlist to start")
        probe = f"falcon/player/{HOST}/set/probe"
        fppd.wait_for(lambda: (_publish_many([probe]) or probe in fppd.get("/fppd/mqtt/cache")),
                      timeout=30, interval=1, what="fppd to connect to the broker")
        stop = threading.Event()

        def mqtt():
            while not stop.is_set():
                _publish_many([f"falcon/player/{HOST}/set/playlist/Other/start",
                               f"falcon/player/{HOST}/set/playlist/ALLPLAYLISTS/stop/now"])
                time.sleep(0.15)

        def poll():
            while not stop.is_set():
                fppd.get("/fppd/status", timeout=10)
                fppd.get("/fppd/schedule", timeout=10)

        threads = [threading.Thread(target=mqtt, daemon=True),
                   threading.Thread(target=poll, daemon=True)]
        for t in threads:
            t.start()
        try:
            for _ in range(15):
                fppd.command("Start Playlist", "Other", "true", "false")
                time.sleep(0.2)
                fppd.command("Stop Now")
                time.sleep(0.2)
        finally:
            stop.set()
            for t in threads:
                t.join(15)
        # Whether Show comes back is not asserted: the streams interleave
        # freely, and a stop that lands on Show after the scheduler restored
        # it is a force stop of the scheduled playlist, which keeps it off for
        # the rest of its window by design.
        time.sleep(1)
        fppd.command("Start Playlist", "Other", "true", "false")
        fppd.wait_for(lambda: current(fppd) == ("playing", "Other"), timeout=10, interval=0.2,
                      what="Other to start once the streams stop")
        fppd.command("Stop Now")
        fppd.wait_for(lambda: (lambda c: c == ("playing", "Show") or c[0] == "idle")(current(fppd)),
                      timeout=20, interval=0.5, what="the player to settle after the last stop")


def test_stop_now_of_the_scheduled_playlist_keeps_it_stopped(fppd):
    """Stop Now on the playlist the schedule started, inside a window whose
    entry repeats: the player stays idle, and the scheduler does not start
    the entry again over the next several passes.

    Regression: 272a975fb. The main loop asked the scheduler what should be
    playing after any stop, and a repeating entry still in its window was
    started again at once, so a user could not stop a scheduled show. The
    fix passes the stopped entry (CheckIfShouldBePlayingNow's forceStopped)
    and the scheduler leaves that entry alone. 1fae361cb added a second
    guard (ShouldStart() skips the item a force stop came from), so on
    master either one keeps the show stopped: shown red with both undone.
    A one-second sequence, so a playlist that came back would be seen
    playing within the wait."""
    install(fppd, solid_frames(20, CHANNELS, 50))
    start, end = window(-60, 600)
    fppd.write("config/schedule.json", [schedule_entry("Show", start, end, repeat=1)])
    fppd.start()
    fppd.wait_for(lambda: current(fppd) == ("playing", "Show"), timeout=30, interval=0.5,
                  what="the scheduled playlist to start")
    fppd.command("Stop Now")
    time.sleep(1)  # the stop itself
    seen = []
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        seen.append(current(fppd))
        time.sleep(0.2)
    back = [s for s in seen if s[0] != "idle"]
    assert not back, (f"the scheduled playlist came back after Stop Now: {len(back)} of "
                      f"{len(seen)} samples over 8 s were {sorted(set(back))}")
