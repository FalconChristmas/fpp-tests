"""A repeating entry's occurrences end where the next one starts.

The case from FalconChristmas/fpp#3141: an hourly show above a graceful
filler. When one occurrence of the show ran up to the next one's start, it
was hard-stopped a second early. In that second nothing of the show was due,
so the filler started, and the next occurrence of the show then waited for the
filler's whole item. Here the interval is a minute and the filler's item 20
seconds, so it takes seconds rather than hours.

Occurrences are half-open, [start, end), in the scheduler, the calendar
(range) API and the schedule preview alike; the tests below hold each to it.
"""

import datetime
import os

import pytest

from ddp import DdpReceiver
from fseq import unique_frames, write_fseq
from show import CHANNELS, ddp_output, playlist, sequence_entry
from test_schedule_calendar import YEAR, ZONE, entry, items, local

DAY = datetime.date(YEAR, 6, 1)
SHOW_FRAMES = 600           # 30 s at 50 ms: still playing at the boundary
FILLER_FRAMES = 400         # 20 s: what a late show would wait for
WATCH_S = 45                # past the hand-over, short of the next boundary


def test_repeat_occurrences_end_at_the_next_start_and_the_last_at_the_entry_end(fppd):
    """Each occurrence of a repeating playlist entry ends at the second the
    next one starts, and the last ends at the entry's own end time, not
    later. The same holds for the calendar (range) view, built by a second
    copy of the expansion.

    Regression: 0577f3c90 (#3141). Before it every occurrence but the last
    ended a second early."""
    e = entry(7, "19:00:00", "20:45:00", repeat=3000)       # every 30 min
    got = [i for i in items(fppd, [e], f"{DAY} 12:00:00")
           if local(DAY, 19, 0) <= i["startTime"] < local(DAY, 21, 0)]
    want = [(local(DAY, 19, 0), local(DAY, 19, 30)),
            (local(DAY, 19, 30), local(DAY, 20, 0)),
            (local(DAY, 20, 0), local(DAY, 20, 30)),
            (local(DAY, 20, 30), local(DAY, 20, 45))]
    assert [(i["startTime"], i["endTime"]) for i in got] == want, \
        [(i["startTimeStr"], i["endTimeStr"]) for i in got]

    r0, r1 = local(DAY, 0, 0), local(DAY, 23, 59)
    cal = fppd.get(f"/fppd/schedule/range?start={r0}&end={r1}")["schedule"]["items"]
    assert sorted((i["startTime"], i["endTime"]) for i in cal) == want, \
        [(i["startTimeStr"], i["endTimeStr"]) for i in cal]
    assert not any(i["overridden"] for i in cal), [i["startTimeStr"] for i in cal if i["overridden"]]


def test_window_shorter_than_its_repeat_interval_ends_at_its_end_time(fppd):
    """An entry repeating every 30 minutes in a 10-minute window has one
    occurrence, and it ends at the entry's End Time, not half an hour after
    its start. The same in the calendar (range) view.

    Regression: 6652a74fd. Before it the first occurrence's end was never
    capped, so the playlist ran 20
    minutes past its End Time and held lower entries off."""
    e = entry(7, "20:00:00", "20:10:00", repeat=3000)
    got = [i for i in items(fppd, [e], f"{DAY} 12:00:00")
           if local(DAY, 19, 0) <= i["startTime"] < local(DAY, 21, 0)]
    want = [(local(DAY, 20, 0), local(DAY, 20, 10))]
    assert [(i["startTime"], i["endTime"]) for i in got] == want, \
        [(i["startTimeStr"], i["endTimeStr"]) for i in got]

    r0, r1 = local(DAY, 0, 0), local(DAY, 23, 59)
    cal = fppd.get(f"/fppd/schedule/range?start={r0}&end={r1}")["schedule"]["items"]
    assert [(i["startTime"], i["endTime"]) for i in cal] == want, \
        [(i["startTimeStr"], i["endTimeStr"]) for i in cal]


def test_range_leaves_out_what_ends_at_its_start(fppd):
    """A calendar range starting at midnight leaves out the previous
    evening's playlists that end exactly at midnight (an hourly entry's last
    occurrence, a non-repeating entry ending at 24:00), and keeps a command
    scheduled at midnight, which is a point in time rather than a span.

    Regression: 274d84f42. The range kept an occurrence whose end equalled
    the range start, so anything ending at midnight also showed on the next
    day."""
    sched = [entry(7, "22:00:00", "24:00:00", repeat=6000),
             entry(7, "20:00:00", "24:00:00", repeat=0),
             entry(7, "00:00:00", "00:00:00", playlist="", command="Volume Set", args=["50"],
                   repeat=0)]
    items(fppd, sched, f"{DAY} 12:00:00")
    nxt = DAY + datetime.timedelta(days=1)
    r0, r1 = local(nxt, 0, 0), local(nxt, 23, 59)
    cal = fppd.get(f"/fppd/schedule/range?start={r0}&end={r1}")["schedule"]["items"]
    got = sorted((i["id"], i["startTime"], i["endTime"]) for i in cal)
    m = local(nxt + datetime.timedelta(days=1), 0, 0)
    want = sorted([(0, local(nxt, 22, 0), local(nxt, 23, 0)), (0, local(nxt, 23, 0), m),
                   (1, local(nxt, 20, 0), m),
                   (2, r0, r0)])
    assert got == want, [(i["id"], i["startTimeStr"], i["endTimeStr"]) for i in cal]


