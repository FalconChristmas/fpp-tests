"""How far ahead the scheduler lines up a weekly entry's runs."""

import datetime

from test_schedule_calendar import EVERY_DAY, TZ, at, entry, items, nth_sunday


def test_a_daily_entry_is_scheduled_weeks_ahead(fppd):
    """A daily entry has a run on each of the next four weeks' days, not just
    this week and next, so the schedule preview and the "Next Playlist"
    field can show a month of what is coming.

    Regression: c26edfd1e. The scheduler lined up a week ahead only."""
    start = nth_sunday(6, 1)
    got = items(fppd, [entry(EVERY_DAY, "08:00:00", "09:00:00")], at(start, "06:00:00"))
    days = {datetime.datetime.fromtimestamp(i["startTime"], TZ).date() for i in got}
    want = {start + datetime.timedelta(days=n) for n in range(28)}
    assert want <= days, f"missing days: {sorted(want - days)[:5]} ...({len(days)} scheduled)"
