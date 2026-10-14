"""Holidays the scheduler knows by name: the locale's tables plus the user's
own, from config/user-holidays.json. Both can change while fppd runs (the
holiday editor on the Scheduler page, the Locale setting), and a schedule
reload after the change has to see them."""

import datetime
import time

from test_schedule_calendar import YEAR, ZONE, entry
from test_schedule_config import easter
from test_scheduler import reload_schedule


def scheduled_days(fppd):
    from zoneinfo import ZoneInfo
    got = fppd.get("/fppd/schedule")["schedule"]["items"]
    return {datetime.datetime.fromtimestamp(i["startTime"], ZoneInfo(ZONE)).date() for i in got}


def days_after_reload(fppd, want, timeout=10):
    """Reload the schedule until it is scheduled on `want` or `timeout`
    passes, and return the days it is scheduled on. A reload is queued for
    the main loop, and a settings change is noticed asynchronously, so one
    reload read back at once can be too early."""
    deadline = time.monotonic() + timeout
    while True:
        reload_schedule(fppd)
        time.sleep(0.5)
        days = scheduled_days(fppd)
        if days == want or time.monotonic() > deadline:
            return days


def show(fppd):
    fppd.write("playlists/Show.json", {"name": "Show", "repeat": 0, "loopCount": 0,
                                       "leadIn": [], "leadOut": [], "mainPlaylist": []})


def test_user_holiday_added_while_running_is_scheduled(fppd):
    """A holiday added in the holiday editor while fppd runs is known to the
    next schedule reload, so an entry naming it runs on that day only.

    Regression: f97987d31. fppd read the holiday tables once and cached them. The
    editor asked fppd to clear the cache over the command socket with a
    command the socket doesn't have, so fppd kept the old tables, didn't know
    the new name, and ran the entry across its whole date range until it was
    restarted.
    """
    day = datetime.date(YEAR, 6, 20)
    show(fppd)
    fppd.write("config/schedule.json", [entry(7, "19:00:00", "20:00:00",
                                              startDate="FamilyDay", endDate="FamilyDay")])
    fppd.start(fake_time=f"{YEAR}-06-15 12:00:00", tz=ZONE)
    fppd.write("config/user-holidays.json", [{"name": "Family Day", "shortName": "FamilyDay",
                                              "year": 0, "month": day.month, "day": day.day}])
    days = days_after_reload(fppd, {day})
    assert days == {day}, f"FamilyDay is {day}; scheduled on {sorted(days)[:5]}"


def test_locale_changed_while_running_is_used(fppd):
    """Changing the Locale setting while fppd runs switches the holiday
    table the next schedule reload uses: Mothering Sunday is a UK holiday,
    unknown to the Global table.

    Regression: f97987d31. The cached table was never dropped when Locale changed, so
    fppd kept scheduling with the old locale's holidays until restarted.
    """
    want = easter(YEAR) - datetime.timedelta(days=21)
    show(fppd)
    fppd.write("config/schedule.json", [entry(7, "10:00:00", "11:00:00",
                                              startDate="MotheringSunday",
                                              endDate="MotheringSunday")])
    fppd.start(fake_time=f"{(want - datetime.timedelta(days=5)).isoformat()} 12:00:00", tz=ZONE)
    assert scheduled_days(fppd) != {want}, "Global already knows Mothering Sunday; this proves nothing"
    fppd.settings(Locale="UK")
    days = days_after_reload(fppd, {want})
    assert days == {want}, f"Mothering Sunday {YEAR} is {want}; scheduled on {sorted(days)[:5]}"
