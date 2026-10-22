"""What the scheduler reports about itself: the times in its status, and the
warning for an entry whose playlist is missing."""

import datetime
import os
import time

import shims
from fseq import solid_frames
from show import CHANNELS, install, status
from test_scheduler import reload_schedule, schedule_entry, window


def test_scheduler_status_shows_the_current_time(fppd):
    """While a scheduled playlist plays, the scheduler's status gives the
    current time as a string that agrees with its number.

    Regression: 801405240. currentTimeStr was formatted from a variable still
    holding 0, so it read 1970-01-01 next to a correct currentTime."""
    install(fppd, solid_frames(40, CHANNELS, 55))
    start, end = window(-60, 600)
    fppd.write("config/schedule.json", [schedule_entry("Show", start, end)])
    fppd.settings(DateFormat="%Y-%m-%d", TimeFormat="%H:%M:%S")
    fppd.start()
    fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", timeout=30,
                  interval=0.5, what="the scheduled playlist to start")
    current = status(fppd)["scheduler"]["currentPlaylist"]
    now = datetime.datetime.fromtimestamp(current["currentTime"])
    assert current["currentTimeStr"] == now.strftime("%Y-%m-%d @ %H:%M:%S"), current


def test_missing_playlist_warning_names_it_and_comes_down(fppd):
    """A scheduled playlist deleted while the schedule loads gets the warning
    "Scheduled Playlist '<name>' does not exist", and the warning comes down
    once the playlist is back and the schedule reloaded.

    Regression: 549f8a1d7. The scheduler built the warning twice; the copy
    used when expanding an entry's times assigned where it meant to append,
    so it read " 'Gone' does not exist", and the removal, which matches the
    text exactly, never took that one down."""
    install(fppd, solid_frames(40, CHANNELS, 55), playlist_name="Gone")
    playlist = os.path.join(fppd.media, "playlists", "Gone.json")
    with open(playlist) as f:
        saved = f.read()
    start, end = window(300, 600)
    fppd.write("config/schedule.json", [schedule_entry("Gone", start, end)])
    arm = os.path.join(fppd.media, "tmp", "statgone-arm")
    fppd.start(preload=[shims.build("statgone.c")],
               extra_env={"STATGONE_SUFFIX": "/playlists/Gone.json", "STATGONE_ARM": arm})

    def about_gone():
        return [w for w in status(fppd).get("warnings", []) if "Gone" in w]

    # Deleted between the loader's check and the expansion's.
    open(arm, "w").close()
    reload_schedule(fppd)
    fppd.wait_for(lambda: not os.path.exists(playlist), timeout=10, what="the playlist to be deleted")
    fppd.wait_for(about_gone, timeout=10, what="a warning about the missing playlist")
    assert about_gone() == ["Scheduled Playlist 'Gone' does not exist"], about_gone()

    with open(playlist, "w") as f:
        f.write(saved)
    reload_schedule(fppd)
    time.sleep(3)
    assert not about_gone(), f"the warning stayed up with the playlist back: {about_gone()}"