def test_range_flags_an_override_by_a_playlist_from_before_its_start(fppd):
    """An occurrence that started the evening before a range and runs into
    it is still shown as overridden when a higher-priority playlist, which
    ended before the range starts, was running at its start.

    Regression: 274d84f42. The override check only looked at playlists
    inside the range, so the higher one was dropped before it was
    compared."""
    sched = [entry(7, "23:00:00", "23:45:00", repeat=0),                  # higher
             entry(7, "23:30:00", "01:00:00", repeat=0)]                  # lower, past midnight
    items(fppd, sched, f"{DAY} 12:00:00")
    nxt = DAY + datetime.timedelta(days=1)
    r0, r1 = local(nxt, 0, 0), local(nxt, 23, 59)
    cal = fppd.get(f"/fppd/schedule/range?start={r0}&end={r1}")["schedule"]["items"]
    late = [i for i in cal if i["id"] == 1 and i["startTime"] == local(DAY, 23, 30)]
    assert len(late) == 1, [(i["id"], i["startTimeStr"]) for i in cal]
    assert late[0]["overridden"], "the 23:30 occurrence runs under the 23:00 one but isn't flagged"


@pytest.mark.parametrize("stop_type", [1, 0, 2], ids=["hard", "graceful", "graceful_loop"])
def test_occurrence_hands_over_to_its_own_next_occurrence(fppd, stop_type):
    """An entry whose playlist is still playing at the next repeat hands over
    to its own next occurrence at the boundary however it stops: Hard cuts the
    sequence there, Graceful and Graceful Loop let it finish. Either way the
    show starts again exactly once, and the graceful filler below never
    plays in between.

    Regression (the hard case): 0577f3c90 (#3141).
    Occurrences ended a second before the next one started; in that second
    nothing of the show was due, so the filler started, and the next
    occurrence then waited out the filler's 20 s item. The graceful cases
    cover the hand-over itself: the next occurrence comes due while the same
    playlist is still stopping at the same priority, and must wait for it
    rather than start twice or be skipped."""
    show = unique_frames(SHOW_FRAMES, CHANNELS)
    filler = unique_frames(FILLER_FRAMES, CHANNELS, first=SHOW_FRAMES)
    write_fseq(os.path.join(fppd.media, "sequences", "High.fseq"), show)
    write_fseq(os.path.join(fppd.media, "sequences", "Low.fseq"), filler)
    fppd.write("playlists/High.json", playlist("High", [sequence_entry("High.fseq")]))
    fppd.write("playlists/Low.json", playlist("Low", [sequence_entry("Low.fseq")]))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.write("config/schedule.json", [
        entry(7, "20:00:00", "21:00:00", playlist="High", repeat=100, stopType=stop_type),
        entry(7, "19:00:00", "21:05:00", playlist="Low", repeat=1, stopType=0),
    ])
    shows = {f: ("high", i) for i, f in enumerate(show)}
    shows.update({f: ("low", i) for i, f in enumerate(filler)})

    with DdpReceiver(CHANNELS) as rx:
        # 20 s before the 20:01:00 boundary: both entries are due, so the
        # show goes first from idle and is mid-sequence at the boundary.
        fppd.start(fake_time=f"{DAY} 20:00:40", tz=ZONE)

        def frames():
            return [(t, *shows[d[:CHANNELS]]) for t, d in rx.snapshot() if d[:CHANNELS] in shows]

        fppd.wait_for(lambda: any(s == "high" for _, s, _ in frames()), timeout=30,
                      interval=0.5, what="the show to start")
        first = next(t for t, s, _ in frames() if s == "high")
        fppd.wait_for(lambda: rx.snapshot()[-1][0] - first > WATCH_S, timeout=90, interval=1,
                      what=f"{WATCH_S} s of output after the show started")

        # Hard restarts at the boundary, 20 s less the start-up delay after
        # the first frame; graceful at 30 s, the sequence's length. The next
        # boundary is a minute later, past the watch.
        seen = [(t - first, s, i) for t, s, i in frames() if 0 <= t - first <= WATCH_S]
        low = [round(t, 1) for t, s, _ in seen if s == "low"]
        assert not low, f"the filler played at {low[:3]} s after the show began"
        # A restart is the frame index going back to the start.
        restarts = [(round(seen[k][0], 1), seen[k - 1][2]) for k in range(1, len(seen))
                    if seen[k][2] < seen[k - 1][2]]
        assert len(restarts) == 1, f"show restarts (s, last frame before): {restarts}"
        cut_at = restarts[0][1]
        # A few frames of slack at the end: a busy box can drop the last ones.
        if stop_type == 1:
            assert cut_at < SHOW_FRAMES - 100, f"a hard stop let the sequence finish (frame {cut_at})"
        else:
            assert cut_at >= SHOW_FRAMES - 5, \
                f"a graceful stop cut the sequence at frame {cut_at} of {SHOW_FRAMES}"
