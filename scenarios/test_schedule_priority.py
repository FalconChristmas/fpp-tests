"""Overlapping schedule entries: the earlier entry in the list has priority.

fppd's clock is faked to boot just inside a low-priority entry's window, ten
seconds before a high-priority entry comes due, so the pre-emption happens
quickly. Each show is told apart on the wire: the low one plays unique frames
(so where it was cut is visible), the high one a solid value.
"""

import datetime
import os
import time

from ddp import DdpReceiver
from fseq import solid_frames, unique_frames, write_fseq
from show import CHANNELS, ddp_output, playlist, sequence_entry, status
from test_schedule_calendar import YEAR, ZONE

LOW_FRAMES = 140            # 7 s: 20:00:00 lands early in a pass, far from its end
HIGH_VALUE = 40
DAY = datetime.date(YEAR, 6, 1)


def setup(fppd, low_repeat, low_frames=LOW_FRAMES):
    low = unique_frames(low_frames, CHANNELS)
    write_fseq(os.path.join(fppd.media, "sequences", "Low.fseq"), low)
    write_fseq(os.path.join(fppd.media, "sequences", "High.fseq"), solid_frames(40, CHANNELS, HIGH_VALUE))
    fppd.write("playlists/Low.json", playlist("Low", [sequence_entry("Low.fseq")]))
    fppd.write("playlists/High.json", playlist("High", [sequence_entry("High.fseq")]))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")

    def entry(name, start, end, repeat):
        return {"enabled": 1, "day": 7, "playlist": name, "startTime": start, "endTime": end,
                "startDate": f"{YEAR}-01-01", "endDate": f"{YEAR}-12-31", "repeat": repeat,
                "stopType": 0}
    fppd.write("config/schedule.json", [
        entry("High", "20:00:00", "20:00:30", 0),        # first: higher priority
        entry("Low", "19:00:00", "21:00:00", low_repeat),
    ])
    return {f: i for i, f in enumerate(low)}


def segments(rx, lookup):
    """[(show, first frame index or None, last frame index or None, t0, t1)]"""
    out = []
    for t, d in rx.snapshot():
        d = d[:CHANNELS]
        if d in lookup:
            show, idx = "low", lookup[d]
        elif any(d) and d[0] == HIGH_VALUE:
            show, idx = "high", None
        else:
            show, idx = "dark", None
        if out and out[-1][0] == show:
            out[-1][2], out[-1][4] = idx, t
        else:
            out.append([show, idx, idx, t, t])
    return out


def test_pre_emption_lets_a_graceful_entry_finish_its_sequence(fppd):
    """A higher-priority entry coming due while a graceful, looping
    lower-priority one plays waits for the running sequence to end: the
    low show's last frame before the high one is its final frame.

    Regression: 1cf10b57d. The scheduler queued the stop and the new start in
    the same pass, and the start cut the stopping playlist off, so every
    pre-emption was a hard stop whatever the running entry's stop type."""
    with DdpReceiver(CHANNELS) as rx:
        lookup = setup(fppd, low_repeat=1)
        fppd.start(fake_time=f"{DAY} 19:59:50", tz=ZONE)
        fppd.wait_for(lambda: any(s[0] == "high" for s in segments(rx, lookup)), timeout=40,
                      interval=0.5, what="the high-priority show to start")
        segs = [s for s in segments(rx, lookup) if s[0] != "dark"]
        cut = next(i for i, s in enumerate(segs) if s[0] == "high")
        assert cut > 0 and segs[cut - 1][0] == "low", [s[:3] for s in segs]
        assert segs[cut - 1][2] == LOW_FRAMES - 1, \
            f"the low show was cut at frame {segs[cut - 1][2]} of {LOW_FRAMES}"


def test_pre_empted_entry_resumes_once(fppd):
    """A non-repeating low-priority entry pre-empted by a higher-priority
    show plays again once that show ends, and then stays stopped.

    Regression: ffd0263ba. The pre-empted entry was remembered for a restart
    and never forgotten, so every natural end of its playlist restarted it
    until its window closed."""
    with DdpReceiver(CHANNELS) as rx:
        # 15 s, so it is still playing when the high-priority entry is due.
        lookup = setup(fppd, low_repeat=0, low_frames=300)
        fppd.start(fake_time=f"{DAY} 19:59:50", tz=ZONE)
        fppd.wait_for(lambda: any(s[0] == "high" for s in segments(rx, lookup)), timeout=40,
                      interval=0.5, what="the high-priority show to start")
        # The high show (2 s), the low show's owed pass (15 s), then quiet.
        time.sleep(2 + 15 + 12)
        shows = [s[0] for s in segments(rx, lookup) if s[0] != "dark"]
        after = shows[shows.index("high") + 1:]
        assert after == ["low"], f"after the high-priority show: {after} (expected one low pass)"
        assert status(fppd).get("status_name") == "idle", status(fppd).get("status_name")
