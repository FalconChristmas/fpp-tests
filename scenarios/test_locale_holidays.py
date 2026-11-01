"""Holidays the regional locale tables name, as the scheduler resolves them.

A schedule entry names a holiday by its short name; fppd looks it up in the
Locale's table (plus the Global one) and schedules the entry on that day only.
A name the table lacks resolves to no date and the entry runs every day, so a
holiday dropped from a table shows as a schedule that never stops.
"""

import datetime

import pytest

from test_holidays import scheduled_days, show
from test_schedule_calendar import YEAR, ZONE, entry


@pytest.mark.parametrize("locale, name, day", [
    ("USA", "BoxingDay", (12, 26)),
    ("Canada", "BoxingDay", (12, 26)),
    ("USA", "NewYearsEve", (12, 31)),
    ("Canada", "NewYearsEve", (12, 31)),
])
def test_a_regional_locale_schedules_its_holidays(fppd, locale, name, day):
    """An entry naming Boxing Day or New Year's Eve under the USA or Canada
    locale runs on that day only.

    Regression: 3cc470862. The USA table had no Boxing Day, so an entry
    naming it under that locale was scheduled every day. Also e30e91bd6: the
    New Year's Eve entries in both tables, whose display names got their
    apostrophes (that part is seen on the Scheduler page, in
    scheduler-locale-holidays.spec.ts)."""
    show(fppd)
    fppd.settings(Locale=locale)
    fppd.write("config/schedule.json", [entry(7, "19:00:00", "20:00:00",
                                              startDate=name, endDate=name)])
    fppd.start(fake_time=f"{YEAR}-12-20 12:00:00", tz=ZONE)
    days = scheduled_days(fppd)
    want = datetime.date(YEAR, *day)
    assert days == {want}, f"{locale} {name} is {want}; scheduled on {sorted(days)[:5]}"
