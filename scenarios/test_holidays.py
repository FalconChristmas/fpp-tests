"""Holidays the scheduler knows by name: the locale's tables plus the user's
own, from config/user-holidays.json. Both can change while fppd runs (the
holiday editor on the Scheduler page, the Locale setting), and a schedule
reload after the change has to see them."""

import datetime
import math
import time

import pytest

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


def islamic_date(hijri_year, month, day=1):
    """The tabular (arithmetic) Islamic calendar's Gregorian date: the
    standard civil epoch, 30-year leap cycle. Observed dates can differ by a
    day, which the check allows."""
    jdn = day + math.ceil(29.5 * (month - 1)) + (hijri_year - 1) * 354 + \
        (3 + 11 * hijri_year) // 30 + 1948440 - 1
    return datetime.date.fromordinal(jdn - 1721425)


# (holiday, Hijri year, Islamic month) for the first occurrence in each
# Gregorian year from 2030: Ramadan 1451 starts in January 2030 and 1452 in
# December, so 2031's is 1453.
ISLAMIC = [("Ramadan", 1451, 9), ("Ramadan", 1453, 9), ("Ramadan", 1454, 9),
           ("Ramadan", 1455, 9), ("Ramadan", 1456, 9), ("Ramadan", 1457, 9),
           ("EidAlFitr", 1451, 10), ("EidAlFitr", 1452, 10), ("EidAlFitr", 1453, 10),
           ("EidAlFitr", 1454, 10), ("EidAlFitr", 1456, 10), ("EidAlFitr", 1457, 10)]


@pytest.mark.parametrize("name, hijri, month", ISLAMIC,
                         ids=[f"{n}-{islamic_date(h, m).year}" for n, h, m in ISLAMIC])
def test_islamic_holidays_fall_on_their_dates(fppd, name, hijri, month):
    """An entry on Ramadan or Eid al-Fitr runs on that year's date (within
    a day of the tabular Islamic calendar).

    Regression: 5f90e21ce. The lookup tables from 2031 (Ramadan) and 2034
    (Eid) on held the previous Gregorian year's date, 11 or 12 days late:
    Ramadan 2032 on December 15 instead of the 4th."""
    want = islamic_date(hijri, month)
    show(fppd)
    fppd.write("config/schedule.json", [entry(7, "19:00:00", "20:00:00",
                                              startDate=name, endDate=name)])
    fppd.start(fake_time=f"{(want - datetime.timedelta(days=5)).isoformat()} 12:00:00", tz=ZONE)
    days = scheduled_days(fppd)
    assert len(days) == 1 and abs((next(iter(days)) - want).days) <= 1, \
        f"{name} {want.year} is about {want}; scheduled on {sorted(days)[:5]}"
