"""The scheduler's Hebrew-calendar holidays (Rosh Hashanah, Passover) and
Diwali (ScheduleEntry::CalculateHebrewDate, CalculateHinduDiwali), checked
against dates computed here independently of fppd's lookup tables:

- Hebrew dates come from the arithmetic Hebrew calendar (molad of Tishrei and
  the four postponement rules, as in Dershowitz and Reingold's Calendrical
  Calculations), which is exact: the calendar is fixed by rule, not
  observation.
- Diwali (Lakshmi Puja) is the evening of the Amavasya (new moon) of the
  lunar month that ends while the sun is in sidereal Libra, so it falls on
  the day of the new moon in India or the day before. New moons come from
  Meeus' algorithm (Astronomical Algorithms, ch. 49), good to a minute or so.

The Global locale's Passover asks for Nisan 14, but the table holds Nisan
15, the first day of Passover (the Seder is the evening before). That is the
date people mean by Passover, so 15 Nisan is what is checked.

Years before 2030 are not checked: fppd holds its scheduler back while its
clock reads earlier than its build, so faked dates must stay in the future
of whatever fpp commit the nightly builds (as test_holidays.py's Islamic
dates do).
"""

import datetime
import math

import pytest

from test_holidays import scheduled_days, show
from test_schedule_calendar import ZONE, entry
from test_schedule_config import warnings


# --- the arithmetic Hebrew calendar -------------------------------------------

HEBREW_EPOCH = -1373427  # day before 1 Tishrei AM 1, as a date.toordinal() (R.D.)


def _leap(y):
    return (7 * y + 1) % 19 < 7


def _elapsed_days(y):
    """Days from the epoch to the molad of Tishrei of year y, postponed when
    it falls on Sunday, Wednesday or Friday (lo ADU rosh)."""
    months = (235 * y - 234) // 19
    parts = 12084 + 13753 * months
    day = 29 * months + parts // 25920
    return day + 1 if (3 * (day + 1)) % 7 < 3 else day


def _year_delay(y):
    """The other two postponements, which keep years 353-355 or 383-385 days."""
    last, present, nxt = _elapsed_days(y - 1), _elapsed_days(y), _elapsed_days(y + 1)
    if nxt - present == 356:
        return 2
    if present - last == 382:
        return 1
    return 0


def _new_year(y):
    return HEBREW_EPOCH + _elapsed_days(y) + _year_delay(y)


def _month_days(y, m):
    """Months are numbered from Nisan (1) to Adar (12) or Adar II (13)."""
    length = _new_year(y + 1) - _new_year(y)
    if m in (2, 4, 6, 10, 13):
        return 29
    if m == 12 and not _leap(y):
        return 29
    if m == 8 and length % 10 != 5:  # Heshvan has 30 only in a complete year
        return 29
    if m == 9 and length % 10 == 3:  # Kislev has 29 in a deficient year
        return 29
    return 30


def hebrew_date(y, m, d):
    """The Gregorian date of day d of Hebrew month m (1 = Nisan, 7 =
    Tishrei) of year y; the year starts at Tishrei."""
    rd = _new_year(y) + d - 1
    if m < 7:
        rd += sum(_month_days(y, mm) for mm in range(7, (13 if _leap(y) else 12) + 1))
        rd += sum(_month_days(y, mm) for mm in range(1, m))
    else:
        rd += sum(_month_days(y, mm) for mm in range(7, m))
    return datetime.date.fromordinal(rd)


def rosh_hashanah(year):
    return hebrew_date(year + 3761, 7, 1)


def passover(year):
    return hebrew_date(year + 3760, 1, 15)


# --- new moons ----------------------------------------------------------------

def new_moon(k):
    """The k-th new moon after January 2000, in UT (Meeus ch. 49: the mean
    phase and its main periodic terms; good to a minute or two)."""
    t = k / 1236.85
    jde = (2451550.09766 + 29.530588861 * k + 0.00015437 * t * t
           - 0.000000150 * t ** 3 + 0.00000000073 * t ** 4)
    e = 1 - 0.002516 * t - 0.0000074 * t * t
    m = math.radians(2.5534 + 29.10535670 * k - 0.0000014 * t * t)
    mp = math.radians(201.5643 + 385.81693528 * k + 0.0107582 * t * t)
    f = math.radians(160.7108 + 390.67050284 * k - 0.0016118 * t * t)
    om = math.radians(124.7746 - 1.56375588 * k + 0.0020672 * t * t)
    sin = math.sin
    jde += (-0.40720 * sin(mp) + 0.17241 * e * sin(m) + 0.01608 * sin(2 * mp)
            + 0.01039 * sin(2 * f) + 0.00739 * e * sin(mp - m) - 0.00514 * e * sin(mp + m)
            + 0.00208 * e * e * sin(2 * m) - 0.00111 * sin(mp - 2 * f)
            - 0.00057 * sin(mp + 2 * f) + 0.00056 * e * sin(2 * mp + m)
            - 0.00042 * sin(3 * mp) + 0.00042 * e * sin(m + 2 * f)
            + 0.00038 * e * sin(m - 2 * f) - 0.00024 * e * sin(2 * mp - m)
            - 0.00017 * sin(om))
    jd = jde - 70 / 86400  # terrestrial time to UT, near enough for these years
    return datetime.datetime(2000, 1, 1, 12) + datetime.timedelta(days=jd - 2451545.0)


