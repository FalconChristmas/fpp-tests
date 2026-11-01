"""A repeating entry whose end time equals its start time."""

from test_schedule_calendar import YEAR, entry, items, local
import datetime

DAY = datetime.date(YEAR, 6, 1)


def test_repeating_entry_with_the_end_at_its_start_is_still_scheduled(fppd):
    """A repeating playlist entry whose end time is its start time is
    scheduled once on each of its days, rather than not at all.

    Regression: 3f6f63b7a. The repeat expansion loops while start < end, so
    with the two equal it produced no occurrence and the entry never ran,
    even with a graceful loop stop type."""
    e = entry(7, "19:00:00", "19:00:00", repeat=3000, stopType=2)
    got = [i for i in items(fppd, [e], f"{DAY} 12:00:00")
           if local(DAY, 18, 0) <= i["startTime"] < local(DAY, 20, 0)]
    assert [i["startTime"] for i in got] == [local(DAY, 19, 0)], got
