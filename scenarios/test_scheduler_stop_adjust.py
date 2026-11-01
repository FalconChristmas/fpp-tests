"""A scheduled playlist whose end was moved while it plays: it isn't started
again by the scheduler."""

import time

import pytest

from test_scheduler import STOP_GRACEFUL, STOP_HARD, playing, reload_schedule, scheduled_show, status

STARTING = "Starting Scheduled Playlist"


def starts(fppd):
    return fppd.log().count(STARTING)


@pytest.mark.parametrize("stop_type", [STOP_HARD, STOP_GRACEFUL])
def test_a_playlist_ended_early_is_not_restarted_by_the_schedule(fppd, stop_type):
    """Extend Schedule with a negative number ends the running scheduled
    playlist early, and the scheduler leaves it stopped for the rest of its
    window rather than starting it again.

    Regression: c12aa23b2 (#1171). The end-time stop called the playlist's
    stop directly instead of the player's, so the stop wasn't recorded as a
    forced one and the scheduler, finding the window still open, restarted
    the playlist a second later."""
    scheduled_show(fppd, -60, 300, stop_type=stop_type)
    fppd.settings(LogLevel_Schedule="debug")
    fppd.start()
    fppd.wait_for(lambda: playing(fppd), timeout=30, interval=0.5, what="the scheduled playlist")
    assert starts(fppd) == 1, "the log never shows the scheduler starting the playlist: the check below is blind"
    fppd.command("Extend Schedule", "-290", "0")
    # Stopped, or started again (the stop and the restart can fall between
    # two polls).
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle" or starts(fppd) > 1,
                  timeout=20, interval=0.1, what="the playlist to stop at the earlier end")
    time.sleep(4)
    assert starts(fppd) == 1 and status(fppd).get("status_name") == "idle", \
        "the scheduler started the playlist again after it was ended early"


def test_reloading_the_schedule_does_not_restart_an_extended_playlist(fppd):
    """Moving the end of a running scheduled playlist (Extend Schedule) and
    then reloading the schedule leaves it playing: the scheduler recognises
    it as the occurrence it started.

    Guards 86898d5d2 (the scheduler compared the reloaded occurrence's end
    with the playlist's moved end only, so it took the extended playlist for
    a different one). Not red on its own today: a reload also matches the
    occurrence against the ones already run (same start and end), so
    dropping that comparison leaves this green."""
    scheduled_show(fppd, -60, 300)
    fppd.settings(LogLevel_Schedule="debug")
    fppd.start()
    fppd.wait_for(lambda: playing(fppd), timeout=30, interval=0.5, what="the scheduled playlist")
    assert starts(fppd) == 1
    assert fppd.command("Extend Schedule", "30", "0") == "Schedule Updated"
    reload_schedule(fppd)
    time.sleep(4)
    assert playing(fppd)
    assert starts(fppd) == 1, "reloading the schedule started the extended playlist again"
    # The occurrence it is playing is spent, so it isn't listed as the next
    # one to run.
    upcoming = status(fppd).get("next_playlist") or {}
    assert upcoming.get("playlist") in (None, "") or upcoming["playlist"].startswith("No playlist"), \
        f"the playlist that is playing is still listed as scheduled next: {upcoming}"