def diwali_new_moon(year):
    """The date in India (UTC+5:30) of the new moon Diwali belongs to: the
    one while the sun is in sidereal Libra, which it enters about October 17
    and leaves about November 16 in these years."""
    k = math.floor((year - 2000) * 12.3685)
    for kk in range(k - 2, k + 15):
        day = (new_moon(kk) + datetime.timedelta(hours=5, minutes=30)).date()
        if datetime.date(year, 10, 17) <= day < datetime.date(year, 11, 16):
            return day
    raise AssertionError(f"no Diwali new moon found in {year}")


# --- scenarios ----------------------------------------------------------------

def scheduled_on(fppd, name, now):
    show(fppd)
    fppd.write("config/schedule.json", [entry(7, "19:00:00", "20:00:00",
                                              startDate=name, endDate=name)])
    fppd.start(fake_time=f"{now.isoformat()} 12:00:00", tz=ZONE)
    return scheduled_days(fppd)


HEBREW = [("RoshHashanah", rosh_hashanah, y) for y in range(2030, 2036)] + \
         [("Passover", passover, y) for y in range(2030, 2036)]


@pytest.mark.parametrize("name, when, year", HEBREW,
                         ids=[f"{n}-{y}" for n, _, y in HEBREW])
def test_hebrew_holidays_fall_on_their_dates(fppd, name, when, year):
    """An entry on Rosh Hashanah (1 Tishrei) or Passover (15 Nisan) runs on
    exactly that year's date, and only then."""
    want = when(year)
    days = scheduled_on(fppd, name, want - datetime.timedelta(days=5))
    assert days == {want}, f"{name} {year} is {want}; scheduled on {sorted(days)[:5]}"


@pytest.mark.parametrize("year", range(2030, 2036))
def test_diwali_falls_on_the_new_moon_or_the_day_before(fppd, year):
    """An entry on Diwali runs on one day, the day of its new moon in India
    or the day before.

    Regression: b8e4e6752. The table held 2034 and 2035 as November 12 and
    November 1, a day after the new moon (November 11, 06:46 IST and October
    31, 08:29 IST)."""
    moon = diwali_new_moon(year)
    days = scheduled_on(fppd, "Diwali", moon - datetime.timedelta(days=6))
    assert len(days) == 1, f"Diwali {year} scheduled on {sorted(days)[:5]}"
    day = next(iter(days))
    assert moon - datetime.timedelta(days=1) <= day <= moon, \
        f"Diwali {year}'s new moon is {moon} in India; scheduled on {day}"


PASSED = [
    # (holiday, a day just after this year's, next year's date this year)
    ("Diwali", datetime.date(2030, 10, 28), datetime.date(2030, 11, 14)),
    ("RoshHashanah", datetime.date(2034, 9, 16), datetime.date(2034, 10, 4)),
    ("Passover", datetime.date(2034, 4, 6), datetime.date(2034, 4, 24)),
]


@pytest.mark.parametrize("name, now, wrong", PASSED, ids=[n for n, _, _ in PASSED])
def test_a_holiday_that_has_passed_does_not_run_again_this_year(fppd, name, now, wrong):
    """Once this year's date has passed, an entry on the holiday runs on no
    other day this year.

    Regression: a88c87545. The date resolved at load rolled forward to
    next year's, without its year, so the entry ran on next year's month and
    day this year: the day after Diwali 2030 it was scheduled on November
    14, 2030 (2031's Diwali)."""
    days = scheduled_on(fppd, name, now)
    assert wrong not in days, f"{name} scheduled on {wrong}, next year's date"
    assert not [d for d in days if d.year == now.year], \
        f"{name} has passed for {now.year}; scheduled on {sorted(days)[:5]}"


def test_a_range_from_a_holiday_that_has_passed_keeps_running(fppd):
    """A range that began on this year's Diwali runs every day after it up to
    its end, Christmas.

    Regression: a88c87545. The day after Diwali 2030 (October 26) the
    range's start rolled forward to November 14, 2031's Diwali, so the show
    went dark from October 27 to November 13."""
    show(fppd)
    fppd.write("config/schedule.json", [entry(7, "19:00:00", "20:00:00",
                                              startDate="Diwali", endDate="Christmas")])
    fppd.start(fake_time="2030-10-28 12:00:00", tz=ZONE)
    days = scheduled_days(fppd)
    want = {datetime.date(2030, 10, 28) + datetime.timedelta(days=d) for d in range(9)}
    assert want <= days, f"dark on {sorted(want - days)}; scheduled on {sorted(days)[:5]}"


@pytest.mark.parametrize("name, word", [("RoshHashanah", "Hebrew"), ("Passover", "Hebrew"),
                                        ("Diwali", "Diwali")])
def test_past_the_table_warns(fppd, name, word):
    """An entry on one of these holidays in a year past fpp's date tables
    (they end in 2035) raises a warning naming the calendar and the year,
    as test_schedule_config.py checks for Chinese New Year."""
    scheduled_on(fppd, name, datetime.date(2040, 1, 5))
    fppd.wait_for(lambda: any(word in w and "2040" in w for w in warnings(fppd)),
                  timeout=10, what=f"a warning that {name} 2040 is unknown")
