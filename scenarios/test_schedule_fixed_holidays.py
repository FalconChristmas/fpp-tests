"""Schedule entries anchored on fixed-date holidays (Christmas, New Year's
Day) after the holiday has passed this year. fppd resolves such a holiday to
a yearless month and day, and a range of them wraps across the new year."""

import datetime

from test_holidays import scheduled_days, show
from test_schedule_calendar import YEAR, ZONE, entry

DAY = datetime.timedelta(days=1)


def test_fixed_holiday_range_keeps_running_after_its_start_has_passed(fppd):
    """A Christmas to New Year's Day entry, with fppd started on December 27,
    runs every day from the 27th to January 1 and no other.

    Regression: 229cdb45d (#2077). fppd gave a yearless holiday the year of
    its next occurrence, so once Christmas had passed it meant Christmas of
    next year: the range started after it ended and nothing ran for the rest
    of the holidays."""
    today = datetime.date(YEAR, 12, 27)
    show(fppd)
    fppd.settings(Locale="USA")
    fppd.write("config/schedule.json", [entry(7, "19:00:00", "20:00:00",
                                              startDate="Christmas", endDate="NewYearsDay")])
    fppd.start(fake_time=f"{today.isoformat()} 12:00:00", tz=ZONE)
    want = {today + n * DAY for n in range(6)}
    assert max(want) == datetime.date(YEAR + 1, 1, 1)
    days = scheduled_days(fppd)
    assert days == want, f"Christmas to New Year's Day from {today}: runs on {sorted(days)}"
