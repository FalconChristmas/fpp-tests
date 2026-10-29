"""The scheduler's guard against a clock that is obviously wrong: a box with
no RTC boots with the time its filesystem was last written, and a schedule
run on that time starts the wrong show. fppd holds the scheduler, at
startup and in its main loop, while the clock reads earlier than the latest
FPP release it knows of (the newest release_date in the tree's
rpi-imager/rpi-imager_falcon_player.json)."""

import datetime
import json
import os
import time

TZ = "UTC"


def latest_release(fppd):
    with open(os.path.join(fppd.tree, "rpi-imager", "rpi-imager_falcon_player.json")) as f:
        dates = [e["release_date"] for e in json.load(f)["os_list"] if "release_date" in e]
    return datetime.date.fromisoformat(max(dates))


def install(fppd, day, start, end):
    """A playlist that plays for ten minutes and a daily entry running it
    from `start` to `end`, valid for years either side of `day`."""
    fppd.write("playlists/Show.json", {
        "name": "Show", "repeat": 0, "loopCount": 0, "leadIn": [], "leadOut": [],
        "mainPlaylist": [{"type": "pause", "enabled": 1, "playOnce": 0, "duration": 600}]})
    fppd.write("config/schedule.json", [{
        "enabled": 1, "day": 7, "playlist": "Show", "startTime": start, "endTime": end,
        "startDate": f"{day.year - 5}-01-01", "endDate": f"{day.year + 5}-12-31",
        "repeat": 0, "stopType": 0}])


def playing(fppd):
    return fppd.get("/fppd/status").get("status_name") == "playing"


def test_scheduler_does_not_start_an_entry_while_the_clock_is_years_behind(fppd):
    """With the clock in 2019, an entry due to start a few seconds after
    fppd is up is not started when its time comes.

    Regression: 827337660. The clock was checked only before the startup
    CheckIfShouldBePlayingNow(); the main loop called ScheduleProc() on every
    pass whatever the clock said, so the first entry to come due on the
    wrong clock started anyway."""
    day = datetime.date(2019, 3, 1)
    install(fppd, day, "12:00:20", "12:30:00")
    fppd.start(fake_time=f"{day.isoformat()} 12:00:10", tz=TZ)
    assert not playing(fppd), "playing before the entry's start time, so this proves nothing"
    assert "Clock appears incorrect" in fppd.log(), fppd.tail()
    time.sleep(16)  # past 12:00:20
    assert not playing(fppd), f"the scheduler started the entry on a 2019 clock\n{fppd.tail()}"


def test_a_clock_months_behind_the_latest_release_is_not_trusted(fppd):
    """With the clock 60 days before the newest FPP release (well inside
    six years of the year fppd was built), an entry already running at startup is not
    started, and the log says the clock is before the release.

    Regression: ef0d1d1d4. The clock counted as valid from six years before
    the build year, so a box that booted on a filesystem time from earlier
    in the same year -- a date no FPP release could be running on -- ran its
    schedule on that time."""
    day = latest_release(fppd) - datetime.timedelta(days=60)
    install(fppd, day, "11:00:00", "13:00:00")
    fppd.start(fake_time=f"{day.isoformat()} 12:00:00", tz=TZ)
    time.sleep(3)
    assert not playing(fppd), f"the scheduler ran on a clock before the latest release\n{fppd.tail()}"
    assert "before release), delaying scheduler start" in fppd.log(), fppd.tail()
