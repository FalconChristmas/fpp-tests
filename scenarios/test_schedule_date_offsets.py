"""Day offsets on holiday-anchored schedule dates ("7 days before
Thanksgiving", "Christmas + 2"), and schedule.json offsets fppd can't read.

As in test_holidays, fppd's clock is faked to the day in question and the
days it has scheduled are read back from GET /fppd/schedule."""

import datetime

from show import status
from test_holidays import scheduled_days, show
from test_schedule_calendar import YEAR, ZONE, entry


def thanksgiving(year):
    d = datetime.date(year, 11, 1)
    d += datetime.timedelta(days=(3 - d.weekday()) % 7)  # first Thursday
    return d + datetime.timedelta(weeks=3)


def scheduled(fppd, entries, today):
    show(fppd)
    fppd.settings(Locale="USA")
    fppd.write("config/schedule.json", entries)
    fppd.start(fake_time=f"{today.isoformat()} 12:00:00", tz=ZONE)
    return scheduled_days(fppd)


def test_start_offset_before_a_holiday(fppd):
    """A schedule from "Thanksgiving" with a start offset of -7 days to
    Christmas is running five days before Thanksgiving.

    Feature: 3db2b02d6."""
    tg = thanksgiving(YEAR)
    today = tg - datetime.timedelta(days=5)
    days = scheduled(fppd, [entry(7, "19:00:00", "20:00:00", startDate="Thanksgiving",
                                  startDateOffset=-7, endDate="Christmas")], today)
    assert today in days, f"Thanksgiving {YEAR} is {tg}; scheduled from {min(days, default=None)}"


def test_end_offset_after_a_holiday(fppd):
    """A schedule to "Christmas" with an end offset of +2 days still runs on
    December 26 and 27, and not on the 28th.

    Feature: 3db2b02d6. With an offset, the range rolls on to next year only
    once the offset date has passed, not the holiday itself."""
    today = datetime.date(YEAR, 12, 26)
    days = scheduled(fppd, [entry(7, "19:00:00", "20:00:00", startDate="Thanksgiving",
                                  endDate="Christmas", endDateOffset=2)], today)
    this_year = {d for d in days if d.year == YEAR}
    assert this_year == {today, today + datetime.timedelta(days=1)}, sorted(days)[:5]


def test_malformed_date_offset_counts_as_zero(fppd):
    """Date offsets that aren't numbers -- an object, an array, a fraction --
    don't stop fppd loading the schedule: each such entry is scheduled with
    no offset, with a warning naming the field. A null offset is no offset.

    Regression: aabdc187a. The offsets were read with asLargestInt(), which
    throws on an object or an array, so fppd died loading the schedule (and
    again on every restart); since 903dc31e6 the entry is skipped instead,
    which is still wrong: it is the offset that is bad, not the entry."""
    today = datetime.date(YEAR, 6, 10)
    bad = [{"x": 1}, [1], 1.5]
    entries = [entry(7, f"{18 + i}:00:00", f"{18 + i}:30:00", startDate=f"{YEAR}-06-01",
                     startDateOffset=v, endDateOffset=None) for i, v in enumerate(bad)]
    show(fppd)
    fppd.write("config/schedule.json", entries)
    fppd.start(fake_time=f"{today.isoformat()} 12:00:00", tz=ZONE)
    from zoneinfo import ZoneInfo
    got = fppd.get("/fppd/schedule")["schedule"]["items"]
    starts = {datetime.datetime.fromtimestamp(i["startTime"], ZoneInfo(ZONE)).strftime("%H:%M")
              for i in got if datetime.datetime.fromtimestamp(i["startTime"], ZoneInfo(ZONE)).date() == today}
    assert starts == {"18:00", "19:00", "20:00"}, (starts, status(fppd).get("warnings"))
    assert any("startDateOffset is not a number" in w for w in status(fppd).get("warnings", [])), \
        status(fppd).get("warnings")
